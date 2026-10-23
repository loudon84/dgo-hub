import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../auth/errors.js';
import type { AgentCredentialMetadata, AuthService, CreateAgentCredentialInput, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';

export type IdentityRouteOptions = Readonly<{
  authenticator: OidcAuthenticator;
  authService: Pick<AuthService, 'createAgentCredential' | 'listAgentCredentials' | 'revokeAgentCredential'>;
}>;

type HubErrorCode = AuthError['code'] | 'AUTH_INVALID' | 'AUTH_UNAVAILABLE';

function envelope(request: FastifyRequest, data: unknown) {
  return { request_id: request.id, data };
}

function statusFor(error: unknown): number {
  if (error instanceof AuthError) return error.code === 'AUTH_INPUT_INVALID' ? 422 : error.status;
  return 503;
}

function codeFor(error: unknown): HubErrorCode {
  if (error instanceof AuthError) return error.code;
  return 'AUTH_UNAVAILABLE';
}

function sendFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code = codeFor(error);
  const status = statusFor(error);
  return reply.code(status).send({
    request_id: request.id,
    error: { code, message: code, retryable: status === 503, details: {} },
  });
}

function sendNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    request_id: request.id,
    error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false, details: {} },
  });
}

async function currentUser(request: FastifyRequest, authenticator: OidcAuthenticator): Promise<UserPrincipal> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') throw new AuthError('AUTH_INVALID');
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match) throw new AuthError('AUTH_INVALID');
  return authenticator(match[1]);
}

function safeUser(user: UserPrincipal) {
  return {
    user_id: user.userId,
    tenant_id: user.tenantId,
    department_id: user.departmentId,
    business_role: user.businessRole,
    management_scopes: [...user.managementScopes],
    business_timezone: user.businessTimezone,
  };
}

function strictCreateBody(body: unknown): CreateAgentCredentialInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AuthError('AUTH_INPUT_INVALID');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'purpose' && key !== 'ttl_seconds') || typeof value.purpose !== 'string' ||
      (value.ttl_seconds !== undefined && typeof value.ttl_seconds !== 'number')) throw new AuthError('AUTH_INPUT_INVALID');
  return value as CreateAgentCredentialInput;
}

function metadataOnly(item: AgentCredentialMetadata) {
  return {
    credential_id: item.credential_id,
    purpose: item.purpose,
    created_at: item.created_at,
    expires_at: item.expires_at,
    revoked_at: item.revoked_at,
  };
}

function pageQuery(query: unknown): { cursor?: string; limit?: number } {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) throw new AuthError('AUTH_INPUT_INVALID');
  const value = query as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'cursor' && key !== 'limit')) throw new AuthError('AUTH_INPUT_INVALID');
  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'string' || !/^(?:[1-9][0-9]?)$|^100$/.test(value.limit)) throw new AuthError('AUTH_INPUT_INVALID');
    limit = Number(value.limit);
    if (limit < 1 || limit > 100) throw new AuthError('AUTH_INPUT_INVALID');
  }
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 128)) throw new AuthError('AUTH_INPUT_INVALID');
  return { ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }), ...(limit === undefined ? {} : { limit }) };
}

/** Register only APIs whose actor is derived from the configured, verified OIDC subject. */
export async function registerIdentityRoutes(app: FastifyInstance, options: IdentityRouteOptions): Promise<void> {
  app.register(async identity => {
    identity.setErrorHandler((error, request, reply) => {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 0;
      if (code.startsWith('FST_ERR_CTP_') || statusCode === 400) {
        return sendFailure(request, reply, new AuthError('AUTH_INPUT_INVALID'));
      }
      return sendFailure(request, reply, error);
    });
    identity.setNotFoundHandler((request, reply) => sendNotFound(request, reply));

  identity.get('/hub/v1/me', async (request, reply) => {
    try { return reply.send(envelope(request, safeUser(await currentUser(request, options.authenticator)))); }
    catch (error) { return sendFailure(request, reply, error); }
  });

  identity.post<{ Body: unknown }>('/hub/v1/me/agent-credentials', async (request, reply) => {
    try {
      const principal = await currentUser(request, options.authenticator);
      const body = strictCreateBody(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new AuthError('AUTH_INPUT_INVALID');
      const result = await options.authService.createAgentCredential(principal, body, idempotencyKey);
      const data = {
        credential_id: result.credential_id,
        purpose: result.purpose,
        created_at: result.created_at,
        expires_at: result.expires_at,
        replayed: result.replayed,
        ...(result.secret === null ? {} : { secret: result.secret }),
      };
      return reply.code(201).send(envelope(request, data));
    } catch (error) { return sendFailure(request, reply, error); }
  });

  identity.get<{ Querystring: Record<string, unknown> }>('/hub/v1/me/agent-credentials', async (request, reply) => {
    try {
      const principal = await currentUser(request, options.authenticator);
      const result = await options.authService.listAgentCredentials(principal, pageQuery(request.query));
      return reply.send(envelope(request, { items: result.items.map(metadataOnly), next_cursor: result.next_cursor }));
    } catch (error) { return sendFailure(request, reply, error); }
  });

  identity.delete<{ Params: { id: string } }>('/hub/v1/me/agent-credentials/:id', async (request, reply) => {
    try {
      const principal = await currentUser(request, options.authenticator);
      await options.authService.revokeAgentCredential(principal, request.params.id);
      return reply.code(204).send();
    } catch (error) { return sendFailure(request, reply, error); }
  });
  });
}
