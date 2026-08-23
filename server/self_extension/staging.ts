import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  authorizeSelfImprovementActivation,
  authorizeSelfImprovementStage,
  getSelfImprovementProposal,
  isAutonomousSelfImprovementDocumentationPath,
  isSelfImprovementVerificationConfigurationPath,
  recordSelfImprovementActivation,
  recordSelfImprovementStage,
  type SelfImprovementProposal,
  type SelfImprovementScope,
} from './improvement_program';
import {
  acquireSelfImprovementRepositoryLease,
  resolveTrustedSelfImprovementRepository,
  sameSelfImprovementRepository,
  selfImprovementGitArgs,
  selfImprovementGitEnvironment,
  type SelfImprovementRepositoryIdentity,
} from './repository_identity';
import { containsSelfImprovementSecret } from './content_security';

export interface SelfImprovementVerificationReceipt {
  profile: 'targeted' | 'standard' | 'full';
  command: string;
  status: 'passed';
  exitCode: 0;
  durationMs: number;
  outputDigest: string;
  summary: string;
}

export interface SelfImprovementStageResult {
  ok: true;
  status: 'verified';
  persisted: true;
  isolated: true;
  activated: false;
  pushed: false;
  proposal: SelfImprovementProposal;
  baseCommit: string;
  branch: string;
  commit?: string;
  worktreePath: string;
  changedPaths: string[];
  repositoryId?: string;
  treeDigest?: string;
  verification: SelfImprovementVerificationReceipt[];
  replayed?: boolean;
}

export interface SelfImprovementActivationResult {
  ok: true;
  status: 'activated';
  persisted: true;
  activated: true;
  pushed: false;
  proposal: SelfImprovementProposal;
  branch: string;
  baseCommit: string;
  commit: string;
  verification: SelfImprovementVerificationReceipt[];
  cleanup: { worktreeRemoved: boolean; stagingBranchRemoved: boolean };
  replayed?: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;
type VerificationRunner = (
  worktreePath: string,
  profile: 'targeted' | 'standard' | 'full',
  changedPaths: string[],
) => Promise<SelfImprovementVerificationReceipt[]>;

export interface SelfImprovementStagingOptions {
  repoRoot?: string;
  worktreeParent?: string;
  commandRunner?: CommandRunner;
  verificationRunner?: VerificationRunner;
  /** Cooperative cancellation/lease guard supplied by the durable task runtime. */
  isCancelled?: () => boolean;
}

export interface SelfImprovementActivationOptions extends SelfImprovementStagingOptions {
  confirmed?: boolean;
}

// Static autonomous documentation permits files up to 1 MB. Keep enough
// command output to materialize that upper bound, then independently verify
// the exact Git blob id before applying any patch. The hash check below still
// fails closed if this capture limit is ever exceeded.
const MAX_COMMAND_OUTPUT = 1_100_000;
const PATCH_FORBIDDEN = /(?:^|\n)(?:GIT binary patch|Binary files .* differ|Submodule )/m;
const PATCH_RENAME_OR_COPY = /(?:^|\n)(?:rename|copy) (?:from|to) /m;
const PATCH_MODE_CHANGE = /(?:^|\n)(?:old mode |new mode |deleted file mode |new file mode (?!100644(?:\r?$))|index [0-9a-f]+\.\.[0-9a-f]+ 120000(?:\r?$))/m;

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeBranchId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function assertStagingMayContinue(options: SelfImprovementStagingOptions): void {
  if (options.isCancelled?.()) {
    throw new Error('Self-improvement staging stopped because its durable task was cancelled, paused, or lost its execution lease.');
  }
}

function normalizePatchPath(value: string): string {
  const raw = value.trim().split(/\s+/)[0].replace(/^"|"$/g, '').replace(/\\/g, '/');
  if (!raw || raw === '/dev/null') return raw;
  const relative = raw.replace(/^[ab]\//, '').replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || /^[a-z]:\//i.test(relative)) return '';
  const segments = relative.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return '';
  return segments.join('/');
}

export function extractUnifiedPatchPaths(patch: string): string[] {
  if (!String(patch || '').trim()) throw new Error('A non-empty unified patch is required.');
  if (PATCH_FORBIDDEN.test(patch)) throw new Error('Binary and submodule patches are not supported by self-improvement staging.');
  if (PATCH_RENAME_OR_COPY.test(patch)) throw new Error('Rename and copy patches are not supported by self-improvement staging.');
  if (PATCH_MODE_CHANGE.test(patch)) throw new Error('File mode, symlink, gitlink, and type changes are not supported by self-improvement staging.');
  const paths: string[] = [];
  let sourcePath = '';
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      sourcePath = normalizePatchPath(line.slice(4));
      if (!sourcePath) throw new Error('Patch contains an invalid or absolute source path.');
      continue;
    }
    if (!line.startsWith('+++ ')) continue;
    const candidate = normalizePatchPath(line.slice(4));
    if (candidate === '/dev/null') throw new Error('File deletion is not allowed in self-improvement staging.');
    if (!candidate) throw new Error('Patch contains an invalid or absolute target path.');
    if (sourcePath && sourcePath !== '/dev/null' && sourcePath !== candidate) {
      throw new Error('Patch source and target paths differ; rename, copy, and cross-path patches are not allowed.');
    }
    paths.push(candidate);
    sourcePath = '';
  }
  const unique = Array.from(new Set(paths));
  if (unique.length === 0) throw new Error('Patch does not contain a valid unified-diff target path.');
  return unique;
}

function normalizeRepositoryPath(value: string): string {
  const candidate = String(value || '').replace(/\\/g, '/');
  if (
    !candidate
    || candidate.startsWith('/')
    || /^[a-z]:\//i.test(candidate)
    || /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(candidate)
  ) return '';
  const segments = candidate.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return '';
  return segments.join('/');
}

function parsePorcelainStatus(output: string): string[] {
  const entries = String(output || '').split('\0').filter(Boolean);
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.length < 4 || entry[2] !== ' ') {
      throw new Error('Self-improvement worktree returned an unrecognized Git status record.');
    }
    const status = entry.slice(0, 2);
    if (/[RC]/.test(status)) {
      throw new Error('Rename and copy changes are not allowed in a self-improvement worktree.');
    }
    const file = normalizeRepositoryPath(entry.slice(3));
    if (!file) throw new Error('Self-improvement worktree contains an invalid repository path.');
    paths.push(file);
  }
  return Array.from(new Set(paths)).sort();
}

function parseNullSeparatedPaths(output: string): string[] {
  return Array.from(new Set(String(output || '')
    .split('\0')
    .map(normalizeRepositoryPath)
    .filter(Boolean)))
    .sort();
}

function assertExactPathSet(actual: string[], expected: string[], phase: string): void {
  const normalizedActual = Array.from(new Set(actual)).sort();
  const normalizedExpected = Array.from(new Set(expected)).sort();
  const unexpected = normalizedActual.filter(file => !normalizedExpected.includes(file));
  const missing = normalizedExpected.filter(file => !normalizedActual.includes(file));
  if (unexpected.length || missing.length) {
    const detail = [
      ...(unexpected.length ? [`unexpected: ${unexpected.join(', ')}`] : []),
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ].join('; ');
    throw new Error(`${phase} paths no longer match the reviewed patch (${detail}).`);
  }
}

