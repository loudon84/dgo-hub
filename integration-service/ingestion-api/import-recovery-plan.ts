import type { PoolClient } from 'pg';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import { AuthError } from '../auth/errors.js';
import { verifyFrozenApplyContext, type ApplyContext } from '../normalization/apply.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';
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
const unavailable:ImportRecoveryCandidate={version:'import-recovery-plan.v1',kind:'UNAVAILABLE'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal=/^(?:0|[1-9][0-9]*)$/;
const digest=/^[0-9a-f]{64}$/;

// Missing includes an explicitly unbound original target as well as an absent key.
export function isMissingOriginalMapping(mapping:{target_id:string|null}|undefined):boolean {
 return !mapping || mapping.target_id===null;
}

/** The caller supplies an open transaction and keeps all acquired locks to its end. */
export async function readImportRecoveryCandidate(client:PoolClient, auth:Pick<AuthService,'assertCurrentPrincipal'>, principal:UserPrincipal, quarantineId:string):Promise<ImportRecoveryCandidate> {
 if (!principal || 'credentialId' in principal || typeof principal.issuer!=='string' || typeof principal.subject!=='string') throw new AuthError('AUTH_INVALID');
 if (!uuid.test(quarantineId)) throw new AuthError('AUTH_INPUT_INVALID');
 let envelope:{facts:Facts|null}|null;
 try {
  const query=await client.query<{value:{facts:Facts|null}|null}>('SELECT control.read_import_recovery_original($1,$2::uuid,$3,$4,$5,$6::bigint) AS value',
   [principal.tenantId,quarantineId,principal.userId,principal.issuer,principal.subject,principal.authEpoch]);
  envelope=query.rows[0]?.value ?? null;
 } catch(error) {
  if(typeof error==='object' && error!==null && 'code' in error && error.code==='42501') throw new AuthError('AUTH_FORBIDDEN');
  if(typeof error==='object' && error!==null && 'code' in error && error.code==='P0001' && 'message' in error && error.message==='AUTH_CONTEXT_CHANGED') throw new AuthError('AUTH_CONTEXT_CHANGED');
  throw error;
 }
 if(!envelope) throw new AuthError('SOURCE_NOT_FOUND');
 await auth.assertCurrentPrincipal(principal,'source:read',client);
 const f=envelope.facts;if(!f) return unavailable;
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
