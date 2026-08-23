import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const GIT = 'git';
const RESERVED_VARIANT_IDS = new Set(['main', 'master', 'origin', 'upstream']);
const REQUIRED_GATES = Object.freeze(['lint', 'test', 'build']);

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${options.label || `${command} ${args.join(' ')}`} failed${detail ? `:\n${detail}` : ''}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    durationMs: Date.now() - startedAt,
  };
}

class VariantReleaseError extends Error {
  constructor(message, releaseState) {
    super(message);
    this.name = 'VariantReleaseError';
    this.releaseState = releaseState;
  }
}

function git(cwd, args, options = {}) {
  return run(GIT, args, { ...options, cwd });
}

function runNpm(args, options = {}) {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  if (process.platform === 'win32') {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], options);
  }
  return run('npm', args, options);
}

function runCode(args, options = {}) {
  if (process.platform === 'win32') {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'code.cmd', ...args], options);
  }
  return run('code', args, options);
}

function samePath(first, second) {
  const normalize = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return normalize(first) === normalize(second);
}

function assertClean(cwd, label) {
  const status = git(cwd, ['status', '--porcelain']).stdout;
  if (status) throw new Error(`${label} has uncommitted changes. Commit or discard them before continuing.`);
}

function parseOptions(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      options._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function writeResult(value) {
  console.log(JSON.stringify(value, null, 2));
  return value;
}

export function normalizeVariantId(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^lumi-/, '')
    .replace(/-+/g, '-');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error('Variant ID must contain only lowercase letters, numbers, and single hyphens.');
  }
  if (RESERVED_VARIANT_IDS.has(normalized)) throw new Error(`Variant ID "${normalized}" is reserved.`);
  return normalized;
}

function validateDisplayName(value) {
  const displayName = String(value || '').trim();
  if (!displayName || displayName.length > 120 || /[\u0000-\u001f]/.test(displayName)) {
    throw new Error('Business name is required and must be 120 characters or fewer.');
  }
  return displayName;
}

function validateBranchName(value, label) {
  const branch = String(value || '').trim();
  const result = branch
    ? run(GIT, ['check-ref-format', '--branch', branch], { allowFailure: true })
    : { ok: false };
  if (!result.ok) throw new Error(`${label} is not a valid Git branch name.`);
  return branch;
}

function validateCommit(value, label) {
  const commit = String(value || '').trim();
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`${label} is not a valid Git commit ID.`);
  return commit;
}

export function parseRepositoryUrl(value) {
  const repository = String(value || '').trim();
  if (!repository || /[\r\n\u0000]/.test(repository)) throw new Error('A valid child repository URL is required.');
  let match = repository.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (match) {
    const repo = match[2].replace(/\.git$/i, '');
    if (!repo || repository.includes('@github.com')) throw new Error('Repository URLs must not contain embedded credentials.');
    return { repository, github: { owner: match[1], repo } };
  }
  match = repository.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (match) return { repository, github: { owner: match[1], repo: match[2].replace(/\.git$/i, '') } };
  if (/^(?:ssh|file):\/\//i.test(repository) || path.isAbsolute(repository)) {
    return { repository, github: null };
  }
  throw new Error('Repository URL must be a GitHub HTTPS/SSH URL, file URL, or absolute local path.');
}

function parseWorktrees(raw) {
  return String(raw || '').split(/\r?\n\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    const branchRef = lines.find(line => line.startsWith('branch '))?.slice('branch '.length);
    return worktree ? [{
      worktree: path.resolve(worktree),
      branch: branchRef?.replace(/^refs\/heads\//, '') || '',
    }] : [];
  });
}

function resolveCoreRoot(start = process.cwd()) {
  const probe = path.resolve(start);
  const worktrees = parseWorktrees(git(probe, ['worktree', 'list', '--porcelain']).stdout);
  const main = worktrees.find(item => item.branch === 'main');
  if (!main) throw new Error('The Lumi main worktree was not found.');
  return path.resolve(main.worktree);
}

export function buildVariantPaths(coreRoot, rawId) {
  const id = normalizeVariantId(rawId);
  const variantsRoot = path.join(path.dirname(path.resolve(coreRoot)), `${path.basename(coreRoot)}-variants`);
  const directoryName = `lumi-${id}`;
  return {
    id,
    branch: `variant/${id}`,
    remote: id,
    variantsRoot,
    worktree: path.join(variantsRoot, directoryName),
    workspace: path.join(variantsRoot, `${directoryName}.code-workspace`),
  };
}

export function buildVariantMetadata({
  id,
  displayName,
  productLine,
  upstreamRepository,
  baselineCommit,
  repository,
  localBranch,
  remoteBranch = 'main',
  defaultBranch = 'main',
}) {
  const variantId = normalizeVariantId(id);
  const deliveryLocalBranch = validateBranchName(localBranch || `variant/${variantId}`, 'Local delivery branch');
  const deliveryRemoteBranch = validateBranchName(remoteBranch, 'Remote delivery branch');
  const deliveryDefaultBranch = validateBranchName(defaultBranch, 'Remote default branch');
  return {
    schemaVersion: 2,
    variantId,
    displayName: validateDisplayName(displayName),
    productLine: String(productLine || variantId).trim() || variantId,
    upstream: {
      repository: upstreamRepository,
      branch: 'main',
      baselineCommit: validateCommit(baselineCommit, 'Core baseline commit'),
      lastSyncedCommit: validateCommit(baselineCommit, 'Last synchronized core commit'),
    },
    repository,
    delivery: {
      localBranch: deliveryLocalBranch,
      remoteBranch: deliveryRemoteBranch,
      defaultBranch: deliveryDefaultBranch,
    },
    verification: {
      requiredGates: [...REQUIRED_GATES],
    },
    syncPolicy: {
      coreToVariant: 'merge reviewed upstream releases',
      variantToCore: 'cherry-pick reviewed generic commits',
      defaultBranchUpdate: 'verified fast-forward only',
    },
    createdAt: new Date().toISOString(),
  };
}

