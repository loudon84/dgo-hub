import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import pgDriver from 'pg';
import { createAuthService } from '../../auth/service.js';
import { createCredential } from '../../auth/credentials.js';
import { createOidcAuthenticator } from '../../auth/oidc.js';
import { buildApp } from '../../app.js';
import { runMigrations } from '../../migrations/runner.js';
import { createSnapshotRun } from '../../etl-worker/snapshot-runs.js';
import { createSourceRegistryService } from '../../source-registry/service.js';
import type { EndpointProfile } from '../../source-registry/capability-probe.js';
import type { PostgresSourceConnectionFactory } from '../../etl-worker/postgres-snapshot-connector.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './postgres.js';

const IMAGE='postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
const AUDIENCE='snapshot-recovery-test';

export type SnapshotRecoveryHttpFixture=Readonly<{pool:Pool;workerPool:Pool;adminPool:Pool;app:FastifyInstance;owner:Readonly<{
  userId:string;tenantId:string;issuer:string;subject:string;managementScopes:readonly string[];authEpoch:string;
  businessTimezone:string;departmentId:string;businessRole:'sales';
}>;token:string;hostPort:number;originalRunId:string;createInterruptedRun:()=>Promise<string>;
createOrderRecoveryRun:(canonicalCustomerId:string)=>Promise<string>;
pauseSource:(expectedRevision:string)=>Promise<unknown>;editSourceConfig:(expectedRevision:string)=>Promise<unknown>;close:()=>Promise<void>}>;

export function createOwnedPostgresSourceFactory(pool:Pool,onConnect:()=>void=()=>undefined,onFetch:(rowCount:number)=>void=()=>undefined):PostgresSourceConnectionFactory {
  return {async connect(){
    onConnect();
    const client=await pool.connect();
    return {async query(sql:string){
      const result=await client.query(sql);
      if(sql.startsWith('FETCH FORWARD')) onFetch(result.rows.length);
      return {rows:result.rows as Record<string,unknown>[]};
    },async cancel(){},async close(){client.release();}};
  }};
}

