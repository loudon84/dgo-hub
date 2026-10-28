import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { createCredential } from '../auth/credentials.js';
import { createAuthService } from '../auth/service.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

let fixture: OwnedPostgres;
let app: Awaited<ReturnType<typeof buildApp>>;
let ownerAuth: ReturnType<typeof createAuthService>;
let pauseMapping: (()=>Promise<void>) | undefined;
beforeAll(async () => {
  const root=fixtureEvidenceRootFromEnvironment();
  if (!root) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
  fixture=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
  await runMigrations(fixture.pool,{directory:fileURLToPath(new URL('../migrations/',import.meta.url)),environmentKind:'local_lab'});
  const auth=createAuthService({pool:fixture.pool}); ownerAuth=auth;
  await auth.repository.provisionTenant({tenantId:'tenant_i1',businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId:'tenant_i1',userId:'owner',departmentId:'dept1',managementScopes:['source:read','source:write','source:approve','mapping:write']});
  await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'owner-i1',tenantId:'tenant_i1',userId:'owner'});
  const owner=await auth.resolveOidc('https://idp.example.test','owner-i1');
  await auth.repository.provisionTenant({tenantId:'other_i1',businessTimezone:'UTC'});
  await auth.repository.provisionSubject({tenantId:'other_i1',userId:'other',managementScopes:['source:read','source:write','source:approve','mapping:write']});
  await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'other-i1',tenantId:'other_i1',userId:'other'});
  const other=await auth.resolveOidc('https://idp.example.test','other-i1');
  await auth.repository.provisionSubject({tenantId:'tenant_i1',userId:'viewer',managementScopes:['source:read']});
  await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'viewer-i1',tenantId:'tenant_i1',userId:'viewer'});
  const viewer=await auth.resolveOidc('https://idp.example.test','viewer-i1');
  const rolePool=new Proxy(fixture.pool,{get(target,property){
    if(property==='connect') return async()=>{ const client=await target.connect(); const query=client.query.bind(client);
      return {query: (async (sql:unknown,...args:unknown[])=> {
        if(typeof sql==='string' && sql.includes('INSERT INTO control.source_mapping_revision') && pauseMapping) {const pause=pauseMapping; pauseMapping=undefined; await pause();}
        const result=await (query as (...values:unknown[])=>Promise<unknown>)(sql,...args);
        if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');
        return result;
      }) as typeof client.query,release:client.release.bind(client)}; };
    const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
  }});
  const sourceService=createSourceRegistryService({pool:rolePool,auth,secretResolver:failClosedSecretResolver,endpointAllowlist:failClosedEndpointAllowlist,capabilityProbe:failClosedCapabilityProbe});
  const authenticator=async (token:string)=>token==='other'?other:token==='viewer'?viewer:owner;
  app=await buildApp({logger:false,sourceRegistry:{authService:auth,sourceService,authenticator},strictIngestion:{pool:rolePool,authService:auth,authenticator}});
},90000);
afterAll(async()=>{ if(app) await app.close(); if(fixture) await fixture.close(); });

