import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_BIGINT=9_223_372_036_854_775_807n;
function fail(code:ConstructorParameters<typeof AuthError>[0]):never { throw new AuthError(code); }
function digest(value:unknown):Buffer {
  const stable=(input:unknown):string=>{
    if(input===null||typeof input!=='object') return JSON.stringify(input);
    if(Array.isArray(input)) return `[${input.map(stable).join(',')}]`;
    const record=input as Record<string,unknown>;
    return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(stable(value),'utf8').digest();
}

async function transaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try { await client.query('BEGIN'); const value=await work(client); await client.query('COMMIT'); return value; }
  catch(error){ await client.query('ROLLBACK').catch(()=>undefined); if(error instanceof AuthError) throw error;
    if(typeof error==='object'&&error!==null&&'message' in error&&typeof error.message==='string'){
      const code=error.message.match(/^(AUTH_INPUT_INVALID|SOURCE_NOT_FOUND|SOURCE_CONFLICT|IDEMPOTENCY_CONFLICT)$/)?.[1];
      if(code) fail(code as ConstructorParameters<typeof AuthError>[0]);
    }
    return fail('AUTH_UNAVAILABLE');
  } finally { client.release(); }
}

export async function createSnapshotRecovery(pool:Pool,auth:Pick<AuthService,'assertCurrentPrincipal'>,principal:UserPrincipal,
  originalRunId:string,input:Readonly<{failed_version:string;reason:string}>,idempotencyKey:string,requestId:string){
  if(!principal.managementScopes.includes('source:write')) fail('AUTH_FORBIDDEN');
  if(!UUID.test(originalRunId)||!/^([1-9][0-9]*)$/.test(input.failed_version)||BigInt(input.failed_version)>MAX_BIGINT||
    typeof input.reason!=='string'||input.reason!==input.reason.trim()||Array.from(input.reason).length<1||Array.from(input.reason).length>1000||
    typeof idempotencyKey!=='string'||! /^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)||!UUID.test(requestId)) fail('AUTH_INPUT_INVALID');
  const requestDigest=digest({original_run_id:originalRunId.toLowerCase(),failed_version:input.failed_version,reason:input.reason});
  return transaction(pool,async client=>{
    await client.query('SELECT control.lock_security_barrier_fence()');
    await auth.assertCurrentPrincipal(principal,'source:write',client);
    const result=await client.query<{create_etl_snapshot_manual_recovery:Record<string,unknown>}>(
      'SELECT control.create_etl_snapshot_manual_recovery($1,$2::uuid,$3::bigint,$4,$5::bytea,$6,$7,$8,$9,$10::bigint,$11::text[],$12::uuid) AS create_etl_snapshot_manual_recovery',
      [principal.tenantId,originalRunId.toLowerCase(),input.failed_version,idempotencyKey,requestDigest,input.reason,principal.issuer,
        principal.subject,principal.userId,principal.authEpoch,principal.managementScopes,requestId]);
    const value=result.rows[0]?.create_etl_snapshot_manual_recovery;
    if(!value||typeof value!=='object') fail('AUTH_UNAVAILABLE');
    return Object.freeze(value);
  });
}
