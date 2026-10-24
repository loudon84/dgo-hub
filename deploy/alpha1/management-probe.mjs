import { readFile } from 'node:fs/promises';
import { request } from 'node:https';

const ca = await readFile(process.env.MANAGEMENT_CA_FILE);
const port = Number(process.env.MANAGEMENT_PORT);
const get = path => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', servername: 'management.local', port, method: 'GET', path, ca, rejectUnauthorized: true }, response => {
    response.resume();
    response.on('end', () => resolve(response.statusCode ?? 0));
  });
  req.on('error', reject);
  req.setTimeout(5000, () => req.destroy(new Error('management probe timeout')));
  req.end();
});

const checks = [];
let status = 'PASS';
let stage = 'initialization';
const record = (name, pass, httpStatus) => {
  checks.push({ name, status: pass ? 'PASS' : 'FAIL', http_status: httpStatus });
  if (!pass) status = 'FAIL';
};
try {
  stage = 'management_tls_health';
  const health = await get('/health');
  record('management_tls_reaches_api_listener', health === 200, health);
  stage = 'management_oidc_gate';
  const identity = await get('/hub/v1/me');
  record('management_identity_requires_oidc', identity === 401, identity);
  stage = 'management_route_absence';
  const admin = await get('/admin/');
  record('management_admin_route_absent', admin === 404, admin);
} catch (error) {
  status = 'FAIL';
  checks.push({ name: 'management_probe_completed', status: 'FAIL', code: 'MANAGEMENT_TLS_PROBE_FAILED', stage, safe_failure_code: error?.code ?? 'unknown' });
}
process.stdout.write(JSON.stringify({ status, checks }) + '\n');
if (status !== 'PASS') process.exitCode = 1;