describe('simulated import source management',()=>{
  it('creates an import through HTTP without external endpoint, secret or pre-provisioned credential',async()=>{
    const response=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers:{authorization:'Bearer owner'},payload:{source_id:'import-one',data_owner_user_id:'owner',config:{name:'Import',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}}});
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({source_id:'import-one',lifecycle:'DRAFT',revision:'1'});
    const proof=await fixture.pool.query("SELECT secret_ref FROM control.source_credential WHERE tenant_key='tenant_i1' AND source_id='import-one'");
    expect(proof.rows).toEqual([{secret_ref:null}]);
  });
  it('validates mapped sample, records Owner proof and activates, then invalidates on mapping edit',async()=>{
    const headers={authorization:'Bearer owner'};
    const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},
      {entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},
      {entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},
      {entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
    const mapped=await app.inject({method:'PUT',url:'/hub/v1/admin/sources/import-one/mappings',headers,payload:{expected_revision:'1',mappings}});
    expect(mapped.statusCode).toBe(200);
    for (const [kind,external,target,rev] of [['user','rep-a','owner','0'],['department','team-a','dept1','1']]) {
      const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=import-one&kind=${kind}&external_id=${external}`,headers});
      expect(candidate.statusCode).toBe(200);
      const confirmed=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:rev,target_id:target,reason:'confirmed'}});
      expect(confirmed.statusCode).toBe(200);
    }
    const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'10000000-0000-4000-8000-000000000001',records:[{event_id:'10000000-0000-4000-8000-000000000002',source_pk:'customer-one',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:' Acme ',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]});
    const tested=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:{expected_revision:'1',samples:{customer:sample}}});
    expect(tested.statusCode).toBe(202);
    expect(tested.json().data.status).toBe('PASS');
    const test=tested.json().data;
    const approved=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/approve',headers,payload:{revision:'1',test_report_id:test.test_report_id,data_contract_ref:test.data_contract_ref}});
    expect(approved.statusCode).toBe(200);
    const activation=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/activate',headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}});
    expect(activation.statusCode).toBe(200);
    expect(activation.json().data.lifecycle).toBe('ACTIVE');
    const edit=await app.inject({method:'PUT',url:'/hub/v1/admin/sources/import-one/mappings',headers,payload:{expected_revision:'2',mappings}});
    expect(edit.statusCode).toBe(200);
    const stale=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/activate',headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}});
    expect(stale.statusCode).not.toBe(200);
  });

  it('rejects malformed or unknown-state samples and forged tenant fields',async()=>{
    const headers={authorization:'Bearer owner'};
    const bad=JSON.stringify({schema_version:'hub.v1',batch_id:'10000000-0000-4000-8000-000000000001',records:[{event_id:'10000000-0000-4000-8000-000000000002',source_pk:'c',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'x',rep:'rep-a',team:'team-a',state:'UNKNOWN'}}]});
    for(const sample of [bad,'{"schema_version":"hub.v1","schema_version":"hub.v1"}']) {
      const response=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:{expected_revision:'1',samples:{customer:sample}}});
      expect(response.statusCode).toBe(202); expect(response.json().data.status).toBe('FAIL');
    }
    const forged=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{tenant_id:'elsewhere',source_id:'forged',data_owner_user_id:'owner',config:{name:'x',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}}});
    expect(forged.statusCode).toBe(400);
  });
  it('never authenticates an import authority using its source token and restricts provisioning grants',async()=>{
    const credential=createCredential();
    await fixture.pool.query('SELECT control.provision_import_authority($1,$2,$3,$4)',['controlled-import','tenant_i1',credential.digest,['customer']]);
    const auth=createAuthService({pool:fixture.pool});
    await expect(auth.authenticateSourceIdentity(credential.secret)).rejects.toMatchObject({code:'AUTH_INVALID'});
    for(const suffix of ['', '/items']) { const response=await app.inject({method:'GET',url:`/hub/v1/ingestion-jobs/10000000-0000-4000-8000-000000000001${suffix}`,headers:{authorization:`Bearer ${credential.secret}`}}); expect(response.statusCode).toBe(401); }
    const grants=await fixture.pool.query(`SELECT has_function_privilege('hub_api','control.provision_import_authority(text,text,bytea,text[])','EXECUTE') api,
      has_function_privilege('hub_mcp','control.provision_import_authority(text,text,bytea,text[])','EXECUTE') mcp,
      EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='control.provision_import_authority(text,text,bytea,text[])'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') public`);
    expect(grants.rows[0]).toEqual({api:true,mcp:false,public:false});
  });

  it('validates and activates an order-only source using an explicitly confirmed foreign customer',async()=>{
    const headers={authorization:'Bearer owner'}, source='orders-only';
    const created=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{source_id:source,data_owner_user_id:'owner',config:{name:'orders',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}}});
    expect(created.statusCode).toBe(201);
    const maps=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
    expect((await app.inject({method:'PUT',url:`/hub/v1/admin/sources/${source}/mappings`,headers,payload:{expected_revision:'1',mappings:maps}})).statusCode).toBe(200);
    const ref={source_id:'foreign-source',source_pk:'foreign-key'};
    const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'20000000-0000-4000-8000-000000000001',records:[{event_id:'20000000-0000-4000-8000-000000000002',source_pk:'order-one',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:ref,number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}}]});
    const test=()=>app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{order:sample}}});
    expect((await test()).json().data.status).toBe('FAIL');
    expect((await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{source_id:'foreign-source',data_owner_user_id:'owner',config:{name:'foreign',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}}})).statusCode).toBe(201);
    const canonical=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('tenant_i1','Existing','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id`);
    await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES('tenant_i1','foreign-source','customer','foreign-key',$1,$1)`,[canonical.rows[0].id]);
    const wrong=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('tenant_i1','Wrong','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,2) RETURNING id`);
    const key='c:'+createHash('sha256').update(JSON.stringify([ref.source_id,ref.source_pk])).digest('base64url');
    const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=customer&external_id=${key}`,headers});
    expect(candidate.statusCode).toBe(200);
    const cross=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('other_i1','Other','other','other','ACTIVE',now(),1,'SOURCE_VERSION',1,3) RETURNING id`);
    const foreignTarget=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'0',target_id:cross.rows[0].id,reason:'cross tenant'}});
    expect(foreignTarget.statusCode).not.toBe(200);
    const confirm=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'0',target_id:wrong.rows[0].id,reason:'confirmed'}});
    expect(confirm.statusCode).toBe(200);
    expect((await test()).json().data.status).toBe('FAIL');
    const correct=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'1',target_id:canonical.rows[0].id,reason:'corrected'}});
    expect(correct.statusCode).toBe(200);
    const pass=await test(); expect(pass.json().data.status).toBe('PASS');
    const first=pass.json().data;
    const newer=(await test()).json().data;
    const stale=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:first.test_report_id,data_contract_ref:first.data_contract_ref}});
    expect(stale.statusCode).toBe(409);
    const approve=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:newer.test_report_id,data_contract_ref:newer.data_contract_ref}});
    expect(approve.statusCode).toBe(200);
    await fixture.pool.query('UPDATE hub.canonical_customer SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',['tenant_i1',canonical.rows[0].id]);
    const activation=()=>app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approve.json().data.approval_id}});
    expect((await activation()).statusCode).toBe(409);
    await fixture.pool.query('UPDATE hub.canonical_customer SET deleted_at=NULL WHERE tenant_id=$1 AND id=$2',['tenant_i1',canonical.rows[0].id]);
    expect((await activation()).statusCode).toBe(200);
    await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES('tenant_i1',$1,'customer','local-key',$2,$2)`,[source,canonical.rows[0].id]);
    const localKey='c:'+createHash('sha256').update(JSON.stringify([source,'local-key'])).digest('base64url');
    const localCandidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=customer&external_id=${localKey}`,headers});
    const localConfirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${localCandidate.json().data.id}`,headers,payload:{expected_revision:'2',target_id:canonical.rows[0].id,reason:'same source'}});
    expect(localConfirmation.statusCode).toBe(200);
    const localBatch=JSON.parse(sample);localBatch.records[0].data.buyer='local-key';
    const local=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{order:JSON.stringify(localBatch)}}});
    expect(local.json().data.status).toBe('PASS');
  });

  it('accepts a 100-record customer sample at the original record bound',async()=>{
    const records=Array.from({length:100},(_,i)=>({event_id:`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`,source_pk:`customer-${i}`,source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'Acme',rep:'rep-a',team:'team-a',state:'ACTIVE'}}));
    const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'60000000-0000-4000-8000-000000000001',records});
    const response=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers:{authorization:'Bearer owner'},payload:{expected_revision:'1',samples:{customer:sample}}});
    expect(response.statusCode).toBe(202); expect(response.json().data.status).toBe('PASS');
  });

  it('activates self-contained customer and order samples without preexisting canonical customer',async()=>{
    const source='bootstrap-i1',headers={authorization:'Bearer owner'};
    const created=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{source_id:source,data_owner_user_id:'owner',config:{name:'bootstrap',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer','order'],delete_contract:'tombstone'}}});
    expect(created.statusCode).toBe(201);
    const customerMaps=[['display','customer_name','trim'],['rep','owner_user_id','source-id'],['team','dept_id','source-id'],['state','status','identity']].map(([source_field,target_field,transform])=>({entity:'customer',source_field,target_field,transform}));
    const orderMaps=[['buyer','customer_id','source-id'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
    expect((await app.inject({method:'PUT',url:`/hub/v1/admin/sources/${source}/mappings`,headers,payload:{expected_revision:'1',mappings:[...customerMaps,...orderMaps]}})).statusCode).toBe(200);
    for(const [kind,external,target,revision] of [['user','bootstrap-user','owner','0'],['department','bootstrap-dept','dept1','1']]) {
      const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${external}`,headers});
      expect((await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:revision,target_id:target,reason:'confirmed'}})).statusCode).toBe(200);
    }
    const record=(event_id:string,source_pk:string,data:unknown)=>({event_id,source_pk,source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data});
    const batch=(recordValue:unknown)=>JSON.stringify({schema_version:'hub.v1',batch_id:'70000000-0000-4000-8000-000000000001',records:[recordValue]});
    const customer=batch(record('70000000-0000-4000-8000-000000000002','cust-new',{display:'New',rep:'bootstrap-user',team:'bootstrap-dept',state:'ACTIVE'}));
    const order=(buyer:string)=>batch(record('70000000-0000-4000-8000-000000000003','ord-new',{buyer,number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}));
    const run=(buyer:string)=>app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer,order:order(buyer)}}});
    const before=await fixture.pool.query<{customers:number;orders:number}>(`SELECT (SELECT count(*)::int FROM hub.canonical_customer) customers,(SELECT count(*)::int FROM hub.canonical_order) orders`);
    expect((await run('missing-customer')).json().data.status).toBe('FAIL');
    const tested=await run('cust-new');expect(tested.json().data.status).toBe('PASS');
    const report=tested.json().data;
    const approval=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
    expect(approval.statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approval.json().data.approval_id}})).statusCode).toBe(200);
    const channels=await fixture.pool.query("SELECT entity FROM control.source_channel WHERE tenant_key='tenant_i1' AND source_id=$1 AND state='active' ORDER BY entity",[source]);
    expect(channels.rows).toEqual([{entity:'customer'},{entity:'order'}]);
    const after=await fixture.pool.query<{customers:number;orders:number}>(`SELECT (SELECT count(*)::int FROM hub.canonical_customer) customers,(SELECT count(*)::int FROM hub.canonical_order) orders`);
    expect(after.rows).toEqual(before.rows);
  });

  it('acquires the source fence before locking tenant during disable',async()=>{
    await ownerAuth.repository.provisionTenant({tenantId:'race_tenant',businessTimezone:'UTC'});
    const fence=await fixture.pool.connect(), observer=await fixture.pool.connect();
    try {
      await fence.query('BEGIN'); await fence.query('SELECT control.lock_security_barrier_fence()');
      const disabling=ownerAuth.repository.setTenantEnabled('race_tenant',false);
      await new Promise(resolve=>setTimeout(resolve,100));
      await observer.query('BEGIN'); await observer.query("SET LOCAL lock_timeout='300ms'");
      let error:unknown;
      try { await observer.query("SELECT 1 FROM control.tenant WHERE tenant_key='race_tenant' FOR UPDATE"); } catch(caught) {error=caught;}
      await observer.query('ROLLBACK'); await fence.query('COMMIT'); await disabling;
      expect(error).toBeUndefined();
    } finally {await fence.query('ROLLBACK').catch(()=>{});await observer.query('ROLLBACK').catch(()=>{});fence.release();observer.release();}
  });
  it('waits for mapped target disable and does not record a passing sample for a revoked target',async()=>{
    await ownerAuth.repository.provisionSubject({tenantId:'tenant_i1',userId:'sample-target',departmentId:'dept1'});
    const headers={authorization:'Bearer owner'};
    const candidate=await app.inject({method:'GET',url:'/hub/v1/admin/identity-mappings?source_id=import-one&kind=user&external_id=rep-a',headers});
    const confirm=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'2',target_id:'sample-target',reason:'confirmed'}});
    expect(confirm.statusCode).toBe(200);
    const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'30000000-0000-4000-8000-000000000001',records:[{event_id:'30000000-0000-4000-8000-000000000002',source_pk:'c',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'Acme',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]});
    const changing=await fixture.pool.connect();
    try {
      await changing.query('BEGIN'); await changing.query("UPDATE control.auth_subject SET enabled=false WHERE tenant_key='tenant_i1' AND user_id='sample-target'");
      const testing=app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:{expected_revision:'1',samples:{customer:sample}}});
      const early=await Promise.race([testing.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),200))]);
      await changing.query('COMMIT'); const result=await testing;
      expect(early).toBe(false); expect(result.json().data.status).toBe('FAIL');
    } finally {await changing.query('ROLLBACK').catch(()=>{});changing.release();}
  });

  it('serializes sample tests and mapping edits in source-fence order',async()=>{
    let entered!:()=>void,release!:()=>void;
    const locked=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    pauseMapping=async()=>{entered();await gate;};
    const headers={authorization:'Bearer owner'};
    const maps=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
    const edit=app.inject({method:'PUT',url:'/hub/v1/admin/sources/import-one/mappings',headers,payload:{expected_revision:'3',mappings:maps}});
    await locked;
    const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'40000000-0000-4000-8000-000000000001',records:[{event_id:'40000000-0000-4000-8000-000000000002',source_pk:'c',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'x',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]});
    const testing=app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:{expected_revision:'1',samples:{customer:sample}}});
    await new Promise(resolve=>setTimeout(resolve,100)); release();
    const [changed,result]=await Promise.all([edit,testing]);
    expect(changed.statusCode).toBe(200); expect(result.statusCode).toBe(202);
    expect(result.json().data.status).toBe('FAIL');
  });
  it('retains external secret on a rejected NULL replacement',async()=>{
    const credential=createCredential();
    await ownerAuth.repository.provisionSourceCredential({sourceId:'external-null-test',tenantId:'tenant_i1',token:credential.secret,secretRef:'vault:/valid',allowedEntities:['customer'],revision:'1'});
    await expect(fixture.pool.query('SELECT control.update_source_credential($1,$2,$3,$4,$5,$6,$7)', ['external-null-test','tenant_i1',true,'1',['customer'],null,true])).rejects.toThrow();
    const row=await fixture.pool.query("SELECT secret_ref FROM control.source_credential WHERE tenant_key='tenant_i1' AND source_id='external-null-test'");
    expect(row.rows[0].secret_ref).toBe('vault:/valid');
  });
  it('upgrades a populated 009 database and replays 010 without changing existing authority',async()=>{
    const root=fixtureEvidenceRootFromEnvironment()!;
    const dir=join(root,`through009-${randomUUID()}`); await mkdir(dir,{recursive:true});
    const migrations=fileURLToPath(new URL('../migrations/',import.meta.url));
    const files=await readdir(migrations);
    for(const file of files) if(/^00[1-5]_.*\.sql$/.test(file)) await copyFile(join(migrations,file),join(dir,file));
    const upgrade=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
    try {
      await runMigrations(upgrade.pool,{directory:dir,environmentKind:'local_lab'});
      const auth=createAuthService({pool:upgrade.pool});
      await auth.repository.provisionTenant({tenantId:'legacy_i1',businessTimezone:'UTC'});
      await auth.repository.provisionSubject({tenantId:'legacy_i1',userId:'legacy'});
      await auth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'legacy',tenantId:'legacy_i1',userId:'legacy'});
      await expect(auth.resolveOidc('https://idp.example.test','legacy')).resolves.toMatchObject({tenantId:'legacy_i1'});
      for(const file of files) if(/^00[6-9]_.*\.sql$/.test(file)) await copyFile(join(migrations,file),join(dir,file));
      await runMigrations(upgrade.pool,{directory:dir,environmentKind:'local_lab'});
      await auth.repository.provisionTenant({tenantId:'upgrade_i1',businessTimezone:'UTC'});
      const secret=createCredential().secret;
      await auth.repository.provisionSourceCredential({sourceId:'ext',tenantId:'upgrade_i1',token:secret,secretRef:'vault:/old',allowedEntities:['customer'],revision:'1'});
      const before=await upgrade.pool.query("SELECT id,revision,source_epoch,credential_generation,secret_ref FROM control.source_credential WHERE tenant_key='upgrade_i1'");
      expect((await runMigrations(upgrade.pool,{directory:migrations,environmentKind:'local_lab'})).applied).toEqual(['010_simulated_import']);
      const after=await upgrade.pool.query("SELECT id,revision,source_epoch,credential_generation,secret_ref FROM control.source_credential WHERE tenant_key='upgrade_i1'");
      expect(after.rows).toEqual(before.rows);
      expect((await runMigrations(upgrade.pool,{directory:migrations,environmentKind:'local_lab'})).skipped).toContain('010_simulated_import');
      await expect(auth.authenticateSourceIdentity(secret)).resolves.toMatchObject({tenantId:'upgrade_i1',sourceId:'ext'});
    } finally {await upgrade.close();}
  },90000);

  it('rejects a sample when its designated Owner is no longer current',async()=>{
    await ownerAuth.repository.provisionSubject({tenantId:'tenant_i1',userId:'delegated-owner',managementScopes:['source:approve']});
    const headers={authorization:'Bearer owner'};
    const created=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{source_id:'delegated',data_owner_user_id:'delegated-owner',config:{name:'delegated',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}}});
    expect(created.statusCode).toBe(201);
    await ownerAuth.repository.updateSubject({tenantId:'tenant_i1',userId:'delegated-owner',managementScopes:['source:approve'],enabled:false});
    const test=await app.inject({method:'POST',url:'/hub/v1/admin/sources/delegated/test',headers,payload:{expected_revision:'1',samples:{customer:'{}'}}});
    expect(test.statusCode).toBe(403);
  });
  it('enforces exact import request-byte bounds and 1\u2013100 record sample bounds',async()=>{
    const headers={authorization:'Bearer owner','content-type':'application/json'};
    const prefix='{"expected_revision":"1","samples":{"customer":"',suffix='"}}';
    const payload=(bytes:number)=>prefix+'x'.repeat(bytes-Buffer.byteLength(prefix+suffix))+suffix;
    const at=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:payload(4*1024*1024)});
    expect(at.statusCode).toBe(202); expect(at.json().data.status).toBe('FAIL');
    const over=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:payload(4*1024*1024+1)});
    expect(over.statusCode).toBe(413);
    for(const n of [0,101]) {
      const sample=JSON.stringify({schema_version:'hub.v1',batch_id:'50000000-0000-4000-8000-000000000001',records:Array(n).fill({})});
      const response=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers,payload:JSON.stringify({expected_revision:'1',samples:{customer:sample}})});
      expect(response.statusCode).toBe(202); expect(response.json().data.status).toBe('FAIL');
    }
  });

  it('serializes an identity rebind against an import principal without deadlock',async()=>{
    const client=await fixture.pool.connect(); let entered!:()=>void,release!:()=>void;
    const locked=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const original=client.query.bind(client);
    const wrapped=new Proxy(client,{get(target,key){
      if(key==='query') return async (sql:unknown,...args:unknown[])=>{
        const result=await (original as (...values:unknown[])=>Promise<unknown>)(sql,...args);
        if(typeof sql==='string' && sql.includes('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE')) {entered();await gate;}
        return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    try {
      await client.query('BEGIN');
      const rebind=ownerAuth.repository.bindIdentity({issuer:'https://idp.example.test',subject:'owner-i1',tenantId:'tenant_i1',userId:'owner'},wrapped);
      await locked;
      const read=app.inject({method:'GET',url:'/hub/v1/admin/sources/import-one',headers:{authorization:'Bearer owner'}});
      await new Promise(resolve=>setTimeout(resolve,200)); release();
      await rebind; await client.query('COMMIT');
      expect((await read).statusCode).toBe(200);
    } finally {release();await client.query('ROLLBACK').catch(()=>{});client.release();}
  },15000);

  it('routes and confirms a typed mapping for a maximum-length source ID without accepting malformed IDs',async()=>{
    const source='s'.repeat(256),headers={authorization:'Bearer owner'};
    const created=await app.inject({method:'POST',url:'/hub/v1/admin/sources',headers,payload:{source_id:source,data_owner_user_id:'owner',config:{name:'long',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}}});
    expect(created.statusCode).toBe(201);
    const customer=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('tenant_i1','Long route','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,4) RETURNING id`);
    const key='c:'+createHash('sha256').update(JSON.stringify(['foreign-source','foreign-key'])).digest('base64url');
    const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=customer&external_id=${key}`,headers});
    expect(candidate.statusCode).toBe(200);
    const confirmation=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:'0',target_id:customer.rows[0].id,reason:'confirmed'}});
    expect(confirmation.statusCode).toBe(200);
    const malformed=await app.inject({method:'PUT',url:'/hub/v1/admin/identity-mappings/%25%25%25',headers,payload:{expected_revision:'1',target_id:'owner',reason:'bad'}});
    expect(malformed.statusCode).toBe(400);
    const longExternal=Buffer.from(`${source}\0user\0${'x'.repeat(129)}`).toString('base64url');
    const invalid=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${longExternal}`,headers,payload:{expected_revision:'1',target_id:'owner',reason:'bad'}});
    expect(invalid.statusCode).toBe(400);
    const over=await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${'x'.repeat(2049)}`,headers,payload:{expected_revision:'1',target_id:'owner',reason:'bad'}});
    expect(over.statusCode).not.toBe(200);
  });

  it('rejects wrong tenant, unprivileged approval, oversized payload and revoked owner',async()=>{
    const foreign=await app.inject({method:'GET',url:'/hub/v1/admin/sources/import-one',headers:{authorization:'Bearer other'}});
    expect(foreign.statusCode).not.toBe(200);
    const unauthorized=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/approve',headers:{authorization:'Bearer viewer'},payload:{revision:'1',test_report_id:'10000000-0000-4000-8000-000000000001',data_contract_ref:'fake'}});
    expect(unauthorized.statusCode).toBe(403);
    const oversized=await app.inject({method:'POST',url:'/hub/v1/admin/sources/import-one/test',headers:{authorization:'Bearer owner'},payload:{expected_revision:'1',samples:{customer:'x'.repeat(4*1024*1024)}}});
    expect(oversized.statusCode).toBe(413);
    await ownerAuth.repository.updateSubject({tenantId:'tenant_i1',userId:'owner',departmentId:'dept1',managementScopes:['source:read','source:write','source:approve','mapping:write'],enabled:false});
    const revoked=await app.inject({method:'PUT',url:'/hub/v1/admin/sources/import-one/mappings',headers:{authorization:'Bearer owner'},payload:{expected_revision:'3',mappings:[]}});
    expect(revoked.statusCode).not.toBe(200);
  });

});
