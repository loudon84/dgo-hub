import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError, isAuthError } from '../auth/errors.js';
import type { AuthService, SourceEntity, SourcePrincipal, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { IngestInputError, parseStrictJson, requestDigest, STRICT_INGEST_BODY_LIMIT, validateHubBatch, type PublicBatch } from './strict-contract.js';

const ROUTES = {
  customer: '/hub/v1/ingest/crm/customers',
  order: '/hub/v1/ingest/orders/orders',
} as const;
type RawStoragePolicy = 'local_lab_fixture' | 'deployment_managed';
type StrictAuth = Pick<AuthService, 'authenticateSource' | 'authenticateSourceIdentity' | 'assertCurrentSource'>;
export type StrictIngestionOptions = Readonly<{
  pool: Pool;
  authService: StrictAuth;
  authenticator?: OidcAuthenticator;
  rawStoragePolicy?: RawStoragePolicy;
}>;
type IntakeProof = {
  credential_id: string;
  source_epoch: string;
  credential_revision: string;
  credential_generation: string;
  channel_id: string;
  channel_epoch: string;
  version_domain: string;
  owner_approval_id: string;
  owner_user_id: string;
  owner_revision: string;
  approval_security_fence: string;
  config_revision: string;
  config_digest: Buffer;
  mapping_revision: string;
  mapping_digest: Buffer;
  identity_mapping_revision: string;
  identity_mapping_digest: Buffer;
  endpoint_profile_digest: Buffer;
  test_report_id: string;
};
type IntakeResult = { jobId: string; status: string; receivedCount: number; appliedCount: number; replayed: boolean };
type ManagementActor = { kind: 'source'; principal: SourcePrincipal } | { kind: 'user'; principal: UserPrincipal };

function sourceInstant(value: string): { second: number; fraction: string } {
  const match = /^(.*T\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)!;
  const second = Date.parse(`${match[1]}${match[2] === '60' ? '59' : match[2]}${match[4]}`)
    + (match[2] === '60' ? 1000 : 0);
  return { second, fraction: (match[3] ?? '').padEnd(20, '0') };
}

function sourceTimeRange(batch: PublicBatch): { first: string; last: string } {
  let first = batch.records[0]!.source_updated_at;
  let last = first;
  let minimum = sourceInstant(first);
  let maximum = minimum;
  for (const record of batch.records.slice(1)) {
    const instant = sourceInstant(record.source_updated_at);
    if (instant.second < minimum.second || (instant.second === minimum.second && instant.fraction < minimum.fraction)) {
      first = record.source_updated_at;
      minimum = instant;
    }
    if (instant.second > maximum.second || (instant.second === maximum.second && instant.fraction > maximum.fraction)) {
      last = record.source_updated_at;
      maximum = instant;
    }
  }
  return { first, last };
}

function success(request: FastifyRequest, data: unknown) { return { request_id: request.id, data }; }
function statusOf(error: unknown): number {
  if (error instanceof IngestInputError) return 422;
  if (error instanceof AuthError) return error.code === 'AUTH_INPUT_INVALID' ? 422 : error.status;
  if (error instanceof RouteError) return error.status;
  const code = errorCode(error);
  if (code === 'INGEST_BODY_TOO_LARGE') return 413;
  if (code === 'INGEST_CONTENT_TYPE_UNSUPPORTED') return 415;
  if (code.startsWith('FST_ERR_CTP_') || (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400)) return 422;
  return 503;
}
function errorCode(error: unknown): string {
  if (error instanceof IngestInputError) return error.code;
  if (error instanceof AuthError) return error.code;
  if (error instanceof RouteError) return error.code;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return 'INGEST_BODY_TOO_LARGE';
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return 'INGEST_CONTENT_TYPE_UNSUPPORTED';
  if (code.startsWith('FST_ERR_CTP_')) return 'INGEST_INPUT_INVALID';
  return 'INGEST_UNAVAILABLE';
}
function sendFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const status = statusOf(error);
  const code = errorCode(error);
  const details = error instanceof IngestInputError ? { path: error.path } : {};
  return reply.code(status).send({ request_id: request.id,
    error: { code, message: code, retryable: status === 503, details } });
}
function sendNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({ request_id: request.id,
    error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false, details: {} } });
}
function errorCodeFromPg(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
class RouteError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'RouteError'; }
}
function bearer(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') throw new AuthError('AUTH_INVALID');
  const match = /^Bearer ([A-Za-z0-9._~-]{1,16384})$/.exec(authorization);
  if (!match) throw new AuthError('AUTH_INVALID');
  return match[1]!;
}
function sourceToken(token: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(token); }
function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
  return value;
}
function digestHex(value: Buffer): string { return value.toString('hex'); }

