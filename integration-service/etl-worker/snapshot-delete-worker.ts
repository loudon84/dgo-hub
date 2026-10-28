import type { Pool } from 'pg';

/** Consume durable C completion reservations in DB order using only the worker role. */
export async function runSnapshotDeleteWorkerOnce(pool: Pool, limit = 20): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('SNAPSHOT_DELETE_WORKER_OPTIONS_INVALID');
  const sources = await pool.query<{ tenant_key: string; source_id: string }>(`SELECT d.tenant_key,d.source_id
    FROM control.etl_snapshot_delete_run d
    WHERE d.status IN ('PENDING','AWAITING_OWNER')
    GROUP BY d.tenant_key,d.source_id
    ORDER BY min(d.last_worker_checked_at) NULLS FIRST,min(d.reservation_ordinal),d.tenant_key,d.source_id LIMIT $1`, [limit]);
  let processed = 0;
  for (const source of sources.rows) {
    for (let pass = 0; pass < limit; pass++) {
      const result = await pool.query<{ consume_etl_snapshot_delete_run: boolean }>(
        'SELECT control.consume_etl_snapshot_delete_run($1,$2)', [source.tenant_key, source.source_id]);
      if (!result.rows[0]?.consume_etl_snapshot_delete_run) break;
      processed++;
    }
  }
  return processed;
}
