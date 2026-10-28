import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createOwnedPostgresSourceFactory, startSnapshotRecoveryHttpFixture, type SnapshotRecoveryHttpFixture } from './helpers/snapshot-recovery-http.js';
import { runSnapshotWorkerOnce } from '../etl-worker/snapshot-worker.js';
import { runSnapshotContinuationWorkerOnce } from '../etl-worker/snapshot-apply-worker.js';

let fixture:SnapshotRecoveryHttpFixture;
beforeAll(async()=>{fixture=await startSnapshotRecoveryHttpFixture();},90_000);
afterAll(async()=>{if(fixture) await fixture.close();});

async function frozenStageState(runId:string):Promise<string>{
  const result=await fixture.adminPool.query<{state:string}>(`
    SELECT jsonb_build_object('run_id',m.run_id,'attempt_id',m.attempt_id,'manifest_digest',encode(m.manifest_digest,'hex'),
      'manifest',m.manifest,'created_at',m.created_at,
      'validation',(SELECT to_jsonb(v) FROM control.etl_snapshot_validation v WHERE (v.tenant_key,v.source_id,v.run_id,v.attempt_id)=
        (m.tenant_key,m.source_id,m.run_id,m.attempt_id)),
      'pages',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.entity,p.relation,p.page_no),'[]'::jsonb)
        FROM control.etl_snapshot_stage_page p WHERE (p.tenant_key,p.source_id,p.run_id,p.attempt_id)=
          (m.tenant_key,m.source_id,m.run_id,m.attempt_id)),
      'records',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.entity,s.relation,s.parent_source_pk,s.source_pk),'[]'::jsonb)
        FROM control.etl_snapshot_stage_record s WHERE (s.tenant_key,s.source_id,s.run_id,s.attempt_id)=
          (m.tenant_key,m.source_id,m.run_id,m.attempt_id)),
      'ranges',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.entity,r.relation,r.parent_source_pk,r.source_pk),'[]'::jsonb)
        FROM control.etl_snapshot_apply_range r WHERE (r.tenant_key,r.source_id,r.run_id,r.attempt_id)=
          (m.tenant_key,m.source_id,m.run_id,m.attempt_id)),
      'outcomes',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.entity,o.relation,o.parent_source_pk,o.source_pk),'[]'::jsonb)
        FROM control.etl_snapshot_apply_outcome o WHERE (o.tenant_key,o.source_id,o.run_id,o.attempt_id)=
          (m.tenant_key,m.source_id,m.run_id,m.attempt_id)))::text AS state
    FROM control.etl_snapshot_manifest m WHERE m.tenant_key=$1 AND m.source_id='pg_recovery' AND m.run_id=$2::uuid`,
    [fixture.owner.tenantId,runId]);
  return result.rows[0]?.state??'';
}

async function killNodeAtAggregateBoundary(hostPort:number,runId:string,phase:'before'|'after'):Promise<number>{
  const hookName=phase==='before'?'beforeAggregateCommit':'afterAggregateCommit';
  const script=`import pg from 'pg';
    import {runSnapshotContinuationWorkerOnce} from './dist/etl-worker/snapshot-apply-worker.js';
    const pool=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:${hostPort}/postgres',options:'-c role=hub_worker',max:2});
    try { await runSnapshotContinuationWorkerOnce(pool,20,10,{${hookName}:async item=>{
      if(item.run_id==='${runId}'&&item.source_pk==='C-REC-2') { process.stdout.write('COMMIT_HOOK '+process.pid+' '+item.run_id+' '+item.source_pk+'\\n');
        await new Promise(()=>{}); }
    }}); } finally { await pool.end(); }`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
  const marker=await new Promise<string>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`NODE_CHILD_COMMIT_TIMEOUT:${stdout}:${stderr}`)),30_000);
    const check=()=>{const line=stdout.split(/\r?\n/).find(value=>value.startsWith('COMMIT_HOOK '));if(line){clearTimeout(timeout);resolve(line);}};
    child.stdout.on('data',check); child.once('error',error=>{clearTimeout(timeout);reject(error);}); child.once('exit',(code,signal)=>{
      if(!stdout.includes('COMMIT_HOOK ')){clearTimeout(timeout);reject(new Error(`NODE_CHILD_EXITED_BEFORE_COMMIT:${code}:${signal}:${stderr}`));}
    });
  });
  const pid=Number(marker.split(' ')[1]);
  if(!Number.isInteger(pid)||pid<1||!marker.includes(runId)) throw new Error('NODE_CHILD_COMMIT_MARKER_INVALID');
  child.kill('SIGKILL');
  const exitCode=await new Promise<number>(resolve=>child.once('close',(code,signal)=>resolve(code??(signal==='SIGKILL'?-1:-2))));
  if(exitCode!==-1) throw new Error(`NODE_CHILD_KILL_NOT_CONFIRMED:${pid}:${exitCode}`);
  process.stdout.write(`NODE_CHILD_CRASH pid=${pid} phase=${phase}-aggregate-commit run_id=${runId} source_pk=C-REC-2 signal=SIGKILL\n`);
  return pid;
}

