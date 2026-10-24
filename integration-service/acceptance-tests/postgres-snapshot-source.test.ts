import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureEvidenceRootFromEnvironment, startOwnedPostgres, type OwnedPostgres } from './helpers/postgres.js';
import { createLocalLabPostgresSourceConnectionFactory, extractPostgresSnapshot } from '../etl-worker/postgres-snapshot-connector.js';
import { createBoundedCapabilityProbe, type EndpointProfile } from '../source-registry/capability-probe.js';
import type { FieldMapping, SourceConfig } from '../source-registry/service.js';

const evidenceRoot = fixtureEvidenceRootFromEnvironment();
const evidenceFile = 'E:/m1t5-runtime/m1-task-5b-source-lifecycle.jsonl';
const image = 'postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297';
let fixture: OwnedPostgres;
let schema: string;
let privateSchema: string;
let reader: string;
let owner: string;
let ownerPool: import('pg').Pool;
let profile: EndpointProfile;

const config: SourceConfig = { name: 'owned fixture', connector: 'postgresql', mode: 'FULL_SNAPSHOT', version_domain: 'SNAPSHOT_OBSERVATION',
  endpoint_allowlist_ref: 'owned-fixture', secret_ref: 'vault:/m1/task5/source', allowed_entities: ['customer', 'order'], delete_contract: 'hard_delete' };
const mappings: readonly FieldMapping[] = [
  { entity: 'customer', source_field: 'customer_name', target_field: 'customer_name', transform: 'trim' },
  { entity: 'order', source_field: 'customer_id', target_field: 'customer_id', transform: 'source-id' },
  { entity: 'order', source_field: 'order_no', target_field: 'order_no', transform: 'trim' },
  { entity: 'order', source_field: 'status', target_field: 'status', transform: 'trim' },
  { entity: 'order', source_field: 'order_at', target_field: 'order_at', transform: 'identity' },
  { entity: 'order', source_field: 'amount', target_field: 'amount', transform: 'decimal-string' },
  { entity: 'order', source_field: 'currency', target_field: 'currency', transform: 'trim' },
  { entity: 'order', source_field: 'line_id', target_field: 'lines.source_line_id', transform: 'source-id' },
  { entity: 'order', source_field: 'product_code', target_field: 'lines.product_code', transform: 'trim' },
  { entity: 'order', source_field: 'product_name', target_field: 'lines.product_name', transform: 'trim' },
  { entity: 'order', source_field: 'quantity', target_field: 'lines.quantity', transform: 'decimal-string' },
  { entity: 'order', source_field: 'unit_price', target_field: 'lines.unit_price', transform: 'decimal-string' },
  { entity: 'order', source_field: 'line_amount', target_field: 'lines.line_amount', transform: 'decimal-string' },
];

