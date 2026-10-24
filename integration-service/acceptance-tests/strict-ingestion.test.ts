import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp } from '../app.js';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { runMigrations } from '../migrations/runner.js';
import { STRICT_INGEST_BODY_LIMIT } from '../ingestion-api/strict-contract.js';
import { createSourceRegistryService, type EndpointAllowlist } from '../source-registry/service.js';
import type { EndpointProfile } from '../source-registry/capability-probe.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceRoot = 'E:\\git\\dgo-hub\\docs\\execution\\alpha1\\m1-task-3-evidence\\d825e7c7-136b-4900-a644-2014f1d24c0e';
const migrationsDirectory = new URL('../migrations/', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:');
const sourceToken = createCredential().secret;
const tenantId = 'task3_tenant';
const sourceId = 'crm-demo';
const route = '/hub/v1/ingest/crm/customers';
const orderRoute = '/hub/v1/ingest/orders/orders';
let fixture: OwnedPostgres;
let apiPool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let jobId: string;
let endpointProfile: EndpointProfile;

const manager = async () => ({ userId: 'manager-a', tenantId, departmentId: null, businessRole: null,
  managementScopes: ['source:read'] as const, authEpoch: '0', businessTimezone: 'Asia/Shanghai', issuer: 'fixture', subject: 'manager-a' });

function customerBatch(count = 1, fields: Record<string, unknown> = {}) {
  return {
    schema_version: 'hub.v1', batch_id: randomUUID(), ...fields,
    records: Array.from({ length: count }, () => ({ event_id: randomUUID(), source_pk: `C-${randomUUID()}`, source_version: '1',
      operation: 'UPSERT', source_updated_at: '2026-10-22T09:00:00+08:00',
      data: { customer_name: 'Synthetic Customer', owner_external_id: 'sales-a', department_external_id: 'dept-a', status: 'ACTIVE' } })),
  };
}

async function post(body: Buffer | string, key = `key-${randomUUID()}`, url = route) {
  return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json', 'idempotency-key': key }, payload: body });
}

function orderBatch(status: 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED', lines: unknown[] = []) {
  return { schema_version:'hub.v1',batch_id:randomUUID(),records:[{ event_id:randomUUID(),source_pk:`O-${randomUUID()}`,source_version:'1',
    operation:'UPSERT',source_updated_at:'2026-10-22T09:00:00+08:00',data:{ customer_ref:{source_id:'crm-demo',source_pk:'missing-C-1'},
      order_no:'SO-1',status,order_at:'2026-10-22T09:00:00+08:00',amount:'100.00',currency:'CNY',lines } }] };
}

async function rowCounts() {
  return fixture.pool.query<{ jobs: string; raw: string; items: string; outbox: string }>(`SELECT
    (SELECT count(*)::text FROM control.ingestion_job WHERE tenant_key=$1 AND source_id=$2) AS jobs,
    (SELECT count(*)::text FROM raw.ingestion_batch WHERE tenant_key=$1 AND source_id=$2) AS raw,
    (SELECT count(*)::text FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id WHERE j.tenant_key=$1 AND j.source_id=$2) AS items,
    (SELECT count(*)::text FROM control.ingestion_processing_outbox o JOIN control.ingestion_job j ON j.id=o.job_id WHERE j.tenant_key=$1 AND j.source_id=$2) AS outbox`, [tenantId,sourceId]);
}

beforeAll(async () => {
  fixture = await startOwnedPostgres({ evidenceRoot, taskLabel: 'task3', evidenceFile: join(evidenceRoot,'task3','placeholder.jsonl') });
  await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  const seedAuth = createAuthService({ pool: fixture.pool });
  await seedAuth.repository.provisionTenant({ tenantId, businessTimezone: 'Asia/Shanghai' });
  await seedAuth.repository.provisionSubject({ tenantId, userId: 'owner-a', businessRole: 'sales', managementScopes: ['source:read','source:write','source:approve'] });
  await seedAuth.repository.bindIdentity({ issuer: 'https://fixture.example.test', subject: 'owner-a', tenantId, userId: 'owner-a' });
  await seedAuth.repository.provisionSubject({ tenantId, userId: 'manager-a', businessRole: 'sales', managementScopes: ['source:read'] });
  await seedAuth.repository.provisionSourceCredential({ tenantId, sourceId, token: sourceToken, secretRef: 'vault:/fixture/crm', allowedEntities: ['customer','order'], revision: '1' });

  endpointProfile = { revision:'fixture-v1',connector:'rest',protocol:'https:',host:'crm.fixture.invalid',port:443,
    path:'/capability',schema_version:'customer-v1',source_identity:'fixture-crm',entities:{
      customer:{version_field:'source_version',delete_field:'deleted_at'},order:{version_field:'source_version',delete_field:'deleted_at'},
    } };
  const config = { name:'CRM fixture',connector:'rest',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:['customer','order'],
    endpoint_allowlist_ref:'crm-fixture',secret_ref:'vault:/fixture/crm',delete_contract:'tombstone',endpoint_profile:endpointProfile };
  const configDigest = createHash('sha256').update(JSON.stringify(config)).digest();
  const mappingDigest = Buffer.alloc(32, 0x21);
  const identityDigest = Buffer.alloc(32, 0x22);
  const endpointDigest = createHash('sha256').update(JSON.stringify(endpointProfile)).digest();
  await fixture.pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,data_owner_user_id)
    VALUES($1,$2,'ACTIVE','owner-a')`, [tenantId,sourceId]);
  await fixture.pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4,'owner-a')`, [tenantId,sourceId,configDigest,config]);
  await fixture.pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'owner-a')`, [tenantId,sourceId,mappingDigest,JSON.stringify([
      {entity:'customer',source_field:'customer_name',target_field:'customer_name',transform:'trim'},
      {entity:'customer',source_field:'owner_user_id',target_field:'owner_user_id',transform:'source-id'},
      {entity:'customer',source_field:'dept_id',target_field:'dept_id',transform:'source-id'},
      {entity:'customer',source_field:'status',target_field:'status',transform:'identity'},
      {entity:'order',source_field:'customer_id',target_field:'customer_id',transform:'source-id'},
      {entity:'order',source_field:'order_no',target_field:'order_no',transform:'trim'},
      {entity:'order',source_field:'status',target_field:'status',transform:'identity'},
      {entity:'order',source_field:'order_at',target_field:'order_at',transform:'identity'},
      {entity:'order',source_field:'amount',target_field:'amount',transform:'decimal-string'},
      {entity:'order',source_field:'currency',target_field:'currency',transform:'identity'},
    ])]);
  await fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]','owner-a')`, [tenantId,sourceId,identityDigest]);
  const credential = await fixture.pool.query<{ id: string }>('SELECT id FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2', [tenantId,sourceId]);
  const test = await fixture.pool.query<{ id: string }>(`INSERT INTO control.source_test_report(
    tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,
    source_credential_revision,credential_generation,endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,1,1,$6,'hub.v1','{}','PASS','owner-a') RETURNING id`,
  [tenantId,sourceId,configDigest,mappingDigest,identityDigest,endpointDigest]);
  await fixture.pool.query(`INSERT INTO control.source_owner_approval(
    tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,identity_mapping_revision,
    config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,endpoint_profile_digest,
    data_contract_ref,test_report_id)
    VALUES($1,$2,'owner-a',1,1,1,1,$3,$4,$5,1,1,$6,'hub.v1',$7)`,
  [tenantId,sourceId,configDigest,mappingDigest,identityDigest,endpointDigest,test.rows[0]!.id]);
  await fixture.pool.query(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
    VALUES($1,$2,'customer','rest','INCREMENTAL','SOURCE_VERSION',1,'active')`, [tenantId,sourceId]);
  await fixture.pool.query(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
    VALUES($1,$2,'order','rest','INCREMENTAL','SOURCE_VERSION',1,'active')`, [tenantId,sourceId]);

  const connectionString = `postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`;
  apiPool = new pg.Pool({ connectionString, options: '-c role=hub_api', max: 6 });
  const auth = createAuthService({ pool: apiPool });
  app = await buildApp({ strictIngestion: { pool: apiPool, authService: auth, authenticator: manager, rawStoragePolicy: 'local_lab_fixture' } });
  await app.ready();
}, 90_000);

