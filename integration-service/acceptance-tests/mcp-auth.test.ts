import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jwtVerify, generateKeyPair, SignJWT } from 'jose';
import { createAuthService } from '../auth/service.js';
import type { AgentPrincipal, AuthService, UserPrincipal } from '../auth/types.js';
import { runMigrations } from '../migrations/runner.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { createMcpApp, type AlphaReadinessResolver, type McpServerOptions, type SalesQueryExecutor } from '../sales-mcp/server.js';
import { createHasuraQueryExecutor } from '../sales-mcp/queries.js';
import { buildApp } from '../app.js';
import { Writable } from 'node:stream';
import { createHubLoggerOptions } from '../ingestion-api/logging.js';
import { readHubRuntimeConfiguration } from '../contracts/runtime-config.js';
import { preparePermissionPublisher } from '../permission-publish/worker.js';
import { resolveWorkerSources } from '../etl-worker/worker.js';

const evidenceDirectory = join(fileURLToPath(new URL('../../docs/execution/alpha1/m0-task-3-evidence/', import.meta.url)), randomUUID());
const lifecycleFile = join(evidenceDirectory, 'postgres-lifecycle.jsonl');
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const signingSecret = Buffer.alloc(32, 17).toString('base64url');
const ready: AlphaReadinessResolver = async () => ({ ready: true, reason: 'READY', bindingVersion: 'binding-test-v1', policyVersion: 'policy-test-v1' });

let fixture: OwnedPostgres;
let authService: AuthService;
let app: Awaited<ReturnType<typeof createMcpApp>> | undefined;
let baseUrl: string;
let agent: AgentPrincipal;
let user: UserPrincipal;
let credential: string;
let queryCalls = 0;
let queryExecutor: SalesQueryExecutor;

async function createUser(userId = 'alice', role: 'sales' | 'sales_manager' = 'sales', departmentId: string | null = 'west'): Promise<UserPrincipal> {
  await authService.repository.provisionTenant({ tenantId: 't01', businessTimezone: 'Asia/Shanghai' });
  await authService.repository.provisionSubject({ tenantId: 't01', userId, departmentId, businessRole: role });
  const issuer = 'https://issuer.example.test';
  const subject = `${userId}-subject`;
  await authService.repository.bindIdentity({ issuer, subject, tenantId: 't01', userId });
  return authService.resolveOidc(issuer, subject);
}

async function makeCredential(principal: UserPrincipal, suffix = randomUUID()): Promise<{ secret: string; agent: AgentPrincipal }> {
  const created = await authService.createAgentCredential(principal, { purpose: 'MCP acceptance' }, `mcp-${suffix}`);
  if (!created.secret) throw new Error('test credential was not created');
  return { secret: created.secret, agent: await authService.authenticateAgent(created.secret) };
}

