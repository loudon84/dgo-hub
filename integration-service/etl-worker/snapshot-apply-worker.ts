import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { applyCustomer, applyOrderAggregate, type ApplyContext, type ApplyResult } from '../normalization/apply.js';
import { sourceContentDigest } from '../normalization/canonical.js';
import { createSnapshotContinuationStore, type SnapshotCProof, type SnapshotContinuationClaim } from './snapshot-continuation-store.js';
import { computeSemanticSnapshotDigest, type SemanticSnapshotFact } from './snapshot-validation.js';
import { toCanonicalSnapshotCustomer, toCanonicalSnapshotOrder } from './snapshot-canonical.js';

function stable(value:unknown):string {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object=value as Record<string,unknown>;
  return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
function sha(value:unknown):string { return createHash('sha256').update(stable(value),'utf8').digest('hex'); }
function hex(value:string):Buffer { if(!/^[a-f0-9]{64}$/.test(value)) throw new Error('SNAPSHOT_DIGEST_INVALID'); return Buffer.from(value,'hex'); }
function asFact(row:Record<string,any>):SemanticSnapshotFact {
  return {entity:row.entity,relation:row.relation,parent_source_pk:row.parent_source_pk,source_pk:row.source_pk,
    source_version:row.source_version,facts:row.facts};
}
function canonicalProof(proof:SnapshotCProof) {
  return {version_domain:(proof.config as any).version_domain,delete_contract:proof.delete_contract,
    customer_source_id:((proof.config as any).endpoint_profile?.entities?.order?.customer_source_id)} as const;
}
function scopeDigest(proof:SnapshotCProof):string {
  return sha({tenant:proof.tenant_key,source:proof.source_id,config_revision:proof.config_revision,config_digest:proof.config_digest,
    mapping_revision:proof.mapping_revision,mapping_digest:proof.mapping_digest,identity_revision:proof.identity_mapping_revision,
    identity_digest:proof.identity_mapping_digest,profile_digest:proof.endpoint_profile_digest,channels:proof.entity_channel_proof,
    entities:[...proof.expected_entities].sort(),version_domain:(proof.config as any).version_domain,
    delete_contract:proof.delete_contract,data_contract_ref:proof.data_contract_ref});
}
function applyContext(proof:SnapshotCProof,entity:'customer'|'order'):ApplyContext {
  const channel=proof.entity_channel_proof[entity];
  if(!channel) throw new Error('SNAPSHOT_C_PROOF_INVALID');
  return {tenantId:proof.tenant_key,sourceId:proof.source_id,credentialId:proof.credential_id,
    sourceEpochAtAdmission:String(proof.admission_source_epoch),credentialRevisionAtAdmission:String(proof.credential_revision),
    credentialGenerationAtAdmission:String(proof.credential_generation),entity,channelId:channel.channel_id,channelEpoch:String(channel.channel_epoch),
    versionDomain:channel.version_domain,ownerApprovalId:proof.approval_id,ownerUserId:proof.owner_user_id,ownerRevision:String(proof.owner_revision),
    configRevision:String(proof.config_revision),configDigest:proof.config_digest,mappingRevision:String(proof.mapping_revision),mappingDigest:proof.mapping_digest,
    identityMappingRevision:String(proof.identity_mapping_revision),identityMappingDigest:proof.identity_mapping_digest,
    endpointProfileDigest:proof.endpoint_profile_digest,testReportId:proof.test_report_id,
    securityBarrierFenceAtAdmission:String(proof.security_barrier_fence)};
}
function outcome(result:ApplyResult):Readonly<{status:'APPLIED'|'DUPLICATE'|'IGNORED_STALE'|'QUARANTINED'|'CHANNEL_EPOCH_RETIRED'|'FAILED';error:string|null}> {
  if(result.status==='QUARANTINED') return {status:'QUARANTINED',error:result.code};
  if(result.status==='CHANNEL_EPOCH_RETIRED') return {status:'CHANNEL_EPOCH_RETIRED',error:'CHANNEL_EPOCH_RETIRED'};
  return {status:result.status,error:null};
}
export type SnapshotContinuationHooks = Readonly<{
  afterProofLoaded?: (claim:SnapshotContinuationClaim)=>Promise<void>;
  afterValidationSeal?: (claim:SnapshotContinuationClaim)=>Promise<void>;
  beforeAggregateCommit?: (item:Readonly<{run_id:string;entity:'customer'|'order';source_pk:string}>)=>Promise<void>;
  afterAggregateCommit?: (item:Readonly<{run_id:string;entity:'customer'|'order';source_pk:string}>)=>Promise<void>;
}>;
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); await client.query('SELECT control.lock_security_barrier_fence()');
    const result=await fn(client); await client.query('COMMIT'); return result;
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

