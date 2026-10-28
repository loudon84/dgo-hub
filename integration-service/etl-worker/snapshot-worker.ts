import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import { validateEndpointProfile } from '../source-registry/capability-probe.js';
import type { SecretResolver } from '../source-registry/service.js';
import {
  extractPostgresSnapshot, failClosedPostgresSourceConnectionFactory, type PostgresSourceConnectionFactory,
  type SnapshotPage, type SourceEgressPolicy, SnapshotSourceError,
} from './postgres-snapshot-connector.js';
import { createSnapshotStageStore, expectedSnapshotRelations, snapshotManifestDigest } from './snapshot-stage-store.js';
import { admitDueSnapshotRun } from './snapshot-runs.js';

type SnapshotPageReceipt = Readonly<Pick<SnapshotPage,'entity'|'relation'|'page_no'|'first_key'|'last_key'|'page_digest'> & { row_count:number }>;
const DUE_ADMISSION_DENIALS = new Set(['SOURCE_CONFLICT','SOURCE_NOT_FOUND','SOURCE_CONTRACT_INVALID']);

export function snapshotPageReceiptMetadata(page:SnapshotPage):SnapshotPageReceipt {
  return Object.freeze({entity:page.entity,relation:page.relation,page_no:page.page_no,first_key:page.first_key,last_key:page.last_key,
    page_digest:page.page_digest,row_count:page.rows.length});
}

export type SnapshotWorkerDependencies = Readonly<{
  secretResolver: SecretResolver;
  sourceConnectionFactory?: PostgresSourceConnectionFactory;
  egressPolicy: SourceEgressPolicy;
  pageSize?: number;
  leaseSeconds?: number;
}>;

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT control.lock_security_barrier_fence()');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function availableSources(pool: Pool, limit: number): Promise<Array<{ tenant_key: string; source_id: string }>> {
  return transaction(pool, async client => {
    const result = await client.query<{ tenant_key: string; source_id: string }>(`SELECT tenant_key,source_id FROM control.etl_run
      WHERE status IN ('QUEUED','SCANNING') AND snapshot_available_at<=clock_timestamp()
        AND (snapshot_claim_token IS NULL OR snapshot_lease_expires_at<=clock_timestamp())
      ORDER BY created_at,run_id LIMIT $1`, [limit]);
    return result.rows;
  });
}

async function dueSchedules(pool:Pool,limit:number):Promise<Array<{tenant_key:string;source_id:string}>> {
  return transaction(pool,async client=>{
    const result=await client.query<{tenant_key:string;source_id:string}>(`SELECT tenant_key,source_id FROM control.etl_snapshot_schedule
      WHERE enabled AND next_due_at<=clock_timestamp() AND active_run_id IS NULL ORDER BY next_due_at,tenant_key,source_id LIMIT $1`,[limit]);
    return result.rows;
  });
}

function errorCode(error: unknown): string {
  if (error instanceof SnapshotSourceError) return error.code;
  if (error instanceof Error && /^SNAPSHOT_[A-Z0-9_:-]{1,90}$/.test(error.message)) return error.message;
  if (typeof error === 'object' && error !== null && 'code' in error && String(error.code) === '23505') return 'SNAPSHOT_DUPLICATE_KEY';
  return 'SNAPSHOT_INTERNAL_FAILURE';
}
function retryable(error: unknown): boolean {
  return error instanceof SnapshotSourceError && error.code === 'SNAPSHOT_SOURCE_UNAVAILABLE';
}

