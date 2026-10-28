import pg from 'pg';
import { runSnapshotDeleteWorkerOnce } from '../../dist/etl-worker/snapshot-delete-worker.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port=Number(process.env.SNAPSHOT_D_TEST_PG_PORT);
const phase=process.env.SNAPSHOT_D_TEST_PHASE;
const runId=process.env.SNAPSHOT_D_TEST_RUN_ID;
if(!Number.isInteger(port)||port<1||!['before','after'].includes(String(phase))||!runId)
  throw new Error('NODE_D_CRASH_FIXTURE_INPUT_INVALID');

const target=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${port}/postgres?application_name=dgo-m1t5-d-${phase}`,max:4,connectionTimeoutMillis:3000});
const pool=new Proxy(target,{get(object,property){
  if(property==='connect') return async()=>{
    const client=await target.connect();
    const original=client.query.bind(client);
    const query=((sql,...args)=>{
      if(typeof sql==='string'&&/^BEGIN(?:\s|$)/i.test(sql.trim()))
        return original(sql,...args).then(async result=>{await original('SET LOCAL ROLE hub_worker');return result;});
      return original(sql,...args);
    });
    return {query,release:client.release.bind(client)};
  };
  if(property==='query') return async(sql,...args)=>{
    const client=await target.connect();
    try { await client.query('SET ROLE hub_worker'); return await client.query(sql,...args); }
    finally { await client.query('RESET ROLE').catch(()=>undefined); client.release(); }
  };
  const value=Reflect.get(object,property,object);
  return typeof value==='function'?value.bind(object):value;
}});
const wait=()=>new Promise(()=>undefined);
const workerPath=new URL('../../dist/etl-worker/snapshot-delete-worker.js',import.meta.url);
if(process.send) process.send({type:'worker-loaded',pid:process.pid,worker_sha256:createHash('sha256').update(readFileSync(workerPath)).digest('hex'),
  worker_path:workerPath.pathname,hasWorker:typeof runSnapshotDeleteWorkerOnce==='function'});
const hook=async item=>{
  if(item.run_id!==runId) return;
  if(process.send) process.send({type:'aggregate-boundary',phase,run_id:item.run_id,candidate_id:item.candidate_id,
    entity:item.entity,source_pk:item.source_pk,operation_id:item.operation_id,pid:process.pid});
  await wait();
};
await runSnapshotDeleteWorkerOnce(pool,20,phase==='before'?{beforeAggregateCommit:hook}:{afterAggregateCommit:hook});
await target.end();
