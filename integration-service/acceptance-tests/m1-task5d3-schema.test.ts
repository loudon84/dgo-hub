import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { runMigrations } from '../migrate.js';

const evidenceRoot=process.env.M0_RUN_EVIDENCE_ROOT;
const postgresImage='postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
let postgres:OwnedPostgres;

beforeAll(async()=>{
  if(!evidenceRoot||!resolve(evidenceRoot)) throw new Error('M0_RUN_EVIDENCE_ROOT_REQUIRED');
  postgres=await startOwnedPostgres({evidenceFile:'',evidenceRoot,taskLabel:'m1task5',imageReference:postgresImage});
},90_000);
afterAll(async()=>{ if(postgres) await postgres.close(); });

describe('M1-5D3 migration and D grant boundary',()=>{
  it('applies the phase-owned 009 once, exposes only fenced worker calls, and replays migration identically',async()=>{
    const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
    const first=await runMigrations(postgres.pool,{directory,environmentKind:'local_lab'});
    expect(first.applied.some(name=>name.startsWith('009_'))).toBe(true);
    const second=await runMigrations(postgres.pool,{directory,environmentKind:'local_lab'});
    expect(second.applied).toEqual([]);
    expect(second.skipped.some(name=>name.startsWith('009_'))).toBe(true);
    const empty=await postgres.pool.query<{current:boolean}>(
      'SELECT control.etl_snapshot_delete_candidate_current_d3($1,$2,$3::uuid,false) AS current',
      ['missing-tenant','missing-source','00000000-0000-4000-8000-000000000001']);
    expect(empty.rows[0]?.current).toBe(false);
    const grants=await postgres.pool.query<{claim:boolean;loader:boolean;candidate_helper:boolean;preflight:boolean;effect_insert:boolean;operation_insert:boolean}>(`
      SELECT has_function_privilege('hub_worker','control.claim_etl_snapshot_delete_apply(text,text,uuid,integer)','EXECUTE') AS claim,
        has_function_privilege('hub_worker','control.load_etl_snapshot_delete_apply_proof(text,text,uuid,uuid,uuid)','EXECUTE') AS loader,
        has_function_privilege('hub_worker','control.etl_snapshot_delete_candidate_current_d3(text,text,uuid,boolean)','EXECUTE') AS candidate_helper,
        has_function_privilege('hub_worker','control.check_etl_snapshot_delete_apply_current(text,text,uuid,uuid,uuid,boolean)','EXECUTE') AS current_helper,
        has_function_privilege('hub_worker','control.preflight_etl_snapshot_delete_apply_candidate(text,text,uuid,uuid,uuid)','EXECUTE') AS preflight,
        has_table_privilege('hub_worker','control.etl_snapshot_delete_effect','INSERT') AS effect_insert,
        has_table_privilege('hub_worker','control.etl_snapshot_delete_operation','INSERT') AS operation_insert`);
    expect(grants.rows[0]).toEqual({claim:true,loader:true,candidate_helper:false,current_helper:false,preflight:true,effect_insert:false,operation_insert:false});
    const worker=await postgres.pool.connect();
    try {
      await worker.query('SET ROLE hub_worker');
      const claim=await worker.query<{claim:unknown}>("SELECT control.claim_etl_snapshot_delete_apply('missing_tenant','missing-source',gen_random_uuid(),60) AS claim");
      expect(claim.rows[0]?.claim).toBeNull();
      await expect(worker.query("SELECT control.etl_snapshot_delete_candidate_current_d3('a','b',gen_random_uuid(),false)"))
        .rejects.toMatchObject({code:'42501'});
      await expect(worker.query("SELECT control.check_etl_snapshot_delete_apply_current('a','b',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),true)"))
        .rejects.toMatchObject({code:'42501'});
      await expect(worker.query("INSERT INTO control.etl_snapshot_delete_operation(candidate_id,entity,source_pk) VALUES(gen_random_uuid(),'customer','k')"))
        .rejects.toMatchObject({code:'42501'});
    } finally { await worker.query('RESET ROLE'); worker.release(); }
  },120_000);
});
