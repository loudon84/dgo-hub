import { recoveryExpectedState } from '../ingestion-api/quarantine-recovery.js';
import pg from 'pg';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createCredential } from '../auth/credentials.js';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createOidcAuthenticator } from '../auth/oidc.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

function sha(value: string): Buffer { return createHash('sha256').update(value).digest(); }
async function seedPreIndexSnapshot(pool: pg.Pool, preIndexTenant: string, preIndexSource: string): Promise<string> {
  const auth = createAuthService({ pool });
  await auth.repository.provisionTenant({ tenantId: preIndexTenant, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: preIndexTenant, userId: 'preindex-owner', managementScopes: ['source:read'] });
  await auth.repository.provisionSourceCredential({ tenantId: preIndexTenant, sourceId: preIndexSource,
    token: createCredential().secret, secretRef: 'vault:/preindex/source', allowedEntities: ['customer'], revision: '1' });
  await pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
    VALUES($1,$2,'ACTIVE','preindex-owner')`, [preIndexTenant, preIndexSource]);
  const config = { name: 'pre-index', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
    endpoint_allowlist_ref: 'pre-index', secret_ref: 'vault:/preindex/source', allowed_entities: ['customer'], delete_contract: 'hard_delete' };
  const configDigest = sha(JSON.stringify(config)); const mappingDigest = sha('pre-index-mapping');
  const identityDigest = sha('pre-index-identity'); const endpointDigest = sha('pre-index-endpoint');
  await pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,'preindex-owner')`, [preIndexTenant, preIndexSource, configDigest, config]);
  await pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]','preindex-owner')`, [preIndexTenant, preIndexSource, mappingDigest]);
  await pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]','preindex-owner')`, [preIndexTenant, preIndexSource, identityDigest]);
  const credential = await pool.query<{ id: string }>(`SELECT id::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2`,
    [preIndexTenant, preIndexSource]);
  const report = await pool.query<{ id: string }>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
    identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
    endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,1,1,$6,'pre-index','{}','PASS','preindex-owner') RETURNING id::text`,
    [preIndexTenant, preIndexSource, configDigest, mappingDigest, identityDigest, endpointDigest]);
  const approval = await pool.query<{ id: string }>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
    config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
    credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,'preindex-owner',1,1,1,1,$3,$4,$5,1,1,$6,'pre-index',$7) RETURNING id::text`,
    [preIndexTenant, preIndexSource, configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id]);
  const channel = await pool.query<{ id: string }>(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,
    channel_epoch,state) VALUES($1,$2,'customer','postgresql','FULL_SNAPSHOT','SNAPSHOT_OBSERVATION',1,'active') RETURNING id::text`,
    [preIndexTenant, preIndexSource]);
  const credentialFact = await pool.query<{ revision: string; generation: string; source_epoch: string }>(`SELECT revision::text,
    credential_generation::text AS generation,source_epoch::text FROM control.source_credential WHERE id=$1`, [credential.rows[0]!.id]);
  const runId = randomUUID(); const attemptId = randomUUID(); const manifestDigest = sha('pre-index-manifest');
  const scopeDigest = sha('pre-index-scope'); const semanticDigest = sha('pre-index-semantic'); const aggregate = sha('pre-index-aggregate');
  const sourceIdentity = sha('pre-index-source-identity').toString('hex');
  await pool.query(`INSERT INTO control.etl_run(run_id,tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,
    status,credential_id,credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
    config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,
    test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,owner_revision)
    VALUES($1,$2,$3,'FULL_SNAPSHOT','MANUAL','API-019',$4,$5,'FAILED',$6,$7,$8,$9,$9,ARRAY['customer']::text[],$10,
      1,$11,1,$12,1,$13,$14,$15,$16,'pre-index','hard_delete',0,'preindex-owner',1)`,
    [runId, preIndexTenant, preIndexSource, `pre-${runId}`, sha(runId), credential.rows[0]!.id, credentialFact.rows[0]!.revision,
      credentialFact.rows[0]!.generation, credentialFact.rows[0]!.source_epoch, { customer: { id: channel.rows[0]!.id, epoch: '1' } },
      configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id, approval.rows[0]!.id]);
  await pool.query(`INSERT INTO control.etl_run_attempt(attempt_id,tenant_key,source_id,run_id,ordinal,operation_id,status,source_snapshot_identity)
    VALUES($1,$2,$3,$4,1,$5,'FAILED',$6)`, [attemptId, preIndexTenant, preIndexSource, runId, randomUUID(), sourceIdentity]);
  await pool.query(`INSERT INTO control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,row_count,
    first_key,last_key,page_digest) VALUES($1,$2,$3,$4,'customer','customer',1,1,'PRE-C-1','PRE-C-1',$5)`,
    [preIndexTenant, preIndexSource, runId, attemptId, sha('pre-index-page')]);
  await pool.query(`INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,
    source_pk,page_no,row_ordinal,source_version,facts) VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',1,1,'1','{}')`,
    [preIndexTenant, preIndexSource, runId, attemptId]);
  await pool.query(`INSERT INTO control.etl_snapshot_manifest(tenant_key,source_id,run_id,attempt_id,state,manifest,manifest_digest,
    source_snapshot_identity) VALUES($1,$2,$3,$4,'EXTRACTED',$5,$6,$7)`,
    [preIndexTenant, preIndexSource, runId, attemptId, { source_snapshot_identity: sourceIdentity }, manifestDigest, sourceIdentity]);
  await pool.query(`INSERT INTO control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id,manifest_digest,proof_scope_digest,
    semantic_digest,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
    [preIndexTenant, preIndexSource, runId, attemptId, manifestDigest, scopeDigest, semanticDigest]);
  const outcome = await pool.query<{ outcome_id: string }>(`INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,run_id,
    attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,status,error_code,created_at)
    VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',$5,'QUARANTINED','PREINDEX_BLOCKED','2026-10-25T00:00:00.123456Z') RETURNING outcome_id::text`,
    [preIndexTenant, preIndexSource, runId, attemptId, aggregate]);
  await pool.query(`INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,
    source_pk,aggregate_digest,proof_scope_digest,outcome_id,committed_at)
    VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',$5,$6,$7,'2026-10-25T00:00:00.123456Z')`,
    [preIndexTenant, preIndexSource, runId, attemptId, aggregate, scopeDigest, outcome.rows[0]!.outcome_id]);
  return outcome.rows[0]!.outcome_id;
}

