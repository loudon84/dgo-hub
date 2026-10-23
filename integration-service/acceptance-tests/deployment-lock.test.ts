import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deploymentLockSchema, validateDeploymentLock } from '../contracts/deployment-lock.js';
import { runGenerateLock } from '../scripts/generate-lock.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pins = JSON.parse(readFileSync(resolve('deploy/upstream-pins.json'), 'utf8')) as unknown;
const jsonSchema = JSON.parse(readFileSync(resolve('deploy/deployment.lock.schema.json'), 'utf8')) as {
  '$defs': { component: { properties: { image: { properties: { reference: { pattern: string } } } } } };
};
const lockJsonSchema = JSON.parse(readFileSync(resolve('deploy/deployment.lock.schema.json'), 'utf8')) as any;

const digest = `sha256:${'a'.repeat(64)}`;
const hubSourceSha = 'b'.repeat(40);

function validLock() {
  const upstream = (pins as { source_pins: {
    helix: { revision: string };
    openmetadata: { tag: string; revision: string };
    hasura: { tag: string; revision: string };
  } }).source_pins;
  const componentIds = [
    'hub-api', 'hub-worker', 'hub-publisher', 'sales-mcp',
    'hasura', 'postgres', 'openmetadata', 'helix-foundry',
  ];
  const components = Object.fromEntries(componentIds.map(id => {
    const sourceSha = id.startsWith('hub-') || id === 'sales-mcp'
      ? hubSourceSha
      : id === 'hasura'
        ? upstream.hasura.revision
        : id === 'openmetadata'
          ? upstream.openmetadata.revision
          : id === 'helix-foundry'
            ? upstream.helix.revision
            : undefined;
    return [id, {
      image: { reference: `registry.example.test/${id}:1.0.0`, digest_source: 'repo_digest', manifest_digest: digest, image_id: `sha256:${'c'.repeat(64)}` },
      ...(sourceSha ? { source_sha: sourceSha } : {}),
      config: { schema: 'alpha1.v1', digest: `sha256:${'d'.repeat(64)}` },
      captured_at: '2026-10-23T00:00:00Z',
      runtime_identity: { image_id: `sha256:${'c'.repeat(64)}`, manifest_digest: digest, config_digest: `sha256:${'d'.repeat(64)}` },
      capability_probe: {
        status: 'PASS',
        captured_at: '2026-10-23T00:01:00Z',
        runtime_identity: { image_id: `sha256:${'c'.repeat(64)}`, manifest_digest: digest, config_digest: `sha256:${'d'.repeat(64)}` },
      },
    }];
  }));

  return {
    schema_version: 'alpha1.v1',
    environment_kind: 'local_lab',
    input_kind: 'observed',
    run_id: 'run-20261023-001',
    captured_at: '2026-10-23T00:00:00Z',
    source_pins: structuredClone(upstream),
    components,
  };
}

function blocked(lock: unknown): string[] {
  const result = validateDeploymentLock(lock, pins, { release: true });
  expect(result.status).toBe('BLOCKED');
  return result.issues;
}

