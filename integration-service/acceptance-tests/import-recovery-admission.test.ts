import Fastify from 'fastify';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../migrations/runner.js';
import type { ExternalBinding, ImportRecoveryRequest } from '../ingestion-api/import-recovery-contract.js';
import type { ApplyContext } from '../normalization/apply.js';
import type { canonicalCustomerInput } from '../normalization/durable-record.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres } from './helpers/postgres.js';
import { setupImportRecoveryFixture, setupOrderRecoveryFixture, sample, source, tenant } from './helpers/import-recovery-fixture.js';

let context: Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let orderFixture:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>;
let barrierFixture:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>,unsupportedFixture:Awaited<ReturnType<typeof setupOrderRecoveryFixture>>;
let partialBody:ImportRecoveryRequest,partialAccepted:{operation_id:string;child_job_id:string;status:'ACCEPTED'};
let canonicalRace:{id:string;childId:string;applyContext:ApplyContext;input:ReturnType<typeof canonicalCustomerInput>};
let ordinaryCustomerJob:string,ordinaryOrderJob:string;
let unicodeReasonId:string,unicodeExternalId:string,unicodeActorId:string;
const api=Fastify({logger:false,requestIdHeader:false});

beforeAll(async()=>{
 context=await setupImportRecoveryFixture('schema');
 const migration=fileURLToPath(new URL('../migrations/015_import_recovery_schema.sql',import.meta.url));
 await copyFile(migration,join(context.migrationDirectory,'015_import_recovery_schema.sql'));
 expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['015_import_recovery_schema']);
 const admission=fileURLToPath(new URL('../migrations/016_import_recovery_admission.sql',import.meta.url));
 await copyFile(admission,join(context.migrationDirectory,'016_import_recovery_admission.sql'));
 expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['016_import_recovery_admission']);
 const repeat=await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});
 expect(repeat.applied).toEqual([]);expect(repeat.skipped.at(-1)).toBe('016_import_recovery_admission');
 const fresh=await startOwnedPostgres({evidenceRoot:join(fixtureEvidenceRootFromEnvironment()!,'i3a1-fresh',randomUUID()),evidenceFile:'unused',taskLabel:'m1task1'});
 try {
  const applied=await runMigrations(fresh.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});
  expect(applied.applied).toHaveLength(16);expect(applied.applied.at(-1)).toBe('016_import_recovery_admission');
  const again=await runMigrations(fresh.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});expect(again.applied).toEqual([]);expect(again.skipped).toHaveLength(16);
 } finally {await fresh.close();}
 const headers={authorization:`Bearer ${context.token}`};
 // Create these original quarantines before confirming the missing identities; no recovery child exists yet.
 const unicode=structuredClone(sample);unicode.batch_id=randomUUID();unicode.records[0]!.event_id=randomUUID();
 unicode.records[0]!.source_pk='unicode-reason-origin';unicode.records[0]!.data.rep='rep-missing';
 unicode.records.push({...structuredClone(unicode.records[0]!),event_id:randomUUID(),source_pk:'unicode-external-origin',data:{...unicode.records[0]!.data,rep:'rep\u0085x'}});
 unicode.records.push({...structuredClone(unicode.records[0]!),event_id:randomUUID(),source_pk:'unicode-actor-origin'});
 const admitted=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'unicode-original'},payload:JSON.stringify(unicode)});
 expect(admitted.statusCode,admitted.body).toBe(202);
 const unicodeWorker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${context.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {const {runDurableWorkerOnce}=await import('../etl-worker/worker.js');await runDurableWorkerOnce(unicodeWorker);} finally {await unicodeWorker.end();}
 const unicodeRows=await context.fixture.pool.query<{id:string;error_code:string}>(`SELECT quarantine_id::text AS id,error_code FROM control.ingestion_quarantine_index WHERE job_id=$1 ORDER BY ordinal`,[admitted.json().data.job_id]);
 expect(unicodeRows.rows.map(x=>x.error_code)).toEqual(['IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_REQUIRED']);
 unicodeReasonId=unicodeRows.rows[0]!.id;unicodeExternalId=unicodeRows.rows[1]!.id;unicodeActorId=unicodeRows.rows[2]!.id;
 for(const [kind,external,target,revision] of [['user','rep-missing','owner','2'],['department','team-missing','dept1','3'],['user','rep\u0085x','owner','4']]) {
  const found=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${encodeURIComponent(external!)}`,headers});
  expect(found.statusCode).toBe(200);
  expect((await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${found.json().data.id}`,headers,payload:{expected_revision:revision,target_id:target,reason:'confirmed'}})).statusCode).toBe(200);
 }
 const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});
 expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
 expect(approved.statusCode).toBe(200);
 expect((await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
 // No recovery children exist yet: this worker run only constructs the ordinary order origin.
 orderFixture=await setupOrderRecoveryFixture(context,'admission','admission-order-ref');
 barrierFixture=await setupOrderRecoveryFixture(context,'barrier','barrier-order-ref');
 unsupportedFixture=await setupOrderRecoveryFixture(context,'unsupported','unsupported-order-ref',true);
 const customer=structuredClone(sample);customer.batch_id=randomUUID();customer.records[0]!.event_id=randomUUID();customer.records[0]!.source_pk='ordinary-compat-customer';
 const customerResponse=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'ordinary-compat-customer'},payload:JSON.stringify(customer)});
 expect(customerResponse.statusCode,customerResponse.body).toBe(202);ordinaryCustomerJob=customerResponse.json().data.job_id;
 const order={schema_version:'hub.v1',batch_id:randomUUID(),records:[{event_id:randomUUID(),source_pk:'ordinary-compat-order',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T08:00:00+08:00',data:{buyer:{source_id:source,source_pk:'admission-order-ref'},number:'ORDER-COMPAT',state:'CONFIRMED',at:'2026-10-29T08:00:00+08:00',total:'12.00',ccy:'CNY',lines:[{source_line_id:'line',product_code:'p',product_name:'P',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]};
 const orderResponse=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${orderFixture.src}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'ordinary-compat-order'},payload:JSON.stringify(order)});
 expect(orderResponse.statusCode,orderResponse.body).toBe(202);ordinaryOrderJob=orderResponse.json().data.job_id;
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${context.fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {const {runDurableWorkerOnce}=await import('../etl-worker/worker.js');await runDurableWorkerOnce(worker);}
 finally {await worker.end();}
 const {registerImportRecoveryRoutes}=await import('../ingestion-api/import-recovery-routes.js');
 const rolePool=new Proxy(context.fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 await registerImportRecoveryRoutes(api,{pool:rolePool,authService:context.auth,authenticator:context.authenticator});
},120000);
afterAll(async()=>{
 await api.close();
 if(context){await context.app.close();await new Promise<void>(resolve=>context.jwks.close(()=>resolve()));await context.fixture.close();}
});