function trackingBranch(worktree) {
  const result = git(worktree, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  if (!result.ok) return { remote: '', branch: '' };
  const separator = result.stdout.indexOf('/');
  return separator > 0
    ? { remote: result.stdout.slice(0, separator), branch: result.stdout.slice(separator + 1) }
    : { remote: '', branch: '' };
}

export function normalizeVariantMetadata(rawMetadata, context = {}) {
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
    throw new Error('Variant metadata must be a JSON object.');
  }
  const variantId = normalizeVariantId(rawMetadata.variantId);
  const repository = parseRepositoryUrl(rawMetadata.repository).repository;
  const upstreamRepository = parseRepositoryUrl(rawMetadata.upstream?.repository).repository;
  const upstreamBranch = validateBranchName(rawMetadata.upstream?.branch || 'main', 'Core branch');
  const baselineCommit = validateCommit(rawMetadata.upstream?.baselineCommit, 'Core baseline commit');
  const lastSyncedCommit = validateCommit(
    rawMetadata.upstream?.lastSyncedCommit || baselineCommit,
    'Last synchronized core commit',
  );
  const localBranch = validateBranchName(
    rawMetadata.delivery?.localBranch || context.currentBranch || `variant/${variantId}`,
    'Local delivery branch',
  );
  const remoteBranch = validateBranchName(
    rawMetadata.delivery?.remoteBranch || context.trackingBranch || 'main',
    'Remote delivery branch',
  );
  const defaultBranch = validateBranchName(rawMetadata.delivery?.defaultBranch || 'main', 'Remote default branch');
  const metadata = {
    ...rawMetadata,
    schemaVersion: 2,
    variantId,
    displayName: validateDisplayName(rawMetadata.displayName),
    productLine: String(rawMetadata.productLine || variantId).trim() || variantId,
    upstream: {
      ...rawMetadata.upstream,
      repository: upstreamRepository,
      branch: upstreamBranch,
      baselineCommit,
      lastSyncedCommit,
    },
    repository,
    delivery: {
      ...rawMetadata.delivery,
      localBranch,
      remoteBranch,
      defaultBranch,
    },
    verification: {
      ...rawMetadata.verification,
      requiredGates: [...REQUIRED_GATES],
    },
    syncPolicy: {
      coreToVariant: 'merge reviewed upstream releases',
      variantToCore: 'cherry-pick reviewed generic commits',
      defaultBranchUpdate: 'verified fast-forward only',
      ...rawMetadata.syncPolicy,
    },
  };
  return { metadata, needsMigration: JSON.stringify(rawMetadata) !== JSON.stringify(metadata) };
}

function readMetadata(worktree, currentBranch) {
  const metadataPath = path.join(worktree, '.lumi', 'variant.json');
  if (!fs.existsSync(metadataPath)) throw new Error(`Variant metadata is missing: ${metadataPath}`);
  let rawMetadata;
  try {
    rawMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    throw new Error(`Variant metadata is invalid JSON: ${metadataPath} (${error.message})`);
  }
  const tracking = trackingBranch(worktree);
  const normalized = normalizeVariantMetadata(rawMetadata, {
    currentBranch,
    trackingBranch: tracking.branch,
  });
  return { metadataPath, rawMetadata, tracking, ...normalized };
}

export function discoverVariants(coreRootInput) {
  const coreRoot = path.resolve(coreRootInput);
  const worktrees = parseWorktrees(git(coreRoot, ['worktree', 'list', '--porcelain']).stdout);
  const discovered = [];
  const seenIds = new Map();
  for (const item of worktrees) {
    if (samePath(item.worktree, coreRoot)) continue;
    const metadataPath = path.join(item.worktree, '.lumi', 'variant.json');
    if (!fs.existsSync(metadataPath)) continue;
    const details = readMetadata(item.worktree, item.branch);
    const previous = seenIds.get(details.metadata.variantId);
    if (previous) {
      throw new Error(`Duplicate variant ID ${details.metadata.variantId} in ${previous} and ${item.worktree}.`);
    }
    seenIds.set(details.metadata.variantId, item.worktree);
    discovered.push({
      id: details.metadata.variantId,
      worktree: item.worktree,
      workspace: path.join(path.dirname(item.worktree), `${path.basename(item.worktree)}.code-workspace`),
      currentBranch: item.branch,
      ...details,
    });
  }
  return discovered.sort((first, second) => first.id.localeCompare(second.id));
}

function findVariantWorktree(coreRoot, id) {
  const normalizedId = normalizeVariantId(id);
  const record = discoverVariants(coreRoot).find(item => item.id === normalizedId);
  if (!record) throw new Error(`Variant ${normalizedId} was not discovered from .lumi/variant.json metadata.`);
  return record;
}

function remoteUrl(coreRoot, remote) {
  const result = git(coreRoot, ['remote', 'get-url', remote], { allowFailure: true });
  return result.ok ? result.stdout : '';
}

function ensureRemote(coreRoot, remote, repository) {
  const existing = remoteUrl(coreRoot, remote);
  if (existing && existing !== repository) {
    throw new Error(`Remote "${remote}" already points to ${existing}; refusing to replace it.`);
  }
  if (!existing) git(coreRoot, ['remote', 'add', remote, repository]);
}

function findVariantRemote(coreRoot, record, create = false) {
  const expected = String(record.metadata.repository || '').trim();
  const preferred = record.tracking.remote || record.id;
  const preferredUrl = remoteUrl(coreRoot, preferred);
  if (preferredUrl) {
    if (preferredUrl !== expected) throw new Error(`Remote ${preferred} does not match variant metadata.`);
    return preferred;
  }
  const remotes = git(coreRoot, ['remote']).stdout.split(/\r?\n/).filter(Boolean);
  const match = remotes.find(remote => remoteUrl(coreRoot, remote) === expected);
  if (match) return match;
  if (!create) return '';
  ensureRemote(coreRoot, record.id, expected);
  return record.id;
}

function resolveOptionalCommit(cwd, reference) {
  const result = git(cwd, ['rev-parse', `${reference}^{commit}`], { allowFailure: true });
  return result.ok ? result.stdout : '';
}

function isAncestor(cwd, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true }).ok;
}

function countCommits(cwd, range) {
  const result = git(cwd, ['rev-list', '--count', range], { allowFailure: true });
  return result.ok ? Number.parseInt(result.stdout, 10) || 0 : null;
}

function remoteBranchHead(cwd, remote, branch) {
  const result = git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], { allowFailure: true });
  if (!result.ok) throw new Error(`Could not read ${remote}/${branch}.`);
  const line = result.stdout.split(/\r?\n/).find(Boolean);
  return line?.split(/\s+/)[0] || '';
}

function mergePreview(coreRoot, record) {
  const ours = git(record.worktree, ['rev-parse', 'HEAD^{commit}']).stdout;
  const theirs = git(coreRoot, ['rev-parse', `${record.metadata.upstream.branch}^{commit}`]).stdout;
  const baseResult = git(record.worktree, ['merge-base', ours, theirs], { allowFailure: true });
  if (!baseResult.ok || !baseResult.stdout) {
    return {
      attempted: false,
      conflictFree: false,
      reason: 'merge_base_missing',
      ours,
      theirs,
    };
  }

  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-variant-merge-preview-'));
  const objectDirectory = path.join(previewRoot, 'objects');
  fs.mkdirSync(objectDirectory);
  const commonDirRaw = git(record.worktree, ['rev-parse', '--git-common-dir']).stdout;
  const commonDir = path.resolve(record.worktree, commonDirRaw);
  try {
    const result = git(record.worktree, [
      'merge-tree',
      '--write-tree',
      '--quiet',
      '--merge-base', baseResult.stdout,
      ours,
      theirs,
    ], {
      allowFailure: true,
      env: {
        ...process.env,
        GIT_OBJECT_DIRECTORY: objectDirectory,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(commonDir, 'objects'),
      },
    });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`Three-way merge preview failed with Git status ${result.status}.`);
    }
    return {
      attempted: true,
      mode: 'isolated_git_merge_tree',
      mergeBase: baseResult.stdout,
      ours,
      theirs,
      conflictFree: result.status === 0,
    };
  } finally {
    const resolvedPreviewRoot = path.resolve(previewRoot);
    if (resolvedPreviewRoot.startsWith(path.resolve(os.tmpdir()))
      && path.basename(resolvedPreviewRoot).startsWith('lumi-variant-merge-preview-')) {
      fs.rmSync(resolvedPreviewRoot, { recursive: true, force: true });
    }
  }
}

