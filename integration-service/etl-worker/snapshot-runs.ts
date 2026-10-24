import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, SourceEntity, UserPrincipal } from '../auth/types.js';
import type { SnapshotRunSummary } from './snapshot-contract.js';

const ACTIVE = new Set(['QUEUED','SCANNING','VALIDATING','READY','APPLYING']);
const TERMINAL = new Set(['COMPLETE','FAILED','INCOMPLETE','CANCELLED']);
const ENTITY_ORDER: readonly SourceEntity[] = ['customer','order'];

function fail(code: ConstructorParameters<typeof AuthError>[0]): never { throw new AuthError(code); }
function requireScope(principal: UserPrincipal, scope: 'source:read' | 'source:write'): void {
  if (!principal.managementScopes.includes(scope)) fail('AUTH_FORBIDDEN');
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
function digest(value: unknown): Buffer { return createHash('sha256').update(stable(value), 'utf8').digest(); }
function digestHex(value: unknown): string { return digest(value).toString('hex'); }
function revision(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' || !/^[1-9][0-9]*$/.test(String(value))) fail('SOURCE_CONFLICT');
  return String(value);
}
function opaque(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
function unopaque(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('AUTH_INPUT_INVALID');
  const result = Buffer.from(value, 'base64url').toString('utf8');
  if (opaque(result) !== value) fail('AUTH_INPUT_INVALID');
  return result;
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
function parseCanonicalDate(value: string): number {
  const match = RFC3339.exec(value);
  if (!match) fail('AUTH_INPUT_INVALID');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (year === 0) fail('AUTH_INPUT_INVALID');
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) fail('AUTH_INPUT_INVALID');
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3)), zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) fail('AUTH_INPUT_INVALID');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail('AUTH_INPUT_INVALID');
  return time;
}

type RunRow = Record<string, any>;
type RunSummary = SnapshotRunSummary & { request_digest: Buffer };
function summary(row: RunRow): SnapshotRunSummary {
  const completeness = row.completeness_summary && typeof row.completeness_summary === 'object'
    ? row.completeness_summary : null;
  const checkpoint = row.checkpoint_summary && typeof row.checkpoint_summary === 'object' ? row.checkpoint_summary : null;
  return Object.freeze({ run_id: row.run_id, source_id: row.source_id, run_mode: row.run_mode, request_kind: row.request_kind,
    status: row.status, expected_entities: Object.freeze([...row.expected_entities]), extracted_count: Number(row.extracted_count),
    applied_count: Number(row.applied_count), quarantined_count: Number(row.quarantined_count),
    created_at: new Date(row.created_at).toISOString(), started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    config_revision: String(row.config_revision), mapping_revision: String(row.mapping_revision),
    identity_mapping_revision: String(row.identity_mapping_revision),
    completeness_report: completeness ?? Object.freeze({ status: 'NOT_STARTED' as const }), checkpoint_summary: checkpoint });
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); } catch { return fail('AUTH_UNAVAILABLE'); }
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AuthError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return fail('SOURCE_CONFLICT');
    return fail('AUTH_UNAVAILABLE');
  } finally { client.release(); }
}