async function sourceActor(request: FastifyRequest, options: StrictIngestionOptions, entity: SourceEntity): Promise<SourcePrincipal> {
  const token = bearer(request);
  if (!sourceToken(token)) throw new AuthError('AUTH_INVALID');
  return options.authService.authenticateSource(token, entity);
}

function canonicalCursor(jobId: string, ordinal: number): string {
  return Buffer.from(JSON.stringify({ job_id: jobId, ordinal }), 'utf8').toString('base64url');
}
function parseCursor(cursor: unknown, jobId: string): number | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new AuthError('AUTH_INPUT_INVALID');
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    value = JSON.parse(decoded.toString('utf8'));
  } catch { throw new AuthError('AUTH_INPUT_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('AUTH_INPUT_INVALID');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).join(',') !== 'job_id,ordinal' || row.job_id !== jobId || !Number.isSafeInteger(row.ordinal) || (row.ordinal as number) < 0 ||
      canonicalCursor(jobId, row.ordinal as number) !== cursor) throw new AuthError('AUTH_INPUT_INVALID');
  return row.ordinal as number;
}
function pageLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
  return Number(value);
}

async function findExisting(client: PoolClient, principal: SourcePrincipal, route: string, key: string) {
  return client.query<{ id: string; request_digest: Buffer; status: string; received_count: number; applied_count: number }>(
    `SELECT id,request_digest,status,received_count,applied_count FROM control.ingestion_job
      WHERE tenant_key=$1 AND source_id=$2 AND route=$3 AND idempotency_key=$4`,
    [principal.tenantId, principal.sourceId, route, key],
  );
}

async function frozenProof(client: PoolClient, principal: SourcePrincipal, entity: SourceEntity): Promise<IntakeProof> {
  const result = await client.query<IntakeProof>(`
    SELECT c.id AS credential_id,c.source_epoch::text,c.revision::text AS credential_revision,c.credential_generation::text,
      ch.id AS channel_id,ch.channel_epoch::text,ch.version_domain,a.id AS owner_approval_id,a.owner_user_id,
      a.owner_revision::text,a.approval_security_fence::text,a.config_revision::text,a.config_digest,
      a.mapping_revision::text,a.mapping_digest,a.identity_mapping_revision::text,a.identity_mapping_digest,
      a.endpoint_profile_digest,a.test_report_id
    FROM control.source_registry r
    JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(r.tenant_key,r.source_id)
    JOIN control.source_channel ch ON (ch.tenant_key,ch.source_id,ch.entity)=(r.tenant_key,r.source_id,$3) AND ch.state='active'
    JOIN LATERAL (
      SELECT a0.* FROM control.source_owner_approval a0
      WHERE a0.tenant_key=r.tenant_key AND a0.source_id=r.source_id
        AND a0.owner_revision=r.owner_revision AND a0.config_revision=r.current_config_revision
        AND a0.mapping_revision=r.mapping_revision AND a0.identity_mapping_revision=r.identity_mapping_revision
      ORDER BY a0.approval_security_fence DESC,a0.created_at DESC,a0.id DESC LIMIT 1
    ) a ON true
    JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(a.tenant_key,a.source_id,a.config_revision)
    JOIN control.source_mapping_revision mr ON (mr.tenant_key,mr.source_id,mr.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
    JOIN control.source_identity_mapping_revision im ON (im.tenant_key,im.source_id,im.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
    JOIN control.source_test_report t ON (t.id,t.tenant_key,t.source_id)=(a.test_report_id,a.tenant_key,a.source_id)
    WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.lifecycle='ACTIVE'
      AND c.id=$4 AND c.enabled AND c.digest_kind='source' AND $3=ANY(c.allowed_entities)
      AND c.revision=a.source_credential_revision AND c.credential_generation=a.credential_generation
      AND cr.config_digest=a.config_digest AND mr.mapping_digest=a.mapping_digest AND im.mapping_digest=a.identity_mapping_digest
      AND t.status='PASS' AND t.config_revision=a.config_revision AND t.mapping_revision=a.mapping_revision
      AND t.identity_mapping_revision=a.identity_mapping_revision AND t.config_digest=a.config_digest
      AND t.mapping_digest=a.mapping_digest AND t.identity_mapping_digest=a.identity_mapping_digest
      AND t.source_credential_revision=a.source_credential_revision AND t.credential_generation=a.credential_generation
      AND t.endpoint_profile_digest=a.endpoint_profile_digest AND t.data_contract_ref=a.data_contract_ref
      AND ch.connector=cr.config->>'connector' AND ch.mode=cr.config->>'mode' AND ch.version_domain=cr.config->>'version_domain'
      AND cr.config->'allowed_entities' ? $3`,
  [principal.tenantId,principal.sourceId,entity,principal.credentialId]);
  if (!result.rowCount) throw new AuthError('SOURCE_CONFLICT');
  return result.rows[0]!;
}

