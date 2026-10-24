import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from './errors.js';
import { createCredential, digestCredential } from './credentials.js';
import { authQuery, decimalBigint, withAuthTransaction } from './repository.js';
import {
  AUTH_SCOPES,
  type AgentCredentialMetadata,
  type AgentCredentialPage,
  type AgentCredentialPageResult,
  type AgentPrincipal,
  type AuthScope,
  type AuthService,
  type BusinessRole,
  type CreateAgentCredentialInput,
  type CreateAgentCredentialResult,
  type IdentityBindingInput,
  type SourceCredentialProvisionInput,
  type SourceEntity,
  type SourcePrincipal,
  type SubjectProvisionInput,
  type TenantProvisionInput,
  type UserPrincipal,
} from './types.js';

type SubjectRow = {
  tenant_key: string;
  user_id: string;
  department_id: string | null;
  business_role: BusinessRole | null;
  management_scopes: string[];
  auth_epoch: string | number;
  enabled: boolean;
  tenant_enabled: boolean;
  business_timezone: string;
  issuer: string;
  subject: string;
  binding_enabled: boolean;
};

type AgentRow = SubjectRow & {
  credential_id: string;
  credential_epoch: string | number;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

type CredentialRow = {
  id: string;
  purpose: string;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

type CurrentIdentity = UserPrincipal & { enabled: boolean; tenantEnabled: boolean; bindingEnabled: boolean };

const scopeSet = new Set<string>(AUTH_SCOPES);
const sourceEntitySet = new Set<string>(['customer', 'order']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new AuthError('AUTH_UNAVAILABLE');
  return value;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AuthError('AUTH_UNAVAILABLE');
  return date.toISOString();
}

function scopes(value: readonly string[]): AuthScope[] {
  if (!Array.isArray(value) || value.some(scope => !scopeSet.has(scope)) || new Set(value).size !== value.length) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return [...value].sort() as AuthScope[];
}

function assertTenantKey(value: string): void {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
}

function mapUser(row: SubjectRow): UserPrincipal {
  return Object.freeze({
    userId: row.user_id,
    tenantId: row.tenant_key,
    departmentId: row.department_id,
    businessRole: row.business_role,
    managementScopes: Object.freeze(scopes(row.management_scopes)),
    authEpoch: decimalBigint(row.auth_epoch),
    businessTimezone: row.business_timezone,
    issuer: row.issuer,
    subject: row.subject,
  });
}

function assertEligibleBusinessUser(user: UserPrincipal): void {
  if (user.businessRole === null || (user.businessRole === 'sales_manager' && user.departmentId === null)) {
    throw new AuthError('AUTH_FORBIDDEN');
  }
}

function assertCallerMatches(caller: UserPrincipal, current: UserPrincipal): void {
  if (caller.userId !== current.userId || caller.tenantId !== current.tenantId ||
      caller.issuer !== current.issuer || caller.subject !== current.subject) throw new AuthError('AUTH_CONTEXT_CHANGED');
}

async function identityByOidc(
  client: PoolClient,
  issuer: string,
  subject: string,
  lock = false,
): Promise<CurrentIdentity> {
  const result = await client.query<SubjectRow>(
    lock
      ? 'SELECT * FROM control.lock_api_identity($1,$2)'
      : `SELECT s.tenant_key, s.user_id, s.department_id, s.business_role, s.management_scopes,
                s.auth_epoch, s.enabled, t.enabled AS tenant_enabled, t.business_timezone,
                b.issuer, b.subject, b.enabled AS binding_enabled
           FROM control.identity_binding b
           JOIN control.auth_subject s ON (s.tenant_key, s.user_id) = (b.tenant_key, b.user_id)
           JOIN control.tenant t ON t.tenant_key = s.tenant_key
          WHERE b.issuer = $1 AND b.subject = $2`,
    [issuer, subject],
  );
  const row = result.rows[0];
  if (!row) throw new AuthError('PRINCIPAL_MAPPING_MISSING');
  if (!row.binding_enabled || !row.enabled || !row.tenant_enabled) throw new AuthError('AUTH_REVOKED');
  const user = mapUser(row);
  return { ...user, enabled: row.enabled, tenantEnabled: row.tenant_enabled, bindingEnabled: row.binding_enabled };
}

function validateOidcKey(issuer: string, subject: string): void {
  if (typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 2048 ||
      typeof subject !== 'string' || subject.length < 1 || subject.length > 2048) throw new AuthError('AUTH_INPUT_INVALID');
}

function validateAgentInput(input: CreateAgentCredentialInput, idempotencyKey: string): { purpose: string; ttl: number; requestDigest: Buffer } {
  if (!input || typeof input !== 'object') throw new AuthError('AUTH_INPUT_INVALID');
  if (Object.keys(input).some(key => key !== 'purpose' && key !== 'ttl_seconds')) throw new AuthError('AUTH_INPUT_INVALID');
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 .:_-]{0,95}$/.test(purpose)) throw new AuthError('AUTH_INPUT_INVALID');
  const ttl = input.ttl_seconds === undefined ? 3600 : input.ttl_seconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) throw new AuthError('AUTH_INPUT_INVALID');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  const requestDigest = createHash('sha256').update(JSON.stringify({ purpose, ttl_seconds: ttl })).digest();
  return { purpose, ttl, requestDigest };
}