it('preserves actual ordinary customer and order worker conversion and application',async()=>{
 const states=(await context.fixture.pool.query(`SELECT job_id::text,status FROM control.ingestion_job_item WHERE job_id=ANY($1::uuid[]) ORDER BY job_id`,[[ordinaryCustomerJob,ordinaryOrderJob]])).rows;
 expect(states).toHaveLength(2);expect(states.map(row=>row.status)).toEqual(['APPLIED','APPLIED']);
 const customer=(await context.fixture.pool.query(`SELECT c.customer_name,c.owner_user_id,c.dept_id FROM hub.canonical_customer c JOIN control.canonical_source_identity i ON (i.tenant_key,i.customer_id)=(c.tenant_id,c.id) WHERE i.tenant_key=$1 AND i.source_id=$2 AND i.source_pk='ordinary-compat-customer'`,[tenant,source])).rows[0];
 expect(customer).toEqual({customer_name:'Acme',owner_user_id:'owner',dept_id:'dept1'});
 const order=(await context.fixture.pool.query(`SELECT o.order_no,o.amount::text,o.customer_id::text FROM hub.canonical_order o JOIN control.canonical_source_identity i ON (i.tenant_key,i.order_id)=(o.tenant_id,o.id) WHERE i.tenant_key=$1 AND i.source_id=$2 AND i.source_pk='ordinary-compat-order'`,[tenant,orderFixture.src])).rows[0];
 expect(order).toMatchObject({order_no:'ORDER-COMPAT',amount:'12.00',customer_id:orderFixture.ids[1]});
});

it('exposes the bounded candidate through an isolated authenticated HTTP registrar',async()=>{
 const response=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${context.partialId}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(response.statusCode).toBe(200);
 expect(response.json().data).toMatchObject({state:'AVAILABLE',expected_source_revision:'1',missing:[{kind:'department',external_id:'team-missing'}]});
 expect(JSON.stringify(response.json())).not.toContain('publicRecord');
});

async function requestFor(id:string,bindings:ExternalBinding[]):Promise<ImportRecoveryRequest> {
 const result=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(result.statusCode).toBe(200);const state=result.json().data;
 return {expected_state:state.expected_state,expected_source_revision:state.expected_source_revision,
  identity_mapping_revision:state.identity_mapping_revision,identity_mapping_digest:state.identity_mapping_digest,bindings,reason:'confirmed missing identity'};
}
function post(id:string,key:string,payload:unknown) {
 return api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':key},payload:JSON.stringify(payload)});
}

