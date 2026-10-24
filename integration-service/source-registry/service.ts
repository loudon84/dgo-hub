import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, SourceEntity, UserPrincipal } from '../auth/types.js';
import { validateEndpointProfile, type EndpointProfile, type ProbeEnvironment } from './capability-probe.js';

export type Connector = 'rest' | 'postgresql' | 'sqlserver';
export type SyncMode = 'FULL_SNAPSHOT' | 'INCREMENTAL';
export type VersionDomain = 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
export type SourceConfig = Readonly<{
  name: string;
  connector: Connector;
  mode: SyncMode;
  version_domain: VersionDomain;
  endpoint_allowlist_ref: string;
  secret_ref: string;
  allowed_entities: readonly SourceEntity[];
  delete_contract: 'tombstone' | 'hard_delete';
  endpoint_profile?: EndpointProfile;
}>;
export type FieldMapping = Readonly<{
  entity: SourceEntity;
  source_field: string;
  target_field: string;
  transform: 'identity' | 'trim' | 'decimal-string' | 'source-id';
}>;
export type IdentityMapping = Readonly<{
  entity: SourceEntity;
  external_id: string;
  target_id: string;
}>;

export type SecretResolver = Readonly<{
  isConfiguredReference(reference: string): boolean | Promise<boolean>;
  resolve(reference: string): Promise<string>;
}>;
export type EndpointAllowlist = Readonly<{
  resolve(reference: string): Promise<EndpointProfile>;
}>;
export type CapabilityProbe = Readonly<{
  run(input: Readonly<{ config: SourceConfig; endpoint: EndpointProfile; secret: string;
    mappings: readonly FieldMapping[]; identityMappings: readonly IdentityMapping[] }>): Promise<Readonly<{ passed: boolean; checks: readonly string[] }>>;
}>;
export type SourceRegistryDependencies = Readonly<{
  pool: Pool;
  auth: Pick<AuthService, 'repository'>;
  secretResolver: SecretResolver;
  endpointAllowlist: EndpointAllowlist;
  capabilityProbe: CapabilityProbe;
  environmentKind?: ProbeEnvironment['environmentKind'];
}>;

