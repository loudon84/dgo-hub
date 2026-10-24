import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../migrations/runner.js';
import { sourceContentDigest } from '../normalization/canonical.js';
import { applyCustomer, applyOrderAggregate } from '../normalization/store.js';
import type { ApplyContext, ApplyResult } from '../normalization/apply.js';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const integrationServiceDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(integrationServiceDirectory, 'migrations');
let fixture: OwnedPostgres;
let database: pg.Pool;

function requireApplied(result: ApplyResult): Extract<ApplyResult,{status:'APPLIED'}> {
  if (result.status !== 'APPLIED') throw new Error(`Expected APPLIED, received ${result.status}`);
  return result;
}

async function seedCustomerApplyProof(versionDomain: 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION' = 'SOURCE_VERSION', entity:'customer'|'order'='customer'): Promise<ApplyContext> {
  const sourceId = `crm-${randomBytes(4).toString('hex')}`;
  const ownerId = `owner-${randomBytes(4).toString('hex')}`;
  const tenantId = `tenant_${randomBytes(3).toString('hex')}`;
  const configDigest = Buffer.alloc(32, 0x11);
  const mappingDigest = Buffer.alloc(32, 0x22);
  const identityDigest = Buffer.alloc(32, 0x33);
  const endpointDigest = Buffer.alloc(32, 0x44);
  const identityMappings = [
    { kind: 'user', external_id: 'owner-ext', target_id: ownerId },
    { kind: 'department', external_id: 'dept-ext', target_id: 'sales-east' },
  ];
  const credentialDigest = randomBytes(32);
  await database.query("INSERT INTO control.tenant(tenant_key,business_timezone) VALUES ($1,'UTC')", [tenantId]);
  await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
    VALUES($1,$2,'sales-east','sales')`, [tenantId,ownerId]);
  const canonicalCustomer=await database.query<{id:string}>(`INSERT INTO hub.canonical_customer
    (tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision)
    VALUES($1,'Fixture customer',$2,'sales-east','ACTIVE','2026-01-01T00:00:00Z',1,$3,1,1) RETURNING id`,[tenantId,ownerId,versionDomain]);
  identityMappings.push({kind:'customer',external_id:'customer-ext',target_id:canonicalCustomer.rows[0].id});
  await database.query("INSERT INTO control.credential_digest_registry(digest,kind) VALUES($1,'source')", [credentialDigest]);
  const credential = await database.query<{ id: string }>(`INSERT INTO control.source_credential
    (tenant_key,source_id,digest,secret_ref,allowed_entities,enabled,revision)
    VALUES($1,$2,$3,'vault:/fixture',ARRAY['customer']::text[],true,1) RETURNING id`, [tenantId,sourceId,credentialDigest]);
  await database.query(`INSERT INTO control.source_registry(tenant_key,source_id,data_owner_user_id)
    VALUES($1,$2,$3)`, [tenantId,sourceId,ownerId]);
  await database.query(`INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
    VALUES($1,$2,1,$3,$4::jsonb,$5)`, [tenantId,sourceId,configDigest,JSON.stringify({ allowed_entities:['customer','order'],connector:'rest',mode:'INCREMENTAL',version_domain:versionDomain }),ownerId]);
  await database.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,'[]'::jsonb,$4)`, [tenantId,sourceId,mappingDigest,ownerId]);
  await database.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,1,$3,$4::jsonb,$5)`, [tenantId,sourceId,identityDigest,JSON.stringify(identityMappings),ownerId]);
  const report = await database.query<{ id: string }>(`INSERT INTO control.source_test_report
    (tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,
     source_credential_revision,credential_generation,endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,1,1,1,$3,$4,$5,1,1,$6,'fixture', '{}'::jsonb,'PASS',$7) RETURNING id`,
  [tenantId,sourceId,configDigest,mappingDigest,identityDigest,endpointDigest,ownerId]);
  const approval = await database.query<{ id: string }>(`INSERT INTO control.source_owner_approval
    (tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,identity_mapping_revision,
     config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
     endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,$3,1,1,1,1,$4,$5,$6,1,1,$7,'fixture',$8) RETURNING id`,
  [tenantId,sourceId,ownerId,configDigest,mappingDigest,identityDigest,endpointDigest,report.rows[0].id]);
  const channel = await database.query<{ id: string }>(`INSERT INTO control.source_channel
    (tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
    VALUES($1,$2,$3,'rest','INCREMENTAL',$4,1,'active') RETURNING id`, [tenantId,sourceId,entity,versionDomain]);
  const fence = await database.query<{ fence: string }>('SELECT control.lock_security_barrier_fence()::text AS fence');
  return {
    tenantId, sourceId, credentialId:credential.rows[0].id, sourceEpochAtAdmission:'0',
    credentialRevisionAtAdmission:'1', credentialGenerationAtAdmission:'1', entity,
    channelId:channel.rows[0].id, channelEpoch:'1', versionDomain,
    ownerApprovalId:approval.rows[0].id, ownerUserId:ownerId, ownerRevision:'1',
    configRevision:'1', configDigest:configDigest.toString('hex'), mappingRevision:'1', mappingDigest:mappingDigest.toString('hex'),
    identityMappingRevision:'1', identityMappingDigest:identityDigest.toString('hex'), endpointProfileDigest:endpointDigest.toString('hex'),
    testReportId:report.rows[0].id, securityBarrierFenceAtAdmission:fence.rows[0].fence,
  };
}

async function approveOwnerMapping(context:ApplyContext,newOwnerId:string):Promise<ApplyContext> {
  await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
    VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwnerId]);
  return approveIdentityMapping(context,[
    {kind:'user',external_id:'owner-ext',target_id:newOwnerId},
    {kind:'department',external_id:'dept-ext',target_id:'sales-east'},
    {kind:'customer',external_id:'customer-ext',target_id:(await database.query<{id:string}>(
      `SELECT id::text AS id FROM hub.canonical_customer WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id},
  ]);
}

async function approveIdentityMapping(context:ApplyContext,mappings:readonly {kind:string;external_id:string;target_id:string|null}[]):Promise<ApplyContext> {
  const identityDigest=Buffer.alloc(32,0x55);
  await database.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
    VALUES($1,$2,2,$3,$4::jsonb,$5)`,[context.tenantId,context.sourceId,identityDigest,JSON.stringify(mappings),context.ownerUserId]);
  const report=await database.query<{id:string}>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,
    identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
    endpoint_profile_digest,data_contract_ref,report,status,created_by)
    VALUES($1,$2,$3,$4,2,$5,$6,$7,$8,$9,$10,'fixture','{}'::jsonb,'PASS',$11) RETURNING id`,
  [context.tenantId,context.sourceId,context.configRevision,context.mappingRevision,Buffer.from(context.configDigest,'hex'),
    Buffer.from(context.mappingDigest,'hex'),identityDigest,context.credentialRevisionAtAdmission,context.credentialGenerationAtAdmission,
    Buffer.from(context.endpointProfileDigest,'hex'),context.ownerUserId]);
  const approval=await database.query<{id:string}>(`INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,
    config_revision,mapping_revision,identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,
    source_credential_revision,credential_generation,endpoint_profile_digest,data_contract_ref,test_report_id)
    VALUES($1,$2,$3,$4,$5,$6,2,$7,$8,$9,$10,$11,$12,'fixture',$13) RETURNING id`,
  [context.tenantId,context.sourceId,context.ownerUserId,context.ownerRevision,context.configRevision,context.mappingRevision,
    Buffer.from(context.configDigest,'hex'),Buffer.from(context.mappingDigest,'hex'),identityDigest,context.credentialRevisionAtAdmission,
    context.credentialGenerationAtAdmission,Buffer.from(context.endpointProfileDigest,'hex'),report.rows[0].id]);
  return {...context,identityMappingRevision:'2',identityMappingDigest:identityDigest.toString('hex'),
    ownerApprovalId:approval.rows[0].id,testReportId:report.rows[0].id};
}

beforeAll(async () => {
  const root = fixtureEvidenceRootFromEnvironment();
  const evidenceFile = join(integrationServiceDirectory, 'acceptance-tests', 'evidence', 'm1-task-2', 'postgres-lifecycle.jsonl');
  if (root) await mkdir(root, { recursive: true });
  fixture = await startOwnedPostgres({ evidenceFile, evidenceRoot: root, taskLabel: 'task2' });
  database = fixture.pool;
  await runMigrations(database, { directory: migrationsDirectory, environmentKind: 'local_lab' });
}, 120_000);

afterAll(async () => {
  if (!fixture) return;
  const resource = {
    taskLabel: fixture.taskLabel,
    runLabel: fixture.runLabel,
    containerId: fixture.containerId,
    imageReference: fixture.imageReference,
    repoDigest: fixture.repoDigest,
    runtimeImageId: fixture.runtimeImageId,
    hostPort: fixture.hostPort,
    ownershipConfirmed: true,
    containerAbsentAfterRemoval: true,
  };
  await fixture.close();
  await writeFile(join(dirname(fixture.evidenceFile), 'postgres-resource-summary.json'), `${JSON.stringify({ ...resource, cleanup: 'confirmed removed by exact owned container ID' }, null, 2)}\n`);
}, 120_000);

