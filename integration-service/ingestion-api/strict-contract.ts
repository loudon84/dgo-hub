import { createHash } from 'node:crypto';
import type { SourceEntity } from '../auth/types.js';

export const STRICT_INGEST_BODY_LIMIT = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const IDENTIFIER = /^(?!\s)[\s\S]{1,128}(?<!\s)$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const VERSION = /^(?:0|[1-9][0-9]{0,19})$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SAFE_PATH_FIELDS = new Set(['schema_version','batch_id','records','event_id','source_pk','source_version','operation',
  'source_updated_at','data','customer_name','owner_external_id','department_external_id','status','phone','customer_ref',
  'source_id','order_no','order_at','amount','currency','lines','source_line_id','product_code','product_name',
  'quantity','unit_price','line_amount']);
const MAX_JSON_DEPTH = 32;

export type CustomerImage = Readonly<{
  customer_name: string;
  owner_external_id: string;
  department_external_id: string;
  status: 'ACTIVE' | 'INACTIVE';
  phone?: string | null;
}>;
export type OrderLine = Readonly<{
  source_line_id: string;
  product_code: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  line_amount: string;
}>;
export type OrderImage = Readonly<{
  customer_ref: Readonly<{ source_id: string; source_pk: string }>;
  order_no: string;
  status: 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
  order_at: string;
  amount: string;
  currency: 'CNY' | 'USD' | 'EUR';
  lines: readonly OrderLine[];
}>;
export type PublicRecord = Readonly<{
  event_id: string;
  source_pk: string;
  source_version: string;
  operation: 'UPSERT' | 'DELETE';
  source_updated_at: string;
  data: CustomerImage | OrderImage | null;
}>;
export type PublicBatch = Readonly<{
  schema_version: 'hub.v1';
  batch_id: string;
  records: readonly PublicRecord[];
}>;

export class IngestInputError extends Error {
  constructor(readonly code: 'INGEST_INPUT_INVALID' | 'INGEST_JSON_DUPLICATE_KEY', readonly path: string) {
    super(code);
    this.name = 'IngestInputError';
  }
}

function validUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new IngestInputError('INGEST_INPUT_INVALID', path);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new IngestInputError('INGEST_INPUT_INVALID', path);
  }
}

function pointer(path: string, key: string | number): string {
  if (typeof key === 'number') return Number.isInteger(key) && key >= 0 && key <= 200 ? `${path}/${key}` : path || '/';
  return SAFE_PATH_FIELDS.has(key) ? `${path}/${key}` : path || '/';
}

class JsonReader {
  private index = 0;
  constructor(private readonly text: string, private readonly allowUnpairedSurrogates = false) {}

  read(): unknown {
    this.space();
    const value = this.value('', 0);
    this.space();
    if (this.index !== this.text.length) throw new IngestInputError('INGEST_INPUT_INVALID', '/');
    return value;
  }

  private space(): void {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index]!)) this.index += 1;
  }

  private value(path: string, depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
    const char = this.text[this.index];
    if (char === '{') return this.object(path, depth);
    if (char === '[') return this.array(path, depth);
    if (char === '"') return this.string(path);
    if (char === 't' && this.text.slice(this.index, this.index + 4) === 'true') { this.index += 4; return true; }
    if (char === 'f' && this.text.slice(this.index, this.index + 5) === 'false') { this.index += 5; return false; }
    if (char === 'n' && this.text.slice(this.index, this.index + 4) === 'null') { this.index += 4; return null; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.index));
    if (number) { this.index += number[0].length; return Number(number[0]); }
    throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
  }

  private string(path: string): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === '"') {
        this.index += 1;
        let value: string;
        try { value = JSON.parse(this.text.slice(start, this.index)) as string; }
        catch { throw new IngestInputError('INGEST_INPUT_INVALID', path || '/'); }
        if (!this.allowUnpairedSurrogates) validUnicode(value, path || '/');
        return value;
      }
      if (char === '\\') {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
          this.index += 5;
          continue;
        }
        if (!escaped || !/^["\\/bfnrt]$/.test(escaped)) throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
        this.index += 1;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
      this.index += 1;
    }
    throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
  }

  private object(path: string, depth: number): Record<string, unknown> {
    this.index += 1;
    this.space();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (this.text[this.index] === '}') { this.index += 1; return output; }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
      const key = this.string(path);
      const fieldPath = pointer(path, key);
      if (seen.has(key)) throw new IngestInputError('INGEST_JSON_DUPLICATE_KEY', fieldPath);
      seen.add(key);
      this.space();
      if (this.text[this.index] !== ':') throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
      this.index += 1;
      this.space();
      output[key] = this.value(fieldPath, depth + 1);
      this.space();
      if (this.text[this.index] === '}') { this.index += 1; return output; }
      if (this.text[this.index] !== ',') throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
      this.index += 1;
      this.space();
    }
    throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
  }

  private array(path: string, depth: number): unknown[] {
    this.index += 1;
    this.space();
    const output: unknown[] = [];
    if (this.text[this.index] === ']') { this.index += 1; return output; }
    while (this.index < this.text.length) {
      output.push(this.value(pointer(path, output.length), depth + 1));
      this.space();
      if (this.text[this.index] === ']') { this.index += 1; return output; }
      if (this.text[this.index] !== ',') throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
      this.index += 1;
      this.space();
    }
    throw new IngestInputError('INGEST_INPUT_INVALID', path || '/');
  }
}

