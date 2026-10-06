import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SelfImprovementProposal } from "../improvement_program";
import type { SelfImprovementRepositoryIdentity } from "../repository_identity";
import { digest, safeBranchId } from './identity';
import { normalizeRepositoryPath } from './patch_policy';

export function snapshotReviewedFiles(worktreePath: string, reviewedPaths: string[]): string {
  const snapshot = reviewedPaths.slice().sort().map(file => {
    const absolute = path.resolve(worktreePath, ...file.split('/'));
    assertWithin(worktreePath, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Reviewed self-improvement path must remain a regular file: ${file}.`);
    }
    return `${file}\0${stat.mode}\0${stat.size}\0${digest(fs.readFileSync(absolute))}`;
  });
  return digest(snapshot.join('\n'));
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function ensureUnlinkedDirectoryChain(directory: string, createMissing = true): string {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (!createMissing) throw new Error(`Self-improvement staging directory is missing: ${current}.`);
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Self-improvement staging ancestor must be a real directory, not a link or reparse target: ${current}.`);
    }
  }
  return fs.realpathSync.native(resolved);
}

export function ensureTrustedStagingParent(
  directory: string,
  repository: SelfImprovementRepositoryIdentity,
  createMissing = true,
): string {
  const resolved = path.resolve(directory);
  if (sameFilesystemPath(resolved, repository.root) || pathIsWithin(repository.root, resolved)) {
    throw new Error('Self-improvement staging parent must remain outside the live repository.');
  }
  const real = ensureUnlinkedDirectoryChain(resolved, createMissing);
  const realRepository = fs.realpathSync.native(repository.root);
  if (sameFilesystemPath(real, realRepository) || pathIsWithin(realRepository, real)) {
    throw new Error('Self-improvement staging parent resolved inside the live repository.');
  }
  return real;
}

export function listPlainStageFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are forbidden in self-improvement staging.');
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const relative = normalizeRepositoryPath(path.relative(root, absolute));
        if (!relative) throw new Error('Self-improvement staging produced an unsafe path.');
        files.push(relative);
      } else {
        throw new Error('Only regular files are allowed in self-improvement staging.');
      }
    }
  };
  walk(root);
  return files.sort();
}

export function assertWithin(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Self-improvement worktree path escaped its dedicated parent.');
  }
}

export function sameResolvedPath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  };
  const normalizedLeft = canonical(left);
  const normalizedRight = canonical(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function registeredWorktrees(porcelain: string): Array<{ path: string; head: string; branch: string }> {
  return String(porcelain || '')
    .split(/\r?\n\r?\n/)
    .map(block => {
      const lines = block.split(/\r?\n/);
      return {
        path: lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length).trim() || '',
        head: lines.find(line => line.startsWith('HEAD '))?.slice('HEAD '.length).trim() || '',
        branch: lines.find(line => line.startsWith('branch '))?.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || '',
      };
    })
    .filter(item => Boolean(item.path));
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function assertSafePlainStageRoot(
  stageRoot: string,
  proposal: SelfImprovementProposal,
  repository: SelfImprovementRepositoryIdentity,
): string {
  const resolved = path.resolve(stageRoot);
  const sessionRoot = path.dirname(resolved);
  const parent = path.dirname(sessionRoot);
  if (
    path.basename(resolved) !== 'content'
    || !path.basename(sessionRoot).startsWith(`${safeBranchId(proposal.id)}-`)
    || pathIsWithin(repository.root, resolved)
    || sameResolvedPath(resolved, path.parse(resolved).root)
    || sameResolvedPath(resolved, os.homedir())
  ) {
    throw new Error('Persisted self-improvement staging directory is not a safe isolated cleanup target.');
  }
  const trustedParent = ensureTrustedStagingParent(parent, repository, false);
  const realSessionRoot = ensureUnlinkedDirectoryChain(sessionRoot, false);
  const realContentRoot = ensureUnlinkedDirectoryChain(resolved, false);
  if (
    !sameFilesystemPath(path.dirname(realSessionRoot), trustedParent)
    || !sameFilesystemPath(path.dirname(realContentRoot), realSessionRoot)
    || pathIsWithin(repository.root, realSessionRoot)
  ) {
    throw new Error('Persisted self-improvement staging directory changed identity.');
  }
  const sessionStat = fs.lstatSync(sessionRoot);
  const stat = fs.lstatSync(resolved);
  if (
    !sessionStat.isDirectory()
    || sessionStat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.isSymbolicLink()
  ) {
    throw new Error('Persisted self-improvement staging path is not a regular directory.');
  }
  return realSessionRoot;
}
