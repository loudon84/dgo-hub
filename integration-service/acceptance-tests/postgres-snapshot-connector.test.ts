import { describe, expect, it } from 'vitest';
import type { EndpointProfile } from '../source-registry/capability-probe.js';
import type { FieldMapping, SourceConfig } from '../source-registry/service.js';
import { extractPostgresSnapshot, type SnapshotConnection, type SnapshotPage } from '../etl-worker/postgres-snapshot-connector.js';

const config: SourceConfig = { name: 'fixture', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
  endpoint_allowlist_ref: 'fixture', secret_ref: 'vault:/fixture/source', allowed_entities: ['customer'], delete_contract: 'hard_delete' };
const profile: EndpointProfile = { revision: 'p1', connector: 'postgresql', protocol: 'postgres:', host: '127.0.0.1', port: 5432,
  allow_loopback_plaintext: true, database: 'source', user: 'reader', schema: 'crm', entities: {
    customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at' },
  } };
const mappings: readonly FieldMapping[] = [{ entity: 'customer', source_field: 'name', target_field: 'customer_name', transform: 'trim' }];

class ScriptedSource implements SnapshotConnection {
  statements: string[] = [];
  cursorRows = [
    { c0: '900719925474099312345', c1: '  Customer  ', c2: '2026-10-25 09:10:11.123456+00' },
    { c0: 'source-B', c1: 'Second', c2: '2026-10-25 09:10:12.000001+00' },
  ];
  async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(sql);
    if (sql.includes('pg_current_snapshot')) return { rows: [{ snapshot_text: '00000003-00000001-1' }] };
    if (sql.startsWith('FETCH')) return { rows: this.cursorRows.splice(0, Number(/^FETCH FORWARD (\d+)/.exec(sql)?.[1] ?? '0')) };
    return { rows: [] };
  }
  async cancel(): Promise<void> { this.statements.push('CANCEL_CONNECTION'); }
  async close(): Promise<void> { this.statements.push('CLOSE_CONNECTION'); }
}

describe('PostgreSQL repeatable-read snapshot connector', () => {
  it('pages on one read-only snapshot and preserves source IDs and timestamp fractions as text', async () => {
    const connection = new ScriptedSource();
    const pages: SnapshotPage[] = [];
    const scan = await extractPostgresSnapshot({ factory: { connect: async ({ profile: actual, password, policy }) => {
      expect(actual).toBe(profile); expect(password).toBe('fixture-secret'); expect(policy).toEqual({ environmentKind: 'local_lab', policyId: 'test' });
      return connection;
    } }, policy: { environmentKind: 'local_lab', policyId: 'test' }, profile, config, password: 'fixture-secret', mappings,
      pageSize: 1, onPage: async page => { pages.push(page); } });
    expect(connection.statements.slice(0, 4)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL TIME ZONE 'UTC'", "SET LOCAL DateStyle TO 'ISO, YMD'",
      'SELECT pg_current_snapshot()::text AS snapshot_text',
    ]);
    expect(connection.statements.some(sql => sql.includes('"customer_id"::text AS "c0"'))).toBe(true);
    expect(connection.statements.filter(sql => sql.startsWith('FETCH'))).toEqual(['FETCH FORWARD 1 FROM hub_snapshot_customer',
      'FETCH FORWARD 1 FROM hub_snapshot_customer', 'FETCH FORWARD 1 FROM hub_snapshot_customer']);
    expect(pages.map(page => page.rows[0])).toMatchObject([
      { source_pk: '900719925474099312345', facts: { customer_name: 'Customer', source_updated_at: '2026-10-25 09:10:11.123456+00' } },
      { source_pk: 'source-B', facts: { customer_name: 'Second', source_updated_at: '2026-10-25 09:10:12.000001+00' } },
    ]);
    expect(scan).toMatchObject({ row_count: 2, relation_counts: { customer: 2, order: 0, order_line: 0 } });
    expect(connection.statements.at(-1)).toBe('CLOSE_CONNECTION');
  });

  it('rejects duplicate primary keys within one fetched page before publishing that page', async () => {
    const connection = new ScriptedSource();
    connection.cursorRows = [
      { c0: 'duplicate', c1: 'A', c2: '2026-10-25 09:10:11.123456+00' },
      { c0: 'duplicate', c1: 'B', c2: '2026-10-25 09:10:12.000001+00' },
    ];
    let published = false;
    await expect(extractPostgresSnapshot({ factory: { connect: async () => connection }, policy: { environmentKind: 'local_lab', policyId: 'test' },
      profile, config, password: 'fixture-secret', mappings, pageSize: 10, onPage: async () => { published = true; } }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_DUPLICATE_KEY' });
    expect(published).toBe(false);
  });

  it('rejects an optional timestamp mapping that conflicts with the frozen profile coordinate', async () => {
    const connection = new ScriptedSource();
    await expect(extractPostgresSnapshot({ factory: { connect: async () => connection },
      policy: { environmentKind:'local_lab',policyId:'test' },profile,config,password:'fixture-secret',
      mappings:[...mappings,{entity:'customer',source_field:'other_timestamp',target_field:'source_updated_at',transform:'identity'}],
      pageSize:10,onPage:async()=>undefined })).rejects.toMatchObject({code:'SNAPSHOT_PROFILE_INVALID'});
  });
});
