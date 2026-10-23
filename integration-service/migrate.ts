import pg from 'pg';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMigrations, MigrationRunnerError, type MigrationEnvironmentKind } from './migrations/runner.js';

export { runMigrations, MigrationRunnerError };
export type { MigrationEnvironmentKind, MigrationRunResult, RunMigrationsOptions } from './migrations/runner.js';

type CliOptions = { environmentKind: MigrationEnvironmentKind; adoptLegacy001: boolean };

function parseCliArguments(arguments_: string[]): CliOptions {
  let selectedEnvironment: string | undefined;
  let explicitEnvironment = false;
  let adoptLegacy001 = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--adopt-legacy-001') {
      adoptLegacy001 = true;
      continue;
    }
    if (argument === '--environment-kind') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) throw new MigrationRunnerError('MIGRATION_CLI_ARGUMENT_INVALID');
      selectedEnvironment = value;
      explicitEnvironment = true;
      index += 1;
      continue;
    }
    if (argument.startsWith('--environment-kind=')) {
      selectedEnvironment = argument.slice('--environment-kind='.length);
      explicitEnvironment = true;
      continue;
    }
    throw new MigrationRunnerError('MIGRATION_CLI_ARGUMENT_INVALID');
  }

  const environmentKind = selectedEnvironment ?? process.env.HUB_ENVIRONMENT_KIND ?? 'site';
  if (environmentKind !== 'local_lab' && environmentKind !== 'site') {
    throw new MigrationRunnerError('MIGRATION_ENVIRONMENT_INVALID');
  }
  if (adoptLegacy001 && (environmentKind !== 'local_lab' || (!explicitEnvironment && !process.env.HUB_ENVIRONMENT_KIND))) {
    throw new MigrationRunnerError('LEGACY_ADOPTION_FORBIDDEN');
  }
  return { environmentKind, adoptLegacy001 };
}

function safeErrorRecord(error: unknown): { code: string; version?: string; migrationName?: string } {
  if (error instanceof MigrationRunnerError) {
    return {
      code: error.code,
      ...(error.version ? { version: error.version } : {}),
      ...(error.migrationName ? { migrationName: error.migrationName } : {}),
    };
  }
  return { code: 'MIGRATION_RUN_FAILED' };
}

async function runCli(): Promise<void> {
  let pool: pg.Pool | undefined;
  let resultCode = 0;
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new MigrationRunnerError('DATABASE_URL_REQUIRED');
    pool = new pg.Pool({ connectionString });
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const directory = basename(moduleDirectory) === 'dist'
      ? resolve(moduleDirectory, '../migrations')
      : resolve(moduleDirectory, 'migrations');
    const result = await runMigrations(pool, { directory, ...options });
    console.log(JSON.stringify({ status: 'PASS', ...result }));
  } catch (error) {
    resultCode = 1;
    console.error(JSON.stringify({ status: 'FAIL', ...safeErrorRecord(error) }));
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        if (resultCode === 0) {
          resultCode = 1;
          console.error(JSON.stringify({ status: 'FAIL', code: 'MIGRATION_POOL_CLOSE_FAILED' }));
        }
      }
    }
  }
  process.exitCode = resultCode;
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && pathToFileURL(resolve(entrypoint!)).href === import.meta.url;
}

if (isDirectExecution()) void runCli();