beforeAll(async () => {
  fixture = await startOwnedPostgres({ evidenceFile, evidenceRoot, taskLabel: 'm1task5', imageReference: image });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  schema = `m1_t5_${suffix}`;
  privateSchema = `m1_private_${suffix}`;
  reader = `m1_reader_${suffix}`;
  owner = `m1_owner_${suffix}`;
  await fixture.pool.query(`CREATE ROLE ${owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await fixture.pool.query(`CREATE ROLE ${reader} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await fixture.pool.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${owner}`);
  await fixture.pool.query(`CREATE SCHEMA ${privateSchema}`);
  await fixture.pool.query(`CREATE TABLE ${privateSchema}.hidden_data(secret text)`);
  const ownerClient = await fixture.pool.connect();
  try {
    await ownerClient.query(`SET ROLE ${owner}`);
    await ownerClient.query(`CREATE TABLE ${schema}.customers(customer_id text PRIMARY KEY, customer_name text NOT NULL, updated_at timestamptz NOT NULL)`);
    await ownerClient.query(`CREATE TABLE ${schema}.orders(order_id bigint PRIMARY KEY, customer_id text NOT NULL, order_no text NOT NULL, status text NOT NULL,
      order_at timestamptz NOT NULL, amount numeric(30,12) NOT NULL, currency text NOT NULL, updated_at timestamptz NOT NULL)`);
    await ownerClient.query(`CREATE TABLE ${schema}.order_lines(line_id text PRIMARY KEY, order_id bigint NOT NULL REFERENCES ${schema}.orders(order_id),
      product_code text NOT NULL, product_name text NOT NULL, quantity numeric(30,12) NOT NULL, unit_price numeric(30,12) NOT NULL,
      line_amount numeric(30,12) NOT NULL)`);
    await ownerClient.query(`CREATE TABLE ${schema}.restricted_data(id integer, secret text)`);
    await ownerClient.query(`INSERT INTO ${schema}.customers VALUES('C-1','Original','2026-10-25 10:00:00.123456+00')`);
    await ownerClient.query(`INSERT INTO ${schema}.orders VALUES(9007199254740993123,'C-1','O-1','DRAFT','2026-10-25 10:01:02.123456+00',
      123456789012345678.123456789012,'USD','2026-10-25 10:01:03.123456+00')`);
    await ownerClient.query(`INSERT INTO ${schema}.order_lines VALUES('L-1',9007199254740993123,'SKU-1','Before',1.123456789012,
      123456789012.123456789012,138636548569.222222221445)`);
  } finally { await ownerClient.query('RESET ROLE').catch(() => undefined); ownerClient.release(); }
  await fixture.pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
  await fixture.pool.query(`GRANT SELECT ON ${schema}.customers,${schema}.orders,${schema}.order_lines TO ${reader}`);
  await fixture.pool.query(`GRANT SELECT(id) ON ${schema}.restricted_data TO ${reader}`);
  const { default: pg } = await import('pg');
  ownerPool = new pg.Pool({ host:'127.0.0.1',port:fixture.hostPort,database:'postgres',user:owner,max:1 });
  await ownerPool.query('SELECT 1');
  profile = { revision: 'owned-pg-v1', connector: 'postgresql', protocol: 'postgres:', host: '127.0.0.1', port: fixture.hostPort,
    allow_loopback_plaintext: true, database: 'postgres', user: reader, schema, entities: {
      customer: { table: 'customers', source_pk: 'customer_id', updated_at_field: 'updated_at' },
      order: { table: 'orders', source_pk: 'order_id', updated_at_field: 'updated_at', lines: { table: 'order_lines', order_fk: 'order_id' } },
    } };
}, 90_000);

afterAll(async () => {
  if (fixture) {
    if (ownerPool) await ownerPool.end();
    if (schema) await fixture.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (privateSchema) await fixture.pool.query(`DROP SCHEMA IF EXISTS ${privateSchema} CASCADE`);
    if (reader) await fixture.pool.query(`DROP ROLE IF EXISTS ${reader}`);
    if (owner) await fixture.pool.query(`DROP ROLE IF EXISTS ${owner}`);
    await fixture.close();
  }
});

describe('owned PostgreSQL source fixture', () => {
  it('reads all relations on one MVCC snapshot, retains exact values, and exposes a read-only role', async () => {
    const rolePool = await import('pg').then(({ default: pg }) => new pg.Pool({ host: '127.0.0.1', port: fixture.hostPort,
      database: 'postgres', user: reader, password: 'fixture', max: 1 }));
    const probe = await createBoundedCapabilityProbe({ environmentKind: 'local_lab' }).run({ config, endpoint: profile, secret: 'fixture',
      identityMappings: [], mappings });
    expect(probe).toMatchObject({ passed: true, checks: expect.arrayContaining(['ENDPOINT_REACHABLE']) });
    const emitted: Array<{ relation: string; pk: string; parent: string; facts: Record<string, string | null> }> = [];
    const scan = await extractPostgresSnapshot({ factory: createLocalLabPostgresSourceConnectionFactory(),
      policy: { environmentKind: 'local_lab', policyId: 'owned-loopback-fixture' }, profile, config, password: 'fixture', mappings,
      pageSize: 1, onPage: async page => {
        emitted.push(...page.rows.map(row => ({ relation: row.relation, pk: row.source_pk, parent: row.parent_source_pk, facts: row.facts })));
        if (page.relation === 'customer') {
          await ownerPool.query(`UPDATE ${schema}.customers SET customer_name='Changed',updated_at='2026-10-25 11:00:00.000001+00' WHERE customer_id='C-1'`);
          await ownerPool.query(`UPDATE ${schema}.orders SET order_no='O-CHANGED' WHERE order_id=9007199254740993123`);
          await ownerPool.query(`UPDATE ${schema}.order_lines SET product_name='After' WHERE line_id='L-1'`);
        }
      } });
    expect(emitted).toMatchObject([
      { relation: 'customer', pk: 'C-1', facts: { customer_name: 'Original', source_updated_at: '2026-10-25 10:00:00.123456+00' } },
      { relation: 'order', pk: '9007199254740993123', facts: { order_no: 'O-1', amount: '123456789012345678.123456789012',
        order_at: '2026-10-25 10:01:02.123456+00', source_updated_at: '2026-10-25 10:01:03.123456+00' } },
      { relation: 'order_line', pk: 'L-1', parent: '9007199254740993123', facts: {
        'lines.product_name': 'Before', 'lines.quantity': '1.123456789012', 'lines.unit_price': '123456789012.123456789012',
        'lines.line_amount': '138636548569.222222221445', 'lines.source_line_id': 'L-1' } },
    ]);
    expect(scan.relation_counts).toEqual({ customer: 1, order: 1, order_line: 1 });
    await expect(rolePool.query(`INSERT INTO ${schema}.customers VALUES('C-2','No','2026-10-25 10:00:00Z')`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`UPDATE ${schema}.customers SET customer_name='No' WHERE customer_id='C-1'`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`DELETE FROM ${schema}.customers WHERE customer_id='C-1'`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`TRUNCATE ${schema}.customers`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`SELECT secret FROM ${schema}.restricted_data`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`SELECT secret FROM ${privateSchema}.hidden_data`)).rejects.toMatchObject({ code: '42501' });
    await rolePool.end();
  });
});
