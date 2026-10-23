import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { evaluateM0Entry, signoffRecordSchema } from './signoff.js';
import { upstreamPinsFileSchema, validateDeploymentLock } from './deployment-lock.js';

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonempty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const referenceSchema = z.object({ path: nonempty, sha256 }).strict();
const actorRef = nonempty;

export const requiredAcceptanceIds = [
  ...['ARCH', 'AUTH', 'SRC', 'ING', 'ETL', 'DATA', 'GOV', 'ONT', 'PUB', 'SEC', 'POL', 'API', 'MCP', 'AGENT', 'UI', 'OBS', 'OPS', 'EVID'].flatMap(category => [`A-${category}-001`, `N-${category}-001`]),
  ...Array.from({ length: 12 }, (_, index) => `FI-${String(index + 1).padStart(2, '0')}`),
] as const;

const categoryRequirement = new Map<string, string>();
for (const category of ['ARCH', 'AUTH', 'SRC', 'ING', 'ETL', 'DATA', 'GOV', 'ONT', 'PUB', 'SEC', 'POL', 'API', 'MCP', 'AGENT', 'UI', 'OBS', 'OPS', 'EVID']) {
  categoryRequirement.set(`A-${category}-001`, `REQ-${category}-001`);
  categoryRequirement.set(`N-${category}-001`, `REQ-${category}-001`);
}
const fiOwners: Record<string, string[]> = {
  'FI-01': ['ING'], 'FI-02': ['ING'], 'FI-03': ['DATA'], 'FI-04': ['ETL'], 'FI-05': ['ETL'],
  'FI-06': ['POL'], 'FI-07': ['POL'], 'FI-08': ['POL'], 'FI-09': ['POL', 'OPS'],
  'FI-10': ['AUTH', 'API'], 'FI-11': ['GOV', 'ONT'], 'FI-12': ['OBS'],
};

const oracleValue = z.union([z.unknown(), referenceSchema]);
const resultSchema = z.object({
  acceptance_id: z.enum(requiredAcceptanceIds),
  requirement_ids: z.array(nonempty),
  test_ids: z.array(nonempty).optional(),
  status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'NOT_RUN']),
  command: z.string().optional(),
  exit_code: z.number().int().optional(),
  started_at: timestamp.optional(),
  completed_at: timestamp.optional(),
  git_sha: nonempty.optional(),
  image_digests: z.record(nonempty, sha256).optional(),
  input_manifest: referenceSchema.optional(),
  oracle: z.object({ expected: oracleValue.optional(), actual: oracleValue.optional() }).strict().optional(),
  evidence_files: z.array(referenceSchema).optional(),
}).strict();

export const runManifestSchema = z.object({
  schema_version: z.literal('alpha1.v1'), run_id: nonempty,
  kind: z.enum(['observed', 'synthetic', 'fixture', 'local_check']),
  git_sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  captured_at: timestamp,
  image_digests: z.record(nonempty, sha256),
}).strict();

export const acceptanceResultsSchema = z.object({ schema_version: z.literal('alpha1.v1'), run_id: nonempty, results: z.array(resultSchema) }).strict();

const sourceContractSchema = z.object({
  source_id: nonempty, system: z.enum(['crm', 'orders']), interface_version: nonempty,
  schema_digest: sha256, approval_ref: nonempty, owner_ref: nonempty, approval_evidence: referenceSchema,
}).strict();
export const sourceContractsSchema = z.object({ schema_version: z.literal('alpha1.v1'), run_id: nonempty, input_kind: z.enum(['real', 'synthetic']), contracts: z.array(sourceContractSchema) }).strict();
const fixtureInputSchema = z.object({ source_id: nonempty, schema_digest: sha256, approval_ref: nonempty, file: referenceSchema }).strict();
export const fixtureManifestSchema = z.object({ schema_version: z.literal('alpha1.v1'), run_id: nonempty, input_kind: z.enum(['real', 'synthetic']), inputs: z.array(fixtureInputSchema) }).strict();

