import Fastify from 'fastify';
import pg from 'pg';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../migrations/runner.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { registerImportRecoveryRoutes } from '../ingestion-api/import-recovery-routes.js';
import { setupImportRecoveryFixture, sample, source, tenant } from './helpers/import-recovery-fixture.js';

let context:Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let worker:pg.Pool;
const api=Fastify({logger:false,requestIdHeader:false});
let child:string,operation:string,reserved:string;

beforeAll(async()=>{
 context=await setupImportRecoveryFixture('schema');
 for(const [name,version] of [['015_import_recovery_schema.sql','015_import_recovery_schema'],['016_import_recovery_admission.sql','016_import_recovery_admission'],['017_import_recovery_worker_context.sql','017_import_recovery_worker_context'],['018_import_recovery_customer_apply.sql','018_import_recovery_customer_apply'],['019_order_visibility_effects.sql','019_order_visibility_effects']]) {
  await copyFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),join(context.migrationDirectory,name));
  expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual([version]);
 }
 const headers={authorization:`Bearer ${context.token}`};
 for(const [kind,external,target,revision] of [['user','rep-missing','owner','2'],['department','team-missing','dept1','3']]) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${external}`,headers});
  expect(found.statusCode,found.body).toBe(200);
  const update=await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${found.json().data.id}`,headers,payload:{expected_revision:revision,target_id:target,reason:'confirmed'}});
  expect(update.statusCode,update.body).toBe(200);
 }
 const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});
 expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
 expect(approved.statusCode,approved.body).toBe(200);
 expect((await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
 const rolePool=new Proxy(context.fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 await registerImportRecoveryRoutes(api,{pool:rolePool,authService:context.auth,authenticator:context.authenticator});
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${context.quarantineId}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);
 const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${context.quarantineId}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'w1-both'},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'user',external_id:'rep-missing',target_id:'owner'},{kind:'department',external_id:'team-missing',target_id:'dept1'}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);child=post.json().data.child_job_id;operation=post.json().data.operation_id;
 reserved=(await context.fixture.pool.query<{id:string}>(`SELECT reserved_object_id::text AS id FROM control.import_recovery_operation WHERE operation_id=$1`,[operation])).rows[0]!.id;
 worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${context.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
},120000);
afterAll(async()=>{
 await api.close();if(worker) await worker.end();
 if(context){await context.app.close();await new Promise<void>(resolve=>context.jwks.close(()=>resolve()));await context.fixture.close();}
});

it('applies a signed admitted customer with both missing identities and its reserved UUID',async()=>{
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 const row=(await context.fixture.pool.query(`SELECT j.status AS job_status,i.status AS item_status,i.error_code,i.attempts_started,
  c.id::text,c.customer_name,c.owner_user_id,c.dept_id,c.status,c.phone,c.source_version::text AS version,
  to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated,
  s.canonical_object_id::text,s.customer_id::text,r.source_version::text AS receipt_version,r.canonical_object_id::text AS receipt_object,
  (SELECT count(*)::int FROM control.canonical_apply_outbox x WHERE x.tenant_key=$2 AND x.source_id=$3 AND x.canonical_object_id=c.id) AS canonical_outboxes,
  (SELECT count(*)::int FROM control.canonical_identity_reference x WHERE x.tenant_key=$2 AND x.source_id=$3 AND x.source_pk='missing') AS references,
  o.acknowledged_at IS NOT NULL AS acknowledged
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
  JOIN control.ingestion_processing_outbox o ON o.job_id=j.id
  LEFT JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=($2,$3,'customer','missing')
  LEFT JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
  LEFT JOIN control.source_version_receipt r ON (r.tenant_key,r.source_id,r.entity,r.source_pk)=($2,$3,'customer','missing') WHERE j.id=$1`,[child,tenant,source])).rows[0];
 expect(row).toEqual({job_status:'SUCCEEDED',item_status:'APPLIED',error_code:null,attempts_started:1,id:reserved,customer_name:'Acme',owner_user_id:'owner',dept_id:'dept1',status:'ACTIVE',phone:null,version:'1',updated:'2026-10-29T00:00:00Z',canonical_object_id:reserved,customer_id:reserved,receipt_version:'1',receipt_object:reserved,canonical_outboxes:1,references:2,acknowledged:true});
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${context.quarantineId}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(get.statusCode,get.body).toBe(200);expect(get.json().data).toMatchObject({state:'APPLIED',operation_id:operation,child_job_id:child,receipt:expect.any(Object)});
 expect(JSON.stringify(get.json())).not.toContain('Acme');
},60000);

