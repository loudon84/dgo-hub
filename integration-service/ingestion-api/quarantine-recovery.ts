import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthService } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { AuthError } from '../auth/errors.js';
import { parseStrictJson } from './strict-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE = '/hub/v1/admin/quarantine/{quarantine_id}/retry';
export function recoveryExpectedState(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, quarantine_id: id, generation: '0' }), 'utf8').toString('base64url');
}
class RecoveryError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
function input(): never { throw new AuthError('AUTH_INPUT_INVALID'); }
function header(request: FastifyRequest, name: string): string {
  const headers = request.raw.rawHeaders;
  let count = 0;
  for (let i=0;i<headers.length;i+=2) if (headers[i]?.toLowerCase()===name) count++;
  const value=request.headers[name];
  if (count!==1 || typeof value!=='string') input();
  return value as string;
}
function parseBody(raw: unknown, id: string) {
  if (!Buffer.isBuffer(raw)) input();
  let value: unknown;
  try { value=parseStrictJson(raw as Buffer,true); } catch { return input(); }
  if (!value || typeof value!=='object' || Array.isArray(value)) input();
  const body=value as Record<string,unknown>;
  if (Object.keys(body).length!==3 || Object.keys(body).some(k=>!['expected_state','mapping_revision','reason'].includes(k)) ||
      typeof body.expected_state!=='string' || typeof body.mapping_revision!=='string' || !/^[1-9][0-9]*$/.test(body.mapping_revision) ||
      typeof body.reason!=='string') input();
  if (!/^[A-Za-z0-9_-]+$/.test(body.expected_state as string)) input();
  let decoded: Buffer;
  try { decoded=Buffer.from(body.expected_state as string,'base64url'); } catch { return input(); }
  if (decoded.toString('base64url')!==body.expected_state) input();
  let token: unknown;
  try { token=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded)); } catch { return input(); }
  if (!token || typeof token!=='object' || Array.isArray(token)) input();
  const fields=token as Record<string,unknown>;
  if (Object.keys(fields).join(',')!=='v,quarantine_id,generation' || fields.v!==1 || fields.generation!=='0' ||
      typeof fields.quarantine_id!=='string' || !UUID.test(fields.quarantine_id) || recoveryExpectedState(fields.quarantine_id)!==body.expected_state) input();
  const reason=(body.reason as string).trim();
  if (Array.from(reason).length<1 || Array.from(reason).length>1000) input();
  return { expected_state:body.expected_state as string,mapping_revision:body.mapping_revision as string,reason };
}
export async function registerQuarantineRecoveryRoute(app: FastifyInstance, options?: Readonly<{
  pool: Pool; authService: Pick<AuthService,'assertCurrentPrincipal'>; authenticator: OidcAuthenticator;
}>): Promise<void> {
  app.register(async scope=>{
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    scope.setErrorHandler((_error,request,reply)=>reply.code(400).send({request_id:request.id,
      error:{code:'AUTH_INPUT_INVALID',message:'AUTH_INPUT_INVALID',retryable:false,details:{}}}));
    scope.post<{Params:{id:string}}>('/hub/v1/admin/quarantine/:id/retry',async(request,reply)=>{
      try {
        if (!options) throw new AuthError('AUTH_UNAVAILABLE');
        const id=request.params.id;
        if (!UUID.test(id)) input();
        if (header(request,'content-type').split(';')[0]?.trim().toLowerCase()!=='application/json') input();
        const key=header(request,'idempotency-key');
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) input();
        const body=parseBody(request.body,id);
        const authorization=header(request,'authorization');
        const match=/^Bearer ([A-Za-z0-9._~-]{1,16384})$/.exec(authorization);
        if (!match) throw new AuthError('AUTH_INVALID');
        const principal=await options.authenticator(match[1]!);
        const client=await options.pool.connect();
        try {
          await client.query('BEGIN');
          const resolved=await client.query<{source_id:string;owner_revision:string}>(
            'SELECT source_id,owner_revision::text FROM control.resolve_recovery_owner_origin($1,$2::uuid,$3,$4,$5,$6::bigint)',
            [principal.tenantId,id,principal.userId,principal.issuer,principal.subject,principal.authEpoch]);
          if (!resolved.rowCount) throw new AuthError('SOURCE_NOT_FOUND');
          await options.authService.assertCurrentPrincipal(principal,'source:approve',client);
          const source=resolved.rows[0]!;
          if (BigInt(body.mapping_revision)>9223372036854775807n) throw new RecoveryError('SOURCE_CONFLICT',409);
          const hash=createHash('sha256');
          for (const field of ['hub.recovery.api024.v1',principal.tenantId,source.source_id,ROUTE,id,body.expected_state,body.mapping_revision,JSON.stringify(body.reason)]) {
            const bytes=Buffer.from(field,'utf8'); const length=Buffer.alloc(4); length.writeUInt32BE(bytes.length); hash.update(length).update(bytes);
          }
          const digest=hash.digest();
          const result=await client.query<{code:string;operation_id:string|null;child_job_id:string|null}>(
            'SELECT * FROM control.create_rest_recovery($1,$2::uuid,$3,$4,$5,$6::bigint,$7::bigint,$8,$9,$10,$11::bigint,$12,$13::uuid,$14::uuid,$15)',
            [principal.tenantId,id,principal.userId,principal.issuer,principal.subject,principal.authEpoch,source.owner_revision,key,digest,
              body.expected_state,body.mapping_revision,JSON.stringify(body.reason),randomUUID(),randomUUID(),`recovery-${randomUUID()}`]);
          const row=result.rows[0];
          if (!row || row.code!=='ACCEPTED') throw new RecoveryError(row?.code ?? 'AUTH_UNAVAILABLE',row?.code==='AUTH_INPUT_INVALID'?400:row?.code==='SOURCE_NOT_FOUND'?404:409);
          await client.query('COMMIT');
          return reply.code(202).send({request_id:request.id,data:{operation_id:row.operation_id,child_job_id:row.child_job_id,status:'ACCEPTED'}});
        } catch(error) {
          await client.query('ROLLBACK').catch(()=>undefined);
          if (typeof error==='object' && error!==null && 'code' in error && error.code==='23505') throw new AuthError('IDEMPOTENCY_CONFLICT');
          if (typeof error==='object' && error!==null && 'code' in error && error.code==='42501') throw new AuthError('AUTH_FORBIDDEN');
          if (typeof error==='object' && error!==null && 'code' in error && error.code==='P0001' && 'message' in error && error.message==='AUTH_CONTEXT_CHANGED') throw new AuthError('AUTH_CONTEXT_CHANGED');
          throw error;
        } finally { client.release(); }
      } catch(error) {
        const code=error instanceof AuthError || error instanceof RecoveryError ? error.code : 'AUTH_UNAVAILABLE';
        const status=error instanceof AuthError || error instanceof RecoveryError ? error.status : 503;
        return reply.code(status).send({request_id:request.id,error:{code,message:code,retryable:status===503,details:{}}});
      }
    });
  });
}