type RevisionRow = { revision: string | number; config_digest: Buffer; config: SourceConfig };
const ENTITY = new Set<SourceEntity>(['customer','order']);
const TRANSFORM = new Set<FieldMapping['transform']>(['identity','trim','decimal-string','source-id']);
const SECRET_REF = /^(?:vault|secret|env):\/[A-Za-z0-9._/-]{1,240}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function fail(code: ConstructorParameters<typeof AuthError>[0]): never { throw new AuthError(code); }
function requireScope(principal: UserPrincipal, scope: UserPrincipal['managementScopes'][number]): void {
  if (!principal.managementScopes.includes(scope)) fail('AUTH_FORBIDDEN');
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}
function digest(value: unknown): Buffer { return createHash('sha256').update(stable(value), 'utf8').digest(); }
function decimal(value: unknown): string {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) fail('AUTH_UNAVAILABLE');
  return text;
}
function parseConfig(input: unknown, stored = false): SourceConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
  const value = input as Record<string, unknown>;
  const allowed = ['name','connector','mode','version_domain','endpoint_allowlist_ref','secret_ref','allowed_entities','delete_contract'];
  if (Object.keys(value).some(key => !allowed.includes(key) && !(stored && key === 'endpoint_profile')) || typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 128 ||
      !['rest','postgresql','sqlserver'].includes(String(value.connector)) || !['FULL_SNAPSHOT','INCREMENTAL'].includes(String(value.mode)) ||
      !['SOURCE_VERSION','SNAPSHOT_OBSERVATION'].includes(String(value.version_domain)) ||
      typeof value.endpoint_allowlist_ref !== 'string' || !REF.test(value.endpoint_allowlist_ref) ||
      typeof value.secret_ref !== 'string' || !SECRET_REF.test(value.secret_ref) ||
      !Array.isArray(value.allowed_entities) || value.allowed_entities.length < 1 || value.allowed_entities.some(entity => !ENTITY.has(entity as SourceEntity)) ||
      new Set(value.allowed_entities).size !== value.allowed_entities.length || !['tombstone','hard_delete'].includes(String(value.delete_contract))) {
    fail('AUTH_INPUT_INVALID');
  }
  const connector = value.connector as Connector;
  const mode = value.mode as SyncMode;
  const domain = value.version_domain as VersionDomain;
  if ((connector === 'rest' && (mode !== 'INCREMENTAL' || domain !== 'SOURCE_VERSION')) ||
      (connector === 'postgresql' && mode === 'INCREMENTAL' && domain !== 'SOURCE_VERSION') ||
      (connector === 'postgresql' && mode === 'FULL_SNAPSHOT' && !['SOURCE_VERSION','SNAPSHOT_OBSERVATION'].includes(domain))) {
    fail('AUTH_INPUT_INVALID');
  }
  return Object.freeze({ name: value.name.trim(), connector, mode, version_domain: domain,
    endpoint_allowlist_ref: value.endpoint_allowlist_ref, secret_ref: value.secret_ref,
    allowed_entities: Object.freeze([...(value.allowed_entities as SourceEntity[])]), delete_contract: value.delete_contract as SourceConfig['delete_contract'],
    ...(stored && value.endpoint_profile ? { endpoint_profile: value.endpoint_profile as EndpointProfile } : {}) });
}
function parseMappings(input: unknown): readonly FieldMapping[] {
  if (!Array.isArray(input) || input.length > 500) fail('AUTH_INPUT_INVALID');
  const result = input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('AUTH_INPUT_INVALID');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).some(key => !['entity','source_field','target_field','transform'].includes(key)) ||
        !ENTITY.has(value.entity as SourceEntity) || typeof value.source_field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(value.source_field) ||
        typeof value.target_field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(value.target_field) || !TRANSFORM.has(value.transform as FieldMapping['transform'])) fail('AUTH_INPUT_INVALID');
    return Object.freeze(value as unknown as FieldMapping);
  });
  const keys = result.map(value => `${value.entity}\0${value.target_field}`);
  if (new Set(keys).size !== keys.length) fail('AUTH_INPUT_INVALID');
  return Object.freeze(result);
}
function parseIdentityMappings(input: unknown): readonly IdentityMapping[] {
  if (!Array.isArray(input) || input.length > 10000) fail('AUTH_INPUT_INVALID');
  const result = input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('AUTH_INPUT_INVALID');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).some(key => !['entity','external_id','target_id'].includes(key)) || !ENTITY.has(value.entity as SourceEntity) ||
        typeof value.external_id !== 'string' || value.external_id.length < 1 || value.external_id.length > 256 || /[\u0000-\u001f\u007f]/.test(value.external_id) ||
        typeof value.target_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.target_id)) fail('AUTH_INPUT_INVALID');
    return Object.freeze(value as unknown as IdentityMapping);
  });
  const keys = result.map(value => `${value.entity}\0${value.external_id}`);
  if (new Set(keys).size !== keys.length) fail('AUTH_INPUT_INVALID');
  return Object.freeze(result);
}
function safeSource(row: Record<string, unknown>) {
  return { source_id: row.source_id, name: row.name, connector: row.connector, mode: row.mode, version_domain: row.version_domain,
    allowed_entities: row.allowed_entities, lifecycle: row.lifecycle, revision: decimal(row.current_config_revision),
    mapping_revision: decimal(row.mapping_revision), identity_mapping_revision: decimal(row.identity_mapping_revision),
    data_owner_user_id: row.data_owner_user_id, owner_revision: decimal(row.owner_revision), updated_at: row.updated_at };
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); } catch { return fail('AUTH_UNAVAILABLE'); }
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AuthError) throw error;
    return fail('AUTH_UNAVAILABLE');
  } finally { client.release(); }
}

async function sourceRow(client: PoolClient, tenantId: string, sourceId: string, lock = false) {
  if (!SOURCE_ID.test(sourceId)) fail('AUTH_INPUT_INVALID');
  const result = await client.query<Record<string, unknown>>(
    `SELECT r.*,c.enabled AS credential_enabled,c.allowed_entities,c.revision AS credential_revision,c.source_epoch,
       cr.config_digest,cr.config,cr.config->>'name' AS name,cr.config->>'connector' AS connector,
       cr.config->>'mode' AS mode,cr.config->>'version_domain' AS version_domain
       FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
       JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
      WHERE r.tenant_key=$1 AND r.source_id=$2 ${lock ? 'FOR UPDATE OF r,c' : ''}`,
    [tenantId, sourceId],
  );
  if (!result.rowCount) fail('SOURCE_NOT_FOUND');
  return result.rows[0];
}

