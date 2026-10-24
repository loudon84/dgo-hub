import pg from 'pg';
import { readFile } from 'node:fs/promises';

const auditFiles = new Map([
  ['default', 'mcp-request-id'],
  ['revoke-sequence', 'revoke-sequence-request-id'],
]);
const auditFile = auditFiles.get(process.argv[2] ?? 'default');
if (!auditFile) throw new Error('AUDIT_EVIDENCE_MODE_INVALID');
const requestId = (await readFile(`/run/audit/${auditFile}`, 'utf8')).trim();
const connectionString = (await readFile(process.env.MIGRATOR_DATABASE_URL_FILE, 'utf8')).trim();
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const result = await pool.query(`SELECT request_id::text,tenant_id,user_id,tool_name,outcome,error_code,stage,result_count
    FROM control.agent_audit WHERE request_id=$1::uuid ORDER BY id`, [requestId]);
  const matching = result.rows.filter(row => row.tenant_id === 'alpha1_local' && row.user_id === 'sales_probe' &&
    row.tool_name === 'get_sales_context' && row.outcome === 'denied' && ['QUERY_NOT_READY', 'ALPHA_POLICY_NOT_READY'].includes(row.error_code) && row.stage === 'audit_checkpoint');
  const noResults = matching.every(row => row.result_count === null);
  const pass = result.rowCount >= 1 && matching.length === result.rowCount && noResults;
  process.stdout.write(JSON.stringify({ status: pass ? 'PASS' : 'FAIL', audit_rows: result.rowCount, request_id_correlated: true, result_count: null }) + '\n');
  if (!pass) process.exitCode = 1;
} catch {
  process.stderr.write('{"status":"FAIL","code":"AUDIT_EVIDENCE_CHECK_FAILED"}\n');
  process.exitCode = 1;
} finally { await pool.end(); }
