import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requiredAcceptanceIds } from '../contracts/evidence.js';

const fiOwners: Record<string, string[]> = {
  'FI-01': ['ING'], 'FI-02': ['ING'], 'FI-03': ['DATA'], 'FI-04': ['ETL'], 'FI-05': ['ETL'], 'FI-06': ['POL'],
  'FI-07': ['POL'], 'FI-08': ['POL'], 'FI-09': ['POL', 'OPS'], 'FI-10': ['AUTH', 'API'], 'FI-11': ['GOV', 'ONT'], 'FI-12': ['OBS'],
};

export type LocalCheck = { id: string; command: string[]; stdout: string; stderr: string; exit_code: number; git_sha?: string; image_digests?: Record<string, string> };
export type LocalCheckRunner = (command: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>;

const allowlist = [
  { id: 'typecheck', command: ['run', 'typecheck'] },
  { id: 'test', command: ['test'] },
  { id: 'build', command: ['run', 'build'] },
] as const;

function digest(bytes: string | Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function platformNpmInvocation(command: readonly string[], platform: NodeJS.Platform = process.platform): { executable: string; args: string[] } {
  return platform === 'win32'
    ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', `npm ${command.join(' ')}`] }
    : { executable: 'npm', args: [...command] };
}
function reqs(id: string): string[] {
  if (id.startsWith('FI-')) return (fiOwners[id] ?? []).map(owner => `REQ-${owner}-001`);
  return [`REQ-${id.split('-')[1]}-001`];
}
function spawnRunner(command: string[], cwd: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return new Promise((resolveResult, reject) => {
    // Windows .cmd entry points must run through cmd.exe. `command` comes only from the fixed allowlist above.
    const invocation = platformNpmInvocation(command);
    const child = spawn(invocation.executable, invocation.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ stdout, stderr, exit_code: code ?? 1 }));
  });
}
async function gitSha(cwd: string): Promise<string> {
  const result = await new Promise<{ stdout: string; code: number }>((resolveResult, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ stdout: stdout.trim(), code: code ?? 1 }));
  });
  if (result.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.stdout)) throw new Error('could not capture hub git SHA');
  return result.stdout;
}
async function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveResult(stdout) : reject(new Error(`git ${args[0]} failed`)));
  });
}
export async function worktreeSnapshot(cwd: string, sourceSha: string): Promise<{ bytes: string; dirty: boolean }> {
  const root = (await gitOutput(['rev-parse', '--show-toplevel'], cwd)).trim();
  const tracked = (await gitOutput(['diff', '--name-only', '-z', '--diff-filter=ACMRD', 'HEAD'], root)).split('\0').filter(Boolean);
  const untracked = (await gitOutput(['ls-files', '--others', '--exclude-standard', '-z'], root)).split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].filter(path => {
    const normalized = path.replace(/\\/g, '/');
    return !normalized.split('/').some(segment => segment.toLowerCase() === '.env' || segment === 'node_modules' || segment === 'dist' || segment === 'deliverables');
  }).sort();
  const files: Array<{ path: string; sha256: string }> = [];
  const unavailable: string[] = [];
  for (const path of paths) {
    try {
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink() || !info.isFile()) { unavailable.push(`${path}:non_regular`); continue; }
      files.push({ path, sha256: digest(await readFile(join(root, path))) });
    } catch { unavailable.push(`${path}:missing`); }
  }
  return { dirty: paths.length > 0, bytes: JSON.stringify({ schema_version: 'alpha1.v1', git_sha: sourceSha, dirty: paths.length > 0, files, unavailable_paths: unavailable }, null, 2) + '\n' };
}