async function seedPre009RestQuarantine(pool: pg.Pool, pre009Tenant: string, pre009Source: string): Promise<{
  jobId: string; eventId: string; sourcePk: string;
}> {
  const auth = createAuthService({ pool });
  await auth.repository.provisionTenant({ tenantId: pre009Tenant, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: pre009Tenant, userId: 'pre009-owner', managementScopes: ['source:read'] });
  await auth.repository.provisionSourceCredential({ tenantId: pre009Tenant, sourceId: pre009Source,
    token: createCredential().secret, secretRef: 'vault:/pre009/rest', allowedEntities: ['customer'], revision: '1' });
  await pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
    VALUES($1,$2,'ACTIVE','pre009-owner')`, [pre009Tenant, pre009Source]);
  const config = { name: 'Pre-009 REST', connector: 'rest', mode: 'INCREMENTAL', version_domain: 'SOURCE_VERSION',
    endpoint_allowlist_ref: 'pre009', secret_ref: 'vault:/pre009/rest', allowed_entities: ['customer'], delete_contract: 'tombstone' };
  const mappings = [{ entity: 'customer', source_field: 'name', target_field: 'customer_name', transform: 'trim' }];
  const identities = [{ kind: 'user', external_id: 'pre009-owner', target_id: 'pre009-owner' }];
  const configDigest = sha(JSON.stringify(config)); const mappingDigest = sha(JSON.stringify(mappings));
  const identityDigest = sha(JSON.stringify(identities)); const endpointDigest = sha('pre009-rest-endpoint');
  await pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, configDigest, config]);
  await pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, mappingDigest, JSON.stringify(mappings)]);
  await pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, identityDigest, JSON.stringify(identities)]);
  const credential = await pool.query<{ id: string; revision: string; credential_generation: string; source_epoch: string }>(`SELECT id::text,
    revision::text,credential_generation::text,source_epoch::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2`,
    [pre009Tenant, pre009Source]);
  const channel = await pool.query<{ id: string }>(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,
    channel_epoch,state) VALUES($1,$2,'customer','rest','INCREMENTAL','SOURCE_VERSION',1,'active') RETURNING id::text`,
    [pre009Tenant, pre009Source]);
  const report = await pool.query<{ id: string }>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
    identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
    endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,$6,$7,$8,'pre009','{}','PASS','pre009-owner') RETURNING id::text`,
    [pre009Tenant, pre009Source, configDigest, mappingDigest, identityDigest, credential.rows[0]!.revision,
      credential.rows[0]!.credential_generation, endpointDigest]);
  const approval = await pool.query<{ id: string }>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
    config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
    credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,'pre009-owner',1,1,1,1,$3,$4,$5,$6,$7,$8,'pre009',$9) RETURNING id::text`,
    [pre009Tenant, pre009Source, configDigest, mappingDigest, identityDigest, credential.rows[0]!.revision,
      credential.rows[0]!.credential_generation, endpointDigest, report.rows[0]!.id]);
  const rawBatchId = randomUUID(); const batchId = randomUUID(); const jobId = randomUUID(); const eventId = randomUUID();
  const sourcePk = 'PRE009-REST-C-1'; const updatedAt = '2026-10-25T00:00:00.123456Z';
  await pool.query(`INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes)
    VALUES($1,$2,$3,'/hub/v1/ingest/crm/customers',$4)`, [rawBatchId, pre009Tenant, pre009Source, Buffer.from('{}')]);
  await pool.query(`INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,
    request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,
    credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,
    approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
    endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
    VALUES($1,$2,$3,'customer','/hub/v1/ingest/crm/customers',$4,$5,$6,$7,'RECEIVED',1,0,$8,$9,$10,$11,$12,1,
      'SOURCE_VERSION',$13,'pre009-owner',1,0,1,$14,1,$15,1,$16,$17,$18,0,$19,$19)`,
    [jobId, pre009Tenant, pre009Source, batchId, rawBatchId, `pre009-${jobId}`, sha(jobId), credential.rows[0]!.id,
      credential.rows[0]!.source_epoch, credential.rows[0]!.revision, credential.rows[0]!.credential_generation, channel.rows[0]!.id,
      approval.rows[0]!.id, configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id, updatedAt]);
  await pool.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)', [jobId]);
  await pool.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,
    public_record,status) VALUES($1,0,$2,$3,1,'UPSERT',$4,'{}','RECEIVED')`, [jobId, eventId, sourcePk, updatedAt]);
  await pool.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='PREINDEX_REST_BLOCKED'
    WHERE job_id=$1 AND ordinal=0`, [jobId]);
  return { jobId, eventId, sourcePk };
}


let fixture: OwnedPostgres;
let app: Awaited<ReturnType<typeof buildApp>>;
let jwks: Server;
let token: string;
let otherToken: string;
let viewerToken: string;
let testAuth: ReturnType<typeof createAuthService>;
let testIssuer: string;
let fault: 'before_write' | 'before_commit' | undefined;
let dropResponse=false;
let holdAfterSource: (()=>Promise<void>) | undefined;
let signalEditAttempt: (()=>void) | undefined;
const tenant='i2a_tenant', source='import-one';
const raw=JSON.stringify({schema_version:'hub.v1',batch_id:'10000000-0000-4000-8000-000000000001',records:[{event_id:'10000000-0000-4000-8000-000000000002',source_pk:'customer-one',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:' Acme ',rep:'rep-a',team:'team-a',state:'ACTIVE',discarded:'original'}}]});