async function *proofFacts(store:ReturnType<typeof createSnapshotContinuationStore>,claim:SnapshotContinuationClaim,
  proof:SnapshotCProof):AsyncGenerator<readonly SemanticSnapshotFact[]> {
  const cp=canonicalProof(proof);
  if(proof.expected_entities.includes('customer')) {
    for await(const page of store.semanticFacts(claim,'customer')) {
      yield Object.freeze(page.map(row=>toCanonicalFact(row,normalizeSnapshotTimestamps(toCanonicalSnapshotCustomer(
        {...row,facts:normalizeSnapshotTimestamps(row.facts)},cp)))));
    }
  }
  if(proof.expected_entities.includes('order')) {
    for await(const page of store.semanticFacts(claim,'order')) {
      const normalized=[] as SemanticSnapshotFact[];
      for(const row of page) {
        const lines=(await store.orderLines(claim,row.source_pk)).map(line=>toCanonicalFact(asFact(line),normalizeSnapshotTimestamps(asFact(line).facts)));
        normalized.push(toCanonicalFact(row,normalizeSnapshotTimestamps(toCanonicalSnapshotOrder(
          {...row,facts:normalizeSnapshotTimestamps(row.facts)},lines,cp))));
      }
      yield Object.freeze(normalized);
    }
  }
}

function toCanonicalFact(row:SemanticSnapshotFact,value:unknown):SemanticSnapshotFact {
  return {...row,facts:value as Record<string,string|null>};
}

