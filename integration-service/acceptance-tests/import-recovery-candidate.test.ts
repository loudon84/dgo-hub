import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createOidcAuthenticator } from '../auth/oidc.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { createCredential } from '../auth/credentials.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import type { UserPrincipal } from '../auth/types.js';

let fixture: OwnedPostgres, app: Awaited<ReturnType<typeof buildApp>>, jwks: Server;
let auth: ReturnType<typeof createAuthService>, principal: UserPrincipal, viewer: UserPrincipal, other: UserPrincipal, token: string;
let authenticator: ReturnType<typeof createOidcAuthenticator>;
let sourceService:ReturnType<typeof createSourceRegistryService>;
let partialId:string;
const tenant='i3p1_tenant', source='candidate-source';
const sample={schema_version:'hub.v1',batch_id:'61000000-0000-4000-8000-000000000001',records:[{event_id:'61000000-0000-4000-8000-000000000002',source_pk:'sample',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'Acme',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]};
let quarantineId:string;

beforeAll(async()=>{
 const root=fixtureEvidenceRootFromEnvironment(); if(!root) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
 fixture=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
 const migrations=fileURLToPath(new URL('../migrations/',import.meta.url)), dir=join(root,'migrations');
 await mkdir(dir,{recursive:true});
 for(const name of await readdir(migrations)) if(/^\d{3}_.+\.sql$/.test(name) && !name.startsWith('013_')) await copyFile(join(migrations,name),join(dir,name));
 await writeFile(join(dir,'009_snapshot_runs_and_recovery.sql'),execFileSync('git',['show','HEAD:integration-service/migrations/009_snapshot_runs_and_recovery.sql']));
 await runMigrations(fixture.pool,{directory:dir,environmentKind:'local_lab'});
 auth=createAuthService({pool:fixture.pool});
 const keys=await generateKeyPair('RS256',{modulusLength:2048});
 const jwk={...await exportJWK(keys.publicKey),kid:'i3p1',alg:'RS256',use:'sig'};
 jwks=createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]})));
 await new Promise<void>((resolve,reject)=>{jwks.once('error',reject);jwks.listen(0,'127.0.0.1',resolve);});
 const address=jwks.address(); if(!address || typeof address==='string') throw new Error('JWKS_ADDRESS');
 const issuer=`http://127.0.0.1:${address.port}/issuer`,audience='i3p1';
 await auth.repository.provisionTenant({tenantId:tenant,businessTimezone:'UTC'});
 await auth.repository.provisionSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write']});
 await auth.repository.bindIdentity({issuer,subject:'owner',tenantId:tenant,userId:'owner'});
 token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'i3p1'}).setIssuer(issuer).setAudience(audience).setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
 authenticator=createOidcAuthenticator({issuer,audience,jwksUrl:`http://127.0.0.1:${address.port}/jwks`,environmentKind:'local_lab',allowLoopbackHttp:true},auth);
 principal=await authenticator(token);
 await auth.repository.provisionSubject({tenantId:tenant,userId:'viewer',managementScopes:['source:read']});
 await auth.repository.bindIdentity({issuer,subject:'viewer',tenantId:tenant,userId:'viewer'});
 await auth.repository.provisionTenant({tenantId:'i3p1_other',businessTimezone:'UTC'});
 await auth.repository.provisionSubject({tenantId:'i3p1_other',userId:'other',managementScopes:['source:read']});
 await auth.repository.bindIdentity({issuer,subject:'other',tenantId:'i3p1_other',userId:'other'});
 viewer=await auth.resolveOidc(issuer,'viewer');other=await auth.resolveOidc(issuer,'other');
 const rolePool=new Proxy(fixture.pool,{get(target,property){
  if(property==='connect') return async()=>{const client=await target.connect(),query=client.query.bind(client);return {query:(async(sql:unknown,...args:unknown[])=>{const result=await (query as (...v:unknown[])=>Promise<unknown>)(sql,...args);if(typeof sql==='string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) await query('SET LOCAL ROLE hub_api');return result;}) as typeof client.query,release:client.release.bind(client)};};
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 sourceService=createSourceRegistryService({pool:rolePool,auth,secretResolver:failClosedSecretResolver,endpointAllowlist:failClosedEndpointAllowlist,capabilityProbe:failClosedCapabilityProbe});
 app=await buildApp({logger:false,sourceRegistry:{authService:auth,sourceService,authenticator},strictIngestion:{pool:rolePool,authService:auth,authenticator,rawStoragePolicy:'local_lab_fixture'}});
 const headers={authorization:`Bearer ${token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 expect((await call('POST','/hub/v1/admin/sources',{source_id:source,data_owner_user_id:'owner',config:{name:'Candidate',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const mappings=[{entity:'customer',source_field:'display',target_field:'customer_name',transform:'trim'},{entity:'customer',source_field:'rep',target_field:'owner_user_id',transform:'source-id'},{entity:'customer',source_field:'team',target_field:'dept_id',transform:'source-id'},{entity:'customer',source_field:'state',target_field:'status',transform:'identity'}];
 expect((await call('PUT',`/hub/v1/admin/sources/${source}/mappings`,{expected_revision:'1',mappings})).statusCode).toBe(200);
 for(const [kind,external,target,revision] of [['user','rep-a','owner','0'],['department','team-a','dept1','1']]) {
  const candidate=await app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=${kind}&external_id=${external}`,headers});expect(candidate.statusCode).toBe(200);
  expect((await call('PUT',`/hub/v1/admin/identity-mappings/${candidate.json().data.id}`,{expected_revision:revision,target_id:target,reason:'confirmed'})).statusCode).toBe(200);
 }
 const tested=await call('POST',`/hub/v1/admin/sources/${source}/test`,{expected_revision:'1',samples:{customer:JSON.stringify(sample)}});expect(tested.json().data.status).toBe('PASS');
 const report=tested.json().data,approved=await call('POST',`/hub/v1/admin/sources/${source}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approved.statusCode).toBe(200);
 expect((await call('POST',`/hub/v1/admin/sources/${source}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);
 const missing=structuredClone(sample);missing.batch_id='61000000-0000-4000-8000-000000000003';missing.records[0]!.event_id='61000000-0000-4000-8000-000000000004';missing.records[0]!.source_pk='missing';missing.records[0]!.data.rep='rep-missing';missing.records[0]!.data.team='team-missing';
 missing.records.push({...structuredClone(missing.records[0]!),event_id:'61000000-0000-4000-8000-000000000005',source_pk:'partial',data:{...missing.records[0]!.data,rep:'rep-a'}});
 const admitted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,headers:{...headers,'content-type':'application/json','idempotency-key':'origin'},payload:JSON.stringify(missing)});expect(admitted.statusCode).toBe(202);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});
 try {await runDurableWorkerOnce(worker);} finally {await worker.end();}
 const result=await fixture.pool.query<{quarantine_id:string;error_code:string;source_pk:string}>('SELECT quarantine_id::text,error_code,source_pk FROM control.ingestion_quarantine_index WHERE job_id=$1 ORDER BY ordinal',[admitted.json().data.job_id]);expect(result.rows.map(x=>x.error_code)).toEqual(['IDENTITY_MAPPING_REQUIRED','IDENTITY_MAPPING_REQUIRED']);quarantineId=result.rows[0]!.quarantine_id;partialId=result.rows[1]!.quarantine_id;
 await copyFile(join(migrations,'013_import_recovery_candidate.sql'),join(dir,'013_import_recovery_candidate.sql'));
 expect((await runMigrations(fixture.pool,{directory:dir,environmentKind:'local_lab'})).applied).toEqual(['013_import_recovery_candidate']);
 expect((await runMigrations(fixture.pool,{directory:dir,environmentKind:'local_lab'})).applied).toEqual([]);
 const fresh=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
 try {const first=await runMigrations(fresh.pool,{directory:dir,environmentKind:'local_lab'});expect(first.applied.at(-1)).toBe('013_import_recovery_candidate');expect((await runMigrations(fresh.pool,{directory:dir,environmentKind:'local_lab'})).applied).toEqual([]);} finally {await fresh.close();}
},90000);
afterAll(async()=>{if(app) await app.close();if(jwks) await new Promise<void>(resolve=>jwks.close(()=>resolve()));if(fixture) await fixture.close();});