afterAll(async () => {
  if (app) await app.close();
  if (apiPool) await apiPool.end();
  if (fixture) {
    const summary = { taskLabel: fixture.taskLabel, runLabel: fixture.runLabel, containerId: fixture.containerId,
      imageReference: fixture.imageReference, repoDigest: fixture.repoDigest, runtimeImageId: fixture.runtimeImageId,
      hostPort: fixture.hostPort, evidenceFile: fixture.evidenceFile };
    const summaryDirectory = dirname(fixture.evidenceFile);
    await fixture.close();
    await writeFile(join(summaryDirectory,'postgres-resource-summary.json'), `${JSON.stringify({ ...summary, ownershipConfirmed: true,
      removedByExactContainerId: true, absentAfterRemoval: true }, null, 2)}\n`, 'utf8');
  }
});

describe('M1-3 strict intake and durable job reads', () => {
  it('returns 202 only after raw, job, item, idempotency and outbox rows commit', async () => {
    const body = Buffer.from(JSON.stringify(customerBatch()), 'utf8');
    const response = await post(body,'durable-commit');
    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ status: 'RECEIVED', received_count: 1, applied_count: 0 });
    jobId = response.json().data.job_id;
    const counts = await rowCounts();
    expect(counts.rows[0]).toEqual({ jobs: '1', raw: '1', items: '1', outbox: '1' });
    const raw = await fixture.pool.query<{ body_bytes: Buffer }>('SELECT body_bytes FROM raw.ingestion_batch');
    expect(raw.rows[0]!.body_bytes).toEqual(body);
  });

  it('replays a lost response with the same scoped job and rejects changed content', async () => {
    const original = customerBatch();
    const raw = Buffer.from(JSON.stringify(original));
    const first = await post(raw,'lost-response-key');
    expect(first.statusCode).toBe(202);
    const replay = await post(raw,'lost-response-key');
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.job_id).toBe(first.json().data.job_id);
    const changed = structuredClone(original);
    changed.records[0]!.data.customer_name = 'Changed content';
    expect((await post(JSON.stringify(changed),'lost-response-key')).statusCode).toBe(409);
    const counts = await rowCounts();
    expect(counts.rows[0]).toEqual({ jobs: '2', raw: '2', items: '2', outbox: '2' });
  });

  it('serializes concurrent same-key requests to one committed receipt', async () => {
    const body = Buffer.from(JSON.stringify(customerBatch()));
    const [left,right] = await Promise.all([post(body,'concurrent-key'),post(body,'concurrent-key')]);
    expect([left.statusCode,right.statusCode]).toEqual([202,202]);
    expect(left.json().data.job_id).toBe(right.json().data.job_id);
  });

  it('rejects structure and schema errors without durable writes', async () => {
    const before = await rowCounts();
    const unknown = customerBatch(1,{ tenant_id: tenantId });
    const invalid = await post(JSON.stringify(unknown));
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('INGEST_INPUT_INVALID');
    const empty = { schema_version:'hub.v1',batch_id:randomUUID(),records:[] };
    expect((await post(JSON.stringify(empty))).statusCode).toBe(422);
    const duplicate = Buffer.from(JSON.stringify(customerBatch()).replace('"customer_name":"Synthetic Customer"',
      '"customer_name":"Synthetic Customer","customer_name":"Second value"'));
    const duplicateResponse = await post(duplicate);
    expect(duplicateResponse.statusCode).toBe(422);
    expect(duplicateResponse.json().error.code).toBe('INGEST_JSON_DUPLICATE_KEY');
    const malformedUtf8 = Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0xc3,0x28,0x7d]);
    expect((await post(malformedUtf8)).statusCode).toBe(422);
    const counts = await rowCounts();
    expect(counts.rows[0]).toEqual(before.rows[0]);
  });

  it('enforces the public order state and empty-lines matrix before writing', async () => {
    const before = await rowCounts();
    for (const status of ['CONFIRMED','COMPLETED'] as const) {
      const response = await post(JSON.stringify(orderBatch(status)),`empty-lines-${status}`,orderRoute);
      expect(response.statusCode).toBe(422);
    }
    expect((await rowCounts()).rows[0]).toEqual(before.rows[0]);
    for (const status of ['DRAFT','CANCELLED'] as const) {
      const response = await post(JSON.stringify(orderBatch(status)),`empty-lines-${status}`,orderRoute);
      expect(response.statusCode).toBe(202);
    }
  });

  it('accepts 100 records and exactly 4 MiB while rejecting 0, 101 and 4 MiB plus one byte', async () => {
    const hundred = await post(JSON.stringify(customerBatch(100)),'hundred-records');
    expect(hundred.statusCode).toBe(202);
    expect(hundred.json().data.received_count).toBe(100);
    const zero = { schema_version:'hub.v1',batch_id:randomUUID(),records:[] };
    const tooMany = customerBatch(101);
    expect((await post(JSON.stringify(zero))).statusCode).toBe(422);
    expect((await post(JSON.stringify(tooMany))).statusCode).toBe(422);
    const exactBase = JSON.stringify(customerBatch());
    const exact = Buffer.from(exactBase + ' '.repeat(STRICT_INGEST_BODY_LIMIT - Buffer.byteLength(exactBase)),'utf8');
    expect(exact.length).toBe(STRICT_INGEST_BODY_LIMIT);
    expect((await post(exact,'exact-4mib')).statusCode).toBe(202);
    const over = Buffer.concat([exact,Buffer.from(' ')]);
    expect(over.length).toBe(STRICT_INGEST_BODY_LIMIT + 1);
    const tooLarge = await post(over,'over-4mib');
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('INGEST_BODY_TOO_LARGE');
  });

  it('rolls back every intake row when the final outbox write fails', async () => {
    const before = await rowCounts();
    await fixture.pool.query(`CREATE FUNCTION control.test_fail_intake_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture failure'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER test_fail_intake_outbox BEFORE INSERT ON control.ingestion_processing_outbox
      FOR EACH ROW EXECUTE FUNCTION control.test_fail_intake_outbox()`);
    try {
      const response = await post(JSON.stringify(customerBatch()),'rollback-key');
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('fixture failure');
    } finally {
      await fixture.pool.query('DROP TRIGGER IF EXISTS test_fail_intake_outbox ON control.ingestion_processing_outbox');
      await fixture.pool.query('DROP FUNCTION IF EXISTS control.test_fail_intake_outbox()');
    }
    expect((await rowCounts()).rows[0]).toEqual(before.rows[0]);
  });

  it('replays after ordinary pause without re-admission and blocks new admission', async () => {
    const key = 'pause-replay-key';
    const body = Buffer.from(JSON.stringify(customerBatch()));
    const accepted = await post(body,key);
    expect(accepted.statusCode).toBe(202);
    await fixture.pool.query("UPDATE control.source_registry SET lifecycle='PAUSED' WHERE tenant_key=$1 AND source_id=$2",[tenantId,sourceId]);
    expect((await post(body,key)).json().data.job_id).toBe(accepted.json().data.job_id);
    const newBatch = await post(Buffer.from(JSON.stringify(customerBatch())),'paused-new-admission');
    expect(newBatch.statusCode).toBe(409);
    await fixture.pool.query("UPDATE control.source_registry SET lifecycle='ACTIVE' WHERE tenant_key=$1 AND source_id=$2",[tenantId,sourceId]);
  });

  it('blocks a newer typed security barrier until a fresh fenced owner approval', async () => {
    const before = await fixture.pool.query<{ approval_security_fence: string; security_barrier_fence_at_admission: string }>(
      'SELECT approval_security_fence::text,security_barrier_fence_at_admission::text FROM control.ingestion_job WHERE id=$1',[jobId]);
    const managementAuth = createAuthService({ pool:fixture.pool });
    const owner = await managementAuth.resolveOidc('https://fixture.example.test','owner-a');
    const endpointAllowlist:EndpointAllowlist = { resolve:async reference => {
      if(reference !== 'crm-fixture') throw new Error('unapproved endpoint reference');
      return endpointProfile;
    } };
    const sourceRegistry = createSourceRegistryService({
      pool:fixture.pool,auth:managementAuth,
      secretResolver:{isConfiguredReference:reference=>reference==='vault:/fixture/crm',resolve:async()=> 'fixture-secret'},
      endpointAllowlist,capabilityProbe:{run:async()=>({passed:true,checks:['FIXTURE_CAPABILITY_PASS']})},environmentKind:'site',
    });
    await managementAuth.repository.recordSourceScopeSecurityBarrier(sourceId,tenantId,'customer','FIXTURE_SCOPE_REMOVED');
    const barrier = await fixture.pool.query<{ effective_fence: string }>(
      `SELECT effective_fence::text FROM control.source_security_barrier WHERE tenant_key=$1 AND source_id=$2
       AND entity='customer' AND barrier_type='SOURCE_SCOPE_SECURITY_REMOVAL' ORDER BY effective_fence DESC LIMIT 1`,[tenantId,sourceId]);
    expect(BigInt(barrier.rows[0]!.effective_fence)).toBeGreaterThan(BigInt(before.rows[0]!.approval_security_fence));
    const counts = await rowCounts();
    const blocked = await post(JSON.stringify(customerBatch()),'blocked-after-barrier');
    expect(blocked.statusCode).toBe(401);
    expect((await rowCounts()).rows[0]).toEqual(counts.rows[0]);

    const credentialBefore = await fixture.pool.query<{ id:string }>(
      'SELECT id::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId]);
    await expect(sourceRegistry.pause(owner,sourceId,'1','security scope review')).resolves.toMatchObject({lifecycle:'PAUSED'});
    await managementAuth.repository.updateSourceCredential(sourceId,tenantId,true,'1',['customer','order']);
    const tested = await sourceRegistry.test(owner,sourceId,'1');
    expect(tested).toMatchObject({status:'PASS'});
    const approval = await sourceRegistry.approve(owner,sourceId,'1',tested.test_report_id,tested.data_contract_ref);
    expect(approval).toMatchObject({status:'APPROVED'});
    await expect(sourceRegistry.activate(owner,sourceId,'1',approval.approval_id)).resolves.toMatchObject({lifecycle:'ACTIVE'});
    const recovered = await post(JSON.stringify(customerBatch()),'recovered-after-fresh-approval');
    expect(recovered.statusCode).toBe(202);
    const credentialAfter = await fixture.pool.query<{ id:string }>(
      'SELECT id::text FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId]);
    expect(credentialAfter.rows).toEqual(credentialBefore.rows);
    const newProof = await fixture.pool.query<{ approval_security_fence: string }>(
      'SELECT approval_security_fence::text FROM control.ingestion_job WHERE id=$1',[recovered.json().data.job_id]);
    expect(newProof.rows[0]!.approval_security_fence).toBe(barrier.rows[0]!.effective_fence);
    const oldProof = await fixture.pool.query<{ approval_security_fence: string; security_barrier_fence_at_admission: string }>(
      'SELECT approval_security_fence::text,security_barrier_fence_at_admission::text FROM control.ingestion_job WHERE id=$1',[jobId]);
    expect(oldProof.rows[0]).toEqual(before.rows[0]);
  });

  it('uses source ownership and same-tenant source:read manager scope for safe job reads', async () => {
    const sourceRead = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${jobId}`,headers:{authorization:`Bearer ${sourceToken}`} });
    expect(sourceRead.statusCode).toBe(200);
    expect(sourceRead.body).not.toContain('public_record');
    expect(sourceRead.body).not.toContain('body_bytes');
    const itemRead = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${jobId}/items`,headers:{authorization:`Bearer ${sourceToken}`} });
    expect(itemRead.statusCode).toBe(200);
    expect(itemRead.json().data.items[0]).toMatchObject({status:'RECEIVED',error_code:null});
    const managerRead = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${jobId}`,headers:{authorization:'Bearer opaque-manager-token'} });
    expect(managerRead.statusCode).toBe(200);
    const pageJob = await post(JSON.stringify(customerBatch(25)),'item-page-job');
    expect(pageJob.statusCode).toBe(202);
    const firstPage = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${pageJob.json().data.job_id}/items`,headers:{authorization:`Bearer ${sourceToken}`} });
    expect(firstPage.json().data.items).toHaveLength(20);
    expect(firstPage.json().data.items[0].source_pk).toMatch(/^C-/);
    expect(firstPage.json().data.next_cursor).toEqual(expect.any(String));
    const firstCursor = firstPage.json().data.next_cursor;
    const secondPage = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${pageJob.json().data.job_id}/items?cursor=${firstCursor}`,headers:{authorization:`Bearer ${sourceToken}`} });
    expect(secondPage.json().data.items).toHaveLength(5);
    expect(secondPage.json().data.next_cursor).toBeNull();
    const crossJobCursor = await app.inject({ method:'GET',url:`/hub/v1/ingestion-jobs/${jobId}/items?cursor=${firstCursor}`,headers:{authorization:`Bearer ${sourceToken}`} });
    expect(crossJobCursor.statusCode).toBe(422);
    const counts = await fixture.pool.query<{ api_raw_select: boolean; worker_raw_select: boolean; api_core_dml: boolean; mcp_ingest: boolean; publisher_ingest: boolean; hasura_ingest: boolean }>(`SELECT
      has_table_privilege('hub_api','raw.ingestion_batch','SELECT') AS api_raw_select,
      has_table_privilege('hub_worker','raw.ingestion_batch','SELECT') AS worker_raw_select,
      has_table_privilege('hub_api','hub.canonical_customer','INSERT') AS api_core_dml,
      has_table_privilege('hub_mcp','raw.ingestion_batch','SELECT') OR has_table_privilege('hub_mcp','control.ingestion_job','SELECT') AS mcp_ingest,
      has_table_privilege('hub_publisher','raw.ingestion_batch','SELECT') OR has_table_privilege('hub_publisher','control.ingestion_job','SELECT') AS publisher_ingest,
      has_table_privilege('hub_hasura_read','raw.ingestion_batch','SELECT') OR has_table_privilege('hub_hasura_read','control.ingestion_job','SELECT') AS hasura_ingest`);
    expect(counts.rows[0]).toEqual({api_raw_select:false,worker_raw_select:true,api_core_dml:false,mcp_ingest:false,publisher_ingest:false,hasura_ingest:false});
    await expect(apiPool.query('SELECT body_bytes FROM raw.ingestion_batch')).rejects.toMatchObject({ code:'42501' });
    await expect(apiPool.query('INSERT INTO hub.canonical_customer(tenant_key,id,customer_name,owner_user_id,dept_external_id,status,source_version,hub_revision) VALUES($1,$2,$3,$4,$5,$6,1,1)',
      [tenantId,randomUUID(),'forbidden','owner-a','dept-a','ACTIVE'])).rejects.toMatchObject({ code:'42501' });
  });
});
