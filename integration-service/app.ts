import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IdentityRouteOptions } from './ingestion-api/identity-routes.js';
import { createHubLoggerOptions } from './ingestion-api/logging.js';

export type BuildAppOptions = Readonly<{
  identity?: IdentityRouteOptions;
  logger?: FastifyServerOptions['logger'];
}>;

/** Build an injectable Fastify app; importing this module does not listen or access runtime configuration. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logger = options.logger ?? createHubLoggerOptions();
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024, requestIdHeader: false, genReqId: () => randomUUID() });
  const { registerRoutes } = await import('./ingestion-api/routes.js');
  await registerRoutes(app, { identity: options.identity });
  return app;
}

/** Validate controlled OIDC settings and start the executable server. */
export async function startApp(): Promise<void> {
  const { readOidcConfiguration, createOidcAuthenticator } = await import('./auth/oidc.js');
  const controlledConfig = readOidcConfiguration(process.env);
  const [{ pool }, { createAuthService }] = await Promise.all([
    import('./db.js'),
    import('./auth/service.js'),
  ]);
  const authService = createAuthService({ pool });
  const identity = { authenticator: createOidcAuthenticator(controlledConfig, authService), authService };
  const app = await buildApp({ identity });
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await startApp();
}
