import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { applyCustomer, applyOrderAggregate, type ApplyContext, type ApplyResult } from '../normalization/apply.js';
import { createSnapshotContinuationStore, type SnapshotCProof } from './snapshot-continuation-store.js';
import { snapshotManifestDigest } from './snapshot-stage-store.js';

type DeleteClaim = Readonly<{tenant_key:string;source_id:string;run_id:string;attempt_id:string;claim_token:string;start_count:number}>;
type DeleteMember = Readonly<{source_pk:string;canonical_object_id:string;sequence_value:string;inferred_completed_at:string;operation_id:string;applied:boolean}>;
type DeleteCandidate = Readonly<{candidate_id:string;entity:'customer'|'order';candidate_revision:number;candidate_digest:string;baseline_count:number;candidate_count:number;above_threshold:boolean;members:readonly DeleteMember[]}>;
type DeleteHooks = Readonly<{
  beforeAggregateCommit?:(item:Readonly<{run_id:string;candidate_id:string;entity:'customer'|'order';source_pk:string;operation_id:string}>)=>Promise<void>;
  afterAggregateCommit?:(item:Readonly<{run_id:string;candidate_id:string;entity:'customer'|'order';source_pk:string;operation_id:string}>)=>Promise<void>;
}>;

function stable(value:unknown):string {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object=value as Record<string,unknown>;
  return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
function sha(value:unknown):string { return createHash('sha256').update(stable(value),'utf8').digest('hex'); }
function applyContext(proof:SnapshotCProof,entity:'customer'|'order'):ApplyContext {
  const channel=proof.entity_channel_proof[entity];
  if(!channel) throw new Error('D_APPLY_PROOF_INVALID');
  return {tenantId:proof.tenant_key,sourceId:proof.source_id,credentialId:proof.credential_id,
    sourceEpochAtAdmission:String(proof.admission_source_epoch),credentialRevisionAtAdmission:String(proof.credential_revision),
    credentialGenerationAtAdmission:String(proof.credential_generation),entity,channelId:channel.channel_id,channelEpoch:String(channel.channel_epoch),
    versionDomain:channel.version_domain,ownerApprovalId:proof.approval_id,ownerUserId:proof.owner_user_id,ownerRevision:String(proof.owner_revision),
    configRevision:String(proof.config_revision),configDigest:proof.config_digest,mappingRevision:String(proof.mapping_revision),mappingDigest:proof.mapping_digest,
    identityMappingRevision:String(proof.identity_mapping_revision),identityMappingDigest:proof.identity_mapping_digest,
    endpointProfileDigest:proof.endpoint_profile_digest,testReportId:proof.test_report_id,
    securityBarrierFenceAtAdmission:String(proof.security_barrier_fence)};
}
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT control.lock_security_barrier_fence()');
    const result=await fn(client);
    await client.query('COMMIT');
    return result;
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

async function applyClaim(pool:Pool,source:Readonly<{tenant_key:string;source_id:string}>,hooks:DeleteHooks):Promise<boolean> {
  const claimResult=await pool.query<{claim_etl_snapshot_delete_apply:DeleteClaim|null}>(
    'SELECT control.claim_etl_snapshot_delete_apply($1,$2,$3::uuid,60) AS claim_etl_snapshot_delete_apply',
    [source.tenant_key,source.source_id,randomUUID()]);
  const claim=claimResult.rows[0]?.claim_etl_snapshot_delete_apply;
  if(!claim) return false;
  const started=await pool.query<{begin_etl_snapshot_delete_start:number}>(
    'SELECT control.begin_etl_snapshot_delete_start($1,$2,$3::uuid,$4::uuid)',
    [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]);
  const startCount=Number(started.rows[0]?.begin_etl_snapshot_delete_start??0);
  if(startCount<1||startCount>4) throw new Error('D_CLAIM_LOST');
  const continuation=createSnapshotContinuationStore(pool);
  let pendingHeartbeats:Promise<boolean>[]=[];
  let heartbeatError:unknown;
  const heartbeat=setInterval(()=>{
    const call=pool.query<{heartbeat_etl_snapshot_delete_apply:boolean}>(
      'SELECT control.heartbeat_etl_snapshot_delete_apply($1,$2,$3::uuid,$4::uuid,60)',
      [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]).then(result=>{
        const ok=result.rows[0]?.heartbeat_etl_snapshot_delete_apply===true;
        if(!ok) throw new Error('D_CLAIM_LOST');
        return ok;
      }).catch(error=>{heartbeatError=error; return false;});
    pendingHeartbeats.push(call);
  },20_000);
  try {
    const proofResult=await pool.query<{load_etl_snapshot_delete_apply_proof:Record<string,any>|null}>(
      'SELECT control.load_etl_snapshot_delete_apply_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS load_etl_snapshot_delete_apply_proof',
      [claim.tenant_key,claim.source_id,claim.run_id,claim.attempt_id,claim.claim_token]);
    const raw=proofResult.rows[0]?.load_etl_snapshot_delete_apply_proof;
    if(!raw||raw.status!=='COMPLETE'||raw.run_id!==claim.run_id||raw.attempt_id!==claim.attempt_id||typeof raw.completed_at!=='string')
      throw new Error('D_APPLY_PROOF_INVALID');
    const proof=raw as SnapshotCProof;
    const manifest=raw.manifest?.manifest;
    const manifestDigest=raw.manifest?.digest;
    if(!manifest||snapshotManifestDigest(manifest)!==manifestDigest||manifest.attempt_id!==claim.attempt_id||manifest.state!=='EXTRACTED'||
      sha(raw.config)!==raw.config_digest||sha(raw.mappings)!==raw.mapping_digest||sha(raw.identity_mappings)!==raw.identity_mapping_digest||
      sha((raw.config as any).endpoint_profile)!==raw.endpoint_profile_digest||
      stable([...(raw.expected_entities as string[])].sort())!==stable([...((raw.config as any).allowed_entities as string[])].sort()))
      throw new Error('D_APPLY_PROOF_INVALID');
    const candidateResult=await pool.query<{list_etl_snapshot_delete_apply_members:DeleteCandidate[]|null}>(
      'SELECT control.list_etl_snapshot_delete_apply_members($1,$2,$3::uuid,$4::uuid) AS list_etl_snapshot_delete_apply_members',
      [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]);
    const candidates=candidateResult.rows[0]?.list_etl_snapshot_delete_apply_members;
    if(!Array.isArray(candidates)||!candidates.length) throw new Error('D_CANDIDATE_EMPTY');
    for(const candidate of candidates) {
      const preflight=await pool.query<{preflight_etl_snapshot_delete_apply_candidate:boolean}>(
        'SELECT control.preflight_etl_snapshot_delete_apply_candidate($1,$2,$3::uuid,$4::uuid,$5::uuid)',
        [claim.tenant_key,claim.source_id,claim.run_id,candidate.candidate_id,claim.claim_token]);
      if(preflight.rows[0]?.preflight_etl_snapshot_delete_apply_candidate!==true) {
        clearInterval(heartbeat);
        await Promise.all(pendingHeartbeats);
        if(heartbeatError) throw heartbeatError;
        await pool.query("SELECT control.finish_etl_snapshot_delete_apply($1,$2,$3::uuid,$4::uuid,'STALE','D_AUTHORITY_OR_PROOF_STALE')",
          [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]);
        return true;
      }
    }
    for(const candidate of candidates) {
      for(const member of candidate.members) {
        if(member.applied) continue;
        const item={run_id:claim.run_id,candidate_id:candidate.candidate_id,entity:candidate.entity,source_pk:member.source_pk,operation_id:member.operation_id};
        const committed=await transaction(pool,async client=>{
          const sourceLock=await client.query<{lock_etl_snapshot_source:boolean}>(
            'SELECT control.lock_etl_snapshot_source($1,$2)',[claim.tenant_key,claim.source_id]);
          if(sourceLock.rows[0]?.lock_etl_snapshot_source!==true) throw new Error('D_SOURCE_LOCK_LOST');
          const current=await client.query<{preflight_etl_snapshot_delete_apply_candidate:boolean}>(
            'SELECT control.preflight_etl_snapshot_delete_apply_candidate($1,$2,$3::uuid,$4::uuid,$5::uuid)',
            [claim.tenant_key,claim.source_id,claim.run_id,candidate.candidate_id,claim.claim_token]);
          if(current.rows[0]?.preflight_etl_snapshot_delete_apply_candidate!==true) return false;
          const ctx=applyContext(proof,candidate.entity);
          const input={source_pk:member.source_pk,source_version:member.sequence_value,deleted_at:member.inferred_completed_at};
          const applied:ApplyResult=candidate.entity==='customer'
            ? await applyCustomer(client,ctx,input)
            : await applyOrderAggregate(client,ctx,input);
          if(applied.status!=='APPLIED'||applied.objectId!==member.canonical_object_id) throw new Error('D_CANONICAL_OUTCOME_NOT_APPLIED');
          const saved=await client.query<{record_etl_snapshot_delete_effect:boolean}>(
            "SELECT control.record_etl_snapshot_delete_effect($1,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,'APPLIED')",
            [claim.tenant_key,claim.source_id,claim.run_id,candidate.candidate_id,candidate.entity,member.source_pk,claim.claim_token]);
          if(saved.rows[0]?.record_etl_snapshot_delete_effect!==true) throw new Error('D_EFFECT_OUTCOME_REJECTED');
          await hooks.beforeAggregateCommit?.(item);
          return true;
        });
        if(!committed) {
          clearInterval(heartbeat);
          await Promise.all(pendingHeartbeats);
          if(heartbeatError) throw heartbeatError;
          await pool.query("SELECT control.finish_etl_snapshot_delete_apply($1,$2,$3::uuid,$4::uuid,'STALE','D_CURRENTNESS_STALE')",
            [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]);
          return true;
        }
        await hooks.afterAggregateCommit?.(item);
        if(heartbeatError) throw heartbeatError;
      }
    }
    clearInterval(heartbeat);
    await Promise.all(pendingHeartbeats);
    if(heartbeatError) throw heartbeatError;
    await pool.query("SELECT control.finish_etl_snapshot_delete_apply($1,$2,$3::uuid,$4::uuid,'COMPLETE',NULL)",
      [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token]);
    return true;
  } catch(error) {
    clearInterval(heartbeat);
    await Promise.all(pendingHeartbeats);
    if(heartbeatError) error=heartbeatError;
    const code=error instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'D_APPLY_FAILED';
    await pool.query('SELECT control.retry_etl_snapshot_delete_apply($1,$2,$3::uuid,$4::uuid,$5)',
      [claim.tenant_key,claim.source_id,claim.run_id,claim.claim_token,code]).catch(()=>undefined);
    throw error;
  }
}

/** Consume durable C completion reservations in DB order using only the worker role. */
export async function runSnapshotDeleteWorkerOnce(pool: Pool, limit = 20,hooks:DeleteHooks={}): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('SNAPSHOT_DELETE_WORKER_OPTIONS_INVALID');
  const sources = await pool.query<{ tenant_key: string; source_id: string }>(`SELECT d.tenant_key,d.source_id
    FROM control.etl_snapshot_delete_run d
    WHERE d.status IN ('PENDING','AWAITING_OWNER','APPLYING')
    GROUP BY d.tenant_key,d.source_id
    ORDER BY min(d.last_worker_checked_at) NULLS FIRST,min(d.reservation_ordinal),d.tenant_key,d.source_id LIMIT $1`, [limit]);
  let processed = 0;
  for (const source of sources.rows) {
    for (let pass = 0; pass < limit; pass++) {
      const result = await pool.query<{ consume_etl_snapshot_delete_run: boolean }>(
        'SELECT control.consume_etl_snapshot_delete_run($1,$2)', [source.tenant_key, source.source_id]);
      if (!result.rows[0]?.consume_etl_snapshot_delete_run) break;
      processed++;
    }
  }
  for(const source of sources.rows) if(await applyClaim(pool,source,hooks)) processed++;
  return processed;
}
