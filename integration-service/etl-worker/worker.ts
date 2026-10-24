import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readHubRuntimeConfiguration, type HubRuntimeConfiguration } from '../contracts/runtime-config.js';
import { validateHubBatch, type PublicRecord } from '../ingestion-api/strict-contract.js';
import { applyCustomer, applyOrderAggregate, type ApplyContext, type ApplyResult } from '../normalization/apply.js';
import { durableRetryDelayMs } from './retry.js';

type Source = { name: string; url: string; table: string; kind: 'customer' | 'order' };
type LegacyDependencies = {
  pool: import('pg').Pool;
  ingest: typeof import('../normalization/store.js').ingest;
  fetchOpenMetadataTable: typeof import('../ontology-binding/binding.js').fetchOpenMetadataTable;
  nextRetryDelay: typeof import('./retry.js').nextRetryDelay;
};

type DurableJob = {
  id: string; tenant_key: string; source_id: string; entity: 'customer' | 'order'; route: string; batch_id: string;
  credential_id: string; source_epoch_at_admission: string; credential_revision_at_admission: string;
  credential_generation_at_admission: string; channel_id: string; channel_epoch: string; version_domain: 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
  owner_approval_id: string; owner_user_id: string; owner_revision: string; config_revision: string; config_digest: Buffer;
  mapping_revision: string; mapping_digest: Buffer; identity_mapping_revision: string; identity_mapping_digest: Buffer;
  endpoint_profile_digest: Buffer; test_report_id: string; security_barrier_fence_at_admission: string;
};
type DurableItem = { ordinal: number; event_id: string; source_pk: string; source_version: string; operation: string;
  public_record: unknown; status: string; attempts_started: number; retries_used: number; next_retry_at: Date | null; operation_id: string };
type DurableClaim = { jobId: string; tenantId: string; sourceId: string; token: string };
export type DurableWorkerHooks = Readonly<{
  afterClaim?: (claim: Readonly<DurableClaim>) => Promise<void>;
  afterCanonicalApply?: (item: Readonly<{ jobId: string; ordinal: number; operationId: string }>) => Promise<void>;
  beforeItemStatus?: (item: Readonly<{ jobId: string; ordinal: number; operationId: string }>) => Promise<void>;
  beforeItemCommit?: (item: Readonly<{ jobId: string; ordinal: number; operationId: string }>) => Promise<void>;
  afterItemCommit?: (item: Readonly<{ jobId: string; ordinal: number; operationId: string }>) => Promise<void>;
  onApplyError?: (error: unknown) => Promise<void>;
}>;

const TERMINAL_ITEM_STATES = new Set(['APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED']);
const TERMINAL_SUCCESS_STATES = new Set(['APPLIED','DUPLICATE','IGNORED_STALE']);
const LEASE_MS = 30_000;

function canonicalUtc(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('DURABLE_FACTS_INVALID');
  const [, year, month, day, hour, minute, secondText, fraction, zone] = match;
  const second = Number(secondText);
  if (second > 60) throw new Error('DURABLE_FACTS_INVALID');
  let instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Math.min(second, 59));
  if (second === 60) instant += 1000;
  if (zone !== 'Z') {
    const sign = zone![0] === '+' ? 1 : -1;
    const offset = Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(4, 6));
    instant -= sign * offset * 60_000;
  }
  const normalized = new Date(instant).toISOString().slice(0, 19);
  return `${normalized}${fraction ?? ''}Z`;
}

function canonicalDecimal(value: string, scale: number): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error('DURABLE_FACTS_INVALID');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error('DURABLE_FACTS_INVALID');
  return `${whole}.${fraction.padEnd(scale, '0')}`;
}

function adaptRecord(job: DurableJob, item: DurableItem): PublicRecord {
  if (job.version_domain !== 'SOURCE_VERSION') throw new Error('DURABLE_FACTS_INVALID');
  const batch = validateHubBatch({ schema_version: 'hub.v1', batch_id: job.batch_id, records: [item.public_record] }, job.entity);
  const record = batch.records[0];
  if (!record || record.event_id !== item.event_id || record.source_pk !== item.source_pk ||
      BigInt(record.source_version) !== BigInt(item.source_version) || record.operation !== item.operation) {
    throw new Error('DURABLE_FACTS_INVALID');
  }
  return record;
}

