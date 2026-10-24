import pg from 'pg';
import { readFile } from 'node:fs/promises';

const connectionString = (await readFile(process.env.MIGRATOR_DATABASE_URL_FILE, 'utf8')).trim();
const pool = new pg.Pool({ connectionString, max: 1 });
const identity = { tenant: 'alpha1_local', user: 'sales_probe', issuer: 'https://alpha1.invalid/oidc', subject: 'task4-sales-probe' };
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO control.tenant(tenant_key,business_timezone) VALUES($1,'UTC') ON CONFLICT(tenant_key) DO NOTHING", [identity.tenant]);
    await client.query("INSERT INTO control.auth_subject(tenant_key,user_id,business_role,management_scopes) VALUES($1,$2,'sales','{}') ON CONFLICT(tenant_key,user_id) DO NOTHING", [identity.tenant, identity.user]);
    await client.query('INSERT INTO control.identity_binding(issuer,subject,tenant_key,user_id) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO NOTHING', [identity.issuer, identity.subject, identity.tenant, identity.user]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  process.stdout.write(JSON.stringify({ status: 'PASS', principal: 'synthetic-local-sales', provisionedBy: 'one-shot-migrator' }) + '\n');
} catch {
  await pool.query('ROLLBACK').catch(() => undefined);
  process.stderr.write('{"status":"FAIL","code":"LOCAL_PRINCIPAL_PROVISION_FAILED"}\n');
  process.exitCode = 1;
} finally {
  await pool.end();
}
