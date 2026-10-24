import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';

const mode = process.argv[2];
const endpoint = new URL(process.env.SALES_URL);
const ca = await readFile(process.env.SALES_CA_FILE);
const token = (await readFile(process.env.SALES_TOKEN_FILE, 'utf8')).trim();
const revokedToken = (await readFile('/run/probe/revoked_agent_token', 'utf8')).trim();
const checks = [];
let status = 'PASS';
let stage = 'initialization';
const record = (name, pass, details = {}) => {
  checks.push({ name, status: pass ? 'PASS' : 'FAIL', ...details });
  if (!pass) status = 'FAIL';
};
const send = (body, authorization, sessionId) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(body));
  const req = request({
    hostname: endpoint.hostname, port: Number(endpoint.port), servername: endpoint.hostname,
    path: '/mcp/sales', method: 'POST', ca, rejectUnauthorized: true,
    headers: {
      host: endpoint.hostname,
      authorization: `Bearer ${authorization}`,
      origin: 'https://sales.local',
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'content-length': payload.length, 'mcp-protocol-version': '2025-03-26',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.setTimeout(6000, () => req.destroy(new Error('probe timeout')));
  req.end(payload);
});
const parseRpc = body => {
  try { return JSON.parse(body); } catch { }
  const data = body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).at(-1);
  if (!data) return undefined;
  try { return JSON.parse(data); } catch { return undefined; }
};

try {
  if (mode === 'initialize') {
    stage = 'initialize_a_before_b_revoke';
    const response = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'alpha1-revoke-sequence', version: '1.0.0' },
    } }, token);
    const rpc = parseRpc(response.body);
    const sessionId = response.headers['mcp-session-id'];
    record('token_a_initializes_before_token_b_revoke', response.status === 200 && !!rpc?.result?.serverInfo, {
      http_status: response.status,
      rpc_error_code: rpc?.error?.code ?? null,
      server_info_present: !!rpc?.result?.serverInfo,
      session_header_present: typeof sessionId === 'string',
    });
    if (response.status === 200 && rpc?.result?.serverInfo) await writeFile('/run/audit/revoke-sequence-initialized', 'initialized', { mode: 0o444, flag: 'wx' });
  } else if (mode === 'post-revoke') {
    await readFile('/run/audit/revoke-sequence-initialized', 'utf8');
    stage = 'new_context_request_using_existing_a_session';
    const context = await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_sales_context', arguments: {} } }, token);
    const rpc = parseRpc(context.body);
    const errorText = rpc?.result?.content?.find(item => item.type === 'text')?.text;
    let toolError;
    try { toolError = JSON.parse(errorText); } catch { }
    const correlated = typeof toolError?.request_id === 'string' && /^[0-9a-f-]{36}$/i.test(toolError.request_id);
    const pass = context.status === 200 && rpc?.result?.isError === true && toolError?.code === 'QUERY_NOT_READY' && correlated;
    record('new_token_a_context_uses_current_epoch_closed_gate', pass, { http_status: context.status, tool_error_code: toolError?.code ?? 'missing', correlated_request_id: correlated });
    if (correlated) await writeFile('/run/audit/revoke-sequence-request-id', toolError.request_id, { mode: 0o444, flag: 'wx' });
    stage = 'new_http_request_using_revoked_b';
    const revoked = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, revokedToken);
    record('new_http_request_with_revoked_token_b_returns_401', revoked.status === 401, { http_status: revoked.status });
  } else {
    throw new Error('SALES_REVOKE_PROBE_MODE_INVALID');
  }
} catch (error) {
  status = 'FAIL';
  checks.push({ name: 'sales_revoke_probe_completed', status: 'FAIL', code: 'SALES_REVOKE_PROBE_FAILED', stage, safe_failure_code: error?.code ?? 'unknown' });
}
process.stdout.write(JSON.stringify({ status, checks }) + '\n');
if (status !== 'PASS') process.exitCode = 1;