it('reads the original missing identities without allocating a canonical UUID',async()=>{
 const modulePath='../ingestion-api/import-recovery-plan.js';
 const candidateModule=await import(modulePath).catch(()=>null);
 expect(candidateModule?.readImportRecoveryCandidate).toBeTypeOf('function');
 const client=await fixture.pool.connect();
 try {
  await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
  const result=await candidateModule.readImportRecoveryCandidate(client,auth,principal,quarantineId);
  expect(result.kind).toBe('ELIGIBLE');expect(result.missing).toEqual([{kind:'user',externalId:'rep-missing'},{kind:'department',externalId:'team-missing'}]);expect(result.resolved).toEqual([]);expect(result.ownObjectId).toBeNull();
  await client.query('COMMIT');
 } finally {client.release();}
 expect((await fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND source_pk='missing'`,[tenant,source])).rowCount).toBe(0);
});


async function read(id:string, who:UserPrincipal=principal) {
 const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');
 const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');const result=await readImportRecoveryCandidate(client,auth,who,id);await client.query('COMMIT');return result;}
 catch(e){await client.query('ROLLBACK');throw e;} finally {client.release();}
}
it('preserves an originally resolved live user while returning only the missing department',async()=>{
 const value=await read(partialId);expect(value.kind).toBe('ELIGIBLE');if(value.kind!=='ELIGIBLE') return;
 expect(value.resolved).toEqual([{kind:'user',externalId:'rep-a',targetId:'owner'}]);
 expect(value.missing).toEqual([{kind:'department',externalId:'team-missing'}]);expect(value.original.ordinal).toBe(1);
 expect(value.original.publicRecord.data).toEqual({customer_name:'Acme',owner_external_id:'rep-a',department_external_id:'team-missing',status:'ACTIVE'});
 expect(value.original.proof.endpointProfileDigest).toBeNull();expect(value.original.sourceVersion).toBe('1');
 expect(JSON.stringify(value)).not.toMatch(/body_bytes|verifier|digest_kind|credential_secret/i);
});
it('returns an existing reserved UUID without filling its nullable reference',async()=>{
 const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');const inserted=await client.query<{id:string}>(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk) VALUES($1,$2,'customer','missing') RETURNING canonical_object_id::text AS id`,[tenant,source]);
  await client.query('SET LOCAL ROLE hub_api');const value=await readImportRecoveryCandidate(client,auth,principal,quarantineId);expect(value.kind).toBe('ELIGIBLE');if(value.kind==='ELIGIBLE') expect(value.ownObjectId).toBe(inserted.rows[0]!.id);
  await client.query('ROLLBACK');
 } finally {client.release();}
 expect((await fixture.pool.query(`SELECT 1 FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND source_pk='missing'`,[tenant,source])).rowCount).toBe(0);
});
it('rejects a newer fence for an originally resolved key',async()=>{
 const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
  SELECT tenant_key,source_id,identity_mapping_revision+1,decode(repeat('ab',32),'hex'),'[]'::jsonb,'fixture' FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
  await client.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision)
   SELECT tenant_key,source_id,'user','rep-a',identity_mapping_revision+1 FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2
   ON CONFLICT(tenant_key,source_id,kind,external_id) DO UPDATE SET identity_mapping_revision=EXCLUDED.identity_mapping_revision`,[tenant,source]);
  await client.query('SET LOCAL ROLE hub_api');expect((await readImportRecoveryCandidate(client,auth,principal,partialId)).kind).toBe('UNAVAILABLE');
 } finally {await client.query('ROLLBACK');client.release();}
});
it('preserves historical uppercase public event UUID spelling while matching the database UUID',async()=>{
 // Trusted transaction-local facts: the current worker compares UUID text case-sensitively before quarantine.
 const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');
  const copy=await client.query<{id:string}>(`INSERT INTO control.ingestion_job(tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
   SELECT j.tenant_key,j.source_id,j.entity,j.route,j.batch_id,j.raw_batch_id,'uppercase-fixture',j.request_digest,'RECEIVED',j.received_count,0,j.credential_id,j.source_epoch_at_admission,j.credential_revision_at_admission,j.credential_generation_at_admission,j.channel_id,j.channel_epoch,j.version_domain,j.owner_approval_id,j.owner_user_id,j.owner_revision,j.approval_security_fence,j.config_revision,j.config_digest,j.mapping_revision,j.mapping_digest,j.identity_mapping_revision,j.identity_mapping_digest,j.endpoint_profile_digest,j.test_report_id,j.security_barrier_fence_at_admission,j.first_source_updated_at,j.last_source_updated_at FROM control.ingestion_job j JOIN control.ingestion_quarantine_index q ON q.job_id=j.id WHERE q.quarantine_id=$1 RETURNING id::text`,[quarantineId]);
  const job=copy.rows[0]!.id;
  await client.query(`INSERT INTO control.ingestion_management_admission_audit(job_id,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,request_id)
   SELECT $2,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,'uppercase-fixture' FROM control.ingestion_management_admission_audit WHERE job_id=(SELECT job_id FROM control.ingestion_quarantine_index WHERE quarantine_id=$1)`,[quarantineId,job]);
  await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
   SELECT $2,0,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,i.source_pk,i.source_version,i.operation,i.source_updated_at,jsonb_set(i.public_record,'{event_id}',to_jsonb('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'::text)),'RECEIVED' FROM control.ingestion_job_item i JOIN control.ingestion_quarantine_index q ON (q.job_id,q.ordinal)=(i.job_id,i.ordinal) WHERE q.quarantine_id=$1`,[quarantineId,job]);
  await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='IDENTITY_MAPPING_REQUIRED' WHERE job_id=$1 AND ordinal=0`,[job]);
  const q=(await client.query<{id:string}>(`SELECT quarantine_id::text AS id FROM control.ingestion_quarantine_index WHERE job_id=$1`,[job])).rows[0]!.id;
  await client.query('SET LOCAL ROLE hub_api');const candidate=await readImportRecoveryCandidate(client,auth,principal,q);expect(candidate.kind).toBe('ELIGIBLE');
  if(candidate.kind==='ELIGIBLE'){expect(candidate.original.eventId).toBe(candidate.original.eventId.toLowerCase());expect(candidate.original.publicRecord.event_id).toBe(candidate.original.eventId.toUpperCase());}
 } finally {await client.query('ROLLBACK');client.release();}
});
it('hides cross tenant and denies a different owner',async()=>{
 await expect(read(quarantineId,other)).rejects.toMatchObject({code:'SOURCE_NOT_FOUND'});
 await expect(read(quarantineId,viewer)).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});
});
it('keeps helper private and rejects runtime-role misuse',async()=>{
 const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
  await expect(client.query('SELECT control.import_recovery_original_facts_internal($1,$2::uuid,$3)',[tenant,quarantineId,source])).rejects.toMatchObject({code:'42501'});
  await client.query('ROLLBACK');await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_worker');
  await expect(client.query('SELECT control.read_import_recovery_original($1,$2::uuid,$3,$4,$5,$6::bigint)',[tenant,quarantineId,principal.userId,principal.issuer,principal.subject,principal.authEpoch])).rejects.toMatchObject({code:'42501'});
  await client.query('ROLLBACK');
 } finally {client.release();}
});
it('refuses an agent bearer and a source bearer',async()=>{
 const agent=await auth.createAgentCredential(principal,{purpose:'candidate test'},'i3p1-agent');expect(agent.secret).toBeTruthy();
 const agentPrincipal=await auth.authenticateAgent(agent.secret!);
 await expect(read(quarantineId,agentPrincipal)).rejects.toMatchObject({code:'AUTH_INVALID'});
 await expect(authenticator(agent.secret!)).rejects.toBeTruthy();
 const sourceSecret=createCredential().secret;
 await auth.repository.provisionSourceCredential({tenantId:tenant,sourceId:'external-test',token:sourceSecret,secretRef:'vault:/fixture',allowedEntities:['customer'],revision:'1'});
 const sourcePrincipal=await auth.authenticateSourceIdentity(sourceSecret);
 await expect(read(quarantineId,sourcePrincipal as unknown as UserPrincipal)).rejects.toMatchObject({code:'AUTH_INVALID'});
 await expect(authenticator(sourceSecret)).rejects.toBeTruthy();
});
it('allows current read-only owner, even after source pause, and denies absent read scope',async()=>{
 await sourceService.update(principal,source,{expected_revision:'1',config:{name:'Candidate edited',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer'],delete_contract:'tombstone'}});
 const edited=await read(quarantineId);expect(edited.kind).toBe('ELIGIBLE');if(edited.kind==='ELIGIBLE') expect(edited.current.sourceRevision).toBe('2');
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read']});
 const readonly=await auth.resolveOidc(principal.issuer,principal.subject);
 expect((await read(quarantineId,readonly)).kind).toBe('ELIGIBLE');
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:approve']});
 const noRead=await auth.resolveOidc(principal.issuer,principal.subject);
 await expect(read(quarantineId,noRead)).rejects.toMatchObject({code:'AUTH_FORBIDDEN'});
 await auth.repository.updateSubject({tenantId:tenant,userId:'owner',departmentId:'dept1',businessRole:'sales',managementScopes:['source:read','source:write','source:approve','mapping:write']});
 principal=await auth.resolveOidc(principal.issuer,principal.subject);
});
it('fails closed when a resolved owner is no longer eligible',async()=>{
 await fixture.pool.query(`UPDATE control.auth_subject SET business_role='sales_manager' WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);
 try {expect((await read(partialId)).kind).toBe('UNAVAILABLE');} finally {await fixture.pool.query(`UPDATE control.auth_subject SET business_role='sales' WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);}
});
it('uses the full foreign customer tuple and excludes non-null original targets',async()=>{
 const src='order-candidate',headers={authorization:`Bearer ${token}`};
 const call=(method:'POST'|'PUT',url:string,payload:Record<string,unknown>)=>app.inject({method,url,headers,payload});
 expect((await call('POST','/hub/v1/admin/sources',{source_id:src,data_owner_user_id:'owner',config:{name:'Orders',connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['order'],delete_contract:'tombstone'}})).statusCode).toBe(201);
 const fields=[['buyer','customer_id','identity'],['number','order_no','trim'],['state','status','identity'],['at','order_at','identity'],['total','amount','decimal-string'],['ccy','currency','identity'],...['source_line_id','product_code','product_name','quantity','unit_price','line_amount'].map(field=>[`lines.${field}`,`lines.${field}`,['quantity','unit_price','line_amount'].includes(field)?'decimal-string':'identity'])].map(([source_field,target_field,transform])=>({entity:'order',source_field,target_field,transform}));
 expect((await call('PUT',`/hub/v1/admin/sources/${src}/mappings`,{expected_revision:'1',mappings:fields})).statusCode).toBe(200);
 const refs=['sample-ref','absent-ref','null-ref','wrong-ref','deleted-ref'];const ids:string[]=[];
 for(const pk of refs) {
  const customer=await fixture.pool.query<{id:string}>(`INSERT INTO hub.canonical_customer(tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision,deleted_at) VALUES($1,'Existing','owner','dept1','ACTIVE',now(),1,'SOURCE_VERSION',1,1,CASE WHEN $2='deleted-ref' THEN now() ELSE NULL END) RETURNING id::text`,[tenant,pk]);ids.push(customer.rows[0]!.id);
  await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id) VALUES($1,$2,'customer',$3,$4,$4)`,[tenant,source,pk,customer.rows[0]!.id]);
 }
 const key=(pk:string)=>customerReferenceMappingKey(source,pk);
 await sourceService.writeIdentityMappings(principal,src,[{kind:'customer',external_id:key(refs[0]!),target_id:ids[0]},
  {kind:'customer',external_id:key(refs[3]!),target_id:ids[0]},{kind:'customer',external_id:key(refs[4]!),target_id:ids[4]}]);
 const record=(pk:string,index:number)=>({event_id:`72000000-0000-4000-8000-00000000000${index}`,source_pk:`order-${pk}`,source_version:'18446744073709551615',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{buyer:{source_id:source,source_pk:pk},number:'O1',state:'CONFIRMED',at:'2026-10-29T00:00:00Z',total:'12.00',ccy:'CNY',lines:[{source_line_id:'l1',product_code:'p',product_name:'item',quantity:'1.000000',unit_price:'12.000000',line_amount:'12.00'}]}});
 const body={schema_version:'hub.v1',batch_id:'72000000-0000-4000-8000-000000000010',records:[record('sample-ref',1)]};
 const tested=await call('POST',`/hub/v1/admin/sources/${src}/test`,{expected_revision:'1',samples:{order:JSON.stringify(body)}});expect(tested.json().data.status).toBe('PASS');
 const report=tested.json().data,approved=await call('POST',`/hub/v1/admin/sources/${src}/approve`,{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref});expect(approved.statusCode).toBe(200);
 expect((await call('POST',`/hub/v1/admin/sources/${src}/activate`,{revision:'1',approval_id:approved.json().data.approval_id})).statusCode).toBe(200);
 body.batch_id='72000000-0000-4000-8000-000000000011';body.records=refs.slice(1).map((pk,i)=>record(pk,i+2));
 const admitted=await app.inject({method:'POST',url:`/hub/v1/admin/sources/${src}/import/order`,headers:{...headers,'content-type':'application/json','idempotency-key':'order-origin'},payload:JSON.stringify(body)});expect(admitted.statusCode).toBe(202);
 const worker=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,options:'-c role=hub_worker'});try{await runDurableWorkerOnce(worker);}finally{await worker.end();}
 const rows=(await fixture.pool.query<{quarantine_id:string;error_code:string}>(`SELECT quarantine_id::text,error_code FROM control.ingestion_quarantine_index WHERE job_id=$1 ORDER BY ordinal`,[admitted.json().data.job_id])).rows;
 expect(rows.map(x=>x.error_code)).toEqual(['IDENTITY_MAPPING_TARGET_INVALID','IDENTITY_MAPPING_TARGET_INVALID','IDENTITY_MAPPING_TARGET_INVALID','IDENTITY_MAPPING_TARGET_INVALID']);
 const counts=async()=>{
  const tables=['hub.canonical_customer','hub.canonical_order','hub.canonical_order_line','control.canonical_source_identity',
   'control.ingestion_job','control.ingestion_job_item','control.ingestion_processing_outbox','control.canonical_apply_outbox',
   'control.canonical_ownership_audit','control.ingestion_management_admission_audit','control.ingestion_recovery_operation','raw.ingestion_batch'];
  const result=[];for(const table of tables) result.push((await fixture.pool.query(`SELECT count(*)::text AS count,md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${table} t`)).rows[0]);
  return result;
 };
 const before=await counts();
 for(let i=0;i<2;i++){const candidate=await read(rows[i]!.quarantine_id);expect(candidate.kind).toBe('ELIGIBLE');if(candidate.kind==='ELIGIBLE'){expect(candidate.missing).toEqual([{kind:'customer',sourceId:source,sourcePk:refs[i+1],externalId:key(refs[i+1]!)}]);expect(candidate.ownObjectId).toBeNull();expect(candidate.original.sourceVersion).toBe('18446744073709551615');}}
 expect((await read(rows[2]!.quarantine_id)).kind).toBe('UNAVAILABLE');expect((await read(rows[3]!.quarantine_id)).kind).toBe('UNAVAILABLE');expect(await counts()).toEqual(before);
 const {readImportRecoveryCandidate}=await import('../ingestion-api/import-recovery-plan.js');const client=await fixture.pool.connect();
 try {await client.query('BEGIN');await client.query(`UPDATE hub.canonical_customer SET deleted_at=now() WHERE tenant_id=$1 AND id=$2`,[tenant,ids[1]]);await client.query('SET LOCAL ROLE hub_api');
  expect((await readImportRecoveryCandidate(client,auth,principal,rows[0]!.quarantine_id)).kind).toBe('UNAVAILABLE');await client.query('ROLLBACK');
 } finally {client.release();}
});
it('rejects the original admission after a credential security barrier',async()=>{
 await fixture.pool.query(`INSERT INTO control.source_security_barrier(tenant_key,source_id,credential_id,barrier_type,reason_code,created_by)
  SELECT tenant_key,source_id,credential_id,'CREDENTIAL_COMPROMISE','SYNTHETIC_TEST','fixture' FROM control.ingestion_job WHERE id=(SELECT job_id FROM control.ingestion_quarantine_index WHERE quarantine_id=$1)`,[quarantineId]);
 expect((await read(quarantineId)).kind).toBe('UNAVAILABLE');
});




it('classifies a historical null target as missing without treating non-null targets as missing',async()=>{
 const {isMissingOriginalMapping}=await import('../ingestion-api/import-recovery-plan.js');
 expect(isMissingOriginalMapping(undefined)).toBe(true);expect(isMissingOriginalMapping({target_id:null})).toBe(true);expect(isMissingOriginalMapping({target_id:'wrong-or-deleted'})).toBe(false);
});