function contextFor(job: DurableJob): ApplyContext {
  return {
    tenantId: job.tenant_key, sourceId: job.source_id, credentialId: job.credential_id,
    sourceEpochAtAdmission: job.source_epoch_at_admission, credentialRevisionAtAdmission: job.credential_revision_at_admission,
    credentialGenerationAtAdmission: job.credential_generation_at_admission, entity: job.entity, channelId: job.channel_id,
    channelEpoch: job.channel_epoch, versionDomain: job.version_domain, ownerApprovalId: job.owner_approval_id,
    ownerUserId: job.owner_user_id, ownerRevision: job.owner_revision, configRevision: job.config_revision,
    configDigest: job.config_digest.toString('hex'), mappingRevision: job.mapping_revision, mappingDigest: job.mapping_digest.toString('hex'),
    identityMappingRevision: job.identity_mapping_revision, identityMappingDigest: job.identity_mapping_digest.toString('hex'),
    endpointProfileDigest: job.endpoint_profile_digest.toString('hex'), testReportId: job.test_report_id,
    securityBarrierFenceAtAdmission: job.security_barrier_fence_at_admission,
  };
}

function canonicalCustomerInput(record: PublicRecord) {
  const updated = canonicalUtc(record.source_updated_at);
  if (record.operation === 'DELETE') return { source_pk: record.source_pk, source_version: record.source_version, deleted_at: updated };
  if (!record.data || 'customer_ref' in record.data) throw new Error('DURABLE_FACTS_INVALID');
  return {
    source_pk: record.source_pk, customer_name: record.data.customer_name, owner_external_id: record.data.owner_external_id,
    dept_external_id: record.data.department_external_id, status: record.data.status, phone: record.data.phone,
    source_updated_at: updated, source_version: record.source_version, deleted_at: null,
  };
}

function canonicalOrderInput(record: PublicRecord) {
  const updated = canonicalUtc(record.source_updated_at);
  if (record.operation === 'DELETE') return { source_pk: record.source_pk, source_version: record.source_version, deleted_at: updated };
  if (!record.data || !('customer_ref' in record.data)) throw new Error('DURABLE_FACTS_INVALID');
  return {
    source_pk: record.source_pk, customer_external_id: record.data.customer_ref.source_pk, order_no: record.data.order_no,
    status: record.data.status, order_at: canonicalUtc(record.data.order_at), amount: canonicalDecimal(record.data.amount, 2),
    currency: record.data.currency, source_updated_at: updated, source_version: record.source_version, deleted_at: null,
    lines: record.data.lines.map(line => ({ ...line, quantity: canonicalDecimal(line.quantity, 6),
      unit_price: canonicalDecimal(line.unit_price, 6), line_amount: canonicalDecimal(line.line_amount, 2) })),
  };
}

async function lockClaim(client: PoolClient, claim: DurableClaim, leaseMs = LEASE_MS): Promise<boolean> {
  const locked = await client.query(`SELECT o.id FROM control.ingestion_processing_outbox o
    JOIN control.ingestion_job j ON j.id=o.job_id
    WHERE o.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3 AND o.claim_token=$4
      AND o.lease_expires_at>clock_timestamp() AND o.acknowledged_at IS NULL FOR UPDATE OF o`,
  [claim.jobId, claim.tenantId, claim.sourceId, claim.token]);
  if (!locked.rowCount) return false;
  await client.query(`UPDATE control.ingestion_processing_outbox SET lease_expires_at=clock_timestamp()+($5::integer*interval '1 millisecond')
    WHERE job_id=$1 AND claim_token=$4 AND EXISTS (SELECT 1 FROM control.ingestion_job j
      WHERE j.id=$1 AND j.tenant_key=$2 AND j.source_id=$3)`, [claim.jobId, claim.tenantId, claim.sourceId, claim.token, leaseMs]);
  return true;
}

