import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { AuthError } from '../auth/errors.js';
import type { AuthScope } from '../auth/types.js';
import { runMigrations } from '../migrations/runner.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceDirectory = fileURLToPath(new URL('../../docs/execution/alpha1/m0-task-1-evidence/round1/', import.meta.url));
const evidenceFile = join(evidenceDirectory, 'postgres-lifecycle.jsonl');
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
let fixture: OwnedPostgres;
let auth: ReturnType<typeof createAuthService>;
let currentTime = new Date('2026-10-23T00:00:00.000Z');
const clock = () => new Date(currentTime);
const issuer = 'https://idp.example.test';

async function resetIdentityRows(): Promise<void> {
  await fixture.pool.query(`TRUNCATE control.agent_credential_idempotency, control.agent_credential,
    control.source_credential, control.identity_binding, control.auth_subject, control.tenant,
    control.credential_digest_registry CASCADE`);
}

async function provisionUser(input: { tenantId?: string; userId?: string; sub?: string; role?: 'sales' | 'sales_manager' | null; departmentId?: string | null; scopes?: AuthScope[] } = {}) {
  const tenantId = input.tenantId ?? 't01';
  const userId = input.userId ?? 'alice';
  const subject = input.sub ?? userId;
  await auth.repository.provisionTenant({ tenantId, businessTimezone: 'Asia/Shanghai' });
  await auth.repository.provisionSubject({
    tenantId, userId, departmentId: input.departmentId === undefined ? 'sales-east' : input.departmentId,
    businessRole: input.role === undefined ? 'sales' : input.role, managementScopes: input.scopes ?? [],
  });
  await auth.repository.bindIdentity({ issuer, subject, tenantId, userId });
  return auth.resolveOidc(issuer, subject);
}

beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidenceFile, '', 'utf8');
  fixture = await startOwnedPostgres({ evidenceFile, taskLabel: 'task1' });
  await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  auth = createAuthService({ pool: fixture.pool, clock });
}, 90_000);

afterAll(async () => {
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
  currentTime = new Date('2026-10-23T00:00:00.000Z');
  await resetIdentityRows();
});

