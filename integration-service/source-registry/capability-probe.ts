import { Client } from 'pg';
import type { SourceEntity } from '../auth/types.js';
import type { SourceConfig, CapabilityProbe } from './service.js';

type EntityProfile = Readonly<{
  table?: string;
  version_field: string;
  delete_field?: string;
  version_type?: 'integer' | 'number' | 'text';
  delete_type?: 'boolean' | 'timestamp';
}>;

export type EndpointProfile = Readonly<{
  revision: string;
  connector: 'rest' | 'postgresql' | 'sqlserver';
  protocol: 'https:' | 'http:' | 'postgres:' | 'mssql:';
  host: string;
  port: number;
  allow_loopback_http?: boolean;
  allow_loopback_plaintext?: boolean;
  path?: string;
  schema_version?: string;
  source_identity?: string;
  database?: string;
  user?: string;
  schema?: string;
  entities: Readonly<Partial<Record<SourceEntity, EntityProfile>>>;
}>;

export type ProbeEnvironment = Readonly<{ environmentKind: 'site' | 'local_lab' }>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SCHEMA_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOOPBACK = new Set(['127.0.0.1','::1','localhost']);
const MAX_REST_BODY_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MS = 3_000;

function loopback(host: string): boolean { return LOOPBACK.has(host.toLowerCase().replace(/^\[|\]$/g,'')); }
function checkProfile(config: SourceConfig, profile: EndpointProfile, environment: ProbeEnvironment): void {
  if (!profile || profile.connector !== config.connector || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.revision) ||
      typeof profile.host !== 'string' || profile.host.length > 253 || /[\s/@?#]/.test(profile.host) ||
      !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('PROFILE_INVALID');
  const local = environment.environmentKind === 'local_lab' && loopback(profile.host);
  if (profile.connector === 'sqlserver') {
    if (profile.protocol !== 'mssql:') throw new Error('PROFILE_INVALID');
    return;
  }
  if (profile.connector === 'rest') {
    if ((profile.protocol !== 'https:' && !(profile.protocol === 'http:' && local && profile.allow_loopback_http === true)) ||
        (profile.allow_loopback_http === true && !local) || typeof profile.path !== 'string' ||
        !/^\/(?!\/)[A-Za-z0-9/_-]{0,127}$/.test(profile.path) || profile.path.split('/').some(segment => segment === '.' || segment === '..') ||
        typeof profile.schema_version !== 'string' || !SCHEMA_VERSION.test(profile.schema_version) ||
        typeof profile.source_identity !== 'string' || !SCHEMA_VERSION.test(profile.source_identity)) throw new Error('PROFILE_INVALID');
  } else {
    if (profile.protocol !== 'postgres:' || typeof profile.database !== 'string' || !IDENTIFIER.test(profile.database) ||
        typeof profile.schema !== 'string' || !IDENTIFIER.test(profile.schema) || typeof profile.user !== 'string' || !IDENTIFIER.test(profile.user) ||
        (profile.allow_loopback_plaintext === true && !local) || (profile.allow_loopback_plaintext !== true && local && environment.environmentKind === 'local_lab')) {
      throw new Error('PROFILE_INVALID');
    }
  }
  for (const entity of config.allowed_entities) {
    const item = profile.entities[entity];
    if (!item || !IDENTIFIER.test(item.version_field) || (item.delete_field !== undefined && !IDENTIFIER.test(item.delete_field)) ||
        (profile.connector === 'postgresql' && (typeof item.table !== 'string' || !IDENTIFIER.test(item.table)))) throw new Error('PROFILE_INVALID');
  }
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error('PROFILE_INVALID');
  return `"${value.replaceAll('"','""')}"`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_REST_BODY_BYTES) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function assertRestContract(config: SourceConfig, profile: EndpointProfile, response: unknown, mappings: readonly { entity: SourceEntity; source_field: string }[]) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('CONTRACT_INVALID');
  const root = response as Record<string, unknown>;
  if (root.protocol !== 'hub.source-capability.v1' || root.schema_version !== profile.schema_version ||
      root.source_identity !== profile.source_identity || root.version_domain !== config.version_domain ||
      !root.entities || typeof root.entities !== 'object' || Array.isArray(root.entities)) throw new Error('CONTRACT_INVALID');
  const entities = root.entities as Record<string, unknown>;
  for (const entity of config.allowed_entities) {
    const declared = entities[entity];
    const expected = profile.entities[entity]!;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('CONTRACT_INVALID');
    const value = declared as Record<string, unknown>;
    const fields = value.fields;
    const fieldTypes=value.field_types;
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string') ||
        !fieldTypes || typeof fieldTypes!=='object' || Array.isArray(fieldTypes) ||
        value.version_field !== expected.version_field || value.delete_contract !== config.delete_contract ||
        !fields.includes(expected.version_field) ||
        !['integer','number','text'].includes(String((fieldTypes as Record<string,unknown>)[expected.version_field])) ||
        (config.delete_contract === 'tombstone' && (typeof expected.delete_field !== 'string' || value.delete_field !== expected.delete_field || !fields.includes(expected.delete_field)))) {
      throw new Error('CONTRACT_INVALID');
    }
    if(config.delete_contract==='tombstone' && !['boolean','timestamp'].includes(String((fieldTypes as Record<string,unknown>)[expected.delete_field!])))
      throw new Error('CONTRACT_INVALID');
    if (mappings.some(mapping => mapping.entity === entity && !fields.includes(mapping.source_field))) throw new Error('MAPPING_INVALID');
  }
}

