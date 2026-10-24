import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { createAuthService } from '../../dist/auth/service.js';

const mode = process.argv[2];
const result = { status: 'PASS', checks: [] };
let stage = 'initialization';
const record = (name, pass) => {
  result.checks.push({ name, status: pass ? 'PASS' : 'FAIL' });
  if (!pass) result.status = 'FAIL';
};
const withPool = async (environmentKey, callback) => {
  const connectionString = (await readFile(process.env[`${environmentKey}_FILE`], 'utf8')).trim();
  const pool = new pg.Pool({ connectionString, max: 2 });
  try { return await callback(pool); } finally { await pool.end(); }
};

try {
  if (mode === 'prepare') {
    let active;
    let revoke;
    await withPool('API_DATABASE_URL', async pool => {
      const auth = createAuthService({ pool });
      const principal = await auth.resolveOidc('https://alpha1.invalid/oidc', 'task4-sales-probe');
      stage = 'issue_distinct_credentials';
      revoke = await auth.createAgentCredential(principal, { purpose: 'task4 revoke sequence B', ttl_seconds: 3600 }, `alpha1-task4-sequence-b-${Date.now()}`);
      active = await auth.createAgentCredential(principal, { purpose: 'task4 active sequence A', ttl_seconds: 3600 }, `alpha1-task4-sequence-a-${Date.now()}`);
      if (!revoke.secret || !active.secret) throw new Error('CREDENTIAL_ISSUE_FAILED');
      await writeFile('/run/probe/agent_token', active.secret, { mode: 0o444 });
      await writeFile('/run/probe/revoked_agent_token', revoke.secret, { mode: 0o444 });
      await writeFile('/run/probe/revoke-sequence-ids.json', JSON.stringify({
        tenantId: principal.tenantId,
        userId: principal.userId,
        issuer: principal.issuer,
        subject: principal.subject,
        activeCredentialId: active.credential_id,
        revokeCredentialId: revoke.credential_id,
      }), { mode: 0o444 });
      record('distinct_active_and_revoke_credentials_issued', active.credential_id !== revoke.credential_id);
    });
    stage = 'authenticate_before_revoke_as_mcp';
    await withPool('MCP_DATABASE_URL', async pool => {
      const auth = createAuthService({ pool });
      const activePrincipal = await auth.authenticateAgent(active.secret);
      const revokePrincipal = await auth.authenticateAgent(revoke.secret);
      record('active_a_authenticates_before_b_revoke', activePrincipal.credentialId === active.credential_id);
      record('candidate_b_authenticates_before_revoke', revokePrincipal.credentialId === revoke.credential_id);
    });
  } else if (mode === 'revoke') {
    const ids = JSON.parse(await readFile('/run/probe/revoke-sequence-ids.json', 'utf8'));
    await withPool('API_DATABASE_URL', async pool => {
      const auth = createAuthService({ pool });
      const principal = await auth.resolveOidc(ids.issuer, ids.subject);
      const before = await pool.query('SELECT auth_epoch FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2', [ids.tenantId, ids.userId]);
      const credentialBefore = await pool.query('SELECT credential_epoch FROM control.agent_credential WHERE id=$1', [ids.revokeCredentialId]);
      stage = 'revoke_distinct_credential_b';
      await auth.revokeAgentCredential(principal, ids.revokeCredentialId);
      const current = await auth.resolveOidc(ids.issuer, ids.subject);
      const credentialAfter = await pool.query('SELECT credential_epoch,revoked_at FROM control.agent_credential WHERE id=$1', [ids.revokeCredentialId]);
      record('revoking_b_increments_subject_and_b_epochs', Number(current.authEpoch) === Number(before.rows[0].auth_epoch) + 1 &&
        Number(credentialAfter.rows[0]?.credential_epoch) === Number(credentialBefore.rows[0]?.credential_epoch) + 1 && credentialAfter.rows[0]?.revoked_at !== null);
    });
    stage = 'authenticate_after_revoke_as_mcp';
    await withPool('MCP_DATABASE_URL', async pool => {
      const auth = createAuthService({ pool });
      const active = await auth.authenticateAgent((await readFile('/run/probe/agent_token', 'utf8')).trim());
      record('new_request_token_a_authenticates_with_current_subject_epoch', active.credentialId === ids.activeCredentialId);
      let revokedCode = 'UNEXPECTED_SUCCESS';
      try { await auth.authenticateAgent((await readFile('/run/probe/revoked_agent_token', 'utf8')).trim()); }
      catch (error) { revokedCode = error?.code ?? 'UNKNOWN'; }
      record('token_b_rejected_after_revoke', revokedCode === 'AUTH_REVOKED');
    });
  } else {
    throw new Error('CREDENTIAL_SEQUENCE_MODE_INVALID');
  }
} catch (error) {
  result.status = 'FAIL';
  result.error_code = 'CREDENTIAL_SEQUENCE_FAILED';
  result.stage = stage;
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '')) result.safe_failure_code = error.code;
  else if (['AuthError', 'Error', 'TypeError'].includes(error?.name)) result.safe_failure_type = error.name;
}
process.stdout.write(JSON.stringify(result) + '\n');
if (result.status !== 'PASS') process.exitCode = 1;
