import { describe, expect, it } from 'vitest';
import { normalizeCustomer, normalizeOrder } from '../normalization/models.js';
import { buildSelectPermission, validatePolicy } from '../permission-publish/policy.js';
import { toolDefinitions } from '../sales-mcp/tools.js';

describe('normalization', () => {
  it('rejects an order whose line total differs from the header total', () => {
    expect(() => normalizeOrder({ sourceId: 'o1', customerSourceId: 'c1', tenantId: 't1', ownerUserId: 'u1', version: 1, total: 99, items: [{ sku: 'A', quantity: 2, unitPrice: 20 }] })).toThrow(/total/i);
  });
  it('normalizes a complete customer with a stable source key', () => {
    expect(normalizeCustomer({ sourceId: 'c1', tenantId: 't1', ownerUserId: 'u1', version: 1, name: ' Acme ' }).name).toBe('Acme');
  });
});

describe('permissions and tools', () => {
  it('rejects columns outside the approved allowlist', () => {
    expect(() => validatePolicy({ table: 'customer', role: 'sales_reader', columns: ['password_hash'] })).toThrow(/column/i);
  });
  it('binds tenant and owner row filters to Hasura session variables', () => {
    const p = buildSelectPermission({ table: 'customer', role: 'sales_reader', columns: ['id', 'name'] });
    expect(p.args.permission.filter).toEqual({ _and: [{ tenant_id: { _eq: 'X-Hasura-Tenant-Id' } }, { owner_user_id: { _eq: 'X-Hasura-User-Id' } }] });
  });
  it('exposes exactly five read-only sales tools', () => {
    expect(toolDefinitions.map(x => x.name).sort()).toEqual(['find_customers', 'get_customer_orders', 'get_order_detail', 'get_sales_context', 'get_sales_summary']);
  });
});
