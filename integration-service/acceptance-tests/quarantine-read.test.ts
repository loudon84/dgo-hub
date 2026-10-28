import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import type { UserPrincipal } from '../auth/types.js';
import { createOidcAuthenticator } from '../auth/oidc.js';
import { createCredential } from '../auth/credentials.js';
import { runMigrations } from '../migrations/runner.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { quarantineContextDigest, quarantineContextJson, type QuarantineContext } from '../ingestion-api/quarantine-read.js';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';
import { createSourceRegistryService } from '../source-registry/service.js';
import { createSnapshotRun } from '../etl-worker/snapshot-runs.js';
import { runSnapshotWorkerOnce } from '../etl-worker/snapshot-worker.js';
import { runSnapshotContinuationWorkerOnce } from '../etl-worker/snapshot-apply-worker.js';
import type { PostgresSourceConnectionFactory } from '../etl-worker/postgres-snapshot-connector.js';

const taskEvidenceRoot = process.env.M0_RUN_EVIDENCE_ROOT;
if (!taskEvidenceRoot || !/^E:\\m1t5-runtime\\[0-9a-f-]{36}$/i.test(taskEvidenceRoot)) {
  throw new Error('QUARANTINE_READ_TEST_EVIDENCE_ROOT_REQUIRED');
}

const migrationsDirectory = new URL('../migrations/', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:');
const tenantId = 'm1q_read_tenant';
const sourceId = 'crm-quarantine-read';
const ownerId = 'm1q-owner';
const audience = 'dgo-hub-test';
const subject = 'owner-subject';
const keyId = 'm1-quarantine-test-key';
let fixture: OwnedPostgres;
let apiPool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let jwksServer: Server;
let token: string;
let sourceBearer: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let controlledIssuer: string;
let controlledAudience: string;

function descendingTuple(left: { created_at: string; quarantine_id: string }, right: { created_at: string; quarantine_id: string }): boolean {
  return left.created_at > right.created_at || (left.created_at === right.created_at && left.quarantine_id > right.quarantine_id);
}

function sha(value: string): Buffer { return createHash('sha256').update(value).digest(); }

async function seedMixedOrigins(): Promise<void> {
  const proof = await fixture.pool.query<{ owner_revision: string; credential_id: string; credential_revision: string;
    credential_generation: string; source_epoch: string }>(`SELECT r.owner_revision::text,c.id::text AS credential_id,
      c.revision::text AS credential_revision,c.credential_generation::text,c.source_epoch::text
      FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
      WHERE r.tenant_key=$1 AND r.source_id=$2`, [tenantId, sourceId]);
  const ownerRevision = proof.rows[0]!.owner_revision;
  const credential = proof.rows[0]!;
  const config = { name: 'quarantine fixture', connector: 'rest', mode: 'INCREMENTAL', version_domain: 'SOURCE_VERSION',
    allowed_entities: ['customer', 'order'], endpoint_allowlist_ref: 'fixture', secret_ref: 'vault:/fixture', delete_contract: 'tombstone' };
  const mappings = [{ entity: 'customer', source_field: 'customer_name', target_field: 'customer_name', transform: 'trim' },
    { entity: 'order', source_field: 'order_no', target_field: 'order_no', transform: 'trim' }];
  const identityMappings = [{ kind: 'user', external_id: 'owner', target_id: ownerId }];
  const configDigest = sha(JSON.stringify(config)); const mappingDigest = sha(JSON.stringify(mappings));
  const identityDigest = sha(JSON.stringify(identityMappings)); const endpointDigest = sha('fixture endpoint profile');
  await fixture.pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,$5)`, [tenantId, sourceId, configDigest, config, ownerId]);
  await fixture.pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,$5)`, [tenantId, sourceId, mappingDigest, JSON.stringify(mappings), ownerId]);
  await fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,$5)`, [tenantId, sourceId, identityDigest, JSON.stringify(identityMappings), ownerId]);
  const report = await fixture.pool.query<{ id: string }>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,
    mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
    credential_generation,endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,$6,$7,$8,'fixture','{}','PASS',$9) RETURNING id::text`,
    [tenantId, sourceId, configDigest, mappingDigest, identityDigest, credential.credential_revision,
      credential.credential_generation, endpointDigest, ownerId]);
  const approval = await fixture.pool.query<{ id: string }>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,
    owner_revision,config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,
    source_credential_revision,credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,$3,$4,1,1,1,$5,$6,$7,$8,$9,$10,'fixture',$11) RETURNING id::text`,
    [tenantId, sourceId, ownerId, ownerRevision, configDigest, mappingDigest, identityDigest, credential.credential_revision,
      credential.credential_generation, endpointDigest, report.rows[0]!.id]);
  for (const entity of ['customer', 'order']) await fixture.pool.query(`INSERT INTO control.source_channel
    (tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
    VALUES($1,$2,$3,'rest','INCREMENTAL','SOURCE_VERSION',1,'active')`, [tenantId, sourceId, entity]);
  const channels = await fixture.pool.query<{ entity: string; id: string }>(`SELECT entity,id::text FROM control.source_channel
    WHERE tenant_key=$1 AND source_id=$2 ORDER BY entity`, [tenantId, sourceId]);

  const rawId = randomUUID(); const jobId = randomUUID(); const batchId = randomUUID();
  await fixture.pool.query(`INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes)
    VALUES($1,$2,$3,'/hub/v1/ingest/crm/customers',$4)`, [rawId, tenantId, sourceId, Buffer.from('{}')]);
  await fixture.pool.query(`INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,
    request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,
    credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,
    approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
    endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
    VALUES($1,$2,$3,'customer','/hub/v1/ingest/crm/customers',$4,$5,$6,$7,'RECEIVED',12,0,$8,$9,$10,$11,$12,1,
      'SOURCE_VERSION',$13,$14,$15,0,1,$16,1,$17,1,$18,$19,$20,$21,'2026-10-27T00:00:00Z','2026-10-27T00:00:00Z')`,
    [jobId, tenantId, sourceId, batchId, rawId, `quarantine-${jobId}`, sha(jobId), credential.credential_id,
      credential.source_epoch, credential.credential_revision, credential.credential_generation,
      channels.rows.find(row => row.entity === 'customer')!.id, approval.rows[0]!.id, ownerId, ownerRevision,
      configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id, 0]);
  await fixture.pool.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)', [jobId]);
  for (let ordinal = 0; ordinal < 12; ordinal++) {
    const eventId = randomUUID();
    await fixture.pool.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,
      source_updated_at,public_record,status) VALUES($1,$2,$3,$4,1,'UPSERT','2026-10-27T00:00:00Z','{}','RECEIVED')`,
      [jobId, ordinal, eventId, `REST-C-${String(ordinal).padStart(2, '0')}`]);
  }
  const workerPool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,
    options: '-c role=hub_worker', max: 2 });
  try { await runDurableWorkerOnce(workerPool, { limit: 20 }); } finally { await workerPool.end(); }
  const restRows = await fixture.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM control.ingestion_quarantine_index
    WHERE tenant_key=$1 AND source_id=$2 AND origin_kind='REST'`, [tenantId, sourceId]);
  if (restRows.rows[0]!.count !== 12) throw new Error(`REST_QUARANTINE_CAPTURE_COUNT:${restRows.rows[0]!.count}`);

  const runId = randomUUID(); const attemptId = randomUUID(); const snapshotProof = Buffer.from(sha('snapshot proof'));
  const semanticDigest = sha('snapshot semantic'); const manifestDigest = sha('snapshot manifest');
  const sourceIdentity = sha('snapshot source identity').toString('hex');
  const snapshotCredential = credential;
  const channelsProof = Object.fromEntries(channels.rows.map(row => [row.entity, { id: row.id, epoch: '1' }]));
  await fixture.pool.query(`INSERT INTO control.etl_run(run_id,tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,
    request_digest,status,credential_id,credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,
    entity_channel_proof,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
    endpoint_profile_digest,test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,owner_revision)
    VALUES($1,$2,$3,'FULL_SNAPSHOT','MANUAL','API-019',$4,$5,'FAILED',$6,$7,$8,$9,$9,ARRAY['customer','order']::text[],$10,
      1,$11,1,$12,1,$13,$14,$15,$16,'fixture','tombstone',0,$17,$18)`,
    [runId, tenantId, sourceId, `seed-${runId}`, sha(runId), snapshotCredential.credential_id, snapshotCredential.credential_revision,
      snapshotCredential.credential_generation, snapshotCredential.source_epoch, channelsProof, configDigest, mappingDigest, identityDigest,
      endpointDigest, report.rows[0]!.id, approval.rows[0]!.id, ownerId, ownerRevision]);
  await fixture.pool.query(`INSERT INTO control.etl_run_attempt(attempt_id,tenant_key,source_id,run_id,ordinal,operation_id,status,source_snapshot_identity)
    VALUES($1,$2,$3,$4,1,$5,'FAILED',$6)`, [attemptId, tenantId, sourceId, runId, randomUUID(), sourceIdentity]);
  await fixture.pool.query(`INSERT INTO control.etl_snapshot_manifest(tenant_key,source_id,run_id,attempt_id,state,manifest,
    manifest_digest,source_snapshot_identity) VALUES($1,$2,$3,$4,'EXTRACTED',$5,$6,$7)`,
    [tenantId, sourceId, runId, attemptId, { source_snapshot_identity: sourceIdentity }, manifestDigest, sourceIdentity]);
  for (const entity of ['customer', 'order']) {
    const count = 6;
    await fixture.pool.query(`INSERT INTO control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,
      row_count,first_key,last_key,page_digest) VALUES($1,$2,$3,$4,$5,$5,1,$6,$7,$8,$9)`,
      [tenantId, sourceId, runId, attemptId, entity, count, `${entity}-00`, `${entity}-05`, sha(`${entity}-page`)]);
    for (let n = 0; n < count; n++) await fixture.pool.query(`INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,
      attempt_id,entity,relation,parent_source_pk,source_pk,page_no,row_ordinal,source_version,facts)
      VALUES($1,$2,$3,$4,$5,$5,'',$6,1,$7,'1','{}')`,
      [tenantId, sourceId, runId, attemptId, entity, `${entity}-${String(n).padStart(2, '0')}`, n + 1]);
  }
  await fixture.pool.query(`INSERT INTO control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id,manifest_digest,
    proof_scope_digest,semantic_digest,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
    [tenantId, sourceId, runId, attemptId, manifestDigest, snapshotProof, semanticDigest]);
  const fixedTimestamp = '2026-10-26T10:00:00.123456Z';
  for (const entity of ['customer', 'order']) for (let n = 0; n < 6; n++) {
    const sourcePk = `${entity}-${String(n).padStart(2, '0')}`;
    const aggregate = sha(`${entity}-${sourcePk}`);
    const storedError = entity === 'customer' && n === 0 ? 'provider text that must stay private' :
      entity === 'customer' && n === 1 ? 'SNAPSHOT_BLOCKED:SAFE' :
      entity === 'customer' && n === 2 ? `PROVIDER_${'X'.repeat(110)}` : null;
    const outcome = await fixture.pool.query<{ outcome_id: string }>(`INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,
      run_id,attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,status,error_code,created_at)
      VALUES($1,$2,$3,$4,$5,$5,'',$6,$7,'QUARANTINED',$8,$9::timestamptz) RETURNING outcome_id::text`,
      [tenantId, sourceId, runId, attemptId, entity, sourcePk, aggregate, storedError, fixedTimestamp]);
    await fixture.pool.query(`INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,
      parent_source_pk,source_pk,aggregate_digest,proof_scope_digest,outcome_id,committed_at)
      VALUES($1,$2,$3,$4,$5,$5,'',$6,$7,$8,$9,$10::timestamptz)`,
      [tenantId, sourceId, runId, attemptId, entity, sourcePk, aggregate, snapshotProof, outcome.rows[0]!.outcome_id, fixedTimestamp]);
  }
}

