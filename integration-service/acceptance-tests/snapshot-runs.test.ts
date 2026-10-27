import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { createSourceRegistryService, type SourceRegistryService } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { buildApp } from '../app.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { createLocalLabPostgresSourceConnectionFactory, SnapshotSourceError, type PostgresSourceConnectionFactory } from '../etl-worker/postgres-snapshot-connector.js';
import { runDurableWorkerLoop } from '../etl-worker/worker.js';
import type { EndpointProfile } from '../source-registry/capability-probe.js';

const evidenceRoot = fixtureEvidenceRootFromEnvironment();
const localEvidence = join(fileURLToPath(new URL('../../docs/execution/alpha1/m1-task-5a-evidence/', import.meta.url)), 'postgres-lifecycle.jsonl');
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const postgresImage = 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
let fixture: OwnedPostgres;
let auth: ReturnType<typeof createAuthService>;
let initialMigrations: { applied: string[]; skipped: string[] };
let service: SourceRegistryService;
let owner = { userId: 'snapshot_owner', tenantId: 'snapshot_tenant', departmentId: null, businessRole: null,
  managementScopes: ['source:read','source:write','source:approve','mapping:write'] as const, authEpoch: '0',
  businessTimezone: 'UTC', issuer: 'https://idp.example.test', subject: 'snapshot-owner' };

let e2eEndpointProfile: EndpointProfile | undefined;
const endpointAllowlist = { resolve: async (reference: string) => {
  if (reference !== 'pg-test') throw new Error('endpoint not approved');
  return e2eEndpointProfile ?? { revision: 'pg-v1', connector: 'postgresql' as const, protocol: 'postgres:' as const, host: 'source.fixture.invalid',
    port: 5432, database: 'source_db', user: 'source_reader', schema: 'public',
    entities: { customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at', version_field: 'source_version' },
      order: { table: 'orders', source_pk: 'order_id', updated_at_field: 'updated_at', version_field: 'source_version', aggregate_version_covers_lines: true,
        lines: { table: 'order_lines', order_fk: 'order_id' } } } };
} };
function makeService(pool: typeof fixture.pool): SourceRegistryService {
  return createSourceRegistryService({ pool, auth, environmentKind: 'local_lab',
    secretResolver: { isConfiguredReference: async value => value === 'vault:/snapshot/source', resolve: async () => 'fixture-secret' },
    endpointAllowlist, capabilityProbe: { run: async () => ({ passed: true, checks: ['READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID'] }) } });
}

beforeAll(async () => {
  if (!evidenceRoot) await mkdir(dirname(localEvidence), { recursive: true });
  fixture = await startOwnedPostgres({ evidenceFile: localEvidence, evidenceRoot, taskLabel: 'm1task5', imageReference: postgresImage });
  initialMigrations = await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  auth = createAuthService({ pool: fixture.pool });
  service = makeService(fixture.pool);
}, 90_000);

beforeEach(async () => {
  await fixture.pool.query(`TRUNCATE control.etl_run_attempt,control.etl_run,control.etl_snapshot_schedule,
    control.source_security_barrier,control.source_lifecycle_event,control.source_owner_approval,control.source_test_report,
    control.source_channel,control.source_identity_mapping_revision,control.source_mapping_revision,control.source_config_revision,
    control.source_registry,control.source_credential,control.identity_binding,control.auth_subject,control.tenant,
    control.credential_digest_registry CASCADE`);
  await auth.repository.provisionTenant({ tenantId: owner.tenantId, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: owner.tenantId, userId: owner.userId, managementScopes: owner.managementScopes });
  await auth.repository.bindIdentity({ issuer: owner.issuer, subject: owner.subject, tenantId: owner.tenantId, userId: owner.userId });
  const token = createCredential().secret;
  await auth.repository.provisionSourceCredential({ sourceId: 'pg-main', tenantId: owner.tenantId, token,
    secretRef: 'vault:/snapshot/source', allowedEntities: ['customer'], revision: '1' });
  const config = { name: 'Snapshot CRM', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
    endpoint_allowlist_ref: 'pg-test', secret_ref: 'vault:/snapshot/source', allowed_entities: ['customer'], delete_contract: 'hard_delete' };
  await service.create(owner, { source_id: 'pg-main', data_owner_user_id: owner.userId, config });
  await service.writeMappings(owner, 'pg-main', '1', [
    { entity: 'customer', source_field: 'name', target_field: 'customer_name', transform: 'trim' },
    { entity: 'customer', source_field: 'owner_id', target_field: 'owner_user_id', transform: 'source-id' },
    { entity: 'customer', source_field: 'department_id', target_field: 'dept_id', transform: 'source-id' },
    { entity: 'customer', source_field: 'status', target_field: 'status', transform: 'identity' },
  ]);
  const tested = await service.test(owner, 'pg-main', '1');
  const approved = await service.approve(owner, 'pg-main', '1', tested.test_report_id, tested.data_contract_ref);
  await service.activate(owner, 'pg-main', '1', approved.approval_id);
});

afterAll(async () => { if (fixture) await fixture.close(); });

