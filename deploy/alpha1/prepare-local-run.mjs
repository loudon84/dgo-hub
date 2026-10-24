import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3) throw new Error('usage: node prepare-local-run.mjs <absolute-scratch-root>');
const runId = randomUUID();
const runRoot = join(root, runId);
const secretRoot = join(runRoot, 'secrets');
const certificateRoot = join(runRoot, 'certs');
await mkdir(secretRoot, { recursive: true, mode: 0o700 });
await mkdir(certificateRoot, { recursive: true, mode: 0o700 });

const secret = () => randomBytes(32).toString('hex');
const passwords = Object.fromEntries([
  'postgres', 'api_db', 'mcp_db', 'publisher_db', 'hasura_read_db', 'migrator_db', 'hasura_metadata_db', 'worker_db',
].map(name => [name, secret()]));
const urls = {
  api_database_url: `postgres://hub_api:${passwords.api_db}@db:5432/alpha1`,
  mcp_database_url: `postgres://hub_mcp:${passwords.mcp_db}@db:5432/alpha1`,
  publisher_database_url: `postgres://hub_publisher:${passwords.publisher_db}@db:5432/alpha1`,
  hasura_read_database_url: `postgres://hub_hasura_read:${passwords.hasura_read_db}@db:5432/alpha1`,
  migrator_database_url: `postgres://hub_migrator:${passwords.migrator_db}@db:5432/alpha1`,
  hasura_metadata_database_url: `postgres://hub_hasura_meta:${passwords.hasura_metadata_db}@db:5432/hasura_metadata`,
  hasura_metadata_business_database_url: `postgres://hub_hasura_meta:${passwords.hasura_metadata_db}@db:5432/alpha1`,
};
for (const [name, value] of Object.entries({
  postgres_password: passwords.postgres,
  api_db_password: passwords.api_db,
  mcp_db_password: passwords.mcp_db,
  publisher_db_password: passwords.publisher_db,
  hasura_read_db_password: passwords.hasura_read_db,
  migrator_db_password: passwords.migrator_db,
  hasura_metadata_db_password: passwords.hasura_metadata_db,
  worker_db_password: passwords.worker_db,
  hasura_jwt_secret: secret(),
  hasura_admin_secret: secret(),
  ...urls,
})) await writeFile(join(secretRoot, name), `${value}\n`, { mode: 0o600, flag: 'wx' });

const allocate = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('local port allocation failed'));
    const port = address.port;
    server.close(error => error ? reject(error) : resolvePort(port));
  });
});
const [salesPort, managementPort] = await Promise.all([allocate(), allocate()]);
const vars = [
  `ALPHA1_PROJECT=alpha1-m0-${runId.replaceAll('-', '')}`,
  `ALPHA1_SECRETS_DIR=${secretRoot.replaceAll('\\', '/')}`,
  `ALPHA1_CERT_DIR=${certificateRoot.replaceAll('\\', '/')}`,
  `ALPHA1_SALES_PORT=${salesPort}`,
  `ALPHA1_MANAGEMENT_PORT=${managementPort}`,
  'ALPHA1_OIDC_ISSUER=',
  'ALPHA1_OIDC_AUDIENCE=',
  'ALPHA1_OIDC_JWKS_URL=',
].join('\n') + '\n';
await writeFile(join(runRoot, 'compose-vars.env'), vars, { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({ status: 'READY', run_id: runId, run_root: runRoot, secret_directory: secretRoot, certificate_directory: certificateRoot, compose_vars: join(runRoot, 'compose-vars.env'), sales_port: salesPort, management_port: managementPort }) + '\n');