export async function startSnapshotRecoveryHttpFixture():Promise<SnapshotRecoveryHttpFixture>{
  const evidenceRoot=fixtureEvidenceRootFromEnvironment();
  if(!evidenceRoot) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
  const pg:OwnedPostgres=await startOwnedPostgres({evidenceFile:`${evidenceRoot}/snapshot-recovery/postgres-lifecycle.jsonl`,
    evidenceRoot,taskLabel:'m1task5',imageReference:IMAGE});
  let jwks:Server|undefined;
  let app:FastifyInstance|undefined;
  let apiPool:Pool|undefined;
  let workerPool:Pool|undefined;
  try {
    const migrationDirectory=fileURLToPath(new URL('../../migrations/',import.meta.url));
    const baselineDirectory=join(evidenceRoot,'snapshot-recovery','migrations-001-008');
    await mkdir(baselineDirectory,{recursive:true});
    for(const name of (await readdir(migrationDirectory)).filter(name=>/^00[1-8]_.*\.sql$/.test(name)))
      await copyFile(join(migrationDirectory,name),join(baselineDirectory,name));
    await runMigrations(pg.pool,{directory:baselineDirectory,environmentKind:'local_lab'});
    const key=await generateKeyPair('RS256',{modulusLength:2048});
    const jwk=await exportJWK(key.publicKey);
    const document={keys:[{...jwk,kid:'snapshot-recovery-key',alg:'RS256',use:'sig'}]};
    jwks=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(document));});
    await new Promise<void>((resolve,reject)=>{jwks!.once('error',reject);jwks!.listen(0,'127.0.0.1',resolve);});
    const address=jwks.address();
    if(!address||typeof address==='string') throw new Error('SNAPSHOT_RECOVERY_JWKS_BIND_FAILED');
    const issuer=`http://127.0.0.1:${address.port}/issuer`;
    const auth=createAuthService({pool:pg.pool});
    const owner={userId:'recovery_owner',tenantId:'m1_recovery_tenant',issuer,subject:'recovery_owner_sub',
      managementScopes:['source:read','source:write','source:approve','mapping:write'] as const,authEpoch:'0',businessTimezone:'UTC',
      departmentId:'recovery_department',businessRole:'sales'} as const;
    await auth.repository.provisionTenant({tenantId:owner.tenantId,businessTimezone:'UTC'});
    await auth.repository.provisionSubject({tenantId:owner.tenantId,userId:owner.userId,departmentId:owner.departmentId,
      businessRole:owner.businessRole,managementScopes:owner.managementScopes});
    await auth.repository.bindIdentity({issuer:owner.issuer,subject:owner.subject,tenantId:owner.tenantId,userId:owner.userId});
    await auth.repository.provisionSourceCredential({sourceId:'pg_recovery',tenantId:owner.tenantId,
      token:createCredential().secret,secretRef:'vault:/snapshot/source',allowedEntities:['customer'],revision:'1'});
    const endpointProfile:EndpointProfile={revision:'pg-v1',connector:'postgresql',protocol:'postgres:',host:'source.fixture.invalid',
      port:5432,database:'source_db',user:'source_reader',schema:'public',entities:{customer:{table:'customers',source_pk:'customer_id',
        updated_at_field:'updated_at',version_field:'source_version'}}};
    const orderEndpointProfile:EndpointProfile={revision:'pg-order-v1',connector:'postgresql',protocol:'postgres:',host:'source.fixture.invalid',
      port:5432,database:'source_db',user:'source_reader',schema:'public',entities:{order:{table:'snapshot_recovery_orders',source_pk:'order_id',
        updated_at_field:'updated_at',lines:{table:'snapshot_recovery_order_lines',order_fk:'order_id'},customer_source_id:'pg_recovery'}}};
    const registry=createSourceRegistryService({pool:pg.pool,auth,environmentKind:'local_lab',
      secretResolver:{isConfiguredReference:value=>value==='vault:/snapshot/source',resolve:async()=>'fixture-secret'},
      endpointAllowlist:{resolve:async reference=>{if(reference==='pg-test') return endpointProfile;
        if(reference==='pg-order-test') return orderEndpointProfile; throw new Error('endpoint not approved');}},
      capabilityProbe:{run:async()=>({passed:true,checks:['READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID']})}});
    const config={name:'Snapshot recovery CRM',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',
      endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',allowed_entities:['customer'],delete_contract:'hard_delete'};
    await registry.create(owner,{source_id:'pg_recovery',data_owner_user_id:owner.userId,config});
    await registry.writeMappings(owner,'pg_recovery','1',[
      {entity:'customer',source_field:'name',target_field:'customer_name',transform:'trim'},
      {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
      {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
      {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
      {entity:'customer',source_field:'updated_at',target_field:'source_updated_at',transform:'identity'},
    ]);
    await registry.writeIdentityMappings(owner,'pg_recovery',[
      {kind:'user',external_id:'owner-ext',target_id:owner.userId},
      {kind:'department',external_id:'department-ext',target_id:'recovery_department'},
    ]);
    const tested=await registry.test(owner,'pg_recovery','1');
    const approved=await registry.approve(owner,'pg_recovery','1',tested.test_report_id,tested.data_contract_ref);
    await runMigrations(pg.pool,{directory:migrationDirectory,environmentKind:'local_lab'});
    await runMigrations(pg.pool,{directory:migrationDirectory,environmentKind:'local_lab'});
    await registry.activate(owner,'pg_recovery','1',approved.approval_id);
    const original=await createSnapshotRun(pg.pool,auth,owner,'pg_recovery','1','snapshot-recovery-original');
    const authenticator=createOidcAuthenticator({issuer,audience:AUDIENCE,jwksUrl:`http://127.0.0.1:${address.port}/jwks`,
      environmentKind:'local_lab',allowLoopbackHttp:true},auth);
    const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'snapshot-recovery-key',typ:'JWT'})
      .setIssuer(issuer).setAudience(AUDIENCE).setSubject(owner.subject).setExpirationTime('5m').sign(key.privateKey);
    apiPool=new pgDriver.Pool({connectionString:`postgres://postgres@127.0.0.1:${pg.hostPort}/postgres`,options:'-c role=hub_api',max:4});
    workerPool=new pgDriver.Pool({connectionString:`postgres://postgres@127.0.0.1:${pg.hostPort}/postgres`,options:'-c role=hub_worker',max:4});
    app=await buildApp({logger:false,snapshotRuns:{pool:apiPool,authService:auth,authenticator}});
    const createInterruptedRun=async()=>{
      const run=await createSnapshotRun(pg.pool,auth,owner,'pg_recovery','1','snapshot-recovery-secondary');
      await pg.pool.query(`UPDATE control.etl_run SET status='INCOMPLETE',error_code='SNAPSHOT_SOURCE_INTERRUPTED'
        WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[owner.tenantId,run.run_id]);
      return run.run_id;
    };
    const createOrderRecoveryRun=async(canonicalCustomerId:string)=>{
      await pg.pool.query(`CREATE TABLE public.snapshot_recovery_orders(order_id bigint PRIMARY KEY,customer_id text NOT NULL,order_no text NOT NULL,
        status text NOT NULL,order_at timestamptz NOT NULL,amount numeric(30,2) NOT NULL,currency text NOT NULL,updated_at timestamptz NOT NULL)`);
      await pg.pool.query(`CREATE TABLE public.snapshot_recovery_order_lines(line_id text PRIMARY KEY,order_id bigint NOT NULL
        REFERENCES public.snapshot_recovery_orders(order_id),product_code text NOT NULL,product_name text NOT NULL,quantity numeric(20,6) NOT NULL,
        unit_price numeric(30,6) NOT NULL,line_amount numeric(30,2) NOT NULL)`);
      await pg.pool.query(`INSERT INTO public.snapshot_recovery_orders VALUES
        (9007199254740993123,'C-REC-1','ORDER-REC-100','COMPLETED','2026-10-28 13:00:00.123456+00',
          123456789012345678.12,'USD','2026-10-28 13:01:00.123456+00'),
        (9007199254740993124,'C-REC-1','ORDER-REC-200','COMPLETED','2026-10-28 13:02:00.123456+00',
          223456789012345678.12,'USD','2026-10-28 13:03:00.123456+00')`);
      await pg.pool.query(`INSERT INTO public.snapshot_recovery_order_lines VALUES
        ('L-100-A',9007199254740993123,'SKU-A','Order line A',1.123456,123456789012.123456,138636548569.22),
        ('L-100-B',9007199254740993123,'SKU-B','Order line B',2.123456,223456789012.123456,238636548569.22),
        ('L-200-A',9007199254740993124,'SKU-C','Order line C',3.123456,323456789012.123456,338636548569.22),
        ('L-200-B',9007199254740993124,'SKU-D','Order line D',4.123456,423456789012.123456,438636548569.22)`);
      await auth.repository.provisionSourceCredential({sourceId:'pg_order_recovery',tenantId:owner.tenantId,
        token:createCredential().secret,secretRef:'vault:/snapshot/source',allowedEntities:['order'],revision:'1'});
      await registry.create(owner,{source_id:'pg_order_recovery',data_owner_user_id:owner.userId,config:{name:'Snapshot recovery orders',
        connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',endpoint_allowlist_ref:'pg-order-test',
        secret_ref:'vault:/snapshot/source',allowed_entities:['order'],delete_contract:'hard_delete'}});
      await registry.writeMappings(owner,'pg_order_recovery','1',[
        {entity:'order',source_field:'customer_id',target_field:'customer_id',transform:'source-id'},
        {entity:'order',source_field:'order_no',target_field:'order_no',transform:'trim'},
        {entity:'order',source_field:'status',target_field:'status',transform:'trim'},
        {entity:'order',source_field:'order_at',target_field:'order_at',transform:'identity'},
        {entity:'order',source_field:'amount',target_field:'amount',transform:'decimal-string'},
        {entity:'order',source_field:'currency',target_field:'currency',transform:'trim'},
        {entity:'order',source_field:'updated_at',target_field:'source_updated_at',transform:'identity'},
        {entity:'order',source_field:'line_id',target_field:'lines.source_line_id',transform:'source-id'},
        {entity:'order',source_field:'product_code',target_field:'lines.product_code',transform:'trim'},
        {entity:'order',source_field:'product_name',target_field:'lines.product_name',transform:'trim'},
        {entity:'order',source_field:'quantity',target_field:'lines.quantity',transform:'decimal-string'},
        {entity:'order',source_field:'unit_price',target_field:'lines.unit_price',transform:'decimal-string'},
        {entity:'order',source_field:'line_amount',target_field:'lines.line_amount',transform:'decimal-string'},
      ]);
      await registry.writeIdentityMappings(owner,'pg_order_recovery',[{kind:'customer',external_id:'C-REC-1',target_id:canonicalCustomerId}]);
      const orderTest=await registry.test(owner,'pg_order_recovery','1');
      const orderApproval=await registry.approve(owner,'pg_order_recovery','1',orderTest.test_report_id,orderTest.data_contract_ref);
      await registry.activate(owner,'pg_order_recovery','1',orderApproval.approval_id);
      return (await createSnapshotRun(pg.pool,auth,owner,'pg_order_recovery','1','snapshot-order-recovery-original')).run_id;
    };
    return {pool:apiPool,workerPool,adminPool:pg.pool,app,owner,token,hostPort:pg.hostPort,originalRunId:original.run_id,createInterruptedRun,
      createOrderRecoveryRun,
      pauseSource:(expectedRevision:string)=>registry.pause(owner,'pg_recovery',expectedRevision,'recovery fixture ordinary pause'),
      editSourceConfig:(expectedRevision:string)=>registry.update(owner,'pg_recovery',{expected_revision:expectedRevision,
        config:{...config,name:'Snapshot recovery CRM revised'}}),
      close:async()=>{await app!.close();await apiPool!.end();await workerPool!.end();await new Promise<void>(resolve=>jwks!.close(()=>resolve()));await pg.close();}};
  } catch(error) {
    if(app) await app.close().catch(()=>undefined);
    if(apiPool) await apiPool.end().catch(()=>undefined);
    if(workerPool) await workerPool.end().catch(()=>undefined);
    if(jwks) await new Promise<void>(resolve=>jwks!.close(()=>resolve())).catch(()=>undefined);
    await pg.close();
    throw error;
  }
}
