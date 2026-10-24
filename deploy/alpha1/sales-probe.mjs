import { readFile, writeFile } from 'node:fs/promises';
import { request as plainRequest } from 'node:http';
import { request } from 'node:https';

const endpoint = new URL(process.env.SALES_URL);
const ca = await readFile(process.env.SALES_CA_FILE);
const token = (await readFile(process.env.SALES_TOKEN_FILE, 'utf8')).trim();
const checks = [];
let status = 'PASS';
let stage = 'initialization';
const record = (name, pass, extra = {}) => {
  checks.push({ name, status: pass ? 'PASS' : 'FAIL', ...extra });
  if (!pass) status = 'FAIL';
};
const send = (method, path, body, options = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const host = options.host ?? endpoint.hostname;
  const req = request({
    hostname: options.connectHost ?? host, port: Number(endpoint.port), servername: host,
    path, method, ca: options.trusted === false ? undefined : ca,
    rejectUnauthorized: options.rejectUnauthorized !== false,
    headers: {
      host,
      ...(options.authorization ? { authorization: `Bearer ${token}` } : {}),
      ...(options.origin ? { origin: 'https://sales.local' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': payload.length }),
      ...(options.protocolVersion ? { 'mcp-protocol-version': '2025-03-26' } : {}),
      ...(options.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
    },
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.setTimeout(6000, () => req.destroy(new Error('probe timeout')));
  if (payload) req.write(payload);
  req.end();
});
const parseRpc = (body) => {
  try { return JSON.parse(body); } catch { }
  const data = body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).at(-1);
  if (!data) return undefined;
  try { return JSON.parse(data); } catch { return undefined; }
};

try {
  stage = 'tls_negative_checks';
  await send('GET', '/mcp/sales', undefined, { trusted: false }).then(() => record('untrusted_ca_rejected', false)).catch(() => record('untrusted_ca_rejected', true));
  await send('GET', '/mcp/sales', undefined, { host: 'wrong.local' }).then(() => record('wrong_hostname_rejected', false)).catch(() => record('wrong_hostname_rejected', true));
  await new Promise(resolve => {
    const req = plainRequest({ hostname: 'sales.local', port: 80, method: 'GET', path: '/mcp/sales', timeout: 1500 }, response => {
      response.resume(); resolve(false);
    });
    req.on('error', () => resolve(true));
    req.on('timeout', () => { req.destroy(); resolve(true); });
    req.end();
  }).then(pass => record('plain_http_denied', pass));
  const unauthenticated = await send('POST', '/mcp/sales', { jsonrpc: '2.0', id: 90, method: 'tools/list' }, { origin: true, protocolVersion: true });
  record('tls_entry_without_credential_401', unauthenticated.status === 401);

  stage = 'mcp_initialize';
  const initialize = await send('POST', '/mcp/sales', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'alpha1-task4-probe', version: '1.0.0' },
  } }, { authorization: true, origin: true, protocolVersion: true });
  const initRpc = parseRpc(initialize.body);
  record('trusted_tls_mcp_initialize', initialize.status === 200 && !!initRpc?.result?.serverInfo);
  const sessionId = initialize.headers['mcp-session-id'];
  const initialized = await send('POST', '/mcp/sales', { jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: true, origin: true, protocolVersion: true, sessionId });
  record('mcp_initialized_notification', initialized.status === 202 || initialized.status === 200);

  stage = 'mcp_list';
  const listed = await send('POST', '/mcp/sales', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: true, origin: true, protocolVersion: true, sessionId });
  const listRpc = parseRpc(listed.body);
  const names = (listRpc?.result?.tools ?? []).map(tool => tool.name).sort();
  record('exact_five_mcp_tools', listed.status === 200 && names.join(',') === ['find_customers','get_customer_orders','get_order_detail','get_sales_context','get_sales_summary'].sort().join(','));

  stage = 'mcp_context_not_ready';
  const called = await send('POST', '/mcp/sales', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_sales_context', arguments: {} } }, { authorization: true, origin: true, protocolVersion: true, sessionId });
  const callRpc = parseRpc(called.body);
  const text = callRpc?.result?.content?.find(item => item.type === 'text')?.text;
  let toolError;
  try { toolError = JSON.parse(text); } catch { }
  const correlated = typeof toolError?.request_id === 'string' && /^[0-9a-f-]{36}$/i.test(toolError.request_id);
  const notReady = ['QUERY_NOT_READY', 'ALPHA_POLICY_NOT_READY'].includes(toolError?.code);
  record('context_not_ready_with_server_request_id', called.status === 200 && callRpc?.result?.isError === true && notReady && correlated, { http_status: called.status, tool_error_code: toolError?.code ?? 'missing', correlated_request_id: correlated });
  if (correlated) await writeFile('/run/audit/mcp-request-id', toolError.request_id, { mode: 0o444, flag: 'wx' });

  stage = 'sales_route_absence';
  for (const [name, path] of [
    ['admin_route_absent', '/admin/'], ['management_route_absent', '/hub/v1/me'],
    ['ingest_route_absent', '/v1/ingest/customer'], ['hasura_route_absent', '/v1/graphql'],
  ]) {
    const response = await send('GET', path, undefined, { authorization: true, origin: true });
    record(name, response.status === 404);
  }

  stage = 'sales_network_isolation';
  for (const [host, port] of [['db', 5432], ['hasura', 8080], ['api', 3000], ['publisher', 3002], ['mcp', 3001]]) {
    const connect = await new Promise(resolve => {
      const socket = request({ hostname: host, port, method: 'GET', timeout: 1500 }, response => {
        response.resume(); resolve({ reachable: true });
      });
      socket.on('error', error => resolve({ reachable: false, code: error.code ?? 'ERROR' }));
      socket.on('timeout', () => { socket.destroy(); resolve({ reachable: false, code: 'TIMEOUT' }); });
      socket.end();
    });
    record(`sales_network_${host}_not_reachable`, !connect.reachable, { reason: connect.code ?? 'reachable' });
  }
} catch (error) {
  record('probe_completed', false, { code: 'SALES_NETWORK_PROBE_FAILED', stage, safe_failure_code: error?.code ?? 'unknown' });
}
process.stdout.write(JSON.stringify({ status, checks }) + '\n');
if (status !== 'PASS') process.exitCode = 1;
