import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const execFile = promisify(execFileCallback);
const IMAGE_REFERENCE = 'postgres:16.10-alpine';
const START_TIMEOUT_MS = 75_000;
type DockerCommand = (args: string[], stage: string, timeout?: number) => Promise<string>;
export type OwnedTaskLabel = 'task0' | 'task1';

type SafeFailure = 'docker_unavailable' | 'image_unavailable' | 'startup_failed' | 'readiness_timeout' | 'pool_unavailable';

export class OwnedPostgresError extends Error {
  constructor(readonly code: string, readonly stage: string, readonly safeReason: SafeFailure) {
    super(`${code} at ${stage}: ${safeReason}`);
    this.name = 'OwnedPostgresError';
  }
}

export type OwnedPostgres = {
  pool: pg.Pool;
  taskLabel: OwnedTaskLabel;
  runLabel: string;
  containerId: string;
  imageReference: string;
  repoDigest: string;
  runtimeImageId: string;
  hostPort: number;
  close(): Promise<void>;
};

function classifyDockerFailure(stage: string, stderr = ''): SafeFailure {
  const text = stderr.toLowerCase();
  if (text.includes('cannot connect') || text.includes('is the docker daemon running') || text.includes('error during connect')) return 'docker_unavailable';
  if (stage.includes('image') || text.includes('manifest unknown') || text.includes('pull access denied')) return 'image_unavailable';
  return 'startup_failed';
}

