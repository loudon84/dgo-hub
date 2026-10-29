import { createHash } from 'node:crypto';
import { customerReferenceMappingKey, importSamplesDigest, mapImportSample } from './import-sample.js';
import type { Pool, PoolClient } from 'pg';
import { AuthError } from '../auth/errors.js';
import type { AuthService, SourceEntity, UserPrincipal } from '../auth/types.js';
import { validateEndpointProfile, type EndpointProfile, type ProbeEnvironment } from './capability-probe.js';

export type Connector = 'rest' | 'postgresql' | 'sqlserver' | 'SIMULATED_IMPORT';
export type SyncMode = 'FULL_SNAPSHOT' | 'INCREMENTAL';
export type VersionDomain = 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
export type SourceConfig = Readonly<{
  name: string;
  connector: Connector;
  mode: SyncMode;
  version_domain: VersionDomain;
  endpoint_allowlist_ref?: string;
  secret_ref?: string;
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
  kind: 'user' | 'department' | 'customer';
  external_id: string;
  target_id: string | null;
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
  auth: Pick<AuthService, 'repository' | 'assertCurrentPrincipal'>;
  secretResolver: SecretResolver;
  endpointAllowlist: EndpointAllowlist;
  capabilityProbe: CapabilityProbe;
  environmentKind?: ProbeEnvironment['environmentKind'];
}>;

type RevisionRow = { revision: string | number; config_digest: Buffer; config: SourceConfig };
const ENTITY = new Set<SourceEntity>(['customer','order']);
const TRANSFORM = new Set<FieldMapping['transform']>(['identity','trim','decimal-string','source-id']);
const TARGET_FIELDS: Readonly<Record<SourceEntity, ReadonlySet<string>>> = {
  customer:new Set(['customer_name','owner_user_id','dept_id','status','phone','source_updated_at','source_version','deleted_at']),
  order:new Set(['customer_id','order_no','status','order_at','amount','currency','source_updated_at','source_version','deleted_at']),
};
const POSTGRES_ORDER_LINE_TARGETS = ['lines.source_line_id','lines.product_code','lines.product_name','lines.quantity','lines.unit_price','lines.line_amount'] as const;
const REQUIRED_TARGET_FIELDS: Readonly<Record<SourceEntity, readonly string[]>> = {
  customer:['customer_name','owner_user_id','dept_id','status'],
  order:['customer_id','order_no','status','order_at','amount','currency'],
};
const SECRET_REF = /^(?:vault|secret|env):\/[A-Za-z0-9._/-]{1,240}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

