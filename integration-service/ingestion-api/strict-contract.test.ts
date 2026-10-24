import { describe, expect, it } from 'vitest';
import { canonicalHubJson, canonicalJson, IngestInputError, parseStrictJson, requestDigest, validateHubBatch } from './strict-contract.js';

const validCustomer = {
  schema_version: 'hub.v1',
  batch_id: 'ab000000-0000-4000-8000-000000000001',
  records: [{
    event_id: 'cd000000-0000-4000-8000-000000000101', source_pk: 'C001', source_version: '1',
    operation: 'UPSERT', source_updated_at: '2026-10-22T09:00:00+08:00',
    data: { customer_name: '示例 A', owner_external_id: 'SALES-001', department_external_id: 'EAST', status: 'ACTIVE' },
  }],
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

describe('strict hub.v1 contract', () => {
  it('rejects malformed UTF-8 and unpaired surrogate escapes', () => {
    expect(() => parseStrictJson(Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0xc3,0x28,0x7d]))).toThrow(IngestInputError);
    expect(() => parseStrictJson(Buffer.from('{"a":"\\ud800"}'))).toThrow(IngestInputError);
  });

  it('sorts object keys by Unicode code point instead of UTF-16 code unit', () => {
    const value = { '\u{10000}': 'astral', '\uE000': 'bmp' };
    expect(canonicalJson(value)).toBe('{"":"bmp","𐀀":"astral"}');
  });

  it('normalizes object key order and insignificant JSON whitespace while preserving public values', () => {
    const compact = validateHubBatch(parseStrictJson(json(validCustomer)), 'customer');
    const spacedRaw = Buffer.from(` { "records" : [ ${JSON.stringify(validCustomer.records[0])} ], "batch_id" : "${validCustomer.batch_id}", "schema_version" : "hub.v1" } `);
    const spaced = validateHubBatch(parseStrictJson(spacedRaw), 'customer');
    expect(canonicalHubJson(compact)).toBe(canonicalHubJson(spaced));
    expect(requestDigest(compact, 'tenant_a', 'crm-demo', '/hub/v1/ingest/crm/customers').toString('hex'))
      .toBe('309a7977738af01dbe1e750e77ba6678856715254aa809a915eab818466c0fa2');
  });

  it('preserves digest distinctions for UUID case, timestamp offset, absent versus null and source ID case', () => {
    const base = validateHubBatch(parseStrictJson(json(validCustomer)), 'customer');
    const variants = [
      { ...validCustomer, batch_id: validCustomer.batch_id.toUpperCase() },
      { ...validCustomer, records: [{ ...validCustomer.records[0], source_updated_at: '2026-10-22T01:00:00Z' }] },
      { ...validCustomer, records: [{ ...validCustomer.records[0], data: { ...validCustomer.records[0]!.data, phone: null } }] },
      { ...validCustomer, records: [{ ...validCustomer.records[0], source_version: '2' }] },
    ];
    const baseDigest = requestDigest(base, 'tenant_a', 'crm-demo', '/hub/v1/ingest/crm/customers').toString('hex');
    for (const variant of variants) {
      const digest = requestDigest(validateHubBatch(parseStrictJson(json(variant)), 'customer'), 'tenant_a', 'crm-demo', '/hub/v1/ingest/crm/customers').toString('hex');
      expect(digest).not.toBe(baseDigest);
    }
    const orderBody = {
      schema_version: 'hub.v1', batch_id: validCustomer.batch_id,
      records: [{ event_id: validCustomer.records[0]!.event_id, source_pk: 'O1', source_version: '1', operation: 'UPSERT', source_updated_at: validCustomer.records[0]!.source_updated_at,
        data: { customer_ref: { source_id: 'CRM-demo', source_pk: 'C1' }, order_no: 'SO-1', status: 'DRAFT', order_at: validCustomer.records[0]!.source_updated_at,
          amount: '1.0', currency: 'CNY', lines: [] } }],
    };
    const upper = requestDigest(validateHubBatch(parseStrictJson(json(orderBody)), 'order'), 'tenant_a', 'orders-demo', '/hub/v1/ingest/orders/orders').toString('hex');
    const lowerBody = structuredClone(orderBody);
    lowerBody.records[0]!.data.customer_ref.source_id = 'crm-demo';
    const lower = requestDigest(validateHubBatch(parseStrictJson(json(lowerBody)), 'order'), 'tenant_a', 'orders-demo', '/hub/v1/ingest/orders/orders').toString('hex');
    expect(upper).not.toBe(lower);

    const lineA = { source_line_id:'A',product_code:'SKU-A',product_name:'A',quantity:'1',unit_price:'1',line_amount:'1' };
    const lineB = { source_line_id:'B',product_code:'SKU-B',product_name:'B',quantity:'1',unit_price:'1',line_amount:'1' };
    const orderedBody = { ...orderBody, records: [{ ...orderBody.records[0]!, data: { ...orderBody.records[0]!.data, status:'CONFIRMED',
      lines:[lineA,lineB] } }] };
    const reorderedBody = structuredClone(orderedBody);
    reorderedBody.records[0]!.data.lines.reverse();
    expect(requestDigest(validateHubBatch(parseStrictJson(json(orderedBody)),'order'),'tenant_a','orders-demo','/hub/v1/ingest/orders/orders'))
      .not.toEqual(requestDigest(validateHubBatch(parseStrictJson(json(reorderedBody)),'order'),'tenant_a','orders-demo','/hub/v1/ingest/orders/orders'));
    const lexicalBody = structuredClone(orderBody);
    lexicalBody.records[0]!.data.amount = '1.00';
    expect(requestDigest(validateHubBatch(parseStrictJson(json(orderBody)),'order'),'tenant_a','orders-demo','/hub/v1/ingest/orders/orders'))
      .not.toEqual(requestDigest(validateHubBatch(parseStrictJson(json(lexicalBody)),'order'),'tenant_a','orders-demo','/hub/v1/ingest/orders/orders'));
  });

  it('rejects invalid public data without normalizing accepted strings', () => {
    expect(() => validateHubBatch(parseStrictJson(Buffer.from('{"schema_version":"hub.v1","batch_id":"10000000-0000-4000-8000-000000000001","records":[]}')), 'customer'))
      .toThrow(IngestInputError);
    const accepted = validateHubBatch(parseStrictJson(json(validCustomer)), 'customer');
    expect(accepted.records[0]?.source_updated_at).toBe('2026-10-22T09:00:00+08:00');
  });

  it.each([
    ['DRAFT', 0, true], ['DRAFT', 1, true], ['CANCELLED', 0, true], ['CANCELLED', 1, true],
    ['CONFIRMED', 0, false], ['CONFIRMED', 1, true], ['COMPLETED', 0, false], ['COMPLETED', 1, true],
  ] as const)('applies the public order line rule for %s with %i lines', (status, lineCount, valid) => {
    const orderBody = {
      schema_version: 'hub.v1', batch_id: 'ab000000-0000-4000-8000-000000000001',
      records: [{ event_id: 'cd000000-0000-4000-8000-000000000101', source_pk: 'O1', source_version: '1', operation: 'UPSERT', source_updated_at: '2026-10-22T09:00:00+08:00',
        data: { customer_ref: { source_id: 'crm-demo', source_pk: 'C1' }, order_no: 'SO-1', status, order_at: '2026-10-22T09:00:00+08:00',
          amount: '1.00', currency: 'CNY', lines: Array.from({ length: lineCount }, (_, index) => ({ source_line_id: String(index + 1), product_code: 'SKU', product_name: 'Product', quantity: '1.000000', unit_price: '1.000000', line_amount: '1.00' })) } }],
    };
    if (valid) expect(() => validateHubBatch(parseStrictJson(json(orderBody)), 'order')).not.toThrow();
    else expect(() => validateHubBatch(parseStrictJson(json(orderBody)), 'order')).toThrow(IngestInputError);
  });

  it('enforces the PRD 2,048-character phone limit without normalizing its content', () => {
    const accepted = { ...validCustomer, records: [{ ...validCustomer.records[0]!, data: { ...validCustomer.records[0]!.data,
      phone: '☎'.repeat(2048) } }] };
    expect(() => validateHubBatch(parseStrictJson(json(accepted)),'customer')).not.toThrow();
    const tooLong = { ...validCustomer, records: [{ ...validCustomer.records[0]!, data: { ...validCustomer.records[0]!.data,
      phone: '☎'.repeat(2049) } }] };
    expect(() => validateHubBatch(parseStrictJson(json(tooLong)),'customer')).toThrow(IngestInputError);
  });
});