function worktreeSnapshot(record) {
  assertClean(record.worktree, `${record.id} worktree`);
  return {
    id: record.id,
    worktree: record.worktree,
    branch: git(record.worktree, ['branch', '--show-current']).stdout,
    head: git(record.worktree, ['rev-parse', 'HEAD^{commit}']).stdout,
  };
}

function rollbackWorktree(snapshot) {
  const currentBranch = git(snapshot.worktree, ['branch', '--show-current'], { allowFailure: true }).stdout;
  if (currentBranch !== snapshot.branch) {
    return {
      id: snapshot.id,
      status: 'failed',
      reason: 'branch_changed',
      expectedBranch: snapshot.branch,
      currentBranch,
    };
  }
  const reset = git(snapshot.worktree, ['reset', '--hard', snapshot.head], { allowFailure: true });
  const currentHead = resolveOptionalCommit(snapshot.worktree, 'HEAD');
  const clean = reset.ok && !git(snapshot.worktree, ['status', '--porcelain']).stdout;
  return {
    id: snapshot.id,
    status: clean && currentHead === snapshot.head ? 'rolled_back' : 'failed',
    restoredCommit: currentHead,
    expectedCommit: snapshot.head,
  };
}

function rollbackWorktrees(snapshots) {
  return [...snapshots].reverse().map(rollbackWorktree).reverse();
}

function releaseStatePath(coreRoot) {
  const commonDirRaw = git(coreRoot, ['rev-parse', '--git-common-dir']).stdout;
  return path.join(path.resolve(coreRoot, commonDirRaw), 'lumi', 'variant-release-state.json');
}

function writeReleaseState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function clearReleaseState(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function releaseFailure(message, state) {
  return new VariantReleaseError(message, state);
}

function remoteDefaultBranch(cwd, remote) {
  const result = git(cwd, ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true });
  if (!result.ok) return '';
  const match = result.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  return match?.[1] || '';
}

function coreRepository(coreRoot) {
  const repository = remoteUrl(coreRoot, 'origin');
  if (!repository) throw new Error('The Lumi main repository requires an origin remote.');
  return repository;
}

function validateCoreLineage(coreRoot, record, coreCommit, blockers) {
  const { baselineCommit, lastSyncedCommit } = record.metadata.upstream;
  if (!resolveOptionalCommit(coreRoot, baselineCommit)) blockers.push('core_baseline_missing');
  if (!resolveOptionalCommit(coreRoot, lastSyncedCommit)) {
    blockers.push('last_synced_commit_missing');
    return;
  }
  if (!isAncestor(coreRoot, baselineCommit, lastSyncedCommit)) blockers.push('baseline_not_ancestor_of_last_sync');
  if (!isAncestor(coreRoot, lastSyncedCommit, coreCommit)) blockers.push('core_history_diverged_since_last_sync');
  if (!isAncestor(record.worktree, lastSyncedCommit, 'HEAD')) blockers.push('variant_does_not_contain_last_sync');
}

export function inspectVariantStatus(coreRootInput, record, options = {}) {
  const coreRoot = path.resolve(coreRootInput);
  const blockers = [];
  const warnings = [];
  const remote = findVariantRemote(coreRoot, record, false);
  if (!remote) blockers.push('repository_remote_missing');
  const originRepository = coreRepository(coreRoot);
  if (record.metadata.upstream.repository !== originRepository) blockers.push('core_repository_mismatch');
  if (record.currentBranch !== record.metadata.delivery.localBranch) blockers.push('delivery_branch_mismatch');
  const coreCommit = resolveOptionalCommit(coreRoot, record.metadata.upstream.branch);
  if (!coreCommit) blockers.push('core_branch_missing');
  if (git(coreRoot, ['status', '--porcelain']).stdout) blockers.push('core_worktree_dirty');
  if (git(record.worktree, ['status', '--porcelain']).stdout) blockers.push('variant_worktree_dirty');
  if (coreCommit) validateCoreLineage(coreRoot, record, coreCommit, blockers);
  if (record.needsMigration) warnings.push('metadata_schema_upgrade_pending');

  if (options.fetch && remote) git(record.worktree, ['fetch', '--prune', remote], { label: `Fetch ${record.id}` });
  const head = resolveOptionalCommit(record.worktree, 'HEAD');
  const remoteDeliveryRef = remote ? `${remote}/${record.metadata.delivery.remoteBranch}` : '';
  const remoteDefaultRef = remote ? `${remote}/${record.metadata.delivery.defaultBranch}` : '';
  const remoteDeliveryHead = remoteDeliveryRef ? resolveOptionalCommit(record.worktree, remoteDeliveryRef) : '';
  const remoteDefaultHead = remoteDefaultRef ? resolveOptionalCommit(record.worktree, remoteDefaultRef) : '';
  if (remote && !remoteDeliveryHead) blockers.push('remote_delivery_branch_missing');
  const localAhead = remoteDeliveryHead ? countCommits(record.worktree, `${remoteDeliveryHead}..${head}`) : null;
  const localBehind = remoteDeliveryHead ? countCommits(record.worktree, `${head}..${remoteDeliveryHead}`) : null;
  if (localBehind) blockers.push('remote_delivery_ahead');
  if (localAhead) warnings.push('local_delivery_not_pushed');
  const coreBehind = coreCommit && resolveOptionalCommit(coreRoot, record.metadata.upstream.lastSyncedCommit)
    ? countCommits(coreRoot, `${record.metadata.upstream.lastSyncedCommit}..${coreCommit}`)
    : null;
  const defaultAligned = Boolean(remoteDefaultHead && remoteDefaultHead === head);
  if (!defaultAligned) warnings.push('remote_default_branch_stale');

  let state = 'ready';
  if (blockers.length) state = 'blocked';
  else if (coreBehind) state = 'needs_core_sync';
  else if (localAhead || localBehind) state = 'delivery_out_of_sync';
  else if (!defaultAligned) state = 'default_branch_stale';
  else if (record.needsMigration) state = 'metadata_upgrade_required';

  return {
    id: record.id,
    displayName: record.metadata.displayName,
    productLine: record.metadata.productLine,
    state,
    canSync: blockers.length === 0,
    blockers,
    warnings: [...new Set(warnings)],
    worktree: record.worktree,
    clean: !blockers.includes('variant_worktree_dirty'),
    metadata: {
      schemaVersion: record.rawMetadata.schemaVersion || 1,
      targetSchemaVersion: 2,
      needsMigration: record.needsMigration,
    },
    core: {
      repository: record.metadata.upstream.repository,
      branch: record.metadata.upstream.branch,
      baselineCommit: record.metadata.upstream.baselineCommit,
      lastSyncedCommit: record.metadata.upstream.lastSyncedCommit,
      currentCommit: coreCommit,
      commitsBehind: coreBehind,
    },
    delivery: {
      repository: record.metadata.repository,
      remote,
      localBranch: record.metadata.delivery.localBranch,
      currentBranch: record.currentBranch,
      remoteBranch: record.metadata.delivery.remoteBranch,
      defaultBranch: record.metadata.delivery.defaultBranch,
      head,
      remoteHead: remoteDeliveryHead,
      defaultHead: remoteDefaultHead,
      localAhead,
      localBehind,
      defaultAligned,
    },
    gates: { required: [...REQUIRED_GATES], lastRun: 'not_run' },
  };
}