// A source test finalizes its report and event together under the source lock.
// Select the last test event before validating it; never skip a bad last event.
const CURRENT_TEST_EVENT = `EXISTS (
  SELECT 1 FROM control.source_lifecycle_event latest
  WHERE (latest.tenant_key,latest.source_id)=(t.tenant_key,t.source_id)
    AND latest.id=(SELECT max(e.id) FROM control.source_lifecycle_event e
      WHERE (e.tenant_key,e.source_id)=(t.tenant_key,t.source_id) AND e.action IN ('TEST_PASSED','TEST_FAILED'))
    AND latest.action='TEST_PASSED' AND latest.details->>'test_report_id'=t.id::text
    AND NOT EXISTS (SELECT 1 FROM control.source_lifecycle_event duplicate
      WHERE (duplicate.tenant_key,duplicate.source_id)=(t.tenant_key,t.source_id)
        AND duplicate.id<>latest.id AND duplicate.action IN ('TEST_PASSED','TEST_FAILED')
        AND duplicate.details->>'test_report_id'=t.id::text)
)`;

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
function encodeSourceCustomerCursor(sourceId:string,sourcePk:string):string { return Buffer.from(`${sourceId}\0${sourcePk}`,'utf8').toString('base64url'); }
function decodeSourceCustomerCursor(sourceId:string,cursor:unknown):string|undefined {
  if(cursor===undefined) return undefined;
  if(typeof cursor!=='string'||cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor)) fail('AUTH_INPUT_INVALID');
  const decoded=Buffer.from(cursor,'base64url').toString('utf8');
  if(Buffer.from(decoded,'utf8').toString('base64url')!==cursor) fail('AUTH_INPUT_INVALID');
  const split=decoded.indexOf('\0');
  if(split<1||decoded.slice(0,split)!==sourceId||split===decoded.length-1) fail('AUTH_INPUT_INVALID');
  return decoded.slice(split+1);
}
function decimal(value: unknown): string {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) fail('AUTH_UNAVAILABLE');
  return text;
}
function parseConfig(input: unknown, stored = false): SourceConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
  const value = input as Record<string, unknown>;
  const allowed = ['name','connector','mode','version_domain','endpoint_allowlist_ref','secret_ref','allowed_entities','delete_contract'];
  if (value.connector === 'SIMULATED_IMPORT') {
    if (Object.keys(value).some(k => !['name','connector','mode','version_domain','allowed_entities','delete_contract'].includes(k)) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length>128 || value.mode!=='INCREMENTAL' || value.version_domain!=='SOURCE_VERSION' || value.delete_contract!=='tombstone' ||
      !Array.isArray(value.allowed_entities) || !value.allowed_entities.length || value.allowed_entities.some(e=>!ENTITY.has(e as SourceEntity)) || new Set(value.allowed_entities).size!==value.allowed_entities.length) fail('AUTH_INPUT_INVALID');
    return Object.freeze({name:value.name.trim(),connector:'SIMULATED_IMPORT',mode:'INCREMENTAL',version_domain:'SOURCE_VERSION',allowed_entities:Object.freeze([...(value.allowed_entities as SourceEntity[])]),delete_contract:'tombstone'});
  }
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
function mappingContractErrors(entities: readonly SourceEntity[], mappings: readonly FieldMapping[], postgresSnapshot = false): string[] {
  const errors:string[]=[];
  for(const entity of entities) {
    const entityMappings=mappings.filter(mapping=>mapping.entity===entity);
    for(const mapping of entityMappings) {
      if(!TARGET_FIELDS[entity].has(mapping.target_field) && !(postgresSnapshot && entity==='order' && POSTGRES_ORDER_LINE_TARGETS.includes(mapping.target_field as typeof POSTGRES_ORDER_LINE_TARGETS[number])))
        errors.push(`MAPPING_TARGET_UNSUPPORTED:${entity}:${mapping.target_field}`);
      else if((mapping.target_field==='amount' || mapping.target_field.startsWith('lines.') &&
          ['lines.quantity','lines.unit_price','lines.line_amount'].includes(mapping.target_field)) && mapping.transform!=='decimal-string')
        errors.push(`MAPPING_TRANSFORM_INVALID:${entity}:${mapping.target_field}`);
      else if(mapping.target_field!=='amount' && !['lines.quantity','lines.unit_price','lines.line_amount'].includes(mapping.target_field) &&
          mapping.transform==='decimal-string') errors.push(`MAPPING_TRANSFORM_INVALID:${entity}:${mapping.target_field}`);
      else if(['customer_name','phone','order_no','status','currency'].includes(mapping.target_field) &&
        !['identity','trim'].includes(mapping.transform)) errors.push(`MAPPING_TRANSFORM_INVALID:${entity}:${mapping.target_field}`);
      else if(['owner_user_id','dept_id','customer_id','lines.source_line_id'].includes(mapping.target_field) && mapping.transform!=='source-id' && mapping.transform!=='identity')
        errors.push(`MAPPING_TRANSFORM_INVALID:${entity}:${mapping.target_field}`);
      else if(['lines.product_code','lines.product_name'].includes(mapping.target_field) && !['identity','trim'].includes(mapping.transform))
        errors.push(`MAPPING_TRANSFORM_INVALID:${entity}:${mapping.target_field}`);
    }
    const targets=new Set(entityMappings.map(mapping=>mapping.target_field));
    for(const required of REQUIRED_TARGET_FIELDS[entity]) if(!targets.has(required)) errors.push(`MAPPING_REQUIRED:${entity}:${required}`);
    if(postgresSnapshot && entity==='order') for(const required of POSTGRES_ORDER_LINE_TARGETS)
      if(!targets.has(required)) errors.push(`MAPPING_REQUIRED:${entity}:${required}`);
  }
  return errors;
}
function parseIdentityMappings(input: unknown): readonly IdentityMapping[] {
  if (!Array.isArray(input) || input.length > 10000) fail('AUTH_INPUT_INVALID');
  const result = input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('AUTH_INPUT_INVALID');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).some(key => !['kind','external_id','target_id'].includes(key)) || !['user','department','customer'].includes(String(value.kind)) ||
        typeof value.external_id !== 'string' || value.external_id.length < 1 || value.external_id.length > 256 || /[\u0000-\u001f\u007f]/.test(value.external_id) ||
        (value.target_id!==null && (typeof value.target_id !== 'string' || value.target_id.length<1 || value.target_id.length>256 || /[\u0000-\u001f\u007f]/.test(value.target_id)))) fail('AUTH_INPUT_INVALID');
    return Object.freeze(value as unknown as IdentityMapping);
  });
  const keys = result.map(value => `${value.kind}\0${value.external_id}`);
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
  if (lock) {
    await client.query('SELECT control.lock_security_barrier_fence()');
    await client.query('SELECT * FROM control.lock_source_credential($1,$2)',[tenantId,sourceId]);
  }
  const result = await client.query<Record<string, unknown>>(
    `SELECT r.*,c.enabled AS credential_enabled,c.allowed_entities,c.revision AS credential_revision,c.source_epoch,
       cr.config_digest,cr.config,cr.config->>'name' AS name,cr.config->>'connector' AS connector,
       cr.config->>'mode' AS mode,cr.config->>'version_domain' AS version_domain
       FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
       JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
      WHERE r.tenant_key=$1 AND r.source_id=$2 ${lock ? 'FOR UPDATE OF r' : ''}`,
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
    if (config.connector === 'SIMULATED_IMPORT') return config;
    const profile = await deps.endpointAllowlist.resolve(config.endpoint_allowlist_ref!);
    validateEndpointProfile(config, profile, probeEnvironment);
    return Object.freeze({ ...config, endpoint_profile: profile });
  }

  async function list(principal: UserPrincipal) {
    requireScope(principal,'source:read');
    return transaction(pool,async client=>{
      await client.query('SELECT control.lock_security_barrier_fence()');
      const result=await client.query<Record<string,unknown>>(`SELECT r.source_id,cr.config->>'name' AS name,cr.config->>'connector' AS connector,cr.config->>'mode' AS mode,
        cr.config->>'version_domain' AS version_domain,c.allowed_entities,r.lifecycle,r.current_config_revision,
        r.mapping_revision,r.identity_mapping_revision,r.data_owner_user_id,r.owner_revision,r.updated_at
       FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
       JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
       WHERE r.tenant_key=$1 ORDER BY r.source_id`,[principal.tenantId]);
      if(result.rows.some(row=>row.connector==='SIMULATED_IMPORT')) await auth.assertCurrentPrincipal(principal,'source:read',client);
      return result.rows.map(safeSource);
    });
  }

  async function get(principal: UserPrincipal, sourceId: string) {
    requireScope(principal,'source:read');
    return transaction(pool, async client => { const row=await sourceRow(client,principal.tenantId,sourceId,true); if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:read',client); return safeSource(row); });
  }

  async function create(principal: UserPrincipal, input: unknown) {
    requireScope(principal,'source:write');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !['source_id','data_owner_user_id','config'].includes(key)) || typeof body.source_id !== 'string' ||
        !SOURCE_ID.test(body.source_id) || typeof body.data_owner_user_id !== 'string') fail('AUTH_INPUT_INVALID');
    const config = await configuredConfig(body.config);
    if (config.connector !== 'SIMULATED_IMPORT' && !await deps.secretResolver.isConfiguredReference(config.secret_ref!)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      await client.query('SELECT control.lock_security_barrier_fence()');
      if (config.connector === 'SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      await currentOwner(client, principal.tenantId, body.data_owner_user_id as string);
      if (config.connector === 'SIMULATED_IMPORT') {
        await auth.repository.provisionImportAuthority(body.source_id as string,principal.tenantId,config.allowed_entities,client);
      }
      const credential = await client.query<{ revision: string | number; enabled: boolean }>(
        'SELECT revision,enabled FROM control.lock_source_credential($1,$2)', [principal.tenantId,body.source_id],
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
    if (config.connector !== 'SIMULATED_IMPORT' && !await deps.secretResolver.isConfiguredReference(config.secret_ref!)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      const currentRevision = decimal(row.current_config_revision);
      if (currentRevision !== body.expected_revision) fail('SOURCE_CONFLICT');
      const sameConfig = Buffer.from(row.config_digest as Buffer).equals(digest(config));
      const nextOwner = body.data_owner_user_id === undefined ? String(row.data_owner_user_id) : body.data_owner_user_id as string;
      const ownerChanged = nextOwner !== row.data_owner_user_id;
      if (ownerChanged) await currentOwner(client,principal.tenantId,nextOwner);
      const oldConfig = row.config as SourceConfig;
      if ((oldConfig.connector === 'SIMULATED_IMPORT') !== (config.connector === 'SIMULATED_IMPORT')) fail('SOURCE_SWITCH_UNAVAILABLE');
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
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:read',client);
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
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'mapping:write',client);
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
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      if (decimal(row.mapping_revision) !== revisionInput) fail('SOURCE_CONFLICT');
      const maps = await loadMappings(client,principal.tenantId,sourceId,revisionInput,decimal(row.identity_mapping_revision));
      const configuredEntities = row.allowed_entities as SourceEntity[];
      const errors=mappingContractErrors(configuredEntities,maps.fieldMappings,row.connector==='postgresql' || row.connector==='SIMULATED_IMPORT');
      return { revision: revisionInput, valid: errors.length === 0, errors };
    });
  }

  async function writeIdentityMappings(principal: UserPrincipal, sourceId: string, input: unknown) {
    requireScope(principal,'source:approve');
    const values = parseIdentityMappings(input);
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:approve',client);
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

  async function testBodyLimit(principal:UserPrincipal,sourceId:string):Promise<number> {
    requireScope(principal,'source:write');
    return transaction(pool,async client=>{
      const row=await sourceRow(client,principal.tenantId,sourceId,true);
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      return row.connector==='SIMULATED_IMPORT'?4*1024*1024:2*1024*1024;
    });
  }

  async function test(principal: UserPrincipal, sourceId: string, expected: unknown, samples?: unknown) {
    requireScope(principal,'source:write');
    if (typeof expected !== 'string' || !/^[1-9][0-9]*$/.test(expected)) fail('AUTH_INPUT_INVALID');
    if (samples !== undefined) return testImport(principal,sourceId,expected,samples);
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
      const credentialReport = await client.query<{ id: string; revision: string | number; enabled: boolean; credential_generation:string|number }>(
        'SELECT id,revision,enabled,credential_generation FROM control.source_credential WHERE tenant_key=$1 AND source_id=$2',
        [principal.tenantId,sourceId],
      );
      return { row, config, maps, configRow: configReport.rows[0], mappingDigest: mappingReport.rows[0]?.mapping_digest,
        identityDigest: identityReport.rows[0]?.mapping_digest, credential: credentialReport.rows[0],
        endpointDigest:digest(config.endpoint_profile) };
    });
    const safeChecks: string[] = [];
    let passed = false;
    const mappingErrors=mappingContractErrors(snapshot.config.allowed_entities,snapshot.maps.fieldMappings,snapshot.config.connector==='postgresql');
    let reportCode = mappingErrors.length ? 'MAPPING_CONTRACT_INVALID' : 'SOURCE_PROBE_UNAVAILABLE';
    if (mappingErrors.length) {
      safeChecks.push(...mappingErrors);
    } else {
      try {
        if (snapshot.config.connector === 'sqlserver') fail('SOURCE_PROBE_UNAVAILABLE');
        if (!snapshot.credential.enabled || decimal(snapshot.credential.revision) !== expected ||
            !await deps.secretResolver.isConfiguredReference(snapshot.config.secret_ref!) ||
            !snapshot.config.endpoint_profile) fail('SOURCE_PROBE_UNAVAILABLE');
        const endpoint = await deps.endpointAllowlist.resolve(snapshot.config.endpoint_allowlist_ref!);
        if (!digest(endpoint).equals(digest(snapshot.config.endpoint_profile))) fail('SOURCE_CONFLICT');
        const secret = await deps.secretResolver.resolve(snapshot.config.secret_ref!);
        const result = await deps.capabilityProbe.run({ config: snapshot.config, endpoint, secret,
          mappings: snapshot.maps.fieldMappings, identityMappings: snapshot.maps.identityMappings });
        passed = result.passed;
        safeChecks.push(...result.checks.filter(value => /^[A-Z0-9_:-]{1,96}$/.test(value)).slice(0,32));
        reportCode = result.passed ? 'CAPABILITY_TEST_PASSED' : 'CAPABILITY_TEST_FAILED';
        const afterProbe=await deps.endpointAllowlist.resolve(snapshot.config.endpoint_allowlist_ref!);
        if (!digest(afterProbe).equals(snapshot.endpointDigest)) fail('SOURCE_CONFLICT');
      } catch (error) {
        if (error instanceof AuthError && error.code === 'SOURCE_CONFLICT') throw error;
        if (!(error instanceof AuthError)) reportCode = 'CAPABILITY_TEST_FAILED';
        else reportCode = error.code;
      }
    }
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      const currentCredential = await client.query<{ id:string; revision:string|number; enabled:boolean; source_epoch:string|number; credential_generation:string|number }>(
        'SELECT c.id,c.revision,c.enabled,c.source_epoch,c.credential_generation FROM control.lock_source_credential($1,$2) c',
        [principal.tenantId,sourceId],
      );
      if (decimal(row.current_config_revision) !== expected ||
          decimal(row.mapping_revision) !== decimal(snapshot.row.mapping_revision) ||
          decimal(row.identity_mapping_revision) !== decimal(snapshot.row.identity_mapping_revision) ||
          decimal(row.owner_revision) !== decimal(snapshot.row.owner_revision) || row.lifecycle !== snapshot.row.lifecycle ||
          !Buffer.from(row.config_digest as Buffer).equals(Buffer.from(snapshot.row.config_digest as Buffer)) ||
          !currentCredential.rowCount || currentCredential.rows[0].id !== snapshot.credential.id ||
          decimal(currentCredential.rows[0].revision) !== decimal(snapshot.credential.revision) ||
          decimal(currentCredential.rows[0].credential_generation) !== decimal(snapshot.credential.credential_generation) ||
          currentCredential.rows[0].enabled !== snapshot.credential.enabled ||
          decimal(currentCredential.rows[0].source_epoch) !== decimal(snapshot.row.source_epoch)) fail('SOURCE_CONFLICT');
      const contractRef = `${sourceId}/config/${expected}/contract`;
      const id = await client.query<{ id: string }>(
        `INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,
          config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,endpoint_profile_digest,
          data_contract_ref,report,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [principal.tenantId,sourceId,expected,row.mapping_revision,row.identity_mapping_revision,snapshot.configRow.config_digest,
         snapshot.mappingDigest,snapshot.identityDigest,expected,snapshot.credential.credential_generation,snapshot.endpointDigest,
         contractRef,JSON.stringify({ code:reportCode,checks:safeChecks }),passed?'PASS':'FAIL',principal.userId],
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

  async function testImport(principal: UserPrincipal, sourceId: string, expected: string, input: unknown) {
    if (!input || typeof input!=='object' || Array.isArray(input)) fail('AUTH_INPUT_INVALID');
    const samples=input as Record<string,unknown>;
    return transaction(pool,async client=>{
      const row=await sourceRow(client,principal.tenantId,sourceId,true);
      await auth.assertCurrentPrincipal(principal,'source:write',client);
      await currentOwner(client,principal.tenantId,String(row.data_owner_user_id));
      const config=parseConfig(row.config,true);
      if(config.connector!=='SIMULATED_IMPORT' || decimal(row.current_config_revision)!==expected) fail('SOURCE_CONFLICT');
      const keys=Object.keys(samples).sort(), entities=[...config.allowed_entities].sort();
      if(keys.length!==entities.length || keys.some((key,i)=>key!==entities[i] || typeof samples[key]!=='string')) fail('AUTH_INPUT_INVALID');
      const maps=await loadMappings(client,principal.tenantId,sourceId,decimal(row.mapping_revision),decimal(row.identity_mapping_revision));
      const errors=mappingContractErrors(entities,maps.fieldMappings,true);
      let passed=errors.length===0;
      const consumedCustomers:Array<{source_id:string;source_pk:string;target_id:string}>=[];
      if(passed) {
        try {
          const customerKeys=new Set<string>();
          if(entities.includes('customer')) {
            const customerBatch=mapImportSample(samples.customer as string,'customer',sourceId,maps.fieldMappings);
            for(const record of customerBatch.records) if(record.operation==='UPSERT') customerKeys.add(record.source_pk);
          }
          for(const entity of entities) {
            const batch=mapImportSample(samples[entity] as string,entity,sourceId,maps.fieldMappings);
            if(entity==='order') for(const record of batch.records) if(record.operation==='UPSERT' && record.data && 'customer_ref' in record.data) {
              const ref=record.data.customer_ref;
              if(ref.source_id!==sourceId || !customerKeys.has(ref.source_pk)) {
                const key=customerReferenceMappingKey(ref.source_id,ref.source_pk);
                const mapping=maps.identityMappings.find(m=>m.kind==='customer' && m.external_id===key && m.target_id);
                if(!mapping) throw new Error('MISSING_CUSTOMER_MAPPING');
                const target=await client.query<{ok:boolean}>('SELECT control.lock_import_customer($1,$2,$3,$4) AS ok',[principal.tenantId,ref.source_id,ref.source_pk,mapping.target_id]);
                if(!target.rows[0]?.ok) throw new Error('MISSING_CUSTOMER_MAPPING');
                consumedCustomers.push({source_id:ref.source_id,source_pk:ref.source_pk,target_id:mapping.target_id!});
              }
            }
            if(entity==='customer') for(const record of batch.records) if(record.operation==='UPSERT' && record.data && 'owner_external_id' in record.data) {
              for(const [kind,external] of [['user',record.data.owner_external_id],['department',record.data.department_external_id]] as const) {
                const mapping=maps.identityMappings.find(m=>m.kind===kind && m.external_id===external && m.target_id);
                if(!mapping) throw new Error('MISSING_IDENTITY');
                const target=kind==='user' ? await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 AND enabled FOR UPDATE',[principal.tenantId,mapping.target_id]) :
                  await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND department_id=$2 AND enabled LIMIT 1 FOR UPDATE',[principal.tenantId,mapping.target_id]);
                if(!target.rowCount) throw new Error('MISSING_IDENTITY');
              }
            }
          }
        } catch { passed=false; errors.push('SAMPLE_INVALID'); }
      }
      const sampleDigest=importSamplesDigest(samples as Record<string,string>);
      const contractRef=`${sourceId}/config/${expected}/contract`;
      const inserted=await client.query<{id:string}>(`INSERT INTO control.source_test_report(tenant_key,source_id,config_revision,mapping_revision,identity_mapping_revision,
        config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,endpoint_profile_digest,sample_digest,data_contract_ref,report,status,created_by,sample_customer_refs)
        SELECT r.tenant_key,r.source_id,r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,cr.config_digest,m.mapping_digest,i.mapping_digest,c.revision,c.credential_generation,NULL,$3,$4,$5,$6,$7,$8::jsonb
        FROM control.source_registry r JOIN control.source_credential c USING(tenant_key,source_id)
        JOIN control.source_config_revision cr ON (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
        JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
        JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
        WHERE r.tenant_key=$1 AND r.source_id=$2 AND c.enabled RETURNING id`,[principal.tenantId,sourceId,sampleDigest,contractRef,JSON.stringify({code:passed?'SAMPLE_VALID':'SAMPLE_INVALID',checks:errors}),passed?'PASS':'FAIL',principal.userId,JSON.stringify(passed?consumedCustomers:[])]);
      if(!inserted.rowCount) fail('SOURCE_CONFLICT');
      await client.query(`UPDATE control.source_registry SET lifecycle=$3,updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId,passed?'TESTED':'DRAFT']);
      if(row.lifecycle==='ACTIVE') await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
      await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,owner_revision,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,jsonb_build_object('test_report_id',$8::text))`,[principal.tenantId,sourceId,principal.userId,passed?'TEST_PASSED':'TEST_FAILED',row.lifecycle,passed?'TESTED':'DRAFT',row.owner_revision,inserted.rows[0].id]);
      return {test_report_id:inserted.rows[0].id,data_contract_ref:contractRef,status:passed?'PASS':'FAIL',report:{code:passed?'SAMPLE_VALID':'SAMPLE_INVALID',checks:errors}};
    });
  }

  async function approve(principal: UserPrincipal, sourceId: string, expected: unknown, reportId: unknown, dataContractRef: unknown) {
    requireScope(principal,'source:approve');
    if (typeof expected !== 'string' || !/^[1-9][0-9]*$/.test(expected) || typeof reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(reportId) || typeof dataContractRef !== 'string' || dataContractRef.length < 1 || dataContractRef.length > 256) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      if(decimal(row.current_config_revision)!==expected || row.lifecycle!=='TESTED') fail('SOURCE_CONFLICT');
      if (row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:approve',client);
      await currentOwner(client,principal.tenantId,principal.userId);
      if (row.data_owner_user_id !== principal.userId) fail('AUTH_FORBIDDEN');
      const config=parseConfig(row.config,true);
      let profileDigest:Buffer|null=null;
      if(config.connector!=='SIMULATED_IMPORT') {
        if(!config.endpoint_profile) fail('SOURCE_PROBE_UNAVAILABLE');
        const profile=await deps.endpointAllowlist.resolve(config.endpoint_allowlist_ref!);
        validateEndpointProfile(config,profile,probeEnvironment);
        profileDigest=digest(profile);
        if(!profileDigest.equals(digest(config.endpoint_profile))) fail('SOURCE_CONFLICT');
      }
      const approval = await client.query<{ id: string }>(
        `INSERT INTO control.source_owner_approval(tenant_key,source_id,owner_user_id,owner_revision,config_revision,mapping_revision,
          identity_mapping_revision,config_digest,mapping_digest,identity_mapping_digest,source_credential_revision,credential_generation,
          endpoint_profile_digest${config.connector==='SIMULATED_IMPORT'?',sample_digest':''},data_contract_ref,test_report_id)
         SELECT r.tenant_key,r.source_id,$3,r.owner_revision,r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,
           t.config_digest,t.mapping_digest,t.identity_mapping_digest,c.revision,c.credential_generation,t.endpoint_profile_digest${config.connector==='SIMULATED_IMPORT'?',t.sample_digest':''},t.data_contract_ref,t.id
          FROM control.source_registry r
          JOIN control.source_test_report t ON t.id=$4 AND t.tenant_key=r.tenant_key AND t.source_id=r.source_id
          JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(r.tenant_key,r.source_id)
          JOIN control.source_config_revision cr_import ON (cr_import.tenant_key,cr_import.source_id,cr_import.revision)=(r.tenant_key,r.source_id,r.current_config_revision)
         WHERE r.tenant_key=$1 AND r.source_id=$2 AND r.data_owner_user_id=$3 AND t.status='PASS' AND t.data_contract_ref=$5
           AND (t.config_revision,t.mapping_revision,t.identity_mapping_revision,t.source_credential_revision,t.credential_generation)=
               (r.current_config_revision,r.mapping_revision,r.identity_mapping_revision,c.revision,c.credential_generation)
           ${config.connector==='SIMULATED_IMPORT' ? 'AND t.endpoint_profile_digest IS NULL AND t.sample_digest IS NOT NULL AND $6::bytea IS NULL' : 'AND t.endpoint_profile_digest=$6'}
           AND ${CURRENT_TEST_EVENT}
           AND (t.config_digest,t.mapping_digest,t.identity_mapping_digest) = (
             SELECT cr.config_digest,m.mapping_digest,i.mapping_digest
             FROM control.source_config_revision cr
             JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(r.tenant_key,r.source_id,r.mapping_revision)
             JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
             WHERE (cr.tenant_key,cr.source_id,cr.revision)=(r.tenant_key,r.source_id,r.current_config_revision))
         RETURNING id`,[principal.tenantId,sourceId,principal.userId,reportId,dataContractRef,profileDigest],
      );
      if (!approval.rowCount) fail('SOURCE_CONFLICT');
      await client.query(`UPDATE control.source_registry SET lifecycle='APPROVED',updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId]);
      return { approval_id:approval.rows[0].id, owner_revision:decimal(row.owner_revision), status:'APPROVED' };
    });
  }

  async function activate(principal: UserPrincipal, sourceId: string, expected: unknown, approvalId: unknown) {
    requireScope(principal,'source:write');
    if (typeof expected !== 'string' || !/^[1-9][0-9]*$/.test(expected) || typeof approvalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(approvalId)) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const row = await sourceRow(client,principal.tenantId,sourceId,true);
      const deleteReconciliationInstalled = await client.query<{ installed:boolean }>(
        `SELECT to_regclass('control.etl_snapshot_delete_run') IS NOT NULL AS installed`);
      if (deleteReconciliationInstalled.rows[0]?.installed) {
        const busy = await client.query<{ busy:boolean }>(
          'SELECT control.etl_snapshot_source_delete_busy($1,$2) AS busy',[principal.tenantId,sourceId]);
        if (busy.rows[0]?.busy) fail('SOURCE_CONFLICT');
      }
      if (decimal(row.current_config_revision)!==expected || !['APPROVED','PAUSED'].includes(String(row.lifecycle))) fail('SOURCE_CONFLICT');
      const config = row.config as SourceConfig;
      let profileDigest:Buffer|null=null;
      if(config.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      else {
        if(!config.endpoint_profile) fail('SOURCE_PROBE_UNAVAILABLE');
        const profile=await deps.endpointAllowlist.resolve(config.endpoint_allowlist_ref!);
        validateEndpointProfile(config,profile,probeEnvironment);
        profileDigest=digest(profile);
        if(!profileDigest.equals(digest(config.endpoint_profile))) fail('SOURCE_CONFLICT');
      }
      const owner = await client.query('SELECT enabled FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 FOR UPDATE',
        [principal.tenantId,row.data_owner_user_id]);
      if (!owner.rowCount || !owner.rows[0].enabled) fail('AUTH_FORBIDDEN');
      const approved = await client.query(
        `SELECT 1 FROM control.source_owner_approval a JOIN control.source_config_revision cr
           ON (cr.tenant_key,cr.source_id,cr.revision)=(a.tenant_key,a.source_id,a.config_revision)
          JOIN control.source_mapping_revision m ON (m.tenant_key,m.source_id,m.revision)=(a.tenant_key,a.source_id,a.mapping_revision)
          JOIN control.source_identity_mapping_revision i ON (i.tenant_key,i.source_id,i.revision)=(a.tenant_key,a.source_id,a.identity_mapping_revision)
          JOIN control.source_credential c ON (c.tenant_key,c.source_id)=(a.tenant_key,a.source_id)
         JOIN control.source_test_report t ON t.id=a.test_report_id AND (t.tenant_key,t.source_id)=(a.tenant_key,a.source_id)
         WHERE a.id=$3 AND a.tenant_key=$1 AND a.source_id=$2 AND a.owner_user_id=$4
           AND (a.owner_revision,a.config_revision,a.mapping_revision,a.identity_mapping_revision,a.source_credential_revision,a.credential_generation)=
               ((SELECT owner_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT current_config_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT mapping_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),
                (SELECT identity_mapping_revision FROM control.source_registry WHERE tenant_key=$1 AND source_id=$2),c.revision,c.credential_generation)
           AND t.status='PASS' AND ${CURRENT_TEST_EVENT}
           ${config.connector==='SIMULATED_IMPORT' ? 'AND t.endpoint_profile_digest IS NULL AND a.endpoint_profile_digest IS NULL AND t.sample_digest=a.sample_digest AND a.sample_digest IS NOT NULL AND $5::bytea IS NULL' : 'AND t.endpoint_profile_digest=$5 AND a.endpoint_profile_digest=$5'}
           AND (a.config_digest,a.mapping_digest,a.identity_mapping_digest)=(cr.config_digest,m.mapping_digest,i.mapping_digest)
          AND c.enabled`,[principal.tenantId,sourceId,approvalId,row.data_owner_user_id,profileDigest],
      );
      if (!approved.rowCount) fail('SOURCE_CONFLICT');
      if (config.connector === 'SIMULATED_IMPORT') {
        const identity=await loadMappings(client,principal.tenantId,sourceId,decimal(row.mapping_revision),decimal(row.identity_mapping_revision));
        const proof=await client.query<{sample_customer_refs:Array<{source_id:string;source_pk:string;target_id:string}>}>(
          'SELECT t.sample_customer_refs FROM control.source_owner_approval a JOIN control.source_test_report t ON t.id=a.test_report_id WHERE a.id=$1 AND a.tenant_key=$2 AND a.source_id=$3',
          [approvalId,principal.tenantId,sourceId]);
        if(!proof.rowCount) fail('SOURCE_CONFLICT');
        for(const ref of proof.rows[0].sample_customer_refs) {
          const mapping=identity.identityMappings.find(m=>m.kind==='customer' && m.external_id===customerReferenceMappingKey(ref.source_id,ref.source_pk) && m.target_id===ref.target_id);
          if(!mapping) fail('SOURCE_CONFLICT');
          const target=await client.query<{ok:boolean}>('SELECT control.lock_import_customer($1,$2,$3,$4) AS ok',[principal.tenantId,ref.source_id,ref.source_pk,ref.target_id]);
          if(!target.rows[0]?.ok) fail('SOURCE_CONFLICT');
        }
        for(const mapping of identity.identityMappings) {
          if (!mapping.target_id) fail('SOURCE_CONFLICT');
          if(mapping.kind==='user' || mapping.kind==='department') {
            const target=await client.query(mapping.kind==='user'
              ? 'SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 AND enabled FOR UPDATE'
              : 'SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND department_id=$2 AND enabled LIMIT 1 FOR UPDATE',
              [principal.tenantId,mapping.target_id]);
            if(!target.rowCount) fail('SOURCE_CONFLICT');
          }
        }
      }
      if (config.connector === 'sqlserver') fail('SOURCE_PROBE_UNAVAILABLE');
      for (const entity of config.allowed_entities) {
        const current = await client.query<{ id: string; connector: string; mode: string; version_domain: string; channel_epoch: string | number }>(
          'SELECT id,connector,mode,version_domain,channel_epoch FROM control.lock_source_channel($1,$2,$3)',[principal.tenantId,sourceId,entity]);
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
      if (config.connector === 'postgresql' && config.mode === 'FULL_SNAPSHOT') {
        await client.query(`INSERT INTO control.etl_snapshot_schedule(tenant_key,source_id,enabled,interval_seconds,next_due_at,schedule_revision)
          VALUES($1,$2,true,300,clock_timestamp(),1)
          ON CONFLICT(tenant_key,source_id) DO UPDATE SET enabled=true,interval_seconds=300,next_due_at=clock_timestamp(),
            schedule_revision=control.etl_snapshot_schedule.schedule_revision+1,updated_at=clock_timestamp()`,
          [principal.tenantId,sourceId]);
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
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:write',client);
      if (decimal(row.current_config_revision) !== expectedRevision) fail('SOURCE_CONFLICT');
      if (row.lifecycle !== 'PAUSED') {
        await client.query(`UPDATE control.source_registry SET lifecycle='PAUSED',updated_at=now() WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,sourceId]);
        await client.query(`UPDATE control.etl_snapshot_schedule SET enabled=false,schedule_revision=schedule_revision+1,updated_at=clock_timestamp()
          WHERE tenant_key=$1 AND source_id=$2 AND enabled`,[principal.tenantId,sourceId]);
        await auth.repository.advanceSourceEpoch(sourceId,principal.tenantId,client);
        await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,prior_state,new_state,details)
          VALUES($1,$2,$3,'PAUSED',$4,'PAUSED',jsonb_build_object('reason',$5::text))`,[principal.tenantId,sourceId,principal.userId,row.lifecycle,reason.trim()]);
      }
      return { source_id:sourceId,lifecycle:'PAUSED',revision:expectedRevision };
    });
  }

  async function identityMappings(principal: UserPrincipal, sourceId?: string, kind?: string, externalId?: string) {
    requireScope(principal,'source:approve');
    if((kind!==undefined || externalId!==undefined) && (!sourceId || !['user','department','customer'].includes(String(kind)) || typeof externalId!=='string' || externalId.length<1 || externalId.length>128 || /[\u0000-\u001f\u007f]/.test(externalId))) fail('AUTH_INPUT_INVALID');
    return transaction(pool,async client=>{
      if(sourceId) {
        const source=await sourceRow(client,principal.tenantId,sourceId,true);
        if(source.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:approve',client);
        if(source.data_owner_user_id!==principal.userId) fail('AUTH_FORBIDDEN');
        await currentOwner(client,principal.tenantId,principal.userId);
      } else {
        await client.query('SELECT control.lock_security_barrier_fence()');
        await auth.assertCurrentPrincipal(principal,'source:approve',client);
      }
      if(kind!==undefined && externalId!==undefined && sourceId) {
        const candidates=kind==='user'
          ? await client.query<{target_id:string;label:string}>(`SELECT user_id AS target_id,user_id AS label FROM control.auth_subject WHERE tenant_key=$1 AND enabled ORDER BY user_id LIMIT 50`,[principal.tenantId])
          : kind==='department'
            ? await client.query<{target_id:string;label:string}>(`SELECT DISTINCT department_id AS target_id,department_id AS label FROM control.auth_subject WHERE tenant_key=$1 AND enabled AND department_id IS NOT NULL ORDER BY department_id LIMIT 50`,[principal.tenantId])
            : await client.query<{target_id:string;label:string}>(`SELECT id::text AS target_id,customer_name AS label FROM api.canonical_customer_identity WHERE tenant_id=$1 ORDER BY customer_name,id LIMIT 50`,[principal.tenantId]);
        return {source_id:sourceId,kind,external_id:externalId,id:Buffer.from(`${sourceId}\0${kind}\0${externalId}`,'utf8').toString('base64url'),resolved:kind!=='customer' || candidates.rows.length>0,candidates:candidates.rows};
      }
      const result=await client.query<{source_id:string;revision:string|number;mappings:IdentityMapping[]}>(`SELECT r.source_id,r.identity_mapping_revision AS revision,i.mappings
       FROM control.source_registry r JOIN control.source_identity_mapping_revision i
       ON (i.tenant_key,i.source_id,i.revision)=(r.tenant_key,r.source_id,r.identity_mapping_revision)
       WHERE r.tenant_key=$1 AND ($2::text IS NULL OR r.source_id=$2) AND r.data_owner_user_id=$3 ORDER BY r.source_id`,[principal.tenantId,sourceId??null,principal.userId]);
      return result.rows.map(row=>({source_id:row.source_id,revision:(BigInt(decimal(row.revision))-1n).toString(),identity_mappings:row.mappings.map(mapping=>({
        ...mapping,id:Buffer.from(`${row.source_id}\0${mapping.kind}\0${mapping.external_id}`,'utf8').toString('base64url')}))}));
    });
  }

  async function sourceCustomerCandidates(principal:UserPrincipal,sourceId:string,limitInput:unknown=20,cursorInput?:unknown) {
    requireScope(principal,'source:approve');
    if(typeof sourceId!=='string'||!SOURCE_ID.test(sourceId)) fail('AUTH_INPUT_INVALID');
    const limit=typeof limitInput==='number'?limitInput:typeof limitInput==='string'&&/^(?:[1-9][0-9]{0,2})$/.test(limitInput)?Number(limitInput):NaN;
    if(!Number.isInteger(limit)||limit<1||limit>100) fail('AUTH_INPUT_INVALID');
    const after=decodeSourceCustomerCursor(sourceId,cursorInput);
    return transaction(pool,async client=>{
      const source=await sourceRow(client,principal.tenantId,sourceId,true);
      if(source.data_owner_user_id!==principal.userId) fail('AUTH_FORBIDDEN');
      await auth.assertCurrentPrincipal(principal,'source:approve',client);
      await currentOwner(client,principal.tenantId,principal.userId);
      const result=await client.query<{source_pk:string;target_id:string}>(`SELECT source_pk,target_id
        FROM api.source_customer_identity_candidates WHERE tenant_key=$1 AND source_id=$2
          AND ($3::text IS NULL OR source_pk COLLATE "C">$3 COLLATE "C")
        ORDER BY source_pk COLLATE "C" LIMIT $4`,[principal.tenantId,sourceId,after??null,limit+1]);
      const hasMore=result.rows.length>limit,rows=result.rows.slice(0,limit);
      return Object.freeze({source_id:sourceId,items:Object.freeze(rows.map(row=>Object.freeze({source_pk:row.source_pk,target_id:row.target_id}))),
        next_cursor:hasMore&&rows.length?encodeSourceCustomerCursor(sourceId,rows.at(-1)!.source_pk):null});
    });
  }

  async function updateIdentityMapping(principal: UserPrincipal, opaqueId: string, expected: string, targetId: string, reason: string) {
    requireScope(principal,'source:approve');
    if (!/^(?:0|[1-9][0-9]*)$/.test(expected) || typeof targetId!=='string' || targetId.length<1 || targetId.length>128 || /[\u0000-\u001f\u007f]/.test(targetId) ||
        typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 256) fail('AUTH_INPUT_INVALID');
    return transaction(pool, async client => {
      const decoded = Buffer.from(opaqueId,'base64url').toString('utf8').split('\0');
      if (decoded.length !== 3 || !SOURCE_ID.test(decoded[0]) || !['user','department','customer'].includes(decoded[1]) ||
        Buffer.from(opaqueId,'base64url').toString('base64url')!==opaqueId) fail('AUTH_INPUT_INVALID');
      const [mappingSourceId, kind, externalId] = decoded;
      if(externalId.length<1 || externalId.length>128 || /[\u0000-\u001f\u007f]/.test(externalId)) fail('AUTH_INPUT_INVALID');
      const row = await sourceRow(client,principal.tenantId,mappingSourceId,true);
      if(row.connector==='SIMULATED_IMPORT') await auth.assertCurrentPrincipal(principal,'source:approve',client);
      if (row.data_owner_user_id !== principal.userId) fail('AUTH_FORBIDDEN');
      await currentOwner(client,principal.tenantId,principal.userId);
      const currentDbRevision=(BigInt(expected)+1n).toString();
      if (decimal(row.identity_mapping_revision) !== currentDbRevision) fail('SOURCE_CONFLICT');
      if(kind==='user') {
        const target=await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND user_id=$2 AND enabled',[principal.tenantId,targetId]);
        if(!target.rowCount) fail('SOURCE_NOT_FOUND');
      } else if(kind==='department') {
        const target=await client.query('SELECT 1 FROM control.auth_subject WHERE tenant_key=$1 AND department_id=$2 AND enabled',[principal.tenantId,targetId]);
        if(!target.rowCount) fail('SOURCE_NOT_FOUND');
      } else if(kind==='customer') {
        const target=await client.query('SELECT 1 FROM api.canonical_customer_identity WHERE tenant_id=$1 AND id::text=$2',[principal.tenantId,targetId]);
        if(!target.rowCount) fail('SOURCE_NOT_FOUND');
      } else fail('SOURCE_NOT_FOUND');
      const data = await loadMappings(client,principal.tenantId,mappingSourceId,decimal(row.mapping_revision),currentDbRevision);
      const unchanged = data.identityMappings.find(mapping => mapping.kind===kind && mapping.external_id===externalId);
      if (unchanged?.target_id===targetId) {
        return {source_id:mappingSourceId,revision:expected,identity_mappings:data.identityMappings};
      }
      const revised = [...data.identityMappings.filter(mapping => !(mapping.kind===kind && mapping.external_id===externalId)),
        {kind:kind as IdentityMapping['kind'],external_id:externalId,target_id:targetId}];
      const revision = (BigInt(currentDbRevision)+1n).toString();
      await client.query(`INSERT INTO control.source_identity_mapping_revision(tenant_key,source_id,revision,mapping_digest,mappings,created_by)
        VALUES($1,$2,$3,$4,$5,$6)`,[principal.tenantId,mappingSourceId,revision,digest(revised),JSON.stringify(revised),principal.userId]);
      await client.query(`UPDATE control.source_registry SET identity_mapping_revision=$3,
        lifecycle=CASE WHEN lifecycle='ACTIVE' THEN 'PAUSED' ELSE 'DRAFT' END,updated_at=now()
        WHERE tenant_key=$1 AND source_id=$2`,[principal.tenantId,mappingSourceId,revision]);
      await auth.repository.advanceSourceEpoch(mappingSourceId,principal.tenantId,client);
      await client.query(`INSERT INTO control.source_lifecycle_event(tenant_key,source_id,actor_user_id,action,details)
        VALUES($1,$2,$3,'IDENTITY_MAPPING_CONFIRMED',jsonb_build_object('reason',$4::text,'revision',$5::text))`,[principal.tenantId,mappingSourceId,principal.userId,reason.trim(),revision]);
      await client.query('SELECT control.remap_canonical_identity($1,$2,$3,$4,$5,$6,$7,$8)',
        [principal.tenantId,mappingSourceId,kind,externalId,targetId,revision,principal.userId,reason.trim()]);
      return { source_id:mappingSourceId,revision:expected==='0'?'1':(BigInt(expected)+1n).toString(),identity_mappings:revised };
    });
  }

  return Object.freeze({ list,get,create,update,mappings,writeMappings,validateMappings,writeIdentityMappings,testBodyLimit,test,approve,activate,pause,
    identityMappings,sourceCustomerCandidates,updateIdentityMapping });
}

export type SourceRegistryService = ReturnType<typeof createSourceRegistryService>;

export const failClosedSecretResolver: SecretResolver = Object.freeze({ isConfiguredReference: () => false, resolve: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
export const failClosedEndpointAllowlist: EndpointAllowlist = Object.freeze({ resolve: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
export const failClosedCapabilityProbe: CapabilityProbe = Object.freeze({ run: async () => fail('SOURCE_PROBE_UNAVAILABLE') });