describe('durable snapshot run admission', () => {
  it('upgrades populated 001-008 registry facts through 009 and preserves every prior checksum', async () => {
    if(!evidenceRoot) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
    const upgradeFixture=await startOwnedPostgres({evidenceFile:join(evidenceRoot,'populated-008-upgrade.jsonl'),evidenceRoot,
      taskLabel:'m1task5',imageReference:postgresImage});
    const upgradeDirectory=join(evidenceRoot,`migrations-008-${randomUUID()}`);
    await mkdir(upgradeDirectory,{recursive:false});
    try {
      const migrationNames=(await readdir(migrationsDirectory)).filter(name=>/^00[1-8]_.*\.sql$/.test(name));
      expect(migrationNames).toHaveLength(8);
      for(const name of migrationNames) await copyFile(join(migrationsDirectory,name),join(upgradeDirectory,name));
      const through008=await runMigrations(upgradeFixture.pool,{directory:upgradeDirectory,environmentKind:'local_lab'});
      expect(through008.applied).toHaveLength(8);
      const upgradeAuth=createAuthService({pool:upgradeFixture.pool});
      await upgradeAuth.repository.provisionTenant({tenantId:owner.tenantId,businessTimezone:'UTC'});
      await upgradeAuth.repository.provisionSubject({tenantId:owner.tenantId,userId:owner.userId,managementScopes:owner.managementScopes});
      await upgradeAuth.repository.bindIdentity({issuer:owner.issuer,subject:owner.subject,tenantId:owner.tenantId,userId:owner.userId});
      await upgradeAuth.repository.provisionSourceCredential({sourceId:'pg-populated-008',tenantId:owner.tenantId,token:createCredential().secret,
        secretRef:'vault:/snapshot/source',allowedEntities:['customer'],revision:'1'});
      const config={name:'Populated 008 source',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',
        endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',allowed_entities:['customer'],delete_contract:'hard_delete'};
      const mappings=[
        {entity:'customer',source_field:'customer_name',target_field:'customer_name',transform:'trim'},
        {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
        {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
        {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
      ];
      const identityMappings=[{kind:'user',external_id:'owner-ext',target_id:owner.userId},
        {kind:'department',external_id:'dept-ext',target_id:'sales-east'}];
      const configDigest=createHash('sha256').update(JSON.stringify(config)).digest();
      const mappingDigest=createHash('sha256').update(JSON.stringify(mappings)).digest();
      const identityDigest=createHash('sha256').update(JSON.stringify(identityMappings)).digest();
      const profileDigest=createHash('sha256').update('accepted-profile-at-008').digest();
      await upgradeFixture.pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
        VALUES($1,'pg-populated-008','ACTIVE',$2)`,[owner.tenantId,owner.userId]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
        VALUES($1,'pg-populated-008',1,$2,$3,$4)`,[owner.tenantId,configDigest,JSON.stringify(config),owner.userId]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,'pg-populated-008',1,$2,$3,$4)`,[owner.tenantId,mappingDigest,JSON.stringify(mappings),owner.userId]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,'pg-populated-008',1,$2,$3,$4)`,[owner.tenantId,identityDigest,JSON.stringify(identityMappings),owner.userId]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
        VALUES($1,'pg-populated-008','customer','postgresql','FULL_SNAPSHOT','SNAPSHOT_OBSERVATION',1,'active')`,[owner.tenantId]);
      const report=await upgradeFixture.pool.query(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
        identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
        endpoint_profile_digest,data_contract_ref,report,status,created_by)
        VALUES($1,'pg-populated-008',1,1,1,$2,$3,$4,1,1,$5,'contract:populated-008','{"checks":["READ_ONLY","MAPPING_VALID"]}',
          'PASS',$6) RETURNING id`,[owner.tenantId,configDigest,mappingDigest,identityDigest,profileDigest,owner.userId]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,config_revision,
        mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
        credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
        VALUES($1,'pg-populated-008',$2,1,1,1,1,$3,$4,$5,1,1,$6,'contract:populated-008',$7)`,
        [owner.tenantId,owner.userId,configDigest,mappingDigest,identityDigest,profileDigest,report.rows[0].id]);
      await upgradeFixture.pool.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,new_state,owner_revision,details)
        VALUES($1,'pg-populated-008',$2,'APPROVED','ACTIVE',1,'{"source":"migration-upgrade-fixture"}')`,[owner.tenantId,owner.userId]);
      const before=await upgradeFixture.pool.query(`SELECT version,name,checksum FROM control.schema_migration WHERE version<=8 ORDER BY version`);
      const populated=await upgradeFixture.pool.query(`SELECT
        (SELECT count(*)::int FROM control.source_registry WHERE source_id='pg-populated-008') AS registry,
        (SELECT count(*)::int FROM control.source_credential WHERE source_id='pg-populated-008') AS credentials,
        (SELECT count(*)::int FROM control.source_config_revision WHERE source_id='pg-populated-008') AS configs,
        (SELECT count(*)::int FROM control.source_mapping_revision WHERE source_id='pg-populated-008') AS mappings,
        (SELECT count(*)::int FROM control.source_identity_mapping_revision WHERE source_id='pg-populated-008') AS identity_maps,
        (SELECT count(*)::int FROM control.source_test_report WHERE source_id='pg-populated-008') AS reports,
        (SELECT count(*)::int FROM control.source_owner_approval WHERE source_id='pg-populated-008') AS approvals`);
      expect(populated.rows[0]).toEqual({registry:1,credentials:1,configs:1,mappings:1,identity_maps:1,reports:1,approvals:1});
      await copyFile(join(migrationsDirectory,'009_snapshot_runs_and_recovery.sql'),join(upgradeDirectory,'009_snapshot_runs_and_recovery.sql'));
      expect(await runMigrations(upgradeFixture.pool,{directory:upgradeDirectory,environmentKind:'local_lab'}))
        .toMatchObject({applied:['009_snapshot_runs_and_recovery']});
      expect(await runMigrations(upgradeFixture.pool,{directory:upgradeDirectory,environmentKind:'local_lab'}))
        .toMatchObject({applied:[],skipped:expect.arrayContaining(['009_snapshot_runs_and_recovery'])});
      const after=await upgradeFixture.pool.query(`SELECT version,name,checksum FROM control.schema_migration WHERE version<=8 ORDER BY version`);
      expect(after.rows).toEqual(before.rows);
      const populatedAfter=await upgradeFixture.pool.query(`SELECT count(*)::int AS count FROM control.source_owner_approval WHERE source_id='pg-populated-008'`);
      expect(populatedAfter.rows[0].count).toBe(1);
    } finally { await upgradeFixture.close(); }
  },60_000);

  it('applies and repeats migration 009, with API and worker limited to their exact run rights', async () => {
    const first = await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
    expect(initialMigrations.applied).toContain('009_snapshot_runs_and_recovery');
    expect(first.applied).toEqual([]);
    expect(await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' }))
      .toMatchObject({ applied: [], skipped: expect.arrayContaining(['009_snapshot_runs_and_recovery']) });
    const grants = await fixture.pool.query(`SELECT has_column_privilege('hub_api','control.etl_run','run_id','SELECT') AS api_read,
      has_column_privilege('hub_worker','control.etl_run','request_digest','UPDATE') AS worker_proof_update,
      has_column_privilege('hub_api','control.etl_snapshot_schedule','interval_seconds','INSERT') AS api_schedule_insert,
      has_column_privilege('hub_api','control.etl_snapshot_schedule','interval_seconds','UPDATE') AS api_schedule_interval_update,
      has_table_privilege('public','control.etl_snapshot_schedule','INSERT') AS public_schedule_insert,
      has_table_privilege('hub_api','raw.ingestion_batch','SELECT') AS api_raw_read,
      has_column_privilege('hub_api','control.source_credential','digest','SELECT') AS api_source_secret_read,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname='control' AND c.relname='etl_run' AND a.grantee=0 AND a.privilege_type='SELECT') AS public_read`);
    expect(grants.rows[0]).toMatchObject({ api_read: true, worker_proof_update: false, api_schedule_insert:true,
      api_schedule_interval_update:true,public_schedule_insert:false,api_raw_read:false,public_read:false });
    expect(grants.rows[0].api_source_secret_read).toBe(false);
    const apiClient=await fixture.pool.connect();
    try {
      await apiClient.query('SET ROLE hub_api');
      await expect(apiClient.query('SELECT id FROM raw.ingestion_batch LIMIT 1')).rejects.toMatchObject({code:'42501'});
      await apiClient.query('RESET ROLE');
      await apiClient.query('SET ROLE hub_worker');
      await expect(apiClient.query(`UPDATE control.etl_run SET request_digest=decode(repeat('00',32),'hex') WHERE false`))
        .rejects.toMatchObject({code:'42501'});
      await apiClient.query('RESET ROLE');
    } finally { await apiClient.query('RESET ROLE').catch(()=>undefined); apiClient.release(); }
  });

  it('claims, starts, stages and publishes one immutable EXTRACTED manifest under the worker role', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const { createSnapshotStageStore, snapshotManifestDigest } = await import('../etl-worker/snapshot-stage-store.js');
    const run = await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','stage-manifest');
    const store = createSnapshotStageStore(roleScopedPool('hub_worker'));
    const [claim, duplicateClaim] = await Promise.all([
      store.claim(owner.tenantId,'pg-main',60),store.claim(owner.tenantId,'pg-main',60),
    ]);
    expect([claim,duplicateClaim].filter(Boolean)).toHaveLength(1);
    const activeClaim = claim ?? duplicateClaim!;
    const proof = await store.loadFrozenProof(owner.tenantId,'pg-main',run.run_id);
    expect(proof).toMatchObject({ run_id:run.run_id,expected_entities:['customer'],endpoint_profile_digest:expect.any(String) });
    const attempt = await store.beginAttempt(owner.tenantId,'pg-main',run.run_id,activeClaim.claim_token,60);
    expect(attempt.ordinal).toBe(1);
    const row = { entity:'customer' as const,relation:'customer' as const,source_pk:'C-1',parent_source_pk:'',source_version:null,
      facts:{customer_name:'Acme',source_updated_at:'2026-10-25 10:00:00.123456+00'} };
    const pageDigest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    await store.writePage(owner.tenantId,'pg-main',run.run_id,attempt.attempt_id,activeClaim.claim_token,{ entity:'customer',relation:'customer',
      page_no:1,rows:[row],first_key:'C-1',last_key:'C-1',page_digest:pageDigest });
    const manifest = { state:'EXTRACTED',relations:['customer'],relation_counts:[{relation:'customer',row_count:1,page_count:1,page_digests:[pageDigest]}],
      row_count:1,page_count:1,source_snapshot_identity:'a'.repeat(64),attempt_id:attempt.attempt_id,operation_id:attempt.operation_id,
      profile_digest:proof.endpoint_profile_digest,mapping_digest:proof.mapping_digest,config_digest:proof.config_digest,
      identity_mapping_digest:proof.identity_mapping_digest };
    await expect(store.complete(owner.tenantId,'pg-main',run.run_id,attempt.attempt_id,activeClaim.claim_token,
      manifest,snapshotManifestDigest(manifest))).resolves.toBe(1);
    const state = await fixture.pool.query(`SELECT r.status,r.extracted_count,m.state,m.manifest_digest,
      (SELECT count(*)::int FROM control.etl_snapshot_stage_record s WHERE s.run_id=r.run_id) AS records
      FROM control.etl_run r JOIN control.etl_snapshot_manifest m USING(tenant_key,source_id,run_id)
      WHERE r.run_id=$1`,[run.run_id]);
    expect(state.rows[0]).toMatchObject({status:'VALIDATING',extracted_count:'1',state:'EXTRACTED',records:1});
    const continuation= (await import('../etl-worker/snapshot-continuation-store.js')).createSnapshotContinuationStore(roleScopedPool('hub_worker'));
    const staleClaim=await continuation.claim(owner.tenantId,'pg-main');
    expect(staleClaim).toBeTruthy();
    await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET claim_token=$2 WHERE run_id=$1`,[run.run_id,randomUUID()]);
    await expect(continuation.begin(staleClaim!)).resolves.toBe(0);
    const startsAfterStale=await fixture.pool.query(`SELECT c_start_count FROM control.etl_snapshot_continuation WHERE run_id=$1`,[run.run_id]);
    expect(startsAfterStale.rows[0].c_start_count).toBe(0);
    await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL WHERE run_id=$1`,[run.run_id]);
    const fencedClaim=await continuation.claim(owner.tenantId,'pg-main');
    expect(fencedClaim).toBeTruthy();
    await fixture.pool.query(`INSERT INTO control.source_security_barrier
      (tenant_key,source_id,barrier_type,reason_code,created_by) VALUES($1,'pg-main','SOURCE_SCOPE_SECURITY_REMOVAL','TEST_C_FENCE','snapshot_owner')`,
      [owner.tenantId]);
    await expect(continuation.loadProof(fencedClaim!)).rejects.toThrow('SNAPSHOT_C_PROOF_INVALID');
    const barrierEffects=await fixture.pool.query(`SELECT (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=$1) AS observations,
      (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=$1) AS outcomes`,[run.run_id]);
    expect(barrierEffects.rows[0]).toEqual({observations:0,outcomes:0});
  });

  it('restarts after terminating its owned PostgreSQL reader and publishes a fresh full scan', async () => {
    const sourceEvidence = join(fileURLToPath(new URL('../../docs/execution/alpha1/m1-task-5b-source-lifecycle.jsonl', import.meta.url)));
    const sourceFixture = await startOwnedPostgres({ evidenceFile:sourceEvidence,evidenceRoot,taskLabel:'m1task5',imageReference:postgresImage });
    const suffix = randomUUID().replaceAll('-','').slice(0,14);
    const sourceSchema = `m1_e2e_${suffix}`;
    const sourceOwner = `m1_e2eo_${suffix}`;
    const sourceReader = `m1_e2er_${suffix}`;
    const { default: pg } = await import('pg');
    const ownerPool = new pg.Pool({host:'127.0.0.1',port:sourceFixture.hostPort,database:'postgres',user:sourceOwner,max:1});
    try {
      await sourceFixture.pool.query(`CREATE ROLE ${sourceOwner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      await sourceFixture.pool.query(`CREATE ROLE ${sourceReader} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      await sourceFixture.pool.query(`CREATE SCHEMA ${sourceSchema} AUTHORIZATION ${sourceOwner}`);
      const ownerClient=await sourceFixture.pool.connect();
      try {
        await ownerClient.query(`SET ROLE ${sourceOwner}`);
        await ownerClient.query(`CREATE TABLE ${sourceSchema}.customers(customer_id text PRIMARY KEY,customer_name text NOT NULL,owner_id text NOT NULL,
          department_id text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL,source_version text NOT NULL DEFAULT '1',deleted_at timestamptz)`);
        await ownerClient.query(`CREATE TABLE ${sourceSchema}.orders(order_id bigint PRIMARY KEY,customer_id text NOT NULL,order_no text NOT NULL,
          status text NOT NULL,order_at timestamptz NOT NULL,amount numeric(20,2) NOT NULL,currency text NOT NULL,updated_at timestamptz NOT NULL)`);
        await ownerClient.query(`CREATE TABLE ${sourceSchema}.order_lines(line_id text PRIMARY KEY,order_id bigint NOT NULL REFERENCES ${sourceSchema}.orders(order_id),
          product_code text NOT NULL,product_name text NOT NULL,quantity numeric(20,6) NOT NULL,unit_price numeric(20,6) NOT NULL,line_amount numeric(20,2) NOT NULL)`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.customers VALUES('C-1','Customer','owner-ext','dept-ext','ACTIVE','2026-10-25 10:00:00.123456+00')`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.customers VALUES('C-2','Second Customer','owner-ext','dept-ext','ACTIVE','2026-10-25 10:00:01.123456+00')`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.orders VALUES(9007199254740993123,'C-1','O-1','DRAFT','2026-10-25 10:01:02.123456+00',
          123456789012345678.12,'USD','2026-10-25 10:01:03.123456+00')`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.order_lines VALUES('L-1',9007199254740993123,'SKU-1','Line',1.123456,
          123456789012.123456,138636548569.22)`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.order_lines VALUES('L-2',9007199254740993123,'SKU-2','Second Line',2.123456,
          223456789012.123456,238636548569.22)`);
      } finally { await ownerClient.query('RESET ROLE').catch(()=>undefined); ownerClient.release(); }
      await sourceFixture.pool.query(`GRANT USAGE ON SCHEMA ${sourceSchema} TO ${sourceReader}`);
      await sourceFixture.pool.query(`GRANT SELECT ON ${sourceSchema}.customers,${sourceSchema}.orders,${sourceSchema}.order_lines TO ${sourceReader}`);
      await ownerPool.query('SELECT 1');
      e2eEndpointProfile={revision:'owned-source-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:sourceFixture.hostPort,
        allow_loopback_plaintext:true,database:'postgres',user:sourceReader,schema:sourceSchema,entities:{
          customer:{table:'customers',source_pk:'customer_id',updated_at_field:'updated_at',version_field:'source_version',delete_field:'deleted_at'},
          order:{table:'orders',source_pk:'order_id',updated_at_field:'updated_at',lines:{table:'order_lines',order_fk:'order_id'}},
        }};
      await auth.repository.provisionSourceCredential({sourceId:'pg-e2e',tenantId:owner.tenantId,token:createCredential().secret,
        secretRef:'vault:/snapshot/source',allowedEntities:['customer','order'],revision:'1'});
      await auth.repository.updateSubject({tenantId:owner.tenantId,userId:owner.userId,departmentId:'sales-east',businessRole:'sales',
        managementScopes:owner.managementScopes});
      const allowedEntities=['customer'] as const;
      await service.create(owner,{source_id:'pg-e2e',data_owner_user_id:owner.userId,config:{name:'Owned order snapshot',connector:'postgresql',
        mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',
        allowed_entities:allowedEntities,delete_contract:'hard_delete'}});
      await service.writeMappings(owner,'pg-e2e','1',[
        {entity:'customer',source_field:'customer_name',target_field:'customer_name',transform:'trim'},
        {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
        {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
        {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
      ]);
      await service.writeIdentityMappings(owner,'pg-e2e',[
        {kind:'user',external_id:'owner-ext',target_id:owner.userId},
        {kind:'department',external_id:'dept-ext',target_id:'sales-east'},
      ]);
      const tested=await service.test(owner,'pg-e2e','1');
      expect(tested.status).toBe('PASS');
      const approved=await service.approve(owner,'pg-e2e','1',tested.test_report_id,tested.data_contract_ref);
      await service.activate(owner,'pg-e2e','1',approved.approval_id);
      const { createSnapshotRun }=await import('../etl-worker/snapshot-runs.js');
      const { createSnapshotStageStore,snapshotManifestDigest }=await import('../etl-worker/snapshot-stage-store.js');
      const store=createSnapshotStageStore(roleScopedPool('hub_worker'));
      const invalidRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e','1','manifest-negative-cases');
      const invalidClaim=await store.claim(owner.tenantId,'pg-e2e',60);
      expect(invalidClaim).toBeTruthy();
      const invalidAttempt=await store.beginAttempt(owner.tenantId,'pg-e2e',invalidRun.run_id,invalidClaim!.claim_token,60);
      const frozen=await store.loadFrozenProof(owner.tenantId,'pg-e2e',invalidRun.run_id);
      const emptyCounts=[{relation:'customer',row_count:0,page_count:0,page_digests:[]}];
      const validShape={state:'EXTRACTED',relations:['customer'],relation_counts:emptyCounts,row_count:0,page_count:0,
        source_snapshot_identity:'a'.repeat(64),attempt_id:invalidAttempt.attempt_id,operation_id:invalidAttempt.operation_id,
        profile_digest:frozen.endpoint_profile_digest,mapping_digest:frozen.mapping_digest,config_digest:frozen.config_digest,
        identity_mapping_digest:frozen.identity_mapping_digest};
      const {profile_digest:_profile,mapping_digest:_mapping,...missingProof}=validShape;
      const invalidManifests=[
        missingProof,
        {...validShape,relation_counts:[{...emptyCounts[0],relation:'order'}]},
        {...validShape,relation_counts:[{...emptyCounts[0],row_count:null}]},
        {...validShape,relation_counts:[{...emptyCounts[0],page_digests:['f'.repeat(64)]}]},
      ];
      for (const malformed of invalidManifests) {
        await expect(store.complete(owner.tenantId,'pg-e2e',invalidRun.run_id,invalidAttempt.attempt_id,invalidClaim!.claim_token,
          malformed,snapshotManifestDigest(malformed))).rejects.toMatchObject({code:'22023'});
      }
      const unpublished=await fixture.pool.query(`SELECT (SELECT count(*)::int FROM control.etl_snapshot_manifest WHERE run_id=$1) AS manifests,
        (SELECT status FROM control.etl_run_attempt WHERE attempt_id=$2) AS attempt_status`,[invalidRun.run_id,invalidAttempt.attempt_id]);
      expect(unpublished.rows[0]).toEqual({manifests:0,attempt_status:'RUNNING'});
      await expect(store.fail(owner.tenantId,'pg-e2e',invalidRun.run_id,invalidAttempt.attempt_id,invalidClaim!.claim_token,
        'SNAPSHOT_PROFILE_INVALID',false)).resolves.toBe('FAILED');
      const run=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e','1','owned-e2e-run');
      const rawFactory=createLocalLabPostgresSourceConnectionFactory();
      let sourceConnectCalls=0;
      const realFactory:PostgresSourceConnectionFactory={connect:async input=>{sourceConnectCalls++;return rawFactory.connect(input);}};
      let loseSourceOnce=true;
      let ownedReaderPid:number|undefined;
      const interruptedFactory: PostgresSourceConnectionFactory={connect:async input=>{
        const connection=await realFactory.connect(input);
        return {query:async(sql:string)=>{
          if(loseSourceOnce && sql.startsWith('FETCH') && sql.includes('hub_snapshot_customer')) {
            loseSourceOnce=false;
            if (!ownedReaderPid) throw new Error('owned source reader PID was not captured');
            const terminated=await sourceFixture.pool.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
              WHERE pid=$1 AND usename=$2 AND datname='postgres' AND client_addr IS NOT NULL`,[ownedReaderPid,sourceReader]);
            if (terminated.rows[0]?.terminated !== true) throw new Error('owned source reader backend identity changed before termination');
          }
          if (!ownedReaderPid) {
            const identity=await connection.query('SELECT pg_backend_pid() AS pid');
            ownedReaderPid=Number(identity.rows[0]?.pid);
            if (!Number.isSafeInteger(ownedReaderPid) || ownedReaderPid < 1) throw new Error('invalid owned source reader PID');
            const owned=await sourceFixture.pool.query(`SELECT 1 FROM pg_stat_activity
              WHERE pid=$1 AND usename=$2 AND datname='postgres' AND client_addr IS NOT NULL`,[ownedReaderPid,sourceReader]);
            if (owned.rowCount !== 1) throw new Error('source backend is not the owned read-only fixture reader');
          }
          return connection.query(sql);
        },cancel:async()=>connection.cancel(),close:async()=>connection.close()};
      }};
      const workerDependencies={secretResolver:{isConfiguredReference:async()=>true,resolve:async()=> 'fixture-password'},
        egressPolicy:{environmentKind:'local_lab' as const,policyId:'owned-local-egress'},pageSize:1,leaseSeconds:60};
      const strictWorkerTick=(dependencies:typeof workerDependencies & {sourceConnectionFactory:PostgresSourceConnectionFactory}) =>
        runDurableWorkerLoop(roleScopedPool('hub_worker'),{HUB_STRICT_INGESTION_WORKER_ONCE:'true'},dependencies);
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:interruptedFactory})).resolves.toBeUndefined();
      const incomplete=await fixture.pool.query(`SELECT r.status,a.ordinal,a.status AS attempt_status,a.error_code,
        count(s.source_pk)::int AS staged FROM control.etl_run r JOIN control.etl_run_attempt a USING(tenant_key,source_id,run_id)
        LEFT JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id)
        WHERE r.run_id=$1 GROUP BY r.status,a.ordinal,a.status,a.error_code`,[run.run_id]);
      expect(incomplete.rows).toEqual([{status:'SCANNING',ordinal:1,attempt_status:'INCOMPLETE',error_code:'SNAPSHOT_SOURCE_UNAVAILABLE',staged:0}]);
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      await fixture.pool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.run_id]);
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const staged=await fixture.pool.query(`SELECT r.status,r.extracted_count,r.completeness_summary,m.state,m.manifest->'relation_counts' AS counts,
        array_agg(DISTINCT s.relation ORDER BY s.relation) AS relations FROM control.etl_run r JOIN control.etl_snapshot_manifest m USING(tenant_key,source_id,run_id)
        JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id)
        WHERE r.run_id=$1 GROUP BY r.status,r.extracted_count,r.completeness_summary,m.state,m.manifest`,[run.run_id]);
      expect(staged.rows[0]).toMatchObject({status:'COMPLETE',extracted_count:'2',state:'EXTRACTED',relations:['customer']});
      expect(staged.rows[0].counts).toEqual([expect.objectContaining({relation:'customer',row_count:2,page_count:2})]);
      const candidates=await service.sourceCustomerCandidates(owner,'pg-e2e');
      expect(candidates.items.map(item=>item.source_pk)).toEqual(['C-1','C-2']);
      const c1=candidates.items.find(item=>item.source_pk==='C-1');
      expect(c1).toBeTruthy();
      e2eEndpointProfile={...e2eEndpointProfile!,entities:{...e2eEndpointProfile!.entities,
        order:{...e2eEndpointProfile!.entities.order!,customer_source_id:'pg-main'}}};
      await ownerPool.query(`UPDATE ${sourceSchema}.orders SET customer_id='C-F' WHERE order_id=9007199254740993123`);
      const combinedConfig={name:'Owned order snapshot',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',
        endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',allowed_entities:['customer','order'],delete_contract:'hard_delete'};
      const updated=await service.update(owner,'pg-e2e',{expected_revision:'1',config:combinedConfig});
      await service.writeMappings(owner,'pg-e2e',updated.revision,[
        {entity:'customer',source_field:'customer_name',target_field:'customer_name',transform:'trim'},
        {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
        {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
        {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
        {entity:'order',source_field:'customer_id',target_field:'customer_id',transform:'source-id'},
        {entity:'order',source_field:'order_no',target_field:'order_no',transform:'trim'},
        {entity:'order',source_field:'status',target_field:'status',transform:'trim'},
        {entity:'order',source_field:'order_at',target_field:'order_at',transform:'identity'},
        {entity:'order',source_field:'amount',target_field:'amount',transform:'decimal-string'},
        {entity:'order',source_field:'currency',target_field:'currency',transform:'trim'},
        {entity:'order',source_field:'line_id',target_field:'lines.source_line_id',transform:'source-id'},
        {entity:'order',source_field:'product_code',target_field:'lines.product_code',transform:'trim'},
        {entity:'order',source_field:'product_name',target_field:'lines.product_name',transform:'trim'},
        {entity:'order',source_field:'quantity',target_field:'lines.quantity',transform:'decimal-string'},
        {entity:'order',source_field:'unit_price',target_field:'lines.unit_price',transform:'decimal-string'},
        {entity:'order',source_field:'line_amount',target_field:'lines.line_amount',transform:'decimal-string'},
      ]);
      const testedCombined=await service.test(owner,'pg-e2e',updated.revision);
      const approvedCombined=await service.approve(owner,'pg-e2e',updated.revision,testedCombined.test_report_id,testedCombined.data_contract_ref);
      await service.activate(owner,'pg-e2e',updated.revision,approvedCombined.approval_id);
      const missingMapRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'owned-unmapped-combined-run');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const rejectedCombined=await fixture.pool.query(`SELECT status,completeness_summary FROM control.etl_run WHERE run_id=$1`,[missingMapRun.run_id]);
      expect(rejectedCombined.rows[0]).toMatchObject({status:'FAILED',completeness_summary:{status:'FAILED',error_code:'SNAPSHOT_IDENTITY_MAPPING_TARGET_INVALID'}});
      const rejectedEffects=await fixture.pool.query(`SELECT
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=$1) AS observations,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=$1) AS outcomes,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=$1) AS ranges`,[missingMapRun.run_id]);
      expect(rejectedEffects.rows[0]).toEqual({observations:0,outcomes:0,ranges:0});
      await service.updateIdentityMapping(owner,Buffer.from('pg-e2e\0customer\0C-1','utf8').toString('base64url'),'1',c1!.target_id,
        'confirm exact source customer before order bootstrap');
      await service.updateIdentityMapping(owner,Buffer.from('pg-e2e\0customer\0C-F','utf8').toString('base64url'),'2',c1!.target_id,
        'confirm foreign source customer reference');
      await fixture.pool.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id)
        VALUES($1,'pg-main','customer','C-F',$2,$2)`,[owner.tenantId,c1!.target_id]);
      const revalidatedCombined=await service.test(owner,'pg-e2e',updated.revision);
      const reapprovedCombined=await service.approve(owner,'pg-e2e',updated.revision,revalidatedCombined.test_report_id,revalidatedCombined.data_contract_ref);
      await service.activate(owner,'pg-e2e',updated.revision,reapprovedCombined.approval_id);
      const combinedRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'owned-combined-e2e-run');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const combined=await fixture.pool.query(`SELECT r.status,r.extracted_count,r.completeness_summary,m.manifest->'relation_counts' AS counts,
        array_agg(DISTINCT s.relation ORDER BY s.relation) AS relations FROM control.etl_run r JOIN control.etl_snapshot_manifest m USING(tenant_key,source_id,run_id)
        JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id)
        WHERE r.run_id=$1 GROUP BY r.status,r.extracted_count,r.completeness_summary,m.manifest`,[combinedRun.run_id]);
      expect(combined.rows[0]).toMatchObject({status:'COMPLETE',extracted_count:'5',relations:['customer','order','order_line']});
      expect(combined.rows[0].counts).toEqual([
        expect.objectContaining({relation:'customer',row_count:2,page_count:2}),
        expect.objectContaining({relation:'order',row_count:1,page_count:1}),
        expect.objectContaining({relation:'order_line',row_count:2,page_count:2}),
      ]);
      const foreignReference=await fixture.pool.query(`SELECT count(*)::int AS local_staged FROM control.etl_snapshot_stage_record
        WHERE run_id=$1 AND entity='customer' AND source_pk='C-F'`,[combinedRun.run_id]);
      expect(foreignReference.rows[0].local_staged).toBe(0);
      for (const relation of combined.rows[0].counts as Array<{page_count:number;page_digests:string[]}>)
        expect(relation.page_digests).toHaveLength(relation.page_count);
      const attempts=await fixture.pool.query(`SELECT a.ordinal,a.status,count(s.source_pk)::int AS staged FROM control.etl_run_attempt a
        LEFT JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id) WHERE a.run_id=$1
        GROUP BY a.ordinal,a.status ORDER BY a.ordinal`,[combinedRun.run_id]);
      expect(attempts.rows).toEqual([{ordinal:1,status:'COMPLETE',staged:5}]);
      const tupleRaceRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'foreign-customer-tuple-race');
      const {runSnapshotWorkerOnce:runSnapshotWorkerOnceForTuple}=await import('../etl-worker/snapshot-worker.js');
      await expect(runSnapshotWorkerOnceForTuple(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
      const unrelatedBarrierTargets=await fixture.pool.query(`SELECT
        (SELECT id FROM control.source_credential WHERE tenant_key=$1 AND source_id='pg-main' LIMIT 1) AS credential_id,
        (SELECT id FROM control.source_channel WHERE tenant_key=$1 AND source_id='pg-e2e' AND entity='customer') AS channel_id`,[owner.tenantId]);
      await fixture.pool.query(`INSERT INTO control.source_security_barrier
        (tenant_key,source_id,credential_id,entity,channel_id,barrier_type,reason_code,created_by)
        VALUES($1,'pg-e2e',$2,'order',$3,'SOURCE_SCOPE_SECURITY_REMOVAL','UNRELATED_C_BARRIER','snapshot_owner')`,
        [owner.tenantId,unrelatedBarrierTargets.rows[0].credential_id,unrelatedBarrierTargets.rows[0].channel_id]);
      const foreignTuple=await fixture.pool.query(`SELECT customer_id FROM control.canonical_source_identity
        WHERE tenant_key=$1 AND source_id='pg-main' AND entity='customer' AND source_pk='C-F'`,[owner.tenantId]);
      const foreignTarget=foreignTuple.rows[0].customer_id;
      const targetC2=candidates.items.find(item=>item.source_pk==='C-2')!.target_id;
      try {
        const {runSnapshotContinuationWorkerOnce}=await import('../etl-worker/snapshot-apply-worker.js');
        await expect(runSnapshotContinuationWorkerOnce(roleScopedPool('hub_worker'),20,60,{afterValidationSeal:async()=>{
          await fixture.pool.query(`UPDATE control.canonical_source_identity SET customer_id=$2,canonical_object_id=$2
            WHERE tenant_key=$1 AND source_id='pg-main' AND entity='customer' AND source_pk='C-F'`,[owner.tenantId,targetC2]);
        }})).resolves.toBe(1);
        const tupleRace=await fixture.pool.query(`SELECT r.status,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id) AS outcomes,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id AND entity='order') AS order_outcomes
          FROM control.etl_run r WHERE r.run_id=$1`,[tupleRaceRun.run_id]);
        expect(tupleRace.rows[0]).toEqual({status:'FAILED',outcomes:2,ranges:2,order_outcomes:0});
      } finally {
        await fixture.pool.query(`UPDATE control.canonical_source_identity SET customer_id=$2,canonical_object_id=$2
          WHERE tenant_key=$1 AND source_id='pg-main' AND entity='customer' AND source_pk='C-F'`,[owner.tenantId,foreignTarget]);
      }
      const firstObservation=await fixture.pool.query(`SELECT sequence_value::text AS sequence_value FROM control.etl_snapshot_observation
        WHERE tenant_key=$1 AND source_id='pg-e2e' AND run_id=$2`,[owner.tenantId,combinedRun.run_id]);
      const allocationsBeforeReplay=await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_snapshot_observation_allocation
        WHERE tenant_key=$1 AND source_id='pg-e2e'`,[owner.tenantId]);
      const outboxBeforeReplay=await fixture.pool.query(`SELECT count(*)::int AS count FROM control.canonical_apply_outbox
        WHERE tenant_key=$1 AND source_id='pg-e2e'`,[owner.tenantId]);
      const unchangedRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'owned-unchanged-replay');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const unchangedObservation=await fixture.pool.query(`SELECT sequence_value::text AS sequence_value FROM control.etl_snapshot_observation
        WHERE tenant_key=$1 AND source_id='pg-e2e' AND run_id=$2`,[owner.tenantId,unchangedRun.run_id]);
      const allocationsAfterReplay=await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_snapshot_observation_allocation
        WHERE tenant_key=$1 AND source_id='pg-e2e'`,[owner.tenantId]);
      const outboxAfterReplay=await fixture.pool.query(`SELECT count(*)::int AS count FROM control.canonical_apply_outbox
        WHERE tenant_key=$1 AND source_id='pg-e2e'`,[owner.tenantId]);
      expect(unchangedObservation.rows).toEqual(firstObservation.rows);
      expect(allocationsAfterReplay.rows).toEqual(allocationsBeforeReplay.rows);
      expect(outboxAfterReplay.rows).toEqual(outboxBeforeReplay.rows);
      const sourceWriter=await sourceFixture.pool.connect();
      try {
        await sourceWriter.query(`SET ROLE ${sourceOwner}`);
        await sourceWriter.query(`UPDATE ${sourceSchema}.customers SET customer_name='Changed customer',
          updated_at='2026-10-25 10:10:00.123456+00' WHERE customer_id='C-1'`);
      } finally { await sourceWriter.query('RESET ROLE').catch(()=>undefined); sourceWriter.release(); }
      const changedRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'owned-changed-snapshot');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const changedObservation=await fixture.pool.query(`SELECT sequence_value::text AS sequence_value FROM control.etl_snapshot_observation
        WHERE tenant_key=$1 AND source_id='pg-e2e' AND run_id=$2`,[owner.tenantId,changedRun.run_id]);
      expect(BigInt(changedObservation.rows[0].sequence_value)).toBeGreaterThan(BigInt(firstObservation.rows[0].sequence_value));
      const restoreA=await sourceFixture.pool.connect();
      try {
        await restoreA.query(`SET ROLE ${sourceOwner}`);
        await restoreA.query(`UPDATE ${sourceSchema}.customers SET customer_name='Customer',
          updated_at='2026-10-25 10:00:00.123456+00' WHERE customer_id='C-1'`);
      } finally { await restoreA.query('RESET ROLE').catch(()=>undefined); restoreA.release(); }
      const replayARun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'observation-a-b-a-replay');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const replayAState=await fixture.pool.query(`SELECT r.status,
        (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS sequence_value,
        (SELECT count(*)::int FROM control.etl_snapshot_observation_allocation WHERE tenant_key=r.tenant_key AND source_id=r.source_id) AS allocations,
        (SELECT cc.customer_name FROM control.canonical_source_identity i JOIN hub.canonical_customer cc ON cc.id=i.customer_id
          WHERE i.tenant_key=r.tenant_key AND i.source_id=r.source_id AND i.entity='customer' AND i.source_pk='C-1') AS customer_name
        FROM control.etl_run r WHERE r.run_id=$1`,[replayARun.run_id]);
      expect(replayAState.rows[0].status).toBe('COMPLETE');
      expect(BigInt(replayAState.rows[0].sequence_value)).toBeGreaterThan(BigInt(changedObservation.rows[0].sequence_value));
      expect(replayAState.rows[0].customer_name).toBe('Customer');
      const partialWriter=await sourceFixture.pool.connect();
      try {
        await partialWriter.query(`SET ROLE ${sourceOwner}`);
        await partialWriter.query(`UPDATE ${sourceSchema}.customers SET customer_name='Partial B',
          updated_at='2026-10-25 10:12:00.123456+00' WHERE customer_id='C-1'`);
      } finally { await partialWriter.query('RESET ROLE').catch(()=>undefined); partialWriter.release(); }
      const partialRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'observation-partial-b-fails');
      const {runSnapshotWorkerOnce:runPartialScan}=await import('../etl-worker/snapshot-worker.js');
      await expect(runPartialScan(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
      let interruptedPartial=false;
      const {runSnapshotContinuationWorkerOnce:runPartialContinuation}=await import('../etl-worker/snapshot-apply-worker.js');
      await expect(runPartialContinuation(roleScopedPool('hub_worker'),20,60,{afterAggregateCommit:async()=>{
        if(!interruptedPartial){interruptedPartial=true;throw new Error('fixture partial aggregate failure');}
      }})).resolves.toBe(1);
      const partialState=await fixture.pool.query(`SELECT r.status,
        (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS sequence_value,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges
        FROM control.etl_run r WHERE r.run_id=$1`,[partialRun.run_id]);
      expect(partialState.rows[0]).toMatchObject({status:'FAILED',ranges:1});
      const restoreAfterPartial=await sourceFixture.pool.connect();
      try {
        await restoreAfterPartial.query(`SET ROLE ${sourceOwner}`);
        await restoreAfterPartial.query(`UPDATE ${sourceSchema}.customers SET customer_name='Customer',
          updated_at='2026-10-25 10:00:00.123456+00' WHERE customer_id='C-1'`);
      } finally { await restoreAfterPartial.query('RESET ROLE').catch(()=>undefined); restoreAfterPartial.release(); }
      const replayAfterPartial=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'observation-partial-b-a-replay');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const replayAfterPartialState=await fixture.pool.query(`SELECT r.status,
        (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS sequence_value
        FROM control.etl_run r WHERE r.run_id=$1`,[replayAfterPartial.run_id]);
      expect(replayAfterPartialState.rows[0].status).toBe('COMPLETE');
      expect(BigInt(replayAfterPartialState.rows[0].sequence_value)).toBeGreaterThan(BigInt(partialState.rows[0].sequence_value));
      const longRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'continuation-heartbeat-long-run');
      const {runSnapshotWorkerOnce}=await import('../etl-worker/snapshot-worker.js');
      await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
      let longProofPause=false,heartbeatCalls=0;
      const shortLeasePool=new Proxy(roleScopedPool('hub_worker'),{get(target,property){
        if(property==='connect') return async()=>{
          const client=await fixture.pool.connect(); if(client.listenerCount('error')===0) client.on('error',()=>undefined);
          const original=client.query.bind(client);
          const query=(async(sql:unknown,...args:unknown[])=>{
            if(typeof sql==='string'&&sql.includes('control.heartbeat_etl_snapshot_continuation')) heartbeatCalls++;
            const result=await original(sql as never,...args as never[]);
            if(typeof sql==='string'&&/^BEGIN(?:\s|$)/i.test(sql.trim())) await original('SET LOCAL ROLE hub_worker');
            return result;
          }) as typeof client.query;
          return {query,release:client.release.bind(client)};
        };
        const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
      }}) as typeof fixture.pool;
      const {runSnapshotContinuationWorkerOnce:runShortLeaseContinuation}=await import('../etl-worker/snapshot-apply-worker.js');
      await expect(runShortLeaseContinuation(shortLeasePool,20,10,{afterProofLoaded:async()=>{
        longProofPause=true;
        await new Promise(resolve=>setTimeout(resolve,12_000));
      }})).resolves.toBe(1);
      const longRunState=await fixture.pool.query(`SELECT status,
        (SELECT c_start_count FROM control.etl_snapshot_continuation WHERE run_id=$1) AS starts FROM control.etl_run WHERE run_id=$1`,
        [longRun.run_id]);
      expect(longProofPause).toBe(true);
      expect(heartbeatCalls).toBeGreaterThan(0);
      expect(longRunState.rows[0]).toEqual({status:'COMPLETE',starts:1});
      const expiredFailRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'expired-token-failure-fence');
      await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
      const {createSnapshotContinuationStore}=await import('../etl-worker/snapshot-continuation-store.js');
      const continuationStore=createSnapshotContinuationStore(roleScopedPool('hub_worker'));
      const expiredClaim=await continuationStore.claim(owner.tenantId,'pg-e2e',10);
      expect(expiredClaim).toBeTruthy();
      await expect(continuationStore.begin(expiredClaim!)).resolves.toBe(1);
      await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
        [expiredFailRun.run_id]);
      await expect(continuationStore.fail(expiredClaim!,'SNAPSHOT_EXPIRED_FAILURE_TEST',false)).resolves.toBe('STALE');
      const expiredFailState=await fixture.pool.query(`SELECT r.status,s.active_run_id,
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=$1) AS observations
        FROM control.etl_run r JOIN control.etl_snapshot_schedule s USING(tenant_key,source_id) WHERE r.run_id=$1`,[expiredFailRun.run_id]);
      expect(expiredFailState.rows[0]).toEqual({status:'VALIDATING',active_run_id:expiredFailRun.run_id,observations:0});
      await fixture.pool.query(`UPDATE control.etl_run SET status='FAILED',completed_at=clock_timestamp() WHERE run_id=$1`,[expiredFailRun.run_id]);
      await fixture.pool.query(`UPDATE control.etl_snapshot_schedule SET active_run_id=NULL WHERE active_run_id=$1`,[expiredFailRun.run_id]);
      const invalidOwnerWriter=await sourceFixture.pool.connect();
      try {
        await invalidOwnerWriter.query(`SET ROLE ${sourceOwner}`);
        await invalidOwnerWriter.query(`UPDATE ${sourceSchema}.customers SET customer_name='R4 must not commit',
          updated_at='2026-10-25 10:30:00.123456+00' WHERE customer_id='C-1'`);
        await invalidOwnerWriter.query(`UPDATE ${sourceSchema}.customers SET owner_id='owner-missing',
          updated_at='2026-10-25 10:30:01.123456+00' WHERE customer_id='C-2'`);
      } finally { await invalidOwnerWriter.query('RESET ROLE').catch(()=>undefined); invalidOwnerWriter.release(); }
      const beforeInvalidOwner=await fixture.pool.query(`SELECT cc.customer_name,
        (SELECT count(*)::int FROM control.canonical_apply_outbox WHERE source_id='pg-e2e') AS outbox_count
        FROM control.canonical_source_identity i JOIN hub.canonical_customer cc ON cc.id=i.customer_id
        WHERE i.tenant_key=$1 AND i.source_id='pg-e2e' AND i.entity='customer' AND i.source_pk='C-1'`,[owner.tenantId]);
      const invalidOwnerRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'late-customer-owner-invalid');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const afterInvalidOwner=await fixture.pool.query(`SELECT r.status,
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS observations,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id) AS outcomes,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges,
        (SELECT count(*)::int FROM control.etl_snapshot_checkpoint WHERE run_id=r.run_id) AS checkpoints,
        (SELECT cc.customer_name FROM control.canonical_source_identity i JOIN hub.canonical_customer cc ON cc.id=i.customer_id
          WHERE i.tenant_key=r.tenant_key AND i.source_id=r.source_id AND i.entity='customer' AND i.source_pk='C-1') AS customer_name,
        (SELECT count(*)::int FROM control.canonical_apply_outbox WHERE source_id='pg-e2e') AS outbox_count
        FROM control.etl_run r WHERE r.run_id=$1`,[invalidOwnerRun.run_id]);
      expect(afterInvalidOwner.rows[0]).toMatchObject({status:'FAILED',observations:0,outcomes:0,ranges:0,checkpoints:0,
        customer_name:beforeInvalidOwner.rows[0].customer_name,outbox_count:beforeInvalidOwner.rows[0].outbox_count});
      const restoreIdentityFacts=await sourceFixture.pool.connect();
      try {
        await restoreIdentityFacts.query(`SET ROLE ${sourceOwner}`);
        await restoreIdentityFacts.query(`UPDATE ${sourceSchema}.customers SET customer_name='Customer',owner_id='owner-ext',
          updated_at='2026-10-25 10:00:00.123456+00' WHERE customer_id='C-1'`);
        await restoreIdentityFacts.query(`UPDATE ${sourceSchema}.customers SET owner_id='owner-ext',
          updated_at='2026-10-25 10:00:01.123456+00' WHERE customer_id='C-2'`);
      } finally { await restoreIdentityFacts.query('RESET ROLE').catch(()=>undefined); restoreIdentityFacts.release(); }
      const { createSnapshotRun: createStaleRangeRun } = await import('../etl-worker/snapshot-runs.js');
      const staleTokenRun=await createStaleRangeRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,'stale-token-atomic-range');
      const staleWriter=await sourceFixture.pool.connect();
      try {
        await staleWriter.query(`SET ROLE ${sourceOwner}`);
        await staleWriter.query(`UPDATE ${sourceSchema}.customers SET customer_name='Must roll back',
          updated_at='2026-10-25 10:15:00.123456+00' WHERE customer_id='C-1'`);
      } finally { await staleWriter.query('RESET ROLE').catch(()=>undefined); staleWriter.release(); }
      const canonicalBeforeStale=await fixture.pool.query(`SELECT cc.customer_name,
        (SELECT count(*)::int FROM control.canonical_apply_outbox o WHERE o.source_id='pg-e2e') AS outbox_count
        FROM control.canonical_source_identity i JOIN hub.canonical_customer cc ON cc.id=i.customer_id
        WHERE i.tenant_key=$1 AND i.source_id='pg-e2e' AND i.entity='customer' AND i.source_pk='C-1'`,[owner.tenantId]);
      let invalidatedAfterHelper=false;
      const stalePool=new Proxy(roleScopedPool('hub_worker'),{get(target,property){
        if(property==='connect') return async()=>{
          const client=await fixture.pool.connect(); if(client.listenerCount('error')===0) client.on('error',()=>undefined);
          const original=client.query.bind(client);
          const query=(async(sql:unknown,...args:unknown[])=>{
            if(!invalidatedAfterHelper&&typeof sql==='string'&&sql.includes('control.record_etl_snapshot_aggregate')&&
                Array.isArray(args[0])&&String((args[0] as unknown[])[2])===staleTokenRun.run_id) {
              invalidatedAfterHelper=true;
              await original(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second'
                WHERE run_id=$1 AND claim_token=$2`,[staleTokenRun.run_id,(args[0] as unknown[])[4]]);
            }
            const result=await original(sql as never,...args as never[]);
            if(typeof sql==='string'&&/^BEGIN(?:\s|$)/i.test(sql.trim())) await original('SET LOCAL ROLE hub_worker');
            return result;
          }) as typeof client.query;
          return {query,release:client.release.bind(client)};
        };
        const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
      }}) as typeof fixture.pool;
      await expect(runDurableWorkerLoop(stalePool,{HUB_STRICT_INGESTION_WORKER_ONCE:'true'},
        {...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      expect(invalidatedAfterHelper).toBe(true);
      const canonicalAfterStale=await fixture.pool.query(`SELECT cc.customer_name,
        (SELECT count(*)::int FROM control.canonical_apply_outbox o WHERE o.source_id='pg-e2e') AS outbox_count
        FROM control.canonical_source_identity i JOIN hub.canonical_customer cc ON cc.id=i.customer_id
        WHERE i.tenant_key=$1 AND i.source_id='pg-e2e' AND i.entity='customer' AND i.source_pk='C-1'`,[owner.tenantId]);
      expect(canonicalAfterStale.rows[0]).toEqual(canonicalBeforeStale.rows[0]);
      const staleRunEffects=await fixture.pool.query(`SELECT r.status,
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS observations,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id) AS outcomes,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges,
        (SELECT count(*)::int FROM control.etl_snapshot_checkpoint WHERE run_id=r.run_id) AS checkpoints
        FROM control.etl_run r WHERE r.run_id=$1`,[staleTokenRun.run_id]);
      expect(staleRunEffects.rows[0]).toMatchObject({observations:1,outcomes:0,ranges:0,checkpoints:0});
      const {runSnapshotContinuationWorkerOnce}=await import('../etl-worker/snapshot-apply-worker.js');
      const runWithDestinationCrash=async(mode:'before'|'after',key:string)=>{
        const writer=await sourceFixture.pool.connect();
        try {
          await writer.query(`SET ROLE ${sourceOwner}`);
          await writer.query(`UPDATE ${sourceSchema}.customers SET customer_name=$1,updated_at=$2 WHERE customer_id='C-1'`,
            [`Crash ${mode} ${key}`,`2026-10-25 10:20:0${mode==='before'?'1':'2'}.123456+00`]);
        } finally { await writer.query('RESET ROLE').catch(()=>undefined); writer.release(); }
        const crashRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,key);
        let faultHit=false;
        const basePool=roleScopedPool('hub_worker');
        const faultPool=new Proxy(basePool,{get(target,property){
          if(property==='connect') return async()=>{
            const client=await fixture.pool.connect(); if(client.listenerCount('error')===0) client.on('error',()=>undefined);
            let armed=false; let backendPid:number|undefined;
            const original=client.query.bind(client);
            const query=(async(sql:unknown,...args:unknown[])=>{
              if(typeof sql==='string'&&sql.trim().toUpperCase()==='COMMIT'&&armed) {
                armed=false; faultHit=true;
                if(mode==='before') {
                  if(!backendPid) throw new Error('destination backend PID missing before commit fault');
                  const killed=await fixture.pool.query<{terminated:boolean}>(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
                    WHERE pid=$1 AND usename='postgres' AND datname='postgres' AND client_addr IS NOT NULL`,[backendPid]);
                  if(killed.rows[0]?.terminated!==true) throw new Error('owned destination backend identity changed before termination');
                  return await original(sql as never,...args as never[]);
                }
                await original(sql as never,...args as never[]);
                if(!backendPid) throw new Error('destination backend PID missing after commit fault');
                const killed=await fixture.pool.query<{terminated:boolean}>(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
                  WHERE pid=$1 AND usename='postgres' AND datname='postgres' AND client_addr IS NOT NULL`,[backendPid]);
                if(killed.rows[0]?.terminated!==true) throw new Error('owned destination backend identity changed after termination');
                // Surface the driver's real transport failure after the backend is killed.
                // Do not synthesize a SQLSTATE: recovery must classify the actual pg error.
                return await original('SELECT 1' as never);
              }
              const result=await original(sql as never,...args as never[]);
              if(typeof sql==='string'&&/^BEGIN(?:\s|$)/i.test(sql.trim())) await original('SET LOCAL ROLE hub_worker');
              if(typeof sql==='string'&&sql.includes('control.record_etl_snapshot_aggregate')&&Array.isArray(args[0])&&String((args[0] as unknown[])[8])==='C-1') {
                armed=true;
                const identity=await original('SELECT pg_backend_pid() AS pid');
                backendPid=Number(identity.rows[0]?.pid);
              }
              return result;
            }) as typeof client.query;
            return {query,release:client.release.bind(client)};
          };
          const value=Reflect.get(target,property,target);
          return typeof value==='function'?value.bind(target):value;
        }}) as typeof fixture.pool;
        await expect(runDurableWorkerLoop(faultPool,{HUB_STRICT_INGESTION_WORKER_ONCE:'true'},
          {...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
        expect(faultHit).toBe(true);
        const beforeRestart=await fixture.pool.query(`SELECT
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=$1) AS outcomes,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=$1) AS ranges,
          (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=$1) AS observations`,[crashRun.run_id]);
        expect(beforeRestart.rows[0]).toMatchObject(mode==='before'?{outcomes:0,ranges:0,observations:1}:{outcomes:1,ranges:1,observations:1});
        const sourceCallsBeforeRestart=sourceConnectCalls;
        await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET next_retry_at=clock_timestamp() WHERE run_id=$1`,[crashRun.run_id]);
        const retryState=await fixture.pool.query(`SELECT r.status,s.active_run_id,c.c_start_count,c.next_retry_at<=clock_timestamp() AS due,
          c.claim_token,c.lease_until FROM control.etl_run r JOIN control.etl_snapshot_schedule s USING(tenant_key,source_id)
          JOIN control.etl_snapshot_continuation c USING(tenant_key,source_id,run_id) WHERE r.run_id=$1`,[crashRun.run_id]);
        expect(retryState.rows[0]).toMatchObject({status:'APPLYING',active_run_id:crashRun.run_id,c_start_count:1});
        if(retryState.rows[0].claim_token!==null) {
          await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1`,
            [crashRun.run_id]);
          await expect(runSnapshotContinuationWorkerOnce(roleScopedPool('hub_worker'))).resolves.toBe(0);
        }
        await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET next_retry_at=clock_timestamp() WHERE run_id=$1`,[crashRun.run_id]);
        await expect(runSnapshotContinuationWorkerOnce(roleScopedPool('hub_worker'))).resolves.toBe(1);
        expect(sourceConnectCalls).toBe(sourceCallsBeforeRestart);
        const recovered=await fixture.pool.query(`SELECT r.status,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome o WHERE o.run_id=r.run_id) AS outcomes,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_range a WHERE a.run_id=r.run_id) AS ranges,
          (SELECT count(*)::int FROM control.etl_snapshot_observation x WHERE x.run_id=r.run_id) AS observations
          FROM control.etl_run r WHERE r.run_id=$1`,[crashRun.run_id]);
        expect(recovered.rows[0]).toEqual({status:'COMPLETE',outcomes:3,ranges:3,observations:1});
      };
      await runWithDestinationCrash('before','owned-crash-before-commit');
      await runWithDestinationCrash('after','owned-crash-after-commit');
      const processCrashRun=async(phase:'before'|'after')=>{
        if(!evidenceRoot) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
        const crashRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',updated.revision,`owned-node-crash-${phase}`);
        await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
        const child=fork('acceptance-tests/fixtures/snapshot-continuation-child.mjs',[],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc'],env:{
          SNAPSHOT_C_TEST_PG_PORT:String(fixture.hostPort),SNAPSHOT_C_TEST_PHASE:phase,SNAPSHOT_C_TEST_RUN_ID:crashRun.run_id}});
        const lifecycle=join(evidenceRoot,'node-child-lifecycle.jsonl');
        await appendFile(lifecycle,JSON.stringify({event:'spawned',phase,pid:child.pid,run_id:crashRun.run_id})+'\n','utf8');
        const boundary=await new Promise<{type:string;run_id:string}>((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('NODE_CRASH_BOUNDARY_TIMEOUT')),30_000);
          child.on('message',message=>{const value=message as {type:string;run_id:string};if(value.type==='aggregate-boundary') {clearTimeout(timer);resolve(value);}});
          child.on('error',reject);
        });
        expect(boundary.run_id).toBe(crashRun.run_id);
        child.kill('SIGKILL');
        const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
        await appendFile(lifecycle,JSON.stringify({event:'killed',phase,pid:child.pid,signal:exit.signal,run_id:crashRun.run_id})+'\n','utf8');
        expect(exit.signal).toBe('SIGKILL');
        const beforeRestart=await fixture.pool.query(`SELECT
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=$1) AS outcomes,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=$1) AS ranges,
          (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE run_id=$1) AS observation`,[crashRun.run_id]);
        expect(beforeRestart.rows[0]).toMatchObject(phase==='before'?{outcomes:0,ranges:0}:{outcomes:1,ranges:1});
        const observation=beforeRestart.rows[0].observation;
        const rangesBefore=await fixture.pool.query(`SELECT entity,source_pk FROM control.etl_snapshot_apply_range WHERE run_id=$1 ORDER BY entity,source_pk`,[crashRun.run_id]);
        const sourceCallsBeforeRestart=sourceConnectCalls;
        await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second',next_retry_at=clock_timestamp() WHERE run_id=$1`,[crashRun.run_id]);
        await expect(runSnapshotContinuationWorkerOnce(roleScopedPool('hub_worker'))).resolves.toBe(0);
        await fixture.pool.query(`UPDATE control.etl_snapshot_continuation SET next_retry_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[crashRun.run_id]);
        await expect(runSnapshotContinuationWorkerOnce(roleScopedPool('hub_worker'))).resolves.toBe(1);
        expect(sourceConnectCalls).toBe(sourceCallsBeforeRestart);
        const afterRestart=await fixture.pool.query(`SELECT r.status,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id) AS outcomes,
          (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges,
          (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS observation
          FROM control.etl_run r WHERE r.run_id=$1`,[crashRun.run_id]);
        expect(afterRestart.rows[0]).toEqual({status:'COMPLETE',outcomes:3,ranges:3,observation});
        const rangesAfter=await fixture.pool.query(`SELECT entity,source_pk FROM control.etl_snapshot_apply_range WHERE run_id=$1 ORDER BY entity,source_pk`,[crashRun.run_id]);
        expect(rangesAfter.rows).toEqual(expect.arrayContaining(rangesBefore.rows));
        await appendFile(lifecycle,JSON.stringify({event:'recovered',phase,pid:child.pid,signal:exit.signal,run_id:crashRun.run_id,
          observation,range_count:rangesAfter.rowCount})+'\n','utf8');
      };
      await processCrashRun('before');
      await processCrashRun('after');
      e2eEndpointProfile={...e2eEndpointProfile!,entities:{...e2eEndpointProfile!.entities,
        order:{...e2eEndpointProfile!.entities.order!,customer_source_id:'pg-e2e'}}};
      await ownerPool.query(`UPDATE ${sourceSchema}.orders SET customer_id='C-1' WHERE order_id=9007199254740993123`);
      const sameSourceUpdate=await service.update(owner,'pg-e2e',{expected_revision:updated.revision,config:combinedConfig});
      const sameSourceTest=await service.test(owner,'pg-e2e',sameSourceUpdate.revision);
      const sameSourceApproval=await service.approve(owner,'pg-e2e',sameSourceUpdate.revision,sameSourceTest.test_report_id,sameSourceTest.data_contract_ref);
      await service.activate(owner,'pg-e2e',sameSourceUpdate.revision,sameSourceApproval.approval_id);
      const sameSourceRaceRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e',sameSourceUpdate.revision,'same-customer-tuple-race');
      await expect(runSnapshotWorkerOnceForTuple(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeGreaterThanOrEqual(1);
      const sameSourceTarget=await fixture.pool.query(`SELECT customer_id FROM control.canonical_source_identity
        WHERE tenant_key=$1 AND source_id='pg-e2e' AND entity='customer' AND source_pk='C-1'`,[owner.tenantId]);
      const sameSourceC1=sameSourceTarget.rows[0].customer_id;
      let sameSourceChanged=false;
      const {runSnapshotContinuationWorkerOnce:runSameSourceContinuation}=await import('../etl-worker/snapshot-apply-worker.js');
      await expect(runSameSourceContinuation(roleScopedPool('hub_worker'),20,60,{afterAggregateCommit:async item=>{
        if(!sameSourceChanged&&item.entity==='customer'&&item.source_pk==='C-1') {
          sameSourceChanged=true;
          await fixture.pool.query(`UPDATE control.canonical_source_identity SET customer_id=$2,canonical_object_id=$2
            WHERE tenant_key=$1 AND source_id='pg-e2e' AND entity='customer' AND source_pk='C-1'`,[owner.tenantId,targetC2]);
        }
      }})).resolves.toBe(1);
      const sameRace=await fixture.pool.query(`SELECT r.status,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id AND entity='order') AS order_outcomes
        FROM control.etl_run r WHERE r.run_id=$1`,[sameSourceRaceRun.run_id]);
      expect(sameRace.rows[0]).toEqual({status:'FAILED',order_outcomes:0});
      await fixture.pool.query(`UPDATE control.canonical_source_identity SET customer_id=$2,canonical_object_id=$2
        WHERE tenant_key=$1 AND source_id='pg-e2e' AND entity='customer' AND source_pk='C-1'`,[owner.tenantId,sameSourceC1]);
      await ownerPool.query(`ALTER TABLE ${sourceSchema}.customers ADD COLUMN boolean_delete boolean NOT NULL DEFAULT false`);
      e2eEndpointProfile={...e2eEndpointProfile!,entities:{...e2eEndpointProfile!.entities,
        customer:{...e2eEndpointProfile!.entities.customer,delete_field:'boolean_delete'}}};
      await auth.repository.provisionSourceCredential({sourceId:'pg-version',tenantId:owner.tenantId,token:createCredential().secret,
        secretRef:'vault:/snapshot/source',allowedEntities:['customer'],revision:'1'});
      await service.create(owner,{source_id:'pg-version',data_owner_user_id:owner.userId,config:{name:'Owned source version snapshot',connector:'postgresql',
        mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',
        allowed_entities:['customer'],delete_contract:'tombstone'}});
      await service.writeMappings(owner,'pg-version','1',[
        {entity:'customer',source_field:'customer_name',target_field:'customer_name',transform:'trim'},
        {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
        {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
        {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
      ]);
      await service.writeIdentityMappings(owner,'pg-version',[
        {kind:'user',external_id:'owner-ext',target_id:owner.userId},{kind:'department',external_id:'dept-ext',target_id:'sales-east'},
      ]);
      const versionTest=await service.test(owner,'pg-version','1');
      const versionApproval=await service.approve(owner,'pg-version','1',versionTest.test_report_id,versionTest.data_contract_ref);
      await service.activate(owner,'pg-version','1',versionApproval.approval_id);
      const versionRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-version','1','owned-source-version-no-observation');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const versionState=await fixture.pool.query(`SELECT r.status,
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=r.run_id) AS observations,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=r.run_id) AS outcomes,
        (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=r.run_id) AS ranges
        FROM control.etl_run r WHERE r.run_id=$1`,[versionRun.run_id]);
      expect(versionState.rows[0]).toEqual({status:'COMPLETE',observations:0,outcomes:2,ranges:2});
      await ownerPool.query(`UPDATE ${sourceSchema}.customers SET boolean_delete=true,source_version='2',
        updated_at='2026-10-25 11:00:00.654321+00' WHERE customer_id='C-2'`);
      const tombstoneRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-version','1','owned-source-version-tombstone');
      await expect(strictWorkerTick({...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBeUndefined();
      const deletedReceipt=await fixture.pool.query(`SELECT r.deleted,r.source_version::text AS source_version,c.deleted_at::text AS deleted_at
        FROM control.source_version_receipt r JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.source_id,i.entity,i.source_pk)=(r.tenant_key,r.source_id,r.entity,r.source_pk)
        JOIN hub.canonical_customer c ON c.id=i.customer_id
        WHERE r.tenant_key=$1 AND r.source_id='pg-version' AND r.entity='customer' AND r.source_pk='C-2'`,[owner.tenantId]);
      const tombstoneState=await fixture.pool.query(`SELECT status,
        (SELECT count(*)::int FROM control.etl_snapshot_observation WHERE run_id=$1) AS observations FROM control.etl_run WHERE run_id=$1`,
        [tombstoneRun.run_id]);
      expect(deletedReceipt.rows[0]).toEqual({deleted:true,source_version:'2',deleted_at:'2026-10-25 11:00:00.654321+00'});
      expect(tombstoneState.rows[0]).toEqual({status:'COMPLETE',observations:0});
    } finally {
      await ownerPool.end();
      await sourceFixture.pool.query(`DROP SCHEMA IF EXISTS ${sourceSchema} CASCADE`);
      await sourceFixture.pool.query(`DROP ROLE IF EXISTS ${sourceReader}`);
      await sourceFixture.pool.query(`DROP ROLE IF EXISTS ${sourceOwner}`);
      await sourceFixture.close();
      e2eEndpointProfile=undefined;
    }
  },60_000);

  it('persists the five second retry delay and fences a prior attempt after a fresh claim', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const { createSnapshotStageStore } = await import('../etl-worker/snapshot-stage-store.js');
    const run = await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','retry-fence');
    const store = createSnapshotStageStore(roleScopedPool('hub_worker'));
    const firstClaim = await store.claim(owner.tenantId,'pg-main',60);
    expect(firstClaim).toBeTruthy();
    const firstAttempt = await store.beginAttempt(owner.tenantId,'pg-main',run.run_id,firstClaim!.claim_token,60);
    await expect(store.fail(owner.tenantId,'pg-main',run.run_id,firstAttempt.attempt_id,firstClaim!.claim_token,
      'SNAPSHOT_SOURCE_UNAVAILABLE',true)).resolves.toBe('RETRY');
    const retryState = await fixture.pool.query(`SELECT r.status,r.snapshot_available_at>clock_timestamp() AS delayed,a.status AS attempt_status,
      a.available_at>clock_timestamp() AS attempt_delayed FROM control.etl_run r JOIN control.etl_run_attempt a USING(run_id)
      WHERE r.run_id=$1`,[run.run_id]);
    expect(retryState.rows[0]).toMatchObject({status:'SCANNING',delayed:true,attempt_status:'INCOMPLETE',attempt_delayed:true});
    await expect(store.claim(owner.tenantId,'pg-main',60)).resolves.toBeUndefined();
    await fixture.pool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.run_id]);
    const secondClaim = await store.claim(owner.tenantId,'pg-main',60);
    expect(secondClaim).toBeTruthy();
    const secondAttempt = await store.beginAttempt(owner.tenantId,'pg-main',run.run_id,secondClaim!.claim_token,60);
    expect(secondAttempt.ordinal).toBe(2);
    const page = {entity:'customer' as const,relation:'customer' as const,page_no:1,first_key:'C-STALE',last_key:'C-STALE',
      page_digest:'0'.repeat(64),rows:[{entity:'customer' as const,relation:'customer' as const,source_pk:'C-STALE',parent_source_pk:'',
        source_version:null,facts:{customer_name:'stale'}}]};
    await expect(store.writePage(owner.tenantId,'pg-main',run.run_id,firstAttempt.attempt_id,firstClaim!.claim_token,page))
      .rejects.toMatchObject({code:'40001'});
  });

  it('counts crash-after-start recovery toward the four durable start limit', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const { createSnapshotStageStore } = await import('../etl-worker/snapshot-stage-store.js');
    const run = await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','crash-start-budget');
    const store = createSnapshotStageStore(roleScopedPool('hub_worker'));
    const ordinals: number[] = [];
    for (let expectedOrdinal=1; expectedOrdinal<=4; expectedOrdinal+=1) {
      const claim = await store.claim(owner.tenantId,'pg-main',60);
      expect(claim).toBeTruthy();
      const attempt = await store.beginAttempt(owner.tenantId,'pg-main',run.run_id,claim!.claim_token,60);
      ordinals.push(attempt.ordinal);
      await fixture.pool.query(`UPDATE control.etl_run SET snapshot_lease_expires_at=clock_timestamp()-interval '1 second',
        snapshot_available_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.run_id]);
      await expect(store.claim(owner.tenantId,'pg-main',60)).resolves.toBeUndefined();
      const recovered = await fixture.pool.query(`SELECT status,snapshot_available_at>clock_timestamp() AS delayed FROM control.etl_run WHERE run_id=$1`,[run.run_id]);
      if (expectedOrdinal < 4) {
        expect(recovered.rows[0]).toMatchObject({status:'SCANNING',delayed:true});
        await fixture.pool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.run_id]);
      } else expect(recovered.rows[0]).toMatchObject({status:'FAILED',delayed:false});
    }
    expect(ordinals).toEqual([1,2,3,4]);
    const attempts = await fixture.pool.query(`SELECT ordinal,status,error_code FROM control.etl_run_attempt WHERE run_id=$1 ORDER BY ordinal`,[run.run_id]);
    expect(attempts.rows).toEqual([1,2,3,4].map(ordinal=>({ordinal,status:'INCOMPLETE',error_code:'SNAPSHOT_LEASE_EXPIRED'})));
  });

  it('rejects page and manifest publication behind a newer typed tenant barrier', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const { createSnapshotStageStore, snapshotManifestDigest } = await import('../etl-worker/snapshot-stage-store.js');
    const run=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','stage-barrier-fence');
    const store=createSnapshotStageStore(roleScopedPool('hub_worker'));
    const claim=await store.claim(owner.tenantId,'pg-main',60);
    const attempt=await store.beginAttempt(owner.tenantId,'pg-main',run.run_id,claim!.claim_token,60);
    await auth.repository.setTenantEnabled(owner.tenantId,false);
    await auth.repository.setTenantEnabled(owner.tenantId,true);
    const row={entity:'customer' as const,relation:'customer' as const,source_pk:'C-BARRIER',parent_source_pk:'',source_version:null,facts:{}};
    const page={entity:'customer' as const,relation:'customer' as const,page_no:1,rows:[row],first_key:'C-BARRIER',last_key:'C-BARRIER',page_digest:'1'.repeat(64)};
    await expect(store.writePage(owner.tenantId,'pg-main',run.run_id,attempt.attempt_id,claim!.claim_token,page))
      .rejects.toMatchObject({code:'42501'});
    const manifest={state:'EXTRACTED',relations:['customer'],relation_counts:[{relation:'customer',row_count:0,page_count:0}],row_count:0,
      page_count:0,source_snapshot_identity:'b'.repeat(64),profile_digest:'0'.repeat(64),mapping_digest:'0'.repeat(64)};
    await expect(store.complete(owner.tenantId,'pg-main',run.run_id,attempt.attempt_id,claim!.claim_token,manifest,snapshotManifestDigest(manifest)))
      .rejects.toMatchObject({code:'42501'});
    const state=await fixture.pool.query(`SELECT r.status,(SELECT count(*)::int FROM control.etl_snapshot_stage_record s WHERE s.run_id=r.run_id) AS records,
      (SELECT count(*)::int FROM control.etl_snapshot_manifest m WHERE m.run_id=r.run_id) AS manifests FROM control.etl_run r WHERE r.run_id=$1`,[run.run_id]);
    expect(state.rows[0]).toEqual({status:'SCANNING',records:0,manifests:0});
  });

  it('activates, pauses, and resumes the PostgreSQL snapshot schedule as hub_api', async () => {
    const apiService = makeService(roleScopedPool('hub_api'));
    await apiService.pause(owner, 'pg-main', '1', 'exercise API role schedule rights');
    await fixture.pool.query(`DELETE FROM control.etl_snapshot_schedule WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    const activated = await apiService.activate(owner, 'pg-main', '1', (await fixture.pool.query<{ id: string }>(
      `SELECT id FROM control.source_owner_approval WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId])).rows[0].id);
    expect(activated.lifecycle).toBe('ACTIVE');
    await apiService.pause(owner, 'pg-main', '1', 'exercise API role pause');
    const paused = await fixture.pool.query(`SELECT enabled FROM control.etl_snapshot_schedule WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    expect(paused.rows[0].enabled).toBe(false);
    const approval = await fixture.pool.query<{ id: string }>(`SELECT id FROM control.source_owner_approval WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    await apiService.activate(owner, 'pg-main', '1', approval.rows[0].id);
    const resumed = await fixture.pool.query(`SELECT enabled,interval_seconds FROM control.etl_snapshot_schedule WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    expect(resumed.rows[0]).toMatchObject({ enabled: true, interval_seconds: 300 });
  });

  it('persists activation schedule and returns the same run for a same-key replay', async () => {
    const authenticator = async (token: string) => token === 'owner-token' ? owner : token === 'read-token'
      ? { ...owner, managementScopes: ['source:read'] as const } : Promise.reject(new Error('invalid'));
    const app = await buildApp({ logger: false, snapshotRuns: { pool: roleScopedPool('hub_api'), authenticator, authService: auth } });
    try {
      const schedule = await fixture.pool.query(`SELECT enabled,interval_seconds,next_due_at,schedule_revision FROM control.etl_snapshot_schedule
        WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
      expect(schedule.rows[0]).toMatchObject({ enabled: true, interval_seconds: 300, schedule_revision: '1' });
      const headers = { authorization: 'Bearer owner-token', 'idempotency-key': 'run-1' };
      const created = await app.inject({ method: 'POST', url: '/hub/v1/admin/sources/pg-main/etl-runs', headers,
        payload: { approved_config_revision: '1', run_mode: 'FULL_SNAPSHOT' } });
      expect(created.statusCode).toBe(202);
      expect(created.json().data).toMatchObject({ status: 'QUEUED', run_mode: 'FULL_SNAPSHOT', expected_entities: ['customer'] });
      const replay = await app.inject({ method: 'POST', url: '/hub/v1/admin/sources/pg-main/etl-runs', headers,
        payload: { approved_config_revision: '1', run_mode: 'FULL_SNAPSHOT' } });
      expect(replay.json().data.run_id).toBe(created.json().data.run_id);
      const changed = await app.inject({ method: 'POST', url: '/hub/v1/admin/sources/pg-main/etl-runs', headers,
        payload: { approved_config_revision: '2', run_mode: 'FULL_SNAPSHOT' } });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      const readOnly = await app.inject({ method: 'POST', url: '/hub/v1/admin/sources/pg-main/etl-runs',
        headers: { authorization: 'Bearer read-token', 'idempotency-key': 'read-only' },
        payload: { approved_config_revision: '1', run_mode: 'FULL_SNAPSHOT' } });
      const detail = await app.inject({ method: 'GET', url: `/hub/v1/admin/etl-runs/${created.json().data.run_id}`,
        headers: { authorization: 'Bearer owner-token' } });
      const invalidFilter = await app.inject({ method: 'GET', url: '/hub/v1/admin/etl-runs?limit=101&unknown=1',
        headers: { authorization: 'Bearer owner-token' } });
      expect(readOnly.statusCode).toBe(403);
      expect(invalidFilter.statusCode).toBe(400);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data).toMatchObject({ completeness_report: { status: 'NOT_STARTED' }, checkpoint_summary: null });
      expect(detail.body).not.toContain('vault:/snapshot/source');
      expect(detail.body).not.toContain('fixture-secret');
      await expect(fixture.pool.query(`UPDATE control.etl_run SET config_revision=2 WHERE run_id=$1`,[created.json().data.run_id]))
        .rejects.toMatchObject({ code:'55000' });
      const apiClient = await fixture.pool.connect();
      try {
        await apiClient.query('SET ROLE hub_api');
        await expect(apiClient.query(`UPDATE control.etl_run SET status='FAILED' WHERE run_id=$1`,[created.json().data.run_id]))
          .rejects.toMatchObject({ code:'42501' });
        await apiClient.query('RESET ROLE');
      } finally { apiClient.release(); }
      await service.pause(owner,'pg-main','1','freeze admission after accepted run');
      const pausedSchedule = await fixture.pool.query(`SELECT enabled FROM control.etl_snapshot_schedule WHERE tenant_key=$1 AND source_id='pg-main'`,[owner.tenantId]);
      expect(pausedSchedule.rows[0].enabled).toBe(false);
      const pausedReplay = await app.inject({ method: 'POST', url: '/hub/v1/admin/sources/pg-main/etl-runs', headers,
        payload: { approved_config_revision: '1', run_mode: 'FULL_SNAPSHOT' } });
      expect(pausedReplay.statusCode).toBe(202);
      expect(pausedReplay.json().data.run_id).toBe(created.json().data.run_id);
    } finally { await app.close(); }
  });

  it('does not admit an overlapping manual request and exposes a durable callable due gate', async () => {
    const { createSnapshotRun, admitDueSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const rolePool = roleScopedPool('hub_api');
    const first = await createSnapshotRun(rolePool, auth, owner, 'pg-main', '1', 'race-a');
    await expect(createSnapshotRun(rolePool, auth, owner, 'pg-main', '1', 'race-b')).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
    const due = await admitDueSnapshotRun(roleScopedPool('hub_worker'), 'snapshot_tenant', 'pg-main');
    expect(due).toBeNull();
    expect(first.run_id).toBeTruthy();
    const count = await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    expect(count.rows[0].count).toBe(1);
  });

  it('admits and scans a due schedule from the strict worker loop without a manual run', async () => {
    e2eEndpointProfile = { revision:'due-pg-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:fixture.hostPort,
      allow_loopback_plaintext:true,database:'postgres',user:'source_reader',schema:'public',
      entities:{customer:{table:'customers',source_pk:'customer_id',updated_at_field:'updated_at'}} };
    await fixture.pool.query(`UPDATE control.etl_snapshot_schedule SET next_due_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg-main'`,[owner.tenantId]);
    let connectCalls=0;
    const sourceConnectionFactory:PostgresSourceConnectionFactory={connect:async()=>{
      connectCalls+=1;
      throw new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE');
    }};
    try {
      await runDurableWorkerLoop(roleScopedPool('hub_worker'),{HUB_STRICT_INGESTION_WORKER_ONCE:'true'}, {
        secretResolver:{isConfiguredReference:async()=>true,resolve:async()=> 'fixture-secret'},sourceConnectionFactory,
        egressPolicy:{environmentKind:'local_lab',policyId:'owned-due-loopback'},pageSize:10,leaseSeconds:60 });
      const runs=await fixture.pool.query(`SELECT r.request_kind,r.status,a.ordinal,a.status AS attempt_status
        FROM control.etl_run r LEFT JOIN control.etl_run_attempt a USING(tenant_key,source_id,run_id)
        WHERE r.tenant_key=$1 AND r.source_id='pg-main'`,[owner.tenantId]);
      expect(connectCalls).toBe(1);
      expect(runs.rows).toEqual([{request_kind:'SCHEDULED',status:'SCANNING',ordinal:1,attempt_status:'INCOMPLETE'}]);
    } finally { e2eEndpointProfile=undefined; }
  });

  it('continues scanning admitted work when another due source is paused by a config edit', async () => {
    e2eEndpointProfile = { revision:'paused-due-pg-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:fixture.hostPort,
      allow_loopback_plaintext:true,database:'postgres',user:'source_reader',schema:'public',
      entities:{customer:{table:'customers',source_pk:'customer_id',updated_at_field:'updated_at'}} };
    const config={name:'Paused snapshot CRM',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',
      endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',allowed_entities:['customer'],delete_contract:'hard_delete'};
    await auth.repository.provisionSourceCredential({sourceId:'pg-paused',tenantId:owner.tenantId,token:createCredential().secret,
      secretRef:'vault:/snapshot/source',allowedEntities:['customer'],revision:'1'});
    await service.create(owner,{source_id:'pg-paused',data_owner_user_id:owner.userId,config});
    await service.writeMappings(owner,'pg-paused','1',[
      {entity:'customer',source_field:'name',target_field:'customer_name',transform:'trim'},
      {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
      {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
      {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
    ]);
    const tested=await service.test(owner,'pg-paused','1');
    const approved=await service.approve(owner,'pg-paused','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'pg-paused','1',approved.approval_id);
    await fixture.pool.query(`UPDATE control.etl_snapshot_schedule SET next_due_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg-paused'`,[owner.tenantId]);
    await service.update(owner,'pg-paused',{expected_revision:'1',config:{...config,name:'Paused after edit'}});
    const schedule=await fixture.pool.query(`SELECT enabled,active_run_id,next_due_at<=clock_timestamp() AS due
      FROM control.etl_snapshot_schedule WHERE tenant_key=$1 AND source_id='pg-paused'`,[owner.tenantId]);
    expect(schedule.rows[0]).toEqual({enabled:true,active_run_id:null,due:true});
    const {createSnapshotRun}=await import('../etl-worker/snapshot-runs.js');
    const admitted=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','continue-after-due-denial');
    const sourceConnectionFactory:PostgresSourceConnectionFactory={connect:async()=>{
      throw new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE');
    }};
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    try {
      await runDurableWorkerLoop(roleScopedPool('hub_worker'),{HUB_STRICT_INGESTION_WORKER_ONCE:'true'}, {
        secretResolver:{isConfiguredReference:async()=>true,resolve:async()=> 'fixture-secret'},sourceConnectionFactory,
        egressPolicy:{environmentKind:'local_lab',policyId:'owned-due-loopback'},pageSize:10,leaseSeconds:60 });
      expect(warning).toHaveBeenCalledWith('snapshot due admission denied',{
        event:'snapshot_due_admission_denied',tenant_key:owner.tenantId,source_id:'pg-paused',code:'SOURCE_CONFLICT'});
      const attempt=await fixture.pool.query(`SELECT status,error_code FROM control.etl_run_attempt WHERE run_id=$1`,[admitted.run_id]);
      expect(attempt.rows).toEqual([{status:'INCOMPLETE',error_code:'SNAPSHOT_SOURCE_UNAVAILABLE'}]);
    } finally {
      warning.mockRestore();
      e2eEndpointProfile=undefined;
    }
  });

  it('serializes simultaneous manual and due admissions to one active durable run', async () => {
    const { createSnapshotRun, admitDueSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const results = await Promise.allSettled([
      createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','manual-vs-due'),
      admitDueSnapshotRun(roleScopedPool('hub_worker'),owner.tenantId,'pg-main'),
    ]);
    const manualWon = results[0].status === 'fulfilled';
    const dueWon = results[1].status === 'fulfilled' && results[1].value !== null;
    expect(Number(manualWon) + Number(dueWon)).toBe(1);
    const count = await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg-main'`,[owner.tenantId]);
    expect(count.rows[0].count).toBe(1);
  });

  it('keeps the admitted run and schedule available after the API instance is recreated', async () => {
    const {createSnapshotRun}=await import('../etl-worker/snapshot-runs.js');
    const run=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','restart-durability');
    const first=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,authenticator:async()=>owner}});
    const firstRead=await first.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${run.run_id}`,headers:{authorization:'Bearer owner-token'}});
    await first.close();
    const schedule=await fixture.pool.query(`SELECT active_run_id,enabled,interval_seconds FROM control.etl_snapshot_schedule
      WHERE tenant_key=$1 AND source_id='pg-main'`,[owner.tenantId]);
    expect(schedule.rows[0]).toMatchObject({active_run_id:run.run_id,enabled:true,interval_seconds:300});
    const restarted=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,authenticator:async()=>owner}});
    try {
      const afterRestart=await restarted.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${run.run_id}`,headers:{authorization:'Bearer owner-token'}});
      expect(firstRead.statusCode).toBe(200);
      expect(afterRestart.statusCode).toBe(200);
      expect(afterRestart.json().data.run_id).toBe(run.run_id);
    } finally { await restarted.close(); }
  });

  it('admits one due run under concurrent worker calls and leaves later calls behind the active fence', async () => {
    const { admitDueSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const pool = roleScopedPool('hub_worker');
    const results = await Promise.all([
      admitDueSnapshotRun(pool,'snapshot_tenant','pg-main'),
      admitDueSnapshotRun(pool,'snapshot_tenant','pg-main'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(value => value === null)).toHaveLength(1);
    expect(await admitDueSnapshotRun(pool,'snapshot_tenant','pg-main')).toBeNull();
    const count = await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    expect(count.rows[0].count).toBe(1);
  });

  it('fails closed when order line mappings are missing from the approved mapping revision', async () => {
    const orderConfig = { name: 'Order snapshot', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
      endpoint_allowlist_ref: 'pg-test', secret_ref: 'vault:/snapshot/source', allowed_entities: ['customer','order'], delete_contract: 'hard_delete' };
    await auth.repository.provisionSourceCredential({ sourceId: 'pg_order', tenantId: owner.tenantId, token: createCredential().secret,
      secretRef: 'vault:/snapshot/source', allowedEntities: ['customer','order'], revision: '1' });
    await service.create(owner,{source_id:'pg_order',data_owner_user_id:owner.userId,config:orderConfig});
    await service.writeMappings(owner,'pg_order','1',[
      { entity:'customer',source_field:'name',target_field:'customer_name',transform:'trim' },
      { entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id' },
      { entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id' },
      { entity:'customer',source_field:'status',target_field:'status',transform:'identity' },
      { entity:'order',source_field:'customer_id',target_field:'customer_id',transform:'source-id' },
      { entity:'order',source_field:'order_no',target_field:'order_no',transform:'identity' },
      { entity:'order',source_field:'status',target_field:'status',transform:'identity' },
      { entity:'order',source_field:'order_at',target_field:'order_at',transform:'identity' },
      { entity:'order',source_field:'amount',target_field:'amount',transform:'decimal-string' },
      { entity:'order',source_field:'currency',target_field:'currency',transform:'identity' },
    ]);
    const tested = await service.test(owner,'pg_order','1');
    expect(tested.status).toBe('FAIL');
    expect(tested.report.checks).toContain('MAPPING_REQUIRED:order:lines.source_line_id');
    await expect(service.approve(owner,'pg_order','1',tested.test_report_id,tested.data_contract_ref))
      .rejects.toMatchObject({ code:'SOURCE_CONFLICT' });
    const runs = await fixture.pool.query(`SELECT count(*)::int AS count FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg_order'`,[owner.tenantId]);
    expect(runs.rows[0].count).toBe(0);
  });

  it('fails closed when hard-delete absence has no safe source-version delete contract', async () => {
    await auth.repository.provisionSourceCredential({ sourceId: 'pg_unsafe', tenantId: owner.tenantId, token: createCredential().secret,
      secretRef: 'vault:/snapshot/source', allowedEntities: ['customer'], revision: '1' });
    await service.create(owner,{source_id:'pg_unsafe',data_owner_user_id:owner.userId,config:{name:'Unsafe delete',connector:'postgresql',
      mode:'FULL_SNAPSHOT',version_domain:'SOURCE_VERSION',endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',
      allowed_entities:['customer'],delete_contract:'hard_delete'}});
    await service.writeMappings(owner,'pg_unsafe','1',[
      { entity:'customer',source_field:'name',target_field:'customer_name',transform:'trim' },
      { entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id' },
      { entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id' },
      { entity:'customer',source_field:'status',target_field:'status',transform:'identity' },
    ]);
    const tested = await service.test(owner,'pg_unsafe','1');
    const approval = await service.approve(owner,'pg_unsafe','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'pg_unsafe','1',approval.approval_id);
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg_unsafe','1','unsafe-version-run'))
      .rejects.toMatchObject({ code:'SOURCE_CONTRACT_INVALID' });
  });

  it('rejects manual and due admission behind a historical tenant barrier until a fresh approval', async () => {
    await auth.repository.setTenantEnabled(owner.tenantId, false);
    await auth.repository.setTenantEnabled(owner.tenantId, true);
    const { createSnapshotRun, admitDueSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','stale-after-tenant-barrier'))
      .rejects.toMatchObject({ code:'SOURCE_CONFLICT' });
    await fixture.pool.query(`UPDATE control.etl_snapshot_schedule SET next_due_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg-main'`, [owner.tenantId]);
    await expect(admitDueSnapshotRun(roleScopedPool('hub_worker'),owner.tenantId,'pg-main'))
      .rejects.toMatchObject({ code:'SOURCE_CONFLICT' });
    const refreshed = await service.test(owner,'pg-main','1');
    const approval = await service.approve(owner,'pg-main','1',refreshed.test_report_id,refreshed.data_contract_ref);
    await service.activate(owner,'pg-main','1',approval.approval_id);
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','fresh-after-tenant-barrier'))
      .resolves.toMatchObject({ request_kind:'MANUAL' });
  });

  it('ignores later barriers for another tenant, source, credential, entity, or channel', async () => {
    await auth.repository.provisionTenant({ tenantId:'snapshot_other', businessTimezone:'UTC' });
    const channel = await fixture.pool.query<{ id:string }>(`INSERT INTO control.source_channel
      (tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
      VALUES($1,'pg-main','order','postgresql','FULL_SNAPSHOT','SNAPSHOT_OBSERVATION',1,'active') RETURNING id`, [owner.tenantId]);
    await fixture.pool.query(`INSERT INTO control.source_security_barrier
      (tenant_key,source_id,credential_id,entity,channel_id,barrier_type,reason_code,created_by) VALUES
      ('snapshot_other',NULL,NULL,NULL,NULL,'TENANT_DISABLED','fixture','fixture'),
      ($1,'pg-main',gen_random_uuid(),'customer',NULL,'CREDENTIAL_COMPROMISE','fixture','fixture'),
      ($1,'pg-main',NULL,'order',NULL,'SOURCE_SCOPE_SECURITY_REMOVAL','fixture','fixture'),
      ($1,'pg-main',NULL,NULL,$2,'CHANNEL_RETIRED','fixture','fixture'),
      ($1,'other-source',gen_random_uuid(),'customer',NULL,'CREDENTIAL_COMPROMISE','fixture','fixture')`,
      [owner.tenantId,channel.rows[0].id]);
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','unrelated-barriers'))
      .resolves.toMatchObject({ source_id:'pg-main' });
  });

  it('revalidates OIDC binding after authentication for create, replay, detail, and list', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const app = await buildApp({ logger:false, snapshotRuns:{ pool:roleScopedPool('hub_api'), authService:auth,
      authenticator: async () => {
        const principal = await auth.resolveOidc(owner.issuer,owner.subject);
        await auth.repository.setIdentityBinding(owner.issuer,owner.subject,false);
        return principal;
      } } });
    try {
      const rejected = await app.inject({ method:'POST',url:'/hub/v1/admin/sources/pg-main/etl-runs',
        headers:{ authorization:'Bearer owner-token','idempotency-key':'binding-drift' },
        payload:{ approved_config_revision:'1',run_mode:'FULL_SNAPSHOT' } });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json().error.code).toBe('AUTH_REVOKED');
    } finally { await app.close(); await auth.repository.setIdentityBinding(owner.issuer,owner.subject,true); }
    await auth.repository.setIdentityBinding(owner.issuer,owner.subject,true);
    const replayRun = await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','binding-replay');
    const replayApp = await buildApp({ logger:false, snapshotRuns:{ pool:roleScopedPool('hub_api'), authService:auth,
      authenticator: async () => {
        const principal = await auth.resolveOidc(owner.issuer,owner.subject);
        await auth.repository.setIdentityBinding(owner.issuer,owner.subject,false);
        return principal;
      } } });
    try {
      const replay = await replayApp.inject({ method:'POST',url:'/hub/v1/admin/sources/pg-main/etl-runs',
        headers:{authorization:'Bearer owner-token','idempotency-key':'binding-replay'},
        payload:{approved_config_revision:'1',run_mode:'FULL_SNAPSHOT'} });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('AUTH_REVOKED');
    } finally { await replayApp.close(); await auth.repository.setIdentityBinding(owner.issuer,owner.subject,true); }
    const run = replayRun;
    const readApp = await buildApp({ logger:false, snapshotRuns:{ pool:roleScopedPool('hub_api'), authService:auth,
      authenticator: async () => {
        const principal = await auth.resolveOidc(owner.issuer,owner.subject);
        await auth.repository.updateSubject({ tenantId:owner.tenantId,userId:owner.userId,
          managementScopes:['source:write','source:approve','mapping:write'] });
        return principal;
      } } });
    try {
      const detail = await readApp.inject({ method:'GET',url:`/hub/v1/admin/etl-runs/${run.run_id}`,headers:{authorization:'Bearer owner-token'} });
      const list = await readApp.inject({ method:'GET',url:'/hub/v1/admin/etl-runs',headers:{authorization:'Bearer owner-token'} });
      expect(detail.statusCode).toBe(403);
      expect(list.statusCode).toBe(403);
    } finally { await readApp.close(); }
  });

  it('rejects a principal rebound or tenant disabled after OIDC authentication', async () => {
    await auth.repository.provisionSubject({tenantId:owner.tenantId,userId:'snapshot_rebound',managementScopes:owner.managementScopes});
    const reboundApp=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,
      authenticator:async()=>{
        const principal=await auth.resolveOidc(owner.issuer,owner.subject);
        await auth.repository.bindIdentity({issuer:owner.issuer,subject:owner.subject,tenantId:owner.tenantId,userId:'snapshot_rebound'});
        return principal;
      }}});
    try {
      const rebound=await reboundApp.inject({method:'POST',url:'/hub/v1/admin/sources/pg-main/etl-runs',
        headers:{authorization:'Bearer owner-token','idempotency-key':'rebound-after-auth'},
        payload:{approved_config_revision:'1',run_mode:'FULL_SNAPSHOT'}});
      expect(rebound.statusCode).toBe(401);
      expect(rebound.json().error.code).toBe('AUTH_CONTEXT_CHANGED');
    } finally { await reboundApp.close(); }
    await auth.repository.bindIdentity({issuer:owner.issuer,subject:owner.subject,tenantId:owner.tenantId,userId:owner.userId});
    const tenantApp=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,
      authenticator:async()=>{
        const principal=await auth.resolveOidc(owner.issuer,owner.subject);
        await auth.repository.setTenantEnabled(owner.tenantId,false);
        return principal;
      }}});
    try {
      const disabled=await tenantApp.inject({method:'POST',url:'/hub/v1/admin/sources/pg-main/etl-runs',
        headers:{authorization:'Bearer owner-token','idempotency-key':'tenant-disabled-after-auth'},
        payload:{approved_config_revision:'1',run_mode:'FULL_SNAPSHOT'}});
      expect(disabled.statusCode).toBe(401);
      expect(disabled.json().error.code).toBe('AUTH_REVOKED');
    } finally { await tenantApp.close(); await auth.repository.setTenantEnabled(owner.tenantId,true); }
  });

  it('keeps run lists and details inside the authenticated tenant', async () => {
    const other={...owner,userId:'snapshot_other_owner',tenantId:'snapshot_other',issuer:'https://idp.example.test',subject:'snapshot-other'};
    await auth.repository.provisionTenant({tenantId:other.tenantId,businessTimezone:'UTC'});
    await auth.repository.provisionSubject({tenantId:other.tenantId,userId:other.userId,managementScopes:other.managementScopes});
    await auth.repository.bindIdentity({issuer:other.issuer,subject:other.subject,tenantId:other.tenantId,userId:other.userId});
    await auth.repository.provisionSourceCredential({sourceId:'pg-other',tenantId:other.tenantId,token:createCredential().secret,
      secretRef:'vault:/snapshot/source',allowedEntities:['customer'],revision:'1'});
    const config={name:'Other snapshot',connector:'postgresql',mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',
      endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',allowed_entities:['customer'],delete_contract:'hard_delete'};
    await service.create(other,{source_id:'pg-other',data_owner_user_id:other.userId,config});
    await service.writeMappings(other,'pg-other','1',[
      {entity:'customer',source_field:'name',target_field:'customer_name',transform:'trim'},
      {entity:'customer',source_field:'owner_id',target_field:'owner_user_id',transform:'source-id'},
      {entity:'customer',source_field:'department_id',target_field:'dept_id',transform:'source-id'},
      {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
    ]);
    const tested=await service.test(other,'pg-other','1');
    const approval=await service.approve(other,'pg-other','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(other,'pg-other','1',approval.approval_id);
    const {createSnapshotRun}=await import('../etl-worker/snapshot-runs.js');
    await fixture.pool.query(`INSERT INTO control.source_security_barrier
      (tenant_key,source_id,credential_id,entity,barrier_type,reason_code,created_by)
      VALUES($1,'pg-main',NULL,'customer','SOURCE_SCOPE_SECURITY_REMOVAL','fixture','fixture')`,[owner.tenantId]);
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-main','1','blocked-source-only'))
      .rejects.toMatchObject({code:'SOURCE_CONFLICT'});
    const otherRun=await createSnapshotRun(roleScopedPool('hub_api'),auth,other,'pg-other','1','other-tenant-run');
    const app=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,authenticator:async()=>owner}});
    try {
      const detail=await app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${otherRun.run_id}`,headers:{authorization:'Bearer owner-token'}});
      const list=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?source_id=pg-other',headers:{authorization:'Bearer owner-token'}});
      const guessed=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?source_id=guessed-source',headers:{authorization:'Bearer owner-token'}});
      expect(detail.statusCode).toBe(404);
      expect(list.statusCode).toBe(200);
      expect(list.json().data.items).toEqual([]);
      expect(guessed.statusCode).toBe(200);
      expect(guessed.json().data.items).toEqual([]);
    } finally { await app.close(); }
  });

  it('enumerates same-millisecond microsecond timestamps and UUID ties through HTTP pages', async () => {
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    const pool = roleScopedPool('hub_api');
    const runs=[] as {run_id:string}[];
    for (const key of ['page-a','page-b','page-c']) {
      runs.push(await createSnapshotRun(pool,auth,owner,'pg-main','1',key));
      await fixture.pool.query(`UPDATE control.etl_run SET status='COMPLETE' WHERE run_id=$1`,[runs.at(-1)!.run_id]);
    }
    const client=await fixture.pool.connect();
    try {
      await client.query('ALTER TABLE control.etl_run DISABLE TRIGGER etl_run_proof_immutable');
      await client.query(`UPDATE control.etl_run SET created_at=CASE run_id
        WHEN $1::uuid THEN '2026-10-24T12:00:00.123900Z'::timestamptz
        WHEN $2::uuid THEN '2026-10-24T12:00:00.123800Z'::timestamptz
        ELSE '2026-10-24T12:00:00.123800Z'::timestamptz END WHERE run_id=ANY($3::uuid[])`,
        [runs[0].run_id,runs[1].run_id,runs.map(run=>run.run_id)]);
      await client.query('ALTER TABLE control.etl_run ENABLE TRIGGER etl_run_proof_immutable');
    } finally {
      await client.query('ALTER TABLE control.etl_run ENABLE TRIGGER etl_run_proof_immutable').catch(()=>undefined);
      client.release();
    }
    const app=await buildApp({logger:false,snapshotRuns:{pool,authService:auth,authenticator:async()=>owner}});
    try {
      const visited:string[]=[]; let cursor:string|undefined;
      do {
        const url='/hub/v1/admin/etl-runs?limit=1'+(cursor===undefined?'':'&cursor='+encodeURIComponent(cursor));
        const page=await app.inject({method:'GET',url,headers:{authorization:'Bearer owner-token'}});
        expect(page.statusCode).toBe(200);
        const body=page.json().data;
        visited.push(...body.items.map((item:{run_id:string})=>item.run_id));
        cursor=body.next_cursor ?? undefined;
      } while(cursor!==undefined && visited.length<8);
      expect(visited).toEqual(expect.arrayContaining(runs.map(run=>run.run_id)));
      expect(new Set(visited).size).toBe(visited.length);
      expect(visited).toHaveLength(3);
    } finally { await app.close(); }
  });

  it('rejects malformed route UUID, canonical date, cursor payload, and empty cursor safely', async () => {
    const malformedCursor=Buffer.from('2026-99-99T\0------------------------------------','utf8').toString('base64url');
    const app=await buildApp({logger:false,snapshotRuns:{pool:roleScopedPool('hub_api'),authService:auth,authenticator:async()=>owner}});
    try {
      const headers={authorization:'Bearer owner-token'};
      const badId=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs/------------------------------------',headers});
      const badDate=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?created_from=2026-99-99T00%3A00%3A00Z',headers});
      const yearZeroFrom=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?created_from=0000-01-01T00%3A00%3A00Z',headers});
      const yearZeroTo=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?created_to=0000-01-01T00%3A00%3A00Z',headers});
      const yearOneControl=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?created_from=0001-01-01T00%3A00%3A00Z',headers});
      const badCursor=await app.inject({method:'GET',url:`/hub/v1/admin/etl-runs?cursor=${malformedCursor}`,headers});
      const emptyCursor=await app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?cursor=',headers});
      expect(badId.statusCode).toBe(404);
      for (const response of [badDate,yearZeroFrom,yearZeroTo,badCursor,emptyCursor]) {
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('AUTH_INPUT_INVALID');
        expect(response.json().error.retryable).toBe(false);
      }
      expect(yearOneControl.statusCode).toBe(200);
      expect([badId,badDate,yearZeroFrom,yearZeroTo,badCursor,emptyCursor].map(response=>response.statusCode)).not.toContain(503);
    } finally { await app.close(); }
  });
});

function roleScopedPool(role: 'hub_api' | 'hub_worker'): typeof fixture.pool {
  const target = fixture.pool;
  return new Proxy(target,{get(object,property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      const original = client.query.bind(client);
      const query = ((sql: unknown,...args: unknown[]) => {
        if (typeof sql === 'string' && /^BEGIN(?:\s|$)/i.test(sql.trim())) {
          return (original as (...values: unknown[])=>Promise<unknown>)(sql,...args)
            .then(async result => { await original(`SET LOCAL ROLE ${role}`); return result; });
        }
        return (original as (...values: unknown[])=>unknown)(sql,...args);
      }) as typeof client.query;
      return { query, release: client.release.bind(client) };
    };
    if (property === 'query') return async (sql: unknown,...args: unknown[]) => {
      const client = await target.connect();
      try { await client.query(`SET ROLE ${role}`); return await (client.query.bind(client) as (...values: unknown[])=>Promise<unknown>)(sql,...args); }
      finally { await client.query('RESET ROLE').catch(()=>undefined); client.release(); }
    };
    const value = Reflect.get(object,property,object);
    return typeof value === 'function' ? value.bind(object) : value;
  }}) as typeof fixture.pool;
}