async function worktreeChangePaths(runner: CommandRunner, worktreePath: string): Promise<string[]> {
  const status = await runChecked(
    runner,
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
    30_000,
  );
  return parsePorcelainStatus(status.stdout);
}

function snapshotReviewedFiles(worktreePath: string, reviewedPaths: string[]): string {
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

function verifyStaticDocumentation(
  worktreePath: string,
  profile: 'targeted' | 'standard' | 'full',
  changedPaths: string[],
): SelfImprovementVerificationReceipt[] {
  if (!changedPaths.length || changedPaths.some(file => !isAutonomousSelfImprovementDocumentationPath(file))) {
    throw new Error('Autonomous self-improvement may verify only exact static Markdown documentation paths.');
  }
  const contents = changedPaths.map(file => {
    const absolute = path.resolve(worktreePath, ...file.split('/'));
    assertWithin(worktreePath, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
      throw new Error(`Autonomous documentation must remain a regular file under 1 MB: ${file}.`);
    }
    const content = fs.readFileSync(absolute);
    if (content.includes(0) || content.toString('utf8').includes('\uFFFD')) {
      throw new Error(`Autonomous documentation must be valid UTF-8 text without NUL bytes: ${file}.`);
    }
    return `${file}\0${digest(content)}`;
  });
  return [{
    profile,
    command: 'static-markdown-integrity',
    status: 'passed',
    exitCode: 0,
    durationMs: 0,
    outputDigest: digest(contents.sort().join('\n')),
    summary: `static Markdown integrity verified for ${changedPaths.length} reviewed path(s); no project code was executed`,
  }];
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: env || process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (current: string, chunk: unknown) => (
      `${current}${String(chunk || '')}`.slice(-MAX_COMMAND_OUTPUT)
    );
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

function gitBlobObjectId(content: Buffer, objectFormat: string): string {
  const algorithm = objectFormat === 'sha256' ? 'sha256' : 'sha1';
  return crypto.createHash(algorithm)
    .update(Buffer.from(`blob ${content.length}\0`, 'utf8'))
    .update(content)
    .digest('hex');
}

async function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runner(command, args, cwd, timeoutMs, env);
  if (result.exitCode !== 0) {
    const detail = `${result.stderr || result.stdout}`.replace(/\s+/g, ' ').trim().slice(0, 900);
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed with exit ${result.exitCode}: ${detail}`);
  }
  return result;
}

function repositoryIdentityFromProposal(proposal: SelfImprovementProposal) {
  if (
    !proposal.repositoryId
    || !proposal.repositoryRoot
    || !proposal.repositoryOrigin
    || !proposal.repositoryObjectFormat
  ) {
    throw new Error('Self-improvement proposal is missing its trusted repository identity.');
  }
  return {
    repositoryId: proposal.repositoryId,
    root: proposal.repositoryRoot,
    origin: proposal.repositoryOrigin,
    objectFormat: proposal.repositoryObjectFormat,
  };
}

function resolveBoundRepository(
  proposal: SelfImprovementProposal,
  options: SelfImprovementStagingOptions,
): SelfImprovementRepositoryIdentity {
  const explicitRoot = options.repoRoot && (
    process.env.NODE_ENV === 'test'
    || Boolean(options.commandRunner)
    || Boolean(options.verificationRunner)
  ) ? options.repoRoot : undefined;
  const repository = resolveTrustedSelfImprovementRepository(explicitRoot);
  if (!sameSelfImprovementRepository(repositoryIdentityFromProposal(proposal), repository)) {
    throw new Error('The active repository does not match the repository identity persisted with this proposal.');
  }
  return repository;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ensureUnlinkedDirectoryChain(directory: string, createMissing = true): string {
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

function ensureTrustedStagingParent(
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

function makeRestrictedGitContext(parent: string): { hooksPath: string; env: NodeJS.ProcessEnv } {
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

async function runRestrictedGit(
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

async function runRestrictedGitProbe(
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

interface GitBlobEntry {
  path: string;
  mode: string;
  type: string;
  objectId: string;
}

function parseLsTreeEntries(output: string): GitBlobEntry[] {
  return String(output || '').split('\0').filter(Boolean).map(record => {
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/i.exec(record);
    if (!match) throw new Error('Git returned an invalid tree entry during self-improvement verification.');
    const file = normalizeRepositoryPath(match[4]);
    if (!file) throw new Error('Git returned an unsafe repository path during self-improvement verification.');
    return { mode: match[1], type: match[2], objectId: match[3], path: file };
  });
}

async function exactCommitManifest(
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

async function assertNoGitContentTransforms(
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

async function assertNoRepositoryGitContentDrivers(
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

function listPlainStageFiles(root: string): string[] {
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

function assertStaticDocumentationContent(stageRoot: string, changedPaths: string[]): void {
  for (const file of changedPaths) {
    const absolute = path.resolve(stageRoot, ...file.split('/'));
    assertWithin(stageRoot, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
      throw new Error(`Autonomous documentation must remain a regular file under 1 MB: ${file}.`);
    }
    const content = fs.readFileSync(absolute);
    const text = content.toString('utf8');
    if (content.includes(0) || text.includes('\uFFFD')) {
      throw new Error(`Autonomous documentation must be valid UTF-8 text without NUL bytes: ${file}.`);
    }
    if (containsSelfImprovementSecret(text)) {
      throw new Error(`Autonomous documentation appears to contain credential or private-key material: ${file}.`);
    }
  }
}

async function assertStageFilesMatchCommit(
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

function assertWithin(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Self-improvement worktree path escaped its dedicated parent.');
  }
}

async function cleanupFailedWorktree(
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

async function stageAutonomousStaticDocumentation(input: {
  scope: SelfImprovementScope;
  program: ReturnType<typeof authorizeSelfImprovementStage>['program'];
  proposal: SelfImprovementProposal;
  patchText: string;
  patchDigest: string;
  changedPaths: string[];
  profile: 'targeted' | 'standard' | 'full';
  baseCommit: string;
  deliveryBranch: string;
  repository: SelfImprovementRepositoryIdentity;
  runner: CommandRunner;
  options: SelfImprovementStagingOptions;
  commitMessage?: string;
}): Promise<SelfImprovementStageResult> {
  const {
    scope, program, proposal, patchText, patchDigest, changedPaths, profile,
    baseCommit, deliveryBranch, repository, runner, options,
  } = input;
  assertStagingMayContinue(options);
  if (!program.allowLocalCommit) {
    throw new Error('Autonomous documentation staging requires an isolated local commit receipt.');
  }
  const requestedParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
  const worktreeParent = ensureTrustedStagingParent(requestedParent, repository);
  const sessionRoot = fs.mkdtempSync(path.join(worktreeParent, `${safeBranchId(proposal.id)}-`));
  assertWithin(worktreeParent, sessionRoot);
  ensureUnlinkedDirectoryChain(sessionRoot, false);
  const stageRoot = path.join(sessionRoot, 'content');
  fs.mkdirSync(stageRoot, { recursive: false, mode: 0o700 });
  ensureUnlinkedDirectoryChain(stageRoot, false);
  const patchPath = path.join(sessionRoot, 'reviewed.patch');
  assertWithin(sessionRoot, patchPath);
  fs.writeFileSync(patchPath, patchText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const indexPath = path.join(sessionRoot, 'git.index');
  assertWithin(sessionRoot, indexPath);
  if (fs.existsSync(indexPath)) throw new Error('The isolated self-improvement index already exists.');
  const branch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  const ref = `refs/heads/${branch}`;
  const gitContext = makeRestrictedGitContext(sessionRoot);
  let branchCreated = false;
  let createdCommit = '';
  try {
    const branchProbe = await runRestrictedGitProbe(runner, repository, gitContext, [
      'show-ref', '--verify', '--quiet', ref,
    ]);
    if (branchProbe.exitCode === 0) throw new Error('The isolated self-improvement branch already exists.');
    await assertNoGitContentTransforms(runner, repository, gitContext, changedPaths);

    for (const file of changedPaths) {
      const treeOutput = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['ls-tree', '-z', baseCommit, '--', file],
      )).stdout;
      if (!treeOutput) continue;
      const entries = parseLsTreeEntries(treeOutput);
      if (entries.length !== 1 || entries[0].path !== file || entries[0].mode !== '100644' || entries[0].type !== 'blob') {
        throw new Error(`Existing autonomous documentation must be a regular 100644 Git blob: ${file}.`);
      }
      const content = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['cat-file', 'blob', `${baseCommit}:${file}`],
      )).stdout;
      const contentBuffer = Buffer.from(content, 'utf8');
      if (contentBuffer.length > 1_000_000) {
        throw new Error(`Existing autonomous documentation exceeds the 1 MB static limit: ${file}.`);
      }
      if (gitBlobObjectId(contentBuffer, repository.objectFormat) !== entries[0].objectId) {
        throw new Error(`Materialized autonomous documentation does not match its exact base Git blob: ${file}.`);
      }
      const absolute = path.resolve(stageRoot, ...file.split('/'));
      assertWithin(stageRoot, absolute);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contentBuffer, { flag: 'wx', mode: 0o600 });
    }

    await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['apply', '--check', '--whitespace=error-all', patchPath],
      stageRoot,
    );
    await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['apply', '--whitespace=error-all', patchPath],
      stageRoot,
    );
    fs.rmSync(patchPath, { force: true });
    assertExactPathSet(listPlainStageFiles(stageRoot), changedPaths, 'Applied static documentation patch');
    assertStaticDocumentationContent(stageRoot, changedPaths);
    const verification = verifyStaticDocumentation(stageRoot, profile, changedPaths);

    const indexEnv = { GIT_INDEX_FILE: indexPath };
    await runRestrictedGit(runner, repository, gitContext, ['read-tree', baseCommit], repository.root, 30_000, indexEnv);
    for (const file of changedPaths) {
      const absolute = path.resolve(stageRoot, ...file.split('/'));
      const objectId = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['hash-object', '-w', '--no-filters', '--', absolute],
      )).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error(`Git did not create a valid blob for ${file}.`);
      await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['update-index', '--add', '--cacheinfo', `100644,${objectId},${file}`],
        repository.root,
        30_000,
        indexEnv,
      );
    }
    const tree = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['write-tree'],
      repository.root,
      30_000,
      indexEnv,
    )).stdout.trim();
    const message = `docs: verified self-improvement ${safeBranchId(proposal.id)}`;
    const identityArgs = [
      '-c', 'user.name=Lumi Self-Improvement',
      '-c', 'user.email=lumi-self-improvement@localhost',
      'commit-tree', tree, '-p', baseCommit, '-m', message,
    ];
    const commit = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      identityArgs,
      repository.root,
      60_000,
      indexEnv,
    )).stdout.trim();
    createdCommit = commit;
    const zeroObject = '0'.repeat(repository.objectFormat === 'sha256' ? 64 : 40);
    assertStagingMayContinue(options);
    await runRestrictedGit(runner, repository, gitContext, ['update-ref', ref, commit, zeroObject]);
    branchCreated = true;

    const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['diff', '--no-ext-diff', '--name-only', '-z', baseCommit, commit],
    )).stdout);
    assertExactPathSet(committedPaths, changedPaths, 'Committed self-improvement');
    const manifest = await exactCommitManifest(runner, repository, gitContext, commit, changedPaths);
    await assertStageFilesMatchCommit(runner, repository, gitContext, stageRoot, manifest.entries);
    assertStagingMayContinue(options);
    const persistedProposal = await recordSelfImprovementStage(scope, proposal.id, {
      status: 'verified',
      baseCommit,
      worktreePath: stageRoot,
      branch,
      commit,
      patchDigest,
      treeDigest: manifest.digest,
      stagingProtocol: 'static_git_plumbing_v1',
      deliveryBranch,
      evidence: [
        { kind: 'repository', ref: repository.repositoryId, status: 'bound', summary: `trusted repository origin fingerprint ${repository.origin}` },
        { kind: 'git', ref: branch, status: 'isolated', summary: `plumbing-only branch at base ${baseCommit}` },
        { kind: 'tree', ref: tree, status: 'verified', summary: `exact 100644 documentation tree ${manifest.digest}` },
        ...verification.map(receipt => ({
          kind: 'verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
        })),
        { kind: 'commit', ref: commit, status: 'verified', summary: 'local isolated commit created without checkout, hooks, filters, or signing' },
      ],
    });
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      isolated: true,
      activated: false,
      pushed: false,
      proposal: persistedProposal,
      baseCommit,
      branch,
      commit,
      worktreePath: stageRoot,
      changedPaths,
      repositoryId: repository.repositoryId,
      treeDigest: manifest.digest,
      verification,
    };
  } catch (error) {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    try { fs.rmSync(indexPath, { force: true }); } catch {}
    if (branchCreated) {
      try { await runRestrictedGitProbe(runner, repository, gitContext, ['update-ref', '-d', ref, createdCommit]); } catch {}
    }
    if (fs.existsSync(sessionRoot)) {
      try {
        const safeSessionRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
        fs.rmSync(safeSessionRoot, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  } finally {
    try { fs.rmSync(indexPath, { force: true }); } catch {}
    try {
      const safeSessionRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
      assertWithin(safeSessionRoot, gitContext.hooksPath);
      const hooksStat = fs.lstatSync(gitContext.hooksPath);
      if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) throw new Error('Unsafe restricted hooks cleanup target.');
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}

export async function stageSelfImprovementPatch(
  scope: SelfImprovementScope,
  input: {
    proposalId: string;
    patch: string;
    commitMessage?: string;
    expectedBaseCommit?: string;
    expectedDeliveryBranch?: string;
  },
  options: SelfImprovementStagingOptions = {},
): Promise<SelfImprovementStageResult> {
  assertStagingMayContinue(options);
  const patchText = String(input.patch || '');
  const patchDigest = digest(patchText);
  const authorization = authorizeSelfImprovementStage(scope, String(input.proposalId || ''), {
    reviewedPatchDigest: patchDigest,
  });
  const { program, proposal } = authorization;
  if (proposal.target !== 'core') {
    throw new Error('Variant source staging must run through the variant release train so the correct repository and delivery branch are verified.');
  }
  const unsupportedOperations = proposal.operations.filter(operation => ![
    'code_change',
    'test_change',
    'documentation_change',
    'git_commit',
  ].includes(operation));
  if (unsupportedOperations.length > 0) {
    throw new Error(`Self-improvement staging does not support reviewed high-impact operations: ${unsupportedOperations.join(', ')}.`);
  }
  const patchBytes = Buffer.byteLength(patchText, 'utf8');
  if (patchBytes > program.maxPatchBytes) throw new Error('Patch exceeds the authorized byte budget.');
  const changedPaths = extractUnifiedPatchPaths(patchText);
  const verificationConfigurationPaths = changedPaths.filter(isSelfImprovementVerificationConfigurationPath);
  if (verificationConfigurationPaths.length > 0) {
    throw new Error(`Self-improvement staging cannot modify executable verification or dependency configuration: ${verificationConfigurationPaths.join(', ')}.`);
  }
  const profile = proposal.verificationProfile || 'standard';
  const changedTests = changedPaths.filter(file => /^test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
  if (profile === 'targeted' && proposal.operations.includes('code_change') && changedTests.length === 0) {
    throw new Error('Targeted self-improvement code changes must include an exact changed test path; otherwise use the standard or full verification profile.');
  }
  if (changedPaths.length > program.maxFilesPerChange) throw new Error('Patch exceeds the authorized file budget.');
  const declaredPaths = new Set(proposal.changedPaths || []);
  const unexpected = changedPaths.filter(file => !declaredPaths.has(file));
  const missing = [...declaredPaths].filter(file => !changedPaths.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      ...(unexpected.length > 0 ? [`undeclared: ${unexpected.join(', ')}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ];
    throw new Error(`Patch paths do not exactly match the reviewed proposal (${details.join('; ')}).`);
  }

  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const repoRoot = repository.root;
  const requestedIdentityParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repoRoot), '.lumi-self-improvement', path.basename(repoRoot)));
  const identityParent = ensureTrustedStagingParent(requestedIdentityParent, repository);
  const identityGitContext = makeRestrictedGitContext(identityParent);
  await assertNoRepositoryGitContentDrivers(runner, repository, identityGitContext);
  const baseCommit = (await runRestrictedGit(runner, repository, identityGitContext, ['rev-parse', 'HEAD'])).stdout.trim();
  const deliveryBranch = (await runRestrictedGit(
    runner,
    repository,
    identityGitContext,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  )).stdout.trim();
  if (!deliveryBranch) throw new Error('Self-improvement staging requires a normal checked-out delivery branch.');
  if (input.expectedBaseCommit && input.expectedBaseCommit !== baseCommit) {
    throw new Error('The repository HEAD changed after the self-improvement scope was inspected.');
  }
  if (input.expectedDeliveryBranch && input.expectedDeliveryBranch !== deliveryBranch) {
    throw new Error('The delivery branch changed after the self-improvement scope was inspected.');
  }
  if (authorization.evaluation.decision === 'eligible_supervised' && (
    proposal.reviewedBaseCommit !== baseCommit
    || proposal.reviewedDeliveryBranch !== deliveryBranch
    || proposal.reviewedVerificationProfile !== profile
  )) {
    throw new Error('The supervised patch review is not bound to this exact base commit, delivery branch, and verification profile.');
  }
  const autonomousStaticDocumentation = authorization.evaluation.decision === 'eligible_autonomous';
  if (proposal.status === 'verified' && proposal.worktreePath && proposal.baseCommit) {
    try {
      if (!proposal.stagedPatchDigest || proposal.stagedPatchDigest !== patchDigest) {
        throw new Error('Verified self-improvement replay requires the exact previously staged patch digest.');
      }
      if (!autonomousStaticDocumentation) {
        if (!proposal.stagedCommit || !proposal.stagedBranch) {
          throw new Error('Verified executable self-improvement replay is missing its exact commit identity.');
        }
        const listed = registeredWorktrees((await runChecked(
          runner,
          'git',
          ['worktree', 'list', '--porcelain'],
          repoRoot,
          30_000,
        )).stdout);
        const registered = listed.find(item => sameResolvedPath(item.path, proposal.worktreePath!));
        if (!registered || registered.branch !== proposal.stagedBranch || registered.head !== proposal.stagedCommit) {
          throw new Error('Verified executable self-improvement worktree no longer matches its persisted branch and commit.');
        }
        const status = await worktreeChangePaths(runner, proposal.worktreePath);
        if (status.length > 0) throw new Error('Verified executable self-improvement worktree is no longer clean.');
        return {
          ok: true,
          status: 'verified',
          persisted: true,
          isolated: true,
          activated: false,
          pushed: false,
          proposal,
          baseCommit: proposal.baseCommit,
          branch: proposal.stagedBranch,
          commit: proposal.stagedCommit,
          worktreePath: proposal.worktreePath,
          changedPaths: proposal.changedPaths || [],
          repositoryId: repository.repositoryId,
          verification: (proposal.evidence || [])
            .filter(item => item.kind === 'verification')
            .map(item => ({
              profile: proposal.verificationProfile || 'standard',
              command: item.ref,
              status: 'passed',
              exitCode: 0,
              durationMs: 0,
              outputDigest: '',
              summary: item.summary,
            })),
          replayed: true,
        };
      }
      if (!proposal.stagedCommit || !proposal.stagedBranch || !proposal.stagedTreeDigest) {
        throw new Error('Verified self-improvement replay is missing its exact commit and tree identity.');
      }
      const branchCommit = (await runRestrictedGit(
        runner,
        repository,
        identityGitContext,
        ['rev-parse', `refs/heads/${proposal.stagedBranch}`],
      )).stdout.trim();
      if (branchCommit !== proposal.stagedCommit) throw new Error('Verified self-improvement branch moved after staging.');
      const parent = (await runRestrictedGit(
        runner,
        repository,
        identityGitContext,
        ['rev-parse', `${proposal.stagedCommit}^`],
      )).stdout.trim();
      if (parent !== proposal.baseCommit) throw new Error('Verified self-improvement commit parent no longer matches its base.');
      const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
        runner,
        repository,
        identityGitContext,
        ['diff', '--no-ext-diff', '--name-only', '-z', proposal.baseCommit, proposal.stagedCommit],
      )).stdout);
      assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified replay commit');
      const manifest = await exactCommitManifest(
        runner,
        repository,
        identityGitContext,
        proposal.stagedCommit,
        proposal.changedPaths || [],
      );
      if (manifest.digest !== proposal.stagedTreeDigest) {
        throw new Error('Verified self-improvement tree digest no longer matches the persisted receipt.');
      }
      if (autonomousStaticDocumentation) {
        assertStaticDocumentationContent(proposal.worktreePath, proposal.changedPaths || []);
        await assertStageFilesMatchCommit(
          runner,
          repository,
          identityGitContext,
          proposal.worktreePath,
          manifest.entries,
        );
      }
      return {
        ok: true,
        status: 'verified',
        persisted: true,
        isolated: true,
        activated: false,
        pushed: false,
        proposal,
        baseCommit: proposal.baseCommit,
        branch: proposal.stagedBranch,
        commit: proposal.stagedCommit,
        worktreePath: proposal.worktreePath,
        changedPaths: proposal.changedPaths || [],
        repositoryId: repository.repositoryId,
        treeDigest: manifest.digest,
        verification: (proposal.evidence || [])
          .filter(item => item.kind === 'verification')
          .map(item => ({
            profile: proposal.verificationProfile || 'standard',
            command: item.ref,
            status: 'passed',
            exitCode: 0,
            durationMs: 0,
            outputDigest: '',
            summary: item.summary,
          })),
        replayed: true,
      };
    } finally {
      try {
        assertWithin(identityParent, identityGitContext.hooksPath);
        fs.rmSync(identityGitContext.hooksPath, { recursive: true, force: true });
      } catch {}
    }
  }
  try {
    if (autonomousStaticDocumentation) {
      return await stageAutonomousStaticDocumentation({
        scope,
        program,
        proposal,
        patchText,
        patchDigest,
        changedPaths,
        profile,
        baseCommit,
        deliveryBranch,
        repository,
        runner,
        options,
        commitMessage: input.commitMessage,
      });
    }
  } finally {
    try {
      assertWithin(identityParent, identityGitContext.hooksPath);
      fs.rmSync(identityGitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
  if (!options.verificationRunner) {
    throw new Error('Executable self-improvement verification is disabled until a trusted OS sandbox runner is configured; use supervised external review.');
  }
  const requestedWorktreeParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repoRoot), '.lumi-self-improvement', path.basename(repoRoot)));
  const worktreeParent = ensureTrustedStagingParent(requestedWorktreeParent, repository);
  const worktreePath = path.join(worktreeParent, safeBranchId(proposal.id));
  assertWithin(worktreeParent, worktreePath);
  if (fs.existsSync(worktreePath)) throw new Error('The isolated self-improvement worktree already exists without a verified persisted receipt.');
  fs.mkdirSync(worktreeParent, { recursive: true });
  const patchDirectory = path.join(worktreeParent, 'patches');
  fs.mkdirSync(patchDirectory, { recursive: true });
  const patchPath = path.join(patchDirectory, `${safeBranchId(proposal.id)}.patch`);
  assertWithin(worktreeParent, patchPath);
  fs.writeFileSync(patchPath, patchText, { encoding: 'utf8', flag: 'wx' });
  const branch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  let worktreeCreated = false;
  let branchCreated = false;
  try {
    await runChecked(runner, 'git', ['worktree', 'add', '--detach', worktreePath, baseCommit], repoRoot, 2 * 60_000);
    worktreeCreated = true;
    await runChecked(runner, 'git', ['switch', '-c', branch], worktreePath, 30_000);
    branchCreated = true;
    await runChecked(runner, 'git', ['apply', '--check', '--whitespace=error-all', patchPath], worktreePath, 60_000);
    await runChecked(runner, 'git', ['apply', '--whitespace=error-all', patchPath], worktreePath, 60_000);
    fs.rmSync(patchPath, { force: true });
    const actualPaths = await worktreeChangePaths(runner, worktreePath);
    assertExactPathSet(actualPaths, changedPaths, 'Applied patch');
    const reviewedContentSnapshot = snapshotReviewedFiles(worktreePath, changedPaths);
    const verification = await options.verificationRunner(worktreePath, profile, changedPaths);
    if (!verification.length || verification.some(receipt => receipt.status !== 'passed' || receipt.exitCode !== 0)) {
      throw new Error('Self-improvement verification did not produce an all-passing receipt set.');
    }
    const postVerificationPaths = await worktreeChangePaths(runner, worktreePath);
    assertExactPathSet(postVerificationPaths, changedPaths, 'Post-verification worktree');
    if (snapshotReviewedFiles(worktreePath, changedPaths) !== reviewedContentSnapshot) {
      throw new Error('Verification changed reviewed file contents after the patch was applied; staging stopped.');
    }
    let commit: string | undefined;
    if (program.allowLocalCommit && proposal.operations.includes('git_commit')) {
      assertStagingMayContinue(options);
      await runChecked(runner, 'git', ['add', '--', ...changedPaths], worktreePath, 30_000);
      const message = `improve: verified proposal ${safeBranchId(proposal.id)}`;
      await runChecked(runner, 'git', [
        '-c', 'user.name=Lumi Self-Improvement',
        '-c', 'user.email=lumi-self-improvement@localhost',
        '-c', 'core.hooksPath=.lumi-disabled-hooks',
        'commit', '-m', message,
      ], worktreePath, 2 * 60_000);
      commit = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], worktreePath, 30_000)).stdout.trim();
      const committedPaths = parseNullSeparatedPaths((await runChecked(
        runner,
        'git',
        ['diff', '--name-only', '-z', baseCommit, commit],
        worktreePath,
        30_000,
      )).stdout);
      assertExactPathSet(committedPaths, changedPaths, 'Committed self-improvement');
      const postCommitPaths = await worktreeChangePaths(runner, worktreePath);
      if (postCommitPaths.length > 0) {
        throw new Error(`Self-improvement commit left undeclared worktree changes: ${postCommitPaths.join(', ')}.`);
      }
    }
    const evidence = [
      { kind: 'git', ref: branch, status: 'isolated', summary: `isolated branch at base ${baseCommit}` },
      ...verification.map(receipt => ({
        kind: 'verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
      })),
      ...(commit ? [{ kind: 'commit', ref: commit, status: 'verified', summary: 'local isolated commit created after verification' }] : []),
    ];
    assertStagingMayContinue(options);
    const persistedProposal = await recordSelfImprovementStage(scope, proposal.id, {
      status: 'verified', baseCommit, worktreePath, branch, commit, patchDigest,
      stagingProtocol: 'supervised_worktree_v1', deliveryBranch, evidence,
    });
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      isolated: true,
      activated: false,
      pushed: false,
      proposal: persistedProposal,
      baseCommit,
      branch,
      commit,
      worktreePath,
      changedPaths,
      verification,
    };
  } catch (error) {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    if (worktreeCreated) await cleanupFailedWorktree(runner, repoRoot, worktreePath, branch, branchCreated);
    throw error;
  }
}