describe('canonical migration 006', () => {
  it('orders admissions and new security barriers through one transaction fence', async () => {
    const admission = await database.connect();
    try {
      await admission.query('BEGIN');
      const snapshot = await admission.query<{ fence: string }>('SELECT control.lock_security_barrier_fence()::text AS fence');
      const pendingBarrier = database.query<{ effective_fence: string }>(`INSERT INTO control.source_security_barrier
        (tenant_key,source_id,barrier_type,reason_code,created_by)
        VALUES('tenant_a','crm','SOURCE_SCOPE_SECURITY_REMOVAL','fixture','fixture') RETURNING effective_fence::text`);
      const contender = await database.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(1296905544,1) AS acquired');
      expect(contender.rows[0].acquired).toBe(false);
      await admission.query('COMMIT');
      const barrier = await pendingBarrier;
      expect(BigInt(barrier.rows[0].effective_fence)).toBeGreaterThan(BigInt(snapshot.rows[0].fence));
      const current = await database.query<{ fence: string }>('SELECT control.lock_security_barrier_fence()::text AS fence');
      expect(current.rows[0].fence).toBe(barrier.rows[0].effective_fence);
    } finally {
      admission.release();
    }
  });

  it('appends after the reviewed registry and records repeatable checksum history', async () => {
    const history = await database.query<{ version: number; name: string }>(
      'SELECT version,name FROM control.schema_migration ORDER BY version',
    );
    expect(history.rows.slice(-2)).toEqual([
      { version: 5, name: 'source_registry' },
      { version: 6, name: 'canonical_data_and_receipts' },
    ]);
    await expect(runMigrations(database, { directory: migrationsDirectory, environmentKind: 'local_lab' }))
      .resolves.toEqual({ applied: [], skipped: history.rows.map(row => `${String(row.version).padStart(3, '0')}_${row.name}`) });
  });

  it('uses tenant composite keys for canonical order to customer references', async () => {
    await database.query("INSERT INTO control.tenant(tenant_key,business_timezone) VALUES ('tenant_a','UTC'),('tenant_b','UTC')");
    await database.query("INSERT INTO control.auth_subject(tenant_key,user_id) VALUES ('tenant_a','owner_a'),('tenant_b','owner_b')");
    const customer = await database.query<{ id: string }>(`INSERT INTO hub.canonical_customer
      (tenant_id,customer_name,owner_user_id,dept_id,status,source_updated_at,source_version,version_domain,channel_epoch,hub_revision)
      VALUES('tenant_a','Acme','owner_a','dept_a','ACTIVE',now(),1,'SOURCE_VERSION',1,1) RETURNING id`);
    await expect(database.query(`INSERT INTO hub.canonical_order
      (tenant_id,customer_id,order_no,status,order_at,amount,currency,source_updated_at,source_version,version_domain,channel_epoch,hub_revision)
      VALUES('tenant_b',$1,'O-1','DRAFT',now(),1,'CNY',now(),1,'SOURCE_VERSION',1,1)`, [customer.rows[0].id]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the API principal out of canonical core DML and gives the shared worker bounded apply DML', async () => {
    const privileges = await database.query<{ api_insert: boolean; worker_insert: boolean; worker_delete_receipt: boolean; worker_read_barriers: boolean }>(`
      SELECT has_table_privilege('hub_api','hub.canonical_customer','INSERT') AS api_insert,
        has_table_privilege('hub_worker','hub.canonical_customer','INSERT') AS worker_insert,
        has_table_privilege('hub_worker','control.source_version_receipt','DELETE') AS worker_delete_receipt,
        has_table_privilege('hub_worker','control.source_security_barrier','SELECT') AS worker_read_barriers`);
    expect(privileges.rows[0]).toEqual({ api_insert: false, worker_insert: true, worker_delete_receipt: false, worker_read_barriers: true });
  });

  it('runs complete customer and order applies under hub_worker with no unrelated auth writes', async () => {
    const customerContext=await seedCustomerApplyProof();
    const customer={source_pk:'worker-customer',customer_name:'Worker customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const customerClient=await database.connect();
    try {
      await customerClient.query('BEGIN');
      await customerClient.query('SET LOCAL ROLE hub_worker');
      const result=await applyCustomer(customerClient,customerContext,customer);
      await customerClient.query('COMMIT');
      expect(result.status).toBe('APPLIED');
      await customerClient.query('BEGIN');
      await customerClient.query('SET LOCAL ROLE hub_worker');
      await expect(customerClient.query('UPDATE control.auth_subject SET auth_epoch=auth_epoch+1 WHERE tenant_key=$1 AND user_id=$2',
        [customerContext.tenantId,customerContext.ownerUserId])).rejects.toMatchObject({code:'42501'});
      await customerClient.query('ROLLBACK');
    } finally { await customerClient.query('ROLLBACK').catch(()=>undefined); customerClient.release(); }

    const orderContext=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const order={source_pk:'worker-order',customer_external_id:'customer-ext',order_no:'WORKER-1',status:'DRAFT' as const,
      order_at:'2026-01-01T00:00:00Z',amount:'1.00',currency:'CNY' as const,source_updated_at:'2026-01-01T00:00:00Z',
      source_version:'1',lines:[{source_line_id:'line-1',product_code:'sku-1',product_name:'Item',quantity:'1.000000',unit_price:'1.000000',line_amount:'1.00'}]};
    const orderClient=await database.connect();
    try {
      await orderClient.query('BEGIN');
      await orderClient.query('SET LOCAL ROLE hub_worker');
      const result=await applyOrderAggregate(orderClient,orderContext,order);
      await orderClient.query('COMMIT');
      expect(result.status).toBe('APPLIED');
    } finally { await orderClient.query('ROLLBACK').catch(()=>undefined); orderClient.release(); }
  });

  it('serializes owner eligibility with a concurrent M0 disable', async () => {
    const context=await seedCustomerApplyProof();
    const customer={source_pk:'owner-disable-race',customer_name:'Race customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const disable=await database.connect();
    const apply=await database.connect();
    let applyPromise:Promise<ApplyResult>|undefined;
    try {
      await disable.query('BEGIN');
      await disable.query('UPDATE control.auth_subject SET enabled=false WHERE tenant_key=$1 AND user_id=$2',[context.tenantId,context.ownerUserId]);
      await apply.query("SET application_name='m1_t2_owner_disable_apply'");
      await apply.query('BEGIN');
      applyPromise=applyCustomer(apply,context,customer);
      const deadline=Date.now()+2000;
      let lockWaitObserved=false;
      while(Date.now()<deadline && !lockWaitObserved) {
        const activity=await database.query<{wait_event_type:string|null}>(`SELECT wait_event_type FROM pg_stat_activity
          WHERE application_name='m1_t2_owner_disable_apply'`);
        lockWaitObserved=activity.rows[0]?.wait_event_type==='Lock';
        if(!lockWaitObserved) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(lockWaitObserved).toBe(true);
      await disable.query('COMMIT');
      await expect(applyPromise).resolves.toMatchObject({status:'QUARANTINED',code:'IDENTITY_MAPPING_TARGET_INVALID'});
      await apply.query('ROLLBACK');
      const state=await database.query<{receipts:string;identities:string}>(`SELECT
        (SELECT count(*)::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_pk=$2) AS receipts,
        (SELECT count(*)::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_pk=$2) AS identities`,
      [context.tenantId,customer.source_pk]);
      expect(state.rows[0]).toEqual({receipts:'0',identities:'0'});
    } finally {
      await disable.query('ROLLBACK').catch(()=>undefined);
      if(applyPromise) await applyPromise.catch(()=>undefined);
      await apply.query('ROLLBACK').catch(()=>undefined);
      disable.release(); apply.release();
    }
  });

  it('applies an independently specified customer and handles version receipt outcomes atomically', async () => {
    const context = await seedCustomerApplyProof();
    const customer = {
      source_pk:'C-100', customer_name:'Acme Ltd', owner_external_id:'owner-ext', dept_external_id:'dept-ext',
      status:'ACTIVE' as const, phone:null, source_updated_at:'2026-01-02T03:04:05Z', source_version:'9007199254740993', deleted_at:null,
    };
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const first = await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const stored = await database.query<{ customer_name:string; owner_user_id:string; source_version:string }>(
        'SELECT customer_name,owner_user_id,source_version::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',
        [context.tenantId,requireApplied(first).objectId],
      );
      expect(stored.rows[0]).toEqual({ customer_name:'Acme Ltd',owner_user_id:context.ownerUserId,source_version:'9007199254740993' });

      await client.query('BEGIN');
      const duplicate = await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(duplicate).toEqual({ status:'DUPLICATE',objectId:requireApplied(first).objectId,digest:requireApplied(first).digest });

      await client.query('BEGIN');
      const conflict = await applyCustomer(client,context,{ ...customer,customer_name:'Different at same version' });
      await client.query('COMMIT');
      expect(conflict).toEqual({ status:'QUARANTINED',code:'SOURCE_VERSION_CONFLICT' });
      await database.query(`UPDATE control.source_channel SET state='retired' WHERE id=$1`,[context.channelId]);
      await client.query('BEGIN');
      const retiredBeforeVersionCompare=await applyCustomer(client,context,{...customer,source_version:'1'});
      await client.query('COMMIT');
      expect(retiredBeforeVersionCompare).toEqual({status:'CHANNEL_EPOCH_RETIRED'});
    } finally {
      client.release();
    }
  });

  it('fences old and new owner epochs with a source driven ownership change', async () => {
    const context=await seedCustomerApplyProof();
    const client=await database.connect();
    const customer={source_pk:'source-owner-change',customer_name:'Owner change customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const newOwner=`owner-next-${randomBytes(3).toString('hex')}`;
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const before=await database.query<{user_id:string;auth_epoch:string}>(`SELECT user_id,auth_epoch::text FROM control.auth_subject
        WHERE tenant_key=$1 AND user_id IN ($2,$3) ORDER BY user_id`,[context.tenantId,context.ownerUserId,newOwner]);
      const revised=await approveOwnerMapping(context,newOwner);
      await client.query('BEGIN');
      const changed=await applyCustomer(client,revised,{...customer,source_version:'2'});
      await client.query('COMMIT');
      expect(changed).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const after=await database.query<{user_id:string;auth_epoch:string;owner_user_id:string;audit_count:string}>(`SELECT s.user_id,s.auth_epoch::text,
        (SELECT c.owner_user_id FROM hub.canonical_customer c WHERE c.tenant_id=$1 AND c.id=$6::uuid) AS owner_user_id,
        (SELECT count(*)::text FROM control.canonical_ownership_audit a WHERE a.tenant_key=$1 AND a.source_id=$2 AND a.source_pk=$3) AS audit_count
        FROM control.auth_subject s WHERE s.tenant_key=$1 AND s.user_id IN ($4,$5) ORDER BY s.user_id`,
      [context.tenantId,context.sourceId,customer.source_pk,context.ownerUserId,newOwner,requireApplied(first).objectId]);
      expect(after.rows.map(row=>row.user_id)).toEqual([context.ownerUserId,newOwner].sort());
      for(const row of after.rows) {
        const oldEpoch=before.rows.find(old=>old.user_id===row.user_id)?.auth_epoch ?? '0';
        expect(BigInt(row.auth_epoch)).toBe(BigInt(oldEpoch)+1n);
        expect(row.owner_user_id).toBe(newOwner);
        expect(row.audit_count).toBe('1');
      }
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('applies an owner change between two external keys in one frozen identity mapping', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-key-b-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const client=await database.connect();
    const firstPayload={source_pk:'two-owner-keys',customer_name:'Two key customer',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      const first=await applyCustomer(client,frozen,firstPayload);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const before=await database.query<{user_id:string;auth_epoch:string}>(`SELECT user_id,auth_epoch::text FROM control.auth_subject
        WHERE tenant_key=$1 AND user_id IN ($2,$3) ORDER BY user_id`,[context.tenantId,context.ownerUserId,newOwner]);

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      const rolledBack=await applyCustomer(client,frozen,{...firstPayload,owner_external_id:'ext-B',source_version:'2'});
      expect(rolledBack.status).toBe('APPLIED');
      await expect(client.query('SELECT 1/0')).rejects.toMatchObject({code:'22012'});
      await client.query('ROLLBACK');
      const afterRollback=await database.query<{owner_user_id:string;source_version:string;reference_key:string;reference_target:string;
        audit_count:string;outbox_count:string}>(`SELECT
        (SELECT c.owner_user_id FROM hub.canonical_customer c WHERE c.tenant_id=$1 AND c.id=$4::uuid) AS owner_user_id,
        (SELECT r.source_version::text FROM control.source_version_receipt r WHERE r.tenant_key=$1 AND r.source_id=$2
          AND r.entity='customer' AND r.source_pk=$3) AS source_version,
        (SELECT i.external_id FROM control.canonical_identity_reference i WHERE i.tenant_key=$1 AND i.source_id=$2
          AND i.entity='customer' AND i.source_pk=$3 AND i.kind='user') AS reference_key,
        (SELECT i.target_id FROM control.canonical_identity_reference i WHERE i.tenant_key=$1 AND i.source_id=$2
          AND i.entity='customer' AND i.source_pk=$3 AND i.kind='user') AS reference_target,
        (SELECT count(*)::text FROM control.canonical_ownership_audit a WHERE a.tenant_key=$1 AND a.source_id=$2 AND a.source_pk=$3) AS audit_count,
        (SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=$1 AND o.source_id=$2 AND o.entity='customer'
          AND o.canonical_object_id=$4::uuid) AS outbox_count`,
      [context.tenantId,context.sourceId,firstPayload.source_pk,requireApplied(first).objectId]);
      expect(afterRollback.rows[0]).toEqual({owner_user_id:context.ownerUserId,source_version:'1',reference_key:'ext-A',
        reference_target:context.ownerUserId,audit_count:'0',outbox_count:'1'});
      const epochsAfterRollback=await database.query<{user_id:string;auth_epoch:string}>(`SELECT user_id,auth_epoch::text FROM control.auth_subject
        WHERE tenant_key=$1 AND user_id IN ($2,$3) ORDER BY user_id`,[context.tenantId,context.ownerUserId,newOwner]);
      expect(epochsAfterRollback.rows).toEqual(before.rows);

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      const second=await applyCustomer(client,frozen,{...firstPayload,owner_external_id:'ext-B',source_version:'2'});
      const transactionProof=await client.query<{current_xid:string;receipt_xid:string;outbox_xid:string}>(`SELECT pg_current_xact_id()::text AS current_xid,
        (SELECT apply_xid::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3) AS receipt_xid,
        (SELECT apply_xid::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND entity='customer'
          AND canonical_object_id=$4 ORDER BY id DESC LIMIT 1) AS outbox_xid`,
      [context.tenantId,context.sourceId,firstPayload.source_pk,requireApplied(first).objectId]);
      expect(transactionProof.rows[0].receipt_xid).toBe(transactionProof.rows[0].current_xid);
      expect(transactionProof.rows[0].outbox_xid).toBe(transactionProof.rows[0].current_xid);
      await client.query('COMMIT');
      expect(second).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const after=await database.query<{user_id:string;auth_epoch:string;owner_user_id:string;source_version:string;reference_key:string;
        reference_target:string;audit_count:string;outbox_count:string}>(`SELECT s.user_id,s.auth_epoch::text,
          (SELECT c.owner_user_id FROM hub.canonical_customer c WHERE c.tenant_id=$1 AND c.id=$6) AS owner_user_id,
          (SELECT r.source_version::text FROM control.source_version_receipt r WHERE r.tenant_key=$1 AND r.source_id=$2
            AND r.entity='customer' AND r.source_pk=$3) AS source_version,
          (SELECT i.external_id FROM control.canonical_identity_reference i WHERE i.tenant_key=$1 AND i.source_id=$2
            AND i.entity='customer' AND i.source_pk=$3 AND i.kind='user') AS reference_key,
          (SELECT i.target_id FROM control.canonical_identity_reference i WHERE i.tenant_key=$1 AND i.source_id=$2
            AND i.entity='customer' AND i.source_pk=$3 AND i.kind='user') AS reference_target,
          (SELECT count(*)::text FROM control.canonical_ownership_audit a WHERE a.tenant_key=$1 AND a.source_id=$2 AND a.source_pk=$3) AS audit_count,
          (SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=$1 AND o.source_id=$2 AND o.entity='customer'
            AND o.canonical_object_id=$6) AS outbox_count
        FROM control.auth_subject s WHERE s.tenant_key=$1 AND s.user_id IN ($4,$5) ORDER BY s.user_id`,
      [context.tenantId,context.sourceId,firstPayload.source_pk,context.ownerUserId,newOwner,requireApplied(first).objectId]);
      expect(after.rows.map(row=>row.user_id)).toEqual([context.ownerUserId,newOwner].sort());
      for(const row of after.rows) {
        const oldEpoch=before.rows.find(old=>old.user_id===row.user_id)?.auth_epoch ?? '0';
        expect(BigInt(row.auth_epoch)).toBe(BigInt(oldEpoch)+1n);
        expect(row.owner_user_id).toBe(newOwner);
        expect(row.source_version).toBe('2');
        expect(row.reference_key).toBe('ext-B');
        expect(row.reference_target).toBe(newOwner);
        expect(row.audit_count).toBe('1');
        expect(row.outbox_count).toBe('2');
      }

      const beforeReplay=await database.query<{old_epoch:string;new_epoch:string;audits:string;outbox:string}>(`SELECT
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$3) AS new_epoch,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_pk=$4) AS audits,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$5 AND entity='customer' AND canonical_object_id=$6) AS outbox`,
      [context.tenantId,context.ownerUserId,newOwner,firstPayload.source_pk,context.sourceId,requireApplied(first).objectId]);
      await client.query('BEGIN');
      await client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,firstPayload.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,
        frozen.versionDomain,frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,
        frozen.identityMappingRevision,JSON.stringify([{kind:'user',external_id:'ext-B'}]),
      ]);
      await client.query('COMMIT');
      const afterReplay=await database.query<{old_epoch:string;new_epoch:string;audits:string;outbox:string}>(`SELECT
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$3) AS new_epoch,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_pk=$4) AS audits,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$5 AND entity='customer' AND canonical_object_id=$6) AS outbox`,
      [context.tenantId,context.ownerUserId,newOwner,firstPayload.source_pk,context.sourceId,requireApplied(first).objectId]);
      expect(afterReplay.rows).toEqual(beforeReplay.rows);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('finishes frozen owner work after an ordinary Data Owner binding change', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-after-data-owner-change-${randomBytes(3).toString('hex')}`;
    const replacementDataOwner=`data-owner-current-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales'),($1,$3,NULL,NULL)`,[context.tenantId,newOwner,replacementDataOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    await database.query(`UPDATE control.source_registry SET data_owner_user_id=$3 WHERE tenant_key=$1 AND source_id=$2`,
      [context.tenantId,context.sourceId,replacementDataOwner]);
    await database.query(`UPDATE control.source_registry SET owner_revision=owner_revision+1,lifecycle='PAUSED'
      WHERE tenant_key=$1 AND source_id=$2`,[context.tenantId,context.sourceId]);
    const client=await database.connect();
    const customer={source_pk:'frozen-owner-binding-change',customer_name:'Frozen O1 proof',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,frozen,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      await client.query('BEGIN');
      const changed=await applyCustomer(client,frozen,{...customer,owner_external_id:'ext-B',source_version:'2'});
      await client.query('COMMIT');
      expect(changed).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const state=await database.query<{current_data_owner:string;owner_user_id:string;actor_user_id:string;old_epoch:string;new_epoch:string}>(`SELECT
        r.data_owner_user_id AS current_data_owner,
        c.owner_user_id,
        (SELECT a.actor_user_id FROM control.canonical_ownership_audit a WHERE a.tenant_key=$1 AND a.source_id=$2 AND a.source_pk=$3) AS actor_user_id,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$4) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$5) AS new_epoch
        FROM control.source_registry r JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=$6
        WHERE r.tenant_key=$1 AND r.source_id=$2`,
      [context.tenantId,context.sourceId,customer.source_pk,context.ownerUserId,newOwner,requireApplied(first).objectId]);
      expect(state.rows[0]).toEqual({current_data_owner:replacementDataOwner,owner_user_id:newOwner,actor_user_id:context.ownerUserId,
        old_epoch:'1',new_epoch:'1'});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('rejects a direct worker owner-change effect without a matching canonical change', async () => {
    const context=await seedCustomerApplyProof();
    const unrelated=`unrelated-subject-${randomBytes(3).toString('hex')}`;
    const newOwner=`owner-direct-helper-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,NULL,NULL),($1,$3,'sales-east','sales')`,[context.tenantId,unrelated,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'owner-ext',target_id:newOwner},
      {kind:'department',external_id:'dept-ext',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const before=await database.query<{unrelated_epoch:string;owner_epoch:string;audits:string;receipts:string;outbox:string;source_identities:string;
      core_state:string[];old_signature_absent:boolean}>(`SELECT
      (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS unrelated_epoch,
      (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$3) AS owner_epoch,
      (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$4) AS audits,
      (SELECT count(*)::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$4) AS receipts,
      (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$4) AS outbox,
      (SELECT count(*)::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$4) AS source_identities,
      (SELECT array_agg(id::text||':'||owner_user_id||':'||dept_id ORDER BY id) FROM hub.canonical_customer WHERE tenant_id=$1) AS core_state,
      to_regprocedure('control.record_canonical_customer_owner_change(text,text,text,text,text,text,text,text,text,bigint,text)') IS NULL AS old_signature_absent`,
    [context.tenantId,unrelated,context.ownerUserId,context.sourceId]);
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      await expect(client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,'no-canonical-change',$3,$4,$5::bigint,$6,$7::bigint,$8,$9,2,$10::jsonb)`,[
        context.tenantId,context.sourceId,context.credentialId,frozen.channelId,frozen.channelEpoch,frozen.versionDomain,
        frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,
        JSON.stringify([{kind:'user',external_id:'owner-ext'}]),
      ])).rejects.toMatchObject({code:'42501'});
      expect(before.rows[0].old_signature_absent).toBe(true);
      await client.query('ROLLBACK');
      const after=await database.query<{unrelated_epoch:string;owner_epoch:string;audits:string;receipts:string;outbox:string;source_identities:string;
        core_state:string[];old_signature_absent:boolean}>(`SELECT
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS unrelated_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$3) AS owner_epoch,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$4) AS audits,
        (SELECT count(*)::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$4) AS receipts,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$4) AS outbox,
        (SELECT count(*)::text FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$4) AS source_identities,
        (SELECT array_agg(id::text||':'||owner_user_id||':'||dept_id ORDER BY id) FROM hub.canonical_customer WHERE tenant_id=$1) AS core_state,
        to_regprocedure('control.record_canonical_customer_owner_change(text,text,text,text,text,text,text,text,text,bigint,text)') IS NULL AS old_signature_absent`,
      [context.tenantId,unrelated,context.ownerUserId,context.sourceId]);
      expect(after.rows).toEqual(before.rows);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('rejects stale matching receipt and outbox after a partial direct core owner update', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-stale-artifact-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const customer={source_pk:'stale-owner-artifacts',customer_name:'Stale artifact customer',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      const first=await applyCustomer(client,frozen,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const before=await database.query<{owner:string;hub_revision:string;version:string;projection:string;reference:string;target:string;
        outbox:string;audit:string;old_epoch:string;new_epoch:string}>(`SELECT
        (SELECT owner_user_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS owner,
        (SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS hub_revision,
        (SELECT source_version::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS version,
        (SELECT encode(projection_digest,'hex') FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS projection,
        (SELECT external_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS reference,
        (SELECT target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS target,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3 AND canonical_object_id=$2) AS outbox,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS audit,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$5) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$6) AS new_epoch`,
      [context.tenantId,requireApplied(first).objectId,context.sourceId,customer.source_pk,context.ownerUserId,newOwner]);

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      await client.query(`UPDATE hub.canonical_customer SET owner_user_id=$3
        WHERE tenant_id=$1 AND id=$2`,[context.tenantId,requireApplied(first).objectId,newOwner]);
      await expect(client.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,customer.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,
        frozen.versionDomain,frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,
        frozen.identityMappingRevision,JSON.stringify([{kind:'user',external_id:'ext-B'}]),
      ])).rejects.toMatchObject({code:'42501'});
      await client.query('ROLLBACK');
      const after=await database.query(`SELECT
        (SELECT owner_user_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS owner,
        (SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS hub_revision,
        (SELECT source_version::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS version,
        (SELECT encode(projection_digest,'hex') FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS projection,
        (SELECT external_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS reference,
        (SELECT target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS target,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3 AND canonical_object_id=$2) AS outbox,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS audit,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$5) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$6) AS new_epoch`,
      [context.tenantId,requireApplied(first).objectId,context.sourceId,customer.source_pk,context.ownerUserId,newOwner]);
      expect(after.rows).toEqual(before.rows);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('stamps receipt and outbox transaction IDs over worker supplied values', async () => {
    const context=await seedCustomerApplyProof();
    const customer={source_pk:'worker-xid-stamp',customer_name:'Worker XID stamp',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const initial=await database.connect();
    const client=await database.connect();
    try {
      await initial.query('BEGIN');
      await initial.query('SET LOCAL ROLE hub_worker');
      const applied=await applyCustomer(initial,context,customer);
      await initial.query('COMMIT');
      expect(applied.status).toBe('APPLIED');
      const old=await database.query<{xid:string;outbox_id:string}>(`SELECT
        (SELECT apply_xid::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3) AS xid,
        (SELECT id::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND canonical_object_id=$4 ORDER BY id DESC LIMIT 1) AS outbox_id`,
      [context.tenantId,context.sourceId,customer.source_pk,requireApplied(applied).objectId]);
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hub_worker');
      const current=await client.query<{xid:string}>('SELECT pg_current_xact_id()::text AS xid');
      await client.query(`UPDATE control.source_version_receipt SET apply_xid=$5::xid8
        WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3 AND channel_id=$4`,
      [context.tenantId,context.sourceId,customer.source_pk,context.channelId,old.rows[0].xid]);
      await client.query(`INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,
        canonical_object_id,hub_revision,operation,projection_digest,source_content_digest,apply_xid)
        SELECT tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,canonical_object_id,hub_revision,operation,
          projection_digest,source_content_digest,$2::xid8 FROM control.canonical_apply_outbox WHERE id=$1`,
      [old.rows[0].outbox_id,old.rows[0].xid]);
      const stamped=await client.query<{receipt_xid:string;outbox_xid:string}>(`SELECT
        (SELECT apply_xid::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3) AS receipt_xid,
        (SELECT apply_xid::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND canonical_object_id=$4
          ORDER BY id DESC LIMIT 1) AS outbox_xid`,
      [context.tenantId,context.sourceId,customer.source_pk,requireApplied(applied).objectId]);
      expect(stamped.rows[0]).toEqual({receipt_xid:current.rows[0].xid,outbox_xid:current.rows[0].xid});
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(()=>undefined);
      await initial.query('ROLLBACK').catch(()=>undefined);
      initial.release(); client.release();
    }
  });

  it('locks direct-helper owner eligibility before validating it under concurrent disable', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-direct-disable-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const firstPayload={source_pk:'direct-helper-disable-race',customer_name:'Direct helper race',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const initial=await database.connect();
    const disable=await database.connect();
    const worker=await database.connect();
    let helperPromise:Promise<pg.QueryResult>|undefined;
    try {
      await initial.query('BEGIN');
      await initial.query('SET LOCAL ROLE hub_worker');
      const first=await applyCustomer(initial,frozen,firstPayload);
      await initial.query('COMMIT');
      expect(first.status).toBe('APPLIED');

      await disable.query('BEGIN');
      await disable.query('UPDATE control.auth_subject SET enabled=false WHERE tenant_key=$1 AND user_id=$2',
        [context.tenantId,newOwner]);
      const before=await database.query<{owner:string;hub_revision:string;version:string;reference:string;target:string;outbox:string;audit:string;
        old_epoch:string;new_epoch:string}>(`SELECT
        (SELECT owner_user_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS owner,
        (SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS hub_revision,
        (SELECT source_version::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS version,
        (SELECT external_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS reference,
        (SELECT target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS target,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3 AND canonical_object_id=$2) AS outbox,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS audit,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$5) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$6) AS new_epoch`,
      [context.tenantId,requireApplied(first).objectId,context.sourceId,firstPayload.source_pk,context.ownerUserId,newOwner]);

      await worker.query("SET application_name='m1_t2_direct_helper_auth_wait'");
      await worker.query('BEGIN');
      await worker.query('SET LOCAL ROLE hub_worker');
      const secondPayload={...firstPayload,owner_external_id:'ext-B',source_version:'2'};
      const sourceDigest=Buffer.from(sourceContentDigest(secondPayload),'hex');
      const revision=(await worker.query<{revision:string}>("SELECT nextval('control.canonical_hub_revision_seq')::text AS revision")).rows[0].revision;
      const projection=(await worker.query<{digest:Buffer}>(`SELECT control.canonical_projection_digest($1,$2::uuid,
        $3::jsonb) AS digest`,[sourceDigest,requireApplied(first).objectId,
        JSON.stringify({owner_user_id:newOwner,department_id:'sales-east'})])).rows[0].digest;
      await worker.query(`UPDATE hub.canonical_customer SET owner_user_id=$3,source_version=2,hub_revision=$4
        WHERE tenant_id=$1 AND id=$2`,[context.tenantId,requireApplied(first).objectId,newOwner,revision]);
      await worker.query(`UPDATE control.source_version_receipt SET source_version=2,source_content_digest=$4,projection_digest=$5,deleted=false
        WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3`,[context.tenantId,context.sourceId,firstPayload.source_pk,sourceDigest,projection]);
      await worker.query(`INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,
        canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
        VALUES($1,$2,$3,$4,$5,'customer',$6,$7,'UPSERT',$8,$9)`,[context.tenantId,context.sourceId,frozen.channelId,
        frozen.channelEpoch,frozen.versionDomain,requireApplied(first).objectId,revision,projection,sourceDigest]);
      helperPromise=worker.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,firstPayload.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,
        frozen.versionDomain,frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,
        frozen.identityMappingRevision,JSON.stringify([{kind:'user',external_id:'ext-B'}]),
      ]);
      const deadline=Date.now()+2000;
      let lockWaitObserved=false;
      while(Date.now()<deadline && !lockWaitObserved) {
        const activity=await database.query<{wait_event_type:string|null}>(`SELECT wait_event_type FROM pg_stat_activity
          WHERE application_name='m1_t2_direct_helper_auth_wait'`);
        lockWaitObserved=activity.rows[0]?.wait_event_type==='Lock';
        if(!lockWaitObserved) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(lockWaitObserved).toBe(true);
      await disable.query('COMMIT');
      await expect(helperPromise).rejects.toMatchObject({code:'42501'});
      await worker.query('ROLLBACK');
      const after=await database.query(`SELECT
        (SELECT owner_user_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS owner,
        (SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2) AS hub_revision,
        (SELECT source_version::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS version,
        (SELECT external_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS reference,
        (SELECT target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4 AND kind='user') AS target,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3 AND canonical_object_id=$2) AS outbox,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$3 AND source_pk=$4) AS audit,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$5) AS old_epoch,
        (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$6) AS new_epoch`,
      [context.tenantId,requireApplied(first).objectId,context.sourceId,firstPayload.source_pk,context.ownerUserId,newOwner]);
      expect(after.rows).toEqual(before.rows);
    } finally {
      await disable.query('ROLLBACK').catch(()=>undefined);
      if(helperPromise) await helperPromise.catch(()=>undefined);
      await worker.query('ROLLBACK').catch(()=>undefined);
      await initial.query('ROLLBACK').catch(()=>undefined);
      initial.release(); disable.release(); worker.release();
    }
  });

  it('rejects direct-helper owner changes after M0 withdraws the business role to NULL', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-direct-null-role-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const firstPayload={source_pk:'direct-helper-null-role',customer_name:'Direct helper null role',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const initial=await database.connect();
    const worker=await database.connect();
    try {
      await initial.query('BEGIN');
      await initial.query('SET LOCAL ROLE hub_worker');
      const first=await applyCustomer(initial,frozen,firstPayload);
      await initial.query('COMMIT');
      expect(first.status).toBe('APPLIED');

      await database.query('UPDATE control.auth_subject SET business_role=NULL WHERE tenant_key=$1 AND user_id=$2',
        [context.tenantId,newOwner]);
      const withdrawn=await database.query<{enabled:boolean;business_role:string|null;department_id:string}>(
        'SELECT enabled,business_role,department_id FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2',
        [context.tenantId,newOwner]);
      expect(withdrawn.rows[0]).toEqual({enabled:true,business_role:null,department_id:'sales-east'});

      const customerId=requireApplied(first).objectId;
      const captureState=async () => (await database.query<{
        core:unknown;identity_refs:unknown;receipt:unknown;outbox:unknown;audit:unknown;epochs:unknown;
      }>(`SELECT
        (SELECT to_jsonb(c) FROM hub.canonical_customer c WHERE c.tenant_id=$1 AND c.id=$2) AS core,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind) FROM control.canonical_identity_reference r
          WHERE r.tenant_key=$1 AND r.source_id=$3 AND r.entity='customer' AND r.source_pk=$4) AS identity_refs,
        (SELECT to_jsonb(r) FROM control.source_version_receipt r
          WHERE r.tenant_key=$1 AND r.source_id=$3 AND r.entity='customer' AND r.source_pk=$4) AS receipt,
        (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id),'[]'::jsonb) FROM control.canonical_apply_outbox o
          WHERE o.tenant_key=$1 AND o.source_id=$3 AND o.entity='customer' AND o.canonical_object_id=$2) AS outbox,
        (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM control.canonical_ownership_audit a
          WHERE a.tenant_key=$1 AND a.source_id=$3 AND a.entity='customer' AND a.source_pk=$4) AS audit,
        (SELECT jsonb_agg(jsonb_build_array(s.user_id,s.auth_epoch) ORDER BY s.user_id) FROM control.auth_subject s
          WHERE s.tenant_key=$1 AND s.user_id=ANY(ARRAY[$5,$6]::text[])) AS epochs`,
      [context.tenantId,customerId,context.sourceId,firstPayload.source_pk,context.ownerUserId,newOwner])).rows[0];
      const before=await captureState();

      await worker.query('BEGIN');
      await worker.query('SET LOCAL ROLE hub_worker');
      const secondPayload={...firstPayload,owner_external_id:'ext-B',source_version:'2'};
      const sourceDigest=Buffer.from(sourceContentDigest(secondPayload),'hex');
      const revision=(await worker.query<{revision:string}>("SELECT nextval('control.canonical_hub_revision_seq')::text AS revision")).rows[0].revision;
      const projection=(await worker.query<{digest:Buffer}>(`SELECT control.canonical_projection_digest($1,$2::uuid,
        $3::jsonb) AS digest`,[sourceDigest,customerId,
        JSON.stringify({owner_user_id:newOwner,department_id:'sales-east'})])).rows[0].digest;
      await worker.query(`UPDATE hub.canonical_customer SET owner_user_id=$3,source_version=2,hub_revision=$4
        WHERE tenant_id=$1 AND id=$2`,[context.tenantId,customerId,newOwner,revision]);
      await worker.query(`UPDATE control.source_version_receipt SET source_version=2,source_content_digest=$4,projection_digest=$5,deleted=false
        WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3`,[context.tenantId,context.sourceId,firstPayload.source_pk,sourceDigest,projection]);
      await worker.query(`INSERT INTO control.canonical_apply_outbox(tenant_key,source_id,channel_id,channel_epoch,version_domain,entity,
        canonical_object_id,hub_revision,operation,projection_digest,source_content_digest)
        VALUES($1,$2,$3,$4,$5,'customer',$6,$7,'UPSERT',$8,$9)`,[context.tenantId,context.sourceId,frozen.channelId,
        frozen.channelEpoch,frozen.versionDomain,customerId,revision,projection,sourceDigest]);
      await expect(worker.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,firstPayload.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,
        frozen.versionDomain,frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,
        frozen.identityMappingRevision,JSON.stringify([{kind:'user',external_id:'ext-B'}]),
      ])).rejects.toMatchObject({code:'42501'});
      await worker.query('ROLLBACK');

      const after=await captureState();
      expect(after).toEqual(before);
      const roleAfterRollback=await database.query<{enabled:boolean;business_role:string|null;department_id:string}>(
        'SELECT enabled,business_role,department_id FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2',
        [context.tenantId,newOwner]);
      expect(roleAfterRollback.rows[0]).toEqual({enabled:true,business_role:null,department_id:'sales-east'});
    } finally {
      await worker.query('ROLLBACK').catch(()=>undefined);
      await initial.query('ROLLBACK').catch(()=>undefined);
      initial.release(); worker.release();
    }
  });

  it('enforces typed barriers and newer remap fences through direct worker helper calls', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-helper-fences-${randomBytes(3).toString('hex')}`;
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
    const customerTarget=(await database.query<{id:string}>(`SELECT id::text AS id FROM hub.canonical_customer
      WHERE tenant_id=$1 ORDER BY id LIMIT 1`,[context.tenantId])).rows[0].id;
    const frozen=await approveIdentityMapping(context,[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ]);
    const payload={source_pk:'direct-helper-fences',customer_name:'Helper fence customer',owner_external_id:'ext-A',dept_external_id:'dept-D',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    const apply=await database.connect();
    let objectId:string;
    try {
      await apply.query('BEGIN');
      const first=await applyCustomer(apply,frozen,payload);
      await apply.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      await apply.query('BEGIN');
      const changed=await applyCustomer(apply,frozen,{...payload,owner_external_id:'ext-B',source_version:'2'});
      await apply.query('COMMIT');
      expect(changed).toMatchObject({status:'APPLIED'});
      objectId=requireApplied(first).objectId;
    } finally { await apply.query('ROLLBACK').catch(()=>undefined); apply.release(); }

    const state=async()=>database.query<{owner_epoch:string;new_epoch:string;owner_user_id:string;owner_key:string;owner_target:string;
      audit_count:string;receipt_version:string;outbox_count:string;hub_revision:string}>(`SELECT
      (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS owner_epoch,
      (SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$3) AS new_epoch,
      (SELECT owner_user_id FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$6) AS owner_user_id,
      (SELECT external_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$4 AND source_pk=$5 AND kind='user') AS owner_key,
      (SELECT target_id FROM control.canonical_identity_reference WHERE tenant_key=$1 AND source_id=$4 AND source_pk=$5 AND kind='user') AS owner_target,
      (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_id=$4 AND source_pk=$5) AS audit_count,
      (SELECT source_version::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$4 AND entity='customer' AND source_pk=$5) AS receipt_version,
      (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$4 AND entity='customer' AND canonical_object_id=$6) AS outbox_count,
      (SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$6) AS hub_revision`,
    [context.tenantId,context.ownerUserId,newOwner,context.sourceId,payload.source_pk,objectId]);

    const beforeFence=await state();
    const mappingDigest=Buffer.alloc(32,0x66);
    const revisionThree=[
      {kind:'user',external_id:'ext-A',target_id:context.ownerUserId},
      {kind:'user',external_id:'ext-B',target_id:newOwner},
      {kind:'department',external_id:'dept-D',target_id:'sales-east'},
      {kind:'customer',external_id:'customer-ext',target_id:customerTarget},
    ];
    await database.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
      VALUES($1,$2,3,$3,$4::jsonb,$5)`,[context.tenantId,context.sourceId,mappingDigest,JSON.stringify(revisionThree),context.ownerUserId]);
    await database.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision)
      VALUES($1,$2,'user','ext-B',3)`,[context.tenantId,context.sourceId]);
    const remapClient=await database.connect();
    try {
      await remapClient.query('BEGIN');
      await remapClient.query('SET LOCAL ROLE hub_worker');
      await expect(remapClient.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,payload.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,frozen.versionDomain,
        frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,frozen.identityMappingRevision,
        JSON.stringify([{kind:'user',external_id:'ext-B'}]),
      ])).rejects.toMatchObject({code:'42501',message:'identity mapping was superseded'});
      await remapClient.query('ROLLBACK');
    } finally { await remapClient.query('ROLLBACK').catch(()=>undefined); remapClient.release(); }
    expect((await state()).rows).toEqual(beforeFence.rows);

    const barrier=await database.query<{effective_fence:string}>(`INSERT INTO control.source_security_barrier
      (tenant_key,source_id,credential_id,entity,channel_id,barrier_type,reason_code,created_by)
      VALUES($1,$2,$3,'customer',$4,'SOURCE_SCOPE_SECURITY_REMOVAL','fix2 fixture','fixture')
      RETURNING effective_fence::text`,[context.tenantId,context.sourceId,context.credentialId,frozen.channelId]);
    expect(BigInt(barrier.rows[0].effective_fence)).toBeGreaterThan(BigInt(frozen.securityBarrierFenceAtAdmission));
    const beforeBarrier=await state();
    const barrierClient=await database.connect();
    try {
      await barrierClient.query('BEGIN');
      await barrierClient.query('SET LOCAL ROLE hub_worker');
      await expect(barrierClient.query(`SELECT control.record_canonical_customer_owner_change($1,$2,$3,$4,$5,$6::bigint,$7,$8::bigint,$9,$10,$11::bigint,$12::jsonb)`,[
        context.tenantId,context.sourceId,payload.source_pk,context.credentialId,frozen.channelId,frozen.channelEpoch,frozen.versionDomain,
        frozen.securityBarrierFenceAtAdmission,frozen.ownerApprovalId,frozen.testReportId,frozen.identityMappingRevision,
        JSON.stringify([{kind:'department',external_id:'dept-D'}]),
      ])).rejects.toMatchObject({code:'42501',message:'security barrier blocks source ownership change'});
      await barrierClient.query('ROLLBACK');
    } finally { await barrierClient.query('ROLLBACK').catch(()=>undefined); barrierClient.release(); }
    expect((await state()).rows).toEqual(beforeBarrier.rows);
  });

  it('applies the first version zero and rejects a customer payload on an order channel', async () => {
    const context=await seedCustomerApplyProof();
    const customer={source_pk:'zero-version',customer_name:'Zero version customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'0'};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const orderContext={...context,entity:'order' as const};
      await client.query('BEGIN');
      await expect(applyCustomer(client,orderContext,customer)).rejects.toThrow('CANONICAL_APPLY_PROOF_INVALID');
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('uses only the caller transaction and leaves the supplied PoolClient unreleased', async () => {
    const context=await seedCustomerApplyProof();
    const client=await database.connect();
    const originalQuery=client.query.bind(client);
    const statements:string[]=[];
    let released=false;
    const originalRelease=client.release.bind(client);
    client.query=((query:unknown,...args:unknown[])=>{
      if(typeof query==='string') statements.push(query.trim().split(/\s+/)[0].toUpperCase());
      return (originalQuery as (...values:unknown[])=>unknown)(query,...args);
    }) as typeof client.query;
    client.release=((...args:Parameters<typeof client.release>)=>{released=true;return originalRelease(...args);}) as typeof client.release;
    try {
      await client.query('BEGIN');
      const result=await applyCustomer(client,context,{source_pk:'caller-owned-client',customer_name:'Caller',owner_external_id:'owner-ext',
        dept_external_id:'dept-ext',status:'ACTIVE',source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'});
      expect(result.status).toBe('APPLIED');
      expect(statements.filter(value=>['BEGIN','COMMIT','ROLLBACK'].includes(value))).toEqual(['BEGIN']);
      expect(released).toBe(false);
      await client.query('ROLLBACK');
      expect(await database.query('SELECT 1 FROM control.source_version_receipt WHERE tenant_key=$1 AND source_pk=$2',
        [context.tenantId,'caller-owned-client'])).toMatchObject({rowCount:0});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); originalRelease(); }
  });

  it('rejects a frozen proof paired with a same-source channel from another connector tuple', async () => {
    const context=await seedCustomerApplyProof();
    await database.query(`UPDATE control.source_channel SET state='retired' WHERE id=$1`,[context.channelId]);
    const channel=await database.query<{id:string}>(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,
      version_domain,channel_epoch,state) VALUES($1,$2,'customer','postgresql','INCREMENTAL',$3,2,'active') RETURNING id`,
    [context.tenantId,context.sourceId,context.versionDomain]);
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      await expect(applyCustomer(client,{...context,channelId:channel.rows[0].id,channelEpoch:'2'},
        {source_pk:'mismatched-channel',customer_name:'Reject',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
          status:'ACTIVE',source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'})).rejects.toThrow('CANONICAL_APPLY_PROOF_INVALID');
      await client.query('ROLLBACK');
      const receipt=await database.query('SELECT 1 FROM control.source_version_receipt WHERE tenant_key=$1 AND source_pk=$2',
        [context.tenantId,'mismatched-channel']);
      expect(receipt.rowCount).toBe(0);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('keeps equal replay harmless after identity remap and fences later observations from the old mapping', async () => {
    const context=await seedCustomerApplyProof();
    const customer={source_pk:'remapped-customer',customer_name:'Before remap',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-02-01T00:00:00Z',source_version:'1'};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const beforeRemap=await database.query<{hub_revision:string}>(
        'SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',[context.tenantId,requireApplied(first).objectId]);
      const newOwner=`remapped-${randomBytes(4).toString('hex')}`;
      await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
        VALUES($1,$2,'sales-east','sales')`,[context.tenantId,newOwner]);
      const mappingDigest=Buffer.alloc(32,0x67);
      const mappings=[{kind:'user',external_id:'owner-ext',target_id:newOwner},
        {kind:'department',external_id:'dept-ext',target_id:'sales-east'}];
      await database.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,$2,2,$3,$4::jsonb,$5)`,[context.tenantId,context.sourceId,mappingDigest,JSON.stringify(mappings),context.ownerUserId]);
      await database.query(`INSERT INTO control.source_identity_remap_fence(tenant_key,source_id,kind,external_id,identity_mapping_revision)
        VALUES($1,$2,'user','owner-ext',2)`,[context.tenantId,context.sourceId]);
      await database.query('UPDATE hub.canonical_customer SET owner_user_id=$3 WHERE tenant_id=$1 AND id=$2',
        [context.tenantId,requireApplied(first).objectId,newOwner]);
      await database.query(`UPDATE control.canonical_identity_reference SET target_id=$5 WHERE tenant_key=$1 AND source_id=$2
        AND entity='customer' AND source_pk=$3 AND kind='user' AND external_id=$4`,
        [context.tenantId,context.sourceId,customer.source_pk,'owner-ext',newOwner]);

      await client.query('BEGIN');
      const duplicate=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(duplicate).toMatchObject({status:'DUPLICATE',objectId:requireApplied(first).objectId});
      const replayState=await database.query<{owner_user_id:string;hub_revision:string;outbox_count:string}>(`SELECT c.owner_user_id,c.hub_revision::text,
        (SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=c.tenant_id AND o.canonical_object_id=c.id) AS outbox_count
        FROM hub.canonical_customer c WHERE c.tenant_id=$1 AND c.id=$2`,[context.tenantId,requireApplied(first).objectId]);
      expect(replayState.rows[0]).toMatchObject({owner_user_id:newOwner,hub_revision:beforeRemap.rows[0].hub_revision,outbox_count:'1'});

      await client.query('BEGIN');
      const staleMapping=await applyCustomer(client,{...context,identityMappingRevision:'1'}, {...customer,source_version:'2'});
      await client.query('COMMIT');
      expect(staleMapping).toEqual({status:'QUARANTINED',code:'AUTHORITY_MAPPING_SUPERSEDED'});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('reserves a stable customer identity for a minimal unknown-key delete and restores only at a higher version', async () => {
    const context=await seedCustomerApplyProof();
    const client=await database.connect();
    try {
      const tombstone={source_pk:'never-seen-customer',source_version:'2',deleted_at:'2026-02-01T00:00:00Z'};
      await client.query('BEGIN');
      const deleted=await applyCustomer(client,context,tombstone as never);
      await client.query('COMMIT');
      expect(deleted).toMatchObject({status:'APPLIED'});
      const reserved=await database.query<{canonical_object_id:string;customer_id:string|null;deleted:boolean}>(`SELECT i.canonical_object_id::text,i.customer_id::text,r.deleted
        FROM control.canonical_source_identity i JOIN control.source_version_receipt r
          USING(tenant_key,source_id,entity,source_pk) WHERE i.tenant_key=$1 AND i.source_id=$2 AND i.source_pk=$3`,
        [context.tenantId,context.sourceId,tombstone.source_pk]);
      expect(reserved.rows[0]).toEqual({canonical_object_id:deleted.status==='APPLIED'?requireApplied(deleted).objectId:'',customer_id:null,deleted:true});
      const customer={source_pk:tombstone.source_pk,customer_name:'Restored customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
        status:'ACTIVE' as const,source_updated_at:'2026-02-02T00:00:00Z',source_version:'1'};
      await client.query('BEGIN');
      const stale=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(stale.status).toBe('IGNORED_STALE');
      expect(await database.query('SELECT 1 FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',[context.tenantId,deleted.status==='APPLIED'?requireApplied(deleted).objectId:'']))
        .toMatchObject({rowCount:0});
      await client.query('BEGIN');
      const restored=await applyCustomer(client,context,{...customer,source_version:'3'});
      await client.query('COMMIT');
      expect(restored).toMatchObject({status:'APPLIED',objectId:deleted.status==='APPLIED'?requireApplied(deleted).objectId:''});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('advances a repeated unknown-key snapshot tombstone without another revision or outbox row', async () => {
    const context=await seedCustomerApplyProof('SNAPSHOT_OBSERVATION');
    const client=await database.connect();
    const tombstone={source_pk:'snapshot-unknown-delete',source_version:'1',deleted_at:'2026-02-01T00:00:00Z'};
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,tombstone as never);
      await client.query('COMMIT');
      const objectId=requireApplied(first).objectId;
      await client.query('BEGIN');
      const repeated=await applyCustomer(client,context,{...tombstone,source_version:'2'} as never);
      await client.query('COMMIT');
      expect(repeated).toMatchObject({status:'DUPLICATE',objectId});
      const state=await database.query<{source_version:string;canonical_object_id:string;outbox_count:string;core_count:string}>(`SELECT r.source_version::text,
        r.canonical_object_id::text,(SELECT count(*)::text FROM control.canonical_apply_outbox o
          WHERE o.tenant_key=r.tenant_key AND o.source_id=r.source_id AND o.canonical_object_id=r.canonical_object_id) AS outbox_count,
        (SELECT count(*)::text FROM hub.canonical_customer c WHERE c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id) AS core_count
        FROM control.source_version_receipt r WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,
      [context.tenantId,context.sourceId,tombstone.source_pk]);
      expect(state.rows[0]).toEqual({source_version:'2',canonical_object_id:objectId,outbox_count:'1',core_count:'0'});
      const customer={source_pk:tombstone.source_pk,customer_name:'Restored snapshot customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
        status:'ACTIVE' as const,source_updated_at:'2026-02-02T00:00:00Z',source_version:'1'};
      await client.query('BEGIN');
      const stale=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(stale).toMatchObject({status:'IGNORED_STALE',objectId});
      await client.query('BEGIN');
      const restored=await applyCustomer(client,context,{...customer,source_version:'3'});
      await client.query('COMMIT');
      expect(restored).toMatchObject({status:'APPLIED',objectId});
      const restoredState=await database.query<{source_version:string;deleted:boolean;canonical_object_id:string;outbox_count:string}>(`SELECT r.source_version::text,
        r.deleted,r.canonical_object_id::text,(SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=r.tenant_key
          AND o.source_id=r.source_id AND o.canonical_object_id=r.canonical_object_id) AS outbox_count
        FROM control.source_version_receipt r WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,
      [context.tenantId,context.sourceId,tombstone.source_pk]);
      expect(restoredState.rows[0]).toEqual({source_version:'3',deleted:false,canonical_object_id:objectId,outbox_count:'2'});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('reserves a stable order identity for a minimal unknown-key delete and accepts explicit empty-line restoration', async () => {
    const context=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const client=await database.connect();
    try {
      const tombstone={source_pk:'never-seen-order',source_version:'4',deleted_at:'2026-02-01T00:00:00Z'};
      await client.query('BEGIN');
      const deleted=await applyOrderAggregate(client,context,tombstone as never);
      await client.query('COMMIT');
      expect(deleted.status).toBe('APPLIED');
      const reservation=await database.query<{canonical_object_id:string;order_id:string|null;deleted:boolean}>(`SELECT i.canonical_object_id::text,i.order_id::text,r.deleted
        FROM control.canonical_source_identity i JOIN control.source_version_receipt r
          USING(tenant_key,source_id,entity,source_pk) WHERE i.tenant_key=$1 AND i.source_id=$2 AND i.source_pk=$3`,
        [context.tenantId,context.sourceId,tombstone.source_pk]);
      expect(reservation.rows[0]).toEqual({canonical_object_id:deleted.status==='APPLIED'?requireApplied(deleted).objectId:'',order_id:null,deleted:true});
      const order={source_pk:tombstone.source_pk,customer_external_id:'customer-ext',order_no:'O-RESTORE',status:'DRAFT' as const,
        order_at:'2026-02-02T00:00:00Z',amount:'1.00',currency:'CNY' as const,source_updated_at:'2026-02-02T00:00:00Z',
        source_version:'5',deleted_at:null,lines:[]};
      await client.query('BEGIN');
      const restored=await applyOrderAggregate(client,context,order);
      await client.query('COMMIT');
      expect(restored).toMatchObject({status:'APPLIED',objectId:deleted.status==='APPLIED'?requireApplied(deleted).objectId:''});
    } finally { client.release(); }
  });

  it('serializes a matching security barrier after old admission and accepts a later trusted fence', async () => {
    const context=await seedCustomerApplyProof();
    const admission=await database.connect();
    try {
      await admission.query('BEGIN');
      const snapshot=await admission.query<{fence:string}>('SELECT control.lock_security_barrier_fence()::text AS fence');
      const barrierPending=database.query<{effective_fence:string}>(`INSERT INTO control.source_security_barrier
        (tenant_key,source_id,credential_id,entity,channel_id,barrier_type,reason_code,created_by)
        VALUES($1,$2,$3,'customer',$4,'CREDENTIAL_COMPROMISE','fixture','fixture') RETURNING effective_fence::text`,
        [context.tenantId,context.sourceId,context.credentialId,context.channelId]);
      const contending=await database.query<{acquired:boolean}>('SELECT pg_try_advisory_lock(1296905544,1) AS acquired');
      expect(contending.rows[0].acquired).toBe(false);
      await admission.query('COMMIT');
      const barrier=await barrierPending;
      expect(BigInt(barrier.rows[0].effective_fence)).toBeGreaterThan(BigInt(snapshot.rows[0].fence));
      const customer={source_pk:'security-race',customer_name:'Protected customer',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
        status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'0'};
      const client=await database.connect();
      try {
        await client.query('BEGIN');
        const oldApply=await applyCustomer(client,{...context,securityBarrierFenceAtAdmission:snapshot.rows[0].fence},customer);
        await client.query('COMMIT');
        expect(oldApply).toEqual({status:'QUARANTINED',code:'SECURITY_BARRIER_ACTIVE'});
        const recoveredFence=await database.query<{fence:string}>('SELECT control.lock_security_barrier_fence()::text AS fence');
        await client.query('BEGIN');
        const recovered=await applyCustomer(client,{...context,securityBarrierFenceAtAdmission:recoveredFence.rows[0].fence},customer);
        await client.query('COMMIT');
        expect(recovered.status).toBe('APPLIED');
      } finally { client.release(); }
    } finally { await admission.query('ROLLBACK').catch(()=>undefined); admission.release(); }
  });

  it('advances an unchanged snapshot observation receipt without emitting a second outbox event', async () => {
    const context=await seedCustomerApplyProof('SNAPSHOT_OBSERVATION');
    const customer={source_pk:'snapshot-customer',customer_name:'Acme Ltd',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,phone:null,source_updated_at:'2026-02-03T00:00:00Z',source_version:'10',deleted_at:null};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const initialCore=await database.query<{hub_revision:string}>(
        'SELECT hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',[context.tenantId,requireApplied(first).objectId]);
      await client.query('BEGIN');
      const unchanged=await applyCustomer(client,context,{...customer,source_version:'11'});
      await client.query('COMMIT');
      expect(unchanged).toMatchObject({status:'DUPLICATE',objectId:requireApplied(first).objectId});
      const persisted=await database.query<{source_version:string;outbox_count:string}>(`SELECT r.source_version::text,
        (SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=r.tenant_key AND o.source_id=r.source_id AND o.entity='customer' AND o.canonical_object_id=r.canonical_object_id) AS outbox_count
        FROM control.source_version_receipt r WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,[context.tenantId,context.sourceId,customer.source_pk]);
      expect(persisted.rows[0]).toEqual({source_version:'11',outbox_count:'1'});
      await client.query('BEGIN');
      const lowerChanged=await applyCustomer(client,context,{...customer,source_version:'10',customer_name:'Older snapshot'});
      await client.query('COMMIT');
      expect(lowerChanged).toMatchObject({status:'IGNORED_STALE',objectId:requireApplied(first).objectId});
      const core=await database.query<{customer_name:string;source_version:string;hub_revision:string}>(
        'SELECT customer_name,source_version::text,hub_revision::text FROM hub.canonical_customer WHERE tenant_id=$1 AND id=$2',
        [context.tenantId,requireApplied(first).objectId]);
      expect(core.rows[0]).toMatchObject({customer_name:'Acme Ltd',source_version:'10',hub_revision:initialCore.rows[0].hub_revision});
    } finally { client.release(); }
  });

  it('uses one projection digest for remap and an unchanged post-remap snapshot observation', async () => {
    const context=await seedCustomerApplyProof('SNAPSHOT_OBSERVATION');
    const newOwner=`owner-remap-${randomBytes(3).toString('hex')}`;
    const client=await database.connect();
    const customer={source_pk:'snapshot-after-remap',customer_name:'Projection stable',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    try {
      await database.query("UPDATE control.auth_subject SET management_scopes=ARRAY['source:approve']::text[] WHERE tenant_key=$1 AND user_id=$2",
        [context.tenantId,context.ownerUserId]);
      await client.query('BEGIN');
      const first=await applyCustomer(client,context,customer);
      await client.query('COMMIT');
      const revised=await approveOwnerMapping(context,newOwner);
      const initialEpochs=await database.query<{user_id:string;auth_epoch:string}>(`SELECT user_id,auth_epoch::text FROM control.auth_subject
        WHERE tenant_key=$1 AND user_id IN ($2,$3) ORDER BY user_id`,[context.tenantId,context.ownerUserId,newOwner]);
      await client.query('BEGIN');
      await client.query('SELECT control.remap_canonical_identity($1,$2,\'user\',\'owner-ext\',$3,2,$4,\'rollback correction\')',
        [context.tenantId,context.sourceId,newOwner,context.ownerUserId]);
      await client.query('ROLLBACK');
      const rolledBack=await database.query<{owner_user_id:string;source_version:string;outbox_count:string;audit_count:string;fence_count:string}>(`SELECT c.owner_user_id,
        r.source_version::text,(SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=r.tenant_key AND o.canonical_object_id=r.canonical_object_id) AS outbox_count,
        (SELECT count(*)::text FROM control.canonical_ownership_audit a WHERE a.tenant_key=r.tenant_key AND a.source_pk=r.source_pk) AS audit_count,
        (SELECT count(*)::text FROM control.source_identity_remap_fence f WHERE f.tenant_key=r.tenant_key AND f.source_id=r.source_id) AS fence_count
        FROM control.source_version_receipt r JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,[context.tenantId,context.sourceId,customer.source_pk]);
      expect(rolledBack.rows[0]).toEqual({owner_user_id:context.ownerUserId,source_version:'1',outbox_count:'1',audit_count:'0',fence_count:'0'});
      expect((await database.query<{auth_epoch:string}>(`SELECT auth_epoch::text FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2`,
        [context.tenantId,context.ownerUserId])).rows[0].auth_epoch).toBe(initialEpochs.rows.find(row=>row.user_id===context.ownerUserId)?.auth_epoch);
      await client.query('BEGIN');
      await client.query('SELECT control.remap_canonical_identity($1,$2,\'user\',\'owner-ext\',$3,2,$4,\'approved correction\')',
        [context.tenantId,context.sourceId,newOwner,context.ownerUserId]);
      await client.query('COMMIT');
      const remapDigest=await database.query<{matches:boolean;outbox_count:string}>(`SELECT
        o.projection_digest=control.canonical_projection_digest(r.source_content_digest,r.canonical_object_id,
          jsonb_build_object('owner_user_id',c.owner_user_id,'department_id',c.dept_id)) AS matches,
        (SELECT count(*)::text FROM control.canonical_apply_outbox x WHERE x.tenant_key=o.tenant_key AND x.canonical_object_id=o.canonical_object_id) AS outbox_count
        FROM control.canonical_apply_outbox o JOIN control.source_version_receipt r
          ON (r.tenant_key,r.source_id,r.entity,r.canonical_object_id)=(o.tenant_key,o.source_id,o.entity,o.canonical_object_id)
        JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id
        WHERE o.tenant_key=$1 AND o.source_id=$2 AND o.canonical_object_id=$3 AND o.operation='IDENTITY_REMAP'`,
      [context.tenantId,context.sourceId,requireApplied(first).objectId]);
      expect(remapDigest.rows[0]).toEqual({matches:true,outbox_count:'2'});
      const remappedState=await database.query<{owner_user_id:string;dept_id:string;source_version:string;digest:string;user_ref:string;dept_ref:string;hub_revision:string}>(`SELECT
        c.owner_user_id,c.dept_id,c.hub_revision::text,r.source_version::text,encode(r.source_content_digest,'hex') AS digest,
        (SELECT target_id FROM control.canonical_identity_reference x WHERE x.tenant_key=r.tenant_key AND x.source_id=r.source_id
          AND x.source_pk=r.source_pk AND x.kind='user') AS user_ref,
        (SELECT target_id FROM control.canonical_identity_reference x WHERE x.tenant_key=r.tenant_key AND x.source_id=r.source_id
          AND x.source_pk=r.source_pk AND x.kind='department') AS dept_ref
        FROM control.source_version_receipt r JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,[context.tenantId,context.sourceId,customer.source_pk]);
      expect(remappedState.rows[0]).toMatchObject({owner_user_id:newOwner,dept_id:'sales-east',source_version:'1',
        digest:requireApplied(first).digest,user_ref:newOwner,dept_ref:'sales-east'});
      await client.query('BEGIN');
      const unchanged=await applyCustomer(client,revised,{...customer,source_version:'2'});
      await client.query('COMMIT');
      expect(unchanged).toMatchObject({status:'DUPLICATE',objectId:requireApplied(first).objectId});
      const state=await database.query<{source_version:string;owner_user_id:string;hub_revision:string;outbox_count:string}>(`SELECT r.source_version::text,c.owner_user_id,
        c.hub_revision::text,(SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=r.tenant_key AND o.canonical_object_id=r.canonical_object_id) AS outbox_count
        FROM control.source_version_receipt r JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,[context.tenantId,context.sourceId,customer.source_pk]);
      expect(state.rows[0]).toEqual({source_version:'2',owner_user_id:newOwner,hub_revision:remappedState.rows[0].hub_revision,outbox_count:'2'});
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('serializes a source apply with an explicit owner remap and fences the older accepted mapping', async () => {
    const context=await seedCustomerApplyProof();
    const newOwner=`owner-race-${randomBytes(3).toString('hex')}`;
    const customer={source_pk:'apply-remap-race',customer_name:'Race before remap',owner_external_id:'owner-ext',dept_external_id:'dept-ext',
      status:'ACTIVE' as const,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'};
    await database.query("UPDATE control.auth_subject SET management_scopes=ARRAY['source:approve']::text[] WHERE tenant_key=$1 AND user_id=$2",
      [context.tenantId,context.ownerUserId]);
    const revised=await approveOwnerMapping(context,newOwner);
    const apply=await database.connect();
    const remap=await database.connect();
    let remapPromise:Promise<unknown>|undefined;
    let applyPromise:Promise<ApplyResult>|undefined;
    try {
      await apply.query("SELECT set_config('application_name','m1_t2_apply_remap_hold',false)");
      await apply.query('BEGIN');
      applyPromise=applyCustomer(apply,context,customer);
      await expect(applyPromise).resolves.toMatchObject({status:'APPLIED'});

      await remap.query("SELECT set_config('application_name','m1_t2_apply_remap_wait',false)");
      await remap.query('BEGIN');
      await remap.query('SET LOCAL ROLE hub_api');
      remapPromise=remap.query(`SELECT control.remap_canonical_identity($1,$2,'user','owner-ext',$3,2,$4,'concurrent approved correction')`,
        [context.tenantId,context.sourceId,newOwner,context.ownerUserId]);
      const deadline=Date.now()+2000;
      let lockWaitObserved=false;
      while(Date.now()<deadline && !lockWaitObserved) {
        const activity=await database.query<{wait_event_type:string|null}>(`SELECT wait_event_type FROM pg_stat_activity
          WHERE application_name='m1_t2_apply_remap_wait'`);
        lockWaitObserved=activity.rows[0]?.wait_event_type==='Lock';
        if(!lockWaitObserved) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(lockWaitObserved).toBe(true);
      await apply.query('COMMIT');
      await expect(remapPromise).resolves.toBeDefined();
      await remap.query('COMMIT');

      const stale=await database.connect();
      try {
        await stale.query('BEGIN');
        await expect(applyCustomer(stale,context,{...customer,source_version:'2',customer_name:'Stale mapping update'}))
          .resolves.toMatchObject({status:'QUARANTINED',code:'AUTHORITY_MAPPING_SUPERSEDED'});
        await stale.query('ROLLBACK');
      } finally { await stale.query('ROLLBACK').catch(()=>undefined); stale.release(); }

      const state=await database.query<{owner_user_id:string;receipt_version:string;outbox_count:string;audit_count:string}>(`SELECT c.owner_user_id,
        r.source_version::text AS receipt_version,
        (SELECT count(*)::text FROM control.canonical_apply_outbox o WHERE o.tenant_key=r.tenant_key AND o.canonical_object_id=r.canonical_object_id) AS outbox_count,
        (SELECT count(*)::text FROM control.canonical_ownership_audit a WHERE a.tenant_key=r.tenant_key AND a.source_pk=r.source_pk) AS audit_count
        FROM control.source_version_receipt r JOIN hub.canonical_customer c ON c.tenant_id=r.tenant_key AND c.id=r.canonical_object_id
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.source_pk=$3`,[context.tenantId,context.sourceId,customer.source_pk]);
      expect(state.rows[0]).toEqual({owner_user_id:newOwner,receipt_version:'1',outbox_count:'2',audit_count:'1'});
      expect(revised.identityMappingRevision).toBe('2');
    } finally {
      await apply.query('ROLLBACK').catch(()=>undefined);
      await remapPromise?.catch(()=>undefined);
      await remap.query('ROLLBACK').catch(()=>undefined);
      apply.release(); remap.release();
    }
  });

  it('rejects a department remap that contradicts the current M0 owner department', async () => {
    const context=await seedCustomerApplyProof();
    const customerId=(await database.query<{id:string}>(`SELECT id::text FROM hub.canonical_customer WHERE tenant_id=$1`,[context.tenantId])).rows[0].id;
    await database.query(`UPDATE control.auth_subject SET management_scopes=ARRAY['source:approve']::text[] WHERE tenant_key=$1 AND user_id=$2`,
      [context.tenantId,context.ownerUserId]);
    await database.query(`INSERT INTO control.auth_subject(tenant_key,user_id,department_id,business_role)
      VALUES($1,'other-sales','dept-other','sales')`,[context.tenantId]);
    await database.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
      VALUES($1,$2,2,$3,$4::jsonb,$5)`,[context.tenantId,context.sourceId,Buffer.alloc(32,0x66),JSON.stringify([
        {kind:'user',external_id:'owner-ext',target_id:context.ownerUserId},
        {kind:'department',external_id:'dept-ext',target_id:'dept-other'},
      ]),context.ownerUserId]);
    await database.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id,customer_id)
      VALUES($1,$2,'customer','dept-remap-target',$3,$3)`,[context.tenantId,context.sourceId,customerId]);
    await database.query(`INSERT INTO control.canonical_identity_reference(tenant_key,source_id,entity,source_pk,kind,external_id,target_id)
      VALUES($1,$2,'customer','dept-remap-target','user','owner-ext',$3),($1,$2,'customer','dept-remap-target','department','dept-ext','sales-east')`,
    [context.tenantId,context.sourceId,context.ownerUserId]);
    await database.query(`INSERT INTO control.source_version_receipt(tenant_key,source_id,channel_id,channel_epoch,entity,source_pk,version_domain,
      source_version,source_content_digest,projection_digest,canonical_object_id,deleted)
      VALUES($1,$2,$3,1,'customer','dept-remap-target','SOURCE_VERSION',1,$4,$5,$6,false)`,
    [context.tenantId,context.sourceId,context.channelId,Buffer.alloc(32,0x77),Buffer.alloc(32,0x88),customerId]);
    const before=await database.query(`SELECT c.dept_id,r.target_id,
      (SELECT auth_epoch FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS owner_epoch,
      (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_pk='dept-remap-target') AS audits,
      (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3) AS outbox,
      (SELECT count(*)::text FROM control.source_identity_remap_fence WHERE tenant_key=$1 AND source_id=$3) AS fences
      FROM hub.canonical_customer c JOIN control.canonical_identity_reference r ON r.tenant_key=c.tenant_id AND r.target_id=c.dept_id
      WHERE c.tenant_id=$1 AND c.id=$4 AND r.kind='department'`,[context.tenantId,context.ownerUserId,context.sourceId,customerId]);
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(`SELECT control.remap_canonical_identity($1,$2,'department','dept-ext','dept-other',2,$3,'contradiction')`,
        [context.tenantId,context.sourceId,context.ownerUserId])).rejects.toMatchObject({code:'22023'});
      await client.query('ROLLBACK');
      const after=await database.query(`SELECT c.dept_id,r.target_id,
        (SELECT auth_epoch FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2) AS owner_epoch,
        (SELECT count(*)::text FROM control.canonical_ownership_audit WHERE tenant_key=$1 AND source_pk='dept-remap-target') AS audits,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$3) AS outbox,
        (SELECT count(*)::text FROM control.source_identity_remap_fence WHERE tenant_key=$1 AND source_id=$3) AS fences
        FROM hub.canonical_customer c JOIN control.canonical_identity_reference r ON r.tenant_key=c.tenant_id AND r.target_id=c.dept_id
        WHERE c.tenant_id=$1 AND c.id=$4 AND r.kind='department'`,[context.tenantId,context.ownerUserId,context.sourceId,customerId]);
      expect(after.rows).toEqual(before.rows);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });

  it('replaces the complete order line image, retains tombstones, and restores only with a higher source version', async () => {
    const context=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const base={source_pk:'order-100',customer_external_id:'customer-ext',order_no:'O-100',status:'CONFIRMED' as const,
      order_at:'2026-02-03T00:00:00Z',amount:'0.01',currency:'CNY' as const,source_updated_at:'2026-02-03T00:00:00Z',deleted_at:null,
      lines:[{source_line_id:'line-a',product_code:'SKU-A',product_name:'A',quantity:'2.000000',unit_price:'900.000000',line_amount:'1800.00'},
        {source_line_id:'line-b',product_code:'SKU-B',product_name:'B',quantity:'1.000000',unit_price:'50.000000',line_amount:'50.00'}]};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      const first=await applyOrderAggregate(client,context,{...base,source_version:'1'});
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      const initialLines=await database.query<{id:string;source_line_id:string;line_amount:string;deleted_at:Date|null}>(
        'SELECT id::text,source_line_id,line_amount::text,deleted_at FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id',
        [context.tenantId,requireApplied(first).objectId]);
      expect(initialLines.rows.map(({source_line_id,line_amount,deleted_at})=>({source_line_id,line_amount,deleted_at}))).toEqual([
        {source_line_id:'line-a',line_amount:'1800.00',deleted_at:null},{source_line_id:'line-b',line_amount:'50.00',deleted_at:null},
      ]);

      await client.query('BEGIN');
      const replacement=await applyOrderAggregate(client,context,{...base,source_version:'2',lines:[{...base.lines[0],product_name:'A revised',line_amount:'9.00'}]});
      await client.query('COMMIT');
      expect(replacement.status).toBe('APPLIED');
      const replacedLines=await database.query<{id:string;source_line_id:string;product_name:string;line_amount:string;deleted_at:Date|null}>(
        'SELECT id::text,source_line_id,product_name,line_amount::text,deleted_at FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id',
        [context.tenantId,requireApplied(first).objectId]);
      expect(replacedLines.rows).toEqual([
        {id:initialLines.rows[0].id,source_line_id:'line-a',product_name:'A revised',line_amount:'9.00',deleted_at:null},
        {id:initialLines.rows[1].id,source_line_id:'line-b',product_name:'B',line_amount:'50.00',deleted_at:expect.any(Date)},
      ]);

      await client.query('BEGIN');
      const deleted=await applyOrderAggregate(client,context,{...base,source_version:'3',deleted_at:'2026-02-04T00:00:00Z',lines:[]});
      await client.query('COMMIT');
      expect(deleted).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const tombstone=await database.query<{deleted_at:Date|null;line_deleted_at:Date|null;receipt_deleted:boolean}>(`SELECT o.deleted_at,
        (SELECT max(l.deleted_at) FROM hub.canonical_order_line l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id) AS line_deleted_at,
        r.deleted AS receipt_deleted FROM hub.canonical_order o JOIN control.source_version_receipt r
          ON r.tenant_key=o.tenant_id AND r.canonical_object_id=o.id WHERE o.tenant_id=$1 AND o.id=$2`,[context.tenantId,requireApplied(first).objectId]);
      expect(tombstone.rows[0]).toMatchObject({deleted_at:expect.any(Date),line_deleted_at:expect.any(Date),receipt_deleted:true});

      await client.query('BEGIN');
      const staleRestore=await applyOrderAggregate(client,context,{...base,source_version:'2',deleted_at:null});
      await client.query('COMMIT');
      expect(staleRestore.status).toBe('IGNORED_STALE');
      await client.query('BEGIN');
      const restored=await applyOrderAggregate(client,context,{...base,source_version:'4',deleted_at:null,lines:[base.lines[0]]});
      await client.query('COMMIT');
      expect(restored).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const restoredRow=await database.query<{deleted_at:Date|null;line_count:string;line_id:string;old_line_id:string}>(`SELECT deleted_at,
        (SELECT count(*)::text FROM hub.canonical_order_line l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.deleted_at IS NULL) AS line_count,
        (SELECT id::text FROM hub.canonical_order_line l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.source_line_id='line-a') AS line_id,
        (SELECT id::text FROM hub.canonical_order_line l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.source_line_id='line-b') AS old_line_id
        FROM hub.canonical_order o WHERE o.tenant_id=$1 AND o.id=$2`,[context.tenantId,requireApplied(first).objectId]);
      expect(restoredRow.rows[0]).toEqual({deleted_at:null,line_count:'1',line_id:initialLines.rows[0].id,old_line_id:initialLines.rows[1].id});
    } finally { client.release(); }
  });

  it('preserves the complete T0 order image when header, each representative line, receipt, or outbox fails', async () => {
    const context=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const client=await database.connect();
    const sourcePk='order-rollback-matrix';
    let orderId='';
    const base={source_pk:sourcePk,customer_external_id:'customer-ext',order_no:'O-RB',status:'DRAFT' as const,
      order_at:'2026-02-03T00:00:00Z',amount:'3.00',currency:'CNY' as const,source_updated_at:'2026-02-03T00:00:00Z',deleted_at:null,
      lines:['line-first','line-middle','line-last'].map((source_line_id,index)=>({source_line_id,product_code:`SKU-${index}`,
        product_name:`Item ${index}`,quantity:'1.000000',unit_price:'1.000000',line_amount:'1.00'}))};
    const state=async()=>{
      const [header,lines,receipt,outbox]=await Promise.all([
        database.query(`SELECT id::text,order_no,amount::text,source_version::text,hub_revision::text FROM hub.canonical_order WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId,orderId]),
        database.query(`SELECT id::text,source_line_id,product_name,deleted_at,hub_revision::text FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id`,
          [context.tenantId,orderId]),
        database.query(`SELECT source_version::text,source_content_digest,projection_digest,canonical_object_id::text,deleted FROM control.source_version_receipt
          WHERE tenant_key=$1 AND source_id=$2 AND source_pk=$3`,[context.tenantId,context.sourceId,sourcePk]),
        database.query(`SELECT count(*)::text AS count FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2`,
          [context.tenantId,context.sourceId]),
      ]);
      return {header:header.rows,lines:lines.rows,receipt:receipt.rows,outbox:outbox.rows[0].count};
    };
    try {
      await client.query('BEGIN');
      const first=await applyOrderAggregate(client,context,{...base,source_version:'1'});
      await client.query('COMMIT');
      expect(first.status).toBe('APPLIED');
      orderId=requireApplied(first).objectId;
      const t0=await state();
      expect(t0.header[0]).toMatchObject({order_no:'O-RB',amount:'3.00',source_version:'1',hub_revision:requireApplied(first).hubRevision});
      expect(t0.lines).toHaveLength(3);
      expect(t0.receipt[0]).toMatchObject({source_version:'1',canonical_object_id:requireApplied(first).objectId,deleted:false});
      expect(t0.outbox).toBe('1');

      await database.query(`CREATE FUNCTION control.fail_canonical_test_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE point text := current_setting('m1_t2.failpoint',true); BEGIN
          IF TG_TABLE_NAME='canonical_order' AND point='header' THEN
            RAISE EXCEPTION 'fixture failure %',point;
          ELSIF TG_TABLE_NAME='canonical_order_line' AND point IN ('first','middle','last') THEN
            IF NEW.source_line_id='line-'||point THEN RAISE EXCEPTION 'fixture failure %',point; END IF;
          ELSIF TG_TABLE_NAME='source_version_receipt' AND point='receipt' THEN
            RAISE EXCEPTION 'fixture failure %',point;
          ELSIF TG_TABLE_NAME='canonical_apply_outbox' AND point='outbox' THEN
            RAISE EXCEPTION 'fixture failure %',point;
          END IF;
          RETURN NEW;
        END $$`);
      await database.query(`CREATE TRIGGER fail_canonical_header BEFORE INSERT ON hub.canonical_order
        FOR EACH ROW EXECUTE FUNCTION control.fail_canonical_test_checkpoint()`);
      await database.query(`CREATE TRIGGER fail_canonical_line BEFORE INSERT ON hub.canonical_order_line
        FOR EACH ROW EXECUTE FUNCTION control.fail_canonical_test_checkpoint()`);
      await database.query(`CREATE TRIGGER fail_canonical_receipt BEFORE INSERT ON control.source_version_receipt
        FOR EACH ROW EXECUTE FUNCTION control.fail_canonical_test_checkpoint()`);
      await database.query(`CREATE TRIGGER fail_canonical_outbox BEFORE INSERT ON control.canonical_apply_outbox
        FOR EACH ROW EXECUTE FUNCTION control.fail_canonical_test_checkpoint()`);

      for(const point of ['header','first','middle','last','receipt','outbox'] as const) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('m1_t2.failpoint',$1,true)",[point]);
        await expect(applyOrderAggregate(client,context,{...base,amount:'4.00',source_version:'2',
          lines:base.lines.map(line=>({...line,product_name:`revised ${line.product_name}`}))})).rejects.toThrow(`fixture failure ${point}`);
        await client.query('ROLLBACK');
        expect(await state()).toEqual(t0);
      }
    } finally {
      await database.query('DROP TRIGGER IF EXISTS fail_canonical_header ON hub.canonical_order').catch(()=>undefined);
      await database.query('DROP TRIGGER IF EXISTS fail_canonical_line ON hub.canonical_order_line').catch(()=>undefined);
      await database.query('DROP TRIGGER IF EXISTS fail_canonical_receipt ON control.source_version_receipt').catch(()=>undefined);
      await database.query('DROP TRIGGER IF EXISTS fail_canonical_outbox ON control.canonical_apply_outbox').catch(()=>undefined);
      await database.query('DROP FUNCTION IF EXISTS control.fail_canonical_test_checkpoint()').catch(()=>undefined);
      await client.query('ROLLBACK').catch(()=>undefined);
      client.release();
    }
  });

  it('persists a complete 200-line order image', async () => {
    const context=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const order={source_pk:'order-two-hundred',customer_external_id:'customer-ext',order_no:'O-200',status:'DRAFT' as const,
      order_at:'2026-02-03T00:00:00Z',amount:'0.00',currency:'CNY' as const,source_updated_at:'2026-02-03T00:00:00Z',source_version:'1',
      lines:Array.from({length:200},(_,index)=>({source_line_id:`line-${String(index).padStart(3,'0')}`,product_code:`SKU-${index}`,
        product_name:`Product ${index}`,quantity:'1.000000',unit_price:'0.000000',line_amount:'0.00'}))};
    const client=await database.connect();
    try {
      await client.query('BEGIN');
      const result=await applyOrderAggregate(client,context,order);
      await client.query('COMMIT');
      expect(result.status).toBe('APPLIED');
      const count=await database.query<{count:string}>(`SELECT count(*)::text AS count FROM hub.canonical_order_line
        WHERE tenant_id=$1 AND order_id=$2`,[context.tenantId,requireApplied(result).objectId]);
      expect(count.rows[0].count).toBe('200');
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  });
});