function metadata(row: CredentialRow): AgentCredentialMetadata {
  return Object.freeze({
    credential_id: row.id,
    purpose: row.purpose,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    revoked_at: row.revoked_at === null ? null : iso(row.revoked_at),
  });
}

function assertEntity(entity: SourceEntity): void {
  if (!sourceEntitySet.has(entity)) throw new AuthError('AUTH_INPUT_INVALID');
}

function sourceEntities(values: readonly SourceEntity[]): SourceEntity[] {
  if (!Array.isArray(values) || values.length < 1 || values.some(value => !sourceEntitySet.has(value)) || new Set(values).size !== values.length) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return [...values].sort() as SourceEntity[];
}

function revision(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
  return decimalBigint(value);
}

function validateSubject(input: SubjectProvisionInput): { tenantId: string; userId: string; departmentId: string | null; role: BusinessRole | null; managementScopes: AuthScope[]; enabled: boolean } {
  assertTenantKey(input.tenantId);
  if (typeof input.userId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(input.userId)) throw new AuthError('AUTH_INPUT_INVALID');
  const departmentId = input.departmentId ?? null;
  if (departmentId !== null && (typeof departmentId !== 'string' || departmentId.length > 256 || /[\u0000-\u001f\u007f]/.test(departmentId))) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  const role = input.businessRole ?? null;
  if (role !== null && role !== 'sales' && role !== 'sales_manager') throw new AuthError('AUTH_INPUT_INVALID');
  return { tenantId: input.tenantId, userId: input.userId, departmentId, role, managementScopes: scopes(input.managementScopes ?? []), enabled: input.enabled ?? true };
}

function validateBinding(input: IdentityBindingInput): IdentityBindingInput {
  validateOidcKey(input.issuer, input.subject);
  assertTenantKey(input.tenantId);
  if (typeof input.userId !== 'string' || input.userId.length < 1 || input.userId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.userId)) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return input;
}

async function provisionTenant(pool: Pool, input: TenantProvisionInput, supplied?: PoolClient): Promise<void> {
  assertTenantKey(input.tenantId);
  if (typeof input.businessTimezone !== 'string' || input.businessTimezone.length < 1 || input.businessTimezone.length > 128) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  try {
    await new Intl.DateTimeFormat('en-US', { timeZone: input.businessTimezone }).format(new Date(0));
  } catch { throw new AuthError('AUTH_INPUT_INVALID'); }
  const enabled = input.enabled ?? true;
  await withAuthTransaction(pool, supplied, async client => {
    const inserted = await client.query(
      `INSERT INTO control.tenant(tenant_key, enabled, business_timezone) VALUES($1,$2,$3)
       ON CONFLICT (tenant_key) DO NOTHING`, [input.tenantId, enabled, input.businessTimezone],
    );
    if (inserted.rowCount === 1) return;
    const existing = await client.query<{ enabled: boolean; business_timezone: string }>(
      'SELECT enabled, business_timezone FROM control.tenant WHERE tenant_key=$1 FOR UPDATE', [input.tenantId],
    );
    const row = existing.rows[0];
    if (!row) throw new AuthError('AUTH_UNAVAILABLE');
    if (row.enabled === enabled && row.business_timezone === input.businessTimezone) return;
    await client.query('UPDATE control.tenant SET enabled=$2,business_timezone=$3 WHERE tenant_key=$1', [input.tenantId, enabled, input.businessTimezone]);
    await client.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1', [input.tenantId]);
  });
}