function renderWorkspace(paths, displayName) {
  return `${JSON.stringify({
    folders: [{ name: displayName, path: path.basename(paths.worktree) }],
    settings: {
      'git.autofetch': true,
      'files.exclude': { '**/.codex-run': true, '**/src-tauri/target': true },
      'search.exclude': { '**/node_modules': true, '**/src-tauri/target': true },
    },
  }, null, 2)}\n`;
}

function renderDevelopmentGuide(displayName) {
  return `# ${displayName} 开发约定

本仓库是 Lumi 主程序的独立定制版。来源、交付分支、核心基线和同步策略记录在 \`.lumi/variant.json\`。

## 开发边界

- 客户界面、业务流程、行业技能、交付配置和集成适配在本仓库开发。
- 不因定制需求重写 Lumi 核心意图、回执、身份隔离、记忆隔离、安全确认和模型路由逻辑。
- 不提交客户数据、个人信息、数据库、日志、语音数据、安装包、API 密钥或其他凭据。
- 客户专属修改与可复用的通用修改必须分开提交。

## 分支、验证与同步

- 交付分支以 \`.lumi/variant.json\` 为准，不依赖本地分支命名约定。
- 所有发布必须通过 lint、全量测试和 build 三道门禁。
- 主程序升级由核心维护人员通过 \`npm run variant:sync\` 审核同步。
- 可反哺主程序的通用提交通过 \`npm run variant:promote\` 创建独立集成分支。
`;
}