async function lockedProof(client: PoolClient, tenantId: string, sourceId: string, approvedRevision: string,
  ) {
  // This global barrier guard is the first lock on every admission path.
  const guard = await client.query<{ lock_security_barrier_fence: string | number }>(
    'SELECT control.lock_security_barrier_fence()::text AS lock_security_barrier_fence');
  const fence = String(guard.rows[0]?.lock_security_barrier_fence ?? '0');
  const credentials = await client.query(`SELECT * FROM control.lock_source_credential($1,$2)`, [tenantId,sourceId]);
  if (!credentials.rowCount) fail('SOURCE_NOT_FOUND');
  const sourceLock = await client.query<{ lock_etl_snapshot_source: boolean }>(
    'SELECT control.lock_etl_snapshot_source($1,$2)',[tenantId,sourceId]);
  if (!sourceLock.rows[0]?.lock_etl_snapshot_source) fail('SOURCE_NOT_FOUND');
  const sourceResult = await client.query<RunRow>(
    `SELECT r.tenant_key,r.source_id,r.lifecycle,r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,
        r.data_owner_user_id,r.owner_revision,c.id AS credential_id,c.enabled AS credential_enabled,c.allowed_entities,
        c.revision AS credential_revision,c.source_epoch,c.credential_generation,t.enabled AS tenant_enabled,
        cr.config_digest,cr.config,m.mapping_digest,i.mapping_digest AS identity_mapping_digest
       FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
       JOIN control.tenant t USING(tenant_key)
       JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
       JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
       JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
      WHERE r.tenant_key=$1 AND r.source_id=$2`, [tenantId,sourceId]);
  const source = sourceResult.rows[0];
  if (!source) fail('SOURCE_NOT_FOUND');
  if (source.lifecycle !== 'ACTIVE' || !source.credential_enabled || !source.tenant_enabled ||
      revision(source.current_config_revision) !== approvedRevision) fail('SOURCE_CONFLICT');
  const config = source.config as Record<string, any>;
  const entities = Array.isArray(config.allowed_entities) ? [...config.allowed_entities].sort() as SourceEntity[] : [];
  const credentialEntities = Array.isArray(source.allowed_entities) ? [...source.allowed_entities].sort() as SourceEntity[] : [];
  if (config.connector !== 'postgresql' || config.mode !== 'FULL_SNAPSHOT' || entities.length === 0 ||
      stable(entities) !== stable(credentialEntities)) fail('SOURCE_CONTRACT_INVALID');
  const endpoint = config.endpoint_profile as Record<string, any> | undefined;
  if (!endpoint || typeof endpoint !== 'object') fail('SOURCE_CONTRACT_INVALID');
  for (const entity of entities) {
    const profileEntity = endpoint.entities?.[entity];
    if (!profileEntity || typeof profileEntity.source_pk !== 'string' ||
        (config.version_domain === 'SOURCE_VERSION' && typeof profileEntity.version_field !== 'string')) fail('SOURCE_CONTRACT_INVALID');
  }
  if (entities.includes('order')) {
    const order = endpoint.entities?.order;
    if (!order.lines || typeof order.lines.table !== 'string' || typeof order.lines.order_fk !== 'string' ||
        (config.version_domain === 'SOURCE_VERSION' && order.aggregate_version_covers_lines !== true)) fail('SOURCE_CONTRACT_INVALID');
  }
  if (config.delete_contract === 'tombstone' && entities.some(entity => typeof endpoint.entities?.[entity]?.delete_field !== 'string')) {
    fail('SOURCE_CONTRACT_INVALID');
  }
  if (config.version_domain === 'SOURCE_VERSION') {
    if (config.delete_contract === 'hard_delete' || entities.some(entity => typeof endpoint.entities?.[entity]?.version_field !== 'string')) {
      fail('SOURCE_CONTRACT_INVALID');
    }
  } else if (config.version_domain !== 'SNAPSHOT_OBSERVATION') fail('SOURCE_CONTRACT_INVALID');
  const channels: Record<string, unknown> = {};
  for (const entity of entities.sort((a,b) => ENTITY_ORDER.indexOf(a)-ENTITY_ORDER.indexOf(b))) {
    const result = await client.query<RunRow>('SELECT * FROM control.lock_source_channel($1,$2,$3)', [tenantId,sourceId,entity]);
    const channel = result.rows[0];
    if (!channel || channel.connector !== 'postgresql' || channel.mode !== 'FULL_SNAPSHOT' || channel.version_domain !== config.version_domain) {
      fail('SOURCE_CONFLICT');
    }
    channels[entity] = { channel_id: channel.id, channel_epoch: String(channel.channel_epoch), connector: channel.connector,
      mode: channel.mode, version_domain: channel.version_domain };
  }
  const approvalResult = await client.query<RunRow>(
    `SELECT a.id AS approval_id,a.owner_user_id,a.owner_revision,a.approval_security_fence::text AS approval_security_fence,
        a.data_contract_ref,t.id AS test_report_id,
        t.config_digest,t.mapping_digest,t.identity_mapping_digest,t.endpoint_profile_digest,t.status AS test_status,
        c.id AS credential_id,c.revision AS credential_revision,c.credential_generation
       FROM control.source_registry r JOIN control.source_owner_approval a
         ON (a.tenant_key,a.source_id,a.owner_user_id,a.owner_revision,a.config_revision,a.mapping_revision,a.identity_mapping_revision)=
            (r.tenant_key,r.source_id,r.data_owner_user_id,r.owner_revision,r.current_config_revision,r.mapping_revision,r.identity_mapping_revision)
       JOIN control.source_test_report t ON t.id=a.test_report_id AND (t.tenant_key,t.source_id,t.config_revision,t.mapping_revision,t.identity_mapping_revision)=
         (a.tenant_key,a.source_id,a.config_revision,a.mapping_revision,a.identity_mapping_revision)
       JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(r.tenant_key,r.source_id)
       JOIN control.auth_subject owner ON (owner.tenant_key,owner.user_id)=(r.tenant_key,r.data_owner_user_id) AND owner.enabled
       JOIN control.source_config_revision r0 ON (r0.tenant_key,r0.source_id,r0.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
       JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
       JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
      WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.lifecycle='ACTIVE'
        AND a.config_revision=$3 AND t.status='PASS'
        AND (a.config_digest,a.mapping_digest,a.identity_mapping_digest,a.source_credential_revision,a.credential_generation,a.endpoint_profile_digest)=
            (t.config_digest,t.mapping_digest,t.identity_mapping_digest,c.revision,c.credential_generation,t.endpoint_profile_digest)
        AND (t.config_digest,t.mapping_digest,t.identity_mapping_digest,t.endpoint_profile_digest)=
            (r0.config_digest,m.mapping_digest,i.mapping_digest,decode($4,'hex'))
        AND t.data_contract_ref=a.data_contract_ref
        AND NOT EXISTS (SELECT 1 FROM control.source_test_report newer WHERE newer.tenant_key=t.tenant_key AND newer.source_id=t.source_id
          AND (newer.created_at,newer.id)>(t.created_at,t.id))
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,
    [tenantId,sourceId,approvedRevision,digestHex(endpoint)]);
  const approval = approvalResult.rows[0];
  if (!approval) fail('SOURCE_CONFLICT');
  const channelIds = Object.values(channels).map((channel: any) => channel.channel_id);
  const barrierRows = await client.query<RunRow>(`SELECT 1 FROM control.source_security_barrier b
    WHERE b.tenant_key=$1 AND b.effective_fence>$2::bigint
      AND (b.source_id IS NULL OR b.source_id=$3)
      AND (b.credential_id IS NULL OR b.credential_id=$4)
      AND (b.entity IS NULL OR b.entity=ANY($5::text[]))
      AND (b.channel_id IS NULL OR b.channel_id=ANY($6::uuid[]))
      AND b.barrier_type IN ('TENANT_DISABLED','CREDENTIAL_COMPROMISE','SOURCE_SCOPE_SECURITY_REMOVAL','CHANNEL_RETIRED') LIMIT 1`,
    [tenantId,approval.approval_security_fence,sourceId,source.credential_id,entities,channelIds]);
  if (barrierRows.rowCount) fail('SOURCE_CONFLICT');
  return { source, config, entities, channels, fence, approval };
}

const SELECT_SUMMARY = `run_id,source_id,run_mode,request_kind,status,expected_entities,extracted_count,applied_count,
  quarantined_count,created_at,started_at,completed_at,config_revision,mapping_revision,identity_mapping_revision,
  completeness_summary,checkpoint_summary`;

async function insertRun(client: PoolClient, proof: Awaited<ReturnType<typeof lockedProof>>, tenantId: string,
  sourceId: string, requestKind: 'MANUAL' | 'SCHEDULED', route: 'API-019' | 'DUE_GATE', idempotencyKey: string,
  scheduleRevision: string | null): Promise<SnapshotRunSummary> {
  const request = { approved_config_revision: revision(proof.source.current_config_revision), run_mode: 'FULL_SNAPSHOT',
    request_kind: requestKind, schedule_revision: scheduleRevision };
  const requestDigest = digest(request);
  const existing = await client.query<RunRow>(`SELECT ${SELECT_SUMMARY},request_digest FROM control.etl_run
    WHERE tenant_key=$1 AND source_id=$2 AND request_route=$3 AND idempotency_key=$4`, [tenantId,sourceId,route,idempotencyKey]);
  if (existing.rowCount) {
    if (!Buffer.from(existing.rows[0].request_digest).equals(requestDigest)) fail('IDEMPOTENCY_CONFLICT');
    return summary(existing.rows[0]);
  }
  const active = await client.query(`SELECT run_id FROM control.etl_run WHERE tenant_key=$1 AND source_id=$2
    AND status=ANY($3::text[])`, [tenantId,sourceId,[...ACTIVE]]);
  if (active.rowCount) fail('SOURCE_CONFLICT');
  const inserted = await client.query<RunRow>(
    `INSERT INTO control.etl_run(tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,
      credential_id,credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
      config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
      endpoint_profile_digest,test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,owner_revision,schedule_revision)
     VALUES($1,$2,'FULL_SNAPSHOT',$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING ${SELECT_SUMMARY}`,
    [tenantId,sourceId,requestKind,route,idempotencyKey,requestDigest,proof.source.credential_id,proof.source.credential_revision,
      proof.source.credential_generation,proof.source.source_epoch,proof.entities,JSON.stringify(proof.channels),proof.source.current_config_revision,
      proof.source.config_digest,proof.source.mapping_revision,proof.source.mapping_digest,proof.source.identity_mapping_revision,
      proof.source.identity_mapping_digest,digest(proof.config.endpoint_profile),proof.approval.test_report_id,proof.approval.approval_id,
      proof.approval.data_contract_ref,proof.config.delete_contract,proof.fence,proof.approval.owner_user_id,proof.approval.owner_revision,scheduleRevision],
  );
  await client.query(`INSERT INTO control.etl_run_attempt(tenant_key,source_id,run_id,ordinal,status)
    VALUES($1,$2,$3,1,'QUEUED')`, [tenantId,sourceId,inserted.rows[0].run_id]);
  return summary(inserted.rows[0]);
}

export async function createSnapshotRun(pool: Pool, auth: Pick<AuthService,'assertCurrentPrincipal'>, principal: UserPrincipal, sourceId: string,
  approvedConfigRevision: string, idempotencyKey: string): Promise<SnapshotRunSummary> {
  requireScope(principal,'source:write');
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sourceId) || !/^[1-9][0-9]*$/.test(approvedConfigRevision) ||
      typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)) fail('AUTH_INPUT_INVALID');
  return transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    await auth.assertCurrentPrincipal(principal,'source:write',client);
    const requestDigest = digest({ approved_config_revision: approvedConfigRevision, run_mode: 'FULL_SNAPSHOT',
      request_kind: 'MANUAL', schedule_revision: null });
    const prior = await client.query<RunRow>(`SELECT ${SELECT_SUMMARY},request_digest FROM control.etl_run
      WHERE tenant_key=$1 AND source_id=$2 AND request_route='API-019' AND idempotency_key=$3`,
      [principal.tenantId,sourceId,idempotencyKey]);
    if (prior.rowCount) {
      if (!Buffer.from(prior.rows[0].request_digest).equals(requestDigest)) fail('IDEMPOTENCY_CONFLICT');
      return summary(prior.rows[0]);
    }
    const proof = await lockedProof(client,principal.tenantId,sourceId,approvedConfigRevision);
    const run = await insertRun(client,proof,principal.tenantId,sourceId,'MANUAL','API-019',idempotencyKey,null);
    const schedule = await client.query(`UPDATE control.etl_snapshot_schedule SET active_run_id=$3,last_run_id=$3,updated_at=clock_timestamp()
      WHERE tenant_key=$1 AND source_id=$2 AND enabled`, [principal.tenantId,sourceId,run.run_id]);
    return run;
  });
}

export async function admitDueSnapshotRun(pool: Pool, tenantId: string, sourceId: string): Promise<SnapshotRunSummary | null> {
  return transaction(pool, async client => {
    // Preserve the guard-first ordering before locking source, channels, then schedule.
    await client.query('SELECT control.lock_security_barrier_fence()');
    await client.query('SELECT * FROM control.lock_source_credential($1,$2)', [tenantId,sourceId]);
    const source = await client.query<RunRow>(`SELECT control.lock_etl_snapshot_source($1,$2) AS locked`, [tenantId,sourceId]);
    if (!source.rows[0]?.locked) return null;
    const currentSource = await client.query<RunRow>(`SELECT current_config_revision FROM control.source_registry
      WHERE tenant_key=$1 AND source_id=$2`, [tenantId,sourceId]);
    if (!currentSource.rowCount) return null;
    const revisionValue = revision(currentSource.rows[0].current_config_revision);
    const base = await client.query<RunRow>(`SELECT cr.config->'allowed_entities' AS entities FROM control.source_registry r
      JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
      WHERE r.tenant_key=$1 AND r.source_id=$2`, [tenantId,sourceId]);
    const entities = (base.rows[0]?.entities ?? []).slice().sort((a: string,b: string) => ENTITY_ORDER.indexOf(a as SourceEntity)-ENTITY_ORDER.indexOf(b as SourceEntity));
    for (const entity of entities) await client.query('SELECT * FROM control.lock_source_channel($1,$2,$3)', [tenantId,sourceId,entity]);
    const schedule = await client.query<RunRow>(`SELECT schedule_revision,next_due_at FROM control.etl_snapshot_schedule
      WHERE tenant_key=$1 AND source_id=$2 AND enabled AND next_due_at<=clock_timestamp() FOR UPDATE SKIP LOCKED`, [tenantId,sourceId]);
    if (!schedule.rowCount) return null;
    const active = await client.query<RunRow>(`SELECT status FROM control.etl_run WHERE tenant_key=$1 AND source_id=$2
      AND status=ANY($3::text[]) LIMIT 1`, [tenantId,sourceId,[...ACTIVE]]);
    if (active.rowCount) return null;
    const proof = await lockedProof(client,tenantId,sourceId,revisionValue);
    const scheduledKey = `due:${schedule.rows[0].schedule_revision}:${new Date(schedule.rows[0].next_due_at).toISOString()}`;
    const run = await insertRun(client,proof,tenantId,sourceId,'SCHEDULED','DUE_GATE',scheduledKey,String(schedule.rows[0].schedule_revision));
    await client.query(`UPDATE control.etl_snapshot_schedule SET active_run_id=$3,last_run_id=$3,updated_at=clock_timestamp()
      WHERE tenant_key=$1 AND source_id=$2`, [tenantId,sourceId,run.run_id]);
    return run;
  });
}

export async function listSnapshotRuns(pool: Pool, auth: Pick<AuthService,'assertCurrentPrincipal'>, principal: UserPrincipal, filters: {
  source_id?: string; status?: string; created_from?: string; created_to?: string; cursor?: string; limit?: number;
} = {}) {
  requireScope(principal,'source:read');
  const limit = filters.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (filters.source_id !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(filters.source_id)) ||
      (filters.status !== undefined && !['QUEUED','SCANNING','VALIDATING','READY','APPLYING','COMPLETE','FAILED','INCOMPLETE','CANCELLED'].includes(filters.status))) fail('AUTH_INPUT_INVALID');
  const fromTime = filters.created_from === undefined ? undefined : parseCanonicalDate(filters.created_from);
  const toTime = filters.created_to === undefined ? undefined : parseCanonicalDate(filters.created_to);
  if ((fromTime !== undefined && !Number.isFinite(fromTime)) || (toTime !== undefined && !Number.isFinite(toTime)) ||
      (fromTime !== undefined && toTime !== undefined && (fromTime >= toTime || toTime - fromTime > 366 * 24 * 60 * 60 * 1000))) {
    fail('AUTH_INPUT_INVALID');
  }
  const anchorId = filters.cursor === undefined ? null : unopaque(filters.cursor);
  if (anchorId !== null && !UUID.test(anchorId)) fail('AUTH_INPUT_INVALID');
  return transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    await auth.assertCurrentPrincipal(principal,'source:read',client);
    if (anchorId !== null) {
      const anchor = await client.query('SELECT 1 FROM control.etl_run WHERE tenant_key=$1 AND run_id=$2::uuid', [principal.tenantId,anchorId]);
      if (!anchor.rowCount) fail('SOURCE_NOT_FOUND');
    }
    const result = await client.query<RunRow>(`SELECT ${SELECT_SUMMARY} FROM control.etl_run
      WHERE tenant_key=$1 AND ($2::text IS NULL OR source_id=$2) AND ($3::text IS NULL OR status=$3)
        AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at < $5)
        AND ($6::uuid IS NULL OR (created_at,run_id)<(SELECT created_at,run_id FROM control.etl_run WHERE tenant_key=$1 AND run_id=$6::uuid))
      ORDER BY created_at DESC,run_id DESC LIMIT $7`,
      [principal.tenantId,filters.source_id ?? null,filters.status ?? null,filters.created_from ?? null,filters.created_to ?? null,
        anchorId,limit+1]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0,limit);
    return Object.freeze({ items: Object.freeze(rows.map(summary)), next_cursor: hasMore && rows.length
      ? opaque(rows[rows.length-1].run_id) : null });
  });
}

export async function getSnapshotRun(pool: Pool, auth: Pick<AuthService,'assertCurrentPrincipal'>, principal: UserPrincipal, runId: string) {
  requireScope(principal,'source:read');
  if (!UUID.test(runId)) fail('SOURCE_NOT_FOUND');
  return transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    await auth.assertCurrentPrincipal(principal,'source:read',client);
    const result = await client.query<RunRow>(`SELECT ${SELECT_SUMMARY},checkpoint_summary,completeness_summary FROM control.etl_run
      WHERE tenant_key=$1 AND run_id=$2::uuid`, [principal.tenantId,runId]);
    if (!result.rowCount) fail('SOURCE_NOT_FOUND');
    return summary(result.rows[0]);
  });
}

export function isActiveSnapshotStatus(status: string): boolean { return ACTIVE.has(status); }
export function isTerminalSnapshotStatus(status: string): boolean { return TERMINAL.has(status); }