async function docker(args: string[], stage: string, timeout = 20_000): Promise<string> {
  try {
    const { stdout } = await execFile('docker', args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    throw new OwnedPostgresError('OWNED_POSTGRES_COMMAND_FAILED', stage, classifyDockerFailure(stage, stderr));
  }
}

async function containerIsAbsent(command: DockerCommand, containerId: string): Promise<boolean> {
  const remaining = await command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`], 'cleanup_verification');
  return remaining === '';
}

async function appendEvidence(path: string, event: Record<string, string | number | boolean>): Promise<void> {
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

export async function startOwnedPostgres(options: { evidenceFile: string; taskLabel?: OwnedTaskLabel }, command: DockerCommand = docker): Promise<OwnedPostgres> {
  const runLabel = randomUUID();
  const taskLabel = options.taskLabel ?? 'task0';
  const tempDirectory = await mkdtemp(join(tmpdir(), 'dgo-m0-pg-'));
  const cidFile = join(tempDirectory, 'container.cid');
  let containerId: string | undefined;
  let pool: pg.Pool | undefined;

  try {
    try {
      await command([
        'run', '--detach', '--cidfile', cidFile, '--name', `dgo-m0-${runLabel}`,
        '--label', `codex.m0.task=${taskLabel}`, '--label', `codex.m0.run=${runLabel}`,
        '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,size=268435456',
        '--env', 'POSTGRES_USER=postgres', '--env', 'POSTGRES_DB=postgres', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
        IMAGE_REFERENCE,
      ], 'container_start', START_TIMEOUT_MS);
    } catch (error) { throw error; }

    containerId = (await readFile(cidFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/i.test(containerId)) throw new OwnedPostgresError('OWNED_POSTGRES_ID_INVALID', 'record_created_resource', 'startup_failed');
    await appendEvidence(options.evidenceFile, { event: 'created', taskLabel, runLabel, containerId, imageReference: IMAGE_REFERENCE });

    const inspectRaw = await command(['inspect', '--format', '{{.Config.Image}}|{{.Image}}|{{json .Mounts}}', containerId], 'container_metadata');
    const [imageReference, runtimeImageId, mountJson] = inspectRaw.split('|');
    if (imageReference !== IMAGE_REFERENCE || !/^sha256:[a-f0-9]{64}$/i.test(runtimeImageId)) {
      throw new OwnedPostgresError('OWNED_POSTGRES_IMAGE_IDENTITY_INVALID', 'container_metadata', 'startup_failed');
    }
    const mounts = JSON.parse(mountJson) as Array<{ Type: string; Destination: string }>;
    if (mounts.some(mount => mount.Type !== 'tmpfs' || mount.Destination !== '/var/lib/postgresql/data')) {
      throw new OwnedPostgresError('OWNED_POSTGRES_STORAGE_NOT_ISOLATED', 'container_metadata', 'startup_failed');
    }

    const repoDigestsRaw = await command(['image', 'inspect', '--format', '{{json .RepoDigests}}', IMAGE_REFERENCE], 'image_metadata');
    const repoDigests = JSON.parse(repoDigestsRaw) as string[] | null;
    const repoDigest = repoDigests?.find(value => value.startsWith('postgres@sha256:'));
    if (!repoDigest || !/^postgres@sha256:[a-f0-9]{64}$/i.test(repoDigest)) {
      throw new OwnedPostgresError('OWNED_POSTGRES_REPO_DIGEST_MISSING', 'image_metadata', 'image_unavailable');
    }
    await appendEvidence(options.evidenceFile, { event: 'image_observed', runLabel, containerId, imageReference, repoDigest, runtimeImageId });

    const readyBy = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < readyBy) {
      try {
        await command(['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], 'readiness_check', 5_000);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (Date.now() >= readyBy) throw new OwnedPostgresError('OWNED_POSTGRES_READINESS_TIMEOUT', 'readiness', 'readiness_timeout');

    const portText = await command(['port', containerId, '5432/tcp'], 'port_discovery');
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portText);
    if (!portMatch) throw new OwnedPostgresError('OWNED_POSTGRES_PORT_INVALID', 'port_discovery', 'startup_failed');
    const hostPort = Number(portMatch[1]);
    pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${hostPort}/postgres`, max: 8, connectionTimeoutMillis: 3_000 });
    try {
      await pool.query('SELECT 1');
    } catch {
      throw new OwnedPostgresError('OWNED_POSTGRES_POOL_UNAVAILABLE', 'pool_check', 'pool_unavailable');
    }

    const ownedPool = pool;
    return {
      pool: ownedPool,
      taskLabel,
      runLabel,
      containerId,
      imageReference,
      repoDigest,
      runtimeImageId,
      hostPort,
      async close() {
        await ownedPool.end();
        let ownershipConfirmed = false;
        let containerAbsentAfterRemoval = false;
        try {
          ownershipConfirmed = await inspectOwnedContainerWith(command, containerId!, runLabel, taskLabel);
          if (!ownershipConfirmed) throw new OwnedPostgresError('OWNED_POSTGRES_OWNERSHIP_UNCONFIRMED', 'cleanup', 'startup_failed');
          await command(['rm', '--force', containerId!], 'owned_container_removal');
          containerAbsentAfterRemoval = await containerIsAbsent(command, containerId!);
          if (!containerAbsentAfterRemoval) throw new OwnedPostgresError('OWNED_POSTGRES_CLEANUP_INCOMPLETE', 'cleanup_verification', 'startup_failed');
          await appendEvidence(options.evidenceFile, { event: 'removed', taskLabel, runLabel, containerId: containerId!, ownershipConfirmed: true, containerAbsentAfterRemoval: true });
          await rm(tempDirectory, { recursive: true, force: true });
        } catch (error) {
          await appendEvidence(options.evidenceFile, {
            event: 'cleanup_unconfirmed', taskLabel, runLabel, containerId: containerId!, cidFile,
            ownershipConfirmed, containerAbsentAfterRemoval,
          }).catch(() => undefined);
          throw error;
        }
      },
    };
  } catch (error) {
    if (pool) await pool.end().catch(() => undefined);
    if (!containerId) {
      try {
        const candidate = (await readFile(cidFile, 'utf8')).trim();
        if (/^[a-f0-9]{64}$/.test(candidate)) {
          containerId = candidate;
          await appendEvidence(options.evidenceFile, { event: 'created', taskLabel, runLabel, containerId, imageReference: IMAGE_REFERENCE, recoveredFromCidFile: true });
        }
      } catch { /* Keep the cidfile directory if resource identity cannot be recovered. */ }
    }
    let cleanupConfirmed = false;
    let ownershipConfirmed = false;
    if (containerId) {
      ownershipConfirmed = await inspectOwnedContainerWith(command, containerId, runLabel, taskLabel);
      if (ownershipConfirmed) {
        try {
          await command(['rm', '--force', containerId], 'failed_start_cleanup');
          cleanupConfirmed = await containerIsAbsent(command, containerId);
        } catch { cleanupConfirmed = false; }
      }
      if (cleanupConfirmed) {
        try {
          await appendEvidence(options.evidenceFile, { event: 'removed_after_start_failure', taskLabel, runLabel, containerId, ownershipConfirmed: true, containerAbsentAfterRemoval: true });
          await rm(tempDirectory, { recursive: true, force: true });
        } catch { /* Retain the cidfile directory when lifecycle evidence cannot be completed. */ }
      } else {
        await appendEvidence(options.evidenceFile, {
          event: 'cleanup_unconfirmed', taskLabel, runLabel, containerId, cidFile, ownershipConfirmed,
          containerAbsentAfterRemoval: false,
        }).catch(() => undefined);
      }
    } else {
      await appendEvidence(options.evidenceFile, { event: 'start_failure_unresolved', taskLabel, runLabel, cidFile }).catch(() => undefined);
    }
    throw error;
  }
}

async function inspectOwnedContainerWith(command: DockerCommand, containerId: string, runLabel: string, expectedTaskLabel: OwnedTaskLabel): Promise<boolean> {
  try {
    const raw = await command(['inspect', '--format', '{{.Id}}|{{index .Config.Labels "codex.m0.task"}}|{{index .Config.Labels "codex.m0.run"}}', containerId], 'ownership_check');
    const [id, actualTaskLabel, run] = raw.split('|');
    return id === containerId && actualTaskLabel === expectedTaskLabel && run === runLabel;
  } catch { return false; }
}
