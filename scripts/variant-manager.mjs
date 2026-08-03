import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const GIT = 'git';
const RESERVED_VARIANT_IDS = new Set(['main', 'master', 'origin', 'upstream']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
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
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length);
    return worktree ? [{ worktree, branch }] : [];
  });
}

function resolveCoreRoot(start = process.cwd()) {
  const probe = path.resolve(start);
  const worktrees = parseWorktrees(git(probe, ['worktree', 'list', '--porcelain']).stdout);
  const main = worktrees.find(item => item.branch === 'refs/heads/main');
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

export function buildVariantMetadata({ id, displayName, productLine, upstreamRepository, baselineCommit, repository }) {
  return {
    schemaVersion: 1,
    variantId: normalizeVariantId(id),
    displayName: validateDisplayName(displayName),
    productLine: String(productLine || id).trim() || id,
    upstream: {
      repository: upstreamRepository,
      branch: 'main',
      baselineCommit,
      lastSyncedCommit: baselineCommit,
    },
    repository,
    syncPolicy: {
      coreToVariant: 'merge reviewed upstream releases',
      variantToCore: 'cherry-pick reviewed generic commits',
    },
    createdAt: new Date().toISOString(),
  };
}

function renderWorkspace(paths, displayName) {
  return `${JSON.stringify({
    folders: [{ name: displayName, path: path.basename(paths.worktree) }],
    settings: {
      'git.autofetch': true,
      'files.exclude': {
        '**/.codex-run': true,
        '**/src-tauri/target': true,
      },
      'search.exclude': {
        '**/node_modules': true,
        '**/src-tauri/target': true,
      },
    },
  }, null, 2)}\n`;
}

function renderDevelopmentGuide(displayName) {
  return `# ${displayName}开发约定

本仓库是 Lumi 主程序的独立定制版。上游基线、仓库地址和同步策略记录在 \`.lumi/variant.json\`。

## 开发边界

- 客户界面、业务流程、行业技能、交付配置和集成适配在本仓库开发。
- 不因定制需求重写 Lumi 核心意图、回执、身份隔离、记忆隔离、安全确认和模型路由逻辑。
- 不提交客户数据、个人信息、数据库、日志、语音数据、安装包、API 密钥或其他凭据。
- 客户专属修改与可复用的通用修改必须分开提交。

## 分支和提交

- 从子仓库 \`main\` 创建 \`feature/*\` 分支开发定制功能。
- 可反哺主程序的通用修改使用独立的 \`contrib/*\` 分支和独立提交。
- 所有修改通过 Pull Request 合入子仓库 \`main\`。
- 主程序升级由核心维护人员审核后同步；业务开发人员不直接修改主仓库。

## 本地启动

\`\`\`powershell
npm ci
npm run dev
\`\`\`

Tauri 原生客户端开发：

\`\`\`powershell
npm run tauri:dev
\`\`\`

## 双向同步

- 主程序到定制版：核心维护人员运行 \`npm run variant:sync\`，将经过验收的上游版本合入子仓库。
- 定制版到主程序：核心维护人员运行 \`npm run variant:promote\`，提取无客户数据、无业务耦合的通用提交并创建主仓库集成分支。
`;
}

function branchExists(coreRoot, branch) {
  return git(coreRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
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

function findVariantWorktree(coreRoot, id) {
  const paths = buildVariantPaths(coreRoot, id);
  const worktrees = parseWorktrees(git(coreRoot, ['worktree', 'list', '--porcelain']).stdout);
  const match = worktrees.find(item => item.branch === `refs/heads/${paths.branch}`);
  if (!match) throw new Error(`Variant worktree ${paths.branch} was not found. Run npm run variant:new first.`);
  paths.worktree = path.resolve(match.worktree);
  paths.workspace = path.join(path.dirname(paths.worktree), `${path.basename(paths.worktree)}.code-workspace`);
  return paths;
}

function readMetadata(worktree) {
  const metadataPath = path.join(worktree, '.lumi', 'variant.json');
  if (!fs.existsSync(metadataPath)) throw new Error(`Variant metadata is missing: ${metadataPath}`);
  return { metadataPath, metadata: JSON.parse(fs.readFileSync(metadataPath, 'utf8')) };
}

function findVariantRemote(coreRoot, paths, metadata) {
  const expected = String(metadata.repository || '').trim();
  const preferred = remoteUrl(coreRoot, paths.remote);
  if (preferred) {
    if (preferred !== expected) throw new Error(`Remote ${paths.remote} does not match variant metadata.`);
    return paths.remote;
  }
  const remotes = git(coreRoot, ['remote']).stdout.split(/\r?\n/).filter(Boolean);
  const match = remotes.find(remote => remoteUrl(coreRoot, remote) === expected);
  if (match) return match;
  ensureRemote(coreRoot, paths.remote, expected);
  return paths.remote;
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
  if (skipInstall || fs.existsSync(path.join(worktree, 'node_modules'))) return;
  runNpm(['ci'], { cwd: worktree, inherit: true });
}

function verifyVariant(worktree, skipVerify) {
  if (skipVerify) return;
  installDependencies(worktree, false);
  runNpm(['run', 'lint'], { cwd: worktree, inherit: true });
  runNpm(['test', '--', '--run'], { cwd: worktree, inherit: true });
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
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { inherit: true });
  const baselineCommit = git(coreRoot, ['rev-parse', 'main']).stdout;
  const upstreamRepository = remoteUrl(coreRoot, 'origin');
  if (!upstreamRepository) throw new Error('The Lumi main repository requires an origin remote.');
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
    git(coreRoot, ['worktree', 'add', '-b', paths.branch, paths.worktree, 'main'], { inherit: true });
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
    });
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  } else {
    const existing = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
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
    git(paths.worktree, ['commit', '-m', `chore: initialize ${id} variant`], { inherit: true });
  }
  if (!options['skip-push']) {
    git(paths.worktree, ['push', '-u', paths.remote, 'HEAD:main'], { inherit: true });
  }
  if (!options['skip-open']) {
    const opened = runCode(['-n', paths.workspace], { cwd: paths.worktree, allowFailure: true });
    if (!opened.ok) console.warn(`VS Code could not be opened automatically. Open ${paths.workspace} manually.`);
  }
  console.log(JSON.stringify({
    ok: true,
    command: 'new',
    id,
    displayName,
    branch: paths.branch,
    worktree: paths.worktree,
    workspace: paths.workspace,
    repository: parsedRepository.repository,
    upstreamCommit: baselineCommit,
  }, null, 2));
}

