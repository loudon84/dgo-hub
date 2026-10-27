import pg from 'pg';
import { runSnapshotContinuationWorkerOnce } from '../../dist/etl-worker/snapshot-apply-worker.js';
const port=Number(process.env.SNAPSHOT_C_TEST_PG_PORT);
const phase=process.env.SNAPSHOT_C_TEST_PHASE;
const runId=process.env.SNAPSHOT_C_TEST_RUN_ID;
if(!Number.isInteger(port)||port<1||!['before','after'].includes(String(phase))||!runId) throw new Error('NODE_CRASH_FIXTURE_INPUT_INVALID');
const target=new pg.Pool({connectionString:`postgres://postgres@127.0.0.1:${port}/postgres`,max:4,connectionTimeoutMillis:3000});
const pool=new Proxy(target,{get(object,property){
  if(property==='connect') return async()=>{
    const client=await target.connect();const original=client.query.bind(client);
    const query=((sql,...args)=>{
      if(typeof sql==='string'&&/^BEGIN(?:\s|$)/i.test(sql.trim())) return original(sql,...args).then(async result=>{await original('SET LOCAL ROLE hub_worker');return result;});
      return original(sql,...args);
    });
    return {query,release:client.release.bind(client)};
  };
  if(property==='query') return async(sql,...args)=>{const client=await target.connect();try{await client.query('SET ROLE hub_worker');return await client.query(sql,...args);}finally{await client.query('RESET ROLE').catch(()=>undefined);client.release();}};
  const value=Reflect.get(object,property,object);return typeof value==='function'?value.bind(object):value;
}});
const wait=()=>new Promise(()=>undefined);
const hook=async item=>{if(item.run_id!==runId) return; if(process.send) process.send({type:'aggregate-boundary',phase,run_id:item.run_id,source_pk:item.source_pk}); await wait();};
const hooks=phase==='before'?{beforeAggregateCommit:hook}:{afterAggregateCommit:hook};
await runSnapshotContinuationWorkerOnce(pool,20,60,hooks);
await target.end();
