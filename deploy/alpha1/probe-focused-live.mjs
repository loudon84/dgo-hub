// Bounded transport verification against owned live services, no business calls.
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { certificateRejection, probeTcp } from './probe-transport.mjs';

const [mode, targetFile, caFile] = process.argv.slice(2);
const targets = JSON.parse(await readFile(targetFile, 'utf8'));
const checks = [];
const record = (name, pass, detail = {}) => checks.push({ ...detail, name, status: pass ? 'PASS' : 'FAIL' });
const http = (host, port, path) => new Promise((resolve, reject) => {
  const req = httpRequest({ host, port, path }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.setTimeout(3000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))); req.end();
});
try {
  if (mode === 'allowed') {
    for (const target of targets) {
      const result = await probeTcp(target.host, target.port);
      record(`allowed_${target.name}`, result.reachable, { ...target, ...result });
    }
    record('api_actual_health', await http('api', 3000, '/health') === 200);
    record('mcp_actual_unauthenticated_boundary', await http('mcp', 3001, '/mcp/sales') === 401);
    record('hasura_actual_health', await http('hasura', 8080, '/healthz') === 200);
  } else if (mode === 'sales') {
    const ca = await readFile(caFile);
    const send = (servername = 'sales.local', trusted = true) => new Promise((resolve, reject) => {
      const req = httpsRequest({ hostname: 'sales.local', servername, port: 443, method: 'POST', path: '/mcp/sales', ca: trusted ? ca : undefined }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.setTimeout(3000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))); req.end();
    });
    record('trusted_ca_correct_hostname_live_mcp', await send() === 401, { tcp_target: 'sales.local:443', servername: 'sales.local' });
    for (const [name, kind, servername, trusted] of [
      ['wrong_hostname', 'hostname', 'wrong.local', true],
      ['untrusted_ca', 'trust', 'sales.local', false],
    ]) {
      const { pass, ...result } = await certificateRejection(() => send(servername, trusted), kind);
      record(name, pass, { ...result, tcp_target: 'sales.local:443', servername });
    }
    for (const target of targets) {
      const result = await probeTcp(target.host, target.port);
      record(`sales_deny_${target.name}`, !result.reachable && ['tcp_refused', 'tcp_timeout', 'network_unreachable'].includes(result.layer), { ...target, ...result });
    }
    // DNS isolation is separately observed; direct IP denial above carries proof.
    for (const [host, port] of [['db', 5432], ['api', 3000], ['mcp', 3001], ['hasura', 8080]]) {
      const result = await probeTcp(host, port);
      checks.push({ name: `sales_dns_observation_${host}`, status: 'INFO', host, port, ...result });
    }
    checks.push({ name: 'publisher_no_m0_listener', status: 'INFO', reason: 'NO_M0_LISTENER', network_proof: false });
  } else { throw Object.assign(new Error('invalid mode'), { code: 'PROBE_MODE_INVALID' }); }
} catch (error) { record('completed', false, { reason: error.code ?? 'UNEXPECTED_ERROR' }); }
const status = checks.every(row => row.status !== 'FAIL') ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ mode, status, checks }));
if (status !== 'PASS') process.exitCode = 1;