it('retains an originally resolved user when recovering a missing department from ordinal one',async()=>{
 await runDurableWorkerOnce(worker);
 const headers={authorization:`Bearer ${context.token}`};
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${context.partialId}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${context.partialId}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'w1-partial'},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'department',external_id:'team-missing',target_id:'dept1'}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);const job=post.json().data.child_job_id,operationId=post.json().data.operation_id;
 const facts=(await context.fixture.pool.query(`SELECT o.original_ordinal,o.reserved_object_id::text,o.confirmed_bindings,
  oj.identity_mapping_revision::text AS original_mapping,o.binding_identity_mapping_revision::text AS binding_mapping,
  cj.raw_batch_id=oj.raw_batch_id AS same_raw,cj.request_digest=oj.request_digest AS same_digest,
  ci.public_record=oi.public_record AS same_record,cj.owner_approval_id=oj.owner_approval_id AS same_original_approval
  FROM control.import_recovery_operation o JOIN control.ingestion_job oj ON oj.id=o.original_job_id JOIN control.ingestion_job cj ON cj.id=o.child_job_id
  JOIN control.ingestion_job_item oi ON (oi.job_id,oi.ordinal)=(oj.id,o.original_ordinal) JOIN control.ingestion_job_item ci ON (ci.job_id,ci.ordinal)=(cj.id,0)
  WHERE o.operation_id=$1`,[operationId])).rows[0];
 expect(facts).toMatchObject({original_ordinal:1,original_mapping:'3',binding_mapping:'5',confirmed_bindings:[{kind:'department',externalId:'team-missing',targetId:'dept1'}],same_raw:true,same_digest:true,same_record:true,same_original_approval:true});
 await runDurableWorkerOnce(worker,{limit:1});
 const result=(await context.fixture.pool.query(`SELECT i.status,i.error_code,c.id::text,c.customer_name,c.owner_user_id,c.dept_id,c.phone,c.source_version::text AS version,
  to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated
  FROM control.ingestion_job_item i JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=($2,$3,'customer','partial')
  JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id) WHERE i.job_id=$1`,[job,tenant,source])).rows[0];
 expect(result).toEqual({status:'APPLIED',error_code:null,id:facts.reserved_object_id,customer_name:'Acme',owner_user_id:'owner',dept_id:'dept1',phone:null,version:'12345678901234567890',updated:'2026-10-29T00:00:00Z'});
 const refs=(await context.fixture.pool.query(`SELECT kind,external_id,target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='partial' ORDER BY kind`,[tenant,source])).rows;
 expect(refs).toEqual([{kind:'department',external_id:'team-missing',target_id:'dept1'},{kind:'user',external_id:'rep-a',target_id:'owner'}]);
 const final=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${context.partialId}/import-recovery`,headers});expect(final.statusCode).toBe(200);
 expect(final.json().data).toMatchObject({state:'APPLIED',operation_id:operationId,child_job_id:job,receipt:{canonical_object_id:facts.reserved_object_id,source_version:'12345678901234567890'}});
 expect(JSON.stringify(final.json())).not.toContain('Acme');
},60000);

it('commits a signed self-affected ownership change with one epoch increment and terminal reclaim only',async()=>{
 const src='self-owner-source',headers={authorization:`Bearer ${context.token}`};
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'old-self-sales',departmentId:'dept1',businessRole:'sales'});
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>context.app.inject({method,url,headers,payload});
 const created=await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Self owner fixture',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}});
 expect(created.statusCode,created.body).toBe(201);
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings})).statusCode).toBe(200);
 async function bind(kind:string,external:string,target:string,revision:string) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=${kind}&external_id=${external}`,headers});expect(found.statusCode,found.body).toBe(200);
  const update=await call('PUT',`/hub/v1/admin/identity-mappings/${found.json().data.id}`,{expected_revision:revision,target_id:target,reason:'confirmed'});expect(update.statusCode,update.body).toBe(200);
 }
 const sampleSelf={schema_version:'hub.v1',batch_id:crypto.randomUUID(),records:[{event_id:crypto.randomUUID(),source_pk:'self-sample',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T04:00:00Z',data:{display:'Sample',rep:'old-key',team:'self-team',state:'ACTIVE'}}]};
 async function approve() {
  const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(sampleSelf)}});expect(tested.json().data.status).toBe('PASS');
  const report=tested.json().data,approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});
  if(approved.statusCode!==200) {
   const diagnostic=await context.fixture.pool.query(`SELECT t.id::text,to_char(t.created_at,'YYYY-MM-DD HH24:MI:SS.US') created_at,t.status,t.identity_mapping_revision::text,r.lifecycle,r.identity_mapping_revision::text current_identity,
    t.config_revision=r.current_config_revision config_match,t.mapping_revision=r.mapping_revision mapping_match,t.identity_mapping_revision=r.identity_mapping_revision identity_match,
    t.source_credential_revision=c.revision credential_match,t.credential_generation=c.credential_generation generation_match,
    t.config_digest=cr.config_digest config_digest_match,t.mapping_digest=m.mapping_digest mapping_digest_match,t.identity_mapping_digest=i.mapping_digest identity_digest_match,
    EXISTS(SELECT 1 FROM control.source_test_report newer WHERE newer.tenant_key=t.tenant_key AND newer.source_id=t.source_id AND (newer.created_at,newer.id)>(t.created_at,t.id)) newer_exists
    FROM control.source_test_report t JOIN control.source_registry r USING(tenant_key,source_id) JOIN control.source_credential c USING(tenant_key,source_id)
    JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
    JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
    JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
    WHERE t.tenant_key=$1 AND t.source_id=$2 ORDER BY t.created_at,t.id`,[tenant,src]);
   expect(approved.statusCode,`${approved.body} ${JSON.stringify(diagnostic.rows)} selected=${report.test_report_id}`).toBe(200);
  }
  expect(approved.statusCode,approved.body).toBe(200);
  expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);
 }
 async function send(version:string,rep:string) {
  const record={...structuredClone(sampleSelf.records[0]!),event_id:crypto.randomUUID(),source_pk:'self-owned-item',source_version:version,data:{display:'Self Literal',rep,team:'self-team',state:'ACTIVE'}};
  const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':`self-original-${version}`},payload:JSON.stringify({...sampleSelf,batch_id:crypto.randomUUID(),records:[record]})});
  expect(response.statusCode,response.body).toBe(202);return response.json().data.job_id as string;
 }
 await bind('user','old-key','old-self-sales','0');await bind('department','self-team','dept1','1');await approve();
 const v1=await send('1','old-key');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[v1])).rows[0].status).toBe('APPLIED');
 const v2=await send('2','to-owner');await runDurableWorkerOnce(worker);
 const q=(await context.fixture.pool.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1`,[v2])).rows[0]!.id;
 await bind('user','to-owner','owner','2');await approve();
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'self-recovery'},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'user',external_id:'to-owner',target_id:'owner'}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);const job=post.json().data.child_job_id,operationId=post.json().data.operation_id;
 const snapshot=async(client:Pick<pg.Pool,'query'>|pg.PoolClient)=>({
  epochs:(await client.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=ANY($2::text[]) ORDER BY user_id`,[tenant,['old-self-sales','owner']])).rows,
  customer:(await client.query(`SELECT c.id::text,c.owner_user_id,c.dept_id,c.source_version::text AS version FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id) WHERE s.tenant_key=$1 AND s.source_id=$2 AND s.source_pk='self-owned-item'`,[tenant,src])).rows[0],
  audit:(await client.query(`SELECT kind,old_target_id,new_target_id FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2 AND source_pk='self-owned-item'`,[tenant,src])).rows,
  receipt:(await client.query(`SELECT source_version::text,canonical_object_id::text FROM control.source_version_receipt WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer','self-owned-item')`,[tenant,src])).rows[0],
  outboxes:(await client.query(`SELECT count(*)::int AS n FROM control.canonical_apply_outbox o JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.canonical_object_id)=(o.tenant_key,o.source_id,o.canonical_object_id) WHERE s.tenant_key=$1 AND s.source_id=$2 AND s.source_pk='self-owned-item'`,[tenant,src])).rows[0].n,
  refs:(await client.query(`SELECT kind,external_id,target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$2 AND source_pk='self-owned-item' ORDER BY kind`,[tenant,src])).rows,
 });
 const before=await snapshot(context.fixture.pool);
 const operation=(await context.fixture.pool.query(`SELECT o.actor_user_id,o.actor_auth_epoch::text,o.owner_revision::text,o.reserved_object_id::text,
  o.binding_identity_mapping_revision::text,j.identity_mapping_revision::text AS original_identity_mapping_revision,
  o.binding_approval_id::text,j.owner_approval_id::text AS original_approval_id,o.confirmed_bindings
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.original_job_id WHERE o.operation_id=$1`,[operationId])).rows[0];
 let during:Awaited<ReturnType<typeof snapshot>>|undefined;
 const instrumented=new Proxy(worker,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{
   const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);
   if(typeof sql==='string' && sql.includes('SELECT control.record_import_recovery_customer_owner_change')) {
    await query('SET LOCAL ROLE postgres');try {during=await snapshot(client);} finally {await query('SET LOCAL ROLE hub_worker');}
   }
   return result;
  }) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const errors:string[]=[];await runDurableWorkerOnce(instrumented,{hooks:{beforeItemCommit:async()=>{throw new Error('self precommit failure');},onApplyError:async error=>{errors.push(error instanceof Error?error.message:String(error));}}});
 expect(operation.actor_user_id).toBe('owner');expect(operation.actor_auth_epoch).toBe(before.epochs.find(row=>row.user_id==='owner')!.auth_epoch);
 expect(during).toBeDefined();expect(during!.customer).toEqual({...before.customer,owner_user_id:'owner',version:'2'});
 expect(during!.epochs).toEqual(before.epochs.map(row=>({...row,auth_epoch:(BigInt(row.auth_epoch)+1n).toString()})));
 expect(during!.audit).toEqual([{kind:'user',old_target_id:'old-self-sales',new_target_id:'owner'}]);
 expect(errors).toEqual(['self precommit failure']);const rollback=await snapshot(context.fixture.pool);expect(rollback).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT i.status,i.error_code,i.attempts_started,j.status AS job_status FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id WHERE i.job_id=$1`,[job])).rows[0]).toEqual({status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE',attempts_started:1,job_status:'PROCESSING'});
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[job]);
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[job]);
 errors.length=0;during=undefined;await runDurableWorkerOnce(instrumented,{hooks:{onApplyError:async error=>{errors.push(error instanceof Error?error.message:String(error));}}});
 expect(errors).toEqual([]);const after=await snapshot(context.fixture.pool);expect(after).toEqual(during);
 expect(after.receipt).toEqual({source_version:'2',canonical_object_id:operation.reserved_object_id});expect(after.outboxes).toBe(before.outboxes+1);
 expect(after.refs).toEqual([{kind:'department',external_id:'self-team',target_id:'dept1'},{kind:'user',external_id:'to-owner',target_id:'owner'}]);
 const item=(await context.fixture.pool.query(`SELECT i.status,i.error_code,o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[job])).rows[0];
 expect(item).toEqual({status:'APPLIED',error_code:null,acknowledged:true});
 const finalGet=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(finalGet.json().data).toMatchObject({state:'APPLIED',operation_id:operationId,child_job_id:job,receipt:{canonical_object_id:operation.reserved_object_id,source_version:'2'}});
 // Test-only recreation of the pre-ACK queue state; this is not a process-crash FI05 test.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=NULL,available_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL WHERE job_id=$1`,[job]);
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 expect(await snapshot(context.fixture.pool)).toEqual(after);
 const reclaimed=(await context.fixture.pool.query(`SELECT i.status,i.error_code,i.attempts_started,o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[job])).rows[0];
 expect(reclaimed).toEqual({status:'APPLIED',error_code:null,attempts_started:2,acknowledged:true});
 await writeFile(join(process.env.M0_RUN_EVIDENCE_ROOT!,'self-affected-observation.json'),JSON.stringify({operationId,job,operation,before,during,rollback,after,errors,item,reclaimed,get:finalGet.json().data},null,2));
},60000);

it('applies a real existing customer ownership change under an unrelated confirming actor',async()=>{
 const headers={authorization:`Bearer ${context.token}`};
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'old-sales',departmentId:'dept1',businessRole:'sales'});
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'new-sales',departmentId:'dept1',businessRole:'sales'});
 async function bind(external:string,target:string,revision:string) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=user&external_id=${external}`,headers});
  expect(found.statusCode,found.body).toBe(200);
  const update=await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${found.json().data.id}`,headers,payload:{expected_revision:revision,target_id:target,reason:'confirmed'}});
  expect(update.statusCode,update.body).toBe(200);
 }
 async function approve() {
  const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});
  expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
  const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
  expect(approved.statusCode,approved.body).toBe(200);
  expect((await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
 }
 async function importCustomer(key:string,version:string,rep:string) {
  const body={schema_version:'hub.v1',batch_id:crypto.randomUUID(),records:[{event_id:crypto.randomUUID(),source_pk:'owned-control',source_version:version,operation:'UPSERT',source_updated_at:'2026-10-29T03:04:05Z',data:{display:'Owned Literal',rep,team:'team-a',state:'ACTIVE'}}]};
  const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':key},payload:JSON.stringify(body)});
  expect(response.statusCode,response.body).toBe(202);return response.json().data.job_id as string;
 }
 await bind('rep-old','old-sales','4');await approve();
 const original=await importCustomer('w1-owned-v1','1','rep-old');await runDurableWorkerOnce(worker);
 const existing=(await context.fixture.pool.query(`SELECT c.id::text,c.owner_user_id,c.dept_id FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id) WHERE s.tenant_key=$1 AND s.source_id=$2 AND s.source_pk='owned-control'`,[tenant,source])).rows[0];
 expect(existing).toMatchObject({owner_user_id:'old-sales',dept_id:'dept1'});
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[original])).rows[0].status).toBe('APPLIED');
 const quarantined=await importCustomer('w1-owned-v2','2','rep-control');await runDurableWorkerOnce(worker);
 const q=(await context.fixture.pool.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1`,[quarantined])).rows[0]!.id;
 await bind('rep-control','new-sales','5');await approve();
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'w1-owned'},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'user',external_id:'rep-control',target_id:'new-sales'}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);const job=post.json().data.child_job_id;
 const epochs=async()=>(await context.fixture.pool.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=ANY($2::text[]) ORDER BY user_id`,[tenant,['old-sales','new-sales','owner']])).rows;
 const before=await epochs();const errors:unknown[]=[];await runDurableWorkerOnce(worker,{hooks:{onApplyError:async error=>{errors.push(error);}}});
 const outcome=(await context.fixture.pool.query(`SELECT i.status,i.error_code,c.id::text,c.owner_user_id,c.dept_id,c.source_version::text AS version FROM control.ingestion_job_item i JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=($2,$3,'customer','owned-control') JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id) WHERE i.job_id=$1`,[job,tenant,source])).rows[0];
 expect(outcome,JSON.stringify(errors)).toEqual({status:'APPLIED',error_code:null,id:existing.id,owner_user_id:'new-sales',dept_id:'dept1',version:'2'});
 const after=await epochs();
 expect(after).toEqual(before.map(row=>({...row,auth_epoch:row.user_id==='owner'?row.auth_epoch:(BigInt(row.auth_epoch)+1n).toString()})));
 const audit=(await context.fixture.pool.query(`SELECT kind,external_id,old_target_id,new_target_id,actor_user_id FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2 AND source_pk='owned-control'`,[tenant,source])).rows;
 expect(audit).toEqual([{kind:'user',external_id:'rep-control',old_target_id:'old-sales',new_target_id:'new-sales',actor_user_id:'owner'}]);
},60000);

async function prepareIsolatedCustomer(label:string) {
 await runDurableWorkerOnce(worker); // A focused run may leave the beforeAll child pending.
 const src=`w1-${label}`,sales=`sales-${label}`,other=`other-${label}`,headers={authorization:`Bearer ${context.token}`};
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:sales,departmentId:'dept1',businessRole:'sales'});
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:other,departmentId:'dept1',businessRole:'sales'});
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>context.app.inject({method,url,headers,payload});
 const created=await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Isolated customer',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}});expect(created.statusCode,created.body).toBe(201);
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'},{entity:'customer',source_field:'contact',target_field:'phone',transform:'trim'}];
 const fields=await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings});expect(fields.statusCode,fields.body).toBe(200);
 async function bind(kind:string,external:string,target:string,revision:string) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=${kind}&external_id=${external}`,headers});expect(found.statusCode,found.body).toBe(200);
  const updated=await call('PUT',`/hub/v1/admin/identity-mappings/${found.json().data.id}`,{expected_revision:revision,target_id:target,reason:'confirmed'});expect(updated.statusCode,updated.body).toBe(200);
 }
 const sampleCase={schema_version:'hub.v1',batch_id:crypto.randomUUID(),records:[{event_id:crypto.randomUUID(),source_pk:`sample-${label}`,source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{display:'Sample',rep:'sample-user',team:'sample-dept',state:'ACTIVE',contact:'100'}}]};
 async function approve() {
  const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(sampleCase)}});expect(tested.json().data.status).toBe('PASS');
  const report=tested.json().data,approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approved.statusCode,approved.body).toBe(200);
  expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);
 }
 await bind('user','sample-user',sales,'0');await bind('department','sample-dept','dept1','1');await bind('user','selected-user',sales,'2');await approve();
 const selected={event_id:crypto.randomUUID(),source_pk:`selected-${label}`,source_version:'42',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{display:'  Literal Selected  ',rep:'selected-user',team:'missing-dept',state:'ACTIVE',contact:' +86 12345678901 '}};
 const batch={...sampleCase,batch_id:crypto.randomUUID(),records:[sampleCase.records[0],selected]};
 const imported=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':`origin-${label}`},payload:JSON.stringify(batch)});expect(imported.statusCode,imported.body).toBe(202);
 await runDurableWorkerOnce(worker);
 const originalJob=imported.json().data.job_id as string;
 const quarantines=await context.fixture.pool.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1 AND ordinal=1`,[originalJob]);
 if(!quarantines.rowCount) {
  const queue=await context.fixture.pool.query(`SELECT j.id::text,j.source_id,j.status,i.ordinal,i.status item_status,b.available_at::text,b.lease_expires_at::text,b.acknowledged_at::text,b.claim_token::text,b.available_at<=clock_timestamp() due
   FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_processing_outbox b ON b.job_id=j.id
   WHERE b.acknowledged_at IS NULL ORDER BY b.available_at,b.id`);
  throw new Error(`original ${originalJob} missing quarantine; queue=${JSON.stringify(queue.rows)}`);
 }
 const q=quarantines.rows[0]!.id;
 await bind('department','missing-dept','dept1','3');await approve();
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':`recover-${label}`},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'department',external_id:'missing-dept',target_id:'dept1'}],reason:'confirmed'})});expect(post.statusCode,post.body).toBe(202);
 const job=post.json().data.child_job_id as string,operationId=post.json().data.operation_id as string;
 const op=(await context.fixture.pool.query(`SELECT reserved_object_id::text,actor_auth_epoch::text,original_ordinal FROM control.import_recovery_operation WHERE operation_id=$1`,[operationId])).rows[0];
 const effects=async()=>(await context.fixture.pool.query(`SELECT s.canonical_object_id::text,s.customer_id::text,
  (SELECT count(*)::int FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$2,'customer',$3)) AS receipts,
  (SELECT count(*)::int FROM control.canonical_apply_outbox b WHERE b.tenant_key=$1 AND b.source_id=$2 AND b.canonical_object_id=s.canonical_object_id) AS outboxes,
  (SELECT count(*)::int FROM control.canonical_identity_reference x WHERE (x.tenant_key,x.source_id,x.entity,x.source_pk)=($1,$2,'customer',$3)) AS refs,
  (SELECT count(*)::int FROM control.canonical_ownership_audit x WHERE (x.tenant_key,x.source_id,x.entity,x.source_pk)=($1,$2,'customer',$3)) AS audits
  FROM control.canonical_source_identity s WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'customer',$3)`,[tenant,src,selected.source_pk])).rows[0];
 return {src,sales,other,headers,bind,call,mappings,job,operationId,op,q,selected,originalJob,effects};
}

async function enqueueOrdinaryVersion(x:Awaited<ReturnType<typeof prepareIsolatedCustomer>>,version:string,display:string) {
 const record={...x.selected,event_id:crypto.randomUUID(),source_version:version,data:{...x.selected.data,display}};
 const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/customer`,headers:{...x.headers,'content-type':'application/json','idempotency-key':`ordinary-${version}-${crypto.randomUUID()}`},payload:JSON.stringify({schema_version:'hub.v1',batch_id:crypto.randomUUID(),records:[record]})});
 expect(response.statusCode,response.body).toBe(202);return response.json().data.job_id as string;
}

