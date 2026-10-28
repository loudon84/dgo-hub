import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

function hasCredentialsOrSecretQuery(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some(isCredentialQueryName);
  } catch {
    return true;
  }
}

function isCredentialQueryName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases = new Set([
    'auth', 'authorization', 'credential', 'credentials', 'password', 'passwd', 'pass', 'pwd', 'passphrase',
    'user', 'username', 'userid', 'uid', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'secret',
    'clientsecret', 'clientid', 'apikey', 'accesskey',
  ]);
  return aliases.has(normalized) || /(?:auth|password|passwd|pwd|token|secret|credential|authorization|apikey|accesskey)/.test(normalized);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function hasProtocol(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const safeUrl = z.string().url().refine(value => !hasCredentialsOrSecretQuery(value), 'URL must not contain credentials or secret query parameters');
const secretRef = z.string().regex(/^(env|secret|vault):\/\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/, 'secret_ref must be a nonempty env://, secret://, or vault:// reference');
export const identityReferenceSchema = nonEmpty.refine(value => {
  if (/[\s?#]/.test(value) || /^(?:bearer|password|token)\s*:/i.test(value)) return false;
  if (/^[^/@:]+:[^/@]+@/.test(value)) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(isCredentialQueryName)) return false;
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !url.hostname) return false;
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return false;
      return true;
    } catch {
      return false;
    }
  }
  return true;
}, 'identity references cannot contain credentials');
const hostname = nonEmpty.refine(value => {
  try {
    const parsed = new URL(`https://${value}`);
    return parsed.hostname === value && !parsed.port && !value.includes('/');
  } catch {
    return false;
  }
}, 'tls_hostname must be a hostname without a scheme, path, or port');

const sourceSchema = z.object({
  source_id: nonEmpty,
  connection_mode: z.enum(['rest', 'postgresql', 'sqlserver']),
  endpoint: safeUrl,
  secret_ref: secretRef,
  mapping_ref: nonEmpty,
  replica_authorization_ref: nonEmpty,
  deletion_contract_ref: nonEmpty,
  read_only: z.boolean().optional(),
}).strict().superRefine((source, ctx) => {
  if (source.connection_mode !== 'rest' && source.read_only !== true) {
    ctx.addIssue({ code: 'custom', path: ['read_only'], message: 'Database sources must be read-only' });
  }
  const protocols = source.connection_mode === 'rest' ? ['http:', 'https:'] : source.connection_mode === 'postgresql' ? ['postgres:', 'postgresql:'] : ['mssql:'];
  if (!hasProtocol(source.endpoint, protocols)) {
    ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint protocol does not match connection_mode' });
  }
});

const importSourceSchema = z.object({
  source_id: nonEmpty,
  connection_mode: z.literal('SIMULATED_IMPORT'),
  mode: z.literal('INCREMENTAL'),
  version_domain: z.literal('SOURCE_VERSION'),
  allowed_entities: z.array(z.enum(['customer', 'order'])).min(1).refine(values => new Set(values).size === values.length, 'Entities must be unique'),
  delete_contract: z.literal('tombstone'),
  input_ref: nonEmpty,
  data_contract_ref: nonEmpty,
  version: nonEmpty,
  mapping_ref: nonEmpty,
  replica_authorization_ref: nonEmpty,
  deletion_contract_ref: nonEmpty,
}).strict();

const internalServiceProtocols: Record<string, string[]> = {
  hub_api: ['http:', 'https:'],
  sales_mcp: ['http:', 'https:'],
  hasura: ['http:', 'https:'],
  postgres: ['postgres:', 'postgresql:'],
  openmetadata: ['http:', 'https:'],
  helix: ['http:', 'https:'],
};

const internalServicesSchema = z.object({
  hub_api: safeUrl,
  sales_mcp: safeUrl,
  hasura: safeUrl,
  postgres: safeUrl,
  openmetadata: safeUrl,
  helix: safeUrl,
}).strict().superRefine((services, ctx) => {
  for (const [name, value] of Object.entries(services)) {
    if (!hasProtocol(value, internalServiceProtocols[name] ?? [])) {
      ctx.addIssue({ code: 'custom', path: [name], message: `Invalid protocol for ${name}` });
    }
  }
});

