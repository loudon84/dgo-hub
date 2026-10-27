import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { FieldMapping, SourceConfig } from '../source-registry/service.js';
import type { EndpointProfile } from '../source-registry/capability-probe.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const VERSION = /^(?:0|[1-9][0-9]*|[0-9a-fA-F-]{36}|[A-Za-z0-9._:-]{1,128})$/;
export const MAX_SNAPSHOT_PAGE_SIZE = 1000;

export type SnapshotRelation = 'customer' | 'order' | 'order_line';
export type SnapshotStageRow = Readonly<{
  entity: 'customer' | 'order';
  relation: SnapshotRelation;
  source_pk: string;
  parent_source_pk: string;
  source_version: string | null;
  facts: Readonly<Record<string, string | null>>;
}>;
export type SnapshotPage = Readonly<{
  entity: 'customer' | 'order';
  relation: SnapshotRelation;
  page_no: number;
  rows: readonly SnapshotStageRow[];
  first_key: string;
  last_key: string;
  page_digest: string;
}>;
export type SnapshotConnection = Readonly<{
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}>;
export type SourceEgressPolicy = Readonly<{
  environmentKind: 'site' | 'local_lab';
  policyId: string;
}>;
export type PostgresSourceConnectionFactory = Readonly<{
  connect(input: Readonly<{ profile: EndpointProfile; password: string; policy: SourceEgressPolicy; signal?:AbortSignal }>): Promise<SnapshotConnection>;
}>;
export type SnapshotScanResult = Readonly<{
  snapshot_identity: string;
  page_count: number;
  row_count: number;
  relation_counts: Readonly<Record<SnapshotRelation, number>>;
}>;
export type SnapshotPageSink = (page: SnapshotPage) => Promise<void>;

