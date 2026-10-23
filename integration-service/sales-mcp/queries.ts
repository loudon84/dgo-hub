import { SignJWT } from 'jose';
import type { AgentPrincipal } from '../auth/types.js';
import { deriveExecutionRole } from '../auth/credentials.js';
import { toolDefinitions } from './tools.js';
import type { SalesQueryExecutor } from './server.js';

export type SalesToolName = typeof toolDefinitions[number]['name'];
export type HasuraConfiguration = Readonly<{ url: string; jwtSecret: string }>;

export function money(cents: number): string { return (cents / 100).toFixed(2); }
export function summarizeRows(rows: { total: string }[]) {
  return { orderCount: rows.length, total: money(rows.reduce((sum, row) => sum + Math.round(Number(row.total) * 100), 0)) };
}
export function rankCustomers(rows: { customer_id: string; total: string }[], limit: number) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.customer_id, (totals.get(row.customer_id) ?? 0) + Math.round(Number(row.total) * 100));
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([customerId, cents]) => ({ customerId, total: money(cents) }));
}

export function readHasuraConfiguration(environment: NodeJS.ProcessEnv = process.env): HasuraConfiguration {
  const urlText = environment.HASURA_URL;
  const jwtSecret = environment.HASURA_JWT_SECRET;
  if (!urlText || !jwtSecret || jwtSecret.length < 32) throw new Error('MCP_CONFIG_INVALID');
  try {
    const url = new URL(urlText);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    return Object.freeze({ url: url.origin, jwtSecret });
  } catch { throw new Error('MCP_CONFIG_INVALID'); }
}

export function createHasuraQueryExecutor(configuration: HasuraConfiguration, fetcher: typeof fetch = fetch): SalesQueryExecutor {
  return async ({ principal, name, variables }) => {
    if (!principal.businessRole) throw new Error('AUTH_FORBIDDEN');
    const role = deriveExecutionRole(principal.tenantId, principal.businessRole);
    const token = await new SignJWT({ 'https://hasura.io/jwt/claims': {
      'x-hasura-allowed-roles': [role], 'x-hasura-default-role': role,
      'x-hasura-user-id': principal.userId, 'x-hasura-tenant-id': principal.tenantId,
      ...(principal.departmentId ? { 'x-hasura-department-id': principal.departmentId } : {}),
    } }).setProtectedHeader({ alg: 'HS256' }).setSubject(principal.userId).setAudience('hasura-sales')
      .setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(configuration.jwtSecret));
    const definition = toolDefinitions.find(item => item.name === name);
    if (!definition || !definition.query) throw new Error('QUERY_FAILED');
    let response: Response;
    try {
      response = await fetcher(`${configuration.url}/v1/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: definition.query, variables }), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error('QUERY_FAILED'); }
    if (!response.ok) throw new Error('QUERY_FAILED');
    try {
      const body = await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
      if (body.errors?.length || !body.data || typeof body.data !== 'object') throw new Error('QUERY_FAILED');
      return body.data;
    } catch { throw new Error('QUERY_FAILED'); }
  };
}

export async function runSalesTool(
  principal: AgentPrincipal,
  name: SalesToolName,
  rawArgs: Record<string, unknown>,
  executor: SalesQueryExecutor,
): Promise<unknown> {
  const definition = toolDefinitions.find(item => item.name === name);
  if (!definition) throw new Error('TOOL_INPUT_INVALID');
  const parsed = definition.inputSchema.safeParse(rawArgs);
  if (!parsed.success) throw new Error('TOOL_INPUT_INVALID');
  const args = parsed.data as Record<string, unknown>;
  if (name === 'get_sales_context') return {
    userId: principal.userId, tenantId: principal.tenantId, departmentId: principal.departmentId,
    businessRole: principal.businessRole, businessTimezone: principal.businessTimezone,
  };
  const variables: Record<string, unknown> = {};
  if (name === 'find_customers' || name === 'get_customer_orders') variables.limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
  if (name === 'find_customers') {
    const term = String(args.term).trim();
    variables.term = `%${term.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  }
  if (name === 'get_customer_orders') variables.customerId = args.customerId;
  if (name === 'get_order_detail') variables.id = args.orderId;
  const data = await executor({ principal, name, variables });
  if (name === 'get_sales_summary') return data.sales_summary ?? [];
  return data;
}