async function admit(options: StrictIngestionOptions, principal: SourcePrincipal, entity: SourceEntity, route: string,
  key: string, batch: PublicBatch, rawBody: Buffer, digest: Buffer): Promise<IntakeResult> {
  const client = await options.pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const fence = await client.query<{ fence: string }>('SELECT control.lock_security_barrier_fence()::text AS fence');
    const existing = await findExisting(client, principal, route, key);
    if (existing.rowCount) {
      const row = existing.rows[0]!;
      if (!row.request_digest.equals(digest)) throw new AuthError('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      begun = false;
      return { jobId: row.id, status: row.status, receivedCount: row.received_count, appliedCount: row.applied_count, replayed: true };
    }

    const proof = await frozenProof(client, principal, entity);
    const barriers = await client.query(`SELECT 1 FROM control.source_security_barrier b
      WHERE b.tenant_key=$1 AND b.effective_fence>$2::bigint
        AND (b.source_id IS NULL OR b.source_id=$3)
        AND (b.credential_id IS NULL OR b.credential_id=$4)
        AND (b.entity IS NULL OR b.entity=$5)
        AND (b.channel_id IS NULL OR b.channel_id=$6)
        AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED') LIMIT 1`,
    [principal.tenantId,proof.approval_security_fence,principal.sourceId,principal.credentialId,entity,proof.channel_id]);
    if (barriers.rowCount) throw new AuthError('SOURCE_CONFLICT');

    const sourceRange = sourceTimeRange(batch);
    const rawBatchId = randomUUID();
    await client.query(`INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes)
      VALUES($1,$2,$3,$4,$5)`, [rawBatchId,principal.tenantId,principal.sourceId,route,rawBody]);
    const job = await client.query<{ id: string }>(`INSERT INTO control.ingestion_job(
      tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,request_digest,status,received_count,applied_count,
      credential_id,source_epoch_at_admission,credential_revision_at_admission,credential_generation_at_admission,
      channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,approval_security_fence,
      config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
      endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED',$9,0,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
      RETURNING id`, [principal.tenantId,principal.sourceId,entity,route,batch.batch_id,rawBatchId,key,digest,batch.records.length,
        proof.credential_id,proof.source_epoch,proof.credential_revision,proof.credential_generation,proof.channel_id,proof.channel_epoch,
        proof.version_domain,proof.owner_approval_id,proof.owner_user_id,proof.owner_revision,proof.approval_security_fence,
        proof.config_revision,proof.config_digest,proof.mapping_revision,proof.mapping_digest,proof.identity_mapping_revision,
        proof.identity_mapping_digest,proof.endpoint_profile_digest,proof.test_report_id,fence.rows[0]!.fence,
        sourceRange.first,sourceRange.last]);
    const jobId = job.rows[0]!.id;
    for (const [index, record] of batch.records.entries()) {
      await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED')`,
      [jobId,index,record.event_id,record.source_pk,record.source_version,record.operation,record.source_updated_at,record]);
    }
    await client.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)', [jobId]);
    await options.authService.assertCurrentSource(principal,entity,client);
    await client.query('COMMIT');
    begun = false;
    return { jobId, status: 'RECEIVED', receivedCount: batch.records.length, appliedCount: 0, replayed: false };
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => undefined);
    if (errorCodeFromPg(error) === '23505') throw new AuthError('IDEMPOTENCY_CONFLICT');
    if (error instanceof AuthError && error.code === 'AUTH_CONTEXT_CHANGED') throw new AuthError('SOURCE_CONFLICT');
    throw error;
  } finally { client.release(); }
}

async function requestBody(request: FastifyRequest): Promise<Buffer> {
  const raw = request.body;
  if (!Buffer.isBuffer(raw)) throw new RouteError('INGEST_INPUT_INVALID', 422);
  return raw;
}

