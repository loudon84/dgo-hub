import { z } from 'zod';
import { environmentInputSchema } from './environment.js';

const sha1OrSha256 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = /^sha256:[a-f0-9]{64}$/;
const utcTimestamp = z.string().datetime({ offset: false });
const sha256Value = z.string().regex(sha256);
const environmentKindSchema = environmentInputSchema.shape.environment_kind;

const repositoryComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const registryHost = /^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::([1-9][0-9]{0,4}))?$/;
const imageTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function hasRepositoryTagGrammar(reference: string): boolean {
  if (reference.includes('@') || reference.includes('://') || /\s/.test(reference)) return false;
  const lastSlash = reference.lastIndexOf('/');
  const tagSeparator = reference.lastIndexOf(':');
  if (tagSeparator <= lastSlash || tagSeparator === reference.length - 1) return false;

  const repository = reference.slice(0, tagSeparator);
  const tag = reference.slice(tagSeparator + 1);
  if (!imageTag.test(tag)) return false;

  const pathComponents = repository.split('/');
  if (pathComponents.some(component => component.length === 0)) return false;
  if (pathComponents.length > 1 && pathComponents[0]!.includes(':')) {
    const host = pathComponents[0]!;
    const match = registryHost.exec(host);
    if (!match) return false;
    if (match[1] && Number(match[1]) > 65535) return false;
    return pathComponents.slice(1).every(component => repositoryComponent.test(component));
  }
  return pathComponents.every(component => repositoryComponent.test(component));
}

const upstreamPinsSchema = z.object({
  helix: z.object({ revision: z.string().regex(sha1OrSha256) }).strict(),
  openmetadata: z.object({ tag: z.string().trim().min(1), revision: z.string().regex(sha1OrSha256) }).strict(),
  hasura: z.object({ tag: z.string().trim().min(1), revision: z.string().regex(sha1OrSha256) }).strict(),
}).strict();

export const upstreamPinsFileSchema = z.object({
  schema_version: z.literal('alpha1.v1'),
  source_pins: upstreamPinsSchema,
  reference_sources: z.record(z.string(), z.string().url()).optional(),
}).strict();

const runtimeIdentitySchema = z.object({
  image_id: sha256Value,
  manifest_digest: sha256Value,
  config_digest: sha256Value,
}).strict();

const imageSchema = z.object({
  reference: z.string().min(1),
  manifest_digest: sha256Value,
  image_id: sha256Value.optional(),
}).strict();

const componentSchema = z.object({
  image: imageSchema,
  source_sha: z.string().regex(sha1OrSha256).optional(),
  config: z.object({ schema: z.string().trim().min(1), digest: sha256Value }).strict(),
  captured_at: utcTimestamp,
  runtime_identity: runtimeIdentitySchema,
  capability_probe: z.object({
    status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']),
    captured_at: utcTimestamp,
    runtime_identity: runtimeIdentitySchema,
  }).strict(),
}).strict().superRefine((component, ctx) => {
  const ref = component.image.reference;
  if (!hasRepositoryTagGrammar(ref)) {
    ctx.addIssue({ code: 'custom', path: ['image', 'reference'], message: 'Image reference must use repository:fixed-tag syntax with a valid repository and tag' });
  } else if (ref.slice(ref.lastIndexOf(':') + 1).toLowerCase() === 'latest') {
    ctx.addIssue({ code: 'custom', path: ['image', 'reference'], message: 'Floating latest image tags are not allowed' });
  }

  if (component.runtime_identity.manifest_digest !== component.image.manifest_digest
    || component.runtime_identity.config_digest !== component.config.digest
    || (component.image.image_id !== undefined && component.runtime_identity.image_id !== component.image.image_id)) {
    ctx.addIssue({ code: 'custom', path: ['runtime_identity'], message: 'Runtime identity must match the declared image and config digests' });
  }
  if (component.image.manifest_digest === component.runtime_identity.image_id
    || component.runtime_identity.manifest_digest === component.runtime_identity.image_id) {
    ctx.addIssue({ code: 'custom', path: ['image', 'manifest_digest'], message: 'manifest_digest must not be populated with the config image_id' });
  }
  if (component.capability_probe.runtime_identity.image_id !== component.runtime_identity.image_id
    || component.capability_probe.runtime_identity.manifest_digest !== component.runtime_identity.manifest_digest
    || component.capability_probe.runtime_identity.config_digest !== component.runtime_identity.config_digest) {
    ctx.addIssue({ code: 'custom', path: ['capability_probe', 'runtime_identity'], message: 'Probe identity must match the observed runtime identity' });
  }
});

