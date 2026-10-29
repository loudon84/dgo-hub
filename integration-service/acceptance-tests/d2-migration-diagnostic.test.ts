import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';

const here=dirname(fileURLToPath(import.meta.url));
const migrationDirectory=join(here,'../migrations');
const evidenceFile=join(here,'../../docs/execution/alpha1/m1-task-5b-source-lifecycle.jsonl');
const evidenceRoot=fixtureEvidenceRootFromEnvironment();
const image='postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
let postgres:OwnedPostgres|undefined;

afterAll(async()=>{if(postgres){await postgres.close();postgres=undefined;}});

describe('M1-5D2 migration diagnostics',()=>{
  it('applies migration SQL directly and preserves the native PostgreSQL failure',async()=>{
    postgres=await startOwnedPostgres({evidenceFile,evidenceRoot,taskLabel:'m1task5',imageReference:image});
    const files=(await readdir(migrationDirectory)).filter(file=>/^\d{3}_.*\.sql$/.test(file)).sort();
    for(const file of files){
      const sql=await readFile(join(migrationDirectory,file),'utf8');
      try{await postgres.pool.query(sql);}catch(error){
        const value=error as Record<string,unknown>;
        console.error('MIGRATION_DIAGNOSTIC',JSON.stringify({file,code:value.code,message:value.message,detail:value.detail,
          where:value.where,position:value.position,internalPosition:value.internalPosition,routine:value.routine}));
        throw error;
      }
    }
  },90_000);
});
