import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const phase = process.argv[2];
if (phase !== 'beforeItemCommit' && phase !== 'afterItemCommit') throw new Error('INVALID_CRASH_PHASE');
if (!process.env.I3C_CONNECTION) throw new Error('I3C_CONNECTION_REQUIRED');
const workerUrl = new URL('../dist/etl-worker/worker.js', import.meta.url);
const hash = createHash('sha256').update(await readFile(workerUrl)).digest('hex');
const { runDurableWorkerOnce } = await import(workerUrl.href);
const pool = new pg.Pool({ connectionString: process.env.I3C_CONNECTION, options: '-c role=hub_worker', application_name: `i3c-child-${process.pid}`, max: 1 });
process.stdout.write(JSON.stringify({ event:'loaded', pid:process.pid, phase, worker_path:fileURLToPath(workerUrl), worker_sha256:hash })+'\n');
try {
  await runDurableWorkerOnce(pool, { limit:1, leaseMs:1000, hooks: { [phase]: async item => {
    process.stdout.write(JSON.stringify({ event:'ready', pid:process.pid, phase, item })+'\n');
    await new Promise(() => {});
  } } });
  throw new Error('BOUNDARY_NOT_REACHED');
} finally { await pool.end(); }