async function updateJobSummary(client: PoolClient, job: DurableJob): Promise<void> {
  const result = await client.query<{ status: string; applied_count: number }>(`SELECT
    CASE WHEN count(*) FILTER (WHERE i.status IN ('RECEIVED','VALIDATING','APPLYING','RETRY_PENDING'))>0 THEN 'PROCESSING'
         WHEN count(*) FILTER (WHERE i.status='QUARANTINED')=0 THEN 'SUCCEEDED'
         WHEN count(*) FILTER (WHERE i.status IN ('APPLIED','DUPLICATE','IGNORED_STALE'))>0 THEN 'PARTIAL'
         ELSE 'FAILED' END AS status,
    count(*) FILTER (WHERE i.status='APPLIED')::integer AS applied_count
    FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
    WHERE i.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3`, [job.id, job.tenant_key, job.source_id]);
  await client.query(`UPDATE control.ingestion_job SET status=$4,applied_count=$5
    WHERE id=$1 AND tenant_key=$2 AND source_id=$3 AND (status,applied_count) IS DISTINCT FROM ($4,$5)`,
  [job.id, job.tenant_key, job.source_id, result.rows[0]!.status, result.rows[0]!.applied_count]);
}

async function transaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function claimJobs(pool: Pool, limit: number, leaseMs: number): Promise<DurableClaim[]> {
  return transaction(pool, async client => {
    const candidates = await client.query<{ job_id: string; tenant_key: string; source_id: string }>(`SELECT o.job_id,j.tenant_key,j.source_id
      FROM control.ingestion_processing_outbox o JOIN control.ingestion_job j ON j.id=o.job_id
      WHERE o.acknowledged_at IS NULL AND o.available_at<=clock_timestamp()
        AND (o.claim_token IS NULL OR o.lease_expires_at<=clock_timestamp())
      ORDER BY o.available_at,o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
    const claims: DurableClaim[] = [];
    for (const row of candidates.rows) {
      const token = randomUUID();
      await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2::uuid,
        lease_expires_at=clock_timestamp()+($3::integer*interval '1 millisecond')
        WHERE job_id=$1 AND acknowledged_at IS NULL`, [row.job_id, token, leaseMs]);
      await client.query(`UPDATE control.ingestion_job SET status='PROCESSING'
        WHERE id=$1 AND tenant_key=$2 AND source_id=$3 AND status='RECEIVED'`, [row.job_id,row.tenant_key,row.source_id]);
      claims.push({ jobId: row.job_id, tenantId: row.tenant_key, sourceId: row.source_id, token });
    }
    return claims;
  });
}

async function loadJob(pool: Pool, claim: DurableClaim): Promise<DurableJob> {
  const result = await pool.query<DurableJob>(`SELECT id,tenant_key,source_id,entity,route,batch_id,credential_id::text,
    source_epoch_at_admission::text,credential_revision_at_admission::text,credential_generation_at_admission::text,
    channel_id::text,channel_epoch::text,version_domain,owner_approval_id::text,owner_user_id,owner_revision::text,
    config_revision::text,config_digest,mapping_revision::text,mapping_digest,identity_mapping_revision::text,identity_mapping_digest,
    endpoint_profile_digest,test_report_id::text,security_barrier_fence_at_admission::text
    FROM control.ingestion_job WHERE id=$1 AND tenant_key=$2 AND source_id=$3`, [claim.jobId,claim.tenantId,claim.sourceId]);
  if (!result.rowCount) throw new Error('DURABLE_JOB_SCOPE_INVALID');
  return result.rows[0];
}

async function loadItems(pool: Pool, job: DurableJob): Promise<DurableItem[]> {
  const result = await pool.query<DurableItem>(`SELECT i.ordinal,i.event_id::text,i.source_pk,i.source_version::text,i.operation,
    i.public_record,i.status,i.attempts_started::integer,i.retries_used::integer,i.next_retry_at,i.operation_id::text
    FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
    WHERE i.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3 ORDER BY i.ordinal`, [job.id,job.tenant_key,job.source_id]);
  return result.rows;
}

