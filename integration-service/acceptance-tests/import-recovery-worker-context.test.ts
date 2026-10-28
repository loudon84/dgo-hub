import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { setupImportRecoveryFixture, setupOrderRecoveryFixture, source, tenant } from './helpers/import-recovery-fixture.js';

let context:Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let orderFixture:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>;
let worker:pg.Pool;

beforeAll(async()=>{
 context=await setupImportRecoveryFixture('schema');
 orderFixture=await setupOrderRecoveryFixture(context,'w0','w0-reference');
 worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${context.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
},120000);
afterAll(async()=>{
 if(recoveryApi) await recoveryApi.close();
 if(worker) await worker.end();
 if(context) {await context.app.close();await new Promise<void>(resolve=>context.jwks.close(()=>resolve()));await context.fixture.close();}
});

const customerBody={schema_version:'hub.v1',batch_id:'abcdef12-3456-0000-0000-000000000011',records:[{event_id:'ABCDEF12-3456-0000-0000-000000000012',source_pk:'w0-uuid-customer',source_version:'12345678901234567890',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{display:'  Literal Customer  ',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]};
const orderBody={schema_version:'hub.v1',batch_id:'abcdef12-3456-0000-0000-000000000021',records:[{event_id:'aBcDeF12-3456-0000-0000-000000000022',source_pk:'w0-uuid-order',source_version:'42',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{buyer:{source_id:source,source_pk:'w0-reference'},number:'  ORD-42  ',state:'CONFIRMED',at:'2026-10-29T08:12:13+08:00',total:'12.30',ccy:'CNY',lines:[{source_line_id:'line-42',product_code:'P-42',product_name:'Literal item',quantity:'2.500000',unit_price:'4.920000',line_amount:'12.30'}]}}]};

async function admit(src:string,entity:'customer'|'order',body:unknown,key:string) {
 const raw=JSON.stringify(body);
 const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/${entity}`,
  headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':key},payload:raw});
 expect(response.statusCode,response.body).toBe(202);
 return {job:response.json().data.job_id as string,raw};
}
async function durableFacts(job:string) {
 return (await context.fixture.pool.query(`SELECT j.status AS job_status,encode(j.request_digest,'hex') AS digest,
  convert_from(r.body_bytes,'UTF8') AS raw,i.event_id::text AS event_id,i.public_record,i.status,i.error_code,i.source_version::text AS source_version
  FROM control.ingestion_job j JOIN raw.ingestion_batch r ON r.id=j.raw_batch_id
  JOIN control.ingestion_job_item i ON i.job_id=j.id AND i.ordinal=0 WHERE j.id=$1`,[job])).rows[0];
}
function independentDigest(src:string,entity:string,canonical:string) {
 return createHash('sha256').update(['hub.ingest.v1',tenant,src,`/hub/v1/admin/sources/${src}/import/${entity}`,canonical].join('\0')).digest('hex');
}

it('applies an ordinary OIDC customer with uppercase event UUID and preserves its exact stored facts',async()=>{
 const {job,raw}=await admit(source,'customer',customerBody,'w0-uuid-customer');
 const before=await durableFacts(job);
 const canonical='{"batch_id":"abcdef12-3456-0000-0000-000000000011","records":[{"data":{"display":"  Literal Customer  ","rep":"rep-a","state":"ACTIVE","team":"team-a"},"event_id":"ABCDEF12-3456-0000-0000-000000000012","operation":"UPSERT","source_pk":"w0-uuid-customer","source_updated_at":"2026-10-29T08:12:13+08:00","source_version":"12345678901234567890"}],"schema_version":"hub.v1"}';
 expect(before).toMatchObject({raw,digest:independentDigest(source,'customer',canonical),event_id:'abcdef12-3456-0000-0000-000000000012',source_version:'12345678901234567890',
  public_record:{event_id:'ABCDEF12-3456-0000-0000-000000000012',source_pk:'w0-uuid-customer',source_version:'12345678901234567890',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{customer_name:'Literal Customer',owner_external_id:'rep-a',department_external_id:'team-a',status:'ACTIVE'}}});
 await runDurableWorkerOnce(worker);
 const after=await durableFacts(job);
 expect(after).toEqual({...before,job_status:'SUCCEEDED',status:'APPLIED',error_code:null});
 const applied=(await context.fixture.pool.query(`SELECT c.customer_name,c.owner_user_id,c.dept_id,c.status,c.source_version::text AS version,
  to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated
  FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
  WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'customer','w0-uuid-customer')`,[tenant,source])).rows[0];
 expect(applied).toEqual({customer_name:'Literal Customer',owner_user_id:'owner',dept_id:'dept1',status:'ACTIVE',version:'12345678901234567890',updated:'2026-10-29T00:12:13Z'});
},30000);

it('applies an ordinary OIDC order with mixed-case event UUID and exact header and line values',async()=>{
 const {job,raw}=await admit(orderFixture.src,'order',orderBody,'w0-uuid-order');
 const before=await durableFacts(job);
 const canonical='{"batch_id":"abcdef12-3456-0000-0000-000000000021","records":[{"data":{"at":"2026-10-29T08:12:13+08:00","buyer":{"source_id":"candidate-source","source_pk":"w0-reference"},"ccy":"CNY","lines":[{"line_amount":"12.30","product_code":"P-42","product_name":"Literal item","quantity":"2.500000","source_line_id":"line-42","unit_price":"4.920000"}],"number":"  ORD-42  ","state":"CONFIRMED","total":"12.30"},"event_id":"aBcDeF12-3456-0000-0000-000000000022","operation":"UPSERT","source_pk":"w0-uuid-order","source_updated_at":"2026-10-29T08:12:13+08:00","source_version":"42"}],"schema_version":"hub.v1"}';
 expect(before).toMatchObject({raw,digest:independentDigest(orderFixture.src,'order',canonical),event_id:'abcdef12-3456-0000-0000-000000000022',source_version:'42',
  public_record:{event_id:'aBcDeF12-3456-0000-0000-000000000022',source_pk:'w0-uuid-order',source_version:'42',operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{customer_ref:{source_id:source,source_pk:'w0-reference'},order_no:'ORD-42',status:'CONFIRMED',order_at:'2026-10-29T08:12:13+08:00',amount:'12.30',currency:'CNY',lines:[{source_line_id:'line-42',product_code:'P-42',product_name:'Literal item',quantity:'2.500000',unit_price:'4.920000',line_amount:'12.30'}]}}});
 await runDurableWorkerOnce(worker);
 const after=await durableFacts(job);expect(after).toEqual({...before,job_status:'SUCCEEDED',status:'APPLIED',error_code:null});
 const applied=(await context.fixture.pool.query(`SELECT o.order_no,o.status,o.amount::text,o.currency,o.customer_id::text,o.source_version::text AS version,
  to_char(o.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS order_at,
  l.source_line_id,l.product_code,l.product_name,l.quantity::text,l.unit_price::text,l.line_amount::text
  FROM control.canonical_source_identity s JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(s.tenant_key,s.order_id)
  JOIN hub.canonical_order_line l ON (l.tenant_id,l.order_id)=(o.tenant_id,o.id)
  WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'order','w0-uuid-order')`,[tenant,orderFixture.src])).rows[0];
 expect(applied).toEqual({order_no:'ORD-42',status:'CONFIRMED',amount:'12.30',currency:'CNY',customer_id:orderFixture.ids[1],version:'42',order_at:'2026-10-29T00:12:13Z',source_line_id:'line-42',product_code:'P-42',product_name:'Literal item',quantity:'2.500000',unit_price:'4.920000',line_amount:'12.30'});
},30000);

let recoveryApi:import('fastify').FastifyInstance;
let prepared:Promise<{customerJob:string;orderJob:string}>|undefined;
const longSubject=`${'s'.repeat(257)}\u0085x`;
async function prepareChildren() {
 if(prepared) return prepared;
 prepared=(async()=>{
  const {copyFile}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {runMigrations}=await import('../migrations/runner.js');
  for(const [name,version] of [['015_import_recovery_schema.sql','015_import_recovery_schema'],['016_import_recovery_admission.sql','016_import_recovery_admission']]) {
   await copyFile(fileURLToPath(new URL(`../migrations/${name}`,import.meta.url)),join(context.migrationDirectory,name));
   expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual([version]);
  }
  const headers={authorization:`Bearer ${context.token}`};
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=department&external_id=team-missing`,headers});
  expect(found.statusCode).toBe(200);
  expect((await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${found.json().data.id}`,headers,payload:{expected_revision:'2',target_id:'dept1',reason:'confirmed'}})).statusCode).toBe(200);
  const {sample}=await import('./helpers/import-recovery-fixture.js');
  const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});
  expect(tested.json().data.status).toBe('PASS');
  const report=tested.json().data;
  const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
  expect(approved.statusCode).toBe(200);
  expect((await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
  // An unrelated tenant disable advances the real global fence between original and binding acceptance.
  const otherClient=await context.fixture.pool.connect();
  try {await otherClient.query('BEGIN');await context.auth.repository.provisionImportAuthority('w0-other-source','i3p1_other',['customer'],otherClient);await otherClient.query('COMMIT');}
  catch(error) {await otherClient.query('ROLLBACK');throw error;} finally {otherClient.release();}
  await context.auth.repository.setTenantEnabled('i3p1_other',false);
  // Trusted precision setup; all later authority still comes from signed OIDC and existing binding rows.
  await context.fixture.pool.query("UPDATE control.auth_subject SET auth_epoch=9007199254740993 WHERE tenant_key=$1 AND user_id='owner'",[tenant]);
  await context.auth.repository.bindIdentity({issuer:context.principal.issuer,subject:longSubject,tenantId:tenant,userId:'owner'});
  const longToken=await context.issueToken(longSubject);
  const Fastify=(await import('fastify')).default; recoveryApi=Fastify({logger:false,requestIdHeader:false});
  const rolePool=new Proxy(context.fixture.pool,{get(target,property){
   if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  const {registerImportRecoveryRoutes}=await import('../ingestion-api/import-recovery-routes.js');
  await registerImportRecoveryRoutes(recoveryApi,{pool:rolePool,authService:context.auth,authenticator:context.authenticator});
  async function accept(id:string,key:string,bindings:unknown[],token=context.token) {
   const actorHeaders={authorization:`Bearer ${token}`};
   const get=await recoveryApi.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:actorHeaders});
   expect(get.statusCode,get.body).toBe(200);const state=get.json().data;
   const response=await recoveryApi.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{...actorHeaders,'content-type':'application/json','idempotency-key':key},
    payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings,reason:'confirm missing mapping'})});
   expect(response.statusCode,response.body).toBe(202);return response.json().data.child_job_id as string;
  }
  const customerJob=await accept(context.partialId,'w0-customer-recovery',[{kind:'department',external_id:'team-missing',target_id:'dept1'}],longToken);
  const orderJob=await accept(orderFixture.q,'w0-order-recovery',[{kind:'customer',source_id:source,source_pk:'w0-reference',target_id:orderFixture.ids[1]}]);
  const origin=(await context.fixture.pool.query(`SELECT o.original_ordinal,o.binding_approval_id::text,j.owner_approval_id::text
   FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.original_job_id WHERE o.child_job_id=$1`,[customerJob])).rows[0];
  expect(origin.original_ordinal).toBe(1);expect(origin.binding_approval_id).not.toBe(origin.owner_approval_id);
  await copyFile(fileURLToPath(new URL('../migrations/017_import_recovery_worker_context.sql',import.meta.url)),join(context.migrationDirectory,'017_import_recovery_worker_context.sql'));
  expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['017_import_recovery_worker_context']);
  await copyFile(fileURLToPath(new URL('../migrations/018_import_recovery_customer_apply.sql',import.meta.url)),join(context.migrationDirectory,'018_import_recovery_customer_apply.sql'));
  expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['018_import_recovery_customer_apply']);
  return {customerJob,orderJob};
 })();
 return prepared;
}
async function childStates(ids:string[]) {
 return (await context.fixture.pool.query(`SELECT j.id::text,j.status AS job_status,i.status AS item_status,i.attempts_started,i.retries_used,i.error_code,
  o.claim_token::text,o.lease_expires_at,o.acknowledged_at,o.available_at
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_processing_outbox o ON o.job_id=j.id
  WHERE j.id=ANY($1::uuid[]) ORDER BY j.id`,[ids])).rows;
}

it('leaves the order child untouched and advances a later ordinary job before LIMIT',async()=>{
 const {customerJob,orderJob}=await prepareChildren();
 // Keep the customer available for the independent rollback-only reader tests below.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[customerJob]);
 const ids=[customerJob,orderJob],before=await childStates(ids);
 expect(before).toHaveLength(2);
 for(const child of before) expect(child).toMatchObject({job_status:'RECEIVED',item_status:'RECEIVED',attempts_started:0,retries_used:0,error_code:null,claim_token:null,lease_expires_at:null,acknowledged_at:null});
 const ordinary=structuredClone(customerBody);ordinary.batch_id='abcdef12-3456-0000-0000-000000000031';ordinary.records[0]!.event_id='abcdef12-3456-0000-0000-000000000032';ordinary.records[0]!.source_pk='w0-later-ordinary';
 const {job}=await admit(source,'customer',ordinary,'w0-later-ordinary');
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 expect((await durableFacts(job)).status).toBe('APPLIED');
 expect(await childStates(ids)).toEqual(before);
},60000);

it('exposes only the bounded worker context definer with a fixed search path',async()=>{
 await prepareChildren();
 const row=(await context.fixture.pool.query(`SELECT p.oid IS NOT NULL AS present,p.prosecdef,p.proconfig,
  CASE WHEN p.oid IS NULL THEN NULL ELSE ARRAY[
   has_function_privilege('hub_worker',p.oid,'EXECUTE'),has_function_privilege('hub_api',p.oid,'EXECUTE'),
   has_function_privilege('hub_mcp',p.oid,'EXECUTE'),has_function_privilege('hub_publisher',p.oid,'EXECUTE'),
   has_function_privilege('hub_hasura_read',p.oid,'EXECUTE')] END AS grants
  FROM (SELECT to_regprocedure('control.read_import_recovery_worker_context(text,text,uuid,integer,uuid,uuid)') AS oid) f
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=f.oid`)).rows[0];
 expect(row).toEqual({present:true,prosecdef:true,proconfig:['search_path=pg_catalog'],grants:[true,false,false,false,false]});
},60000);

type ReaderArgs={tenantId:string;sourceId:string;jobId:string;ordinal:number;itemOperationId:string;claimToken:string};
async function controlledClaim<T>(job:string,src:string,body:(client:import('pg').PoolClient,args:ReaderArgs)=>Promise<T>,options:{expired?:boolean;role?:string;beforeRole?:(client:import('pg').PoolClient)=>Promise<void>}={}) {
 // Trusted fixture only: establish exactly the worker's claim state inside a rollback-only transaction.
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  const token='abcd0000-0000-0000-0000-000000000123';
  await client.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[job]);
  const item=(await client.query<{operation_id:string}>(`UPDATE control.ingestion_job_item SET status='APPLYING',attempts_started=1,retries_used=0
   WHERE job_id=$1 AND ordinal=0 RETURNING operation_id::text`,[job])).rows[0]!;
  await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2,lease_expires_at=clock_timestamp()+($3::integer*interval '1 second') WHERE job_id=$1`,[job,token,options.expired?-1:30]);
  await options.beforeRole?.(client);
  await client.query(`SET LOCAL ROLE ${options.role??'hub_worker'}`);
  return await body(client,{tenantId:tenant,sourceId:src,jobId:job,ordinal:0,itemOperationId:item.operation_id,claimToken:token});
 } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}

