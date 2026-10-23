import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { jwtVerify, SignJWT } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HasuraConfiguration } from './queries.js';
import { toolDefinitions } from './tools.js';

export type LegacyMcpConfiguration = Readonly<{
  agentJwtSecret: string;
  issuer: string;
  audience: string;
  hasura: HasuraConfiguration;
  fetcher?: typeof fetch;
}>;
type LegacyPrincipal = { userId: string; tenantId: string; role: 'sales_reader' };

async function authenticate(header: string | undefined, configuration: LegacyMcpConfiguration): Promise<LegacyPrincipal> {
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
  if (!match) throw new Error('AUTH_INVALID');
  const { payload } = await jwtVerify(match[1], new TextEncoder().encode(configuration.agentJwtSecret), {
    issuer: configuration.issuer, audience: configuration.audience,
  });
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.tenant_id !== 'string' || payload.role !== 'sales_reader') throw new Error('AUTH_INVALID');
  return { userId: payload.sub, tenantId: payload.tenant_id, role: 'sales_reader' };
}

async function queryLegacy(
  pool: Pick<Pool, 'query'>,
  configuration: LegacyMcpConfiguration,
  principal: LegacyPrincipal,
  name: typeof toolDefinitions[number]['name'],
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const gate = await pool.query<{ state: string; epoch: string }>('SELECT state,epoch::text AS epoch FROM control.query_gate WHERE id=1');
  if (gate.rows[0]?.state !== 'open') throw new Error('QUERY_NOT_READY');
  const definition = toolDefinitions.find(item => item.name === name);
  if (!definition) throw new Error('TOOL_INPUT_INVALID');
  if (name === 'get_sales_context') return { objectTypes: ['Customer','SalesOrder','SalesOrderLine'], businessTimezone: 'Asia/Shanghai', scope: principal };
  const role = principal.role;
  const token = await new SignJWT({ 'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': [role], 'x-hasura-default-role': role,
    'x-hasura-user-id': principal.userId, 'x-hasura-tenant-id': principal.tenantId,
  } }).setProtectedHeader({ alg: 'HS256' }).setSubject(principal.userId).setIssuedAt().setExpirationTime('60s')
    .sign(new TextEncoder().encode(configuration.hasura.jwtSecret));
  let variables: Record<string, unknown> = {};
  if (name === 'find_customers') variables = { term: `%${String(args.term ?? '').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, limit: args.limit ?? 20 };
  if (name === 'get_customer_orders') variables = { customerId: args.customerId, limit: args.limit ?? 20 };
  if (name === 'get_order_detail') variables = { id: args.orderId };
  let response: Response;
  try {
    response = await (configuration.fetcher ?? fetch)(`${configuration.hasura.url}/v1/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: definition.query, variables }), signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('QUERY_FAILED'); }
  if (!response.ok) throw new Error('QUERY_FAILED');
  let body: { data?: Record<string, unknown>; errors?: unknown[] };
  try { body = await response.json() as typeof body; } catch { throw new Error('QUERY_FAILED'); }
  if (body.errors?.length || !body.data) throw new Error('QUERY_FAILED');
  const after = await pool.query<{ state: string; epoch: string }>('SELECT state,epoch::text AS epoch FROM control.query_gate WHERE id=1');
  if (after.rows[0]?.state !== 'open' || after.rows[0]?.epoch !== gate.rows[0]?.epoch) throw new Error('AUTH_CONTEXT_CHANGED');
  if (name === 'get_sales_summary') return { sales_summary: (body.data.sales_summary as unknown[] | undefined)?.[0] ?? { order_count: 0, total: '0.00' } };
  return body.data;
}

function safeCode(error: unknown): string {
  if (error instanceof Error && ['AUTH_INVALID','QUERY_NOT_READY','AUTH_CONTEXT_CHANGED','TOOL_INPUT_INVALID','QUERY_FAILED'].includes(error.message)) return error.message;
  return 'QUERY_FAILED';
}

export function registerLegacyMcpRoute(
  app: FastifyInstance,
  pool: Pick<Pool, 'query'>,
  configuration: LegacyMcpConfiguration,
): void {
  app.post('/mcp', async (request, reply) => {
    let principal: LegacyPrincipal;
    try { principal = await authenticate(request.headers.authorization, configuration); }
    catch { return reply.code(401).send({ request_id: request.id, error: { code: 'AUTH_INVALID', message: 'AUTH_INVALID' } }); }
    const server = new McpServer({ name: 'sales-data-mcp-legacy-lab', version: '1.0.0' });
    for (const tool of toolDefinitions) server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true },
    }, async (args: unknown) => {
      try {
        const data = await queryLegacy(pool, configuration, principal, tool.name, args as Record<string, unknown>);
        try {
          await pool.query('INSERT INTO control.agent_audit(tenant_id,user_id,tool_name,outcome,duration_ms) VALUES($1,$2,$3,$4,$5)', [principal.tenantId,principal.userId,tool.name,'ok',0]);
        } catch { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: 'AUDIT_UNAVAILABLE', message: 'AUDIT_UNAVAILABLE' }) }] }; }
        return { structuredContent: { data }, content: [{ type: 'text' as const, text: JSON.stringify({ data }) }] };
      } catch (error) {
        try {
          await pool.query('INSERT INTO control.agent_audit(tenant_id,user_id,tool_name,outcome,error_code,duration_ms) VALUES($1,$2,$3,$4,$5,$6)', [principal.tenantId,principal.userId,tool.name,'error',safeCode(error),0]);
        } catch { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: 'AUDIT_UNAVAILABLE', message: 'AUDIT_UNAVAILABLE' }) }] }; }
        const code = safeCode(error);
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code, message: code }) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    request.raw.on('close', () => { void server.close(); });
    await transport.handleRequest(request.raw as IncomingMessage, reply.raw as ServerResponse, request.body);
  });
}
