import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '../migrations/runner.js';
import type { PoolClient } from 'pg';
import { setupImportRecoveryFixture, setupOrderRecoveryFixture, sample, source, tenant } from './helpers/import-recovery-fixture.js';
import { startOwnedPostgres, fixtureEvidenceRootFromEnvironment } from './helpers/postgres.js';
import type { ImportRecoveryPlan } from '../ingestion-api/import-recovery-plan.js';

let context: Awaited<ReturnType<typeof setupImportRecoveryFixture>>;
let plan: Extract<ImportRecoveryPlan,{kind:'ELIGIBLE'}>;
let otherPlan: Extract<ImportRecoveryPlan,{kind:'ELIGIBLE'}>;
let orderPlan: Extract<ImportRecoveryPlan,{kind:'ELIGIBLE'}>, orderReferenceId:string;
const racePlans:Extract<ImportRecoveryPlan,{kind:'ELIGIBLE'}>[]=[];
beforeAll(async () => {
 context = await setupImportRecoveryFixture('schema');
 const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
 await copyFile(join(migrations,'015_import_recovery_schema.sql'),join(context.migrationDirectory,'015_import_recovery_schema.sql'));
 expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['015_import_recovery_schema']);
 const again=await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});
 expect(again.applied).toEqual([]);expect(again.skipped.at(-1)).toBe('015_import_recovery_schema');
 const fresh=await startOwnedPostgres({evidenceRoot:join(fixtureEvidenceRootFromEnvironment()!,'i3a0-fresh',randomUUID()),evidenceFile:'unused',taskLabel:'m1task1'});
 try {
  const first=await runMigrations(fresh.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});
  expect(first.applied).toHaveLength(15);expect(first.applied.at(-1)).toBe('015_import_recovery_schema');
  const repeat=await runMigrations(fresh.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'});
  expect(repeat.applied).toEqual([]);expect(repeat.skipped).toHaveLength(15);
 } finally {await fresh.close();}
 // Current runtime fails closed on 015 without the bounded 016 ordinary lookup.
 // Stage it only after the populated, reapply, and fresh 015 assertions above.
 await copyFile(join(migrations,'016_import_recovery_admission.sql'),join(context.migrationDirectory,'016_import_recovery_admission.sql'));
 expect((await runMigrations(context.fixture.pool,{directory:context.migrationDirectory,environmentKind:'local_lab'})).applied).toEqual(['016_import_recovery_admission']);
 const headers={authorization:`Bearer ${context.token}`};
 const mapping=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=department&external_id=team-missing`,headers});
 expect(mapping.statusCode).toBe(200);
 expect((await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${mapping.json().data.id}`,headers,payload:{expected_revision:'2',target_id:'dept1',reason:'confirmed'}})).statusCode).toBe(200);
 const userMapping=await context.app.inject({method:'GET',url:`/hub/v1/admin/identity-mappings?source_id=${source}&kind=user&external_id=rep-missing`,headers});
 expect(userMapping.statusCode).toBe(200);
 expect((await context.app.inject({method:'PUT',url:`/hub/v1/admin/identity-mappings/${userMapping.json().data.id}`,headers,payload:{expected_revision:'3',target_id:'owner',reason:'confirmed'}})).statusCode).toBe(200);
 const tested=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/test`,headers,payload:{expected_revision:'1',samples:{customer:JSON.stringify(sample)}}});
 expect(tested.json().data.status).toBe('PASS');
 const report=tested.json().data;
 const approved=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/approve`,headers,payload:{revision:'1',test_report_id:report.test_report_id,data_contract_ref:report.data_contract_ref}});
 expect(approved.statusCode).toBe(200);
 expect((await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/activate`,headers,payload:{revision:'1',approval_id:approved.json().data.approval_id}})).statusCode).toBe(200);
 const {readImportRecoveryCandidate,readImportRecoveryBindingPlan}=await import('../ingestion-api/import-recovery-plan.js');
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');await client.query('SET LOCAL ROLE hub_api');
  const candidate=await readImportRecoveryCandidate(client,context.auth,context.principal,context.partialId);
  expect(candidate.kind).toBe('ELIGIBLE');if(candidate.kind!=='ELIGIBLE') throw new Error('fixture candidate unavailable');
  const result=await readImportRecoveryBindingPlan(client,context.auth,context.principal,context.partialId,{
   expectedSourceRevision:candidate.current.sourceRevision,identityMappingRevision:candidate.current.identityMappingRevision,
   identityMappingDigest:candidate.current.identityMappingDigest,bindings:[{kind:'department',externalId:'team-missing',targetId:'dept1'}]});
  expect(result.kind).toBe('ELIGIBLE');if(result.kind!=='ELIGIBLE') throw new Error('fixture binding unavailable');plan=result;
  const otherCandidate=await readImportRecoveryCandidate(client,context.auth,context.principal,context.quarantineId);
  expect(otherCandidate.kind).toBe('ELIGIBLE');if(otherCandidate.kind!=='ELIGIBLE') throw new Error('other fixture candidate unavailable');
  const other=await readImportRecoveryBindingPlan(client,context.auth,context.principal,context.quarantineId,{
   expectedSourceRevision:otherCandidate.current.sourceRevision,identityMappingRevision:otherCandidate.current.identityMappingRevision,
   identityMappingDigest:otherCandidate.current.identityMappingDigest,bindings:[{kind:'user',externalId:'rep-missing',targetId:'owner'},
    {kind:'department',externalId:'team-missing',targetId:'dept1'}]});
  expect(other.kind).toBe('ELIGIBLE');if(other.kind!=='ELIGIBLE') throw new Error('other fixture binding unavailable');otherPlan=other;
  for(const id of context.raceIds) {
   const c=await readImportRecoveryCandidate(client,context.auth,context.principal,id);
   expect(c.kind).toBe('ELIGIBLE');if(c.kind!=='ELIGIBLE') throw new Error('race fixture candidate unavailable');
   const p=await readImportRecoveryBindingPlan(client,context.auth,context.principal,id,{
    expectedSourceRevision:c.current.sourceRevision,identityMappingRevision:c.current.identityMappingRevision,
    identityMappingDigest:c.current.identityMappingDigest,bindings:[{kind:'department',externalId:'team-missing',targetId:'dept1'}]});
   expect(p.kind).toBe('ELIGIBLE');if(p.kind!=='ELIGIBLE') throw new Error('race fixture binding unavailable');racePlans.push(p);
  }
 } finally {await client.query('ROLLBACK');client.release();}
 const orderFixture=await setupOrderRecoveryFixture(context,'schema','schema-order-ref');
 const orderClient=await context.fixture.pool.connect();
 try {
  await orderClient.query('BEGIN');await orderClient.query('SET LOCAL ROLE hub_api');
  const candidate=await readImportRecoveryCandidate(orderClient,context.auth,context.principal,orderFixture.q);
  expect(candidate.kind).toBe('ELIGIBLE');if(candidate.kind!=='ELIGIBLE') throw new Error('order fixture candidate unavailable');
  const result=await readImportRecoveryBindingPlan(orderClient,context.auth,context.principal,orderFixture.q,{
   expectedSourceRevision:candidate.current.sourceRevision,identityMappingRevision:candidate.current.identityMappingRevision,
   identityMappingDigest:candidate.current.identityMappingDigest,
   bindings:[{kind:'customer',sourceId:source,sourcePk:'schema-order-ref',externalId:orderFixture.key('schema-order-ref'),targetId:orderFixture.ids[1]!}]});
  expect(result.kind).toBe('ELIGIBLE');if(result.kind!=='ELIGIBLE') throw new Error('order fixture binding unavailable');
  orderPlan=result;orderReferenceId=orderFixture.ids[1]!;
 } finally {await orderClient.query('ROLLBACK');orderClient.release();}
}, 120000);
afterAll(async () => { if(context) { await context.app.close(); await new Promise<void>(r=>context.jwks.close(()=>r())); await context.fixture.close(); } });

it('keeps the existing multi-item management import unflagged after upgrade', async () => {
 const result = await context.fixture.pool.query(`SELECT j.import_recovery_operation_id, q.ordinal
  FROM control.ingestion_quarantine_index q JOIN control.ingestion_job j ON j.id=q.job_id
  WHERE q.quarantine_id=$1`,[context.partialId]);
 expect(result.rows).toEqual([{import_recovery_operation_id:null,ordinal:1}]);
});

type Options={order?:'op-first'|'child-first'; missing?:'child'|'item'|'outbox'; extraItem?:boolean; wrongReverse?:boolean; sameItemUuid?:boolean; other?:boolean; selected?:Extract<ImportRecoveryPlan,{kind:'ELIGIBLE'}>;
 op?:Record<string,unknown>; child?:Record<string,string>; item?:Record<string,string>; audit?:boolean; immediate?:boolean};
const childColumns=['tenant_key','source_id','entity','route','batch_id','raw_batch_id','request_digest','credential_id','source_epoch_at_admission',
 'credential_revision_at_admission','credential_generation_at_admission','channel_id','channel_epoch','version_domain','owner_approval_id','owner_user_id',
 'owner_revision','approval_security_fence','config_revision','config_digest','mapping_revision','mapping_digest','identity_mapping_revision',
 'identity_mapping_digest','endpoint_profile_digest','test_report_id','security_barrier_fence_at_admission'];
const itemColumns=['event_id','source_pk','source_version','operation','source_updated_at','public_record'];

// Trusted migrator constructs rows; this is not a runtime admission or OIDC proof.
async function insertCycle(client:PoolClient, options:Options={}) {
 const selected=options.selected??(options.other?otherPlan:plan),quarantine=selected.original.quarantineId;
 const op=randomUUID(),child=randomUUID(),own=randomUUID(),p=selected.bindingProof;
 await client.query(`INSERT INTO control.canonical_source_identity(tenant_key,source_id,entity,source_pk,canonical_object_id)
  VALUES($1,$2,$3,$4,$5)`,[selected.original.tenantId,selected.original.sourceId,selected.original.entity,selected.original.sourcePk,own]);
 const row:Record<string,unknown>={operation_id:op,tenant_key:selected.original.tenantId,source_id:selected.original.sourceId,entity:selected.original.entity,quarantine_id:quarantine,
  original_job_id:selected.original.jobId,original_ordinal:selected.original.ordinal,source_pk:selected.original.sourcePk,reserved_object_id:own,child_job_id:child,
  route:`/hub/v1/admin/quarantine/${quarantine}/import-recovery`,idempotency_key:`recovery-${op}`,request_digest:Buffer.alloc(32,7),
  expected_state:'v1-fixture',reason:'repair missing binding',actor_user_id:context.principal.userId,actor_issuer:context.principal.issuer,
  actor_subject:context.principal.subject,actor_auth_epoch:context.principal.authEpoch,owner_revision:p.ownerRevision,binding_proof_version:1,
  binding_approval_id:p.approvalId,binding_test_report_id:p.testReportId,binding_config_revision:p.configRevision,binding_config_digest:Buffer.from(p.configDigest,'hex'),
  binding_mapping_revision:p.mappingRevision,binding_mapping_digest:Buffer.from(p.mappingDigest,'hex'),binding_identity_mapping_revision:p.identityMappingRevision,
  binding_identity_mapping_digest:Buffer.from(p.identityMappingDigest,'hex'),binding_sample_digest:Buffer.from(p.sampleDigest,'hex'),binding_credential_id:p.credentialId,
  binding_source_epoch:p.sourceEpoch,binding_credential_revision:p.credentialRevision,binding_credential_generation:p.credentialGeneration,
  binding_channel_id:p.channelId,binding_channel_epoch:p.channelEpoch,binding_approval_security_fence:p.approvalSecurityFence,
  binding_security_fence:p.securityFence,confirmed_bindings:JSON.stringify(selected.confirmedBindings),...options.op};
 const insertOp=async()=>{const names=Object.keys(row);await client.query(`INSERT INTO control.import_recovery_operation(${names.join(',')}) VALUES(${names.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));};
 const insertChild=async()=>{
  const expressions=childColumns.map(column=>options.child?.[column]??`j.${column}`);
  await client.query(`INSERT INTO control.ingestion_job(id,${childColumns.join(',')},idempotency_key,status,received_count,applied_count,first_source_updated_at,last_source_updated_at,import_recovery_operation_id)
   SELECT $1,${expressions.join(',')},$2,'RECEIVED',1,0,i.source_updated_at,i.source_updated_at,$3
   FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id AND i.ordinal=$5 WHERE j.id=$4`,[child,`child-${child}`,options.wrongReverse?randomUUID():op,selected.original.jobId,selected.original.ordinal]);
 };
 if(options.order==='child-first') {if(options.missing!=='child') await insertChild();await insertOp();}
 else {await insertOp();if(options.missing!=='child') await insertChild();}
 if(options.missing!=='child' && options.missing!=='item') {
  const expressions=itemColumns.map(column=>options.item?.[column]??`i.${column}`);
  await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,${itemColumns.join(',')},status,operation_id)
   SELECT $1,0,${expressions.join(',')},'RECEIVED',${options.sameItemUuid?'i.operation_id':'gen_random_uuid()'} FROM control.ingestion_job_item i WHERE i.job_id=$2 AND i.ordinal=$3`,[child,selected.original.jobId,selected.original.ordinal]);
 }
 if(options.extraItem) await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
  SELECT $1,1,gen_random_uuid(),i.source_pk,i.source_version,i.operation,i.source_updated_at,i.public_record,'RECEIVED' FROM control.ingestion_job_item i WHERE i.job_id=$2 AND i.ordinal=$3`,[child,selected.original.jobId,selected.original.ordinal]);
 if(options.missing!=='child' && options.missing!=='outbox') await client.query('INSERT INTO control.ingestion_processing_outbox(job_id) VALUES($1)',[child]);
 if(options.audit) await client.query(`INSERT INTO control.ingestion_management_admission_audit(job_id,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,request_id)
  VALUES($1,$2,$3,'owner','fixture','fixture',0,'fake')`,[child,tenant,source]);
 return {op,child,own};
}