async function verifyUnicodeAdmission(id:string,key:string,externalId:string,reason:string,token=context.token,subject='owner') {
 const original=async()=>(await context.fixture.pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(i) AS item,to_jsonb(q) AS quarantine,to_jsonb(r) AS raw
  FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(q.job_id,q.ordinal)
  JOIN raw.ingestion_batch r ON r.id=j.raw_batch_id WHERE q.quarantine_id=$1`,[id])).rows[0];
 const before=await original(),body=await requestFor(id,[{kind:'user',external_id:externalId,target_id:'owner'}]);
 expect(before.item.public_record.data.owner_external_id).toBe(externalId);
 const submit=(payload:unknown)=>api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},payload:JSON.stringify(payload)});
 const response=await submit({...body,reason:`  ${reason}  `});expect(response.statusCode,response.body).toBe(202);
 const accepted=response.json().data;
 const stored=(await context.fixture.pool.query(`SELECT o.reason,o.confirmed_bindings,o.actor_subject,o.actor_issuer,o.binding_approval_id::text,j.owner_approval_id::text AS original_approval,
  ci.public_record=oi.public_record AS same_record,j.raw_batch_id=oj.raw_batch_id AS same_raw,j.request_digest=oj.request_digest AS same_digest,
  (j.credential_id,j.source_epoch_at_admission,j.credential_revision_at_admission,j.credential_generation_at_admission,j.channel_id,j.channel_epoch,
   j.owner_approval_id,j.owner_user_id,j.owner_revision,j.approval_security_fence,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,
   j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.security_barrier_fence_at_admission)
   IS NOT DISTINCT FROM
  (oj.credential_id,oj.source_epoch_at_admission,oj.credential_revision_at_admission,oj.credential_generation_at_admission,oj.channel_id,oj.channel_epoch,
   oj.owner_approval_id,oj.owner_user_id,oj.owner_revision,oj.approval_security_fence,oj.config_revision,oj.config_digest,oj.mapping_revision,oj.mapping_digest,
   oj.identity_mapping_revision,oj.identity_mapping_digest,oj.endpoint_profile_digest,oj.test_report_id,oj.security_barrier_fence_at_admission) AS same_proof
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id JOIN control.ingestion_job oj ON oj.id=o.original_job_id
  JOIN control.ingestion_job_item ci ON (ci.job_id,ci.ordinal)=(j.id,0) JOIN control.ingestion_job_item oi ON (oi.job_id,oi.ordinal)=(oj.id,o.original_ordinal)
  WHERE o.operation_id=$1`,[accepted.operation_id])).rows[0];
 expect(stored).toMatchObject({reason,confirmed_bindings:[{kind:'user',externalId,targetId:'owner'}],actor_subject:subject,actor_issuer:context.principal.issuer,same_record:true,same_raw:true,same_digest:true,same_proof:true});
 expect(stored.binding_approval_id).not.toBe(stored.original_approval);expect(await original()).toEqual(before);
 const replay=await submit({...body,reason:`\t${reason}\n`});expect(replay.statusCode,replay.body).toBe(202);expect(replay.json().data).toEqual(accepted);
 expect((await context.fixture.pool.query('SELECT count(*)::int AS n FROM control.import_recovery_operation WHERE quarantine_id=$1',[id])).rows[0].n).toBe(1);
}

it('accepts and semantically replays a reason with U+0085 at its trimmed edge',async()=>{
 await verifyUnicodeAdmission(unicodeReasonId,'reason-edge','rep-missing','\u0085x');
});

it('accepts and semantically replays an original external identifier containing U+0085',async()=>{
 await verifyUnicodeAdmission(unicodeExternalId,'external-c1','rep\u0085x','approved');
});

it('retains a bound OIDC subject containing U+0085 and longer than 256 characters',async()=>{
 const subject=`${'s'.repeat(257)}\u0085x`;
 await context.auth.repository.bindIdentity({issuer:context.principal.issuer,subject,tenantId:tenant,userId:'owner'});
 await verifyUnicodeAdmission(unicodeActorId,'actor-c1','rep-missing','approved',await context.issueToken(subject),subject);
});

it('keeps the database Unicode predicates aligned with explicit ECMAScript edges and C0/DEL',async()=>{
 const spaces=[...Array.from({length:5},(_,i)=>i+9),0x20,0xa0,0x1680,...Array.from({length:11},(_,i)=>i+0x2000),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff];
 const samples=[...spaces.flatMap(cp=>[`${String.fromCodePoint(cp)}x`,`x${String.fromCodePoint(cp)}`]),
  ...Array.from({length:31},(_,i)=>`x${String.fromCodePoint(i+1)}y`),'x\u007fy','\u0085x','x\u0085','x\u0085y','\u180ex','x\u200by','🙂'];
 const rows=(await context.fixture.pool.query<{value:string;trimmed:boolean;has_control:boolean}>(`SELECT value,control.import_recovery_is_js_trimmed(value) AS trimmed,
  control.import_recovery_has_c0_del(value) AS has_control FROM unnest($1::text[]) AS s(value)`,[samples])).rows;
 for(const row of rows) {expect(row.trimmed,row.value).toBe(row.value===row.value.trim());expect(row.has_control,row.value).toBe(/[\u0000-\u001f\u007f]/.test(row.value));}
 const acl=(await context.fixture.pool.query<{proname:string;proconfig:string[];prosecdef:boolean;privileges:boolean[]}>(`SELECT p.proname,p.proconfig,p.prosecdef,
  ARRAY[has_function_privilege('hub_api',p.oid,'EXECUTE'),has_function_privilege('hub_worker',p.oid,'EXECUTE'),
   has_function_privilege('hub_mcp',p.oid,'EXECUTE'),has_function_privilege('hub_publisher',p.oid,'EXECUTE'),has_function_privilege('hub_hasura_read',p.oid,'EXECUTE')] AS privileges
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,[['check_import_recovery_cycle','import_recovery_has_c0_del','import_recovery_is_js_trimmed']])).rows;
 expect(acl).toHaveLength(3);
 for(const row of acl) {expect(row.proconfig).toEqual(['search_path=pg_catalog']);expect(row.privileges).toEqual([false,false,false,false,false]);expect(row.prosecdef).toBe(row.proname==='check_import_recovery_cycle');}
});
async function ensurePartialAccepted() {
 if(partialAccepted) return;
 const id=context.partialId,own=randomUUID();
 await context.fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id) VALUES($1,$2,'customer','partial',$3)`,[tenant,source,own]);
 const original=async()=>(await context.fixture.pool.query(`SELECT to_jsonb(j) AS job,to_jsonb(i) AS item,to_jsonb(q) AS quarantine,to_jsonb(r) AS raw
  FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(q.job_id,q.ordinal)
  JOIN raw.ingestion_batch r ON r.id=j.raw_batch_id WHERE q.quarantine_id=$1`,[id])).rows[0];
 const before=await original();expect(before.quarantine.ordinal).toBe(1);
 const body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const currentOwner=await context.authenticator(context.token);
 const response=await post(id,'partial-recovery',body);expect(response.statusCode,response.body).toBe(202);
 const accepted=response.json().data;partialBody=body;partialAccepted=accepted;expect(accepted).toMatchObject({status:'ACCEPTED',operation_id:expect.any(String),child_job_id:expect.any(String)});
 const rows=await context.fixture.pool.query(`SELECT o.reserved_object_id::text,o.original_ordinal,o.actor_user_id,o.actor_issuer,o.actor_subject,o.actor_auth_epoch::text,
  o.binding_approval_id::text,j.owner_approval_id::text AS original_approval,j.raw_batch_id::text,j.request_digest=i0.request_digest AS digest_same,
  i.operation_id::text AS item_operation,i.status,i.public_record=i0.record AS record_same,
  (SELECT count(*)::int FROM control.ingestion_processing_outbox b WHERE b.job_id=j.id) AS outboxes,
  (SELECT count(*)::int FROM control.ingestion_management_admission_audit a WHERE a.job_id=j.id) AS audits
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id
  JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(j.id,0)
  JOIN LATERAL (SELECT oj.request_digest,oi.public_record AS record FROM control.ingestion_job oj JOIN control.ingestion_job_item oi ON oi.job_id=oj.id AND oi.ordinal=o.original_ordinal WHERE oj.id=o.original_job_id) i0 ON true WHERE o.operation_id=$1`,[accepted.operation_id]);
 expect(rows.rows[0]).toMatchObject({reserved_object_id:own,original_ordinal:1,actor_user_id:'owner',actor_issuer:currentOwner.issuer,
  actor_subject:'owner',actor_auth_epoch:currentOwner.authEpoch,digest_same:true,record_same:true,status:'RECEIVED',outboxes:1,audits:0});
 expect(rows.rows[0].binding_approval_id).not.toBe(rows.rows[0].original_approval);
 expect(rows.rows[0].item_operation).not.toBe(before.item.operation_id);
 expect(await original()).toEqual(before);
 const get=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(get.json().data).toEqual({state:'ACCEPTED',operation_id:accepted.operation_id,child_job_id:accepted.child_job_id,receipt:null});
}
it('commits one selected multi-item recovery with a preexisting own UUID and preserves original proof and raw facts',ensurePartialAccepted);

it('converges concurrent same-key confirmations and distinguishes changed digest and consumed key',async()=>{
 const id=context.quarantineId;
 const body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'},{kind:'user',external_id:'rep-missing',target_id:'owner'}]);
 expect((await context.fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='missing'`,[tenant,source])).rowCount).toBe(0);
 const [a,b]=await Promise.all([post(id,'concurrent',body),post(id,'concurrent',{...body,bindings:[...body.bindings].reverse(),reason:`  ${body.reason}  `})]);
 expect(a.statusCode,a.body).toBe(202);expect(b.statusCode,b.body).toBe(202);expect(a.json().data).toEqual(b.json().data);
 const op=await context.fixture.pool.query<{digest:string;own:string}>(`SELECT encode(request_digest,'hex') AS digest,reserved_object_id::text AS own FROM control.import_recovery_operation WHERE operation_id=$1`,[a.json().data.operation_id]);
 const normalized=[{kind:'user',external_id:'rep-missing',target_id:'owner'},{kind:'department',external_id:'team-missing',target_id:'dept1'}];
 const fields=['hub.import-recovery','1',tenant,source,`/hub/v1/admin/quarantine/${id}/import-recovery`,id,body.expected_state,body.expected_source_revision,body.identity_mapping_revision,body.identity_mapping_digest,
  '[{"external_id":"rep-missing","kind":"user","target_id":"owner"},{"external_id":"team-missing","kind":"department","target_id":"dept1"}]',body.reason];
 const framed=Buffer.concat(fields.flatMap(field=>{const bytes=Buffer.from(field,'utf8'),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return [length,bytes];}));
 expect(op.rows[0]!.digest).toBe(createHash('sha256').update(framed).digest('hex'));
 expect((await context.fixture.pool.query(`SELECT canonical_object_id::text AS id FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='missing'`,[tenant,source])).rows[0].id).toBe(op.rows[0]!.own);
 expect((await post(id,'concurrent',{...body,bindings:normalized,reason:'changed'})).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
 expect((await post(id,'different',body)).json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');
});