it('applies ordinary version 41 after recovery reservation, then advances that exact UUID with recovery version 42',async()=>{
 const x=await prepareIsolatedCustomer('older-after-reservation');
 const reservedId=x.op.reserved_object_id as string;
 expect(reservedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 expect(x.op.original_ordinal).toBe(1);
 const untouched={canonical_object_id:reservedId,customer_id:null,receipts:0,outboxes:0,refs:0,audits:0};
 expect(await x.effects()).toEqual(untouched);
 const epochs=async()=>(await context.fixture.pool.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject
  WHERE tenant_key=$1 AND user_id=ANY($2::text[]) ORDER BY user_id`,[tenant,['owner',x.sales,x.other]])).rows;
 const beforeEpochs=await epochs();
 const jobState=async(job:string)=>(await context.fixture.pool.query(`SELECT j.status AS job_status,j.received_count,j.applied_count,
  i.ordinal,i.status AS item_status,i.error_code,i.attempts_started,i.retries_used,
  o.acknowledged_at IS NOT NULL AS acknowledged,o.claim_token::text,o.lease_expires_at
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
  JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`,[job])).rows[0];
 const pending={job_status:'RECEIVED',received_count:1,applied_count:0,ordinal:0,item_status:'RECEIVED',error_code:null,attempts_started:0,retries_used:0,acknowledged:false,claim_token:null,lease_expires_at:null};
 const applied={...pending,job_status:'SUCCEEDED',applied_count:1,item_status:'APPLIED',attempts_started:1,acknowledged:true};
 expect(await jobState(x.job)).toEqual(pending);
 const initialGet=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
 expect(initialGet.statusCode).toBe(200);expect(initialGet.json().data).toEqual({state:'ACCEPTED',operation_id:x.operationId,child_job_id:x.job,receipt:null});
 // Change only scheduling availability, so the ordinary event really arrives and runs after admission.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const ordinary=await enqueueOrdinaryVersion(x,'41','  Older Literal  ');
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 expect(await jobState(ordinary)).toEqual(applied);expect(await jobState(x.job)).toEqual(pending);
 const snapshot=async()=>({
  customer:(await context.fixture.pool.query(`SELECT c.id::text,c.customer_name,c.owner_user_id,c.dept_id,c.status,c.phone,
   to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated,c.source_version::text AS version,
   c.version_domain,c.channel_epoch::text,c.deleted_at,c.hub_revision::text
   FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
   WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'customer','selected-older-after-reservation')`,[tenant,x.src])).rows[0],
  receipt:(await context.fixture.pool.query(`SELECT source_version::text,canonical_object_id::text,channel_id::text,channel_epoch::text,version_domain,deleted,
   encode(source_content_digest,'hex') AS content_digest,encode(projection_digest,'hex') AS projection_digest
   FROM control.source_version_receipt WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer','selected-older-after-reservation')`,[tenant,x.src])).rows[0],
  outboxes:(await context.fixture.pool.query(`SELECT id::text,operation,canonical_object_id::text,hub_revision::text,channel_id::text,channel_epoch::text,version_domain,
   encode(source_content_digest,'hex') AS content_digest,encode(projection_digest,'hex') AS projection_digest
   FROM control.canonical_apply_outbox outbox WHERE tenant_key=$1 AND source_id=$2 AND canonical_object_id=$3::uuid ORDER BY outbox.id`,[tenant,x.src,reservedId])).rows,
  refs:(await context.fixture.pool.query(`SELECT kind,external_id,target_id FROM control.canonical_identity_reference
   WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer','selected-older-after-reservation') ORDER BY kind`,[tenant,x.src])).rows,
 });
 const older=await snapshot();
 const olderDigest='adc913dddb9a21fcc0fdeda1c468f9598c955fcbb5b61ef88fe5ad6db8362db3';
 const recoveryDigest='48bbead7f49ddf18ebc217825ad84b1ea244646c7f8ee7374f5e91020cafca5f';
 const customer=(name:string,version:string,revision:string)=>({id:reservedId,customer_name:name,owner_user_id:'sales-older-after-reservation',dept_id:'dept1',status:'ACTIVE',phone:'+86 12345678901',updated:'2026-10-29T00:12:13Z',version,version_domain:'SOURCE_VERSION',channel_epoch:'1',deleted_at:null,hub_revision:revision});
 const references=[{kind:'department',external_id:'missing-dept',target_id:'dept1'},{kind:'user',external_id:'selected-user',target_id:'sales-older-after-reservation'}];
 expect(older.customer).toEqual(customer('Older Literal','41',older.customer.hub_revision));
 expect(older.receipt).toMatchObject({source_version:'41',canonical_object_id:reservedId,channel_epoch:'1',version_domain:'SOURCE_VERSION',deleted:false,content_digest:olderDigest});
 expect(older.outboxes).toHaveLength(1);
 expect(older.outboxes[0]).toMatchObject({operation:'UPSERT',canonical_object_id:reservedId,hub_revision:older.customer.hub_revision,channel_id:older.receipt.channel_id,channel_epoch:'1',version_domain:'SOURCE_VERSION',content_digest:olderDigest,projection_digest:older.receipt.projection_digest});
 expect(older.refs).toEqual(references);expect(await x.effects()).toEqual({canonical_object_id:reservedId,customer_id:reservedId,receipts:1,outboxes:1,refs:2,audits:0});
 expect(await epochs()).toEqual(beforeEpochs);
 const stillPending=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
 expect(stillPending.json().data).toEqual({state:'ACCEPTED',operation_id:x.operationId,child_job_id:x.job,receipt:null});
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 expect(await jobState(x.job)).toEqual(applied);expect(await jobState(ordinary)).toEqual(applied);
 const newer=await snapshot();
 expect(newer.customer).toEqual(customer('Literal Selected','42',newer.customer.hub_revision));
 expect(BigInt(newer.customer.hub_revision)).toBeGreaterThan(BigInt(older.customer.hub_revision));
 expect(newer.receipt).toMatchObject({source_version:'42',canonical_object_id:reservedId,channel_id:older.receipt.channel_id,channel_epoch:'1',version_domain:'SOURCE_VERSION',deleted:false,content_digest:recoveryDigest});
 expect(newer.outboxes).toHaveLength(2);expect(newer.outboxes[0]).toEqual(older.outboxes[0]);
 expect(newer.outboxes[1]).toMatchObject({operation:'UPSERT',canonical_object_id:reservedId,hub_revision:newer.customer.hub_revision,channel_id:newer.receipt.channel_id,channel_epoch:'1',version_domain:'SOURCE_VERSION',content_digest:recoveryDigest,projection_digest:newer.receipt.projection_digest});
 expect(newer.refs).toEqual(references);expect(await x.effects()).toEqual({canonical_object_id:reservedId,customer_id:reservedId,receipts:1,outboxes:2,refs:2,audits:0});
 expect(await epochs()).toEqual(beforeEpochs);
 const finalGet=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
 expect(finalGet.statusCode).toBe(200);expect(finalGet.json().data).toEqual({state:'APPLIED',operation_id:x.operationId,child_job_id:x.job,receipt:{channel_id:newer.receipt.channel_id,channel_epoch:'1',source_version:'42',canonical_object_id:reservedId}});
 expect(JSON.stringify(finalGet.json())).not.toContain('Literal Selected');expect(JSON.stringify(finalGet.json())).not.toContain('+86 12345678901');
 await writeFile(join(process.env.M0_RUN_EVIDENCE_ROOT!,'older-after-reservation-observation.json'),JSON.stringify({reservedId,operationId:x.operationId,ordinary,child:x.job,originalOrdinal:x.op.original_ordinal,before:untouched,older,newer,beforeEpochs,afterEpochs:await epochs(),ordinaryJob:await jobState(ordinary),recoveryJob:await jobState(x.job),get:finalGet.json().data},null,2));
},60000);

