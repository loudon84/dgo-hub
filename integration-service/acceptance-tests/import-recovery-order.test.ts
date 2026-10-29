import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../migrations/runner.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { buildApp } from '../app.js';
import { registerImportRecoveryRoutes } from '../ingestion-api/import-recovery-routes.js';
import { bindingInput, importRecoveryDigest, type ImportRecoveryRequest } from '../ingestion-api/import-recovery-contract.js';
import { readImportRecoveryBindingPlan } from '../ingestion-api/import-recovery-plan.js';
import { setupImportRecoveryFixture, setupOrderRecoveryFixture, source, tenant } from './helpers/import-recovery-fixture.js';

let context:Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let order:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>;
let worker:pg.Pool;
const api=Fastify({logger:false,requestIdHeader:false});
let child:string,operation:string,reserved:string;

async function observedOrderFixture(label:string,pk:string) {
 const observations:unknown[]=[];
 const connections:unknown[]=[];
 const pool=context.fixture.pool,previousConnect=pool.connect;
 const originalConnect=previousConnect.bind(pool) as (...args:unknown[])=>unknown;
 // Inspect the actual checked-out backend before each explicit BEGIN, including
 // a previously open transaction on the same pooled connection.
 pool.connect=((callback?:unknown)=>{
  if(callback) return originalConnect(callback);
  return (originalConnect() as Promise<pg.PoolClient>).then(async client=>{
   try {
    const state=await client.query(`SELECT pg_backend_pid() pid,transaction_timestamp()::text transaction_start,
     statement_timestamp()::text statement_start,transaction_timestamp()<>statement_timestamp() preexisting_transaction`);
    connections.push(state.rows[0]);return client;
   } catch(error) {client.release(error as Error);throw error;}
  });
 }) as typeof pool.connect;
 const clockState=async()=> (await context.fixture.pool.query(`SELECT clock_timestamp()::text clock,pg_backend_pid() probe_pid,
  transaction_timestamp()::text transaction_start,statement_timestamp()::text statement_start,
  transaction_timestamp()<>statement_timestamp() probe_preexisting_transaction,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'state',a.state,'xact_start',a.xact_start)),'[]'::jsonb) FROM pg_stat_activity a
   WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND a.state LIKE 'idle in transaction%') idle_transactions`)).rows[0];
 const observedApp=new Proxy(context.app,{get(target,property){
  if(property==='inject') return async(options:{method:string;url:string;[key:string]:unknown})=>{
   const observed=options.url.endsWith('/test') || options.url.endsWith('/approve');
   const before=observed?await clockState():undefined;
   const inject=target.inject as unknown as (input:unknown)=>Promise<{statusCode:number;body:string}>;
   const response=await inject.call(target,options);
   if(observed) {
    const after=await clockState();
    observations.push({url:options.url,before,after,status:response.statusCode,body:response.body});
   }
   return response;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 try {
  const result=await setupOrderRecoveryFixture({...context,app:observedApp,principal:await context.authenticator(context.token)},label,pk);
  await writeFile(join(process.env.M0_RUN_EVIDENCE_ROOT!,`w2-${label}-approval-observation.json`),JSON.stringify({observations,connections},null,2));
  return result;
 } catch(error) {
  const debug=await context.fixture.pool.query(`SELECT t.id::text,to_char(t.created_at,'YYYY-MM-DD HH24:MI:SS.US') created_at,t.identity_mapping_revision::text,r.lifecycle,r.identity_mapping_revision::text current_identity,
   EXISTS(SELECT 1 FROM control.source_test_report newer WHERE newer.tenant_key=t.tenant_key AND newer.source_id=t.source_id AND (newer.created_at,newer.id)>(t.created_at,t.id)) newer_exists
   FROM control.source_test_report t JOIN control.source_registry r USING(tenant_key,source_id) WHERE t.tenant_key=$1 AND t.source_id=$2 ORDER BY t.created_at,t.id`,[tenant,`order-binding-${label}`]);
  await writeFile(join(process.env.M0_RUN_EVIDENCE_ROOT!,`w2-${label}-approval-diagnostic.json`),JSON.stringify({error:String(error),observations,connections,reports:debug.rows},null,2));
  throw new Error(`${String(error)} observations=${JSON.stringify(observations)} reports=${JSON.stringify(debug.rows)}`);
 } finally {
  pool.connect=previousConnect;
 }
}

beforeAll(async()=>{
 context=await setupImportRecoveryFixture('schema');
 order=await observedOrderFixture('w2','w2-reference');
 for(const name of ['015_import_recovery_schema','016_import_recovery_admission','017_import_recovery_worker_context','018_import_recovery_customer_apply','019_order_visibility_effects']) {
  await copyFile(fileURLToPath(new URL(`../migrations/${name}.sql`,import.meta.url)),join(context.migrationDirectory,`${name}.sql`));
  expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual([name]);
 }
 const rolePool=new Proxy(context.fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 await registerImportRecoveryRoutes(api,{pool:rolePool,authService:context.auth,authenticator:context.authenticator});
 const headers={authorization:`Bearer ${context.token}`};
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${order.q}/import-recovery`,headers});expect(get.statusCode,get.body).toBe(200);
 const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${order.q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'w2-order'},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'customer',source_id:source,source_pk:'w2-reference',target_id:order.ids[1]}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);child=post.json().data.child_job_id;operation=post.json().data.operation_id;
 reserved=(await context.fixture.pool.query<{id:string}>('SELECT reserved_object_id::text AS id FROM control.import_recovery_operation WHERE operation_id=$1',[operation])).rows[0]!.id;
 worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${context.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
},120000);
afterAll(async()=>{
 await api.close();if(worker) await worker.end();
 if(context){await context.app.close();await new Promise<void>(resolve=>context.jwks.close(()=>resolve()));await context.fixture.close();}
});

it('keeps the recovery route unregistered in the default not-ready application',async()=>{
 const unconfigured=await buildApp({logger:false});
 try {
  const url='/hub/v1/admin/quarantine/61000000-0000-4000-8000-000000000001/import-recovery';
  expect((await unconfigured.inject({method:'GET',url})).statusCode).toBe(404);
  expect((await unconfigured.inject({method:'POST',url,payload:{}})).statusCode).toBe(404);
 } finally {await unconfigured.close();}
});

it('applies an admitted order against the exact confirmed customer and reserved order UUID',async()=>{
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 const row=(await context.fixture.pool.query(`SELECT j.status AS job_status,i.status AS item_status,i.error_code,i.attempts_started,
  c.id::text,c.customer_id::text,c.order_no,c.status,c.amount::text,c.currency,c.source_version::text AS version,
  to_char(c.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS order_at,
  s.canonical_object_id::text,s.order_id::text,r.source_version::text AS receipt_version,r.canonical_object_id::text AS receipt_object,
  (SELECT count(*)::int FROM control.canonical_apply_outbox x WHERE x.tenant_key=$2 AND x.source_id=$3 AND x.canonical_object_id=c.id) AS canonical_outboxes,
  o.acknowledged_at IS NOT NULL AS acknowledged
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_processing_outbox o ON o.job_id=j.id
  LEFT JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=($2,$3,'order','order-w2-reference')
  LEFT JOIN hub.canonical_order c ON (c.tenant_id,c.id)=(s.tenant_key,s.order_id)
  LEFT JOIN control.source_version_receipt r ON (r.tenant_key,r.source_id,r.entity,r.source_pk)=($2,$3,'order','order-w2-reference') WHERE j.id=$1`,[child,tenant,order.src])).rows[0];
 expect(row).toEqual({job_status:'SUCCEEDED',item_status:'APPLIED',error_code:null,attempts_started:1,id:reserved,customer_id:order.ids[1],order_no:'O1',status:'CONFIRMED',amount:'12.00',currency:'CNY',version:'1',order_at:'2026-10-29T00:00:00Z',canonical_object_id:reserved,order_id:reserved,receipt_version:'1',receipt_object:reserved,canonical_outboxes:1,acknowledged:true});
 const lines=(await context.fixture.pool.query(`SELECT source_line_id,product_code,product_name,quantity::text,unit_price::text,line_amount::text,deleted_at FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2`,[tenant,reserved])).rows;
 expect(lines).toEqual([{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00',deleted_at:null}]);
 const reference=(await context.fixture.pool.query(`SELECT kind,external_id,target_id FROM control.canonical_identity_reference WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order','order-w2-reference')`,[tenant,order.src])).rows;
 expect(reference).toEqual([{kind:'customer',external_id:order.key('w2-reference'),target_id:order.ids[1]}]);
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${order.q}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(get.statusCode,get.body).toBe(200);expect(get.json().data).toMatchObject({state:'APPLIED',operation_id:operation,child_job_id:child,receipt:{canonical_object_id:reserved,source_version:'1'}});
 expect(JSON.stringify(get.json())).not.toContain('O1');
},60000);

async function acceptOrder(fixture:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>,label:string,referencePk=`ref-${label}`) {
 const headers={authorization:`Bearer ${context.token}`};
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${fixture.q}/import-recovery`,headers});
 expect(get.statusCode,get.body).toBe(200);expect(get.json().data.state).toBe('AVAILABLE');const state=get.json().data;
 const post=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${fixture.q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':`w2-${label}`},payload:JSON.stringify({expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings:[{kind:'customer',source_id:source,source_pk:referencePk,target_id:fixture.ids[1]}],reason:'confirmed'})});
 expect(post.statusCode,post.body).toBe(202);
 const operationId=post.json().data.operation_id as string,job=post.json().data.child_job_id as string;
 const own=(await context.fixture.pool.query<{id:string}>('SELECT reserved_object_id::text AS id FROM control.import_recovery_operation WHERE operation_id=$1',[operationId])).rows[0]!.id;
 return {job,operationId,own};
}

async function createCase(label:string) {
 const fixture=await observedOrderFixture(label,`ref-${label}`);
 return {...fixture,...await acceptOrder(fixture,label)};
}

async function recoveryStatus(q:string) {
 const response=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(response.statusCode,response.body).toBe(200);return response.json().data;
}

it('applies ordinal one to an existing order with exact decimals, full lines and omitted-line deletion',async()=>{
 const src='w2-rich-order',headers={authorization:`Bearer ${context.token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>context.app.inject({method,url,headers,payload});
 await context.auth.repository.provisionSubject({tenantId:tenant,userId:'new-sales',departmentId:'dept2',businessRole:'sales'});
 for(const [userId,departmentId,enabled] of [['manager-one','dept1',true],['manager-two','dept2',true],['manager-other','dept3',true],['manager-disabled','dept2',false]] as const)
  await context.auth.repository.provisionSubject({tenantId:tenant,userId,departmentId,businessRole:'sales_manager',enabled});
 // Trusted setup changes owners of the two distinct preexisting fixture customers before any order is admitted.
 await context.fixture.pool.query(`UPDATE hub.canonical_customer SET owner_user_id=CASE WHEN id=$2::uuid THEN 'owner' ELSE 'new-sales' END,
  dept_id=CASE WHEN id=$2::uuid THEN 'dept1' ELSE 'dept2' END WHERE tenant_id=$1 AND id=ANY($3::uuid[])`,[tenant,order.ids[0],order.ids]);
 expect((await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'W2 rich',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const fields=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings:fields})).statusCode).toBe(200);
 const oldKey=order.key('sample-ref-w2'),newKey=order.key('w2-reference');
 await context.sourceService.writeIdentityMappings(await context.authenticator(context.token),src,[{kind:'customer',external_id:oldKey,target_id:order.ids[0]}]);
 const line=(id:string,product:string,quantity:string,price:string,amount:string)=>({source_line_id:id,product_code:product,product_name:`Name ${product}`,quantity,unit_price:price,line_amount:amount});
 const record=(pk:string,buyer:string,version:string,lines:ReturnType<typeof line>[],number:string,total:string)=>({event_id:randomUUID(),source_pk:pk,source_version:version,operation:'UPSERT',source_updated_at:'2026-10-29T08:12:13+08:00',data:{buyer:{source_id:source,source_pk:buyer},number,state:'CONFIRMED',at:'2026-10-29T08:12:13+08:00',total,ccy:'CNY',lines}});
 const old=record('selected-rich','sample-ref-w2','1',[line('keep','OLD','1.000000','2.000000','2.00'),line('omit','OMIT','1.000000','3.000000','3.00')],'OLD','5.00');
 const sampleBody={schema_version:'hub.v1',batch_id:randomUUID(),records:[old]};
 async function approve(){const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{order:JSON.stringify(sampleBody)}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;const approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});if(approved.statusCode!==200) {const debug=await context.fixture.pool.query(`SELECT t.id,t.created_at,t.identity_mapping_revision::text,r.lifecycle,r.identity_mapping_revision::text current_identity FROM control.source_test_report t JOIN control.source_registry r USING(tenant_key,source_id) WHERE t.tenant_key=$1 AND t.source_id=$2 ORDER BY t.created_at,t.id`,[tenant,src]);throw new Error(`${approved.body} ${JSON.stringify(debug.rows)}`);}expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);}
 await approve();
 const submit=async(body:unknown,key:string)=>{const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':key},payload:JSON.stringify(body)});expect(response.statusCode,response.body).toBe(202);return response.json().data.job_id as string;};
 const baselineJob=await submit(sampleBody,'w2-rich-baseline');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[baselineJob])).rows[0].status).toBe('APPLIED');
 const beforeOrder=(await context.fixture.pool.query<{id:string}>(`SELECT canonical_object_id::text id FROM control.canonical_source_identity WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order','selected-rich')`,[tenant,src])).rows[0]!.id;
 const fresh=record('selected-rich','w2-reference','12345678901234567890',[line('keep','NEW','9007199254.123456','0.123456','11.17'),line('new','B','2.500000','4.920000','12.30')],'  RICH-42  ','9007199254740993.17');
 const first=record('earlier-rich','sample-ref-w2','8',[line('first','F','1.000000','1.000000','1.00')],'EARLIER','1.00');
 const original={schema_version:'hub.v1',batch_id:randomUUID(),records:[first,fresh]},originalRaw=JSON.stringify(original);
 const originalJob=await submit(original,'w2-rich-original');await runDurableWorkerOnce(worker);
 const originalItems=(await context.fixture.pool.query(`SELECT ordinal,status,error_code FROM control.ingestion_job_item WHERE job_id=$1 ORDER BY ordinal`,[originalJob])).rows;
 expect(originalItems).toEqual([{ordinal:0,status:'APPLIED',error_code:null},{ordinal:1,status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID'}]);
 const q=(await context.fixture.pool.query<{id:string}>('SELECT quarantine_id::text id FROM control.ingestion_quarantine_index WHERE job_id=$1 AND ordinal=1',[originalJob])).rows[0]!.id;
 const epochs=async()=> (await context.fixture.pool.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id IN ('owner','new-sales') ORDER BY user_id`,[tenant])).rows;
 const managers=async()=> (await context.fixture.pool.query(`SELECT user_id,auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id IN ('manager-one','manager-two','manager-other','manager-disabled') ORDER BY user_id`,[tenant])).rows;
 const audits=async()=> (await context.fixture.pool.query<{count:number}>(`SELECT count(*)::int count FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2 AND source_pk='selected-rich'`,[tenant,src])).rows[0]!.count;
 const beforeBinding={epochs:await epochs(),managers:await managers(),audit:await audits()};
 const candidate=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=customer&external_id=${encodeURIComponent(newKey)}`,headers});
 expect(candidate.statusCode,candidate.body).toBe(200);
 const binding=await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:'1',target_id:order.ids[1],reason:'confirmed'});
 expect(binding.statusCode,binding.body).toBe(200);
 await approve();const afterBinding={epochs:await epochs(),managers:await managers(),audit:await audits()};
 const available=await recoveryStatus(q);expect(available.state).toBe('AVAILABLE');
 const accepted=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${q}/import-recovery`,headers:{...headers,'content-type':'application/json','idempotency-key':'w2-rich-recovery'},payload:JSON.stringify({expected_state:available.expected_state,expected_source_revision:available.expected_source_revision,identity_mapping_revision:available.identity_mapping_revision,identity_mapping_digest:available.identity_mapping_digest,bindings:[{kind:'customer',source_id:source,source_pk:'w2-reference',target_id:order.ids[1]}],reason:'confirmed'})});
 expect(accepted.statusCode,accepted.body).toBe(202);const job=accepted.json().data.child_job_id as string,operationId=accepted.json().data.operation_id as string;
 const facts=(await context.fixture.pool.query(`SELECT o.original_ordinal,o.reserved_object_id::text,oj.identity_mapping_revision::text AS original_mapping,o.binding_identity_mapping_revision::text AS binding_mapping,
 cj.raw_batch_id=oj.raw_batch_id AS same_raw,cj.request_digest=oj.request_digest AS same_digest,ci.public_record=oi.public_record AS same_record,
 convert_from(b.body_bytes,'UTF8') AS raw FROM control.import_recovery_operation o JOIN control.ingestion_job oj ON oj.id=o.original_job_id
 JOIN raw.ingestion_batch b ON b.id=oj.raw_batch_id JOIN control.ingestion_job cj ON cj.id=o.child_job_id
 JOIN control.ingestion_job_item oi ON (oi.job_id,oi.ordinal)=(oj.id,o.original_ordinal) JOIN control.ingestion_job_item ci ON (ci.job_id,ci.ordinal)=(cj.id,0) WHERE o.operation_id=$1`,[operationId])).rows[0];
 expect(facts).toMatchObject({original_ordinal:1,reserved_object_id:beforeOrder,original_mapping:'2',binding_mapping:'3',same_raw:true,same_digest:true,same_record:true,raw:originalRaw});
 const business=async()=> (await context.fixture.pool.query(`SELECT to_jsonb(o) header,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.source_line_id) FROM hub.canonical_order_line l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id)) lines,
  (SELECT to_jsonb(r) FROM control.canonical_identity_reference r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk,r.kind)=($1,$2,'order','selected-rich','customer')) reference,
  (SELECT to_jsonb(v) FROM control.source_version_receipt v WHERE (v.tenant_key,v.source_id,v.entity,v.source_pk)=($1,$2,'order','selected-rich')) receipt,
  (SELECT count(*)::int FROM control.canonical_apply_outbox x WHERE x.tenant_key=$1 AND x.source_id=$2 AND x.canonical_object_id=$3) outboxes
  FROM hub.canonical_order o WHERE (o.tenant_id,o.id)=($1,$3)`,[tenant,src,beforeOrder])).rows[0];
 const beforeEffects={business:await business(),epochs:await epochs(),managers:await managers(),audit:await audits()};
 await context.fixture.pool.query(`CREATE FUNCTION public.w2_rich_line_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'W2_RICH_LINE_FAULT'; END $$`);
 await context.fixture.pool.query(`CREATE TRIGGER w2_rich_line_fault BEFORE INSERT OR UPDATE ON hub.canonical_order_line FOR EACH ROW WHEN (NEW.order_id='${beforeOrder}'::uuid AND NEW.product_code='B') EXECUTE FUNCTION public.w2_rich_line_fault()`);
 try {await runDurableWorkerOnce(worker);} finally {
  await context.fixture.pool.query('DROP TRIGGER w2_rich_line_fault ON hub.canonical_order_line');await context.fixture.pool.query('DROP FUNCTION public.w2_rich_line_fault()');
 }
 expect((await context.fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[job])).rows[0]).toEqual({status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE'});
 expect({business:await business(),epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(beforeEffects);
 async function releaseRetry(){await context.fixture.pool.query('UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1',[job]);await context.fixture.pool.query('UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1',[job]);}
 await releaseRetry();await runDurableWorkerOnce(worker,{hooks:{beforeItemCommit:async()=>{throw new Error('W2_AFTER_EFFECTS_FAULT');}}});
 expect((await context.fixture.pool.query('SELECT status,error_code FROM control.ingestion_job_item WHERE job_id=$1',[job])).rows[0]).toEqual({status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE'});
 expect({business:await business(),epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(beforeEffects);
 await releaseRetry();await runDurableWorkerOnce(worker);
 const header=(await context.fixture.pool.query(`SELECT c.id::text,c.customer_id::text,c.order_no,c.status,c.amount::text,c.currency,c.source_version::text,
 to_char(c.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') order_at,to_char(c.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') updated,
 i.status item_status,i.error_code,b.acknowledged_at IS NOT NULL acknowledged FROM hub.canonical_order c JOIN control.ingestion_job_item i ON i.job_id=$3 JOIN control.ingestion_processing_outbox b ON b.job_id=i.job_id WHERE (c.tenant_id,c.id)=($1,$2)`,[tenant,beforeOrder,job])).rows[0];
 expect(header).toEqual({id:beforeOrder,customer_id:order.ids[1],order_no:'RICH-42',status:'CONFIRMED',amount:'9007199254740993.17',currency:'CNY',source_version:'12345678901234567890',order_at:'2026-10-29T00:12:13Z',updated:'2026-10-29T00:12:13Z',item_status:'APPLIED',error_code:null,acknowledged:true});
 const lines=(await context.fixture.pool.query(`SELECT source_line_id,product_code,product_name,quantity::text,unit_price::text,line_amount::text,deleted_at IS NOT NULL deleted FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id`,[tenant,beforeOrder])).rows;
 expect(lines).toEqual([{source_line_id:'keep',product_code:'NEW',product_name:'Name NEW',quantity:'9007199254.123456',unit_price:'0.123456',line_amount:'11.17',deleted:false},{source_line_id:'new',product_code:'B',product_name:'Name B',quantity:'2.500000',unit_price:'4.920000',line_amount:'12.30',deleted:false},{source_line_id:'omit',product_code:'OMIT',product_name:'Name OMIT',quantity:'1.000000',unit_price:'3.000000',line_amount:'3.00',deleted:true}]);
 const ref=(await context.fixture.pool.query(`SELECT external_id,target_id FROM control.canonical_identity_reference WHERE (tenant_key,source_id,entity,source_pk,kind)=($1,$2,'order','selected-rich','customer')`,[tenant,src])).rows;
 expect(ref).toEqual([{external_id:'c:4mG5wOgQN4Jzs4KZ3kkwNCMxSH_1rYZqrNsqBfe7r3g',target_id:order.ids[1]}]);
 const receipts=(await context.fixture.pool.query(`SELECT r.canonical_object_id::text,r.source_version::text,encode(r.source_content_digest,'hex') digest,
 (SELECT count(*)::int FROM control.canonical_apply_outbox x WHERE x.tenant_key=r.tenant_key AND x.source_id=r.source_id AND x.canonical_object_id=r.canonical_object_id) outboxes
 FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$2,'order','selected-rich')`,[tenant,src])).rows;
 // SHA-256 of the independently written canonical literal for this exact order, not the implementation serializer.
 expect(receipts).toEqual([{canonical_object_id:beforeOrder,source_version:'12345678901234567890',digest:'6bf0a962b15e0cdf6f4a5ac4a94e1593bcd423fc5d4f8ae861be9bc8c6c3ab59',outboxes:2}]);
 expect(await recoveryStatus(q)).toMatchObject({state:'APPLIED',operation_id:operationId,child_job_id:job,receipt:{canonical_object_id:beforeOrder,source_version:'12345678901234567890'}});
 const afterApply={epochs:await epochs(),managers:await managers(),audit:await audits()};
 await writeFile(join(process.env.M0_RUN_EVIDENCE_ROOT!,'w2-existing-order-observation.json'),JSON.stringify({beforeBinding,afterBinding,afterApply,header,receipts,operationId},null,2));
 expect(beforeBinding).toEqual({epochs:[{user_id:'new-sales',auth_epoch:'0'},{user_id:'owner',auth_epoch:'1'}],managers:[{user_id:'manager-disabled',auth_epoch:'0'},{user_id:'manager-one',auth_epoch:'0'},{user_id:'manager-other',auth_epoch:'0'},{user_id:'manager-two',auth_epoch:'0'}],audit:0});
 expect(afterBinding).toEqual(beforeBinding);
 expect(afterApply).toEqual({epochs:[{user_id:'new-sales',auth_epoch:'1'},{user_id:'owner',auth_epoch:'2'}],managers:[{user_id:'manager-disabled',auth_epoch:'0'},{user_id:'manager-one',auth_epoch:'1'},{user_id:'manager-other',auth_epoch:'0'},{user_id:'manager-two',auth_epoch:'1'}],audit:1});
 const audit=(await context.fixture.pool.query(`SELECT kind,external_id,old_target_id,new_target_id,identity_mapping_revision::text,actor_user_id,reason
  FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2 AND entity='order' AND source_pk='selected-rich'`,[tenant,src])).rows;
 expect(audit).toEqual([{kind:'customer',external_id:'c:4mG5wOgQN4Jzs4KZ3kkwNCMxSH_1rYZqrNsqBfe7r3g',old_target_id:order.ids[0],new_target_id:order.ids[1],identity_mapping_revision:'3',actor_user_id:'owner',reason:'source projection changed customer'}]);
 // Recreate only the unacknowledged post-commit processing state; a terminal reclaim must not reapply.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=NULL,claim_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp() WHERE job_id=$1`,[job]);
 await runDurableWorkerOnce(worker);expect({epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(afterApply);
 expect((await context.fixture.pool.query('SELECT attempts_started FROM control.ingestion_job_item WHERE job_id=$1',[job])).rows[0].attempts_started).toBe(3);
 const duplicate={...fresh,event_id:randomUUID()};
 const duplicateJob=await submit({schema_version:'hub.v1',batch_id:randomUUID(),records:[duplicate]},'w2-rich-duplicate');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[duplicateJob])).rows[0].status).toBe('DUPLICATE');
 expect({epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(afterApply);
 const unchanged={...fresh,event_id:randomUUID(),source_version:'12345678901234567891',data:{...fresh.data,number:'SAME-CUSTOMER'}};
 const unchangedJob=await submit({schema_version:'hub.v1',batch_id:randomUUID(),records:[unchanged]},'w2-rich-same');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[unchangedJob])).rows[0].status).toBe('APPLIED');
 expect({epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(afterApply);
 expect(await recoveryStatus(q)).toMatchObject({state:'APPLIED',receipt:null});
 const back={...old,event_id:randomUUID(),source_version:'12345678901234567892'};
 const backJob=await submit({schema_version:'hub.v1',batch_id:randomUUID(),records:[back]},'w2-rich-ordinary-back');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[backJob])).rows[0].status).toBe('APPLIED');
 const afterBack={epochs:[{user_id:'new-sales',auth_epoch:'2'},{user_id:'owner',auth_epoch:'3'}],managers:[{user_id:'manager-disabled',auth_epoch:'0'},{user_id:'manager-one',auth_epoch:'2'},{user_id:'manager-other',auth_epoch:'0'},{user_id:'manager-two',auth_epoch:'2'}],audit:2};
 expect({epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual(afterBack);
 // Controlled fixture establishes two distinct customer UUIDs with identical effective sales/department scope.
 await context.fixture.pool.query(`UPDATE hub.canonical_customer SET owner_user_id='owner',dept_id='dept1' WHERE (tenant_id,id)=($1,$2)`,[tenant,order.ids[1]]);
 const sameScope={...fresh,event_id:randomUUID(),source_version:'12345678901234567893'};
 const sameScopeJob=await submit({schema_version:'hub.v1',batch_id:randomUUID(),records:[sameScope]},'w2-rich-same-scope');await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[sameScopeJob])).rows[0].status).toBe('APPLIED');
 expect({epochs:await epochs(),managers:await managers(),audit:await audits()}).toEqual({...afterBack,audit:3});
},60000);

