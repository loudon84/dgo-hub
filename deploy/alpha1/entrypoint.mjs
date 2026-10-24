import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const readSecret = async (name) => {
  const file = process.env[`${name}_FILE`];
  if (!file) return;
  const value = (await readFile(file, 'utf8')).trim();
  if (!value) throw new Error('RUNTIME_SECRET_MISSING');
  process.env[name] = value;
};

for (const name of ['DATABASE_URL', 'HASURA_URL', 'HASURA_JWT_SECRET', 'HASURA_ADMIN_SECRET']) {
  await readSecret(name);
}

const command = process.argv[2];
const targets = {
  api: '../../dist/app.js',
  mcp: '../../dist/sales-mcp/main.js',
  publisher: '../../dist/permission-publish/worker.js',
  worker: '../../dist/etl-worker/worker.js',
  migrate: '../../dist/migrate.js',
  'grant-probe': './grant-probe.mjs',
  'credential-revoke-sequence': './credential-revoke-sequence.mjs',
  'seed-principal': './seed-principal.mjs',
  'sales-probe': './sales-probe.mjs',
  'sales-revoke-http-probe': './sales-revoke-http-probe.mjs',
  'verify-audit': './verify-audit.mjs',
};
const target = targets[command];
if (!target) throw new Error('RUNTIME_COMMAND_INVALID');
const targetUrl = new URL(target, import.meta.url);
const targetPath = fileURLToPath(targetUrl);
process.argv = [process.argv[0], targetPath, ...process.argv.slice(3)];
await import(targetUrl);
