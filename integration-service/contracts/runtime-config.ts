export type EnvironmentKind = 'local_lab' | 'site';

export type HubRuntimeConfiguration = Readonly<{
  environmentKind: EnvironmentKind;
  legacyLabEnabled: boolean;
  mcpAllowedOrigins: readonly string[];
}>;

export class RuntimeConfigurationError extends Error {
  readonly code = 'RUNTIME_CONFIG_INVALID';
  constructor() {
    super('RUNTIME_CONFIG_INVALID');
    this.name = 'RuntimeConfigurationError';
  }
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new RuntimeConfigurationError();
}

function parseOriginList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return [];
  const origins = value.split(',').map(part => part.trim());
  if (origins.some(origin => {
    try {
      const parsed = new URL(origin);
      return origin === '*' || parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '';
    } catch { return true; }
  }) || new Set(origins).size !== origins.length) throw new RuntimeConfigurationError();
  return Object.freeze(origins);
}

/** Read only when a process entry point starts; never call at module import time. */
export function readHubRuntimeConfiguration(environment: NodeJS.ProcessEnv = process.env): HubRuntimeConfiguration {
  const environmentKind = environment.HUB_ENVIRONMENT_KIND ?? 'site';
  if (environmentKind !== 'site' && environmentKind !== 'local_lab') throw new RuntimeConfigurationError();
  const legacyLabEnabled = parseBoolean(environment.HUB_ENABLE_LEGACY_LAB);
  if (environmentKind === 'site' && legacyLabEnabled) throw new RuntimeConfigurationError();
  return Object.freeze({
    environmentKind,
    legacyLabEnabled,
    mcpAllowedOrigins: parseOriginList(environment.HUB_MCP_ALLOWED_ORIGINS),
  });
}