async function outcome(job:string,src:string,own:string) {
 return (await context.fixture.pool.query(`SELECT j.status job_status,i.status item_status,i.error_code,i.attempts_started,i.retries_used,b.acknowledged_at IS NOT NULL acknowledged,
  (SELECT count(*)::int FROM hub.canonical_order WHERE tenant_id=$2 AND id=$4) orders,
  (SELECT count(*)::int FROM hub.canonical_order_line WHERE tenant_id=$2 AND order_id=$4) lines,
  (SELECT count(*)::int FROM control.source_version_receipt WHERE tenant_key=$2 AND source_id=$3 AND canonical_object_id=$4) receipts,
  (SELECT count(*)::int FROM control.canonical_apply_outbox WHERE tenant_key=$2 AND source_id=$3 AND canonical_object_id=$4) outboxes,
  (SELECT count(*)::int FROM control.canonical_identity_reference WHERE tenant_key=$2 AND source_id=$3 AND entity='order') refs
  FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_processing_outbox b ON b.job_id=j.id WHERE j.id=$1`,[job,tenant,src,own])).rows[0];
}

// Admit an ordinary older order on customer A after reserving the recovery UUID;
// the recovery then changes its reference to the confirmed customer B.
async function transitionCase(label:string,referencePk=`ref-${label}`) {
 const fixture=await observedOrderFixture(label,referencePk);
 const x={...fixture,...await acceptOrder(fixture,label,referencePk)};
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const sourcePk=`order-${referencePk}`;
 const body={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:sourcePk,source_version:'0',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:`sample-ref-${label}`},number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
 const accepted=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/order`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':`w2-transition-${label}`},payload:JSON.stringify(body)});
 expect(accepted.statusCode,accepted.body).toBe(202);await runDurableWorkerOnce(worker,{limit:1});
 const baseline=(await context.fixture.pool.query(`SELECT o.id::text,o.customer_id::text,i.status FROM hub.canonical_order o
  JOIN control.ingestion_job_item i ON i.job_id=$3 WHERE (o.tenant_id,o.id)=($1,$2)`,[tenant,x.own,accepted.json().data.job_id])).rows[0];
 expect(baseline).toEqual({id:x.own,customer_id:x.ids[0],status:'APPLIED'});
 return {...x,sourcePk};
}

it('derives the same typed key as the original Unicode and escaped customer tuple',async()=>{
 const referencePk='客戶-"\\-😀-é',x=await transitionCase('unicode',referencePk);
 expect(x.key(referencePk)).toBe('c:fHqK-mQW2TyFIgmoOhmxM2xY23zoVu_H15y26sJkMXU');
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 expect(await runDurableWorkerOnce(worker,{limit:1})).toBe(1);
 expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'APPLIED',error_code:null,orders:1,lines:1,receipts:1,outboxes:2,refs:1});
 const row=(await context.fixture.pool.query(`SELECT o.customer_id::text,r.external_id,r.target_id FROM hub.canonical_order o
  JOIN control.canonical_identity_reference r ON (r.tenant_key,r.source_id,r.entity,r.source_pk,r.kind)=($1,$3,'order',$4,'customer')
  WHERE (o.tenant_id,o.id)=($1,$2)`,[tenant,x.own,x.src,x.sourcePk])).rows[0];
 expect(row).toEqual({customer_id:x.ids[1],external_id:'c:fHqK-mQW2TyFIgmoOhmxM2xY23zoVu_H15y26sJkMXU',target_id:x.ids[1]});
},60000);

it('rejects a confirmed customer key that differs from the original tuple at the worker SQL boundary',async()=>{
 const label='key-mismatch',referencePk=`ref-${label}`;
 const x=await observedOrderFixture(label,referencePk);
 const correctKey=x.key(referencePk),alternateKey=x.key(`alternate-${label}`);
 expect(alternateKey).not.toBe(correctKey);
 const principal=await context.authenticator(context.token);
 await context.sourceService.writeIdentityMappings(principal,x.src,[
  {kind:'customer',external_id:x.key(`sample-ref-${label}`),target_id:x.ids[0]},
  {kind:'customer',external_id:correctKey,target_id:x.ids[1]},
  {kind:'customer',external_id:alternateKey,target_id:x.ids[1]},
 ]);
 const headers={authorization:`Bearer ${context.token}`};
 const sample={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:`sample-${label}`,
  source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:`sample-ref-${label}`},
   number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',
    product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
 const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/test`,headers,payload:{expected_revision:'1',samples:{order:JSON.stringify(sample)}}});
 expect(tested.statusCode,tested.body).toBe(202);expect(tested.json().data.status).toBe('PASS');
 const report=tested.json().data;
 const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
 expect(approved.statusCode,approved.body).toBe(200);
 const active=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}});
 expect(active.statusCode,active.body).toBe(200);
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${x.q}/import-recovery`,headers});
 expect(get.statusCode,get.body).toBe(200);expect(get.json().data.state).toBe('AVAILABLE');
 const state=get.json().data;
 const body:ImportRecoveryRequest={expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,
  identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,
  bindings:[{kind:'customer',source_id:source,source_pk:referencePk,target_id:x.ids[1]!}],reason:'confirmed'};
 const proofs=(await context.fixture.pool.query(`SELECT i.public_record AS record,original.mappings AS original_mappings,binding.mappings AS binding_mappings,
  (SELECT count(*)::int FROM control.source_identity_remap_fence f WHERE (f.tenant_key,f.source_id,f.kind,f.external_id)=($1,$2,'customer',$4)
   AND f.identity_mapping_revision>binding.revision) AS later_fences,
  (SELECT c.id::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
   WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk,s.canonical_object_id) = ($1,$5,'customer',$6,c.id) AND c.deleted_at IS NULL) AS live_target
  FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id
  JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(q.job_id,q.ordinal)
  JOIN control.source_identity_mapping_revision original ON (original.tenant_key,original.source_id,original.revision)=(j.tenant_key,j.source_id,j.identity_mapping_revision)
  JOIN control.source_registry r ON (r.tenant_key,r.source_id)=(q.tenant_key,q.source_id)
  JOIN control.source_identity_mapping_revision binding ON (binding.tenant_key,binding.source_id,binding.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
  WHERE q.quarantine_id=$3`,[tenant,x.src,x.q,alternateKey,source,referencePk])).rows[0];
 expect(proofs.record.data.customer_ref).toEqual({source_id:source,source_pk:referencePk});
 const selected=(entries:Array<{kind:string;external_id:string;target_id:string|null}>,key:string)=>entries.filter(e=>e.kind==='customer' && e.external_id===key);
 expect(selected(proofs.original_mappings,alternateKey)).toEqual([]);
 expect(selected(proofs.original_mappings,correctKey)).toEqual([]);
 expect(selected(proofs.binding_mappings,alternateKey)).toEqual([{kind:'customer',external_id:alternateKey,target_id:x.ids[1]}]);
 expect(selected(proofs.binding_mappings,correctKey)).toEqual([{kind:'customer',external_id:correctKey,target_id:x.ids[1]}]);
 expect(proofs.later_fences).toBe(0);expect(proofs.live_target).toBe(x.ids[1]);
 const sourcePk=`order-${referencePk}`;
 const effects=async(client:pg.PoolClient)=> (await client.query(`SELECT
  (SELECT count(*)::int FROM control.canonical_source_identity s JOIN hub.canonical_order o ON (o.tenant_id,o.id)=(s.tenant_key,s.order_id)
   WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'order',$3)) AS orders,
  (SELECT count(*)::int FROM control.canonical_source_identity s JOIN hub.canonical_order_line l ON (l.tenant_id,l.order_id)=(s.tenant_key,s.order_id)
   WHERE (s.tenant_key,s.source_id,s.entity,s.source_pk)=($1,$2,'order',$3)) AS lines,
  (SELECT count(*)::int FROM control.source_version_receipt WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order',$3)) AS receipts,
  (SELECT count(*)::int FROM control.canonical_apply_outbox WHERE (tenant_key,source_id,entity)=($1,$2,'order')) AS outboxes,
  (SELECT count(*)::int FROM control.canonical_identity_reference WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order',$3)) AS refs,
  (SELECT count(*)::int FROM control.canonical_ownership_audit WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order',$3)) AS audits,
  (SELECT jsonb_agg(jsonb_build_array(user_id,auth_epoch::text) ORDER BY user_id) FROM control.auth_subject WHERE tenant_key=$1) AS epochs`,[tenant,x.src,sourcePk])).rows[0];
 const snapshot=async()=>{const client=await context.fixture.pool.connect();try{return await effects(client);}finally{client.release();}};
 const before=await snapshot();expect(before).toMatchObject({orders:0,lines:0,receipts:0,outboxes:0,refs:0,audits:0});
 const origin=async()=> (await context.fixture.pool.query(`SELECT to_jsonb(q) AS quarantine,to_jsonb(j) AS job,to_jsonb(i) AS item
  FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id
  JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(q.job_id,q.ordinal) WHERE q.quarantine_id=$1`,[x.q])).rows[0];
 const originalState=await origin();
 let controlProofs:unknown;
 for(const [key,error] of [[correctKey,'IMPORT_RECOVERY_CONTEXT_INVALID'],[alternateKey,'IMPORT_RECOVERY_PROOF_INVALID']] as const) {
  const client=await context.fixture.pool.connect(),childId=randomUUID(),operationId=randomUUID(),claimToken=randomUUID();
  try {
   await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
   const actor=await context.authenticator(context.token);
   const plan=await readImportRecoveryBindingPlan(client,context.auth,actor,x.q,bindingInput(body));
   expect(plan.kind).toBe('ELIGIBLE');if(plan.kind!=='ELIGIBLE') throw new Error('FIXTURE_PLAN_UNAVAILABLE');
   expect(plan.confirmedBindings).toEqual([{kind:'customer',sourceId:source,sourcePk:referencePk,externalId:correctKey,targetId:x.ids[1]}]);
   const binding={...plan.confirmedBindings[0],externalId:key};
   const route=`/hub/v1/admin/quarantine/${x.q}/import-recovery`;
   await client.query(`SELECT control.admit_import_recovery($1,$2::uuid,$3,$4,$5,$6::bigint,$7,$8,$9,$10,$11::bigint,$12::bigint,$13,$14::jsonb,$15::uuid,$16::uuid)`,
    [tenant,x.q,actor.userId,actor.issuer,actor.subject,actor.authEpoch,`w2-${label}`,importRecoveryDigest(tenant,x.src,route,x.q,body),
     body.expected_state,body.reason,body.expected_source_revision,body.identity_mapping_revision,Buffer.from(body.identity_mapping_digest,'hex'),JSON.stringify([binding]),operationId,childId]);
   await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('RESET ROLE');
   await client.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[childId]);
   const item=(await client.query<{id:string}>(`UPDATE control.ingestion_job_item SET status='APPLYING',attempts_started=1,retries_used=0 WHERE job_id=$1 RETURNING operation_id::text AS id`,[childId])).rows[0]!;
   await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1`,[childId,claimToken]);
   expect(await effects(client)).toEqual(before);
   const controlledState=async()=> (await client.query(`SELECT to_jsonb(j) AS job,to_jsonb(i) AS item,to_jsonb(b) AS queue,to_jsonb(s) AS identity
    FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_processing_outbox b ON b.job_id=j.id
    JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=(j.tenant_key,j.source_id,j.entity,i.source_pk) WHERE j.id=$1`,[childId])).rows[0];
   const controlled=await controlledState();
   expect(controlled).toMatchObject({job:{status:'PROCESSING'},item:{status:'APPLYING',attempts_started:1},
    queue:{claim_token:claimToken,acknowledged_at:null},identity:{order_id:null}});
   await client.query('SET LOCAL ROLE hub_worker');
   const scope=[tenant,x.src,childId,0,item.id,claimToken];
   const envelope=(await client.query('SELECT control.read_import_recovery_worker_context($1,$2,$3,$4,$5,$6) AS value',scope)).rows[0].value;
   expect(envelope.entity).toBe('order');expect(envelope.confirmedBindings).toEqual([binding]);
   expect(envelope.original.publicRecord.data.customer_ref).toEqual({source_id:source,source_pk:referencePk});
   expect(envelope.bindingProof.identityMappingRevision).toBe(state.identity_mapping_revision);
   expect(envelope.original.proof.identityMappingRevision).not.toBe(envelope.bindingProof.identityMappingRevision);
   const actualProofs={original:envelope.original.proof,binding:envelope.bindingProof,observedFence:envelope.observedFence};
   if(key===correctKey) controlProofs=actualProofs;else expect(actualProofs).toEqual(controlProofs);
   await client.query('SAVEPOINT effect_check');
   await expect(client.query('SELECT control.record_import_recovery_order_customer_change($1,$2,$3,$4,$5,$6)',scope)).rejects.toMatchObject({message:error});
   await client.query('ROLLBACK TO SAVEPOINT effect_check');await client.query('RESET ROLE');
   expect(await effects(client)).toEqual(before);
   expect(await controlledState()).toEqual(controlled);
  } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
  expect(await snapshot()).toEqual(before);
  expect(await origin()).toEqual(originalState);
  expect((await context.fixture.pool.query('SELECT count(*)::int AS n FROM control.import_recovery_operation WHERE quarantine_id=$1',[x.q])).rows[0].n).toBe(0);
 }
},60000);

