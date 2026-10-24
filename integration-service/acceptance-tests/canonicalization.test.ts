import { describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  canonicalSourceSerialization,
  canonicalVersion,
  sourceContentDigest,
  validateCanonicalIdentifier,
} from '../normalization/canonical.js';
import { canonicalCustomerSchema, canonicalOrderSchema } from '../normalization/models.js';

describe('strict canonical normalization', () => {
  it('normalizes decimal strings exactly at the requested scale', () => {
    expect(canonicalDecimal('1.2', 2)).toBe('1.20');
    expect(canonicalDecimal('2', 6)).toBe('2.000000');
    expect(() => canonicalDecimal('1.001', 2)).toThrow('CANONICAL_DECIMAL_INVALID');
    expect(() => canonicalDecimal('0', 6, { positive: true })).toThrow('CANONICAL_DECIMAL_INVALID');
    expect(() => canonicalDecimal('1000000000000000000', 2)).toThrow('CANONICAL_DECIMAL_INVALID');
    expect(canonicalDecimal('-0', 2)).toBe('0.00');
  });

  it('accepts decimal versions without converting them through Number', () => {
    expect(canonicalVersion('99999999999999999999')).toBe('99999999999999999999');
    expect(() => canonicalVersion('01')).toThrow('CANONICAL_VERSION_INVALID');
    expect(() => canonicalVersion('100000000000000000000')).toThrow('CANONICAL_VERSION_INVALID');
  });

  it('preserves case and rejects padded or oversized public identifiers', () => {
    expect(validateCanonicalIdentifier('AbC-1')).toBe('AbC-1');
    expect(validateCanonicalIdentifier('AbC-1')).not.toBe('abc-1');
    expect(() => validateCanonicalIdentifier(' AbC-1')).toThrow('CANONICAL_IDENTIFIER_INVALID');
    expect(() => validateCanonicalIdentifier('x'.repeat(129))).toThrow('CANONICAL_IDENTIFIER_INVALID');
  });

  it('hashes source business content before owner resolution and ignores processing metadata', () => {
    const left = sourceContentDigest({
      customer_name: 'Acme', owner_external_id: 'owner-A', phone: null,
      source_version: '1', observation_seq: '7', channel_epoch: '2', event_id: 'evt-1',
    });
    const right = sourceContentDigest({
      event_id: 'evt-2', channel_epoch: '3', observation_seq: '99', source_version: '2',
      phone: null, owner_external_id: 'owner-A', customer_name: 'Acme',
    });
    expect(left).toBe(right);
    expect(sourceContentDigest({ customer_name: 'Acme', owner_external_id: 'owner-B', phone: null })).not.toBe(left);
    expect(sourceContentDigest({ customer_name: 'Acme', owner_external_id: 'owner-A' })).not.toBe(
      sourceContentDigest({ customer_name: 'Acme', owner_external_id: 'owner-A', phone: null }),
    );
    expect(sourceContentDigest({ amount:'1.00', channel_id:'ch-1', version_seq:'1', received_at:'t1' }))
      .toBe(sourceContentDigest({ amount:'1.00', channel_id:'ch-2', version_seq:'2', received_at:'t2' }));
  });

  it('orders complete line images by their case-sensitive source line id', () => {
    const a = sourceContentDigest({ order_no: 'O-1', lines: [
      { source_line_id: 'b', product_code: 'B', line_amount: '2' },
      { source_line_id: 'A', product_code: 'A', line_amount: '1' },
    ] });
    const b = sourceContentDigest({ order_no: 'O-1', lines: [
      { source_line_id: 'A', product_code: 'A', line_amount: '1' },
      { source_line_id: 'b', product_code: 'B', line_amount: '2' },
    ] });
    expect(a).toBe(b);
  });

  it('orders keys by UTF-8 bytes instead of runtime locale or UTF-16 collation', () => {
    const serialized = canonicalSourceSerialization({ '\u{10000}': 1, '\uE000': 2 });
    expect(serialized).toBe('{"\uE000":2,"𐀀":1}');
  });

  it('keeps canonical source identity separate from legacy demo models', () => {
    const customer = canonicalCustomerSchema.parse({
      source_pk: 'CRM-1', customer_name: 'Acme', owner_external_id: 'user-1',
      dept_external_id: 'dept-1', status: 'ACTIVE', source_updated_at: '2026-01-01T00:00:00Z',
      source_version: '1',
    });
    expect(customer.phone).toBeUndefined();
    expect(customer.deleted_at).toBeUndefined();
    expect(customer.source_version).toBe('1');
    const explicitNull=canonicalCustomerSchema.parse({source_pk:'CRM-1',customer_name:'Acme',owner_external_id:'user-1',
      dept_external_id:'dept-1',status:'ACTIVE',phone:null,deleted_at:null,source_updated_at:'2026-01-01T00:00:00Z',source_version:'1'});
    expect(sourceContentDigest(customer)).not.toBe(sourceContentDigest(explicitNull));
    expect(canonicalOrderSchema.safeParse({
      source_pk: 'O-1', customer_external_id: 'CRM-1', order_no: 'O-1', status: 'DRAFT',
      order_at: '2026-01-01T00:00:00Z', amount: '3.00', currency: 'CNY',
      source_updated_at: '2026-01-01T00:00:00Z', source_version: '1',
    }).success).toBe(false);
    expect(canonicalOrderSchema.parse({
      source_pk: 'O-1', customer_external_id: 'CRM-1', order_no: 'O-1', status: 'DRAFT',
      order_at: '2026-01-01T00:00:00Z', amount: '3.00', currency: 'CNY',
      source_updated_at: '2026-01-01T00:00:00Z', source_version: '1', lines: [],
    }).lines).toEqual([]);
  });
});
