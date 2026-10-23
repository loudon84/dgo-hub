import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../migrations/runner.js';
import { OwnedPostgresError, startOwnedPostgres } from './helpers/postgres.js';

const source001 = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));
const roots: string[] = [];

async function migrationDirectory(secondSql: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'm0-boundary-'));
  roots.push(root);
  const directory = join(root, 'migrations');
  await mkdir(directory);
  await copyFile(source001, join(directory, '001_init.sql'));
  await writeFile(join(directory, '002_boundary.sql'), secondSql);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('migration transaction boundary', () => {
  it.each([
    'CREATE TABLE control.escape_a(id integer); COMMIT; SELECT 1 / 0;',
    'CREATE TABLE control.escape_b(id integer); ROLLBACK; SELECT 1 / 0;',
    'START TRANSACTION;', 'BEGIN WORK;', 'END TRANSACTION;', 'ABORT;',
    "PREPARE TRANSACTION 'escape';", "COMMIT PREPARED 'escape';", "ROLLBACK PREPARED 'escape';",
  ])('rejects top-level transaction control before connecting (%s)', async sql => {
    const connect = vi.fn();
    const pool = { connect } as unknown as pg.Pool;
    await expect(runMigrations(pool, { directory: await migrationDirectory(sql), environmentKind: 'local_lab' }))
      .rejects.toMatchObject({ code: 'MIGRATION_TRANSACTION_CONTROL_FORBIDDEN', version: '002', migrationName: 'boundary' });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    'SET standard_conforming_strings = off;',
    `SET LOCAL "standard_conforming_strings" TO 'off';`,
    `SELECT set_config('standard_conforming_strings','off',false);`,
    `SELECT set_config('standard_' || 'conforming_strings','off',false);`,
    'RESET standard_conforming_strings;', 'RESET ALL;',
  ])('rejects migration changes to the SQL string lexer mode (%s)', async sql => {
    const connect = vi.fn();
    const pool = { connect } as unknown as pg.Pool;
    await expect(runMigrations(pool, { directory: await migrationDirectory(sql), environmentKind: 'local_lab' }))
      .rejects.toMatchObject({ code: 'MIGRATION_SQL_MODE_UNSUPPORTED', version: '002', migrationName: 'boundary' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('allows transaction words in comments, strings, identifiers and dollar-quoted bodies', async () => {
    const sql = `/* COMMIT; /* ROLLBACK; */ */
      CREATE FUNCTION control.word_fixture() RETURNS text LANGUAGE plpgsql AS $body$
      BEGIN RAISE NOTICE 'COMMIT;'; RETURN 'ROLLBACK'; END;
      $body$;
      SELECT 'COMMIT; ROLLBACK;';
      SELECT E'COMMIT; escaped \\' still text';
      SELECT 1 AS "COMMIT"; -- END; ABORT
    `;
    const connect = vi.fn().mockRejectedValue(new Error('not connected in preflight test'));
    const pool = { connect } as unknown as pg.Pool;
    await expect(runMigrations(pool, { directory: await migrationDirectory(sql), environmentKind: 'local_lab' }))
      .rejects.toMatchObject({ code: 'MIGRATION_CONNECTION_FAILED' });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('owned PostgreSQL startup cleanup failure paths', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'm0-docker-mock-'));
    roots.push(root);
    const evidenceFile = join(root, 'lifecycle.jsonl');
    await writeFile(evidenceFile, '');
    let id = 'a'.repeat(64);
    let label = '';
    let cidFile = '';
    const calls: string[][] = [];
    const command = vi.fn(async (args: string[], stage: string) => {
      calls.push(args);
      if (stage === 'container_start') {
        label = args.find(value => value.startsWith('codex.m0.run='))!.slice('codex.m0.run='.length);
        cidFile = args[args.indexOf('--cidfile') + 1];
        await writeFile(cidFile, `${id}\n`);
        throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, 'startup_failed');
      }
      if (stage === 'ownership_check') return `${id}|task0|${label}`;
      if (stage === 'failed_start_cleanup') return '';
      if (stage === 'cleanup_verification') return '';
      throw new Error(`unexpected stage: ${stage}`);
    });
    return { root, evidenceFile, get cidFile() { return cidFile; }, calls, command, setId(value: string) { id = value; } };
  }

  it('recovers the created ID after docker run writes its cidfile then fails', async () => {
    const f = await fixture();
    await expect(startOwnedPostgres({ evidenceFile: f.evidenceFile }, f.command)).rejects.toMatchObject({ code: 'OWNED_POSTGRES_COMMAND_FAILED' });
    const events = (await readFile(f.evidenceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.map(event => event.event)).toEqual(['created', 'removed_after_start_failure']);
    expect(events[0].containerId).toBe('a'.repeat(64));
    expect(events[1]).toMatchObject({ ownershipConfirmed: true, containerAbsentAfterRemoval: true });
    expect(f.calls.map(args => args[0])).toContain('rm');
    await expect(readFile(f.cidFile, 'utf8')).rejects.toThrow();
  });

  it('retains ID locator evidence when owned removal fails', async () => {
    const f = await fixture();
    f.command.mockImplementation(async (args: string[], stage: string) => {
      f.calls.push(args);
      if (stage === 'container_start') {
        const label = args.find(value => value.startsWith('codex.m0.run='))!.slice('codex.m0.run='.length);
        const cidFile = args[args.indexOf('--cidfile') + 1];
        await writeFile(cidFile, `${'a'.repeat(64)}\n`);
        Object.assign(f, { recoveredLabel: label, recoveredCidFile: cidFile });
        throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, 'startup_failed');
      }
      if (stage === 'ownership_check') return `${'a'.repeat(64)}|task0|${String((f as unknown as { recoveredLabel: string }).recoveredLabel)}`;
      if (stage === 'failed_start_cleanup') throw new Error('simulated rm failure');
      throw new Error(`unexpected stage: ${stage}`);
    });
    await expect(startOwnedPostgres({ evidenceFile: f.evidenceFile }, f.command)).rejects.toMatchObject({ code: 'OWNED_POSTGRES_COMMAND_FAILED' });
    const events = (await readFile(f.evidenceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ event: 'cleanup_unconfirmed', containerId: 'a'.repeat(64), ownershipConfirmed: true, containerAbsentAfterRemoval: false });
    const locator = String((f as unknown as { recoveredCidFile: string }).recoveredCidFile);
    await expect(readFile(locator, 'utf8')).resolves.toBe(`${'a'.repeat(64)}\n`);
  });

  it('does not remove a container when either ownership label fails inspection', async () => {
    const f = await fixture();
    f.command.mockImplementation(async (args: string[], stage: string) => {
      f.calls.push(args);
      if (stage === 'container_start') {
        const cidFile = args[args.indexOf('--cidfile') + 1];
        await writeFile(cidFile, `${'a'.repeat(64)}\n`);
        throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, 'startup_failed');
      }
      if (stage === 'ownership_check') return `${'a'.repeat(64)}|other-task|other-run`;
      throw new Error(`unexpected stage: ${stage}`);
    });
    await expect(startOwnedPostgres({ evidenceFile: f.evidenceFile }, f.command)).rejects.toMatchObject({ code: 'OWNED_POSTGRES_COMMAND_FAILED' });
    expect(f.calls.map(args => args[0])).not.toContain('rm');
    const events = (await readFile(f.evidenceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ event: 'cleanup_unconfirmed', ownershipConfirmed: false, containerId: 'a'.repeat(64) });
  });

  it('keeps cleanup unconfirmed when Docker cannot verify absence after rm', async () => {
    const f = await fixture();
    f.command.mockImplementation(async (args: string[], stage: string) => {
      f.calls.push(args);
      if (stage === 'container_start') {
        const label = args.find(value => value.startsWith('codex.m0.run='))!.slice('codex.m0.run='.length);
        const cidFile = args[args.indexOf('--cidfile') + 1];
        await writeFile(cidFile, `${'a'.repeat(64)}\n`);
        Object.assign(f, { recoveredLabel: label, recoveredCidFile: cidFile });
        throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, 'startup_failed');
      }
      if (stage === 'ownership_check') return `${'a'.repeat(64)}|task0|${String((f as unknown as { recoveredLabel: string }).recoveredLabel)}`;
      if (stage === 'failed_start_cleanup') return '';
      if (stage === 'cleanup_verification') throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, 'docker_unavailable');
      throw new Error(`unexpected stage: ${stage}`);
    });
    await expect(startOwnedPostgres({ evidenceFile: f.evidenceFile }, f.command)).rejects.toMatchObject({ code: 'OWNED_POSTGRES_COMMAND_FAILED' });
    const events = (await readFile(f.evidenceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ event: 'cleanup_unconfirmed', containerId: 'a'.repeat(64), ownershipConfirmed: true, containerAbsentAfterRemoval: false });
    const locator = String((f as unknown as { recoveredCidFile: string }).recoveredCidFile);
    await expect(readFile(locator, 'utf8')).resolves.toBe(`${'a'.repeat(64)}\n`);
  });
});
