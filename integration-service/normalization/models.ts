import { z } from 'zod';
import { canonicalDecimal, canonicalVersion, validateCanonicalIdentifier } from './canonical.js';

const key = z.string().trim().min(1).max(160);
const money = z.number().finite().nonnegative();
export const customerSchema = z.object({
  sourceId: key, tenantId: key, ownerUserId: key, version: z.number().int().nonnegative(),
  name: key, email: z.email().optional(), phone: z.string().max(40).optional(),
  deleted: z.boolean().default(false)
});
export const orderSchema = z.object({
  sourceId: key, customerSourceId: key, customerSourceSystem: key.optional(), tenantId: key, ownerUserId: key,
  version: z.number().int().nonnegative(), total: money,
  status: z.enum(['new', 'paid', 'cancelled']).default('new'),
  items: z.array(z.object({ sku: key, quantity: z.number().int().positive(), unitPrice: money })).min(1).max(500),
  deleted: z.boolean().default(false)
});
export type Customer = z.infer<typeof customerSchema>;
export type SalesOrder = z.infer<typeof orderSchema>;

const canonicalId = z.string().transform(value => validateCanonicalIdentifier(value));
const canonicalVersionSchema = z.string().transform(value => canonicalVersion(value));
const sourceTimestamp = z.string().datetime({ offset: true });
const canonicalText = z.string().min(1);
const decimalAt = (scale: number, positive = false) => z.string().transform(value => canonicalDecimal(value, scale, { positive }));

export const canonicalCustomerSchema = z.object({
  source_pk: canonicalId,
  customer_name: canonicalText,
  owner_external_id: canonicalId,
  dept_external_id: canonicalId,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  phone: z.string().nullable().optional(),
  source_updated_at: sourceTimestamp,
  source_version: canonicalVersionSchema,
  deleted_at: sourceTimestamp.nullable().optional(),
}).strict();

export const canonicalDeleteSchema = z.object({
  source_pk: canonicalId,
  source_version: canonicalVersionSchema,
  deleted_at: sourceTimestamp,
}).strict();

export const canonicalOrderLineSchema = z.object({
  source_line_id: canonicalId,
  product_code: canonicalId,
  product_name: canonicalText,
  quantity: decimalAt(6, true),
  unit_price: decimalAt(6),
  line_amount: decimalAt(2),
}).strict();

export const canonicalOrderSchema = z.object({
  source_pk: canonicalId,
  customer_external_id: canonicalId,
  order_no: canonicalText,
  status: z.enum(['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED']),
  order_at: sourceTimestamp,
  amount: decimalAt(2),
  currency: z.enum(['CNY', 'USD', 'EUR']),
  source_updated_at: sourceTimestamp,
  source_version: canonicalVersionSchema,
  deleted_at: sourceTimestamp.nullable().optional(),
  lines: z.array(canonicalOrderLineSchema).max(200),
}).strict().superRefine((order, context) => {
  const sourceIds = order.lines.map(line => line.source_line_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: 'custom', path: ['lines'], message: 'CANONICAL_LINE_ID_DUPLICATE' });
  }
});

export const canonicalOrderDeleteSchema = z.object({
  source_pk: canonicalId,
  source_version: canonicalVersionSchema,
  deleted_at: sourceTimestamp,
}).strict();

export type CanonicalCustomer = z.infer<typeof canonicalCustomerSchema>;
export type CanonicalDelete = z.infer<typeof canonicalDeleteSchema>;
export type CanonicalOrderLine = z.infer<typeof canonicalOrderLineSchema>;
export type CanonicalOrder = z.infer<typeof canonicalOrderSchema>;

export function normalizeCustomer(input: unknown): Customer { return customerSchema.parse(input); }
export function normalizeOrder(input: unknown): SalesOrder {
  const order = orderSchema.parse(input);
  const cents = (n: number) => Math.round(n * 100);
  if (order.items.reduce((sum, item) => sum + cents(item.unitPrice) * item.quantity, 0) !== cents(order.total)) {
    throw new Error('Order total does not match complete line items');
  }
  return order;
}
