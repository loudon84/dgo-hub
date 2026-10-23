import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { AuthError } from './errors.js';
import type { AuthService, UserPrincipal } from './types.js';

export type OidcEnvironmentKind = 'local_lab' | 'site';

export type OidcConfiguration = Readonly<{
  issuer: string;
  audience: string;
  jwksUrl: string;
  environmentKind: OidcEnvironmentKind;
  allowLoopbackHttp?: boolean;
}>;

export type OidcAuthenticator = (token: string) => Promise<UserPrincipal>;

export class OidcConfigurationError extends Error {
  readonly code = 'AUTH_CONFIG_INVALID';

  constructor() {
    super('AUTH_CONFIG_INVALID');
    this.name = 'OidcConfigurationError';
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function safeUrl(value: string, configuration: OidcConfiguration): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new OidcConfigurationError(); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new OidcConfigurationError();
  }
  if (url.protocol === 'https:') return url;
  if (configuration.environmentKind !== 'local_lab' || configuration.allowLoopbackHttp !== true || !isLoopback(url.hostname)) {
    throw new OidcConfigurationError();
  }
  return url;
}

function validateConfiguration(configuration: OidcConfiguration): { issuer: string; audience: string; jwksUrl: URL } {
  if (!configuration || (configuration.environmentKind !== 'site' && configuration.environmentKind !== 'local_lab') ||
      typeof configuration.issuer !== 'string' || configuration.issuer.length < 1 || configuration.issuer.length > 2048 ||
      typeof configuration.audience !== 'string' || configuration.audience.trim().length < 1 || configuration.audience.length > 256 ||
      typeof configuration.jwksUrl !== 'string' || configuration.jwksUrl.length < 1 || configuration.jwksUrl.length > 2048 ||
      (configuration.allowLoopbackHttp !== undefined && typeof configuration.allowLoopbackHttp !== 'boolean') ||
      (configuration.environmentKind === 'site' && configuration.allowLoopbackHttp === true)) {
    throw new OidcConfigurationError();
  }
  safeUrl(configuration.issuer, configuration);
  const jwksUrl = safeUrl(configuration.jwksUrl, configuration);
  return { issuer: configuration.issuer, audience: configuration.audience, jwksUrl };
}

/** Read the explicitly named runtime settings. Nothing is read until this function is called. */
export function readOidcConfiguration(environment: NodeJS.ProcessEnv = process.env): OidcConfiguration {
  const environmentKind = environment.HUB_ENVIRONMENT_KIND ?? 'site';
  const allowText = environment.HUB_AUTH_ALLOW_LOOPBACK_HTTP ?? 'false';
  if ((environmentKind !== 'site' && environmentKind !== 'local_lab') || (allowText !== 'true' && allowText !== 'false')) {
    throw new OidcConfigurationError();
  }
  const configuration: OidcConfiguration = {
    issuer: environment.HUB_AUTH_ISSUER ?? '',
    audience: environment.HUB_AUTH_AUDIENCE ?? '',
    jwksUrl: environment.HUB_AUTH_JWKS_URL ?? '',
    environmentKind,
    allowLoopbackHttp: allowText === 'true',
  };
  validateConfiguration(configuration);
  return configuration;
}

export function createOidcAuthenticator(
  controlledConfig: OidcConfiguration,
  authService: Pick<AuthService, 'resolveOidc'>,
): OidcAuthenticator {
  const config = validateConfiguration(controlledConfig);
  const jwks = createRemoteJWKSet(config.jwksUrl, {
    timeoutDuration: 3_000,
    cooldownDuration: 250,
    cacheMaxAge: 60_000,
    [customFetch]: async (input, init) => {
      try {
        const response = await fetch(input, { ...init, redirect: 'manual' });
        if (!response.ok) throw new AuthError('AUTH_UNAVAILABLE');
        return response;
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError('AUTH_UNAVAILABLE');
      }
    },
  });

  return async (token: string): Promise<UserPrincipal> => {
    if (typeof token !== 'string' || token.length < 1 || token.length > 16_384) throw new AuthError('AUTH_INVALID');
    try {
      const header = decodeProtectedHeader(token);
      if ((header.alg !== 'RS256' && header.alg !== 'ES256') || header.jku !== undefined || header.x5u !== undefined) {
        throw new AuthError('AUTH_INVALID');
      }
      const { payload } = await jwtVerify(token, jwks, {
        algorithms: ['RS256', 'ES256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      });
      if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 2048) throw new AuthError('AUTH_INVALID');
      // Authorization facts in claims are deliberately ignored; the DB mapping is authoritative.
      return await authService.resolveOidc(config.issuer, payload.sub);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof errors.JOSEError) throw new AuthError('AUTH_INVALID');
      throw new AuthError('AUTH_INVALID');
    }
  };
}
