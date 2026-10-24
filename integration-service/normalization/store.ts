import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db.js';
import { normalizeCustomer, normalizeOrder } from './models.js';

export { applyCustomer, applyOrderAggregate } from './apply.js';
export type { ApplyContext, ApplyResult } from './apply.js';

type Kind = 'customer' | 'order';
export async function ingest(kind: Kind, sourceSystem: string, eventId: string, payload: unknown) {
  const record = kind === 'customer' ? normalizeCustomer(payload) : normalizeOrder(payload);
  const hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [sourceSystem,eventId]);
    const old = await client.query('SELECT payload_hash, status FROM control.ingestion_event WHERE source_system=$1 AND event_id=$2', [sourceSystem, eventId]);
    if (old.rowCount) {
      if (old.rows[0].payload_hash !== hash) throw new Error('Idempotency key reused with different payload');
      return { status: 'duplicate', eventId };
    }
    await client.query('INSERT INTO control.ingestion_event(source_system,event_id,kind,payload_hash,status) VALUES($1,$2,$3,$4,$5)', [sourceSystem,eventId,kind,hash,'processing']);
    const outcome = kind === 'customer' ? await upsertCustomer(client, sourceSystem, normalizeCustomer(payload)) : await upsertOrder(client, sourceSystem, normalizeOrder(payload));
    await client.query('UPDATE control.ingestion_event SET status=$3, processed_at=now() WHERE source_system=$1 AND event_id=$2', [sourceSystem,eventId,outcome]);
    if (outcome === 'applied') await client.query('INSERT INTO control.hook_outbox(kind,payload) VALUES($1,$2)', ['metadata_sync', JSON.stringify({ kind, sourceSystem, sourceId: record.sourceId })]);
    return { status: outcome, eventId };
  });
}
async function upsertCustomer(client: pg.PoolClient, source: string, c: ReturnType<typeof normalizeCustomer>) {
  const row = await client.query('SELECT version FROM hub.customer WHERE tenant_id=$1 AND source_system=$2 AND source_id=$3 FOR UPDATE', [c.tenantId,source,c.sourceId]);
  if (row.rowCount && Number(row.rows[0].version) >= c.version) return 'stale';
  const saved = await client.query(`INSERT INTO hub.customer(tenant_id,source_system,source_id,owner_user_id,version,name,email,phone,deleted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(tenant_id,source_system,source_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,version=EXCLUDED.version,name=EXCLUDED.name,email=EXCLUDED.email,phone=EXCLUDED.phone,deleted=EXCLUDED.deleted,updated_at=now()
    WHERE hub.customer.version < EXCLUDED.version RETURNING id`,
    [c.tenantId,source,c.sourceId,c.ownerUserId,c.version,c.name,c.email ?? null,c.phone ?? null,c.deleted]);
  return saved.rowCount ? 'applied' : 'stale';
}
async function upsertOrder(client: pg.PoolClient, source: string, o: ReturnType<typeof normalizeOrder>) {
  const customer = await client.query('SELECT id FROM hub.customer WHERE tenant_id=$1 AND source_system=$2 AND source_id=$3 AND NOT deleted', [o.tenantId,o.customerSourceSystem ?? source,o.customerSourceId]);
  if (!customer.rowCount) throw new Error('Customer mapping not found');
  const row = await client.query('SELECT id,version FROM hub.sales_order WHERE tenant_id=$1 AND source_system=$2 AND source_id=$3 FOR UPDATE', [o.tenantId,source,o.sourceId]);
  if (row.rowCount && Number(row.rows[0].version) >= o.version) return 'stale';
  const saved = await client.query(`INSERT INTO hub.sales_order(tenant_id,source_system,source_id,customer_id,owner_user_id,version,total,status,deleted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(tenant_id,source_system,source_id) DO UPDATE SET customer_id=EXCLUDED.customer_id,owner_user_id=EXCLUDED.owner_user_id,version=EXCLUDED.version,total=EXCLUDED.total,status=EXCLUDED.status,deleted=EXCLUDED.deleted,updated_at=now()
    WHERE hub.sales_order.version < EXCLUDED.version RETURNING id`,
    [o.tenantId,source,o.sourceId,customer.rows[0].id,o.ownerUserId,o.version,o.total,o.status,o.deleted]);
  if (!saved.rowCount) return 'stale';
  const id = saved.rows[0].id;
  await client.query('DELETE FROM hub.order_item WHERE order_id=$1', [id]);
  if (!o.deleted) for (const item of o.items) await client.query('INSERT INTO hub.order_item(order_id,tenant_id,owner_user_id,sku,quantity,unit_price) VALUES($1,$2,$3,$4,$5,$6)', [id,o.tenantId,o.ownerUserId,item.sku,item.quantity,item.unitPrice]);
  return 'applied';
}