it('admits the exact approved order customer tuple without creating another customer',async()=>{
 const {q,ids}=orderFixture;
 const body=await requestFor(q,[{kind:'customer',source_id:source,source_pk:'admission-order-ref',target_id:ids[1]!}]);
 const before=(await context.fixture.pool.query('SELECT count(*)::int AS n FROM hub.canonical_customer')).rows[0].n;
 const wrong=await post(q,'order-wrong',{...body,bindings:[{kind:'customer',source_id:source,source_pk:'admission-order-ref',target_id:ids[0]}]});
 expect(wrong.statusCode,wrong.body).toBe(409);expect(wrong.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');
 const uppercase=await post(q,'order-uppercase',{...body,bindings:[{kind:'customer',source_id:source,source_pk:'admission-order-ref',target_id:ids[1]!.toUpperCase()}]});
 expect(uppercase.statusCode).toBe(400);
 const response=await post(q,'order-recovery',body);expect(response.statusCode,response.body).toBe(202);
 const op=await context.fixture.pool.query(`SELECT entity,confirmed_bindings,reserved_object_id::text FROM control.import_recovery_operation WHERE operation_id=$1`,[response.json().data.operation_id]);
 expect(op.rows[0].entity).toBe('order');expect(op.rows[0].confirmed_bindings[0]).toMatchObject({kind:'customer',sourceId:source,sourcePk:'admission-order-ref',targetId:ids[1]});
 expect((await context.fixture.pool.query('SELECT count(*)::int AS n FROM hub.canonical_customer')).rows[0].n).toBe(before);
});

it('distinguishes an unsupported original binding from a newly barred original proof',async()=>{
 const unsupported=unsupportedFixture.q;
 const visible=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${unsupported}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(visible.json().data).toEqual({state:'SCOPE_UNAVAILABLE'});
 const current=(await context.fixture.pool.query<{source_revision:string;mapping_revision:string;digest:string}>(`SELECT r.current_config_revision::text AS source_revision,r.identity_mapping_revision::text AS mapping_revision,encode(m.mapping_digest,'hex') AS digest FROM control.source_registry r JOIN control.source_identity_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision) WHERE r.tenant_key=$1 AND r.source_id=$2`,[tenant,unsupportedFixture.src])).rows[0]!;
 const {importRecoveryExpectedState}=await import('../ingestion-api/import-recovery-contract.js');
 const unsupportedBody={expected_state:importRecoveryExpectedState(unsupported),expected_source_revision:current.source_revision,identity_mapping_revision:current.mapping_revision,identity_mapping_digest:current.digest,
  bindings:[{kind:'customer',source_id:source,source_pk:'unsupported-order-ref',target_id:unsupportedFixture.ids[1]}],reason:'confirmed'};
 const rejected=await post(unsupported,'unsupported',unsupportedBody);expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().error.code).toBe('RECOVERY_SCOPE_UNAVAILABLE');
 const blocked=barrierFixture.q,body=await requestFor(blocked,[{kind:'customer',source_id:source,source_pk:'barrier-order-ref',target_id:barrierFixture.ids[1]!}]);
 await context.auth.repository.recordSourceScopeSecurityBarrier(barrierFixture.src,tenant,'order','FIXTURE_BARRIER');
 const stale=await post(blocked,'barrier',body);expect(stale.statusCode,stale.body).toBe(409);expect(stale.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');
});

it('returns a conflict when an originally resolved live target loses eligibility',async()=>{
 const id=context.raceIds[2]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const update=(role:'sales'|'sales_manager')=>context.auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:role,managementScopes:['source:read','source:write','source:approve','mapping:write'],enabled:true});
 await update('sales_manager');
 try {const result=await post(id,'target-lost',body);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');}
 finally {await update('sales');}
});