it('converges on the reserved UUID for equal, newer, and conflicting ordinary version races',async()=>{
 for(const [label,version,display,status,error] of [['duplicate','42','  Literal Selected  ','DUPLICATE',null],['stale','43','  Literal Selected  ','IGNORED_STALE',null],['conflict','42','Different value','QUARANTINED','SOURCE_VERSION_CONFLICT']] as const) {
  const x=await prepareIsolatedCustomer(`race-${label}`);
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
  const ordinary=await enqueueOrdinaryVersion(x,version,display);await runDurableWorkerOnce(worker,{limit:1});
  expect((await context.fixture.pool.query(`SELECT status FROM control.ingestion_job_item WHERE job_id=$1`,[ordinary])).rows[0].status).toBe('APPLIED');
  expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:1,refs:2,audits:0});
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
  await runDurableWorkerOnce(worker,{limit:1});
  expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status,error_code:error});
  expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:1,refs:2,audits:0});
  const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
  expect(get.json().data).toEqual({state:status,operation_id:x.operationId,child_job_id:x.job,receipt:null});
 }
},60000);

it('hides an APPLIED recovery receipt after a later higher version replaces it',async()=>{
 const x=await prepareIsolatedCustomer('receipt-advanced');await runDurableWorkerOnce(worker,{limit:1});
 let get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
 expect(get.json().data).toMatchObject({state:'APPLIED',receipt:{canonical_object_id:x.op.reserved_object_id,source_version:'42'}});
 const ordinary=await enqueueOrdinaryVersion(x,'43','Newer value');await runDurableWorkerOnce(worker,{limit:1});
 const ordinaryState=(await context.fixture.pool.query(`SELECT i.status,b.available_at::text,b.available_at<=clock_timestamp() due,b.claim_token::text FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox b ON b.job_id=i.job_id WHERE i.job_id=$1`,[ordinary])).rows[0];
 expect(ordinaryState.status,JSON.stringify(ordinaryState)).toBe('APPLIED');
 get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});
 expect(get.json().data).toEqual({state:'APPLIED',operation_id:x.operationId,child_job_id:x.job,receipt:null});
 expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:2,refs:2,audits:0});
},60000);