async function setInvalidFacts(pool: Pool, claim: DurableClaim, job: DurableJob, item: DurableItem, errorCode: string): Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    if (!await lockClaim(client, claim)) return;
    const current = await client.query<{ status: string }>(`SELECT i.status FROM control.ingestion_job_item i
      JOIN control.ingestion_job j ON j.id=i.job_id WHERE i.job_id=$1 AND i.ordinal=$4
        AND j.tenant_key=$2 AND j.source_id=$3 FOR UPDATE OF i`, [job.id,job.tenant_key,job.source_id,item.ordinal]);
    if (current.rowCount && !TERMINAL_ITEM_STATES.has(current.rows[0]!.status)) {
      await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code=$3,next_retry_at=NULL
        WHERE job_id=$1 AND ordinal=$2 AND EXISTS (SELECT 1 FROM control.ingestion_job j
          WHERE j.id=$1 AND j.tenant_key=$4 AND j.source_id=$5)`, [job.id,item.ordinal,errorCode,job.tenant_key,job.source_id]);
      await updateJobSummary(client, job);
    }
  });
}

async function startAttempt(pool: Pool, claim: DurableClaim, job: DurableJob, item: DurableItem, leaseMs: number): Promise<DurableItem | undefined> {
  return transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    if (!await lockClaim(client, claim, leaseMs)) return undefined;
    const current = await client.query<DurableItem>(`SELECT i.ordinal,i.event_id::text,i.source_pk,i.source_version::text,i.operation,
      i.public_record,i.status,i.attempts_started::integer,i.retries_used::integer,i.next_retry_at,i.operation_id::text
      FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
      WHERE i.job_id=$1 AND i.ordinal=$4 AND j.tenant_key=$2 AND j.source_id=$3 FOR UPDATE OF i`,
    [job.id,job.tenant_key,job.source_id,item.ordinal]);
    const row = current.rows[0];
    if (!row || TERMINAL_ITEM_STATES.has(row.status)) return undefined;
    if (row.next_retry_at && row.next_retry_at.getTime() > Date.now()) return undefined;
    if (row.status === 'APPLYING' && row.attempts_started >= 4) {
      await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='RETRY_BUDGET_EXHAUSTED',next_retry_at=NULL
        WHERE job_id=$1 AND ordinal=$2`, [job.id,row.ordinal]);
      await updateJobSummary(client, job);
      return undefined;
    }
    const attempts = row.attempts_started + 1;
    const delay = durableRetryDelayMs(attempts);
    const updated=await client.query<DurableItem>(`UPDATE control.ingestion_job_item SET status='APPLYING',error_code=NULL,
      attempts_started=$3,retries_used=$4,next_retry_at=CASE WHEN $5::integer IS NULL THEN NULL
        ELSE clock_timestamp()+($5::integer*interval '1 millisecond') END
      WHERE job_id=$1 AND ordinal=$2 RETURNING ordinal,event_id::text,source_pk,source_version::text,operation,
        public_record,status,attempts_started::integer,retries_used::integer,next_retry_at,operation_id::text`,
    [job.id,row.ordinal,attempts,attempts-1,delay]);
    await updateJobSummary(client, job);
    return updated.rows[0];
  });
}

async function verifyOrderCustomerReference(client: PoolClient, job: DurableJob, record: PublicRecord): Promise<boolean> {
  if (job.entity !== 'order' || record.operation === 'DELETE' || !record.data || !('customer_ref' in record.data)) return true;
  const { source_id: refSourceId, source_pk: refSourcePk } = record.data.customer_ref;
  const result = await client.query<{ mapped_target: string | null; object_id: string | null; live_customer_id: string | null }>(`SELECT
      (SELECT m.target_id::text FROM control.source_identity_mapping_revision r
        CROSS JOIN LATERAL jsonb_to_recordset(r.mappings) AS m(kind text,external_id text,target_id text)
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.revision=$3::bigint
          AND m.kind='customer' AND m.external_id=$4 LIMIT 1) AS mapped_target,
      s.canonical_object_id::text AS object_id,
      c.id::text AS live_customer_id
    FROM control.canonical_source_identity s
    LEFT JOIN hub.canonical_customer c ON c.tenant_id=s.tenant_key AND c.id=s.customer_id
      AND c.id=s.canonical_object_id AND c.deleted_at IS NULL
    WHERE s.tenant_key=$1 AND s.source_id=$5 AND s.entity='customer' AND s.source_pk=$4`,
  [job.tenant_key,job.source_id,job.identity_mapping_revision,refSourcePk,refSourceId]);
  const row = result.rows[0];
  return !!row && !!row.mapped_target && row.mapped_target === row.object_id && row.live_customer_id === row.object_id;
}

