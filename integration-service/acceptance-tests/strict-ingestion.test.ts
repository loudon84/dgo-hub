import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { runDurableWorkerOnce } from '../etl-worker/worker.js';

const evidenceRoot = process.env.M0_RUN_EVIDENCE_ROOT
  ?? 'E:\\git\\dgo-hub\\docs\\execution\\alpha1\\m1-task-3-evidence\\d825e7c7-136b-4900-a644-2014f1d24c0e';
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

async function postAs(token: string, body: Buffer | string, key = `key-${randomUUID()}`, url = route) {
  return app.inject({ method:'POST',url,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},payload:body });
}

function orderBatch(status: 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED', lines: unknown[] = [], orderNo='SO-1') {
  return { schema_version:'hub.v1',batch_id:randomUUID(),records:[{ event_id:randomUUID(),source_pk:`O-${randomUUID()}`,source_version:'1',
    operation:'UPSERT',source_updated_at:'2026-10-22T09:00:00+08:00',data:{ customer_ref:{source_id:sourceId,source_pk:'REF-C-1'},
      order_no:orderNo,status,order_at:'2026-10-22T09:00:00+08:00',amount:'100.00',currency:'CNY',lines } }] };
}

async function rowCounts() {
  return fixture.pool.query<{ jobs: string; raw: string; items: string; outbox: string }>(`SELECT
    (SELECT count(*)::text FROM control.ingestion_job WHERE tenant_key=$1 AND source_id=$2) AS jobs,
    (SELECT count(*)::text FROM raw.ingestion_batch WHERE tenant_key=$1 AND source_id=$2) AS raw,
    (SELECT count(*)::text FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id WHERE j.tenant_key=$1 AND j.source_id=$2) AS items,
    (SELECT count(*)::text FROM control.ingestion_processing_outbox o JOIN control.ingestion_job j ON j.id=o.job_id WHERE j.tenant_key=$1 AND j.source_id=$2) AS outbox`, [tenantId,sourceId]);
}

function hubWorkerPool(max = 4) {
  return new pg.Pool({ connectionString:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,
    options:'-c role=hub_worker',max });
}

async function registerWorkerSourceAtLength(length:number):Promise<{sourceId:string;token:string}> {
  const newSourceId='A'.repeat(length);
  const token=createCredential().secret;
  const auth=createAuthService({pool:fixture.pool});
  await auth.repository.provisionSourceCredential({tenantId,sourceId:newSourceId,token,secretRef:'vault:/fixture/crm',
    allowedEntities:['customer','order'],revision:'1'});
  await fixture.pool.query(`INSERT INTO control.source_registry(tenant_key,source_id,lifecycle,current_config_revision,mapping_revision,
      identity_mapping_revision,data_owner_user_id,owner_revision)
    SELECT tenant_key,$3,lifecycle,current_config_revision,mapping_revision,identity_mapping_revision,data_owner_user_id,owner_revision
      FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2`,[tenantId,sourceId,newSourceId]);
  await fixture.pool.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    SELECT tenant_key,$3,revision,config_digest,config,created_by FROM control.source_config_revision WHERE tenant_key=$1 AND source_id=$2`,
  [tenantId,sourceId,newSourceId]);
  await fixture.pool.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    SELECT tenant_key,$3,revision,mapping_digest,mappings,created_by FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2`,
  [tenantId,sourceId,newSourceId]);
  await fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    SELECT tenant_key,$3,revision,mapping_digest,mappings,created_by FROM control.source_identity_mapping_revision WHERE tenant_key=$1 AND source_id=$2`,
  [tenantId,sourceId,newSourceId]);
  const report=await fixture.pool.query<{id:string}>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
      identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
      endpoint_profile_digest,data_contract_ref,report,status,created_by)
    SELECT tenant_key,$3,config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,
      1,1,endpoint_profile_digest,data_contract_ref,report,status,created_by FROM control.source_test_report
      WHERE tenant_key=$1 AND source_id=$2 ORDER BY created_at LIMIT 1 RETURNING id::text`,[tenantId,sourceId,newSourceId]);
  const approval=await fixture.pool.query<{id:string}>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
      config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,
      credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    SELECT tenant_key,$3,owner_user_id,owner_revision,config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,
      identity_mapping_digest,1,1,endpoint_profile_digest,data_contract_ref,$4 FROM control.source_owner_approval
      WHERE tenant_key=$1 AND source_id=$2 ORDER BY created_at LIMIT 1 RETURNING id::text`,[tenantId,sourceId,newSourceId,report.rows[0]!.id]);
  await fixture.pool.query(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
    SELECT tenant_key,$3,entity,connector,mode,version_domain,channel_epoch,state FROM control.source_channel
      WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND state='active'`,[tenantId,sourceId,newSourceId]);
  await fixture.pool.query(`UPDATE control.source_registry SET lifecycle='ACTIVE' WHERE tenant_key=$1 AND source_id=$2`,[tenantId,newSourceId]);
  expect(report.rowCount).toBe(1);
  expect(approval.rowCount).toBe(1);
  return {sourceId:newSourceId,token};
}

async function killWorkerAtBoundary(point: 'after_claim'|'after_commit', leaseMs = 500): Promise<void> {
  const serviceDirectory=dirname(dirname(fileURLToPath(import.meta.url)));
  const child=spawn(process.execPath,[join(serviceDirectory,'node_modules/vitest/vitest.mjs'),'run','--reporter=dot',
    '--testNamePattern=holds a claimed worker at the requested crash boundary','acceptance-tests/worker-crash-driver.test.ts'],{
    cwd:serviceDirectory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{
      PATH:process.env.PATH ?? '',SystemRoot:process.env.SystemRoot ?? '',M0_RUN_EVIDENCE_ROOT:evidenceRoot,
      DGO_WORKER_CONNECTION:`postgres://postgres@127.0.0.1:${fixture.hostPort}/postgres`,
      DGO_WORKER_CRASH_POINT:point,DGO_WORKER_LEASE_MS:String(leaseMs),
    },
  });
  let output='';
  const ready=new Promise<void>((resolveReady,rejectReady)=>{
    const timer=setTimeout(()=>rejectReady(new Error(`WORKER_CRASH_BOUNDARY_TIMEOUT:${output.slice(-2000)}`)),90_000);
    child.stdout.on('data',(chunk:Buffer)=>{
      output+=chunk.toString('utf8');
      if(output.includes('DGO_CRASH_READY')) { clearTimeout(timer); resolveReady(); }
    });
    child.stderr.on('data',(chunk:Buffer)=>{ output+=chunk.toString('utf8'); });
    child.once('error',error=>{ clearTimeout(timer); rejectReady(error); });
    child.once('exit',(code,signal)=>{
      if(!output.includes('DGO_CRASH_READY')) { clearTimeout(timer); rejectReady(new Error(`WORKER_EXITED_BEFORE_BOUNDARY:${code}:${signal}:${output.slice(-2000)}`)); }
    });
  });
  await ready;
  child.kill();
  await new Promise<void>((resolveExit,rejectExit)=>{
    child.once('exit',()=>resolveExit());
    child.once('error',rejectExit);
  });
}

