import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const api = process.env.ACCEPTANCE_API_URL ?? 'http://127.0.0.1:3100';
const mcp = process.env.ACCEPTANCE_MCP_URL ?? 'http://127.0.0.1:3101/mcp';
const hasura = process.env.ACCEPTANCE_HASURA_URL ?? 'http://127.0.0.1:8088';
const suffix = randomUUID().slice(0,8);
const customerId = `c-${suffix}`, orderId = `o-${suffix}`;
async function post(kind: string, event: string, body: unknown) {
  const response = await fetch(`${api}/v1/ingest/${kind}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-source-key': process.env.INGEST_API_KEY ?? '',
    'x-source-system': 'acceptance', 'idempotency-key': event
  }, body: JSON.stringify(body) });
  if (response.status !== 200) throw new Error(`Ingest HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{status:string}>;
}
const customer = { sourceId: customerId, tenantId: 'acceptance', ownerUserId: 'alice', version: 1, name: `Acme ${suffix}`, email: 'a@example.test' };
assert.equal((await post('customer', `${customerId}:1`, customer)).status, 'applied');
assert.equal((await post('customer', `${customerId}:1`, customer)).status, 'duplicate');
assert.equal((await post('customer', `${customerId}:old`, { ...customer, version: 0 })).status, 'stale');
const order = { sourceId: orderId, customerSourceId: customerId, tenantId: 'acceptance', ownerUserId: 'alice', version: 1,
  status: 'paid', total: 25, items: [{ sku: 'SKU', quantity: 1, unitPrice: 25 }] };
assert.equal((await post('order', `${orderId}:1`, order)).status, 'applied');
const token = await new SignJWT({ tenant_id: 'acceptance', role: 'sales_reader' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('alice').setIssuer(process.env.AGENT_JWT_ISSUER ?? 'data-hub')
  .setAudience(process.env.AGENT_JWT_AUDIENCE ?? 'sales-mcp').setExpirationTime('5m')
  .sign(new TextEncoder().encode(process.env.AGENT_JWT_SECRET));
const client = new Client({ name: 'acceptance-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
await client.connect(transport);
const tools = await client.listTools();
assert.equal(tools.tools.length, 5);
const result = await client.callTool({ name: 'find_customers', arguments: { term: suffix } });
assert.equal(result.isError, undefined);
assert.ok(result.structuredContent);
assert.match(JSON.stringify(result), new RegExp(suffix));
const found = result.structuredContent as { data: { customer: { id: string }[] } };
const context = await client.callTool({ name: 'get_sales_context', arguments: {} });
assert.equal(context.isError, undefined);
const orders = await client.callTool({ name: 'get_customer_orders', arguments: { customerId: found.data.customer[0].id } });
assert.equal(orders.isError, undefined);
const orderRows = orders.structuredContent as { data: { sales_order: { id: string }[] } };
assert.ok(orderRows.data.sales_order.length >= 1);
const detail = await client.callTool({ name: 'get_order_detail', arguments: { orderId: orderRows.data.sales_order[0].id } });
assert.equal(detail.isError, undefined, JSON.stringify(detail));
assert.match(JSON.stringify(detail), /SKU/);
const summary = await client.callTool({ name: 'get_sales_summary', arguments: {} });
assert.equal(summary.isError, undefined);
assert.ok(summary.structuredContent);
await client.close();
async function graphql(user: string, query: string) {
  const hasuraToken = await new SignJWT({ 'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': ['sales_reader'], 'x-hasura-default-role': 'sales_reader',
    'x-hasura-user-id': user, 'x-hasura-tenant-id': 'acceptance'
  } }).setProtectedHeader({ alg: 'HS256' }).setSubject(user).setIssuedAt().setExpirationTime('60s')
    .sign(new TextEncoder().encode(process.env.HASURA_JWT_SECRET));
  const response = await fetch(`${hasura}/v1/graphql`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${hasuraToken}`
  }, body: JSON.stringify({ query }) });
  return response.json() as Promise<{data?: any;errors?: any[]}>
}
assert.equal((await graphql('bob', 'query { customer { id } }')).data?.customer?.length, 0);
assert.ok((await graphql('alice', 'query { customer { email } }')).errors?.length);
console.log('Live acceptance passed: REST, idempotency, five MCP tools, row and column permissions');