it('rejects malformed, spoofed, stale, missing, and mismatched confirmations',async()=>{
 const id=context.raceIds[0]!;
 const body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 for(const invalid of [
  {...body,actor:'owner'}, {...body,tenant_id:tenant}, {...body,expected_source_revision:'01'},
  {...body,identity_mapping_revision:'9223372036854775808'}, {...body,identity_mapping_digest:'A'.repeat(64)},
  {...body,bindings:[{...body.bindings[0] as object,extra:true}]}, {...body,bindings:[body.bindings[0],body.bindings[0]]},
  {...body,bindings:[{kind:'department',external_id:'team-\u0001x',target_id:'dept1'}]},
  {...body,bindings:[{kind:'department',external_id:'team-\u007fx',target_id:'dept1'}]},
  {...body,bindings:[{kind:'department',external_id:'team-missing',target_id:'dept-\u0001x'}]},
  {...body,reason:'\u0000'}, {...body,reason:'\ud800'}, {...body,reason:' '}, {...body,reason:'x'.repeat(1001)},
  {...body,expected_state:`${body.expected_state}=`}, {...body,expected_state:Buffer.from(JSON.stringify({v:1,kind:'REST',quarantine_id:id,generation:'0'})).toString('base64url')},
  {...body,expected_state:Buffer.from(JSON.stringify({v:1,kind:'IMPORT_RECOVERY',quarantine_id:id,generation:'0',extra:true})).toString('base64url')},
 ]) {const result=await post(id,'invalid',invalid);expect(result.statusCode,result.body).toBe(400);expect(result.json().error.code).toBe('AUTH_INPUT_INVALID');}
 for(const conflict of [{...body,expected_source_revision:'2'}, {...body,identity_mapping_digest:'a'.repeat(64)},
  {...body,bindings:[{kind:'department',external_id:'wrong',target_id:'dept1'}]},
  {...body,bindings:[{kind:'department',external_id:'team-missing',target_id:'other'}]},
  {...body,expected_state:Buffer.from(JSON.stringify({v:1,kind:'IMPORT_RECOVERY',quarantine_id:randomUUID(),generation:'0'})).toString('base64url')},
  {...body,bindings:[{kind:'user',external_id:'rep-a',target_id:'owner'},...body.bindings]}]) {
  const result=await post(id,'stale',conflict);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');
 }
 expect((await context.fixture.pool.query('SELECT count(*)::int AS n FROM control.import_recovery_operation WHERE quarantine_id=$1',[id])).rows[0].n).toBe(0);
});

