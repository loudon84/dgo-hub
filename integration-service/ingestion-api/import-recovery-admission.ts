import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import { canonicalCustomerInput, canonicalOrderInput } from '../normalization/durable-record.js';
import { sourceContentDigest } from '../normalization/canonical.js';
import { validateHubBatch } from './strict-contract.js';
import { bindingInput, importRecoveryDigest, importRecoveryExpectedState, type ImportRecoveryRequest } from './import-recovery-contract.js';
import { readImportRecoveryBindingPlan, readImportRecoveryCandidate, readImportRecoveryCandidateForApproval } from './import-recovery-plan.js';

export class ImportRecoveryError extends Error {
 constructor(readonly code:'IMPORT_RECOVERY_CONFLICT'|'RECOVERY_SCOPE_UNAVAILABLE') {super(code);}
}
type Receipt={channelId:string;channelEpoch:string;sourceVersion:string;canonicalObjectId:string;contentDigest:string};
type Operation={operationId:string;childJobId:string;idempotencyKey:string;requestDigest:string;itemStatus:string;jobStatus:string;
 entity:'customer'|'order';batchId:string;record:unknown;receipt:Receipt|null};
type Lookup={sourceId:string;operation:Operation|null};
type Options={pool:Pool;authService:Pick<AuthService,'assertCurrentPrincipal'>};
function translate(error:unknown):never {
 if(typeof error==='object' && error!==null && 'code' in error) {
  if(error.code==='42501') throw new AuthError('AUTH_FORBIDDEN');
  if(error.code==='23505') throw new ImportRecoveryError('IMPORT_RECOVERY_CONFLICT');
  if(error.code==='P0001' && 'message' in error && error.message==='AUTH_CONTEXT_CHANGED') throw new AuthError('AUTH_CONTEXT_CHANGED');
  if(error.code==='P0001' && 'message' in error && error.message==='IMPORT_RECOVERY_CONFLICT') throw new ImportRecoveryError('IMPORT_RECOVERY_CONFLICT');
 }
 throw error;
}
async function lookup(client:PoolClient,auth:Options['authService'],principal:UserPrincipal,id:string,scope:'source:read'|'source:approve'):Promise<Lookup> {
 try {
  const result=await client.query<{value:Lookup|null}>('SELECT control.lookup_import_recovery($1,$2::uuid,$3,$4,$5,$6::bigint,$7) AS value',
   [principal.tenantId,id,principal.userId,principal.issuer,principal.subject,principal.authEpoch,scope]);
  const value=result.rows[0]?.value;if(!value) throw new AuthError('SOURCE_NOT_FOUND');
  await auth.assertCurrentPrincipal(principal,scope,client);
  return value;
 } catch(error) {return translate(error);}
}
function consumed(operation:Operation) {
 const terminal=['APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED'];
 const pending=['RECEIVED','VALIDATING','APPLYING','RETRY_PENDING'];
 const state=terminal.includes(operation.itemStatus)?operation.itemStatus:
  operation.jobStatus==='FAILED'?'FAILED':pending.includes(operation.itemStatus)?'ACCEPTED':null;
 if(!state) throw new AuthError('AUTH_UNAVAILABLE');
 let receipt:null|{channel_id:string;channel_epoch:string;source_version:string;canonical_object_id:string}=null;
 if(operation.receipt && state==='APPLIED') {
  try {
   const record=validateHubBatch({schema_version:'hub.v1',batch_id:operation.batchId,records:[operation.record]},operation.entity).records[0]!;
   const input=operation.entity==='customer'?canonicalCustomerInput(record):canonicalOrderInput({endpoint_profile_digest:null},record);
   if(sourceContentDigest(input)===operation.receipt.contentDigest) receipt={channel_id:operation.receipt.channelId,
    channel_epoch:operation.receipt.channelEpoch,source_version:operation.receipt.sourceVersion,canonical_object_id:operation.receipt.canonicalObjectId};
  } catch { /* A nonmatching or unusable receipt is not this operation's result. */ }
 }
 return {state,operation_id:operation.operationId,child_job_id:operation.childJobId,receipt};
}
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error) {await client.query('ROLLBACK').catch(()=>undefined);return translate(error);}
 finally {client.release();}
}
export async function getImportRecovery(options:Options,principal:UserPrincipal,id:string) {
 return transaction(options.pool,async client=>{
  const found=await lookup(client,options.authService,principal,id,'source:read');
  if(found.operation) return consumed(found.operation);
  const candidate=await readImportRecoveryCandidate(client,options.authService,principal,id);
  if(candidate.kind!=='ELIGIBLE') return {state:'SCOPE_UNAVAILABLE'};
  const missing=candidate.missing.map(key=>key.kind==='customer'
   ?{kind:key.kind,source_id:key.sourceId,source_pk:key.sourcePk}:{kind:key.kind,external_id:key.externalId});
  return {state:'AVAILABLE',expected_state:importRecoveryExpectedState(id),expected_source_revision:candidate.current.sourceRevision,
   identity_mapping_revision:candidate.current.identityMappingRevision,identity_mapping_digest:candidate.current.identityMappingDigest,missing};
 });
}
export async function postImportRecovery(options:Options,principal:UserPrincipal,id:string,key:string,body:ImportRecoveryRequest) {
 return transaction(options.pool,async client=>{
  const found=await lookup(client,options.authService,principal,id,'source:approve');
  const route=`/hub/v1/admin/quarantine/${id}/import-recovery`;
  const digest=importRecoveryDigest(principal.tenantId,found.sourceId,route,id,body);
  if(found.operation) {
   if(found.operation.idempotencyKey!==key) throw new ImportRecoveryError('IMPORT_RECOVERY_CONFLICT');
   if(found.operation.requestDigest!==digest.toString('hex')) throw new AuthError('IDEMPOTENCY_CONFLICT');
   return {operation_id:found.operation.operationId,child_job_id:found.operation.childJobId,status:'ACCEPTED' as const};
  }
  if(body.expected_state!==importRecoveryExpectedState(id)) throw new ImportRecoveryError('IMPORT_RECOVERY_CONFLICT');
  const {candidate,conflict}=await readImportRecoveryCandidateForApproval(client,options.authService,principal,id);
  if(candidate.kind!=='ELIGIBLE') throw new ImportRecoveryError(conflict?'IMPORT_RECOVERY_CONFLICT':'RECOVERY_SCOPE_UNAVAILABLE');
  const plan=await readImportRecoveryBindingPlan(client,options.authService,principal,id,bindingInput(body));
  if(plan.kind!=='ELIGIBLE') throw new ImportRecoveryError('IMPORT_RECOVERY_CONFLICT');
  const operation=randomUUID(),child=randomUUID();
  await client.query(`SELECT control.admit_import_recovery($1,$2::uuid,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11::bigint,$12::bigint,$13,$14::jsonb,$15::uuid,$16::uuid)`,
   [principal.tenantId,id,principal.userId,principal.issuer,principal.subject,principal.authEpoch,key,digest,body.expected_state,body.reason,
    body.expected_source_revision,body.identity_mapping_revision,Buffer.from(body.identity_mapping_digest,'hex'),JSON.stringify(plan.confirmedBindings),operation,child]);
  await options.authService.assertCurrentPrincipal(principal,'source:approve',client);
  return {operation_id:operation,child_job_id:child,status:'ACCEPTED' as const};
 });
}
