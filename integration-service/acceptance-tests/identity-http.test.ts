import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, generateSecret, SignJWT } from 'jose';
import { createAuthService } from '../auth/service.js';
import { buildApp } from '../app.js';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import { createOidcAuthenticator, readOidcConfiguration, type OidcConfiguration } from '../auth/oidc.js';
import { registerIdentityRoutes } from '../ingestion-api/identity-routes.js';
import { createHubLoggerOptions } from '../ingestion-api/logging.js';
import { runMigrations } from '../migrations/runner.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceDirectory = fileURLToPath(new URL('../../docs/execution/alpha1/m0-task-2-evidence/', import.meta.url));
const evidenceFile = join(evidenceDirectory, 'postgres-lifecycle.jsonl');
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const audience = 'hub-api';
const NOW = Math.floor(Date.now() / 1000);

type LocalHttpServer = { server: Server; url: string; close(): Promise<void> };
type SigningKey = { kid: string; alg: 'RS256' | 'ES256'; privateKey: CryptoKey; jwk: Record<string, unknown> };
type TokenOptions = {
  subject?: string | null;
  tokenIssuer?: string | null;
  tokenAudience?: string | string[] | null;
  expiration?: number | null;
  notBefore?: number;
  header?: Record<string, unknown>;
  forgedClaims?: Record<string, unknown>;
};

async function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<LocalHttpServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local test server failed to bind');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

let fixture: OwnedPostgres;
let authService: AuthService;
let app: FastifyInstance | undefined;
let mainServer: LocalHttpServer;
let secondServer: LocalHttpServer;
let rsa: SigningKey;
let ec: SigningKey;
let jwksHits = 0;
let redirectedHits = 0;
let jwksDocument: { keys: Record<string, unknown>[] };
let logOutput = '';

async function createSigningKey(alg: SigningKey['alg'], kid: string): Promise<SigningKey> {
  const pair = alg === 'RS256'
    ? await generateKeyPair('RS256', { modulusLength: 2048 })
    : await generateKeyPair('ES256');
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    jwk: { ...await exportJWK(pair.publicKey), kid, alg, use: 'sig' },
  };
}

function configuration(jwksUrl = `${mainServer.url}/jwks`): OidcConfiguration {
  return {
    issuer: `${mainServer.url}/issuer`,
    audience,
    jwksUrl,
    environmentKind: 'local_lab',
    allowLoopbackHttp: true,
  };
}

async function token(key: SigningKey, options: TokenOptions = {}): Promise<string> {
  const claims = {
    tenant_id: 'forged_tenant',
    user_id: 'forged-user',
    department_id: 'forged-department',
    business_role: 'sales_manager',
    management_scopes: ['agent:revoke'],
    ...options.forgedClaims,
  };
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT', ...options.header });
  if (options.tokenIssuer !== null) jwt = jwt.setIssuer(options.tokenIssuer ?? `${mainServer.url}/issuer`);
  if (options.tokenAudience !== null) jwt = jwt.setAudience(options.tokenAudience ?? audience);
  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? 'alice-sub');
  if (options.expiration !== null) jwt = jwt.setExpirationTime(options.expiration ?? NOW + 300);
  if (options.notBefore !== undefined) jwt = jwt.setNotBefore(options.notBefore);
  return jwt.setIssuedAt(NOW).sign(key.privateKey);
}

async function principal(input: { tenantId?: string; userId?: string; subject?: string; businessRole?: 'sales' | 'sales_manager' | null; departmentId?: string | null; managementScopes?: ('agent:revoke' | 'ops:read')[] } = {}): Promise<UserPrincipal> {
  const tenantId = input.tenantId ?? 't01';
  const userId = input.userId ?? 'alice';
  const subject = input.subject ?? `${userId}-sub`;
  const selectedIssuer = `${mainServer.url}/issuer`;
  await authService.repository.provisionTenant({ tenantId, businessTimezone: 'Asia/Shanghai' });
  await authService.repository.provisionSubject({
    tenantId,
    userId,
    businessRole: input.businessRole === undefined ? 'sales' : input.businessRole,
    departmentId: input.departmentId === undefined ? 'sales-east' : input.departmentId,
    managementScopes: input.managementScopes ?? [],
  });
  await authService.repository.bindIdentity({ issuer: selectedIssuer, subject, tenantId, userId });
  return authService.resolveOidc(selectedIssuer, subject);
}