describe('API-022 immutable snapshot recovery',()=>{
  it('accepts a strict retry for a terminal incomplete run over authenticated HTTP',async()=>{
    const original=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(original.statusCode).toBe(200);
    expect(original.json().data.failure_version).toBe('1');
    const send=(reason='recover controlled incomplete extraction',failedVersion='1',key='snapshot-recovery-red')=>fixture.app.inject({
      method:'POST',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':key},
      payload:{failed_version:failedVersion,reason}});
    expect((await send('overflow bigint','9223372036854775808','snapshot-recovery-overflow')).statusCode).toBe(400);
    expect((await send('oversized bigint','9'.repeat(100),'snapshot-recovery-long-version')).statusCode).toBe(400);
    expect((await send('😀'.repeat(1001),'1','snapshot-recovery-long-reason')).statusCode).toBe(400);
    expect((await send('😀'.repeat(1000),'9223372036854775807','snapshot-recovery-max-reason')).statusCode).toBe(409);
    const unknownField=await fixture.app.inject({method:'POST',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':'snapshot-recovery-unknown'},
      payload:{failed_version:'1',reason:'unknown fields are rejected',tenant_key:fixture.owner.tenantId}});
    expect(unknownField.statusCode).toBe(400);
    const concurrent=await Promise.all([
      send('concurrent source snapshot recovery A','1','snapshot-recovery-race-a'),
      send('concurrent source snapshot recovery B','1','snapshot-recovery-race-b'),
    ]);
    expect(concurrent.map(result=>result.statusCode).sort()).toEqual([202,409]);
    const winnerIndex=concurrent.findIndex(result=>result.statusCode===202);
    const winningKey=winnerIndex===0?'snapshot-recovery-race-a':'snapshot-recovery-race-b';
    const winningReason=winnerIndex===0?'concurrent source snapshot recovery A':'concurrent source snapshot recovery B';
    const response=concurrent[winnerIndex];
    expect(response.statusCode,response.body).toBe(202);
    const accepted=response.json().data;
    expect(accepted).toMatchObject({recovery_mode:'FRESH_SCAN',status:'QUEUED',replayed:false});
    expect((await send('competing recovery key while child is active','1','snapshot-recovery-competing')).statusCode).toBe(409);
    const competingNormal=await fixture.app.inject({method:'POST',url:'/hub/v1/admin/sources/pg_recovery/etl-runs',
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':'snapshot-recovery-normal-busy'},
      payload:{approved_config_revision:'1',run_mode:'FULL_SNAPSHOT'}});
    expect(competingNormal.statusCode).toBe(409);
    const replay=await send(winningReason,'1',winningKey);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data).toMatchObject({...response.json().data,replayed:true});
    const conflict=await send('different normalized reason','1',winningKey);
    expect(conflict.statusCode).toBe(409);
    const stale=await send('retry old failure version','2','snapshot-recovery-stale');
    expect(stale.statusCode).toBe(409);
    const malformed=await fixture.app.inject({method:'POST',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':'snapshot-recovery-invalid'},
      payload:{failed_version:1,reason:'number is not accepted'}});
    expect(malformed.statusCode).toBe(400);
    await fixture.adminPool.query(`CREATE TABLE public.customers(customer_id text PRIMARY KEY,name text NOT NULL,owner_id text NOT NULL,
      department_id text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL,source_version bigint NOT NULL)`);
    await fixture.adminPool.query(`INSERT INTO public.customers VALUES('C-REC-1','Recovery Customer','owner-ext','department-ext','ACTIVE',
      '2026-10-28 12:00:00+00',1)`);
    let sourceConnections=0,sourceRows=0;
    const worked=await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:
        createOwnedPostgresSourceFactory(fixture.adminPool,()=>sourceConnections++,count=>sourceRows+=count)});
    expect(worked).toBe(1);
    expect(sourceConnections).toBe(1);
    expect(sourceRows).toBe(1);
    const child=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${accepted.run_id}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(child.statusCode).toBe(200);
    expect(child.json().data).toMatchObject({run_id:accepted.run_id,status:'VALIDATING',extracted_count:1});
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(1);
    const completed=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${accepted.run_id}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(completed.statusCode).toBe(200);
    expect(completed.json().data).toMatchObject({run_id:accepted.run_id,status:'COMPLETE',extracted_count:1});
    const canonical=await fixture.adminPool.query<{customer_count:string;outcome_count:string;observation_count:string;delete_count:string}>(`
      SELECT (SELECT count(*) FROM hub.canonical_customer WHERE tenant_id=$1)::text AS customer_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS outcome_count,
        (SELECT count(*) FROM control.etl_snapshot_observation WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS observation_count,
        (SELECT count(*) FROM control.etl_snapshot_delete_run WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS delete_count`,
      [fixture.owner.tenantId,accepted.run_id]);
    expect(canonical.rows[0]).toEqual({customer_count:'1',outcome_count:'1',observation_count:'1',delete_count:'1'});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_delete_run SET status='SKIPPED'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,accepted.run_id]);
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_schedule SET enabled=false,schedule_revision=schedule_revision+1
      WHERE tenant_key=$1 AND source_id='pg_recovery'`,[fixture.owner.tenantId]);

    await fixture.adminPool.query(`UPDATE public.customers SET name='Recovery Customer One',updated_at='2026-10-28 12:01:00+00'
      WHERE customer_id='C-REC-1'`);
    await fixture.adminPool.query(`INSERT INTO public.customers VALUES('C-REC-2','Recovery Customer Two','owner-ext','department-ext','ACTIVE',
      '2026-10-28 12:02:00+00',1)`);
    const partialOriginalId=await fixture.createInterruptedRun();
    const sendPartial=(runId=partialOriginalId,reason='recover partial C failure',failedVersion='1',key='snapshot-recovery-partial')=>fixture.app.inject({
      method:'POST',url:`/hub/v1/admin/etl-runs/${runId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':key},
      payload:{failed_version:failedVersion,reason}});
    const partialAccepted=await sendPartial();
    expect(partialAccepted.statusCode,partialAccepted.body).toBe(202);
    expect(partialAccepted.json().data.recovery_mode).toBe('FRESH_SCAN');
    let partialSourceConnections=0,partialSourceRows=0;
    const partialWorked=await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:
        createOwnedPostgresSourceFactory(fixture.adminPool,()=>partialSourceConnections++,count=>partialSourceRows+=count)});
    expect(partialWorked).toBe(1);
    expect(partialSourceConnections).toBe(1);
    expect(partialSourceRows).toBe(2);
    let committedRun='';
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool,20,60,{afterAggregateCommit:async item=>{
      if(item.run_id===partialAccepted.json().data.run_id&&!committedRun){committedRun=item.run_id;throw new Error('controlled partial C crash');}
    }})).toBe(1);
    expect(committedRun).toBe(partialAccepted.json().data.run_id);
    const wrongParentRetry=await sendPartial(partialOriginalId,'retry parent after child was already reserved','1','snapshot-recovery-wrong-parent');
    expect(wrongParentRetry.statusCode).toBe(409);
    const partialStatus=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${committedRun}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(partialStatus.json().data).toMatchObject({status:'FAILED',failure_version:'1'});
    const sealedSource=await fixture.adminPool.query<{sequence_value:string;created_at:string;range_count:string;d_count:string}>(`
      SELECT o.sequence_value::text,o.created_at::text,
        (SELECT count(*) FROM control.etl_snapshot_apply_range r WHERE r.tenant_key=o.tenant_key AND r.source_id=o.source_id AND r.run_id=o.run_id)::text AS range_count,
        (SELECT count(*) FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=o.tenant_key AND d.source_id=o.source_id)::text AS d_count
      FROM control.etl_snapshot_observation o WHERE o.tenant_key=$1 AND o.source_id='pg_recovery' AND o.run_id=$2::uuid`,
      [fixture.owner.tenantId,committedRun]);
    expect(sealedSource.rows).toHaveLength(1);
    expect(sealedSource.rows[0].range_count).toBe('1');
    expect(sealedSource.rows[0].d_count).toBe('1');
    const frozenBefore=await frozenStageState(committedRun);
    expect(frozenBefore).not.toBe('');
    const changedCanonical=await fixture.adminPool.query<{customer_name:string}>(`
      SELECT c.customer_name FROM control.canonical_source_identity i JOIN hub.canonical_customer c
        ON (c.tenant_id,c.id)=(i.tenant_key,i.canonical_object_id)
      WHERE i.tenant_key=$1 AND i.source_id='pg_recovery' AND i.entity='customer' AND i.source_pk='C-REC-1'`,
      [fixture.owner.tenantId]);
    expect(changedCanonical.rows[0]?.customer_name).toBe('Recovery Customer One');
    const originalRange=await fixture.adminPool.query<{outcome_id:string;status:string;aggregate_digest:string;proof_scope_digest:string}>(`
      SELECT r.outcome_id,o.status,encode(r.aggregate_digest,'hex') AS aggregate_digest,encode(r.proof_scope_digest,'hex') AS proof_scope_digest
      FROM control.etl_snapshot_apply_range r JOIN control.etl_snapshot_apply_outcome o ON o.outcome_id=r.outcome_id
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery' AND r.run_id=$2::uuid`,[fixture.owner.tenantId,committedRun]);
    expect(originalRange.rows).toHaveLength(1);
    expect(originalRange.rows[0].status).toBe('APPLIED');
    const outboxBefore=await fixture.adminPool.query<{count:string;max_id:string;prefix:string}>(`SELECT count(*)::text AS count,coalesce(max(id),0)::text AS max_id,
      coalesce(jsonb_agg(jsonb_build_object('id',id,'entity',entity,'canonical_object_id',canonical_object_id,'hub_revision',hub_revision,
        'operation',operation,'projection_digest',encode(projection_digest,'hex'),'source_content_digest',encode(source_content_digest,'hex'),
        'apply_xid',apply_xid::text) ORDER BY id),'[]'::jsonb)::text AS prefix
      FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_recovery'`,[fixture.owner.tenantId]);
    expect(await fixture.pauseSource('1')).toMatchObject({lifecycle:'PAUSED',revision:'1'});
    expect(await fixture.editSourceConfig('1')).toMatchObject({lifecycle:'DRAFT',revision:'2'});
    expect(await fixture.pauseSource('2')).toMatchObject({lifecycle:'PAUSED',revision:'2'});
    const driftedSource=await fixture.adminPool.query<{lifecycle:string;current_config_revision:string;credential_revision:string;enabled:boolean}>(`
      SELECT r.lifecycle,r.current_config_revision::text AS current_config_revision,c.revision::text AS credential_revision,c.enabled
      FROM control.source_registry r JOIN control.source_credential c ON c.tenant_key=r.tenant_key AND c.source_id=r.source_id
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery'`,[fixture.owner.tenantId]);
    expect(driftedSource.rows[0]).toMatchObject({lifecycle:'PAUSED',current_config_revision:'2',credential_revision:'2',enabled:true});
    expect((await fixture.adminPool.query<{enabled:boolean}>(`SELECT enabled FROM control.etl_snapshot_schedule
      WHERE tenant_key=$1 AND source_id='pg_recovery'`,[fixture.owner.tenantId])).rows[0].enabled).toBe(false);
    const sealedAccepted=await sendPartial(committedRun,'resume immutable sealed stage','1','snapshot-recovery-sealed');
    expect(sealedAccepted.statusCode,sealedAccepted.body).toBe(202);
    expect(sealedAccepted.json().data).toMatchObject({recovery_mode:'SEALED_STAGE',status:'QUEUED'});
    let sealedSourceConnections=0;
    expect(await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:{
        async connect(){sealedSourceConnections+=1;throw new Error('SEALED_STAGE must not open source IO');},
      }})).toBe(1);
    expect(sealedSourceConnections).toBe(0);
    const sealedRunId=sealedAccepted.json().data.run_id as string;
    const sealedAttemptId=sealedAccepted.json().data.attempt_id as string;
    const liveClaimResult=await fixture.workerPool.query<{claim_token:string}>(
      'SELECT claim_token::text FROM control.claim_etl_snapshot_continuation($1,$2,10)',
      [fixture.owner.tenantId,'pg_recovery']);
    expect(liveClaimResult.rows).toHaveLength(1);
    const liveClaimToken=liveClaimResult.rows[0].claim_token;
    const oldClaimToken='00000000-0000-4000-8000-000000000000';
    for(const token of [null,oldClaimToken]) {
      const rejected=await fixture.workerPool.query<{metadata:unknown;proof:unknown;heartbeat:boolean}>(`
        SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
          control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof,
          control.heartbeat_etl_snapshot_continuation($1,$2,$3::uuid,$4::uuid,$5::uuid,10) AS heartbeat`,
        [fixture.owner.tenantId,'pg_recovery',sealedRunId,sealedAttemptId,token]);
      expect(rejected.rows[0]).toEqual({metadata:null,proof:null,heartbeat:false});
    }
    const validClaim=await fixture.workerPool.query<{metadata:Record<string,unknown>;proof:Record<string,unknown>}>(`
      SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
        control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof`,
      [fixture.owner.tenantId,'pg_recovery',sealedRunId,sealedAttemptId,liveClaimToken]);
    expect(validClaim.rows[0].metadata).toMatchObject({recovery_mode:'SEALED_STAGE',original_run_id:committedRun});
    expect(validClaim.rows[0].proof).toMatchObject({run_id:sealedRunId,status:'VALIDATING'});
    const unrelatedScope=await fixture.workerPool.query<{proof:unknown}>(
      'SELECT control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof',
      [fixture.owner.tenantId,'pg_recovery',committedRun,sealedAttemptId,liveClaimToken]);
    expect(unrelatedScope.rows[0].proof).toBeNull();
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedRunId]);
    const expiredClaim=await fixture.workerPool.query<{metadata:unknown;proof:unknown;heartbeat:boolean}>(`
      SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
        control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof,
        control.heartbeat_etl_snapshot_continuation($1,$2,$3::uuid,$4::uuid,$5::uuid,10) AS heartbeat`,
      [fixture.owner.tenantId,'pg_recovery',sealedRunId,sealedAttemptId,liveClaimToken]);
    expect(expiredClaim.rows[0]).toEqual({metadata:null,proof:null,heartbeat:false});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedRunId]);
    const beforeCrashPid=await killNodeAtAggregateBoundary(fixture.hostPort,sealedAccepted.json().data.run_id,'before');
    expect(beforeCrashPid).toBeGreaterThan(0);
    const beforeCommitEffect=await fixture.adminPool.query<{identity_count:string;outcome_count:string}>(`
      SELECT (SELECT count(*) FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id='pg_recovery'
        AND entity='customer' AND source_pk='C-REC-2')::text AS identity_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-2')::text AS outcome_count`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(beforeCommitEffect.rows[0]).toEqual({identity_count:'0',outcome_count:'0'});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second',
      next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(0);
    await new Promise(resolve=>setTimeout(resolve,5_100));
    const crashedChildPid=await killNodeAtAggregateBoundary(fixture.hostPort,sealedAccepted.json().data.run_id,'after');
    expect(crashedChildPid).toBeGreaterThan(0);
    const afterCommitEffect=await fixture.adminPool.query<{identity_count:string;outcome_count:string}>(`
      SELECT (SELECT count(*) FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id='pg_recovery'
        AND entity='customer' AND source_pk='C-REC-2')::text AS identity_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-2')::text AS outcome_count`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(afterCommitEffect.rows[0]).toEqual({identity_count:'1',outcome_count:'1'});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second',
      next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(0);
    const releasedRetry=await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid AND claim_token IS NULL AND lease_until IS NULL`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(releasedRetry.rowCount).toBe(1);
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(1);
    const sealedComplete=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${sealedAccepted.json().data.run_id}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(sealedComplete.json().data).toMatchObject({status:'COMPLETE',extracted_count:2});
    const postRecoverySource=await fixture.adminPool.query<{lifecycle:string;current_config_revision:string;credential_revision:string;enabled:boolean}>(`
      SELECT r.lifecycle,r.current_config_revision::text AS current_config_revision,c.revision::text AS credential_revision,c.enabled
      FROM control.source_registry r JOIN control.source_credential c ON c.tenant_key=r.tenant_key AND c.source_id=r.source_id
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery'`,[fixture.owner.tenantId]);
    expect(postRecoverySource.rows[0]).toMatchObject({lifecycle:'PAUSED',current_config_revision:'2',credential_revision:'2',enabled:true});
    const sealedOutcome=await fixture.adminPool.query<{reused_count:string;applied_count:string;reused_source_status:string;reused_outcome_id:string;d_count:string;allocation_count:string;sequence_value:string;child_observation_count:string}>(`
      SELECT (SELECT count(*) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
        AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL)::text AS reused_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.status='APPLIED')::text AS applied_count,
        (SELECT status FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL) AS reused_source_status,
        (SELECT reused_original_outcome_id::text FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL) AS reused_outcome_id,
        (SELECT count(*) FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=$1 AND d.source_id='pg_recovery')::text AS d_count,
        (SELECT count(*) FROM control.etl_snapshot_observation_allocation a WHERE a.tenant_key=$1 AND a.source_id='pg_recovery')::text AS allocation_count,
        (SELECT sequence_value::text FROM control.etl_snapshot_observation o WHERE o.tenant_key=$1 AND o.source_id='pg_recovery' AND o.run_id=$3::uuid) AS sequence_value,
        (SELECT count(*) FROM control.etl_snapshot_observation o WHERE o.tenant_key=$1 AND o.source_id='pg_recovery' AND o.run_id=$2::uuid)::text AS child_observation_count`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id,committedRun]);
    expect(sealedOutcome.rows[0]).toMatchObject({reused_count:'1',applied_count:'1',reused_source_status:'DUPLICATE',d_count:'1',allocation_count:'2',
      sequence_value:sealedSource.rows[0].sequence_value,child_observation_count:'0'});
    expect(sealedOutcome.rows[0].reused_outcome_id).toBe(originalRange.rows[0].outcome_id);
    const originalObservation=await fixture.adminPool.query<{created_at:string}>(`SELECT created_at::text FROM control.etl_snapshot_observation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,committedRun]);
    expect(originalObservation.rows[0].created_at).toBe(sealedSource.rows[0].created_at);
    expect(await frozenStageState(committedRun)).toBe(frozenBefore);
    const outboxAfter=await fixture.adminPool.query<{count:string;max_id:string;prefix:string}>(`SELECT
      (SELECT count(*) FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_recovery')::text AS count,
      coalesce((SELECT max(id) FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_recovery'),0)::text AS max_id,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'entity',entity,'canonical_object_id',canonical_object_id,'hub_revision',hub_revision,
        'operation',operation,'projection_digest',encode(projection_digest,'hex'),'source_content_digest',encode(source_content_digest,'hex'),
        'apply_xid',apply_xid::text) ORDER BY id) FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_recovery' AND id<=$2),'[]'::jsonb)::text AS prefix`,
      [fixture.owner.tenantId,outboxBefore.rows[0].max_id]);
    expect(Number(outboxAfter.rows[0].count)).toBe(Number(outboxBefore.rows[0].count)+1);
    expect(Number(outboxAfter.rows[0].max_id)).toBeGreaterThan(Number(outboxBefore.rows[0].max_id));
    expect(outboxAfter.rows[0].prefix).toBe(outboxBefore.rows[0].prefix);
    const sealedReplayAfterDrift=await sendPartial(committedRun,'resume immutable sealed stage','1','snapshot-recovery-sealed');
    expect(sealedReplayAfterDrift.statusCode,sealedReplayAfterDrift.body).toBe(202);
    expect(sealedReplayAfterDrift.json().data).toMatchObject({...sealedAccepted.json().data,replayed:true});
    const paused=await fixture.adminPool.query<{enabled:boolean}>(`SELECT enabled FROM control.etl_snapshot_schedule
      WHERE tenant_key=$1 AND source_id='pg_recovery'`,[fixture.owner.tenantId]);
    expect(paused.rows[0].enabled).toBe(false);
    let nullClaimRejected=false;
    try {
      const nullClaim=await fixture.workerPool.query<{proof:unknown}>(`SELECT control.read_etl_snapshot_recovery_manifest(
        $1,$2,$3::uuid,$4::uuid,NULL::uuid) AS proof`,[fixture.owner.tenantId,'pg_recovery',sealedAccepted.json().data.run_id,
        sealedAccepted.json().data.attempt_id]);
      nullClaimRejected=nullClaim.rows[0]?.proof===null;
    } catch { nullClaimRejected=true; }
    expect(nullClaimRejected).toBe(true);
    const channel=await fixture.adminPool.query<{id:string}>(`SELECT id::text FROM control.source_channel
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND entity='customer' AND state='active'`,[fixture.owner.tenantId]);
    await fixture.adminPool.query(`INSERT INTO control.source_security_barrier(tenant_key,source_id,channel_id,barrier_type,reason_code,created_by)
      VALUES($1,'pg_recovery',$2::uuid,'CHANNEL_RETIRED','TEST_CHANNEL_RETIRED','acceptance-test')`,[fixture.owner.tenantId,channel.rows[0].id]);
    const retiredReplay=await sendPartial(committedRun,'resume immutable sealed stage','1','snapshot-recovery-sealed');
    expect(retiredReplay.statusCode).toBe(409);
  },30_000);
  it('runs HTTP as hub_api and keeps recovery proof loaders worker-only',async()=>{
    const api=await fixture.pool.query<{role:string;admission:boolean;proof:boolean}>(`SELECT current_user AS role,
      has_function_privilege(current_user,'control.create_etl_snapshot_manual_recovery(text,uuid,bigint,text,bytea,text,text,text,text,bigint,text[],uuid)','EXECUTE') AS admission,
      has_function_privilege(current_user,'control.read_etl_snapshot_recovery_manifest(text,text,uuid,uuid,uuid)','EXECUTE') AS proof`);
    expect(api.rows[0]).toEqual({role:'hub_api',admission:true,proof:false});
    const worker=await fixture.workerPool.query<{role:string;admission:boolean;proof:boolean}>(`SELECT current_user AS role,
      has_function_privilege(current_user,'control.create_etl_snapshot_manual_recovery(text,uuid,bigint,text,bytea,text,text,text,text,bigint,text[],uuid)','EXECUTE') AS admission,
      has_function_privilege(current_user,'control.read_etl_snapshot_recovery_manifest(text,text,uuid,uuid,uuid)','EXECUTE') AS proof`);
    expect(worker.rows[0]).toEqual({role:'hub_worker',admission:false,proof:true});
  });
  it('does not replay an accepted operation after caller disablement',async()=>{
    const before=await fixture.adminPool.query<{count:string}>(`SELECT count(*)::text AS count FROM control.etl_snapshot_recovery_operation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND route='API-022'`,[fixture.owner.tenantId]);
    await fixture.adminPool.query(`UPDATE control.auth_subject SET enabled=false WHERE tenant_key=$1 AND user_id=$2`,
      [fixture.owner.tenantId,fixture.owner.userId]);
    const denied=await fixture.app.inject({method:'POST',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':'snapshot-recovery-red'},
      payload:{failed_version:'1',reason:'recover controlled incomplete extraction'}});
    expect(denied.statusCode).toBe(401);
    expect(denied.json().data).toBeUndefined();
    const after=await fixture.adminPool.query<{count:string}>(`SELECT count(*)::text AS count FROM control.etl_snapshot_recovery_operation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND route='API-022'`,[fixture.owner.tenantId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