async function runRealSnapshotQuarantine(): Promise<void> {
  const cSourceId = 'crm-quarantine-c-capture';
  const ownerAuth = createAuthService({ pool: fixture.pool });
  const ownerPrincipal: UserPrincipal = { userId: ownerId, tenantId, departmentId: 'sales-east', businessRole: 'sales',
    managementScopes: ['source:read', 'source:write', 'source:approve', 'mapping:write'] as const,
    authEpoch: '0', businessTimezone: 'UTC', issuer: controlledIssuer, subject };
  const remapUserId = 'm1q-remap-owner';
  await ownerAuth.repository.updateSubject({ tenantId, userId: ownerId, departmentId: 'sales-east', businessRole: 'sales',
    managementScopes: ownerPrincipal.managementScopes });
  await ownerAuth.repository.provisionSubject({ tenantId, userId: remapUserId, departmentId: 'sales-east', businessRole: 'sales',
    managementScopes: ['source:read'] });
  const endpointProfile = { revision: 'quarantine-c-v1', connector: 'postgresql' as const, protocol: 'postgres:' as const,
    host: '127.0.0.1', port: 5432, allow_loopback_plaintext: true, database: 'postgres', user: 'fixture_reader', schema: 'public',
    entities: { customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at', version_field: 'source_version',
      delete_field: 'deleted_at' } } };
  const secretRef = 'vault:/fixture/quarantine-c';
  const sourceService = createSourceRegistryService({ pool: fixture.pool, auth: ownerAuth, environmentKind: 'local_lab',
    secretResolver: { isConfiguredReference: async value => value === secretRef, resolve: async () => 'fixture-password' },
    endpointAllowlist: { resolve: async reference => reference === 'quarantine-c-profile' ? endpointProfile : Promise.reject(new Error('PROFILE_NOT_ALLOWED')) },
    capabilityProbe: { run: async () => ({ passed: true, checks: ['PROFILE_VALID', 'MAPPING_VALID', 'VERSION_DELETE_CONTRACT_VALID'] }) } });
  await ownerAuth.repository.provisionSourceCredential({ tenantId, sourceId: cSourceId, token: createCredential().secret,
    secretRef, allowedEntities: ['customer'], revision: '1' });
  await sourceService.create(ownerPrincipal, { source_id: cSourceId, data_owner_user_id: ownerId, config: {
    name: 'C quarantine capture', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SOURCE_VERSION',
    endpoint_allowlist_ref: 'quarantine-c-profile', secret_ref: secretRef, allowed_entities: ['customer'], delete_contract: 'tombstone' } });
  await sourceService.writeMappings(ownerPrincipal, cSourceId, '1', [
    { entity: 'customer', source_field: 'customer_name', target_field: 'customer_name', transform: 'trim' },
    { entity: 'customer', source_field: 'owner_id', target_field: 'owner_user_id', transform: 'source-id' },
    { entity: 'customer', source_field: 'department_id', target_field: 'dept_id', transform: 'source-id' },
    { entity: 'customer', source_field: 'status', target_field: 'status', transform: 'identity' },
  ]);
  await sourceService.writeIdentityMappings(ownerPrincipal, cSourceId, [
    { kind: 'user', external_id: 'owner-ext', target_id: ownerId },
    { kind: 'department', external_id: 'dept-ext', target_id: 'sales-east' },
  ]);
  const report = await sourceService.test(ownerPrincipal, cSourceId, '1');
  expect(report.status).toBe('PASS');
  const approval = await sourceService.approve(ownerPrincipal, cSourceId, '1', report.test_report_id, report.data_contract_ref);
  await sourceService.activate(ownerPrincipal, cSourceId, '1', approval.approval_id);
  const run = await createSnapshotRun(apiPool, createAuthService({ pool: apiPool }), ownerPrincipal, cSourceId, '1', 'real-c-quarantine');
  const sourceConnectionFactory: PostgresSourceConnectionFactory = { connect: async () => {
    let fetched = false;
    return { query: async sql => {
      if (sql.startsWith('SELECT pg_current_snapshot()')) return { rows: [{ snapshot_text: '10:10:' }] };
      if (sql.startsWith('FETCH')) {
        if (fetched) return { rows: [] };
        fetched = true;
        return { rows: [
          { c0: 'C-1', c1: 'First customer', c2: 'owner-ext', c3: 'dept-ext', c4: 'ACTIVE', c5: '2026-10-27T00:00:00.123456Z', c6: '1', c7: null },
          { c0: 'C-2', c1: 'Second customer', c2: 'owner-ext', c3: 'dept-ext', c4: 'ACTIVE', c5: '2026-10-27T00:00:01.123456Z', c6: '1', c7: null },
        ] };
      }
      return { rows: [] };
    }, cancel: async () => undefined, close: async () => undefined };
  } };
  const workerPool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,
    options: '-c role=hub_worker', max: 2 });
  try {
    const dependencies = { secretResolver: { isConfiguredReference: async () => true, resolve: async () => 'fixture-password' },
      sourceConnectionFactory, egressPolicy: { environmentKind: 'local_lab' as const, policyId: 'quarantine-c-fixture' }, pageSize: 10 };
    expect(await runSnapshotWorkerOnce(workerPool, dependencies)).toBeGreaterThan(0);
    let remapped = false;
    expect(await runSnapshotContinuationWorkerOnce(workerPool, 20, 60, { afterAggregateCommit: async item => {
      if (remapped || item.run_id !== run.run_id || item.entity !== 'customer' || item.source_pk !== 'C-1') return;
      remapped = true;
      await sourceService.updateIdentityMapping(ownerPrincipal, Buffer.from(`${cSourceId}\0user\0owner-ext`, 'utf8').toString('base64url'),
        '1', remapUserId, 'confirm current owner after first snapshot aggregate commit');
    } })).toBe(1);
    expect(remapped).toBe(true);
  } finally { await workerPool.end(); }
  const cOutcome = await fixture.pool.query<{ status: string; error_code: string | null; indexed: number }>(`SELECT o.status,o.error_code,
    (SELECT count(*)::int FROM control.ingestion_quarantine_index i WHERE i.outcome_id=o.outcome_id) AS indexed
    FROM control.etl_snapshot_apply_outcome o WHERE o.run_id=$1 AND o.source_pk='C-2'`, [run.run_id]);
  expect(cOutcome.rows).toEqual([{ status: 'QUARANTINED', error_code: 'AUTHORITY_MAPPING_SUPERSEDED', indexed: 1 }]);
}