async function probeRest(config: SourceConfig, profile: EndpointProfile, secret: string,
  mappings: readonly { entity: SourceEntity; source_field: string }[]): Promise<void> {
  const origin = new URL(`${profile.protocol}//${profile.host}:${profile.port}`).origin;
  const url = new URL(profile.path!, origin);
  if (url.origin !== origin || url.username || url.password || url.hash || url.search) throw new Error('PROFILE_INVALID');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      redirect: 'manual', signal: controller.signal });
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new Error('ENDPOINT_REJECTED');
    }
    assertRestContract(config, profile, await readBoundedJson(response), mappings);
  } finally { clearTimeout(timeout); }
}

async function probePostgres(config: SourceConfig, profile: EndpointProfile, secret: string,
  mappings: readonly { entity: SourceEntity; source_field: string }[]): Promise<void> {
  const client = new Client({ host: profile.host, port: profile.port, database: profile.database, user: profile.user,
    password: secret, ssl: profile.allow_loopback_plaintext ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: PROBE_TIMEOUT_MS, query_timeout: PROBE_TIMEOUT_MS, statement_timeout: PROBE_TIMEOUT_MS,
  });
  let inTransaction = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const identity = await client.query<{ database: string; superuser: boolean; createdb: boolean; createrole: boolean; schema_create: boolean; database_create: boolean }>(
      `SELECT current_database() AS database,r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,
        has_schema_privilege(current_user,$1,'CREATE') AS schema_create,
        has_database_privilege(current_user,current_database(),'CREATE') AS database_create
       FROM pg_roles r WHERE r.rolname=current_user`, [profile.schema],
    );
    if (identity.rows[0]?.database !== profile.database || !identity.rowCount || identity.rows[0].superuser ||
        identity.rows[0].createdb || identity.rows[0].createrole || identity.rows[0].schema_create || identity.rows[0].database_create) {
      throw new Error('SOURCE_IDENTITY_INVALID');
    }
    for (const entity of config.allowed_entities) {
      const item = profile.entities[entity]!;
      const columns = await client.query<{ column_name: string;data_type:string;udt_name:string }>(
        `SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_catalog=$1 AND table_schema=$2 AND table_name=$3`,
        [profile.database,profile.schema,item.table],
      );
      const names = new Set(columns.rows.map(row => row.column_name));
      const byName=new Map(columns.rows.map(row=>[row.column_name,row]));
      const required = [item.version_field,...(config.delete_contract === 'tombstone' ? [item.delete_field!] : []),
        ...mappings.filter(mapping => mapping.entity === entity).map(mapping => mapping.source_field)];
      if (!columns.rowCount || required.some(name => !names.has(name))) throw new Error('MAPPING_INVALID');
      const versionType=byName.get(item.version_field)?.data_type;
      const versionTypes=new Set(['smallint','integer','bigint','numeric','character varying','text']);
      const deleteType=item.delete_field?byName.get(item.delete_field)?.data_type:undefined;
      const deleteTypes=new Set(['boolean','timestamp without time zone','timestamp with time zone']);
      if(!versionType || !versionTypes.has(versionType) || (config.delete_contract==='tombstone' && (!deleteType || !deleteTypes.has(deleteType))))
        throw new Error('VERSION_DELETE_CONTRACT_INVALID');
      const qualified = `${quoteIdentifier(profile.schema!)}.${quoteIdentifier(item.table!)}`;
      const permission = await client.query<{ can_read: boolean; can_write: boolean; column_write: boolean }>(
        `SELECT has_table_privilege(current_user,$1::regclass,'SELECT') AS can_read,
          has_table_privilege(current_user,$1::regclass,'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write,
          has_any_column_privilege(current_user,$1::regclass,'INSERT') OR
          has_any_column_privilege(current_user,$1::regclass,'UPDATE') AS column_write`, [`${profile.schema}.${item.table}`],
      );
      if (!permission.rows[0]?.can_read || permission.rows[0].can_write || permission.rows[0].column_write) throw new Error('READ_ONLY_PERMISSION_INVALID');
      const selected = required.map(quoteIdentifier).join(',');
      await client.query(`SELECT ${selected} FROM ${qualified} LIMIT 0`);
    }
  } finally {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export function createBoundedCapabilityProbe(environment: ProbeEnvironment): CapabilityProbe {
  return Object.freeze({
    async run({ config, endpoint, secret, mappings }) {
      const checks: string[] = [];
      try {
        checkProfile(config, endpoint as EndpointProfile, environment);
        checks.push('PROFILE_VALID');
        if (config.connector === 'sqlserver') throw new Error('CONNECTOR_UNAVAILABLE');
        if (config.connector === 'rest') {
          await probeRest(config, endpoint as EndpointProfile, secret, mappings);
        } else {
          await probePostgres(config, endpoint as EndpointProfile, secret, mappings);
        }
        checks.push('ENDPOINT_REACHABLE');
        checks.push('SOURCE_IDENTITY_VALID','READ_ONLY','MAPPING_VALID','VERSION_DELETE_CONTRACT_VALID');
        return { passed: true, checks };
      } catch (error) {
        const safeCodes = new Set(['PROFILE_INVALID','CONNECTOR_UNAVAILABLE','ENDPOINT_REJECTED','ENDPOINT_UNAVAILABLE',
          'RESPONSE_TOO_LARGE','RESPONSE_INVALID','CONTRACT_INVALID','MAPPING_INVALID','SOURCE_IDENTITY_INVALID',
          'READ_ONLY_PERMISSION_INVALID','VERSION_DELETE_CONTRACT_INVALID']);
        const code = error instanceof Error && safeCodes.has(error.message) ? error.message : 'CAPABILITY_CHECK_FAILED';
        return { passed: false, checks: [...checks,code] };
      }
    },
  });
}

export function validateEndpointProfile(config: SourceConfig, profile: EndpointProfile, environment: ProbeEnvironment): void {
  checkProfile(config, profile, environment);
}
