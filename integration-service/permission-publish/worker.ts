import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readHubRuntimeConfiguration, type HubRuntimeConfiguration } from '../contracts/runtime-config.js';

export async function preparePermissionPublisher(
  runtime: HubRuntimeConfiguration,
  closeQueryGate: () => Promise<void>,
  bootstrap: () => Promise<void>,
): Promise<'not_ready' | 'local_lab'> {
  if (!runtime.legacyLabEnabled || runtime.environmentKind !== 'local_lab') {
    await closeQueryGate();
    return 'not_ready';
  }
  await bootstrap();
  return 'local_lab';
}

export async function startPermissionPublisher(environment: NodeJS.ProcessEnv = process.env): Promise<'not_ready' | 'local_lab'> {
  const runtime = readHubRuntimeConfiguration(environment);
  if (!environment.DATABASE_URL) throw new Error('RUNTIME_CONFIG_INVALID');
  const { pool } = await import('../db.js');
  const mode = await preparePermissionPublisher(runtime, async () => {
    await pool.query("UPDATE control.query_gate SET state='closed',epoch=epoch+1,changed_at=now() WHERE id=1");
  }, async () => {
    const { bootstrapHasura } = await import('./hasura.js');
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await bootstrapHasura(); break; }
      catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
    }
  });
  if (mode === 'not_ready') return mode;
  const { publishSavedPolicy } = await import('./hasura.js');
  while (true) {
    const pending = await pool.query("SELECT id,created_by,approved_by FROM control.permission_policy WHERE status='publish_pending' ORDER BY table_name LIMIT 1");
    if (pending.rowCount) {
      const row = pending.rows[0];
      await pool.query("UPDATE control.permission_policy SET status='approved' WHERE id=$1 AND status='publish_pending'", [row.id]);
      try { await publishSavedPolicy(row.id, 'publisher'); } catch { /* The controlled lab gate remains closed on failure. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await startPermissionPublisher();
