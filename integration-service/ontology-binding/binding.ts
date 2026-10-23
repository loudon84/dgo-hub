export type Binding = { objectType: string; table: 'customer' | 'sales_order' | 'order_item'; fields: Record<string, string>; relationships?: Record<string, string> };
export function validateBinding(binding: Binding, physicalColumns: string[]) {
  if (!binding.objectType || !Object.keys(binding.fields).length) throw new Error('Empty binding');
  for (const physical of Object.values(binding.fields)) if (!physicalColumns.includes(physical)) throw new Error(`Unknown physical column: ${physical}`);
  return { valid: true, fields: Object.keys(binding.fields).length };
}
async function jsonGet(url: string, token: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.json();
}
export async function fetchPublishedHelixModels() {
  if (!process.env.HELIX_URL || !process.env.HELIX_WORKSPACE_ID || !process.env.HELIX_READ_TOKEN) throw new Error('Helix adapter is not configured');
  const base = `${process.env.HELIX_URL}/api/v1/workspaces/${encodeURIComponent(process.env.HELIX_WORKSPACE_ID)}`;
  const overview = await jsonGet(`${base}/overview`, process.env.HELIX_READ_TOKEN) as {
    workspace?: { data?: { activeGeneration?: string | null } };
    objectType?: { id: string; name: string; data?: { generation?: string } }[]
  };
  const generation = overview.workspace?.data?.activeGeneration;
  return { workspaceId: process.env.HELIX_WORKSPACE_ID, generation,
    objectTypes: generation ? (overview.objectType ?? []).filter(x => x.data?.generation === generation) : [] };
}
export async function fetchOpenMetadataTable(fqn: string) {
  if (!process.env.OPENMETADATA_URL || !process.env.OPENMETADATA_TOKEN) throw new Error('OpenMetadata adapter is not configured');
  return jsonGet(`${process.env.OPENMETADATA_URL}/api/v1/tables/name/${encodeURIComponent(fqn)}`, process.env.OPENMETADATA_TOKEN) as Promise<{ columns?: { name: string }[]; id?: string }>;
}