it('uses real OIDC principal, current Owner and separate namespace scopes',async()=>{
 const id=context.raceIds[1]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const url=`/hub/v1/admin/quarantine/${id}/import-recovery`,viewer=await context.issueToken('viewer'),other=await context.issueToken('other');
 for(const [token,status] of [[viewer,403],[other,404]] as const) {
  const result=await api.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`}});expect(result.statusCode,result.body).toBe(status);
 }
 const {createCredential}=await import('../auth/credentials.js');
 const unknown=await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${randomUUID()}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}});
 expect(unknown.statusCode).toBe(404);expect(unknown.json().error.code).toBe('SOURCE_NOT_FOUND');
 expect((await api.inject({method:'GET',url,headers:{authorization:`Bearer ${createCredential().secret}`}})).statusCode).toBe(401);
 const agent=await context.auth.createAgentCredential(await context.authenticator(context.token),{purpose:'fixture'},'i3a1-agent');
 expect((await api.inject({method:'POST',url,headers:{authorization:`Bearer ${agent.secret}`,'content-type':'application/json','idempotency-key':'agent'},payload:JSON.stringify(body)})).statusCode).toBe(401);
 const owner=(scopes:('source:read'|'source:write'|'source:approve'|'mapping:write')[],enabled=true)=>context.auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:scopes,enabled});
 await owner(['source:read']);expect((await post(id,'wrong-scope',body)).statusCode).toBe(403);
 await owner(['source:approve']);expect((await api.inject({method:'GET',url,headers:{authorization:`Bearer ${context.token}`}})).statusCode).toBe(403);
 const accepted=await post(id,'approve-only',body);expect(accepted.statusCode,accepted.body).toBe(202);
 await owner(['source:read','source:write','source:approve','mapping:write'],false);
 expect((await post(id,'approve-only',body)).statusCode).toBe(401);
 await owner(['source:read','source:write','source:approve','mapping:write']);
});

it('keeps operation writes and private lookup unavailable to unrelated database roles',async()=>{
 const grants=(await context.fixture.pool.query(`SELECT has_table_privilege('hub_api','control.import_recovery_operation','SELECT') AS op_read,
  has_table_privilege('hub_api','control.import_recovery_operation','INSERT') AS op_write,
  has_column_privilege('hub_api','control.ingestion_job','import_recovery_operation_id','INSERT') AS flag_write,
  has_function_privilege('hub_worker','control.lookup_import_recovery(text,uuid,text,text,text,bigint,text)','EXECUTE') AS worker_lookup,
  has_function_privilege('hub_mcp','control.admit_import_recovery(text,uuid,text,text,text,bigint,text,bytea,text,text,bigint,bigint,bytea,jsonb,uuid,uuid)','EXECUTE') AS mcp_admit`)).rows[0];
 expect(grants).toEqual({op_read:false,op_write:false,flag_write:false,worker_lookup:false,mcp_admit:false});
 const client=await context.fixture.pool.connect();try {
  await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_worker');
  await expect(client.query(`SELECT control.lookup_import_recovery($1,$2::uuid,$3,$4,$5,$6::bigint,'source:read')`,[tenant,context.partialId,context.principal.userId,context.principal.issuer,context.principal.subject,context.principal.authEpoch])).rejects.toMatchObject({code:'42501'});
 } finally {await client.query('ROLLBACK');client.release();}
});

it('rejects oversized chunked bodies, duplicate JSON keys and duplicate idempotency headers over a socket',async()=>{
 const id=context.raceIds[2]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const address=await api.listen({host:'127.0.0.1',port:0});
 const send=(headers:string[],chunks:Buffer[])=>new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=httpRequest(`${address}/hub/v1/admin/quarantine/${id}/import-recovery`,{method:'POST',headers},res=>{
   const parts:Buffer[]=[];res.on('data',part=>parts.push(Buffer.from(part)));res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(parts).toString('utf8')}));
  });req.on('error',reject);for(const chunk of chunks) req.write(chunk);req.end();
 });
 const base=['host',new URL(address).host,'authorization',`Bearer ${context.token}`,'content-type','application/json','idempotency-key','socket','transfer-encoding','chunked'];
 const duplicate=JSON.stringify(body).replace('"reason":','"reason":"duplicate","reason":');
 const invalidUtf8=Buffer.concat([Buffer.from('{"x":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}')]);
 for(const [label,headers,chunks] of [['duplicate-json',base,[Buffer.from(duplicate)]],['invalid-utf8',base,[invalidUtf8]],
  ['oversized',base,[Buffer.from(JSON.stringify({...body,reason:'x'.repeat(17000)}))]],
  ['duplicate-header',[...base,'idempotency-key','second'],[Buffer.from(JSON.stringify(body))]]] as [string,string[],Buffer[]][]) {
  const response=await send(headers,chunks);expect(response.status,`${label}: ${response.body}`).toBe(400);expect(response.body,`${label} returned empty body`).not.toBe('');expect(JSON.parse(response.body).error.code).toBe('AUTH_INPUT_INVALID');
 }
});

it('never replays a recovery child as ordinary intake and fails closed on a 015-only runtime',async()=>{
 const row=(await context.fixture.pool.query<{id:string;route:string;idempotency_key:string}>(`SELECT j.id::text,j.route,j.idempotency_key FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id WHERE o.quarantine_id=$1`,[context.partialId])).rows[0]!;
 const response=await context.app.inject({method:'POST',url:row.route,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':row.idempotency_key},payload:JSON.stringify(sample)});
 expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');await client.query('DROP FUNCTION control.find_ordinary_ingestion_job(text,text,text,text)');await client.query('SET LOCAL ROLE hub_api');
  const {findExisting}=await import('../ingestion-api/strict-ingestion.js');
  await expect(findExisting(client,{tenantId:tenant,sourceId:source},row.route,row.idempotency_key)).rejects.toMatchObject({code:'AUTH_UNAVAILABLE'});
 } finally {await client.query('ROLLBACK');client.release();}
});

async function recoveryCounts(id:string) {
 return (await context.fixture.pool.query(`SELECT
  (SELECT count(*)::int FROM control.import_recovery_operation WHERE quarantine_id=$1) AS operations,
  (SELECT count(*)::int FROM control.canonical_source_identity c JOIN control.ingestion_quarantine_index q ON (c.tenant_key,c.source_id,c.entity,c.source_pk)=(q.tenant_key,q.source_id,q.entity,q.source_pk) WHERE q.quarantine_id=$1) AS identities,
  (SELECT count(*)::int FROM control.ingestion_job) AS jobs,(SELECT count(*)::int FROM control.ingestion_job_item) AS items,
  (SELECT count(*)::int FROM control.ingestion_processing_outbox) AS outboxes,(SELECT count(*)::int FROM raw.ingestion_batch) AS batches`,[id])).rows[0];
}
it('rolls back every write when a deferred check fails at COMMIT',async()=>{
 const id=context.raceIds[2]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const before=await recoveryCounts(id);
 await context.fixture.pool.query(`CREATE FUNCTION control.i3a1_test_commit_failure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $test$
  BEGIN IF EXISTS(SELECT 1 FROM control.ingestion_job j WHERE j.id=NEW.job_id AND j.import_recovery_operation_id IS NOT NULL) THEN
   RAISE EXCEPTION 'controlled deferred failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`);
 await context.fixture.pool.query(`CREATE CONSTRAINT TRIGGER i3a1_test_commit_failure AFTER INSERT ON control.ingestion_processing_outbox
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION control.i3a1_test_commit_failure()`);
 try {
  const response=await post(id,'deferred',body);expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('AUTH_UNAVAILABLE');
  expect(await recoveryCounts(id)).toEqual(before);
 } finally {
  await context.fixture.pool.query('DROP TRIGGER i3a1_test_commit_failure ON control.ingestion_processing_outbox');
  await context.fixture.pool.query('DROP FUNCTION control.i3a1_test_commit_failure()');
 }
});

it('rolls back every write when the service fails immediately before COMMIT',async()=>{
 const id=context.raceIds[2]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const before=await recoveryCounts(id),faultApi=Fastify({logger:false});
 const faultPool=new Proxy(context.fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{
   if(typeof sql==='string' && sql.trim()==='COMMIT') throw new Error('controlled pre-commit failure');
   const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;
  }) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {registerImportRecoveryRoutes}=await import('../ingestion-api/import-recovery-routes.js');
 await registerImportRecoveryRoutes(faultApi,{pool:faultPool,authService:context.auth,authenticator:context.authenticator});
 try {
  const response=await faultApi.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':'pre-commit'},payload:JSON.stringify(body)});
  expect(response.statusCode,response.body).toBe(503);expect(await recoveryCounts(id)).toEqual(before);
 } finally {await faultApi.close();}
});

async function ensureCanonicalRace() {
 if(canonicalRace) return;
 const id=context.raceIds[0]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const {readImportRecoveryBindingPlan}=await import('../ingestion-api/import-recovery-plan.js');
 const {bindingInput}=await import('../ingestion-api/import-recovery-contract.js');
 const {validateHubBatch}=await import('../ingestion-api/strict-contract.js');
 const {canonicalCustomerInput}=await import('../normalization/durable-record.js');
 const {applyCustomer}=await import('../normalization/apply.js');
 const actor=await context.authenticator(context.token),reader=await context.fixture.pool.connect();let plan;
 try {await reader.query('BEGIN');await reader.query('SET LOCAL ROLE hub_api');plan=await readImportRecoveryBindingPlan(reader,context.auth,actor,id,bindingInput(body));}
 finally {await reader.query('ROLLBACK');reader.release();}
 expect(plan.kind).toBe('ELIGIBLE');if(plan.kind!=='ELIGIBLE') throw new Error('binding plan unavailable');
 const p=plan.bindingProof;
 const applyContext={tenantId:tenant,sourceId:source,entity:'customer' as const,credentialId:p.credentialId,sourceEpochAtAdmission:p.sourceEpoch,
  credentialRevisionAtAdmission:p.credentialRevision,credentialGenerationAtAdmission:p.credentialGeneration,channelId:p.channelId,channelEpoch:p.channelEpoch,
  versionDomain:'SOURCE_VERSION' as const,ownerApprovalId:p.approvalId,ownerUserId:p.ownerUserId,ownerRevision:p.ownerRevision,
  configRevision:p.configRevision,configDigest:p.configDigest,mappingRevision:p.mappingRevision,mappingDigest:p.mappingDigest,
  identityMappingRevision:p.identityMappingRevision,identityMappingDigest:p.identityMappingDigest,endpointProfileDigest:null,
  importRoute:`/hub/v1/admin/sources/${source}/import/customer`,testReportId:p.testReportId,securityBarrierFenceAtAdmission:p.securityFence};
 const original=(await context.fixture.pool.query<{batch_id:string;public_record:unknown}>(`SELECT j.batch_id::text,i.public_record FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id JOIN control.ingestion_job_item i ON (i.job_id,i.ordinal)=(q.job_id,q.ordinal) WHERE q.quarantine_id=$1`,[id])).rows[0]!;
 const record=validateHubBatch({schema_version:'hub.v1',batch_id:original.batch_id,records:[original.public_record]},'customer').records[0]!;
 const writer=await context.fixture.pool.connect();let pending:ReturnType<typeof post>|undefined;
 try {
  await writer.query('BEGIN');await writer.query('SET LOCAL ROLE hub_worker');
  const result=await applyCustomer(writer,applyContext,canonicalCustomerInput(record));expect(result.status).toBe('APPLIED');if(result.status!=='APPLIED') throw new Error('ordinary apply failed');
  pending=post(id,'canonical-race',body);
  let waiting=false;
  for(let n=0;n<100;n++) {const activity=await context.fixture.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%lookup_import_recovery%'`);if(activity.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  expect(waiting).toBe(true);
  await writer.query('COMMIT');
  const response=await pending;expect(response.statusCode,response.body).toBe(202);
  const reserved=(await context.fixture.pool.query(`SELECT reserved_object_id::text AS id FROM control.import_recovery_operation WHERE quarantine_id=$1`,[id])).rows[0].id;
  expect(reserved).toBe(result.objectId);
  canonicalRace={id,childId:response.json().data.child_job_id,applyContext,input:canonicalCustomerInput(record)};
 } finally {await writer.query('ROLLBACK').catch(()=>undefined);writer.release();if(pending) await pending;}
}
it('reuses a UUID committed by the concurrent legitimate canonical writer',ensureCanonicalRace);

it('serializes persisted child-state fixtures and never attributes an advanced or duplicate receipt',async()=>{
 // These status mutations exercise the reader only; they do not claim that a recovery worker ran.
 await ensureCanonicalRace();
 const {id,childId,applyContext,input}=canonicalRace;
 const read=async()=>(await api.inject({method:'GET',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${context.token}`}})).json().data;
 const setItem=(status:string)=>context.fixture.pool.query(`UPDATE control.ingestion_job_item SET status=$2 WHERE job_id=$1 AND ordinal=0`,[childId,status]);
 const setJob=(status:string)=>context.fixture.pool.query(`UPDATE control.ingestion_job SET status=$2 WHERE id=$1`,[childId,status]);
 await setItem('APPLIED');const matching=await read();
 expect(matching.state).toBe('APPLIED');expect(matching.receipt).toMatchObject({channel_id:applyContext.channelId,channel_epoch:applyContext.channelEpoch,source_version:input.source_version,canonical_object_id:expect.any(String)});
 const {applyCustomer}=await import('../normalization/apply.js');const writer=await context.fixture.pool.connect();
 try {await writer.query('BEGIN');await writer.query('SET LOCAL ROLE hub_worker');const result=await applyCustomer(writer,applyContext,{...input,source_version:(BigInt(input.source_version)+1n).toString()});expect(result.status).toBe('APPLIED');await writer.query('COMMIT');}
 finally {await writer.query('ROLLBACK').catch(()=>undefined);writer.release();}
 expect((await read()).receipt).toBeNull();
 for(const status of ['DUPLICATE','IGNORED_STALE','QUARANTINED']) {await setItem(status);const value=await read();expect(value.state).toBe(status);expect(value.receipt).toBeNull();}
 await setJob('FAILED');expect((await read()).state).toBe('QUARANTINED');
 await setItem('RECEIVED');expect((await read()).state).toBe('FAILED');
 await setJob('PROCESSING');
 for(const status of ['VALIDATING','APPLYING','RETRY_PENDING']) {await setItem(status);expect((await read()).state).toBe('ACCEPTED');}
 await setItem('RECEIVED');await setJob('RECEIVED');
});

async function waitForLookupLock() {
 for(let n=0;n<100;n++) {
  const result=await context.fixture.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%lookup_import_recovery%'`);
  if(result.rowCount) return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw new Error('request did not reach the controlled lock');
}
it('rechecks the current authenticated epoch when a disable commits during admission',async()=>{
 const id=context.raceIds[3]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const before=await recoveryCounts(id),controller=await context.fixture.pool.connect();let pending:ReturnType<typeof post>|undefined;
 try {
  await controller.query('BEGIN');await controller.query('SELECT control.lock_security_barrier_fence()');
  pending=post(id,'disable-race',body);await waitForLookupLock();
  await context.auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write'],enabled:false},controller);
  await controller.query('COMMIT');
  const response=await pending;expect(response.statusCode,response.body).toBe(401);expect(await recoveryCounts(id)).toEqual(before);
 } finally {
  await controller.query('ROLLBACK').catch(()=>undefined);controller.release();if(pending) await pending;
  await context.auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write'],enabled:true});
 }
});

it('retains ordinary canonical conversion behavior for customer and order inputs',async()=>{
 const {validateHubBatch}=await import('../ingestion-api/strict-contract.js');
 const {canonicalCustomerInput,canonicalOrderInput}=await import('../normalization/durable-record.js');
 const {customerReferenceMappingKey}=await import('../source-registry/import-sample.js');
 const customer={event_id:randomUUID(),source_pk:'c',source_version:'2',operation:'UPSERT',source_updated_at:'2026-10-29T09:00:00+08:00',data:{customer_name:'Acme',owner_external_id:'rep',department_external_id:'team',status:'ACTIVE',phone:'123'}};
 const order={event_id:randomUUID(),source_pk:'o',source_version:'3',operation:'UPSERT',source_updated_at:'2026-10-29T09:00:00+08:00',data:{customer_ref:{source_id:source,source_pk:'c'},order_no:'O1',status:'CONFIRMED',order_at:'2026-10-29T09:00:00+08:00',amount:'12',currency:'CNY',lines:[{source_line_id:'line',product_code:'p',product_name:'P',quantity:'1',unit_price:'12',line_amount:'12'}]}};
 const batch=(record:unknown,entity:'customer'|'order')=>validateHubBatch({schema_version:'hub.v1',batch_id:randomUUID(),records:[record]},entity).records[0]!;
 expect(canonicalCustomerInput(batch(customer,'customer'))).toEqual({source_pk:'c',customer_name:'Acme',owner_external_id:'rep',dept_external_id:'team',status:'ACTIVE',phone:'123',source_updated_at:'2026-10-29T01:00:00Z',source_version:'2',deleted_at:null});
 const canonical=canonicalOrderInput({endpoint_profile_digest:null},batch(order,'order'));
 expect(canonical).toMatchObject({source_pk:'o',customer_external_id:customerReferenceMappingKey(source,'c'),order_no:'O1',order_at:'2026-10-29T01:00:00Z',amount:'12.00',source_updated_at:'2026-10-29T01:00:00Z',lines:[{quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]});
 expect(canonicalOrderInput({endpoint_profile_digest:Buffer.alloc(32)},batch(order,'order'))).toMatchObject({customer_external_id:'c'});
});

it('accepts the maximum Unicode-scalar reason including embedded newline and control characters',async()=>{
 const id=context.raceIds[4]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 const reason=`a\n\u0001${'🙂'.repeat(997)}`;expect(Array.from(reason)).toHaveLength(1000);
 const response=await post(id,'unicode-reason',{...body,reason});expect(response.statusCode,response.body).toBe(202);
 const stored=await context.fixture.pool.query<{reason:string}>('SELECT reason FROM control.import_recovery_operation WHERE quarantine_id=$1',[id]);
 expect(stored.rows[0]!.reason).toBe(reason);
});

it('rejects a newer remap fence on an originally resolved identity',async()=>{
 const id=context.raceIds[5]!,body=await requestFor(id,[{kind:'department',external_id:'team-missing',target_id:'dept1'}]);
 await context.fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
  SELECT tenant_key,source_id,identity_mapping_revision+1,decode(repeat('ab',32),'hex'),'[]'::jsonb,'fixture' FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
 await context.fixture.pool.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision)
  SELECT tenant_key,source_id,'user','rep-a',identity_mapping_revision+1 FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2
  ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision`,[tenant,source]);
 const result=await post(id,'remap-fence',body);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('IMPORT_RECOVERY_CONFLICT');
});

it('replays immutable IDs after pause and edit, while an Owner change racing replay is enforced',async()=>{
 await ensurePartialAccepted();
 const id=context.partialId,actor=await context.authenticator(context.token);
 const immutable=async()=>(await context.fixture.pool.query(`SELECT to_jsonb(o) AS value FROM control.import_recovery_operation o WHERE operation_id=$1`,[partialAccepted.operation_id])).rows[0].value;
 const before=await immutable();
 await context.sourceService.pause(actor,source,'1','maintenance');
 const config={name:'Edited',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'};
 await context.sourceService.update(actor,source,{expected_revision:'1',config});
 const replay=await post(id,'partial-recovery',partialBody);expect(replay.statusCode,replay.body).toBe(202);expect(replay.json().data).toEqual(partialAccepted);
 await context.auth.repository.updateSubject({tenantId:tenant,userId:'viewer',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:approve'],enabled:true});
 let unblock!:()=>void,updated!:()=>void;const release=new Promise<void>(resolve=>{unblock=resolve;}),locked=new Promise<void>(resolve=>{updated=resolve;});
 const rolePool=new Proxy(context.fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{
   const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);
   if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');
   if(typeof sql==='string' && sql.includes('UPDATE control.source_registry SET current_config_revision')) {updated();await release;}
   return result;
  }) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {createSourceRegistryService,failClosedCapabilityProbe,failClosedEndpointAllowlist,failClosedSecretResolver}=await import('../source-registry/service.js');
 const service=createSourceRegistryService({pool:rolePool,auth:context.auth,secretResolver:failClosedSecretResolver,endpointAllowlist:failClosedEndpointAllowlist,capabilityProbe:failClosedCapabilityProbe});
 const change=service.update(actor,source,{expected_revision:'2',config,data_owner_user_id:'viewer'});
 let pending:ReturnType<typeof post>|undefined;
 try {
  await locked;pending=post(id,'partial-recovery',partialBody);await waitForLookupLock();unblock();await change;
  const rejected=await pending;expect(rejected.statusCode,rejected.body).toBe(403);
  const viewer=await context.issueToken('viewer');
  const newOwner=await api.inject({method:'POST',url:`/hub/v1/admin/quarantine/${id}/import-recovery`,headers:{authorization:`Bearer ${viewer}`,'content-type':'application/json','idempotency-key':'partial-recovery'},payload:JSON.stringify(partialBody)});
  expect(newOwner.statusCode,newOwner.body).toBe(202);expect(newOwner.json().data).toEqual(partialAccepted);expect(await immutable()).toEqual(before);
 } finally {unblock();await change.catch(()=>undefined);if(pending) await pending;}
});