async function checkCycle(options:Options={},commit=false) {
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');const ids=await insertCycle(client,options);
  if(options.immediate) await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query(commit?'COMMIT':'ROLLBACK');return ids;
 } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

it('accepts both deferred insertion orders and checks the final transaction state',async()=>{
 await checkCycle({order:'op-first',immediate:true});
 await checkCycle({order:'child-first',immediate:true});
});
const wrongQuarantine=randomUUID();
it.each([
 ['missing child',{missing:'child'}],['missing item',{missing:'item'}],['missing outbox',{missing:'outbox'}],['extra item',{extraItem:true}],
 ['wrong original ordinal',{op:{original_ordinal:0}}],['wrong quarantine',{op:{quarantine_id:wrongQuarantine,route:`/hub/v1/admin/quarantine/${wrongQuarantine}/import-recovery`}}],['wrong reserved UUID',{op:{reserved_object_id:randomUUID()}}],
 ['wrong child reverse link',{wrongReverse:true}],
 ['reused original item UUID',{sameItemUuid:true}],
 ['wrong child scope',{op:{source_id:'wrong'}}],['wrong child route',{child:{route:"'/hub/v1/ingest/crm/customers'"}}],
 ['wrong raw batch',{child:{raw_batch_id:'gen_random_uuid()'}}],['wrong batch',{child:{batch_id:'gen_random_uuid()'}}],
 ['wrong request digest',{child:{request_digest:"decode(repeat('11',32),'hex')"}}],['wrong item facts',{item:{source_version:'2'}}],
 ['wrong copied proof fence',{child:{security_barrier_fence_at_admission:'j.security_barrier_fence_at_admission+1'}}],
 ['wrong event',{item:{event_id:'gen_random_uuid()'}}],['wrong public record',{item:{public_record:"'{}'::jsonb"}}],
 ['wrong binding digest',{op:{binding_sample_digest:Buffer.alloc(32,1)}}],['wrong actor',{op:{actor_user_id:'viewer'}}],
 ['wrong binding channel',{op:{binding_channel_id:randomUUID()}}],['wrong binding credential',{op:{binding_credential_id:randomUUID()}}],
 ['malformed bindings',{op:{confirmed_bindings:JSON.stringify([{kind:'department',externalId:'team-missing',targetId:'dept1',extra:true}])}}],
 ['duplicate bindings',{op:{confirmed_bindings:JSON.stringify([{kind:'department',externalId:'team-missing',targetId:'dept1'},{kind:'department',externalId:'team-missing',targetId:'dept1'}])}}],
 ['wrong binding target',{op:{confirmed_bindings:JSON.stringify([{kind:'department',externalId:'team-missing',targetId:'other'}])}}],
 ['fake child audit',{audit:true}],
] as [string,Options][])('rejects %s without a partial transaction',async(_label,options)=>{
 const before=await context.fixture.pool.query(`SELECT (SELECT count(*) FROM control.ingestion_job)::int AS jobs,
  (SELECT count(*) FROM control.ingestion_job_item)::int AS items,(SELECT count(*) FROM control.ingestion_processing_outbox)::int AS outboxes`);
 await expect(checkCycle({...options,immediate:true})).rejects.toMatchObject({code:expect.stringMatching(/^(23503|23514)$/)});
 const result=await context.fixture.pool.query(`SELECT (SELECT count(*) FROM control.import_recovery_operation)::int AS ops,
  (SELECT count(*) FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id=$2 AND source_pk='partial')::int AS reserved,
  (SELECT count(*) FROM control.ingestion_job)::int AS jobs,(SELECT count(*) FROM control.ingestion_job_item)::int AS items,
  (SELECT count(*) FROM control.ingestion_processing_outbox)::int AS outboxes`,[tenant,source]);
 expect(result.rows[0]).toEqual({ops:0,reserved:0,...before.rows[0]});
});
it('rejects a missing outbox at COMMIT as well as immediate constraint checking',async()=>{
 await expect(checkCycle({missing:'outbox'},true)).rejects.toMatchObject({code:expect.stringMatching(/^(23503|23514)$/)});
});
it('rejects a changed order customer source tuple',async()=>{
 const binding=orderPlan.confirmedBindings[0]!;
 await expect(checkCycle({selected:orderPlan,op:{confirmed_bindings:JSON.stringify([{...binding,sourceId:'wrong-source'}])},immediate:true}))
  .rejects.toMatchObject({code:'23514',message:'invalid import recovery order binding'});
});
it.each([['uppercase','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],['malformed','not-a-uuid']])('rejects a %s order customer UUID',async(_label,targetId)=>{
 const binding=orderPlan.confirmedBindings[0]!;
 await expect(checkCycle({selected:orderPlan,op:{confirmed_bindings:JSON.stringify([{...binding,targetId}])},immediate:true}))
  .rejects.toMatchObject({code:'23514',message:'invalid import recovery order binding'});
});
it('commits an order cycle with its already established referenced customer',async()=>{
 const before=await context.fixture.pool.query<{count:number}>('SELECT count(*)::int AS count FROM hub.canonical_customer');
 const result=await checkCycle({selected:orderPlan,immediate:true},true);
 const row=await context.fixture.pool.query(`SELECT o.entity,o.source_pk,o.reserved_object_id::text,o.confirmed_bindings->0->>'targetId' AS referenced_customer,
  c.customer_id::text FROM control.import_recovery_operation o JOIN control.canonical_source_identity c
  ON (c.tenant_key,c.source_id,c.entity,c.source_pk,c.canonical_object_id)=(o.tenant_key,o.source_id,o.entity,o.source_pk,o.reserved_object_id)
  WHERE o.operation_id=$1`,[result.op]);
 expect(row.rows).toEqual([{entity:'order',source_pk:'order-schema-order-ref',reserved_object_id:result.own,referenced_customer:orderReferenceId,customer_id:null}]);
 expect((await context.fixture.pool.query('SELECT count(*)::int AS count FROM hub.canonical_customer')).rows).toEqual(before.rows);
});
it('returns null authorized facts and rejects a null-error quarantined original',async()=>{
 const client=await context.fixture.pool.connect(), original=randomUUID();
 try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO control.ingestion_job(id,${childColumns.join(',')},idempotency_key,status,received_count,applied_count,first_source_updated_at,last_source_updated_at)
   SELECT $1,${childColumns.map(c=>`j.${c}`).join(',')},$2,'RECEIVED',1,0,i.source_updated_at,i.source_updated_at
   FROM control.ingestion_job j JOIN control.ingestion_job_item i ON i.job_id=j.id AND i.ordinal=1 WHERE j.id=$3`,[original,`fake-${original}`,plan.original.jobId]);
  await client.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,${itemColumns.join(',')},status)
   SELECT $1,0,${itemColumns.map(c=>`i.${c}`).join(',')},'RECEIVED' FROM control.ingestion_job_item i WHERE i.job_id=$2 AND i.ordinal=1`,[original,plan.original.jobId]);
  await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code=NULL WHERE job_id=$1 AND ordinal=0`,[original]);
  await client.query(`INSERT INTO control.ingestion_management_admission_audit(job_id,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,request_id)
   VALUES($1,$2,$3,'owner','fixture','fixture',0,'synthetic')`,[original,tenant,source]);
  const q=(await client.query(`SELECT quarantine_id::text FROM control.ingestion_quarantine_index WHERE job_id=$1`,[original])).rows[0].quarantine_id as string;
  await client.query('SET LOCAL ROLE hub_api');
  const candidate=await client.query(`SELECT control.read_import_recovery_original($1,$2,$3,$4,$5,$6) AS value`,
   [tenant,q,context.principal.userId,context.principal.issuer,context.principal.subject,context.principal.authEpoch]);
  await client.query('RESET ROLE');
  expect(candidate.rows).toEqual([{value:{facts:null}}]);
  await insertCycle(client,{op:{quarantine_id:q,original_job_id:original,original_ordinal:0,route:`/hub/v1/admin/quarantine/${q}/import-recovery`}});
  await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({code:'23514'});
 } finally {await client.query('ROLLBACK');client.release();}
});

it('preserves ordinary pause while the original channel is active, and rejects a retired channel at child insertion',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');await client.query(`UPDATE control.source_registry SET lifecycle='PAUSED' WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
  await insertCycle(client);await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('ROLLBACK');
  await client.query('BEGIN');await client.query(`UPDATE control.source_channel SET state='retired',retired_at=clock_timestamp() WHERE id=$1`,[plan.original.proof.channelId]);
  await expect(insertCycle(client)).rejects.toMatchObject({code:'23514'});await client.query('ROLLBACK');
 } finally {await client.query('ROLLBACK');client.release();}
});
it('keeps an existing source credential linked by the source registry foreign key',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  await expect(client.query('DELETE FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2',[tenant,source])).rejects.toMatchObject({code:'23503',constraint:'source_registry_tenant_key_source_id_fkey'});
 } finally {await client.query('ROLLBACK');client.release();}
});

