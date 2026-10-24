import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { createServer as plainServer } from 'node:http';
import { request } from 'node:https';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { certificateRejection, probeTcp } from './probe-transport.mjs';

// Regressions: wrong TCP destination accepted as hostname proof; TLS EPROTO
// accepted as network isolation despite a reachable plaintext listener.
test('live TLS negatives classify certificates and reachable plaintext fails isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpha1-probe-control-'));
  const run = (command, args, env) => new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  const keyEnv = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH };
  const issued = await run('pwsh', ['-NoProfile', '-File', 'deploy/alpha1/New-LocalCertificates.ps1', '-CertificateDirectory', directory], keyEnv);
  assert.equal(issued.code, 0, 'fresh certificate issuance');
  const server = createServer({ key: await readFile(join(directory, 'leaf-key.pem')), cert: await readFile(join(directory, 'leaf.pem')) }, (req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
    });
  });
  server.on('tlsClientError', () => {});
  const plaintext = plainServer((req, res) => res.end('control'));
  let accepted = 0;
  plaintext.on('connection', () => { accepted++; });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => plaintext.listen(0, '127.0.0.1', resolve));
    const caBytes = await readFile(join(directory, 'ca.pem'));
    const trusted = await new Promise((resolve, reject) => {
      const verified = request({ hostname: '127.0.0.1', port: server.address().port, ca: caBytes, method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      verified.on('error', reject); verified.end();
    });
    assert.equal(trusted, 200);
    console.log(JSON.stringify({ trusted_ca_correct_identity_status: trusted }));
    const old = await new Promise(resolve => {
      const req = request({ hostname: '127.0.0.1', port: plaintext.address().port, timeout: 1500 }, response => { response.resume(); resolve({ reachable: true }); });
      req.on('error', error => resolve({ reachable: false, code: error.code }));
      req.on('timeout', () => { req.destroy(); resolve({ reachable: false, code: 'TIMEOUT' }); });
      req.end();
    });
    console.log(JSON.stringify({ old_algorithm: old, old_false_isolation_pass: !old.reachable, plaintext_connections_accepted: accepted }));
    assert.equal(old.reachable, false);
    assert.equal(old.code, 'EPROTO');
    assert.ok(accepted > 0);
    await writeFile(join(directory, 'token'), 'synthetic-probe-control');
    await writeFile(join(directory, 'targets.json'), JSON.stringify([{ name: 'control', host: '127.0.0.1', port: plaintext.address().port }]));
    const result = await run(process.execPath, ['deploy/alpha1/sales-probe.mjs'], {
      ...keyEnv, SALES_URL: `https://127.0.0.1:${server.address().port}`,
      SALES_CA_FILE: join(directory, 'ca.pem'), SALES_TOKEN_FILE: join(directory, 'token'),
      SALES_NETWORK_TARGETS_FILE: join(directory, 'targets.json'),
    });
    const report = JSON.parse(result.stdout.trim());
    console.log(JSON.stringify({ child_exit: result.code, checks: report.checks, plaintext_connections_accepted: accepted }));
    const wrong = report.checks.find(row => row.name === 'wrong_hostname_rejected');
    assert.equal(wrong?.status, 'PASS');
    assert.equal(wrong?.reason, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(wrong?.layer, 'certificate_hostname');
    const ca = report.checks.find(row => row.name === 'untrusted_ca_rejected');
    assert.equal(ca?.status, 'PASS');
    assert.equal(ca?.layer, 'certificate_trust');
    const control = report.checks.find(row => row.name === 'sales_network_control_not_reachable');
    assert.equal(control?.status, 'FAIL', 'any TCP connection must fail isolation');
    assert.equal(control?.reason, 'TCP_CONNECTED');
    assert.ok(accepted > 0);
    assert.equal(result.code, 1);
  } finally {
    server.closeAllConnections(); plaintext.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => plaintext.close(resolve));
    await rm(directory, { recursive: true });
  }
});

test('refusal is network denial and cannot satisfy either certificate negative', async () => {
  const listener = plainServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const result = await probeTcp('127.0.0.1', port);
  assert.deepEqual(result, { reachable: false, reason: 'ECONNREFUSED', layer: 'tcp_refused' });
  const send = () => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port }, response => { response.resume(); resolve(); });
    req.on('error', reject); req.end();
  });
  for (const kind of ['hostname', 'trust']) {
    assert.deepEqual(await certificateRejection(send, kind), { pass: false, reason: 'ECONNREFUSED', layer: 'unexpected_failure' });
  }
});
