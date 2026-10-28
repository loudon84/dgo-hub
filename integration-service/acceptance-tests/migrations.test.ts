import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceDirectory = fileURLToPath(new URL('../../docs/execution/alpha1/m0-task-1-evidence/round1/', import.meta.url));
const evidenceFile = join(evidenceDirectory, 'foundation-postgres-lifecycle.jsonl');
const controlledEvidenceRoot = fixtureEvidenceRootFromEnvironment();
const postgresImage = 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
const source001 = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));
const source002 = fileURLToPath(new URL('../migrations/002_identity_auth.sql', import.meta.url));
const migrationsSourceDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
let postgres: OwnedPostgres;
let runMigrations: (pool: pg.Pool, options: { directory: string; environmentKind: 'local_lab' | 'site'; adoptLegacy001?: boolean }) => Promise<{ applied: string[]; skipped: string[] }>;
let migrationDirectories: string[] = [];

async function createMigrationDirectory(additional: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'm0-migration-'));
  migrationDirectories.push(root);
  const directory = join(root, 'migrations');
  await mkdir(directory);
  await copyFile(source001, join(directory, '001_init.sql'));
  for (const [name, contents] of Object.entries(additional)) await writeFile(join(directory, name), contents);
  return directory;
}

async function createVersionedMigrationDirectory(lastVersion: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'm0-migration-m1t4-upgrade-'));
  migrationDirectories.push(root);
  const directory = join(root, 'migrations');
  await mkdir(directory);
  for (let version = 1; version <= lastVersion; version += 1) {
    const name = (await (await import('node:fs/promises')).readdir(migrationsSourceDirectory))
      .find(file => file.startsWith(`${String(version).padStart(3, '0')}_`) && file.endsWith('.sql'));
    if (!name) throw new Error(`MIGRATION_FIXTURE_SOURCE_MISSING:${version}`);
    await copyFile(join(migrationsSourceDirectory, name), join(directory, name));
  }
  return directory;
}

async function ledgerState(): Promise<{ exists: boolean; count: number }> {
  const result = await postgres.pool.query<{ ledger: string | null }>("SELECT to_regclass('control.schema_migration')::text AS ledger");
  if (!result.rows[0].ledger) return { exists: false, count: 0 };
  const count = await postgres.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM control.schema_migration');
  return { exists: true, count: Number(count.rows[0].count) };
}

async function migrationRunner() {
  if (!runMigrations) runMigrations = (await import('../migrate.js')).runMigrations;
  return runMigrations;
}

beforeAll(async () => {
  if (!controlledEvidenceRoot) await mkdir(evidenceDirectory, { recursive: true });
  postgres = await startOwnedPostgres({ evidenceFile, evidenceRoot: controlledEvidenceRoot, taskLabel: 'm1task5', imageReference: postgresImage });
}, 90_000);

afterAll(async () => {
  if (postgres) {
    const resource = {
      runLabel: postgres.runLabel,
      containerId: postgres.containerId,
      imageReference: postgres.imageReference,
      repoDigest: postgres.repoDigest,
      runtimeImageId: postgres.runtimeImageId,
      hostPort: postgres.hostPort,
    };
    await postgres.close();
    await writeFile(join(dirname(postgres.evidenceFile), 'foundation-postgres-resource-summary.json'), `${JSON.stringify({ ...resource, cleanup: 'confirmed removed by exact owned container ID' }, null, 2)}\n`);
  }
});

beforeEach(async () => {
  await postgres.pool.query('DROP SCHEMA IF EXISTS api, hub, control, raw CASCADE');
});

afterEach(async () => {
  for (const root of migrationDirectories) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir(), 'm0-migration-'))) throw new Error('test migration directory escaped its temporary root');
    await rm(absolute, { recursive: true, force: true });
  }
  migrationDirectories = [];
});