it('rolls back recovery when header or live-line channel metadata disagrees with the guarded job',async()=>{
 for(const [label,table,column] of [
  ['header-epoch','canonical_order','channel_epoch'],['header-domain','canonical_order','version_domain'],
  ['line-epoch','canonical_order_line','channel_epoch'],['line-domain','canonical_order_line','version_domain'],
 ] as const) {
  const x=await transitionCase(label);
  const snapshot=async()=> (await context.fixture.pool.query(`SELECT to_jsonb(o) header,
   (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.source_line_id) FROM hub.canonical_order_line l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id)) lines,
   (SELECT to_jsonb(r) FROM control.canonical_identity_reference r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk,r.kind)=($1,$3,'order',$4,'customer')) reference,
   (SELECT to_jsonb(r) FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$3,'order',$4)) receipt,
   (SELECT count(*)::int FROM control.canonical_apply_outbox a WHERE a.tenant_key=$1 AND a.source_id=$3 AND a.canonical_object_id=$2) outboxes,
   (SELECT count(*)::int FROM control.canonical_ownership_audit a WHERE a.tenant_key=$1 AND a.source_id=$3 AND a.source_pk=$4) audits,
   (SELECT jsonb_agg(jsonb_build_array(s.user_id,s.auth_epoch) ORDER BY s.user_id) FROM control.auth_subject s WHERE s.tenant_key=$1) epochs
   FROM hub.canonical_order o WHERE (o.tenant_id,o.id)=($1,$2)`,[tenant,x.own,x.src,x.sourcePk])).rows[0];
  const before=await snapshot();
  const assignment=column==='channel_epoch'?'NEW.channel_epoch:=NEW.channel_epoch+1':'NEW.version_domain:=\'SNAPSHOT_OBSERVATION\'';
  await context.fixture.pool.query(`CREATE FUNCTION public.w2_metadata_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${assignment}; RETURN NEW; END $$`);
  const objectColumn=table==='canonical_order'?'id':'order_id';
  await context.fixture.pool.query(`CREATE TRIGGER w2_metadata_fault BEFORE INSERT OR UPDATE ON hub.${table}
   FOR EACH ROW WHEN (NEW.${objectColumn}='${x.own}'::uuid) EXECUTE FUNCTION public.w2_metadata_fault()`);
  let observedError:unknown;
  try {
   await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
   expect(await runDurableWorkerOnce(worker,{limit:1,hooks:{onApplyError:async error=>{observedError=error;}}})).toBe(1);
  } finally {
   await context.fixture.pool.query(`DROP TRIGGER w2_metadata_fault ON hub.${table}`);
   await context.fixture.pool.query('DROP FUNCTION public.w2_metadata_fault()');
  }
  expect(observedError).toMatchObject({message:'IMPORT_RECOVERY_CONTEXT_INVALID'});
  expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'QUARANTINED',error_code:'IMPORT_RECOVERY_CONTEXT_INVALID',orders:1,lines:1,receipts:1,outboxes:1,refs:1});
  expect(await snapshot()).toEqual(before);
 }
},120000);

