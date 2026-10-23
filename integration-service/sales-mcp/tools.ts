import { z } from 'zod';

export const toolDefinitions = [
  { name: 'get_sales_context', description: '查看销售查询口径与授权上下文', query: '', inputSchema: z.object({}).strict() },
  { name: 'find_customers', description: '按客户名称查询本人可见的客户', query: `query($term: String!, $limit: Int!) { customer(where: {name: {_ilike: $term}, deleted: {_eq: false}}, limit: $limit) { id name email_masked phone_masked } }`, inputSchema: z.object({ term: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: 'get_customer_orders', description: '查询本人可见的客户订单', query: `query($customerId: uuid!, $limit: Int!) { sales_order(where: {customer_id: {_eq: $customerId}, deleted: {_eq: false}}, limit: $limit, order_by: {updated_at: desc}) { id source_id total status updated_at } }`, inputSchema: z.object({ customerId: z.string().uuid(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: 'get_sales_summary', description: '汇总本人可见的全部已支付订单', query: `query { sales_summary { order_count total } }`, inputSchema: z.object({}).strict() },
  { name: 'get_order_detail', description: '查询本人可见的订单头和明细', query: `query($id: uuid!) { sales_order(where: {id: {_eq: $id}}, limit: 1) { id source_id total status order_items { sku quantity unit_price } } }`, inputSchema: z.object({ orderId: z.string().uuid() }).strict() }
] as const;