async function syncVariant(rawOptions) {
  const options = await promptFor(rawOptions, [{ key: 'id', label: '英文代号' }]);
  const coreRoot = resolveCoreRoot(options.root || process.cwd());
  const paths = findVariantWorktree(coreRoot, options.id);
  const { metadataPath, metadata } = readMetadata(paths.worktree);
  const remote = findVariantRemote(coreRoot, paths, metadata);

  if (git(coreRoot, ['branch', '--show-current']).stdout !== 'main') throw new Error('The primary Lumi worktree must be on main.');
  assertClean(coreRoot, 'Lumi main worktree');
  assertClean(paths.worktree, `${paths.id} worktree`);
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { inherit: true });
  git(paths.worktree, ['pull', '--ff-only', remote, 'main'], { inherit: true });
  git(paths.worktree, ['merge', '--no-edit', 'main'], { inherit: true });

  const syncedCommit = git(coreRoot, ['rev-parse', 'main']).stdout;
  if (metadata.upstream?.lastSyncedCommit !== syncedCommit) {
    metadata.upstream = { ...metadata.upstream, lastSyncedCommit: syncedCommit };
    metadata.lastSyncedAt = new Date().toISOString();
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    git(paths.worktree, ['add', '--', '.lumi/variant.json']);
    git(paths.worktree, ['commit', '-m', 'chore: record Lumi core synchronization'], { inherit: true });
  }
  verifyVariant(paths.worktree, Boolean(options['skip-verify']));
  git(paths.worktree, ['push', remote, 'HEAD:main'], { inherit: true });
  console.log(JSON.stringify({
    ok: true,
    command: 'sync',
    id: paths.id,
    upstreamCommit: syncedCommit,
    variantCommit: git(paths.worktree, ['rev-parse', 'HEAD']).stdout,
    repository: metadata.repository,
  }, null, 2));
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
  const options = await promptFor(rawOptions, [
    { key: 'id', label: '英文代号' },
    { key: 'commits', label: '要反哺的提交号（多个用逗号分隔）' },
  ]);
  const coreRoot = resolveCoreRoot(options.root || process.cwd());
  const paths = findVariantWorktree(coreRoot, options.id);
  const { metadata } = readMetadata(paths.worktree);
  const remote = findVariantRemote(coreRoot, paths, metadata);
  const commits = parseCommits(options);

  if (git(coreRoot, ['branch', '--show-current']).stdout !== 'main') throw new Error('The primary Lumi worktree must be on main.');
  assertClean(coreRoot, 'Lumi main worktree');
  git(coreRoot, ['pull', '--ff-only', 'origin', 'main'], { inherit: true });
  git(coreRoot, ['fetch', remote, 'main'], { inherit: true });
  const resolved = commits.map(commit => git(coreRoot, ['rev-parse', `${commit}^{commit}`]).stdout);
  for (const commit of resolved) {
    if (!git(coreRoot, ['merge-base', '--is-ancestor', commit, `${remote}/main`], { allowFailure: true }).ok) {
      throw new Error(`Commit ${commit} is not part of ${remote}/main.`);
    }
    const parents = git(coreRoot, ['rev-list', '--parents', '-n', '1', commit]).stdout.split(/\s+/);
    if (parents.length > 2) throw new Error(`Merge commit ${commit} must be split into linear generic commits before promotion.`);
    if (git(coreRoot, ['merge-base', '--is-ancestor', commit, 'main'], { allowFailure: true }).ok) {
      throw new Error(`Commit ${commit} is already present in main.`);
    }
  }

  const short = resolved[0].slice(0, 8);
  const branch = options.branch || `integrate/${paths.id}-${short}`;
  if (!/^integrate\/[a-z0-9][a-z0-9._/-]*$/i.test(branch)) throw new Error('Integration branch name is invalid.');
  if (branchExists(coreRoot, branch)) throw new Error(`Integration branch ${branch} already exists.`);

  git(coreRoot, ['switch', '-c', branch, 'main'], { inherit: true });
  let completed = false;
  try {
    git(coreRoot, ['cherry-pick', ...resolved], { inherit: true });
    verifyVariant(coreRoot, Boolean(options['skip-verify']));
    git(coreRoot, ['push', '-u', 'origin', branch], { inherit: true });
    completed = true;
  } finally {
    if (completed) git(coreRoot, ['switch', 'main'], { inherit: true });
  }
  console.log(JSON.stringify({
    ok: true,
    command: 'promote',
    id: paths.id,
    commits: resolved,
    integrationBranch: branch,
    pullRequestUrl: githubCompareUrl(remoteUrl(coreRoot, 'origin'), branch),
  }, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === 'new') return createVariant(options);
  if (command === 'sync') return syncVariant(options);
  if (command === 'promote') return promoteVariant(options);
  throw new Error('Usage: variant-manager.mjs <new|sync|promote> [options]');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && samePath(fileURLToPath(import.meta.url), invokedPath)) {
  main().catch(error => {
    console.error(`[variant-manager] ${error.message}`);
    process.exitCode = 1;
  });
}
