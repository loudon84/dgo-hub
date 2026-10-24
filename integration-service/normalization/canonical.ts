import { createHash } from 'node:crypto';

const IDENTIFIER = /^[^\u0000-\u001f\u007f]+$/u;
const DECIMAL_FIELDS: Readonly<Record<string, number>> = Object.freeze({
  amount: 2,
  line_amount: 2,
  quantity: 6,
  unit_price: 6,
});
const PROCESSING_FIELDS = new Set([
  'source_version', 'version_seq', 'version_sequence', 'observation_seq', 'observation_sequence',
  'channel_id', 'source_channel_id', 'channelId', 'channel_epoch', 'version_domain', 'version_mode',
  'event_id', 'eventId', 'event_sequence', 'batch_id', 'batchId', 'batch_sequence', 'request_id', 'requestId',
  'receive_at', 'received_at', 'receivedAt', 'processed_at', 'processing_at', 'processingAt',
]);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export type DecimalOptions = Readonly<{ positive?: boolean; nonnegative?: boolean }>;

export function canonicalDecimal(value: unknown, scale: number, options: DecimalOptions = {}): string {
  if (typeof value !== 'string' || !Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error('CANONICAL_DECIMAL_INVALID');
  }
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match || (match[3]?.length ?? 0) > scale || match[2].length > 20 - scale) throw new Error('CANONICAL_DECIMAL_INVALID');
  const fraction = (match[3] ?? '').padEnd(scale, '0');
  const magnitude = BigInt(match[2]) * 10n ** BigInt(scale) + BigInt(fraction || '0');
  const signed = magnitude === 0n ? 0n : match[1] === '-' ? -magnitude : magnitude;
  if ((options.positive && signed <= 0n) || (options.nonnegative && signed < 0n)) throw new Error('CANONICAL_DECIMAL_INVALID');
  const digits = (signed < 0n ? -signed : signed).toString().padStart(scale + 1, '0');
  const normalized = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return signed < 0n ? `-${normalized}` : normalized;
}

export function canonicalVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error('CANONICAL_VERSION_INVALID');
  }
  return value;
}

export function validateCanonicalIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      value.trim() !== value || !IDENTIFIER.test(value)) {
    throw new Error('CANONICAL_IDENTIFIER_INVALID');
  }
  return value;
}

function normalizeSourceValue(value: unknown, key?: string): unknown {
  if (key && Object.hasOwn(DECIMAL_FIELDS, key)) return canonicalDecimal(value, DECIMAL_FIELDS[key]);
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeSourceValue(item));
    if (normalized.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).source_line_id === 'string')) {
      normalized.sort((left, right) => {
        const a = (left as Record<string, unknown>).source_line_id as string;
        const b = (right as Record<string, unknown>).source_line_id as string;
        return compareUtf8(a, b);
      });
    }
    return normalized;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(compareUtf8).filter(field => !PROCESSING_FIELDS.has(field))
      .map(field => [field, normalizeSourceValue(record[field], field)]));
  }
  return value;
}

export function canonicalSourceSerialization(sourceBusinessContent: unknown): string {
  return JSON.stringify(normalizeSourceValue(sourceBusinessContent));
}

export function sourceContentDigest(sourceBusinessContent: unknown): string {
  return createHash('sha256').update(canonicalSourceSerialization(sourceBusinessContent), 'utf8').digest('hex');
}
