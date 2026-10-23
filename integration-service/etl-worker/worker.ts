import pg from 'pg';
import { pool } from '../db.js';
import { ingest } from '../normalization/store.js';
import { fetchOpenMetadataTable } from '../ontology-binding/binding.js';
import { nextRetryDelay } from './retry.js';

type Source = { name: string; url: string; table: string; kind: 'customer' | 'order' };
const sources = ([
  { name: 'crm', url: process.env.CRM_DB_URL ?? '', table: 'crm_customers', kind: 'customer' },
  { name: 'orders', url: process.env.ORDER_DB_URL ?? '', table: 'erp_orders', kind: 'order' }
] as Source[]).filter(x => x.url);
async function pull(source: Source) {
  const upstream = new pg.Pool({ connectionString: source.url, max: 1 });
  try {
    await pool.query('INSERT INTO control.etl_watermark(source_system) VALUES($1) ON CONFLICT DO NOTHING', [source.name]);
    const mark = (await pool.query('SELECT last_updated_at,last_source_id FROM control.etl_watermark WHERE source_system=$1', [source.name])).rows[0];
    // Table names are fixed in source definitions, never interpolated from a request.
    const rows = await upstream.query(`SELECT * FROM ${source.table} WHERE (updated_at,source_id) > ($1::timestamptz,$2::text) ORDER BY updated_at,source_id LIMIT 100`, [mark.last_updated_at,mark.last_source_id]);
    for (const row of rows.rows) {
      const payload = source.kind === 'customer' ? {
        sourceId: row.source_id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id, version: Number(row.version),
        name: row.name, email: row.email ?? undefined, phone: row.phone ?? undefined, deleted: row.deleted ?? false
      } : {
        sourceId: row.source_id, customerSourceId: row.customer_source_id, customerSourceSystem: 'crm', tenantId: row.tenant_id, ownerUserId: row.owner_user_id,
        version: Number(row.version), total: Number(row.total), status: row.status, items: row.items, deleted: row.deleted ?? false
      };
      await ingest(source.kind, source.name, `${row.source_id}:${row.version}`, payload);
      await pool.query("UPDATE control.etl_watermark SET last_updated_at=$2,last_source_id=$3,last_status='ok',last_error=NULL,updated_at=now() WHERE source_system=$1", [source.name,row.updated_at,row.source_id]);
    }
  } catch (error) {
    await pool.query("INSERT INTO control.etl_watermark(source_system,last_status,last_error) VALUES($1,'failed',$2) ON CONFLICT(source_system) DO UPDATE SET last_status='failed',last_error=EXCLUDED.last_error,updated_at=now()", [source.name,String(error)]);
  } finally { await upstream.end(); }
}
async function processHooks() {
  const rows = await pool.query('SELECT id,kind,payload,attempts FROM control.hook_outbox WHERE done_at IS NULL AND next_attempt_at<=now() ORDER BY id LIMIT 20');
  for (const row of rows.rows) {
    try {
      const fqn = row.payload.kind === 'customer' ? process.env.OPENMETADATA_CUSTOMER_FQN : process.env.OPENMETADATA_ORDER_FQN;
      if (fqn) await fetchOpenMetadataTable(fqn); // Reconcile registered asset after every successful write.
      await pool.query('UPDATE control.hook_outbox SET done_at=now(),last_error=NULL WHERE id=$1', [row.id]);
    } catch (error) {
      await pool.query("UPDATE control.hook_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+($3::integer * interval '1 millisecond') WHERE id=$1", [row.id,String(error),nextRetryDelay(row.attempts)]);
    }
  }
}
async function tick() { for (const source of sources) await pull(source); await processHooks(); }
await tick();
if (process.env.WORKER_ONCE === '1') { await pool.end(); process.exit(0); }
setInterval(() => { void tick(); }, Number(process.env.WORKER_INTERVAL_MS ?? 15000));