const testIdentitySchema = z.object({
  actor_ref: identityReferenceSchema,
  role: z.enum(['sales', 'sales_manager']),
  tenant_key: nonEmpty,
}).strict();

export const environmentInputSchema = z.object({
  schema_version: z.literal('alpha1.v1'),
  environment_kind: z.enum(['local_lab', 'site']),
  acceptance_level: z.enum(['platform', 'site']).optional(),
  tenant_key: nonEmpty,
  business_timezone: nonEmpty,
  idp: z.object({ issuer: safeUrl, audience: nonEmpty, jwks_uri: safeUrl }).strict(),
  sources: z.array(z.union([sourceSchema, importSourceSchema])).min(1),
  identity_mapping_ref: nonEmpty,
  tls_hostname: hostname,
  internal_services: internalServicesSchema,
  backup_ref: nonEmpty,
  hermes: z.object({ actual_version: nonEmpty }).strict().optional(),
  test_identities: z.array(testIdentitySchema).min(1),
  example: z.boolean(),
}).strict().superRefine((environment, ctx) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: environment.business_timezone });
  } catch {
    ctx.addIssue({ code: 'custom', path: ['business_timezone'], message: 'business_timezone must be a valid IANA timezone' });
  }

  const platform = environment.acceptance_level === 'platform';
  if (environment.environment_kind === 'local_lab' && environment.acceptance_level !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['acceptance_level'], message: 'Acceptance levels require a site environment' });
  }
  if (!platform && !environment.hermes) {
    ctx.addIssue({ code: 'custom', path: ['hermes'], message: 'Hermes version is required for legacy and site inputs' });
  }
  environment.sources.forEach((source, index) => {
    if (platform !== (source.connection_mode === 'SIMULATED_IMPORT')) {
      ctx.addIssue({ code: 'custom', path: ['sources', index, 'connection_mode'], message: 'Source type does not match acceptance level' });
    }
  });

  const ids = environment.sources.map(source => source.source_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'source_id values must be unique' });
  }

  const actors = environment.test_identities.map(identity => identity.actor_ref);
  if (new Set(actors).size !== actors.length) {
    ctx.addIssue({ code: 'custom', path: ['test_identities'], message: 'actor_ref values must be unique' });
  }
  environment.test_identities.forEach((identity, index) => {
    if (identity.tenant_key !== environment.tenant_key) {
      ctx.addIssue({ code: 'custom', path: ['test_identities', index, 'tenant_key'], message: 'Identity must be bound to the environment tenant' });
    }
  });

  if (environment.environment_kind === 'site') {
    for (const [path, value] of [
      [['idp', 'issuer'], environment.idp.issuer],
      [['idp', 'jwks_uri'], environment.idp.jwks_uri],
    ] as const) {
      if (!hasProtocol(value, ['https:'])) ctx.addIssue({ code: 'custom', path: [...path], message: 'Site identity provider URLs must use HTTPS' });
    }
    environment.sources.forEach((source, index) => {
      if (source.connection_mode === 'rest' && !hasProtocol(source.endpoint, ['https:'])) {
        ctx.addIssue({ code: 'custom', path: ['sources', index, 'endpoint'], message: 'Site REST sources must use HTTPS' });
      }
    });
    const salesCount = environment.test_identities.filter(identity => identity.role === 'sales').length;
    const managerCount = environment.test_identities.filter(identity => identity.role === 'sales_manager').length;
    if (salesCount < 2 || managerCount < 1) {
      ctx.addIssue({ code: 'custom', path: ['test_identities'], message: 'Site requires at least two sales users and one sales_manager' });
    }
    environment.test_identities.forEach((identity, index) => {
      if (/^synthetic:/i.test(identity.actor_ref)) {
        ctx.addIssue({ code: 'custom', path: ['test_identities', index, 'actor_ref'], message: 'Synthetic identities cannot satisfy site readiness' });
      }
    });
  } else {
    for (const [path, value] of [
      [['idp', 'issuer'], environment.idp.issuer],
      [['idp', 'jwks_uri'], environment.idp.jwks_uri],
    ] as const) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
          ctx.addIssue({ code: 'custom', path: [...path], message: 'Local lab identity provider URLs must use HTTPS or loopback HTTP' });
        }
      } catch { /* safeUrl already reports invalid URLs */ }
    }
  }
});

export type EnvironmentInput = z.infer<typeof environmentInputSchema>;