beforeAll(async()=>{
  const root=fixtureEvidenceRootFromEnvironment(); if(!root) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
  fixture=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
  const migrationSource=fileURLToPath(new URL('../migrations/',import.meta.url)), upgradeDir=join(root,'upgrade-migrations');
  await mkdir(upgradeDir,{recursive:true});
  for(const file of await readdir(migrationSource)) if(/^0(?:0[1-9]|10)_.*\.sql$/.test(file)) await copyFile(join(migrationSource,file),join(upgradeDir,file));
  if(process.env.I2B_BASELINE_009) await copyFile(process.env.I2B_BASELINE_009,join(upgradeDir,'009_snapshot_runs_and_recovery.sql'));
  await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'});
  const auth=createAuthService({pool:fixture.pool}); testAuth=auth;
  const keys=await generateKeyPair('RS256',{modulusLength:2048});
  const jwk={...await exportJWK(keys.publicKey),kid:'i2a',alg:'RS256',use:'sig'};
  jwks=createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]})));
  await new Promise<void>((resolve,reject)=>{jwks.once('error',reject);jwks.listen(0,'127.0.0.1',resolve);});
  const address=jwks.address(); if(!address || typeof address==='string') throw new Error('JWKS_ADDRESS');
  const issuer=`http://127.0.0.1:${address.port}/issuer`, audience='i2a'; testIssuer=issuer;
  await auth.repository.provisionTenant({tenantId:tenant,businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write']});
  await auth.repository.bindIdentity({issuer,subject:'owner',tenantId:tenant,userId:'owner'});
  await auth.repository.provisionTenant({tenantId:'i2a_other',businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId:'i2a_other',userId:'other',managementScopes:['source:write']});
  await auth.repository.bindIdentity({issuer,subject:'other',tenantId:'i2a_other',userId:'other'});
  await auth.repository.provisionSubject({tenantId:tenant,userId:'viewer',managementScopes:['source:read']});
  await auth.repository.bindIdentity({issuer,subject:'viewer',tenantId:tenant,userId:'viewer'});
  const mint=(subject:string)=>new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'i2a'}).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  token=await mint('owner');otherToken=await mint('other');viewerToken=await mint('viewer');
  const authenticator=createOidcAuthenticator({issuer,audience,jwksUrl:`http://127.0.0.1:${address.port}/jwks`,environmentKind:'local_lab',allowLoopbackHttp:true},auth);
  const rolePool=new Proxy(fixture.pool,{get(target,property){
    if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client); return {query:(async(sql:unknown,...args:unknown[])=>{if(typeof sql==='string' && sql==='SELECT control.lock_security_barrier_fence()' && signalEditAttempt) {const signal=signalEditAttempt;signalEditAttempt=undefined;signal();} if (typeof sql==='string' && ((fault==='before_write' && sql.startsWith('INSERT INTO raw.ingestion_batch')) || (fault==='before_commit' && sql.trim()==='COMMIT'))) { fault=undefined; throw new Error('OWNED_FAILURE_INJECTION'); } const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && sql.includes("SELECT r.lifecycle,r.data_owner_user_id") && holdAfterSource) {const hold=holdAfterSource;holdAfterSource=undefined;await hold();}if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  const sourceService=createSourceRegistryService({pool:rolePool,auth,secretResolver:failClosedSecretResolver,endpointAllowlist:failClosedEndpointAllowlist,capabilityProbe:failClosedCapabilityProbe});
  const options={pool:rolePool,authService:auth,authenticator,rawStoragePolicy:'local_lab_fixture' as const};
  app=await buildApp({logger:false,sourceRegistry:{authService:auth,sourceService,authenticator},strictIngestion:options});
  app.addHook('onSend',async(request,reply,payload)=>{if(dropResponse && request.url===`/hub/v1/admin/sources/${source}/import/customer`) {dropResponse=false;reply.raw.socket?.destroy();} return payload;});
  const headers={authorization:`Bearer ${token}`};
  const call=async(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
  expect((await call('POST','/hub/v1/admin/sources',{source_id:source,data_owner_user_id:'owner',config:{name:'Import',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}})).statusCode).toBe(201);
  const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
  expect((await call('PUT',`/hub/v1/admin/sources/${source}/mappings`,{expected_revision:'1',mappings})).statusCode).toBe(200);
  for(const [kind,external,target,rev] of [['user','rep-a','owner','0'],['department','team-a','dept1','1']]) {
    const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${external}`,headers});
    expect(candidate.statusCode).toBe(200);
    expect((await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:rev,target_id:target,reason:'confirmed'})).statusCode).toBe(200);
  }
  const tested=await call('POST',`/hub/v1/admin/sources/${source}/test`,{expected_revision:'1',samples:{customer:raw}}); expect(tested.json().data.status).toBe('PASS');
  const report=tested.json().data;
  const approval=await call('POST',`/hub/v1/admin/sources/${source}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}); expect(approval.statusCode).toBe(200);
  expect((await call('POST',`/hub/v1/admin/sources/${source}/activate`,{revision:'1',approval_id:approval.json().data.approval_id})).statusCode).toBe(200);
  await copyFile(join(migrationSource,'011_management_import_admission.sql'),join(upgradeDir,'011_management_import_admission.sql'));
  await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'});
  await seedPreIndexSnapshot(fixture.pool,'legacy_snapshot_012','snapshot-012');
  await seedPre009RestQuarantine(fixture.pool,'legacy_rest_012','rest-012');
  const priorQuarantine=(await fixture.pool.query(`SELECT to_jsonb(q) row FROM control.ingestion_quarantine_index q WHERE tenant_key IN ('legacy_snapshot_012','legacy_rest_012') ORDER BY origin_kind`)).rows;
  expect(priorQuarantine.map(row=>row.row.origin_kind)).toEqual(['REST','SNAPSHOT']);
  await copyFile(join(migrationSource,'012_import_quarantine.sql'),join(upgradeDir,'012_import_quarantine.sql'));
  await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'});
  await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'});
  await fixture.pool.query(await readFile(join(migrationSource,'012_import_quarantine.sql'),'utf8'));
  expect((await fixture.pool.query(`SELECT to_jsonb(q) row FROM control.ingestion_quarantine_index q WHERE tenant_key IN ('legacy_snapshot_012','legacy_rest_012') ORDER BY origin_kind`)).rows).toEqual(priorQuarantine);
  for(const name of ['013_import_recovery_candidate','014_import_recovery_binding','015_import_recovery_schema','016_import_recovery_admission','017_import_recovery_worker_context','018_import_recovery_customer_apply','019_order_visibility_effects']) {
    await copyFile(join(migrationSource,`${name}.sql`),join(upgradeDir,`${name}.sql`));
    expect((await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'})).applied).toEqual([name]);
  }
},90000);
afterAll(async()=>{if(app) await app.close();if(jwks) await new Promise<void>(resolve=>jwks.close(()=>resolve()));if(fixture) await fixture.close();});

it('applies an admitted import customer with the durable hub_worker',async()=>{
 const response=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'worker-customer'},payload:raw});
 expect(response.statusCode).toBe(202);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 const errors:string[]=[];
 try { await runDurableWorkerOnce(worker,{hooks:{onApplyError:async e=>{errors.push(String(e));}}}); } finally { await worker.end(); }
 const row=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[response.json().data.job_id]);
 expect(errors).toEqual([]);expect(row.rows[0].status).toBe('APPLIED');
});