it('does not launder a post-acceptance remap through an equal-version receipt',async()=>{
 const x=await prepareIsolatedCustomer('duplicate-remap');
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const ordinary=await enqueueOrdinaryVersion(x,'42','  Literal Selected  ');await runDurableWorkerOnce(worker,{limit:1});
 const ordinaryState=(await context.fixture.pool.query(`SELECT i.status,b.available_at::text,b.available_at<=clock_timestamp() due,b.claim_token::text FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox b ON b.job_id=i.job_id WHERE i.job_id=$1`,[ordinary])).rows[0];
 expect(ordinaryState.status,JSON.stringify(ordinaryState)).toBe('APPLIED');
 await x.bind('user','selected-user',x.other,'4');const before=await x.effects();
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker,{limit:1});
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'AUTHORITY_MAPPING_SUPERSEDED'});
 expect(await x.effects()).toEqual(before);
},60000);

it('uses literal customer fields and rolls back every effect on a precommit error before retry',async()=>{
 const x=await prepareIsolatedCustomer('rollback');const before=await x.effects();
 expect(before).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:null,receipts:0,outboxes:0,refs:0,audits:0});
 await runDurableWorkerOnce(worker,{limit:1,hooks:{beforeItemCommit:async()=>{throw new Error('test precommit failure');}}});
 expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code,attempts_started FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE',attempts_started:1});
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker,{limit:1});
 expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:1,refs:2,audits:0});
 const row=(await context.fixture.pool.query(`SELECT i.status,i.error_code,i.attempts_started,c.id::text,c.customer_name,c.owner_user_id,c.dept_id,c.status AS customer_status,c.phone,c.source_version::text AS version,
  to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated
  FROM control.ingestion_job_item i JOIN hub.canonical_customer c ON c.tenant_id=$2 AND c.id=$3::uuid WHERE i.job_id=$1`,[x.job,tenant,x.op.reserved_object_id])).rows[0];
 expect(row).toEqual({status:'APPLIED',error_code:null,attempts_started:2,id:x.op.reserved_object_id,customer_name:'Literal Selected',owner_user_id:x.sales,dept_id:'dept1',customer_status:'ACTIVE',phone:'+86 12345678901',version:'42',updated:'2026-10-29T00:12:13Z'});
 expect(x.op.original_ordinal).toBe(1);
},60000);