beforeAll(async () => {
  fixture = await startOwnedPostgres({ evidenceRoot, taskLabel: 'task3', evidenceFile: join(evidenceRoot,'task3','placeholder.jsonl') });
  await runMigrations(fixture.pool, { directory: migrationsDirectory, environmentKind: 'local_lab' });
  const seedAuth = createAuthService({ pool: fixture.pool });
  await seedAuth.repository.provisionTenant({ tenantId, businessTimezone: 'Asia/Shanghai' });
  await seedAuth.repository.provisionSubject({ tenantId, userId: 'owner-a', departmentId: 'sales-east', businessRole: 'sales', managementScopes: ['source:read','source:write','source:approve'] });
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
  const referenceCustomerId=randomUUID();
  await fixture.pool.query(`INSERT INTO hub.canonical_customer
    (tenant_id,id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision)
    VALUES($1,$2,'Reference Customer','owner-a','sales-east','ACTIVE','2026-10-22T00:00:00Z',1,'SOURCE_VERSION',1,1)`,
  [tenantId,referenceCustomerId]);
  await fixture.pool.query(`INSERT INTO control.canonical_source_identity
    (tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id)
    VALUES($1,$2,'customer','REF-C-1',$3,$3)`,[tenantId,sourceId,referenceCustomerId]);
  await fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4,'owner-a')`, [tenantId,sourceId,identityDigest,JSON.stringify([
      {kind:'user',external_id:'sales-a',target_id:'owner-a'},
      {kind:'user',external_id:'sales-b',target_id:'owner-a'},
      {kind:'department',external_id:'dept-a',target_id:'sales-east'},
      {kind:'customer',external_id:'REF-C-1',target_id:referenceCustomerId},
    ])]);
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

  it('rejects invalid enum and identifier images without durable rows', async () => {
    const before = await rowCounts();
    for (const [field, value] of [['status', ['CONFIRMED']], ['status', { value: 'CONFIRMED' }],
      ['currency', ['CNY']], ['currency', { value: 'CNY' }]] as const) {
      const body = orderBatch(field === 'currency' ? 'DRAFT' : 'CONFIRMED');
      (body.records[0]!.data as Record<string, unknown>)[field] = value;
      const response = await post(JSON.stringify(body), `invalid-enum-${randomUUID()}`, orderRoute);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.retryable).toBe(false);
    }
    for (const field of ['owner_external_id', 'department_external_id'] as const) {
      for (const value of ['x'.repeat(129), ' x']) {
        const body = customerBatch();
        (body.records[0]!.data as Record<string, unknown>)[field] = value;
        expect((await post(JSON.stringify(body))).statusCode).toBe(422);
      }
    }
    expect((await rowCounts()).rows[0]).toEqual(before.rows[0]);
  });

  it('stores chronological source range across record order, offsets and microseconds', async () => {
    const body = customerBatch(3);
    body.records[0]!.source_updated_at = '2026-10-22T10:00:00.123457+08:00';
    body.records[1]!.source_updated_at = '2026-10-22T01:59:59.999999Z';
    body.records[2]!.source_updated_at = '2026-10-21T18:00:00.123456-08:00';
    const response = await post(JSON.stringify(body));
    expect(response.statusCode).toBe(202);
    const id = response.json().data.job_id;
    const range = await fixture.pool.query<{ first: string; last: string; facts: string[] }>(`SELECT
      to_char(j.first_source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS first,
      to_char(j.last_source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS last,
      (SELECT array_agg(i.public_record->>'source_updated_at' ORDER BY i.ordinal) FROM control.ingestion_job_item i WHERE i.job_id=j.id) AS facts
      FROM control.ingestion_job j WHERE j.id=$1`, [id]);
    expect(range.rows[0]).toEqual({ first: '2026-10-22T01:59:59.999999', last: '2026-10-22T02:00:00.123457',
      facts: body.records.map(record => record.source_updated_at) });
    const read = await app.inject({ method:'GET', url:`/hub/v1/ingestion-jobs/${id}`, headers:{authorization:`Bearer ${sourceToken}`} });
    expect(read.statusCode).toBe(200);
    expect(Date.parse(read.json().data.first_source_updated_at)).toBe(Date.parse('2026-10-22T01:59:59.999Z'));
    expect(Date.parse(read.json().data.last_source_updated_at)).toBe(Date.parse('2026-10-22T02:00:00.123Z'));
  });

  it('rejects private-key and deep JSON over HTTP without durable writes', async () => {
    const before = await rowCounts();
    for (const payload of ['{"SYNTHETIC_PRIVATE_MARKER":1}', '{"SYNTHETIC_PRIVATE_MARKER":1,"SYNTHETIC_PRIVATE_MARKER":2}',
      '['.repeat(5000) + '0' + ']'.repeat(5000)]) {
      const response = await post(payload);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.retryable).toBe(false);
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    }
    expect((await rowCounts()).rows[0]).toEqual(before.rows[0]);
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

describe('M1-4 durable strict worker', () => {
  it('applies frozen HTTP jobs with 128, 129, and 256 character source IDs unchanged', async () => {
    const jobs:string[]=[];
    const sources:string[]=[];
    for(const length of [128,129,256]) {
      const registered=await registerWorkerSourceAtLength(length);
      const batch=customerBatch();
      batch.records[0]!.source_pk=`LONG-SOURCE-${length}`;
      const accepted=await postAs(registered.token,JSON.stringify(batch),`long-source-${length}`);
      expect(accepted.statusCode).toBe(202);
      jobs.push(accepted.json().data.job_id as string);
      sources.push(registered.sourceId);
    }
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at='2099-01-01T00:00:00Z'::timestamptz WHERE acknowledged_at IS NULL`);
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=ANY($1::uuid[])`,[jobs]);
    const worker=hubWorkerPool();
    const applyErrors:string[]=[];
    try { await runDurableWorkerOnce(worker,{limit:10,hooks:{onApplyError:async error=>{
      applyErrors.push(error instanceof Error?error.message:'NON_ERROR_APPLY_FAILURE');
    }}}); }
    finally { await worker.end(); }
    expect(applyErrors).toEqual([]);
    const outcomes=await fixture.pool.query<{source_id:string;source_pk:string;item_status:string;job_status:string;applied_count:number}>(`SELECT
      j.source_id,i.source_pk,i.status AS item_status,j.status AS job_status,j.applied_count
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=ANY($1::uuid[])
      ORDER BY j.source_id`,[jobs]);
    expect(outcomes.rows).toEqual(sources.map((id,index)=>({source_id:id,source_pk:`LONG-SOURCE-${[128,129,256][index]}`,
      item_status:'APPLIED',job_status:'SUCCEEDED',applied_count:1})).sort((a,b)=>a.source_id.localeCompare(b.source_id)));
  });

  it('applies a committed HTTP job as hub_worker and records the canonical effect with its terminal summary', async () => {
    const batch = customerBatch();
    const sourcePk = batch.records[0]!.source_pk;
    const accepted = await post(JSON.stringify(batch), 'worker-applies-customer');
    expect(accepted.statusCode).toBe(202);
    const worker = hubWorkerPool(2);
    try {
      await runDurableWorkerOnce(worker,{limit:100});
      const state = await fixture.pool.query<{ status: string; applied_count: number; item_status: string; attempts_started: number;
        customers: string; receipts: string; events: string; acknowledged: boolean }>(`SELECT j.status,j.applied_count,
          i.status AS item_status,i.attempts_started::integer,
          (SELECT count(*)::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c
            ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
            WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.entity='customer' AND s.source_pk=$2
              AND c.customer_name='Synthetic Customer') AS customers,
          (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id
            AND r.entity='customer' AND r.source_pk=$2) AS receipts,
          (SELECT count(*)::text FROM control.canonical_apply_outbox e JOIN control.canonical_source_identity s
            ON (s.tenant_key,s.source_id,s.entity,s.canonical_object_id)=(e.tenant_key,e.source_id,e.entity,e.canonical_object_id)
            WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id AND s.entity='customer' AND s.source_pk=$2) AS events,
          o.acknowledged_at IS NOT NULL AS acknowledged
          FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
          JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`, [accepted.json().data.job_id, sourcePk]);
      expect(state.rows[0]).toEqual({ status:'SUCCEEDED',applied_count:1,item_status:'APPLIED',attempts_started:1,
        customers:'1',receipts:'1',events:'1',acknowledged:true });
    } finally {
      await worker.end();
    }
  });

  it('preserves source version outcomes and counts only committed APPLIED effects', async () => {
    const makeBatch=(version:string,name='Versioned Customer')=>{
      const body=customerBatch();
      body.records[0]!.source_pk='VERSION-MATRIX-C1';
      body.records[0]!.source_version=version;
      (body.records[0]!.data as Record<string,unknown>).customer_name=name;
      return body;
    };
    const cases=[
      {body:makeBatch('2'),status:'APPLIED',job:'SUCCEEDED',applied:1},
      {body:makeBatch('1'),status:'IGNORED_STALE',job:'SUCCEEDED',applied:0},
      {body:makeBatch('2'),status:'DUPLICATE',job:'SUCCEEDED',applied:0},
      {body:makeBatch('2','Conflicting Customer'),status:'QUARANTINED',job:'FAILED',applied:0},
      {body:makeBatch('3','Newer Customer'),status:'APPLIED',job:'SUCCEEDED',applied:1},
    ] as const;
    const jobs:string[]=[];
    for(const [index,item] of cases.entries()) {
      const accepted=await post(JSON.stringify(item.body),`version-matrix-${index}`);
      expect(accepted.statusCode).toBe(202);
      jobs.push(accepted.json().data.job_id);
    }
    const worker=hubWorkerPool();
    try {
      await runDurableWorkerOnce(worker,{limit:100});
    } finally { await worker.end(); }
    const results=await fixture.pool.query<{job_id:string;item_status:string;error_code:string|null;job_status:string;applied_count:number}>(`SELECT j.id::text AS job_id,
      i.status AS item_status,i.error_code,j.status AS job_status,j.applied_count
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
      WHERE j.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],j.id)`,[jobs]);
    expect(results.rows).toEqual(cases.map((item,index)=>({job_id:jobs[index]!,item_status:item.status,
      error_code:item.status==='QUARANTINED'?'SOURCE_VERSION_CONFLICT':null,job_status:item.job,applied_count:item.applied})));
  });

  it('summarizes mixed terminal outcomes as PARTIAL with only real APPLIED effects counted', async () => {
    const batch=customerBatch(2);
    batch.records[0]!.source_pk='PARTIAL-APPLIED-C1';
    batch.records[1]!.source_pk='PARTIAL-QUARANTINED-C2';
    batch.records[1]!.data.owner_external_id='missing-owner';
    const accepted=await post(JSON.stringify(batch),'partial-worker-summary');
    expect(accepted.statusCode).toBe(202);
    const id=accepted.json().data.job_id as string;
    const eventsBefore=(await fixture.pool.query<{count:string}>(`SELECT count(*)::text AS count FROM control.canonical_apply_outbox
      WHERE tenant_key=$1 AND source_id=$2 AND entity='customer'`,[tenantId,sourceId])).rows[0]!.count;
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=CASE WHEN job_id=$1 THEN '2000-01-01T00:00:00Z'::timestamptz
      ELSE '2099-01-01T00:00:00Z'::timestamptz END WHERE acknowledged_at IS NULL`,[id]);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:1}); }
    finally { await worker.end(); }
    const state=await fixture.pool.query<{job_status:string;applied_count:number;items:Array<{status:string;error_code:string|null;source_pk:string}>;
      applied_identities:string;receipts:string;events:string}>(`SELECT j.status AS job_status,j.applied_count,
      (SELECT jsonb_agg(jsonb_build_object('status',i.status,'error_code',i.error_code,'source_pk',i.source_pk) ORDER BY i.ordinal)
        FROM control.ingestion_job_item i WHERE i.job_id=j.id) AS items,
      (SELECT count(*)::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c
        ON c.tenant_id=s.tenant_key AND c.id=s.customer_id AND c.deleted_at IS NULL
        WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.entity='customer'
          AND s.source_pk=ANY(ARRAY['PARTIAL-APPLIED-C1','PARTIAL-QUARANTINED-C2'])) AS applied_identities,
      (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id
        AND r.source_pk=ANY(ARRAY['PARTIAL-APPLIED-C1','PARTIAL-QUARANTINED-C2'])) AS receipts,
      (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id
        AND e.entity='customer') AS events
      FROM control.ingestion_job j WHERE j.id=$1`,[id]);
    expect(state.rows[0]).toEqual({job_status:'PARTIAL',applied_count:1,
      items:[{status:'APPLIED',error_code:null,source_pk:'PARTIAL-APPLIED-C1'},{status:'QUARANTINED',error_code:'IDENTITY_MAPPING_REQUIRED',source_pk:'PARTIAL-QUARANTINED-C2'}],
      applied_identities:'1',receipts:'1',events:String(BigInt(eventsBefore)+1n)});
  });

  it('quarantines an order when the frozen customer target disagrees with the full source reference tuple', async () => {
    const batch=orderBatch('DRAFT');
    batch.records[0]!.data.customer_ref.source_id='other-crm';
    const accepted=await post(JSON.stringify(batch),'cross-source-customer-reference',orderRoute);
    expect(accepted.statusCode).toBe(202);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:100}); }
    finally { await worker.end(); }
    const state=await fixture.pool.query<{item_status:string;error_code:string|null;job_status:string;applied_count:number;orders:string}>(`SELECT i.status AS item_status,
      i.error_code,j.status AS job_status,j.applied_count,
      (SELECT count(*)::text FROM control.canonical_source_identity s WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id
        AND s.entity='order' AND s.source_pk=$2) AS orders
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[accepted.json().data.job_id,batch.records[0]!.source_pk]);
    expect(state.rows[0]).toEqual({item_status:'QUARANTINED',error_code:'IDENTITY_MAPPING_TARGET_INVALID',job_status:'FAILED',applied_count:0,orders:'0'});
  });

  it('preserves canonical timestamp precision and exact decimal scale at the worker adapter', async () => {
    const batch=orderBatch('CONFIRMED',[{source_line_id:'EXACT-LINE-1',product_code:'SKU-EXACT',product_name:'Exact Values',
      quantity:'1.5',unit_price:'10.1',line_amount:'15.15'}],'EXACT-ORDER-1');
    batch.records[0]!.source_pk='EXACT-ORDER-PK-1';
    batch.records[0]!.source_updated_at='2026-10-22T09:00:00.123456+08:00';
    batch.records[0]!.data.order_at='2026-10-22T09:00:01.654321+08:00';
    batch.records[0]!.data.amount='100.1';
    const accepted=await post(JSON.stringify(batch),'exact-worker-adapter',orderRoute);
    const id=accepted.json().data.job_id as string;
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=CASE WHEN job_id=$1 THEN '2000-01-01T00:00:00Z'::timestamptz
      ELSE '2099-01-01T00:00:00Z'::timestamptz END WHERE acknowledged_at IS NULL`,[id]);
    const worker=hubWorkerPool();
    let applyError:unknown;
    try { await runDurableWorkerOnce(worker,{limit:1,hooks:{onApplyError:async error=>{applyError=error;}}}); }
    finally { await worker.end(); }
    const stored=await fixture.pool.query<{status:string;source_updated_at:string;order_at:string;amount:string;
      quantity:string;unit_price:string;line_amount:string}>(`SELECT i.status,
      to_char(o.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_updated_at,
      to_char(o.order_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS order_at,
      o.amount::text,l.quantity::text,l.unit_price::text,l.line_amount::text
      FROM control.ingestion_job_item i LEFT JOIN control.canonical_source_identity s
        ON s.tenant_key=$1 AND s.source_id=$2 AND s.entity='order' AND s.source_pk=i.source_pk
      LEFT JOIN hub.canonical_order o ON o.tenant_id=s.tenant_key AND o.id=s.order_id
      LEFT JOIN hub.canonical_order_line l ON l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.source_line_id='EXACT-LINE-1'
      WHERE i.job_id=$3 AND i.source_pk='EXACT-ORDER-PK-1'`,[tenantId,sourceId,id]);
    expect(applyError === undefined ? undefined : String(applyError)).toBeUndefined();
    expect(stored.rows[0]).toEqual({status:'APPLIED',source_updated_at:'2026-10-22T01:00:00.123456Z',
      order_at:'2026-10-22T01:00:01.654321Z',amount:'100.10',quantity:'1.500000',unit_price:'10.100000',line_amount:'15.15'});
  });

  it('keeps the retry budget, due times, and operation identity across failed transactions', async () => {
    const batch=customerBatch();
    batch.records[0]!.source_pk='RETRY-BUDGET-C1';
    const accepted=await post(JSON.stringify(batch),'durable-retry-budget');
    expect(accepted.statusCode).toBe(202);
    const jobId=accepted.json().data.job_id as string;
    const operation=(await fixture.pool.query<{operation_id:string}>('SELECT operation_id::text FROM control.ingestion_job_item WHERE job_id=$1',[jobId])).rows[0]!.operation_id;
    const eventsBefore=(await fixture.pool.query<{count:string}>('SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId])).rows[0]!.count;
    const worker=hubWorkerPool();
    try {
      for(let attempt=1;attempt<=4;attempt+=1) {
        await runDurableWorkerOnce(worker,{limit:100,hooks:{afterCanonicalApply:async()=>{throw new Error('synthetic transaction fault');}}});
        const state=await fixture.pool.query<{status:string;error_code:string|null;attempts:number;retries:number;operation_id:string;
          delay_ms:number|null;customers:string;receipts:string;events:string}>(`SELECT i.status,i.error_code,i.attempts_started::integer AS attempts,
          i.retries_used::integer AS retries,i.operation_id::text,
          CASE WHEN i.next_retry_at IS NULL THEN NULL ELSE round(extract(epoch FROM (i.next_retry_at-i.updated_at))*1000)::integer END AS delay_ms,
          (SELECT count(*)::text FROM hub.canonical_customer c JOIN control.canonical_source_identity s
            ON s.tenant_key=c.tenant_id AND s.customer_id=c.id WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.source_pk='RETRY-BUDGET-C1') AS customers,
          (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk='RETRY-BUDGET-C1') AS receipts,
          (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
          FROM control.ingestion_job_item i JOIN control.ingestion_job j ON j.id=i.job_id WHERE i.job_id=$1`,[jobId]);
        const row=state.rows[0]!;
        expect(row).toMatchObject({status:attempt<4?'RETRY_PENDING':'QUARANTINED',error_code:attempt<4?'WORKER_TRANSIENT_FAILURE':'RETRY_BUDGET_EXHAUSTED',
          attempts:attempt,retries:attempt-1,operation_id:operation,customers:'0',receipts:'0',events:eventsBefore});
        if(attempt<4) {
          const expected=[5000,30000,120000][attempt-1]!;
          expect(row.delay_ms).toBeGreaterThan(expected-200);
          expect(row.delay_ms).toBeLessThanOrEqual(expected);
          await fixture.pool.query(`UPDATE control.ingestion_job_item SET next_retry_at=clock_timestamp() WHERE job_id=$1`,[jobId]);
          await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=clock_timestamp() WHERE job_id=$1`,[jobId]);
        } else expect(row.delay_ms).toBeNull();
      }
      const job=await fixture.pool.query<{status:string;applied_count:number;acknowledged:boolean}>(`SELECT j.status,j.applied_count,
        o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job j JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`,[jobId]);
      expect(job.rows[0]).toEqual({status:'FAILED',applied_count:0,acknowledged:true});
    } finally { await worker.end(); }
  });

  it('rolls back canonical writes when a database trigger rejects a written customer header', async () => {
    const batch=customerBatch();
    batch.records[0]!.source_pk='HEADER-ROLLBACK-C1';
    (batch.records[0]!.data as Record<string,unknown>).customer_name='Rollback Header Customer';
    const accepted=await post(JSON.stringify(batch),'rollback-after-customer-header');
    expect(accepted.statusCode).toBe(202);
    const eventsBefore=(await fixture.pool.query<{count:string}>('SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId])).rows[0]!.count;
    await fixture.pool.query(`CREATE FUNCTION control.test_fail_worker_customer_header() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic worker header failure'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER test_fail_worker_customer_header AFTER INSERT ON hub.canonical_customer
      FOR EACH ROW WHEN (NEW.customer_name='Rollback Header Customer') EXECUTE FUNCTION control.test_fail_worker_customer_header()`);
    const worker=hubWorkerPool();
    try {
      await runDurableWorkerOnce(worker,{limit:100});
    } finally {
      await worker.end();
      await fixture.pool.query('DROP TRIGGER IF EXISTS test_fail_worker_customer_header ON hub.canonical_customer');
      await fixture.pool.query('DROP FUNCTION IF EXISTS control.test_fail_worker_customer_header()');
    }
    const state=await fixture.pool.query<{status:string;attempts:number;applied_count:number;identities:string;customers:string;receipts:string;events:string}>(`SELECT i.status,
      i.attempts_started::integer AS attempts,j.applied_count,
      (SELECT count(*)::text FROM control.canonical_source_identity s WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.source_pk='HEADER-ROLLBACK-C1') AS identities,
      (SELECT count(*)::text FROM hub.canonical_customer c JOIN control.canonical_source_identity s
        ON s.tenant_key=c.tenant_id AND s.customer_id=c.id WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.source_pk='HEADER-ROLLBACK-C1') AS customers,
      (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk='HEADER-ROLLBACK-C1') AS receipts,
      (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[accepted.json().data.job_id]);
    expect(state.rows[0]).toEqual({status:'RETRY_PENDING',attempts:1,applied_count:0,identities:'0',customers:'0',receipts:'0',events:eventsBefore});
  });

  it('starts the full retry delay when a long database attempt fails and rolls back', async () => {
    const batch=customerBatch();
    batch.records[0]!.source_pk='LONG-FAILURE-RETRY-C1';
    (batch.records[0]!.data as Record<string,unknown>).customer_name='Long Failure Customer';
    const accepted=await post(JSON.stringify(batch),'long-failure-retry-delay');
    expect(accepted.statusCode).toBe(202);
    const jobId=accepted.json().data.job_id as string;
    const operation=(await fixture.pool.query<{operation_id:string}>(
      'SELECT operation_id::text FROM control.ingestion_job_item WHERE job_id=$1',[jobId])).rows[0]!.operation_id;
    await fixture.pool.query(`CREATE FUNCTION control.test_long_worker_customer_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(5.5); RAISE EXCEPTION 'synthetic long worker failure'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER test_long_worker_customer_failure BEFORE INSERT ON hub.canonical_customer
      FOR EACH ROW WHEN (NEW.customer_name='Long Failure Customer') EXECUTE FUNCTION control.test_long_worker_customer_failure()`);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:100}); }
    finally {
      await worker.end();
      await fixture.pool.query('DROP TRIGGER IF EXISTS test_long_worker_customer_failure ON hub.canonical_customer');
      await fixture.pool.query('DROP FUNCTION IF EXISTS control.test_long_worker_customer_failure()');
    }
    const state=await fixture.pool.query<{status:string;attempts:number;operation_id:string;remaining_ms:number}>(`SELECT i.status,
      i.attempts_started::integer AS attempts,i.operation_id::text,
      round(extract(epoch FROM (i.next_retry_at-clock_timestamp()))*1000)::integer AS remaining_ms
      FROM control.ingestion_job_item i WHERE i.job_id=$1`,[jobId]);
    expect(state.rows[0]).toMatchObject({status:'RETRY_PENDING',attempts:1,operation_id:operation});
    expect(state.rows[0]!.remaining_ms).toBeGreaterThan(4_000);
    const retryWorker=hubWorkerPool();
    try { await runDurableWorkerOnce(retryWorker,{limit:100}); }
    finally { await retryWorker.end(); }
    const after=await fixture.pool.query<{attempts:number;operation_id:string;status:string}>(
      'SELECT attempts_started::integer AS attempts,operation_id::text,status FROM control.ingestion_job_item WHERE job_id=$1',[jobId]);
    expect(after.rows[0]).toEqual({attempts:1,operation_id:operation,status:'RETRY_PENDING'});
  }, 15_000);

  it('rolls back canonical state when item status or the pre-commit boundary fails', async () => {
    const worker=hubWorkerPool();
    try {
      for(const [index,point] of (['beforeItemStatus','beforeItemCommit'] as const).entries()) {
        const batch=customerBatch();
        batch.records[0]!.source_pk=`STATUS-ROLLBACK-C${index}`;
        const accepted=await post(JSON.stringify(batch),`rollback-${point}`);
        expect(accepted.statusCode).toBe(202);
        const eventsBefore=(await fixture.pool.query<{count:string}>('SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId])).rows[0]!.count;
        const hooks={
          beforeItemStatus:async()=>{if(point==='beforeItemStatus')throw new Error('synthetic pre-status failure');},
          beforeItemCommit:async()=>{if(point==='beforeItemCommit')throw new Error('synthetic pre-commit failure');},
        };
        await runDurableWorkerOnce(worker,{limit:100,hooks});
        const state=await fixture.pool.query<{status:string;attempts:number;applied_count:number;identity_count:string;receipt_count:string;events:string}>(`SELECT i.status,
          i.attempts_started::integer AS attempts,j.applied_count,
          (SELECT count(*)::text FROM control.canonical_source_identity s WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id
            AND s.entity='customer' AND s.source_pk=$2) AS identity_count,
          (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk=$2) AS receipt_count,
          (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
          FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[accepted.json().data.job_id,batch.records[0]!.source_pk]);
        expect(state.rows[0]).toEqual({status:'RETRY_PENDING',attempts:1,applied_count:0,identity_count:'0',receipt_count:'0',events:eventsBefore});
      }
    } finally { await worker.end(); }
  });

  it('recovers an expired lease with a fresh token and fences stale ACK writes', async () => {
    const accepted=await post(JSON.stringify(customerBatch()),'expired-lease-fence');
    expect(accepted.statusCode).toBe(202);
    const jobId=accepted.json().data.job_id as string;
    const oldToken=randomUUID();
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET claim_token=$2,lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE job_id=$1`,[jobId,oldToken]);
    let freshToken='';
    const worker=hubWorkerPool();
    try {
      await runDurableWorkerOnce(worker,{limit:1,hooks:{afterClaim:async claim=>{freshToken=claim.token;}}});
      expect(freshToken).not.toBe(oldToken);
      const staleAck=await worker.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=clock_timestamp()
        WHERE job_id=$1 AND claim_token=$2`,[jobId,oldToken]);
      expect(staleAck.rowCount).toBe(0);
    } finally { await worker.end(); }
    const state=await fixture.pool.query<{item_status:string;acknowledged:boolean;attempts:number}>(`SELECT i.status AS item_status,
      o.acknowledged_at IS NOT NULL AS acknowledged,i.attempts_started::integer AS attempts FROM control.ingestion_job_item i
      JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[jobId]);
    expect(state.rows[0]).toEqual({item_status:'APPLIED',acknowledged:true,attempts:1});
  });

  it('lets concurrent hub_worker processes claim distinct jobs', async () => {
    const first=await post(JSON.stringify(customerBatch()),'concurrent-worker-one');
    const second=await post(JSON.stringify(customerBatch()),'concurrent-worker-two');
    const ids=[first.json().data.job_id as string,second.json().data.job_id as string];
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at='2000-01-01T00:00:00Z' WHERE job_id=ANY($1::uuid[])`,[ids]);
    const left=hubWorkerPool(1),right=hubWorkerPool(1);
    try {
      const claimed=await Promise.all([runDurableWorkerOnce(left,{limit:1}),runDurableWorkerOnce(right,{limit:1})]);
      expect(claimed).toEqual([1,1]);
    } finally { await Promise.all([left.end(),right.end()]); }
    const state=await fixture.pool.query<{status:string;applied_count:number}>(`SELECT j.status,j.applied_count FROM control.ingestion_job j
      WHERE j.id=ANY($1::uuid[]) ORDER BY j.id`,[ids]);
    expect(state.rows).toHaveLength(2);
    expect(state.rows).toEqual([{status:'SUCCEEDED',applied_count:1},{status:'SUCCEEDED',applied_count:1}]);
  });

  it('recovers after actual process termination before apply and after commit before ACK', async () => {
    const before=await post(JSON.stringify(customerBatch()),'crash-before-apply');
    const after=await post(JSON.stringify(customerBatch()),'crash-after-commit');
    const beforeJob=before.json().data.job_id as string,afterJob=after.json().data.job_id as string;
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at='2000-01-01T00:00:00Z' WHERE job_id=ANY($1::uuid[])`,[[beforeJob,afterJob]]);
    const beforePk=(await fixture.pool.query<{source_pk:string}>('SELECT source_pk FROM control.ingestion_job_item WHERE job_id=$1',[beforeJob])).rows[0]!.source_pk;
    const afterPk=(await fixture.pool.query<{source_pk:string}>('SELECT source_pk FROM control.ingestion_job_item WHERE job_id=$1',[afterJob])).rows[0]!.source_pk;
    await killWorkerAtBoundary('after_claim',500);
    const preApply=await fixture.pool.query<{status:string;attempts:number;acknowledged:boolean}>(`SELECT i.status,i.attempts_started::integer AS attempts,
      o.acknowledged_at IS NOT NULL AS acknowledged FROM control.ingestion_job_item i JOIN control.ingestion_processing_outbox o ON o.job_id=i.job_id WHERE i.job_id=$1`,[beforeJob]);
    expect(preApply.rows[0]).toEqual({status:'RECEIVED',attempts:0,acknowledged:false});
    await new Promise(resolve=>setTimeout(resolve,650));
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:1,leaseMs:500}); }
    finally { await worker.end(); }
    await killWorkerAtBoundary('after_commit',500);
    const committed=await fixture.pool.query<{status:string;attempts:number;acknowledged:boolean;receipts:string;events:string}>(`SELECT i.status,
      i.attempts_started::integer AS attempts,o.acknowledged_at IS NOT NULL AS acknowledged,
      (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk=$2) AS receipts,
      (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
      JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`,[afterJob,afterPk]);
    expect(committed.rows[0]).toMatchObject({status:'APPLIED',attempts:1,acknowledged:false,receipts:'1'});
    const eventCountBefore=(await fixture.pool.query<{count:string}>('SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId])).rows[0]!.count;
    await new Promise(resolve=>setTimeout(resolve,650));
    const replay=hubWorkerPool();
    try { await runDurableWorkerOnce(replay,{limit:1,leaseMs:500}); }
    finally { await replay.end(); }
    const final=await fixture.pool.query<{status:string;applied_count:number;acknowledged:boolean;receipt_count:string;events:string}>(`SELECT j.status,j.applied_count,
      o.acknowledged_at IS NOT NULL AS acknowledged,
      (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk=$2) AS receipt_count,
      (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
      FROM control.ingestion_job j JOIN control.ingestion_processing_outbox o ON o.job_id=j.id WHERE j.id=$1`,[afterJob,afterPk]);
    expect(final.rows[0]).toEqual({status:'SUCCEEDED',applied_count:1,acknowledged:true,receipt_count:'1',events:eventCountBefore});
    expect(beforePk).not.toBe(afterPk);
  },180_000);

  it('keeps order lines, receipts, and business outbox atomic when a selected line write fails', async () => {
    const batch=orderBatch('CONFIRMED',[{source_line_id:'LINE-ROLLBACK-1',product_code:'SKU-1',product_name:'Rollback Line',
      quantity:'1',unit_price:'10.000000',line_amount:'10.00'}],'ROLLBACK-ORDER-1');
    batch.records[0]!.data.amount='10.00';
    const accepted=await post(JSON.stringify(batch),'rollback-after-order-line',orderRoute);
    expect(accepted.statusCode).toBe(202);
    const eventsBefore=(await fixture.pool.query<{count:string}>('SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2',[tenantId,sourceId])).rows[0]!.count;
    await fixture.pool.query(`CREATE FUNCTION control.test_fail_worker_order_line() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic worker line failure'; END $$`);
    await fixture.pool.query(`CREATE TRIGGER test_fail_worker_order_line AFTER INSERT ON hub.canonical_order_line
      FOR EACH ROW WHEN (NEW.source_line_id='LINE-ROLLBACK-1') EXECUTE FUNCTION control.test_fail_worker_order_line()`);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:100}); }
    finally {
      await worker.end();
      await fixture.pool.query('DROP TRIGGER IF EXISTS test_fail_worker_order_line ON hub.canonical_order_line');
      await fixture.pool.query('DROP FUNCTION IF EXISTS control.test_fail_worker_order_line()');
    }
    const state=await fixture.pool.query<{status:string;attempts:number;orders:string;lines:string;receipts:string;events:string}>(`SELECT i.status,
      i.attempts_started::integer AS attempts,
      (SELECT count(*)::text FROM control.canonical_source_identity s WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id
        AND s.entity='order' AND s.source_pk=i.source_pk) AS orders,
      (SELECT count(*)::text FROM hub.canonical_order_line l JOIN hub.canonical_order o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
        JOIN control.canonical_source_identity s ON s.tenant_key=o.tenant_id AND s.order_id=o.id
        WHERE o.tenant_id=j.tenant_key AND s.source_id=j.source_id AND s.source_pk=i.source_pk) AS lines,
      (SELECT count(*)::text FROM control.source_version_receipt r WHERE r.tenant_key=j.tenant_key AND r.source_id=j.source_id AND r.source_pk=$2) AS receipts,
      (SELECT count(*)::text FROM control.canonical_apply_outbox e WHERE e.tenant_key=j.tenant_key AND e.source_id=j.source_id) AS events
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[accepted.json().data.job_id,batch.records[0]!.source_pk]);
    expect(state.rows[0]).toEqual({status:'RETRY_PENDING',attempts:1,orders:'0',lines:'0',receipts:'0',events:eventsBefore});
  });

  it('isolates each newer typed security barrier during worker apply', async () => {
    const managementAuth=createAuthService({pool:fixture.pool});
    const owner=await managementAuth.resolveOidc('https://fixture.example.test','owner-a');
    const sourceRegistry=createSourceRegistryService({
      pool:fixture.pool,auth:managementAuth,
      secretResolver:{isConfiguredReference:reference=>reference==='vault:/fixture/crm',resolve:async()=> 'fixture-secret'},
      endpointAllowlist:{resolve:async reference=>{
        if(reference!=='crm-fixture') throw new Error('unapproved endpoint reference');
        return endpointProfile;
      }},
      capabilityProbe:{run:async()=>({passed:true,checks:['FIXTURE_CAPABILITY_PASS']})},environmentKind:'site',
    });
    const recoverApproval=async()=>{
      await sourceRegistry.pause(owner,sourceId,'1','synthetic worker barrier review');
      await managementAuth.repository.updateSourceCredential(sourceId,tenantId,true,'1',['customer','order']);
      const tested=await sourceRegistry.test(owner,sourceId,'1');
      const approval=await sourceRegistry.approve(owner,sourceId,'1',tested.test_report_id,tested.data_contract_ref);
      await sourceRegistry.activate(owner,sourceId,'1',approval.approval_id);
    };
    await recoverApproval();
    const barriers=[
      {type:'CREDENTIAL_COMPROMISE',expected:'SECURITY_BARRIER_ACTIVE'},
      {type:'SOURCE_SCOPE_SECURITY_REMOVAL',expected:'SECURITY_BARRIER_ACTIVE'},
      {type:'CHANNEL_RETIRED',expected:'CHANNEL_EPOCH_RETIRED'},
      {type:'TENANT_DISABLED',expected:'SECURITY_BARRIER_ACTIVE'},
    ] as const;
    for(const [index,barrier] of barriers.entries()) {
      const batch=customerBatch();
      batch.records[0]!.source_pk=`BARRIER-WORKER-C${index+1}`;
      const accepted=await post(JSON.stringify(batch),`barrier-worker-${barrier.type}`);
      expect(accepted.statusCode,JSON.stringify(accepted.json())).toBe(202);
      const id=accepted.json().data.job_id as string;
      await fixture.pool.query(`INSERT INTO control.source_security_barrier
        (tenant_key,source_id,credential_id,entity,channel_id,barrier_type,reason_code,created_by)
        SELECT j.tenant_key,
          CASE WHEN $2='TENANT_DISABLED' THEN NULL ELSE j.source_id END,
          CASE WHEN $2='CREDENTIAL_COMPROMISE' THEN j.credential_id ELSE NULL END,
          CASE WHEN $2='SOURCE_SCOPE_SECURITY_REMOVAL' THEN j.entity ELSE NULL END,
          CASE WHEN $2='CHANNEL_RETIRED' THEN j.channel_id ELSE NULL END,
          $2,'SYNTHETIC_WORKER_BARRIER','fixture'
        FROM control.ingestion_job j WHERE j.id=$1`,[id,barrier.type]);
      await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=CASE WHEN job_id=$1 THEN '2000-01-01T00:00:00Z'::timestamptz
        ELSE '2099-01-01T00:00:00Z'::timestamptz END WHERE acknowledged_at IS NULL`,[id]);
      const worker=hubWorkerPool();
      try { await runDurableWorkerOnce(worker,{limit:1}); }
      finally { await worker.end(); }
      const result=await fixture.pool.query<{status:string;error_code:string|null;job_status:string;applied_count:number;customers:string}>(`SELECT i.status,i.error_code,j.status AS job_status,j.applied_count,
        (SELECT count(*)::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c
          ON c.tenant_id=s.tenant_key AND c.id=s.customer_id AND c.deleted_at IS NULL
          WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.entity='customer' AND s.source_pk=i.source_pk) AS customers
        FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[id]);
      expect(result.rows[0]).toEqual({status:'QUARANTINED',error_code:barrier.expected,job_status:'FAILED',applied_count:0,customers:'0'});
      if(index<barriers.length-1) await recoverApproval();
    }
    await recoverApproval();
  });

  it('finishes frozen work after ordinary source epoch drift', async () => {
    const accepted=await post(JSON.stringify(customerBatch()),'worker-source-epoch-drift');
    expect(accepted.statusCode).toBe(202);
    const id=accepted.json().data.job_id as string;
    await createAuthService({pool:fixture.pool}).repository.advanceSourceEpoch(sourceId,tenantId);
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox SET available_at=CASE WHEN job_id=$1 THEN '2000-01-01T00:00:00Z'::timestamptz
      ELSE '2099-01-01T00:00:00Z'::timestamptz END WHERE acknowledged_at IS NULL`,[id]);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:1}); }
    finally { await worker.end(); }
    const result=await fixture.pool.query<{status:string;error_code:string|null;job_status:string;applied_count:number}>(`SELECT i.status,i.error_code,j.status AS job_status,j.applied_count
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id WHERE j.id=$1`,[id]);
    expect(result.rows[0]).toEqual({status:'APPLIED',error_code:null,job_status:'SUCCEEDED',applied_count:1});
  });

  it('isolates an explicitly remapped frozen identity while completing unrelated frozen work', async () => {
    const affectedBatch=customerBatch();
    affectedBatch.records[0]!.source_pk='REMAP-FENCE-AFFECTED';
    const unrelatedBatch=customerBatch();
    unrelatedBatch.records[0]!.source_pk='REMAP-FENCE-UNRELATED';
    (unrelatedBatch.records[0]!.data as Record<string,unknown>).owner_external_id='sales-b';
    const affected=await post(JSON.stringify(affectedBatch),'worker-remap-fence-affected');
    const unrelated=await post(JSON.stringify(unrelatedBatch),'worker-remap-fence-unrelated');
    expect(affected.statusCode).toBe(202);
    expect(unrelated.statusCode).toBe(202);
    const affectedId=affected.json().data.job_id as string;
    const unrelatedId=unrelated.json().data.job_id as string;
    await fixture.pool.query(`INSERT INTO control.source_identity_mapping_revision
      (tenant_key,source_id,revision,mapping_digest,mappings,created_by)
      VALUES($1,$2,2,$3,$4::jsonb,'owner-a')`,[tenantId,sourceId,Buffer.alloc(32,0x23),JSON.stringify([
        {kind:'user',external_id:'sales-a',target_id:'owner-b'},
        {kind:'user',external_id:'sales-b',target_id:'owner-a'},
        {kind:'department',external_id:'dept-a',target_id:'sales-east'},
        {kind:'customer',external_id:'REF-C-1',target_id:(await fixture.pool.query<{customer_id:string}>(
          "SELECT customer_id::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND entity='customer' AND source_pk='REF-C-1'",
          [tenantId,sourceId])).rows[0]!.customer_id},
      ])]);
    await fixture.pool.query(`INSERT INTO control.source_identity_remap_fence
      (tenant_key,source_id,kind,external_id,identity_mapping_revision)
      VALUES($1,$2,'user','sales-a',2)`,[tenantId,sourceId]);
    await fixture.pool.query(`UPDATE control.ingestion_processing_outbox
      SET available_at='2000-01-01T00:00:00Z'::timestamptz WHERE job_id=ANY($1::uuid[]) AND acknowledged_at IS NULL`,[[affectedId,unrelatedId]]);
    const worker=hubWorkerPool();
    try { await runDurableWorkerOnce(worker,{limit:10}); }
    finally { await worker.end(); }
    const outcomes=await fixture.pool.query<{source_pk:string;item_status:string;error_code:string|null;job_status:string;applied_count:number;customers:string}>(`SELECT i.source_pk,i.status AS item_status,i.error_code,j.status AS job_status,j.applied_count,
      (SELECT count(*)::text FROM control.canonical_source_identity s JOIN hub.canonical_customer c
        ON (c.tenant_id,c.id)=(s.tenant_key,s.customer_id)
        WHERE s.tenant_key=j.tenant_key AND s.source_id=j.source_id AND s.entity='customer' AND s.source_pk=i.source_pk) AS customers
      FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id
      WHERE j.id=ANY($1::uuid[]) ORDER BY i.source_pk`,[[affectedId,unrelatedId]]);
    expect(outcomes.rows).toEqual([
      {source_pk:'REMAP-FENCE-AFFECTED',item_status:'QUARANTINED',error_code:'AUTHORITY_MAPPING_SUPERSEDED',job_status:'FAILED',applied_count:0,customers:'0'},
      {source_pk:'REMAP-FENCE-UNRELATED',item_status:'APPLIED',error_code:null,job_status:'SUCCEEDED',applied_count:1,customers:'1'},
    ]);
  });
});