it('rolls back a real order-line SQL fault and retries the complete aggregate once',async()=>{
 const x=await createCase('line-fault');
 // The fixture-owned trigger raises in PostgreSQL while the real worker inserts the selected line.
 await context.fixture.pool.query(`CREATE FUNCTION public.w2_line_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'W2_LINE_FAULT'; END $$`);
 await context.fixture.pool.query(`CREATE TRIGGER w2_line_fault BEFORE INSERT ON hub.canonical_order_line FOR EACH ROW WHEN (NEW.order_id='${x.own}'::uuid) EXECUTE FUNCTION public.w2_line_fault()`);
 try {
  await runDurableWorkerOnce(worker);
  expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'PROCESSING',item_status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE',attempts_started:1,retries_used:0,acknowledged:false,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
  expect(await recoveryStatus(x.q)).toMatchObject({state:'ACCEPTED',receipt:null});
 } finally {
  await context.fixture.pool.query('DROP TRIGGER w2_line_fault ON hub.canonical_order_line');
  await context.fixture.pool.query('DROP FUNCTION public.w2_line_fault()');
 }
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'SUCCEEDED',item_status:'APPLIED',error_code:null,attempts_started:2,retries_used:1,acknowledged:true,orders:1,lines:1,receipts:1,outboxes:1,refs:1});
 expect(await recoveryStatus(x.q)).toMatchObject({state:'APPLIED',receipt:{canonical_object_id:x.own,source_version:'1'}});
},60000);

