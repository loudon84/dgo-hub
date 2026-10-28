import type { PublicRecord } from '../ingestion-api/strict-contract.js';
import { customerReferenceMappingKey } from '../source-registry/import-sample.js';

function canonicalUtc(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('DURABLE_FACTS_INVALID');
  const [, year, month, day, hour, minute, secondText, fraction, zone] = match;
  const second = Number(secondText);
  if (second > 60) throw new Error('DURABLE_FACTS_INVALID');
  let instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Math.min(second, 59));
  if (second === 60) instant += 1000;
  if (zone !== 'Z') {
    const sign = zone![0] === '+' ? 1 : -1;
    const offset = Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(4, 6));
    instant -= sign * offset * 60_000;
  }
  const normalized = new Date(instant).toISOString().slice(0, 19);
  return `${normalized}${fraction ?? ''}Z`;
}

function canonicalDecimal(value: string, scale: number): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error('DURABLE_FACTS_INVALID');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error('DURABLE_FACTS_INVALID');
  return `${whole}.${fraction.padEnd(scale, '0')}`;
}

export function canonicalCustomerInput(record: PublicRecord) {
  const updated = canonicalUtc(record.source_updated_at);
  if (record.operation === 'DELETE') return { source_pk: record.source_pk, source_version: record.source_version, deleted_at: updated };
  if (!record.data || 'customer_ref' in record.data) throw new Error('DURABLE_FACTS_INVALID');
  return {
    source_pk: record.source_pk, customer_name: record.data.customer_name, owner_external_id: record.data.owner_external_id,
    dept_external_id: record.data.department_external_id, status: record.data.status, phone: record.data.phone,
    source_updated_at: updated, source_version: record.source_version, deleted_at: null,
  };
}

export function canonicalOrderInput(job: { endpoint_profile_digest: Buffer | null }, record: PublicRecord) {
  const updated = canonicalUtc(record.source_updated_at);
  if (record.operation === 'DELETE') return { source_pk: record.source_pk, source_version: record.source_version, deleted_at: updated };
  if (!record.data || !('customer_ref' in record.data)) throw new Error('DURABLE_FACTS_INVALID');
  return {
    source_pk: record.source_pk, customer_external_id: job.endpoint_profile_digest === null ? customerReferenceMappingKey(record.data.customer_ref.source_id, record.data.customer_ref.source_pk) : record.data.customer_ref.source_pk, order_no: record.data.order_no,
    status: record.data.status, order_at: canonicalUtc(record.data.order_at), amount: canonicalDecimal(record.data.amount, 2),
    currency: record.data.currency, source_updated_at: updated, source_version: record.source_version, deleted_at: null,
    lines: record.data.lines.map(line => ({ ...line, quantity: canonicalDecimal(line.quantity, 6),
      unit_price: canonicalDecimal(line.unit_price, 6), line_amount: canonicalDecimal(line.line_amount, 2) })),
  };
}