it('commits a complete child-first cycle for a second quarantined original',async()=>{
 const result=await checkCycle({order:'child-first',other:true},true);
 const row=await context.fixture.pool.query(`SELECT o.original_ordinal,j.import_recovery_operation_id::text AS reverse_id
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id WHERE o.operation_id=$1`,[result.op]);
 expect(row.rows).toEqual([{original_ordinal:0,reverse_id:result.op}]);
});
let accepted:{op:string;child:string;own:string};
it('commits one operation for the selected nonzero ordinal with copied proof and its own item UUID',async()=>{
 accepted=await checkCycle({order:'op-first'},true);
 const result=await context.fixture.pool.query(`SELECT o.original_ordinal,o.reserved_object_id::text,j.received_count,i.ordinal,i.source_version::text,
  i.operation_id<>orig.operation_id AS distinct_item_id,i.source_version=orig.source_version AS same_version,
  j.raw_batch_id=parent.raw_batch_id AS same_raw,j.request_digest=parent.request_digest AS same_digest,
  j.first_source_updated_at=orig.source_updated_at AND j.last_source_updated_at=orig.source_updated_at AS selected_time
  FROM control.import_recovery_operation o JOIN control.ingestion_job j ON j.id=o.child_job_id
  JOIN control.ingestion_job parent ON parent.id=o.original_job_id
  JOIN control.ingestion_job_item i ON i.job_id=j.id JOIN control.ingestion_job_item orig ON (orig.job_id,orig.ordinal)=(o.original_job_id,o.original_ordinal)
  WHERE o.operation_id=$1`,[accepted.op]);
 expect(result.rows).toEqual([{original_ordinal:1,reserved_object_id:accepted.own,received_count:1,ordinal:0,source_version:'12345678901234567890',distinct_item_id:true,
  same_version:true,same_raw:true,same_digest:true,selected_time:true}]);
});