it('rejects a deleted foreign customer and a post-acceptance mapping remap before effects',async()=>{
 const deleted=await createCase('deleted');
 await context.fixture.pool.query('UPDATE hub.canonical_customer SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[tenant,deleted.ids[1]]);
 await runDurableWorkerOnce(worker);
 expect(await outcome(deleted.job,deleted.src,deleted.own)).toEqual({job_status:'FAILED',item_status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID',attempts_started:1,retries_used:0,acknowledged:true,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
 expect(await recoveryStatus(deleted.q)).toMatchObject({state:'QUARANTINED',receipt:null});
 const remap=await createCase('remap');
 const headers={authorization:`Bearer ${context.token}`};
 const candidate=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${remap.src}&kind=customer&external_id=${encodeURIComponent(remap.key('ref-remap'))}`,headers});
 expect(candidate.statusCode,candidate.body).toBe(200);
 const changed=await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'2',target_id:remap.ids[0],reason:'remapped'}});
 expect(changed.statusCode,changed.body).toBe(200);await runDurableWorkerOnce(worker);
 expect(await outcome(remap.job,remap.src,remap.own)).toEqual({job_status:'FAILED',item_status:'QUARANTINED',error_code:'AUTHORITY_MAPPING_SUPERSEDED',attempts_started:1,retries_used:0,acknowledged:true,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
 expect(await recoveryStatus(remap.q)).toMatchObject({state:'QUARANTINED',receipt:null});
},60000);

it('rejects a live same-name customer when the exact foreign source tuple no longer names the approved UUID',async()=>{
 const x=await createCase('wrong-tuple');
 // Controlled privileged corruption changes only the foreign identity after acceptance; both customers are live and named Existing.
 await context.fixture.pool.query(`UPDATE control.canonical_source_identity SET canonical_object_id=$4,customer_id=$4
  WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'customer',$3)`,[tenant,source,'ref-wrong-tuple',x.ids[0]]);
 await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'FAILED',item_status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID',attempts_started:1,retries_used:0,acknowledged:true,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
 expect(await recoveryStatus(x.q)).toMatchObject({state:'QUARANTINED',receipt:null});
},60000);

it('cannot apply or acknowledge an order after its claim token is replaced',async()=>{
 const x=await createCase('lost-token');
 const replacement=randomUUID();
 await runDurableWorkerOnce(worker,{hooks:{afterClaim:async claim=>{
  expect(claim.jobId).toBe(x.job);
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1`,[x.job,replacement]);
 }}});
 expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'PROCESSING',item_status:'RECEIVED',error_code:null,attempts_started:0,retries_used:0,acknowledged:false,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
 const current=(await context.fixture.pool.query<{token:string}>('SELECT claim_token::text token FROM control.ingestion_processing_outbox WHERE job_id=$1',[x.job])).rows[0];expect(current!.token).toBe(replacement);
 // Fixture release does not fabricate item or ACK state; the next real claimant owns the retry.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'APPLIED',attempts_started:1,acknowledged:true,orders:1,lines:1,receipts:1,outboxes:1,refs:1});
},60000);

