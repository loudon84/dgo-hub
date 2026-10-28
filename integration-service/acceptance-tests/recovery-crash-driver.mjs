import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const workerUrl=new URL('../dist/etl-worker/worker.js',import.meta.url);
const workerHash=createHash('sha256').update(await readFile(workerUrl)).digest('hex');
const {runDurableWorkerOnce}=await import(workerUrl.href);
const pool=new pg.Pool({connectionString:process.env.DGO_RECOVERY_CONNECTION,options:'-c role=hub_worker',max:1});
process.stdout.write(JSON.stringify({event:'loaded',pid:process.pid,worker_path:fileURLToPath(workerUrl),worker_sha256:workerHash})+'\n');
try {
  await runDurableWorkerOnce(pool,{limit:1,leaseMs:500,hooks:{afterItemCommit:async()=>{
    process.stdout.write(JSON.stringify({event:'ready',pid:process.pid})+'\n');
    await new Promise(()=>{});
  }}});
} finally { await pool.end(); }