export function parseStrictJson(rawBody: Buffer, allowUnpairedSurrogates = false): unknown {
  if (rawBody.length > STRICT_INGEST_BODY_LIMIT) throw new IngestInputError('INGEST_INPUT_INVALID', '/');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBody); }
  catch { throw new IngestInputError('INGEST_INPUT_INVALID', '/'); }
  return new JsonReader(text, allowUnpairedSurrogates).read();
}

function invalid(path: string): never { throw new IngestInputError('INGEST_INPUT_INVALID', path || '/'); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(path);
  return value as Record<string, unknown>;
}
function strictKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) invalid(pointer(path, key));
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(pointer(path, key));
}
function string(value: unknown, path: string, max = 2048): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return invalid(path);
  validUnicode(value, path);
  return value;
}
function identifier(value: unknown, path: string): string {
  const text = string(value, path, 128);
  if (!IDENTIFIER.test(text)) return invalid(path);
  return text;
}
function timestamp(value: unknown, path: string): string {
  const text = string(value, path, 40);
  const match = RFC3339.exec(text);
  if (!match) return invalid(path);
  const [, y, mo, d, h, mi, s, , offset] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59)));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 60) return invalid(path);
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return invalid(path);
  return text;
}
function decimal(value: unknown, path: string, scale: number, positive: boolean): string {
  const text = string(value, path, 32);
  const match = DECIMAL.exec(text);
  if (!match || (match[1]?.length ?? 0) > scale) return invalid(path);
  const integerDigits = text.split('.')[0]!.length;
  if (integerDigits > 20 - scale || (positive && /^0(?:\.0+)?$/.test(text))) return invalid(path);
  return text;
}
function parseCustomer(dataValue: unknown, path: string): CustomerImage {
  const data = object(dataValue, path);
  strictKeys(data, ['customer_name', 'owner_external_id', 'department_external_id', 'status'], ['phone'], path);
  const customerName = string(data.customer_name, pointer(path, 'customer_name'));
  const ownerExternalId = identifier(data.owner_external_id, pointer(path, 'owner_external_id'));
  const departmentExternalId = identifier(data.department_external_id, pointer(path, 'department_external_id'));
  if (data.status !== 'ACTIVE' && data.status !== 'INACTIVE') invalid(pointer(path, 'status'));
  let phone: string | null | undefined;
  if (Object.hasOwn(data, 'phone')) phone = data.phone === null ? null : string(data.phone, pointer(path, 'phone'), 2048);
  return Object.freeze({ customer_name: customerName, owner_external_id: ownerExternalId,
    department_external_id: departmentExternalId, status: data.status, ...(phone === undefined ? {} : { phone }) });
}

