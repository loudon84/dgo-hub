import { pool } from '../db.js';
import { bootstrapHasura, publishSavedPolicy } from './hasura.js';

for (let attempt = 0; attempt < 30; attempt++) {
  try { await bootstrapHasura(); break; }
  catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
}
while (true) {
  const pending = await pool.query("SELECT id,created_by,approved_by FROM control.permission_policy WHERE status='publish_pending' ORDER BY table_name LIMIT 1");
  if (pending.rowCount) {
    const row = pending.rows[0];
    await pool.query("UPDATE control.permission_policy SET status='approved' WHERE id=$1 AND status='publish_pending'", [row.id]);
    try { await publishSavedPolicy(row.id, 'publisher'); } catch (error) { console.error('Permission publish failed', error); }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