const consumerProfile = z.object({ actor_ref: actorRef, before: referenceSchema, after: referenceSchema, unrelated_configuration: referenceSchema, call_evidence: referenceSchema }).strict();
const consumerCall = z.object({ actor_ref: actorRef, input_refs: z.array(referenceSchema).min(1), oracle: referenceSchema, tool_trace: referenceSchema, final_answer: referenceSchema }).strict();
export const goldenConsumerManifestSchema = z.object({
  schema_version: z.literal('alpha1.v1'), run_id: nonempty, input_kind: z.enum(['real', 'synthetic']),
  consumer: z.object({ name: nonempty, actual_version: nonempty, deployment_ref: nonempty, observed_commit: z.string().optional() }).strict(),
  mcp: z.object({ git_sha: nonempty, manifest_digest: sha256 }).strict(),
  approved_source_inputs: z.array(referenceSchema), profiles: z.array(consumerProfile), calls: z.array(consumerCall),
}).strict();

export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED';
export type EvidenceCheckResult = { status: GateStatus; issues: string[] };
export type ReleaseGateResult = EvidenceCheckResult & { product_ready: boolean };

function hasNonrealAuthorityScheme(reference: string): boolean {
  return /^(?:synthetic|example|fixture):/i.test(reference.trim());
}

function nonrealAuthorityIssues(data: Record<string, any>): string[] {
  const references: Array<[string, unknown]> = [];
  const env = data['environment-inputs.json'];
  const signoffs = data['signoffs.json'];
  const sourceContracts = data['source-contracts.json'];
  const fixture = data['fixture-manifest.json'];
  const golden = data['golden-consumer/manifest.json'];
  references.push(['golden-consumer/manifest.json: consumer.deployment_ref', golden?.consumer?.deployment_ref]);
  for (const [index, contract] of (sourceContracts?.contracts ?? []).entries()) {
    references.push([`source-contracts.json: contracts[${index}].approval_ref`, contract.approval_ref]);
    references.push([`source-contracts.json: contracts[${index}].owner_ref`, contract.owner_ref]);
  }
  for (const [index, input] of (fixture?.inputs ?? []).entries()) {
    references.push([`fixture-manifest.json: inputs[${index}].approval_ref`, input.approval_ref]);
  }
  for (const [index, approval] of (signoffs?.approvals ?? []).entries()) {
    references.push([`signoffs.json: approvals[${index}].actor_ref`, approval.actor_ref]);
  }
  for (const [index, identity] of (env?.test_identities ?? []).entries()) {
    references.push([`environment-inputs.json: test_identities[${index}].actor_ref`, identity.actor_ref]);
  }
  references.push(['environment-inputs.json: identity_mapping_ref', env?.identity_mapping_ref]);
  references.push(['environment-inputs.json: backup_ref', env?.backup_ref]);
  for (const [index, source] of (env?.sources ?? []).entries()) {
    references.push([`environment-inputs.json: sources[${index}].mapping_ref`, source.mapping_ref]);
    references.push([`environment-inputs.json: sources[${index}].replica_authorization_ref`, source.replica_authorization_ref]);
    references.push([`environment-inputs.json: sources[${index}].deletion_contract_ref`, source.deletion_contract_ref]);
  }
  return references.filter((entry): entry is [string, string] => typeof entry[1] === 'string' && hasNonrealAuthorityScheme(entry[1]))
    .map(([path]) => `${path}: explicit synthetic/example/fixture authority references cannot satisfy release`);
}

function controlledPinsPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = basename(dirname(moduleDirectory)) === 'dist'
    ? resolve(moduleDirectory, '../..')
    : resolve(moduleDirectory, '..');
  return resolve(projectRoot, 'deploy/upstream-pins.json');
}