export async function recordLocalChecks(options: { outputParent: string; runId: string }, runner: LocalCheckRunner = spawnRunner): Promise<{ runDir: string; status: 'PASS' | 'FAIL'; product_ready: false; check_results: LocalCheck[] }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.runId)) throw new Error('run-id must be a safe 1-64 character identifier');
  if (!options.outputParent.trim()) throw new Error('output-parent is required');
  const outputParent = resolve(options.outputParent);
  await mkdir(outputParent, { recursive: true });
  const sourceSha = await gitSha(process.cwd());
  const runDir = join(outputParent, options.runId);
  // mkdir without recursive is the exclusive create; prior evidence is never overwritten.
  await mkdir(runDir);
  const capturedAt = new Date().toISOString();
  const acceptanceResults = {
    schema_version: 'alpha1.v1', run_id: options.runId,
    results: requiredAcceptanceIds.map(acceptance_id => ({ acceptance_id, requirement_ids: reqs(acceptance_id), status: 'NOT_RUN' })),
  };
  await writeJson(join(runDir, 'run.json'), { schema_version: 'alpha1.v1', run_id: options.runId, kind: 'local_check', git_sha: sourceSha, captured_at: capturedAt, image_digests: {} });
  await writeJson(join(runDir, 'acceptance-results.json'), acceptanceResults);
  const worktree = await worktreeSnapshot(process.cwd(), sourceSha);
  await writeFile(join(runDir, 'worktree-manifest.json'), worktree.bytes, { flag: 'wx' });
  const checkResults: LocalCheck[] = [];
  for (const check of allowlist) {
    const result = await runner([...check.command], process.cwd());
    const base = `local-checks/${check.id}`;
    const stdout = Buffer.from(result.stdout, 'utf8'), stderr = Buffer.from(result.stderr, 'utf8');
    await mkdir(join(runDir, 'local-checks'), { recursive: true });
    await writeFile(join(runDir, `${base}.stdout.log`), stdout, { flag: 'wx' });
    await writeFile(join(runDir, `${base}.stderr.log`), stderr, { flag: 'wx' });
    checkResults.push({ id: check.id, command: ['npm', ...check.command], stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code, git_sha: sourceSha, image_digests: {} });
  }
  await writeJson(join(runDir, 'check-results.json'), {
    schema_version: 'alpha1.v1', run_id: options.runId, git_sha: sourceSha, image_digests: {}, worktree: { path: 'worktree-manifest.json', sha256: digest(worktree.bytes) }, checks: checkResults.map((check, index) => ({
      id: check.id, command: check.command, exit_code: check.exit_code,
      stdout: { path: `local-checks/${check.id}.stdout.log`, sha256: digest(check.stdout) },
      stderr: { path: `local-checks/${check.id}.stderr.log`, sha256: digest(check.stderr) },
    })),
  });
  const files = await listFiles(runDir);
  const fileDigests: Record<string, string> = {};
  for (const path of files) fileDigests[path] = digest(await readFile(join(runDir, path)));
  await writeJson(join(runDir, 'file-digests.json'), fileDigests);
  return { runDir, status: checkResults.every(check => check.exit_code === 0) ? 'PASS' : 'FAIL', product_ready: false, check_results: checkResults };
}

async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.filter(path => path !== 'file-digests.json').sort();
}

type CliResult = { status: 'PASS' | 'FAIL' | 'BLOCKED'; product_ready: false; run_dir?: string; error?: string };
export async function runRecordLocalChecks(argv: string[], runner: LocalCheckRunner = spawnRunner): Promise<{ result: CliResult; exitCode: number }> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag !== '--output-parent' && flag !== '--run-id') || !argv[i + 1] || options[flag]) return { result: { status: 'FAIL', product_ready: false, error: 'usage: --output-parent <path> --run-id <safe-id>' }, exitCode: 1 };
    options[flag] = argv[++i]!;
  }
  if (!options['--output-parent'] || !options['--run-id']) return { result: { status: 'FAIL', product_ready: false, error: 'usage: --output-parent <path> --run-id <safe-id>' }, exitCode: 1 };
  try {
    const recorded = await recordLocalChecks({ outputParent: options['--output-parent'], runId: options['--run-id'] }, runner);
    return { result: { status: recorded.status, product_ready: false, run_dir: recorded.runDir }, exitCode: recorded.status === 'PASS' ? 0 : 2 };
  } catch (error) {
    return { result: { status: 'FAIL', product_ready: false, error: error instanceof Error ? error.message : 'local checks could not be recorded' }, exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { result, exitCode } = await runRecordLocalChecks(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
