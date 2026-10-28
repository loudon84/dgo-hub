import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../../app.js';
import { createAuthService } from '../../auth/service.js';
import { createOidcAuthenticator } from '../../auth/oidc.js';
import { createSourceRegistryService, failClosedCapabilityProbe, failClosedEndpointAllowlist, failClosedSecretResolver } from '../../source-registry/service.js';
import { runMigrations } from '../../migrations/runner.js';
import { runDurableWorkerOnce } from '../../etl-worker/worker.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './postgres.js';
import type { UserPrincipal } from '../../auth/types.js';

export const tenant='i3p1_tenant', source='candidate-source';
export const sample={schema_version:'hub.v1',batch_id:'61000000-0000-4000-8000-000000000001',records:[{event_id:'61000000-0000-4000-8000-000000000002',source_pk:'sample',source_version:'1',operation:'UPSERT',source_updated_at:'2026-10-29T00:00:00Z',data:{display:'Acme',rep:'rep-a',team:'team-a',state:'ACTIVE'}}]};

/** Shared real OIDC/import setup; each suite gets an independently staged migration directory. */
export async function setupImportRecoveryFixture(suite:'candidate'|'binding') {
 let fixture!:OwnedPostgres, app!:Awaited<ReturnType<typeof buildApp>>, jwks!:Server;
 let auth!:ReturnType<typeof createAuthService>, principal!:UserPrincipal, viewer!:UserPrincipal, other!:UserPrincipal, token!:string;
 let authenticator!:ReturnType<typeof createOidcAuthenticator>, sourceService!:ReturnType<typeof createSourceRegistryService>;
 let partialId!:string, quarantineId!:string;
 try {
 const evidenceRoot=fixtureEvidenceRootFromEnvironment(); if(!evidenceRoot) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
 const root=join(evidenceRoot,`i3p2-${suite}`,randomUUID());
 fixture=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
 const migrations=fileURLToPath(new URL('../../migrations/',import.meta.url)), dir=join(root,'migrations');
 await mkdir(dir,{recursive:true});
 for(const name of await readdir(migrations)) if(/^\d{3}_.+\.sql$/.test(name) && !name.startsWith('013_') && !name.startsWith('014_')) await copyFile(join(migrations,name),join(dir,name));
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
 const fresh013=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
 try {const first=await runMigrations(fresh013.pool,{directory:dir,environmentKind:'local_lab'});expect(first.applied.at(-1)).toBe('013_import_recovery_candidate');expect((await runMigrations(fresh013.pool,{directory:dir,environmentKind:'local_lab'})).applied).toEqual([]);} finally {await fresh013.close();}
 await copyFile(join(migrations,'014_import_recovery_binding.sql'),join(dir,'014_import_recovery_binding.sql'));
 expect((await runMigrations(fixture.pool,{directory:dir,environmentKind:'local_lab'})).applied).toEqual(['014_import_recovery_binding']);
 const reapplied=await runMigrations(fixture.pool,{directory:dir,environmentKind:'local_lab'});
 expect(reapplied.applied).toEqual([]);expect(reapplied.skipped.at(-1)).toBe('014_import_recovery_binding');
 const fresh014=await startOwnedPostgres({evidenceRoot:root,evidenceFile:'unused',taskLabel:'m1task1'});
 try {const first=await runMigrations(fresh014.pool,{directory:dir,environmentKind:'local_lab'});expect(first.applied.at(-1)).toBe('014_import_recovery_binding');const again=await runMigrations(fresh014.pool,{directory:dir,environmentKind:'local_lab'});expect(again.applied).toEqual([]);expect(again.skipped.at(-1)).toBe('014_import_recovery_binding');} finally {await fresh014.close();}
 return {fixture,app,jwks,auth,principal,viewer,other,token,authenticator,sourceService,partialId,quarantineId};
 } catch (error) {
  if(app) await app.close();
  if(jwks) await new Promise<void>(resolve=>jwks.close(()=>resolve()));
  if(fixture) await fixture.close();
  throw error;
 }
}