export async function runSnapshotWorkerOnce(pool: Pool, dependencies: SnapshotWorkerDependencies, options: { limit?: number } = {}): Promise<number> {
  const limit = options.limit ?? 10;
  const leaseSeconds = dependencies.leaseSeconds ?? 60;
  const pageSize = dependencies.pageSize ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 900)
    throw new Error('SNAPSHOT_WORKER_OPTIONS_INVALID');
  const store = createSnapshotStageStore(pool);
  for (const schedule of await dueSchedules(pool,limit)) {
    try { await admitDueSnapshotRun(pool,schedule.tenant_key,schedule.source_id); }
    catch (error) {
      if (!(error instanceof AuthError) || !DUE_ADMISSION_DENIALS.has(error.code)) throw error;
      console.warn('snapshot due admission denied', { event:'snapshot_due_admission_denied',tenant_key:schedule.tenant_key,
        source_id:schedule.source_id,code:error.code });
    }
  }
  const candidates = await availableSources(pool, limit);
  let claimed = 0;
  for (const source of candidates) {
    const claim = await store.claim(source.tenant_key, source.source_id, leaseSeconds);
    if (!claim) continue;
    claimed += 1;
    let attemptId: string | undefined;
    let stopped = false;
    let leaseLost = false;
    const abort = new AbortController();
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const attempt = await store.beginAttempt(source.tenant_key, source.source_id, claim.run_id, claim.claim_token, leaseSeconds);
      attemptId = attempt.attempt_id;
      const proof = await store.loadFrozenProof(source.tenant_key, source.source_id, claim.run_id);
      if(proof.recovery_mode==='SEALED_STAGE') {
        await store.copySealedStage(source.tenant_key,source.source_id,claim.run_id,attempt.attempt_id,claim.claim_token,attempt.operation_id);
        continue;
      }
      const profile = proof.endpoint_profile;
      validateEndpointProfile(proof.config, profile, { environmentKind: dependencies.egressPolicy.environmentKind });
      const password = await dependencies.secretResolver.resolve(proof.config.secret_ref);
      if (typeof password !== 'string' || password.length < 1) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
      const pages: SnapshotPageReceipt[] = [];
      const stopHeartbeat = () => { stopped = true; if (heartbeat) clearInterval(heartbeat); };
      heartbeat = setInterval(() => {
        if (stopped) return;
        void store.heartbeat(source.tenant_key, source.source_id, claim.run_id, attempt.attempt_id, claim.claim_token, leaseSeconds)
          .then(ok => { if (!ok) { leaseLost = true; abort.abort(); } })
          .catch(() => { leaseLost = true; abort.abort(); });
      }, Math.max(2_000, Math.floor(leaseSeconds * 1000 / 3)));
      const scan = await extractPostgresSnapshot({ factory: dependencies.sourceConnectionFactory ?? failClosedPostgresSourceConnectionFactory,
        policy: dependencies.egressPolicy, profile, config: proof.config, password, mappings: proof.mappings, pageSize,
        signal: abort.signal,
        onPage: async page => {
          if (leaseLost) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
          await store.writePage(source.tenant_key, source.source_id, claim.run_id, attempt.attempt_id, claim.claim_token, page);
          pages.push(snapshotPageReceiptMetadata(page));
        } });
      stopHeartbeat();
      if (leaseLost) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
      const relations = expectedSnapshotRelations(proof.expected_entities);
      const relationCounts = relations.map(relation => ({ relation, row_count: scan.relation_counts[relation],
        page_count: pages.filter(page => page.relation === relation).length,
        page_digests: pages.filter(page => page.relation === relation).map(page => page.page_digest) }));
      const manifest: Record<string, unknown> = { state: 'EXTRACTED', relations, relation_counts: relationCounts,
        row_count: scan.row_count, page_count: scan.page_count, source_snapshot_identity: scan.snapshot_identity,
        attempt_id: attempt.attempt_id, operation_id: attempt.operation_id, profile_digest: proof.endpoint_profile_digest,
        mapping_digest: proof.mapping_digest, config_digest: proof.config_digest,
        identity_mapping_digest: proof.identity_mapping_digest };
      await store.complete(source.tenant_key, source.source_id, claim.run_id, attempt.attempt_id, claim.claim_token,
        manifest, snapshotManifestDigest(manifest));
    } catch (error) {
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      if (attemptId) await store.fail(source.tenant_key, source.source_id, claim.run_id, attemptId, claim.claim_token,
        errorCode(error), retryable(error)).catch(() => 'STALE');
    } finally {
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  return claimed;
}
