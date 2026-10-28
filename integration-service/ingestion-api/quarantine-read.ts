import { createHash } from 'node:crypto';
import { recoveryExpectedState } from './quarantine-recovery.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AuthError, AUTH_ERROR_STATUS } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ERROR_CODE = /^[A-Z0-9_:-]{1,96}$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export type QuarantineContext = Readonly<{
  tenant_key: string;
  source_id: string;
  issuer: string;
  subject: string;
  auth_epoch: string;
  owner_user_id: string;
  owner_revision: string;
  origin_kind: 'REST' | 'SNAPSHOT' | null;
  error_code: string | null;
  limit: number;
}>;

type QuarantineFilters = Readonly<{
  sourceId: string;
  originKind: 'REST' | 'SNAPSHOT' | null;
  errorCode: string | null;
  limit: number;
}>;

type CursorValue = Readonly<{ v: 1; context_sha256: string; created_at: string; quarantine_id: string }>;

type QuarantineRow = Readonly<{
  quarantine_id: string;
  origin_kind: 'REST' | 'SNAPSHOT';
  source_id: string;
  entity: 'customer' | 'order';
  relation: 'customer' | 'order' | null;
  parent_source_pk: string | null;
  job_id: string | null;
  ordinal: number | null;
  event_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  outcome_id: string | null;
  source_pk: string;
  status: 'QUARANTINED';
  error_code: string | null;
  created_at: string;
  proof: Record<string, string>;
  dependency_status: 'UNKNOWN' | 'AVAILABLE';
  dependency_code: string | null;
  retry?: { state: 'AVAILABLE'|'ACCEPTED'|'SCOPE_UNAVAILABLE'; expected_state: string|null; operation_id?: string };
}>;

export type QuarantineReadOptions = Readonly<{
  pool: Pool;
  authService: Pick<AuthService, 'assertCurrentPrincipal'>;
  authenticator: OidcAuthenticator;
}>;

function isCanonicalUnsignedDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(value);
}

export function quarantineContextJson(context: QuarantineContext): string {
  if (!isCanonicalUnsignedDecimal(context.auth_epoch) || !isCanonicalUnsignedDecimal(context.owner_revision) ||
      !Number.isInteger(context.limit) || context.limit < 1 || context.limit > 100) throw new AuthError('AUTH_INPUT_INVALID');
  return JSON.stringify({
    tenant_key: context.tenant_key,
    source_id: context.source_id,
    issuer: context.issuer,
    subject: context.subject,
    auth_epoch: context.auth_epoch,
    owner_user_id: context.owner_user_id,
    owner_revision: context.owner_revision,
    origin_kind: context.origin_kind,
    error_code: context.error_code,
    limit: context.limit,
  });
}

export function quarantineContextDigest(context: QuarantineContext): string {
  return createHash('sha256').update(quarantineContextJson(context), 'utf8').digest('hex');
}

function encodeCursor(cursor: CursorValue): string {
  return Buffer.from(JSON.stringify({
    v: cursor.v,
    context_sha256: cursor.context_sha256,
    created_at: cursor.created_at,
    quarantine_id: cursor.quarantine_id,
  }), 'utf8').toString('base64url');
}