function branchExists(coreRoot, branch) {
  return git(coreRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
}

function githubCredential() {
  const result = run(GIT, ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    allowFailure: true,
  });
  if (!result.ok) return '';
  const values = Object.fromEntries(result.stdout.split(/\r?\n/).flatMap(line => {
    const index = line.indexOf('=');
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
  return values.password || '';
}

async function verifyGitHubChildRepository(parsedRepository, keepActions) {
  if (!parsedRepository.github) return;
  const token = githubCredential();
  if (!token) throw new Error('GitHub authentication is required to verify the child repository.');
  const { owner, repo } = parsedRepository.github;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LumiOS-Variant-Manager',
  };
  const response = await fetch(apiUrl, { headers });
  if (response.status === 404) throw new Error(`Create the empty private GitHub repository ${owner}/${repo} first.`);
  if (!response.ok) throw new Error(`GitHub repository verification failed with HTTP ${response.status}.`);
  const repository = await response.json();
  if (repository.private !== true) throw new Error('The child repository must be private.');
  if (!keepActions) {
    const actionsResponse = await fetch(`${apiUrl}/actions/permissions`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    if (!actionsResponse.ok) throw new Error(`Could not disable inherited child-repository Actions (HTTP ${actionsResponse.status}).`);
  }
}

async function promptFor(options, fields) {
  const missing = fields.filter(field => !options[field.key]);
  if (missing.length === 0) return options;
  if (!process.stdin.isTTY) throw new Error(`Missing required options: ${missing.map(field => `--${field.key}`).join(', ')}`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const field of missing) options[field.key] = await terminal.question(`${field.label}: `);
  } finally {
    terminal.close();
  }
  return options;
}

function installDependencies(worktree, skipInstall) {
  if (skipInstall || fs.existsSync(path.join(worktree, 'node_modules'))) return null;
  const result = runNpm(['ci'], { cwd: worktree, label: 'Dependency installation' });
  return { name: 'install', status: 'passed', durationMs: result.durationMs };
}

export function verifyVariant(worktree) {
  const packagePath = path.join(worktree, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`package.json is missing in ${worktree}.`);
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const missing = REQUIRED_GATES.filter(gate => typeof packageJson.scripts?.[gate] !== 'string');
  if (missing.length) throw new Error(`Required variant verification scripts are missing: ${missing.join(', ')}.`);
  const receipts = [];
  const installation = installDependencies(worktree, false);
  if (installation) receipts.push(installation);
  for (const gate of REQUIRED_GATES) {
    const args = gate === 'test' ? ['test', '--', '--run'] : ['run', gate];
    const result = runNpm(args, { cwd: worktree, label: `Variant ${gate} gate` });
    receipts.push({ name: gate, status: 'passed', durationMs: result.durationMs });
  }
  return receipts;
}

async function createVariant(rawOptions) {
  const options = await promptFor(rawOptions, [
    { key: 'name', label: '业务名称' },
    { key: 'id', label: '英文代号' },
    { key: 'repo', label: 'GitHub 私有空仓库地址' },
  ]);
  const coreRoot = resolveCoreRoot(options.root || process.cwd());
  const id = normalizeVariantId(options.id);
  const displayName = validateDisplayName(options.name);
  const parsedRepository = parseRepositoryUrl(options.repo);
  const paths = buildVariantPaths(coreRoot, id);

  if (git(coreRoot, ['branch', '--show-current']).stdout !== 'main') throw new Error('The primary Lumi worktree must be on main.');
  assertClean(coreRoot, 'Lumi main worktree');
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { label: 'Fast-forward Lumi main' });
  const baselineCommit = git(coreRoot, ['rev-parse', 'main']).stdout;
  const upstreamRepository = coreRepository(coreRoot);
  if (parsedRepository.repository === upstreamRepository) throw new Error('The child repository must not be the Lumi main repository.');

  const targetExists = fs.existsSync(paths.worktree);
  const localBranchExists = branchExists(coreRoot, paths.branch);
  if (targetExists !== localBranchExists) {
    throw new Error('Variant branch/worktree state is incomplete. Resolve it before rerunning the generator.');
  }
  const remoteRefs = git(coreRoot, ['ls-remote', '--heads', '--tags', parsedRepository.repository], { allowFailure: true });
  if (!remoteRefs.ok) throw new Error('The child repository is not reachable with the current Git credentials.');
  if (remoteRefs.stdout && !targetExists) throw new Error('The child repository is not empty; refusing to overwrite it.');
  await verifyGitHubChildRepository(parsedRepository, Boolean(options['keep-actions']));

  if (!targetExists) {
    fs.mkdirSync(paths.variantsRoot, { recursive: true });
    git(coreRoot, ['worktree', 'add', '-b', paths.branch, paths.worktree, 'main'], { label: `Create ${id} worktree` });
  } else if (git(paths.worktree, ['branch', '--show-current']).stdout !== paths.branch) {
    throw new Error(`Existing worktree is not on ${paths.branch}.`);
  }

  const metadataPath = path.join(paths.worktree, '.lumi', 'variant.json');
  const guidePath = path.join(paths.worktree, 'VARIANT_DEVELOPMENT.md');
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  if (!fs.existsSync(metadataPath)) {
    const metadata = buildVariantMetadata({
      id,
      displayName,
      productLine: options['product-line'] || id,
      upstreamRepository,
      baselineCommit,
      repository: parsedRepository.repository,
      localBranch: paths.branch,
    });
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  } else {
    const existing = readMetadata(paths.worktree, paths.branch).metadata;
    if (existing.variantId !== id || existing.repository !== parsedRepository.repository) {
      throw new Error('Existing variant metadata does not match the requested variant.');
    }
  }
  if (!fs.existsSync(guidePath)) fs.writeFileSync(guidePath, renderDevelopmentGuide(displayName), 'utf8');
  fs.writeFileSync(paths.workspace, renderWorkspace(paths, displayName), 'utf8');

  installDependencies(paths.worktree, Boolean(options['skip-install']));
  ensureRemote(coreRoot, paths.remote, parsedRepository.repository);
  const changes = git(paths.worktree, ['status', '--porcelain']).stdout;
  if (changes) {
    git(paths.worktree, ['add', '--', '.lumi/variant.json', 'VARIANT_DEVELOPMENT.md']);
    git(paths.worktree, ['commit', '-m', `chore: initialize ${id} variant`], { label: `Initialize ${id}` });
  }
  if (!options['skip-push']) {
    verifyVariant(paths.worktree);
    git(paths.worktree, ['push', '-u', paths.remote, 'HEAD:main'], { label: `Publish ${id}` });
  }
  if (!options['skip-open']) {
    const opened = runCode(['-n', paths.workspace], { cwd: paths.worktree, allowFailure: true });
    if (!opened.ok) console.warn(`VS Code could not be opened automatically. Open ${paths.workspace} manually.`);
  }
  return writeResult({
    ok: true,
    command: 'new',
    id,
    displayName,
    localBranch: paths.branch,
    remoteBranch: 'main',
    worktree: paths.worktree,
    workspace: paths.workspace,
    repository: parsedRepository.repository,
    upstreamCommit: baselineCommit,
  });
}

function selectRecords(coreRoot, options) {
  if (options.all && options.id) throw new Error('Use either --all or --id, not both.');
  if (options.all) {
    const records = discoverVariants(coreRoot);
    if (!records.length) throw new Error('No variants were discovered from .lumi/variant.json metadata.');
    return records;
  }
  if (!options.id) throw new Error('Missing required option: --id (or use --all).');
  return [findVariantWorktree(coreRoot, options.id)];
}

async function statusVariants(rawOptions) {
  const coreRoot = resolveCoreRoot(rawOptions.root || process.cwd());
  const records = rawOptions.id ? [findVariantWorktree(coreRoot, rawOptions.id)] : discoverVariants(coreRoot);
  const variants = records.map(record => inspectVariantStatus(coreRoot, record, { fetch: Boolean(rawOptions.fetch) }));
  if (rawOptions.verify) {
    for (let index = 0; index < records.length; index += 1) {
      if (variants[index].blockers.length) {
        variants[index].gates = { required: [...REQUIRED_GATES], lastRun: 'blocked', receipts: [] };
        continue;
      }
      variants[index].gates = {
        required: [...REQUIRED_GATES],
        lastRun: 'passed',
        receipts: verifyVariant(records[index].worktree),
      };
    }
  }
  return writeResult({
    ok: variants.every(variant => variant.blockers.length === 0),
    command: 'status',
    coreRoot,
    variants,
  });
}

function syncPlan(coreRoot, record) {
  const inspected = inspectVariantStatus(coreRoot, record);
  const status = {
    ...inspected,
    blockers: [...inspected.blockers],
    warnings: [...inspected.warnings],
  };
  const previewBlockers = new Set([
    'core_branch_missing',
    'core_worktree_dirty',
    'variant_worktree_dirty',
    'last_synced_commit_missing',
    'baseline_not_ancestor_of_last_sync',
    'core_history_diverged_since_last_sync',
    'variant_does_not_contain_last_sync',
    'remote_delivery_ahead',
  ]);
  if (!status.blockers.some(blocker => previewBlockers.has(blocker))) {
    status.mergePreview = mergePreview(coreRoot, record);
    if (!status.mergePreview.conflictFree) {
      status.blockers.push('core_merge_conflict_preview');
      status.canSync = false;
      status.state = 'blocked';
    }
  } else {
    status.mergePreview = {
      attempted: false,
      conflictFree: false,
      reason: 'status_blocked',
    };
  }
  return {
    ...status,
    plannedActions: [
      `fast-forward ${record.metadata.upstream.branch} from origin`,
      `fast-forward ${record.metadata.delivery.localBranch} from ${record.metadata.delivery.remoteBranch}`,
      `merge core ${record.metadata.upstream.branch} into ${record.metadata.delivery.localBranch}`,
      'upgrade and record .lumi/variant.json core baseline',
      'run lint, test, and build gates',
      `push HEAD to ${record.metadata.delivery.remoteBranch}`,
    ],
  };
}

function writeMetadata(record, metadata) {
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  if (fs.readFileSync(record.metadataPath, 'utf8') === serialized) return false;
  fs.writeFileSync(record.metadataPath, serialized, 'utf8');
  return true;
}

function assertReleaseReady(coreRoot, record) {
  if (record.currentBranch !== record.metadata.delivery.localBranch) {
    throw new Error(`${record.id} is on ${record.currentBranch}; metadata requires ${record.metadata.delivery.localBranch}.`);
  }
  if (record.metadata.upstream.repository !== coreRepository(coreRoot)) {
    throw new Error(`${record.id} metadata points to a different Lumi core repository.`);
  }
  assertClean(coreRoot, 'Lumi main worktree');
  assertClean(record.worktree, `${record.id} worktree`);
  const coreCommit = resolveOptionalCommit(coreRoot, record.metadata.upstream.branch);
  const blockers = [];
  if (!coreCommit) blockers.push('core_branch_missing');
  else validateCoreLineage(coreRoot, record, coreCommit, blockers);
  if (blockers.length) throw new Error(`${record.id} cannot be synchronized: ${blockers.join(', ')}.`);
}

function prepareVariantSync(coreRoot, record) {
  assertReleaseReady(coreRoot, record);
  const remote = findVariantRemote(coreRoot, record, true);
  const remoteBranch = record.metadata.delivery.remoteBranch;
  git(record.worktree, ['fetch', '--prune', remote], { label: `Fetch ${record.id}` });
  git(record.worktree, ['pull', '--ff-only', remote, remoteBranch], { label: `Fast-forward ${record.id}` });

  const refreshedDetails = readMetadata(record.worktree, record.currentBranch);
  const refreshedRecord = { ...record, ...refreshedDetails };
  if (refreshedRecord.metadata.variantId !== record.id || refreshedRecord.metadata.repository !== record.metadata.repository) {
    throw new Error(`${record.id} metadata identity changed after pull; review the remote update and rerun.`);
  }
  if (refreshedRecord.metadata.delivery.remoteBranch !== remoteBranch) {
    throw new Error(`${record.id} remote delivery branch changed after pull; rerun using the refreshed metadata.`);
  }
  assertReleaseReady(coreRoot, refreshedRecord);
  git(refreshedRecord.worktree, ['merge', '--no-edit', refreshedRecord.metadata.upstream.branch], {
    label: `Merge Lumi core into ${record.id}`,
  });

  const coreCommit = git(coreRoot, ['rev-parse', `${refreshedRecord.metadata.upstream.branch}^{commit}`]).stdout;
  const metadataChanged = refreshedRecord.needsMigration
    || refreshedRecord.metadata.upstream.lastSyncedCommit !== coreCommit;
  const metadata = {
    ...refreshedRecord.metadata,
    schemaVersion: 2,
    upstream: { ...refreshedRecord.metadata.upstream, lastSyncedCommit: coreCommit },
    ...(metadataChanged ? { lastSyncedAt: new Date().toISOString() } : {}),
  };
  if (metadataChanged && writeMetadata(refreshedRecord, metadata)) {
    git(refreshedRecord.worktree, ['add', '--', '.lumi/variant.json']);
    git(refreshedRecord.worktree, ['commit', '-m', 'chore: record Lumi core synchronization'], {
      label: `Record ${record.id} synchronization`,
    });
  }
  const gates = verifyVariant(refreshedRecord.worktree);
  return {
    id: record.id,
    remote,
    remoteBranch,
    upstreamCommit: coreCommit,
    variantCommit: git(refreshedRecord.worktree, ['rev-parse', 'HEAD']).stdout,
    metadataUpgraded: refreshedRecord.needsMigration,
    metadataChanged,
    gates,
    pushed: false,
  };
}

async function syncVariants(rawOptions) {
  if (rawOptions['skip-verify']) {
    throw new Error('Release verification cannot be skipped. Use --dry-run to inspect the plan without changing repositories.');
  }
  const coreRoot = resolveCoreRoot(rawOptions.root || process.cwd());
  const options = rawOptions.all || rawOptions.id
    ? rawOptions
    : await promptFor(rawOptions, [{ key: 'id', label: '英文代号' }]);
  let records = selectRecords(coreRoot, options);
  if (options['dry-run']) {
    const plans = records.map(record => syncPlan(coreRoot, record));
    return writeResult({
      ok: plans.every(plan => plan.canSync),
      command: 'sync',
      dryRun: true,
      changed: false,
      readyToExecute: plans.every(plan => plan.canSync),
      variants: plans,
    });
  }

  if (git(coreRoot, ['branch', '--show-current']).stdout !== 'main') throw new Error('The primary Lumi worktree must be on main.');
  assertClean(coreRoot, 'Lumi main worktree');
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { label: 'Fast-forward Lumi main' });
  const releaseCoreCommit = git(coreRoot, ['rev-parse', 'main']).stdout;
  records = selectRecords(coreRoot, options);
  for (const record of records) assertReleaseReady(coreRoot, record);
  const snapshots = new Map(records.map(record => [record.id, worktreeSnapshot(record)]));
  const receipts = [];
  const startedSnapshots = [];
  try {
    for (const record of records) {
      startedSnapshots.push(snapshots.get(record.id));
      receipts.push(prepareVariantSync(coreRoot, record));
    }
  } catch (error) {
    const rollback = rollbackWorktrees(startedSnapshots);
    const phase = rollback.every(item => item.status === 'rolled_back') ? 'rolled_back' : 'rollback_failed';
    throw releaseFailure(`${error.message} Local release preparation was ${phase}.`, {
      schemaVersion: 1,
      command: 'sync',
      phase,
      remoteChanges: false,
      rollback,
      recovery: phase === 'rolled_back'
        ? 'Resolve the reported cause and rerun the same sync command.'
        : 'Inspect the listed worktrees before retrying; at least one could not be restored automatically.',
    });
  }
  if (!options['no-push']) {
    const coreStatusAfterGates = git(coreRoot, ['status', '--porcelain']).stdout;
    if (coreStatusAfterGates) {
      const rollback = rollbackWorktrees([...snapshots.values()]);
      throw releaseFailure('Lumi main changed while variant gates were running; no variant was pushed.', {
        schemaVersion: 1,
        command: 'sync',
        phase: 'concurrent_core_change',
        remoteChanges: false,
        rollback,
        preservedCoreWorktree: true,
        recovery: 'Review and commit or remove the Lumi main change, then rerun the release train.',
      });
    }
    if (git(coreRoot, ['rev-parse', 'main']).stdout !== releaseCoreCommit) {
      const rollback = rollbackWorktrees([...snapshots.values()]);
      throw releaseFailure('Lumi main changed while variant gates were running; no variant was pushed.', {
        schemaVersion: 1,
        command: 'sync',
        phase: rollback.every(item => item.status === 'rolled_back') ? 'rolled_back' : 'rollback_failed',
        remoteChanges: false,
        rollback,
        recovery: 'Rerun the release train from the current Lumi main commit.',
      });
    }
    for (const receipt of receipts) {
      const record = findVariantWorktree(coreRoot, receipt.id);
      const statusAfterGates = git(record.worktree, ['status', '--porcelain']).stdout;
      const headAfterGates = git(record.worktree, ['rev-parse', 'HEAD']).stdout;
      if (statusAfterGates || headAfterGates !== receipt.variantCommit) {
        const rollback = rollbackWorktrees([...snapshots.values()].filter(snapshot => snapshot.id !== receipt.id));
        throw releaseFailure(`${receipt.id} changed after verification; it was preserved and no variant was pushed.`, {
          schemaVersion: 1,
          command: 'sync',
          phase: 'concurrent_local_change',
          remoteChanges: false,
          rollback,
          preservedWorktree: receipt.id,
          recovery: `Review ${receipt.id}; it was preserved because it changed after verification.`,
        });
      }
    }

    try {
      for (const receipt of receipts) {
        const record = findVariantWorktree(coreRoot, receipt.id);
        receipt.remoteBefore = remoteBranchHead(record.worktree, receipt.remote, receipt.remoteBranch);
        if (receipt.remoteBefore && !isAncestor(record.worktree, receipt.remoteBefore, receipt.variantCommit)) {
          throw new Error(`${receipt.id} remote delivery branch changed and is not fast-forwardable.`);
        }
        git(record.worktree, [
          'push',
          '--dry-run',
          receipt.remote,
          `${receipt.variantCommit}:refs/heads/${receipt.remoteBranch}`,
        ], { label: `Preflight ${receipt.id} push` });
        receipt.pushPreflight = 'passed';
      }
    } catch (error) {
      const rollback = rollbackWorktrees([...snapshots.values()]);
      const phase = rollback.every(item => item.status === 'rolled_back') ? 'rolled_back' : 'rollback_failed';
      throw releaseFailure(`${error.message} Cross-repository push preflight failed; no push was started.`, {
        schemaVersion: 1,
        command: 'sync',
        phase,
        remoteChanges: false,
        rollback,
        variants: receipts.map(receipt => ({
          id: receipt.id,
          branch: receipt.remoteBranch,
          targetCommit: receipt.variantCommit,
          preflight: receipt.pushPreflight || 'failed_or_not_run',
        })),
        recovery: 'Fix the remote/authentication issue and rerun the same sync command.',
      });
    }

    const stateFile = releaseStatePath(coreRoot);
    const releaseState = {
      schemaVersion: 1,
      transactionId: `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`,
      command: 'sync',
      phase: 'pushing',
      coreCommit: releaseCoreCommit,
      startedAt: new Date().toISOString(),
      variants: receipts.map(receipt => ({
        id: receipt.id,
        remote: receipt.remote,
        branch: receipt.remoteBranch,
        remoteBefore: receipt.remoteBefore,
        targetCommit: receipt.variantCommit,
        status: receipt.remoteBefore === receipt.variantCommit ? 'already_published' : 'pending',
      })),
      recovery: options.all
        ? 'npm run variant:sync -- --all'
        : `npm run variant:sync -- --id ${receipts[0].id}`,
    };
    writeReleaseState(stateFile, releaseState);

    let pushError = null;
    for (const entry of releaseState.variants) {
      const receipt = receipts.find(item => item.id === entry.id);
      if (entry.status === 'already_published') {
        receipt.remoteAfter = entry.targetCommit;
        receipt.publicationStatus = entry.status;
        continue;
      }
      const record = findVariantWorktree(coreRoot, entry.id);
      try {
        git(record.worktree, [
          'push',
          entry.remote,
          `${entry.targetCommit}:refs/heads/${entry.branch}`,
        ], { label: `Push ${entry.id}` });
        const actual = remoteBranchHead(record.worktree, entry.remote, entry.branch);
        if (actual !== entry.targetCommit) throw new Error(`${entry.id} remote did not reach its verified commit.`);
        entry.status = 'published';
        entry.remoteAfter = actual;
        receipt.pushed = true;
        receipt.remoteAfter = actual;
        receipt.publicationStatus = entry.status;
        writeReleaseState(stateFile, releaseState);
      } catch (error) {
        pushError = error;
        break;
      }
    }

    if (pushError) {
      let reconciliationUnavailable = false;
      for (const entry of releaseState.variants) {
        const record = findVariantWorktree(coreRoot, entry.id);
        let actual;
        try {
          actual = remoteBranchHead(record.worktree, entry.remote, entry.branch);
        } catch {
          reconciliationUnavailable = true;
          entry.reconciliation = 'unavailable';
          continue;
        }
        entry.remoteAfter = actual;
        entry.reconciliation = 'verified';
        if (actual === entry.targetCommit) entry.status = entry.remoteBefore === actual ? 'already_published' : 'published';
        else if (actual === entry.remoteBefore) entry.status = 'pending';
        else entry.status = 'remote_changed';
      }
      const publishedThisRun = releaseState.variants.some(
        entry => entry.remoteBefore !== entry.targetCommit && entry.remoteAfter === entry.targetCommit,
      );
      const allPublished = releaseState.variants.every(entry => entry.remoteAfter === entry.targetCommit);
      if (!allPublished && !publishedThisRun && !reconciliationUnavailable) {
        const rollback = rollbackWorktrees([...snapshots.values()]);
        releaseState.phase = rollback.every(item => item.status === 'rolled_back') ? 'rolled_back' : 'rollback_failed';
        releaseState.remoteChanges = false;
        releaseState.rollback = rollback;
        clearReleaseState(stateFile);
      } else if (!allPublished) {
        releaseState.phase = reconciliationUnavailable ? 'remote_state_unknown' : 'partial_remote_publish';
        releaseState.remoteChanges = reconciliationUnavailable ? 'unknown' : true;
        releaseState.stateFile = stateFile;
        writeReleaseState(stateFile, releaseState);
      }
      if (!allPublished) {
        throw releaseFailure(`${pushError.message} Remote publication stopped with a recoverable state.`, releaseState);
      }
    }
    clearReleaseState(stateFile);
    for (const receipt of receipts) {
      if (!receipt.publicationStatus) {
        receipt.remoteAfter = receipt.variantCommit;
        receipt.publicationStatus = receipt.remoteBefore === receipt.variantCommit ? 'already_published' : 'published';
      }
    }
  }
  return writeResult({
    ok: true,
    command: 'sync',
    dryRun: false,
    allGatesPassed: receipts.every(receipt => REQUIRED_GATES.every(
      gate => receipt.gates.some(item => item.name === gate && item.status === 'passed'),
    )),
    variants: receipts,
  });
}

