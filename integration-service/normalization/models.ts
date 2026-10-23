import { z } from 'zod';

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
export function normalizeCustomer(input: unknown): Customer { return customerSchema.parse(input); }
export function normalizeOrder(input: unknown): SalesOrder {
  const order = orderSchema.parse(input);
  const cents = (n: number) => Math.round(n * 100);
  if (order.items.reduce((sum, item) => sum + cents(item.unitPrice) * item.quantity, 0) !== cents(order.total)) {
    throw new Error('Order total does not match complete line items');
  }
  return order;
}