async function identityApp(options: { service?: AuthService; logger?: boolean } = {}): Promise<FastifyInstance> {
  const service = options.service ?? authService;
  const authenticator = createOidcAuthenticator(configuration(), service);
  const output = new Writable({ write(chunk, _encoding, callback) { logOutput += String(chunk); callback(); } });
  const server = Fastify({ logger: options.logger === false ? false : createHubLoggerOptions(output), bodyLimit: 2 * 1024 * 1024, requestIdHeader: false });
  await registerIdentityRoutes(server, { authenticator, authService: service });
  return server;
}

function bearer(value: string): Record<string, string> { return { authorization: `Bearer ${value}` }; }
function responseJson(response: { body: string }): Record<string, any> { return JSON.parse(response.body) as Record<string, any>; }
function unsignedToken(alg: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg, typ: 'JWT' })}.${encode({ iss: `${mainServer.url}/issuer`, aud: audience, sub: 'alice-sub', exp: NOW + 300 })}.`;
}

beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidenceFile, '', 'utf8');
  fixture = await startOwnedPostgres({ evidenceFile, taskLabel: 'task2' });
  await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  authService = createAuthService({ pool: fixture.pool });
  rsa = await createSigningKey('RS256', 'rsa-primary');
  ec = await createSigningKey('ES256', 'ec-primary');
  jwksDocument = { keys: [rsa.jwk, ec.jwk] };
  secondServer = await listen((_request, response) => { redirectedHits += 1; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwksDocument)); });
  mainServer = await listen((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `${secondServer.url}/jwks` }).end();
      return;
    }
    jwksHits += 1;
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(jwksDocument));
  });
  // Issuer URLs are selected from the listener after binding. Fixtures use this exact value.
}, 120_000);

afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
});

afterAll(async () => {
  if (mainServer) await mainServer.close();
  if (secondServer) await secondServer.close();
  if (!fixture) return;
  const resource = {
    taskLabel: fixture.taskLabel,
    runLabel: fixture.runLabel,
    containerId: fixture.containerId,
    imageReference: fixture.imageReference,
    repoDigest: fixture.repoDigest,
    runtimeImageId: fixture.runtimeImageId,
    hostPort: fixture.hostPort,
  };
  await fixture.close();
  await writeFile(join(evidenceDirectory, 'postgres-resource-summary.json'), `${JSON.stringify({ ...resource, cleanup: 'confirmed removed by exact owned container ID' }, null, 2)}\n`, 'utf8');
});

beforeEach(async () => {
  logOutput = '';
  jwksHits = 0;
  redirectedHits = 0;
  await fixture.pool.query(`TRUNCATE control.agent_credential_idempotency, control.agent_credential,
    control.source_credential, control.identity_binding, control.auth_subject, control.tenant,
    control.credential_digest_registry CASCADE`);
});

describe('M0 Task2 OIDC and current identity APIs', () => {
  it('imports an injectable app factory without starting a listener', () => {
    expect(typeof buildApp).toBe('function');
  });
  it('loads only complete controlled configuration and rejects site HTTP or permissive fallbacks', () => {
    expect(() => readOidcConfiguration({} as NodeJS.ProcessEnv)).toThrow('AUTH_CONFIG_INVALID');
    expect(() => readOidcConfiguration({ HUB_AUTH_ISSUER: 'http://issuer.test', HUB_AUTH_AUDIENCE: audience, HUB_AUTH_JWKS_URL: 'https://keys.test/jwks' } as NodeJS.ProcessEnv)).toThrow('AUTH_CONFIG_INVALID');
    expect(() => readOidcConfiguration({ HUB_ENVIRONMENT_KIND: 'site', HUB_AUTH_ALLOW_LOOPBACK_HTTP: 'true', HUB_AUTH_ISSUER: 'https://issuer.test', HUB_AUTH_AUDIENCE: audience, HUB_AUTH_JWKS_URL: 'https://keys.test/jwks' } as NodeJS.ProcessEnv)).toThrow('AUTH_CONFIG_INVALID');
    expect(readOidcConfiguration({ HUB_ENVIRONMENT_KIND: 'local_lab', HUB_AUTH_ALLOW_LOOPBACK_HTTP: 'true', HUB_AUTH_ISSUER: 'http://127.0.0.1/issuer', HUB_AUTH_AUDIENCE: audience, HUB_AUTH_JWKS_URL: 'http://localhost/jwks' } as NodeJS.ProcessEnv)).toMatchObject({ environmentKind: 'local_lab', allowLoopbackHttp: true });
    expect(() => readOidcConfiguration({ HUB_ENVIRONMENT_KIND: 'local_lab', HUB_AUTH_ALLOW_LOOPBACK_HTTP: 'true', HUB_AUTH_ISSUER: 'http://remote.test/issuer', HUB_AUTH_AUDIENCE: audience, HUB_AUTH_JWKS_URL: 'http://remote.test/jwks' } as NodeJS.ProcessEnv)).toThrow('AUTH_CONFIG_INVALID');
    expect(() => readOidcConfiguration({ HUB_ENVIRONMENT_KIND: 'maybe', HUB_AUTH_ISSUER: 'https://issuer.test', HUB_AUTH_AUDIENCE: audience, HUB_AUTH_JWKS_URL: 'https://keys.test/jwks' } as NodeJS.ProcessEnv)).toThrow('AUTH_CONFIG_INVALID');
  });

  it('verifies RS256 and ES256 then resolves only issuer/subject facts from the database', async () => {
    const alice = await principal({ subject: 'alice-sub' });
    const authenticator = createOidcAuthenticator(configuration(), authService);
    for (const key of [rsa, ec]) {
      await expect(authenticator(await token(key))).resolves.toMatchObject({
        userId: alice.userId, tenantId: alice.tenantId, businessRole: 'sales', departmentId: 'sales-east',
        managementScopes: [], businessTimezone: 'Asia/Shanghai', issuer: `${mainServer.url}/issuer`, subject: 'alice-sub',
      });
    }
  });

  it('rejects invalid signatures, unknown keys, claims, times, required claims, and unapproved algorithms', async () => {
    await principal({ subject: 'alice-sub' });
    const authenticator = createOidcAuthenticator(configuration(), authService);
    const good = await token(rsa);
    const pieces = good.split('.');
    pieces[2] = `${pieces[2].startsWith('a') ? 'b' : 'a'}${pieces[2].slice(1)}`;
    const invalidSignature = pieces.join('.');
    const unknownKid = await token({ ...rsa, kid: 'unknown-kid' });
    const wrongIssuer = await token(rsa, { tokenIssuer: 'https://attacker.invalid' });
    const wrongAudience = await token(rsa, { tokenAudience: 'another-api' });
    const expired = await token(rsa, { expiration: NOW - 1 });
    const future = await token(rsa, { notBefore: NOW + 60 });
    const missingExpiration = await token(rsa, { expiration: null });
    const missingIssuer = await token(rsa, { tokenIssuer: null });
    const missingAudience = await token(rsa, { tokenAudience: null });
    const missingSubject = await token(rsa, { subject: null });
    const oversizedSubject = await token(rsa, { subject: 's'.repeat(2049) });
    const hsKey = await generateSecret('HS256');
    const hs = await new SignJWT({ iss: `${mainServer.url}/issuer`, aud: audience, sub: 'alice-sub', exp: NOW + 300 }).setProtectedHeader({ alg: 'HS256' }).sign(hsKey);
    const failures = [invalidSignature, unknownKid, wrongIssuer, wrongAudience, expired, future, missingExpiration, missingIssuer, missingAudience, missingSubject, oversizedSubject, hs, unsignedToken('none')];
    for (const [index, candidate] of failures.entries()) {
      try { await authenticator(candidate); throw new Error(`invalid token case ${index} unexpectedly accepted`); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('invalid token case ')) throw error;
        expect(error).toBeInstanceOf(AuthError);
        expect(error).toMatchObject({ status: 401 });
      }
    }
  });

  it('rejects hostile jku and x5u without fetching their URLs, and blocks configured JWKS redirects', async () => {
    const authenticator = createOidcAuthenticator(configuration(), authService);
    const baseline = jwksHits;
    await expect(authenticator(await token(rsa, { header: { jku: `${secondServer.url}/attacker-jwks` } }))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(authenticator(await token(rsa, { header: { x5u: `${secondServer.url}/attacker-cert` } }))).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(jwksHits).toBe(baseline);
    expect(redirectedHits).toBe(0);

    const redirecting = createOidcAuthenticator(configuration(`${mainServer.url}/redirect`), authService);
    await expect(redirecting(await token(rsa))).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE', status: 503 });
    expect(redirectedHits).toBe(0);
  });

  it('maps verified but unmapped or disabled subjects to stable safe authentication errors', async () => {
    const authenticator = createOidcAuthenticator(configuration(), authService);
    await expect(authenticator(await token(rsa, { subject: 'missing-sub' }))).rejects.toMatchObject({ code: 'PRINCIPAL_MAPPING_MISSING', status: 401 });
    await principal({ subject: 'disabled-sub' });
    await authService.repository.setIdentityBinding(`${mainServer.url}/issuer`, 'disabled-sub', false);
    await expect(authenticator(await token(rsa, { subject: 'disabled-sub' }))).rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 401 });
  });

  it('does not resolve identity or enter business storage for invalid tokens', async () => {
    const resolveOidc = vi.fn(authService.resolveOidc);
    const authenticator = createOidcAuthenticator(configuration(), { resolveOidc });
    await expect(authenticator('not-a-jwt')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(resolveOidc).not.toHaveBeenCalled();
    const count = await fixture.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM control.agent_credential');
    expect(count.rows[0].count).toBe('0');
  });

  it('returns the Appendix A.1 envelope with a safe DB-bound current-user whitelist', async () => {
    const alice = await principal({ subject: 'alice-sub' });
    app = await identityApp();
    const result = await app.inject({ method: 'GET', url: '/hub/v1/me', headers: bearer(await token(rsa)) });
    expect(result.statusCode).toBe(200);
    const body = responseJson(result);
    expect(body).toMatchObject({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), data: {
      user_id: alice.userId, tenant_id: alice.tenantId, department_id: 'sales-east', business_role: 'sales',
      management_scopes: [], business_timezone: 'Asia/Shanghai',
    } });
    expect(JSON.stringify(body)).not.toContain('forged');
    expect(body.data).not.toHaveProperty('issuer');
    expect(body.data).not.toHaveProperty('subject');
    expect(body.data).not.toHaveProperty('authEpoch');
  });

  it('creates personal credentials once, omits replay secrets, rejects forged bodies, and redacts logs', async () => {
    const alice = await principal({ subject: 'alice-sub' });
    const jwt = await token(rsa);
    app = await identityApp();
    const first = await app.inject({
      method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'once-only', 'x-actor': 'forged-actor', 'request-id': 'untrusted-request-id-sentinel' },
      payload: { purpose: 'daily summary', ttl_seconds: 600 },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = responseJson(first);
    expect(firstBody.data).toMatchObject({ purpose: 'daily summary', replayed: false });
    expect(firstBody.data.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const oneTimeSecret = firstBody.data.secret as string;
    const replay = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'once-only' }, payload: { purpose: 'daily summary', ttl_seconds: 600 } });
    expect(replay.statusCode).toBe(201);
    expect(responseJson(replay).data).toMatchObject({ credential_id: firstBody.data.credential_id, replayed: true });
    expect(responseJson(replay).data).not.toHaveProperty('secret');
    const conflict = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'once-only' }, payload: { purpose: 'different' } });
    expect(conflict.statusCode).toBe(409);
    expect(responseJson(conflict).error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false, details: {} });
    const forged = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'forged-body' }, payload: { purpose: 'bad', tenantId: 'other', userId: 'bob', role: 'sales_manager', scopes: ['agent:revoke'] } });
    expect(forged.statusCode).toBe(422);
    const missingKey = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: bearer(jwt), payload: { purpose: 'bad' } });
    expect(missingKey.statusCode).toBe(422);
    const malformedJson = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'malformed', 'content-type': 'application/json' }, payload: '{"purpose":' });
    expect(malformedJson.statusCode).toBe(422);
    expect(responseJson(malformedJson).error).toMatchObject({ code: 'AUTH_INPUT_INVALID', details: {} });
    const credentials = await authService.listAgentCredentials(alice, { limit: 100 });
    expect(credentials.items).toHaveLength(1);
    expect(JSON.stringify(credentials)).not.toContain(oneTimeSecret);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(logOutput).not.toContain(jwt);
    expect(logOutput).not.toContain(oneTimeSecret);
    expect(logOutput).not.toContain('untrusted-request-id-sentinel');
    expect((createHubLoggerOptions() as unknown as { redact: { paths: string[] } }).redact).toMatchObject({ paths: expect.arrayContaining([
      'req.headers.authorization', 'req.headers.cookie', 'req.headers.x-source-key',
    ]) });
  });

  it('lists only the current user metadata with stable pagination and strict query parameters', async () => {
    const alice = await principal({ subject: 'alice-sub' });
    const jwt = await token(rsa);
    for (const [purpose, key] of [['one', 'p1'], ['two', 'p2'], ['three', 'p3']] as const) {
      await authService.createAgentCredential(alice, { purpose }, key);
    }
    const bob = await principal({ userId: 'bob', subject: 'bob-sub' });
    const bobCredential = await authService.createAgentCredential(bob, { purpose: 'bob private' }, 'bob-idem');
    app = await identityApp();
    const first = await app.inject({ method: 'GET', url: '/hub/v1/me/agent-credentials?limit=1', headers: bearer(jwt) });
    expect(first.statusCode).toBe(200);
    expect(responseJson(first).data.items).toHaveLength(1);
    const cursor = responseJson(first).data.next_cursor as string;
    const second = await app.inject({ method: 'GET', url: `/hub/v1/me/agent-credentials?limit=1&cursor=${cursor}`, headers: bearer(jwt) });
    expect(responseJson(second).data.items[0].credential_id).not.toBe(responseJson(first).data.items[0].credential_id);
    const all = await app.inject({ method: 'GET', url: '/hub/v1/me/agent-credentials', headers: bearer(jwt) });
    expect(responseJson(all).data.items).toHaveLength(3);
    expect(JSON.stringify(responseJson(all))).not.toContain('secret');
    expect(JSON.stringify(responseJson(all))).not.toContain('bob private');
    expect(JSON.stringify(responseJson(all))).not.toContain(bobCredential.credential_id);
    for (const query of ['?limit=0', '?limit=101', '?limit=NaN', '?cursor=not-a-uuid', '?tenantId=t02', '?userId=bob']) {
      const invalid = await app.inject({ method: 'GET', url: `/hub/v1/me/agent-credentials${query}`, headers: bearer(jwt) });
      expect(invalid.statusCode).toBe(422);
      expect(responseJson(invalid).error).toMatchObject({ code: 'AUTH_INPUT_INVALID', retryable: false });
    }
  });

  it('keeps delete response indistinguishable for missing and cross-user ids, then revokes own token', async () => {
    const alice = await principal({ subject: 'alice-sub' });
    const bob = await principal({ userId: 'bob', subject: 'bob-sub' });
    const outside = await principal({ tenantId: 't02', userId: 'outside', subject: 'outside-sub' });
    const admin = await principal({ userId: 'admin', subject: 'admin-sub', managementScopes: ['agent:revoke'] });
    const aliceCredential = await authService.createAgentCredential(alice, { purpose: 'own' }, 'own-key');
    const bobCredential = await authService.createAgentCredential(bob, { purpose: 'other' }, 'other-key');
    const outsideCredential = await authService.createAgentCredential(outside, { purpose: 'outside' }, 'outside-key');
    app = await identityApp();
    const jwt = await token(rsa);
    const headers = bearer(jwt);
    const unknown = await app.inject({ method: 'DELETE', url: '/hub/v1/me/agent-credentials/00000000-0000-4000-8000-000000000000', headers });
    const crossTenant = await app.inject({ method: 'DELETE', url: `/hub/v1/me/agent-credentials/${bobCredential.credential_id}`, headers });
    expect(unknown.statusCode).toBe(204);
    expect(unknown.body).toBe('');
    expect(crossTenant.statusCode).toBe(204);
    expect(crossTenant.body).toBe('');
    await expect(authService.authenticateAgent(bobCredential.secret!)).resolves.toMatchObject({ credentialId: bobCredential.credential_id });
    const outsideDelete = await app.inject({ method: 'DELETE', url: `/hub/v1/me/agent-credentials/${outsideCredential.credential_id}`, headers });
    expect(outsideDelete.statusCode).toBe(204);
    await expect(authService.authenticateAgent(outsideCredential.secret!)).resolves.toMatchObject({ credentialId: outsideCredential.credential_id });
    const adminDelete = await app.inject({ method: 'DELETE', url: `/hub/v1/me/agent-credentials/${bobCredential.credential_id}`, headers: bearer(await token(rsa, { subject: admin.subject })) });
    expect(adminDelete.statusCode).toBe(204);
    await expect(authService.authenticateAgent(bobCredential.secret!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    const own = await app.inject({ method: 'DELETE', url: `/hub/v1/me/agent-credentials/${aliceCredential.credential_id}`, headers });
    expect(own.statusCode).toBe(204);
    await expect(authService.authenticateAgent(aliceCredential.secret!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
  });

  it('allows management-only identity reads but does not turn a management scope into business credential authority', async () => {
    await principal({ userId: 'ops', subject: 'ops-sub', businessRole: null, departmentId: null, managementScopes: ['ops:read'] });
    const jwt = await token(rsa, { subject: 'ops-sub' });
    app = await identityApp();
    const me = await app.inject({ method: 'GET', url: '/hub/v1/me', headers: bearer(jwt) });
    expect(me.statusCode).toBe(200);
    expect(responseJson(me).data).toMatchObject({ business_role: null, management_scopes: ['ops:read'] });
    const create = await app.inject({ method: 'POST', url: '/hub/v1/me/agent-credentials', headers: { ...bearer(jwt), 'idempotency-key': 'cannot-self-grant' }, payload: { purpose: 'no business role' } });
    expect(create.statusCode).toBe(403);
    expect(responseJson(create).error).toMatchObject({ code: 'AUTH_FORBIDDEN', retryable: false });
  });

  it('uses standard safe envelopes for missing or invalid bearer authentication', async () => {
    app = await identityApp();
    for (const authorization of [undefined, 'Basic dXNlcjpwYXNz', 'Bearer malformed']) {
      const result = await app.inject({ method: 'GET', url: '/hub/v1/me', ...(authorization ? { headers: { authorization } } : {}) });
      expect(result.statusCode).toBe(401);
      const body = responseJson(result);
      expect(body).toMatchObject({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/), error: { code: 'AUTH_INVALID', message: 'AUTH_INVALID', retryable: false, details: {} } });
      expect(JSON.stringify(body)).not.toContain('malformed');
    }
    const absent = await app.inject({ method: 'GET', url: '/hub/v1/me/unknown' });
    expect(absent.statusCode).toBe(404);
    expect(responseJson(absent).error).toMatchObject({ code: 'NOT_FOUND', retryable: false, details: {} });
  });
});