async function seedPreIndexSnapshot(pool: pg.Pool, preIndexTenant: string, preIndexSource: string): Promise<string> {
  const auth = createAuthService({ pool });
  await auth.repository.provisionTenant({ tenantId: preIndexTenant, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: preIndexTenant, userId: 'preindex-owner', managementScopes: ['source:read'] });
  await auth.repository.provisionSourceCredential({ tenantId: preIndexTenant, sourceId: preIndexSource,
    token: createCredential().secret, secretRef: 'vault:/preindex/source', allowedEntities: ['customer'], revision: '1' });
  await pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
    VALUES($1,$2,'ACTIVE','preindex-owner')`, [preIndexTenant, preIndexSource]);
  const config = { name: 'pre-index', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
    endpoint_allowlist_ref: 'pre-index', secret_ref: 'vault:/preindex/source', allowed_entities: ['customer'], delete_contract: 'hard_delete' };
  const configDigest = sha(JSON.stringify(config)); const mappingDigest = sha('pre-index-mapping');
  const identityDigest = sha('pre-index-identity'); const endpointDigest = sha('pre-index-endpoint');
  await pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,'preindex-owner')`, [preIndexTenant, preIndexSource, configDigest, config]);
  await pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]','preindex-owner')`, [preIndexTenant, preIndexSource, mappingDigest]);
  await pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]','preindex-owner')`, [preIndexTenant, preIndexSource, identityDigest]);
  const credential = await pool.query<{ id: string }>(`SELECT id::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2`,
    [preIndexTenant, preIndexSource]);
  const report = await pool.query<{ id: string }>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
    identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
    endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,1,1,$6,'pre-index','{}','PASS','preindex-owner') RETURNING id::text`,
    [preIndexTenant, preIndexSource, configDigest, mappingDigest, identityDigest, endpointDigest]);
  const approval = await pool.query<{ id: string }>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
    config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
    credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,'preindex-owner',1,1,1,1,$3,$4,$5,1,1,$6,'pre-index',$7) RETURNING id::text`,
    [preIndexTenant, preIndexSource, configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id]);
  const channel = await pool.query<{ id: string }>(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,
    channel_epoch,state) VALUES($1,$2,'customer','postgresql','FULL_SNAPSHOT','SNAPSHOT_OBSERVATION',1,'active') RETURNING id::text`,
    [preIndexTenant, preIndexSource]);
  const credentialFact = await pool.query<{ revision: string; generation: string; source_epoch: string }>(`SELECT revision::text,
    credential_generation::text AS generation,source_epoch::text FROM control.source_credential WHERE id=$1`, [credential.rows[0]!.id]);
  const runId = randomUUID(); const attemptId = randomUUID(); const manifestDigest = sha('pre-index-manifest');
  const scopeDigest = sha('pre-index-scope'); const semanticDigest = sha('pre-index-semantic'); const aggregate = sha('pre-index-aggregate');
  const sourceIdentity = sha('pre-index-source-identity').toString('hex');
  await pool.query(`INSERT INTO control.etl_run(run_id,tenant_key,source_id,run_mode,request_kind,request_route,idempotency_key,request_digest,
    status,credential_id,credential_revision,credential_generation,source_epoch,admission_source_epoch,expected_entities,entity_channel_proof,
    config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,endpoint_profile_digest,
    test_report_id,approval_id,data_contract_ref,delete_contract,security_barrier_fence,owner_user_id,owner_revision)
    VALUES($1,$2,$3,'FULL_SNAPSHOT','MANUAL','API-019',$4,$5,'FAILED',$6,$7,$8,$9,$9,ARRAY['customer']::text[],$10,
      1,$11,1,$12,1,$13,$14,$15,$16,'pre-index','hard_delete',0,'preindex-owner',1)`,
    [runId, preIndexTenant, preIndexSource, `pre-${runId}`, sha(runId), credential.rows[0]!.id, credentialFact.rows[0]!.revision,
      credentialFact.rows[0]!.generation, credentialFact.rows[0]!.source_epoch, { customer: { id: channel.rows[0]!.id, epoch: '1' } },
      configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id, approval.rows[0]!.id]);
  await pool.query(`INSERT INTO control.etl_run_attempt(attempt_id,tenant_key,source_id,run_id,ordinal,operation_id,status,source_snapshot_identity)
    VALUES($1,$2,$3,$4,1,$5,'FAILED',$6)`, [attemptId, preIndexTenant, preIndexSource, runId, randomUUID(), sourceIdentity]);
  await pool.query(`INSERT INTO control.etl_snapshot_stage_page(tenant_key,source_id,run_id,attempt_id,entity,relation,page_no,row_count,
    first_key,last_key,page_digest) VALUES($1,$2,$3,$4,'customer','customer',1,1,'PRE-C-1','PRE-C-1',$5)`,
    [preIndexTenant, preIndexSource, runId, attemptId, sha('pre-index-page')]);
  await pool.query(`INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,
    source_pk,page_no,row_ordinal,source_version,facts) VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',1,1,'1','{}')`,
    [preIndexTenant, preIndexSource, runId, attemptId]);
  await pool.query(`INSERT INTO control.etl_snapshot_manifest(tenant_key,source_id,run_id,attempt_id,state,manifest,manifest_digest,
    source_snapshot_identity) VALUES($1,$2,$3,$4,'EXTRACTED',$5,$6,$7)`,
    [preIndexTenant, preIndexSource, runId, attemptId, { source_snapshot_identity: sourceIdentity }, manifestDigest, sourceIdentity]);
  await pool.query(`INSERT INTO control.etl_snapshot_validation(tenant_key,source_id,run_id,attempt_id,manifest_digest,proof_scope_digest,
    semantic_digest,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
    [preIndexTenant, preIndexSource, runId, attemptId, manifestDigest, scopeDigest, semanticDigest]);
  const outcome = await pool.query<{ outcome_id: string }>(`INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,run_id,
    attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,status,error_code,created_at)
    VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',$5,'QUARANTINED','PREINDEX_BLOCKED','2026-10-25T00:00:00.123456Z') RETURNING outcome_id::text`,
    [preIndexTenant, preIndexSource, runId, attemptId, aggregate]);
  await pool.query(`INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,
    source_pk,aggregate_digest,proof_scope_digest,outcome_id,committed_at)
    VALUES($1,$2,$3,$4,'customer','customer','','PRE-C-1',$5,$6,$7,'2026-10-25T00:00:00.123456Z')`,
    [preIndexTenant, preIndexSource, runId, attemptId, aggregate, scopeDigest, outcome.rows[0]!.outcome_id]);
  return outcome.rows[0]!.outcome_id;
}