describe('deployment lock contract', () => {
  it('keeps the checked-in example schema-valid and release-blocked', () => {
    const example = JSON.parse(readFileSync(resolve('deploy/deployment.lock.example.json'), 'utf8')) as unknown;
    expect(deploymentLockSchema.safeParse(example).success).toBe(true);
    expect(validateDeploymentLock(example, pins, { release: true }).status).toBe('BLOCKED');
  });

  it('keeps exact approved upstream source pins', () => {
    expect(pins).toMatchObject({
      source_pins: {
        helix: { revision: '00d7927d7c08e16c58316e006959f052427e7fa1' },
        openmetadata: { tag: '2.0.6-release', revision: 'a695261b19d48411a39502a5c5fc0b453729eb4e' },
        hasura: { tag: 'v2.51.1', revision: '2b130a135659026ff6eda42c1df5722f123fd84e' },
      },
    });
  });

  it('keeps the exported contract aligned with distribution digest provenance fields', () => {
    const image = lockJsonSchema.$defs.component.properties.image;
    expect(image.required).toContain('digest_source');
    expect(image.properties.digest_source.enum).toEqual(['repo_digest', 'descriptor']);
    expect(image.properties.descriptor_media_type.enum).toEqual([
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ]);
  });

  it('accepts a syntactically complete synthetic example but blocks release', () => {
    const example = { ...validLock(), input_kind: 'synthetic' };
    expect(deploymentLockSchema.safeParse(example).success).toBe(true);
    expect(validateDeploymentLock(example, pins, { release: false })).toEqual({ status: 'PASS', issues: [] });
    expect(blocked(example).join(' ')).toMatch(/observed|synthetic/i);
  });

  it('blocks release locks that describe a local lab', () => {
    const lock = { ...validLock(), environment_kind: 'local_lab' };
    expect(blocked(lock).join(' ')).toMatch(/environment_kind.*site|site.*environment_kind/i);
  });

  it('blocks a missing manifest digest instead of treating an image id as the digest', () => {
    const lock = validLock();
    const component = lock.components['hub-api'] as Record<string, unknown>;
    component.image = { image_id: `sha256:${'c'.repeat(64)}` };
    expect(blocked(lock).join(' ')).toMatch(/hub-api.*manifest_digest|manifest_digest.*hub-api/i);
  });

  it('accepts Docker engine identity equal to a declared distribution descriptor', () => {
    const lock = validLock();
    lock.environment_kind = 'site';
    lock.input_kind = 'observed';
    const component = lock.components['hub-api'] as {
      image: { manifest_digest: string };
      runtime_identity: { manifest_digest: string };
      capability_probe: { runtime_identity: { manifest_digest: string } };
    };
    const configImageId = `sha256:${'c'.repeat(64)}`;
    component.image.manifest_digest = configImageId;
    component.runtime_identity.manifest_digest = configImageId;
    component.capability_probe.runtime_identity.manifest_digest = configImageId;

    const result = validateDeploymentLock(lock, pins, { release: true });
    expect(result).toEqual({ status: 'PASS', issues: [] });
  });

  it('requires an explicit distribution digest source and valid optional media type', () => {
    const lock = validLock();
    lock.environment_kind = 'site';
    lock.input_kind = 'observed';
    const image = lock.components['hub-api'].image as Record<string, unknown>;
    delete image.digest_source;
    expect(blocked(lock).join(' ')).toMatch(/digest_source/i);

    image.digest_source = 'image_id';
    expect(blocked(lock).join(' ')).toMatch(/digest_source/i);

    image.digest_source = 'descriptor';
    image.descriptor_media_type = 'application/vnd.oci.image.index.v1+json';
    expect(validateDeploymentLock(lock, pins, { release: true }).status).toBe('PASS');
    image.descriptor_media_type = 'application/x-unknown';
    expect(blocked(lock).join(' ')).toMatch(/descriptor_media_type/i);
  });

  it('blocks floating latest image references', () => {
    const lock = validLock();
    (lock.components['hub-api'] as { image: { reference: string } }).image.reference = 'registry.example.test/hub-api:latest';
    expect(blocked(lock).join(' ')).toMatch(/hub-api.*latest|latest.*hub-api/i);
  });

  it('blocks source revisions that differ from approved pins', () => {
    const lock = validLock();
    (lock.components.hasura as { source_sha: string }).source_sha = 'e'.repeat(40);
    expect(blocked(lock).join(' ')).toMatch(/hasura.*source|source.*hasura/i);
  });

  it('blocks capabilities that were not probed', () => {
    const lock = validLock();
    (lock.components['hub-worker'] as { capability_probe: { status: string } }).capability_probe.status = 'NOT_RUN';
    expect(blocked(lock).join(' ')).toMatch(/hub-worker.*probe|probe.*hub-worker/i);
  });

  it('blocks missing required components', () => {
    const lock = validLock();
    delete lock.components.postgres;
    expect(blocked(lock).join(' ')).toMatch(/postgres/i);
  });

  it('blocks runtime observations whose probe identity does not match the image', () => {
    const lock = validLock();
    (lock.components['sales-mcp'] as { capability_probe: { runtime_identity: { manifest_digest: string } } })
      .capability_probe.runtime_identity.manifest_digest = `sha256:${'e'.repeat(64)}`;
    expect(blocked(lock).join(' ')).toMatch(/sales-mcp.*identity|identity.*sales-mcp/i);
  });

  it('blocks runtime config digests that differ from the observed config', () => {
    const lock = validLock();
    (lock.components['hub-api'] as { runtime_identity: { config_digest: string } })
      .runtime_identity.config_digest = `sha256:${'e'.repeat(64)}`;
    expect(blocked(lock).join(' ')).toMatch(/hub-api.*identity|identity.*hub-api/i);
  });

  it('blocks image references without a fixed tag or with an embedded digest', () => {
    const lock = validLock();
    (lock.components.hasura as { image: { reference: string } }).image.reference = 'registry.example.test:5000/hasura';
    expect(blocked(lock).join(' ')).toMatch(/hasura.*tag|tag.*hasura/i);

    const embeddedDigest = validLock();
    (embeddedDigest.components.hasura as { image: { reference: string } }).image.reference = 'registry.example.test:5000/hasura:v2.51.1@sha256:abc';
    expect(blocked(embeddedDigest).join(' ')).toMatch(/hasura.*reference|reference.*hasura/i);
  });

  it('requires repository:fixed-tag image syntax while allowing registry ports', () => {
    const invalidReferences = [':fixed', 'repo:tag:again', 'https://example.test/repo:1', ' repo:tag '];
    for (const reference of invalidReferences) {
      const lock = validLock();
      lock.environment_kind = 'site';
      lock.input_kind = 'observed';
      (lock.components.hasura as { image: { reference: string } }).image.reference = reference;
      const result = validateDeploymentLock(lock, pins, { release: true });
      expect(result.status, reference).toBe('BLOCKED');
      expect(result.issues.join(' '), reference).toMatch(/hasura.*reference|reference.*hasura/i);
    }

    const registryPort = validLock();
    registryPort.environment_kind = 'site';
    registryPort.input_kind = 'observed';
    (registryPort.components.hasura as { image: { reference: string } }).image.reference = 'registry.example.test:5000/hasura:v2.51.1';
    expect(validateDeploymentLock(registryPort, pins, { release: true }).status).toBe('PASS');

    const repeatedHyphenRegistry = validLock();
    repeatedHyphenRegistry.environment_kind = 'site';
    repeatedHyphenRegistry.input_kind = 'observed';
    const repeatedHyphenReference = 'registry--east.example.test:5000/repo:1';
    (repeatedHyphenRegistry.components.hasura as { image: { reference: string } }).image.reference = repeatedHyphenReference;
    expect(validateDeploymentLock(repeatedHyphenRegistry, pins, { release: true }).status).toBe('PASS');
    const imageReferencePattern = new RegExp(jsonSchema['$defs'].component.properties.image.properties.reference.pattern);
    expect(imageReferencePattern.test(repeatedHyphenReference)).toBe(true);
  });

  it('represents the same repository and tag restrictions in JSON Schema', () => {
    const imageReferencePattern = new RegExp(jsonSchema['$defs'].component.properties.image.properties.reference.pattern);
    for (const reference of [':fixed', 'repo:tag:again', 'https://example.test/repo:1', ' repo:tag ']) {
      expect(imageReferencePattern.test(reference), reference).toBe(false);
    }
    expect(imageReferencePattern.test('registry.example.test:5000/repo:1')).toBe(true);
  });

  it('blocks source pins that drift from the approved pins file', () => {
    const lock = validLock();
    lock.source_pins.helix.revision = 'e'.repeat(40);
    expect(blocked(lock).join(' ')).toMatch(/source_pins/i);
  });

  it('blocks missing real observations without inventing a release-ready lock', () => {
    const lock = { ...validLock(), components: {} };
    expect(blocked(lock).join(' ')).toMatch(/hub-api/);
  });

  it('requires applicable source identity on explicitly declared extra upstream components', () => {
    const lock = validLock();
    lock.components['openmetadata-search'] = {
      ...lock.components.openmetadata,
      source_sha: undefined,
    };
    expect(blocked(lock).join(' ')).toMatch(/openmetadata-search.*source_sha/i);
  });
});