describe('Task1 identity and credential persistence', () => {
  it('applies 002 once and skips it on repeat while keeping migration 001 bytes intact', async () => {
    await expect(runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' }))
      .resolves.toEqual({ applied: [], skipped: ['001_init', '002_identity_auth'] });
    const tables = await fixture.pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='control' AND table_name IN ('tenant','auth_subject','identity_binding','agent_credential','source_credential','credential_digest_registry','agent_credential_idempotency')`,
    );
    expect(tables.rowCount).toBe(7);
  });

  it('stores only SHA256 of decoded 32-byte credentials and applies server TTL boundaries', async () => {
    const principal = await provisionUser();
    const result = await auth.createAgentCredential(principal, { purpose: 'daily brief' }, 'default-ttl');
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expires_at).toBe('2026-10-23T01:00:00.000Z');
    const decoded = Buffer.from(result.secret!, 'base64url');
    const digest = createHash('sha256').update(decoded).digest();
    const stored = await fixture.pool.query<{ digest: Buffer; kind: string }>(
      `SELECT d.digest,d.kind FROM control.agent_credential c
        JOIN control.credential_digest_registry d ON d.digest=c.digest WHERE c.id=$1`, [result.credential_id],
    );
    expect(stored.rows[0].digest).toEqual(digest);
    expect(stored.rows[0].kind).toBe('agent');
    expect(JSON.stringify(stored.rows)).not.toContain(result.secret);
    await expect(auth.createAgentCredential(principal, { purpose: 'too long', ttl_seconds: 86401 }, 'ttl-invalid'))
      .rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    await expect(auth.createAgentCredential(principal, { purpose: 'extra', tenantId: 'other' } as never, 'extra-field'))
      .rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    const short = await auth.createAgentCredential(principal, { purpose: 'short', ttl_seconds: 1 }, 'ttl-one');
    const max = await auth.createAgentCredential(principal, { purpose: 'max', ttl_seconds: 86400 }, 'ttl-max');
    expect(max.expires_at).toBe('2026-10-24T00:00:00.000Z');
    currentTime = new Date('2026-10-23T00:00:01.000Z');
    await expect(auth.authenticateAgent(short.secret!)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('returns the first secret once, replays safe metadata, conflicts on changed requests and serializes concurrent retries', async () => {
    const principal = await provisionUser();
    const first = await auth.createAgentCredential(principal, { purpose: 'agent', ttl_seconds: 600 }, 'same-key');
    const replay = await auth.createAgentCredential(principal, { purpose: ' agent ', ttl_seconds: 600 }, 'same-key');
    expect(replay).toMatchObject({ credential_id: first.credential_id, expires_at: first.expires_at, secret: null, replayed: true });
    await expect(auth.createAgentCredential(principal, { purpose: 'different', ttl_seconds: 600 }, 'same-key'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    const concurrent = await Promise.all([
      auth.createAgentCredential(principal, { purpose: 'concurrent' }, 'parallel-key'),
      auth.createAgentCredential(principal, { purpose: 'concurrent' }, 'parallel-key'),
    ]);
    expect(new Set(concurrent.map(result => result.credential_id)).size).toBe(1);
    expect(concurrent.filter(result => result.secret !== null)).toHaveLength(1);
    expect(concurrent.filter(result => result.replayed)).toHaveLength(1);
    const count = await fixture.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM control.agent_credential');
    expect(count.rows[0].count).toBe('2');
  });

  it('lists only current user metadata with stable anchors and rejects forged or cross-user cursors', async () => {
    const alice = await provisionUser();
    for (const [purpose, key] of [['one', 'page-1'], ['two', 'page-2'], ['three', 'page-3']] as const) {
      await auth.createAgentCredential(alice, { purpose }, key);
    }
    const bob = await provisionUser({ userId: 'bob', sub: 'bob' });
    const bobToken = await auth.createAgentCredential(bob, { purpose: 'bob-only' }, 'bob-key');
    const otherTenant = await provisionUser({ tenantId: 't02', userId: 'carol', sub: 'carol' });
    const otherTenantToken = await auth.createAgentCredential(otherTenant, { purpose: 'other-tenant' }, 'other-tenant-key');
    const first = await auth.listAgentCredentials(alice, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    const second = await auth.listAgentCredentials(alice, { limit: 1, cursor: first.next_cursor! });
    expect(second.items[0].credential_id).not.toBe(first.items[0].credential_id);
    await expect(auth.listAgentCredentials(alice, { cursor: bobToken.credential_id })).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    await expect(auth.listAgentCredentials(alice, { cursor: otherTenantToken.credential_id })).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    await expect(auth.listAgentCredentials(alice, { cursor: 'not-a-uuid' })).rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    const all = await auth.listAgentCredentials(alice, { limit: 100 });
    expect(all.items).toHaveLength(3);
    expect(JSON.stringify(all)).not.toMatch(/secret|digest/i);
  });

  it('traverses every owned credential across submillisecond timestamp anchors', async () => {
    const principal = await provisionUser();
    const credentials: string[] = [];
    for (const [index, timestamp] of [
      '2026-10-23T00:00:00.000900Z',
      '2026-10-23T00:00:00.000800Z',
      '2026-10-23T00:00:00.000700Z',
    ].entries()) {
      const created = await auth.createAgentCredential(principal, { purpose: `microsecond ${index}` }, `microsecond-${index}`);
      credentials.push(created.credential_id);
      await fixture.pool.query('UPDATE control.agent_credential SET created_at=$2::timestamptz WHERE id=$1', [created.credential_id, timestamp]);
    }

    const all = await auth.listAgentCredentials(principal, { limit: 100 });
    expect(all.items.map(item => item.credential_id)).toEqual(credentials);

    const traversed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await auth.listAgentCredentials(principal, { limit: 1, ...(cursor ? { cursor } : {}) });
      traversed.push(...page.items.map(item => item.credential_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    expect(traversed).toEqual(credentials);
  });

  it('revokes atomically and idempotently, invalidates in-flight snapshots, and allows fresh other credentials', async () => {
    const principal = await provisionUser();
    const revoked = await auth.createAgentCredential(principal, { purpose: 'to-revoke' }, 'revoke-key');
    const active = await auth.createAgentCredential(principal, { purpose: 'still-valid' }, 'active-key');
    const staleSnapshot = await auth.authenticateAgent(active.secret!);
    const credentialBefore = await fixture.pool.query<{ credential_epoch: string; auth_epoch: string }>(
      `SELECT c.credential_epoch::text AS credential_epoch,s.auth_epoch::text AS auth_epoch
         FROM control.agent_credential c JOIN control.auth_subject s USING(tenant_key,user_id) WHERE c.id=$1`, [revoked.credential_id],
    );
    await auth.revokeAgentCredential(principal, revoked.credential_id);
    const credentialAfter = await fixture.pool.query<{ credential_epoch: string; auth_epoch: string }>(
      `SELECT c.credential_epoch::text AS credential_epoch,s.auth_epoch::text AS auth_epoch
         FROM control.agent_credential c JOIN control.auth_subject s USING(tenant_key,user_id) WHERE c.id=$1`, [revoked.credential_id],
    );
    expect(BigInt(credentialAfter.rows[0].credential_epoch)).toBe(BigInt(credentialBefore.rows[0].credential_epoch) + 1n);
    expect(BigInt(credentialAfter.rows[0].auth_epoch)).toBe(BigInt(credentialBefore.rows[0].auth_epoch) + 1n);
    await expect(auth.authenticateAgent(revoked.secret!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    await expect(auth.assertCurrentAgent(staleSnapshot)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await expect(auth.authenticateAgent(active.secret!)).resolves.toMatchObject({ credentialId: active.credential_id });
    const epochAfterOnce = credentialAfter.rows[0].auth_epoch;
    await auth.revokeAgentCredential(principal, revoked.credential_id);
    const epochAfterTwice = await fixture.pool.query<{ auth_epoch: string }>('SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2', [principal.tenantId, principal.userId]);
    expect(epochAfterTwice.rows[0].auth_epoch).toBe(epochAfterOnce);
  });

  it('allows agent:revoke only for same-tenant managed targets and makes other attempts a no-op', async () => {
    const admin = await provisionUser({ userId: 'admin', sub: 'admin', scopes: ['agent:revoke'] });
    const target = await provisionUser({ userId: 'target', sub: 'target' });
    const intruder = await provisionUser({ userId: 'intruder', sub: 'intruder' });
    const outside = await provisionUser({ tenantId: 't02', userId: 'outside', sub: 'outside', scopes: ['agent:revoke'] });
    const targetCredential = await auth.createAgentCredential(target, { purpose: 'managed' }, 'managed-key');
    await auth.revokeAgentCredential(outside, targetCredential.credential_id);
    await auth.revokeAgentCredential(intruder, targetCredential.credential_id);
    await expect(auth.authenticateAgent(targetCredential.secret!)).resolves.toMatchObject({ credentialId: targetCredential.credential_id });
    await auth.revokeAgentCredential(admin, targetCredential.credential_id);
    await expect(auth.authenticateAgent(targetCredential.secret!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    await auth.repository.provisionTenant({ tenantId: 'new_key', businessTimezone: 'UTC' });
    await expect(fixture.pool.query("UPDATE control.tenant SET tenant_key='changed' WHERE tenant_key='new_key'")).rejects.toThrow();
  });

  it('rechecks binding, role, department and tenant state on every fresh authentication', async () => {
    const principal = await provisionUser({ role: 'sales_manager', departmentId: 'north' });
    const created = await auth.createAgentCredential(principal, { purpose: 'snapshot' }, 'snapshot-key');
    const snapshot = await auth.authenticateAgent(created.secret!);
    await auth.repository.updateSubject({ tenantId: principal.tenantId, userId: principal.userId, departmentId: null, businessRole: 'sales_manager' });
    await expect(auth.authenticateAgent(created.secret!)).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(auth.assertCurrentAgent(snapshot)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await auth.repository.updateSubject({ tenantId: principal.tenantId, userId: principal.userId, departmentId: 'north', businessRole: 'sales_manager' });
    const current = await auth.resolveOidc(issuer, principal.subject);
    const next = await auth.authenticateAgent(created.secret!);
    await auth.repository.setIdentityBinding(issuer, principal.subject, false);
    await expect(auth.authenticateAgent(created.secret!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    await expect(auth.assertCurrentAgent(next)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await auth.repository.setIdentityBinding(issuer, principal.subject, true);
    await expect(auth.authenticateAgent(created.secret!)).resolves.toBeDefined();
    const afterReenable = await auth.resolveOidc(issuer, principal.subject);
    const afterReenableSnapshot = await auth.authenticateAgent(created.secret!);
    await auth.repository.setTenantEnabled(principal.tenantId, false);
    await expect(auth.resolveOidc(issuer, principal.subject)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    await expect(auth.assertCurrentAgent(afterReenableSnapshot)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(current.authEpoch).not.toBe(afterReenable.authEpoch);
  });

  it('binds each authenticated snapshot to one deterministic enabled OIDC binding', async () => {
    const principal = await provisionUser({ userId: 'multi', sub: 'primary' });
    const created = await auth.createAgentCredential(principal, { purpose: 'multi-binding' }, 'multi-binding-key');
    const original = await auth.authenticateAgent(created.secret!);
    await auth.repository.bindIdentity({ issuer, subject: 'alternate', tenantId: principal.tenantId, userId: principal.userId });
    await expect(auth.assertCurrentAgent(original)).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await auth.repository.setIdentityBinding(issuer, 'primary', false);
    const replacement = await auth.authenticateAgent(created.secret!);
    expect(replacement.subject).toBe('alternate');
    await expect(auth.assertCurrentAgent(replacement)).resolves.toBeUndefined();
  });

  it('keeps management-only users resolvable but prevents agent credentials and enforces role eligibility', async () => {
    const manager = await provisionUser({ userId: 'manager', role: 'sales_manager', departmentId: null, scopes: ['agent:revoke'] });
    expect(manager.managementScopes).toEqual(['agent:revoke']);
    await expect(auth.createAgentCredential(manager, { purpose: 'no department' }, 'manager-key')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    const managementOnly = await provisionUser({ userId: 'ops', role: null, departmentId: null, scopes: ['ops:read'] });
    expect(managementOnly.businessRole).toBeNull();
    await expect(auth.createAgentCredential(managementOnly, { purpose: 'no role' }, 'ops-key')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(auth.repository.provisionSubject({ tenantId: managementOnly.tenantId, userId: 'bad-scope', managementScopes: ['unknown:scope'] as never }))
      .rejects.toMatchObject({ code: 'AUTH_INPUT_INVALID' });
    await expect(auth.resolveOidc(issuer, 'unbound')).rejects.toMatchObject({ code: 'PRINCIPAL_MAPPING_MISSING' });
  });

  it('keeps source and agent credential families separate and scopes source entities', async () => {
    const agentPrincipal = await provisionUser();
    const agentToken = await auth.createAgentCredential(agentPrincipal, { purpose: 'personal' }, 'family-agent');
    const sourceToken = createCredential().secret;
    await auth.repository.provisionSourceCredential({
      sourceId: 'crm-main', tenantId: agentPrincipal.tenantId, token: sourceToken, secretRef: 'vault://crm/token-v3',
      allowedEntities: ['customer'], revision: '7',
    });
    await expect(auth.authenticateSource(sourceToken, 'customer')).resolves.toMatchObject({ sourceId: 'crm-main', revision: '7' });
    await expect(auth.authenticateSource(sourceToken, 'order')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(auth.authenticateAgent(sourceToken)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await expect(auth.authenticateSource(agentToken.secret!, 'customer')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    const sourceDigest = createHash('sha256').update(Buffer.from(sourceToken, 'base64url')).digest();
    await expect(fixture.pool.query("INSERT INTO control.credential_digest_registry(digest,kind) VALUES($1,'agent')", [sourceDigest])).rejects.toThrow();
    await auth.repository.updateSourceCredential('crm-main', agentPrincipal.tenantId, false, '8', ['customer']);
    await expect(auth.authenticateSource(sourceToken, 'customer')).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
  });

  it('supports caller-owned transactions for related authorization mutations', async () => {
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await auth.repository.provisionTenant({ tenantId: 'tx_tenant', businessTimezone: 'UTC' }, client);
      await auth.repository.provisionSubject({ tenantId: 'tx_tenant', userId: 'tx_user', businessRole: 'sales', departmentId: 'tx' }, client);
      const inTransaction = await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2', ['tx_tenant', 'tx_user']);
      expect(inTransaction.rowCount).toBe(1);
      await client.query('ROLLBACK');
      const afterRollback = await fixture.pool.query('SELECT 1 FROM control.tenant WHERE tenant_key=$1', ['tx_tenant']);
      expect(afterRollback.rowCount).toBe(0);
    } finally { client.release(); }
  });

  it('maps database outages to a safe fail-closed error without preserving the driver error', async () => {
    const unavailablePool = { query: async () => { throw new Error('sensitive connection diagnostic'); } } as unknown as pg.Pool;
    const unavailable = createAuthService({ pool: unavailablePool });
    let caught: unknown;
    try { await unavailable.authenticateAgent(createCredential().secret); } catch (error) { caught = error; }
    const error = caught as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('AUTH_UNAVAILABLE');
    expect(error.message).toBe('AUTH_UNAVAILABLE');
    expect(error.message).not.toContain('sensitive');
    expect('cause' in error).toBe(false);
  });
});
