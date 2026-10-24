import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IdentityRouteOptions } from './ingestion-api/identity-routes.js';
import type { SourceRegistryRouteOptions } from './source-registry/routes.js';
import { createHubLoggerOptions } from './ingestion-api/logging.js';
import { readHubRuntimeConfiguration, type HubRuntimeConfiguration } from './contracts/runtime-config.js';

export type BuildAppOptions = Readonly<{
  identity?: IdentityRouteOptions;
  sourceRegistry?: SourceRegistryRouteOptions;
  logger?: FastifyServerOptions['logger'];
  runtime?: HubRuntimeConfiguration;
}>;

/** Build an injectable Fastify app; importing this module does not listen or access runtime configuration. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logger = options.logger ?? createHubLoggerOptions();
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024, requestIdHeader: false, genReqId: () => randomUUID() });
  const { registerRoutes } = await import('./ingestion-api/routes.js');
  await registerRoutes(app, { identity: options.identity, sourceRegistry: options.sourceRegistry, runtime: options.runtime });
  return app;
}

/** Validate controlled OIDC settings and start the executable server. */
export async function startApp(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const runtime = readHubRuntimeConfiguration(environment);
  if (runtime.legacyLabEnabled) {
    if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
    const app = await buildApp({ runtime });
    await app.listen({ host: '0.0.0.0', port: Number(environment.PORT ?? 3000) });
    return;
  }
  const { readOidcConfiguration, createOidcAuthenticator } = await import('./auth/oidc.js');
  const controlledConfig = readOidcConfiguration(environment);
  if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
  const [{ pool }, { createAuthService }] = await Promise.all([
    import('./db.js'),
    import('./auth/service.js'),
  ]);
  const authService = createAuthService({ pool });
  const [{ createSourceRegistryService, failClosedSecretResolver, failClosedEndpointAllowlist, failClosedCapabilityProbe }] = await Promise.all([
    import('./source-registry/service.js'),
  ]);
  const sourceService = createSourceRegistryService({ pool, auth: authService, secretResolver: failClosedSecretResolver,
    endpointAllowlist: failClosedEndpointAllowlist, capabilityProbe: failClosedCapabilityProbe });
  const identity = { authenticator: createOidcAuthenticator(controlledConfig, authService), authService };
  const sourceRegistry = { ...identity, sourceService };
  const app = await buildApp({ identity, sourceRegistry, runtime });
  await app.listen({ host: '0.0.0.0', port: Number(environment.PORT ?? 3000) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await startApp();
}