it('fails closed on an existing order with a missing old customer reference',async()=>{
 const label='missing-old',x=await createCase(label);
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const body={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:'order-ref-missing-old',source_version:'0',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:'sample-ref-missing-old'},number:'BEFORE',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
 const old=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/order`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':'w2-missing-old-ordinary'},payload:JSON.stringify(body)});expect(old.statusCode,old.body).toBe(202);await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[old.json().data.job_id])).rows[0].status).toBe('APPLIED');
 const previous=(await context.fixture.pool.query(`SELECT customer_id::text,order_no,source_version::text FROM hub.canonical_order WHERE tenant_id=$1 AND id=$2`,[tenant,x.own])).rows[0];
 const reference=(await context.fixture.pool.query(`DELETE FROM control.canonical_identity_reference WHERE (tenant_key,source_id,entity,source_pk,kind)=($1,$2,'order','order-ref-missing-old','customer') RETURNING external_id,target_id`,[tenant,x.src])).rows[0];
 expect(reference).toEqual({external_id:x.key('sample-ref-missing-old'),target_id:x.ids[0]});
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'RETRY_PENDING',error_code:'WORKER_TRANSIENT_FAILURE',orders:1,lines:1,receipts:1,outboxes:1,refs:0,acknowledged:false});
 expect((await context.fixture.pool.query(`SELECT customer_id::text,order_no,source_version::text FROM hub.canonical_order WHERE tenant_id=$1 AND id=$2`,[tenant,x.own])).rows[0]).toEqual(previous);
 await context.fixture.pool.query(`INSERT INTO control.canonical_identity_reference(tenant_key,source_id,entity,source_pk,kind,external_id,target_id) VALUES($1,$2,'order','order-ref-missing-old','customer',$3,$4)`,[tenant,x.src,reference.external_id,reference.target_id]);
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1`,[x.job]);await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'APPLIED',attempts_started:2,acknowledged:true,orders:1,lines:1,receipts:1,outboxes:2,refs:1});
},60000);

