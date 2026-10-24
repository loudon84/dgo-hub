import type { PoolClient } from 'pg';

export const AUTH_SCOPES = [
  'source:read', 'source:write', 'source:approve', 'mapping:write', 'governance:read', 'governance:write',
  'ontology:write', 'ontology:publish', 'binding:read', 'binding:write', 'binding:approve', 'binding:publish',
  'policy:read', 'policy:write', 'policy:approve', 'policy:publish', 'policy:revoke', 'access:preview',
  'agent:read', 'agent:revoke', 'audit:read', 'operation:read', 'ops:read',
] as const;

export type AuthScope = typeof AUTH_SCOPES[number];
export type BusinessRole = 'sales' | 'sales_manager';
export type SourceEntity = 'customer' | 'order';

export type UserPrincipal = Readonly<{
  userId: string;
  tenantId: string;
  departmentId: string | null;
  businessRole: BusinessRole | null;
  managementScopes: readonly AuthScope[];
  authEpoch: string;
  businessTimezone: string;
  issuer: string;
  subject: string;
}>;

export type AgentPrincipal = UserPrincipal & Readonly<{
  credentialId: string;
  credentialEpoch: string;
  expiresAt: string;
}>;

export type SourcePrincipal = Readonly<{
  sourceId: string;
  tenantId: string;
  allowedEntities: readonly SourceEntity[];
  credentialId: string;
  revision: string;
  sourceEpoch: string;
}>;

export type CreateAgentCredentialInput = Readonly<{ purpose: string; ttl_seconds?: number }>;
export type AgentCredentialMetadata = Readonly<{
  credential_id: string;
  purpose: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}>;
export type CreateAgentCredentialResult = Readonly<AgentCredentialMetadata & {
  secret: string | null;
  replayed: boolean;
}>;
export type AgentCredentialPage = Readonly<{ cursor?: string; limit?: number }>;
export type AgentCredentialPageResult = Readonly<{
  items: readonly AgentCredentialMetadata[];
  next_cursor: string | null;
}>;

export type TenantProvisionInput = Readonly<{ tenantId: string; businessTimezone: string; enabled?: boolean }>;
export type SubjectProvisionInput = Readonly<{
  tenantId: string;
  userId: string;
  departmentId?: string | null;
  businessRole?: BusinessRole | null;
  managementScopes?: readonly AuthScope[];
  enabled?: boolean;
}>;
export type IdentityBindingInput = Readonly<{ issuer: string; subject: string; tenantId: string; userId: string; enabled?: boolean }>;
export type SourceCredentialProvisionInput = Readonly<{
  sourceId: string;
  tenantId: string;
  token: string;
  secretRef: string;
  allowedEntities: readonly SourceEntity[];
  revision: string;
  enabled?: boolean;
}>;

export type AuthService = Readonly<{
  resolveOidc(issuer: string, subject: string): Promise<UserPrincipal>;
  createAgentCredential(principal: UserPrincipal, input: CreateAgentCredentialInput, idempotencyKey: string): Promise<CreateAgentCredentialResult>;
  listAgentCredentials(principal: UserPrincipal, page?: AgentCredentialPage): Promise<AgentCredentialPageResult>;
  revokeAgentCredential(principal: UserPrincipal, credentialId: string): Promise<void>;
  authenticateAgent(token: string): Promise<AgentPrincipal>;
  authenticateSource(token: string, entity: SourceEntity): Promise<SourcePrincipal>;
  assertCurrentSource(snapshot: SourcePrincipal, entity: SourceEntity, client: PoolClient): Promise<void>;
  assertCurrentAgent(snapshot: AgentPrincipal): Promise<void>;
  /** Controlled repository methods; a supplied PoolClient is reused without opening a nested transaction. */
  repository: Readonly<{
    provisionTenant(input: TenantProvisionInput, client?: PoolClient): Promise<void>;
    provisionSubject(input: SubjectProvisionInput, client?: PoolClient): Promise<void>;
    bindIdentity(input: IdentityBindingInput, client?: PoolClient): Promise<void>;
    updateSubject(input: SubjectProvisionInput, client?: PoolClient): Promise<void>;
    setIdentityBinding(issuer: string, subject: string, enabled: boolean, client?: PoolClient): Promise<void>;
    setTenantEnabled(tenantId: string, enabled: boolean, client?: PoolClient): Promise<void>;
    provisionSourceCredential(input: SourceCredentialProvisionInput, client?: PoolClient): Promise<void>;
    updateSourceCredential(sourceId: string, tenantId: string, enabled: boolean, revision: string, allowedEntities: readonly SourceEntity[], client?: PoolClient, secretRef?: string): Promise<void>;
    advanceSourceEpoch(sourceId: string, tenantId: string, client?: PoolClient): Promise<void>;
    revokeSourceCredential(sourceId: string, tenantId: string, reasonCode: string, client?: PoolClient): Promise<void>;
    recordSourceScopeSecurityBarrier(sourceId: string, tenantId: string, entity: SourceEntity, reasonCode: string, client?: PoolClient): Promise<void>;
  }>;
}>;
