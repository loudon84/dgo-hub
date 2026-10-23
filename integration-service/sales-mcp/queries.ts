import { toolDefinitions } from './tools.js';
import { SignJWT } from 'jose';
import { pool } from '../db.js';

export type Principal = { userId: string; tenantId: string; role: 'sales_reader' };
export function money(cents: number): string { return (cents / 100).toFixed(2); }
export function summarizeRows(rows: { total: string }[]) {
  return { orderCount: rows.length, total: money(rows.reduce((sum, row) => sum + Math.round(Number(row.total) * 100), 0)) };
}
export function rankCustomers(rows: { customer_id: string; total: string }[], limit: number) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.customer_id, (totals.get(row.customer_id) ?? 0) + Math.round(Number(row.total) * 100));
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([customerId, cents]) => ({ customerId, total: money(cents) }));
}
export async function queryHasura(principal: Principal, name: typeof toolDefinitions[number]['name'], args: Record<string, unknown>) {
  const gate = await pool.query("SELECT state,epoch FROM control.query_gate WHERE id=1");
  if (gate.rows[0]?.state !== 'open') throw new Error('Query gate closed');
  const definition = toolDefinitions.find(x => x.name === name)!;
  if (!process.env.HASURA_JWT_SECRET) throw new Error('Hasura JWT secret missing');
  const token = await new SignJWT({ 'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': [principal.role], 'x-hasura-default-role': principal.role,
    'x-hasura-user-id': principal.userId, 'x-hasura-tenant-id': principal.tenantId
  } }).setProtectedHeader({ alg: 'HS256' }).setSubject(principal.userId).setIssuedAt().setExpirationTime('60s')
    .sign(new TextEncoder().encode(process.env.HASURA_JWT_SECRET));
  const response = await fetch(`${process.env.HASURA_URL}/v1/graphql`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`
  }, body: JSON.stringify({ query: definition.query, variables: args }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Hasura HTTP ${response.status}`);
  const body = await response.json() as { data?: Record<string, any>; errors?: unknown[] };
  if (body.errors?.length) throw new Error('Hasura query rejected');
  const after = await pool.query('SELECT state,epoch FROM control.query_gate WHERE id=1');
  if (after.rows[0]?.state !== 'open' || after.rows[0]?.epoch !== gate.rows[0].epoch) throw new Error('Query authorization changed');
  return body.data ?? {};
}
export async function runSalesTool(principal: Principal, name: typeof toolDefinitions[number]['name'], args: Record<string, unknown>) {
  if (name === 'get_sales_context') return { objectTypes: ['Customer','SalesOrder','SalesOrderLine'], metricVersion: 'demo.v1', businessTimezone: 'Asia/Shanghai', scope: principal };
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
  if (!Number.isInteger(limit)) throw new Error('Invalid limit');
  const variables: Record<string, unknown> = {};
  if (name === 'find_customers' || name === 'get_customer_orders') variables.limit = limit;
  if (name === 'find_customers') {
    const term = String(args.term ?? '').trim(); if (!term || term.length > 100) throw new Error('Invalid term');
    variables.term = `%${term.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  }
  if (name === 'get_customer_orders') variables.customerId = String(args.customerId ?? '');
  if (name === 'get_order_detail') variables.id = String(args.orderId ?? '');
  const data = await queryHasura(principal, name, variables);
  if (name === 'get_sales_summary') return data.sales_summary?.[0] ?? { order_count: 0, total: '0.00' };
  return data;
}