it('rolls back an order whose lease expires after canonical work and later reclaims it',async()=>{
 const x=await createCase('expired');
 await runDurableWorkerOnce(worker,{leaseMs:200,hooks:{beforeItemCommit:async()=>{await new Promise(resolve=>setTimeout(resolve,300));}}});
 expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'PROCESSING',item_status:'APPLYING',error_code:null,attempts_started:1,retries_used:0,acknowledged:false,orders:0,lines:0,receipts:0,outboxes:0,refs:0});
 expect(await recoveryStatus(x.q)).toMatchObject({state:'ACCEPTED',receipt:null});
 await context.fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker);
 expect(await outcome(x.job,x.src,x.own)).toEqual({job_status:'SUCCEEDED',item_status:'APPLIED',error_code:null,attempts_started:2,retries_used:1,acknowledged:true,orders:1,lines:1,receipts:1,outboxes:1,refs:1});
},60000);

it('keeps the reservation and version outcomes when an ordinary order arrives after admission',async()=>{
 for(const [label,version,number,want,outboxes] of [
  ['older','0','O1','APPLIED',2],['equal','1','O1','DUPLICATE',1],['conflict','1','DIFFERENT','QUARANTINED',1],['newer','2','O1','IGNORED_STALE',1],
 ] as const) {
  const x=await createCase(label);
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
  const body={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:`order-ref-${label}`,source_version:version,operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:`ref-${label}`},number,state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
  const response=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/order`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':`w2-ordinary-${label}`},payload:JSON.stringify(body)});
  expect(response.statusCode,response.body).toBe(202);await runDurableWorkerOnce(worker);
  const ordinary=(await context.fixture.pool.query(`SELECT i.status,s.canonical_object_id::text FROM control.ingestion_job_item i JOIN control.canonical_source_identity s ON (s.tenant_key,s.source_id,s.entity,s.source_pk)=($2,$3,'order',i.source_pk) WHERE i.job_id=$1`,[response.json().data.job_id,tenant,x.src])).rows[0];
  expect(ordinary).toEqual({status:'APPLIED',canonical_object_id:x.own});
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);await runDurableWorkerOnce(worker);
  const actual=await outcome(x.job,x.src,x.own);
  expect(actual).toMatchObject({item_status:want,error_code:want==='QUARANTINED'?'SOURCE_VERSION_CONFLICT':null,attempts_started:1,acknowledged:true,orders:1,lines:1,receipts:1,outboxes,refs:1});
  const state=await recoveryStatus(x.q);expect(state.state).toBe(want);expect(state.receipt).toEqual(want==='APPLIED'?expect.objectContaining({canonical_object_id:x.own,source_version:'1'}):null);
 }
},120000);

it('checks a newer remap and deleted target before an equal-version duplicate shortcut',async()=>{
 for(const kind of ['remap','deleted'] as const) {
  const label=`equal-${kind}`,x=await createCase(label);
  await context.auth.repository.provisionSubject({tenantId:tenant,userId:`w2-${kind}-a`,departmentId:'dept1',businessRole:'sales'});
  await context.auth.repository.provisionSubject({tenantId:tenant,userId:`w2-${kind}-b`,departmentId:'dept1',businessRole:'sales'});
  await context.fixture.pool.query(`UPDATE hub.canonical_customer SET owner_user_id=CASE WHEN id=$2::uuid THEN $4 ELSE $5 END WHERE tenant_id=$1 AND id=ANY($3::uuid[])`,[tenant,x.ids[0],x.ids,`w2-${kind}-a`,`w2-${kind}-b`]);
  await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
  const body={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:`order-ref-${label}`,source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:`ref-${label}`},number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
  const admitted=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/order`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':`w2-equal-${kind}`},payload:JSON.stringify(body)});
  expect(admitted.statusCode,admitted.body).toBe(202);await runDurableWorkerOnce(worker);
  expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[admitted.json().data.job_id])).rows[0].status).toBe('APPLIED');
  if(kind==='deleted') await context.fixture.pool.query('UPDATE hub.canonical_customer SET deleted_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[tenant,x.ids[1]]);
  else {
   const headers={authorization:`Bearer ${context.token}`};const candidate=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${x.src}&kind=customer&external_id=${encodeURIComponent(x.key(`ref-${label}`))}`,headers});expect(candidate.statusCode).toBe(200);
   const changed=await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'2',target_id:x.ids[0],reason:'remapped'}});expect(changed.statusCode,changed.body).toBe(200);
  }
  const snapshot=async()=> (await context.fixture.pool.query(`SELECT to_jsonb(o) AS order_row,
   (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.source_line_id) FROM hub.canonical_order_line l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id)) lines,
   (SELECT to_jsonb(r) FROM control.source_version_receipt r WHERE (r.tenant_key,r.source_id,r.entity,r.source_pk)=($1,$2,'order',$4)) receipt,
   (SELECT count(*)::int FROM control.canonical_apply_outbox a WHERE a.tenant_key=$1 AND a.source_id=$2 AND a.canonical_object_id=$3) outboxes
   FROM hub.canonical_order o WHERE (o.tenant_id,o.id)=($1,$3)`,[tenant,x.src,x.own,`order-ref-${label}`])).rows[0];
  const before=await snapshot();await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);await runDurableWorkerOnce(worker);
  expect(await snapshot()).toEqual(before);
  expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'QUARANTINED',error_code:kind==='remap'?'AUTHORITY_MAPPING_SUPERSEDED':'IDENTITY_MAPPING_TARGET_INVALID',acknowledged:true});
  expect(await recoveryStatus(x.q)).toMatchObject({state:'QUARANTINED',receipt:null});
 }
},120000);

it('denies forged order targets and artifacts to the real worker role',async()=>{
 const x=await createCase('forgery');
 const acl=(await context.fixture.pool.query(`SELECT
  has_function_privilege('hub_worker','control.record_import_recovery_order_customer_change(text,text,uuid,integer,uuid,uuid)','EXECUTE') recovery_worker,
  has_function_privilege('hub_api','control.record_import_recovery_order_customer_change(text,text,uuid,integer,uuid,uuid)','EXECUTE') recovery_api,
  has_function_privilege('hub_worker','control.record_canonical_order_customer_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,text)','EXECUTE') ordinary_worker,
  has_function_privilege('hub_api','control.record_canonical_order_customer_change(text,text,text,uuid,uuid,bigint,text,bigint,uuid,uuid,bigint,text)','EXECUTE') ordinary_api,
  has_function_privilege('hub_worker','control.canonical_order_customer_effects_internal(text,text,text,uuid,text,text,uuid,bigint)','EXECUTE') private_worker`)).rows[0];
 expect(acl).toEqual({recovery_worker:true,recovery_api:false,ordinary_worker:true,ordinary_api:false,private_worker:false});
 // Schedule an actual ordinary v0 after the reservation to supply a committed old reference.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp()+interval '1 day' WHERE job_id=$1`,[x.job]);
 const body={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:'order-ref-forgery',source_version:'0',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:'ref-forgery'},number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
 const accepted=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${x.src}/import/order`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':'w2-forgery-ordinary'},payload:JSON.stringify(body)});expect(accepted.statusCode,accepted.body).toBe(202);
 const ordinaryJob=accepted.json().data.job_id as string;await runDurableWorkerOnce(worker);
 expect((await context.fixture.pool.query('SELECT status FROM control.ingestion_job_item WHERE job_id=$1',[ordinaryJob])).rows[0].status).toBe('APPLIED');
 const client=await context.fixture.pool.connect(),token=randomUUID();
 try {
  await client.query('BEGIN');
  await client.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[x.job]);
  const item=(await client.query<{id:string}>(`UPDATE control.ingestion_job_item SET status='APPLYING',attempts_started=1,retries_used=0 WHERE job_id=$1 RETURNING operation_id::text id`,[x.job])).rows[0]!;
  await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE job_id=$1`,[x.job,token]);
  // Privileged rollback-only fixture forges the wrong customer plus matching current-XID receipt/outbox.
  const revision=(await client.query<{revision:string}>(`UPDATE hub.canonical_order SET customer_id=$3,source_version=1,hub_revision=nextval('control.canonical_hub_revision_seq') WHERE tenant_id=$1 AND id=$2 RETURNING hub_revision::text revision`,[tenant,x.own,x.ids[0]])).rows[0]!.revision;
  await client.query('UPDATE hub.canonical_order_line SET source_version=1 WHERE tenant_id=$1 AND order_id=$2',[tenant,x.own]);
  await client.query(`UPDATE control.source_version_receipt SET source_version=1,projection_digest=control.canonical_projection_digest(source_content_digest,canonical_object_id,jsonb_build_object('customer_id',$4::text))
   WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order',$3)`,[tenant,x.src,'order-ref-forgery',x.ids[0]]);
  await client.query(`INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
   SELECT tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,canonical_object_id,$4,'UPSERT',projection_digest,source_content_digest FROM control.source_version_receipt
   WHERE (tenant_key,source_id,entity,source_pk)=($1,$2,'order',$3)`,[tenant,x.src,'order-ref-forgery',revision]);
  await client.query('SET LOCAL ROLE hub_worker');
  const scope=[tenant,x.src,x.job,0,item.id,token];
  expect((await client.query('SELECT control.read_import_recovery_worker_context($1,$2,$3,$4,$5,$6) AS value',scope)).rows[0].value.entity).toBe('order');
  await client.query('SAVEPOINT deny_forgery');
  await expect(client.query('SELECT control.record_import_recovery_order_customer_change($1,$2,$3,$4,$5,$6)',scope)).rejects.toMatchObject({message:'IMPORT_RECOVERY_CONTEXT_INVALID'});
  await client.query('ROLLBACK TO SAVEPOINT deny_forgery');
  const proof=(await client.query(`SELECT credential_id::text,channel_id::text,channel_epoch::text,version_domain,security_barrier_fence_at_admission::text,
   owner_approval_id::text,test_report_id::text,identity_mapping_revision::text FROM control.ingestion_job WHERE id=$1`,[ordinaryJob])).rows[0];
  await client.query('SAVEPOINT deny_ordinary');
  // The selected proof maps the recovered key to customer B, while the forged projection is customer A.
  await expect(client.query('SELECT control.record_canonical_order_customer_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
   [tenant,x.src,'order-ref-forgery',proof.credential_id,proof.channel_id,proof.channel_epoch,proof.version_domain,proof.security_barrier_fence_at_admission,proof.owner_approval_id,proof.test_report_id,proof.identity_mapping_revision,x.key('ref-forgery')])).rejects.toMatchObject({code:'42501'});
  await client.query('ROLLBACK TO SAVEPOINT deny_ordinary');
  await client.query('SAVEPOINT deny_private');
  await expect(client.query('SELECT control.canonical_order_customer_effects_internal($1,$2,$3,$4,$5,$6,$7,$8)',[tenant,x.src,'order-ref-forgery',proof.channel_id,'owner',x.key('ref-forgery'),x.ids[0],proof.identity_mapping_revision])).rejects.toMatchObject({code:'42501'});
  await client.query('ROLLBACK TO SAVEPOINT deny_private');
  await client.query('SET LOCAL ROLE postgres');
  expect((await client.query(`SELECT count(*)::int n FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$2`,[tenant,x.src])).rows[0].n).toBe(0);
 } finally {await client.query('ROLLBACK').catch(()=>undefined);client.release();}
 // Release the original child normally; the forged canonical writes were rolled back.
 await context.fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[x.job]);
 await runDurableWorkerOnce(worker);expect(await outcome(x.job,x.src,x.own)).toMatchObject({item_status:'APPLIED',orders:1,lines:1,receipts:1,outboxes:2,refs:1});
},60000);
