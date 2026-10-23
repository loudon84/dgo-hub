import { createServer } from 'node:http';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { pool } from '../db.js';
import { runSalesTool, type Principal } from './queries.js';
import { toolDefinitions } from './tools.js';

async function authenticate(header: string | undefined): Promise<Principal> {
  const token = header?.match(/^Bearer (.+)$/i)?.[1];
  if (!token || !process.env.AGENT_JWT_SECRET) throw new Error('Unauthorized');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.AGENT_JWT_SECRET), {
    issuer: process.env.AGENT_JWT_ISSUER ?? 'data-hub', audience: process.env.AGENT_JWT_AUDIENCE ?? 'sales-mcp'
  });
  if (!payload.sub || typeof payload.tenant_id !== 'string' || payload.role !== 'sales_reader') throw new Error('Invalid principal');
  return { userId: payload.sub, tenantId: payload.tenant_id, role: 'sales_reader' };
}
function makeMcp(principal: Principal) {
  const server = new McpServer({ name: 'sales-data-mcp', version: '1.0.0' });
  for (const tool of toolDefinitions) {
    const schema = { term: z.string().optional(), customerId: z.uuid().optional(), orderId: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() };
    server.registerTool(tool.name, { description: tool.description, inputSchema: schema, annotations: { readOnlyHint: true } }, async args => {
      const start = Date.now();
      try {
        const data = await runSalesTool(principal, tool.name, args as Record<string, unknown>);
        await pool.query('INSERT INTO control.agent_audit(tenant_id,user_id,tool_name,outcome,duration_ms) VALUES($1,$2,$3,$4,$5)', [principal.tenantId,principal.userId,tool.name,'ok',Date.now()-start]);
        const structuredContent = { data, source: 'Hasura V2', scope: { tenantId: principal.tenantId, userId: principal.userId } };
        return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }] };
      } catch (error) {
        await pool.query('INSERT INTO control.agent_audit(tenant_id,user_id,tool_name,outcome,error_code,duration_ms) VALUES($1,$2,$3,$4,$5,$6)', [principal.tenantId,principal.userId,tool.name,'error','QUERY_FAILED',Date.now()-start]);
        return { isError: true, content: [{ type: 'text' as const, text: String(error) }] };
      }
    });
  }
  return server;
}
export function startMcp(port: number) {
  const http = createServer(async (req,res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    try {
      const principal = await authenticate(req.headers.authorization);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeMcp(principal);
      await server.connect(transport);
      await transport.handleRequest(req,res);
      res.on('close', () => { void server.close(); });
    } catch { if (!res.headersSent) res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' })); }
  });
  http.listen(port, '0.0.0.0');
  return http;
}
