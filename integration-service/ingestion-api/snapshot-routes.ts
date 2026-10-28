import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { createSnapshotRun, getSnapshotRun, listSnapshotRuns, MAX_DELETE_CANDIDATE_CURSOR_LENGTH } from '../etl-worker/snapshot-runs.js';
import { approveSnapshotDeleteCandidate, type DeleteCandidateApprovalInput } from '../etl-worker/snapshot-delete-api.js';

export type SnapshotRouteOptions = Readonly<{ pool: Pool; authService: Pick<AuthService,'repository'|'assertCurrentPrincipal'>; authenticator: OidcAuthenticator }>;
function fail(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code = error instanceof AuthError ? error.code : 'AUTH_UNAVAILABLE';
  const status = error instanceof AuthError ? error.status : 503;
  return reply.code(status).send({ request_id: request.id, error: { code, message: code, retryable: status >= 500, details: {} } });
}
function envelope(request: FastifyRequest, data: unknown) { return { request_id: request.id, data }; }
async function currentUser(request: FastifyRequest, authenticate: OidcAuthenticator): Promise<UserPrincipal> {
  const value = request.headers.authorization;
  if (typeof value !== 'string') throw new AuthError('AUTH_INVALID');
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  if (!match) throw new AuthError('AUTH_INVALID');
  return authenticate(match[1]);
}
function strictBody(request: FastifyRequest): Record<string, unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new AuthError('AUTH_INPUT_INVALID');
  const body = request.body as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || Object.keys(body).some(key => !['approved_config_revision','run_mode'].includes(key)) ||
      typeof body.approved_config_revision !== 'string' || !/^[1-9][0-9]*$/.test(body.approved_config_revision) ||
      body.run_mode !== 'FULL_SNAPSHOT') throw new AuthError('AUTH_INPUT_INVALID');
  return body;
}
function strictQuery(request: FastifyRequest): Record<string, string> {
  const query = request.query as Record<string, unknown>;
  const allowed = ['source_id','status','created_from','created_to','cursor','limit'];
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return query as Record<string,string>;
}
function detailQuery(request: FastifyRequest): Readonly<{candidateId:string;limit:number;cursor?:string}|null> {
  const query=request.query as Record<string,unknown>;
  if(Object.values(query).some(value=>typeof value!=='string')) throw new AuthError('AUTH_INPUT_INVALID');
  const keys=Object.keys(query);
  if(query.include===undefined) {
    if(keys.length!==0) throw new AuthError('AUTH_INPUT_INVALID');
    return null;
  }
  if(query.include!=='delete_candidates' || keys.some(key=>!['include','candidate_id','limit','cursor'].includes(key)) ||
    typeof query.candidate_id!=='string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(query.candidate_id)) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  let limit=20;
  if(query.limit!==undefined) {
    if(typeof query.limit!=='string' || !/^(?:[1-9][0-9]?|100)$/.test(query.limit)) throw new AuthError('AUTH_INPUT_INVALID');
    limit=Number(query.limit);
  }
  if(query.cursor!==undefined && (typeof query.cursor!=='string' || query.cursor.length>MAX_DELETE_CANDIDATE_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(query.cursor))) {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return Object.freeze({candidateId:query.candidate_id.toLowerCase(),limit,...(query.cursor===undefined?{}:{cursor:query.cursor})});
}
function strictApprovalBody(request: FastifyRequest): DeleteCandidateApprovalInput {
  if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json' ||
    !request.body || typeof request.body!=='object' || Array.isArray(request.body)) throw new AuthError('AUTH_INPUT_INVALID');
  const body=request.body as Record<string,unknown>;
  const required=['run_id','candidate_revision','candidate_digest','expected_owner_revision','reason'];
  if(Object.keys(body).length!==required.length || Object.keys(body).some(key=>!required.includes(key)) ||
    typeof body.run_id!=='string' || typeof body.candidate_revision!=='number' || !Number.isSafeInteger(body.candidate_revision) ||
    typeof body.candidate_digest!=='string' || typeof body.expected_owner_revision!=='string' || typeof body.reason!=='string') {
    throw new AuthError('AUTH_INPUT_INVALID');
  }
  return body as unknown as DeleteCandidateApprovalInput;
}
function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new AuthError('AUTH_INPUT_INVALID');
  return value;
}

export async function registerSnapshotRoutes(app: FastifyInstance, options: SnapshotRouteOptions): Promise<void> {
  app.register(async admin => {
    admin.setErrorHandler((error,request,reply) => {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode : 500;
      const code = statusCode === 413 ? 'AUTH_INPUT_INVALID' : statusCode < 500 ? 'AUTH_INPUT_INVALID' : 'AUTH_UNAVAILABLE';
      return reply.code(statusCode === 413 ? 413 : statusCode === 415 ? 415 : statusCode < 500 ? 400 : 503).send({ request_id:request.id,
        error:{code,message:code,retryable:code==='AUTH_UNAVAILABLE',details:{}} });
    });
    admin.setNotFoundHandler((request,reply) => reply.code(404).send({ request_id:request.id,
      error:{code:'NOT_FOUND',message:'NOT_FOUND',retryable:false,details:{}} }));
    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/etl-runs', async (request,reply) => {
      try {
        const principal = await currentUser(request,options.authenticator);
        const body = strictBody(request);
        const result = await createSnapshotRun(options.pool,options.authService,principal,request.params.id,
          body.approved_config_revision as string,idempotencyKey(request));
        return reply.code(202).send(envelope(request,result));
      } catch (error) { return fail(request,reply,error); }
    });
    admin.get('/hub/v1/admin/etl-runs', async (request,reply) => {
      try {
        const principal = await currentUser(request,options.authenticator);
        const query = strictQuery(request);
        const limit = query.limit === undefined ? undefined : Number(query.limit);
        if (query.limit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(query.limit)) throw new AuthError('AUTH_INPUT_INVALID');
        const result = await listSnapshotRuns(options.pool,options.authService,principal,{ ...query, ...(limit === undefined ? {} : { limit }) });
        return reply.send(envelope(request,result));
      } catch (error) { return fail(request,reply,error); }
    });
    admin.get<{ Params: { id: string } }>('/hub/v1/admin/etl-runs/:id', async (request,reply) => {
      try {
        const principal = await currentUser(request,options.authenticator);
        const query=detailQuery(request);
        const page=query?{candidateId:query.candidateId,limit:query.limit,requestId:request.id,...(query.cursor===undefined?{}:{cursor:query.cursor})}:undefined;
        return reply.send(envelope(request,await getSnapshotRun(options.pool,options.authService,principal,request.params.id,page)));
      } catch (error) { return fail(request,reply,error); }
    });
    admin.post<{ Params: { id:string; candidate_id:string } }>(
      '/hub/v1/admin/sources/:id/delete-candidates/:candidate_id/approve',async(request,reply)=>{
        try {
          const principal=await currentUser(request,options.authenticator);
          const body=strictApprovalBody(request);
          const result=await approveSnapshotDeleteCandidate(options.pool,principal,request.params.id,request.params.candidate_id,
            body,idempotencyKey(request),request.id);
          return reply.code(200).send(envelope(request,result));
        } catch(error) { return fail(request,reply,error); }
      });
  });
}
