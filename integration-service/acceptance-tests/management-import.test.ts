import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createOidcAuthenticator } from '../auth/oidc.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

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
  await runMigrations(fixture.pool,{directory:upgradeDir,environmentKind:'local_lab'});
  const auth=createAuthService({pool:fixture.pool}); testAuth=auth;
  const keys=await generateKeyPair('RS256',{modulusLength:2048});
  const jwk={...await exportJWK(keys.publicKey),kid:'i2a',alg:'RS256',use:'sig'};
  jwks=createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]})));
  await new Promise<void>((resolve,reject)=>{jwks.once('error',reject);jwks.listen(0,'127.0.0.1',resolve);});
  const address=jwks.address(); if(!address || typeof address==='string') throw new Error('JWKS_ADDRESS');
  const issuer=`http://127.0.0.1:${address.port}/issuer`, audience='i2a'; testIssuer=issuer;
  await auth.repository.provisionTenant({tenantId:tenant,businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',managementScopes:['source:read','source:write','source:approve','mapping:write']});
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
},90000);
afterAll(async()=>{if(app) await app.close();if(jwks) await new Promise<void>(resolve=>jwks.close(()=>resolve()));if(fixture) await fixture.close();});

it('durably admits original bytes and mapped effective record through OIDC and hub_api',async()=>{
  const response=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'same-key'},payload:raw});
  expect(response.statusCode).toBe(202);
  const job=response.json().data.job_id;
  const stored=await fixture.pool.query(`SELECT b.body_bytes,i.public_record,a.actor_user_id,j.request_digest,j.endpoint_profile_digest,j.config_digest,j.mapping_digest,j.identity_mapping_digest,approval.config_digest AS approved_config,approval.mapping_digest AS approved_mapping,approval.identity_mapping_digest AS approved_identity,approval.sample_digest,report.sample_digest AS report_sample FROM control.ingestion_job j JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_management_admission_audit a ON a.job_id=j.id JOIN control.source_owner_approval approval ON approval.id=j.owner_approval_id JOIN control.source_test_report report ON report.id=j.test_report_id WHERE j.id=$1`,[job]);
  expect(stored.rows[0].body_bytes.equals(Buffer.from(raw))).toBe(true);
  expect(stored.rows[0].public_record.data).toEqual({customer_name:'Acme',owner_external_id:'rep-a',department_external_id:'team-a',status:'ACTIVE'});
  expect(stored.rows[0].actor_user_id).toBe('owner');
  const canonical='{"batch_id":"10000000-0000-4000-8000-000000000001","records":[{"data":{"discarded":"original","display":" Acme ","rep":"rep-a","state":"ACTIVE","team":"team-a"},"event_id":"10000000-0000-4000-8000-000000000002","operation":"UPSERT","source_pk":"customer-one","source_updated_at":"2026-10-29T00:00:00Z","source_version":"1"}],"schema_version":"hub.v1"}';
  const expectedDigest=createHash('sha256').update(['hub.ingest.v1',tenant,source,`/hub/v1/admin/sources/${source}/import/customer`,canonical].join('\0')).digest();
  expect(stored.rows[0].request_digest.equals(expectedDigest)).toBe(true);expect(stored.rows[0].endpoint_profile_digest).toBeNull();
  for(const [actual,approved] of [['config_digest','approved_config'],['mapping_digest','approved_mapping'],['identity_mapping_digest','approved_identity'],['sample_digest','report_sample']]) expect(stored.rows[0][actual].equals(stored.rows[0][approved])).toBe(true);
});