it('rolls back an expired claim after canonical work and applies once on a later live reclaim',async()=>{
 const x=await prepareIsolatedCustomer('lease');const before=await x.effects();
 await runDurableWorkerOnce(worker,{limit:1,leaseMs:100,hooks:{beforeItemCommit:async()=>{await context.fixture.pool.query('SELECT pg_sleep(0.25)');}}});
 expect(await x.effects()).toEqual(before);
 const expired=(await context.fixture.pool.query(`SELECT i.status,i.attempts_started,o.acknowledged_at IS NOT NULL AS acknowledged,o.lease_expires_at<=clock_timestamp() AS expired FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[x.job])).rows[0];
 expect(expired).toEqual({status:'APPLYING',attempts_started:1,acknowledged:false,expired:true});
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker,{limit:1});
 expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:1,refs:2,audits:0});
 expect((await context.fixture.pool.query(`SELECT i.status,i.attempts_started,o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[x.job])).rows[0]).toEqual({status:'APPLIED',attempts_started:2,acknowledged:true});
},60000);

it('does not revive a claim that expires between the lock and renewal',async()=>{
 const x=await prepareIsolatedCustomer('renew-expiry');const before=await x.effects();let delayed=false;
 const delayedPool=new Proxy(worker,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{
   const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);
   if(!delayed && typeof sql==='string' && sql.includes('SELECT o.id FROM control.ingestion_processing_outbox') && sql.includes('FOR UPDATE OF o')) {
    delayed=true;await query('SELECT pg_sleep(0.25)');
   }
   return result;
  }) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 await runDurableWorkerOnce(delayedPool,{limit:1,leaseMs:100});expect(delayed).toBe(true);expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT i.status,i.attempts_started,o.acknowledged_at IS NOT NULL AS acknowledged,o.lease_expires_at<=clock_timestamp() AS expired FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[x.job])).rows[0]).toEqual({status:'RECEIVED',attempts_started:0,acknowledged:false,expired:true});
},60000);

it('does not revive an ordinary import claim that expires between the lock and renewal',async()=>{
 const x=await prepareIsolatedCustomer('ordinary-renew');const before=await x.effects();
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const ordinary=await enqueueOrdinaryVersion(x,'42','  Literal Selected  ');let delayed=false;
 const delayedPool=new Proxy(worker,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{
   const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);
   if(!delayed && typeof sql==='string' && sql.includes('SELECT o.id FROM control.ingestion_processing_outbox') && sql.includes('FOR UPDATE OF o')) {delayed=true;await query('SELECT pg_sleep(0.25)');}
   return result;
  }) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 await runDurableWorkerOnce(delayedPool,{limit:1,leaseMs:100});expect(delayed).toBe(true);expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT i.status,i.attempts_started,o.acknowledged_at IS NOT NULL AS acknowledged,o.lease_expires_at<=clock_timestamp() AS expired FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[ordinary])).rows[0]).toEqual({status:'RECEIVED',attempts_started:0,acknowledged:false,expired:true});
},60000);

it('rejects a post-acceptance remap of an originally resolved key without canonical effects',async()=>{
 const x=await prepareIsolatedCustomer('old-remap');const before=await x.effects();
 await x.bind('user','selected-user',x.other,'4');await runDurableWorkerOnce(worker,{limit:1});
 expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'AUTHORITY_MAPPING_SUPERSEDED'});
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers:x.headers});expect(get.json().data).toEqual({state:'QUARANTINED',operation_id:x.operationId,child_job_id:x.job,receipt:null});
},60000);

it('rejects an actual originally resolved key remap before recovery admission despite a current approval',async()=>{
 await runDurableWorkerOnce(worker);
 const src='w1-before-binding-remap',headers={authorization:`Bearer ${context.token}`};
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'earlier-sales',departmentId:'dept1',businessRole:'sales'});
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'later-sales',departmentId:'dept1',businessRole:'sales'});
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>context.app.inject({method,url,headers,payload});
 const created=await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Before binding remap',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}});expect(created.statusCode,created.body).toBe(201);
 const fields=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings:fields})).statusCode).toBe(200);
 async function bind(kind:string,external:string,target:string,revision:string) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=${kind}&external_id=${external}`,headers});expect(found.statusCode,found.body).toBe(200);
  const changed=await call('PUT',`/hub/v1/admin/identity-mappings/${found.json().data.id}`,{expected_revision:revision,target_id:target,reason:'confirmed'});expect(changed.statusCode,changed.body).toBe(200);
 }
 const original={schema_version:'hub.v1',batch_id:crypto.randomUUID(),records:[{event_id:crypto.randomUUID(),source_pk:'earlier-sample',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'Sample',rep:'sample-user',team:'sample-dept',state:'ACTIVE'}}]};
 async function approve() {
  const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(original)}});expect(tested.json().data.status).toBe('PASS');
  const report=tested.json().data,approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approved.statusCode,approved.body).toBe(200);
  expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);return approved.json().data.approval_id as string;
 }
 await bind('user','sample-user','earlier-sales','0');await bind('department','sample-dept','dept1','1');await bind('user','selected-user','earlier-sales','2');await approve();
 const selected={...original.records[0]!,event_id:crypto.randomUUID(),source_pk:'earlier-selected',data:{display:'Selected',rep:'selected-user',team:'missing-dept',state:'ACTIVE'}};
 const imported=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'before-remap-origin'},payload:JSON.stringify({...original,batch_id:crypto.randomUUID(),records:[original.records[0],selected]})});
 expect(imported.statusCode,imported.body).toBe(202);const originalJob=imported.json().data.job_id as string;await runDurableWorkerOnce(worker);
 const q=(await context.fixture.pool.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1 AND ordinal=1`,[originalJob])).rows[0]!.id;
 const initial=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(initial.statusCode).toBe(200);expect(initial.json().data.state).toBe('AVAILABLE');
 const expectedState=initial.json().data.expected_state;
 await bind('department','missing-dept','dept1','3');
 // No canonical identity reference uses selected-user before this real remap.
 expect((await context.fixture.pool.query(`SELECT count(*)::int AS n FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$2 AND kind='user' AND external_id='selected-user'`,[tenant,src])).rows[0].n).toBe(0);
 await bind('user','selected-user','later-sales','4');const currentApproval=await approve();
 const proof=(await context.fixture.pool.query(`SELECT j.identity_mapping_revision::text AS original_revision,r.identity_mapping_revision::text AS current_revision,
  encode(m.mapping_digest,'hex') AS digest,a.id::text AS approval_id,a.identity_mapping_revision::text AS approved_revision,f.identity_mapping_revision::text AS remap_revision
  FROM control.ingestion_job j JOIN control.source_registry r ON (r.tenant_key,r.source_id)=(j.tenant_key,j.source_id)
  JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
  JOIN control.source_owner_approval a ON a.id=$2::uuid JOIN control.source_identity_remap_fence f ON (f.tenant_key,f.source_id,f.kind,f.external_id)=(j.tenant_key,j.source_id,'user','selected-user') WHERE j.id=$1`,[originalJob,currentApproval])).rows[0];
 expect(proof).toMatchObject({original_revision:'4',current_revision:'6',approval_id:currentApproval,approved_revision:'6',remap_revision:'6'});expect(proof.digest).toMatch(/^[0-9a-f]{64}$/);
 const snapshot=async()=>(await context.fixture.pool.query(`SELECT to_jsonb(j) AS original_job,to_jsonb(i) AS original_item,to_jsonb(b) AS original_raw,
  (SELECT count(*)::int FROM control.import_recovery_operation WHERE quarantine_id=$2::uuid) AS operations,
  (SELECT count(*)::int FROM control.ingestion_job WHERE tenant_key=$3 AND source_id=$4 AND import_recovery_operation_id IS NOT NULL) AS children,
  (SELECT count(*)::int FROM control.canonical_source_identity WHERE tenant_key=$3 AND source_id=$4 AND entity='customer' AND source_pk='earlier-selected') AS identities,
  (SELECT count(*)::int FROM control.canonical_ownership_audit WHERE tenant_key=$3 AND source_id=$4) AS audits,
  (SELECT count(*)::int FROM raw.ingestion_batch WHERE tenant_key=$3 AND source_id=$4) AS batches
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(j.id,1) JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[originalJob,q,tenant,src])).rows[0];
 const before=await snapshot();expect(before).toMatchObject({operations:0,children:0,identities:0,audits:0,batches:1});
 const candidate=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers});expect(candidate.statusCode).toBe(200);expect(candidate.json().data).toEqual({state:'SCOPE_UNAVAILABLE'});
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'before-remap-recover'},payload:JSON.stringify({expected_state:expectedState,expected_source_revision:'1',identity_mapping_revision:proof.current_revision,identity_mapping_digest:proof.digest,bindings:[{kind:'department',external_id:'missing-dept',target_id:'dept1'}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(409);expect(post.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');expect(await snapshot()).toEqual(before);
},60000);

it('rejects a post-acceptance remap of the confirmed missing key without canonical effects',async()=>{
 const x=await prepareIsolatedCustomer('new-remap');const before=await x.effects();
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'dept2-member',departmentId:'dept2',businessRole:'sales'});
 await x.bind('department','missing-dept','dept2','4');await runDurableWorkerOnce(worker,{limit:1});
 expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'AUTHORITY_MAPPING_SUPERSEDED'});
},60000);

it('fails closed when the selected target is disabled or no longer belongs to its approved department',async()=>{
 for(const [label,enabled,department] of [['disabled',false,'dept1'],['department-drift',true,'dept2']] as const) {
  const x=await prepareIsolatedCustomer(label);const before=await x.effects();
  await context.auth.repository.updateSubject({tenantId:tenant,userId:x.sales,departmentId:department,businessRole:'sales',enabled});
  await runDurableWorkerOnce(worker,{limit:1});expect(await x.effects()).toEqual(before);
  expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID'});
 }
},60000);

it('rejects an externally revoked and re-enabled confirming binding before apply',async()=>{
 const x=await prepareIsolatedCustomer('revoked');const before=await x.effects();
 await context.auth.repository.setIdentityBinding(context.principal.issuer,'owner',false);
 await context.auth.repository.setIdentityBinding(context.principal.issuer,'owner',true);
 await runDurableWorkerOnce(worker,{limit:1});expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'IMPORT_RECOVERY_AUTHORITY_INVALID'});
},60000);

it('leaves no effects when the claim token is replaced before the attempt',async()=>{
 const x=await prepareIsolatedCustomer('claim-replaced');const before=await x.effects(),replacement=crypto.randomUUID();
 await runDurableWorkerOnce(worker,{limit:1,hooks:{afterClaim:async()=>{
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2::uuid,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1`,[x.job,replacement]);
 }}});
 expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT i.status,i.attempts_started,o.claim_token::text,o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[x.job])).rows[0]).toEqual({status:'RECEIVED',attempts_started:0,claim_token:replacement,acknowledged:false});
},60000);