it('applies a foreign typed customer reference and all order lines',async()=>{
 const headers={authorization:`Bearer ${token}`}, orderSource='orders-only', ref={source_id:source,source_pk:'foreign-key'};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 expect((await call('POST','/hub/v1/admin/sources',{source_id:orderSource,data_owner_user_id:'owner',config:{name:'orders',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const mappings=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
 expect((await call('PUT',`/hub/v1/admin/sources/${orderSource}/mappings`,{expected_revision:'1',mappings})).statusCode).toBe(200);
 const canonical=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES($1,'Existing','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id`,[tenant]);
 await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES($1,$2,'customer',$3,$4,$4)`,[tenant,ref.source_id,ref.source_pk,canonical.rows[0]!.id]);
 const mappingKey='c:'+createHash('sha256').update(JSON.stringify([ref.source_id,ref.source_pk])).digest('base64url');
 const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${orderSource}&kind=customer&external_id=${mappingKey}`,headers});expect(candidate.statusCode).toBe(200);
 expect((await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:'0',target_id:canonical.rows[0]!.id,reason:'confirmed'})).statusCode).toBe(200);
 const order=JSON.stringify({schema_version:'hub.v1',batch_id:'20000000-0000-4000-8000-000000000001',records:[{event_id:'20000000-0000-4000-8000-000000000002',source_pk:'order-one',source_version:'18446744073709551615',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:ref,number:' O1 ',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'},{source_line_id:'l2',product_code:'q',product_name:'second',quantity:'1.000000',unit_price:'0.000000',line_amount:'0.00'}]}}]});
 const tested=await call('POST',`/hub/v1/admin/sources/${orderSource}/test`,{expected_revision:'1',samples:{order}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approval=await call('POST',`/hub/v1/admin/sources/${orderSource}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approval.statusCode).toBe(200);
 expect((await call('POST',`/hub/v1/admin/sources/${orderSource}/activate`,{revision:'1',approval_id:approval.json().data.approval_id})).statusCode).toBe(200);
 const accepted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${orderSource}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'order'},payload:order});expect(accepted.statusCode).toBe(202);
 const stored=await fixture.pool.query('SELECT public_record FROM control.ingestion_job_item WHERE job_id=$1',[accepted.json().data.job_id]);
 expect(stored.rows[0].public_record.data).toEqual({customer_ref:ref,order_no:'O1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00Z',amount:'12.00',currency:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'},{source_line_id:'l2',product_code:'q',product_name:'second',quantity:'1.000000',unit_price:'0.000000',line_amount:'0.00'}]});
 expect(stored.rows[0].public_record.source_version).toBe('18446744073709551615');
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});const errors:string[]=[];
 try {
  for(const point of ['header','line'] as const) {
   await runDurableWorkerOnce(worker,{hooks:{afterOrderHeader:async()=>{if(point==='header') throw new Error('FI03_HEADER');},afterOrderLine:async index=>{if(point==='line' && index===1) throw new Error('FI03_LINE');}}});
   const rolled=await fixture.pool.query(`SELECT (SELECT count(*)::int FROM hub.canonical_order WHERE tenant_id=$1 AND order_no='O1') orders,(SELECT count(*)::int FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2) receipts,(SELECT count(*)::int FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2) outbox,(SELECT count(*)::int FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id IN (SELECT id FROM hub.canonical_order WHERE tenant_id=$1 AND order_no='O1')) lines`,[tenant,orderSource]);
   expect(rolled.rows[0]).toEqual({orders:0,receipts:0,outbox:0,lines:0});
   const state=await fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[accepted.json().data.job_id]);expect(state.rows[0].status).toBe('RETRY_PENDING');
   await fixture.pool.query('UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1',[accepted.json().data.job_id]);
   await fixture.pool.query('UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1',[accepted.json().data.job_id]);
  }
  await runDurableWorkerOnce(worker,{hooks:{onApplyError:async e=>{errors.push(String(e));}}});
 } finally {await worker.end();}
 expect(errors).toEqual([]);
 const actual=await fixture.pool.query(`SELECT o.customer_id::text,o.order_no,o.status,to_char(o.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_at,o.amount::text,o.currency,to_char(o.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_updated_at,o.source_version::text,l.source_line_id,l.product_code,l.product_name,l.quantity::text,l.unit_price::text,l.line_amount::text,to_char(l.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') line_updated_at FROM hub.canonical_order o JOIN hub.canonical_order_line l ON l.tenant_id=o.tenant_id AND l.order_id=o.id WHERE o.tenant_id=$1 AND o.order_no='O1' ORDER BY l.source_line_id`,[tenant]);
 expect(actual.rows).toEqual([{customer_id:canonical.rows[0]!.id,order_no:'O1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00.000000Z',amount:'12.00',currency:'CNY',order_updated_at:'2026-10-29T00:00:00.000000Z',source_version:'18446744073709551615',source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00',line_updated_at:'2026-10-29T00:00:00.000000Z'},{customer_id:canonical.rows[0]!.id,order_no:'O1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00.000000Z',amount:'12.00',currency:'CNY',order_updated_at:'2026-10-29T00:00:00.000000Z',source_version:'18446744073709551615',source_line_id:'l2',product_code:'q',product_name:'second',quantity:'1.000000',unit_price:'0.000000',line_amount:'0.00',line_updated_at:'2026-10-29T00:00:00.000000Z'}]);
 const other=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES($1,'Wrong','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id`,[tenant]);
 await fixture.pool.query(`UPDATE control.canonical_source_identity SET canonical_object_id=$4,customer_id=$4 WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk=$3`,[tenant,ref.source_id,ref.source_pk,other.rows[0]!.id]);
 const wrong=JSON.parse(order);wrong.batch_id='70000000-0000-4000-8000-000000000001';wrong.records[0].event_id='70000000-0000-4000-8000-000000000002';wrong.records[0].source_pk='wrong-target';wrong.records[0].data.number='WRONG';
 const rejected=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${orderSource}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'wrong-target'},payload:JSON.stringify(wrong)});expect(rejected.statusCode).toBe(202);
 const secondWorker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});try {await runDurableWorkerOnce(secondWorker);} finally {await secondWorker.end();}
 const wrongState=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[rejected.json().data.job_id]);expect(wrongState.rows[0]).toEqual({status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID'});


});
it('bootstraps a customer then confirms its typed mapping and applies its order',async()=>{
 const src='bootstrap',headers={authorization:`Bearer ${token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 const customer=JSON.parse(raw); customer.batch_id='40000000-0000-4000-8000-000000000001';customer.records[0].event_id='40000000-0000-4000-8000-000000000002';
 const order={schema_version:'hub.v1',batch_id:'40000000-0000-4000-8000-000000000003',records:[{event_id:'40000000-0000-4000-8000-000000000004',source_pk:'order-bootstrap',source_version:'9007199254740993',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:'customer-one',number:'B1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'24.00',ccy:'CNY',lines:[{source_line_id:'a',product_code:'p1',product_name:'first',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'},{source_line_id:'b',product_code:'p2',product_name:'second',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00'}]}}]};
 expect((await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Bootstrap',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer','order'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const cm=[['display','customer_name','trim'],['rep','owner_user_id','source-id'],['team','dept_id','source-id'],['state','status','identity']].map(([source_field,target_field,transform])=>({entity:'customer',source_field,target_field,transform}));
 const om=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings:[...cm,...om]})).statusCode).toBe(200);
 for(const [kind,external,target,rev] of [['user','rep-a','owner','0'],['department','team-a','dept1','1']]) {const c=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=${kind}&external_id=${external}`,headers});expect((await call('PUT',`/hub/v1/admin/identity-mappings/${c.json().data.id}`,{expected_revision:rev,target_id:target,reason:'confirmed'})).statusCode).toBe(200);}
 const activate=async()=>{const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(customer),order:JSON.stringify(order)}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;const approval=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approval.statusCode).toBe(200);expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approval.json().data.approval_id})).statusCode).toBe(200);};
 await activate();
 const submit=async(entity:string,body:unknown,key:string)=>app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/${entity}`,headers:{...headers,'content-type':'application/json','idempotency-key':key},payload:JSON.stringify(body)});
 const accepted=await submit('customer',customer,'bootstrap-customer');expect(accepted.statusCode).toBe(202);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {
 await runDurableWorkerOnce(worker);const applied=await fixture.pool.query(`SELECT s.canonical_object_id::text id,i.status FROM control.canonical_source_identity s JOIN control.ingestion_job_item i ON i.job_id=$1 WHERE s.tenant_key=$2 AND s.source_id=$3 AND s.entity='customer' AND s.source_pk='customer-one'`,[accepted.json().data.job_id,tenant,src]);expect(applied.rows[0].status).toBe('APPLIED');const id=applied.rows[0].id;
 const key='c:'+createHash('sha256').update(JSON.stringify([src,'customer-one'])).digest('base64url');const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=customer&external_id=${key}`,headers});expect(candidate.statusCode).toBe(200);expect((await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:'2',target_id:id,reason:'confirmed'})).statusCode).toBe(200);
 await activate();const acceptedOrder=await submit('order',order,'bootstrap-order');expect(acceptedOrder.statusCode).toBe(202);
 const frozen=async()=> (await fixture.pool.query(`SELECT b.body_bytes,encode(j.request_digest,'hex') request_digest,i.public_record,encode(j.config_digest,'hex') config_digest,encode(j.mapping_digest,'hex') mapping_digest,encode(j.identity_mapping_digest,'hex') identity_digest,j.owner_approval_id::text,j.test_report_id::text,j.endpoint_profile_digest,j.channel_id::text,j.channel_epoch::text,j.security_barrier_fence_at_admission::text FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[acceptedOrder.json().data.job_id])).rows[0];
 const before=await frozen();expect(before.body_bytes.equals(Buffer.from(JSON.stringify(order)))).toBe(true);expect(before.endpoint_profile_digest).toBeNull();expect(before.public_record.data.customer_ref).toEqual({source_id:src,source_pk:'customer-one'});
 await runDurableWorkerOnce(worker);expect(await frozen()).toEqual(before);
 const actual=await fixture.pool.query(`SELECT o.customer_id::text,o.order_no,o.status,to_char(o.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_at,o.amount::text,o.currency,to_char(o.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_updated_at,o.source_version::text,l.source_line_id,l.product_code,l.product_name,l.quantity::text,l.unit_price::text,l.line_amount::text,to_char(l.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') line_updated_at FROM hub.canonical_order o JOIN hub.canonical_order_line l ON (l.tenant_id,l.order_id)=(o.tenant_id,o.id) WHERE o.tenant_id=$1 AND o.order_no='B1' ORDER BY l.source_line_id`,[tenant]);expect(actual.rows).toEqual([{customer_id:id,order_no:'B1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00.000000Z',amount:'24.00',currency:'CNY',order_updated_at:'2026-10-29T00:00:00.000000Z',source_version:'9007199254740993',source_line_id:'a',product_code:'p1',product_name:'first',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00',line_updated_at:'2026-10-29T00:00:00.000000Z'},{customer_id:id,order_no:'B1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00.000000Z',amount:'24.00',currency:'CNY',order_updated_at:'2026-10-29T00:00:00.000000Z',source_version:'9007199254740993',source_line_id:'b',product_code:'p2',product_name:'second',quantity:'2.000000',unit_price:'6.000000',line_amount:'12.00',line_updated_at:'2026-10-29T00:00:00.000000Z'}]);
 const replayOrder=await submit('order',order,'bootstrap-order');expect(replayOrder.statusCode).toBe(202);expect(replayOrder.json().data.job_id).toBe(acceptedOrder.json().data.job_id);
 const changed=JSON.parse(JSON.stringify(order));changed.records[0].data.number='CHANGED';expect((await submit('order',changed,'bootstrap-order')).statusCode).toBe(409);
 const duplicate=await submit('order',order,'bootstrap-duplicate');expect(duplicate.statusCode).toBe(202);await runDurableWorkerOnce(worker);const dup=await fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[duplicate.json().data.job_id]);expect(dup.rows[0].status).toBe('DUPLICATE');
 const otherSource=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers:{authorization:`Bearer ${otherToken}`},payload:{source_id:'foreign-other-tenant',data_owner_user_id:'other',config:{name:'Other',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}}});expect(otherSource.statusCode).toBe(201);
 const otherCustomer=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('i2a_other','Other','other','other-dept','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id`);
 await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES('i2a_other','foreign-other-tenant','customer','customer-one',$1,$1)`,[otherCustomer.rows[0]!.id]);
 const foreignKey='c:'+createHash('sha256').update(JSON.stringify(['foreign-other-tenant','customer-one'])).digest('base64url');const foreignCandidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=customer&external_id=${foreignKey}`,headers});expect(foreignCandidate.statusCode).toBe(200);
 const forbidden=await call('PUT',`/hub/v1/admin/identity-mappings/${foreignCandidate.json().data.id}`,{expected_revision:'3',target_id:otherCustomer.rows[0]!.id,reason:'cross tenant'});expect(forbidden.statusCode).not.toBe(200);
 for(const [n,buyer] of [['1','missing'],['2',{source_id:'foreign-other-tenant',source_pk:'customer-one'}]] as const) {
  const bad=JSON.parse(JSON.stringify(order));bad.batch_id=`60000000-0000-4000-8000-00000000000${n}`;bad.records[0].event_id=`60000000-0000-4000-8000-00000000001${n}`;bad.records[0].source_pk=`bad-${n}`;bad.records[0].data.buyer=buyer;bad.records[0].data.number=`BAD-${n}`;
  const admission=await submit('order',bad,`bad-${n}`);expect(admission.statusCode).toBe(202);await runDurableWorkerOnce(worker);const state=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[admission.json().data.job_id]);expect(state.rows[0]).toEqual({status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID'});
 }
 const race=JSON.parse(JSON.stringify(order));race.batch_id='50000000-0000-4000-8000-000000000001';race.records[0].event_id='50000000-0000-4000-8000-000000000002';race.records[0].source_pk='order-race';race.records[0].data.number='B-RACE';
 const raceJob=await submit('order',race,'race-order');expect(raceJob.statusCode).toBe(202);
 let reached!:()=>void,release!:()=>void;const atHeader=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;});
 const applying=runDurableWorkerOnce(worker,{hooks:{afterOrderHeader:async()=>{reached();await gate;}}});await atHeader;
 const deleting=await fixture.pool.connect();try {await deleting.query('BEGIN');const pid=(await deleting.query('SELECT pg_backend_pid() pid')).rows[0].pid;const pending=deleting.query('UPDATE hub.canonical_customer SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[tenant,id]);
 let blocked=false;for(let attempt=0;attempt<100&&!blocked;attempt++){const check=await fixture.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid]);blocked=check.rows[0].blocked;if(!blocked) await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);release();await applying;await pending;await deleting.query('COMMIT');
 const state=await fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[raceJob.json().data.job_id]);expect(state.rows[0].status).toBe('APPLIED');
 } finally {release();await deleting.query('ROLLBACK').catch(()=>undefined);deleting.release();}
 const stale=JSON.parse(JSON.stringify(order));stale.batch_id='50000000-0000-4000-8000-000000000003';stale.records[0].event_id='50000000-0000-4000-8000-000000000004';stale.records[0].source_pk='order-deleted';stale.records[0].data.number='B-DELETED';const staleJob=await submit('order',stale,'deleted-order');expect(staleJob.statusCode).toBe(202);await runDurableWorkerOnce(worker);const rejected=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[staleJob.json().data.job_id]);expect(rejected.rows[0]).toEqual({status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID'});
 } finally {await worker.end();}
});
it('captures an import quarantine with explicit origin and unavailable recovery',async()=>{
 const body=raw.replace('customer-one','customer-bad').replace('000000000002','000000000003');
 const response=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'worker-bad'},payload:body});
 expect(response.statusCode).toBe(202);
 await fixture.pool.query("UPDATE control.auth_subject SET business_role=NULL WHERE tenant_key=$1 AND user_id='owner'",[tenant]);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try { await runDurableWorkerOnce(worker); } finally { await worker.end(); }
 const row=await fixture.pool.query('SELECT origin_kind,endpoint_profile_digest,quarantine_id FROM control.ingestion_quarantine_index WHERE job_id=$1',[response.json().data.job_id]);
 expect(row.rows[0]).toMatchObject({origin_kind:'IMPORT',endpoint_profile_digest:null});
 await expect(fixture.pool.query(`INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,job_id,ordinal,event_id,source_pk,status,error_code,created_at,owner_approval_id,owner_revision,channel_id,channel_epoch,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,approval_security_fence,security_barrier_fence_at_admission)
 SELECT origin_kind,tenant_key,source_id,entity,job_id,ordinal,event_id,source_pk,status,error_code,created_at,owner_approval_id,owner_revision+1,channel_id,channel_epoch,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,approval_security_fence,security_barrier_fence_at_admission FROM control.ingestion_quarantine_index WHERE quarantine_id=$1`,[row.rows[0].quarantine_id])).rejects.toMatchObject({code:'23514'});
 const restricted=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});try {await expect(restricted.query('INSERT INTO control.ingestion_quarantine_index DEFAULT VALUES')).rejects.toMatchObject({code:'42501'});} finally {await restricted.end();}
 const list=await app.inject({method:'GET',url:`/hub/v1/admin/quarantine?source_id=${source}&origin_kind=IMPORT`,headers:{authorization:`Bearer ${token}`}});
 expect(list.statusCode,list.body).toBe(200);expect(JSON.stringify(list.json())).toContain('SCOPE_UNAVAILABLE');expect(JSON.stringify(list.json())).not.toContain('discarded');
 const counts=async()=> (await fixture.pool.query(`SELECT (SELECT count(*)::int FROM control.ingestion_recovery_operation) rest_operations,(SELECT count(*)::int FROM control.import_recovery_operation) import_operations,(SELECT count(*)::int FROM control.ingestion_job) jobs,(SELECT count(*)::int FROM control.ingestion_processing_outbox) outbox`)).rows[0];
 const before=await counts(),id=row.rows[0].quarantine_id;
 const retry=await app.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/retry`,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'import-retry'},payload:{expected_state:recoveryExpectedState(id),mapping_revision:'1',reason:'retry request'}});
 expect(retry.statusCode).toBe(409);expect(retry.json().error.code).toBe('RECOVERY_SCOPE_UNAVAILABLE');expect(await counts()).toEqual(before);
 await fixture.pool.query("UPDATE control.auth_subject SET business_role='sales' WHERE tenant_key=$1 AND user_id='owner'",[tenant]);
});

it('applies immutable admitted mapping after ordinary active-source edit and pause',async()=>{
 const body=raw.replace('customer-one','frozen-edit').replace('000000000002','000000000006'),headers={authorization:`Bearer ${token}`};
 const accepted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'frozen-edit'},payload:body});expect(accepted.statusCode).toBe(202);
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'identity'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 const latest=(await fixture.pool.query('SELECT revision::text FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 ORDER BY revision DESC LIMIT 1',[tenant,source])).rows[0].revision;
 const edited=await app.inject({method:'PUT',url:`/hub/v1/admin/sources/${source}/mappings`,headers,payload:{expected_revision:latest,mappings}});expect(edited.statusCode).toBe(200);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});try {await runDurableWorkerOnce(worker);} finally {await worker.end();}
 const actual=await fixture.pool.query(`SELECT c.customer_name,i.status FROM control.ingestion_job_item i JOIN control.canonical_source_identity s ON s.tenant_key=$2 AND s.source_id=$3 AND s.entity='customer' AND s.source_pk=i.source_pk JOIN hub.canonical_customer c ON c.tenant_id=s.tenant_key AND c.id=s.customer_id WHERE i.job_id=$1`,[accepted.json().data.job_id,tenant,source]);expect(actual.rows[0]).toEqual({customer_name:'Acme',status:'APPLIED'});
 const tested=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:raw}}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approved=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});expect(approved.statusCode).toBe(200);expect((await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
});
it('quarantines accepted imports when barriers arrive after claim, including channel retirement',async()=>{
 const body=raw.replace('customer-one','barrier-customer').replace('000000000002','000000000005');const headers={authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'barrier-customer'};
 const accepted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers,payload:body});expect(accepted.statusCode).toBe(202);const id=accepted.json().data.job_id;
 const retiredBody=raw.replace('customer-one','retired-customer').replace('000000000002','000000000007');const retired=await app.inject({method:'POST',url:'/hub/v1/admin/sources/bootstrap/import/customer',headers:{...headers,'idempotency-key':'retired-customer'},payload:retiredBody});expect(retired.statusCode).toBe(202);const retiredId=retired.json().data.job_id;
 await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=CASE WHEN job_id=$1 THEN '2000-01-01'::timestamptz ELSE '2099-01-01'::timestamptz END WHERE acknowledged_at IS NULL`,[id]);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {
 let reached!:()=>void,release!:()=>void;const claimed=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;});const pending=runDurableWorkerOnce(worker,{limit:1,hooks:{afterClaim:async()=>{reached();await gate;}}});await claimed;
 await fixture.pool.query(`INSERT INTO control.source_security_barrier(tenant_key,source_id,credential_id,barrier_type,reason_code,created_by) SELECT tenant_key,source_id,credential_id,'CREDENTIAL_COMPROMISE','SYNTHETIC_TEST','fixture' FROM control.ingestion_job WHERE id=$1`,[id]);
 const replay=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers,payload:body});expect(replay.statusCode).toBe(202);expect(replay.json().data.job_id).toBe(id);release();await pending;
 const result=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[id]);expect(result.rows[0]).toEqual({status:'QUARANTINED',error_code:'SECURITY_BARRIER_ACTIVE'});
 await fixture.pool.query(`INSERT INTO control.source_security_barrier(tenant_key,source_id,channel_id,barrier_type,reason_code,created_by) SELECT tenant_key,source_id,channel_id,'CHANNEL_RETIRED','SYNTHETIC_TEST','fixture' FROM control.ingestion_job WHERE id=$1`,[retiredId]);
 await fixture.pool.query('UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1',[retiredId]);await runDurableWorkerOnce(worker,{limit:1});
 const second=await fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[retiredId]);expect(second.rows[0]).toEqual({status:'QUARANTINED',error_code:'CHANNEL_EPOCH_RETIRED'});
 } finally {await worker.end();}
});