async function publishDefaultBranch(rawOptions) {
  if (rawOptions['skip-verify']) throw new Error('Default-branch publication cannot skip lint, test, or build.');
  const options = rawOptions.id
    ? rawOptions
    : await promptFor(rawOptions, [{ key: 'id', label: '英文代号' }]);
  const coreRoot = resolveCoreRoot(options.root || process.cwd());
  const record = findVariantWorktree(coreRoot, options.id);
  assertReleaseReady(coreRoot, record);
  const remote = findVariantRemote(coreRoot, record, false);
  if (!remote) throw new Error(`${record.id} repository remote is missing.`);
  const { remoteBranch, defaultBranch } = record.metadata.delivery;
  const head = git(record.worktree, ['rev-parse', 'HEAD']).stdout;

  if (!options['dry-run']) git(record.worktree, ['fetch', '--prune', remote], { label: `Fetch ${record.id}` });
  const actualDefaultBranch = options['dry-run'] ? defaultBranch : remoteDefaultBranch(record.worktree, remote);
  if (!options['dry-run'] && !actualDefaultBranch) {
    throw new Error(`Could not verify the remote default branch for ${record.id}; publication is blocked.`);
  }
  if (actualDefaultBranch && actualDefaultBranch !== defaultBranch) {
    throw new Error(`Remote default branch is ${actualDefaultBranch}; metadata requires ${defaultBranch}.`);
  }
  const remoteDeliveryHead = resolveOptionalCommit(record.worktree, `${remote}/${remoteBranch}`);
  const remoteDefaultHead = resolveOptionalCommit(record.worktree, `${remote}/${defaultBranch}`);
  const blockers = [];
  if (!remoteDeliveryHead) blockers.push('remote_delivery_branch_missing');
  if (remoteDeliveryHead && remoteDeliveryHead !== head) blockers.push('delivery_branch_not_published');
  if (!remoteDefaultHead) blockers.push('remote_default_branch_missing');
  if (remoteDefaultHead && !isAncestor(record.worktree, remoteDefaultHead, head)) blockers.push('default_branch_not_fast_forwardable');
  if (blockers.length) throw new Error(`${record.id} default branch cannot be published: ${blockers.join(', ')}.`);

  const alreadyAligned = remoteBranch === defaultBranch
    && remoteDefaultHead === head
    && !record.needsMigration;
  if (alreadyAligned) {
    const trackingAligned = record.tracking.remote === remote && record.tracking.branch === defaultBranch;
    if (!options['dry-run'] && !trackingAligned) {
      git(record.worktree, ['branch', '--set-upstream-to', `${remote}/${defaultBranch}`, record.currentBranch], {
        label: `Track ${record.id} default branch`,
      });
    }
    return writeResult({
      ok: true,
      command: 'publish-default',
      dryRun: Boolean(options['dry-run']),
      changed: !options['dry-run'] && !trackingAligned,
      id: record.id,
      defaultBranch,
      publishedCommit: head,
      status: 'already_aligned',
      trackingUpdated: !options['dry-run'] && !trackingAligned,
      gates: { required: [...REQUIRED_GATES], lastRun: 'not_needed' },
    });
  }

  const plan = {
    id: record.id,
    repository: record.metadata.repository,
    localBranch: record.metadata.delivery.localBranch,
    currentRemoteBranch: remoteBranch,
    defaultBranch,
    currentCommit: head,
    currentDefaultCommit: remoteDefaultHead,
    fastForward: true,
    gates: [...REQUIRED_GATES],
    actions: [
      `record ${defaultBranch} as the delivery branch in .lumi/variant.json`,
      'run lint, test, and build gates',
      `fast-forward ${remote}/${defaultBranch} to the verified commit`,
      `track ${remote}/${defaultBranch} for future releases`,
    ],
  };
  if (options['dry-run']) {
    return writeResult({ ok: true, command: 'publish-default', dryRun: true, changed: false, plan });
  }

  const snapshot = worktreeSnapshot(record);
  const metadata = {
    ...record.metadata,
    delivery: { ...record.metadata.delivery, remoteBranch: defaultBranch },
    defaultBranchAlignedAt: new Date().toISOString(),
  };
  let gates = [];
  let publishedCommit = '';
  let remoteAccepted = false;
  try {
    if (writeMetadata(record, metadata)) {
      git(record.worktree, ['add', '--', '.lumi/variant.json']);
      git(record.worktree, ['commit', '-m', 'chore: align variant default delivery branch'], {
        label: `Record ${record.id} default delivery branch`,
      });
    }
    gates = verifyVariant(record.worktree);
    publishedCommit = git(record.worktree, ['rev-parse', 'HEAD']).stdout;
    try {
      git(record.worktree, [
        'push',
        remote,
        `${publishedCommit}:refs/heads/${defaultBranch}`,
      ], { label: `Publish ${record.id} default branch` });
      remoteAccepted = true;
    } catch (error) {
      const actual = remoteBranchHead(record.worktree, remote, defaultBranch);
      if (actual !== publishedCommit) throw error;
      remoteAccepted = true;
    }
  } catch (error) {
    if (!remoteAccepted) {
      const rollback = rollbackWorktree(snapshot);
      throw releaseFailure(`${error.message} The temporary default-branch metadata commit was rolled back.`, {
        schemaVersion: 1,
        command: 'publish-default',
        id: record.id,
        phase: rollback.status === 'rolled_back' ? 'rolled_back' : 'rollback_failed',
        remoteChanges: false,
        rollback: [rollback],
        recovery: rollback.status === 'rolled_back'
          ? `Fix the gate or push failure and rerun publish-default for ${record.id}.`
          : `Inspect ${record.id} before retrying; its temporary commit could not be restored automatically.`,
      });
    }
    throw error;
  }
  try {
    git(record.worktree, ['branch', '--set-upstream-to', `${remote}/${defaultBranch}`, record.currentBranch], {
      label: `Track ${record.id} default branch`,
    });
  } catch (error) {
    throw releaseFailure(`${error.message} The default branch was published, but local tracking still needs repair.`, {
      schemaVersion: 1,
      command: 'publish-default',
      id: record.id,
      phase: 'published_tracking_pending',
      remoteChanges: true,
      publishedCommit,
      defaultBranch,
      recovery: `Rerun publish-default for ${record.id}; it will repair tracking without creating another metadata commit.`,
    });
  }
  return writeResult({
    ok: true,
    command: 'publish-default',
    dryRun: false,
    id: record.id,
    previousDefaultCommit: remoteDefaultHead,
    publishedCommit,
    defaultBranch,
    fastForward: true,
    gates,
  });
}