/**
 * Reconstruct a terminal receipt after a crash that happened after durable
 * static staging but before the autonomous task recorded its tool receipt.
 * No patch bytes are needed: every persisted Git/ref/tree/path/task binding is
 * revalidated against the trusted repository before the receipt is returned.
 */
export async function replayVerifiedSelfImprovementStage(
  scope: SelfImprovementScope,
  input: { proposalId: string; taskId: string },
  options: SelfImprovementStagingOptions = {},
): Promise<SelfImprovementStageResult> {
  assertStagingMayContinue(options);
  const { evaluation, proposal } = authorizeSelfImprovementStage(scope, String(input.proposalId || ''));
  if (
    evaluation.decision !== 'eligible_autonomous'
    || proposal.status !== 'verified'
    || proposal.taskId !== String(input.taskId || '')
    || proposal.stagingProtocol !== 'static_git_plumbing_v1'
    || !proposal.worktreePath
    || !proposal.baseCommit
    || !proposal.stagedBranch
    || !proposal.stagedCommit
    || !proposal.stagedTreeDigest
  ) {
    throw new Error('No exact task-bound verified autonomous stage is available for durable replay.');
  }
  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const requestedParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
  const identityParent = ensureTrustedStagingParent(requestedParent, repository);
  const gitContext = makeRestrictedGitContext(identityParent);
  try {
    await assertNoRepositoryGitContentDrivers(runner, repository, gitContext);
    assertSafePlainStageRoot(proposal.worktreePath, proposal, repository);
    const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
    if (proposal.stagedBranch !== expectedBranch) throw new Error('Verified replay branch identity is invalid.');
    const branchCommit = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['rev-parse', `refs/heads/${proposal.stagedBranch}`],
    )).stdout.trim();
    if (branchCommit !== proposal.stagedCommit) throw new Error('Verified self-improvement branch moved after staging.');
    const parent = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['rev-parse', `${proposal.stagedCommit}^`],
    )).stdout.trim();
    if (parent !== proposal.baseCommit) throw new Error('Verified self-improvement commit parent no longer matches its base.');
    const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['diff', '--no-ext-diff', '--name-only', '-z', proposal.baseCommit, proposal.stagedCommit],
    )).stdout);
    assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified replay commit');
    const manifest = await exactCommitManifest(
      runner,
      repository,
      gitContext,
      proposal.stagedCommit,
      proposal.changedPaths || [],
    );
    if (manifest.digest !== proposal.stagedTreeDigest) {
      throw new Error('Verified self-improvement tree digest no longer matches the persisted receipt.');
    }
    assertStaticDocumentationContent(proposal.worktreePath, proposal.changedPaths || []);
    await assertStageFilesMatchCommit(
      runner,
      repository,
      gitContext,
      proposal.worktreePath,
      manifest.entries,
    );
    assertStagingMayContinue(options);
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      isolated: true,
      activated: false,
      pushed: false,
      proposal,
      baseCommit: proposal.baseCommit,
      branch: proposal.stagedBranch,
      commit: proposal.stagedCommit,
      worktreePath: proposal.worktreePath,
      changedPaths: proposal.changedPaths || [],
      repositoryId: repository.repositoryId,
      treeDigest: manifest.digest,
      verification: (proposal.evidence || [])
        .filter(item => item.kind === 'verification')
        .map(item => ({
          profile: proposal.verificationProfile || 'standard',
          command: item.ref,
          status: 'passed',
          exitCode: 0,
          durationMs: 0,
          outputDigest: '',
          summary: item.summary,
        })),
      replayed: true,
    };
  } finally {
    try {
      assertWithin(identityParent, gitContext.hooksPath);
      const hooksStat = fs.lstatSync(gitContext.hooksPath);
      if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) throw new Error('Unsafe restricted hooks cleanup target.');
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}

