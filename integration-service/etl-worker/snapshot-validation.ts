import { createHash } from 'node:crypto';
import { canonicalVersion, sourceContentDigest } from '../normalization/canonical.js';

export type SemanticSnapshotFact = Readonly<{
  entity: 'customer' | 'order';
  relation: 'customer' | 'order' | 'order_line';
  parent_source_pk: string;
  source_pk: string;
  source_version?: string | null;
  facts: Readonly<Record<string, unknown>>;
}>;

const RELATION_ORDER: Readonly<Record<SemanticSnapshotFact['relation'], number>> = Object.freeze({ customer: 0, order: 1, order_line: 2 });

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareFullKey(left: SemanticSnapshotFact, right: SemanticSnapshotFact): number {
  return RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation] ||
    compareUtf8(left.parent_source_pk, right.parent_source_pk) || compareUtf8(left.source_pk, right.source_pk);
}

function putField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length).update(bytes);
}

/**
 * Hashes already normalized business facts in indexed full-key order. The caller streams
 * bounded durable pages in customer, order, then order-line order; this function retains
 * only the previous key and digest state, never the snapshot rows.
 */
export async function computeSemanticSnapshotDigest(
  pages: AsyncIterable<readonly SemanticSnapshotFact[]>,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update('dgo.snapshot.semantic.v1\0', 'utf8');
  let previous: SemanticSnapshotFact | undefined;
  for await (const page of pages) {
    if (!Array.isArray(page) || page.length > 1000) throw new Error('SNAPSHOT_PAGE_INVALID');
    for (const row of page) {
      if (!row || !['customer', 'order'].includes(row.entity) ||
          (row.relation === 'customer' && (row.entity !== 'customer' || row.parent_source_pk !== '')) ||
          (row.relation === 'order' && (row.entity !== 'order' || row.parent_source_pk !== '')) ||
          (row.relation === 'order_line' && (row.entity !== 'order' || !row.parent_source_pk)) ||
          !['customer', 'order', 'order_line'].includes(row.relation) ||
          typeof row.source_pk !== 'string' || row.source_pk.length < 1 || typeof row.parent_source_pk !== 'string' ||
          !row.facts || typeof row.facts !== 'object' || Array.isArray(row.facts)) {
        throw new Error('SNAPSHOT_STAGE_RECORD_INVALID');
      }
      if (row.source_version !== undefined && row.source_version !== null) {
        try { canonicalVersion(row.source_version); }
        catch { throw new Error('SNAPSHOT_SOURCE_VERSION_INVALID'); }
      }
      if (previous) {
        const order = compareFullKey(previous, row);
        if (order === 0) throw new Error('SNAPSHOT_DUPLICATE_KEY');
        if (order > 0) throw new Error('SNAPSHOT_STAGE_ORDER_INVALID');
      }
      // Canonical source normalization validates exact decimals and sorts line facts by
      // UTF-8 source_line_id. Its processing/version fields are deliberately excluded.
      const businessFacts = row.relation === 'order_line'
        ? Object.fromEntries(Object.entries(row.facts).map(([key, value]) => [key.startsWith('lines.') ? key.slice(6) : key, value]))
        : row.facts;
      const businessDigest = sourceContentDigest(businessFacts);
      putField(hash, row.entity);
      putField(hash, row.relation);
      putField(hash, row.parent_source_pk);
      putField(hash, row.source_pk);
      putField(hash, businessDigest);
      previous = row;
    }
  }
  return hash.digest('hex');
}