function parseCommits(options) {
  const raw = options.commits || options.commit || '';
  const commits = String(raw).split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  if (commits.length === 0) throw new Error('At least one --commit or --commits value is required.');
  return commits;
}

function githubCompareUrl(originUrl, branch) {
  const parsed = parseRepositoryUrl(originUrl);
  if (!parsed.github) return '';
  return `https://github.com/${parsed.github.owner}/${parsed.github.repo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}

async function promoteVariant(rawOptions) {
  if (rawOptions['skip-verify']) throw new Error('Core integration verification cannot be skipped.');
  const options = await promptFor(rawOptions, [
    { key: 'id', label: '英文代号' },
    { key: 'commits', label: '要反哺的提交号（多个用逗号分隔）' },
  ]);
  const coreRoot = resolveCoreRoot(options.root || process.cwd());
  const record = findVariantWorktree(coreRoot, options.id);
  const remote = findVariantRemote(coreRoot, record, true);
  const remoteBranch = record.metadata.delivery.remoteBranch;
  const commits = parseCommits(options);

  if (git(coreRoot, ['branch', '--show-current']).stdout !== 'main') throw new Error('The primary Lumi worktree must be on main.');
  assertClean(coreRoot, 'Lumi main worktree');
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { label: 'Fast-forward Lumi main' });
  git(coreRoot, ['fetch', remote, remoteBranch], { label: `Fetch ${record.id} delivery branch` });
  const resolved = commits.map(commit => git(coreRoot, ['rev-parse', `${commit}^{commit}`]).stdout);
  for (const commit of resolved) {
    if (!git(coreRoot, ['merge-base', '--is-ancestor', commit, `${remote}/${remoteBranch}`], { allowFailure: true }).ok) {
      throw new Error(`Commit ${commit} is not part of ${remote}/${remoteBranch}.`);
    }
    const parents = git(coreRoot, ['rev-list', '--parents', '-n', '1', commit]).stdout.split(/\s+/);
    if (parents.length > 2) throw new Error(`Merge commit ${commit} must be split into linear generic commits before promotion.`);
    if (git(coreRoot, ['merge-base', '--is-ancestor', commit, 'main'], { allowFailure: true }).ok) {
      throw new Error(`Commit ${commit} is already present in main.`);
    }
  }

  const short = resolved[0].slice(0, 8);
  const branch = options.branch || `integrate/${record.id}-${short}`;
  if (!/^integrate\/[a-z0-9][a-z0-9._/-]*$/i.test(branch)) throw new Error('Integration branch name is invalid.');
  if (branchExists(coreRoot, branch)) throw new Error(`Integration branch ${branch} already exists.`);

  git(coreRoot, ['switch', '-c', branch, 'main'], { label: `Create ${branch}` });
  let completed = false;
  try {
    git(coreRoot, ['cherry-pick', ...resolved], { label: `Integrate ${record.id} commits` });
    const gates = verifyVariant(coreRoot);
    git(coreRoot, ['push', '-u', 'origin', branch], { label: `Push ${branch}` });
    completed = true;
    return writeResult({
      ok: true,
      command: 'promote',
      id: record.id,
      commits: resolved,
      integrationBranch: branch,
      gates,
      pullRequestUrl: githubCompareUrl(remoteUrl(coreRoot, 'origin'), branch),
    });
  } finally {
    if (completed) git(coreRoot, ['switch', 'main'], { label: 'Return to Lumi main' });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === 'new') return createVariant(options);
  if (command === 'status') return statusVariants(options);
  if (command === 'sync') return syncVariants(options);
  if (command === 'publish-default') return publishDefaultBranch(options);
  if (command === 'promote') return promoteVariant(options);
  throw new Error('Usage: variant-manager.mjs <new|status|sync|publish-default|promote> [options]');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && samePath(fileURLToPath(import.meta.url), invokedPath)) {
  main().catch(error => {
    console.error(`[variant-manager] ${error.message}`);
    if (error.releaseState) {
      console.error(JSON.stringify({ ok: false, releaseState: error.releaseState }, null, 2));
    }
    process.exitCode = 1;
  });
}
