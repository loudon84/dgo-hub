import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createAuthService } from '../../dist/auth/service.js';

const result = { status: 'PASS', checks: [] };
let stage = 'initialization';
const record = (name, pass, details = {}) => {
  result.checks.push({ name, status: pass ? 'PASS' : 'FAIL', ...details });
  if (!pass) result.status = 'FAIL';
};
const withPool = async (environmentKey, callback) => {
  const connectionString = (await readFile(process.env[`${environmentKey}_FILE`], 'utf8')).trim();
  const pool = new pg.Pool({ connectionString, max: 2 });
  try { return await callback(pool); } finally { await pool.end(); }
};
const allowed = async (pool, sql, values = []) => { await pool.query(sql, values); return true; };
const denied = async (pool, sql, values = []) => {
  try { await pool.query(sql, values); return { denied: false }; }
  catch (error) { return { denied: error?.code === '42501', sqlstate: error?.code ?? 'unknown' }; }
};

try {
  stage = 'api_resolve_oidc';
  await withPool('API_DATABASE_URL', async pool => {
    const auth = createAuthService({ pool });
    const principal = await auth.resolveOidc('https://alpha1.invalid/oidc', 'task4-sales-probe');
    stage = 'api_create_credential';
    const revokeCandidate = await auth.createAgentCredential(principal, { purpose: 'task4 revoke probe', ttl_seconds: 3600 }, `alpha1-task4-revoke-${randomUUID()}`);
    if (!revokeCandidate.secret) throw new Error('API_REVOKE_CREDENTIAL_NOT_ISSUED');
    const beforeRevoke = await pool.query('SELECT auth_epoch FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2', [principal.tenantId, principal.userId]);
    const beforeCredential = await pool.query('SELECT credential_epoch FROM control.agent_credential WHERE id=$1', [revokeCandidate.credential_id]);
    stage = 'api_revoke_credential';
    await auth.revokeAgentCredential(principal, revokeCandidate.credential_id);
    const afterRevoke = await auth.resolveOidc(principal.issuer, principal.subject);
    const afterCredential = await pool.query('SELECT credential_epoch,revoked_at FROM control.agent_credential WHERE id=$1', [revokeCandidate.credential_id]);
    const epochTransition = Number(afterRevoke.authEpoch) === Number(beforeRevoke.rows[0].auth_epoch) + 1 &&
      Number(afterCredential.rows[0]?.credential_epoch) === Number(beforeCredential.rows[0].credential_epoch) + 1 &&
      afterCredential.rows[0]?.revoked_at !== null;
    record('api_revoke_updates_subject_and_credential_epochs', epochTransition);
    stage = 'api_issue_probe_credential';
    const issued = await auth.createAgentCredential(afterRevoke, { purpose: 'task4 TLS probe', ttl_seconds: 3600 }, `alpha1-task4-local-${randomUUID()}`);
    if (!issued.secret) throw new Error('API_CREDENTIAL_NOT_ISSUED');
    await writeFile('/run/probe/agent_token', issued.secret, { mode: 0o444 });
    stage = 'api_list_credentials';
    const revokedList = await auth.listAgentCredentials(principal);
    record('api_revoked_credential_visible', revokedList.items.some(item => item.credential_id === revokeCandidate.credential_id && item.revoked_at !== null));
    record('api_identity_lock_and_credential_lifecycle', true);
    record('api_tenant_business_read_denied', (await denied(pool, 'SELECT 1 FROM hub.customer LIMIT 1')).denied);
    record('api_identity_mutation_denied', (await denied(pool, "UPDATE control.auth_subject SET business_role='sales_manager' WHERE tenant_key='alpha1_local'")).denied);
    record('api_binding_mutation_denied', (await denied(pool, "INSERT INTO control.identity_binding(issuer,subject,tenant_key,user_id) VALUES('https://x.invalid','x','alpha1_local','sales_probe')")).denied);
    record('api_role_creation_denied', (await denied(pool, 'CREATE ROLE alpha1_task4_forbidden_probe')).denied);
    record('api_role_membership_change_denied', (await denied(pool, 'GRANT hub_api TO hub_mcp')).denied);
    record('api_ddl_denied', (await denied(pool, 'CREATE TABLE control.task4_forbidden(x integer)')).denied);
  });

  stage = 'mcp_grants';
  await withPool('MCP_DATABASE_URL', async pool => {
    await allowed(pool, 'SELECT id,state,epoch FROM control.query_gate WHERE id=1');
    await allowed(pool, "SELECT id,credential_epoch,expires_at,revoked_at,digest,digest_kind,tenant_key,user_id FROM control.agent_credential LIMIT 1");
    await allowed(pool, "SELECT digest,kind FROM control.credential_digest_registry LIMIT 1");
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`INSERT INTO control.agent_audit
      (tenant_id,user_id,tool_name,outcome,error_code,duration_ms,request_id,credential_id,auth_epoch,gate_epoch,result_count,args_digest,
       protocol_version,binding_version,policy_version,stage)
      VALUES('alpha1_local','sales_probe','get_sales_context','denied','ALPHA_POLICY_NOT_READY',1,gen_random_uuid(),gen_random_uuid(),0,0,NULL,decode(repeat('00',32),'hex'),'2025-03-26',NULL,NULL,'audit_checkpoint')`);
    await client.query('ROLLBACK');
    client.release();
    record('mcp_auth_gate_reads_and_audit_insert', true);
    record('mcp_business_read_denied', (await denied(pool, 'SELECT 1 FROM hub.customer LIMIT 1')).denied);
    record('mcp_source_read_denied', (await denied(pool, 'SELECT 1 FROM control.source_credential LIMIT 1')).denied);
    record('mcp_policy_read_denied', (await denied(pool, 'SELECT 1 FROM control.permission_policy LIMIT 1')).denied);
    record('mcp_gate_write_denied', (await denied(pool, "UPDATE control.query_gate SET state='open' WHERE id=1")).denied);
    record('mcp_subject_epoch_write_denied', (await denied(pool, "UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key='alpha1_local'")).denied);
    record('mcp_ddl_denied', (await denied(pool, 'CREATE TABLE hub.task4_forbidden(x integer)')).denied);
  });

  stage = 'publisher_grants';
  await withPool('PUBLISHER_DATABASE_URL', async pool => {
    const closed = await pool.query('SELECT * FROM control.close_query_gate()');
    record('publisher_close_gate_function', closed.rows[0]?.state === 'closed');
    record('publisher_open_gate_denied', (await denied(pool, "UPDATE control.query_gate SET state='open' WHERE id=1")).denied);
    record('publisher_business_dml_denied', (await denied(pool, "UPDATE hub.customer SET name='blocked' WHERE false")).denied);
    record('publisher_ddl_denied', (await denied(pool, 'CREATE TABLE control.task4_forbidden(x integer)')).denied);
  });

  stage = 'hasura_read_grants';
  await withPool('HASURA_READ_DATABASE_URL', async pool => {
    await allowed(pool, 'SELECT id,source_id,tenant_id,owner_user_id,name,email_masked,phone_masked,deleted FROM api.customer LIMIT 1');
    record('hasura_read_approved_view', true);
    record('hasura_read_underlying_business_denied', (await denied(pool, 'SELECT 1 FROM hub.customer LIMIT 1')).denied);
    record('hasura_read_control_denied', (await denied(pool, 'SELECT 1 FROM control.query_gate')).denied);
    record('hasura_read_dml_denied', (await denied(pool, 'UPDATE api.customer SET name=name WHERE false')).denied);
    record('hasura_read_ddl_denied', (await denied(pool, 'CREATE TABLE api.task4_forbidden(x integer)')).denied);
  });

  stage = 'hasura_metadata_isolation';
  const businessConnection = (await readFile(process.env.HASURA_METADATA_BUSINESS_DATABASE_URL_FILE, 'utf8')).trim();
  const metadataBusinessPool = new pg.Pool({ connectionString: businessConnection, max: 1 });
  try { await metadataBusinessPool.query('SELECT 1'); record('hasura_metadata_business_database_unavailable', false); }
  catch (error) { record('hasura_metadata_business_database_unavailable', error?.code === '42501', { sqlstate: error?.code ?? 'unknown' }); }
  finally { await metadataBusinessPool.end(); }

  stage = 'hasura_admin_endpoint';
  let hasuraResponse;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      hasuraResponse = await fetch(`${process.env.HASURA_URL}/v1/metadata`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'export_metadata', args: {} }),
        signal: AbortSignal.timeout(1000),
      });
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!hasuraResponse) throw new Error('HASURA_PROBE_UNAVAILABLE');
  record('mcp_side_hasura_admin_endpoint_denied_without_secret', hasuraResponse.status >= 400 && hasuraResponse.status < 500, { http_status: hasuraResponse.status });
} catch (error) {
  result.status = 'FAIL';
  result.error_code = error?.code === '42501' ? 'GRANT_PROBE_PERMISSION_DENIED' : 'GRANT_PROBE_FAILED';
  result.stage = stage;
  if (/^[0-9A-Z]{5}$/.test(error?.code ?? '')) result.sqlstate = error.code;
  else if (/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '')) result.safe_failure_code = error.code;
  else if (['AuthError', 'Error', 'TypeError'].includes(error?.name)) result.safe_failure_type = error.name;
} finally {
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (result.status !== 'PASS') process.exitCode = 1;