async function request(method: string, body: unknown, token = credential, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp/sales`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json, text/event-stream', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function rpc(method: string, id: number, params: unknown = {}) {
  return { jsonrpc: '2.0', id, method, params };
}
async function initialize(token = credential) {
  return request('POST', rpc('initialize', 1, {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-acceptance', version: '1' },
  }), token);
}
async function callTool(name: string, args: Record<string, unknown> = {}, token = credential) {
  return request('POST', rpc('tools/call', 2, { name, arguments: args }), token, { 'mcp-protocol-version': '2025-03-26' });
}

function createApp(options: Partial<McpServerOptions> = {}) {
  return createMcpApp({
    authService,
    pool: fixture.pool,
    queryExecutor,
    readinessResolver: ready,
    logger: false,
    ...options,
  });
}

describe('strict sales MCP authentication and audit boundary', () => {
  beforeAll(async () => {
    await mkdir(evidenceDirectory, { recursive: true });
    fixture = await startOwnedPostgres({ evidenceFile: lifecycleFile, taskLabel: 'task3' });
    await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
    authService = createAuthService({ pool: fixture.pool });
    user = await createUser();
    ({ secret: credential, agent } = await makeCredential(user));
    queryExecutor = async () => { queryCalls += 1; return { customer: [{ id: 'safe-row' }] }; };
    app = createApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('MCP test server failed to bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    await fixture.pool.query("UPDATE control.query_gate SET state='open',epoch=epoch+1 WHERE id=1");
  }, 90_000);

  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.close();
  }, 90_000);

  it('requires personal opaque Bearer auth before MCP protocol work', async () => {
    const legacyAbsent = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(legacyAbsent.status).toBe(404);
    const missing = await request('POST', rpc('initialize', 1), '');
    expect(missing.status).toBe(401);
    const malformed = await request('POST', rpc('initialize', 1), 'not-a-personal-token');
    expect(malformed.status).toBe(401);
    const body = await malformed.text();
    expect(body).not.toContain('not-a-personal-token');
    const keyPair = await generateKeyPair('RS256', { modulusLength: 2048 });
    const managementJwt = await new SignJWT({ tenant_id: 'forged', role: 'sales_manager' }).setProtectedHeader({ alg: 'RS256', kid: 'management-key' })
      .setIssuer('https://management.example.test').setAudience('hub-api').setSubject('alice').setIssuedAt().setExpirationTime('60s').sign(keyPair.privateKey);
    const wrongFamily = await request('POST', rpc('initialize', 2), managementJwt);
    expect(wrongFamily.status).toBe(401);
    expect(queryCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });

  it('keeps present invalid Origin at 403 and accepts absent or exact allowed Origin', async () => {
    let authCalls = 0;
    const countedAuth = { ...authService, authenticateAgent: async (value: string) => { authCalls += 1; return authService.authenticateAgent(value); } };
    const originApp = createApp({ authService: countedAuth, allowedOrigins: ['https://hermes.example.test'], logger: false });
    await originApp.listen({ host: '127.0.0.1', port: 0 });
    const address = originApp.server.address();
    if (!address || typeof address === 'string') throw new Error('Origin test server failed to bind');
    const url = `http://127.0.0.1:${address.port}/mcp/sales`;
    try {
      const bad = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(rpc('initialize', 1)) });
      expect(bad.status).toBe(403);
      expect(authCalls).toBe(0);
      expect(queryCalls).toBe(0);
      const badGet = await fetch(url, { method: 'GET', headers: { origin: 'https://evil.example', authorization: `Bearer ${credential}` } });
      expect(badGet.status).toBe(403);
      expect(authCalls).toBe(0);
      const allowed = await fetch(url, { method: 'POST', headers: { origin: 'https://hermes.example.test', authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('initialize', 1)) });
      expect(allowed.status).toBe(200);
      const absent = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('initialize', 1)) });
      expect(absent.status).toBe(200);
    } finally { await originApp.close(); }
  });

  it('advertises exactly five fixed tools and audits all five as not ready by default', async () => {
    const strictApp = createMcpApp({ authService, pool: fixture.pool, queryExecutor, logger: false });
    await strictApp.listen({ host: '127.0.0.1', port: 0 });
    const address = strictApp.server.address();
    if (!address || typeof address === 'string') throw new Error('strict server failed to bind');
    const url = `http://127.0.0.1:${address.port}/mcp/sales`;
    try {
      const listed = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/list', 1)) });
      expect(listed.status).toBe(200);
      const listBody = await listed.json() as { result?: { tools?: { name: string }[] } };
      expect(listBody.result?.tools?.map(item => item.name).sort()).toEqual([
        'find_customers', 'get_customer_orders', 'get_order_detail', 'get_sales_context', 'get_sales_summary',
      ]);
      for (const name of ['get_sales_context','find_customers','get_customer_orders','get_order_detail','get_sales_summary']) {
        const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify(rpc('tools/call', 2, { name, arguments: name === 'find_customers' ? { term: 'x' } : name === 'get_customer_orders' ? { customerId: '95f92b46-ec8a-43ba-ad39-39595ac65a29' } : name === 'get_order_detail' ? { orderId: '95f92b46-ec8a-43ba-ad39-39595ac65a29' } : {} })) });
        expect(response.status).toBe(200);
        const result = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
        expect(result.result?.isError).toBe(true);
        expect(result.result?.content?.[0]?.text).toContain('ALPHA_POLICY_NOT_READY');
      }
      expect(queryCalls).toBe(0);
      const audits = await fixture.pool.query("SELECT count(*)::int AS n FROM control.agent_audit WHERE tool_name IN ('get_sales_context','find_customers','get_customer_orders','get_order_detail','get_sales_summary') AND error_code='ALPHA_POLICY_NOT_READY'");
      expect(audits.rows[0].n).toBe(5);
      const safeAudit = await fixture.pool.query("SELECT request_id,credential_id,auth_epoch,gate_epoch,result_count,octet_length(args_digest)::int AS digest_bytes FROM control.agent_audit WHERE tool_name='find_customers' AND error_code='ALPHA_POLICY_NOT_READY' ORDER BY id DESC LIMIT 1");
      expect(safeAudit.rows[0]).toMatchObject({ credential_id: agent.credentialId, auth_epoch: agent.authEpoch, gate_epoch: expect.any(String), result_count: null, digest_bytes: 32 });
      expect(safeAudit.rows[0].request_id).toBeTruthy();
    } finally { await strictApp.close(); }
  });

  it('derives signed Hasura claims from the verified principal with the pinned audience and TTL', async () => {
    let capturedToken = '';
    const executor = createHasuraQueryExecutor({ url: 'https://hasura.example.test', jwtSecret: signingSecret }, async (_url, init) => {
      capturedToken = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      return new Response(JSON.stringify({ data: { customer: [{ id: 'x' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await executor({ principal: agent, name: 'find_customers', variables: { term: '%safe%', limit: 10 } });
    const { payload, protectedHeader } = await jwtVerify(capturedToken, Buffer.from(signingSecret), { audience: 'hasura-sales', subject: 'alice' });
    const claims = payload['https://hasura.io/jwt/claims'] as Record<string, unknown>;
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(claims['x-hasura-allowed-roles']).toEqual(['hub_t01_sales']);
    expect(claims['x-hasura-default-role']).toBe('hub_t01_sales');
    expect(claims['x-hasura-tenant-id']).toBe('t01');
    expect(claims['x-hasura-user-id']).toBe('alice');
    expect(claims.role).toBeUndefined();
  });

  it('discards query data after credential revocation and lets another live credential make a fresh request', async () => {
    let entered!: () => void;
    let release!: () => void;
    const insideQuery = new Promise<void>(resolve => { entered = resolve; });
    const queryBarrier = new Promise<void>(resolve => { release = resolve; });
    const delayed: SalesQueryExecutor = async () => { entered(); await queryBarrier; return { customer: [{ id: 'must-not-escape' }] }; };
    const active = await makeCredential(user);
    const queryApp = createApp({ queryExecutor: delayed });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('query barrier server failed to bind');
    const url = `http://127.0.0.1:${address.port}/mcp/sales`;
    try {
      const pending = fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 3, { name: 'find_customers', arguments: { term: 'secret-result' } })) });
      await insideQuery;
      await authService.revokeAgentCredential(user, agent.credentialId);
      release();
      const response = await pending;
      const result = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUTH_CONTEXT_CHANGED');
      expect(JSON.stringify(result)).not.toContain('must-not-escape');
      credential = active.secret;
      agent = active.agent;
      const freshApp = createApp({ queryExecutor: async () => ({ customer: [{ id: 'fresh-request-row' }] }) });
      await freshApp.listen({ host: '127.0.0.1', port: 0 });
      const freshAddress = freshApp.server.address();
      if (!freshAddress || typeof freshAddress === 'string') throw new Error('fresh request server failed to bind');
      const fresh = await fetch(`http://127.0.0.1:${freshAddress.port}/mcp/sales`, { method: 'POST', headers: { authorization: `Bearer ${active.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 4, { name: 'find_customers', arguments: { term: 'safe' } })) });
      try {
        expect(fresh.status).toBe(200);
        const freshResult = await fresh.json() as { result?: { isError?: boolean } };
        expect(freshResult.result?.isError).toBeUndefined();
      } finally { await freshApp.close(); }
    } finally { release(); await queryApp.close(); }
  });

  it('rechecks authorization after durable audit and returns no data when the audit write overlaps revocation', async () => {
    let auditEntered!: () => void;
    let finishAudit!: () => void;
    const insideAudit = new Promise<void>(resolve => { auditEntered = resolve; });
    const auditBarrier = new Promise<void>(resolve => { finishAudit = resolve; });
    const auditPool = {
      query: async (...args: Parameters<typeof fixture.pool.query>) => {
        const result = await fixture.pool.query(...args);
        if (String(args[0]).includes('INSERT INTO control.agent_audit')) { auditEntered(); await auditBarrier; }
        return result;
      },
    } as unknown as typeof fixture.pool;
    const queryApp = createApp({ pool: auditPool, queryExecutor: async () => ({ customer: [{ id: 'audit-race-row' }] }) });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('audit barrier server failed to bind');
    const url = `http://127.0.0.1:${address.port}/mcp/sales`;
    const active = await makeCredential(user);
    try {
      const pending = fetch(url, { method: 'POST', headers: { authorization: `Bearer ${active.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 5, { name: 'find_customers', arguments: { term: 'safe' } })) });
      await insideAudit;
      await authService.revokeAgentCredential(user, active.agent.credentialId);
      finishAudit();
      const result = await (await pending).json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUTH_CONTEXT_CHANGED');
      expect(JSON.stringify(result)).not.toContain('audit-race-row');
      const auditEvents = await fixture.pool.query("SELECT request_id::text AS request_id,stage,outcome,error_code,result_count FROM control.agent_audit WHERE credential_id=$1 AND tool_name='find_customers' ORDER BY id", [active.agent.credentialId]);
      expect(auditEvents.rows).toHaveLength(2);
      expect(auditEvents.rows[0]).toMatchObject({ stage: 'audit_checkpoint', outcome: 'success', result_count: 1 });
      expect(auditEvents.rows[1]).toMatchObject({ stage: 'return_check', outcome: 'denied', error_code: 'AUTH_CONTEXT_CHANGED', result_count: null });
      expect(auditEvents.rows[1].request_id).toBe(auditEvents.rows[0].request_id);
    } finally { finishAudit(); await queryApp.close(); }
  });

  it('returns AUDIT_UNAVAILABLE and no query data if the final denial event cannot be appended', async () => {
    let auditEntered!: () => void;
    let finishAudit!: () => void;
    const insideAudit = new Promise<void>(resolve => { auditEntered = resolve; });
    const auditBarrier = new Promise<void>(resolve => { finishAudit = resolve; });
    const active = await makeCredential(user);
    const auditPool = {
      query: async (...args: Parameters<typeof fixture.pool.query>) => {
        if (String(args[0]).includes('INSERT INTO control.agent_audit') && args[1]?.[15] === 'return_check') throw new Error('audit unavailable');
        const result = await fixture.pool.query(...args);
        if (String(args[0]).includes('INSERT INTO control.agent_audit')) { auditEntered(); await auditBarrier; }
        return result;
      },
    } as unknown as typeof fixture.pool;
    const queryApp = createApp({ pool: auditPool, queryExecutor: async () => ({ customer: [{ id: 'final-audit-failure-row' }] }) });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('final audit failure server failed to bind');
    try {
      const pending = fetch(`http://127.0.0.1:${address.port}/mcp/sales`, { method: 'POST', headers: { authorization: `Bearer ${active.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 11, { name: 'find_customers', arguments: { term: 'safe' } })) });
      await insideAudit;
      await authService.revokeAgentCredential(user, active.agent.credentialId);
      finishAudit();
      const result = await (await pending).json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUDIT_UNAVAILABLE');
      expect(JSON.stringify(result)).not.toContain('final-audit-failure-row');
    } finally { finishAudit(); await queryApp.close(); }
  });

  it('discards a query result when the gate epoch changes during execution', async () => {
    let entered!: () => void;
    let release!: () => void;
    const insideQuery = new Promise<void>(resolve => { entered = resolve; });
    const queryBarrier = new Promise<void>(resolve => { release = resolve; });
    const queryApp = createApp({ queryExecutor: async () => { entered(); await queryBarrier; return { customer: [{ id: 'gate-race-row' }] }; } });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('gate barrier server failed to bind');
    try {
      const pending = fetch(`http://127.0.0.1:${address.port}/mcp/sales`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 8, { name: 'find_customers', arguments: { term: 'safe' } })) });
      await insideQuery;
      await fixture.pool.query("UPDATE control.query_gate SET epoch=epoch+1,changed_at=now() WHERE id=1");
      release();
      const result = await (await pending).json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUTH_CONTEXT_CHANGED');
      expect(JSON.stringify(result)).not.toContain('gate-race-row');
    } finally { release(); await queryApp.close(); }
  });

  it('discards a query result when the credential expires while the query is in flight', async () => {
    let now = new Date();
    const expiringAuth = createAuthService({ pool: fixture.pool, clock: () => now });
    let entered!: () => void;
    let release!: () => void;
    const insideQuery = new Promise<void>(resolve => { entered = resolve; });
    const queryBarrier = new Promise<void>(resolve => { release = resolve; });
    const queryApp = createApp({ authService: expiringAuth, queryExecutor: async () => { entered(); await queryBarrier; return { customer: [{ id: 'expired-race-row' }] }; } });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('expiry barrier server failed to bind');
    try {
      const pending = fetch(`http://127.0.0.1:${address.port}/mcp/sales`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 9, { name: 'find_customers', arguments: { term: 'safe' } })) });
      await insideQuery;
      now = new Date(Date.now() + 3_700_000);
      release();
      const result = await (await pending).json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUTH_EXPIRED');
      expect(JSON.stringify(result)).not.toContain('expired-race-row');
    } finally { release(); await queryApp.close(); }
  });

  it('returns AUDIT_UNAVAILABLE without business data when durable audit fails', async () => {
    const failedAuditPool = {
      query: (...args: Parameters<typeof fixture.pool.query>) => {
        if (String(args[0]).includes('INSERT INTO control.agent_audit')) throw new Error('private storage detail');
        return fixture.pool.query(...args);
      },
    } as unknown as typeof fixture.pool;
    const queryApp = createApp({ pool: failedAuditPool, queryExecutor: async () => ({ customer: [{ id: 'audit-failure-row' }] }) });
    await queryApp.listen({ host: '127.0.0.1', port: 0 });
    const address = queryApp.server.address();
    if (!address || typeof address === 'string') throw new Error('audit failure server failed to bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp/sales`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('tools/call', 6, { name: 'find_customers', arguments: { term: 'safe' } })) });
    try {
      const result = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content?.[0]?.text).toContain('AUDIT_UNAVAILABLE');
      expect(JSON.stringify(result)).not.toContain('audit-failure-row');
      expect(JSON.stringify(result)).not.toContain('private storage detail');
    } finally { await queryApp.close(); }
  });

  it('keeps raw request, credential, argument, and result values out of logs and audit', async () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
    const logApp = createApp({
      logger: createHubLoggerOptions(stream),
      queryExecutor: async () => ({ customer: [{ id: 'raw-result-sentinel' }] }),
    });
    await logApp.listen({ host: '127.0.0.1', port: 0 });
    const address = logApp.server.address();
    if (!address || typeof address === 'string') throw new Error('logger test server failed to bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp/sales?raw-path-sentinel=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(rpc('tools/call', 7, { name: 'find_customers', arguments: { term: 'raw-argument-sentinel' } })),
    });
    try {
      expect(response.status).toBe(200);
      await response.text();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(output).not.toContain(credential);
      expect(output).not.toContain('raw-argument-sentinel');
      expect(output).not.toContain('raw-result-sentinel');
      expect(output).not.toContain('raw-path-sentinel');
      const eventLines = output.split('\n').filter(Boolean).map(line => JSON.parse(line) as { reqId?: string });
      const requestId = eventLines.find(line => line.reqId)?.reqId;
      expect(requestId).toBeTruthy();
      const audit = await fixture.pool.query('SELECT request_id::text AS request_id, args_digest FROM control.agent_audit WHERE request_id=$1', [requestId]);
      expect(audit.rowCount).toBe(1);
      expect(Buffer.isBuffer(audit.rows[0].args_digest)).toBe(true);
      expect(audit.rows[0].args_digest.toString()).not.toContain('raw-argument-sentinel');
    } finally { await logApp.close(); }
  });

  it('rejects forged tool identity fields and manager credentials without a department', async () => {
    const forged = await callTool('get_sales_context', { tenantId: 'other', userId: 'root', businessRole: 'sales_manager' });
    expect(forged.status).toBe(200);
    const forgedBody = await forged.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(forgedBody.result?.isError).toBe(true);
    expect(JSON.stringify(forgedBody)).not.toContain('root');
    const manager = await createUser('manager', 'sales_manager', null);
    await expect(makeCredential(manager)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN', status: 403 });
  });

  it('restores the old /mcp demo route only for explicit local_lab legacy configuration', async () => {
    const runtime = readHubRuntimeConfiguration({ HUB_ENVIRONMENT_KIND: 'local_lab', HUB_ENABLE_LEGACY_LAB: 'true' });
    const legacySecret = 'legacy-demo-secret-for-mcp-tests';
    const legacyJwt = await new SignJWT({ tenant_id: 't01', role: 'sales_reader' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('data-hub').setAudience('sales-mcp').setSubject('alice').setIssuedAt().setExpirationTime('60s')
      .sign(new TextEncoder().encode(legacySecret));
    const legacyApp = createApp({
      runtime,
      legacyMcp: {
        agentJwtSecret: legacySecret, issuer: 'data-hub', audience: 'sales-mcp',
        hasura: { url: 'https://hasura.example.test', jwtSecret: signingSecret },
      },
    });
    await legacyApp.listen({ host: '127.0.0.1', port: 0 });
    const address = legacyApp.server.address();
    if (!address || typeof address === 'string') throw new Error('legacy lab server failed to bind');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${legacyJwt}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(rpc('tools/call', 10, { name: 'get_sales_context', arguments: {} })),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { result?: { isError?: boolean; structuredContent?: { data?: { scope?: { role?: string } } } } };
      expect(result.result?.isError).toBeUndefined();
      expect(result.result?.structuredContent?.data?.scope?.role).toBe('sales_reader');
      const rejected = createApp({ runtime: readHubRuntimeConfiguration({}), legacyMcp: {
        agentJwtSecret: legacySecret, issuer: 'data-hub', audience: 'sales-mcp', hasura: { url: 'https://hasura.example.test', jwtSecret: signingSecret },
      } });
      await rejected.listen({ host: '127.0.0.1', port: 0 });
      try {
        const otherAddress = rejected.server.address();
        if (!otherAddress || typeof otherAddress === 'string') throw new Error('strict MCP server failed to bind');
        expect((await fetch(`http://127.0.0.1:${otherAddress.port}/mcp`, { method: 'POST' })).status).toBe(404);
      } finally { await rejected.close(); }
    } finally { await legacyApp.close(); }
  });
});

describe('strict transition route and worker guards', () => {
  it('keeps legacy API routes absent by default and available only when explicitly selected', async () => {
    const strict = await buildApp({ logger: false });
    const absentIngest = await strict.inject({ method: 'POST', url: '/v1/ingest/customer', payload: {} });
    const absentAdmin = await strict.inject({ method: 'GET', url: '/admin/ingestion/events' });
    expect(absentIngest.statusCode).toBe(404);
    expect(absentAdmin.statusCode).toBe(404);
    await strict.close();
    const labRuntime = readHubRuntimeConfiguration({ HUB_ENVIRONMENT_KIND: 'local_lab', HUB_ENABLE_LEGACY_LAB: 'true' });
    const lab = await buildApp({ runtime: labRuntime, logger: false });
    const presentIngest = await lab.inject({ method: 'POST', url: '/v1/ingest/customer', payload: {} });
    expect(presentIngest.statusCode).toBe(401);
    await lab.close();
  });

  it('requires explicit local_lab selection for legacy flags and demo source scans', async () => {
    expect(readHubRuntimeConfiguration({})).toMatchObject({ environmentKind: 'site', legacyLabEnabled: false, mcpAllowedOrigins: [] });
    expect(() => readHubRuntimeConfiguration({ HUB_ENVIRONMENT_KIND: 'site', HUB_ENABLE_LEGACY_LAB: 'true' })).toThrow('RUNTIME_CONFIG_INVALID');
    expect(() => readHubRuntimeConfiguration({ HUB_ENABLE_LEGACY_LAB: 'yes' })).toThrow('RUNTIME_CONFIG_INVALID');
    expect(() => readHubRuntimeConfiguration({ HUB_MCP_ALLOWED_ORIGINS: '*' })).toThrow('RUNTIME_CONFIG_INVALID');
    expect(() => readHubRuntimeConfiguration({ HUB_MCP_ALLOWED_ORIGINS: 'https://example.test/path' })).toThrow('RUNTIME_CONFIG_INVALID');
    const runtime = readHubRuntimeConfiguration({ HUB_ENVIRONMENT_KIND: 'local_lab', HUB_ENABLE_LEGACY_LAB: 'true' });
    expect(resolveWorkerSources({ CRM_DB_URL: 'postgres://demo' } as NodeJS.ProcessEnv, runtime)).toHaveLength(1);
    expect(resolveWorkerSources({ CRM_DB_URL: 'postgres://demo' } as NodeJS.ProcessEnv, readHubRuntimeConfiguration({}))).toHaveLength(0);
  });

  it('makes strict permission publisher close the gate without running the legacy bootstrap', async () => {
    const runtime = readHubRuntimeConfiguration({});
    const closeGate = vi.fn(async () => undefined);
    const bootstrap = vi.fn(async () => undefined);
    const status = await preparePermissionPublisher(runtime, closeGate, bootstrap);
    expect(status).toBe('not_ready');
    expect(closeGate).toHaveBeenCalledOnce();
    expect(bootstrap).not.toHaveBeenCalled();
  });
});
