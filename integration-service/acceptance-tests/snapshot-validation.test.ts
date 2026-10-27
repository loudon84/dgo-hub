import { describe, expect, it } from 'vitest';
import { computeSemanticSnapshotDigest, type SemanticSnapshotFact } from '../etl-worker/snapshot-validation.js';
import { toCanonicalSnapshotCustomer, toCanonicalSnapshotOrder, type SnapshotCanonicalProof } from '../etl-worker/snapshot-canonical.js';

const customer: SemanticSnapshotFact = {
  entity: 'customer', relation: 'customer', parent_source_pk: '', source_pk: 'C001',
  source_version: '9',
  facts: { customer_name: 'Acme', owner_user_id: 'owner-1', dept_id: 'dept-1', status: 'ACTIVE',
    source_updated_at: '2026-01-02T03:04:05Z', deleted_at: null },
};

const order: SemanticSnapshotFact = {
  entity: 'order', relation: 'order', parent_source_pk: '', source_pk: 'O001',
  source_version: '10',
  facts: { customer_id: 'C001', order_no: 'N001', status: 'CONFIRMED', order_at: '2026-01-01T00:00:00Z',
    amount: '12.5', currency: 'CNY', source_updated_at: '2026-01-02T03:04:05Z',
    deleted_at: null,
    lines: [
      { source_line_id: 'L002', product_code: 'P2', product_name: 'Second', quantity: '1', unit_price: '2', line_amount: '2' },
      { source_line_id: 'L001', product_code: 'P1', product_name: 'First', quantity: '1', unit_price: '10.5', line_amount: '10.5' },
    ] },
};

async function* pages(values: readonly SemanticSnapshotFact[], pageSize: number): AsyncIterable<readonly SemanticSnapshotFact[]> {
  for (let offset = 0; offset < values.length; offset += pageSize) yield values.slice(offset, offset + pageSize);
}

const proof: SnapshotCanonicalProof = {
  version_domain: 'SOURCE_VERSION', delete_contract: 'tombstone',
  customer_source_id: 'customer-source',
};

describe('C whole-snapshot semantic digest', () => {
  it('is independent of stage page boundaries and normalizes canonical business facts', async () => {
    const onePage = await computeSemanticSnapshotDigest(pages([customer, order], 20));
    const manyPages = await computeSemanticSnapshotDigest(pages([customer, order], 1));

    expect(onePage).toBe(manyPages);
  });

  it('binds an explicit source tombstone and its source timestamp', async () => {
    const deleted: SemanticSnapshotFact = {
      ...customer, source_version: '11', facts: { deleted_at: '2026-02-03T04:05:06Z', source_updated_at: '2026-02-03T04:05:06Z' },
    };
    const originalDigest = await computeSemanticSnapshotDigest(pages([customer], 1));
    const tombstoneDigest = await computeSemanticSnapshotDigest(pages([deleted], 1));

    expect(tombstoneDigest).not.toBe(originalDigest);
  });

  it('rejects duplicate full source keys while allowing the same line key under different orders', async () => {
    const firstLine: SemanticSnapshotFact = { entity: 'order', relation: 'order_line', parent_source_pk: 'O001', source_pk: 'L1', facts: { line_amount: '1.00' } };
    const secondOrderLine: SemanticSnapshotFact = { ...firstLine, parent_source_pk: 'O002' };

    await expect(computeSemanticSnapshotDigest(pages([firstLine, secondOrderLine], 1))).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(computeSemanticSnapshotDigest(pages([firstLine, firstLine], 1))).rejects.toThrow('SNAPSHOT_DUPLICATE_KEY');
  });

  it('preserves exact 20-digit source versions without numeric conversion', async () => {
    const largest: SemanticSnapshotFact = { ...customer, source_version: '99999999999999999999' };
    await expect(computeSemanticSnapshotDigest(pages([largest], 1))).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects invalid exact decimal facts before a digest can seal', async () => {
    const invalid: SemanticSnapshotFact = { ...customer, facts: { amount: '01.000' } };
    await expect(computeSemanticSnapshotDigest(pages([invalid], 1))).rejects.toThrow('CANONICAL_DECIMAL_INVALID');
  });

  it('rejects a source version that cannot be represented by the exact version contract', async () => {
    const invalid: SemanticSnapshotFact = { ...customer, source_version: '0009' };
    await expect(computeSemanticSnapshotDigest(pages([invalid], 1))).rejects.toThrow('SNAPSHOT_SOURCE_VERSION_INVALID');
  });

  it('maps an explicit boolean customer tombstone to its approved source update timestamp', () => {
    const deleted = toCanonicalSnapshotCustomer({ ...customer, facts: { ...customer.facts, deleted_at: 'true' } }, proof);
    expect(deleted).toEqual({ source_pk: 'C001', source_version: '9', deleted_at: '2026-01-02T03:04:05Z' });
  });

  it('uses the actual timestamp when the source supplies a timestamp tombstone', () => {
    const deleted = toCanonicalSnapshotCustomer({ ...customer, facts: { ...customer.facts, deleted_at: '2026-02-03T04:05:06Z' } }, proof);
    expect(deleted).toEqual({ source_pk: 'C001', source_version: '9', deleted_at: '2026-02-03T04:05:06Z' });
  });

  it('builds a complete canonical order from one header and all exact decimal lines', () => {
    const header: SemanticSnapshotFact = { ...order, facts: { ...order.facts, customer_id: 'C001' } };
    const lineRows: SemanticSnapshotFact[] = [
      { entity: 'order', relation: 'order_line', parent_source_pk: 'O001', source_pk: 'L002', facts: {
        'lines.source_line_id': 'L002', 'lines.product_code': 'P2', 'lines.product_name': 'Second', 'lines.quantity': '1',
        'lines.unit_price': '2', 'lines.line_amount': '2' } },
      { entity: 'order', relation: 'order_line', parent_source_pk: 'O001', source_pk: 'L001', facts: {
        'lines.source_line_id': 'L001', 'lines.product_code': 'P1', 'lines.product_name': 'First', 'lines.quantity': '1',
        'lines.unit_price': '10.5', 'lines.line_amount': '10.5' } },
    ];
    const value = toCanonicalSnapshotOrder(header, lineRows, proof);
    expect(value).toMatchObject({ source_pk: 'O001', customer_external_id: 'C001', amount: '12.50', source_version: '10' });
    expect(value).toMatchObject({ lines: [{ source_line_id: 'L001' }, { source_line_id: 'L002' }] });
  });
});
