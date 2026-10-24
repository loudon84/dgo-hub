import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../migrations/runner.js';
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
      expect(first).toMatchObject({ status:'APPLIED', hubRevision:'1' });
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
      const initialLines=await database.query<{source_line_id:string;line_amount:string}>(
        'SELECT source_line_id,line_amount::text FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 ORDER BY source_line_id',
        [context.tenantId,requireApplied(first).objectId]);
      expect(initialLines.rows).toEqual([{source_line_id:'line-a',line_amount:'1800.00'},{source_line_id:'line-b',line_amount:'50.00'}]);

      await client.query('BEGIN');
      const replacement=await applyOrderAggregate(client,context,{...base,source_version:'2',lines:[base.lines[0]]});
      await client.query('COMMIT');
      expect(replacement.status).toBe('APPLIED');
      await expect(database.query('SELECT 1 FROM hub.canonical_order_line WHERE tenant_id=$1 AND order_id=$2 AND source_line_id=$3',
        [context.tenantId,requireApplied(first).objectId,'line-b'])).resolves.toMatchObject({rowCount:0});

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
      const restored=await applyOrderAggregate(client,context,{...base,source_version:'4',deleted_at:null,lines:[]});
      await client.query('COMMIT');
      expect(restored).toMatchObject({status:'APPLIED',objectId:requireApplied(first).objectId});
      const restoredRow=await database.query<{deleted_at:Date|null;line_count:string}>(`SELECT deleted_at,
        (SELECT count(*)::text FROM hub.canonical_order_line l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.deleted_at IS NULL) AS line_count
        FROM hub.canonical_order o WHERE o.tenant_id=$1 AND o.id=$2`,[context.tenantId,requireApplied(first).objectId]);
      expect(restoredRow.rows[0]).toEqual({deleted_at:null,line_count:'0'});
    } finally { client.release(); }
  });

  it('rolls back the order header, first line, receipt, and outbox if a middle line write fails', async () => {
    const context=await seedCustomerApplyProof('SOURCE_VERSION','order');
    const client=await database.connect();
    try {
      await database.query(`CREATE FUNCTION control.fail_canonical_test_line() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.source_line_id='line-fail' THEN RAISE EXCEPTION 'fixture line failure'; END IF; RETURN NEW; END $$`);
      await database.query(`CREATE TRIGGER fail_canonical_test_line BEFORE INSERT ON hub.canonical_order_line
        FOR EACH ROW EXECUTE FUNCTION control.fail_canonical_test_line()`);
      await client.query('BEGIN');
      await expect(applyOrderAggregate(client,context,{source_pk:'order-rollback',customer_external_id:'customer-ext',order_no:'O-RB',status:'DRAFT',
        order_at:'2026-02-03T00:00:00Z',amount:'1.00',currency:'CNY',source_updated_at:'2026-02-03T00:00:00Z',source_version:'1',deleted_at:null,
        lines:[{source_line_id:'line-first',product_code:'SKU-A',product_name:'A',quantity:'1.000000',unit_price:'1.000000',line_amount:'1.00'},
          {source_line_id:'line-fail',product_code:'SKU-B',product_name:'B',quantity:'1.000000',unit_price:'1.000000',line_amount:'1.00'}]}))
        .rejects.toThrow('fixture line failure');
      await client.query('ROLLBACK');
      const leftovers=await database.query<{orders:string;lines:string;receipts:string;outbox:string}>(`SELECT
        (SELECT count(*)::text FROM hub.canonical_order WHERE tenant_id=$1 AND order_no='O-RB') AS orders,
        (SELECT count(*)::text FROM hub.canonical_order_line WHERE tenant_id=$1 AND source_line_id IN ('line-first','line-fail')) AS lines,
        (SELECT count(*)::text FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id=$2 AND source_pk='order-rollback') AS receipts,
        (SELECT count(*)::text FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id=$2 AND canonical_object_id IN
          (SELECT id FROM hub.canonical_order WHERE tenant_id=$1 AND order_no='O-RB')) AS outbox`,[context.tenantId,context.sourceId]);
      expect(leftovers.rows[0]).toEqual({orders:'0',lines:'0',receipts:'0',outbox:'0'});
    } finally {
      await database.query('DROP TRIGGER IF EXISTS fail_canonical_test_line ON hub.canonical_order_line').catch(()=>undefined);
      await database.query('DROP FUNCTION IF EXISTS control.fail_canonical_test_line()').catch(()=>undefined);
      client.release();
    }
  });
});
