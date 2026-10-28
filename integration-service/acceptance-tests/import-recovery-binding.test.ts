import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { buildApp } from '../app.js';
import type { createAuthService } from '../auth/service.js';
import type { createOidcAuthenticator } from '../auth/oidc.js';
import type { createSourceRegistryService } from '../source-registry/service.js';
import { createCredential } from '../auth/credentials.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import type { OwnedPostgres } from './helpers/postgres.js';
import { setupImportRecoveryFixture, tenant, source, sample } from './helpers/import-recovery-fixture.js';
import type { UserPrincipal } from '../auth/types.js';

let fixture:OwnedPostgres, app:Awaited<ReturnType<typeof buildApp>>, jwks:Server;
let auth:ReturnType<typeof createAuthService>, principal:UserPrincipal, viewer:UserPrincipal, other:UserPrincipal, token:string;
let authenticator:ReturnType<typeof createOidcAuthenticator>, sourceService:ReturnType<typeof createSourceRegistryService>;
let partialId:string, quarantineId:string;

beforeAll(async()=>{
 ({fixture,app,jwks,auth,principal,viewer,other,token,authenticator,sourceService,partialId,quarantineId}=await setupImportRecoveryFixture('binding'));
},90000);
afterAll(async()=>{if(app) await app.close();if(jwks) await new Promise<void>(resolve=>jwks.close(()=>resolve()));if(fixture) await fixture.close();});