function normalizeSnapshotTimestamps<T>(value:T):T {
  if(Array.isArray(value)) return value.map(normalizeSnapshotTimestamps) as T;
  if(!value||typeof value!=='object') return value;
  const object=value as Record<string,unknown>;
  const normalized:Record<string,unknown>={};
  for(const [key,item] of Object.entries(object)) {
    if(key==='deleted_at'&&(item==='true'||item==='false')) {
      normalized[key]=item;
    } else if(['source_updated_at','order_at','deleted_at'].includes(key)&&typeof item==='string') {
      const match=/^(.*?)(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(item);
      if(!match) throw new Error('SNAPSHOT_TIMESTAMP_INVALID');
      const offset=match[3]==='Z'?'Z':`${match[4]}${match[5]}:${match[6]??'00'}`;
      const timestamp=match[1].replace(' ','T');
      const epoch=Date.parse(`${timestamp}${offset}`);
      if(!Number.isFinite(epoch)) throw new Error('SNAPSHOT_TIMESTAMP_INVALID');
      const fraction=(match[2]??'').padEnd(6,'0').replace(/0+$/,'');
      normalized[key]=`${new Date(epoch).toISOString().replace(/\.\d{3}Z$/,'')}${fraction?`.${fraction}`:''}Z`;
    } else normalized[key]=normalizeSnapshotTimestamps(item);
  }
  return normalized as T;
}

async function validateAndSeal(store:ReturnType<typeof createSnapshotContinuationStore>,claim:SnapshotContinuationClaim,proof:SnapshotCProof) {
  let rows=0,pages=0;
  for await(const page of store.stagePages(claim,proof)) { rows+=page.rows.length; pages++; }
  const referenceError=await store.validateOrderReferences(claim,proof);
  if(referenceError) throw new Error(referenceError.startsWith('SNAPSHOT_')?referenceError:`SNAPSHOT_${referenceError}`);
  const customerError=await store.validateCustomerReferences(claim,proof);
  if(customerError) throw new Error(customerError.startsWith('SNAPSHOT_')?customerError:`SNAPSHOT_${customerError}`);
  const semantic=await computeSemanticSnapshotDigest(proofFacts(store,claim,proof));
  const scope=scopeDigest(proof);
  const ok=await store.seal(claim,proof,scope,semantic,{rows,pages,relations:proof.manifest.relations});
  if(!ok) throw new Error('SNAPSHOT_VALIDATION_SEAL_REJECTED');
  return {semantic,scope};
}

async function applyOne(pool:Pool,store:ReturnType<typeof createSnapshotContinuationStore>,claim:SnapshotContinuationClaim,
  proof:SnapshotCProof,entity:'customer'|'order',row:SemanticSnapshotFact,observation?:string,scope?:string,
  hooks:SnapshotContinuationHooks={}):Promise<boolean> {
  const cp=canonicalProof(proof);
  const canonicalRow={...row,facts:normalizeSnapshotTimestamps(row.facts)};
  const canonical=entity==='customer'?toCanonicalSnapshotCustomer(canonicalRow,cp,observation):
    toCanonicalSnapshotOrder(canonicalRow,await store.orderLines(claim,row.source_pk).then(lines=>lines.map(line=>{
      const fact=asFact(line); return {...fact,facts:normalizeSnapshotTimestamps(fact.facts)};
    })),cp,observation);
  const aggregate=sourceContentDigest(canonical);
  const proofScope=scope ?? scopeDigest(proof);
  const previous=await store.existingRange(claim,entity,row.source_pk);
  if(previous) {
    if(previous.aggregate_digest!==aggregate||previous.proof_scope_digest!==proofScope) throw new Error('SNAPSHOT_RECOVERY_DRIFT');
    return false;
  }
  if(proof.recovery_mode==='SEALED_STAGE') {
    const original=await store.recoveryPriorRange(claim,entity,row.source_pk);
    if(original) {
      if(original.aggregate_digest!==aggregate||original.proof_scope_digest!==proofScope) throw new Error('SNAPSHOT_RECOVERY_DRIFT');
      const reused=await transaction(pool,async client=>{
        if(!await store.assertApplyClaim(client,claim)) throw new Error('SNAPSHOT_C_CLAIM_LOST');
        return store.recordRecoveryReuse(client,claim,{entity,source_pk:row.source_pk,aggregate_digest:aggregate,proof_scope_digest:proofScope});
      });
      if(!reused) throw new Error('SNAPSHOT_RECOVERY_RANGE_REUSE_REJECTED');
      return false;
    }
  }
  const ctx=applyContext(proof,entity);
  const recorded=await transaction(pool,async client=>{
    if(!await store.assertApplyClaim(client,claim)) throw new Error('SNAPSHOT_C_CLAIM_LOST');
    if(entity==='order'&&!await store.lockOrderCustomerReference(client,claim,proof,row))
      throw new Error('SNAPSHOT_ORDER_CUSTOMER_REFERENCE_CHANGED');
    const applied=entity==='customer'
      ? await applyCustomer(client,ctx,canonical as Parameters<typeof applyCustomer>[2])
      : await applyOrderAggregate(client,ctx,canonical as Parameters<typeof applyOrderAggregate>[2]);
    const result=outcome(applied);
    const saved=await store.recordAggregate(client,claim,{entity,source_pk:row.source_pk,
      aggregate_digest:aggregate,proof_scope_digest:proofScope,status:result.status,error_code:result.error});
    if(!saved) throw new Error('SNAPSHOT_OUTCOME_COMMIT_REJECTED');
    await hooks.beforeAggregateCommit?.({run_id:claim.run_id,entity,source_pk:row.source_pk});
    return saved;
  });
  return true;
}

function retryableContinuationFailure(error:unknown):boolean {
  if(!error||typeof error!=='object') return false;
  const pgError=error as {code?:unknown;message?:unknown};
  if(typeof pgError.code==='string'&&(/^(08|40|55|57)/.test(pgError.code)||pgError.code==='53300')) return true;
  return error instanceof Error&&pgError.code===undefined&&(
    pgError.message==='Connection terminated unexpectedly'||
    pgError.message==='Client has encountered a connection error and is not queryable'||
    pgError.message==='Connection terminated'
  );
}

async function processClaim(pool:Pool,store:ReturnType<typeof createSnapshotContinuationStore>,claim:SnapshotContinuationClaim,
  leaseSeconds:number,hooks:SnapshotContinuationHooks):Promise<void> {
  let leaseLost=false,heartbeatFailure:unknown,heartbeatInFlight:Promise<boolean>|undefined;
  const renew=async()=>{
    if(heartbeatFailure!==undefined) throw heartbeatFailure;
    if(leaseLost) return false;
    if(!heartbeatInFlight) {
      heartbeatInFlight=store.heartbeat(claim,leaseSeconds).then(alive=>{
        if(!alive) leaseLost=true;
        return alive;
      }).catch(error=>{
        heartbeatFailure=error;
        throw error;
      }).finally(()=>{ heartbeatInFlight=undefined; });
    }
    return heartbeatInFlight;
  };
  const heartbeat=async()=>{
    await renew().catch(()=>undefined);
  };
  const assertLease=async()=>{
    if(heartbeatFailure!==undefined) throw heartbeatFailure;
    if(leaseLost||!await renew()) {
      leaseLost=true;
      throw new Error('SNAPSHOT_C_START_LEASE_LOST');
    }
  };
  const timer=setInterval(()=>{ void heartbeat(); },Math.max(1000,Math.floor(leaseSeconds*1000/3)));
  timer.unref?.();
  try {
    await assertLease();
    const start=await store.begin(claim);
    if(!Number.isInteger(start)||start<1||start>4) throw new Error('SNAPSHOT_C_START_LEASE_LOST');
    const proof=await store.loadProof(claim);
    await hooks.afterProofLoaded?.(claim);
    const {semantic,scope}=await validateAndSeal(store,claim,proof);
    await hooks.afterValidationSeal?.(claim);
    await assertLease();
    const observation=(proof.config as any).version_domain==='SNAPSHOT_OBSERVATION'
      ? await store.observation(claim,semantic,scope) : undefined;
    if((proof.config as any).version_domain==='SNAPSHOT_OBSERVATION'&&!observation) throw new Error('SNAPSHOT_OBSERVATION_ALLOCATION_FAILED');
    for(const entity of proof.expected_entities) {
      for await(const page of store.semanticFacts(claim,entity)) {
        for(const row of page) {
          await assertLease();
          if(await applyOne(pool,store,claim,proof,entity,row,observation,scope,hooks)) {
            await hooks.afterAggregateCommit?.({run_id:claim.run_id,entity,source_pk:row.source_pk});
          }
        }
      }
    }
    await assertLease();
    if(!await store.finish(claim)) throw new Error('SNAPSHOT_FINISH_REJECTED');
  } finally {
    clearInterval(timer);
  }
}

export async function runSnapshotContinuationWorkerOnce(pool:Pool,limit=20,leaseSeconds=60,hooks:SnapshotContinuationHooks={}):Promise<number> {
  const store=createSnapshotContinuationStore(pool);
  const sources=await pool.query<{tenant_key:string;source_id:string}>(`SELECT tenant_key,source_id FROM control.etl_run
    WHERE status IN ('VALIDATING','READY','APPLYING') ORDER BY created_at,run_id LIMIT $1`,[limit]);
  let claimed=0;
  for(const source of sources.rows) {
    const claim=await store.claim(source.tenant_key,source.source_id,leaseSeconds);
    if(!claim) continue;
    claimed++;
    try { await processClaim(pool,store,claim,leaseSeconds,hooks); }
    catch(error) {
      const code=error instanceof Error&&/^SNAPSHOT_[A-Z0-9_:-]{1,90}$/.test(error.message)?error.message:'SNAPSHOT_C_PROCESSING_FAILED';
      const pgError=typeof error==='object'&&error!==null?error as {code?:unknown;constraint?:unknown;column?:unknown}:undefined;
      const retryable=retryableContinuationFailure(error);
      console.warn('snapshot continuation failed',{tenant_key:claim.tenant_key,source_id:claim.source_id,run_id:claim.run_id,
        error_code:code,sqlstate:typeof pgError?.code==='string'?pgError.code:undefined,
        constraint:typeof pgError?.constraint==='string'?pgError.constraint:undefined,
        column:typeof pgError?.column==='string'?pgError.column:undefined,
        failure_name:error instanceof Error?error.name:typeof error,
        failure_site:error instanceof Error?error.stack?.split('\n')[1]?.trim():undefined});
      await store.fail(claim,code,retryable).catch(()=>undefined);
    }
  }
  return claimed;
}
