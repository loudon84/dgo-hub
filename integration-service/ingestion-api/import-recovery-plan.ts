import type { PoolClient } from 'pg';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import { AuthError } from '../auth/errors.js';
import { verifyFrozenApplyContext, type ApplyContext } from '../normalization/apply.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';
import { frozenProof } from './strict-ingestion.js';
import { IngestInputError, validateHubBatch } from './strict-contract.js';

type Key = {kind:'user'|'department';externalId:string} | {kind:'customer';sourceId:string;sourcePk:string;externalId:string};
type Binding = Key & {targetId:string};
type Proof = {credentialId:string;sourceEpoch:string;credentialRevision:string;credentialGeneration:string;channelId:string;channelEpoch:string;
 ownerUserId:string;ownerRevision:string;approvalId:string;approvalSecurityFence:string;configRevision:string;configDigest:string;
 mappingRevision:string;mappingDigest:string;identityMappingRevision:string;identityMappingDigest:string;endpointProfileDigest:null;
 testReportId:string;sampleDigest:string;securityFence:string};
type Original = {quarantineId:string;jobId:string;ordinal:number;tenantId:string;sourceId:string;entity:'customer'|'order';rawBatchId:string;
 requestDigest:string;eventId:string;sourcePk:string;sourceVersion:string;operation:'UPSERT';sourceUpdatedAt:string;
 publicRecord:Record<string,unknown>;proof:Proof};
export type ImportRecoveryCandidate = {version:'import-recovery-plan.v1';kind:'UNAVAILABLE'} |
 {version:'import-recovery-plan.v1';kind:'ELIGIBLE';original:Original;missing:Key[];resolved:Binding[];ownObjectId:string|null;
 current:{sourceRevision:string;identityMappingRevision:string;identityMappingDigest:string}};
type Facts = Original & {batchId:string;current:Extract<ImportRecoveryCandidate,{kind:'ELIGIBLE'}>['current'];ownObjectId:string|null;
 userOk:boolean;userDepartment:string|null;departmentOk:boolean;referenceObjectId:string|null;referenceCustomerId:string|null;customerOk:boolean;
 fences:{kind:string;externalId:string;revision:string}[]};
