import { describe, expect, it } from 'vitest';
import { environmentInputSchema } from '../contracts/environment.js';
import { signoffRecordSchema } from '../contracts/signoff.js';
import { evaluateM0Entry } from '../contracts/signoff.js';
import { runCheckM0Entry } from '../scripts/check-m0-entry.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const validEnvironment = () => ({
  schema_version: 'alpha1.v1',
  environment_kind: 'site',
  tenant_key: 'tenant-north',
  business_timezone: 'Asia/Shanghai',
  idp: {
    issuer: 'https://id.example.test/tenant-north',
    audience: 'sales-mcp',
    jwks_uri: 'https://id.example.test/tenant-north/.well-known/jwks.json',
  },
  sources: [{
    source_id: 'crm',
    connection_mode: 'rest',
    endpoint: 'https://crm.example.test/api',
    secret_ref: 'vault://alpha1/crm/readonly',
    mapping_ref: 'docs/mappings/crm.json',
    replica_authorization_ref: 'docs/approvals/crm-replica.json',
    deletion_contract_ref: 'docs/contracts/crm-deletion.json',
  }],
  identity_mapping_ref: 'docs/mappings/identity.json',
  tls_hostname: 'hub.example.test',
  internal_services: {
    hub_api: 'https://hub-api.internal.test',
    sales_mcp: 'https://sales-mcp.internal.test',
    hasura: 'http://hasura.internal.test:8080',
    postgres: 'postgresql://postgres.internal.test:5432/hub',
    openmetadata: 'https://metadata.internal.test',
    helix: 'https://helix.internal.test',
  },
  backup_ref: 'docs/operations/alpha1-backup.json',
  hermes: { actual_version: '1.2.3' },
  test_identities: [
    { actor_ref: 'idp://tenant-north/alice', role: 'sales', tenant_key: 'tenant-north' },
    { actor_ref: 'idp://tenant-north/bob', role: 'sales', tenant_key: 'tenant-north' },
    { actor_ref: 'idp://tenant-north/manager', role: 'sales_manager', tenant_key: 'tenant-north' },
  ],
  example: false,
});

const validSignoffs = () => ({
  schema_version: 'alpha1.v1',
  contract_ref: 'PRD-DGO-HUB-001:v1.0',
  status: 'APPROVED_FOR_PLAN',
  example: false,
  approvals: ['product', 'architecture', 'data_owner', 'security', 'test'].map((role, index) => ({
    role,
    status: 'APPROVED',
    actor_ref: `directory://approver-${index + 1}`,
    approved_at: '2026-10-20T09:00:00Z',
  })),
});

