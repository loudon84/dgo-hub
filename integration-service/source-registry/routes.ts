import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../auth/errors.js';
import type { AuthService, UserPrincipal } from '../auth/types.js';
import type { OidcAuthenticator } from '../auth/oidc.js';
import type { SourceRegistryService } from './service.js';

export type SourceRegistryRouteOptions = Readonly<{
  authenticator: OidcAuthenticator;
  authService: Pick<AuthService, 'repository'>;
  sourceService: SourceRegistryService;
}>;

type FailureCode = AuthError['code'] | 'AUTH_INVALID' | 'AUTH_UNAVAILABLE';

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code: FailureCode = error instanceof AuthError ? error.code : 'AUTH_UNAVAILABLE';
  const status = error instanceof AuthError ? error.status : 503;
  return reply.code(status).send({ request_id: request.id, error: { code, message: code, retryable: status === 503, details: {} } });
}

function envelope(request: FastifyRequest, data: unknown) {
  return { request_id: request.id, data };
}

async function currentUser(request: FastifyRequest, authenticator: OidcAuthenticator): Promise<UserPrincipal> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') throw new AuthError('AUTH_INVALID');
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match) throw new AuthError('AUTH_INVALID');
  return authenticator(match[1]);
}

function body(request: FastifyRequest, allowed: readonly string[]): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new AuthError('AUTH_INPUT_INVALID');
  const value = request.body as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AuthError('AUTH_INPUT_INVALID');
  return value;
}

/** M1 source APIs use only the verified OIDC principal for tenant and actor identity. */
export async function registerSourceRegistryRoutes(app: FastifyInstance, options: SourceRegistryRouteOptions): Promise<void> {
  app.register(async admin => {
    admin.setNotFoundHandler((request, reply) => reply.code(404).send({
      request_id: request.id, error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false, details: {} },
    }));

    admin.get('/hub/v1/admin/sources', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        return reply.send(envelope(request, await options.sourceService.list(principal)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post('/hub/v1/admin/sources', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['source_id', 'data_owner_user_id', 'config']);
        return reply.code(201).send(envelope(request, await options.sourceService.create(principal, value)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.get<{ Params: { id: string } }>('/hub/v1/admin/sources/:id', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        return reply.send(envelope(request, await options.sourceService.get(principal, request.params.id)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.patch<{ Params: { id: string } }>('/hub/v1/admin/sources/:id', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['expected_revision', 'config', 'data_owner_user_id']);
        return reply.send(envelope(request, await options.sourceService.update(principal, request.params.id, value)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/test', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['expected_revision']);
        const result = await options.sourceService.test(principal, request.params.id, value.expected_revision);
        return reply.code(202).send(envelope(request, { operation_id: result.test_report_id, ...result }));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/approve', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['revision', 'test_report_id', 'data_contract_ref']);
        if (typeof value.revision !== 'string' || typeof value.data_contract_ref !== 'string' ||
            value.data_contract_ref.length < 1 || value.data_contract_ref.length > 256) throw new AuthError('AUTH_INPUT_INVALID');
        const source = await options.sourceService.get(principal, request.params.id);
        if (source.revision !== value.revision) throw new AuthError('SOURCE_CONFLICT');
        return reply.send(envelope(request, await options.sourceService.approve(
          principal, request.params.id, value.test_report_id, value.data_contract_ref,
        )));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/activate', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['revision', 'approval_id']);
        if (typeof value.revision !== 'string') throw new AuthError('AUTH_INPUT_INVALID');
        const source = await options.sourceService.get(principal, request.params.id);
        if (source.revision !== value.revision) throw new AuthError('SOURCE_CONFLICT');
        return reply.send(envelope(request, await options.sourceService.activate(principal, request.params.id, value.approval_id)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/pause', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['expected_revision', 'reason']);
        return reply.send(envelope(request, await options.sourceService.pause(
          principal, request.params.id, value.expected_revision, value.reason,
        )));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.get<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/mappings', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        return reply.send(envelope(request, await options.sourceService.mappings(principal, request.params.id)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.put<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/mappings', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['expected_revision', 'mappings']);
        return reply.send(envelope(request, await options.sourceService.writeMappings(
          principal, request.params.id, value.expected_revision, value.mappings,
        )));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.post<{ Params: { id: string } }>('/hub/v1/admin/sources/:id/mappings/validate', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['revision', 'sample_ref']);
        return reply.send(envelope(request, await options.sourceService.validateMappings(principal, request.params.id, value.revision)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.get('/hub/v1/admin/identity-mappings', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        return reply.send(envelope(request, await options.sourceService.identityMappings(principal)));
      } catch (error) { return failure(request, reply, error); }
    });

    admin.put<{ Params: { id: string } }>('/hub/v1/admin/identity-mappings/:id', async (request, reply) => {
      try {
        const principal = await currentUser(request, options.authenticator);
        const value = body(request, ['expected_revision', 'target_id', 'reason']);
        if (typeof value.expected_revision !== 'string' || typeof value.target_id !== 'string' || typeof value.reason !== 'string') {
          throw new AuthError('AUTH_INPUT_INVALID');
        }
        return reply.send(envelope(request, await options.sourceService.updateIdentityMapping(
          principal, request.params.id, value.expected_revision, value.target_id, value.reason,
        )));
      } catch (error) { return failure(request, reply, error); }
    });
  });
}