async function writeSubject(pool: Pool, input: SubjectProvisionInput, supplied: PoolClient | undefined, requireExisting: boolean): Promise<void> {
  const value = validateSubject(input);
  await withAuthTransaction(pool, supplied, async client => {
    if (!requireExisting) {
      await client.query(
        `INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role,management_scopes,enabled)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(tenant_key,user_id) DO UPDATE SET
           department_id=EXCLUDED.department_id, business_role=EXCLUDED.business_role,
           management_scopes=EXCLUDED.management_scopes, enabled=EXCLUDED.enabled,
           auth_epoch=control.auth_subject.auth_epoch+1
         WHERE (control.auth_subject.department_id,control.auth_subject.business_role,control.auth_subject.management_scopes,control.auth_subject.enabled)
           IS DISTINCT FROM (EXCLUDED.department_id,EXCLUDED.business_role,EXCLUDED.management_scopes,EXCLUDED.enabled)`,
        [value.tenantId, value.userId, value.departmentId, value.role, value.managementScopes, value.enabled],
      );
      return;
    }
    const updated = await client.query(
      `UPDATE control.auth_subject SET department_id=$3,business_role=$4,management_scopes=$5,enabled=$6,auth_epoch=auth_epoch+1
        WHERE tenant_key=$1 AND user_id=$2
          AND (department_id,business_role,management_scopes,enabled) IS DISTINCT FROM ($3,$4,$5,$6)`,
      [value.tenantId, value.userId, value.departmentId, value.role, value.managementScopes, value.enabled],
    );
    if (updated.rowCount === 0) {
      const exists = await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2', [value.tenantId, value.userId]);
      if (exists.rowCount === 0) throw new AuthError('AUTH_INPUT_INVALID');
    }
  });
}

async function bindIdentity(pool: Pool, rawInput: IdentityBindingInput, supplied?: PoolClient): Promise<void> {
  const input = validateBinding(rawInput);
  const enabled = input.enabled ?? true;
  await withAuthTransaction(pool, supplied, async client => {
    const target = await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE', [input.tenantId, input.userId]);
    if (target.rowCount !== 1) throw new AuthError('AUTH_INPUT_INVALID');
    const prior = await client.query<{ tenant_key: string; user_id: string; enabled: boolean }>(
      'SELECT tenant_key,user_id,enabled FROM control.identity_binding WHERE issuer=$1 AND subject=$2 FOR UPDATE', [input.issuer, input.subject],
    );
    const old = prior.rows[0];
    if (old && old.tenant_key === input.tenantId && old.user_id === input.userId && old.enabled === enabled) return;
    if (old) await client.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id=$2', [old.tenant_key, old.user_id]);
    if (!old || old.tenant_key !== input.tenantId || old.user_id !== input.userId) {
      await client.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id=$2', [input.tenantId, input.userId]);
    }
    await client.query(
      `INSERT INTO control.identity_binding(issuer,subject,tenant_key,user_id,enabled) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(issuer,subject) DO UPDATE SET tenant_key=EXCLUDED.tenant_key,user_id=EXCLUDED.user_id,enabled=EXCLUDED.enabled`,
      [input.issuer, input.subject, input.tenantId, input.userId, enabled],
    );
  });
}

