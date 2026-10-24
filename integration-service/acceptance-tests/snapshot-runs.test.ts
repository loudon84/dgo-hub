import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { createSourceRegistryService, type SourceRegistryService } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { buildApp } from '../app.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { createLocalLabPostgresSourceConnectionFactory, type PostgresSourceConnectionFactory } from '../etl-worker/postgres-snapshot-connector.js';
import { runSnapshotWorkerOnce } from '../etl-worker/snapshot-worker.js';
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
          department_id text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL)`);
        await ownerClient.query(`CREATE TABLE ${sourceSchema}.orders(order_id bigint PRIMARY KEY,customer_id text NOT NULL,order_no text NOT NULL,
          status text NOT NULL,order_at timestamptz NOT NULL,amount numeric(30,12) NOT NULL,currency text NOT NULL,updated_at timestamptz NOT NULL)`);
        await ownerClient.query(`CREATE TABLE ${sourceSchema}.order_lines(line_id text PRIMARY KEY,order_id bigint NOT NULL REFERENCES ${sourceSchema}.orders(order_id),
          product_code text NOT NULL,product_name text NOT NULL,quantity numeric(30,12) NOT NULL,unit_price numeric(30,12) NOT NULL,line_amount numeric(30,12) NOT NULL)`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.customers VALUES('C-1','Customer','owner-ext','dept-ext','ACTIVE','2026-10-25 10:00:00.123456+00')`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.orders VALUES(9007199254740993123,'C-1','O-1','DRAFT','2026-10-25 10:01:02.123456+00',
          123456789012345678.123456789012,'USD','2026-10-25 10:01:03.123456+00')`);
        await ownerClient.query(`INSERT INTO ${sourceSchema}.order_lines VALUES('L-1',9007199254740993123,'SKU-1','Line',1.123456789012,
          123456789012.123456789012,138636548569.222222221445)`);
      } finally { await ownerClient.query('RESET ROLE').catch(()=>undefined); ownerClient.release(); }
      await sourceFixture.pool.query(`GRANT USAGE ON SCHEMA ${sourceSchema} TO ${sourceReader}`);
      await sourceFixture.pool.query(`GRANT SELECT ON ${sourceSchema}.customers,${sourceSchema}.orders,${sourceSchema}.order_lines TO ${sourceReader}`);
      await ownerPool.query('SELECT 1');
      e2eEndpointProfile={revision:'owned-source-v1',connector:'postgresql',protocol:'postgres:',host:'127.0.0.1',port:sourceFixture.hostPort,
        allow_loopback_plaintext:true,database:'postgres',user:sourceReader,schema:sourceSchema,entities:{
          customer:{table:'customers',source_pk:'customer_id',updated_at_field:'updated_at'},
          order:{table:'orders',source_pk:'order_id',updated_at_field:'updated_at',lines:{table:'order_lines',order_fk:'order_id'}},
        }};
      await auth.repository.provisionSourceCredential({sourceId:'pg-e2e',tenantId:owner.tenantId,token:createCredential().secret,
        secretRef:'vault:/snapshot/source',allowedEntities:['customer','order'],revision:'1'});
      const allowedEntities=['customer','order'] as const;
      await service.create(owner,{source_id:'pg-e2e',data_owner_user_id:owner.userId,config:{name:'Owned order snapshot',connector:'postgresql',
        mode:'FULL_SNAPSHOT',version_domain:'SNAPSHOT_OBSERVATION',endpoint_allowlist_ref:'pg-test',secret_ref:'vault:/snapshot/source',
        allowed_entities:allowedEntities,delete_contract:'hard_delete'}});
      await service.writeMappings(owner,'pg-e2e','1',[
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
      const tested=await service.test(owner,'pg-e2e','1');
      expect(tested.status).toBe('PASS');
      const approved=await service.approve(owner,'pg-e2e','1',tested.test_report_id,tested.data_contract_ref);
      await service.activate(owner,'pg-e2e','1',approved.approval_id);
      const { createSnapshotRun }=await import('../etl-worker/snapshot-runs.js');
      const run=await createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg-e2e','1','owned-e2e-run');
      const realFactory=createLocalLabPostgresSourceConnectionFactory();
      let loseSourceOnce=true;
      let ownedReaderPid:number|undefined;
      const interruptedFactory: PostgresSourceConnectionFactory={connect:async input=>{
        const connection=await realFactory.connect(input);
        return {query:async(sql:string)=>{
          if(loseSourceOnce && sql.startsWith('FETCH') && sql.includes('hub_snapshot_order')) {
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
        },close:async()=>connection.close()};
      }};
      const workerDependencies={secretResolver:{isConfiguredReference:async()=>true,resolve:async()=> 'fixture-password'},
        egressPolicy:{environmentKind:'local_lab' as const,policyId:'owned-local-egress'},pageSize:1,leaseSeconds:60};
      await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:interruptedFactory})).resolves.toBe(1);
      const incomplete=await fixture.pool.query(`SELECT r.status,a.ordinal,a.status AS attempt_status,a.error_code,
        count(s.source_pk)::int AS staged FROM control.etl_run r JOIN control.etl_run_attempt a USING(tenant_key,source_id,run_id)
        LEFT JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id)
        WHERE r.run_id=$1 GROUP BY r.status,a.ordinal,a.status,a.error_code`,[run.run_id]);
      expect(incomplete.rows).toEqual([{status:'SCANNING',ordinal:1,attempt_status:'INCOMPLETE',error_code:'SNAPSHOT_SOURCE_UNAVAILABLE',staged:1}]);
      await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBe(0);
      await fixture.pool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()-interval '1 second' WHERE run_id=$1`,[run.run_id]);
      await expect(runSnapshotWorkerOnce(roleScopedPool('hub_worker'),{...workerDependencies,sourceConnectionFactory:realFactory})).resolves.toBe(1);
      const staged=await fixture.pool.query(`SELECT r.status,r.extracted_count,m.state,m.manifest->'relation_counts' AS counts,
        array_agg(s.relation ORDER BY s.relation) AS relations FROM control.etl_run r JOIN control.etl_snapshot_manifest m USING(tenant_key,source_id,run_id)
        JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id)
        WHERE r.run_id=$1 GROUP BY r.status,r.extracted_count,m.state,m.manifest`,[run.run_id]);
      expect(staged.rows[0]).toMatchObject({status:'VALIDATING',extracted_count:'3',state:'EXTRACTED',relations:['customer','order','order_line']});
      expect(staged.rows[0].counts).toMatchObject([{relation:'customer',row_count:1},{relation:'order',row_count:1},{relation:'order_line',row_count:1}]);
      const attempts=await fixture.pool.query(`SELECT a.ordinal,a.status,count(s.source_pk)::int AS staged FROM control.etl_run_attempt a
        LEFT JOIN control.etl_snapshot_stage_record s USING(tenant_key,source_id,run_id,attempt_id) WHERE a.run_id=$1
        GROUP BY a.ordinal,a.status ORDER BY a.ordinal`,[run.run_id]);
      expect(attempts.rows).toEqual([{ordinal:1,status:'INCOMPLETE',staged:1},{ordinal:2,status:'COMPLETE',staged:3}]);
    } finally {
      await ownerPool.end();
      await sourceFixture.pool.query(`DROP SCHEMA IF EXISTS ${sourceSchema} CASCADE`);
      await sourceFixture.pool.query(`DROP ROLE IF EXISTS ${sourceReader}`);
      await sourceFixture.pool.query(`DROP ROLE IF EXISTS ${sourceOwner}`);
      await sourceFixture.close();
      e2eEndpointProfile=undefined;
    }
  });

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