function isValidUtcMicroseconds(value: string): boolean {
  if (!UTC_MICROSECONDS.test(value)) return false;
  const seconds = value.slice(0, 19);
  const parsed = new Date(`${seconds}Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === seconds;
}

function decodeCursor(value: unknown): CursorValue | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 1024 || !CURSOR.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('noncanonical base64url');
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid cursor');
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).join(',') !== 'v,context_sha256,created_at,quarantine_id' || row.v !== 1 ||
        typeof row.context_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.context_sha256) ||
        typeof row.created_at !== 'string' || !isValidUtcMicroseconds(row.created_at) ||
        typeof row.quarantine_id !== 'string' || !UUID.test(row.quarantine_id)) throw new Error('invalid cursor');
    const cursor: CursorValue = { v: 1, context_sha256: row.context_sha256, created_at: row.created_at,
      quarantine_id: row.quarantine_id };
    if (encodeCursor(cursor) !== value) throw new Error('noncanonical cursor');
    return cursor;
  } catch {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
}

function parseFilters(query: unknown): QuarantineFilters & { cursor: CursorValue | null } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new AuthError('AUTH_INPUT_INVALID');
  const values = query as Record<string, unknown>;
  const allowed = new Set(['source_id', 'origin_kind', 'error_code', 'limit', 'cursor']);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new AuthError('AUTH_INPUT_INVALID');
  const sourceId = values.source_id;
  const originKind = values.origin_kind;
  const errorCode = values.error_code;
  const limitValue = values.limit;
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) ||
      (originKind !== undefined && originKind !== 'REST' && originKind !== 'SNAPSHOT') ||
      (errorCode !== undefined && (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode))) ||
      (limitValue !== undefined && (typeof limitValue !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(limitValue)))) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return { sourceId, originKind: (originKind as 'REST' | 'SNAPSHOT' | undefined) ?? null,
    errorCode: (errorCode as string | undefined) ?? null, limit: limitValue === undefined ? 20 : Number(limitValue),
    cursor: decodeCursor(values.cursor) };
}

function success(request: FastifyRequest, data: unknown) {
  return { request_id: request.id, data };
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code = error instanceof AuthError ? error.code : 'AUTH_UNAVAILABLE';
  const status = error instanceof AuthError ? error.status : AUTH_ERROR_STATUS.AUTH_UNAVAILABLE;
  return reply.code(status).send({ request_id: request.id,
    error: { code, message: code, retryable: status === 503, details: {} } });
}

function bearer(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') throw new AuthError('AUTH_INVALID');
  const match = /^Bearer ([A-Za-z0-9._~-]{1,16384})$/.exec(authorization);
  if (!match) throw new AuthError('AUTH_INVALID');
  return match[1]!;
}

async function inTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_UNAVAILABLE');
  } finally {
    client.release();
  }
}

async function listCurrentOwnerPage(options: QuarantineReadOptions, principal: UserPrincipal,
  filters: QuarantineFilters & { cursor: CursorValue | null }): Promise<{ items: QuarantineRow[]; nextCursor: string | null }> {
  return inTransaction(options.pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    const credential = await client.query('SELECT control.lock_source_credential($1,$2)', [principal.tenantId, filters.sourceId]);
    if (!credential.rowCount) throw new AuthError('SOURCE_NOT_FOUND');
    const source = await client.query<{ data_owner_user_id: string; owner_revision: string }>(`
      SELECT data_owner_user_id,owner_revision::text FROM control.source_registry
      WHERE tenant_key=$1 AND source_id=$2 FOR UPDATE`, [principal.tenantId, filters.sourceId]);
    if (!source.rowCount) throw new AuthError('SOURCE_NOT_FOUND');
    await options.authService.assertCurrentPrincipal(principal, 'source:read', client);
    const owner = source.rows[0]!;
    if (owner.data_owner_user_id !== principal.userId) throw new AuthError('AUTH_FORBIDDEN');
    if (!isCanonicalUnsignedDecimal(owner.owner_revision)) throw new AuthError('AUTH_UNAVAILABLE');
    const identity = await client.query<{ auth_epoch: string }>(`SELECT auth_epoch::text FROM control.auth_subject
      WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE`, [principal.tenantId, principal.userId]);
    if (!identity.rowCount || !isCanonicalUnsignedDecimal(identity.rows[0]!.auth_epoch)) throw new AuthError('AUTH_CONTEXT_CHANGED');

    const context: QuarantineContext = { tenant_key: principal.tenantId, source_id: filters.sourceId,
      issuer: principal.issuer, subject: principal.subject, auth_epoch: identity.rows[0]!.auth_epoch,
      owner_user_id: owner.data_owner_user_id, owner_revision: owner.owner_revision,
      origin_kind: filters.originKind, error_code: filters.errorCode, limit: filters.limit };
    const contextDigest = quarantineContextDigest(context);
    if (filters.cursor && filters.cursor.context_sha256 !== contextDigest) throw new AuthError('SOURCE_CONFLICT');

    const rowsResult = await client.query<QuarantineRow>(`
      SELECT * FROM control.list_ingestion_quarantine_current_owner(
        $1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10::timestamptz,$11::uuid,$12::integer
      )`, [principal.tenantId, filters.sourceId, principal.userId, principal.issuer, principal.subject,
      identity.rows[0]!.auth_epoch, owner.owner_revision, filters.originKind, filters.errorCode,
      filters.cursor?.created_at ?? null, filters.cursor?.quarantine_id ?? null, filters.limit]);
    const hasMore = rowsResult.rows.length > filters.limit;
    const items = hasMore ? rowsResult.rows.slice(0, filters.limit) : rowsResult.rows;
    const retry = await client.query<{quarantine_id:string;state:'AVAILABLE'|'ACCEPTED'|'SCOPE_UNAVAILABLE';operation_id:string|null}>(
      'SELECT * FROM control.list_quarantine_retry_state($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::uuid[])',
      [principal.tenantId,filters.sourceId,principal.userId,principal.issuer,principal.subject,identity.rows[0]!.auth_epoch,
        owner.owner_revision,items.map(item=>item.quarantine_id)]);
    if (retry.rows.length!==items.length) throw new AuthError('AUTH_UNAVAILABLE');
    const states=new Map(retry.rows.map(row=>[row.quarantine_id,row]));
    const safeItems=items.map(item=>{
      const row=states.get(item.quarantine_id);
      if (!row) throw new AuthError('AUTH_UNAVAILABLE');
      return {...item,retry:row.state==='AVAILABLE' ? {state:row.state,expected_state:recoveryExpectedState(item.quarantine_id)} :
        row.state==='ACCEPTED' && row.operation_id ? {state:row.state,expected_state:null,operation_id:row.operation_id} :
        {state:'SCOPE_UNAVAILABLE' as const,expected_state:null}};
    });
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, context_sha256: contextDigest,
      created_at: last.created_at, quarantine_id: last.quarantine_id }) : null;
    return { items: safeItems, nextCursor };
  });
}

export async function registerQuarantineReadRoute(app: FastifyInstance, options?: QuarantineReadOptions): Promise<void> {
  app.get('/hub/v1/admin/quarantine', async (request, reply) => {
    try {
      if (!options) throw new AuthError('AUTH_UNAVAILABLE');
      const filters = parseFilters(request.query);
      const principal = await options.authenticator(bearer(request));
      const result = await listCurrentOwnerPage(options, principal, filters);
      return reply.send(success(request, { items: result.items, next_cursor: result.nextCursor }));
    } catch (error) {
      return failure(request, reply, error);
    }
  });
}