it('reads separate frozen proofs for the selected original through a real worker claim',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const value=await controlledClaim(customerJob,source,(client,args)=>readImportRecoveryWorkerContext(client,args));
 expect(value.original.ordinal).toBe(1);
 expect(value.original.sourceVersion).toBe('12345678901234567890');
 expect(value.original.record).toMatchObject({source_pk:'partial',source_version:'12345678901234567890',data:{owner_external_id:'rep-a',department_external_id:'team-missing'}});
 expect(BigInt(value.originalContext.securityBarrierFenceAtAdmission)).toBeLessThan(BigInt(value.bindingContext.securityBarrierFenceAtAdmission));
 expect(value.originalContext.ownerApprovalId).not.toBe(value.bindingContext.ownerApprovalId);
 expect(value.originalContext.identityMappingRevision).not.toBe(value.bindingContext.identityMappingRevision);
 expect(value.confirmedBindings).toEqual([{kind:'department',externalId:'team-missing',targetId:'dept1'}]);
 expect(value.actor).toMatchObject({userId:'owner',subject:longSubject,authEpoch:'9007199254740994'});
 expect(JSON.stringify(value)).not.toContain('body_bytes');
},60000);

it('rejects the wrong worker namespace, item, claim and expired lease',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 for(const change of [
  {sourceId:'wrong-source',message:'IMPORT_RECOVERY_CONTEXT_INVALID'},
  {ordinal:1,message:'IMPORT_RECOVERY_CONTEXT_INVALID'},
  {itemOperationId:'abcd0000-0000-0000-0000-000000000999',message:'IMPORT_RECOVERY_CONTEXT_INVALID'},
  {claimToken:'abcd0000-0000-0000-0000-000000000999',message:'WORKER_CLAIM_LOST'},
 ]) {
  const {message,...fields}=change;
  await expect(controlledClaim(customerJob,source,(client,args)=>readImportRecoveryWorkerContext(client,{...args,...fields}))).rejects.toThrow(message);
 }
 await expect(controlledClaim(customerJob,source,(client,args)=>readImportRecoveryWorkerContext(client,args),{expired:true})).rejects.toThrow('WORKER_CLAIM_LOST');
 await expect(controlledClaim(customerJob,source,(client,args)=>client.query('SELECT control.read_import_recovery_worker_context($1,$2,$3,$4,$5,$6)',[args.tenantId,args.sourceId,args.jobId,args.ordinal,args.itemOperationId,args.claimToken]),{role:'hub_api'})).rejects.toMatchObject({code:'42501'});
},60000);

