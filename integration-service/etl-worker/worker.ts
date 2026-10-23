import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readHubRuntimeConfiguration, type HubRuntimeConfiguration } from '../contracts/runtime-config.js';

type Source = { name: string; url: string; table: string; kind: 'customer' | 'order' };
type LegacyDependencies = {
  pool: import('pg').Pool;
  ingest: typeof import('../normalization/store.js').ingest;
  fetchOpenMetadataTable: typeof import('../ontology-binding/binding.js').fetchOpenMetadataTable;
  nextRetryDelay: typeof import('./retry.js').nextRetryDelay;
};

export function resolveWorkerSources(environment: NodeJS.ProcessEnv, runtime: HubRuntimeConfiguration): readonly Source[] {
  if (runtime.environmentKind !== 'local_lab' || !runtime.legacyLabEnabled) return [];
  return ([
    { name: 'crm', url: environment.CRM_DB_URL ?? '', table: 'crm_customers', kind: 'customer' },
    { name: 'orders', url: environment.ORDER_DB_URL ?? '', table: 'erp_orders', kind: 'order' },
  ] as Source[]).filter(item => item.url);
}

async function runLegacyWorker(environment: NodeJS.ProcessEnv, sources: readonly Source[], dependencies: LegacyDependencies): Promise<void> {
  const { pool, ingest, fetchOpenMetadataTable, nextRetryDelay } = dependencies;
  async function pull(source: Source) {
    const pg = await import('pg');
    const upstream = new pg.default.Pool({ connectionString: source.url, max: 1 });
    try {
      await pool.query('INSERT INTO control.etl_watermark(source_system) VALUES($1) ON CONFLICT DO NOTHING', [source.name]);
      const mark = (await pool.query('SELECT last_updated_at,last_source_id FROM control.etl_watermark WHERE source_system=$1', [source.name])).rows[0];
      const rows = await upstream.query(`SELECT * FROM ${source.table} WHERE (updated_at,source_id) > ($1::timestamptz,$2::text) ORDER BY updated_at,source_id LIMIT 100`, [mark.last_updated_at,mark.last_source_id]);
      for (const row of rows.rows) {
        const payload = source.kind === 'customer' ? {
          sourceId: row.source_id, tenantId: row.tenant_id, ownerUserId: row.owner_user_id, version: Number(row.version),
          name: row.name, email: row.email ?? undefined, phone: row.phone ?? undefined, deleted: row.deleted ?? false,
        } : {
          sourceId: row.source_id, customerSourceId: row.customer_source_id, customerSourceSystem: 'crm', tenantId: row.tenant_id,
          ownerUserId: row.owner_user_id, version: Number(row.version), total: Number(row.total), status: row.status,
          items: row.items, deleted: row.deleted ?? false,
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
        const fqn = row.payload.kind === 'customer' ? environment.OPENMETADATA_CUSTOMER_FQN : environment.OPENMETADATA_ORDER_FQN;
        if (fqn) await fetchOpenMetadataTable(fqn);
        await pool.query('UPDATE control.hook_outbox SET done_at=now(),last_error=NULL WHERE id=$1', [row.id]);
      } catch (error) {
        await pool.query("UPDATE control.hook_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+($3::integer * interval '1 millisecond') WHERE id=$1", [row.id,String(error),nextRetryDelay(row.attempts)]);
      }
    }
  }
  const tick = async () => { for (const source of sources) await pull(source); await processHooks(); };
  await tick();
  if (environment.WORKER_ONCE === '1') { await pool.end(); return; }
  setInterval(() => { void tick(); }, Number(environment.WORKER_INTERVAL_MS ?? 15000));
}

export async function startWorker(environment: NodeJS.ProcessEnv = process.env): Promise<'not_ready' | 'local_lab'> {
  const runtime = readHubRuntimeConfiguration(environment);
  const sources = resolveWorkerSources(environment, runtime);
  if (!runtime.legacyLabEnabled) return 'not_ready';
  if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
  const [{ pool }, { ingest }, { fetchOpenMetadataTable }, { nextRetryDelay }] = await Promise.all([
    import('../db.js'), import('../normalization/store.js'), import('../ontology-binding/binding.js'), import('./retry.js'),
  ]);
  await runLegacyWorker(environment, sources, { pool, ingest, fetchOpenMetadataTable, nextRetryDelay });
  return 'local_lab';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await startWorker();
