import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AuthError } from '../auth/errors.js';
import type { SourceEntity } from '../auth/types.js';
import { mapImportSample } from '../source-registry/import-sample.js';
import type { FieldMapping } from '../source-registry/service.js';
import { canonicalJson, IngestInputError, parseStrictJson, STRICT_INGEST_BODY_LIMIT } from './strict-contract.js';
import { bearer, findExisting, frozenProof, idempotencyKey, sendFailure, sourceTimeRange, sourceToken, success, type StrictIngestionOptions } from './strict-ingestion.js';

export async function registerManagementImportRoutes(app: FastifyInstance, options: StrictIngestionOptions): Promise<void> {
  app.register(async intake=>{
    intake.removeContentTypeParser('application/json');
    intake.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    intake.setErrorHandler((error,request,reply)=>sendFailure(request,reply,error));
    intake.post<{Params:{id:string;entity:string}}>('/hub/v1/admin/sources/:id/import/:entity',{bodyLimit:STRICT_INGEST_BODY_LIMIT},async(request,reply)=>{
      try {
        const entity=request.params.entity as SourceEntity, sourceId=request.params.id;
        if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sourceId) || !['customer','order'].includes(entity)) throw new AuthError('AUTH_INPUT_INVALID');
        const token=bearer(request); if(sourceToken(token) || !options.authenticator) throw new AuthError('AUTH_INVALID');
        const actor=await options.authenticator(token);
        if(!actor.managementScopes.includes('source:write')) throw new AuthError('AUTH_FORBIDDEN');
        const key=idempotencyKey(request), raw=request.body;
        if(!Buffer.isBuffer(raw)) throw new IngestInputError('INGEST_INPUT_INVALID','/');
        const original=parseStrictJson(raw);
        const route=`/hub/v1/admin/sources/${sourceId}/import/${entity}`;
        const digest=createHash('sha256').update(['hub.ingest.v1',actor.tenantId,sourceId,route,canonicalJson(original)].join('\0'),'utf8').digest();
        if(!options.rawStoragePolicy) throw new AuthError('AUTH_UNAVAILABLE');
        const client=await options.pool.connect(); let begun=false;
        try {
          await client.query('BEGIN'); begun=true;
          const fence=await client.query<{fence:string}>('SELECT control.lock_security_barrier_fence()::text AS fence');
          const credential=await client.query<{id:string;enabled:boolean;allowed_entities:string[]}>('SELECT * FROM control.lock_source_credential($1,$2)',[actor.tenantId,sourceId]);
          const source=await client.query<{lifecycle:string;connector:string;data_owner_user_id:string}>(`SELECT r.lifecycle,r.data_owner_user_id,cr.config->>'connector' AS connector FROM control.source_registry r JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision) WHERE r.tenant_key=$1 AND r.source_id=$2 FOR UPDATE OF r`,[actor.tenantId,sourceId]);
          await options.authService.assertCurrentPrincipal(actor,'source:write',client);
          if(!source.rowCount || source.rows[0]!.connector!=='SIMULATED_IMPORT') throw new AuthError('SOURCE_NOT_FOUND');
          const existing=await findExisting(client,{tenantId:actor.tenantId,sourceId},route,key);
          if(existing.rowCount) {
            const row=existing.rows[0]!; if(!row.request_digest.equals(digest)) throw new AuthError('IDEMPOTENCY_CONFLICT');
            await client.query('COMMIT'); begun=false;
            return reply.code(202).send(success(request,{job_id:row.id,status:row.status,received_count:row.received_count,applied_count:row.applied_count}));
          }
          if(!credential.rowCount || !credential.rows[0]!.enabled || !credential.rows[0]!.allowed_entities.includes(entity) || source.rows[0]!.lifecycle!=='ACTIVE') throw new AuthError('SOURCE_CONFLICT');
          await client.query('SELECT * FROM control.lock_source_channel($1,$2,$3)',[actor.tenantId,sourceId,entity]);
          const owner=await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 AND enabled FOR UPDATE',[actor.tenantId,source.rows[0]!.data_owner_user_id]);
          if(!owner.rowCount) throw new AuthError('SOURCE_CONFLICT');
          const proof=await frozenProof(client,{tenantId:actor.tenantId,sourceId,credentialId:credential.rows[0]!.id},entity,true);
          const barrier=await client.query(`SELECT 1 FROM control.source_security_barrier b WHERE b.tenant_key=$1 AND b.effective_fence>$2::bigint AND (b.source_id IS NULL OR b.source_id=$3) AND (b.credential_id IS NULL OR b.credential_id=$4) AND (b.entity IS NULL OR b.entity=$5) AND (b.channel_id IS NULL OR b.channel_id=$6) AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED') LIMIT 1`,[actor.tenantId,proof.approval_security_fence,sourceId,proof.credential_id,entity,proof.channel_id]);
          if(barrier.rowCount) throw new AuthError('SOURCE_CONFLICT');
          const mapping=await client.query<{mappings:FieldMapping[]}>('SELECT mappings FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3',[actor.tenantId,sourceId,proof.mapping_revision]);
          let batch; try {batch=mapImportSample(raw.toString('utf8'),entity,sourceId,mapping.rows[0]!.mappings);} catch(error) { if(error instanceof IngestInputError) throw error; throw new IngestInputError('INGEST_INPUT_INVALID','/'); }
          const range=sourceTimeRange(batch), rawId=randomUUID();
          await client.query('INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes) VALUES($1,$2,$3,$4,$5)',[rawId,actor.tenantId,sourceId,route,raw]);
          const job=await client.query<{id:string}>(`INSERT INTO control.ingestion_job(tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED',$9,0,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING id`,[actor.tenantId,sourceId,entity,route,batch.batch_id,rawId,key,digest,batch.records.length,proof.credential_id,proof.source_epoch,proof.credential_revision,proof.credential_generation,proof.channel_id,proof.channel_epoch,proof.version_domain,proof.owner_approval_id,proof.owner_user_id,proof.owner_revision,proof.approval_security_fence,proof.config_revision,proof.config_digest,proof.mapping_revision,proof.mapping_digest,proof.identity_mapping_revision,proof.identity_mapping_digest,proof.endpoint_profile_digest,proof.test_report_id,fence.rows[0]!.fence,range.first,range.last]);
          const jobId=job.rows[0]!.id;
          for(const [index,record] of batch.records.entries()) await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED')`,[jobId,index,record.event_id,record.source_pk,record.source_version,record.operation,record.source_updated_at,record]);
          await client.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)',[jobId]);
          await client.query('INSERT INTO control.ingestion_management_admission_audit(job_id,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[jobId,actor.tenantId,sourceId,actor.userId,actor.issuer,actor.subject,actor.authEpoch,request.id]);
          await options.authService.assertCurrentPrincipal(actor,'source:write',client);
          await client.query('COMMIT'); begun=false;
          return reply.code(202).send(success(request,{job_id:jobId,status:'RECEIVED',received_count:batch.records.length,applied_count:0}));
        } catch(error) {if(begun) await client.query('ROLLBACK').catch(()=>undefined); throw error;} finally {client.release();}
      } catch(error) {return sendFailure(request,reply,error);}
    });
  });
}
