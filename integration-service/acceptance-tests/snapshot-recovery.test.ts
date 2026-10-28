import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { SnapshotSourceError } from '../etl-worker/postgres-snapshot-connector.js';
import { createOwnedPostgresSourceFactory, startSnapshotRecoveryHttpFixture, type SnapshotRecoveryHttpFixture } from './helpers/snapshot-recovery-http.js';
import { runSnapshotWorkerOnce } from '../etl-worker/snapshot-worker.js';
import { runSnapshotContinuationWorkerOnce } from '../etl-worker/snapshot-apply-worker.js';

let fixture:SnapshotRecoveryHttpFixture;
let acceptedRecovery:Readonly<{runId:string;key:string;reason:string;failedVersion:string}>|undefined;
beforeAll(async()=>{fixture=await startSnapshotRecoveryHttpFixture();},90_000);
afterAll(async()=>{if(fixture) await fixture.close();});

async function frozenStageState(runId:string,sourceId='pg_recovery'):Promise<string>{
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
    FROM control.etl_snapshot_manifest m WHERE m.tenant_key=$1 AND m.source_id=$2 AND m.run_id=$3::uuid`,
    [fixture.owner.tenantId,sourceId,runId]);
  return result.rows[0]?.state??'';
}

async function killNodeAtAggregateBoundary(hostPort:number,runId:string,phase:'before'|'after'):Promise<number>{
  const hookName=phase==='before'?'beforeAggregateCommit':'afterAggregateCommit';
  const buildCaptureId=process.env.M1_FIX1_BUILD_CAPTURE_ID??'UNBOUND_BUILD_CAPTURE';
  const modulePath=resolve(process.cwd(),'dist/etl-worker/snapshot-apply-worker.js');
  const expectedBytes=readFileSync(modulePath);
  const expectedHash=createHash('sha256').update(expectedBytes).digest('hex');
  const script=`import pg from 'pg';
    import {createHash} from 'node:crypto'; import {readFileSync} from 'node:fs';
    const moduleUrl=new URL('./dist/etl-worker/snapshot-apply-worker.js',import.meta.url);
    const moduleBytes=readFileSync(moduleUrl); const moduleSha256=createHash('sha256').update(moduleBytes).digest('hex');
    process.stdout.write('NODE_MODULE_LOAD '+JSON.stringify({pid:process.pid,run_id:'${runId}',idempotency_key:'snapshot-recovery-sealed',
      build_capture_id:'${buildCaptureId}',module_path:moduleUrl.pathname,module_sha256:moduleSha256,module_size:moduleBytes.length})+'\\n');
    const {runSnapshotContinuationWorkerOnce}=await import(moduleUrl.href);
    const pool=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:${hostPort}/postgres',options:'-c role=hub_worker',max:2});
    try { await runSnapshotContinuationWorkerOnce(pool,20,10,{${hookName}:async item=>{
      if(item.run_id==='${runId}'&&item.source_pk==='C-REC-4') { process.stdout.write('COMMIT_HOOK '+process.pid+' ${phase} '+item.run_id+' '+item.attempt_id+' '+item.source_pk+'\\n');
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
  const markerFields=marker.split(' ');
  const pid=Number(markerFields[1]);
  if(!Number.isInteger(pid)||pid<1||markerFields[2]!==phase||markerFields[3]!==runId||!markerFields[4]||markerFields[5]!=='C-REC-4')
    throw new Error('NODE_CHILD_COMMIT_MARKER_INVALID');
  const moduleMarker=stdout.split(/\r?\n/).find(value=>value.startsWith('NODE_MODULE_LOAD '));
  if(!moduleMarker) throw new Error('NODE_CHILD_MODULE_LOAD_MARKER_MISSING');
  const loaded=JSON.parse(moduleMarker.slice('NODE_MODULE_LOAD '.length)) as {pid:number;run_id:string;idempotency_key:string;
    build_capture_id:string;module_path:string;module_sha256:string;module_size:number};
  if(loaded.pid!==pid||loaded.run_id!==runId||loaded.idempotency_key!=='snapshot-recovery-sealed'||loaded.module_sha256!==expectedHash||
      loaded.module_size!==expectedBytes.length||loaded.build_capture_id!==buildCaptureId) throw new Error('NODE_CHILD_MODULE_LOAD_BINDING_INVALID');
  process.stdout.write(`NODE_MODULE_LOAD_RECORD ${JSON.stringify(loaded)}\\n`);
  child.kill('SIGKILL');
  const exitCode=await new Promise<number>(resolve=>child.once('close',(code,signal)=>resolve(code??(signal==='SIGKILL'?-1:-2))));
  if(exitCode!==-1) throw new Error(`NODE_CHILD_KILL_NOT_CONFIRMED:${pid}:${exitCode}`);
  process.stdout.write(`NODE_CHILD_CRASH pid=${pid} phase=${phase}-aggregate-commit run_id=${runId} attempt_id=${markerFields[4]} source_pk=C-REC-4 signal=SIGKILL\n`);
  return pid;
}

function failSealedManifestOnce(pool:Pool,runId:string):Pool {
  let failed=false;
  return new Proxy(pool,{get(target,key,receiver){
    if(key!=='connect') { const value=Reflect.get(target,key,receiver); return typeof value==='function'?value.bind(target):value; }
    return async()=>{
      const client=await target.connect();
      return new Proxy(client,{get(inner,member,clientReceiver){
        if(member!=='query') { const value=Reflect.get(inner,member,clientReceiver); return typeof value==='function'?value.bind(inner):value; }
        return async(...args:unknown[])=>{
          const sql=args[0]; const values=args[1];
          if(!failed&&typeof sql==='string'&&sql.includes('complete_etl_snapshot_manifest')&&Array.isArray(values)&&values[2]===runId) {
            failed=true;
            throw new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE');
          }
          return (inner.query as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
        };
      }}) as typeof client;
    };
  }}) as Pool;
}

function slowSealedWritePool(pool:Pool,adminPool:Pool,tenantId:string,runId:string,delayMs:number,
  observations:Array<{beforeExpiry:string;beforeObserved:string;afterExpiry:string;afterObserved:string}>):Pool {
  return new Proxy(pool,{get(target,key,receiver){
    if(key!=='connect') { const value=Reflect.get(target,key,receiver); return typeof value==='function'?value.bind(target):value; }
    return async()=>{
      const client=await target.connect();
      let sealedPageCommitted=false;
      return new Proxy(client,{get(inner,member,clientReceiver){
        if(member!=='query') { const value=Reflect.get(inner,member,clientReceiver); return typeof value==='function'?value.bind(inner):value; }
        return async(...args:unknown[])=>{
          const sql=args[0]; const values=args[1];
          const result=await (inner.query as (...queryArgs:unknown[])=>Promise<unknown>)(...args);
          if(typeof sql==='string'&&sql.includes('write_etl_snapshot_page')&&Array.isArray(values)&&values[2]===runId) sealedPageCommitted=true;
          if(sql==='COMMIT'&&sealedPageCommitted) {
            sealedPageCommitted=false;
            const before=await adminPool.query<{expiry:string;observed:string}>(`SELECT snapshot_lease_expires_at::text AS expiry,
              clock_timestamp()::text AS observed FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[tenantId,runId]);
            await new Promise(resolve=>setTimeout(resolve,delayMs));
            const after=await adminPool.query<{expiry:string;observed:string}>(`SELECT snapshot_lease_expires_at::text AS expiry,
              clock_timestamp()::text AS observed FROM control.etl_run WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[tenantId,runId]);
            observations.push({beforeExpiry:before.rows[0].expiry,beforeObserved:before.rows[0].observed,
              afterExpiry:after.rows[0].expiry,afterObserved:after.rows[0].observed});
          }
          return result;
        };
      }}) as typeof client;
    };
  }}) as Pool;
}

describe('API-022 immutable snapshot recovery',()=>{
  it('accepts a strict retry for a terminal incomplete run over authenticated HTTP',async()=>{
    await fixture.adminPool.query(`CREATE TABLE public.customers(customer_id text PRIMARY KEY,name text NOT NULL,owner_id text NOT NULL,
      department_id text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL,source_version bigint NOT NULL)`);
    await fixture.adminPool.query(`INSERT INTO public.customers VALUES('C-REC-1','Recovery Customer','owner-ext','department-ext','ACTIVE',
      '2026-10-28 12:00:00+00',1)`);
    for(let start=1;start<=4;start++) {
      let interruptedFetches=0;
      expect(await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
        egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},pageSize:1,sourceConnectionFactory:
          createOwnedPostgresSourceFactory(fixture.adminPool,()=>undefined,()=>{if(++interruptedFetches===2) throw new Error('controlled source interruption after persisted page');})})).toBe(1);
      await fixture.adminPool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()
        WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,fixture.originalRunId]);
    }
    const interruptedOriginal=await fixture.adminPool.query<{status:string;attempt_status:string;page_count:string;manifest_count:string;record_count:string}>(`
      SELECT r.status,a.status AS attempt_status,
        (SELECT count(*) FROM control.etl_snapshot_stage_page p WHERE p.tenant_key=r.tenant_key AND p.source_id=r.source_id AND p.run_id=r.run_id)::text AS page_count,
        (SELECT count(*) FROM control.etl_snapshot_manifest m WHERE m.tenant_key=r.tenant_key AND m.source_id=r.source_id AND m.run_id=r.run_id)::text AS manifest_count,
        (SELECT count(*) FROM control.etl_snapshot_stage_record s WHERE s.tenant_key=r.tenant_key AND s.source_id=r.source_id AND s.run_id=r.run_id)::text AS record_count
      FROM control.etl_run r JOIN control.etl_run_attempt a USING(tenant_key,source_id,run_id)
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery' AND r.run_id=$2::uuid ORDER BY a.ordinal DESC LIMIT 1`,
      [fixture.owner.tenantId,fixture.originalRunId]);
    expect(interruptedOriginal.rows[0]).toEqual({status:'FAILED',attempt_status:'FAILED',page_count:'4',manifest_count:'0',record_count:'4'});
    const frozenOriginalStage=(await fixture.adminPool.query<{state:string}>(`SELECT jsonb_build_object(
      'attempts',(SELECT jsonb_agg(jsonb_build_object('attempt_id',attempt_id,'ordinal',ordinal,'status',status,'error_code',error_code)
        ORDER BY ordinal) FROM control.etl_run_attempt WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid),
      'pages',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.attempt_id,p.entity,p.relation,p.page_no)
        FROM control.etl_snapshot_stage_page p WHERE p.tenant_key=$1 AND p.source_id='pg_recovery' AND p.run_id=$2::uuid),
      'records',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.attempt_id,s.entity,s.relation,s.page_no,s.row_ordinal)
        FROM control.etl_snapshot_stage_record s WHERE s.tenant_key=$1 AND s.source_id='pg_recovery' AND s.run_id=$2::uuid))::text AS state`,
      [fixture.owner.tenantId,fixture.originalRunId])).rows[0].state;
    const original=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${fixture.originalRunId}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(original.statusCode).toBe(200);
    expect(original.json().data.failure_version).toBe('1');
    const failedList=await fixture.app.inject({method:'GET',url:'/hub/v1/admin/etl-runs?status=FAILED&source_id=pg_recovery',
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(failedList.statusCode).toBe(200);
    expect(failedList.json().data.items.find((item:{run_id:string})=>item.run_id===fixture.originalRunId)?.failure_version).toBe('1');
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
    acceptedRecovery=Object.freeze({runId:fixture.originalRunId,key:winningKey,reason:winningReason,failedVersion:'1'});
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
    await fixture.adminPool.query(`UPDATE public.customers SET name='Recovery Customer One',updated_at='2026-10-28 12:01:00+00'
      WHERE customer_id='C-REC-1'`);
    await fixture.adminPool.query(`INSERT INTO public.customers VALUES('C-REC-2','Recovery Customer Two','owner-ext','department-ext','ACTIVE',
      '2026-10-28 12:02:00+00',1)`);
    let sourceConnections=0,sourceRows=0;
    const worked=await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:
        createOwnedPostgresSourceFactory(fixture.adminPool,()=>sourceConnections++,count=>sourceRows+=count)});
    expect(worked).toBe(1);
    expect(sourceConnections).toBe(1);
    expect(sourceRows).toBe(2);
    const child=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${accepted.run_id}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(child.statusCode).toBe(200);
    expect(child.json().data).toMatchObject({run_id:accepted.run_id,status:'VALIDATING',extracted_count:2});
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(1);
    const completed=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${accepted.run_id}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(completed.statusCode).toBe(200);
    expect(completed.json().data).toMatchObject({run_id:accepted.run_id,status:'COMPLETE',extracted_count:2});
    const afterSourceRecovery=(await fixture.adminPool.query<{state:string}>(`SELECT jsonb_build_object(
      'attempts',(SELECT jsonb_agg(jsonb_build_object('attempt_id',attempt_id,'ordinal',ordinal,'status',status,'error_code',error_code)
        ORDER BY ordinal) FROM control.etl_run_attempt WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid),
      'pages',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.attempt_id,p.entity,p.relation,p.page_no)
        FROM control.etl_snapshot_stage_page p WHERE p.tenant_key=$1 AND p.source_id='pg_recovery' AND p.run_id=$2::uuid),
      'records',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.attempt_id,s.entity,s.relation,s.page_no,s.row_ordinal)
        FROM control.etl_snapshot_stage_record s WHERE s.tenant_key=$1 AND s.source_id='pg_recovery' AND s.run_id=$2::uuid))::text AS state`,
      [fixture.owner.tenantId,fixture.originalRunId])).rows[0].state;
    expect(afterSourceRecovery).toBe(frozenOriginalStage);
    const canonical=await fixture.adminPool.query<{customer_count:string;outcome_count:string;observation_count:string;delete_count:string}>(`
      SELECT (SELECT count(*) FROM hub.canonical_customer WHERE tenant_id=$1)::text AS customer_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS outcome_count,
        (SELECT count(*) FROM control.etl_snapshot_observation WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS observation_count,
        (SELECT count(*) FROM control.etl_snapshot_delete_run WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid)::text AS delete_count`,
      [fixture.owner.tenantId,accepted.run_id]);
    expect(canonical.rows[0]).toEqual({customer_count:'2',outcome_count:'2',observation_count:'1',delete_count:'1'});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_delete_run SET status='SKIPPED'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,accepted.run_id]);
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_schedule SET enabled=false,schedule_revision=schedule_revision+1
      WHERE tenant_key=$1 AND source_id='pg_recovery'`,[fixture.owner.tenantId]);

    await fixture.adminPool.query(`UPDATE public.customers SET name='Recovery Customer Two Revised',updated_at='2026-10-28 12:03:00+00'
      WHERE customer_id='C-REC-2'`);
    await fixture.adminPool.query(`INSERT INTO public.customers VALUES
      ('C-REC-3','Recovery Customer Three','owner-ext','department-ext','ACTIVE','2026-10-28 12:04:00+00',1),
      ('C-REC-4','Recovery Customer Four','owner-ext','department-ext','ACTIVE','2026-10-28 12:05:00+00',1)`);
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
    expect(partialSourceRows).toBe(4);
    let committedRun='';
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool,20,60,{afterAggregateCommit:async item=>{
      if(item.run_id===partialAccepted.json().data.run_id&&item.source_pk==='C-REC-3'&&!committedRun){committedRun=item.run_id;throw new Error('controlled partial C crash');}
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
    expect(sealedSource.rows[0].range_count).toBe('3');
    expect(sealedSource.rows[0].d_count).toBe('1');
    const frozenBefore=await frozenStageState(committedRun);
    expect(frozenBefore).not.toBe('');
    const changedCanonical=await fixture.adminPool.query<{customer_name:string}>(`
      SELECT c.customer_name FROM control.canonical_source_identity i JOIN hub.canonical_customer c
        ON (c.tenant_id,c.id)=(i.tenant_key,i.canonical_object_id)
      WHERE i.tenant_key=$1 AND i.source_id='pg_recovery' AND i.entity='customer' AND i.source_pk='C-REC-1'`,
      [fixture.owner.tenantId]);
    expect(changedCanonical.rows[0]?.customer_name).toBe('Recovery Customer One');
    const originalRange=await fixture.adminPool.query<{outcome_id:string;status:string;aggregate_digest:string;proof_scope_digest:string;source_pk:string}>(`
      SELECT r.outcome_id,o.status,r.source_pk,encode(r.aggregate_digest,'hex') AS aggregate_digest,encode(r.proof_scope_digest,'hex') AS proof_scope_digest
      FROM control.etl_snapshot_apply_range r JOIN control.etl_snapshot_apply_outcome o ON o.outcome_id=r.outcome_id
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery' AND r.run_id=$2::uuid AND r.source_pk='C-REC-3'`,[fixture.owner.tenantId,committedRun]);
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
    const interruptedCopyPool=failSealedManifestOnce(fixture.workerPool,sealedAccepted.json().data.run_id);
    expect(await runSnapshotWorkerOnce(interruptedCopyPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:{
        async connect(){sealedSourceConnections+=1;throw new Error('SEALED_STAGE must not open source IO');},
      }})).toBe(1);
    expect(sealedSourceConnections).toBe(0);
    const sealedRunId=sealedAccepted.json().data.run_id as string;
    const sealedAttemptId=sealedAccepted.json().data.attempt_id as string;
    const interruptedCopy=await fixture.adminPool.query<{attempt_id:string;ordinal:number;status:string;manifest_count:string;page_count:string}>(`
      SELECT a.attempt_id::text,a.ordinal,a.status,
        (SELECT count(*) FROM control.etl_snapshot_manifest m WHERE (m.tenant_key,m.source_id,m.run_id,m.attempt_id)=
          (a.tenant_key,a.source_id,a.run_id,a.attempt_id))::text AS manifest_count,
        (SELECT count(*) FROM control.etl_snapshot_stage_page p WHERE (p.tenant_key,p.source_id,p.run_id,p.attempt_id)=
          (a.tenant_key,a.source_id,a.run_id,a.attempt_id))::text AS page_count
      FROM control.etl_run_attempt a WHERE a.tenant_key=$1 AND a.source_id='pg_recovery' AND a.run_id=$2::uuid ORDER BY a.ordinal`,
      [fixture.owner.tenantId,sealedRunId]);
    expect(interruptedCopy.rows.at(-1)).toMatchObject({ordinal:1,status:'INCOMPLETE',manifest_count:'0',page_count:'1'});
    await fixture.adminPool.query(`UPDATE control.etl_run SET snapshot_available_at=clock_timestamp()
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedRunId]);
    const leaseObservations:Array<{beforeExpiry:string;beforeObserved:string;afterExpiry:string;afterObserved:string}>=[];
    const slowCopyPool=slowSealedWritePool(fixture.workerPool,fixture.adminPool,fixture.owner.tenantId,sealedRunId,11_500,leaseObservations);
    expect(await runSnapshotWorkerOnce(slowCopyPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',resolve:async()=> 'fixture-secret'},
      leaseSeconds:10,
      egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:{
        async connect(){sealedSourceConnections+=1;throw new Error('SEALED_STAGE must not open source IO');},
      }})).toBe(1);
    expect(sealedSourceConnections).toBe(0);
    const resumedCopy=await fixture.adminPool.query<{attempt_id:string;ordinal:number;status:string;manifest_count:string;page_count:string}>(`
      SELECT a.attempt_id::text,a.ordinal,a.status,
        (SELECT count(*) FROM control.etl_snapshot_manifest m WHERE (m.tenant_key,m.source_id,m.run_id,m.attempt_id)=
          (a.tenant_key,a.source_id,a.run_id,a.attempt_id))::text AS manifest_count,
        (SELECT count(*) FROM control.etl_snapshot_stage_page p WHERE (p.tenant_key,p.source_id,p.run_id,p.attempt_id)=
          (a.tenant_key,a.source_id,a.run_id,a.attempt_id))::text AS page_count
      FROM control.etl_run_attempt a WHERE a.tenant_key=$1 AND a.source_id='pg_recovery' AND a.run_id=$2::uuid ORDER BY a.ordinal`,
      [fixture.owner.tenantId,sealedRunId]);
    process.stdout.write(`FIX1_SEALED_LEASE_OBSERVATION ${JSON.stringify(leaseObservations)}\n`);
    expect(leaseObservations).toHaveLength(1);
    expect(Date.parse(leaseObservations[0].afterExpiry)).toBeGreaterThan(Date.parse(leaseObservations[0].afterObserved));
    expect(resumedCopy.rows.at(-1)).toMatchObject({ordinal:2,status:'COMPLETE',manifest_count:'1',page_count:'1'});
    expect(Date.parse(leaseObservations[0].beforeExpiry)).toBeGreaterThan(Date.parse(leaseObservations[0].beforeObserved));
    expect(Date.parse(leaseObservations[0].afterExpiry)).toBeGreaterThan(Date.parse(leaseObservations[0].afterObserved));
    expect(Date.parse(leaseObservations[0].afterExpiry)).toBeGreaterThan(Date.parse(leaseObservations[0].beforeExpiry));
    const liveClaimResult=await fixture.workerPool.query<{claim_token:string;attempt_id:string}>(
      'SELECT claim_token::text,attempt_id::text FROM control.claim_etl_snapshot_continuation($1,$2,10)',
      [fixture.owner.tenantId,'pg_recovery']);
    expect(liveClaimResult.rows).toHaveLength(1);
    const liveClaimToken=liveClaimResult.rows[0].claim_token;
    const liveClaimAttemptId=liveClaimResult.rows[0].attempt_id;
    expect(liveClaimAttemptId).not.toBe(sealedAttemptId);
    const oldClaimToken='00000000-0000-4000-8000-000000000000';
    for(const token of [null,oldClaimToken]) {
      const rejected=await fixture.workerPool.query<{metadata:unknown;proof:unknown;heartbeat:boolean}>(`
        SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
          control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof,
          control.heartbeat_etl_snapshot_continuation($1,$2,$3::uuid,$4::uuid,$5::uuid,10) AS heartbeat`,
        [fixture.owner.tenantId,'pg_recovery',sealedRunId,liveClaimAttemptId,token]);
      expect(rejected.rows[0]).toEqual({metadata:null,proof:null,heartbeat:false});
    }
    const validClaim=await fixture.workerPool.query<{metadata:Record<string,unknown>;proof:Record<string,unknown>}>(`
      SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
        control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof`,
      [fixture.owner.tenantId,'pg_recovery',sealedRunId,liveClaimAttemptId,liveClaimToken]);
    expect(validClaim.rows[0].metadata).toMatchObject({recovery_mode:'SEALED_STAGE',original_run_id:committedRun});
    expect(validClaim.rows[0].proof).toMatchObject({run_id:sealedRunId,status:'VALIDATING'});
    const unrelatedScope=await fixture.workerPool.query<{proof:unknown}>(
      'SELECT control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof',
      [fixture.owner.tenantId,'pg_recovery',committedRun,liveClaimAttemptId,liveClaimToken]);
    expect(unrelatedScope.rows[0].proof).toBeNull();
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedRunId]);
    const expiredClaim=await fixture.workerPool.query<{metadata:unknown;proof:unknown;heartbeat:boolean}>(`
      SELECT control.read_etl_snapshot_recovery_c_metadata($1,$2,$3::uuid,$4::uuid,$5::uuid) AS metadata,
        control.read_etl_snapshot_c_proof($1,$2,$3::uuid,$4::uuid,$5::uuid) AS proof,
        control.heartbeat_etl_snapshot_continuation($1,$2,$3::uuid,$4::uuid,$5::uuid,10) AS heartbeat`,
      [fixture.owner.tenantId,'pg_recovery',sealedRunId,liveClaimAttemptId,liveClaimToken]);
    expect(expiredClaim.rows[0]).toEqual({metadata:null,proof:null,heartbeat:false});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET claim_token=NULL,lease_until=NULL,next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedRunId]);
    const beforeCrashPid=await killNodeAtAggregateBoundary(fixture.hostPort,sealedAccepted.json().data.run_id,'before');
    expect(beforeCrashPid).toBeGreaterThan(0);
    const beforeCommitEffect=await fixture.adminPool.query<{identity_count:string;canonical_count:string;outcome_count:string;range_count:string;
      receipt_count:string;outbox_count:string;checkpoint:{completed_count:number;last_source_pk:string}}>(`
      SELECT (SELECT count(*) FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id='pg_recovery'
        AND entity='customer' AND source_pk='C-REC-4')::text AS identity_count,
        (SELECT count(*) FROM hub.canonical_customer c JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.canonical_object_id)=(c.tenant_id,c.id) WHERE i.tenant_key=$1 AND i.source_id='pg_recovery'
            AND i.entity='customer' AND i.source_pk='C-REC-4')::text AS canonical_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-4')::text AS outcome_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_range WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-4')::text AS range_count,
        (SELECT count(*) FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND entity='customer' AND source_pk='C-REC-4')::text AS receipt_count,
        (SELECT count(*) FROM control.canonical_apply_outbox o JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.source_id,i.entity,i.canonical_object_id)=(o.tenant_key,o.source_id,o.entity,o.canonical_object_id)
          WHERE i.tenant_key=$1 AND i.source_id='pg_recovery' AND i.entity='customer' AND i.source_pk='C-REC-4')::text AS outbox_count,
        (SELECT jsonb_build_object('completed_count',completed_count,'last_source_pk',last_source_pk)
          FROM control.etl_snapshot_checkpoint WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid AND entity='customer') AS checkpoint`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(beforeCommitEffect.rows[0]).toEqual({identity_count:'0',canonical_count:'0',outcome_count:'0',range_count:'0',receipt_count:'0',outbox_count:'0',
      checkpoint:{completed_count:3,last_source_pk:'C-REC-3'}});
    await fixture.adminPool.query(`UPDATE control.etl_snapshot_continuation SET lease_until=clock_timestamp()-interval '1 second',
      next_retry_at=clock_timestamp()-interval '1 second'
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid`,[fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(0);
    await new Promise(resolve=>setTimeout(resolve,5_100));
    const crashedChildPid=await killNodeAtAggregateBoundary(fixture.hostPort,sealedAccepted.json().data.run_id,'after');
    expect(crashedChildPid).toBeGreaterThan(0);
    const afterCommitEffect=await fixture.adminPool.query<{identity_count:string;canonical_count:string;outcome_count:string;range_count:string;
      receipt_count:string;outbox_count:string;checkpoint:{completed_count:number;last_source_pk:string}}>(`
      SELECT (SELECT count(*) FROM control.canonical_source_identity WHERE tenant_key=$1 AND source_id='pg_recovery'
        AND entity='customer' AND source_pk='C-REC-4')::text AS identity_count,
        (SELECT count(*) FROM hub.canonical_customer c JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.canonical_object_id)=(c.tenant_id,c.id) WHERE i.tenant_key=$1 AND i.source_id='pg_recovery'
            AND i.entity='customer' AND i.source_pk='C-REC-4')::text AS canonical_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-4')::text AS outcome_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_range WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND run_id=$2::uuid AND entity='customer' AND source_pk='C-REC-4')::text AS range_count,
        (SELECT count(*) FROM control.source_version_receipt WHERE tenant_key=$1 AND source_id='pg_recovery'
          AND entity='customer' AND source_pk='C-REC-4')::text AS receipt_count,
        (SELECT count(*) FROM control.canonical_apply_outbox o JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.source_id,i.entity,i.canonical_object_id)=(o.tenant_key,o.source_id,o.entity,o.canonical_object_id)
          WHERE i.tenant_key=$1 AND i.source_id='pg_recovery' AND i.entity='customer' AND i.source_pk='C-REC-4')::text AS outbox_count,
        (SELECT jsonb_build_object('completed_count',completed_count,'last_source_pk',last_source_pk)
          FROM control.etl_snapshot_checkpoint WHERE tenant_key=$1 AND source_id='pg_recovery' AND run_id=$2::uuid AND entity='customer') AS checkpoint`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id]);
    expect(afterCommitEffect.rows[0]).toEqual({identity_count:'1',canonical_count:'1',outcome_count:'1',range_count:'1',receipt_count:'1',outbox_count:'1',
      checkpoint:{completed_count:4,last_source_pk:'C-REC-4'}});
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
    expect(sealedComplete.json().data).toMatchObject({status:'COMPLETE',extracted_count:4});
    const postRecoverySource=await fixture.adminPool.query<{lifecycle:string;current_config_revision:string;credential_revision:string;enabled:boolean}>(`
      SELECT r.lifecycle,r.current_config_revision::text AS current_config_revision,c.revision::text AS credential_revision,c.enabled
      FROM control.source_registry r JOIN control.source_credential c ON c.tenant_key=r.tenant_key AND c.source_id=r.source_id
      WHERE r.tenant_key=$1 AND r.source_id='pg_recovery'`,[fixture.owner.tenantId]);
    expect(postRecoverySource.rows[0]).toMatchObject({lifecycle:'PAUSED',current_config_revision:'2',credential_revision:'2',enabled:true});
    const sealedOutcome=await fixture.adminPool.query<{reused_count:string;applied_count:string;reused_source_statuses:string[];reused_outcome_ids:string[];d_count:string;allocation_count:string;sequence_value:string;child_observation_count:string}>(`
      SELECT (SELECT count(*) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
        AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL)::text AS reused_count,
        (SELECT count(*) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.status='APPLIED')::text AS applied_count,
        (SELECT array_agg(x.status ORDER BY x.source_pk) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL) AS reused_source_statuses,
        (SELECT array_agg(x.reused_original_outcome_id::text ORDER BY x.source_pk) FROM control.etl_snapshot_apply_outcome x WHERE x.tenant_key=$1 AND x.source_id='pg_recovery'
          AND x.run_id=$2::uuid AND x.reused_original_outcome_id IS NOT NULL) AS reused_outcome_ids,
        (SELECT count(*) FROM control.etl_snapshot_delete_run d WHERE d.tenant_key=$1 AND d.source_id='pg_recovery')::text AS d_count,
        (SELECT count(*) FROM control.etl_snapshot_observation_allocation a WHERE a.tenant_key=$1 AND a.source_id='pg_recovery')::text AS allocation_count,
        (SELECT sequence_value::text FROM control.etl_snapshot_observation o WHERE o.tenant_key=$1 AND o.source_id='pg_recovery' AND o.run_id=$3::uuid) AS sequence_value,
        (SELECT count(*) FROM control.etl_snapshot_observation o WHERE o.tenant_key=$1 AND o.source_id='pg_recovery' AND o.run_id=$2::uuid)::text AS child_observation_count`,
      [fixture.owner.tenantId,sealedAccepted.json().data.run_id,committedRun]);
    expect(sealedOutcome.rows[0]).toMatchObject({reused_count:'3',applied_count:'1',reused_source_statuses:['DUPLICATE','DUPLICATE','DUPLICATE'],d_count:'1',allocation_count:'2',
      sequence_value:sealedSource.rows[0].sequence_value,child_observation_count:'0'});
    expect(sealedOutcome.rows[0].reused_outcome_ids).toContain(originalRange.rows[0].outcome_id);
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
  it('copies the immutable SEALED order proof and applies two source lines as one aggregate',async()=>{
    const customer=await fixture.adminPool.query<{canonical_object_id:string}>(`SELECT canonical_object_id::text FROM control.canonical_source_identity
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND entity='customer' AND source_pk='C-REC-1'`,[fixture.owner.tenantId]);
    expect(customer.rows).toHaveLength(1);
    const originalRunId=await fixture.createOrderRecoveryRun(customer.rows[0].canonical_object_id);
    const sourceFactory=createOwnedPostgresSourceFactory(fixture.adminPool);
    expect(await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',
      resolve:async()=> 'fixture-secret'},egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},
      sourceConnectionFactory:sourceFactory})).toBe(1);
    let committedOriginalOrder='';
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool,20,60,{afterAggregateCommit:async item=>{
      if(item.run_id===originalRunId&&item.entity==='order'&&item.source_pk==='9007199254740993123') {
        committedOriginalOrder=item.source_pk; throw new Error('controlled order aggregate failure after commit');
      }
    }})).toBe(1);
    expect(committedOriginalOrder).toBe('9007199254740993123');
    const originalStatus=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${originalRunId}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(originalStatus.statusCode).toBe(200);
    expect(originalStatus.json().data).toMatchObject({status:'FAILED',failure_version:'1',expected_entities:['order']});
    const frozenBefore=await frozenStageState(originalRunId,'pg_order_recovery');
    expect(frozenBefore).not.toBe('');
    const originalRange=await fixture.adminPool.query<{outcome_id:string;status:string;aggregate_digest:string;proof_scope_digest:string}>(`
      SELECT r.outcome_id::text,o.status,encode(r.aggregate_digest,'hex') AS aggregate_digest,encode(r.proof_scope_digest,'hex') AS proof_scope_digest
      FROM control.etl_snapshot_apply_range r JOIN control.etl_snapshot_apply_outcome o USING(outcome_id)
      WHERE r.tenant_key=$1 AND r.source_id='pg_order_recovery' AND r.run_id=$2::uuid AND r.entity='order'
        AND r.source_pk='9007199254740993123'`,[fixture.owner.tenantId,originalRunId]);
    expect(originalRange.rows).toHaveLength(1);
    expect(originalRange.rows[0].status).toBe('APPLIED');
    const originalOrderEffect=await fixture.adminPool.query<{line_count:string;receipt_outbox_count:string;unapplied_second_order:string}>(`
      SELECT (SELECT count(*)::text FROM control.canonical_source_identity i JOIN hub.canonical_order o
          ON o.tenant_id=i.tenant_key AND o.id=i.canonical_object_id JOIN hub.canonical_order_line l
          ON l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.deleted_at IS NULL
        WHERE i.tenant_key=$1 AND i.source_id='pg_order_recovery' AND i.entity='order' AND i.source_pk='9007199254740993123') AS line_count,
        (SELECT count(*)::text FROM control.source_version_receipt r JOIN control.canonical_source_identity i
          ON (i.tenant_key,i.source_id,i.entity,i.source_pk,i.canonical_object_id)=(r.tenant_key,r.source_id,r.entity,r.source_pk,r.canonical_object_id)
          JOIN control.canonical_apply_outbox o ON (o.tenant_key,o.source_id,o.entity,o.canonical_object_id,o.apply_xid,
            o.source_content_digest,o.projection_digest)=(r.tenant_key,r.source_id,r.entity,r.canonical_object_id,r.apply_xid,
            r.source_content_digest,r.projection_digest)
        WHERE r.tenant_key=$1 AND r.source_id='pg_order_recovery' AND r.entity='order' AND r.source_pk='9007199254740993123') AS receipt_outbox_count,
        (SELECT count(*)::text FROM control.etl_snapshot_apply_range WHERE tenant_key=$1 AND source_id='pg_order_recovery'
          AND run_id=$2::uuid AND entity='order' AND source_pk='9007199254740993124') AS unapplied_second_order`,
      [fixture.owner.tenantId,originalRunId]);
    expect(originalOrderEffect.rows[0]).toEqual({line_count:'2',receipt_outbox_count:'1',unapplied_second_order:'0'});
    const originalObservation=await fixture.adminPool.query<{sequence_value:string;created_at:string}>(`SELECT sequence_value::text,created_at::text
      FROM control.etl_snapshot_observation WHERE tenant_key=$1 AND source_id='pg_order_recovery' AND run_id=$2::uuid`,
      [fixture.owner.tenantId,originalRunId]);
    expect(originalObservation.rows).toHaveLength(1);
    const outboxBefore=await fixture.adminPool.query<{count:string;max_id:string;prefix:string}>(`SELECT count(*)::text AS count,
      max(id)::text AS max_id,coalesce(jsonb_agg(jsonb_build_object('id',id,'entity',entity,'source_content_digest',
        encode(source_content_digest,'hex'),'projection_digest',encode(projection_digest,'hex')) ORDER BY id),'[]'::jsonb)::text AS prefix
      FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_order_recovery'`,[fixture.owner.tenantId]);
    const retry=await fixture.app.inject({method:'POST',url:`/hub/v1/admin/etl-runs/${originalRunId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':'snapshot-order-recovery'},
      payload:{failed_version:'1',reason:'resume exact two-line order snapshot'}});
    expect(retry.statusCode,retry.body).toBe(202);
    expect(retry.json().data).toMatchObject({recovery_mode:'SEALED_STAGE',status:'QUEUED'});
    let sourceConnections=0;
    expect(await runSnapshotWorkerOnce(fixture.workerPool,{secretResolver:{isConfiguredReference:reference=>reference==='vault:/snapshot/source',
      resolve:async()=> 'fixture-secret'},egressPolicy:{environmentKind:'local_lab',policyId:'controlled-recovery-fixture'},sourceConnectionFactory:{
        async connect(){sourceConnections+=1;throw new Error('SEALED order recovery must not open source IO');},
      }})).toBe(1);
    expect(sourceConnections).toBe(0);
    const childRunId=retry.json().data.run_id as string;
    expect(await frozenStageState(originalRunId,'pg_order_recovery')).toBe(frozenBefore);
    expect(await runSnapshotContinuationWorkerOnce(fixture.workerPool)).toBe(1);
    const childStatus=await fixture.app.inject({method:'GET',url:`/hub/v1/admin/etl-runs/${childRunId}`,
      headers:{authorization:`Bearer ${fixture.token}`}});
    expect(childStatus.json().data).toMatchObject({status:'COMPLETE',expected_entities:['order']});
    const recoveryRanges=await fixture.adminPool.query<{entity:string;source_pk:string;status:string;reused_original_outcome_id:string|null;outcome_id:string}>(`
      SELECT r.entity,r.source_pk,o.status,x.reused_original_outcome_id::text,r.outcome_id::text
      FROM control.etl_snapshot_apply_range r JOIN control.etl_snapshot_apply_outcome o USING(outcome_id)
      LEFT JOIN control.etl_snapshot_apply_outcome x USING(outcome_id)
      WHERE r.tenant_key=$1 AND r.source_id='pg_order_recovery' AND r.run_id=$2::uuid ORDER BY r.source_pk`,
      [fixture.owner.tenantId,childRunId]);
    expect(recoveryRanges.rows).toHaveLength(2);
    expect(recoveryRanges.rows.find(row=>row.source_pk==='9007199254740993123')).toMatchObject({
      status:'DUPLICATE',reused_original_outcome_id:originalRange.rows[0].outcome_id});
    expect(recoveryRanges.rows.find(row=>row.source_pk==='9007199254740993124')).toMatchObject({status:'APPLIED',reused_original_outcome_id:null});
    const canonicalOrder=await fixture.adminPool.query<{order_no:string;amount:string;line_count:string;receipt_outbox_count:string;lines:Array<Record<string,string>>}>(`
      SELECT o.order_no,o.amount::text,(SELECT count(*)::text FROM hub.canonical_order_line l
        WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.deleted_at IS NULL) AS line_count,
        (SELECT count(*)::text FROM control.source_version_receipt r JOIN control.canonical_apply_outbox x
          ON (x.tenant_key,x.source_id,x.entity,x.canonical_object_id,x.apply_xid,x.source_content_digest,x.projection_digest)=
            (r.tenant_key,r.source_id,r.entity,r.canonical_object_id,r.apply_xid,r.source_content_digest,r.projection_digest)
          WHERE r.tenant_key=i.tenant_key AND r.source_id=i.source_id AND r.entity='order' AND r.source_pk=i.source_pk) AS receipt_outbox_count,
        (SELECT jsonb_agg(jsonb_build_object('line_id',l.source_line_id,'quantity',l.quantity::text,'unit_price',l.unit_price::text,
          'line_amount',l.line_amount::text) ORDER BY l.source_line_id)::jsonb FROM hub.canonical_order_line l
          WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.deleted_at IS NULL) AS lines
      FROM control.canonical_source_identity i JOIN hub.canonical_order o ON o.tenant_id=i.tenant_key AND o.id=i.canonical_object_id
      WHERE i.tenant_key=$1 AND i.source_id='pg_order_recovery' AND i.entity='order' AND i.source_pk='9007199254740993124'`,
      [fixture.owner.tenantId]);
    expect(canonicalOrder.rows[0]).toEqual({order_no:'ORDER-REC-200',amount:'223456789012345678.12',line_count:'2',receipt_outbox_count:'1',lines:[
      {line_id:'L-200-A',quantity:'3.123456',unit_price:'323456789012.123456',line_amount:'338636548569.22'},
      {line_id:'L-200-B',quantity:'4.123456',unit_price:'423456789012.123456',line_amount:'438636548569.22'},
    ]});
    const observationAfter=await fixture.adminPool.query<{sequence_value:string;created_at:string;child_observation_count:string}>(`
      SELECT (SELECT sequence_value::text FROM control.etl_snapshot_observation WHERE tenant_key=$1 AND source_id='pg_order_recovery'
        AND run_id=$2::uuid) AS sequence_value,(SELECT created_at::text FROM control.etl_snapshot_observation WHERE tenant_key=$1
        AND source_id='pg_order_recovery' AND run_id=$2::uuid) AS created_at,(SELECT count(*)::text FROM control.etl_snapshot_observation
        WHERE tenant_key=$1 AND source_id='pg_order_recovery' AND run_id=$3::uuid) AS child_observation_count`,
      [fixture.owner.tenantId,originalRunId,childRunId]);
    expect(observationAfter.rows[0]).toMatchObject({...originalObservation.rows[0],child_observation_count:'0'});
    expect(await frozenStageState(originalRunId,'pg_order_recovery')).toBe(frozenBefore);
    const outboxAfter=await fixture.adminPool.query<{count:string;prefix:string}>(`SELECT count(*)::text AS count,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'entity',entity,'source_content_digest',encode(source_content_digest,'hex'),
        'projection_digest',encode(projection_digest,'hex')) ORDER BY id) FROM control.canonical_apply_outbox
        WHERE tenant_key=$1 AND source_id='pg_order_recovery' AND id<=$2),'[]'::jsonb)::text AS prefix
      FROM control.canonical_apply_outbox WHERE tenant_key=$1 AND source_id='pg_order_recovery'`,
      [fixture.owner.tenantId,outboxBefore.rows[0].max_id]);
    expect(Number(outboxAfter.rows[0].count)).toBe(Number(outboxBefore.rows[0].count)+1);
    expect(outboxAfter.rows[0].prefix).toBe(outboxBefore.rows[0].prefix);
  });
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
    expect(acceptedRecovery).toBeDefined();
    const accepted=acceptedRecovery!;
    const stored=await fixture.adminPool.query<{operation_id:string;child_run_id:string;request_digest:string}>(`
      SELECT operation_id::text,child_run_id::text,encode(request_digest,'hex') AS request_digest
      FROM control.etl_snapshot_recovery_operation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND route='API-022' AND idempotency_key=$2
        AND parent_run_id=$3::uuid`,[fixture.owner.tenantId,accepted.key,accepted.runId]);
    expect(stored.rowCount).toBe(1);
    const before=await fixture.adminPool.query<{count:string}>(`SELECT count(*)::text AS count FROM control.etl_snapshot_recovery_operation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND route='API-022'`,[fixture.owner.tenantId]);
    await fixture.adminPool.query(`UPDATE control.auth_subject SET enabled=false WHERE tenant_key=$1 AND user_id=$2`,
      [fixture.owner.tenantId,fixture.owner.userId]);
    const denied=await fixture.app.inject({method:'POST',url:`/hub/v1/admin/etl-runs/${accepted.runId}/retry`,
      headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json','idempotency-key':accepted.key},
      payload:{failed_version:accepted.failedVersion,reason:accepted.reason}});
    expect(denied.statusCode).toBe(401);
    expect(denied.json().data).toBeUndefined();
    const after=await fixture.adminPool.query<{count:string}>(`SELECT count(*)::text AS count FROM control.etl_snapshot_recovery_operation
      WHERE tenant_key=$1 AND source_id='pg_recovery' AND route='API-022'`,[fixture.owner.tenantId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
