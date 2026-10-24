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
const source001 = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));
const source002 = fileURLToPath(new URL('../migrations/002_identity_auth.sql', import.meta.url));
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
  postgres = await startOwnedPostgres({ evidenceFile, evidenceRoot: controlledEvidenceRoot, taskLabel: 'task0' });
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
  await postgres.pool.query('DROP SCHEMA IF EXISTS api, hub, control CASCADE');
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
    expect(JSON.parse(output)).toEqual({ status: 'PASS', applied: ['001_init', '002_identity_auth', '003_mcp_audit_boundary'], skipped: [] });
    expect(await ledgerState()).toEqual({ exists: true, count: 3 });
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
