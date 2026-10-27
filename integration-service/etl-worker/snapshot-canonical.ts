import { canonicalDeleteSchema, canonicalCustomerSchema, canonicalOrderDeleteSchema, canonicalOrderSchema,
  type CanonicalCustomer, type CanonicalDelete, type CanonicalOrder } from '../normalization/models.js';
import { canonicalVersion } from '../normalization/canonical.js';
import type { SemanticSnapshotFact } from './snapshot-validation.js';

export type SnapshotCanonicalProof = Readonly<{
  version_domain: 'SOURCE_VERSION' | 'SNAPSHOT_OBSERVATION';
  delete_contract: 'tombstone' | 'hard_delete';
  customer_source_id?: string;
}>;

function facts(row: SemanticSnapshotFact): Record<string, unknown> {
  return row.facts as Record<string, unknown>;
}

function requiredText(value: unknown, code = 'SNAPSHOT_FACTS_INVALID'): string {
  if (typeof value !== 'string' || value.length < 1) throw new Error(code);
  return value;
}

function sourceVersion(row: SemanticSnapshotFact, proof: SnapshotCanonicalProof, observation?: string): string {
  const value = proof.version_domain === 'SOURCE_VERSION' ? row.source_version : (observation ?? '0');
  if (typeof value !== 'string') throw new Error('SNAPSHOT_SOURCE_VERSION_INVALID');
  try { return canonicalVersion(value); }
  catch { throw new Error('SNAPSHOT_SOURCE_VERSION_INVALID'); }
}

function sourceDeletion(row: SemanticSnapshotFact, proof: SnapshotCanonicalProof): string | null {
  if (proof.delete_contract !== 'tombstone') return null;
  const value = facts(row).deleted_at;
  if (value === null || value === undefined || value === '' || value === 'false') return null;
  if (value === 'true') return requiredText(facts(row).source_updated_at, 'SNAPSHOT_DELETE_TIMESTAMP_INVALID');
  if (typeof value !== 'string') throw new Error('SNAPSHOT_DELETE_TIMESTAMP_INVALID');
  return value;
}

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); }
  catch { throw new Error('SNAPSHOT_FACTS_INVALID'); }
}

export function toCanonicalSnapshotCustomer(
  row: SemanticSnapshotFact,
  proof: SnapshotCanonicalProof,
  observation?: string,
): CanonicalCustomer | CanonicalDelete {
  if (row.entity !== 'customer' || row.relation !== 'customer' || row.parent_source_pk !== '') throw new Error('SNAPSHOT_FACTS_INVALID');
  const version = sourceVersion(row, proof, observation);
  const deletedAt = sourceDeletion(row, proof);
  if (deletedAt !== null) return parse(canonicalDeleteSchema, { source_pk: row.source_pk, source_version: version, deleted_at: deletedAt });
  const value = facts(row);
  return parse(canonicalCustomerSchema, {
    source_pk: row.source_pk,
    customer_name: value.customer_name,
    owner_external_id: value.owner_user_id,
    dept_external_id: value.dept_id,
    status: value.status,
    ...(value.phone === null || value.phone === undefined ? {} : { phone: value.phone }),
    source_updated_at: value.source_updated_at,
    source_version: version,
    deleted_at: null,
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function toCanonicalSnapshotOrder(
  row: SemanticSnapshotFact,
  lineRows: readonly SemanticSnapshotFact[],
  proof: SnapshotCanonicalProof,
  observation?: string,
): CanonicalOrder | CanonicalDelete {
  if (row.entity !== 'order' || row.relation !== 'order' || row.parent_source_pk !== '' || lineRows.length > 200) {
    throw new Error('SNAPSHOT_FACTS_INVALID');
  }
  const version = sourceVersion(row, proof, observation);
  const deletedAt = sourceDeletion(row, proof);
  if (deletedAt !== null) return parse(canonicalOrderDeleteSchema, { source_pk: row.source_pk, source_version: version, deleted_at: deletedAt });
  const value = facts(row);
  const seen = new Set<string>();
  const lines = lineRows.map(line => {
    if (line.entity !== 'order' || line.relation !== 'order_line' || line.parent_source_pk !== row.source_pk || seen.has(line.source_pk)) {
      throw new Error('SNAPSHOT_ORDER_LINES_INVALID');
    }
    seen.add(line.source_pk);
    const item = facts(line);
    if (item['lines.source_line_id'] !== line.source_pk) throw new Error('SNAPSHOT_ORDER_LINES_INVALID');
    return {
      source_line_id: item['lines.source_line_id'], product_code: item['lines.product_code'],
      product_name: item['lines.product_name'], quantity: item['lines.quantity'], unit_price: item['lines.unit_price'],
      line_amount: item['lines.line_amount'],
    };
  }).sort((left, right) => compareUtf8(String(left.source_line_id), String(right.source_line_id)));
  return parse(canonicalOrderSchema, {
    source_pk: row.source_pk,
    customer_external_id: value.customer_id,
    order_no: value.order_no,
    status: value.status,
    order_at: value.order_at,
    amount: value.amount,
    currency: value.currency,
    source_updated_at: value.source_updated_at,
    source_version: version,
    deleted_at: null,
    lines,
  }) as CanonicalOrder;
}