function itemOutcome(result: ApplyResult): { status: 'APPLIED'|'DUPLICATE'|'IGNORED_STALE'|'QUARANTINED'; errorCode: string | null } {
  switch(result.status) {
    case 'APPLIED': return { status:result.status,errorCode:null };
    case 'DUPLICATE': return { status:result.status,errorCode:null };
    case 'IGNORED_STALE': return { status:result.status,errorCode:null };
    case 'QUARANTINED': return { status:'QUARANTINED',errorCode:result.code };
    case 'CHANNEL_EPOCH_RETIRED': return { status:'QUARANTINED',errorCode:'CHANNEL_EPOCH_RETIRED' };
  }
}

async function recordTransientFailure(pool: Pool, claim: DurableClaim, job: DurableJob, item: DurableItem): Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT control.lock_security_barrier_fence()');
    if (!await lockClaim(client, claim)) return;
    const current = await client.query<{ status: string; attempts_started: number }>(`SELECT i.status,i.attempts_started::integer
      FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
      WHERE i.job_id=$1 AND i.ordinal=$4 AND j.tenant_key=$2 AND j.source_id=$3 FOR UPDATE OF i`,
    [job.id,job.tenant_key,job.source_id,item.ordinal]);
    const row=current.rows[0];
    if (!row || TERMINAL_ITEM_STATES.has(row.status)) return;
    const exhausted=row.attempts_started>=4;
    await client.query(`UPDATE control.ingestion_job_item SET status=$3,error_code=$4,next_retry_at=$5
      WHERE job_id=$1 AND ordinal=$2`, [job.id,item.ordinal,exhausted?'QUARANTINED':'RETRY_PENDING',
        exhausted?'RETRY_BUDGET_EXHAUSTED':'WORKER_TRANSIENT_FAILURE',exhausted?null:item.next_retry_at]);
    await updateJobSummary(client,job);
  });
}

async function applyItem(pool: Pool, claim: DurableClaim, job: DurableJob, item: DurableItem, record: PublicRecord,
  leaseMs: number, hooks: DurableWorkerHooks): Promise<void> {
  const started = await startAttempt(pool,claim,job,item,leaseMs);
  if (!started) return;
  const hookItem = { jobId:job.id,ordinal:item.ordinal,operationId:started.operation_id };
  try {
    await transaction(pool, async client => {
      await client.query('SELECT control.lock_security_barrier_fence()');
      if (!await lockClaim(client,claim,leaseMs)) throw new Error('WORKER_CLAIM_LOST');
      const current = await client.query<{ status:string; operation_id:string }>(`SELECT i.status,i.operation_id::text
        FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
        WHERE i.job_id=$1 AND i.ordinal=$4 AND j.tenant_key=$2 AND j.source_id=$3 FOR UPDATE OF i`,
      [job.id,job.tenant_key,job.source_id,item.ordinal]);
      if (current.rows[0]?.status !== 'APPLYING' || current.rows[0].operation_id !== started.operation_id) return;
      if (!(await verifyOrderCustomerReference(client,job,record))) {
        await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='IDENTITY_MAPPING_TARGET_INVALID',next_retry_at=NULL
          WHERE job_id=$1 AND ordinal=$2`,[job.id,item.ordinal]);
        await updateJobSummary(client,job);
        return;
      }
      const context=contextFor(job);
      const outcome=job.entity==='customer'
        ? await applyCustomer(client,context,canonicalCustomerInput(record))
        : await applyOrderAggregate(client,context,canonicalOrderInput(record));
      await hooks.afterCanonicalApply?.(hookItem);
      const persisted=itemOutcome(outcome);
      await hooks.beforeItemStatus?.(hookItem);
      await client.query(`UPDATE control.ingestion_job_item SET status=$3,error_code=$4,next_retry_at=NULL
        WHERE job_id=$1 AND ordinal=$2`,[job.id,item.ordinal,persisted.status,persisted.errorCode]);
      await updateJobSummary(client,job);
      await hooks.beforeItemCommit?.(hookItem);
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'WORKER_CLAIM_LOST') return;
    await hooks.onApplyError?.(error);
    await recordTransientFailure(pool,claim,job,started);
    return;
  }
  await hooks.afterItemCommit?.(hookItem);
}

async function finishClaim(pool: Pool, claim: DurableClaim, job: DurableJob): Promise<void> {
  await transaction(pool, async client => {
    const locked=await client.query(`SELECT o.id FROM control.ingestion_processing_outbox o
      JOIN control.ingestion_job j ON j.id=o.job_id WHERE o.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3
        AND o.claim_token=$4 AND o.lease_expires_at>clock_timestamp() AND o.acknowledged_at IS NULL FOR UPDATE OF o`,
    [job.id,job.tenant_key,job.source_id,claim.token]);
    if (!locked.rowCount) return;
    const states=await client.query<{ pending: number; next_retry_at: Date | null }>(`SELECT
      count(*) FILTER (WHERE i.status NOT IN ('APPLIED','DUPLICATE','IGNORED_STALE','QUARANTINED'))::integer AS pending,
      min(i.next_retry_at) FILTER (WHERE i.status IN ('RETRY_PENDING','APPLYING')) AS next_retry_at
      FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id
      WHERE i.job_id=$1 AND j.tenant_key=$2 AND j.source_id=$3`,[job.id,job.tenant_key,job.source_id]);
    if (states.rows[0]!.pending===0) {
      await client.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL
        WHERE job_id=$1 AND claim_token=$2 AND acknowledged_at IS NULL`,[job.id,claim.token]);
      return;
    }
    await client.query(`UPDATE control.ingestion_processing_outbox SET claim_token=NULL,lease_expires_at=NULL,
      available_at=COALESCE($3::timestamptz,clock_timestamp()) WHERE job_id=$1 AND claim_token=$2 AND acknowledged_at IS NULL`,
    [job.id,claim.token,states.rows[0]!.next_retry_at]);
  });
}

