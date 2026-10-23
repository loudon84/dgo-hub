import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export type MigrationEnvironmentKind = 'local_lab' | 'site';
export type RunMigrationsOptions = {
  directory: string;
  environmentKind: MigrationEnvironmentKind;
  adoptLegacy001?: boolean;
};
export type MigrationRunResult = { applied: string[]; skipped: string[] };

type Migration = { version: number; versionText: string; name: string; sql: string; checksum: string };
type AppliedMigration = { version: number; name: string; checksum: string };

export class MigrationRunnerError extends Error {
  constructor(
    readonly code: string,
    readonly version?: string,
    readonly migrationName?: string,
  ) {
    super([code, version, migrationName].filter(Boolean).join(' '));
    this.name = 'MigrationRunnerError';
  }
}

const LOCK_CLASS = 1_296_905_543;
const LOCK_ID = 1;
const MIGRATION_FILE = /^(\d{3})_([a-zA-Z0-9][a-zA-Z0-9_-]*)\.sql$/;
const KNOWN_APPLICATION_OBJECTS = [
  'hub.customer', 'hub.sales_order', 'hub.order_item',
  'api.customer', 'api.sales_order', 'api.order_item', 'api.sales_summary', 'api.customer_sales',
  'control.ingestion_event', 'control.etl_watermark', 'control.ingestion_failure', 'control.hook_outbox',
  'control.permission_policy', 'control.query_gate', 'control.ontology_binding', 'control.agent_audit',
] as const;

function isWordStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isWordPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function dollarDelimiterAt(sql: string, index: number): string | undefined {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
  return match?.[0];
}

function scanMigrationSql(sql: string): { transactionControl: boolean; stringModeChange: boolean } {
  const statements: Array<{ words: string[]; values: string[] }> = [];
  let words: string[] = [];
  let values: string[] = [];
  let index = 0;
  const finishStatement = () => {
    if (words.length || values.length) statements.push({ words, values });
    words = [];
    values = [];
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') { depth += 1; index += 2; }
        else if (sql[index] === '*' && sql[index + 1] === '/') { depth -= 1; index += 2; }
        else index += 1;
      }
      continue;
    }
    if ((char === 'E' || char === 'e') && next === "'" && (index === 0 || !isWordPart(sql[index - 1]))) {
      index += 2;
      const start = index;
      while (index < sql.length) {
        if (sql[index] === '\\') { index += 2; continue; }
        if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
        if (sql[index] === "'") { values.push(sql.slice(start, index).toUpperCase()); index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (char === "'") {
      index += 1;
      const start = index;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
        if (sql[index] === "'") { values.push(sql.slice(start, index).toUpperCase()); index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      index += 1;
      const identifier: string[] = [];
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') { identifier.push('"'); index += 2; continue; }
        if (sql[index] === '"') { values.push(identifier.join('').toUpperCase()); index += 1; break; }
        identifier.push(sql[index]);
        index += 1;
      }
      continue;
    }
    if (char === '$') {
      const delimiter = dollarDelimiterAt(sql, index);
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        index = end < 0 ? sql.length : end + delimiter.length;
        continue;
      }
    }
    if (isWordStart(char)) {
      const start = index++;
      while (isWordPart(sql[index])) index += 1;
      const word = sql.slice(start, index).toUpperCase();
      words.push(word);
      values.push(word);
      continue;
    }
    if (char === ';') finishStatement();
    index += 1;
  }
  finishStatement();

  let transactionControl = false;
  let stringModeChange = false;
  for (const { words: statementWords, values: statementValues } of statements) {
    const [first, second] = statementWords;
    if (['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT'].includes(first) || (first === 'PREPARE' && second === 'TRANSACTION')) {
      transactionControl = true;
    }

    const changesStringMode = statementValues.includes('STANDARD_CONFORMING_STRINGS') && (first === 'SET' || first === 'RESET');
    if (changesStringMode || statementValues.includes('SET_CONFIG') || (first === 'RESET' && second === 'ALL')) stringModeChange = true;
  }
  return { transactionControl, stringModeChange };
}