describe('deployment lock CLI', () => {
  it('returns stable JSON for missing arguments', async () => {
    const result = await runGenerateLock([]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ error: 'usage', product_ready: false });
  });

  it('writes a structurally valid synthetic lock but never reports product readiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-lock-'));
    try {
      const observationsPath = join(dir, 'observations.json');
      const pinsPath = join(dir, 'pins.json');
      const outputPath = join(dir, 'deployment.lock.json');
      writeFileSync(observationsPath, JSON.stringify({ ...validLock(), input_kind: 'synthetic' }));
      writeFileSync(pinsPath, JSON.stringify(pins));

      const result = await runGenerateLock([
        '--observations', observationsPath,
        '--pins', pinsPath,
        '--output', outputPath,
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ status: 'PASS', product_ready: false, scope: 'deployment-lock-validation' });
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({ input_kind: 'synthetic' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nonzero stable JSON for incomplete observations in release mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-lock-'));
    try {
      const observationsPath = join(dir, 'observations.json');
      const pinsPath = join(dir, 'pins.json');
      const incomplete = { ...validLock(), components: {} };
      writeFileSync(observationsPath, JSON.stringify(incomplete));
      writeFileSync(pinsPath, JSON.stringify(pins));

      const result = await runGenerateLock([
        '--observations', observationsPath,
        '--pins', pinsPath,
        '--release',
      ]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({ status: 'BLOCKED', product_ready: false });
      expect(JSON.parse(result.output).issues.join(' ')).toMatch(/hub-api/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns stable nonzero JSON when the requested output cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-lock-'));
    try {
      const observationsPath = join(dir, 'observations.json');
      const pinsPath = join(dir, 'pins.json');
      writeFileSync(observationsPath, JSON.stringify({ ...validLock(), input_kind: 'synthetic' }));
      writeFileSync(pinsPath, JSON.stringify(pins));

      const result = await runGenerateLock([
        '--observations', observationsPath,
        '--pins', pinsPath,
        '--output', dir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({ error: 'output_write', product_ready: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
