import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node exposes the Windows null device as `\\.\nul`, but Git for Windows
// treats that spelling as a path/URL and aborts before running the command.
// Use the native DOS device spelling for Git configuration values.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : os.devNull;

export interface SelfImprovementRepositoryIdentity {
  repositoryId: string;
  root: string;
  gitCommonDir: string;
  /** Non-reversible identity only. Never persist or expose the raw remote URL. */
  origin: string;
  objectFormat: string;
}

export interface SelfImprovementRepositoryLease {
  path: string;
  token: string;
  release: () => void;
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  const real = fs.realpathSync.native(resolved);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

export function selfImprovementGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

export function selfImprovementGitArgs(args: string[], hooksPath = GIT_NULL_DEVICE): string[] {
  return [
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.pager=cat',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    ...args,
  ];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', selfImprovementGitArgs(args), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2_000_000,
    env: selfImprovementGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function moduleRepositoryCandidate(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function repositoryOriginFingerprint(rawOrigin: string): string {
  const raw = String(rawOrigin || '').trim();
  if (!raw) throw new Error('Trusted self-improvement repository has no origin identity.');

  // Credentials embedded in Git remotes must never enter proposal state, model
  // context, receipts, or errors. Normalize the public repository locator when
  // possible and persist only its non-reversible digest.
  let normalized = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      parsed.hostname = parsed.hostname.toLowerCase();
      normalized = parsed.toString();
    } else {
      const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(raw);
      if (scp) normalized = `ssh://${scp[1].toLowerCase()}/${scp[2]}`;
    }
  } catch {
    // An unusual but valid Git transport is still safe: only its digest leaves
    // this function, and parsing failures never echo the credential-bearing URL.
    normalized = raw;
  }
  return `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

export function resolveTrustedSelfImprovementRepository(
  explicitRoot?: string,
): SelfImprovementRepositoryIdentity {
  const configured = String(explicitRoot || process.env.LUMI_SELF_IMPROVEMENT_REPO_ROOT || '').trim();
  const candidate = path.resolve(configured || moduleRepositoryCandidate());
  const root = canonical(git(candidate, ['rev-parse', '--show-toplevel']));
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('Trusted self-improvement repository is missing package.json.');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageJson?.name !== 'lumi-core') {
    throw new Error('Trusted self-improvement repository marker does not identify LumiCore.');
  }
  const gitCommonDirRaw = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitCommonDir = canonical(gitCommonDirRaw);
  const origin = repositoryOriginFingerprint(git(root, ['config', '--get', 'remote.origin.url']));
  const objectFormat = git(root, ['rev-parse', '--show-object-format']) || 'sha1';
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error(`Unsupported Git object format for self-improvement: ${objectFormat}.`);
  }
  const repositoryId = crypto.createHash('sha256')
    .update([root, gitCommonDir, origin, objectFormat].join('\0'))
    .digest('hex');
  return { repositoryId, root, gitCommonDir, origin, objectFormat };
}

export function sameSelfImprovementRepository(
  expected: Pick<SelfImprovementRepositoryIdentity, 'repositoryId' | 'root' | 'origin' | 'objectFormat'>,
  actual: SelfImprovementRepositoryIdentity,
): boolean {
  try {
    return expected.repositoryId === actual.repositoryId
      && canonical(expected.root) === canonical(actual.root)
      && expected.origin === actual.origin
      && expected.objectFormat === actual.objectFormat;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

/**
 * Serializes authorization revisions and live Git activation across backend
 * processes that share the same repository. A crash-stale lock is reclaimed
 * only when its recorded process no longer exists; malformed locks fail closed.
 */
export function acquireSelfImprovementRepositoryLease(
  repository: SelfImprovementRepositoryIdentity,
  purpose: 'authorization_update' | 'activation',
): SelfImprovementRepositoryLease {
  const lockPath = path.join(repository.gitCommonDir, 'lumi-self-improvement.activation.lock');
  const token = crypto.randomBytes(24).toString('hex');
  const payload = JSON.stringify({
    schemaVersion: 1,
    repositoryId: repository.repositoryId,
    purpose,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        token,
        release: () => {
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (current?.token === token && current?.repositoryId === repository.repositoryId) {
              fs.unlinkSync(lockPath);
            }
          } catch {
            // Never remove a lock whose ownership can no longer be proven.
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      let existing: any;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        throw new Error('Self-improvement repository is locked by an unreadable activation lease.');
      }
      if (
        existing?.repositoryId !== repository.repositoryId
        || !existing?.token
        || !Number.isSafeInteger(existing?.pid)
      ) {
        throw new Error('Self-improvement repository is locked by an invalid activation lease.');
      }
      if (processIsAlive(existing.pid)) {
        throw new Error(`Self-improvement repository is busy with ${existing.purpose || 'another mutation'}.`);
      }
      // Re-read before reclaiming so a replaced live lock is not deleted based
      // on stale contents from the first read.
      const latest = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (latest?.token !== existing.token || processIsAlive(latest?.pid)) {
        throw new Error('Self-improvement repository lease changed while stale-lock recovery was attempted.');
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error('Unable to acquire the self-improvement repository lease.');
}
