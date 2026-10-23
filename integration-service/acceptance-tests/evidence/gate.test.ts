import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReleaseGate, validateEvidenceStructure } from '../../contracts/evidence.js';
import { platformNpmInvocation, runRecordLocalChecks } from '../../scripts/record-local-checks.js';
import { runGateCli } from './run-gate.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function runDirectory(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'alpha1-evidence-'));
  const run = join(root, 'run');
  await mkdir(run);
  return run;
}

describe('evidence release gate', () => {
  it('returns a structured non-pass result when required files are absent', async () => {
    const run = await runDirectory();
    const result = await evaluateReleaseGate(run);
    expect(['FAIL', 'BLOCKED']).toContain(result.status);
    expect(result.product_ready).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('returns stable JSON-compatible CLI results and a nonzero code for blocked input', async () => {
    const run = await runDirectory();
    expect(await runGateCli([])).toEqual({ result: { status: 'FAIL', product_ready: false, issues: ['usage: --run-dir <path>'] }, exitCode: 1 });
    const result = await runGateCli(['--run-dir', run]);
    expect(result.exitCode).toBe(2);
    expect(result.result).toMatchObject({ status: 'BLOCKED', product_ready: false });
    expect(Object.keys(result.result).sort()).toEqual(['issues', 'product_ready', 'status']);
  });

  it('exposes the canonical 48 acceptance ids and keeps them NOT_RUN by default', async () => {
    const run = await runDirectory();
    const { requiredAcceptanceIds } = await import('../../contracts/evidence.js');
    expect(requiredAcceptanceIds).toHaveLength(48);
    expect(new Set(requiredAcceptanceIds).size).toBe(48);
    const result = await evaluateReleaseGate(run);
    expect(result.product_ready).toBe(false);
  });

  it('distinguishes a complete synthetic structure from release readiness', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run, true);
    expect(await validateEvidenceStructure(run)).toMatchObject({ status: 'PASS', issues: [] });
    expect(await evaluateReleaseGate(run)).toMatchObject({ status: 'BLOCKED', product_ready: false });
  });

  it('rejects a PASS result when its Oracle assertion values differ', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run, true);
    const resultsPath = join(run, 'acceptance-results.json');
    const acceptance = JSON.parse(await readFile(resultsPath, 'utf8')) as Record<string, any>;
    acceptance.results[0].oracle.actual = { assertion: 'different' };
    await writeFile(resultsPath, JSON.stringify(acceptance));
    await refreshDigests(run);
    const result = await validateEvidenceStructure(run);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some(issue => issue.includes('Oracle expected and actual values differ'))).toBe(true);
  });

  it('compares referenced Oracle JSON values while ignoring object key order', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run, true);
    const resultsPath = join(run, 'acceptance-results.json');
    const acceptance = JSON.parse(await readFile(resultsPath, 'utf8')) as Record<string, any>;
    const expectedPath = join(run, 'oracle-expected.json'), actualPath = join(run, 'oracle-actual.json');
    const expected = '{"a":1,"b":2}', actual = '{"b":2,"a":1}';
    await writeFile(expectedPath, expected); await writeFile(actualPath, actual);
    const expectedRef = { path: 'oracle-expected.json', sha256: `sha256:${createHash('sha256').update(expected).digest('hex')}` };
    const actualRef = { path: 'oracle-actual.json', sha256: `sha256:${createHash('sha256').update(actual).digest('hex')}` };
    acceptance.results[0].oracle = { expected: expectedRef, actual: actualRef };
    acceptance.results[0].evidence_files.push(expectedRef, actualRef);
    await writeFile(resultsPath, JSON.stringify(acceptance));
    const digests = JSON.parse(await readFile(join(run, 'file-digests.json'), 'utf8')) as Record<string, string>;
    digests[expectedRef.path] = expectedRef.sha256;
    digests[actualRef.path] = actualRef.sha256;
    await writeFile(join(run, 'file-digests.json'), JSON.stringify(digests));
    await refreshDigests(run);
    expect(await validateEvidenceStructure(run)).toMatchObject({ status: 'PASS', issues: [] });
  });

  it('rejects a symlink in any referenced path segment', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run, true);
    const outside = join(root!, 'outside.json');
    await writeFile(outside, '{"outside":true}');
    await symlink(outside, join(run, 'escape.json'), 'file');
    const digestPath = join(run, 'file-digests.json');
    const digests = JSON.parse(await readFile(digestPath, 'utf8')) as Record<string, string>;
    digests['escape.json'] = `sha256:${createHash('sha256').update(await readFile(outside)).digest('hex')}`;
    await writeFile(digestPath, JSON.stringify(digests));
    const result = await validateEvidenceStructure(run);
    expect(result.status).toBe('FAIL');
    expect(result.issues.some(issue => issue.includes('symlink evidence path rejected'))).toBe(true);
  });

  it('rejects PASS records whose source, image, or fixture identities differ from the run', async () => {
    for (const [field, value] of [['git_sha', 'f'.repeat(40)], ['image_digests', {}], ['input_manifest', { path: 'elsewhere.json', sha256: `sha256:${'a'.repeat(64)}` }]] as const) {
      const run = await runDirectory();
      await createSyntheticFixture(run, true);
      const path = join(run, 'acceptance-results.json');
      const acceptance = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
      acceptance.results[0][field] = value;
      await writeFile(path, JSON.stringify(acceptance));
      await refreshDigests(run);
      expect((await validateEvidenceStructure(run)).status, field).toBe('FAIL');
      await rm(root!, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('rejects evidence digest tampering and path traversal', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run);
    const target = join(run, 'golden-consumer', 'calls', 'trace-1.json');
    await writeFile(target, '{"altered":true}');
    expect((await validateEvidenceStructure(run)).status).toBe('FAIL');
    const digests = JSON.parse(await (await import('node:fs/promises')).readFile(join(run, 'file-digests.json'), 'utf8')) as Record<string, string>;
    digests['../outside.json'] = 'sha256:' + 'a'.repeat(64);
    await writeFile(join(run, 'file-digests.json'), JSON.stringify(digests));
    expect((await validateEvidenceStructure(run)).status).toBe('FAIL');
  });

  it('rejects a claimed golden consumer with synthetic inputs or duplicate actor evidence', async () => {
    const run = await runDirectory();
    await createSyntheticFixture(run);
    const manifestPath = join(run, 'golden-consumer', 'manifest.json');
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')) as Record<string, any>;
    manifest.input_kind = 'real';
    manifest.profiles[1].actor_ref = manifest.profiles[0].actor_ref;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await refreshDigests(run);
    expect((await validateEvidenceStructure(run)).status).toBe('FAIL');
  });
});