describe('environment and signoff contracts', () => {
  it('accepts a complete site input with tenant-bound distinct test identities', () => {
    expect(environmentInputSchema.safeParse(validEnvironment()).success).toBe(true);
  });

  it('requires issuer, source contracts, and all five approved signoffs', () => {
    const environment = validEnvironment();
    delete (environment.idp as Partial<typeof environment.idp>).issuer;
    delete (environment.sources[0] as Partial<typeof environment.sources[0]>).replica_authorization_ref;
    const signoffs = validSignoffs();
    signoffs.approvals.pop();

    expect(environmentInputSchema.safeParse(environment).success).toBe(false);
    expect(signoffRecordSchema.safeParse(signoffs).success).toBe(false);
    expect(evaluateM0Entry(signoffs, validEnvironment(), { expectedKind: 'site', allowExample: false }).status).toBe('BLOCKED');
  });

  it('blocks REVIEW records and missing approval actors or timestamps', () => {
    const review = validSignoffs();
    review.status = 'REVIEW';
    expect(evaluateM0Entry(review, validEnvironment(), { expectedKind: 'site', allowExample: false }).status).toBe('BLOCKED');

    const incomplete = validSignoffs();
    delete (incomplete.approvals[0] as Partial<typeof incomplete.approvals[0]>).actor_ref;
    expect(signoffRecordSchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects credential-bearing endpoints and invalid secret references', () => {
    for (const secret_ref of ['vault://', 'vault:///', 'vault://user:password@vault/path', 'postgres://user:password@db/hub']) {
      const environment = validEnvironment();
      environment.sources[0]!.secret_ref = secret_ref;
      expect(environmentInputSchema.safeParse(environment).success, secret_ref).toBe(false);
    }

    for (const endpoint of [
      'https://user:password@crm.example.test/api',
      'https://crm.example.test/api?password=secret',
      'https://crm.example.test/api?token=secret',
    ]) {
      const environment = validEnvironment();
      environment.sources[0]!.endpoint = endpoint;
      expect(environmentInputSchema.safeParse(environment).success, endpoint).toBe(false);
    }
  });

  it('rejects duplicate sources, invalid timezone, and additional secret fields', () => {
    const duplicate = validEnvironment();
    duplicate.sources.push({ ...duplicate.sources[0]!, source_id: 'crm' });
    expect(environmentInputSchema.safeParse(duplicate).success).toBe(false);

    const invalidTimezone = validEnvironment();
    invalidTimezone.business_timezone = 'Mars/Olympus';
    expect(environmentInputSchema.safeParse(invalidTimezone).success).toBe(false);

    const withPassword = { ...validEnvironment(), password: 'should-never-be-accepted' };
    expect(environmentInputSchema.safeParse(withPassword).success).toBe(false);
  });

  it('requires site HTTPS and a sales and manager identity set bound to the tenant', () => {
    const noManager = validEnvironment();
    noManager.test_identities.pop();
    expect(environmentInputSchema.safeParse(noManager).success).toBe(false);

    const wrongTenant = validEnvironment();
    wrongTenant.test_identities[0]!.tenant_key = 'other-tenant';
    expect(environmentInputSchema.safeParse(wrongTenant).success).toBe(false);

    const insecure = validEnvironment();
    insecure.idp.issuer = 'http://id.example.test/tenant-north';
    expect(environmentInputSchema.safeParse(insecure).success).toBe(false);
  });

  it('blocks synthetic identities in site readiness while allowing them in a local lab', () => {
    const site = validEnvironment();
    site.test_identities.forEach((identity, index) => {
      identity.actor_ref = `synthetic://tenant-north/actor-${index}`;
    });
    expect(environmentInputSchema.safeParse(site).success).toBe(false);
    expect(evaluateM0Entry(validSignoffs(), site, { expectedKind: 'site', allowExample: false }).status).toBe('BLOCKED');

    const localLab = { ...site, environment_kind: 'local_lab' as const };
    localLab.idp = {
      issuer: 'http://127.0.0.1:8081/realms/example',
      audience: 'sales-mcp',
      jwks_uri: 'http://localhost:8081/realms/example/jwks',
    };
    expect(environmentInputSchema.safeParse(localLab).success).toBe(true);
  });

  it('rejects password aliases in accepted endpoint query strings', () => {
    for (const endpoint of [
      'mssql://db.example.test/hub?user=readonly&pwd=NON_SECRET_SENTINEL',
      'mssql://db.example.test/hub?%70%77%64=NON_SECRET_SENTINEL',
    ]) {
      const environment = validEnvironment();
      const source = environment.sources[0]! as { connection_mode: string; endpoint: string; read_only?: boolean };
      source.connection_mode = 'sqlserver';
      source.endpoint = endpoint;
      source.read_only = true;
      expect(environmentInputSchema.safeParse(environment).success, endpoint).toBe(false);
    }
  });

  it('allows only HTTPS or loopback HTTP for local-lab IdP URLs', () => {
    const localLab = { ...validEnvironment(), environment_kind: 'local_lab' as const };
    localLab.idp.issuer = 'ftp://id.example.test/realm';
    localLab.idp.jwks_uri = 'ftp://id.example.test/jwks';
    expect(environmentInputSchema.safeParse(localLab).success).toBe(false);

    localLab.idp.issuer = 'http://id.example.test/realm';
    localLab.idp.jwks_uri = 'http://id.example.test/jwks';
    expect(environmentInputSchema.safeParse(localLab).success).toBe(false);

    localLab.idp.issuer = 'https://id.example.test/realm';
    localLab.idp.jwks_uri = 'https://id.example.test/jwks';
    expect(environmentInputSchema.safeParse(localLab).success).toBe(true);

    localLab.idp.issuer = 'http://127.0.0.1:8081/realm';
    localLab.idp.jwks_uri = 'http://[::1]:8081/jwks';
    expect(environmentInputSchema.safeParse(localLab).success).toBe(true);
  });

  it('rejects credentials embedded in identity references', () => {
    const environment = validEnvironment();
    environment.test_identities[0]!.actor_ref = 'https://user:password@id.example.test/subject';
    expect(environmentInputSchema.safeParse(environment).success).toBe(false);

    const signoffs = validSignoffs();
    signoffs.approvals[0]!.actor_ref = 'https://user:password@directory.example.test/approver';
    expect(signoffRecordSchema.safeParse(signoffs).success).toBe(false);

    const malformed = validEnvironment();
    malformed.test_identities[0]!.actor_ref = 'https://user:NON_SECRET_SENTINEL@';
    expect(environmentInputSchema.safeParse(malformed).success).toBe(false);

    const opaque = validEnvironment();
    opaque.test_identities[0]!.actor_ref = 'urn:employee:alice';
    expect(environmentInputSchema.safeParse(opaque).success).toBe(true);
  });

  it('rejects bare user:password@host syntax in test identity references', () => {
    const environment = validEnvironment();
    environment.test_identities[0]!.actor_ref = 'user:NON_SECRET_SENTINEL@directory.example.test';
    expect(environmentInputSchema.safeParse(environment).success).toBe(false);
  });

  it('rejects bare user:password@host syntax in approval actor references', () => {
    const signoffs = validSignoffs();
    signoffs.approvals[0]!.actor_ref = 'user:NON_SECRET_SENTINEL@directory.example.test';
    expect(signoffRecordSchema.safeParse(signoffs).success).toBe(false);
  });

  it('rejects auth_key endpoint query aliases while retaining password aliases', () => {
    const environment = validEnvironment();
    environment.sources[0]!.endpoint = 'https://crm.example.test/api?auth_key=NON_SECRET_SENTINEL';
    expect(environmentInputSchema.safeParse(environment).success).toBe(false);
  });

  it('does not pass an example or a mismatched environment kind as formal M0 readiness', () => {
    const signoffs = validSignoffs();
    const sample = { ...validEnvironment(), example: true };
    expect(evaluateM0Entry(signoffs, sample, { expectedKind: 'site', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(signoffs, validEnvironment(), { expectedKind: 'local_lab', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(validSignoffs(), validEnvironment(), { expectedKind: 'site', allowExample: false })).toEqual({ status: 'PASS', missing: [], example: false });
  });
});

describe('M0 entry CLI', () => {
  it('returns a stable usage error for missing arguments', async () => {
    const result = await runCheckM0Entry([]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ error: 'usage', product_ready: false });
  });

  it('validates examples successfully while explicitly reporting product_ready false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-entry-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      const signoffsPath = join(dir, 'signoffs.json');
      writeFileSync(environmentPath, JSON.stringify({ ...validEnvironment(), example: true }));
      writeFileSync(signoffsPath, JSON.stringify({
        schema_version: 'alpha1.v1',
        contract_ref: 'PRD-DGO-HUB-001:v1.0',
        status: 'REVIEW',
        example: true,
        approvals: [],
      }));

      const result = await runCheckM0Entry([
        '--signoffs', signoffsPath,
        '--environment', environmentPath,
        '--expected-kind', 'site',
        '--validate-example',
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ status: 'BLOCKED', product_ready: false, example: true, scope: 'entry-input-validation' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 for valid but blocked formal readiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-entry-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      const signoffsPath = join(dir, 'signoffs.json');
      writeFileSync(environmentPath, JSON.stringify(validEnvironment()));
      const review = validSignoffs();
      review.status = 'REVIEW';
      writeFileSync(signoffsPath, JSON.stringify(review));

      const result = await runCheckM0Entry([
        '--signoffs', signoffsPath,
        '--environment', environmentPath,
        '--expected-kind', 'site',
      ]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({ status: 'BLOCKED', product_ready: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit code 0 and entry-validation scope for a complete non-example contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-entry-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      const signoffsPath = join(dir, 'signoffs.json');
      writeFileSync(environmentPath, JSON.stringify(validEnvironment()));
      writeFileSync(signoffsPath, JSON.stringify(validSignoffs()));

      const result = await runCheckM0Entry([
        '--signoffs', signoffsPath,
        '--environment', environmentPath,
        '--expected-kind', 'site',
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ status: 'PASS', product_ready: true, scope: 'entry-input-validation' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit code 1 for unreadable and schema-invalid inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-entry-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      const signoffsPath = join(dir, 'signoffs.json');
      writeFileSync(environmentPath, JSON.stringify(validEnvironment()));
      writeFileSync(signoffsPath, '{bad json');
      const args = ['--signoffs', signoffsPath, '--environment', environmentPath, '--expected-kind', 'site'];
      const malformed = await runCheckM0Entry(args);
      expect(malformed.exitCode).toBe(1);
      expect(JSON.parse(malformed.output)).toMatchObject({ error: 'malformed_input', product_ready: false });

      writeFileSync(signoffsPath, JSON.stringify({ status: 'REVIEW' }));
      const invalid = await runCheckM0Entry(args);
      expect(invalid.exitCode).toBe(1);
      expect(JSON.parse(invalid.output)).toMatchObject({ error: 'schema_validation', product_ready: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns stable unreadable_input JSON for a genuinely missing signoff path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-entry-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      writeFileSync(environmentPath, JSON.stringify(validEnvironment()));
      const missingPath = join(dir, 'missing-signoffs.json');
      const result = await runCheckM0Entry([
        '--signoffs', missingPath,
        '--environment', environmentPath,
        '--expected-kind', 'site',
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output)).toEqual({
        error: 'unreadable_input',
        message: 'Input files must be readable JSON documents',
        product_ready: false,
      });
      expect(result.output).not.toContain(missingPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


const platformEnvironment = () => {
  const { hermes: _hermes, ...base } = validEnvironment();
  return { ...base, acceptance_level: 'platform', sources: [{
    source_id: 'import-one', connection_mode: 'SIMULATED_IMPORT', mode: 'INCREMENTAL',
    version_domain: 'SOURCE_VERSION', allowed_entities: ['customer', 'order'], delete_contract: 'tombstone',
    input_ref: 'controlled://batch', data_contract_ref: 'contract://hub/v1', version: '1',
    mapping_ref: 'mapping://import', replica_authorization_ref: 'approval://replica', deletion_contract_ref: 'contract://deletion',
  }] };
};
const platformSignoffs = () => ({ ...validSignoffs(), supplement_ref: 'PRD-DGO-HUB-001-FIXTURE:v1.0.fixture' });

describe('platform entry', () => {
  it('accepts complete platform declarations without site source credentials or Hermes', () => {
    const env = platformEnvironment();
    expect(environmentInputSchema.safeParse(env).success).toBe(true);
    expect(evaluateM0Entry(platformSignoffs(), env, { expectedKind: 'platform', allowExample: false }).status).toBe('PASS');
    expect(evaluateM0Entry(platformSignoffs(), env, { expectedKind: 'site', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(validSignoffs(), env, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(platformSignoffs(), validEnvironment(), { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
  });
});


describe('platform entry boundaries', () => {
  it('rejects missing platform inputs, invalid source variants and mismatched identities', () => {
    const base = platformEnvironment();
    const source = base.sources[0]!;
    const badEnvironments: unknown[] = [
      { ...base, environment_kind: 'local_lab' },
      { ...base, acceptance_level: 'site' },
      { ...base, sources: validEnvironment().sources },
      { ...base, sources: [{ ...source, endpoint: 'https://example.test' }] },
      { ...base, sources: [{ ...source, secret_ref: 'env://EXAMPLE' }] },
      { ...base, sources: [{ ...source, input_ref: '' }] },
      { ...base, sources: [{ ...source, data_contract_ref: '' }] },
      { ...base, sources: [{ ...source, mapping_ref: '' }] },
      { ...base, sources: [{ ...source, deletion_contract_ref: '' }] },
      { ...base, sources: [{ ...source, replica_authorization_ref: '' }] },
      { ...base, sources: [{ ...source, version: '' }] },
      { ...base, sources: [{ ...source, allowed_entities: ['customer', 'customer'] }] },
      { ...base, sources: [{ ...source, mode: 'SNAPSHOT' }] },
      { ...base, sources: [{ ...source, delete_contract: 'missing' }] },
      { ...base, idp: { ...base.idp, issuer: 'http://id.example.test' } },
      { ...base, internal_services: { ...base.internal_services, hub_api: 'https://user:pass@host.test' } },
      { ...base, backup_ref: '' },
      { ...base, tls_hostname: '' },
      { ...base, identity_mapping_ref: '' },
      { ...base, test_identities: base.test_identities.slice(0, 2) },
      { ...base, test_identities: [base.test_identities[0], base.test_identities[0], base.test_identities[2]] },
      { ...base, test_identities: [{ ...base.test_identities[0], tenant_key: 'other' }, ...base.test_identities.slice(1)] },
      { ...base, test_identities: [{ ...base.test_identities[0], actor_ref: 'synthetic://example/user' }, ...base.test_identities.slice(1)] },
      { ...validEnvironment(), hermes: undefined },
      { ...validEnvironment(), sources: [source] },
    ];
    for (const input of badEnvironments) expect(environmentInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('keeps all approval roles and examples blocking formal platform entry', () => {
    const env = platformEnvironment();
    const missing = platformSignoffs();
    missing.approvals.pop();
    expect(evaluateM0Entry(missing, env, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry({ ...platformSignoffs(), status: 'REVIEW' }, env, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry({ ...platformSignoffs(), example: true }, env, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(platformSignoffs(), { ...env, example: true }, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
    expect(evaluateM0Entry(platformSignoffs(), { ...validEnvironment(), environment_kind: 'local_lab' }, { expectedKind: 'platform', allowExample: false }).status).toBe('BLOCKED');
  });

  it('distinguishes platform CLI readiness from example syntax checking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha1-platform-'));
    try {
      const environmentPath = join(dir, 'environment.json');
      const signoffsPath = join(dir, 'signoffs.json');
      writeFileSync(environmentPath, JSON.stringify(platformEnvironment()));
      writeFileSync(signoffsPath, JSON.stringify(platformSignoffs()));
      const args = ['--signoffs', signoffsPath, '--environment', environmentPath, '--expected-kind'];
      const platform = await runCheckM0Entry([...args, 'platform']);
      expect(platform.exitCode).toBe(0);
      expect(JSON.parse(platform.output)).toMatchObject({ status: 'PASS', product_ready: true, scope: 'entry-input-validation' });
      const site = await runCheckM0Entry([...args, 'site']);
      expect(site.exitCode).toBe(2);
      expect(JSON.parse(site.output)).toMatchObject({ status: 'BLOCKED', product_ready: false });
      writeFileSync(environmentPath, JSON.stringify({ ...platformEnvironment(), example: true }));
      const formal = await runCheckM0Entry([...args, 'platform']);
      expect(formal.exitCode).toBe(2);
      const syntax = await runCheckM0Entry([...args, 'platform', '--validate-example']);
      expect(syntax.exitCode).toBe(0);
      expect(JSON.parse(syntax.output)).toMatchObject({ status: 'BLOCKED', product_ready: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it('accepts the checked-in platform example only as a syntax example', async () => {
  const environmentPath = new URL('../../docs/approvals/environment-inputs.platform.example.json', import.meta.url);
  const signoffsPath = new URL('../../docs/approvals/alpha1-signoffs.example.json', import.meta.url);
  const example = JSON.parse(readFileSync(environmentPath, 'utf8'));
  expect(environmentInputSchema.safeParse(example).success).toBe(true);
  const result = await runCheckM0Entry(['--signoffs', fileURLToPath(signoffsPath), '--environment', fileURLToPath(environmentPath), '--expected-kind', 'platform', '--validate-example']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toMatchObject({ status: 'BLOCKED', product_ready: false, example: true });
});