function invalid(code: string, migration?: Migration): MigrationRunnerError {
  return new MigrationRunnerError(code, migration?.versionText, migration?.name);
}

function normalizeSql(bytes: Buffer, migration?: Pick<Migration, 'versionText' | 'name'>): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MigrationRunnerError('MIGRATION_SET_INVALID', migration?.versionText, migration?.name);
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new MigrationRunnerError('MIGRATION_SET_INVALID', migration?.versionText, migration?.name);
  return normalized;
}

async function discoverMigrations(directory: string): Promise<Migration[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new MigrationRunnerError('MIGRATION_SET_INVALID');
  }

  const sqlFiles = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'));
  const parsed: Array<{ entryName: string; versionText: string; version: number; name: string }> = [];
  for (const entry of sqlFiles) {
    const match = MIGRATION_FILE.exec(entry.name);
    if (!match) throw new MigrationRunnerError('MIGRATION_SET_INVALID');
    parsed.push({ entryName: entry.name, versionText: match[1], version: Number(match[1]), name: match[2] });
  }
  parsed.sort((left, right) => left.version - right.version || left.entryName.localeCompare(right.entryName));
  if (!parsed.length || parsed.some((migration, index) => index > 0 && migration.version === parsed[index - 1].version)) {
    throw new MigrationRunnerError('MIGRATION_SET_INVALID');
  }
  if (parsed[0].version !== 1 || parsed.some((migration, index) => migration.version !== index + 1)) {
    throw new MigrationRunnerError('MIGRATION_SET_INVALID');
  }

  const migrations: Migration[] = [];
  for (const item of parsed) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, item.entryName));
    } catch {
      throw new MigrationRunnerError('MIGRATION_SET_INVALID', item.versionText, item.name);
    }
    const sql = normalizeSql(bytes, item);
    const safety = scanMigrationSql(sql);
    if (safety.transactionControl) throw new MigrationRunnerError('MIGRATION_TRANSACTION_CONTROL_FORBIDDEN', item.versionText, item.name);
    if (safety.stringModeChange) throw new MigrationRunnerError('MIGRATION_SQL_MODE_UNSUPPORTED', item.versionText, item.name);
    migrations.push({
      ...item,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }
  return migrations;
}

async function detectKnownApplicationObjects(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ object_name: string }>(
    `SELECT expected.object_name
       FROM unnest($1::text[]) AS expected(object_name)
      WHERE to_regclass(expected.object_name) IS NOT NULL`,
    [KNOWN_APPLICATION_OBJECTS],
  );
  return result.rows.map(row => row.object_name);
}