it('exposes an import recovery scope without accepting a previously bound invalid target',async()=>{
  const found=await fixture.pool.query<{quarantine_id:string}>(`SELECT quarantine_id::text FROM control.ingestion_quarantine_index WHERE tenant_key=$1 AND source_id=$2 AND source_pk='customer-bad' AND origin_kind='IMPORT'`,[tenant,source]);
  expect(found.rowCount).toBe(1);
  const response=await app.inject({method:'GET',url:`/hub/v1/admin/quarantine/${found.rows[0]!.quarantine_id}/import-recovery`,headers:{authorization:`Bearer ${token}`}});
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toEqual({state:'SCOPE_UNAVAILABLE'});
});

it('recovers an import customer with missing original mappings under a newly approved binding',async()=>{
 const src='i3r-customer',headers={authorization:`Bearer ${token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 const sample=JSON.parse(raw);sample.batch_id='61000000-0000-4000-8000-000000000001';sample.records[0].event_id='61000000-0000-4000-8000-000000000002';
 const missing=JSON.parse(JSON.stringify(sample));missing.batch_id='61000000-0000-4000-8000-000000000003';missing.records[0].event_id='61000000-0000-4000-8000-000000000004';missing.records[0].source_pk='recovery-customer';missing.records[0].data.rep='rep-missing';missing.records[0].data.team='team-missing';
 expect((await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'I3R Customer',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings})).statusCode).toBe(200);
 const confirm=async(kind:string,external:string,target:string,revision:string)=>{const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=${kind}&external_id=${external}`,headers});expect(candidate.statusCode).toBe(200);expect((await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:revision,target_id:target,reason:'confirmed'})).statusCode).toBe(200);};
 const activate=async(data:unknown)=>{const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(data)}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;const approval=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approval.statusCode).toBe(200);expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approval.json().data.approval_id})).statusCode).toBe(200);};
 await confirm('user','rep-a','owner','0');await confirm('department','team-a','dept1','1');await activate(sample);
 const admitted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'i3r-customer-origin'},payload:JSON.stringify(missing)});expect(admitted.statusCode).toBe(202);
 const job=admitted.json().data.job_id;
 const snapshot=async()=> (await fixture.pool.query(`SELECT b.body_bytes,to_jsonb(j)-'updated_at'-'status'-'applied_count' job,i.public_record,i.event_id::text,i.source_pk,i.source_version::text,i.operation FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[job])).rows[0];
 const before=await snapshot();const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {
 await runDurableWorkerOnce(worker);
 const q=await fixture.pool.query<{quarantine_id:string;error_code:string}>(`SELECT quarantine_id::text,error_code FROM control.ingestion_quarantine_index WHERE job_id=$1`,[job]);expect(q.rows[0].error_code).toBe('IDENTITY_MAPPING_REQUIRED');const id=q.rows[0].quarantine_id;
 expect((await fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='recovery-customer'`,[tenant,src])).rowCount).toBe(0);
 await confirm('user','rep-missing','owner','2');await confirm('department','team-missing','dept1','3');await activate(missing);
 const get=await app.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers});expect(get.statusCode).toBe(200);expect(get.json().data.state).toBe('AVAILABLE');
 const proof=(await fixture.pool.query<{revision:string;digest:string}>(`SELECT r.identity_mapping_revision::text revision,encode(m.mapping_digest,'hex') digest FROM control.source_registry r JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision) WHERE r.tenant_key=$1 AND r.source_id=$2`,[tenant,src])).rows[0]!;
 const body={expected_state:get.json().data.expected_state,expected_source_revision:'1',identity_mapping_revision:proof.revision,identity_mapping_digest:proof.digest,bindings:[{kind:'user',external_id:'rep-missing',target_id:'owner'},{kind:'department',external_id:'team-missing',target_id:'dept1'}],reason:'Confirmed missing mappings'};
 const post=()=>app.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{...headers,'idempotency-key':'i3r-confirm'},payload:body});const accepted=await post();expect(accepted.statusCode).toBe(202);expect(accepted.json().data.status).toBe('ACCEPTED');expect((await post()).json().data).toEqual(accepted.json().data);
 await runDurableWorkerOnce(worker);expect(await snapshot()).toEqual(before);
 const actual=await fixture.pool.query(`SELECT s.canonical_object_id::text id,c.customer_name,c.owner_user_id,c.dept_id,c.status,c.source_version::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id) WHERE s.tenant_key=$1 AND s.source_id=$2 AND s.entity='customer' AND s.source_pk='recovery-customer'`,[tenant,src]);expect(actual.rowCount).toBe(1);expect(actual.rows[0]).toMatchObject({customer_name:'Acme',owner_user_id:'owner',dept_id:'dept1',status:'ACTIVE',source_version:'1'});
 const final=await app.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers});expect(final.json().data.state).toBe('APPLIED');expect(final.json().data.child_job_id).toBe(accepted.json().data.child_job_id);
 } finally {await worker.end();}
},30000);