async function setIdentityBinding(pool: Pool, issuer: string, subject: string, enabled: boolean, supplied?: PoolClient): Promise<void> {
  validateOidcKey(issuer, subject);
  if (typeof enabled !== 'boolean') throw new AuthError('AUTH_INPUT_INVALID');
  await withAuthTransaction(pool, supplied, async client => {
    const changed = await client.query<{ tenant_key: string; user_id: string }>(
      `UPDATE control.identity_binding SET enabled=$3 WHERE issuer=$1 AND subject=$2 AND enabled IS DISTINCT FROM $3
       RETURNING tenant_key,user_id`, [issuer, subject, enabled],
    );
    if (changed.rowCount) await client.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id=$2', [changed.rows[0].tenant_key, changed.rows[0].user_id]);
  });
}

async function setTenantEnabled(pool: Pool, tenantId: string, enabled: boolean, supplied?: PoolClient): Promise<void> {
  assertTenantKey(tenantId);
  if (typeof enabled !== 'boolean') throw new AuthError('AUTH_INPUT_INVALID');
  await withAuthTransaction(pool, supplied, async client => {
    const changed = await client.query('UPDATE control.tenant SET enabled=$2 WHERE tenant_key=$1 AND enabled IS DISTINCT FROM $2', [tenantId, enabled]);
    if (changed.rowCount) {
      await client.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1', [tenantId]);
      if (!enabled) await client.query('SELECT control.record_tenant_security_disable($1)', [tenantId]);
    }
  });
}

async function provisionSourceCredential(pool: Pool, input: SourceCredentialProvisionInput, supplied?: PoolClient): Promise<void> {
  assertTenantKey(input.tenantId);
  if (typeof input.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.sourceId) ||
      typeof input.secretRef !== 'string' || input.secretRef.length < 1 || input.secretRef.length > 512 || /[\u0000-\u001f\u007f]/.test(input.secretRef)) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  const allowedEntities = sourceEntities(input.allowedEntities);
  const revisionValue = revision(input.revision);
  const digest = digestCredential(input.token);
  const enabled = input.enabled ?? true;
  await withAuthTransaction(pool, supplied, async client => {
    try {
      await client.query('SELECT control.upsert_source_credential($1,$2,$3,$4,$5,$6,$7)',
        [input.sourceId,input.tenantId,digest,input.secretRef,allowedEntities,enabled,revisionValue]);
    } catch { throw new AuthError('AUTH_INPUT_INVALID'); }
  });
}

async function updateSourceCredential(
  pool: Pool, sourceId: string, tenantId: string, enabled: boolean, revisionText: string,
  allowedEntitiesInput: readonly SourceEntity[], supplied?: PoolClient, secretRef?: string,
): Promise<void> {
  assertTenantKey(tenantId);
  if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 256 || typeof enabled !== 'boolean') throw new AuthError('AUTH_INPUT_INVALID');
  const revisionValue = revision(revisionText);
  const entities = sourceEntities(allowedEntitiesInput);
  if (secretRef !== undefined && (typeof secretRef !== 'string' || secretRef.length < 1 || secretRef.length > 512 || /[\u0000-\u001f\u007f]/.test(secretRef))) throw new AuthError('AUTH_INPUT_INVALID');
  await withAuthTransaction(pool, supplied, async client => {
    const result = await client.query<{ update_source_credential: number }>(
      'SELECT control.update_source_credential($1,$2,$3,$4,$5,$6,$7)',
      [sourceId,tenantId,enabled,revisionValue,entities,secretRef ?? null,secretRef !== undefined],
    );
    if (Number(result.rows[0]?.update_source_credential ?? 0) === 0) {
      const exists = await client.query('SELECT 1 FROM control.source_credential WHERE source_id=$1 AND tenant_key=$2', [sourceId, tenantId]);
      if (!exists.rowCount) throw new AuthError('AUTH_INPUT_INVALID');
    }
  });
}

async function advanceSourceEpoch(pool: Pool, sourceId: string, tenantId: string, supplied?: PoolClient): Promise<void> {
  assertTenantKey(tenantId);
  await withAuthTransaction(pool, supplied, async client => {
    const updated = await client.query<{ bump_source_epoch: number }>('SELECT control.bump_source_epoch($1,$2)', [sourceId,tenantId]);
    if (Number(updated.rows[0]?.bump_source_epoch ?? 0) === 0) throw new AuthError('AUTH_INPUT_INVALID');
  });
}

