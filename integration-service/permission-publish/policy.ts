export type PolicyInput = { table: 'customer' | 'sales_order' | 'order_item' | 'sales_summary' | 'customer_sales'; role: 'sales_reader'; columns: string[] };
const allowed: Record<PolicyInput['table'], string[]> = {
  customer: ['id', 'source_id', 'tenant_id', 'owner_user_id', 'name', 'email_masked', 'phone_masked', 'deleted'],
  sales_order: ['id', 'source_id', 'customer_id', 'tenant_id', 'owner_user_id', 'total', 'status', 'deleted', 'updated_at'],
  order_item: ['id', 'order_id', 'tenant_id', 'owner_user_id', 'sku', 'quantity', 'unit_price'],
  sales_summary: ['tenant_id', 'owner_user_id', 'order_count', 'total'],
  customer_sales: ['tenant_id', 'owner_user_id', 'customer_id', 'total']
};
export function validatePolicy(policy: PolicyInput): void {
  if (policy.role !== 'sales_reader' || !Object.hasOwn(allowed, policy.table) || policy.columns.length === 0 ||
      policy.columns.some(column => !allowed[policy.table].includes(column))) throw new Error('Invalid role, table or column allowlist');
}
export function buildSelectPermission(policy: PolicyInput) {
  validatePolicy(policy);
  return { type: 'pg_create_select_permission', args: { source: process.env.HASURA_SOURCE ?? 'default', table: { schema: 'api', name: policy.table }, role: policy.role,
    permission: { columns: policy.columns, filter: { _and: [
      { tenant_id: { _eq: 'X-Hasura-Tenant-Id' } }, { owner_user_id: { _eq: 'X-Hasura-User-Id' } }
    ] }, limit: 100, allow_aggregations: false } } } as const;
}
export const defaultPolicies: PolicyInput[] = [
  { table: 'customer', role: 'sales_reader', columns: allowed.customer },
  { table: 'sales_order', role: 'sales_reader', columns: allowed.sales_order },
  { table: 'order_item', role: 'sales_reader', columns: allowed.order_item },
  { table: 'sales_summary', role: 'sales_reader', columns: allowed.sales_summary },
  { table: 'customer_sales', role: 'sales_reader', columns: allowed.customer_sales }
];