async function currentOwner(client: PoolClient, tenantId: string, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM control.tenant t JOIN control.auth_subject s USING(tenant_key)
      WHERE t.tenant_key=$1 AND s.user_id=$2 AND t.enabled AND s.enabled FOR UPDATE OF t,s`, [tenantId, userId],
  );
  if (!result.rowCount) fail('AUTH_FORBIDDEN');
}

async function loadMappings(client: PoolClient, tenantId: string, sourceId: string, mappingRevision: string, identityRevision: string) {
  const field = await client.query<{ mappings: FieldMapping[] }>('SELECT mappings FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3', [tenantId,sourceId,mappingRevision]);
  const identity = await client.query<{ mappings: IdentityMapping[] }>('SELECT mappings FROM control.source_identity_mapping_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3', [tenantId,sourceId,identityRevision]);
  if (!field.rowCount || !identity.rowCount) fail('SOURCE_NOT_FOUND');
  return { fieldMappings: field.rows[0].mappings, identityMappings: identity.rows[0].mappings };
}

export function createSourceRegistryService(deps: SourceRegistryDependencies) {
  const { pool, auth } = deps;
  const probeEnvironment: ProbeEnvironment = { environmentKind: deps.environmentKind ?? 'site' };

  async function configuredConfig(input: unknown): Promise<SourceConfig> {
    const config = parseConfig(input);
    const profile = await deps.endpointAllowlist.resolve(config.endpoint_allowlist_ref);
    validateEndpointProfile(config, profile, probeEnvironment);
    return Object.freeze({ ...config, endpoint_profile: profile });
  }

  async function list(principal: UserPrincipal) {
    requireScope(principal,'source:read');
    const result = await pool.query<Record<string, unknown>>(
      `SELECT r.source_id,cr.config->>'name' AS name,cr.config->>'connector' AS connector,cr.config->>'mode' AS mode,
        cr.config->>'version_domain' AS version_domain,c.allowed_entities,r.lifecycle,r.current_config_revision,
        r.mapping_revision,r.identity_mapping_revision,r.data_owner_user_id,r.owner_revision,r.updated_at
       FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
       JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
       WHERE r.tenant_key=$1 ORDER BY r.source_id`, [principal.tenantId],
    );
    return result.rows.map(safeSource);
  }

  async function get(principal: UserPrincipal, sourceId: string) {
    requireScope(principal,'source:read');
    return transaction(pool, async client => safeSource(await sourceRow(client, principal.tenantId, sourceId)));
  }

  async function create(principal: UserPrincipal, input: unknown) {
    requireScope(principal,'source:write');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !['source_id','data_owner_user_id','config'].includes(key)) || typeof body.source_id !== 'string' ||
        !SOURCE_ID.test(body.source_id) || typeof body.data_owner_user_id !== 'string') fail('AUTH_INPUT_INVALID');
    const config = await configuredConfig(body.config);
    if (!await deps.secretResolver.isConfiguredReference(config.secret_ref)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      await currentOwner(client, principal.tenantId, body.data_owner_user_id as string);
      const credential = await client.query<{ revision: string | number; enabled: boolean }>(
        'SELECT revision,enabled FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2 FOR UPDATE', [principal.tenantId,body.source_id],
      );
      if (!credential.rowCount) fail('SOURCE_NOT_FOUND');
      const initialDigest = digest([]);
      const idDigest = digest([]);
      const inserted = await client.query(
        `INSERT INTO control.source_registry(tenant_key,source_id,data_owner_user_id)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_id`, [principal.tenantId,body.source_id,body.data_owner_user_id],
      );
      if (!inserted.rowCount) fail('SOURCE_CONFLICT');
      await client.query(
        `INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
         VALUES($1,$2,1,$3,$4,$5)`, [principal.tenantId,body.source_id,digest(config),JSON.stringify(config),principal.userId],
      );
      await client.query(
        `INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
         VALUES($1,$2,1,$3,'[]',$4)`, [principal.tenantId,body.source_id,initialDigest,principal.userId],
      );
      await client.query(
        `INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
         VALUES($1,$2,1,$3,'[]',$4)`, [principal.tenantId,body.source_id,idDigest,principal.userId],
      );
      await auth.repository.updateSourceCredential(body.source_id as string, principal.tenantId, credential.rows[0].enabled,
        '1', config.allowed_entities, client, config.secret_ref);
      await client.query(
        `INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,new_state,owner_revision,details)
         VALUES($1,$2,$3,'OWNER_ASSIGNED','DRAFT',1,jsonb_build_object('old_owner',NULL,'new_owner',$4::text))`,
        [principal.tenantId,body.source_id,principal.userId,body.data_owner_user_id],
      );
      return { source_id: body.source_id, revision: '1', lifecycle: 'DRAFT', data_owner_user_id: body.data_owner_user_id };
    });
  }

  async function update(principal: UserPrincipal, sourceId: string, input: unknown) {
    requireScope(principal,'source:write');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !['expected_revision','config','data_owner_user_id'].includes(key)) ||
        typeof body.expected_revision !== 'string' || !/^[1-9][0-9]*$/.test(body.expected_revision) ||
        (body.data_owner_user_id !== undefined && typeof body.data_owner_user_id !== 'string')) fail('AUTH_INPUT_INVALID');
    const config = await configuredConfig(body.config);
    if (!await deps.secretResolver.isConfiguredReference(config.secret_ref)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      const currentRevision = decimal(row.current_config_revision);
      if (currentRevision !== body.expected_revision) fail('SOURCE_CONFLICT');
      const sameConfig = Buffer.from(row.config_digest as Buffer).equals(digest(config));
      const nextOwner = body.data_owner_user_id === undefined ? String(row.data_owner_user_id) : body.data_owner_user_id as string;
      const ownerChanged = nextOwner !== row.data_owner_user_id;
      if (ownerChanged) await currentOwner(client,principal.tenantId,nextOwner);
      const oldConfig = row.config as SourceConfig;
      const channelChanged = oldConfig.connector !== config.connector || oldConfig.mode !== config.mode || oldConfig.version_domain !== config.version_domain;
      if (channelChanged) {
        const active = await client.query(
          `SELECT 1 FROM control.source_channel WHERE tenant_key=$1 AND source_id=$2 AND state IN ('active','pending') LIMIT 1`,
          [principal.tenantId,sourceId],
        );
        if (active.rowCount) fail('SOURCE_SWITCH_UNAVAILABLE');
      }
      if (sameConfig && !ownerChanged) return safeSource(row);
      const nextRevision = (BigInt(currentRevision) + 1n).toString();
      const nextOwnerRevision = decimal(row.owner_revision) === '0' ? '1' : ownerChanged ? (BigInt(decimal(row.owner_revision)) + 1n).toString() : decimal(row.owner_revision);
      await client.query(
        `INSERT INTO control.source_config_revision(tenant_key,source_id,revision,config_digest,config,created_by)
         VALUES($1,$2,$3,$4,$5,$6)`, [principal.tenantId,sourceId,nextRevision,digest(config),JSON.stringify(config),principal.userId],
      );
      await client.query(
        `UPDATE control.source_registry SET current_config_revision=$3,data_owner_user_id=$4,owner_revision=$5,
           lifecycle=CASE WHEN lifecycle='ACTIVE' THEN 'PAUSED' ELSE 'DRAFT' END,updated_at=now()
         WHERE tenant_key=$1 AND source_id=$2`, [principal.tenantId,sourceId,nextRevision,nextOwner,nextOwnerRevision],
      );
      await auth.repository.updateSourceCredential(sourceId,principal.tenantId,Boolean(row.credential_enabled),nextRevision,
        config.allowed_entities,client,config.secret_ref);
      if (ownerChanged) await client.query(
        `INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,owner_revision,details)
         VALUES($1,$2,$3,'OWNER_REASSIGNED',$4,$5,$6,jsonb_build_object('old_owner',$7::text,'new_owner',$8::text))`,
        [principal.tenantId,sourceId,principal.userId,row.lifecycle,row.lifecycle === 'ACTIVE' ? 'PAUSED' : 'DRAFT',nextOwnerRevision,row.data_owner_user_id,nextOwner],
      );
      return { source_id: sourceId, revision: nextRevision, lifecycle: row.lifecycle === 'ACTIVE' ? 'PAUSED' : 'DRAFT', data_owner_user_id: nextOwner, owner_revision: nextOwnerRevision };
    });
  }

  async function mappings(principal: UserPrincipal, sourceId: string) {
    requireScope(principal,'source:read');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId);
      const data = await loadMappings(client,principal.tenantId,sourceId,decimal(row.mapping_revision),decimal(row.identity_mapping_revision));
      return { revision: decimal(row.mapping_revision), identity_mapping_revision: decimal(row.identity_mapping_revision),
        mappings: data.fieldMappings, identity_mappings: data.identityMappings };
    });
  }

  async function writeMappings(principal: UserPrincipal, sourceId: string, expected: unknown, input: unknown) {
    requireScope(principal,'mapping:write');
    if (typeof expected !== 'string' || !/^[1-9][0-9]*$/.test(expected)) fail('AUTH_INPUT_INVALID');
    const values = parseMappings(input);
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      const revision = decimal(row.mapping_revision);
      if (revision !== expected) fail('SOURCE_CONFLICT');
      const next = (BigInt(revision) + 1n).toString();
      await client.query(`INSERT INTO control.source_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,$2,$3,$4,$5,$6)`,[principal.tenantId,sourceId,next,digest(values),JSON.stringify(values),principal.userId]);
      await client.query(`UPDATE control.source_registry SET mapping_revision=$3,
        lifecycle=CASE WHEN lifecycle='ACTIVE' THEN 'PAUSED' ELSE 'DRAFT' END,updated_at=now()
        WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId,next]);
      await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
      return { revision: next, mappings: values };
    });
  }

  async function validateMappings(principal: UserPrincipal, sourceId: string, revisionInput: unknown) {
    requireScope(principal,'source:write');
    if (typeof revisionInput !== 'string' || !/^[1-9][0-9]*$/.test(revisionInput)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId);
      if (decimal(row.mapping_revision) !== revisionInput) fail('SOURCE_CONFLICT');
      const maps = await loadMappings(client,principal.tenantId,sourceId,revisionInput,decimal(row.identity_mapping_revision));
      const configuredEntities = row.allowed_entities as SourceEntity[];
      const unmappedEntities = configuredEntities.filter(entity => !maps.fieldMappings.some(mapping => mapping.entity === entity));
      return { revision: revisionInput, valid: unmappedEntities.length === 0, errors: unmappedEntities.map(entity => `MAPPING_REQUIRED:${entity}`) };
    });
  }

  async function writeIdentityMappings(principal: UserPrincipal, sourceId: string, input: unknown) {
    requireScope(principal,'source:approve');
    const values = parseIdentityMappings(input);
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if (row.data_owner_user_id !== principal.userId) fail('AUTH_FORBIDDEN');
      await currentOwner(client,principal.tenantId,principal.userId);
      const revision = (BigInt(decimal(row.identity_mapping_revision)) + 1n).toString();
      await client.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,$2,$3,$4,$5,$6)`,[principal.tenantId,sourceId,revision,digest(values),JSON.stringify(values),principal.userId]);
      await client.query(`UPDATE control.source_registry SET identity_mapping_revision=$3,
        lifecycle=CASE WHEN lifecycle='ACTIVE' THEN 'PAUSED' ELSE 'DRAFT' END,updated_at=now()
        WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId,revision]);
      await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
      return { revision, identity_mappings: values };
    });
  }

  async function test(principal: UserPrincipal, sourceId: string, expected: unknown) {
    requireScope(principal,'source:write');
    if (typeof expected !== 'string' || !/^[1-9][0-9]*$/.test(expected)) fail('AUTH_INPUT_INVALID');
    const snapshot = await transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if (decimal(row.current_config_revision) !== expected) fail('SOURCE_CONFLICT');
      const config = parseConfig(row.config, true);
      if (!config.endpoint_profile) fail('SOURCE_PROBE_UNAVAILABLE');
      const maps = await loadMappings(client,principal.tenantId,sourceId,decimal(row.mapping_revision),decimal(row.identity_mapping_revision));
      const configReport = await client.query<RevisionRow>(
        'SELECT revision,config_digest,config FROM control.source_config_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3',
        [principal.tenantId,sourceId,expected],
      );
      const mappingReport = await client.query<{ mapping_digest: Buffer }>(
        'SELECT mapping_digest FROM control.source_mapping_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3',
        [principal.tenantId,sourceId,row.mapping_revision],
      );
      const identityReport = await client.query<{ mapping_digest: Buffer }>(
        'SELECT mapping_digest FROM control.source_identity_mapping_revision WHERE tenant_key=$1 AND source_id=$2 AND revision=$3',
        [principal.tenantId,sourceId,row.identity_mapping_revision],
      );
      const credentialReport = await client.query<{ id: string; revision: string | number; enabled: boolean }>(
        'SELECT id,revision,enabled FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2',
        [principal.tenantId,sourceId],
      );
      return { row, config, maps, configRow: configReport.rows[0], mappingDigest: mappingReport.rows[0]?.mapping_digest,
        identityDigest: identityReport.rows[0]?.mapping_digest, credential: credentialReport.rows[0] };
    });
    const safeChecks: string[] = [];
    let passed = false;
    const unmappedEntities = snapshot.config.allowed_entities.filter(entity =>
      !snapshot.maps.fieldMappings.some(mapping => mapping.entity === entity));
    let reportCode = unmappedEntities.length ? 'MAPPING_REQUIRED' : 'SOURCE_PROBE_UNAVAILABLE';
    if (unmappedEntities.length) {
      safeChecks.push(...unmappedEntities.map(entity => `MAPPING_REQUIRED:${entity}`));
    } else {
      try {
        if (snapshot.config.connector === 'sqlserver') fail('SOURCE_PROBE_UNAVAILABLE');
        if (!snapshot.credential.enabled || decimal(snapshot.credential.revision) !== expected ||
            !await deps.secretResolver.isConfiguredReference(snapshot.config.secret_ref) ||
            !snapshot.config.endpoint_profile) fail('SOURCE_PROBE_UNAVAILABLE');
        const endpoint = await deps.endpointAllowlist.resolve(snapshot.config.endpoint_allowlist_ref);
        if (!digest(endpoint).equals(digest(snapshot.config.endpoint_profile))) fail('SOURCE_CONFLICT');
        const secret = await deps.secretResolver.resolve(snapshot.config.secret_ref);
        const result = await deps.capabilityProbe.run({ config: snapshot.config, endpoint, secret,
          mappings: snapshot.maps.fieldMappings, identityMappings: snapshot.maps.identityMappings });
        passed = result.passed;
        safeChecks.push(...result.checks.filter(value => /^[A-Z0-9_:-]{1,96}$/.test(value)).slice(0,32));
        reportCode = result.passed ? 'CAPABILITY_TEST_PASSED' : 'CAPABILITY_TEST_FAILED';
      } catch (error) {
        if (error instanceof AuthError && error.code === 'SOURCE_CONFLICT') throw error;
        if (!(error instanceof AuthError)) reportCode = 'CAPABILITY_TEST_FAILED';
        else reportCode = error.code;
      }
    }
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      const currentCredential = await client.query<{ id:string; revision:string|number; enabled:boolean; source_epoch:string|number }>(
        'SELECT id,revision,enabled,source_epoch FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2 FOR UPDATE',
        [principal.tenantId,sourceId],
      );
      if (decimal(row.current_config_revision) !== expected ||
          decimal(row.mapping_revision) !== decimal(snapshot.row.mapping_revision) ||
          decimal(row.identity_mapping_revision) !== decimal(snapshot.row.identity_mapping_revision) ||
          decimal(row.owner_revision) !== decimal(snapshot.row.owner_revision) || row.lifecycle !== snapshot.row.lifecycle ||
          !Buffer.from(row.config_digest as Buffer).equals(Buffer.from(snapshot.row.config_digest as Buffer)) ||
          !currentCredential.rowCount || currentCredential.rows[0].id !== snapshot.credential.id ||
          decimal(currentCredential.rows[0].revision) !== decimal(snapshot.credential.revision) ||
          currentCredential.rows[0].enabled !== snapshot.credential.enabled ||
          decimal(currentCredential.rows[0].source_epoch) !== decimal(snapshot.row.source_epoch)) fail('SOURCE_CONFLICT');
      const contractRef = `${sourceId}/config/${expected}/contract`;
      const id = await client.query<{ id: string }>(
        `INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,
          config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,data_contract_ref,report,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [principal.tenantId,sourceId,expected,row.mapping_revision,row.identity_mapping_revision,snapshot.configRow.config_digest,
         snapshot.mappingDigest,snapshot.identityDigest,expected,contractRef,JSON.stringify({ code:reportCode,checks:safeChecks }),passed?'PASS':'FAIL',principal.userId],
      );
      await client.query(`UPDATE control.source_registry SET lifecycle=$3,updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,
        [principal.tenantId,sourceId,passed?'TESTED':'DRAFT']);
      if (row.lifecycle === 'ACTIVE') await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
      await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,owner_revision,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,jsonb_build_object('test_report_id',$8::text))`,
        [principal.tenantId,sourceId,principal.userId,passed?'TEST_PASSED':'TEST_FAILED',row.lifecycle,passed?'TESTED':'DRAFT',row.owner_revision,id.rows[0].id]);
      return { test_report_id:id.rows[0].id,data_contract_ref:contractRef,status:passed?'PASS':'FAIL',report:{ code:reportCode,checks:safeChecks } };
    });
  }

  async function approve(principal: UserPrincipal, sourceId: string, reportId: unknown, dataContractRef: unknown) {
    requireScope(principal,'source:approve');
    if (typeof reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(reportId) || typeof dataContractRef !== 'string' || dataContractRef.length < 1 || dataContractRef.length > 256) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      await currentOwner(client,principal.tenantId,principal.userId);
      if (row.data_owner_user_id !== principal.userId) fail('AUTH_FORBIDDEN');
      const approval = await client.query<{ id: string }>(
        `INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
          identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,data_contract_ref,test_report_id)
         SELECT r.tenant_key,r.source_id,$3,r.owner_revision,r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,
           t.config_digest,t.mapping_digest,t.identity_mapping_digest,c.revision,t.data_contract_ref,t.id
          FROM control.source_registry r
          JOIN control.source_test_report t ON t.id=$4 AND t.tenant_key=r.tenant_key AND t.source_id=r.source_id
          JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(r.tenant_key,r.source_id)
         WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.data_owner_user_id=$3 AND t.status='PASS' AND t.data_contract_ref=$5
           AND (t.config_revision,t.mapping_revision,t.identity_mapping_revision,t.source_credential_revision)=
               (r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,c.revision)
           AND (t.config_digest,t.mapping_digest,t.identity_mapping_digest) = (
             SELECT cr.config_digest,m.mapping_digest,i.mapping_digest
             FROM control.source_config_revision cr
             JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
             JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
             WHERE (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision))
         RETURNING id`,[principal.tenantId,sourceId,principal.userId,reportId,dataContractRef],
      );
      if (!approval.rowCount) fail('SOURCE_CONFLICT');
      await client.query(`UPDATE control.source_registry SET lifecycle='APPROVED',updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId]);
      return { approval_id:approval.rows[0].id, owner_revision:decimal(row.owner_revision), status:'APPROVED' };
    });
  }

  async function activate(principal: UserPrincipal, sourceId: string, approvalId: unknown) {
    requireScope(principal,'source:write');
    if (typeof approvalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(approvalId)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if (row.lifecycle === 'ACTIVE') fail('SOURCE_CONFLICT');
      const owner = await client.query('SELECT enabled FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE',
        [principal.tenantId,row.data_owner_user_id]);
      if (!owner.rowCount || !owner.rows[0].enabled) fail('AUTH_FORBIDDEN');
      const approved = await client.query(
        `SELECT 1 FROM control.source_owner_approval a JOIN control.source_config_revision cr
           ON (cr.tenant_key,cr.source_id,cr.revision)=(a.tenant_key,a.source_id,a.config_revision)
          JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
          JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
          JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(a.tenant_key,a.source_id)
         WHERE a.id=$3 AND a.tenant_key=$1 AND a.source_id=$2 AND a.owner_user_id=$4
           AND (a.owner_revision,a.config_revision,a.mapping_revision,a.identity_mapping_revision,a.source_credential_revision)=
               ((SELECT owner_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT current_config_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT mapping_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT identity_mapping_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),c.revision)
           AND (a.config_digest,a.mapping_digest,a.identity_mapping_digest)=(cr.config_digest,m.mapping_digest,i.mapping_digest)
           AND c.enabled`,[principal.tenantId,sourceId,approvalId,row.data_owner_user_id],
      );
      if (!approved.rowCount) fail('SOURCE_CONFLICT');
      const config = row.config as SourceConfig;
      if (config.connector === 'sqlserver') fail('SOURCE_PROBE_UNAVAILABLE');
      for (const entity of config.allowed_entities) {
        const current = await client.query<{ id: string; connector: string; mode: string; version_domain: string; channel_epoch: string | number }>(
          `SELECT id,connector,mode,version_domain,channel_epoch FROM control.source_channel
            WHERE tenant_key=$1 AND source_id=$2 AND entity=$3 AND state='active' FOR UPDATE`,[principal.tenantId,sourceId,entity]);
        if (current.rowCount) {
          const channel = current.rows[0];
          if (channel.connector !== config.connector || channel.mode !== config.mode || channel.version_domain !== config.version_domain) fail('SOURCE_SWITCH_UNAVAILABLE');
          continue;
        }
        const last = await client.query<{ epoch: string | number | null }>(
          'SELECT max(channel_epoch)::text AS epoch FROM control.source_channel WHERE tenant_key=$1 AND source_id=$2 AND entity=$3',
          [principal.tenantId,sourceId,entity]);
        if (last.rows[0].epoch !== null) fail('SOURCE_SWITCH_UNAVAILABLE');
        await client.query(`INSERT INTO control.source_channel(tenant_key,source_id,entity,connector,mode,version_domain,channel_epoch,state)
          VALUES($1,$2,$3,$4,$5,$6,1,'active')`,[principal.tenantId,sourceId,entity,config.connector,config.mode,config.version_domain]);
      }
      await client.query(`UPDATE control.source_registry SET lifecycle='ACTIVE',updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId]);
      await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
      await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,owner_revision)
        VALUES($1,$2,$3,'ACTIVATED',$4,'ACTIVE',$5)`,[principal.tenantId,sourceId,principal.userId,row.lifecycle,row.owner_revision]);
      return { source_id:sourceId,lifecycle:'ACTIVE',revision:decimal(row.current_config_revision),channels:config.allowed_entities };
    });
  }

  async function pause(principal: UserPrincipal, sourceId: string, expectedRevision: unknown, reason: unknown) {
    requireScope(principal,'source:write');
    if (typeof expectedRevision !== 'string' || !/^[1-9][0-9]*$/.test(expectedRevision) || typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 256) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if (decimal(row.current_config_revision) !== expectedRevision) fail('SOURCE_CONFLICT');
      if (row.lifecycle !== 'PAUSED') {
        await client.query(`UPDATE control.source_registry SET lifecycle='PAUSED',updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId]);
        await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
        await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,details)
          VALUES($1,$2,$3,'PAUSED',$4,'PAUSED',jsonb_build_object('reason',$5::text))`,[principal.tenantId,sourceId,principal.userId,row.lifecycle,reason.trim()]);
      }
      return { source_id:sourceId,lifecycle:'PAUSED',revision:expectedRevision };
    });
  }

  async function identityMappings(principal: UserPrincipal, sourceId?: string) {
    requireScope(principal,'source:approve');
    const result = await pool.query<{ source_id:string;revision:string|number;mappings:IdentityMapping[];data_owner_user_id:string }>(
      `SELECT r.source_id,r.identity_mapping_revision AS revision,i.mappings,r.data_owner_user_id
       FROM control.source_registry r JOIN control.source_identity_mapping_revision i
       ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
       WHERE r.tenant_key=$1 AND ($2::text IS NULL OR r.source_id=$2) AND r.data_owner_user_id=$3 ORDER BY r.source_id`,
      [principal.tenantId,sourceId ?? null,principal.userId]);
    return result.rows.map(row => ({ source_id:row.source_id,revision:decimal(row.revision),identity_mappings:row.mappings.map(mapping => ({
      ...mapping,id:Buffer.from(`${row.source_id}\0${mapping.entity}\0${mapping.external_id}`,'utf8').toString('base64url'),
    })) }));
  }

  async function updateIdentityMapping(principal: UserPrincipal, sourceId: string, expected: string, targetId: string, reason: string) {
    requireScope(principal,'source:approve');
    if (!/^[1-9][0-9]*$/.test(expected) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId) ||
        typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 256) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const decoded = Buffer.from(sourceId,'base64url').toString('utf8').split('\0');
      if (decoded.length !== 3 || !SOURCE_ID.test(decoded[0]) || !ENTITY.has(decoded[1] as SourceEntity)) fail('AUTH_INPUT_INVALID');
      const [mappingSourceId, entity, externalId] = decoded;
      const row = await sourceRow(client,principal.tenantId,mappingSourceId,true);
      if (row.data_owner_user_id !== principal.userId) fail('AUTH_FORBIDDEN');
      await currentOwner(client,principal.tenantId,principal.userId);
      if (decimal(row.identity_mapping_revision) !== expected) fail('SOURCE_CONFLICT');
      const data = await loadMappings(client,principal.tenantId,mappingSourceId,decimal(row.mapping_revision),expected);
      if (!data.identityMappings.some(mapping => mapping.entity === entity && mapping.external_id === externalId)) fail('SOURCE_NOT_FOUND');
      const revised = data.identityMappings.map(mapping => mapping.entity === entity && mapping.external_id === externalId ? { ...mapping,target_id:targetId } : mapping);
      const revision = (BigInt(expected)+1n).toString();
      await client.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,$2,$3,$4,$5,$6)`,[principal.tenantId,mappingSourceId,revision,digest(revised),JSON.stringify(revised),principal.userId]);
      await client.query(`UPDATE control.source_registry SET identity_mapping_revision=$3,
        lifecycle=CASE WHEN lifecycle='ACTIVE' THEN 'PAUSED' ELSE 'DRAFT' END,updated_at=now()
        WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,mappingSourceId,revision]);
      await auth.repository.advanceSourceEpoch(mappingSourceId,principal.tenantId,client);
      await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,details)
        VALUES($1,$2,$3,'IDENTITY_MAPPING_CONFIRMED',jsonb_build_object('reason',$4::text,'revision',$5::text))`,[principal.tenantId,mappingSourceId,principal.userId,reason.trim(),revision]);
      return { source_id:mappingSourceId,revision,identity_mappings:revised };
    });
  }

  return Object.freeze({ list,get,create,update,mappings,writeMappings,validateMappings,writeIdentityMappings,test,approve,activate,pause,identityMappings,updateIdentityMapping });
}

export type SourceRegistryService = ReturnType<typeof createSourceRegistryService>;

export const failClosedSecretResolver: SecretResolver = Object.freeze({ isConfiguredReference: () => false, resolve: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
export const failClosedEndpointAllowlist: EndpointAllowlist = Object.freeze({ resolve: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
export const failClosedCapabilityProbe: CapabilityProbe = Object.freeze({ run: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