it('rejects current actor, binding, tenant, scope and epoch changes even after re-enable',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const scopes=['source:read','source:write','source:approve','mapping:write'] as const;
 const subject=(enabled:boolean,managementScopes:readonly (typeof scopes)[number][]=scopes)=>({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales' as const,managementScopes,enabled});
 const mutations:Array<(client:import('pg').PoolClient)=>Promise<void>>=[
  async c=>{await context.auth.repository.updateSubject(subject(false),c);},
  async c=>{await context.auth.repository.updateSubject(subject(false),c);await context.auth.repository.updateSubject(subject(true),c);},
  async c=>{await context.auth.repository.setIdentityBinding(context.principal.issuer,longSubject,false,c);},
  async c=>{await context.auth.repository.setIdentityBinding(context.principal.issuer,longSubject,false,c);await context.auth.repository.setIdentityBinding(context.principal.issuer,longSubject,true,c);},
  async c=>{await context.auth.repository.setTenantEnabled(tenant,false,c);},
  async c=>{await context.auth.repository.setTenantEnabled(tenant,false,c);await context.auth.repository.setTenantEnabled(tenant,true,c);},
  async c=>{await context.auth.repository.updateSubject(subject(true,['source:read','source:write','mapping:write']),c);},
  async c=>{await c.query(`UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);},
 ];
 for(const beforeRole of mutations) await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a),{beforeRole})).rejects.toThrow('IMPORT_RECOVERY_AUTHORITY_INVALID');
},60000);

it('rejects separately corrupted original and binding proof reports and a later real security barrier',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 // Trusted transaction fixture: corrupt only a test-report digest, rolled back after each case.
 for(const side of ['original','binding'] as const) {
  const beforeRole=async(c:import('pg').PoolClient)=>{
   await c.query(`UPDATE control.source_test_report SET sample_digest=decode(repeat('ab',32),'hex') WHERE id=(
    SELECT ${side==='original'?'j.test_report_id':'o.binding_test_report_id'} FROM control.import_recovery_operation o
    JOIN control.ingestion_job j ON j.id=o.original_job_id WHERE o.child_job_id=$1)`,[customerJob]);
  };
  await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a),{beforeRole})).rejects.toThrow('IMPORT_RECOVERY_PROOF_INVALID');
 }
 await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a),{beforeRole:c=>
  context.auth.repository.recordSourceScopeSecurityBarrier(source,tenant,'customer','W0_TEST_BARRIER',c)})).rejects.toThrow('IMPORT_RECOVERY_PROOF_INVALID');
},60000);

it('holds current actor binding locks until the caller transaction ends',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const revoker=await context.fixture.pool.connect();let pending:Promise<void>|undefined;
 try {
  await revoker.query('BEGIN');const pid=(await revoker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await controlledClaim(customerJob,source,async(c,a)=>{
   await readImportRecoveryWorkerContext(c,a);
   pending=context.auth.repository.setIdentityBinding(context.principal.issuer,longSubject,false,revoker);
   await new Promise(resolve=>setTimeout(resolve,200));
   const blocked=await context.fixture.pool.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid]);
   expect(blocked.rows[0]!.blocked).toBe(true);
  });
  await pending;
 } finally {await revoker.query('ROLLBACK').catch(()=>undefined);revoker.release();}
},60000);

it('rejects a truly different event UUID in a trusted corruption fixture',async()=>{
 const body=structuredClone(customerBody);body.batch_id='abcdef12-3456-0000-0000-000000000041';
 body.records[0]!.event_id='abcdef12-3456-0000-0000-000000000042';body.records[0]!.source_pk='w0-corrupt-uuid';
 const {job}=await admit(source,'customer',body,'w0-corrupt-uuid');
 // The trusted fixture temporarily disables the immutable-item trigger to create an impossible supported-write state.
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE control.ingestion_job_item DISABLE TRIGGER ingestion_job_item_fact_immutable');
  await client.query(`UPDATE control.ingestion_job_item SET event_id='abcdef12-3456-0000-0000-000000000043' WHERE job_id=$1`,[job]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('ALTER TABLE control.ingestion_job_item ENABLE TRIGGER ingestion_job_item_fact_immutable');
  await client.query('COMMIT');
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
 await runDurableWorkerOnce(worker);
 expect(await durableFacts(job)).toMatchObject({status:'QUARANTINED',error_code:'DURABLE_FACTS_INVALID',event_id:'abcdef12-3456-0000-0000-000000000043'});
 expect((await context.fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer','w0-corrupt-uuid')`,[tenant,source])).rowCount).toBe(0);
},60000);

it('does not deadlock the existing binding-then-subject revocation order',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const revoker=await context.fixture.pool.connect();
 let resolvePid!:(pid:number)=>void; const workerPid=new Promise<number>(resolve=>{resolvePid=resolve;});
 let reader:Promise<unknown>|undefined;
 try {
  await revoker.query('BEGIN');
  // Same first row update as setIdentityBinding, paused before its subject epoch update.
  await revoker.query(`UPDATE control.identity_binding SET enabled=false WHERE issuer=$1 AND subject=$2`,[context.principal.issuer,longSubject]);
  reader=controlledClaim(customerJob,source,async(c,a)=>{
   resolvePid((await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
   return readImportRecoveryWorkerContext(c,a);
  });
  const pid=await workerPid;let blocked=false;
  for(let n=0;n<30 && !blocked;n++) {
   await new Promise(resolve=>setTimeout(resolve,50));
   blocked=(await context.fixture.pool.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]!.blocked;
  }
  expect(blocked).toBe(true);
  await revoker.query("SET LOCAL lock_timeout='1s'");
  await revoker.query(`UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);
 } finally {
  await revoker.query('ROLLBACK').catch(()=>undefined);revoker.release();
  if(reader) await reader.catch(()=>undefined);
 }
},60000);

async function recoverySideEffectSnapshot(job:string) {
 return (await context.fixture.pool.query(`SELECT j.status AS job_status,i.status AS item_status,i.attempts_started,i.retries_used,i.error_code,
  b.claim_token::text,b.lease_expires_at,b.acknowledged_at,s.auth_epoch::text,s.enabled AS subject_enabled,t.enabled AS tenant_enabled,
  ib.enabled AS binding_enabled,r.data_owner_user_id,r.owner_revision::text,
  (SELECT count(*)::integer FROM hub.canonical_customer c WHERE (c.tenant_id,c.id)=(o.tenant_key,o.reserved_object_id)) AS customers,
  (SELECT count(*)::integer FROM control.source_version_receipt v WHERE (v.tenant_key,v.source_id,v.entity,v.source_pk)=(o.tenant_key,o.source_id,o.entity,o.source_pk)) AS receipts,
  (SELECT count(*)::integer FROM control.canonical_apply_outbox x WHERE (x.tenant_key,x.source_id,x.entity,x.canonical_object_id)=(o.tenant_key,o.source_id,o.entity,o.reserved_object_id)) AS canonical_outboxes
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id
  JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(j.id,0) JOIN control.ingestion_processing_outbox b ON b.job_id=j.id
  JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(o.tenant_key,o.actor_user_id)
  JOIN control.tenant t ON t.tenant_key=o.tenant_key JOIN control.identity_binding ib ON (ib.issuer,ib.subject)=(o.actor_issuer,o.actor_subject)
  JOIN control.source_registry r ON (r.tenant_key,r.source_id)=(o.tenant_key,o.source_id) WHERE j.id=$1`,[job])).rows[0];
}
async function waitForCondition(label:string,check:()=>Promise<boolean>,timeoutMs=10000) {
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline) {
  if(await check()) return;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error(`TIMEOUT_WAITING_FOR_${label}`);
}
async function waitForDatabaseExpiry(expiresAt:string) {
 await waitForCondition('DATABASE_LEASE_EXPIRY',async()=>
  (await context.fixture.pool.query<{expired:boolean}>('SELECT clock_timestamp()>=$1::timestamptz AS expired',[expiresAt])).rows[0]!.expired);
}
async function shorterLease(client:import('pg').PoolClient,job:string) {
 await client.query(`UPDATE control.ingestion_processing_outbox SET lease_expires_at=clock_timestamp()+interval '5 seconds' WHERE job_id=$1`,[job]);
}

it('rejects a claim that expires during the SQL reader binding-lock wait',async()=>{
 const {customerJob}=await prepareChildren();
 const before=await recoverySideEffectSnapshot(customerJob);
 expect(before).toMatchObject({customers:0,receipts:0,canonical_outboxes:0,item_status:'RECEIVED',attempts_started:0,acknowledged_at:null});
 const blocker=await context.fixture.pool.connect();
 try {
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM control.identity_binding WHERE issuer=$1 AND subject=$2 FOR UPDATE',[context.principal.issuer,longSubject]);
  const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await controlledClaim(customerJob,source,async(c,a)=>{
   const expires=(await c.query<{expires:string}>('SELECT lease_expires_at::text AS expires FROM control.ingestion_processing_outbox WHERE job_id=$1',[customerJob])).rows[0]!.expires;
   const pid=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const pending=c.query('SELECT control.read_import_recovery_worker_context($1,$2,$3::uuid,$4,$5::uuid,$6::uuid)',
    [a.tenantId,a.sourceId,a.jobId,a.ordinal,a.itemOperationId,a.claimToken]);
   const outcome=pending.then(()=>({error:undefined}),error=>({error}));
   try {
    await waitForCondition('BINDING_LOCK',async()=>
     (await context.fixture.pool.query<{blocked:boolean}>('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked',[blockerPid,pid])).rows[0]!.blocked,4000);
    await waitForDatabaseExpiry(expires);
    await blocker.query('ROLLBACK');
    expect((await outcome).error).toMatchObject({message:'WORKER_CLAIM_LOST'});
   } finally {await blocker.query('ROLLBACK').catch(()=>undefined);await outcome;}
  },{beforeRole:c=>shorterLease(c,customerJob)});
 } finally {await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release();expect(await recoverySideEffectSnapshot(customerJob)).toEqual(before);}
},60000);

it('rejects a claim that expires during TypeScript proof work after SQL returned live',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const before=await recoverySideEffectSnapshot(customerJob);
 expect(before).toMatchObject({customers:0,receipts:0,canonical_outboxes:0,item_status:'RECEIVED',attempts_started:0,acknowledged_at:null});
 try {
  await controlledClaim(customerJob,source,async(c,a)=>{
   const expires=(await c.query<{expires:string}>('SELECT lease_expires_at::text AS expires FROM control.ingestion_processing_outbox WHERE job_id=$1',[customerJob])).rows[0]!.expires;
   let sqlReturnedLive=false,proofBarrierReads=0;
   // Test-only wrapper pauses after the second real proof barrier query; no production hook is installed.
   const delayed=new Proxy(c,{get(target,key){
    if(key==='query') return async(sql:unknown,...args:unknown[])=>{
     const result=await (target.query.bind(target) as (...v:unknown[])=>Promise<import('pg').QueryResult>)(sql,...args);
     if(typeof sql==='string' && sql.includes('SELECT control.read_import_recovery_worker_context')) {
      sqlReturnedLive=(await target.query<{live:boolean}>('SELECT lease_expires_at>clock_timestamp() AS live FROM control.ingestion_processing_outbox WHERE job_id=$1',[customerJob])).rows[0]!.live;
     }
     if(typeof sql==='string' && sql.includes('SELECT barrier_type FROM control.source_security_barrier') && ++proofBarrierReads===2) await waitForDatabaseExpiry(expires);
     return result;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }});
   const result=await readImportRecoveryWorkerContext(delayed,a).then(()=>({error:undefined}),error=>({error}));
   expect(sqlReturnedLive).toBe(true);expect(proofBarrierReads).toBe(2);
   expect(result.error).toMatchObject({message:'WORKER_CLAIM_LOST'});
  },{beforeRole:c=>shorterLease(c,customerJob)});
 } finally {expect(await recoverySideEffectSnapshot(customerJob)).toEqual(before);}
},60000);


it('keeps frozen proofs after an ordinary edit but rejects actual Owner reassignment and return',async()=>{
 const {customerJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const principal=await context.authenticator(context.token);
 const config=(await context.fixture.pool.query(`SELECT c.config FROM control.source_registry r JOIN control.source_config_revision c
  ON (c.tenant_key,c.source_id,c.revision)=(r.tenant_key,r.source_id,r.current_config_revision) WHERE (r.tenant_key,r.source_id)=($1,$2)`,[tenant,source])).rows[0].config;
 const edited={...config,name:'Ordinary edit after acceptance'};
 expect(await context.sourceService.update(principal,source,{expected_revision:'1',config:edited})).toMatchObject({revision:'2',lifecycle:'PAUSED'});
 await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a))).resolves.toMatchObject({original:{ordinal:1}});
 expect(await context.sourceService.update(principal,source,{expected_revision:'2',config:edited,data_owner_user_id:'viewer'})).toMatchObject({revision:'3',owner_revision:'2'});
 await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a))).rejects.toThrow('IMPORT_RECOVERY_AUTHORITY_INVALID');
 expect(await context.sourceService.update(principal,source,{expected_revision:'3',config:edited,data_owner_user_id:'owner'})).toMatchObject({revision:'4',owner_revision:'3'});
 await expect(controlledClaim(customerJob,source,(c,a)=>readImportRecoveryWorkerContext(c,a))).rejects.toThrow('IMPORT_RECOVERY_AUTHORITY_INVALID');
},60000);

it('reads the accepted order context and exact confirmed foreign tuple under a controlled worker claim',async()=>{
 const {orderJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 const result=await controlledClaim(orderJob,orderFixture.src,(c,a)=>readImportRecoveryWorkerContext(c,a));
 expect(result.entity).toBe('order');
 expect(result.original.record).toMatchObject({source_pk:'order-w0-reference',source_version:'1',data:{customer_ref:{source_id:source,source_pk:'w0-reference'}}});
 expect(result.confirmedBindings).toEqual([{kind:'customer',sourceId:source,sourcePk:'w0-reference',externalId:orderFixture.key('w0-reference'),targetId:orderFixture.ids[1]}]);
 expect(result.originalContext.ownerApprovalId).not.toBe(result.bindingContext.ownerApprovalId);
},60000);

it('fails closed on wrong tenant, unknown job, replaced and acknowledged claims',async()=>{
 const {orderJob}=await prepareChildren();
 const {readImportRecoveryWorkerContext}=await import('../etl-worker/import-recovery-context.js');
 await expect(controlledClaim(orderJob,orderFixture.src,(c,a)=>readImportRecoveryWorkerContext(c,{...a,tenantId:'i3p1_other'}))).rejects.toThrow('IMPORT_RECOVERY_CONTEXT_INVALID');
 await expect(controlledClaim(orderJob,orderFixture.src,(c,a)=>readImportRecoveryWorkerContext(c,{...a,jobId:'abcd0000-0000-0000-0000-000000000999'}))).rejects.toThrow('IMPORT_RECOVERY_CONTEXT_INVALID');
 await expect(controlledClaim(orderJob,orderFixture.src,(c,a)=>readImportRecoveryWorkerContext(c,a),{beforeRole:async c=>{
  await c.query(`UPDATE control.ingestion_processing_outbox SET claim_token='abcd0000-0000-0000-0000-000000000999' WHERE job_id=$1`,[orderJob]);
 }})).rejects.toThrow('WORKER_CLAIM_LOST');
 await expect(controlledClaim(orderJob,orderFixture.src,(c,a)=>readImportRecoveryWorkerContext(c,a),{beforeRole:async c=>{
  await c.query(`UPDATE control.ingestion_processing_outbox SET claim_token=NULL,lease_expires_at=NULL,acknowledged_at=clock_timestamp() WHERE job_id=$1`,[orderJob]);
 }})).rejects.toThrow('WORKER_CLAIM_LOST');
},60000);

it('does not process or acknowledge a flagged job delivered by a controlled stale claimant',async()=>{
 const {orderJob}=await prepareChildren();let hookCalled=false;
 // Test-only pool wrapper injects a stale candidate after the real SQL exclusion, without adding a production bypass.
 const stalePool=new Proxy(worker,{get(target,property){
  if(property==='connect') return async()=>{
   const client=await target.connect(),query=client.query.bind(client);
   return new Proxy(client,{get(inner,key){
    if(key==='query') return async(sql:unknown,...args:unknown[])=>{
     const result=await (query as (...v:unknown[])=>Promise<import('pg').QueryResult>)(sql,...args);
     if(typeof sql==='string' && sql.includes('SELECT o.job_id,j.tenant_key,j.source_id'))
      return {...result,rowCount:1,rows:[{job_id:orderJob,tenant_key:tenant,source_id:orderFixture.src}]};
     return result;
    };
    const value=Reflect.get(inner,key,inner);return typeof value==='function'?value.bind(inner):value;
   }});
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 expect(await runDurableWorkerOnce(stalePool,{limit:1,hooks:{afterClaim:async()=>{hookCalled=true;}}})).toBe(1);
 const [state]=await childStates([orderJob]);
 expect(hookCalled).toBe(false);
 expect(state).toMatchObject({job_status:'PROCESSING',item_status:'RECEIVED',attempts_started:0,retries_used:0,error_code:null,acknowledged_at:null});
 expect(state.claim_token).toBeTruthy();
 expect((await context.fixture.pool.query(`SELECT 1 FROM hub.canonical_order o JOIN control.canonical_source_identity s ON (s.tenant_key,s.order_id)=(o.tenant_id,o.id) WHERE s.tenant_key=$1 AND s.source_id=$2 AND s.source_pk='order-w0-reference'`,[tenant,orderFixture.src])).rowCount).toBe(0);
},60000);