async function ensureLedger(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS control');
    await client.query(`
      CREATE TABLE IF NOT EXISTS control.schema_migration (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch {
    throw new MigrationRunnerError('MIGRATION_LEDGER_INVALID');
  }
}

async function readHistory(client: pg.PoolClient): Promise<AppliedMigration[]> {
  try {
    const result = await client.query<AppliedMigration>(
      'SELECT version, name, checksum FROM control.schema_migration ORDER BY version',
    );
    return result.rows;
  } catch {
    throw new MigrationRunnerError('MIGRATION_LEDGER_INVALID');
  }
}

function validateHistory(history: AppliedMigration[], migrations: Migration[]): Set<number> {
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]));
  const applied = new Set<number>();
  for (const [index, row] of history.entries()) {
    const versionText = Number.isInteger(row.version) && row.version >= 1 && row.version <= 999 ? String(row.version).padStart(3, '0') : undefined;
    const migration = byVersion.get(row.version);
    if (row.version !== index + 1 || !migration || row.name !== migration.name) {
      throw new MigrationRunnerError('MIGRATION_HISTORY_INCONSISTENT', versionText, migration?.name);
    }
    if (row.checksum !== migration.checksum) throw invalid('MIGRATION_CHECKSUM_MISMATCH', migration);
    applied.add(row.version);
  }
  return applied;
}

async function applyMigration(client: pg.PoolClient, migration: Migration): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO control.schema_migration(version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      throw invalid('MIGRATION_ROLLBACK_FAILED', migration);
    }
    throw invalid('MIGRATION_APPLY_FAILED', migration);
  }
}

export async function runMigrations(pool: pg.Pool, options: RunMigrationsOptions): Promise<MigrationRunResult> {
  if (options.environmentKind !== 'local_lab' && options.environmentKind !== 'site') {
    throw new MigrationRunnerError('MIGRATION_ENVIRONMENT_INVALID');
  }
  if (options.adoptLegacy001 && options.environmentKind !== 'local_lab') {
    throw new MigrationRunnerError('LEGACY_ADOPTION_FORBIDDEN');
  }

  const migrations = await discoverMigrations(options.directory);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new MigrationRunnerError('MIGRATION_CONNECTION_FAILED');
  }

  let primaryError: unknown;
  let result: MigrationRunResult | undefined;
  let lockAttempted = false;
  let destroyClient = false;
  try {
    try {
      lockAttempted = true;
      await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_CLASS, LOCK_ID]);
    } catch {
      throw new MigrationRunnerError('MIGRATION_LOCK_FAILED');
    }

    try {
      const sqlMode = await client.query<{ standard_conforming_strings: string }>('SHOW standard_conforming_strings');
      if (sqlMode.rows[0]?.standard_conforming_strings !== 'on') throw new MigrationRunnerError('MIGRATION_SQL_MODE_UNSUPPORTED');
    } catch (error) {
      if (error instanceof MigrationRunnerError) throw error;
      throw new MigrationRunnerError('MIGRATION_SQL_MODE_UNSUPPORTED');
    }

    let ledgerExists = false;
    try {
      const ledger = await client.query<{ ledger: string | null }>(
        "SELECT to_regclass('control.schema_migration')::text AS ledger",
      );
      ledgerExists = ledger.rows[0]?.ledger !== null;
    } catch {
      throw new MigrationRunnerError('MIGRATION_CATALOG_INVALID');
    }
    const knownObjects = await detectKnownApplicationObjects(client);
    const history = ledgerExists ? await readHistory(client) : [];
    const legacyWithoutHistory = knownObjects.length > 0 && history.length === 0;
    if (legacyWithoutHistory && !options.adoptLegacy001) {
      throw new MigrationRunnerError('LEGACY_BASELINE_REQUIRED');
    }
    if (legacyWithoutHistory && !migrations.some(migration => migration.version === 1 && migration.name === 'init')) {
      throw new MigrationRunnerError('MIGRATION_HISTORY_INCONSISTENT', '001', 'init');
    }

    await ensureLedger(client);
    const appliedVersions = validateHistory(history, migrations);
    const applied: string[] = [];
    const skipped: string[] = [];

    if (legacyWithoutHistory) {
      const baseline = migrations[0];
      await applyMigration(client, baseline);
      appliedVersions.add(baseline.version);
      applied.push(`${baseline.versionText}_${baseline.name}`);
    }
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        if (!legacyWithoutHistory || migration.version !== 1) skipped.push(`${migration.versionText}_${migration.name}`);
        continue;
      }
      await applyMigration(client, migration);
      appliedVersions.add(migration.version);
      applied.push(`${migration.versionText}_${migration.name}`);
    }
    result = { applied, skipped };
  } catch (error) {
    primaryError = error instanceof MigrationRunnerError ? error : new MigrationRunnerError('MIGRATION_RUN_FAILED');
  } finally {
    if (lockAttempted) {
      try {
        const unlocked = await client.query<{ pg_advisory_unlock: boolean }>(
          'SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_ID],
        );
        if (unlocked.rows[0]?.pg_advisory_unlock !== true && !primaryError) {
          primaryError = new MigrationRunnerError('MIGRATION_LOCK_RELEASE_FAILED');
        }
      } catch {
        destroyClient = true;
        if (!primaryError) primaryError = new MigrationRunnerError('MIGRATION_LOCK_RELEASE_FAILED');
      }
    }
    client.release(destroyClient ? new Error('migration lock release failed') : undefined);
  }
  if (primaryError) throw primaryError;
  return result!;
}