const importUrl=`/hub/v1/admin/sources/${source}/import/customer`;
async function submit(body:string,key:string,auth=token) { return app.inject({method:'POST',url:importUrl,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json','idempotency-key':key},payload:body}); }
async function counts() { const result=await fixture.pool.query(`SELECT (SELECT count(*)::int FROM control.ingestion_job WHERE tenant_key=$1) jobs,(SELECT count(*)::int FROM raw.ingestion_batch WHERE tenant_key=$1) raw,(SELECT count(*)::int FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id WHERE j.tenant_key=$1) items,(SELECT count(*)::int FROM control.ingestion_processing_outbox o JOIN control.ingestion_job j ON j.id=o.job_id WHERE j.tenant_key=$1) outbox,(SELECT count(*)::int FROM control.ingestion_management_admission_audit WHERE tenant_key=$1) audit`,[tenant]);return result.rows[0]; }
it('allows typed NULL import proof through the hardened ownership proof consumer',async()=>{
 const proof=await fixture.pool.query(`SELECT * FROM control.ingestion_job WHERE tenant_key=$1 AND source_id=$2 LIMIT 1`,[tenant,source]);const row=proof.rows[0]!;
 const client=await fixture.pool.connect();try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_worker');
  await expect(client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,'absent-key',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[tenant,source,row.credential_id,row.channel_id,row.channel_epoch,row.version_domain,row.security_barrier_fence_at_admission,row.owner_approval_id,row.test_report_id,row.identity_mapping_revision,JSON.stringify([{kind:'user',external_id:'rep-a'}])])).rejects.toThrow('source ownership change has no canonical customer');
 } finally {await client.query('ROLLBACK');client.release();}
});
it('converges concurrent replays and rejects changed discarded original field',async()=>{
 const responses=await Promise.all([submit(raw,'parallel'),submit(raw,'parallel')]);
 expect(responses.map(r=>r.statusCode)).toEqual([202,202]);expect(responses[0].json().data.job_id).toBe(responses[1].json().data.job_id);
 const before=await counts();
 expect((await submit(raw.replace('original','changed'),'parallel')).statusCode).toBe(409);
 expect(await counts()).toEqual(before);
});
it('rejects duplicate keys and unsafe numeric source fields without writing',async()=>{
 const before=await counts();
 for(const body of [raw.replace('"schema_version":"hub.v1"','"schema_version":"hub.v1","schema_version":"hub.v1"'),raw.replace('"original"','9007199254740992'),raw.replace('"original"','9007199254740993')]) expect((await submit(body,`invalid-${body.length}`)).statusCode).toBe(422);
 expect(await counts()).toEqual(before);
});
it('rolls back every durable fact before first write and before commit',async()=>{
 for(const point of ['before_write','before_commit'] as const) {const before=await counts(); fault=point; expect((await submit(raw,`fault-${point}`)).statusCode).toBe(503);expect(await counts()).toEqual(before);}
});
it('denies source-shaped bearer and keeps the shipped application unregistered',async()=>{
 expect((await submit(raw,'source-token','A'.repeat(43))).statusCode).toBe(401);
 const shipped=await buildApp({logger:false});
 try { expect((await shipped.inject({method:'POST',url:importUrl,headers:{'content-type':'application/json'},payload:raw})).statusCode).toBe(404); } finally {await shipped.close();}
});

it('preserves populated migration invariants and rejects forged import proof',async()=>{
 const definitions=await fixture.pool.query<{name:string;definition:string}>(`SELECT conname name,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='control.ingestion_job'::regclass AND contype='c'`);
 expect(definitions.rows.some(row=>row.definition.includes('applied_count <= received_count'))).toBe(true);
 expect(definitions.rows.some(row=>row.name==='ingestion_job_route_entity_check' && row.definition.includes("entity = 'customer'"))).toBe(true);
 const job=await fixture.pool.query<{id:string}>('SELECT id FROM control.ingestion_job WHERE tenant_key=$1 ORDER BY created_at LIMIT 1',[tenant]);
 await expect(fixture.pool.query("UPDATE control.ingestion_job SET status='FAILED',applied_count=received_count+1 WHERE id=$1",[job.rows[0]!.id])).rejects.toMatchObject({code:'23514'});
 await expect(fixture.pool.query(`INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes) VALUES(gen_random_uuid(),$1,$2,$3,'x'::bytea)`,[tenant,source,`/hub/v1/admin/sources/${source}/import/other`])).rejects.toMatchObject({code:'23514'});
 await expect(fixture.pool.query(`INSERT INTO control.ingestion_job(tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at) SELECT tenant_key,source_id,entity,route,batch_id,raw_batch_id,'forged-proof',request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,NULL,gen_random_uuid(),security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at FROM control.ingestion_job WHERE id=$1`,[job.rows[0]!.id])).rejects.toMatchObject({code:'23514'});
 const before=await counts(); await runMigrations(fixture.pool,{directory:fileURLToPath(new URL('../migrations/',import.meta.url)),environmentKind:'local_lab'}); expect(await counts()).toEqual(before);
});

it('recovers the original receipt after the committed HTTP response is dropped',async()=>{
 const before=await counts();
 const address=await app.listen({host:'127.0.0.1',port:0}); dropResponse=true;
 await new Promise<void>((resolve,reject)=>{
  const req=httpRequest(`${address}${importUrl}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'response-loss'}},res=>{res.resume();reject(new Error('response was not dropped'));});
  req.on('error',()=>resolve());req.end(raw);
 });
 const committed=await counts(); expect(committed.jobs).toBe(before.jobs+1);expect(committed.audit).toBe(before.audit+1);
 const replay=await submit(raw,'response-loss');expect(replay.statusCode).toBe(202);expect(await counts()).toEqual(committed);
 const row=await fixture.pool.query('SELECT id FROM control.ingestion_job WHERE tenant_key=$1 AND source_id=$2 AND idempotency_key=$3',[tenant,source,'response-loss']);
 expect(replay.json().data.job_id).toBe(row.rows[0].id);
});

it('enforces body and record limits on actual bytes',async()=>{
 const batch=JSON.parse(raw);const record=batch.records[0];batch.records=Array.from({length:100},(_,i)=>({...record,event_id:`20000000-0000-4000-8000-${String(i).padStart(12,'0')}`,source_pk:`c-${i}`}));
 expect((await submit(JSON.stringify(batch),'hundred')).statusCode).toBe(202);
 batch.records.push({...record,event_id:'30000000-0000-4000-8000-000000000001'});expect((await submit(JSON.stringify(batch),'hundred-one')).statusCode).toBe(422);
 const prefix=raw.replace('original','');const limit=4*1024*1024;const atLimit=prefix.replace('"discarded":""',`"discarded":"${'x'.repeat(limit-Buffer.byteLength(prefix))}"`);
 expect(Buffer.byteLength(atLimit)).toBe(limit); expect((await submit(atLimit,'four-mib')).statusCode).toBe(202); expect((await submit(atLimit+' ','four-mib-plus')).statusCode).toBe(413);
});
it('denies wrong tenant and missing write scope',async()=>{
 const before=await counts();expect((await submit(raw,'other',otherToken)).statusCode).not.toBe(202);expect((await submit(raw,'viewer',viewerToken)).statusCode).toBe(403);expect(await counts()).toEqual(before);
});
it('preserves an explicitly confirmed foreign typed customer reference in an order',async()=>{
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
 const order=JSON.stringify({schema_version:'hub.v1',batch_id:'20000000-0000-4000-8000-000000000001',records:[{event_id:'20000000-0000-4000-8000-000000000002',source_pk:'order-one',source_version:'18446744073709551615',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:ref,number:' O1 ',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]});
 const tested=await call('POST',`/hub/v1/admin/sources/${orderSource}/test`,{expected_revision:'1',samples:{order}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approval=await call('POST',`/hub/v1/admin/sources/${orderSource}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approval.statusCode).toBe(200);
 expect((await call('POST',`/hub/v1/admin/sources/${orderSource}/activate`,{revision:'1',approval_id:approval.json().data.approval_id})).statusCode).toBe(200);
 const accepted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${orderSource}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'order'},payload:order});expect(accepted.statusCode).toBe(202);
 const stored=await fixture.pool.query('SELECT public_record FROM control.ingestion_job_item WHERE job_id=$1',[accepted.json().data.job_id]);
 expect(stored.rows[0].public_record.data).toEqual({customer_ref:ref,order_no:'O1',status:'CONFIRMED',order_at:'2026-10-29T00:00:00Z',amount:'12.00',currency:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]});
 expect(stored.rows[0].public_record.source_version).toBe('18446744073709551615');
});
it('serializes a mapping edit behind admission and replays the immutable old proof after edit',async()=>{
 const headers={authorization:`Bearer ${token}`};
 const beforeProof=await fixture.pool.query(`SELECT revision::text AS mapping_revision,encode(mapping_digest,'hex') digest FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 ORDER BY revision DESC LIMIT 1`,[tenant,source]);
 let locked!:()=>void,release!:()=>void,editStarted!:()=>void;const atLock=new Promise<void>(r=>{locked=r;}),gate=new Promise<void>(r=>{release=r;}),atEdit=new Promise<void>(r=>{editStarted=r;});
 holdAfterSource=async()=>{locked();await gate;};const pending=submit(raw,'mapping-race');await atLock;
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'identity'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 signalEditAttempt=editStarted;const editing=app.inject({method:'PUT',url:`/hub/v1/admin/sources/${source}/mappings`,headers,payload:{expected_revision:beforeProof.rows[0].mapping_revision,mappings}}).then(result=>result);await atEdit;
 release();const admitted=await pending;expect(admitted.statusCode).toBe(202);expect((await editing).statusCode).toBe(200);
 const job=admitted.json().data.job_id;const rows=await fixture.pool.query(`SELECT j.mapping_revision::text,encode(j.mapping_digest,'hex') digest,i.public_record,b.body_bytes FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[job]);
 expect(rows.rows[0].mapping_revision).toBe(beforeProof.rows[0].mapping_revision);expect(rows.rows[0].digest).toBe(beforeProof.rows[0].digest);expect(rows.rows[0].public_record.data.customer_name).toBe('Acme');expect(rows.rows[0].body_bytes.equals(Buffer.from(raw))).toBe(true);
 const updated=await fixture.pool.query(`SELECT revision::text AS mapping_revision,encode(mapping_digest,'hex') digest FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 ORDER BY revision DESC LIMIT 1`,[tenant,source]);expect(updated.rows[0].mapping_revision).not.toBe(beforeProof.rows[0].mapping_revision);expect(updated.rows[0].digest).not.toBe(beforeProof.rows[0].digest);
 const before=await counts();const replay=await submit(raw,'mapping-race');expect(replay.statusCode).toBe(202);expect(replay.json().data.job_id).toBe(job);expect(await counts()).toEqual(before);
 const after=await fixture.pool.query(`SELECT j.mapping_revision::text,encode(j.mapping_digest,'hex') digest,i.public_record,b.body_bytes FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN raw.ingestion_batch b ON b.id=j.raw_batch_id WHERE j.id=$1`,[job]);expect(after.rows).toEqual(rows.rows);
 const tested=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:raw}}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;
 const approval=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});expect(approval.statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approval.json().data.approval_id}})).statusCode).toBe(200);
});
it('rejects an identity revoked while waiting inside intake',async()=>{
 let entered!:()=>void, release!:()=>void;const atLock=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 holdAfterSource=async()=>{entered();await gate;};const pending=submit(raw,'principal-race');await atLock;
 await testAuth.repository.setIdentityBinding(testIssuer,'owner',false);release();expect((await pending).statusCode).not.toBe(202);
 await testAuth.repository.setIdentityBinding(testIssuer,'owner',true);
});
it('replays across pause but denies revoked identity and current reads',async()=>{
 const accepted=await submit(raw,'pause-replay');expect(accepted.statusCode).toBe(202);
 let entered!:()=>void, release!:()=>void;const atLock=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 holdAfterSource=async()=>{entered();await gate;};const racing=submit(raw,'source-race');await atLock;
 const pausePromise=app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/pause`,headers:{authorization:`Bearer ${token}`},payload:{expected_revision:'1',reason:'fixture pause'}});
 release();expect((await racing).statusCode).toBe(202);expect((await pausePromise).statusCode).toBe(200);
 const before=await counts();const replay=await submit(raw,'pause-replay');expect(replay.statusCode).toBe(202);expect(replay.json().data.job_id).toBe(accepted.json().data.job_id);expect((await submit(raw,'new-paused')).statusCode).toBe(409);expect(await counts()).toEqual(before);
 const id=accepted.json().data.job_id;for(const suffix of ['', '/items']) expect((await app.inject({method:'GET',url:`/hub/v1/ingestion-jobs/${id}${suffix}`,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(200);
 await testAuth.repository.setIdentityBinding(testIssuer,'owner',false);
 expect((await submit(raw,'pause-replay')).statusCode).not.toBe(202);
 for(const suffix of ['', '/items']) expect((await app.inject({method:'GET',url:`/hub/v1/ingestion-jobs/${id}${suffix}`,headers:{authorization:`Bearer ${token}`}})).statusCode).not.toBe(200);
});