it('rejects a real post-acceptance source security barrier without canonical effects',async()=>{
 const x=await prepareIsolatedCustomer('barrier');const before=await x.effects();
 await context.auth.repository.recordSourceScopeSecurityBarrier(x.src,tenant,'customer','W1_TEST_BARRIER');
 await runDurableWorkerOnce(worker,{limit:1});expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'IMPORT_RECOVERY_PROOF_INVALID'});
},60000);

it('rejects source Owner reassignment and return after acceptance',async()=>{
 const x=await prepareIsolatedCustomer('owner-return');const before=await x.effects();
 const principal=await context.authenticator(context.token);
 const config=(await context.fixture.pool.query(`SELECT c.config FROM control.source_registry r JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(r.tenant_key,r.source_id,r.current_config_revision) WHERE (r.tenant_key,r.source_id)=($1,$2)`,[tenant,x.src])).rows[0].config;
 expect(await context.sourceService.update(principal,x.src,{expected_revision:'1',config,data_owner_user_id:'viewer'})).toMatchObject({owner_revision:'2'});
 expect(await context.sourceService.update(principal,x.src,{expected_revision:'2',config,data_owner_user_id:'owner'})).toMatchObject({owner_revision:'3'});
 await runDurableWorkerOnce(worker,{limit:1});expect(await x.effects()).toEqual(before);
 expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'QUARANTINED',error_code:'IMPORT_RECOVERY_AUTHORITY_INVALID'});
},60000);

it('keeps the admitted proofs after a real ordinary source edit and pause',async()=>{
 const x=await prepareIsolatedCustomer('paused');
 const config=(await context.fixture.pool.query(`SELECT c.config FROM control.source_registry r JOIN control.source_config_revision c ON (c.tenant_key,c.source_id,c.revision)=(r.tenant_key,r.source_id,r.current_config_revision) WHERE (r.tenant_key,r.source_id)=($1,$2)`,[tenant,x.src])).rows[0].config;
 const update=await context.app.inject({method:'PATCH',url:`/hub/v1/admin/sources/${x.src}`,headers:x.headers,payload:{expected_revision:'1',config:{...config,name:'After ordinary edit'}}});expect(update.statusCode,update.body).toBe(200);expect(update.json().data.lifecycle).toBe('PAUSED');
 const fields=await x.call('PUT',`/hub/v1/admin/sources/${x.src}/mappings`,{expected_revision:'2',mappings:x.mappings.map(m=>m.source_field==='display'?{...m,transform:'identity'}:m)});
 expect(fields.statusCode,fields.body).toBe(200);expect(fields.json().data.revision).toBe('3');
 await runDurableWorkerOnce(worker,{limit:1});expect((await context.fixture.pool.query(`SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1`,[x.job])).rows[0]).toEqual({status:'APPLIED',error_code:null});
 expect((await context.fixture.pool.query(`SELECT customer_name FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2::uuid`,[tenant,x.op.reserved_object_id])).rows[0].customer_name).toBe('Literal Selected');
},60000);

