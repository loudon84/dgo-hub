import type { PoolClient } from 'pg';
import { z } from 'zod';
import { validateHubBatch } from '../ingestion-api/strict-contract.js';
import { verifyFrozenApplyContext, type ApplyContext } from '../normalization/apply.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const decimal=z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const proof=z.object({
 credentialId:uuid,sourceEpoch:decimal,credentialRevision:decimal,credentialGeneration:decimal,
 channelId:uuid,channelEpoch:decimal,ownerUserId:z.string().min(1),ownerRevision:decimal,approvalId:uuid,
 approvalSecurityFence:decimal,configRevision:decimal,configDigest:digest,mappingRevision:decimal,mappingDigest:digest,
 identityMappingRevision:decimal,identityMappingDigest:digest,endpointProfileDigest:z.null(),testReportId:uuid,
 sampleDigest:digest,securityFence:decimal,
}).strict();
const binding=z.union([
 z.object({kind:z.enum(['user','department']),externalId:z.string().min(1),targetId:z.string().min(1)}).strict(),
 z.object({kind:z.literal('customer'),sourceId:z.string().min(1),sourcePk:z.string().min(1),externalId:z.string().min(1),targetId:uuid}).strict(),
]);
const envelope=z.object({
 operationId:uuid,reservedObjectId:uuid,entity:z.enum(['customer','order']),observedFence:decimal,
 actor:z.object({userId:z.string().min(1),issuer:z.string().min(1),subject:z.string().min(1),authEpoch:decimal,ownerRevision:decimal}).strict(),
 confirmedBindings:z.array(binding).min(1).max(2),bindingProof:proof,
 original:z.object({quarantineId:uuid,jobId:uuid,ordinal:z.number().int().min(0).max(99),batchId:uuid,eventId:uuid,
  sourcePk:z.string().min(1),sourceVersion:decimal,sourceUpdatedAt:z.string(),publicRecord:z.unknown(),proof}).strict(),
}).strict();
type Proof=z.infer<typeof proof>;
export type ImportRecoveryWorkerScope=Readonly<{tenantId:string;sourceId:string;jobId:string;ordinal:number;itemOperationId:string;claimToken:string}>;

function applyContext(scope:ImportRecoveryWorkerScope,entity:'customer'|'order',p:Proof):ApplyContext {
 return {tenantId:scope.tenantId,sourceId:scope.sourceId,entity,credentialId:p.credentialId,sourceEpochAtAdmission:p.sourceEpoch,
  credentialRevisionAtAdmission:p.credentialRevision,credentialGenerationAtAdmission:p.credentialGeneration,channelId:p.channelId,
  channelEpoch:p.channelEpoch,versionDomain:'SOURCE_VERSION',ownerApprovalId:p.approvalId,ownerUserId:p.ownerUserId,
  ownerRevision:p.ownerRevision,configRevision:p.configRevision,configDigest:p.configDigest,mappingRevision:p.mappingRevision,
  mappingDigest:p.mappingDigest,identityMappingRevision:p.identityMappingRevision,identityMappingDigest:p.identityMappingDigest,
  endpointProfileDigest:null,importRoute:`/hub/v1/admin/sources/${scope.sourceId}/import/${entity}`,testReportId:p.testReportId,
  securityBarrierFenceAtAdmission:p.securityFence};
}

/** Caller owns an open transaction; returned proof is usable only while its locks are held. */
export async function readImportRecoveryWorkerContext(client:PoolClient,scope:ImportRecoveryWorkerScope) {
 const row=await client.query<{value:unknown}>(`SELECT control.read_import_recovery_worker_context($1,$2,$3::uuid,$4,$5::uuid,$6::uuid) AS value`,
  [scope.tenantId,scope.sourceId,scope.jobId,scope.ordinal,scope.itemOperationId,scope.claimToken]);
 const parsed=envelope.safeParse(row.rows[0]?.value);
 if(!parsed.success) throw new Error('IMPORT_RECOVERY_CONTEXT_INVALID');
 const value=parsed.data;
 let record:ReturnType<typeof validateHubBatch>['records'][number];
 try {record=validateHubBatch({schema_version:'hub.v1',batch_id:value.original.batchId,records:[value.original.publicRecord]},value.entity).records[0]!;}
 catch {throw new Error('IMPORT_RECOVERY_CONTEXT_INVALID');}
 if(record.event_id.toLowerCase()!==value.original.eventId.toLowerCase() || record.source_pk!==value.original.sourcePk ||
  record.source_version!==value.original.sourceVersion || record.operation!=='UPSERT' || !record.data) throw new Error('IMPORT_RECOVERY_CONTEXT_INVALID');
 const sameTime=await client.query<{same:boolean}>('SELECT $1::timestamptz=$2::timestamptz AS same',[record.source_updated_at,value.original.sourceUpdatedAt]);
 if(!sameTime.rows[0]?.same) throw new Error('IMPORT_RECOVERY_CONTEXT_INVALID');
 const originalContext=applyContext(scope,value.entity,value.original.proof);
 const bindingContext=applyContext(scope,value.entity,value.bindingProof);
 async function validate(p:Proof,context:ApplyContext) {
  if(BigInt(p.approvalSecurityFence)>BigInt(p.securityFence) || BigInt(p.securityFence)>BigInt(value.observedFence)) throw new Error('IMPORT_RECOVERY_PROOF_INVALID');
  const approval=await client.query<{sample:string|null;fence:string}>(`SELECT encode(sample_digest,'hex') AS sample,approval_security_fence::text AS fence
   FROM control.source_owner_approval WHERE tenant_key=$1 AND source_id=$2 AND id=$3::uuid`,[scope.tenantId,scope.sourceId,p.approvalId]);
  if(approval.rows[0]?.sample!==p.sampleDigest || approval.rows[0]?.fence!==p.approvalSecurityFence) throw new Error('IMPORT_RECOVERY_PROOF_INVALID');
  try {
   const result=await verifyFrozenApplyContext(client,context);
   if('status' in result) throw new Error('IMPORT_RECOVERY_PROOF_INVALID');
   return result;
  } catch(error) {
   if(error instanceof Error && error.message==='CANONICAL_APPLY_PROOF_INVALID') throw new Error('IMPORT_RECOVERY_PROOF_INVALID');
   throw error;
  }
 }
 const originalProof=await validate(value.original.proof,originalContext);
 const bindingProof=await validate(value.bindingProof,bindingContext);
 // The lease can expire while the independent proofs are being checked. Do not renew it here.
 const liveClaim=await client.query(`SELECT 1 FROM control.ingestion_processing_outbox o
  JOIN control.ingestion_job j ON j.id=o.job_id WHERE o.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3
   AND o.claim_token=$4::uuid AND o.acknowledged_at IS NULL AND o.lease_expires_at>clock_timestamp()`,
 [scope.jobId,scope.tenantId,scope.sourceId,scope.claimToken]);
 if(!liveClaim.rowCount) throw new Error('WORKER_CLAIM_LOST');
 return {operationId:value.operationId,reservedObjectId:value.reservedObjectId,entity:value.entity,actor:value.actor,
  observedFence:value.observedFence,confirmedBindings:value.confirmedBindings,
  original:{quarantineId:value.original.quarantineId,jobId:value.original.jobId,ordinal:value.original.ordinal,
   sourcePk:value.original.sourcePk,sourceVersion:value.original.sourceVersion,record},
  originalContext,bindingContext,originalProof,bindingProof};
}