function sameResolvedPath(left: string, right: string): boolean {
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

function registeredWorktrees(porcelain: string): Array<{ path: string; head: string; branch: string }> {
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

function assertSafePlainStageRoot(
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

async function activateStaticDocumentationStage(
  scope: SelfImprovementScope,
  proposal: SelfImprovementProposal,
  options: SelfImprovementActivationOptions,
): Promise<SelfImprovementActivationResult> {
  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const stageRoot = path.resolve(proposal.worktreePath!);
  const securityParent = assertSafePlainStageRoot(stageRoot, proposal, repository);
  const gitContext = makeRestrictedGitContext(securityParent);
  const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  const ref = `refs/heads/${expectedBranch}`;
  try {
    await assertNoRepositoryGitContentDrivers(runner, repository, gitContext);
    if (proposal.stagedBranch !== expectedBranch) throw new Error('The staged branch identity does not match this proposal.');
    const branchCommit = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', ref])).stdout.trim();
    if (branchCommit !== proposal.stagedCommit) throw new Error('The staging branch moved after verification.');
    const parent = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['rev-parse', `${proposal.stagedCommit}^`],
    )).stdout.trim();
    if (parent !== proposal.baseCommit) throw new Error('Activation requires exactly one reviewed commit on top of the recorded base.');
    const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['diff', '--no-ext-diff', '--name-only', '-z', proposal.baseCommit!, proposal.stagedCommit!],
    )).stdout);
    assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified self-improvement commit');
    const manifest = await exactCommitManifest(
      runner,
      repository,
      gitContext,
      proposal.stagedCommit!,
      proposal.changedPaths || [],
    );
    if (!proposal.stagedTreeDigest || manifest.digest !== proposal.stagedTreeDigest) {
      throw new Error('The staged documentation tree digest no longer matches the persisted verification receipt.');
    }
    assertStaticDocumentationContent(stageRoot, proposal.changedPaths || []);
    await assertStageFilesMatchCommit(runner, repository, gitContext, stageRoot, manifest.entries);
    const verification = verifyStaticDocumentation(
      stageRoot,
      proposal.verificationProfile || 'standard',
      proposal.changedPaths || [],
    );

    const liveStatus = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (liveStatus) throw new Error('The live worktree is not clean; activation stopped without changing it.');
    const currentBranch = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    if (!currentBranch || currentBranch !== proposal.deliveryBranch) {
      throw new Error(`Activation is bound to delivery branch ${proposal.deliveryBranch}; current branch is ${currentBranch || 'detached'}.`);
    }
    const currentHead = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    if (currentHead !== proposal.baseCommit && currentHead !== proposal.stagedCommit) {
      throw new Error('The live branch moved beyond the reviewed base; create and verify a new proposal instead of merging stale work.');
    }

    const refreshed = authorizeSelfImprovementActivation(scope, proposal.id).proposal;
    if (
      refreshed.stagedCommit !== proposal.stagedCommit
      || refreshed.stagedPatchDigest !== proposal.stagedPatchDigest
      || refreshed.stagedTreeDigest !== proposal.stagedTreeDigest
      || refreshed.repositoryId !== proposal.repositoryId
      || refreshed.deliveryBranch !== proposal.deliveryBranch
    ) {
      throw new Error('Self-improvement authorization or reviewed artifact changed during verification; activation stopped.');
    }
    await assertNoGitContentTransforms(runner, repository, gitContext, proposal.changedPaths || []);
    if (fs.readdirSync(gitContext.hooksPath).length > 0) {
      throw new Error('The isolated no-hooks directory changed during activation.');
    }
    const branchImmediatelyBeforeMerge = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    const headImmediatelyBeforeMerge = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    const statusImmediatelyBeforeMerge = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (
      branchImmediatelyBeforeMerge !== proposal.deliveryBranch
      || headImmediatelyBeforeMerge !== currentHead
      || statusImmediatelyBeforeMerge
    ) {
      throw new Error('The live delivery branch changed during verification; activation stopped before merge.');
    }

    if (currentHead === proposal.baseCommit) {
      await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['merge', '--ff-only', '--no-edit', proposal.stagedCommit!],
        repository.root,
        2 * 60_000,
      );
    }
    const activatedHead = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    const activatedBranch = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    const activatedStatus = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (activatedHead !== proposal.stagedCommit || activatedBranch !== proposal.deliveryBranch || activatedStatus) {
      throw new Error('Activation did not reach the exact verified commit on a clean delivery branch.');
    }
    const finalManifest = await exactCommitManifest(
      runner,
      repository,
      gitContext,
      activatedHead,
      proposal.changedPaths || [],
    );
    if (finalManifest.digest !== proposal.stagedTreeDigest) {
      throw new Error('Activated commit tree does not match the reviewed tree digest.');
    }
    const persistedProposal = await recordSelfImprovementActivation(scope, proposal.id, {
      commit: activatedHead,
      evidence: [
        ...verification.map(receipt => ({
          kind: 'activation_verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
        })),
        {
          kind: 'activation',
          ref: `${proposal.deliveryBranch}@${activatedHead}`,
          status: 'verified',
          summary: 'delivery branch fast-forwarded locally to the exact reviewed documentation tree; no push or deployment performed',
        },
      ],
    });

    let worktreeRemoved = false;
    let stagingBranchRemoved = false;
    const cleanupRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
    worktreeRemoved = !fs.existsSync(cleanupRoot);
    if (worktreeRemoved) {
      const deletion = await runRestrictedGitProbe(
        runner,
        repository,
        gitContext,
        ['update-ref', '-d', ref, proposal.stagedCommit!],
      );
      stagingBranchRemoved = deletion.exitCode === 0;
    }
    return {
      ok: true,
      status: 'activated',
      persisted: true,
      activated: true,
      pushed: false,
      proposal: persistedProposal,
      branch: proposal.deliveryBranch!,
      baseCommit: proposal.baseCommit!,
      commit: activatedHead,
      verification,
      cleanup: { worktreeRemoved, stagingBranchRemoved },
    };
  } finally {
    try {
      assertWithin(securityParent, gitContext.hooksPath);
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}

const selfImprovementActivationLocks = new Set<string>();

async function activateSelfImprovementStageInternal(
  scope: SelfImprovementScope,
  input: { proposalId: string },
  options: SelfImprovementActivationOptions = {},
): Promise<SelfImprovementActivationResult> {
  if (options.confirmed !== true) {
    throw new Error('Self-improvement activation requires explicit user confirmation bound to this verified proposal.');
  }
  const existing = getSelfImprovementProposal(scope, String(input.proposalId || ''));
  if (!existing) throw new Error('Self-improvement proposal not found in this user scope.');
  if (existing.status === 'activated' && existing.activatedCommit && existing.baseCommit && existing.stagedBranch) {
    const replayRunner = options.commandRunner || defaultCommandRunner;
    const repository = resolveBoundRepository(existing, options);
    const requestedReplayParent = path.resolve(options.worktreeParent
      || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
    const replayParent = ensureTrustedStagingParent(requestedReplayParent, repository);
    const gitContext = makeRestrictedGitContext(replayParent);
    try {
      const deliveryBranch = String(existing.deliveryBranch || '');
      const currentBranch = (await runRestrictedGit(
        replayRunner,
        repository,
        gitContext,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      )).stdout.trim();
      if (!deliveryBranch || currentBranch !== deliveryBranch) {
        throw new Error('Activated self-improvement replay is not on its recorded delivery branch.');
      }
      const ancestor = await runRestrictedGitProbe(
        replayRunner,
        repository,
        gitContext,
        ['merge-base', '--is-ancestor', existing.activatedCommit, 'HEAD'],
      );
      if (ancestor.exitCode !== 0) {
        throw new Error('The recorded activated commit is no longer contained in the delivery branch.');
      }
      const branchProbe = await runRestrictedGitProbe(
        replayRunner,
        repository,
        gitContext,
        ['show-ref', '--verify', '--quiet', `refs/heads/${existing.stagedBranch}`],
      );
      return {
        ok: true,
        status: 'activated',
        persisted: true,
        activated: true,
        pushed: false,
        proposal: existing,
        branch: deliveryBranch,
        baseCommit: existing.baseCommit,
        commit: existing.activatedCommit,
        verification: [],
        cleanup: {
          worktreeRemoved: !fs.existsSync(existing.worktreePath || ''),
          stagingBranchRemoved: branchProbe.exitCode !== 0,
        },
        replayed: true,
      };
    } finally {
      try {
        assertWithin(replayParent, gitContext.hooksPath);
        fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
      } catch {}
    }
  }

  const { proposal } = authorizeSelfImprovementActivation(scope, existing.id);
  if (proposal.target !== 'core') {
    throw new Error('Variant activation must run through the variant release train.');
  }
  const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  if (proposal.stagedBranch !== expectedBranch) throw new Error('The staged branch identity does not match this proposal.');
  if (!/^[0-9a-f]{40,64}$/i.test(proposal.baseCommit || '') || !/^[0-9a-f]{40,64}$/i.test(proposal.stagedCommit || '')) {
    throw new Error('The persisted Git activation identity is invalid.');
  }
  const autonomousStaticStage = proposal.operations.length === 1
    && proposal.operations[0] === 'documentation_change'
    && (proposal.changedPaths || []).length > 0
    && (proposal.changedPaths || []).every(isAutonomousSelfImprovementDocumentationPath)
    && Boolean(proposal.stagedTreeDigest);
  if (autonomousStaticStage) {
    return activateStaticDocumentationStage(scope, proposal, options);
  }

  const runner = options.commandRunner || defaultCommandRunner;
  const initialRoot = path.resolve(options.repoRoot || process.cwd());
  const repoRoot = path.resolve((await runChecked(runner, 'git', ['rev-parse', '--show-toplevel'], initialRoot, 30_000)).stdout.trim());
  const worktreePath = path.resolve(proposal.worktreePath!);
  const listed = registeredWorktrees((await runChecked(runner, 'git', ['worktree', 'list', '--porcelain'], repoRoot, 30_000)).stdout);
  const registered = listed.find(item => sameResolvedPath(item.path, worktreePath));
  if (!registered || registered.branch !== expectedBranch || registered.head !== proposal.stagedCommit) {
    const mismatch = !registered
      ? 'worktree_not_registered'
      : registered.branch !== expectedBranch
        ? `branch_mismatch:${registered.branch || 'detached'}`
        : `head_mismatch:${registered.head || 'missing'}`;
    throw new Error(`The verified staging worktree, branch, and commit no longer match the persisted proposal (${mismatch}).`);
  }
  const branchCommit = (await runChecked(runner, 'git', ['rev-parse', `refs/heads/${expectedBranch}`], repoRoot, 30_000)).stdout.trim();
  if (branchCommit !== proposal.stagedCommit) throw new Error('The staging branch moved after verification.');
  const stagedParent = (await runChecked(runner, 'git', ['rev-parse', `${proposal.stagedCommit}^`], repoRoot, 30_000)).stdout.trim();
  if (stagedParent !== proposal.baseCommit) throw new Error('Activation requires exactly one reviewed commit on top of the recorded base.');
  const committedPaths = parseNullSeparatedPaths((await runChecked(
    runner,
    'git',
    ['diff', '--name-only', '-z', proposal.baseCommit, proposal.stagedCommit],
    worktreePath,
    30_000,
  )).stdout);
  assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified self-improvement commit');
  const stagingStatusBeforeVerification = await worktreeChangePaths(runner, worktreePath);
  if (stagingStatusBeforeVerification.length > 0) {
    throw new Error(`The verified staging worktree is dirty: ${stagingStatusBeforeVerification.join(', ')}.`);
  }

  const liveStatus = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (liveStatus) throw new Error('The live worktree is not clean; activation stopped without changing it.');
  const currentBranch = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (!currentBranch || currentBranch === expectedBranch) throw new Error('Activation requires a normal checked-out delivery branch.');
  if (currentBranch !== proposal.deliveryBranch) {
    throw new Error(`Activation is bound to delivery branch ${proposal.deliveryBranch}; current branch is ${currentBranch}.`);
  }
  const currentHead = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (currentHead !== proposal.baseCommit && currentHead !== proposal.stagedCommit) {
    throw new Error('The live branch moved beyond the reviewed base; rebase and re-verify a new proposal instead of merging stale work.');
  }

  const profile = proposal.verificationProfile || 'standard';
  const staticDocumentation = proposal.operations.length === 1
    && proposal.operations[0] === 'documentation_change'
    && (proposal.changedPaths || []).length > 0
    && (proposal.changedPaths || []).every(isAutonomousSelfImprovementDocumentationPath);
  if (!staticDocumentation && !options.verificationRunner) {
    throw new Error('Self-improvement activation is disabled until a trusted OS sandbox runner is configured for executable re-verification.');
  }
  const verification = staticDocumentation
    ? verifyStaticDocumentation(worktreePath, profile, proposal.changedPaths || [])
    : await options.verificationRunner!(worktreePath, profile, proposal.changedPaths || []);
  if (!verification.length || verification.some(receipt => receipt.status !== 'passed' || receipt.exitCode !== 0)) {
    throw new Error('Activation re-verification did not produce an all-passing receipt set.');
  }
  const stagingStatusAfterVerification = await worktreeChangePaths(runner, worktreePath);
  if (stagingStatusAfterVerification.length > 0) {
    throw new Error(`Activation verification changed the staged worktree: ${stagingStatusAfterVerification.join(', ')}.`);
  }

  const refreshedAuthorization = authorizeSelfImprovementActivation(scope, proposal.id).proposal;
  if (
    refreshedAuthorization.stagedCommit !== proposal.stagedCommit
    || refreshedAuthorization.stagedPatchDigest !== proposal.stagedPatchDigest
    || refreshedAuthorization.deliveryBranch !== proposal.deliveryBranch
  ) {
    throw new Error('Self-improvement authorization or reviewed artifact changed during verification; activation stopped.');
  }
  const branchImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const headImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const statusImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (
    branchImmediatelyBeforeMerge !== proposal.deliveryBranch
    || headImmediatelyBeforeMerge !== currentHead
    || statusImmediatelyBeforeMerge
  ) {
    throw new Error('The live delivery branch changed during verification; activation stopped before merge.');
  }

  if (currentHead === proposal.baseCommit) {
    await runChecked(runner, 'git', [
      '-c', 'core.hooksPath=.lumi-disabled-hooks',
      'merge', '--ff-only', proposal.stagedCommit!,
    ], repoRoot, 2 * 60_000);
  }
  const activatedHead = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (activatedHead !== proposal.stagedCommit) {
    throw new Error('The live branch did not reach the verified staged commit.');
  }
  const activatedBranch = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const activatedStatus = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (activatedBranch !== proposal.deliveryBranch || activatedStatus) {
    throw new Error('Activation reached the reviewed commit but the delivery branch identity or clean-state verification failed.');
  }
  const persistedProposal = await recordSelfImprovementActivation(scope, proposal.id, {
    commit: activatedHead,
    evidence: [
      ...verification.map(receipt => ({
        kind: 'activation_verification',
        ref: receipt.command,
        status: receipt.status,
        summary: receipt.summary,
      })),
      {
        kind: 'activation',
        ref: `${currentBranch}@${activatedHead}`,
        status: 'verified',
        summary: 'delivery branch fast-forwarded locally to the exact reviewed commit; no push or deployment performed',
      },
    ],
  });

  let worktreeRemoved = false;
  let stagingBranchRemoved = false;
  try {
    await runChecked(runner, 'git', ['worktree', 'remove', worktreePath], repoRoot, 60_000);
    worktreeRemoved = true;
  } catch {}
  if (worktreeRemoved) {
    try {
      await runChecked(runner, 'git', ['branch', '-d', expectedBranch], repoRoot, 30_000);
      stagingBranchRemoved = true;
    } catch {}
  }

  return {
    ok: true,
    status: 'activated',
    persisted: true,
    activated: true,
    pushed: false,
    proposal: persistedProposal,
    branch: currentBranch,
    baseCommit: proposal.baseCommit!,
    commit: activatedHead,
    verification,
    cleanup: { worktreeRemoved, stagingBranchRemoved },
  };
}

export async function activateSelfImprovementStage(
  scope: SelfImprovementScope,
  input: { proposalId: string },
  options: SelfImprovementActivationOptions = {},
): Promise<SelfImprovementActivationResult> {
  if (options.confirmed !== true) {
    return activateSelfImprovementStageInternal(scope, input, options);
  }
  const existing = getSelfImprovementProposal(scope, String(input.proposalId || ''));
  if (!existing) throw new Error('Self-improvement proposal not found in this user scope.');
  const proposal = existing.status === 'activated'
    ? existing
    : authorizeSelfImprovementActivation(scope, existing.id).proposal;
  const repository = resolveBoundRepository(proposal, options);
  const lockKey = `${repository.repositoryId}\0${proposal.deliveryBranch}`;
  if (selfImprovementActivationLocks.has(lockKey)) {
    throw new Error('This self-improvement repository and delivery branch are already being activated.');
  }
  selfImprovementActivationLocks.add(lockKey);
  let repositoryLease: ReturnType<typeof acquireSelfImprovementRepositoryLease> | undefined;
  try {
    repositoryLease = acquireSelfImprovementRepositoryLease(repository, 'activation');
    return await activateSelfImprovementStageInternal(scope, input, options);
  } finally {
    repositoryLease?.release();
    selfImprovementActivationLocks.delete(lockKey);
  }
}