export async function safeReadEvidenceFile(runDir: string, filePath: string): Promise<{ bytes: Buffer; sha256: string; absolutePath: string; identity: string }> {
  if (filePath.includes('\0') || filePath.startsWith('/') || filePath.startsWith('\\') || /^[A-Za-z]:/.test(filePath) || isAbsolute(filePath)) {
    throw new Error(`unsafe evidence path: ${filePath}`);
  }
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some(part => part === '..' || part === '.' || part.length === 0)) throw new Error(`unsafe evidence path: ${filePath}`);
  const runInfo = await lstat(runDir);
  if (runInfo.isSymbolicLink() || !runInfo.isDirectory()) throw new Error('runDir must be a real directory, not a symlink or junction');
  const base = await realpath(runDir);
  const absolutePath = resolve(base, ...parts);
  const rel = relative(base, absolutePath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`evidence path escapes run directory: ${filePath}`);
  let cursor = base;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`symlink evidence path rejected: ${filePath}`);
  }
  const actual = await realpath(absolutePath);
  const actualRelative = relative(base, actual);
  if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error(`evidence path escapes run directory: ${filePath}`);
  const fileInfo = await lstat(absolutePath, { bigint: true });
  const bytes = await readFile(absolutePath);
  const canonicalPath = process.platform === 'win32' ? actual.toLocaleLowerCase('en-US') : actual;
  const identity = fileInfo.ino !== 0n && fileInfo.dev !== 0n
    ? `file:${fileInfo.dev}:${fileInfo.ino}`
    : `path:${canonicalPath}`;
  return { bytes, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, absolutePath: actual, identity };
}

const fixedFiles = [
  'run.json', 'environment-inputs.json', 'signoffs.json', 'upstream-pins.json', 'deployment.lock.json',
  'source-contracts.json', 'fixture-manifest.json', 'acceptance-results.json', 'golden-consumer/manifest.json', 'file-digests.json',
] as const;

type LoadedRun = { data: Record<string, any>; digests: Record<string, string>; issues: string[]; missing: string[] };
async function loadRun(runDir: string): Promise<LoadedRun> {
  const data: Record<string, any> = {};
  const issues: string[] = [];
  const missing: string[] = [];
  let digestMap: Record<string, string> = {};
  for (const path of fixedFiles) {
    try {
      const file = await safeReadEvidenceFile(runDir, path);
      const parsed: unknown = JSON.parse(file.bytes.toString('utf8'));
      if (path === 'file-digests.json') {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('file-digests.json must be an object');
        digestMap = parsed as Record<string, string>;
      } else data[path] = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(path);
      else issues.push(`${path}: ${error instanceof Error ? error.message : 'invalid file'}`);
    }
  }
  if (!missing.includes('file-digests.json')) {
    for (const path of Object.keys(digestMap)) {
      try {
        if (path === 'file-digests.json') throw new Error('file-digests.json cannot hash itself');
        if (!sha256.safeParse(digestMap[path]).success) throw new Error('invalid SHA256 digest');
        const file = await safeReadEvidenceFile(runDir, path);
        if (file.sha256 !== digestMap[path]) throw new Error('SHA256 mismatch');
      } catch (error) { issues.push(`${path}: ${error instanceof Error ? error.message : 'invalid digest entry'}`); }
    }
    for (const path of fixedFiles.filter(path => path !== 'file-digests.json')) {
      if (digestMap[path] === undefined && !missing.includes(path)) issues.push(`${path}: missing from file-digests.json`);
    }
  }
  return { data, digests: digestMap, issues, missing };
}

function isReference(value: unknown): value is z.infer<typeof referenceSchema> { return referenceSchema.safeParse(value).success; }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hasConcreteOracle(value: unknown): boolean {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0)) return false;
  if (Array.isArray(value)) return value.length > 0 && value.every(hasConcreteOracle);
  if (typeof value === 'object') return Object.keys(value as object).length > 0 && Object.values(value as object).every(hasConcreteOracle);
  return true;
}