describe('versioned migration runner', () => {
  it('upgrades accepted 007 ingestion facts through 008 and preserves them on repeat', async () => {
    const run = await migrationRunner();
    const version007 = await createVersionedMigrationDirectory(7);
    const version008 = await createVersionedMigrationDirectory(8);
    await run(postgres.pool, { directory: version007, environmentKind: 'local_lab' });
    const tenant = 'm1t4_upgrade_tenant';
    const source = 'm1t4-upgrade-source';
    const owner = 'm1t4-upgrade-owner';
    const digests = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x44)];
    const credentialDigest = Buffer.alloc(32, 0x55);
    const jobId = '10000000-0000-4000-8000-000000000001';
    const batchId = '10000000-0000-4000-8000-000000000002';
    const proofIds = ['10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004'];
    const channelId = '10000000-0000-4000-8000-000000000005';
    await postgres.pool.query("INSERT INTO control.tenant(tenant_key,business_timezone) VALUES($1,'UTC')", [tenant]);
    await postgres.pool.query("INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role) VALUES($1,$2,'sales','sales')", [tenant,owner]);
    await postgres.pool.query("INSERT INTO control.credential_digest_registry(digest,kind) VALUES($1,'source')", [credentialDigest]);
    const credential = await postgres.pool.query<{id:string}>(`INSERT INTO control.source_credential
      (tenant_key,source_id,digest,secret_ref,allowed_entities,enabled,revision)
      VALUES($1,$2,$3,'vault:/fixture',ARRAY['customer']::text[],true,1) RETURNING id`, [tenant,source,credentialDigest]);
    await postgres.pool.query("INSERT INTO control.source_registry(tenant_key,source_id,data_owner_user_id,lifecycle) VALUES($1,$2,$3,'ACTIVE')", [tenant,source,owner]);
    for (const [table, digest] of [['source_config_revision',digests[0]],['source_mapping_revision',digests[1]],['source_identity_mapping_revision',digests[2]]] as const) {
      const mappings = table === 'source_config_revision' ? JSON.stringify({allowed_entities:['customer'],connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION'}) : '[]';
      await postgres.pool.query(`INSERT INTO control.${table}(tenant_key,source_id,revision,${table === 'source_config_revision' ? 'config_digest,config' : 'mapping_digest,mappings'},created_by) VALUES($1,$2,1,$3,$4::jsonb,$5)`, [tenant,source,digest,mappings,owner]);
    }
    await postgres.pool.query(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,
      config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,endpoint_profile_digest,
      data_contract_ref,report,status,created_by) VALUES($1,$2,1,1,1,$3,$4,$5,1,1,$6,'hub.v1','{}','PASS',$7)`,
    [tenant,source,...digests.slice(0,3),digests[3],owner]);
    const reportId = (await postgres.pool.query<{id:string}>('SELECT id::text FROM control.source_test_report WHERE tenant_key=$1 AND source_id=$2',[tenant,source])).rows[0]!.id;
    await postgres.pool.query(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
      identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
      endpoint_profile_digest,data_contract_ref,test_report_id) VALUES($1,$2,$3,1,1,1,1,$4,$5,$6,1,1,$7,'hub.v1',$8)`,
    [tenant,source,owner,...digests,reportId]);
    const approvalId=(await postgres.pool.query<{id:string}>('SELECT id::text FROM control.source_owner_approval WHERE tenant_key=$1 AND source_id=$2',[tenant,source])).rows[0]!.id;
    await postgres.pool.query(`INSERT INTO control.source_channel(id,tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
      VALUES($1,$2,$3,'customer','rest','INCREMENTAL','SOURCE_VERSION',1,'active')`,[channelId,tenant,source]);
    const rawId=(await postgres.pool.query<{id:string}>(`INSERT INTO raw.ingestion_batch(tenant_key,source_id,route,body_bytes)
      VALUES($1,$2,'/hub/v1/ingest/crm/customers',$3) RETURNING id::text`,[tenant,source,Buffer.from('{"records":[{"source_pk":"C-1"}]}')])).rows[0]!.id;
    await postgres.pool.query(`INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,
      status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,
      channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,config_revision,config_digest,
      mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,test_report_id,
      security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
      VALUES($1,$2,$3,'customer','/hub/v1/ingest/crm/customers',$4,$5,'upgrade-key',$6,'RECEIVED',1,0,$7,0,1,1,$8,1,'SOURCE_VERSION',
      $9,$10,1,0,1,$11,1,$12,1,$13,$14,$15,0,'2026-10-22T00:00:00Z','2026-10-22T00:00:00Z')`,
    [jobId,tenant,source,batchId,rawId,digests[0],credential.rows[0]!.id,channelId,approvalId,owner,...digests,reportId]);
    const eventId='10000000-0000-4000-8000-000000000006';
    await postgres.pool.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
      VALUES($1,0,$2,'C-1',1,'UPSERT','2026-10-22T00:00:00Z','{"operation":"UPSERT","data":{"customer_name":"Accepted"}}','RECEIVED')`,[jobId,eventId]);
    await postgres.pool.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)',[jobId]);
    const before=(await postgres.pool.query<{raw:string;job:string;item:string;outbox:string}>(`SELECT
      (SELECT encode(body_bytes,'hex') FROM raw.ingestion_batch WHERE id=$1) AS raw,
      (SELECT to_jsonb(j)::text FROM control.ingestion_job j WHERE j.id=$2) AS job,
      (SELECT jsonb_build_object('job_id',job_id,'ordinal',ordinal,'event_id',event_id,'source_pk',source_pk,'source_version',source_version,
        'operation',operation,'source_updated_at',source_updated_at,'public_record',public_record,'status',status,'error_code',error_code,'updated_at',updated_at)::text
        FROM control.ingestion_job_item WHERE job_id=$2) AS item,
      (SELECT jsonb_build_object('job_id',job_id,'created_at',created_at) FROM control.ingestion_processing_outbox WHERE job_id=$2)::text AS outbox`,[rawId,jobId])).rows[0]!;
    await expect(run(postgres.pool, { directory: version008, environmentKind: 'local_lab' })).resolves.toMatchObject({applied:['008_durable_worker_leases_and_retries']});
    await expect(run(postgres.pool, { directory: version008, environmentKind: 'local_lab' })).resolves.toMatchObject({applied:[],skipped:['001_init','002_identity_auth','003_mcp_audit_boundary','004_alpha1_runtime_security','005_source_registry','006_canonical_data_and_receipts','007_durable_ingestion_jobs','008_durable_worker_leases_and_retries']});
    const after=(await postgres.pool.query<{raw:string;job:string;item:string;outbox:string;operation_id:string}>(`SELECT
      (SELECT encode(body_bytes,'hex') FROM raw.ingestion_batch WHERE id=$1) AS raw,
      (SELECT to_jsonb(j)::text FROM control.ingestion_job j WHERE j.id=$2) AS job,
      (SELECT jsonb_build_object('job_id',job_id,'ordinal',ordinal,'event_id',event_id,'source_pk',source_pk,'source_version',source_version,
        'operation',operation,'source_updated_at',source_updated_at,'public_record',public_record,'status',status,'error_code',error_code,'updated_at',updated_at)::text
        FROM control.ingestion_job_item WHERE job_id=$2) AS item,
      (SELECT jsonb_build_object('job_id',job_id,'created_at',created_at) FROM control.ingestion_processing_outbox WHERE job_id=$2)::text AS outbox,
      (SELECT operation_id::text FROM control.ingestion_job_item WHERE job_id=$2) AS operation_id`,[rawId,jobId])).rows[0]!;
    expect(after).toMatchObject({raw:before.raw,job:before.job,item:before.item,outbox:before.outbox});
    expect(after.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    await postgres.pool.query(`UPDATE control.ingestion_job_item SET status='APPLYING',attempts_started=1,retries_used=0 WHERE job_id=$1`,[jobId]);
    await postgres.pool.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[jobId]);
    const repeatId=(await postgres.pool.query<{id:string}>('SELECT operation_id::text AS id FROM control.ingestion_job_item WHERE job_id=$1',[jobId])).rows[0]!.id;
    expect(repeatId).toBe(after.operation_id);
  });

  it('imports without connecting, querying, migrating, exiting, or closing a pool', async () => {
    const connect = vi.spyOn(pg.Pool.prototype, 'connect');
    const query = vi.spyOn(pg.Pool.prototype, 'query');
    const end = vi.spyOn(pg.Pool.prototype, 'end');
    const exit = vi.spyOn(process, 'exit');
    const module = await import('../migrate.js');
    runMigrations = module.runMigrations;
    expect(runMigrations).toBeTypeOf('function');
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    connect.mockRestore(); query.mockRestore(); end.mockRestore(); exit.mockRestore();
  });

  it('runs the compiled CLI with an explicit environment and closes its own pool', async () => {
    const connectionString = `postgres://postgres@127.0.0.1:${postgres.hostPort}/postgres`;
    const output = execFileSync(process.execPath, ['dist/migrate.js', '--environment-kind', 'local_lab'], {
      cwd: process.cwd(),
      env: {
        DATABASE_URL: connectionString,
        HUB_ENVIRONMENT_KIND: 'site',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      timeout: 15_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual({ status: 'PASS', applied: ['001_init', '002_identity_auth', '003_mcp_audit_boundary', '004_alpha1_runtime_security', '005_source_registry', '006_canonical_data_and_receipts', '007_durable_ingestion_jobs', '008_durable_worker_leases_and_retries', '009_snapshot_runs_and_recovery','010_simulated_import'], skipped: [] });
    expect(await ledgerState()).toEqual({ exists: true, count: 10 });
    const grants = await postgres.pool.query<{ api_registry_digest_select: boolean; api_registry_kind_select: boolean; api_subject_business_role_update: boolean; api_business_read: boolean; mcp_source_read: boolean; publisher_gate_update: boolean; publisher_close_execute: boolean; no_public_default_acl: boolean }>(`SELECT
      has_column_privilege('hub_api','control.credential_digest_registry','digest','SELECT') AS api_registry_digest_select,
      has_column_privilege('hub_api','control.credential_digest_registry','kind','SELECT') AS api_registry_kind_select,
      has_column_privilege('hub_api','control.auth_subject','business_role','UPDATE') AS api_subject_business_role_update,
      has_table_privilege('hub_api','hub.customer','SELECT') AS api_business_read,
      has_table_privilege('hub_mcp','control.source_credential','SELECT') AS mcp_source_read,
      has_table_privilege('hub_publisher','control.query_gate','UPDATE') AS publisher_gate_update,
      has_function_privilege('hub_publisher','control.close_query_gate()','EXECUTE') AS publisher_close_execute,
      NOT EXISTS (SELECT 1 FROM pg_default_acl da CROSS JOIN LATERAL aclexplode(da.defaclacl) acl
        WHERE da.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND acl.grantee=0) AS no_public_default_acl`);
    expect(grants.rows[0]).toEqual({
      api_registry_digest_select: true,
      api_registry_kind_select: false,
      api_subject_business_role_update: false,
      api_business_read: false,
      mcp_source_read: false,
      publisher_gate_update: false,
      publisher_close_execute: true,
      no_public_default_acl: true,
    });
  });

  it('applies 001 to an empty database, skips it on repeat, and preserves migration data', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory();
    const first = await run(postgres.pool, { directory, environmentKind: 'local_lab' });
    expect(first).toEqual({ applied: ['001_init'], skipped: [] });
    await postgres.pool.query("INSERT INTO hub.customer(tenant_id,source_system,source_id,owner_user_id,version,name) VALUES ('t1','crm','c1','u1',1,'Acme')");
    const second = await run(postgres.pool, { directory, environmentKind: 'local_lab' });
    expect(second).toEqual({ applied: [], skipped: ['001_init'] });
    const rows = await postgres.pool.query<{ name: string }>("SELECT name FROM hub.customer WHERE source_id='c1'");
    expect(rows.rows).toEqual([{ name: 'Acme' }]);
    expect(await ledgerState()).toEqual({ exists: true, count: 1 });
    await expect(postgres.pool.query('SELECT 1')).resolves.toBeDefined();
  });

  it('normalizes CRLF to LF when recording the migration checksum', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory();
    const filePath = join(directory, '001_init.sql');
    const original = await readFile(filePath, 'utf8');
    await writeFile(filePath, original.replace(/\n/g, '\r\n'));
    await run(postgres.pool, { directory, environmentKind: 'local_lab' });
    const ledger = await postgres.pool.query<{ checksum: string }>('SELECT checksum FROM control.schema_migration WHERE version = 1');
    expect(ledger.rows[0].checksum).toBe(createHash('sha256').update(original.replace(/\r\n?/g, '\n')).digest('hex'));
    await writeFile(filePath, original);
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).resolves.toEqual({ applied: [], skipped: ['001_init'] });
  });

  it('serializes concurrent runners and applies each migration exactly once', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory({ '002_concurrent.sql': 'CREATE TABLE control.concurrent_marker(id integer PRIMARY KEY);\n' });
    const results = await Promise.all([
      run(postgres.pool, { directory, environmentKind: 'local_lab' }),
      run(postgres.pool, { directory, environmentKind: 'local_lab' }),
    ]);
    expect(results.flatMap(result => result.applied).sort()).toEqual(['001_init', '002_concurrent']);
    expect(results.flatMap(result => result.skipped).sort()).toEqual(['001_init', '002_concurrent']);
    expect(await ledgerState()).toEqual({ exists: true, count: 2 });
    const marker = await postgres.pool.query("SELECT to_regclass('control.concurrent_marker')::text AS name");
    expect(marker.rows[0].name).toBe('control.concurrent_marker');
  });

  it('rolls back a failed migration and ledger row while preserving 001, then retries successfully', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory({ '002_retry.sql': 'CREATE TABLE control.retry_marker(id integer);\nSELECT 1 / 0;\n' });
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'MIGRATION_APPLY_FAILED', version: '002', migrationName: 'retry' });
    expect(await ledgerState()).toEqual({ exists: true, count: 1 });
    let marker = await postgres.pool.query("SELECT to_regclass('control.retry_marker')::text AS name");
    expect(marker.rows[0].name).toBeNull();
    await writeFile(join(directory, '002_retry.sql'), 'CREATE TABLE control.retry_marker(id integer);\n');
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).resolves.toEqual({ applied: ['002_retry'], skipped: ['001_init'] });
    marker = await postgres.pool.query("SELECT to_regclass('control.retry_marker')::text AS name");
    expect(marker.rows[0].name).toBe('control.retry_marker');
    expect(await ledgerState()).toEqual({ exists: true, count: 2 });
  });

  it.each(['COMMIT', 'ROLLBACK'] as const)(
    'rejects a newline-continued E-string %s before any migration DDL or ledger write', async control => {
      const run = await migrationRunner();
      const directory = await createMigrationDirectory();
      await copyFile(source002, join(directory, '002_identity_auth.sql'));
      const sql = `CREATE TABLE control.review_e_${control.toLowerCase()}(id integer); SELECT E'x'\n'\\'; SELECT 1; ' ; ${control}; SELECT 1 / 0; SELECT 'x';`;
      await writeFile(join(directory, '003_e_continuation.sql'), sql);

      let runError: unknown;
      try { await run(postgres.pool, { directory, environmentKind: 'local_lab' }); } catch (error) { runError = error; }
      const escapedTable = await postgres.pool.query<{ name: string | null }>(
        `SELECT to_regclass('control.review_e_${control.toLowerCase()}')::text AS name`,
      );
      const ledger = await ledgerState();
      expect({
        error: (runError as { code?: string } | undefined)?.code,
        escapedTable: escapedTable.rows[0].name,
        ledger,
      }).toEqual({
        error: 'MIGRATION_TRANSACTION_CONTROL_FORBIDDEN',
        escapedTable: null,
        ledger: { exists: false, count: 0 },
      });
    },
  );

  it('rejects an applied migration whose checksum changed without adding history', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory();
    await run(postgres.pool, { directory, environmentKind: 'local_lab' });
    await writeFile(join(directory, '001_init.sql'), `${await readFile(join(directory, '001_init.sql'), 'utf8')}-- altered\n`);
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: '001', migrationName: 'init' });
    expect(await ledgerState()).toEqual({ exists: true, count: 1 });
  });

  it.each(['renamed', 'missing'])('rejects an applied migration file that is %s', async action => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory({ '002_second.sql': 'CREATE TABLE control.second_marker(id integer);\n' });
    await run(postgres.pool, { directory, environmentKind: 'local_lab' });
    if (action === 'renamed') await rename(join(directory, '002_second.sql'), join(directory, '002_renamed.sql'));
    else await rm(join(directory, '002_second.sql'));
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INCONSISTENT' });
    expect(await ledgerState()).toEqual({ exists: true, count: 2 });
  });

  it.each([
    ['duplicate version', { '001_duplicate.sql': 'SELECT 1;\n' }],
    ['version gap', { '003_gap.sql': 'SELECT 1;\n' }],
    ['invalid UTF-8', { '002_bad.sql': Buffer.from([0xff, 0xfe]) }],
    ['empty SQL', { '002_empty.sql': ' \r\n\t ' }],
  ])('rejects %s without creating phantom migration records', async (_label, additional) => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory(additional);
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'MIGRATION_SET_INVALID' });
    expect(await ledgerState()).toEqual({ exists: false, count: 0 });
  });

  it('rejects known 001 objects without a ledger, then adopts them only in local_lab', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory();
    await postgres.pool.query(await readFile(source001, 'utf8'));
    await postgres.pool.query("INSERT INTO hub.customer(tenant_id,source_system,source_id,owner_user_id,version,name) VALUES ('t1','crm','legacy','u1',1,'Legacy')");
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'LEGACY_BASELINE_REQUIRED' });
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab', adoptLegacy001: true })).resolves.toEqual({ applied: ['001_init'], skipped: [] });
    const rows = await postgres.pool.query<{ name: string }>("SELECT name FROM hub.customer WHERE source_id='legacy'");
    expect(rows.rows).toEqual([{ name: 'Legacy' }]);
    expect(await ledgerState()).toEqual({ exists: true, count: 1 });
  });

  it('prohibits site adoption and preserves unrelated public objects', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory();
    await postgres.pool.query('CREATE TABLE public.unrelated_fixture(id integer PRIMARY KEY)');
    await expect(run(postgres.pool, { directory, environmentKind: 'site' })).resolves.toEqual({ applied: ['001_init'], skipped: [] });
    const preserved = await postgres.pool.query("SELECT to_regclass('public.unrelated_fixture')::text AS name");
    expect(preserved.rows[0].name).toBe('unrelated_fixture');

    await postgres.pool.query('DROP SCHEMA IF EXISTS api, hub, control CASCADE');
    await postgres.pool.query(await readFile(source001, 'utf8'));
    await expect(run(postgres.pool, { directory, environmentKind: 'site', adoptLegacy001: true })).rejects.toMatchObject({ code: 'LEGACY_ADOPTION_FORBIDDEN' });
    expect(await ledgerState()).toEqual({ exists: false, count: 0 });
  });

  it('releases its session lock after a failed migration so a later runner can proceed', async () => {
    const run = await migrationRunner();
    const directory = await createMigrationDirectory({ '002_failure.sql': 'SELECT 1 / 0;\n' });
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).rejects.toMatchObject({ code: 'MIGRATION_APPLY_FAILED' });
    await writeFile(join(directory, '002_failure.sql'), 'CREATE TABLE control.failure_recovered(id integer);\n');
    await expect(run(postgres.pool, { directory, environmentKind: 'local_lab' })).resolves.toEqual({ applied: ['002_failure'], skipped: ['001_init'] });
  });
});
