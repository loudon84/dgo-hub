import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreeSnapshot } from '../scripts/record-local-checks.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe('local-check worktree metadata', () => {
  it('hashes dirty tracked and untracked Chinese paths and records a deleted path as unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'alpha1-recorder-git-'));
    const docs = join(root, 'docs');
    await mkdir(docs);
    await writeFile(join(docs, '变更说明.md'), 'before\n');
    await writeFile(join(docs, '已删除.md'), 'remove me\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', 'docs/变更说明.md', 'docs/已删除.md'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Alpha Test', '-c', 'user.email=alpha@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    await writeFile(join(docs, '变更说明.md'), 'after\n');
    await writeFile(join(docs, '新增说明.md'), 'new\n');
    await rm(join(docs, '已删除.md'));

    const snapshot = await worktreeSnapshot(root, 'a'.repeat(40));
    const manifest = JSON.parse(snapshot.bytes) as { dirty: boolean; files: Array<{ path: string; sha256: string }>; unavailable_paths: string[] };
    expect(snapshot.dirty).toBe(true);
    expect(manifest.files.map(file => file.path)).toEqual(['docs/变更说明.md', 'docs/新增说明.md']);
    expect(manifest.files.every(file => /^sha256:[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(manifest.unavailable_paths).toEqual(['docs/已删除.md:missing']);
    expect(await readFile(join(docs, '新增说明.md'), 'utf8')).toBe('new\n');
  });
});