async function validateBundle(runDir: string): Promise<EvidenceCheckResult & { data?: Record<string, any>; digests?: Record<string, string> }> {
  const loaded = await loadRun(runDir);
  const issues = [...loaded.issues];
  const blocked: string[] = loaded.missing.map(file => `${file}: required file is missing`);
  if (blocked.length || issues.length) return { status: issues.length ? 'FAIL' : 'BLOCKED', issues: [...issues, ...blocked].sort(), data: loaded.data, digests: loaded.digests };
  const d = loaded.data;
  const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T | undefined => {
    const result = schema.safeParse(value);
    if (!result.success) { issues.push(`${label}: schema invalid`); return undefined; }
    return result.data;
  };
  const run = parse(runManifestSchema, d['run.json'], 'run.json');
  const env = parse((await import('./environment.js')).environmentInputSchema, d['environment-inputs.json'], 'environment-inputs.json');
  const acceptance = parse(acceptanceResultsSchema, d['acceptance-results.json'], 'acceptance-results.json');
  const sourceContracts = parse(sourceContractsSchema, d['source-contracts.json'], 'source-contracts.json');
  const fixture = parse(fixtureManifestSchema, d['fixture-manifest.json'], 'fixture-manifest.json');
  const golden = parse(goldenConsumerManifestSchema, d['golden-consumer/manifest.json'], 'golden-consumer/manifest.json');
  const pins = parse(upstreamPinsFileSchema, d['upstream-pins.json'], 'upstream-pins.json');
  if (!run || !env || !acceptance || !sourceContracts || !fixture || !golden || !pins) return { status: 'FAIL', issues, data: d, digests: loaded.digests };
  const lock = d['deployment.lock.json'];
  const lockCheck = validateDeploymentLock(lock, pins, { release: false });
  issues.push(...lockCheck.issues.map(issue => `deployment.lock.json: ${issue}`));
  const signoffParsed = signoffRecordSchema.safeParse(d['signoffs.json']);
  if (!signoffParsed.success) issues.push('signoffs.json: schema invalid');
  const signoff = evaluateM0Entry(d['signoffs.json'], env, { expectedKind: env.environment_kind, allowExample: true });
  if (signoffParsed.success && !signoff.example && signoff.missing.some(item => item.startsWith('signoffs:') || item.startsWith('environment:'))) issues.push('signoffs.json: signoff or environment contract invalid');

  const runId = run.run_id;
  for (const [name, value] of [['deployment.lock.json', lock], ['source-contracts.json', sourceContracts], ['fixture-manifest.json', fixture], ['acceptance-results.json', acceptance], ['golden-consumer/manifest.json', golden]] as const) {
    if (!value || value.run_id !== runId) issues.push(`${name}: run_id mismatch`);
  }
  const hubShas = [...new Set(Object.entries(lock?.components ?? {}).filter(([id]) => id.startsWith('hub-') || id === 'sales-mcp').map(([, component]: [string, any]) => component.source_sha))];
  if (hubShas.length !== 1 || run.git_sha !== hubShas[0]) issues.push('run.json: git_sha must match all hub component source_sha values');
  const lockImages = Object.fromEntries(Object.entries(lock?.components ?? {}).map(([id, component]: [string, any]) => [id, component.image?.manifest_digest]));
  if (stable(run.image_digests) !== stable(lockImages)) issues.push('run.json: image_digests must match deployment lock manifests');
  if (sourceContracts.input_kind !== fixture.input_kind) issues.push('fixture-manifest.json: input_kind does not match source contracts');

  const contractsById = new Map(sourceContracts.contracts.map(contract => [contract.source_id, contract]));
  const systems = new Set(sourceContracts.contracts.map(contract => contract.system));
  if (systems.size !== 2 || !systems.has('crm') || !systems.has('orders')) issues.push('source-contracts.json: CRM and orders contracts are required');
  if (sourceContracts.contracts.length !== contractsById.size) issues.push('source-contracts.json: duplicate source_id');
  for (const contract of sourceContracts.contracts) {
    if (!env.sources.some(source => source.source_id === contract.source_id)) issues.push(`source-contracts.json: ${contract.source_id} is absent from environment sources`);
  }
  const fixtureSourceIds = fixture.inputs.map(input => input.source_id);
  const uniqueFixtureSourceIds = new Set(fixtureSourceIds);
  if (uniqueFixtureSourceIds.size !== fixtureSourceIds.length) issues.push('fixture-manifest.json: source IDs must be unique');
  const approvedSourceIds = [...contractsById.keys()].sort();
  const fixtureSourceIdSet = [...uniqueFixtureSourceIds].sort();
  if (stable(fixtureSourceIdSet) !== stable(approvedSourceIds) || fixture.inputs.length !== contractsById.size) {
    issues.push('fixture-manifest.json: must contain exactly one input artifact for every approved source contract');
  }
  for (const input of fixture.inputs) {
    const contract = contractsById.get(input.source_id);
    if (!contract || contract.schema_digest !== input.schema_digest || contract.approval_ref !== input.approval_ref) issues.push(`fixture-manifest.json: ${input.source_id} does not match source contract`);
  }
  if (fixture.inputs.length !== contractsById.size) issues.push('fixture-manifest.json: must reference every source contract');

  const expectedActors = new Map(env.test_identities.map(identity => [identity.actor_ref, identity.role]));
  const requiredActors = env.environment_kind === 'site' ? env.test_identities.filter(i => i.role === 'sales').slice(0, 2).concat(env.test_identities.filter(i => i.role === 'sales_manager').slice(0, 1)) : [];
  const actualActors = new Set(golden.profiles.map(profile => profile.actor_ref));
  if (golden.input_kind !== sourceContracts.input_kind || golden.input_kind !== fixture.input_kind) issues.push('golden-consumer/manifest.json: input_kind mismatch');
  if (golden.consumer.actual_version !== env.hermes.actual_version) issues.push('golden-consumer/manifest.json: Hermes version mismatch');
  if (golden.mcp.git_sha !== lock?.components?.['sales-mcp']?.source_sha || golden.mcp.manifest_digest !== lock?.components?.['sales-mcp']?.image?.manifest_digest) issues.push('golden-consumer/manifest.json: MCP identity mismatch');
  if (requiredActors.length !== 3 || actualActors.size !== golden.profiles.length || golden.calls.length !== 3) issues.push('golden-consumer/manifest.json: requires three distinct consumer actors and calls');
  const callActors = new Set(golden.calls.map(call => call.actor_ref));
  if (callActors.size !== golden.calls.length || requiredActors.some(identity => !callActors.has(identity.actor_ref))) issues.push('golden-consumer/manifest.json: each required actor needs one distinct call');
  for (const identity of requiredActors) if (!actualActors.has(identity.actor_ref)) issues.push(`golden-consumer/manifest.json: missing profile for ${identity.actor_ref}`);
  for (const profile of golden.profiles) if (!expectedActors.has(profile.actor_ref)) issues.push(`golden-consumer/manifest.json: unknown actor ${profile.actor_ref}`);
  for (const call of golden.calls) if (!expectedActors.has(call.actor_ref) || !actualActors.has(call.actor_ref)) issues.push(`golden-consumer/manifest.json: call actor ${call.actor_ref} has no matching profile`);
  for (const profile of golden.profiles) {
    if (!golden.calls.some(call => call.actor_ref === profile.actor_ref && call.tool_trace.path === profile.call_evidence.path && call.tool_trace.sha256 === profile.call_evidence.sha256)) {
      issues.push(`golden-consumer/manifest.json: profile call evidence is not linked to a call for ${profile.actor_ref}`);
    }
  }
  const sourceInputRefs = fixture.inputs.map(input => input.file).sort((a, b) => a.path.localeCompare(b.path));
  const goldenSourceRefs = golden.approved_source_inputs.slice().sort((a, b) => a.path.localeCompare(b.path));
  if (stable(goldenSourceRefs) !== stable(sourceInputRefs)) issues.push('golden-consumer/manifest.json: approved source input references do not match the fixture manifest');
  for (const call of golden.calls) {
    const callInputs = call.input_refs.slice().sort((a, b) => a.path.localeCompare(b.path));
    if (stable(callInputs) !== stable(sourceInputRefs)) issues.push(`golden-consumer/manifest.json: call inputs for ${call.actor_ref} do not match the approved fixture inputs`);
  }

  const resultsById = new Map(acceptance.results.map(result => [result.acceptance_id, result]));
  if (resultsById.size !== acceptance.results.length) issues.push('acceptance-results.json: duplicate acceptance_id');
  if (resultsById.size !== 48 || requiredAcceptanceIds.some(id => !resultsById.has(id))) issues.push('acceptance-results.json: all 48 required acceptance IDs must be present');
  for (const result of acceptance.results) {
    const expectedRequirements = result.acceptance_id.startsWith('FI-') ? (fiOwners[result.acceptance_id] ?? []).map(owner => `REQ-${owner}-001`) : [categoryRequirement.get(result.acceptance_id)];
    if (stable(result.requirement_ids) !== stable(expectedRequirements)) issues.push(`${result.acceptance_id}: requirement_ids do not match required owners`);
    if (result.status === 'PASS') {
      if (!result.command?.trim() || result.exit_code !== 0 || !result.started_at || !result.completed_at || Date.parse(result.completed_at) < Date.parse(result.started_at) || Date.parse(result.completed_at) > Date.parse(run.captured_at)) issues.push(`${result.acceptance_id}: PASS requires command, exit_code 0, and ordered timestamps within the run`);
      if (result.git_sha !== run.git_sha || stable(result.image_digests) !== stable(run.image_digests)) issues.push(`${result.acceptance_id}: source/image identities mismatch`);
      if (!result.test_ids?.includes(`TEST-${result.acceptance_id}`)) issues.push(`${result.acceptance_id}: PASS requires its canonical test_id`);
      if (!result.input_manifest || result.input_manifest.path !== 'fixture-manifest.json' || result.input_manifest.sha256 !== loaded.digests['fixture-manifest.json']) issues.push(`${result.acceptance_id}: PASS requires matching fixture manifest reference`);
      if (!result.evidence_files?.length) issues.push(`${result.acceptance_id}: PASS requires evidence files`);
      if (!result.oracle || result.oracle.expected === undefined || result.oracle.actual === undefined) issues.push(`${result.acceptance_id}: PASS requires concrete Oracle expected and actual values`);
      for (const evidence of result.evidence_files ?? []) if (!loaded.digests[evidence.path] || loaded.digests[evidence.path] !== evidence.sha256) issues.push(`${result.acceptance_id}: evidence file is not covered by file-digests.json`);
    } else if (result.status === 'NOT_RUN') {
      // NOT_RUN is the canonical initial state and contributes no release evidence.
    }
  }
  const refs: z.infer<typeof referenceSchema>[] = [];
  for (const contract of sourceContracts.contracts) refs.push(contract.approval_evidence);
  for (const input of fixture.inputs) refs.push(input.file);
  refs.push(...golden.approved_source_inputs);
  for (const profile of golden.profiles) refs.push(profile.before, profile.after, profile.unrelated_configuration, profile.call_evidence);
  for (const call of golden.calls) refs.push(...call.input_refs, call.oracle, call.tool_trace, call.final_answer);
  for (const result of acceptance.results) {
    refs.push(...(result.evidence_files ?? []));
    if (result.input_manifest) refs.push(result.input_manifest);
    if (result.oracle) for (const value of [result.oracle.expected, result.oracle.actual]) if (isReference(value)) refs.push(value);
  }
  for (const ref of refs) {
    if (loaded.digests[ref.path] !== ref.sha256) issues.push(`${ref.path}: reference digest is missing or does not match file-digests.json`);
  }
  for (const call of golden.calls) {
    try {
      const artifacts = await Promise.all([call.oracle, call.tool_trace, call.final_answer].map(ref => safeReadEvidenceFile(runDir, ref.path)));
      if (new Set(artifacts.map(file => file.identity)).size !== 3) issues.push('golden-consumer/manifest.json: Oracle, trace, and answer files must be distinct');
    } catch (error) {
      issues.push(`golden-consumer/manifest.json: artifact identity could not be checked (${error instanceof Error ? error.message : 'read failed'})`);
    }
  }
  for (const result of acceptance.results.filter(item => item.status === 'PASS' && item.oracle)) {
    const expected = result.oracle!.expected, actual = result.oracle!.actual;
    const resolveOracle = async (value: unknown): Promise<{ assertion: unknown; identity?: string }> => {
      if (!isReference(value)) return { assertion: value };
      const file = await safeReadEvidenceFile(runDir, value.path);
      return { assertion: JSON.parse(file.bytes.toString('utf8')), identity: file.identity };
    };
    try {
      const expectedResolved = await resolveOracle(expected);
      const actualResolved = await resolveOracle(actual);
      if (expectedResolved.identity !== undefined && expectedResolved.identity === actualResolved.identity) {
        issues.push(`${result.acceptance_id}: expected and actual Oracle references must be independent`);
      }
      if (!hasConcreteOracle(expectedResolved.assertion) || !hasConcreteOracle(actualResolved.assertion)) {
        issues.push(`${result.acceptance_id}: PASS requires concrete Oracle expected and actual values`);
      }
      if (stable(expectedResolved.assertion) !== stable(actualResolved.assertion)) issues.push(`${result.acceptance_id}: Oracle expected and actual values differ`);
    } catch (error) { issues.push(`${result.acceptance_id}: Oracle reference invalid (${error instanceof Error ? error.message : 'read failed'})`); }
  }
  return { status: issues.length ? 'FAIL' : 'PASS', issues: [...new Set(issues)].sort(), data: d, digests: loaded.digests };
}

