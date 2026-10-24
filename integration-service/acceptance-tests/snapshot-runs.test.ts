import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { createSourceRegistryService, type SourceRegistryService } from '../source-registry/service.js';
import { runMigrations } from '../migrations/runner.js';
import { buildApp } from '../app.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

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

beforeAll(async () => {
  if (!evidenceRoot) await mkdir(dirname(localEvidence), { recursive: true });
  fixture = await startOwnedPostgres({ evidenceFile: localEvidence, evidenceRoot, taskLabel: 'm1task5', imageReference: postgresImage });
  initialMigrations = await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  auth = createAuthService({ pool: fixture.pool });
  const endpointAllowlist = { resolve: async (reference: string) => {
    if (reference !== 'pg-test') throw new Error('endpoint not approved');
    return { revision: 'pg-v1', connector: 'postgresql' as const, protocol: 'postgres:' as const, host: 'source.fixture.invalid',
      port: 5432, database: 'source_db', user: 'source_reader', schema: 'public',
      entities: { customer: { table: 'customers', version_field: 'source_version' },
        order: { table: 'orders', version_field: 'source_version' } } };
  } };
  service = createSourceRegistryService({ pool: fixture.pool, auth, environmentKind: 'local_lab',
    secretResolver: { isConfiguredReference: async value => value === 'vault:/snapshot/source', resolve: async () => 'fixture-secret' },
    endpointAllowlist, capabilityProbe: { run: async () => ({ passed: true, checks: ['READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID'] }) } });
}, 90_000);

beforeEach(async () => {
  await fixture.pool.query(`TRUNCATE control.etl_run_attempt,control.etl_run,control.etl_snapshot_schedule,
    control.source_security_barrier,control.source_lifecycle_event,control.source_owner_approval,control.source_test_report,
    control.source_channel,control.source_identity_mapping_revision,control.source_mapping_revision,control.source_config_revision,
    control.source_registry,control.source_credential,control.identity_binding,control.auth_subject,control.tenant,
    control.credential_digest_registry CASCADE`);
  await auth.repository.provisionTenant({ tenantId: owner.tenantId, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: owner.tenantId, userId: owner.userId, managementScopes: owner.managementScopes });
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
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname='control' AND c.relname='etl_run' AND a.grantee=0 AND a.privilege_type='SELECT') AS public_read`);
    expect(grants.rows[0]).toMatchObject({ api_read: true, worker_proof_update: false, public_read: false });
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

  it('fails closed for order snapshots until the approved line relation contract exists', async () => {
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
    const approval = await service.approve(owner,'pg_order','1',tested.test_report_id,tested.data_contract_ref);
    await service.activate(owner,'pg_order','1',approval.approval_id);
    const { createSnapshotRun } = await import('../etl-worker/snapshot-runs.js');
    await expect(createSnapshotRun(roleScopedPool('hub_api'),auth,owner,'pg_order','1','order-run'))
      .rejects.toMatchObject({ code:'SOURCE_CONTRACT_INVALID' });
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