it('hides consumed facts only after authorization and retains the private original reader',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  const internal=await client.query(`SELECT control.import_recovery_original_facts_internal($1,$2,$3) AS facts`,[tenant,context.partialId,source]);
  expect(internal.rows[0].facts.ordinal).toBe(1);
  await client.query('SET LOCAL ROLE hub_api');
  const args=[tenant,context.partialId,context.principal.userId,context.principal.issuer,context.principal.subject,context.principal.authEpoch];
  const read=await client.query(`SELECT control.read_import_recovery_original($1,$2,$3,$4,$5,$6) AS value`,args);
  const approve=await client.query(`SELECT control.read_import_recovery_for_approval($1,$2,$3,$4,$5,$6) AS value`,args);
  expect(read.rows[0].value).toEqual({facts:null});expect(approve.rows[0].value.facts).toBeNull();
  const unknown=await client.query(`SELECT control.read_import_recovery_original($1,$2,$3,$4,$5,$6) AS value`,[tenant,randomUUID(),...args.slice(2)]);
  expect(unknown.rows[0].value).toBeNull();
 } finally {await client.query('ROLLBACK');client.release();}
});
it('rejects immutable operation and discriminator changes and subsequent malformed cardinality',async()=>{
 for(const [sql,args] of [
  ['UPDATE control.import_recovery_operation SET reason=$2 WHERE operation_id=$1',[accepted.op,'changed']],
  ['DELETE FROM control.import_recovery_operation WHERE operation_id=$1',[accepted.op]],
  ["UPDATE control.ingestion_job SET import_recovery_operation_id=NULL,status='PROCESSING' WHERE id=$1",[accepted.child]],
  ['DELETE FROM control.ingestion_processing_outbox WHERE job_id=$1',[accepted.child]],
  [`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
   SELECT job_id,1,gen_random_uuid(),source_pk,source_version,operation,source_updated_at,public_record,'RECEIVED' FROM control.ingestion_job_item WHERE job_id=$1 AND ordinal=0`,[accepted.child]],
 ] as [string,unknown[]][]) {
  const client=await context.fixture.pool.connect();
  try {await client.query('BEGIN');await expect((async()=>{await client.query(sql,args);await client.query('SET CONSTRAINTS ALL IMMEDIATE');})()).rejects.toBeDefined();}
  finally {await client.query('ROLLBACK');client.release();}
 }
});
it('rejects runtime operation access and discriminator writes',async()=>{
 const grants=await context.fixture.pool.query(`SELECT
  has_column_privilege('hub_api','control.ingestion_job','import_recovery_operation_id','INSERT') AS api_insert,
  has_column_privilege('hub_api','control.ingestion_job','import_recovery_operation_id','UPDATE') AS api_update,
  has_column_privilege('hub_worker','control.ingestion_job','import_recovery_operation_id','UPDATE') AS worker_update`);
 expect(grants.rows).toEqual([{api_insert:false,api_update:false,worker_update:false}]);
 for(const role of ['hub_api','hub_worker']) {
  const client=await context.fixture.pool.connect();
  try {
   await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
   await expect(client.query('SELECT * FROM control.import_recovery_operation')).rejects.toMatchObject({code:'42501'});await client.query('ROLLBACK');
   await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
   await expect(client.query('INSERT INTO control.import_recovery_operation DEFAULT VALUES')).rejects.toMatchObject({code:'42501'});await client.query('ROLLBACK');
   await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${role}`);
   await expect(client.query('UPDATE control.ingestion_job SET import_recovery_operation_id=NULL WHERE id=$1',[accepted.child])).rejects.toMatchObject({code:'42501'});
  } finally {await client.query('ROLLBACK');client.release();}
 }
});
it('rejects a second operation for the same quarantine',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  await expect(client.query(`INSERT INTO control.import_recovery_operation
   SELECT (pg_catalog.jsonb_populate_record(NULL::control.import_recovery_operation,
    pg_catalog.to_jsonb(o)||pg_catalog.jsonb_build_object('operation_id',$2::text,'child_job_id',$3::text,'idempotency_key',$4::text))).*
   FROM control.import_recovery_operation o WHERE o.operation_id=$1`,[accepted.op,randomUUID(),randomUUID(),`other-${randomUUID()}`])).rejects.toMatchObject({code:'23505'});
 } finally {await client.query('ROLLBACK');client.release();}
});
it('does not turn later lifecycle, Owner or credential changes into structural proof checks',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  await client.query(`UPDATE control.source_registry SET lifecycle='PAUSED',data_owner_user_id='viewer',owner_revision=owner_revision+1 WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
  await client.query(`UPDATE control.source_credential SET source_epoch=source_epoch+1,credential_generation=credential_generation+1 WHERE tenant_key=$1 AND source_id=$2`,[tenant,source]);
  await client.query(`UPDATE control.auth_subject SET enabled=false WHERE tenant_key=$1 AND user_id='owner'`,[tenant]);
  await client.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[accepted.child]);
  await client.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=clock_timestamp() WHERE job_id=$1`,[accepted.child]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
 } finally {await client.query('ROLLBACK');client.release();}
});
it('does not serialize unrelated worker item state and outbox acknowledgments on the operation',async()=>{
 const a=await context.fixture.pool.connect(),b=await context.fixture.pool.connect();
 try {
  await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='1s'");
  await a.query(`UPDATE control.ingestion_job_item SET status='VALIDATING' WHERE job_id=$1 AND ordinal=0`,[accepted.child]);
  await b.query(`UPDATE control.ingestion_processing_outbox SET acknowledged_at=clock_timestamp() WHERE job_id=$1`,[accepted.child]);
 } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});
it('serializes competing structural item and outbox changes',async()=>{
 const a=await context.fixture.pool.connect(),b=await context.fixture.pool.connect();
 try {
  await a.query('BEGIN');await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='1s'");
  await a.query('DELETE FROM control.ingestion_processing_outbox WHERE job_id=$1',[accepted.child]);
  await expect(b.query(`INSERT INTO control.ingestion_job_item(job_id,ordinal,event_id,source_pk,source_version,operation,source_updated_at,public_record,status)
   SELECT job_id,1,gen_random_uuid(),source_pk,source_version,operation,source_updated_at,public_record,'RECEIVED' FROM control.ingestion_job_item WHERE job_id=$1 AND ordinal=0`,[accepted.child])).rejects.toMatchObject({code:'55P03'});
 } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
});
it('does not use a flagged child as a recursive original even if it becomes quarantined',async()=>{
 const client=await context.fixture.pool.connect();
 try {
  await client.query('BEGIN');
  await client.query(`UPDATE control.ingestion_job_item SET status='QUARANTINED',error_code='IDENTITY_MAPPING_REQUIRED' WHERE job_id=$1 AND ordinal=0`,[accepted.child]);
  const q=await client.query(`SELECT quarantine_id FROM control.ingestion_quarantine_index WHERE job_id=$1`,[accepted.child]);
  expect(q.rowCount).toBe(1);
  const facts=await client.query(`SELECT control.import_recovery_original_facts_internal($1,$2,$3) AS facts`,[tenant,q.rows[0].quarantine_id,source]);
  expect(facts.rows[0].facts).toBeNull();await client.query('SET CONSTRAINTS ALL IMMEDIATE');
 } finally {await client.query('ROLLBACK');client.release();}
});

it('retains ordinary hub_api management admission audits after the 016 runtime stage',async()=>{
 const batch=structuredClone(sample);
 batch.batch_id=randomUUID();batch.records[0]!.event_id=randomUUID();batch.records[0]!.source_pk='ordinary-after-015';
 const admitted=await context.app.inject({method:'POST',url:`/hub/v1/admin/sources/${source}/import/customer`,
  headers:{authorization:`Bearer ${context.token}`,'content-type':'application/json','idempotency-key':'ordinary-after-015'},payload:JSON.stringify(batch)});
 expect(admitted.statusCode).toBe(202);
 const result=await context.fixture.pool.query(`SELECT j.import_recovery_operation_id,a.job_id::text
  FROM control.ingestion_job j JOIN control.ingestion_management_admission_audit a ON a.job_id=j.id WHERE j.id=$1`,[admitted.json().data.job_id]);
 expect(result.rows).toEqual([{import_recovery_operation_id:null,job_id:admitted.json().data.job_id}]);
});

it('rejects an audit whose pre-insert check races an uncommitted recovery child at supported isolation levels',async()=>{
 // This fixture-only trigger pauses after the production BEFORE guard and before the audit FK.
 await context.fixture.pool.query(`CREATE FUNCTION control.zz_audit_race_test_pause() RETURNS trigger LANGUAGE plpgsql AS $test$
  BEGIN PERFORM pg_advisory_xact_lock(180015); RETURN NEW; END $test$`);
 await context.fixture.pool.query(`CREATE TRIGGER zz_audit_race_test_pause BEFORE INSERT ON control.ingestion_management_admission_audit
  FOR EACH ROW EXECUTE FUNCTION control.zz_audit_race_test_pause()`);
 try {
  const cases=[['READ COMMITTED',false],['READ COMMITTED',true],['REPEATABLE READ',false],['REPEATABLE READ',true],['SERIALIZABLE',false],['SERIALIZABLE',true]] as const;
  for(const [index,[isolation,immediate]] of cases.entries()) {
   const a=await context.fixture.pool.connect(),b=await context.fixture.pool.connect(),observer=await context.fixture.pool.connect(),worker=await context.fixture.pool.connect();
   let pending:Promise<{ok:true}|{ok:false;code:string|undefined}>|undefined;
   try {
    await a.query('BEGIN');await a.query('SELECT pg_advisory_xact_lock(180015)');
    const ids=await insertCycle(a,{selected:racePlans[index]!});
    await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    if(immediate) await b.query('SET CONSTRAINTS ALL IMMEDIATE');
    const pid=(await b.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await b.query('SET LOCAL ROLE hub_api');await b.query("SET LOCAL lock_timeout='15s'");
    pending=b.query(`INSERT INTO control.ingestion_management_admission_audit(job_id,tenant_key,source_id,actor_user_id,actor_issuer,actor_subject,actor_auth_epoch,request_id)
     VALUES($1,$2,$3,'owner','race','race',0,'audit-race')`,[ids.child,tenant,source]).then(()=>({ok:true as const}),(error:{code?:string})=>({ok:false as const,code:error.code}));
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline) {
     const state=(await observer.query<{wait_event_type:string|null;wait_event:string|null}>(`SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1`,[pid])).rows[0];
     if(state?.wait_event_type==='Lock' && state.wait_event==='advisory') {waiting=true;break;}
     await new Promise(resolve=>setTimeout(resolve,25));
    }
    expect(waiting,`${isolation}, immediate=${immediate}: audit must pass the BEFORE guard before child commit`).toBe(true);
    await a.query('COMMIT');
    const inserted=await pending;let rejected:string|undefined;
    if(inserted.ok) {
     try {await b.query('COMMIT');} catch(error) {rejected=(error as {code?:string}).code;}
    } else {rejected=inserted.code;await b.query('ROLLBACK');}
    expect(rejected,`${isolation}, immediate=${immediate}: audit must not commit`).toBeDefined();
    expect(rejected).toBe(isolation==='READ COMMITTED'?'23514':'23503');
    expect(inserted.ok).toBe(isolation==='READ COMMITTED' && !immediate);
    const count=await observer.query<{count:number}>('SELECT count(*)::int AS count FROM control.ingestion_management_admission_audit WHERE job_id=$1',[ids.child]);
    expect(count.rows[0]!.count).toBe(0);
    await worker.query('BEGIN');await worker.query('SET LOCAL ROLE hub_worker');
    await worker.query(`UPDATE control.ingestion_job SET status='PROCESSING' WHERE id=$1`,[ids.child]);await worker.query('COMMIT');
    expect((await observer.query('SELECT status FROM control.ingestion_job WHERE id=$1',[ids.child])).rows[0]).toEqual({status:'PROCESSING'});
    console.log(`audit race isolation=${isolation} constraints=${immediate?'IMMEDIATE':'DEFERRED'} rejection=${rejected} phase=${inserted.ok?'COMMIT':'INSERT'} worker=hub_worker status=PROCESSING`);
   } finally {
    await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});await worker.query('ROLLBACK').catch(()=>{});
    if(pending) await pending;a.release();b.release();observer.release();worker.release();
   }
  }
 } finally {
  await context.fixture.pool.query('DROP TRIGGER zz_audit_race_test_pause ON control.ingestion_management_admission_audit');
  await context.fixture.pool.query('DROP FUNCTION control.zz_audit_race_test_pause()');
 }
},120000);