export class SnapshotSourceError extends Error {
  constructor(readonly code: 'SNAPSHOT_PROFILE_INVALID' | 'SNAPSHOT_SOURCE_UNAVAILABLE' | 'SNAPSHOT_SOURCE_CONTRACT_INVALID' |
    'SNAPSHOT_SOURCE_DUPLICATE_KEY' | 'SNAPSHOT_CANCELLED') { super(code); }
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  return `"${value.replaceAll('"', '""')}"`;
}
function qualified(schema: string, table: string): string { return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`; }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
function mappedValue(raw: unknown, mapping: FieldMapping): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  switch (mapping.transform) {
    case 'trim': return text.trim();
    case 'decimal-string': if (!DECIMAL.test(text)) throw new SnapshotSourceError('SNAPSHOT_SOURCE_CONTRACT_INVALID'); return text;
    case 'source-id': if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) throw new SnapshotSourceError('SNAPSHOT_SOURCE_CONTRACT_INVALID'); return text;
    case 'identity': return text;
  }
}
function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || /[\u0000-\u001f\u007f]/.test(value))
    throw new SnapshotSourceError('SNAPSHOT_SOURCE_CONTRACT_INVALID');
  return value;
}
function relationMappings(mappings: readonly FieldMapping[], entity: 'customer' | 'order', prefix?: 'lines.') {
  return mappings.filter(mapping => mapping.entity === entity && (prefix ? mapping.target_field.startsWith(prefix) : !mapping.target_field.startsWith('lines.')));
}
function columns(profile: EndpointProfile, config: SourceConfig, entity: 'customer' | 'order', mappings: readonly FieldMapping[], line = false): string {
  const item = profile.entities[entity];
  if (!item?.table || !item.source_pk || !IDENTIFIER.test(item.source_pk) || !item.table || !IDENTIFIER.test(item.table) || !profile.schema)
    throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  if (!item.updated_at_field || !IDENTIFIER.test(item.updated_at_field)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  const key = line ? relationMappings(mappings, 'order', 'lines.').find(mapping => mapping.target_field === 'lines.source_line_id')?.source_field : item.source_pk;
  if (!key) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  const selected = new Set<string>([key]);
  if (line) {
    if (!item.lines || !IDENTIFIER.test(item.lines.table) || !IDENTIFIER.test(item.lines.order_fk)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
    selected.add(item.lines.order_fk);
  }
  for (const mapping of relationMappings(mappings, entity, line ? 'lines.' : undefined)) {
    if (!IDENTIFIER.test(mapping.source_field)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
    selected.add(mapping.source_field);
  }
  if (!line) {
    selected.add(item.updated_at_field);
    if (item.version_field) selected.add(item.version_field);
    if (config.delete_contract === 'tombstone') {
      if (!item.delete_field || !IDENTIFIER.test(item.delete_field)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
      selected.add(item.delete_field);
    }
    for (const target of ['source_updated_at', 'deleted_at']) {
      const mapping = relationMappings(mappings, entity).find(value => value.target_field === target);
      const field = target === 'source_updated_at' ? item.updated_at_field : item.delete_field;
      if (mapping && mapping.source_field !== field) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
    }
  }
  const projections = [...selected].map((column, index) => `${quoteIdentifier(column)}::text AS ${quoteIdentifier(`c${index}`)}`);
  const ordinal = new Map([...selected].map((column, index) => [column, `c${index}`]));
  const order = line ? [item.lines!.order_fk, key] : [key];
  const from = qualified(profile.schema, line ? item.lines!.table : item.table);
  const orderSql = order.map(column => quoteIdentifier(column)).join(',');
  return `SELECT ${projections.join(',')} FROM ${from} ORDER BY ${orderSql}`;
}

function pageRows(rows: Record<string, unknown>[], profile: EndpointProfile, config: SourceConfig,
  mappings: readonly FieldMapping[], relation: SnapshotRelation): SnapshotStageRow[] {
  const line = relation === 'order_line';
  const entity = relation === 'customer' ? 'customer' : 'order';
  const item = profile.entities[entity]!;
  const lineMaps = line ? relationMappings(mappings, 'order', 'lines.') : [];
  const maps = line ? lineMaps : relationMappings(mappings, entity);
  const allSelected = new Set<string>();
  const keyColumn = line ? lineMaps.find(mapping => mapping.target_field === 'lines.source_line_id')!.source_field : item.source_pk!;
  allSelected.add(keyColumn);
  const parentColumn = line ? item.lines!.order_fk : undefined;
  if (parentColumn) allSelected.add(parentColumn);
  for (const mapping of maps) allSelected.add(mapping.source_field);
  if (!line) {
    allSelected.add(item.updated_at_field!);
    if (item.version_field) allSelected.add(item.version_field);
    if (config.delete_contract === 'tombstone' && item.delete_field) allSelected.add(item.delete_field);
  }
  const names = [...allSelected];
  const alias = new Map(names.map((name, index) => [name, `c${index}`]));
  const unique = new Set<string>();
  return rows.map(raw => {
    const key = requireText(raw[alias.get(keyColumn)!]);
    const parent = parentColumn ? requireText(raw[alias.get(parentColumn)!]) : '';
    const uniqueKey = `${parent.length}:${parent}${key.length}:${key}`;
    if (unique.has(uniqueKey)) throw new SnapshotSourceError('SNAPSHOT_SOURCE_DUPLICATE_KEY');
    unique.add(uniqueKey);
    const facts: Record<string, string | null> = {};
    for (const mapping of maps) {
      const value = mappedValue(raw[alias.get(mapping.source_field)!], mapping);
      if (line && (value === null || value.length === 0)) throw new SnapshotSourceError('SNAPSHOT_SOURCE_CONTRACT_INVALID');
      facts[mapping.target_field] = value;
    }
    if (!line) {
      const updatedAt = requireText(raw[alias.get(item.updated_at_field!)!]);
      facts.source_updated_at = updatedAt;
      if (config.delete_contract === 'tombstone') {
        const deleted = raw[alias.get(item.delete_field!)!];
        facts.deleted_at = deleted === null || deleted === undefined ? null : requireText(deleted);
      }
    }
    const version = item.version_field ? raw[alias.get(item.version_field)!] : null;
    const sourceVersion = version === null || version === undefined ? null : requireText(version);
    if (!line && config.version_domain === 'SOURCE_VERSION' && (!sourceVersion || !VERSION.test(sourceVersion)))
      throw new SnapshotSourceError('SNAPSHOT_SOURCE_CONTRACT_INVALID');
    return Object.freeze({ entity, relation, source_pk: key, parent_source_pk: parent, source_version: sourceVersion,
      facts: Object.freeze(facts) });
  });
}

async function declareCursor(connection: SnapshotConnection, cursor: string, select: string): Promise<void> {
  if (!/^hub_snapshot_(?:customer|order|order_line)$/.test(cursor)) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  await connection.query(`DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR ${select}`);
}

export async function extractPostgresSnapshot(input: Readonly<{
  factory: PostgresSourceConnectionFactory;
  policy: SourceEgressPolicy;
  profile: EndpointProfile;
  config: SourceConfig;
  password: string;
  mappings: readonly FieldMapping[];
  pageSize: number;
  signal?: AbortSignal;
  onPage: SnapshotPageSink;
}>): Promise<SnapshotScanResult> {
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAX_SNAPSHOT_PAGE_SIZE ||
      !input.password || !input.profile || input.profile.connector !== 'postgresql') throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  const relations: SnapshotRelation[] = [...input.config.allowed_entities].sort((left, right) => left.localeCompare(right)).flatMap(entity => entity === 'customer'
    ? ['customer' as const] : ['order' as const, 'order_line' as const]);
  if (new Set(input.config.allowed_entities).size !== input.config.allowed_entities.length ||
      input.config.allowed_entities.some(entity => entity !== 'customer' && entity !== 'order')) throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
  let connection: SnapshotConnection | undefined;
  let inTransaction = false;
  let sinkFailure = false;
  const cancelOutstanding=()=>{ if(connection) void connection.cancel().catch(()=>undefined); };
  try {
    if (input.signal?.aborted) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
    connection = await input.factory.connect({ profile: input.profile, password: input.password, policy: input.policy,signal:input.signal });
    if (input.signal?.aborted) { await connection.cancel().catch(()=>undefined); throw new SnapshotSourceError('SNAPSHOT_CANCELLED'); }
    input.signal?.addEventListener('abort',cancelOutstanding,{once:true});
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;
    await connection.query("SET LOCAL TIME ZONE 'UTC'");
    await connection.query("SET LOCAL DateStyle TO 'ISO, YMD'");
    const snapshot = await connection.query("SELECT pg_current_snapshot()::text AS snapshot_text");
    const snapshotText = requireText(snapshot.rows[0]?.snapshot_text);
    const counts: Record<SnapshotRelation, number> = { customer: 0, order: 0, order_line: 0 };
    let pageCount = 0;
    for (const relation of relations) {
      if (input.signal?.aborted) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
      const entity = relation === 'customer' ? 'customer' : 'order';
      const cursor = `hub_snapshot_${relation}`;
      const select = columns(input.profile, input.config, entity, input.mappings, relation === 'order_line');
      await declareCursor(connection, cursor, select);
      let pageNo = 0;
      while (true) {
        if (input.signal?.aborted) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
        // FETCH grammar accepts only a literal; pageSize is validated and capped above.
        const result = await connection.query(`FETCH FORWARD ${input.pageSize} FROM ${cursor}`);
        if (!result.rows.length) break;
        pageNo += 1;
        const records = pageRows(result.rows, input.profile, input.config, input.mappings, relation);
        const key = (row: SnapshotStageRow) => relation === 'order_line'
          ? `${row.parent_source_pk.length}:${row.parent_source_pk}${row.source_pk.length}:${row.source_pk}` : row.source_pk;
        const page: SnapshotPage = Object.freeze({ entity, relation, page_no: pageNo, rows: Object.freeze(records),
          first_key: key(records[0]), last_key: key(records.at(-1)!), page_digest: sha256(canonical(records)) });
        try { await input.onPage(page); }
        catch (error) { sinkFailure = true; throw error; }
        counts[relation] += records.length;
        pageCount += 1;
      }
      await connection.query(`CLOSE ${cursor}`);
    }
    await connection.query('COMMIT');
    inTransaction = false;
    return Object.freeze({ snapshot_identity: sha256(snapshotText), page_count: pageCount,
      row_count: Object.values(counts).reduce((total, count) => total + count, 0), relation_counts: Object.freeze(counts) });
  } catch (error) {
    if (input.signal?.aborted) error=new SnapshotSourceError('SNAPSHOT_CANCELLED');
    if (inTransaction && connection) await Promise.race([connection.query('ROLLBACK').then(()=>undefined,()=>undefined),
      new Promise<void>(resolve=>setTimeout(resolve,1_000))]);
    if (sinkFailure || error instanceof SnapshotSourceError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String(error.code);
      if (['42501','23505','42703','42P01','28P01','22003','22007'].includes(code))
        throw new SnapshotSourceError(code === '23505' ? 'SNAPSHOT_SOURCE_DUPLICATE_KEY' : 'SNAPSHOT_SOURCE_CONTRACT_INVALID');
    }
    throw new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE');
  } finally {
    input.signal?.removeEventListener('abort',cancelOutstanding);
    if (connection) await Promise.race([connection.close().catch(()=>undefined),new Promise<void>(resolve=>setTimeout(resolve,1_000))]);
  }
}

export const failClosedPostgresSourceConnectionFactory: PostgresSourceConnectionFactory = Object.freeze({
  async connect() { throw new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE'); },
});

export function createLocalLabPostgresSourceConnectionFactory(): PostgresSourceConnectionFactory {
  return Object.freeze({
    async connect({ profile, password, policy,signal }) {
      if (policy.environmentKind !== 'local_lab' || !['127.0.0.1', '::1'].includes(profile.host.toLowerCase().replace(/^\[|\]$/g,'')) ||
          profile.allow_loopback_plaintext !== true || profile.connector !== 'postgresql' || !profile.database || !profile.user)
        throw new SnapshotSourceError('SNAPSHOT_PROFILE_INVALID');
      const client = new Client({ host: profile.host, port: profile.port, database: profile.database, user: profile.user,
        password, ssl: false, connectionTimeoutMillis: 3_000, query_timeout: 10_000, statement_timeout: 10_000,
        application_name: 'hub_snapshot_extractor' });
      const abortConnect=()=>client.connection.stream.destroy(new Error('snapshot source connect cancelled'));
      if (signal?.aborted) throw new SnapshotSourceError('SNAPSHOT_CANCELLED');
      signal?.addEventListener('abort',abortConnect,{once:true});
      try { await client.connect(); }
      catch { await client.end().catch(() => undefined); throw signal?.aborted
        ? new SnapshotSourceError('SNAPSHOT_CANCELLED') : new SnapshotSourceError('SNAPSHOT_SOURCE_UNAVAILABLE'); }
      finally { signal?.removeEventListener('abort',abortConnect); }
      // A backend can disappear while the sink is staging a page; pg emits that socket error
      // independently of a pending query. Pending queries still reject and drive rollback.
      client.on('error', () => undefined);
      return Object.freeze({
        query: async (sql: string) => client.query(sql),
        cancel: async () => { if (!client.connection.stream.destroyed) client.connection.stream.destroy(new Error('snapshot source query cancelled')); },
        close: async () => client.end(),
      });
    },
  });
}
