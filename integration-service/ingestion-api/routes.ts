import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { ingest } from '../normalization/store.js';
import { fetchOpenMetadataTable, fetchPublishedHelixModels, validateBinding, type Binding } from '../ontology-binding/binding.js';
import { validatePolicy, type PolicyInput } from '../permission-publish/policy.js';
import { toolDefinitions } from '../sales-mcp/tools.js';
import { registerIdentityRoutes, type IdentityRouteOptions } from './identity-routes.js';
import type { HubRuntimeConfiguration } from '../contracts/runtime-config.js';
import { registerSourceRegistryRoutes, type SourceRegistryRouteOptions } from '../source-registry/routes.js';
import { registerStrictIngestionRoutes, type StrictIngestionOptions } from './strict-ingestion.js';

function key(request: { headers: Record<string, unknown> }, expected: string, header: string) {
  if (!expected || request.headers[header] !== expected) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
}
export async function registerRoutes(app: FastifyInstance, options: { identity?: IdentityRouteOptions; sourceRegistry?: SourceRegistryRouteOptions;
  strictIngestion?: StrictIngestionOptions; runtime?: HubRuntimeConfiguration } = {}) {
  if (options.identity) await registerIdentityRoutes(app, options.identity);
  if (options.sourceRegistry) await registerSourceRegistryRoutes(app, options.sourceRegistry);
  await registerStrictIngestionRoutes(app, options.strictIngestion);
  app.get('/health', async () => ({ ok: true }));
  if (options.runtime?.environmentKind !== 'local_lab' || options.runtime.legacyLabEnabled !== true) return;
  app.post<{ Params: { kind: 'customer' | 'order' }; Body: unknown }>('/v1/ingest/:kind', async (request, reply) => {
    key(request, process.env.INGEST_API_KEY ?? '', 'x-source-key');
    if (!['customer','order'].includes(request.params.kind)) return reply.code(404).send({ error: 'unknown kind' });
    const source = String(request.headers['x-source-system'] ?? '');
    const eventId = String(request.headers['idempotency-key'] ?? '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source) || !eventId || eventId.length > 160) return reply.code(400).send({ error: 'missing source or idempotency key' });
    try { return await ingest(request.params.kind, source, eventId, request.body); }
    catch (error) {
      await pool.query('INSERT INTO control.ingestion_failure(source_system,event_id,kind,error) VALUES($1,$2,$3,$4)', [source,eventId,request.params.kind,String(error)]);
      return reply.code(422).send({ error: String(error) });
    }
  });
  app.addHook('preHandler', async request => {
    if (request.url.startsWith('/admin/')) key(request, process.env.ADMIN_API_KEY ?? '', 'x-admin-key');
  });
  app.get('/admin/ingestion/events', async () => (await pool.query('SELECT source_system,event_id,kind,status,received_at,processed_at FROM control.ingestion_event ORDER BY received_at DESC LIMIT 100')).rows);
  app.get('/admin/ingestion/failures', async () => (await pool.query('SELECT * FROM control.ingestion_failure ORDER BY failed_at DESC LIMIT 100')).rows);
  app.get('/admin/etl/watermarks', async () => (await pool.query('SELECT * FROM control.etl_watermark ORDER BY source_system')).rows);
  app.post<{ Params: { source: string } }>('/admin/etl/:source/retry', async request => {
    await pool.query("UPDATE control.etl_watermark SET last_status='retry',last_error=NULL WHERE source_system=$1", [request.params.source]);
    return { queued: true };
  });
  app.get('/admin/ontology/helix', fetchPublishedHelixModels);
  app.get('/admin/ontology/bindings', async () => (await pool.query('SELECT * FROM control.ontology_binding ORDER BY object_type')).rows);
  app.post<{ Body: Binding & { openMetadataFqn: string } }>('/admin/ontology/bindings', async request => {
    const binding = request.body;
    const published = await fetchPublishedHelixModels();
    if (!published.objectTypes.some(x => x.name === binding.objectType)) throw new Error('Helix object type is not published');
    const table = await fetchOpenMetadataTable(binding.openMetadataFqn);
    const validation = validateBinding(binding, (table.columns ?? []).map(x => x.name));
    const row = await pool.query(`INSERT INTO control.ontology_binding(object_type,table_name,fields_json,relationships_json,status,validation_json)
      VALUES($1,$2,$3,$4,'validated',$5) ON CONFLICT(object_type) DO UPDATE SET table_name=EXCLUDED.table_name,fields_json=EXCLUDED.fields_json,relationships_json=EXCLUDED.relationships_json,status='validated',validation_json=EXCLUDED.validation_json,updated_at=now() RETURNING *`,
      [binding.objectType,binding.table,JSON.stringify(binding.fields),JSON.stringify(binding.relationships ?? {}),JSON.stringify({ ...validation, helixGeneration: published.generation, openMetadataTableId: table.id })]);
    return row.rows[0];
  });
  app.get('/admin/permissions', async () => (await pool.query('SELECT * FROM control.permission_policy ORDER BY table_name')).rows);
  app.post<{ Body: PolicyInput & { tenantId: string; userId: string } }>('/admin/permissions/preview', async request => {
    validatePolicy(request.body);
    const table = request.body.table;
    const count = await pool.query(`SELECT count(*)::integer AS visible_rows FROM api.${table} WHERE tenant_id=$1 AND owner_user_id=$2`, [request.body.tenantId,request.body.userId]);
    return { columns: request.body.columns, visibleRows: count.rows[0].visible_rows, note: '预发布估算；生效后应由 Hasura 复验' };
  });
  app.post<{ Body: PolicyInput; Headers: { 'x-actor'?: string } }>('/admin/permissions', async request => {
    validatePolicy(request.body);
    const actor = request.headers['x-actor']; if (!actor) throw new Error('Missing actor');
    const row = await pool.query(`INSERT INTO control.permission_policy(table_name,role_name,columns_json,created_by)
      VALUES($1,$2,$3,$4) ON CONFLICT(table_name,role_name) DO UPDATE SET columns_json=EXCLUDED.columns_json,status='draft',revision=control.permission_policy.revision+1,created_by=EXCLUDED.created_by,approved_by=NULL RETURNING *`,
      [request.body.table,request.body.role,JSON.stringify(request.body.columns),actor]);
    return row.rows[0];
  });
  app.post<{ Params: { id: string }; Headers: { 'x-actor'?: string } }>('/admin/permissions/:id/approve', async request => {
    const actor = request.headers['x-actor']; if (!actor) throw new Error('Missing actor');
    const row = await pool.query("UPDATE control.permission_policy SET status='approved',approved_by=$2 WHERE id=$1 AND status='draft' AND created_by<>$2 RETURNING id", [request.params.id,actor]);
    if (!row.rowCount) throw new Error('Approval rejected');
    return { approved: true };
  });
  app.post<{ Params: { id: string }; Headers: { 'x-actor'?: string } }>('/admin/permissions/:id/publish', async request => {
    const actor = request.headers['x-actor']; if (!actor) throw new Error('Missing actor');
    const row = await pool.query("UPDATE control.permission_policy SET status='publish_pending' WHERE id=$1 AND status='approved' AND approved_by<>$2 RETURNING id", [request.params.id,actor]);
    if (!row.rowCount) throw new Error('Policy requires independent approval');
    return { queued: true };
  });
  app.get('/admin/agent/tools', async () => toolDefinitions.map(({ name,description }) => ({ name,description })));
  app.get<{ Params: { userId: string }; Querystring: { tenantId: string } }>('/admin/agent/scope/:userId', async request => {
    const policies = await pool.query("SELECT table_name,columns_json,status,published_at FROM control.permission_policy WHERE role_name='sales_reader' AND status='published'");
    return { tenantId: request.query.tenantId, userId: request.params.userId, role: 'sales_reader', rowRule: 'tenant_id AND owner_user_id', policies: policies.rows };
  });
  app.get('/admin/agent/audit', async () => (await pool.query('SELECT * FROM control.agent_audit ORDER BY at DESC LIMIT 100')).rows);
  app.get('/admin/agent/errors', async () => (await pool.query("SELECT * FROM control.agent_audit WHERE outcome='error' ORDER BY at DESC LIMIT 50")).rows);
}
