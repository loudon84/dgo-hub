import { pool } from '../db.js';
import { buildSelectPermission, defaultPolicies, type PolicyInput } from './policy.js';

async function metadata(type: string, args: unknown, version?: number, resource_version?: number) {
  const response = await fetch(`${process.env.HASURA_URL}/v1/metadata`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-hasura-admin-secret': process.env.HASURA_ADMIN_SECRET ?? ''
  }, body: JSON.stringify({ type, args, ...(version ? { version } : {}), ...(resource_version ? { resource_version } : {}) }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`Hasura metadata ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
export async function bootstrapHasura() {
  for (const table of ['customer','sales_order','order_item','sales_summary','customer_sales']) {
    try { await metadata('pg_track_table', { source: process.env.HASURA_SOURCE ?? 'default', table: { schema: 'api', name: table }, configuration: { custom_root_fields: { select: table } } }); }
    catch (error) { if (!String(error).includes('already tracked')) throw error; }
  }
  try { await metadata('pg_create_array_relationship', { source: process.env.HASURA_SOURCE ?? 'default', table: { schema: 'api', name: 'sales_order' }, name: 'order_items', using: { manual_configuration: { remote_table: { schema: 'api', name: 'order_item' }, column_mapping: { id: 'order_id' } } } }); }
  catch (error) { if (!String(error).includes('already exists')) throw error; }
  for (const policy of defaultPolicies) {
    const existing = await pool.query('SELECT id FROM control.permission_policy WHERE table_name=$1 AND role_name=$2', [policy.table,policy.role]);
    if (existing.rowCount) continue;
    await publishPolicy(policy);
    await pool.query(`INSERT INTO control.permission_policy(table_name,role_name,columns_json,status,created_by,approved_by,published_at)
      VALUES($1,$2,$3,'published','bootstrap','bootstrap',now()) ON CONFLICT(table_name,role_name) DO NOTHING`,
      [policy.table,policy.role,JSON.stringify(policy.columns)]);
  }
  const all = await pool.query('SELECT table_name,role_name,columns_json,status FROM control.permission_policy');
  if (all.rows.some(x => x.status !== 'published')) throw new Error('Unpublished permission policy; query gate remains closed');
  const exported = await metadata('export_metadata', {}, 2) as { metadata: { sources: {name: string; tables: {table: {schema: string; name: string}; select_permissions?: {role: string; permission: unknown}[]}[]}[] } };
  for (const row of all.rows) {
    const policy = { table: row.table_name, role: row.role_name, columns: row.columns_json } as PolicyInput;
    const expected = buildSelectPermission(policy).args.permission;
    const actual = exported.metadata.sources.find(x => x.name === (process.env.HASURA_SOURCE ?? 'default'))?.tables
      .find(x => x.table.schema === 'api' && x.table.name === policy.table)?.select_permissions
      ?.find(x => x.role === policy.role)?.permission;
    if (!permissionMatches(actual, expected)) throw new Error('Hasura permission drift; query gate remains closed');
  }
  await pool.query("UPDATE control.query_gate SET state='open',epoch=epoch+1,changed_at=now() WHERE id=1");
}
function permissionMatches(actualValue: unknown, expected: ReturnType<typeof buildSelectPermission>['args']['permission']) {
  const actual = actualValue as { columns?: string[]; filter?: unknown; limit?: number } | undefined;
  return !!actual && JSON.stringify(actual.columns) === JSON.stringify(expected.columns) &&
    JSON.stringify(actual.filter) === JSON.stringify(expected.filter) && actual.limit === expected.limit;
}
export async function publishPolicy(policy: PolicyInput) {
  const command = buildSelectPermission(policy);
  const exported = await metadata('export_metadata', {}, 2) as {resource_version: number; metadata: {
    sources: {name: string; tables: {table: {schema: string; name: string}; select_permissions?: {role: string; permission: unknown}[]}[]}[]
  }};
  const source = exported.metadata.sources.find(x => x.name === (process.env.HASURA_SOURCE ?? 'default'));
  const table = source?.tables.find(x => x.table.schema === 'api' && x.table.name === policy.table);
  if (!table) throw new Error('Managed Hasura table is not tracked');
  table.select_permissions = (table.select_permissions ?? []).filter(x => x.role !== policy.role);
  table.select_permissions.push({ role: policy.role, permission: command.args.permission });
  await metadata('replace_metadata', { metadata: exported.metadata, allow_inconsistent_metadata: false }, 2, exported.resource_version);
  const inconsistent = await metadata('get_inconsistent_metadata', {});
  if ((inconsistent as { is_consistent?: boolean }).is_consistent === false) throw new Error('Hasura metadata inconsistent');
  const readback = await metadata('export_metadata', {}, 2) as typeof exported;
  const confirmed = readback.metadata.sources.find(x => x.name === (process.env.HASURA_SOURCE ?? 'default'))?.tables
    .find(x => x.table.schema === 'api' && x.table.name === policy.table)?.select_permissions
    ?.find(x => x.role === policy.role);
  if (!permissionMatches(confirmed?.permission, command.args.permission))
    throw new Error('Hasura permission readback differs');
}
export async function publishSavedPolicy(id: string, actor: string) {
  const row = await pool.query('SELECT * FROM control.permission_policy WHERE id=$1', [id]);
  if (!row.rowCount) throw new Error('Policy not found');
  const p = row.rows[0];
  if (p.status !== 'approved' || p.approved_by === actor) throw new Error('Policy requires independent approval');
  const policy = { table: p.table_name, role: p.role_name, columns: p.columns_json } as PolicyInput;
  await pool.query("UPDATE control.query_gate SET state='closed',epoch=epoch+1,changed_at=now() WHERE id=1");
  try { await publishPolicy(policy); await pool.query("UPDATE control.permission_policy SET status='published',published_at=now(),last_error=NULL WHERE id=$1", [id]);
    const unresolved = await pool.query("SELECT 1 FROM control.permission_policy WHERE status<>'published' LIMIT 1");
    if (!unresolved.rowCount) await pool.query("UPDATE control.query_gate SET state='open',epoch=epoch+1,changed_at=now() WHERE id=1"); }
  catch (error) { await pool.query("UPDATE control.permission_policy SET status='failed',last_error=$2 WHERE id=$1", [id,String(error)]); throw error; }
}