function parseOrder(dataValue: unknown, path: string): OrderImage {
  const data = object(dataValue, path);
  strictKeys(data, ['customer_ref', 'order_no', 'status', 'order_at', 'amount', 'currency', 'lines'], [], path);
  const customerRef = object(data.customer_ref, pointer(path, 'customer_ref'));
  strictKeys(customerRef, ['source_id', 'source_pk'], [], pointer(path, 'customer_ref'));
  const sourceId = string(customerRef.source_id, pointer(pointer(path, 'customer_ref'), 'source_id'), 256);
  if (!SOURCE_ID.test(sourceId)) invalid(pointer(pointer(path, 'customer_ref'), 'source_id'));
  const sourcePk = identifier(customerRef.source_pk, pointer(pointer(path, 'customer_ref'), 'source_pk'));
  const orderNo = string(data.order_no, pointer(path, 'order_no'), 128);
  if (!IDENTIFIER.test(orderNo)) invalid(pointer(path, 'order_no'));
  if (typeof data.status !== 'string' || !['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'].includes(data.status)) invalid(pointer(path, 'status'));
  const orderAt = timestamp(data.order_at, pointer(path, 'order_at'));
  const amount = decimal(data.amount, pointer(path, 'amount'), 2, false);
  if (typeof data.currency !== 'string' || !['CNY', 'USD', 'EUR'].includes(data.currency)) invalid(pointer(path, 'currency'));
  if (!Array.isArray(data.lines) || data.lines.length > 200) invalid(pointer(path, 'lines'));
  if ((data.status === 'CONFIRMED' || data.status === 'COMPLETED') && data.lines.length === 0) invalid(pointer(path, 'lines'));
  const lineIds = new Set<string>();
  const lines = data.lines.map((item, index): OrderLine => {
    const linePath = pointer(pointer(path, 'lines'), index);
    const line = object(item, linePath);
    strictKeys(line, ['source_line_id', 'product_code', 'product_name', 'quantity', 'unit_price', 'line_amount'], [], linePath);
    const sourceLineId = identifier(line.source_line_id, pointer(linePath, 'source_line_id'));
    if (lineIds.has(sourceLineId)) invalid(pointer(linePath, 'source_line_id'));
    lineIds.add(sourceLineId);
    const productCode = string(line.product_code, pointer(linePath, 'product_code'), 128);
    const productName = string(line.product_name, pointer(linePath, 'product_name'));
    return Object.freeze({ source_line_id: sourceLineId, product_code: productCode, product_name: productName,
      quantity: decimal(line.quantity, pointer(linePath, 'quantity'), 6, true),
      unit_price: decimal(line.unit_price, pointer(linePath, 'unit_price'), 6, false),
      line_amount: decimal(line.line_amount, pointer(linePath, 'line_amount'), 2, false) });
  });
  return Object.freeze({ customer_ref: Object.freeze({ source_id: sourceId, source_pk: sourcePk }), order_no: orderNo,
    status: data.status as OrderImage['status'], order_at: orderAt, amount,
    currency: data.currency as OrderImage['currency'], lines: Object.freeze(lines) });
}

export function validateHubBatch(value: unknown, entity: SourceEntity): PublicBatch {
  const batch = object(value, '');
  strictKeys(batch, ['schema_version', 'batch_id', 'records'], [], '');
  if (batch.schema_version !== 'hub.v1') invalid('/schema_version');
  if (typeof batch.batch_id !== 'string' || !UUID.test(batch.batch_id)) invalid('/batch_id');
  if (!Array.isArray(batch.records) || batch.records.length < 1 || batch.records.length > 100) invalid('/records');
  const records = batch.records.map((raw, index): PublicRecord => {
    const path = pointer('/records', index);
    const item = object(raw, path);
    strictKeys(item, ['event_id', 'source_pk', 'source_version', 'operation', 'source_updated_at', 'data'], [], path);
    if (typeof item.event_id !== 'string' || !UUID.test(item.event_id)) invalid(pointer(path, 'event_id'));
    const sourcePk = identifier(item.source_pk, pointer(path, 'source_pk'));
    if (typeof item.source_version !== 'string' || !VERSION.test(item.source_version)) invalid(pointer(path, 'source_version'));
    if (item.operation !== 'UPSERT' && item.operation !== 'DELETE') invalid(pointer(path, 'operation'));
    const updatedAt = timestamp(item.source_updated_at, pointer(path, 'source_updated_at'));
    if (item.operation === 'DELETE' && item.data !== null) invalid(pointer(path, 'data'));
    const data = item.operation === 'DELETE' ? null : entity === 'customer'
      ? parseCustomer(item.data, pointer(path, 'data')) : parseOrder(item.data, pointer(path, 'data'));
    return Object.freeze({ event_id: item.event_id, source_pk: sourcePk, source_version: item.source_version,
      operation: item.operation, source_updated_at: updatedAt, data });
  });
  return Object.freeze({ schema_version: 'hub.v1', batch_id: batch.batch_id, records: Object.freeze(records) });
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!);
  const b = Array.from(right, char => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonicalValue(objectValue[key])}`).join(',')}}`;
  }
  throw new IngestInputError('INGEST_INPUT_INVALID', '/');
}
export function canonicalJson(value: unknown): string { return canonicalValue(value); }
export function canonicalHubJson(body: PublicBatch): string { return canonicalJson(body); }

export function requestDigest(body: PublicBatch, tenantKey: string, sourceId: string, route: string): Buffer {
  const input = ['hub.ingest.v1', tenantKey, sourceId, route, canonicalHubJson(body)].join('\0');
  return createHash('sha256').update(input, 'utf8').digest();
}