async function seedPre009RestQuarantine(pool: pg.Pool, pre009Tenant: string, pre009Source: string): Promise<{
  jobId: string; eventId: string; sourcePk: string;
}> {
  const auth = createAuthService({ pool });
  await auth.repository.provisionTenant({ tenantId: pre009Tenant, businessTimezone: 'UTC' });
  await auth.repository.provisionSubject({ tenantId: pre009Tenant, userId: 'pre009-owner', managementScopes: ['source:read'] });
  await auth.repository.provisionSourceCredential({ tenantId: pre009Tenant, sourceId: pre009Source,
    token: createCredential().secret, secretRef: 'vault:/pre009/rest', allowedEntities: ['customer'], revision: '1' });
  await pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
    VALUES($1,$2,'ACTIVE','pre009-owner')`, [pre009Tenant, pre009Source]);
  const config = { name: 'Pre-009 REST', connector: 'rest', mode: 'INCREMENTAL', version_domain: 'SOURCE_VERSION',
    endpoint_allowlist_ref: 'pre009', secret_ref: 'vault:/pre009/rest', allowed_entities: ['customer'], delete_contract: 'tombstone' };
  const mappings = [{ entity: 'customer', source_field: 'name', target_field: 'customer_name', transform: 'trim' }];
  const identities = [{ kind: 'user', external_id: 'pre009-owner', target_id: 'pre009-owner' }];
  const configDigest = sha(JSON.stringify(config)); const mappingDigest = sha(JSON.stringify(mappings));
  const identityDigest = sha(JSON.stringify(identities)); const endpointDigest = sha('pre009-rest-endpoint');
  await pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, configDigest, config]);
  await pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, mappingDigest, JSON.stringify(mappings)]);
  await pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'pre009-owner')`, [pre009Tenant, pre009Source, identityDigest, JSON.stringify(identities)]);
  const credential = await pool.query<{ id: string; revision: string; credential_generation: string; source_epoch: string }>(`SELECT id::text,
    revision::text,credential_generation::text,source_epoch::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2`,
    [pre009Tenant, pre009Source]);
  const channel = await pool.query<{ id: string }>(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,
    channel_epoch,state) VALUES($1,$2,'customer','rest','INCREMENTAL','SOURCE_VERSION',1,'active') RETURNING id::text`,
    [pre009Tenant, pre009Source]);
  const report = await pool.query<{ id: string }>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
    identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
    endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,$6,$7,$8,'pre009','{}','PASS','pre009-owner') RETURNING id::text`,
    [pre009Tenant, pre009Source, configDigest, mappingDigest, identityDigest, credential.rows[0]!.revision,
      credential.rows[0]!.credential_generation, endpointDigest]);
  const approval = await pool.query<{ id: string }>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
    config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
    credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,'pre009-owner',1,1,1,1,$3,$4,$5,$6,$7,$8,'pre009',$9) RETURNING id::text`,
    [pre009Tenant, pre009Source, configDigest, mappingDigest, identityDigest, credential.rows[0]!.revision,
      credential.rows[0]!.credential_generation, endpointDigest, report.rows[0]!.id]);
  const rawBatchId = randomUUID(); const batchId = randomUUID(); const jobId = randomUUID(); const eventId = randomUUID();
  const sourcePk = 'PRE009-REST-C-1'; const updatedAt = '2026-10-25T00:00:00.123456Z';
  await pool.query(`INSERT INTO raw.ingestion_batch(id,tenant_key,source_id,route,body_bytes)
    VALUES($1,$2,$3,'/hub/v1/ingest/crm/customers',$4)`, [rawBatchId, pre009Tenant, pre009Source, Buffer.from('{}')]);
  await pool.query(`INSERT INTO control.ingestion_job(id,tenant_key,source_id,entity,route,batch_id,raw_batch_id,idempotency_key,
    request_digest,status,received_count,applied_count,credential_id,source_epoch_at_admission,credential_revision_at_admission,
    credential_generation_at_admission,channel_id,channel_epoch,version_domain,owner_approval_id,owner_user_id,owner_revision,
    approval_security_fence,config_revision,config_digest,mapping_revision,mapping_digest,identity_mapping_revision,identity_mapping_digest,
    endpoint_profile_digest,test_report_id,security_barrier_fence_at_admission,first_source_updated_at,last_source_updated_at)
    VALUES($1,$2,$3,'customer','/hub/v1/ingest/crm/customers',$4,$5,$6,$7,'RECEIVED',1,0,$8,$9,$10,$11,$12,1,
      'SOURCE_VERSION',$13,'pre009-owner',1,0,1,$14,1,$15,1,$16,$17,$18,0,$19,$19)`,
    [jobId, pre009Tenant, pre009Source, batchId, rawBatchId, `pre009-${jobId}`, sha(jobId), credential.rows[0]!.id,
      credential.rows[0]!.source_epoch, credential.rows[0]!.revision, credential.rows[0]!.credential_generation, channel.rows[0]!.id,
      approval.rows[0]!.id, configDigest, mappingDigest, identityDigest, endpointDigest, report.rows[0]!.id, updatedAt]);
  await pool.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)', [jobId]);
  await pool.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,
    public_record,status) VALUES($1,0,$2,$3,1,'UPSERT',$4,'{}','RECEIVED')`, [jobId, eventId, sourcePk, updatedAt]);
  await pool.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='PREINDEX_REST_BLOCKED'
    WHERE job_id=$1 AND ordinal=0`, [jobId]);
  return { jobId, eventId, sourcePk };
}

async function tokenFor(sub: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: keyId }).setIssuer(controlledIssuer)
    .setAudience(controlledAudience).setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

describe('API-023 cursor representation', () => {
  it('binds PostgreSQL bigint values above JavaScript safe integer precision as exact decimal strings', () => {
    const context: QuarantineContext = { tenant_key: 'tenant', source_id: 'source', issuer: 'issuer', subject: 'subject',
      auth_epoch: '9007199254740993', owner_user_id: 'owner', owner_revision: '9007199254740995', origin_kind: null,
      error_code: null, limit: 20 };
    const canonical = '{"tenant_key":"tenant","source_id":"source","issuer":"issuer","subject":"subject",' +
      '"auth_epoch":"9007199254740993","owner_user_id":"owner","owner_revision":"9007199254740995",' +
      '"origin_kind":null,"error_code":null,"limit":20}';
    expect(quarantineContextJson(context)).toBe(canonical);
    expect(quarantineContextDigest(context)).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
  });

  it('backfills pre-index snapshot origins from accepted 009 and preserves facts on identical suffix reapply', async () => {
    const upgrade = await startOwnedPostgres({
      evidenceFile: `${taskEvidenceRoot}/m1task5/quarantine-preindex-postgres-lifecycle.jsonl`,
      evidenceRoot: taskEvidenceRoot,
      taskLabel: 'm1task5',
      imageReference: 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297',
    });
    const accepted009 = '55bc0ea1605952baa967ec81c6a4cc90564879c6';
    const migrationDirectory = join(taskEvidenceRoot, 'm1task5', `accepted-009-${randomUUID()}`);
    await mkdir(migrationDirectory, { recursive: false });
    try {
      const legacyFiles = (await (await import('node:fs/promises')).readdir(migrationsDirectory))
        .filter(name => /^00[1-8]_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.test(name));
      expect(legacyFiles).toHaveLength(8);
      for (const name of legacyFiles) await copyFile(join(migrationsDirectory, name), join(migrationDirectory, name));
      const baselineBytes = execFileSync('git', ['show', `${accepted009}:integration-service/migrations/009_snapshot_runs_and_recovery.sql`],
        { cwd: 'E:\\git\\dgo-hub', maxBuffer: 24 * 1024 * 1024 });
      const baselinePath = join(migrationDirectory, '009_snapshot_runs_and_recovery.sql');
      await writeFile(baselinePath, baselineBytes);
      const applied = await runMigrations(upgrade.pool, { directory: migrationDirectory, environmentKind: 'local_lab' });
      expect(applied.applied).toHaveLength(9);
      const outcomeId = await seedPreIndexSnapshot(upgrade.pool, 'm1q_preindex_tenant', 'crm-preindex-snapshot');
      const beforeFacts = await upgrade.pool.query(`SELECT o.outcome_id::text,o.status,o.error_code,o.created_at::text,
        encode(o.aggregate_digest,'hex') AS aggregate_digest,x.source_pk,x.proof_scope_digest IS NOT NULL AS has_scope
        FROM control.etl_snapshot_apply_outcome o JOIN control.etl_snapshot_apply_range x USING(outcome_id)
        WHERE o.outcome_id=$1`, [outcomeId]);
      expect(beforeFacts.rowCount).toBe(1);
      const finalSql = await readFile(join(migrationsDirectory, '009_snapshot_runs_and_recovery.sql'), 'utf8');
      const marker = '-- M1-5E1a2-1: narrow immutable identity and same-transaction quarantine capture.';
      const markerAt = finalSql.indexOf(marker);
      expect(markerAt).toBeGreaterThan(0);
      const suffix = finalSql.slice(markerAt);
      const suffixPath = join(migrationDirectory, 'api023-additive-suffix.sql');
      await writeFile(suffixPath, suffix, 'utf8');
      await upgrade.pool.query(suffix);
      const indexedAfterBackfill = await upgrade.pool.query(`SELECT quarantine_id::text,origin_kind,tenant_key,source_id,run_id::text,
        attempt_id::text,outcome_id::text,entity,relation,parent_source_pk,source_pk,status,error_code,created_at::text,
        encode(aggregate_digest,'hex') AS aggregate_digest,encode(proof_scope_digest,'hex') AS proof_scope_digest
        FROM control.ingestion_quarantine_index WHERE outcome_id=$1`, [outcomeId]);
      expect(indexedAfterBackfill.rowCount).toBe(1);
      expect(indexedAfterBackfill.rows[0]).toMatchObject({ origin_kind: 'SNAPSHOT', status: 'QUARANTINED', error_code: 'PREINDEX_BLOCKED',
        parent_source_pk: '', source_pk: 'PRE-C-1' });
      await upgrade.pool.query(suffix);
      const indexedAfterReplay = await upgrade.pool.query(`SELECT quarantine_id::text,origin_kind,tenant_key,source_id,run_id::text,
        attempt_id::text,outcome_id::text,entity,relation,parent_source_pk,source_pk,status,error_code,created_at::text,
        encode(aggregate_digest,'hex') AS aggregate_digest,encode(proof_scope_digest,'hex') AS proof_scope_digest
        FROM control.ingestion_quarantine_index WHERE outcome_id=$1`, [outcomeId]);
      const afterFacts = await upgrade.pool.query(`SELECT o.outcome_id::text,o.status,o.error_code,o.created_at::text,
        encode(o.aggregate_digest,'hex') AS aggregate_digest,x.source_pk,x.proof_scope_digest IS NOT NULL AS has_scope
        FROM control.etl_snapshot_apply_outcome o JOIN control.etl_snapshot_apply_range x USING(outcome_id)
        WHERE o.outcome_id=$1`, [outcomeId]);
      expect(indexedAfterReplay.rows).toEqual(indexedAfterBackfill.rows);
      expect(afterFacts.rows).toEqual(beforeFacts.rows);
      const normalize = (bytes: Buffer) => Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
      const baselineLf = normalize(baselineBytes);
      const suffixBytes = Buffer.from(suffix, 'utf8');
      const suffixLf = normalize(suffixBytes);
      await writeFile(join(taskEvidenceRoot, 'm1task5', 'quarantine-accepted009-source-pin.json'), JSON.stringify({
        accepted_commit: accepted009,
        migration_path: 'integration-service/migrations/009_snapshot_runs_and_recovery.sql',
        baseline_raw_sha256: createHash('sha256').update(baselineBytes).digest('hex'), baseline_raw_bytes: baselineBytes.length,
        baseline_lf_sha256: createHash('sha256').update(baselineLf).digest('hex'), baseline_lf_bytes: baselineLf.length,
        baseline_git_blob: execFileSync('git', ['hash-object', '--stdin'], { cwd: 'E:\\git\\dgo-hub', input: baselineBytes, encoding: 'utf8' }).trim(),
        suffix_raw_sha256: createHash('sha256').update(suffixBytes).digest('hex'), suffix_raw_bytes: suffixBytes.length,
        suffix_lf_sha256: createHash('sha256').update(suffixLf).digest('hex'), suffix_lf_bytes: suffixLf.length,
        suffix_git_blob: execFileSync('git', ['hash-object', '--stdin'], { cwd: 'E:\\git\\dgo-hub', input: suffixBytes, encoding: 'utf8' }).trim(),
        outcome_id: outcomeId, historical_origins: 'snapshot facts seeded on accepted full 009 before phase-owned index suffix',
      }, null, 2), 'utf8');
    } finally { await upgrade.close(); }
  });

  it('backfills populated 001-008 REST quarantine facts through the complete final 009 and exact-checksum runner reentry', async () => {
    const upgrade = await startOwnedPostgres({
      evidenceFile: `${taskEvidenceRoot}/m1task5/quarantine-pre009-rest-postgres-lifecycle.jsonl`,
      evidenceRoot: taskEvidenceRoot,
      taskLabel: 'm1task5',
      imageReference: 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297',
    });
    const migrationDirectory = join(taskEvidenceRoot, 'm1task5', `populated-008-${randomUUID()}`);
    await mkdir(migrationDirectory, { recursive: false });
    try {
      const legacyFiles = (await readdir(migrationsDirectory)).filter(name => /^00[1-8]_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.test(name));
      expect(legacyFiles).toHaveLength(8);
      for (const name of legacyFiles) await copyFile(join(migrationsDirectory, name), join(migrationDirectory, name));
      const through008 = await runMigrations(upgrade.pool, { directory: migrationDirectory, environmentKind: 'local_lab' });
      expect(through008.applied).toHaveLength(8);
      const oldRest = await seedPre009RestQuarantine(upgrade.pool, 'm1q_pre009rest_tenant', 'crm-pre009-rest');
      const preMigrationIndex = await upgrade.pool.query<{ index: string | null }>(`SELECT to_regclass('control.ingestion_quarantine_index')::text AS index`);
      expect(preMigrationIndex.rows[0]?.index).toBeNull();
      const finalBytes = await readFile(join(migrationsDirectory, '009_snapshot_runs_and_recovery.sql'));
      const finalPath = join(migrationDirectory, '009_snapshot_runs_and_recovery.sql');
      await writeFile(finalPath, finalBytes);
      const finalApply = await runMigrations(upgrade.pool, { directory: migrationDirectory, environmentKind: 'local_lab' });
      expect(finalApply.applied).toEqual(['009_snapshot_runs_and_recovery']);
      const backfilled = await upgrade.pool.query(`SELECT quarantine_id::text,origin_kind,tenant_key,source_id,entity,job_id::text,ordinal,
        event_id::text,source_pk,status,error_code,created_at::text,owner_approval_id::text,owner_revision::text,channel_id::text,
        channel_epoch::text,config_revision::text,mapping_revision::text,identity_mapping_revision::text
        FROM control.ingestion_quarantine_index WHERE job_id=$1 AND event_id=$2 AND source_pk=$3`,
        [oldRest.jobId, oldRest.eventId, oldRest.sourcePk]);
      expect(backfilled.rowCount).toBe(1);
      expect(backfilled.rows[0]).toMatchObject({ origin_kind: 'REST', status: 'QUARANTINED', error_code: 'PREINDEX_REST_BLOCKED',
        ordinal: 0, source_pk: oldRest.sourcePk });
      const runnerReentry = await runMigrations(upgrade.pool, { directory: migrationDirectory, environmentKind: 'local_lab' });
      expect(runnerReentry.applied).toEqual([]);
      expect(runnerReentry.skipped).toContain('009_snapshot_runs_and_recovery');
      const afterReentry = await upgrade.pool.query(`SELECT quarantine_id::text,origin_kind,tenant_key,source_id,entity,job_id::text,ordinal,
        event_id::text,source_pk,status,error_code,created_at::text,owner_approval_id::text,owner_revision::text,channel_id::text,
        channel_epoch::text,config_revision::text,mapping_revision::text,identity_mapping_revision::text
        FROM control.ingestion_quarantine_index WHERE job_id=$1 AND event_id=$2 AND source_pk=$3`,
        [oldRest.jobId, oldRest.eventId, oldRest.sourcePk]);
      expect(afterReentry.rows).toEqual(backfilled.rows);
      const baselineLf = Buffer.from(finalBytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
      await writeFile(join(taskEvidenceRoot, 'm1task5', 'quarantine-populated-008-rest-upgrade.json'), JSON.stringify({
        start_state: 'schema migrations 001-008 applied; one eligible REST item already QUARANTINED before final 009',
        migration_path: 'integration-service/migrations/009_snapshot_runs_and_recovery.sql',
        final009_raw_sha256: createHash('sha256').update(finalBytes).digest('hex'), final009_raw_bytes: finalBytes.length,
        final009_lf_sha256: createHash('sha256').update(baselineLf).digest('hex'), final009_lf_bytes: baselineLf.length,
        final009_git_blob: execFileSync('git', ['hash-object', '--stdin'], { cwd: 'E:\\git\\dgo-hub', input: finalBytes, encoding: 'utf8' }).trim(),
        job_id: oldRest.jobId, event_id: oldRest.eventId, source_pk: oldRest.sourcePk,
        quarantine_id: backfilled.rows[0]!.quarantine_id, migration_runner_reentry: 'identical final 009 checksum skipped; index identity and source fact unchanged',
      }, null, 2), 'utf8');
    } finally { await upgrade.close(); }
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OIDC_JWKS_SERVER_ADDRESS_INVALID');
  return address.port;
}

describe('API-023 quarantine read', () => {
  beforeAll(async () => {
    fixture = await startOwnedPostgres({
      evidenceFile: `${taskEvidenceRoot}/m1task5/quarantine-postgres-lifecycle.jsonl`,
      evidenceRoot: taskEvidenceRoot,
      taskLabel: 'm1task5',
      imageReference: 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297',
    });
    await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });

    const auth = createAuthService({ pool: fixture.pool });
    await auth.repository.provisionTenant({ tenantId, businessTimezone: 'UTC' });
    await auth.repository.provisionSubject({ tenantId, userId: ownerId, managementScopes: ['source:read'] });
    sourceBearer = createCredential().secret;
    await auth.repository.provisionSourceCredential({ sourceId, tenantId, token: sourceBearer,
      secretRef: 'vault:/fixture/quarantine-read', allowedEntities: ['customer', 'order'], revision: '1', enabled: false });
    await fixture.pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
      VALUES($1,$2,'DRAFT',$3)`, [tenantId, sourceId, ownerId]);

    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const publicKey = keys.publicKey;
    const publicJwk = await exportJWK(publicKey);
    jwksServer = createServer((request, response) => {
      if (request.url !== '/jwks') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, alg: 'RS256', use: 'sig' }] }));
    });
    const jwksPort = await listen(jwksServer);
    controlledIssuer = `http://127.0.0.1:${jwksPort}/issuer`;
    controlledAudience = audience;
    const controlledAuth = createAuthService({ pool: fixture.pool });
    await auth.repository.bindIdentity({ issuer: controlledIssuer, subject, tenantId, userId: ownerId });
    const authenticator = createOidcAuthenticator({ issuer: controlledIssuer, audience,
      jwksUrl: `http://127.0.0.1:${jwksPort}/jwks`, environmentKind: 'local_lab', allowLoopbackHttp: true }, controlledAuth);
    token = await tokenFor(subject);

    apiPool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,
      options: '-c role=hub_api', max: 4 });
    app = await buildApp({ logger: false, strictIngestion: { pool: apiPool,
      authService: createAuthService({ pool: apiPool }), authenticator } });
    await seedMixedOrigins();
  }, 90_000);

  afterAll(async () => {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    if (jwksServer) await new Promise<void>(resolve => jwksServer.close(() => resolve()));
    if (fixture) await fixture.close();
  });

  it('rejects an inherited non-exact loader invoker while allowing hub_api', async () => {
    await fixture.pool.query('CREATE ROLE m1q_inherited INHERIT');
    await fixture.pool.query('GRANT hub_api TO m1q_inherited');
    const identity = await fixture.pool.query<{ auth_epoch: string; owner_revision: string }>(`SELECT s.auth_epoch::text,r.owner_revision::text
      FROM control.auth_subject s JOIN control.source_registry r ON r.tenant_key=s.tenant_key
      WHERE s.tenant_key=$1 AND s.user_id=$2 AND r.source_id=$3`, [tenantId, ownerId, sourceId]);
    const args = [tenantId,sourceId,ownerId,controlledIssuer,subject,identity.rows[0]!.auth_epoch,identity.rows[0]!.owner_revision,null,null,null,null,1];
    const sql = 'SELECT * FROM control.list_ingestion_quarantine_current_owner($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10::timestamptz,$11::uuid,$12::integer)';
    expect((await apiPool.query(sql,args)).rowCount).toBeGreaterThan(0);
    const client = await fixture.pool.connect();
    try {
      await client.query('SET ROLE m1q_inherited');
      await expect(client.query(sql,args)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
      client.release();
      await fixture.pool.query('DROP ROLE m1q_inherited');
    }
  });

  it('rejects ascending UUIDs on a tied timestamp in the paging oracle', () => {
    const left = { created_at: '2026-10-26T10:00:00.123456Z', quarantine_id: '00000000-0000-0000-0000-000000000001' };
    const right = { created_at: left.created_at, quarantine_id: '00000000-0000-0000-0000-000000000002' };
    expect(descendingTuple(left, right)).toBe(false);
  });

  it('lets a valid current Owner list retained quarantine records while source admission is disabled', async () => {
    const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}`,
      headers: { authorization: `Bearer ${token}` } });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(20);
    expect(response.json().data.next_cursor).toEqual(expect.any(String));
    expect(response.json().data.items[0].created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it('captures an actual C worker quarantine after a current identity remap fences its older frozen proof', async () => {
    await runRealSnapshotQuarantine();
  });

  it('pages 24 mixed REST and supported parentless snapshot origins in stable microsecond order', async () => {
    const expected = await fixture.pool.query<{ quarantine_id: string; origin_kind: string; source_pk: string }>(`SELECT quarantine_id::text,origin_kind,source_pk
      FROM control.ingestion_quarantine_index WHERE tenant_key=$1 AND source_id=$2 ORDER BY created_at DESC,quarantine_id DESC`, [tenantId,sourceId]);
    const expectedKeys = [...Array.from({length: 12}, (_, n) => `REST-C-${String(n).padStart(2, '0')}`),
      ...['customer','order'].flatMap(entity => Array.from({length: 6}, (_, n) => `${entity}-${String(n).padStart(2, '0')}`))].sort();
    expect(expected.rows.map(row => row.source_pk).sort()).toEqual(expectedKeys);
    const all: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const pageResponse: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=7${cursor ? `&cursor=${cursor}` : ''}`,
        headers: { authorization: `Bearer ${token}` } });
      expect(pageResponse.statusCode).toBe(200);
      all.push(...pageResponse.json().data.items);
      cursor = pageResponse.json().data.next_cursor;
    } while (cursor);
    expect(all.map(item => ({ quarantine_id: item.quarantine_id, origin_kind: item.origin_kind, source_pk: item.source_pk }))).toEqual(expected.rows);
    expect(all).toHaveLength(24);
    expect(new Set(all.map(item => item.quarantine_id)).size).toBe(24);
    expect(all.filter(item => item.origin_kind === 'REST')).toHaveLength(12);
    const snapshots = all.filter(item => item.origin_kind === 'SNAPSHOT');
    expect(snapshots).toHaveLength(12);
    expect(snapshots.every(item => item.parent_source_pk === '' && ['customer', 'order'].includes(String(item.relation)))).toBe(true);
    for (let i = 0; i < all.length - 1; i++) {
      const left = all[i]!; const right = all[i + 1]!;
      expect(descendingTuple({ created_at: String(left.created_at), quarantine_id: String(left.quarantine_id) },
        { created_at: String(right.created_at), quarantine_id: String(right.quarantine_id) })).toBe(true);
    }
  });

  it('pages the default limit through the final null cursor without omission', async () => {
    const expected = await fixture.pool.query<{ quarantine_id: string }>(`SELECT quarantine_id::text FROM control.ingestion_quarantine_index
      WHERE tenant_key=$1 AND source_id=$2 ORDER BY created_at DESC,quarantine_id DESC`, [tenantId,sourceId]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}${cursor ? `&cursor=${cursor}` : ''}`,
        headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      seen.push(...response.json().data.items.map((item: { quarantine_id: string }) => item.quarantine_id));
      cursor = response.json().data.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual(expected.rows.map(row => row.quarantine_id));
    expect(seen).toHaveLength(24);
  });

  it('accepts the maximum page size and returns the complete bounded source set', async () => {
    const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=100`,
      headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(24);
    expect(response.json().data.next_cursor).toBeNull();
  });

  it('filters snapshot origins and rejects a cursor bound to another context', async () => {
    const first = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&origin_kind=SNAPSHOT&limit=5`,
      headers: { authorization: `Bearer ${token}` } });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.items).toHaveLength(5);
    expect(first.json().data.items.every((item: { origin_kind: string }) => item.origin_kind === 'SNAPSHOT')).toBe(true);
    const wrongCursor = Buffer.from(JSON.stringify({ v: 1, context_sha256: '0'.repeat(64),
      created_at: first.json().data.items.at(-1).created_at, quarantine_id: first.json().data.items.at(-1).quarantine_id }), 'utf8').toString('base64url');
    const stale = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&origin_kind=SNAPSHOT&limit=5&cursor=${wrongCursor}`,
      headers: { authorization: `Bearer ${token}` } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('SOURCE_CONFLICT');
  });

  it('keeps the quarantine index private from runtime roles and excludes payload fields', async () => {
    const grants = await fixture.pool.query(`SELECT
      has_table_privilege('hub_api','control.ingestion_quarantine_index','SELECT') AS api_select,
      has_table_privilege('hub_api','control.ingestion_quarantine_index','INSERT') AS api_insert,
      has_table_privilege('hub_worker','control.ingestion_quarantine_index','SELECT') AS worker_select,
      has_table_privilege('hub_worker','control.ingestion_quarantine_index','INSERT') AS worker_insert,
      has_function_privilege('hub_api','control.list_ingestion_quarantine_current_owner(text,text,text,text,text,bigint,bigint,text,text,timestamptz,uuid,integer)','EXECUTE') AS api_loader,
      has_function_privilege('hub_worker','control.list_ingestion_quarantine_current_owner(text,text,text,text,text,bigint,bigint,text,text,timestamptz,uuid,integer)','EXECUTE') AS worker_loader`);
    expect(grants.rows[0]).toEqual({ api_select: false, api_insert: false, worker_select: false, worker_insert: false,
      api_loader: true, worker_loader: false });
    const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=1`,
      headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0]).not.toHaveProperty('public_record');
    expect(response.json().data.items[0]).not.toHaveProperty('facts');
  });

  it('denies runtime roles direct private facts and index mutation or synthesis', async () => {
    for (const role of ['hub_api', 'hub_worker']) {
      const client = await fixture.pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        if (role === 'hub_worker') {
          expect((await client.query('SELECT body_bytes FROM raw.ingestion_batch LIMIT 1')).rowCount).toBeGreaterThan(0);
          expect((await client.query('SELECT public_record FROM control.ingestion_job_item LIMIT 1')).rowCount).toBeGreaterThan(0);
          expect((await client.query('SELECT proof_scope_digest FROM control.etl_snapshot_validation LIMIT 1')).rowCount).toBeGreaterThan(0);
        }
        for (const sql of [
          ...(role === 'hub_api' ? ['SELECT body_bytes FROM raw.ingestion_batch LIMIT 1', 'SELECT public_record FROM control.ingestion_job_item LIMIT 1'] : []),
          'SELECT facts FROM control.etl_snapshot_stage_record LIMIT 1',
          ...(role === 'hub_api' ? ['SELECT proof_scope_digest FROM control.etl_snapshot_validation LIMIT 1'] : []),
          'SELECT proof_scope_digest FROM control.ingestion_quarantine_index LIMIT 1',
          'UPDATE control.ingestion_quarantine_index SET source_id=source_id',
          'DELETE FROM control.ingestion_quarantine_index',
          `INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,status) VALUES('REST','foreign','foreign','QUARANTINED')`,
        ]) await expect(client.query(sql), `${role}: ${sql}`).rejects.toMatchObject({ code: '42501' });
      } finally { await client.query('RESET ROLE'); client.release(); }
    }
  });

  it('rejects source credentials and wrong-tenant or missing source requests', async () => {
    const auth = createAuthService({ pool: fixture.pool });
    await auth.repository.provisionTenant({ tenantId: 'm1q_other_tenant', businessTimezone: 'UTC' });
    await auth.repository.provisionSubject({ tenantId: 'm1q_other_tenant', userId: 'other-owner', managementScopes: ['source:read'] });
    await auth.repository.bindIdentity({ issuer: controlledIssuer, subject: 'other-tenant', tenantId: 'm1q_other_tenant', userId: 'other-owner' });
    for (const [bearerValue, requested] of [[sourceBearer, sourceId], [await tokenFor('other-tenant'), sourceId], [token, 'missing-source']]) {
      const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${requested}`,
        headers: { authorization: `Bearer ${bearerValue}` } });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json()).not.toHaveProperty('data.items');
    }
  });

  it('denies a disabled owner and a disabled OIDC binding on fresh reads', async () => {
    for (const [table, predicate, args] of [
      ['auth_subject', 'tenant_key=$1 AND user_id=$2', [tenantId,ownerId]],
      ['identity_binding', 'issuer=$1 AND subject=$2', [controlledIssuer,subject]],
    ] as const) {
      await fixture.pool.query(`UPDATE control.${table} SET enabled=false WHERE ${predicate}`, [...args]);
      try {
        const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}`,
          headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.json()).not.toHaveProperty('data.items');
      } finally { await fixture.pool.query(`UPDATE control.${table} SET enabled=true WHERE ${predicate}`, [...args]); }
    }
  });

  it('rechecks an OIDC binding changed after the first page', async () => {
    const first = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=2`,
      headers: { authorization: `Bearer ${token}` } });
    expect(first.statusCode).toBe(200);
    await fixture.pool.query('UPDATE control.identity_binding SET enabled=false WHERE issuer=$1 AND subject=$2', [controlledIssuer, subject]);
    try {
      const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=2&cursor=${first.json().data.next_cursor}`,
        headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.json()).not.toHaveProperty('data.items');
    } finally { await fixture.pool.query('UPDATE control.identity_binding SET enabled=true WHERE issuer=$1 AND subject=$2', [controlledIssuer, subject]); }
  });

  it('fails closed and releases transaction locks when the security fence fails', async () => {
    await fixture.pool.query('REVOKE EXECUTE ON FUNCTION control.lock_security_barrier_fence() FROM hub_api');
    try {
      const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}`,
        headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AUTH_UNAVAILABLE');
      expect(response.json()).not.toHaveProperty('data.items');
    } finally { await fixture.pool.query('GRANT EXECUTE ON FUNCTION control.lock_security_barrier_fence() TO hub_api'); }
    const probe = await fixture.pool.connect();
    try {
      await probe.query('BEGIN');
      expect((await probe.query('SELECT pg_try_advisory_xact_lock(1296905544,1) AS acquired')).rows[0].acquired).toBe(true);
      await probe.query('ROLLBACK');
    } finally { probe.release(); }
  });

  it('rejects a snapshot index row whose outcome ID belongs to another origin tuple', async () => {
    const pair = await fixture.pool.query<{ tenant_key: string; source_id: string; entity: string; run_id: string; attempt_id: string;
      outcome_id: string; relation: string; parent_source_pk: string; source_pk: string; error_code: string | null;
      created_at: Date; aggregate_digest: Buffer; proof_scope_digest: Buffer; other_outcome_id: string }>(`SELECT
      i.tenant_key,i.source_id,i.entity,i.run_id::text,i.attempt_id::text,i.outcome_id::text,i.relation,i.parent_source_pk,i.source_pk,
      i.error_code,i.created_at,i.aggregate_digest,i.proof_scope_digest,(SELECT other.outcome_id::text
        FROM control.ingestion_quarantine_index other WHERE other.origin_kind='SNAPSHOT' AND other.outcome_id<>i.outcome_id LIMIT 1) AS other_outcome_id
      FROM control.ingestion_quarantine_index i WHERE i.origin_kind='SNAPSHOT' LIMIT 1`);
    expect(pair.rowCount).toBe(1);
    await expect(fixture.pool.query(`INSERT INTO control.ingestion_quarantine_index(origin_kind,tenant_key,source_id,entity,run_id,attempt_id,
      outcome_id,relation,parent_source_pk,source_pk,status,error_code,created_at,aggregate_digest,proof_scope_digest)
      VALUES('SNAPSHOT',$1,$2,$3,$4,$5,$6,$7,$8,'composite-fk-mismatch','QUARANTINED',$9,$10,$11,$12)`,
      [pair.rows[0]!.tenant_key,pair.rows[0]!.source_id,pair.rows[0]!.entity,pair.rows[0]!.run_id,pair.rows[0]!.attempt_id,
        pair.rows[0]!.other_outcome_id,pair.rows[0]!.relation,pair.rows[0]!.parent_source_pk,pair.rows[0]!.error_code,
        pair.rows[0]!.created_at,pair.rows[0]!.aggregate_digest,pair.rows[0]!.proof_scope_digest])).rejects.toMatchObject({ code: '23503' });
  });

  it('rolls back a snapshot outcome and range together when same-transaction index capture fails', async () => {
    const stage = await fixture.pool.query<{ run_id: string; attempt_id: string; aggregate_digest: Buffer; proof_scope_digest: Buffer }>(`
      SELECT r.run_id::text,m.attempt_id::text,o.aggregate_digest,x.proof_scope_digest
      FROM control.etl_run r JOIN control.etl_snapshot_manifest m USING(tenant_key,source_id,run_id)
      JOIN control.etl_snapshot_apply_outcome o USING(tenant_key,source_id,run_id,attempt_id)
      JOIN control.etl_snapshot_apply_range x USING(tenant_key,source_id,run_id,attempt_id)
      WHERE r.tenant_key=$1 AND r.source_id=$2 LIMIT 1`, [tenantId, sourceId]);
    const { run_id: runId, attempt_id: attemptId } = stage.rows[0]!;
    const sourcePk = 'capture-failure-rollback';
    await fixture.pool.query(`CREATE FUNCTION control.test_fail_quarantine_capture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced quarantine index capture failure'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER test_fail_quarantine_capture BEFORE INSERT ON control.ingestion_quarantine_index
      FOR EACH ROW EXECUTE FUNCTION control.test_fail_quarantine_capture()`);
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO control.etl_snapshot_stage_record(tenant_key,source_id,run_id,attempt_id,entity,relation,
        parent_source_pk,source_pk,page_no,row_ordinal,source_version,facts) VALUES($1,$2,$3,$4,'customer','customer','',$5,1,7,'1','{}')`,
        [tenantId, sourceId, runId, attemptId, sourcePk]);
      const outcome = await client.query<{ outcome_id: string }>(`INSERT INTO control.etl_snapshot_apply_outcome(tenant_key,source_id,
        run_id,attempt_id,entity,relation,parent_source_pk,source_pk,aggregate_digest,status,error_code)
        VALUES($1,$2,$3,$4,'customer','customer','',$5,$6,'QUARANTINED','SYNTHETIC_FAILURE') RETURNING outcome_id::text`,
        [tenantId, sourceId, runId, attemptId, sourcePk, stage.rows[0]!.aggregate_digest]);
      await expect(client.query(`INSERT INTO control.etl_snapshot_apply_range(tenant_key,source_id,run_id,attempt_id,entity,relation,
        parent_source_pk,source_pk,aggregate_digest,proof_scope_digest,outcome_id) VALUES($1,$2,$3,$4,'customer','customer','',$5,$6,$7,$8)`,
        [tenantId, sourceId, runId, attemptId, sourcePk, stage.rows[0]!.aggregate_digest, stage.rows[0]!.proof_scope_digest,
          outcome.rows[0]!.outcome_id])).rejects.toThrow('forced quarantine index capture failure');
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await fixture.pool.query('DROP TRIGGER IF EXISTS test_fail_quarantine_capture ON control.ingestion_quarantine_index');
      await fixture.pool.query('DROP FUNCTION IF EXISTS control.test_fail_quarantine_capture()');
    }
    const counts = await fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM control.etl_snapshot_apply_outcome WHERE run_id=$1 AND source_pk=$2) AS outcomes,
      (SELECT count(*)::int FROM control.etl_snapshot_apply_range WHERE run_id=$1 AND source_pk=$2) AS ranges,
      (SELECT count(*)::int FROM control.ingestion_quarantine_index WHERE run_id=$1 AND source_pk=$2) AS indexed`, [runId, sourcePk]);
    expect(counts.rows[0]).toEqual({ outcomes: 0, ranges: 0, indexed: 0 });
  });

  it('rejects malformed query forms and repeated keys before listing', async () => {
    for (const query of [
      '?source_id=bad%20id', '?source_id=crm-quarantine-read&limit=01',
      '?source_id=crm-quarantine-read&origin_kind=rest', '?source_id=crm-quarantine-read&unexpected=x',
      '?source_id=crm-quarantine-read&source_id=crm-quarantine-read',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine${query}`,
        headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode, query).toBe(400);
      expect(response.json().error.code, query).toBe('AUTH_INPUT_INVALID');
    }
  });

  it('requires the exact current source Owner even for a user with source:read', async () => {
    const otherUser = 'm1q-other-reader';
    await createAuthService({ pool: fixture.pool }).repository.provisionSubject({ tenantId, userId: otherUser,
      managementScopes: ['source:read'] });
    await createAuthService({ pool: fixture.pool }).repository.bindIdentity({ issuer: controlledIssuer,
      subject: 'other-reader-subject', tenantId, userId: otherUser });
    const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}`,
      headers: { authorization: `Bearer ${await tokenFor('other-reader-subject')}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_FORBIDDEN');
  });

  it('rechecks current ownership and binding context on a cursor continuation', async () => {
    const first = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=2`,
      headers: { authorization: `Bearer ${token}` } });
    const cursor = first.json().data.next_cursor as string;
    await fixture.pool.query(`UPDATE control.source_registry SET data_owner_user_id=$3,owner_revision=owner_revision+1
      WHERE tenant_key=$1 AND source_id=$2`, [tenantId, sourceId, 'm1q-other-reader']);
    const denied = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=2&cursor=${cursor}`,
      headers: { authorization: `Bearer ${token}` } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('AUTH_FORBIDDEN');
    await fixture.pool.query(`UPDATE control.source_registry SET data_owner_user_id=$3,owner_revision=owner_revision+1
      WHERE tenant_key=$1 AND source_id=$2`, [tenantId, sourceId, ownerId]);
    const ownerAuth = createAuthService({ pool: fixture.pool });
    await ownerAuth.repository.provisionSubject({ tenantId, userId: ownerId, managementScopes: ['source:read', 'source:write'] });
    const staleContext = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=2&cursor=${cursor}`,
      headers: { authorization: `Bearer ${token}` } });
    expect(staleContext.statusCode).toBe(409);
    expect(staleContext.json().error.code).toBe('SOURCE_CONFLICT');
  });

  it('keeps malformed stored snapshot codes out of both index and response while retaining safe codes exactly', async () => {
    const rows = await fixture.pool.query<{ source_pk: string; stored_code: string | null; indexed_code: string | null }>(`SELECT o.source_pk,
      o.error_code AS stored_code,i.error_code AS indexed_code FROM control.etl_snapshot_apply_outcome o
      JOIN control.ingestion_quarantine_index i USING(outcome_id,tenant_key,source_id,run_id,attempt_id,entity,relation,parent_source_pk,source_pk)
      WHERE o.source_id=$1 AND o.source_pk=ANY($2::text[]) ORDER BY o.source_pk`,
      [sourceId, ['customer-00', 'customer-01', 'customer-02']]);
    expect(rows.rows).toEqual([
      { source_pk: 'customer-00', stored_code: 'provider text that must stay private', indexed_code: null },
      { source_pk: 'customer-01', stored_code: 'SNAPSHOT_BLOCKED:SAFE', indexed_code: 'SNAPSHOT_BLOCKED:SAFE' },
      { source_pk: 'customer-02', stored_code: `PROVIDER_${'X'.repeat(110)}`, indexed_code: null },
    ]);
    const safe = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&error_code=SNAPSHOT_BLOCKED:SAFE`,
      headers: { authorization: `Bearer ${token}` } });
    expect(safe.statusCode).toBe(200);
    expect(safe.json().data.items).toHaveLength(1);
    expect(safe.json().data.items[0].error_code).toBe('SNAPSHOT_BLOCKED:SAFE');
    expect(JSON.stringify(safe.json())).not.toContain('provider text');
    const all = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}&limit=100`,
      headers: { authorization: `Bearer ${token}` } });
    expect(JSON.stringify(all.json())).not.toContain(`PROVIDER_${'X'.repeat(110)}`);
  });

  it('applies current management scope removal to an otherwise unchanged Owner', async () => {
    const ownerAuth = createAuthService({ pool: fixture.pool });
    await ownerAuth.repository.provisionSubject({ tenantId, userId: ownerId, managementScopes: ['source:write'] });
    const response = await app.inject({ method: 'GET', url: `/hub/v1/admin/quarantine?source_id=${sourceId}`,
      headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('AUTH_FORBIDDEN');
  });

  it('reenters the exact full 009 migration through the unchanged checksum runner without altering origins or index IDs', async () => {
    const before = await fixture.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.quarantine_id),'[]'::jsonb) AS rows
      FROM control.ingestion_quarantine_index i`);
    const sourceFacts = await fixture.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.outcome_id),'[]'::jsonb) AS outcomes,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.run_id),'[]'::jsonb) FROM control.etl_run r) AS runs
      FROM control.etl_snapshot_apply_outcome o`);
    const ledger = await fixture.pool.query<{ checksum: string }>(`SELECT checksum FROM control.schema_migration WHERE version=9`);
    const rerun = await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toContain('009_snapshot_runs_and_recovery');
    const after = await fixture.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.quarantine_id),'[]'::jsonb) AS rows
      FROM control.ingestion_quarantine_index i`);
    const sourceFactsAfter = await fixture.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.outcome_id),'[]'::jsonb) AS outcomes,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.run_id),'[]'::jsonb) FROM control.etl_run r) AS runs
      FROM control.etl_snapshot_apply_outcome o`);
    const ledgerAfter = await fixture.pool.query<{ checksum: string }>(`SELECT checksum FROM control.schema_migration WHERE version=9`);
    expect(ledger.rowCount).toBe(1);
    expect(ledgerAfter.rows).toEqual(ledger.rows);
    expect(after.rows).toEqual(before.rows);
    expect(sourceFactsAfter.rows).toEqual(sourceFacts.rows);
  });
});