const unavailable:Extract<ImportRecoveryCandidate,{kind:'UNAVAILABLE'}>={version:'import-recovery-plan.v1',kind:'UNAVAILABLE'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal=/^(?:0|[1-9][0-9]*)$/;
const digest=/^[0-9a-f]{64}$/;

// Missing includes an explicitly unbound original target as well as an absent key.
export function isMissingOriginalMapping(mapping:{target_id:string|null}|undefined):boolean {
 return !mapping || mapping.target_id===null;
}

type TargetFacts={userOk:boolean;userDepartment:string|null;departmentOk:boolean};
type Envelope={facts:Facts|null;target:TargetFacts;currentFences:{kind:string;externalId:string;revision:string}[]};
async function authorize(client:PoolClient,auth:Pick<AuthService,'assertCurrentPrincipal'>,principal:UserPrincipal,quarantineId:string,scope:'source:read'|'source:approve'):Promise<Envelope> {
 if (!principal || 'credentialId' in principal || typeof principal.issuer!=='string' || typeof principal.subject!=='string') throw new AuthError('AUTH_INVALID');
 if (!uuid.test(quarantineId)) throw new AuthError('AUTH_INPUT_INVALID');
 let envelope:Envelope|null;
 try {
  const query=await client.query<{value:Envelope|null}>(`SELECT control.${scope==='source:read'?'read_import_recovery_original':'read_import_recovery_for_approval'}($1,$2::uuid,$3,$4,$5,$6::bigint) AS value`,
   [principal.tenantId,quarantineId,principal.userId,principal.issuer,principal.subject,principal.authEpoch]);
  envelope=query.rows[0]?.value ?? null;
 } catch(error) {
  if(typeof error==='object' && error!==null && 'code' in error && error.code==='42501') throw new AuthError('AUTH_FORBIDDEN');
  if(typeof error==='object' && error!==null && 'code' in error && error.code==='P0001' && 'message' in error && error.message==='AUTH_CONTEXT_CHANGED') throw new AuthError('AUTH_CONTEXT_CHANGED');
  throw error;
 }
 if(!envelope) throw new AuthError('SOURCE_NOT_FOUND');
 await auth.assertCurrentPrincipal(principal,scope,client);
 return envelope;
}

async function assemble(client:PoolClient,principal:UserPrincipal,quarantineId:string,f:Facts|null):Promise<ImportRecoveryCandidate> {
 if(!f) return unavailable;
 const p=f.proof;
 if(![f.quarantineId,f.jobId,f.rawBatchId,f.batchId,f.eventId,p.credentialId,p.channelId,p.approvalId,p.testReportId].every(x=>typeof x==='string' && uuid.test(x)) ||
   (f.ownObjectId!==null && !uuid.test(f.ownObjectId)) || !Number.isInteger(f.ordinal) || f.ordinal<0 || f.ordinal>99 ||
   ![f.sourceVersion,p.sourceEpoch,p.credentialRevision,p.credentialGeneration,p.channelEpoch,p.ownerRevision,p.approvalSecurityFence,p.configRevision,p.mappingRevision,p.identityMappingRevision,p.securityFence,f.current?.sourceRevision,f.current?.identityMappingRevision].every(x=>typeof x==='string' && decimal.test(x)) ||
   ![f.requestDigest,p.configDigest,p.mappingDigest,p.identityMappingDigest,p.sampleDigest,f.current?.identityMappingDigest].every(x=>typeof x==='string' && digest.test(x)) ||
   p.endpointProfileDigest!==null || f.tenantId!==principal.tenantId || f.quarantineId!==quarantineId || !['customer','order'].includes(f.entity)) return unavailable;
 let record:ReturnType<typeof validateHubBatch>['records'][number];
 try {record=validateHubBatch({schema_version:'hub.v1',batch_id:f.batchId,records:[f.publicRecord]},f.entity).records[0]!;}
 catch(error){if(error instanceof IngestInputError) return unavailable;throw error;}
 if(record.event_id.toLowerCase()!==f.eventId || record.source_pk!==f.sourcePk || record.source_version!==f.sourceVersion || record.operation!=='UPSERT' || !record.data) return unavailable;
 const sameTime=await client.query<{same:boolean}>('SELECT $1::timestamptz=$2::timestamptz AS same',[record.source_updated_at,f.sourceUpdatedAt]);
 if(!sameTime.rows[0]?.same) return unavailable;
 const context:ApplyContext={tenantId:f.tenantId,sourceId:f.sourceId,entity:f.entity,credentialId:p.credentialId,sourceEpochAtAdmission:p.sourceEpoch,
 credentialRevisionAtAdmission:p.credentialRevision,credentialGenerationAtAdmission:p.credentialGeneration,channelId:p.channelId,channelEpoch:p.channelEpoch,
 versionDomain:'SOURCE_VERSION',ownerApprovalId:p.approvalId,ownerUserId:p.ownerUserId,ownerRevision:p.ownerRevision,configRevision:p.configRevision,
 configDigest:p.configDigest,mappingRevision:p.mappingRevision,mappingDigest:p.mappingDigest,identityMappingRevision:p.identityMappingRevision,
 identityMappingDigest:p.identityMappingDigest,endpointProfileDigest:null,importRoute:`/hub/v1/admin/sources/${f.sourceId}/import/${f.entity}`,
 testReportId:p.testReportId,securityBarrierFenceAtAdmission:p.securityFence};
 let frozen:Awaited<ReturnType<typeof verifyFrozenApplyContext>>;
 try {frozen=await verifyFrozenApplyContext(client,context);} catch(error) {
  if(error instanceof Error && error.message==='CANONICAL_APPLY_PROOF_INVALID') return unavailable;
  throw error;
 }
 if('status' in frozen) return unavailable;
 const seen=new Set<string>();
 for(const m of frozen.identity_mappings) {
  if(!m || typeof m!=='object' || Array.isArray(m) || Object.keys(m).length!==3 || Object.keys(m).some(k=>!['kind','external_id','target_id'].includes(k)) ||
     !['user','department','customer'].includes(m.kind) || typeof m.external_id!=='string' || m.external_id.length<1 || m.external_id.length>256 || /[\u0000-\u001f\u007f]/.test(m.external_id) ||
     (m.target_id!==null && (typeof m.target_id!=='string' || m.target_id.length<1 || m.target_id.length>256 || /[\u0000-\u001f\u007f]/.test(m.target_id)))) return unavailable;
  const id=JSON.stringify([m.kind,m.external_id]);if(seen.has(id)) return unavailable;seen.add(id);
 }
 let keys:Key[];
 if(f.entity==='customer' && !('customer_ref' in record.data)) keys=[{kind:'user',externalId:record.data.owner_external_id},{kind:'department',externalId:record.data.department_external_id}];
 else if(f.entity==='order' && 'customer_ref' in record.data) {
  if(!f.customerOk || !f.referenceObjectId || f.referenceObjectId!==f.referenceCustomerId) return unavailable;
  const ref=record.data.customer_ref; keys=[{kind:'customer',sourceId:ref.source_id,sourcePk:ref.source_pk,externalId:customerReferenceMappingKey(ref.source_id,ref.source_pk)}];
 } else return unavailable;
 const missing:Key[]=[],resolved:Binding[]=[];
 for(const key of keys) {
  const mapping=frozen.identity_mappings.find(x=>x.kind===key.kind && x.external_id===key.externalId);
  if(isMissingOriginalMapping(mapping)) {missing.push(key);continue;}
  if(!mapping || mapping.target_id===null) return unavailable;
  // An order target was already resolved at original admission; it cannot be repaired by this slice.
  if(key.kind==='customer') return unavailable;
  if(f.fences.some(x=>x.kind===key.kind && x.externalId===key.externalId && BigInt(x.revision)>BigInt(p.identityMappingRevision))) return unavailable;
  if((key.kind==='user' && !f.userOk) || (key.kind==='department' && !f.departmentOk)) return unavailable;
  resolved.push({...key,targetId:mapping.target_id});
 }
 const user=resolved.find(x=>x.kind==='user'),dept=resolved.find(x=>x.kind==='department');
 if(user && dept && f.userDepartment!==dept.targetId) return unavailable;
 if(!missing.length) return unavailable;
 const original:Original={quarantineId:f.quarantineId,jobId:f.jobId,ordinal:f.ordinal,tenantId:f.tenantId,sourceId:f.sourceId,entity:f.entity,
 rawBatchId:f.rawBatchId,requestDigest:f.requestDigest,eventId:f.eventId,sourcePk:f.sourcePk,sourceVersion:f.sourceVersion,operation:'UPSERT',
 sourceUpdatedAt:record.source_updated_at,publicRecord:record as unknown as Record<string,unknown>,proof:p};
 return {version:'import-recovery-plan.v1',kind:'ELIGIBLE',original,missing,resolved,ownObjectId:f.ownObjectId,current:f.current};
}

/** The caller supplies an open transaction and retains its locks until transaction end. */
export async function readImportRecoveryCandidate(client:PoolClient,auth:Pick<AuthService,'assertCurrentPrincipal'>,principal:UserPrincipal,quarantineId:string):Promise<ImportRecoveryCandidate> {
 const envelope=await authorize(client,auth,principal,quarantineId,'source:read');
 return assemble(client,principal,quarantineId,envelope.facts);
}
export type ImportRecoveryBindingInput={expectedSourceRevision:string;identityMappingRevision:string;identityMappingDigest:string;bindings:Binding[]};
export type ImportRecoveryPlan=Extract<ImportRecoveryCandidate,{kind:'UNAVAILABLE'}> | (Extract<ImportRecoveryCandidate,{kind:'ELIGIBLE'}> & {bindingProof:Proof;confirmedBindings:Binding[];observedFence:string});
const positiveBigint=(x:unknown):x is string=>typeof x==='string' && /^[1-9][0-9]*$/.test(x) && x.length<=19 && BigInt(x)<=9223372036854775807n;
const identifier=(x:unknown):x is string=>typeof x==='string' && x.length<=128 && /^(?!\s)[\s\S]{1,128}(?<!\s)$/u.test(x) && !/[\u0000-\u001f\u007f]/.test(x) && !/[\uD800-\uDFFF]/.test(x.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,''));
const validText=(x:unknown):x is string=>typeof x==='string' && x.length>0 && x.length<=256 && !/[\u0000-\u001f\u007f]/.test(x);
function parseInput(value:unknown):ImportRecoveryBindingInput {
 if(!value || typeof value!=='object' || Array.isArray(value)) throw new AuthError('AUTH_INPUT_INVALID');
 const input=value as Record<string,unknown>;
 if(Object.keys(input).sort().join(',')!=='bindings,expectedSourceRevision,identityMappingDigest,identityMappingRevision' || !positiveBigint(input.expectedSourceRevision) || !positiveBigint(input.identityMappingRevision) || typeof input.identityMappingDigest!=='string' || !digest.test(input.identityMappingDigest) || !Array.isArray(input.bindings) || input.bindings.length<1 || input.bindings.length>2) throw new AuthError('AUTH_INPUT_INVALID');
 const seen=new Set<string>();
 for(const item of input.bindings) {
  if(!item || typeof item!=='object' || Array.isArray(item)) throw new AuthError('AUTH_INPUT_INVALID');
  const b=item as Record<string,unknown>;
  if(b.kind==='user' || b.kind==='department') {
   if(Object.keys(b).sort().join(',')!=='externalId,kind,targetId' || !identifier(b.externalId) || !validText(b.targetId)) throw new AuthError('AUTH_INPUT_INVALID');
  } else if(b.kind==='customer') {
   if(Object.keys(b).sort().join(',')!=='externalId,kind,sourceId,sourcePk,targetId' || typeof b.sourceId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(b.sourceId) || !identifier(b.sourcePk) || !validText(b.externalId) || b.externalId!==customerReferenceMappingKey(b.sourceId,b.sourcePk) || typeof b.targetId!=='string' || !uuid.test(b.targetId)) throw new AuthError('AUTH_INPUT_INVALID');
  } else throw new AuthError('AUTH_INPUT_INVALID');
  const id=JSON.stringify([b.kind,b.externalId]);if(seen.has(id)) throw new AuthError('AUTH_INPUT_INVALID');seen.add(id);
 }
 return input as ImportRecoveryBindingInput;
}
/** No writes or transaction boundaries; admission must recompute while holding these locks. */
export async function readImportRecoveryBindingPlan(client:PoolClient,auth:Pick<AuthService,'assertCurrentPrincipal'>,principal:UserPrincipal,quarantineId:string,input:ImportRecoveryBindingInput):Promise<ImportRecoveryPlan> {
 const parsed=parseInput(input);
 const envelope=await authorize(client,auth,principal,quarantineId,'source:approve');
 const candidate=await assemble(client,principal,quarantineId,envelope.facts);
 if(candidate.kind!=='ELIGIBLE') return unavailable;
 const {original,current}=candidate;
 if(current.sourceRevision!==parsed.expectedSourceRevision || current.identityMappingRevision!==parsed.identityMappingRevision || current.identityMappingDigest!==parsed.identityMappingDigest) return unavailable;
 if(parsed.bindings.length!==candidate.missing.length) return unavailable;
 if(!Array.isArray(envelope.currentFences) || envelope.currentFences.some(f=>!decimal.test(f.revision) || BigInt(f.revision)>BigInt(current.identityMappingRevision))) return unavailable;
 const confirmed:Binding[]=[];
 for(const key of candidate.missing) {
  const binding=parsed.bindings.find(b=>b.kind===key.kind && b.externalId===key.externalId);
  if(!binding || (key.kind==='customer' && (binding.kind!=='customer' || binding.sourceId!==key.sourceId || binding.sourcePk!==key.sourcePk))) return unavailable;
  confirmed.push(binding);
 }
 const credential=await client.query<{id:string}>('SELECT id FROM control.lock_source_credential($1,$2)',[original.tenantId,original.sourceId]);
 if(!credential.rowCount) return unavailable;
 await client.query('SELECT * FROM control.lock_source_channel($1,$2,$3)',[original.tenantId,original.sourceId,original.entity]);
 let proof:Awaited<ReturnType<typeof frozenProof>>;
 try {proof=await frozenProof(client,{tenantId:original.tenantId,sourceId:original.sourceId,credentialId:credential.rows[0]!.id},original.entity,true);}
 catch(error) {if(error instanceof AuthError && error.code==='SOURCE_CONFLICT') return unavailable;throw error;}
 if(proof.owner_user_id!==principal.userId || proof.config_revision!==parsed.expectedSourceRevision || proof.identity_mapping_revision!==parsed.identityMappingRevision || proof.identity_mapping_digest.toString('hex')!==parsed.identityMappingDigest) return unavailable;
 const barrier=await client.query(`SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=$1 AND b.effective_fence>$2::bigint AND (b.source_id IS NULL OR b.source_id=$3) AND (b.credential_id IS NULL OR b.credential_id=$4) AND (b.entity IS NULL OR b.entity=$5) AND (b.channel_id IS NULL OR b.channel_id=$6) AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED') LIMIT 1`,[original.tenantId,proof.approval_security_fence,original.sourceId,proof.credential_id,original.entity,proof.channel_id]);
 if(barrier.rowCount) return unavailable;
 const selected=await client.query<{mappings:unknown;sample_digest:Buffer}>(`SELECT i.mappings,a.sample_digest FROM control.source_owner_approval a JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision) WHERE a.id=$1 AND a.tenant_key=$2 AND a.source_id=$3`,[proof.owner_approval_id,original.tenantId,original.sourceId]);
 const row=selected.rows[0];if(!row || !Array.isArray(row.mappings) || !Buffer.isBuffer(row.sample_digest)) return unavailable;
 const mappings=row.mappings as {kind:string;external_id:string;target_id:string|null}[];
 const seen=new Set<string>();
 for(const m of mappings) {
  if(!m || typeof m!=='object' || Array.isArray(m) || Object.keys(m).sort().join(',')!=='external_id,kind,target_id' || !['user','department','customer'].includes(m.kind) || !validText(m.external_id) || (m.target_id!==null && !validText(m.target_id))) return unavailable;
  const k=JSON.stringify([m.kind,m.external_id]);if(seen.has(k)) return unavailable;seen.add(k);
 }
 for(const b of [...candidate.resolved,...confirmed]) if(!mappings.some(m=>m.kind===b.kind && m.external_id===b.externalId && m.target_id===b.targetId)) return unavailable;
 if(original.entity==='customer') {
  const user=[...candidate.resolved,...confirmed].find(b=>b.kind==='user'),dept=[...candidate.resolved,...confirmed].find(b=>b.kind==='department');
  if(!user || !dept || !envelope.target.userOk || !envelope.target.departmentOk || envelope.target.userDepartment!==dept.targetId) return unavailable;
 } else if(confirmed[0]?.targetId!==envelope.facts?.referenceObjectId || !envelope.facts?.customerOk || envelope.facts.referenceObjectId!==envelope.facts.referenceCustomerId) return unavailable;
 const fence=await client.query<{fence:string}>('SELECT control.lock_security_barrier_fence()::text AS fence');
 const observedFence=fence.rows[0]!.fence;
 const bindingProof:Proof={credentialId:proof.credential_id,sourceEpoch:proof.source_epoch,credentialRevision:proof.credential_revision,credentialGeneration:proof.credential_generation,channelId:proof.channel_id,channelEpoch:proof.channel_epoch,ownerUserId:proof.owner_user_id,ownerRevision:proof.owner_revision,approvalId:proof.owner_approval_id,approvalSecurityFence:proof.approval_security_fence,configRevision:proof.config_revision,configDigest:proof.config_digest.toString('hex'),mappingRevision:proof.mapping_revision,mappingDigest:proof.mapping_digest.toString('hex'),identityMappingRevision:proof.identity_mapping_revision,identityMappingDigest:proof.identity_mapping_digest.toString('hex'),endpointProfileDigest:null,testReportId:proof.test_report_id,sampleDigest:row.sample_digest.toString('hex'),securityFence:observedFence};
 return {...candidate,bindingProof,confirmedBindings:confirmed,observedFence};
}
