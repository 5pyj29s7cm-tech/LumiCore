import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { selfImprovementGitArgs, selfImprovementGitEnvironment, type SelfImprovementRepositoryIdentity } from "../repository_identity";
import type { CommandRunner, CommandResult, GitBlobEntry } from './contracts';
import { runChecked } from './command';
import { normalizeRepositoryPath, assertExactPathSet } from './patch_policy';
import { digest } from './identity';
import { listPlainStageFiles, assertWithin } from './filesystem_boundary';

export function gitBlobObjectId(content: Buffer, objectFormat: string): string {
  const algorithm = objectFormat === 'sha256' ? 'sha256' : 'sha1';
  return crypto.createHash(algorithm)
    .update(Buffer.from(`blob ${content.length}\0`, 'utf8'))
    .update(content)
    .digest('hex');
}

export function makeRestrictedGitContext(parent: string): { hooksPath: string; env: NodeJS.ProcessEnv } {
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Restricted Git context requires a plain trusted directory.');
  }
  const hooksPath = fs.mkdtempSync(path.join(parent, '.empty-hooks-'));
  const hooksStat = fs.lstatSync(hooksPath);
  if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) {
    throw new Error('Restricted Git hooks directory is not a plain directory.');
  }
  return { hooksPath, env: selfImprovementGitEnvironment() };
}

export async function runRestrictedGit(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
  args: string[],
  cwd = repository.root,
  timeoutMs = 60_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return runChecked(
    runner,
    'git',
    selfImprovementGitArgs(args, gitContext.hooksPath),
    cwd,
    timeoutMs,
    { ...gitContext.env, ...(extraEnv || {}) },
  );
}

export async function runRestrictedGitProbe(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
  args: string[],
  cwd = repository.root,
  timeoutMs = 30_000,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return runner(
    'git',
    selfImprovementGitArgs(args, gitContext.hooksPath),
    cwd,
    timeoutMs,
    { ...gitContext.env, ...(extraEnv || {}) },
  );
}

export function parseLsTreeEntries(output: string): GitBlobEntry[] {
  return String(output || '').split('\0').filter(Boolean).map(record => {
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/i.exec(record);
    if (!match) throw new Error('Git returned an invalid tree entry during self-improvement verification.');
    const file = normalizeRepositoryPath(match[4]);
    if (!file) throw new Error('Git returned an unsafe repository path during self-improvement verification.');
    return { mode: match[1], type: match[2], objectId: match[3], path: file };
  });
}

export async function exactCommitManifest(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
  commit: string,
  changedPaths: string[],
): Promise<{ entries: GitBlobEntry[]; digest: string }> {
  const entries = parseLsTreeEntries((await runRestrictedGit(
    runner,
    repository,
    gitContext,
    ['ls-tree', '-z', commit, '--', ...changedPaths],
  )).stdout);
  assertExactPathSet(entries.map(entry => entry.path), changedPaths, 'Committed self-improvement tree');
  for (const entry of entries) {
    if (entry.mode !== '100644' || entry.type !== 'blob') {
      throw new Error(`Self-improvement documentation must be a regular 100644 blob: ${entry.path}.`);
    }
  }
  return {
    entries,
    digest: digest(entries.slice().sort((a, b) => a.path.localeCompare(b.path))
      .map(entry => `${entry.path}\0${entry.mode}\0${entry.objectId}`).join('\n')),
  };
}

export async function assertNoGitContentTransforms(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
  changedPaths: string[],
): Promise<void> {
  const result = await runRestrictedGit(
    runner,
    repository,
    gitContext,
    [
      'check-attr', '-z', '--cached',
      'filter', 'working-tree-encoding', 'ident', 'eol', 'text',
      '--', ...changedPaths,
    ],
  );
  const parts = result.stdout.split('\0').filter(Boolean);
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const [file, attribute, value] = parts.slice(index, index + 3);
    if (value !== 'unspecified' && value !== 'unset') {
      throw new Error(`Git content-transform attribute ${attribute} is forbidden for self-improvement documentation: ${file}.`);
    }
  }
}

export async function assertNoRepositoryGitContentDrivers(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  const configured = await runRestrictedGitProbe(
    runner,
    repository,
    gitContext,
    ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
  );
  if (configured.exitCode === 0 && configured.stdout.trim()) {
    throw new Error('Repository Git content filter drivers are forbidden during self-improvement staging and activation.');
  }
  if (configured.exitCode !== 0 && configured.exitCode !== 1) {
    throw new Error('Repository Git content filter configuration could not be verified safely.');
  }
}

export async function assertStageFilesMatchCommit(
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: { hooksPath: string; env: NodeJS.ProcessEnv },
  stageRoot: string,
  entries: GitBlobEntry[],
): Promise<void> {
  assertExactPathSet(listPlainStageFiles(stageRoot), entries.map(entry => entry.path), 'Static staging directory');
  for (const entry of entries) {
    const absolute = path.resolve(stageRoot, ...entry.path.split('/'));
    assertWithin(stageRoot, absolute);
    const objectId = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['hash-object', '--no-filters', '--', absolute],
    )).stdout.trim();
    if (objectId !== entry.objectId) {
      throw new Error(`Static staging content no longer matches the verified commit: ${entry.path}.`);
    }
  }
}

export async function cleanupFailedWorktree(
  runner: CommandRunner,
  repoRoot: string,
  worktreePath: string,
  branch: string,
  branchCreated: boolean,
): Promise<void> {
  try { await runner('git', ['worktree', 'remove', '--force', worktreePath], repoRoot, 60_000); } catch {}
  if (branchCreated) {
    try { await runner('git', ['branch', '-D', branch], repoRoot, 30_000); } catch {}
  }
  try { await runner('git', ['worktree', 'prune'], repoRoot, 30_000); } catch {}
}