it('builds a separately approved binding plan after mapping confirmation and retest',async()=>{
 const headers={authorization:`Bearer ${token}`};
 for(const [kind,external,target,revision] of [['user','rep-missing','owner','2'],['department','team-missing','dept1','3']]) {
  const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${external}`,headers});expect(candidate.statusCode).toBe(200);
  expect((await app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,headers,payload:{expected_revision:revision,target_id:target,reason:'confirmed'}})).statusCode).toBe(200);
 }
 expect((await plan()).kind).toBe('UNAVAILABLE');
 const tested=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});expect(tested.json().data.status).toBe('PASS');
 const report=tested.json().data;
 const approved=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});expect(approved.statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
 const mod=await import('../ingestion-api/import-recovery-plan.js');
 const binding=(mod as Record<string,any>).readImportRecoveryBindingPlan;
 expect(binding).toBeTypeOf('function');
 const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
  const original=await mod.readImportRecoveryCandidate(client,auth,principal,quarantineId);expect(original.kind).toBe('ELIGIBLE');if(original.kind!=='ELIGIBLE') return;
  const plan=await binding(client,auth,principal,quarantineId,{expectedSourceRevision:original.current.sourceRevision,identityMappingRevision:original.current.identityMappingRevision,identityMappingDigest:original.current.identityMappingDigest,bindings:[{kind:'user',externalId:'rep-missing',targetId:'owner'},{kind:'department',externalId:'team-missing',targetId:'dept1'}]});
  expect(plan.kind).toBe('ELIGIBLE');expect(plan.original).toEqual(original.original);expect(plan.confirmedBindings).toEqual([{kind:'user',externalId:'rep-missing',targetId:'owner'},{kind:'department',externalId:'team-missing',targetId:'dept1'}]);expect(plan.bindingProof.approvalId).toBe(approved.json().data.approval_id);expect(plan.bindingProof.approvalId).not.toBe(plan.original.proof.approvalId);expect(plan.bindingProof.identityMappingRevision).toBe(original.current.identityMappingRevision);expect(plan.bindingProof.identityMappingDigest).toBe(original.current.identityMappingDigest);expect(plan.bindingProof.securityFence).toBe(plan.observedFence);expect(plan.bindingProof.sampleDigest).toMatch(/^[0-9a-f]{64}$/);expect(plan.ownObjectId).toBeNull();
 } finally {await client.query('ROLLBACK');client.release();}

});

async function plan(id=quarantineId, who=principal, change?: (client:pg.PoolClient)=>Promise<void>, transform?: (input:any)=>any) {
 const mod=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');if(change) await change(client);await client.query('SET LOCAL ROLE hub_api');
  const state=(await fixture.pool.query<{source_revision:string;mapping_revision:string;mapping_digest:string}>(`SELECT r.current_config_revision::text AS source_revision,r.identity_mapping_revision::text AS mapping_revision,encode(i.mapping_digest,'hex') AS mapping_digest FROM control.source_registry r JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision) WHERE r.tenant_key=$1 AND r.source_id=$2`,[tenant,source])).rows[0]!;
  const input={expectedSourceRevision:state.source_revision,identityMappingRevision:state.mapping_revision,identityMappingDigest:state.mapping_digest,bindings:id===partialId?[{kind:'department',externalId:'team-missing',targetId:'dept1'}]:[{kind:'user',externalId:'rep-missing',targetId:'owner'},{kind:'department',externalId:'team-missing',targetId:'dept1'}]};
  return await mod.readImportRecoveryBindingPlan(client,auth,who,id,transform?transform(input):input);
 } finally {await client.query('ROLLBACK');client.release();}
}
it('preserves an originally resolved pair and confirms only the missing text department',async()=>{
 const result=await plan(partialId);expect(result.kind).toBe('ELIGIBLE');if(result.kind==='ELIGIBLE') {expect(result.resolved).toEqual([{kind:'user',externalId:'rep-a',targetId:'owner'}]);expect(result.confirmedBindings).toEqual([{kind:'department',externalId:'team-missing',targetId:'dept1'}]);}
});
it('rejects malformed, duplicate, stale and extraneous binding requests',async()=>{
 for(const transform of [(x:any)=>({...x,expectedSourceRevision:'01'}),(x:any)=>({...x,identityMappingRevision:'9223372036854775808'}),(x:any)=>({...x,identityMappingDigest:'A'.repeat(64)}),(x:any)=>({...x,extra:true}),(x:any)=>({...x,bindings:[x.bindings[0],x.bindings[0]]}),(x:any)=>({...x,bindings:[{...x.bindings[0],extra:true}]})]) await expect(plan(quarantineId,principal,undefined,transform)).rejects.toMatchObject({code:'AUTH_INPUT_INVALID'});
 for(const transform of [(x:any)=>({...x,expectedSourceRevision:'2'}),(x:any)=>({...x,identityMappingRevision:'1'}),(x:any)=>({...x,identityMappingDigest:'a'.repeat(64)}),(x:any)=>({...x,bindings:[x.bindings[0]]}),(x:any)=>({...x,bindings:[x.bindings[0],{kind:'department',externalId:'wrong',targetId:'dept1'}]}),(x:any)=>({...x,bindings:[x.bindings[0],{...x.bindings[1],targetId:'wrong'}]})]) expect((await plan(quarantineId,principal,undefined,transform)).kind).toBe('UNAVAILABLE');
 expect((await plan(partialId,principal,undefined,x=>({...x,bindings:[...x.bindings,{kind:'user',externalId:'rep-a',targetId:'owner'}]}))).kind).toBe('UNAVAILABLE');
});
it('uses separate current Owner read and approve scopes',async()=>{
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read']});
 let who=await auth.resolveOidc(principal.issuer,principal.subject);
 const client=await fixture.pool.connect();try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');expect((await readImportRecoveryCandidate(client,auth,who,quarantineId)).kind).toBe('ELIGIBLE');} finally {await client.query('ROLLBACK');client.release();}
 await expect(plan(quarantineId,who)).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:approve']});who=await auth.resolveOidc(principal.issuer,principal.subject);
 expect((await plan(quarantineId,who)).kind).toBe('ELIGIBLE');
 const c=await fixture.pool.connect();try {await c.query('BEGIN');await c.query('SET LOCAL ROLE hub_api');const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');await expect(readImportRecoveryCandidate(c,auth,who,quarantineId)).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});} finally {await c.query('ROLLBACK');c.release();}
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write']});principal=await auth.resolveOidc(principal.issuer,principal.subject);
 await expect(plan(quarantineId,viewer)).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});await expect(plan(quarantineId,other)).rejects.toMatchObject({code:'SOURCE_NOT_FOUND'});
});
it('rejects agent and source principals',async()=>{
 const agent=await auth.createAgentCredential(principal,{purpose:'binding test'},'i3p2-agent');const actor=await auth.authenticateAgent(agent.secret!);
 await expect(plan(quarantineId,actor)).rejects.toMatchObject({code:'AUTH_INVALID'});
 const secret=createCredential().secret;await auth.repository.provisionSourceCredential({tenantId:tenant,sourceId:'external-binding',token:secret,secretRef:'vault:/fixture',allowedEntities:['customer'],revision:'1'});
 const sourcePrincipal=await auth.authenticateSourceIdentity(secret);await expect(plan(quarantineId,sourcePrincipal as unknown as UserPrincipal)).rejects.toMatchObject({code:'AUTH_INVALID'});
});
it('rejects private helper and worker invocation',async()=>{
 const client=await fixture.pool.connect();try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');await expect(client.query('SELECT control.import_recovery_authorize_internal($1,$2::uuid,$3,$4,$5,$6::bigint,$7)',[tenant,quarantineId,principal.userId,principal.issuer,principal.subject,principal.authEpoch,'source:approve'])).rejects.toMatchObject({code:'42501'});await client.query('ROLLBACK');await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_worker');await expect(client.query('SELECT control.read_import_recovery_for_approval($1,$2::uuid,$3,$4,$5,$6::bigint)',[tenant,quarantineId,principal.userId,principal.issuer,principal.subject,principal.authEpoch])).rejects.toMatchObject({code:'42501'});}finally{await client.query('ROLLBACK');client.release();}
});
it('fails closed on changed target eligibility and the original security barrier',async()=>{
 expect((await plan(quarantineId,principal,async c=>{await c.query(`UPDATE control.auth_subject SET department_id='other' WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);})).kind).toBe('UNAVAILABLE');
 expect((await plan(quarantineId,principal,async c=>{await c.query(`INSERT INTO control.source_security_barrier(tenant_key,source_id,credential_id,barrier_type,reason_code,created_by) SELECT tenant_key,source_id,credential_id,'CREDENTIAL_COMPROMISE','SYNTHETIC_TEST','fixture' FROM control.ingestion_job WHERE id=(SELECT job_id FROM control.ingestion_quarantine_index WHERE quarantine_id=$1)`,[quarantineId]);})).kind).toBe('UNAVAILABLE');
});
it('rejects remapping an originally resolved key even after current approval',async()=>{
 expect((await plan(partialId,principal,async c=>{
  await c.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision) SELECT tenant_key,source_id,'user','rep-a',identity_mapping_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2 ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision`,[tenant,source]);
 })).kind).toBe('UNAVAILABLE');
});
it('does not reserve or persist anything when reading a plan',async()=>{
 const tables=['control.canonical_source_identity','control.ingestion_job','control.ingestion_job_item','control.ingestion_processing_outbox','control.ingestion_management_admission_audit','control.ingestion_recovery_operation','hub.canonical_customer','hub.canonical_order','raw.ingestion_batch'];
 const snapshot=async()=>Promise.all(tables.map(async table=>(await fixture.pool.query(`SELECT count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${table} t`)).rows[0]));
 const before=await snapshot();expect((await plan()).kind).toBe('ELIGIBLE');expect(await snapshot()).toEqual(before);
 expect((await fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND source_pk='missing'`,[tenant,source])).rowCount).toBe(0);
});
it('rejects a remap fence newer than the current binding revision',async()=>{
 expect((await plan(quarantineId,principal,async c=>{
  await c.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by) SELECT tenant_key,source_id,identity_mapping_revision+1,decode(repeat('ab',32),'hex'),'[]'::jsonb,'fixture' FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
  await c.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision) SELECT tenant_key,source_id,'user','rep-missing',identity_mapping_revision+1 FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2 ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision`,[tenant,source]);
 })).kind).toBe('UNAVAILABLE');
});
it('keeps P1 readable after a real source edit but refuses an untested current plan',async()=>{
 await sourceService.update(principal,source,{expected_revision:'1',config:{name:'Changed',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}});
 const client=await fixture.pool.connect();try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');expect((await readImportRecoveryCandidate(client,auth,principal,quarantineId)).kind).toBe('ELIGIBLE');}finally{await client.query('ROLLBACK');client.release();}
 expect((await plan()).kind).toBe('UNAVAILABLE');
});

it.each([['ordinary','missing-ref'],['escaped-unicode','ref\"\\\u4e2d\ud83d\ude00\u2028\u2029end']])('binds an order with a %s foreign customer key after a new approval',async(label,missingPk)=>{
 const samplePk=`sample-ref-${label}`,src=`order-binding-${label}`,headers={authorization:`Bearer ${token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 expect((await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Orders',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const fields=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings:fields})).statusCode).toBe(200);
 const ids:string[]=[];for(const pk of [samplePk,missingPk]) {
  const customer=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES($1,'Existing','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id::text`,[tenant]);ids.push(customer.rows[0]!.id);
  await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES($1,$2,'customer',$3,$4,$4)`,[tenant,source,pk,ids.at(-1)]);
 }
 const key=(pk:string)=>customerReferenceMappingKey(source,pk);
 await sourceService.writeIdentityMappings(principal,src,[{kind:'customer',external_id:key(samplePk),target_id:ids[0]}]);
 const record=(pk:string,event:string)=>({event_id:event,source_pk:`order-${pk}`,source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:pk},number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}});
 const body={schema_version:'hub.v1',batch_id:'73000000-0000-4000-8000-000000000010',records:[record(samplePk,'73000000-0000-4000-8000-000000000001')]};
 async function approve() {const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{order:JSON.stringify(body)}});expect(tested.json().data.status).toBe('PASS');const report=tested.json().data;const approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approved.statusCode).toBe(200);expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);return approved.json().data.approval_id as string;}
 await approve();
 const admitted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'order-origin'},payload:JSON.stringify({...body,batch_id:'73000000-0000-4000-8000-000000000011',records:[record(missingPk,'73000000-0000-4000-8000-000000000002')]})});expect(admitted.statusCode).toBe(202);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});try{await runDurableWorkerOnce(worker);}finally{await worker.end();}
 const q=(await fixture.pool.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1`,[admitted.json().data.job_id])).rows[0]!.id;
 const get=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${src}&kind=customer&external_id=${encodeURIComponent(key(missingPk))}`,headers});expect(get.statusCode).toBe(200);
 expect((await call('PUT',`/hub/v1/admin/identity-mappings/${get.json().data.id}`,{expected_revision:'1',target_id:ids[1],reason:'confirmed'})).statusCode).toBe(200);
 const approval=await approve();
 const mod=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');const original=await mod.readImportRecoveryCandidate(client,auth,principal,q);expect(original.kind).toBe('ELIGIBLE');if(original.kind!=='ELIGIBLE') return;
  const binding={kind:'customer' as const,sourceId:source,sourcePk:missingPk,externalId:key(missingPk),targetId:ids[1]!};const input={expectedSourceRevision:original.current.sourceRevision,identityMappingRevision:original.current.identityMappingRevision,identityMappingDigest:original.current.identityMappingDigest,bindings:[binding]};
  const result=await mod.readImportRecoveryBindingPlan(client,auth,principal,q,input);expect(result.kind).toBe('ELIGIBLE');if(result.kind==='ELIGIBLE'){expect(result.original).toEqual(original.original);expect(result.confirmedBindings).toEqual([binding]);expect(result.bindingProof.approvalId).toBe(approval);expect(result.ownObjectId).toBeNull();}
  expect((await mod.readImportRecoveryBindingPlan(client,auth,principal,q,{...input,bindings:[{...binding,targetId:ids[0]!}]})).kind).toBe('UNAVAILABLE');
  const cross=(await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision) VALUES('i3p1_other','Other','other','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id::text`)).rows[0]!.id;
  expect((await mod.readImportRecoveryBindingPlan(client,auth,principal,q,{...input,bindings:[{...binding,targetId:cross}]})).kind).toBe('UNAVAILABLE');
 } finally {await client.query('ROLLBACK');client.release();}
 const verify=await fixture.pool.connect();
 try {await verify.query('BEGIN');await verify.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by) SELECT tenant_key,source_id,identity_mapping_revision+1,decode(repeat('ab',32),'hex'),'[]'::jsonb,'fixture' FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2`,[tenant,src]);await verify.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision) SELECT tenant_key,source_id,'customer',$3,identity_mapping_revision+1 FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2 ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision`,[tenant,src,key(missingPk)]);await verify.query('SET LOCAL ROLE hub_api');
  const original=await mod.readImportRecoveryCandidate(verify,auth,principal,q);expect(original.kind).toBe('ELIGIBLE');if(original.kind==='ELIGIBLE'){const binding={kind:'customer' as const,sourceId:source,sourcePk:missingPk,externalId:key(missingPk),targetId:ids[1]!};expect((await mod.readImportRecoveryBindingPlan(verify,auth,principal,q,{expectedSourceRevision:original.current.sourceRevision,identityMappingRevision:original.current.identityMappingRevision,identityMappingDigest:original.current.identityMappingDigest,bindings:[binding]})).kind).toBe('UNAVAILABLE');}
 } finally {await verify.query('ROLLBACK');verify.release();}
 const deleted=await fixture.pool.connect();try {await deleted.query('BEGIN');await deleted.query(`UPDATE hub.canonical_customer SET deleted_at=now() WHERE tenant_id=$1 AND id=$2`,[tenant,ids[1]]);const state=(await deleted.query<{revision:string;identity:string;digest:string}>(`SELECT r.current_config_revision::text AS revision,r.identity_mapping_revision::text AS identity,encode(i.mapping_digest,'hex') AS digest FROM control.source_registry r JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision) WHERE r.tenant_key=$1 AND r.source_id=$2`,[tenant,src])).rows[0]!;await deleted.query('SET LOCAL ROLE hub_api');expect((await mod.readImportRecoveryBindingPlan(deleted,auth,principal,q,{expectedSourceRevision:state.revision,identityMappingRevision:state.identity,identityMappingDigest:state.digest,bindings:[{kind:'customer',sourceId:source,sourcePk:missingPk,externalId:key(missingPk),targetId:ids[1]!}]})).kind).toBe('UNAVAILABLE');}finally{await deleted.query('ROLLBACK');deleted.release();}
 expect((await fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='order' AND source_pk=$3`,[tenant,src,`order-${missingPk}`])).rowCount).toBe(0);
});