async function registerReadRoutes(app: FastifyInstance, options?: StrictIngestionOptions): Promise<void> {
 app.register(async reads => {
  reads.get<{ Params: { id: string } }>('/hub/v1/ingestion-jobs/:id', async (request, reply) => {
    try {
      if (!options) throw new RouteError('INGEST_UNAVAILABLE', 503);
      const jobId = request.params.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return sendNotFound(request, reply);
      const token = bearer(request);
      const actor: ManagementActor = sourceToken(token)
        ? { kind: 'source', principal: await options.authService.authenticateSourceIdentity(token) }
        : options.authenticator ? { kind: 'user', principal: await options.authenticator(token) } : (() => { throw new AuthError('AUTH_INVALID'); })();
      let result;
      if (actor.kind === 'source') {
        result = await options.pool.query(`SELECT id,entity,status,received_count,applied_count,first_source_updated_at,last_source_updated_at
          FROM control.ingestion_job WHERE id=$1 AND tenant_key=$2 AND source_id=$3 AND entity=ANY($4::text[])`,
        [jobId,actor.principal.tenantId,actor.principal.sourceId,actor.principal.allowedEntities]);
      } else {
        if (!actor.principal.managementScopes.includes('source:read')) throw new AuthError('AUTH_FORBIDDEN');
        result = await options.pool.query(`SELECT id,entity,status,received_count,applied_count,first_source_updated_at,last_source_updated_at
          FROM control.ingestion_job WHERE id=$1 AND tenant_key=$2`, [jobId,actor.principal.tenantId]);
      }
      if (!result.rowCount) return sendNotFound(request, reply);
      const row = result.rows[0]!;
      return reply.send(success(request, { job_id: row.id,status: row.status,received_count: row.received_count,applied_count: row.applied_count,
        first_source_updated_at: row.first_source_updated_at,last_source_updated_at: row.last_source_updated_at }));
    } catch (error) { return sendFailure(request, reply, error); }
  });

  reads.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/hub/v1/ingestion-jobs/:id/items', async (request, reply) => {
    try {
      if (!options) throw new RouteError('INGEST_UNAVAILABLE', 503);
      const jobId = request.params.id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return sendNotFound(request, reply);
      const token = bearer(request);
      const actor: ManagementActor = sourceToken(token)
        ? { kind: 'source', principal: await options.authService.authenticateSourceIdentity(token) }
        : options.authenticator ? { kind: 'user', principal: await options.authenticator(token) } : (() => { throw new AuthError('AUTH_INVALID'); })();
      const limit = pageLimit(request.query.limit);
      const after = parseCursor(request.query.cursor, jobId);
      let job;
      if (actor.kind === 'source') {
        job = await options.pool.query(`SELECT id FROM control.ingestion_job WHERE id=$1 AND tenant_key=$2 AND source_id=$3 AND entity=ANY($4::text[])`,
          [jobId,actor.principal.tenantId,actor.principal.sourceId,actor.principal.allowedEntities]);
      } else {
        if (!actor.principal.managementScopes.includes('source:read')) throw new AuthError('AUTH_FORBIDDEN');
        job = await options.pool.query(`SELECT id FROM control.ingestion_job WHERE id=$1 AND tenant_key=$2`, [jobId,actor.principal.tenantId]);
      }
      if (!job.rowCount) return sendNotFound(request, reply);
      const items = await options.pool.query(`SELECT event_id,source_pk,status,error_code,ordinal FROM control.ingestion_job_item
        WHERE job_id=$1 AND ($2::integer IS NULL OR ordinal>$2) ORDER BY ordinal ASC LIMIT $3`, [jobId,after ?? null,limit + 1]);
      const hasMore = items.rows.length > limit;
      const rows = hasMore ? items.rows.slice(0,limit) : items.rows;
      const last = rows.at(-1);
      return reply.send(success(request, { items: rows.map(({ event_id,source_pk,status,error_code }) => ({ event_id,source_pk,status,error_code })),
        next_cursor: hasMore && last ? canonicalCursor(jobId,last.ordinal) : null }));
    } catch (error) { return sendFailure(request, reply, error); }
  });
 });
}

export async function registerStrictIngestionRoutes(app: FastifyInstance, options?: StrictIngestionOptions): Promise<void> {
  await registerReadRoutes(app, options);
  app.register(async intake => {
    intake.removeContentTypeParser('application/json');
    intake.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    intake.setErrorHandler((error, request, reply) => sendFailure(request, reply, error));
    for (const entity of ['customer','order'] as const) {
      const route = ROUTES[entity];
      intake.post(route, { bodyLimit: STRICT_INGEST_BODY_LIMIT }, async (request, reply) => {
        try {
          const rawBody = await requestBody(request);
          const parsed = parseStrictJson(rawBody);
          if (!options) throw new RouteError('INGEST_UNAVAILABLE',503);
          const key = idempotencyKey(request);
          const principal = await sourceActor(request,options,entity);
          const batch = validateHubBatch(parsed,entity);
          if (!options.rawStoragePolicy) throw new RouteError('INGEST_RAW_STORAGE_UNAVAILABLE',503);
          const digest = requestDigest(batch,principal.tenantId,principal.sourceId,route);
          const result = await admit(options,principal,entity,route,key,batch,rawBody,digest);
          return reply.code(202).send(success(request,{ job_id:result.jobId,status:result.status,received_count:result.receivedCount,applied_count:result.appliedCount }));
        } catch (error) { return sendFailure(request,reply,error); }
      });
    }
  });
}