const requiredComponentIds = [
  'hub-api', 'hub-worker', 'hub-publisher', 'sales-mcp',
  'hasura', 'postgres', 'openmetadata', 'helix-foundry',
] as const;

const componentShapes = Object.fromEntries(requiredComponentIds.map(id => [id, componentSchema])) as Record<typeof requiredComponentIds[number], typeof componentSchema>;

export const deploymentLockSchema = z.object({
  schema_version: z.literal('alpha1.v1'),
  environment_kind: environmentKindSchema,
  input_kind: z.enum(['observed', 'synthetic', 'example']),
  run_id: z.string().trim().min(1),
  captured_at: utcTimestamp,
  source_pins: upstreamPinsSchema,
  components: z.object(componentShapes).catchall(componentSchema),
}).strict().superRefine((lock, ctx) => {
  for (const id of requiredComponentIds) {
    const component = lock.components[id];
    if (component && (id.startsWith('hub-') || id === 'sales-mcp' || id === 'hasura' || id === 'openmetadata' || id === 'helix-foundry') && !component.source_sha) {
      ctx.addIssue({ code: 'custom', path: ['components', id, 'source_sha'], message: 'Source revision is required for this component' });
    }
  }
});

export type DeploymentLock = z.infer<typeof deploymentLockSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'input';
    return `${path}: ${issue.message}`;
  });
}

function sourceFamily(componentId: string): 'hub' | 'hasura' | 'openmetadata' | 'helix' | undefined {
  if (componentId.startsWith('hub-') || componentId === 'sales-mcp') return 'hub';
  if (componentId === 'hasura' || componentId.startsWith('hasura-')) return 'hasura';
  if (componentId === 'openmetadata' || componentId.startsWith('openmetadata-')) return 'openmetadata';
  if (componentId === 'helix-foundry' || componentId.startsWith('helix-')) return 'helix';
  return undefined;
}

export function validateDeploymentLock(input: unknown, pins: unknown, options: { release: boolean }): { status: 'PASS' | 'BLOCKED'; issues: string[] } {
  const issues: string[] = [];
  const pinsResult = upstreamPinsFileSchema.safeParse(pins);
  if (!pinsResult.success) issues.push(...validationIssues(pinsResult.error).map(issue => `pins.${issue}`));

  const inputRecord = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const componentRecord = inputRecord?.components !== null && typeof inputRecord?.components === 'object' && !Array.isArray(inputRecord.components)
    ? inputRecord.components as Record<string, unknown>
    : undefined;
  for (const id of requiredComponentIds) {
    if (!componentRecord || !(id in componentRecord)) issues.push(`components.${id}: required component observation is missing`);
  }

  const inputResult = deploymentLockSchema.safeParse(input);
  if (!inputResult.success) issues.push(...validationIssues(inputResult.error));

  if (pinsResult.success && inputResult.success) {
    if (stableJson(inputResult.data.source_pins) !== stableJson(pinsResult.data.source_pins)) {
      issues.push('source_pins: declared pins do not match the approved upstream pins file');
    }

    const components = inputResult.data.components;
    const sourcePinsByFamily = {
      hasura: pinsResult.data.source_pins.hasura.revision,
      openmetadata: pinsResult.data.source_pins.openmetadata.revision,
      helix: pinsResult.data.source_pins.helix.revision,
    };
    const hubSourceShas = new Set<string>();
    for (const [id, component] of Object.entries(components)) {
      const family = sourceFamily(id);
      if (family && !component.source_sha) issues.push(`components.${id}.source_sha: source revision is required`);
      if (family === 'hub' && component.source_sha) hubSourceShas.add(component.source_sha);
      const expected = family && family !== 'hub' ? sourcePinsByFamily[family] : undefined;
      if (expected && component.source_sha !== expected) issues.push(`components.${id}.source_sha: does not match the pinned upstream revision`);
      if (component.capability_probe.status !== 'PASS') issues.push(`components.${id}.capability_probe: probe status must be PASS`);
    }
    if (hubSourceShas.size > 1) issues.push('components: hub component source_sha values must match');

    if (options.release) {
      if (inputResult.data.input_kind !== 'observed') issues.push('input_kind: release requires observed deployment data');
      if (inputResult.data.environment_kind !== 'site') issues.push('environment_kind: release requires site');
    }
  }

  const uniqueIssues = [...new Set(issues)].sort();
  return uniqueIssues.length === 0 ? { status: 'PASS', issues: [] } : { status: 'BLOCKED', issues: uniqueIssues };
}