export async function runDurableWorkerOnce(pool: Pool, options: { limit?: number; leaseMs?: number; hooks?: DurableWorkerHooks } = {}): Promise<number> {
  const limit=options.limit ?? 10;
  const leaseMs=options.leaseMs ?? LEASE_MS;
  if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(leaseMs) || leaseMs<100) throw new Error('WORKER_OPTIONS_INVALID');
  const claims=await claimJobs(pool,limit,leaseMs);
  for (const claim of claims) {
    const job=await loadJob(pool,claim);
    await options.hooks?.afterClaim?.(claim);
    const items=await loadItems(pool,job);
    for (const item of items) {
      if (TERMINAL_ITEM_STATES.has(item.status)) continue;
      let record: PublicRecord;
      try { record=adaptRecord(job,item); }
      catch { await setInvalidFacts(pool,claim,job,item,'DURABLE_FACTS_INVALID'); continue; }
      await applyItem(pool,claim,job,item,record,leaseMs,options.hooks ?? {});
    }
    await finishClaim(pool,claim,job);
  }
  return claims.length;
}

export async function runDurableWorkerLoop(pool: Pool, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const once=environment.HUB_STRICT_INGESTION_WORKER_ONCE==='true';
  const interval=Number(environment.HUB_STRICT_INGESTION_WORKER_INTERVAL_MS ?? 1000);
  if (!Number.isInteger(interval) || interval<100 || interval>60_000) throw new Error('WORKER_OPTIONS_INVALID');
  do {
    await runDurableWorkerOnce(pool);
    if (once) return;
    await new Promise(resolve => setTimeout(resolve,interval));
  } while (true);
}

export function resolveWorkerSources(environment: NodeJS.ProcessEnv, runtime: HubRuntimeConfiguration): readonly Source[] {
  if (runtime.environmentKind !== 'local_lab' || !runtime.legacyLabEnabled) return [];
  return ([
    { name: 'crm', url: environment.CRM_DB_URL ?? '', table: 'crm_customers', kind: 'customer' },
    { name: 'orders', url: environment.ORDER_DB_URL ?? '', table: 'erp_orders', kind: 'order' },
  ] as Source[]).filter(item => item.url);
}