async function recordSourceBarrier(
  pool: Pool, sourceId: string, tenantId: string, barrierType: 'CREDENTIAL_COMPROMISE' | 'SOURCE_SCOPE_SECURITY_REMOVAL',
  reasonCode: string, entity?: SourceEntity, supplied?: PoolClient,
): Promise<void> {
  assertTenantKey(tenantId);
  if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 256 ||
      typeof reasonCode !== 'string' || !/^[A-Z0-9_]{1,96}$/.test(reasonCode)) throw new AuthError('AUTH_INPUT_INVALID');
  await withAuthTransaction(pool, supplied, async client => {
    const result = await client.query<{ record_source_security_barrier: number }>(
      'SELECT control.record_source_security_barrier($1,$2,$3,$4,$5)',
      [sourceId,tenantId,barrierType,reasonCode,entity ?? null],
    );
    if (Number(result.rows[0]?.record_source_security_barrier ?? 0) === 0) throw new AuthError('AUTH_INPUT_INVALID');
  });
}

export function createAuthService(options: { pool: Pool; clock?: () => Date }): AuthService {
  const { pool } = options;
  const clock = options.clock ?? (() => new Date());

  const repository: AuthService['repository'] = Object.freeze({
    provisionTenant: (input, client) => provisionTenant(pool, input, client),
    provisionSubject: (input, client) => writeSubject(pool, input, client, false),
    bindIdentity: (input, client) => bindIdentity(pool, input, client),
    updateSubject: (input, client) => writeSubject(pool, input, client, true),
    setIdentityBinding: (issuer, subject, enabled, client) => setIdentityBinding(pool, issuer, subject, enabled, client),
    setTenantEnabled: (tenantId, enabled, client) => setTenantEnabled(pool, tenantId, enabled, client),
    provisionSourceCredential: (input, client) => provisionSourceCredential(pool, input, client),
    updateSourceCredential: (sourceId, tenantId, enabled, revisionValue, entities, client, secretRef) =>
      updateSourceCredential(pool, sourceId, tenantId, enabled, revisionValue, entities, client, secretRef),
    advanceSourceEpoch: (sourceId, tenantId, client) => advanceSourceEpoch(pool, sourceId, tenantId, client),
    revokeSourceCredential: (sourceId, tenantId, reasonCode, client) =>
      recordSourceBarrier(pool, sourceId, tenantId, 'CREDENTIAL_COMPROMISE', reasonCode, undefined, client),
    recordSourceScopeSecurityBarrier: (sourceId, tenantId, entity, reasonCode, client) =>
      recordSourceBarrier(pool, sourceId, tenantId, 'SOURCE_SCOPE_SECURITY_REMOVAL', reasonCode, entity, client),
  });

  return Object.freeze({
    repository,
    async resolveOidc(issuer, subject) {
      validateOidcKey(issuer, subject);
      const result = await authQuery(() => pool.query<SubjectRow>(
        `SELECT s.tenant_key, s.user_id, s.department_id, s.business_role, s.management_scopes,
                s.auth_epoch, s.enabled, t.enabled AS tenant_enabled, t.business_timezone,
                b.issuer, b.subject, b.enabled AS binding_enabled
           FROM control.identity_binding b
           JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(b.tenant_key,b.user_id)
           JOIN control.tenant t ON t.tenant_key=s.tenant_key
          WHERE b.issuer=$1 AND b.subject=$2`, [issuer, subject],
      ));
      const row = result.rows[0];
      if (!row) throw new AuthError('PRINCIPAL_MAPPING_MISSING');
      if (!row.binding_enabled || !row.enabled || !row.tenant_enabled) throw new AuthError('AUTH_REVOKED');
      return mapUser(row);
    },

    async assertCurrentPrincipal(principal, scope, client) {
      validateOidcKey(principal.issuer, principal.subject);
      const current = await identityByOidc(client, principal.issuer, principal.subject, true);
      assertCallerMatches(principal, current);
      if (!current.managementScopes.includes(scope)) throw new AuthError('AUTH_FORBIDDEN');
    },

    async createAgentCredential(principal, input, idempotencyKey): Promise<CreateAgentCredentialResult> {
      const normalized = validateAgentInput(input, idempotencyKey);
      return withAuthTransaction(pool, undefined, async client => {
        const current = await identityByOidc(client, principal.issuer, principal.subject, true);
        assertCallerMatches(principal, current);
        assertEligibleBusinessUser(current);
        const existing = await client.query<{ request_digest: Buffer; credential_id: string }>(
          'SELECT * FROM control.lock_agent_credential_idempotency($1,$2,$3)',
          [current.tenantId, current.userId, idempotencyKey],
        );
        if (existing.rowCount) {
          if (!Buffer.from(existing.rows[0].request_digest).equals(normalized.requestDigest)) throw new AuthError('IDEMPOTENCY_CONFLICT');
          const replay = await client.query<CredentialRow>(
            `SELECT id,purpose,created_at,expires_at,revoked_at FROM control.agent_credential
              WHERE id=$1 AND tenant_key=$2 AND user_id=$3`,
            [existing.rows[0].credential_id, current.tenantId, current.userId],
          );
          if (!replay.rowCount) throw new AuthError('AUTH_UNAVAILABLE');
          return Object.freeze({ ...metadata(replay.rows[0]), secret: null, replayed: true });
        }

        const generated = createCredential();
        const expiry = new Date(nowDate(clock).getTime() + normalized.ttl * 1000);
        const registered = await client.query(
          `INSERT INTO control.credential_digest_registry(digest,kind) VALUES($1,'agent') ON CONFLICT(digest) DO NOTHING`, [generated.digest],
        );
        if (registered.rowCount !== 1) throw new AuthError('AUTH_UNAVAILABLE');
        const created = await client.query<CredentialRow>(
          `INSERT INTO control.agent_credential(tenant_key,user_id,digest,digest_kind,purpose,expires_at)
           VALUES($1,$2,$3,'agent',$4,$5) RETURNING id,purpose,created_at,expires_at,revoked_at`,
          [current.tenantId, current.userId, generated.digest, normalized.purpose, expiry],
        );
        const row = created.rows[0];
        await client.query(
          `INSERT INTO control.agent_credential_idempotency(tenant_key,user_id,idempotency_key,request_digest,credential_id)
           VALUES($1,$2,$3,$4,$5)`, [current.tenantId, current.userId, idempotencyKey, normalized.requestDigest, row.id],
        );
        return Object.freeze({ ...metadata(row), secret: generated.secret, replayed: false });
      });
    },

    async listAgentCredentials(principal, page: AgentCredentialPage = {}): Promise<AgentCredentialPageResult> {
      const current = await this.resolveOidc(principal.issuer, principal.subject);
      assertCallerMatches(principal, current);
      const limit = page.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AuthError('AUTH_INPUT_INVALID');
      let anchorId: string | undefined;
      if (page.cursor !== undefined) {
        if (typeof page.cursor !== 'string' || !UUID.test(page.cursor)) throw new AuthError('AUTH_INPUT_INVALID');
        const found = await authQuery(() => pool.query<{ id: string }>(
          `SELECT id FROM control.agent_credential WHERE id=$1 AND tenant_key=$2 AND user_id=$3`,
          [page.cursor, current.tenantId, current.userId],
        ));
        anchorId = found.rows[0]?.id;
        if (!anchorId) throw new AuthError('AUTH_INPUT_INVALID');
      }
      const listed = await authQuery(() => pool.query<CredentialRow>(
        `WITH anchor AS (
           SELECT created_at,id FROM control.agent_credential
            WHERE id=$3::uuid AND tenant_key=$1 AND user_id=$2
         )
         SELECT credential.id,credential.purpose,credential.created_at,credential.expires_at,credential.revoked_at
           FROM control.agent_credential credential
          WHERE credential.tenant_key=$1 AND credential.user_id=$2
            AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM anchor
               WHERE (credential.created_at,credential.id)<(anchor.created_at,anchor.id)
            ))
          ORDER BY credential.created_at DESC,credential.id DESC LIMIT $4`,
        [current.tenantId, current.userId, anchorId ?? null, limit + 1],
      ));
      const hasMore = listed.rows.length > limit;
      const rows = hasMore ? listed.rows.slice(0, limit) : listed.rows;
      return Object.freeze({
        items: Object.freeze(rows.map(metadata)),
        next_cursor: hasMore && rows.length ? rows[rows.length - 1].id : null,
      });
    },

    async revokeAgentCredential(principal, credentialId) {
      if (typeof credentialId !== 'string' || !UUID.test(credentialId)) throw new AuthError('AUTH_INPUT_INVALID');
      await withAuthTransaction(pool, undefined, async client => {
        const current = await identityByOidc(client, principal.issuer, principal.subject, true);
        assertCallerMatches(principal, current);
        const target = await client.query<{ user_id: string; revoked_at: Date | string | null }>(
          `SELECT user_id,revoked_at FROM control.agent_credential
            WHERE id=$1 AND tenant_key=$2 FOR UPDATE`, [credentialId, current.tenantId],
        );
        const row = target.rows[0];
        if (!row || (row.user_id !== current.userId && !current.managementScopes.includes('agent:revoke')) || row.revoked_at !== null) return;
        const changed = await client.query(
          `UPDATE control.agent_credential SET revoked_at=$2,credential_epoch=credential_epoch+1
            WHERE id=$1 AND revoked_at IS NULL`, [credentialId, nowDate(clock)],
        );
        if (changed.rowCount) await client.query(
          'UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id=$2', [current.tenantId, row.user_id],
        );
      });
    },

    async authenticateAgent(token): Promise<AgentPrincipal> {
      const digest = digestCredential(token);
      const result = await authQuery(() => pool.query<AgentRow>(
        `SELECT c.id AS credential_id,c.credential_epoch,c.expires_at,c.revoked_at,
                s.tenant_key,s.user_id,s.department_id,s.business_role,s.management_scopes,s.auth_epoch,s.enabled,
                t.enabled AS tenant_enabled,t.business_timezone,b.issuer,b.subject,b.enabled AS binding_enabled
           FROM control.agent_credential c
           JOIN control.credential_digest_registry d ON d.digest=c.digest AND d.kind='agent' AND c.digest_kind=d.kind
           JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(c.tenant_key,c.user_id)
           JOIN control.tenant t ON t.tenant_key=s.tenant_key
           JOIN LATERAL (
             SELECT ib.issuer,ib.subject,ib.enabled FROM control.identity_binding ib
              WHERE ib.tenant_key=s.tenant_key AND ib.user_id=s.user_id
              ORDER BY ib.enabled DESC,ib.issuer,ib.subject LIMIT 1
           ) b ON true
          WHERE c.digest=$1`, [digest],
      ));
      const row = result.rows[0];
      if (!row) throw new AuthError('AUTH_INVALID');
      if (row.revoked_at !== null) throw new AuthError('AUTH_REVOKED');
      if (new Date(row.expires_at).getTime() <= nowDate(clock).getTime()) throw new AuthError('AUTH_EXPIRED');
      if (!row.enabled || !row.tenant_enabled || !row.binding_enabled) throw new AuthError('AUTH_REVOKED');
      const user = mapUser(row);
      assertEligibleBusinessUser(user);
      return Object.freeze({ ...user, credentialId: row.credential_id, credentialEpoch: decimalBigint(row.credential_epoch), expiresAt: iso(row.expires_at) });
    },

    async authenticateSourceIdentity(token): Promise<SourcePrincipal> {
      const digest = digestCredential(token);
      const result = await authQuery(() => pool.query<{
        credential_id: string; source_id: string; tenant_key: string; allowed_entities: SourceEntity[]; credential_revision: string | number;
        source_epoch: string | number; enabled: boolean; tenant_enabled: boolean;
      }>('SELECT * FROM control.authenticate_source($1)',[digest]));
      const row = result.rows[0];
      if (!row) throw new AuthError('AUTH_INVALID');
      if (!row.enabled || !row.tenant_enabled) throw new AuthError('AUTH_REVOKED');
      const allowedEntities = sourceEntities(row.allowed_entities);
      return Object.freeze({ sourceId: row.source_id, tenantId: row.tenant_key, allowedEntities: Object.freeze(allowedEntities),
        credentialId: row.credential_id, revision: decimalBigint(row.credential_revision), sourceEpoch: decimalBigint(row.source_epoch) });
    },

    async authenticateSource(token, entity): Promise<SourcePrincipal> {
      assertEntity(entity);
      const principal = await this.authenticateSourceIdentity(token);
      if (!principal.allowedEntities.includes(entity)) throw new AuthError('AUTH_FORBIDDEN');
      return principal;
    },

    async assertCurrentSource(snapshot, entity, client) {
      assertEntity(entity);
      if (!snapshot || !client || typeof snapshot.sourceId !== 'string' || typeof snapshot.tenantId !== 'string') {
        throw new AuthError('AUTH_CONTEXT_CHANGED');
      }
      const result = await authQuery(() => client.query<{
        credential_id: string; tenant_key: string; source_id: string; digest_kind: string; enabled: boolean;
        allowed_entities: SourceEntity[]; credential_revision: string | number; source_epoch: string | number;
        tenant_enabled: boolean; lifecycle: string; config_revision: string | number;
      }>('SELECT * FROM control.lock_current_source($1,$2,$3,$4)',
      [snapshot.credentialId, snapshot.tenantId, snapshot.sourceId, entity]));
      const row = result.rows[0];
      if (!row || row.credential_id !== snapshot.credentialId || row.tenant_key !== snapshot.tenantId || row.source_id !== snapshot.sourceId ||
          row.digest_kind !== 'source' || !row.enabled || !row.tenant_enabled || row.lifecycle !== 'ACTIVE' ||
          !sourceEntities(row.allowed_entities).includes(entity) || !snapshot.allowedEntities.includes(entity) ||
          decimalBigint(row.credential_revision) !== snapshot.revision || decimalBigint(row.config_revision) !== snapshot.revision ||
          decimalBigint(row.source_epoch) !== snapshot.sourceEpoch) throw new AuthError('AUTH_CONTEXT_CHANGED');
    },

    async assertCurrentAgent(snapshot) {
      const result = await authQuery(() => pool.query<AgentRow>(
        `SELECT c.id AS credential_id,c.credential_epoch,c.expires_at,c.revoked_at,
                s.tenant_key,s.user_id,s.department_id,s.business_role,s.management_scopes,s.auth_epoch,s.enabled,
                t.enabled AS tenant_enabled,t.business_timezone,b.issuer,b.subject,b.enabled AS binding_enabled
           FROM control.agent_credential c
           JOIN control.auth_subject s ON (s.tenant_key,s.user_id)=(c.tenant_key,c.user_id)
           JOIN control.tenant t ON t.tenant_key=s.tenant_key
           JOIN control.identity_binding b ON b.tenant_key=s.tenant_key AND b.user_id=s.user_id AND b.issuer=$2 AND b.subject=$3
          WHERE c.id=$1`, [snapshot.credentialId, snapshot.issuer, snapshot.subject],
      ));
      const row = result.rows[0];
      if (!row || row.revoked_at !== null || !row.enabled || !row.tenant_enabled || !row.binding_enabled) throw new AuthError('AUTH_CONTEXT_CHANGED');
      if (new Date(row.expires_at).getTime() <= nowDate(clock).getTime()) throw new AuthError('AUTH_EXPIRED');
      const current = mapUser(row);
      if (current.userId !== snapshot.userId || current.tenantId !== snapshot.tenantId ||
          current.authEpoch !== snapshot.authEpoch || decimalBigint(row.credential_epoch) !== snapshot.credentialEpoch ||
          current.departmentId !== snapshot.departmentId || current.businessRole !== snapshot.businessRole ||
          current.businessTimezone !== snapshot.businessTimezone || current.managementScopes.join('\0') !== snapshot.managementScopes.join('\0')) {
        throw new AuthError('AUTH_CONTEXT_CHANGED');
      }
      assertEligibleBusinessUser(current);
    },
  });
}