describe('fixed local check recorder', () => {
  it('routes Windows npm scripts through cmd.exe with only the fixed command words', () => {
    expect(platformNpmInvocation(['run', 'typecheck'], 'win32')).toEqual({ executable: 'cmd.exe', args: ['/d', '/s', '/c', 'npm run typecheck'] });
    expect(platformNpmInvocation(['test'], 'linux')).toEqual({ executable: 'npm', args: ['test'] });
  });

  it('runs only the fixed allowlist, records source and log digests, and refuses overwrite', async () => {
    root = await mkdtemp(join(tmpdir(), 'alpha1-recorder-'));
    const commands: string[][] = [];
    const runner = async (command: string[]) => { commands.push(command); return { stdout: `ok:${command.join(' ')}`, stderr: '', exit_code: 0 }; };
    const created = await runRecordLocalChecks(['--output-parent', root, '--run-id', 'check-run-1'], runner);
    expect(created).toEqual({ result: expect.objectContaining({ status: 'PASS', product_ready: false }), exitCode: 0 });
    expect(commands).toEqual([['run', 'typecheck'], ['test'], ['run', 'build']]);
    const runDir = created.result.run_dir!;
    const results = JSON.parse(await readFile(join(runDir, 'acceptance-results.json'), 'utf8'));
    expect(results.results).toHaveLength(48);
    expect(results.results.every((item: any) => item.status === 'NOT_RUN')).toBe(true);
    const worktree = JSON.parse(await readFile(join(runDir, 'worktree-manifest.json'), 'utf8'));
    expect(worktree.git_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(typeof worktree.dirty).toBe('boolean');
    expect(worktree.dirty).toBe(worktree.files.length > 0 || worktree.unavailable_paths.length > 0);
    for (const file of worktree.files) {
      const bytes = await readFile(join(process.cwd(), '..', file.path));
      expect(file.sha256).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    }
    const gate = await evaluateReleaseGate(runDir);
    expect(gate).toMatchObject({ status: 'BLOCKED', product_ready: false });
    const duplicate = await runRecordLocalChecks(['--output-parent', root, '--run-id', 'check-run-1'], runner);
    expect(duplicate.exitCode).toBe(1);
    expect(commands).toHaveLength(3);
  });

  it('rejects arbitrary commands and unsafe run identifiers without invoking a runner', async () => {
    const runner = async () => { throw new Error('must not run'); };
    expect((await runRecordLocalChecks(['--command', 'whoami'], runner)).exitCode).toBe(1);
    expect((await runRecordLocalChecks(['--output-parent', 'tmp', '--run-id', '../escape'], runner)).exitCode).toBe(1);
  });
});

async function createSyntheticFixture(run: string, complete = false): Promise<void> {
  const repository = join(process.cwd(), '..');
  const environment = JSON.parse(await readFile(join(repository, 'docs', 'approvals', 'environment-inputs.example.json'), 'utf8'));
  environment.environment_kind = 'site';
  environment.idp.issuer = 'https://idp.example.test/realms/example';
  environment.idp.jwks_uri = 'https://idp.example.test/keys';
  environment.sources[0].endpoint = 'https://crm.example.test/read-only';
  environment.test_identities.forEach((identity: any, index: number) => { identity.actor_ref = `urn:fixture:actor:${index + 1}`; });
  const signoffs = JSON.parse(await readFile(join(repository, 'docs', 'approvals', 'alpha1-signoffs.example.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(process.cwd(), 'deploy', 'deployment.lock.example.json'), 'utf8'));
  const pins = JSON.parse(await readFile(join(process.cwd(), 'deploy', 'upstream-pins.json'), 'utf8'));
  const runId = 'synthetic-fixture-1';
  lock.run_id = runId;
  const gitSha = lock.components['hub-api'].source_sha;
  const imageDigests = Object.fromEntries(Object.entries(lock.components).map(([id, component]: [string, any]) => [id, component.image.manifest_digest]));
  const put = async (path: string, value: string | unknown): Promise<{ path: string; sha256: string }> => {
    const absolute = join(run, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(absolute, content);
    return { path, sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` };
  };
  const crmApproval = await put('approvals/crm.json', { approved: true });
  const ordersApproval = await put('approvals/orders.json', { approved: true });
  const crmInput = await put('inputs/crm.json', [{ id: 'synthetic-crm-1' }]);
  const ordersInput = await put('inputs/orders.json', [{ id: 'synthetic-order-1' }]);
  const schemaDigest = `sha256:${'1'.repeat(64)}`;
  const approvalRef = (system: string) => `synthetic-approval:${system}`;
  const sourceContracts = {
    schema_version: 'alpha1.v1', run_id: runId, input_kind: 'synthetic', contracts: [
      { source_id: environment.sources[0].source_id, system: 'crm', interface_version: 'synthetic-v1', schema_digest: schemaDigest, approval_ref: approvalRef('crm'), owner_ref: 'synthetic:owner:crm', approval_evidence: crmApproval },
      { source_id: environment.sources[1].source_id, system: 'orders', interface_version: 'synthetic-v1', schema_digest: schemaDigest, approval_ref: approvalRef('orders'), owner_ref: 'synthetic:owner:orders', approval_evidence: ordersApproval },
    ],
  };
  const fixture = { schema_version: 'alpha1.v1', run_id: runId, input_kind: 'synthetic', inputs: [
    { source_id: environment.sources[0].source_id, schema_digest: schemaDigest, approval_ref: approvalRef('crm'), file: crmInput },
    { source_id: environment.sources[1].source_id, schema_digest: schemaDigest, approval_ref: approvalRef('orders'), file: ordersInput },
  ] };
  const actorRefs = environment.test_identities.map((identity: any) => identity.actor_ref);
  const profiles = [];
  const calls = [];
  for (let i = 0; i < 3; i++) {
    const before = await put(`golden-consumer/profile-${i}-before.json`, { segment: 'synthetic-before' });
    const after = await put(`golden-consumer/profile-${i}-after.json`, { segment: 'synthetic-after' });
    const unrelated = await put(`golden-consumer/profile-${i}-unrelated.json`, { setting: 'synthetic-unchanged' });
    const trace = await put(`golden-consumer/calls/trace-${i}.json`, { tool: 'synthetic' });
    const oracle = await put(`golden-consumer/calls/oracle-${i}.json`, { expected: 'synthetic' });
    const answer = await put(`golden-consumer/calls/answer-${i}.json`, { answer: 'synthetic' });
    profiles.push({ actor_ref: actorRefs[i], before, after, unrelated_configuration: unrelated, call_evidence: trace });
    calls.push({ actor_ref: actorRefs[i], input_refs: [crmInput, ordersInput], oracle, tool_trace: trace, final_answer: answer });
  }
  const results = requiredIds().map(acceptance_id => ({
    acceptance_id,
    requirement_ids: expectedRequirements(acceptance_id),
    status: 'NOT_RUN',
  }));
  const fixed = {
    'run.json': { schema_version: 'alpha1.v1', run_id: runId, kind: 'synthetic', git_sha: gitSha, captured_at: '2026-10-23T00:03:00Z', image_digests: imageDigests },
    'environment-inputs.json': environment,
    'signoffs.json': signoffs,
    'upstream-pins.json': pins,
    'deployment.lock.json': lock,
    'source-contracts.json': sourceContracts,
    'fixture-manifest.json': fixture,
    'acceptance-results.json': { schema_version: 'alpha1.v1', run_id: runId, results },
    'golden-consumer/manifest.json': {
      schema_version: 'alpha1.v1', run_id: runId, input_kind: 'synthetic',
      consumer: { name: 'Hermes synthetic', actual_version: environment.hermes.actual_version, deployment_ref: 'synthetic://hermes' },
      mcp: { git_sha: lock.components['sales-mcp'].source_sha, manifest_digest: lock.components['sales-mcp'].image.manifest_digest },
      approved_source_inputs: [crmInput, ordersInput], profiles, calls,
    },
  };
  const digestMap: Record<string, string> = {};
  for (const [path, value] of Object.entries(fixed)) digestMap[path] = (await put(path, value)).sha256;
  // All referenced evidence files were added to the digest map above.
  for (const ref of [crmApproval, ordersApproval, crmInput, ordersInput, ...profiles.flatMap(p => [p.before, p.after, p.unrelated_configuration, p.call_evidence]), ...calls.flatMap(c => [c.oracle, c.tool_trace, c.final_answer])]) digestMap[ref.path] = ref.sha256;
  if (complete) {
    for (const result of results as any[]) {
      const evidence = await put(`acceptance-evidence/${result.acceptance_id}.json`, { acceptance_id: result.acceptance_id, assertion: 'synthetic-pass' });
      digestMap[evidence.path] = evidence.sha256;
      result.status = 'PASS';
      result.test_ids = [`TEST-${result.acceptance_id}`];
      result.command = `npm test -- ${result.acceptance_id}`;
      result.exit_code = 0;
      result.started_at = '2026-10-23T00:01:00Z';
      result.completed_at = '2026-10-23T00:02:00Z';
      result.git_sha = gitSha;
      result.image_digests = imageDigests;
      result.input_manifest = { path: 'fixture-manifest.json', sha256: digestMap['fixture-manifest.json'] };
      result.oracle = { expected: { assertion: result.acceptance_id }, actual: { assertion: result.acceptance_id } };
      result.evidence_files = [evidence];
    }
    digestMap['acceptance-results.json'] = (await put('acceptance-results.json', { schema_version: 'alpha1.v1', run_id: runId, results })).sha256;
  }
  await writeFile(join(run, 'file-digests.json'), JSON.stringify(digestMap));
}

async function refreshDigests(run: string): Promise<void> {
  const raw = JSON.parse(await readFile(join(run, 'file-digests.json'), 'utf8')) as Record<string, string>;
  for (const path of Object.keys(raw)) {
    const bytes = await readFile(join(run, path));
    raw[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  await writeFile(join(run, 'file-digests.json'), JSON.stringify(raw));
}

function requiredIds(): string[] { return [...Array.from({ length: 18 }, (_, i) => i), ...Array.from({ length: 18 }, (_, i) => i)].map((_, index) => index < 18 ? `A-${['ARCH', 'AUTH', 'SRC', 'ING', 'ETL', 'DATA', 'GOV', 'ONT', 'PUB', 'SEC', 'POL', 'API', 'MCP', 'AGENT', 'UI', 'OBS', 'OPS', 'EVID'][index]}-001` : `N-${['ARCH', 'AUTH', 'SRC', 'ING', 'ETL', 'DATA', 'GOV', 'ONT', 'PUB', 'SEC', 'POL', 'API', 'MCP', 'AGENT', 'UI', 'OBS', 'OPS', 'EVID'][index - 18]}-001`).concat(Array.from({ length: 12 }, (_, i) => `FI-${String(i + 1).padStart(2, '0')}`)); }
function expectedRequirements(id: string): string[] {
  const fi: Record<string, string[]> = { 'FI-01': ['ING'], 'FI-02': ['ING'], 'FI-03': ['DATA'], 'FI-04': ['ETL'], 'FI-05': ['ETL'], 'FI-06': ['POL'], 'FI-07': ['POL'], 'FI-08': ['POL'], 'FI-09': ['POL', 'OPS'], 'FI-10': ['AUTH', 'API'], 'FI-11': ['GOV', 'ONT'], 'FI-12': ['OBS'] };
  if (id.startsWith('FI-')) return fi[id]!.map(owner => `REQ-${owner}-001`);
  return [`REQ-${id.split('-')[1]}-001`];
}