async function runLegacyWorker(environment: NodeJS.ProcessEnv, sources: readonly Source[], dependencies: LegacyDependencies): Promise<void> {
  const { pool, ingest, fetchOpenMetadataTable, nextRetryDelay } = dependencies;
  async function pull(source: Source) {
    const pg = await import('pg');
    const upstream = new pg.default.Pool({ connectionString: source.url, max: 1 });
    try {
      await pool.query('INSERT INTO control.etl_watermark(source_system) VALUES($1) ON CONFLICT DO NOTHING', [source.name]);
      const mark = (await pool.query('SELECT last_updated_at,last_source_id FROM control.etl_watermark WHERE source_system=$1', [source.name])).rows[0];
      const rows = await upstream.query(`SELECT * FROM ${source.table} WHERE (updated_at,source_id) > ($1::timestamptz,$2::text) ORDER BY updated_at,source_id LIMIT 100`, [mark.last_updated_at,mark.last_source_id]);
      for (const row of rows.rows) {
        const payload = source.kind === 'customer' ? {
          sourceId: row.source_id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id, version: Number(row.version),
          name: row.name, email: row.email ?? undefined, phone: row.phone ?? undefined, deleted: row.deleted ?? false,
        } : {
          sourceId: row.source_id, customerSourceId: row.customer_source_id, customerSourceSystem: 'crm', tenantId: row.tenant_id,
          ownerUserId: row.owner_user_id, version: Number(row.version), total: Number(row.total), status: row.status,
          items: row.items, deleted: row.deleted ?? false,
        };
        await ingest(source.kind, source.name, `${row.source_id}:${row.version}`, payload);
        await pool.query("UPDATE control.etl_watermark SET last_updated_at=$2,last_source_id=$3,last_status='ok',last_error=NULL,updated_at=now() WHERE source_system=$1", [source.name,row.updated_at,row.source_id]);
      }
    } catch (error) {
      await pool.query("INSERT INTO control.etl_watermark(source_system,last_status,last_error) VALUES($1,'failed',$2) ON CONFLICT(source_system) DO UPDATE SET last_status='failed',last_error=EXCLUDED.last_error,updated_at=now()", [source.name,String(error)]);
    } finally { await upstream.end(); }
  }
  async function processHooks() {
    const rows = await pool.query('SELECT id,kind,payload,attempts FROM control.hook_outbox WHERE done_at IS NULL AND next_attempt_at<=now() ORDER BY id LIMIT 20');
    for (const row of rows.rows) {
      try {
        const fqn = row.payload.kind === 'customer' ? environment.OPENMETADATA_CUSTOMER_FQN : environment.OPENMETADATA_ORDER_FQN;
        if (fqn) await fetchOpenMetadataTable(fqn);
        await pool.query('UPDATE control.hook_outbox SET done_at=now(),last_error=NULL WHERE id=$1', [row.id]);
      } catch (error) {
        await pool.query("UPDATE control.hook_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+($3::integer * interval '1 millisecond') WHERE id=$1", [row.id,String(error),nextRetryDelay(row.attempts)]);
      }
    }
  }
  const tick = async () => { for (const source of sources) await pull(source); await processHooks(); };
  await tick();
  if (environment.WORKER_ONCE === '1') { await pool.end(); return; }
  setInterval(() => { void tick(); }, Number(environment.WORKER_INTERVAL_MS ?? 15000));
}

export async function startWorker(environment: NodeJS.ProcessEnv = process.env): Promise<'not_ready' | 'local_lab' | 'strict'> {
  const runtime = readHubRuntimeConfiguration(environment);
  if (environment.HUB_ENABLE_STRICT_INGESTION_WORKER === 'true') {
    if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
    const { pool } = await import('../db.js');
    const role = await pool.query<{ current_user: string }>('SELECT current_user');
    if (role.rows[0]?.current_user !== 'hub_worker') throw new Error('WORKER_DATABASE_ROLE_INVALID');
    await runDurableWorkerLoop(pool, environment);
    return 'strict';
  }
  const sources = resolveWorkerSources(environment, runtime);
  if (!runtime.legacyLabEnabled) return 'not_ready';
  if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
  const [{ pool }, { ingest }, { fetchOpenMetadataTable }, { nextRetryDelay }] = await Promise.all([
    import('../db.js'), import('../normalization/store.js'), import('../ontology-binding/binding.js'), import('./retry.js'),
  ]);
  await runLegacyWorker(environment, sources, { pool, ingest, fetchOpenMetadataTable, nextRetryDelay });
  return 'local_lab';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = await startWorker();
  if (mode === 'not_ready') process.stdout.write('{"status":"BLOCKED","component":"worker","code":"M0_WORKER_NOT_READY"}\n');
}
