import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../app.js';
import { registerManagementImportRoutes } from '../ingestion-api/management-import.js';
import { createAuthService } from '../auth/service.js';
import { createCredential } from '../auth/credentials.js';
import { runMigrations } from '../migrations/runner.js';
import type { EndpointProfile } from '../source-registry/capability-probe.js';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const evidenceRoot=process.env.M0_RUN_EVIDENCE_ROOT;
if(!evidenceRoot) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
const migrationsDirectory = new URL('../migrations/', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:');
const sourceToken=createCredential().secret;
const tenantId='task3_tenant',sourceId='crm-demo',route='/hub/v1/ingest/crm/customers';
let fixture: OwnedPostgres;
let apiPool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let endpointProfile: EndpointProfile;
const manager = async () => ({userId:'manager-a',tenantId,departmentId:null,businessRole:null,managementScopes:['source:read'] as const,authEpoch:'0',businessTimezone:'Asia/Shanghai',issuer:'fixture',subject:'manager-a'});

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

afterAll(async()=>{if(app) await app.close();if(apiPool) await apiPool.end();if(fixture) await fixture.close();});

describe('M1-I2a external proof and source credential',()=>{
  it('preserves external non-null proof and rejects NULL or mismatched external proof',async()=>{
    const response=await post(JSON.stringify(customerBatch()),'external-proof-check');expect(response.statusCode).toBe(202);
    const id=response.json().data.job_id;const job=(await fixture.pool.query('SELECT * FROM control.ingestion_job WHERE id=$1',[id])).rows[0]!;
    expect(job.endpoint_profile_digest).toEqual(createHash('sha256').update(JSON.stringify(endpointProfile)).digest());
    const api=await apiPool.connect();try {await api.query('BEGIN');
      const columns=['tenant_key','source_id','entity','route','batch_id','raw_batch_id','idempotency_key','request_digest','status','received_count','applied_count','credential_id','source_epoch_at_admission','credential_revision_at_admission','credential_generation_at_admission','channel_id','channel_epoch','version_domain','owner_approval_id','owner_user_id','owner_revision','approval_security_fence','config_revision','config_digest','mapping_revision','mapping_digest','identity_mapping_revision','identity_mapping_digest','endpoint_profile_digest','test_report_id','security_barrier_fence_at_admission','first_source_updated_at','last_source_updated_at'];
      const values=columns.map(column=>column==='idempotency_key'?'external-null':column==='endpoint_profile_digest'?null:job[column]);
      await expect(api.query(`INSERT INTO control.ingestion_job(${columns.join(',')}) VALUES(${columns.map((_,index)=>`$${index+1}`).join(',')})`,values)).rejects.toMatchObject({code:'23514'});
    } finally {await api.query('ROLLBACK');api.release();}
    const worker=hubWorkerPool();const client=await worker.connect();
    const call=()=>client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,'absent-key',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[tenantId,sourceId,job.credential_id,job.channel_id,job.channel_epoch,job.version_domain,job.security_barrier_fence_at_admission,job.owner_approval_id,job.test_report_id,job.identity_mapping_revision,JSON.stringify([{kind:'user',external_id:'sales-a'}])]);
    try {
      await expect(call()).rejects.toThrow('source ownership change has no canonical customer');
      await fixture.pool.query('UPDATE control.source_test_report SET endpoint_profile_digest=$2 WHERE id=$1',[job.test_report_id,Buffer.alloc(32,0x55)]);
      await expect(call()).rejects.toThrow('approved source ownership mapping required');
      expect((await post(JSON.stringify(customerBatch()),'mismatched-external-profile')).statusCode).toBe(409);
    } finally {await fixture.pool.query('UPDATE control.source_test_report SET endpoint_profile_digest=$2 WHERE id=$1',[job.test_report_id,job.endpoint_profile_digest]);client.release();await worker.end();}
  });

  it('rejects a real working external source credential on management import without effects',async()=>{
    const auth=createAuthService({pool:apiPool});await expect(auth.authenticateSourceIdentity(sourceToken)).resolves.toMatchObject({tenantId,sourceId});
    const owned=await buildApp({logger:false});await registerManagementImportRoutes(owned,{pool:apiPool,authService:auth,authenticator:manager,rawStoragePolicy:'local_lab_fixture'});
    try {const before=await rowCounts();const auditBefore=await fixture.pool.query('SELECT count(*)::int AS count FROM control.ingestion_management_admission_audit');const response=await owned.inject({method:'POST',url:`/hub/v1/admin/sources/${sourceId}/import/customer`,headers:{authorization:`Bearer ${sourceToken}`,'content-type':'application/json','idempotency-key':'real-source-token'},payload:JSON.stringify(customerBatch())});expect(response.statusCode).toBe(401);expect((await rowCounts()).rows).toEqual(before.rows);expect((await fixture.pool.query('SELECT count(*)::int AS count FROM control.ingestion_management_admission_audit')).rows).toEqual(auditBefore.rows);} finally {await owned.close();}
  });

});
