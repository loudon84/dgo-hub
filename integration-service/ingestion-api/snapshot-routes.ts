import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import { createSnapshotRun, getSnapshotRun, listSnapshotRuns } from '../etl-worker/snapshot-runs.js';

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
        return reply.send(envelope(request,await getSnapshotRun(options.pool,options.authService,principal,request.params.id)));
      } catch (error) { return fail(request,reply,error); }
    });
  });
}