/** Checks internal structure and file consistency. A PASS says nothing about real-world approval or runtime identity. */
export async function validateEvidenceStructure(runDir: string): Promise<EvidenceCheckResult> {
  try { const result = await validateBundle(runDir); return { status: result.status, issues: result.issues }; }
  catch (error) { return { status: 'FAIL', issues: [error instanceof Error ? error.message : 'evidence validation failed'] }; }
}

export async function evaluateReleaseGate(runDir: string): Promise<ReleaseGateResult> {
  try {
    const result = await validateBundle(runDir);
    if (result.status !== 'PASS') return { status: result.status, issues: result.issues, product_ready: false };
    const d = result.data!;
    const run = runManifestSchema.parse(d['run.json']);
    const env = (await import('./environment.js')).environmentInputSchema.parse(d['environment-inputs.json']);
    const entry = evaluateM0Entry(d['signoffs.json'], env, { expectedKind: 'site', allowExample: false });
    const controlledPinsRaw = JSON.parse(await readFile(controlledPinsPath(), 'utf8')) as unknown;
    const controlledPins = upstreamPinsFileSchema.parse(controlledPinsRaw);
    const embeddedPins = upstreamPinsFileSchema.parse(d['upstream-pins.json']);
    const lock = validateDeploymentLock(d['deployment.lock.json'], controlledPins, { release: true });
    const blocked: string[] = [];
    if (stable(embeddedPins.source_pins) !== stable(controlledPins.source_pins)) blocked.push('upstream-pins.json: source pins do not match the repository-controlled approved pins');
    if (run.kind !== 'observed') blocked.push('run.json: release requires an observed run');
    if (entry.status !== 'PASS') blocked.push(...entry.missing.map(item => `M0 entry: ${item}`));
    if (lock.status !== 'PASS') blocked.push(...lock.issues.map(item => `deployment.lock.json: ${item}`));
    blocked.push(...nonrealAuthorityIssues(d));
    if (d['source-contracts.json'].input_kind !== 'real' || d['fixture-manifest.json'].input_kind !== 'real' || d['golden-consumer/manifest.json'].input_kind !== 'real') blocked.push('source, fixture, and Golden Consumer inputs must be approved real inputs');
    if (d['acceptance-results.json'].results.some((item: any) => item.status !== 'PASS')) blocked.push('all 48 canonical acceptance results must be PASS');
    if (blocked.length) return { status: 'BLOCKED', product_ready: false, issues: [...new Set(blocked)].sort() };
    return { status: 'PASS', product_ready: true, issues: [] };
  } catch (error) { return { status: 'FAIL', product_ready: false, issues: [error instanceof Error ? error.message : 'evidence validation failed'] }; }
}
