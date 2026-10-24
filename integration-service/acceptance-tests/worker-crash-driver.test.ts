import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runDurableWorkerOnce } from '../etl-worker/worker.js';

describe('M1-4 worker crash child', () => {
  it('holds a claimed worker at the requested crash boundary', async () => {
    const connectionString=process.env.DGO_WORKER_CONNECTION;
    const point=process.env.DGO_WORKER_CRASH_POINT;
    const leaseMs=Number(process.env.DGO_WORKER_LEASE_MS ?? '500');
    if (!connectionString || !point) return;
    const pool=new pg.Pool({connectionString,options:'-c role=hub_worker',max:1});
    const block=async () => {
      process.stdout.write('DGO_CRASH_READY\n');
      await new Promise<void>(()=>undefined);
    };
    try {
      await runDurableWorkerOnce(pool,{limit:1,leaseMs,hooks:point==='after_claim'
        ? {afterClaim:block} : {afterItemCommit:block}});
    } finally {
      await pool.end();
    }
    expect(point).toBe('unsupported');
  },120_000);
});