it('holds the actor binding lock through customer commit while an external revoker waits',async()=>{
 const x=await prepareIsolatedCustomer('concurrent-revoke');const before=await x.effects();
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
 const applying=runDurableWorkerOnce(worker,{limit:1,hooks:{afterCanonicalApply:async()=>{entered();await gate;}}});
 const revoker=await context.fixture.pool.connect();let pending:Promise<void>|undefined;
 try {
  await reached;await revoker.query('BEGIN');
  const pid=(await revoker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  pending=context.auth.repository.setIdentityBinding(context.principal.issuer,'owner',false,revoker);
  const deadline=Date.now()+10000;let blocked=false;
  while(Date.now()<deadline) {
   blocked=(await context.fixture.pool.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]!.blocked;
   if(blocked) break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(blocked).toBe(true);expect(await x.effects()).toEqual(before);
  release();await applying;await pending;await revoker.query('COMMIT');
  expect(await x.effects()).toEqual({canonical_object_id:x.op.reserved_object_id,customer_id:x.op.reserved_object_id,receipts:1,outboxes:1,refs:2,audits:0});
  expect((await context.fixture.pool.query(`SELECT i.status,i.error_code,o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[x.job])).rows[0]).toEqual({status:'APPLIED',error_code:null,acknowledged:true});
  const binding=(await context.fixture.pool.query(`SELECT b.enabled,s.auth_epoch::text FROM control.identity_binding b JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(b.tenant_key,b.user_id) WHERE b.issuer=$1 AND b.subject='owner'`,[context.principal.issuer])).rows[0];
  expect(binding).toEqual({enabled:false,auth_epoch:(BigInt(x.op.actor_auth_epoch)+1n).toString()});
 } finally {
  release();await applying.catch(()=>undefined);await pending?.catch(()=>undefined);await revoker.query('ROLLBACK').catch(()=>undefined);revoker.release();
  await context.auth.repository.setIdentityBinding(context.principal.issuer,'owner',true);
 }
},60000);

it('exposes only a scope-and-claim ownership entry point to the worker',async()=>{
 const x=await prepareIsolatedCustomer('sql-boundary');const before=await x.effects();
 const acl=(await context.fixture.pool.query(`SELECT p.proname,p.prosecdef,p.proconfig,
  ARRAY[has_function_privilege('hub_worker',p.oid,'EXECUTE'),has_function_privilege('hub_api',p.oid,'EXECUTE'),has_function_privilege('hub_mcp',p.oid,'EXECUTE'),has_function_privilege('hub_publisher',p.oid,'EXECUTE'),has_function_privilege('hub_hasura_read',p.oid,'EXECUTE')] AS grants
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='control' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,[['canonical_owner_effects_internal','canonical_owner_proof_internal','record_import_recovery_customer_owner_change']])).rows;
 expect(acl).toEqual([
  {proname:'canonical_owner_effects_internal',prosecdef:true,proconfig:['search_path=pg_catalog, control'],grants:[false,false,false,false,false]},
  {proname:'canonical_owner_proof_internal',prosecdef:true,proconfig:['search_path=pg_catalog, control'],grants:[false,false,false,false,false]},
  {proname:'record_import_recovery_customer_owner_change',prosecdef:true,proconfig:['search_path=pg_catalog'],grants:[true,false,false,false,false]},
 ]);
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
  await expect(client.query(`SELECT control.record_import_recovery_customer_owner_change($1,$2,$3::uuid,0,$4::uuid,$5::uuid)`,[tenant,x.src,x.job,crypto.randomUUID(),crypto.randomUUID()])).rejects.toMatchObject({code:'42501'});
 } finally {await client.query('ROLLBACK');client.release();}
 expect(await x.effects()).toEqual(before);
},60000);

it('rejects a forged wrong-target projection even with a live operation and same-transaction artifacts',async()=>{
 const x=await prepareIsolatedCustomer('forged-target');const before=await x.effects();
 const client=await context.fixture.pool.connect(),token=crypto.randomUUID();
 try {
  // Trusted, rollback-only fixture: construct a real claim and deliberately forge
  // a wrong projected owner plus matching same-transaction receipt/outbox.
  await client.query('BEGIN');
  await client.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[x.job]);
  const item=(await client.query<{operation_id:string}>(`UPDATE control.ingestion_job_item SET status='APPLYING',attempts_started=1 WHERE job_id=$1 AND ordinal=0 RETURNING operation_id::text`,[x.job])).rows[0]!;
  await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2::uuid,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1`,[x.job,token]);
  await client.query(`INSERT INTO hub.canonical_customer(tenant_id,id,customer_name,owner_user_id,dept_id,status,phone,source_updated_at,source_version,version_domain,channel_epoch,hub_revision)
   SELECT $1,$2::uuid,'Literal Selected',$3,'dept1','ACTIVE','+86 12345678901','2026-10-29T00:12:13Z',42,'SOURCE_VERSION',j.channel_epoch,777
   FROM control.ingestion_job j WHERE j.id=$4`,[tenant,x.op.reserved_object_id,x.other,x.job]);
  await client.query(`UPDATE control.canonical_source_identity SET customer_id=canonical_object_id WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer',$3)`,[tenant,x.src,x.selected.source_pk]);
  await client.query(`INSERT INTO control.canonical_identity_reference(tenant_key,source_id,entity,source_pk,kind,external_id,target_id)
   VALUES($1,$2,'customer',$3,'user','selected-user',$4),($1,$2,'customer',$3,'department','missing-dept','dept1')`,[tenant,x.src,x.selected.source_pk,x.sales]);
  await client.query(`INSERT INTO control.source_version_receipt(tenant_key,source_id,channel_id,channel_epoch,entity,source_pk,version_domain,source_version,source_content_digest,projection_digest,canonical_object_id,deleted)
   SELECT $1,$2,j.channel_id,j.channel_epoch,'customer',$3,'SOURCE_VERSION',42,decode(repeat('ab',32),'hex'),
    control.canonical_projection_digest(decode(repeat('ab',32),'hex'),$4::uuid,jsonb_build_object('owner_user_id',$5::text,'department_id','dept1')),$4::uuid,false
   FROM control.ingestion_job j WHERE j.id=$6`,[tenant,x.src,x.selected.source_pk,x.op.reserved_object_id,x.other,x.job]);
  await client.query(`INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
   SELECT r.tenant_key,r.source_id,r.channel_id,r.channel_epoch,r.version_domain,r.entity,r.canonical_object_id,777,'UPSERT',r.projection_digest,r.source_content_digest
   FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$2,'customer',$3)`,[tenant,x.src,x.selected.source_pk]);
  const evidence=(await client.query(`SELECT r.apply_xid=pg_current_xact_id() AS receipt_same_tx,o.apply_xid=pg_current_xact_id() AS outbox_same_tx,
   r.projection_digest=control.canonical_projection_digest(r.source_content_digest,r.canonical_object_id,jsonb_build_object('owner_user_id',c.owner_user_id,'department_id',c.dept_id)) AS projection_matches,
   c.owner_user_id FROM control.source_version_receipt r JOIN control.canonical_apply_outbox o ON (o.tenant_key,o.source_id,o.channel_id,o.entity,o.canonical_object_id,o.projection_digest,o.source_content_digest)=(r.tenant_key,r.source_id,r.channel_id,r.entity,r.canonical_object_id,r.projection_digest,r.source_content_digest)
   JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(r.tenant_key,r.canonical_object_id) WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$2,'customer',$3)`,[tenant,x.src,x.selected.source_pk])).rows[0];
  expect(evidence).toEqual({receipt_same_tx:true,outbox_same_tx:true,projection_matches:true,owner_user_id:x.other});
  const epochs=async()=>(await client.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=ANY($2::text[]) ORDER BY user_id`,[tenant,['owner',x.sales,x.other]])).rows;
  const beforeEpochs=await epochs();
  await client.query('SET LOCAL ROLE hub_worker');
  const args=[tenant,x.src,x.job,0,item.operation_id,token];
  const reader=await client.query<{value:{operationId:string}}>(`SELECT control.read_import_recovery_worker_context($1,$2,$3::uuid,$4,$5::uuid,$6::uuid) AS value`,args);
  expect(reader.rows[0]!.value.operationId).toBe(x.operationId);
  await client.query('SAVEPOINT forged_call');
  await expect(client.query(`SELECT control.record_import_recovery_customer_owner_change($1,$2,$3::uuid,$4,$5::uuid,$6::uuid)`,args)).rejects.toMatchObject({message:'IMPORT_RECOVERY_CONTEXT_INVALID'});
  await client.query('ROLLBACK TO SAVEPOINT forged_call');await client.query('SET LOCAL ROLE postgres');
  expect(await epochs()).toEqual(beforeEpochs);
  expect((await client.query(`SELECT count(*)::int AS n FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3`,[tenant,x.src,x.selected.source_pk])).rows[0].n).toBe(0);
 } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
 expect(await x.effects()).toEqual(before);
},60000);
