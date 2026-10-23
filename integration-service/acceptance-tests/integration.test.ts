import { describe, expect, it } from 'vitest';
import { summarizeRows, rankCustomers } from '../sales-mcp/queries.js';
import { validateBinding } from '../ontology-binding/binding.js';
import { nextRetryDelay } from '../etl-worker/retry.js';

describe('sales results', () => {
  it('sums visible paid orders in cents', () => {
    expect(summarizeRows([{ total: '10.20' }, { total: '5.10' }])).toEqual({ orderCount: 2, total: '15.30' });
  });
  it('ranks customers from visible order rows', () => {
    expect(rankCustomers([{ customer_id: 'b', total: '2.00' }, { customer_id: 'a', total: '9.00' }, { customer_id: 'b', total: '8.00' }], 1)).toEqual([{ customerId: 'b', total: '10.00' }]);
  });
});
describe('binding and retries', () => {
  it('rejects mappings to unknown physical columns', () => {
    expect(() => validateBinding({ objectType: 'Customer', table: 'customer', fields: { name: 'missing' } }, ['id', 'name'])).toThrow(/missing/);
  });
  it('caps exponential retry delay', () => {
    expect(nextRetryDelay(10)).toBe(60000);
  });
});
