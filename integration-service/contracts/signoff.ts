import { z } from 'zod';
import { environmentInputSchema, identityReferenceSchema, type EnvironmentInput } from './environment.js';

const approvalRoles = ['product', 'architecture', 'data_owner', 'security', 'test'] as const;

const approvalSchema = z.object({
  role: z.enum(approvalRoles),
  status: z.enum(['APPROVED', 'REJECTED']),
  actor_ref: identityReferenceSchema,
  approved_at: z.string().datetime({ offset: true }),
}).strict();

export const signoffRecordSchema = z.object({
  schema_version: z.literal('alpha1.v1'),
  contract_ref: z.literal('PRD-DGO-HUB-001:v1.0'),
  supplement_ref: z.literal('PRD-DGO-HUB-001-FIXTURE:v1.0.fixture').optional(),
  status: z.enum(['REVIEW', 'APPROVED_FOR_PLAN']),
  example: z.boolean(),
  approvals: z.array(approvalSchema),
}).strict().superRefine((record, ctx) => {
  const roles = record.approvals.map(approval => approval.role);
  if (new Set(roles).size !== roles.length) {
    ctx.addIssue({ code: 'custom', path: ['approvals'], message: 'Approval roles must be unique' });
  }
  if (record.status === 'APPROVED_FOR_PLAN') {
    for (const role of approvalRoles) {
      const approval = record.approvals.find(item => item.role === role);
      if (!approval || approval.status !== 'APPROVED') {
        ctx.addIssue({ code: 'custom', path: ['approvals'], message: `APPROVED_FOR_PLAN requires approved ${role} signoff` });
      }
    }
    if (record.approvals.length !== approvalRoles.length) {
      ctx.addIssue({ code: 'custom', path: ['approvals'], message: 'APPROVED_FOR_PLAN requires exactly five signoffs' });
    }
  }
});

export type SignoffRecord = z.infer<typeof signoffRecordSchema>;

// These markers are not proof that other references resolve or are authentic.
function isPlaceholderReference(reference: string): boolean {
  const value = reference.trim();
  const exampleActors = new Set([
    'idp://example-tenant/sales-1', 'idp://example-tenant/sales-2', 'idp://example-tenant/manager',
  ]);
  return /^(?:example:\/\/|required_)/i.test(value) || exampleActors.has(value.toLowerCase());
}

function hasPlatformPlaceholder(environment: EnvironmentInput): boolean {
  const references = [
    environment.identity_mapping_ref, environment.backup_ref,
    ...environment.test_identities.map(identity => identity.actor_ref),
    ...environment.sources.flatMap(source => [
      source.mapping_ref, source.replica_authorization_ref, source.deletion_contract_ref,
      ...(source.connection_mode === 'SIMULATED_IMPORT' ? [source.input_ref, source.data_contract_ref] : []),
    ]),
  ];
  return references.some(isPlaceholderReference);
}

export type M0EntryResult = { status: 'PASS' | 'BLOCKED'; missing: string[]; example: boolean };

export function evaluateM0Entry(
  signoffs: unknown,
  environment: unknown,
  options: { expectedKind: 'local_lab' | 'site' | 'platform'; allowExample: boolean },
): M0EntryResult {
  const signoffResult = signoffRecordSchema.safeParse(signoffs);
  const environmentResult = environmentInputSchema.safeParse(environment);
  const example = signoffResult.success && signoffResult.data.example || environmentResult.success && environmentResult.data.example;
  const missing: string[] = [];
  if (!signoffResult.success) missing.push('signoffs:invalid_or_incomplete');
  if (!environmentResult.success) missing.push('environment:invalid_or_incomplete');
  if (signoffResult.success && signoffResult.data.status !== 'APPROVED_FOR_PLAN') missing.push('signoffs:status_not_approved_for_plan');
  if (environmentResult.success) {
    const env = environmentResult.data;
    const actualKind = env.acceptance_level === 'platform' ? 'platform' : env.environment_kind;
    if (actualKind !== options.expectedKind) missing.push('environment:kind_mismatch');
    if (actualKind === 'platform' && signoffResult.success && !signoffResult.data.supplement_ref) missing.push('signoffs:supplement_ref_missing');
    if (actualKind === 'platform' && hasPlatformPlaceholder(env)) missing.push('environment:placeholder_reference');
    if (actualKind === 'platform' && signoffResult.success && signoffResult.data.approvals.some(approval => isPlaceholderReference(approval.actor_ref))) missing.push('signoffs:placeholder_reference');
  }
  if (example && !options.allowExample) missing.push('example:formal_readiness_rejected');
  if (example && options.allowExample) missing.push('example:syntax_only');
  return { status: missing.length === 0 ? 'PASS' : 'BLOCKED', missing, example };
}
