import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TASK_REGRESSION_BUILD_IDENTITY_KIND = 'lumi_task_regression_build_identity';
export const TASK_REGRESSION_BUILD_IDENTITY_SCHEMA_VERSION = 1;
export const TASK_REGRESSION_UNTRACKED_SOURCE_POLICY = 'source-files-v2';
export const TASK_REGRESSION_MATRIX_BUILD_IDENTITY_KIND = 'lumi.task-regression-build-identity';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MODE_RE = /^(?:0{6}|[0-7]{6})$/;
const CANONICAL_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_ATTEMPTS = 3;

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.css', '.graphql', '.gql', '.h', '.hpp',
  '.html', '.java', '.js', '.jsx', '.json', '.jsonc', '.kt', '.kts', '.mjs',
  '.mts', '.cts', '.py', '.rs', '.scss', '.sql', '.svg', '.toml', '.ts',
  '.tsx', '.vue', '.wasm', '.yaml', '.yml',
]);

const EXCLUDED_ROOT_DIRECTORIES = new Set([
  '.cache', '.codex', '.git', '.lumi', '.next', '.output', '.turbo',
  'artifacts', 'build', 'coverage', 'data', 'dist', 'dist-electron',
  'dist-server', 'evidence', 'logs', 'node_modules', 'out', 'target', 'temp',
  'tmp', 'uploads',
]);
const EXCLUDED_ANY_LEVEL_DIRECTORIES = new Set([
  '.git', 'credentials', 'node_modules', 'secrets',
]);
const KNOWN_GENERATED_SUBTREE_PREFIXES = Object.freeze([
  'android/.gradle/',
  'android/app/build/',
  'ios/app/pods/',
  'src-tauri/target/',
]);

const SENSITIVE_FILE_RE = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|secrets?(?:\..*)?)$/i;
const SENSITIVE_EXTENSION_RE = /\.(?:der|key|p12|pfx|pem)$/i;
const LOCKFILE_BASENAMES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.lock', 'npm-shrinkwrap.json',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

const IDENTITY_BASIS = Object.freeze([
  'head_commit',
  'tracked_worktree_changes',
  'selected_untracked_source_files',
  'dependency_lockfiles',
  'allowlisted_build_environment',
]);

const BUILD_PLATFORMS = new Set([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32',
]);
const BUILD_ARCHITECTURES = new Set([
  'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64',
  'riscv64', 's390', 's390x', 'x64',
]);

export class TaskRegressionBuildIdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TaskRegressionBuildIdentityError';
    this.code = code;
  }
}

function fail(code) {
  throw new TaskRegressionBuildIdentityError(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableTaskRegressionBuildIdentityJson(value, pretty = false) {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : 0);
}

function digestJson(value) {
  return sha256(Buffer.from(stableTaskRegressionBuildIdentityJson(value), 'utf8'));
}

function compareCanonicalPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRelativePath(value) {
  const candidate = String(value || '').replaceAll('\\', '/').normalize('NFC');
  if (!candidate || candidate.includes('\0') || candidate.startsWith('/')) {
    fail('repository_relative_path_invalid');
  }
  if (/^[a-zA-Z]:\//.test(candidate)) fail('repository_relative_path_invalid');
  const segments = candidate.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('repository_relative_path_invalid');
  }
  return segments.join('/');
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function absoluteCandidatePath(root, relativePath) {
  const candidate = path.resolve(root, ...canonicalRelativePath(relativePath).split('/'));
  if (!isPathInside(root, candidate) || candidate === root) {
    fail('repository_relative_path_escape');
  }
  return candidate;
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    fail('git_command_failed');
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function splitNull(bytes) {
  const parts = bytes.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function repositoryRoot(root) {
  const requested = path.resolve(String(root || process.cwd()));
  let canonicalRequested;
  try {
    canonicalRequested = fs.realpathSync.native(requested);
  } catch {
    fail('git_repository_unavailable');
  }
  const topLevel = git(canonicalRequested, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!topLevel) fail('git_repository_unavailable');
  const reported = topLevel.toString('utf8').trim();
  if (!reported) fail('git_repository_unavailable');
  try {
    const canonicalRoot = fs.realpathSync.native(path.resolve(reported));
    if (!isPathInside(canonicalRoot, canonicalRequested)) fail('git_repository_unavailable');
    return canonicalRoot;
  } catch (error) {
    if (error instanceof TaskRegressionBuildIdentityError) throw error;
    fail('git_repository_unavailable');
  }
}

function gitHead(root) {
  const output = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const head = output?.toString('utf8').trim().toLowerCase() || '';
  if (!GIT_OID_RE.test(head)) fail('git_head_unavailable');
  return head;
}

function gitObjectFormat(root, head) {
  const output = git(root, ['rev-parse', '--show-object-format'], { allowFailure: true });
  const format = output?.toString('utf8').trim().toLowerCase();
  if (format === 'sha1' || format === 'sha256') return format;
  return head.length === 64 ? 'sha256' : 'sha1';
}

function normalizeTextBytes(bytes) {
  if (bytes.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return Buffer.from(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 'utf8');
}

function stableFileBytes(filePath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before;
    let after;
    let bytes;
    try {
      before = fs.statSync(filePath, { bigint: true });
      bytes = fs.readFileSync(filePath);
      after = fs.statSync(filePath, { bigint: true });
    } catch {
      fail('candidate_file_unreadable');
    }
    if (
      before.isFile()
      && after.isFile()
      && before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
      && before.ctimeNs === after.ctimeNs
    ) {
      return bytes;
    }
  }
  fail('candidate_file_unstable');
}

function contentDescriptor(root, relativePath, cache) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const absolute = absoluteCandidatePath(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      cache.set(relativePath, null);
      return null;
    }
    fail('candidate_file_unreadable');
  }

  let descriptor;
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = fs.readlinkSync(absolute, 'utf8').replaceAll('\\', '/').normalize('NFC');
    } catch {
      fail('candidate_symlink_unreadable');
    }
    const bytes = Buffer.from(target, 'utf8');
    descriptor = {
      kind: 'symlink',
      normalization: 'normalized_link_target',
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  } else if (stat.isFile()) {
    const sourceBytes = stableFileBytes(absolute);
    const textBytes = normalizeTextBytes(sourceBytes);
    const bytes = textBytes || sourceBytes;
    descriptor = {
      kind: 'file',
      normalization: textBytes ? 'utf8_bomless_lf' : 'binary_exact',
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  } else if (stat.isDirectory()) {
    fail('gitlink_candidate_unsupported');
  } else {
    fail('candidate_file_type_unsupported');
  }
  cache.set(relativePath, descriptor);
  return descriptor;
}

function parseTrackedChanges(root, cache) {
  const raw = splitNull(git(root, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', 'HEAD', '--']));
  const entries = [];
  for (let index = 0; index < raw.length;) {
    const header = raw[index];
    const relativePath = raw[index + 1];
    index += 2;
    if (!header?.startsWith(':') || relativePath === undefined) fail('git_diff_format_invalid');
    const fields = header.slice(1).split(' ');
    if (fields.length !== 5) fail('git_diff_format_invalid');
    const [baseMode, candidateMode, , , rawStatus] = fields;
    if (!MODE_RE.test(baseMode) || !MODE_RE.test(candidateMode) || !/^[A-Z]$/.test(rawStatus)) {
      fail('git_diff_format_invalid');
    }
    const candidatePath = canonicalRelativePath(relativePath);
    const content = rawStatus === 'D' ? null : contentDescriptor(root, candidatePath, cache);
    if (rawStatus !== 'D' && !content) fail('tracked_candidate_missing');
    entries.push({
      path: candidatePath,
      change: ({ A: 'added', D: 'deleted', M: 'modified', T: 'type_changed', U: 'unmerged' })[rawStatus]
        || 'other',
      baseMode,
      candidateMode,
      content,
    });
  }
  return entries.sort((left, right) => compareCanonicalPaths(left.path, right.path));
}

function allUntrackedPaths(root) {
  return splitNull(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .map(canonicalRelativePath)
    .sort(compareCanonicalPaths);
}

export function isSelectedTaskRegressionUntrackedSource(relativePath) {
  let canonical;
  try {
    canonical = canonicalRelativePath(relativePath);
  } catch {
    return false;
  }
  const segments = canonical.toLowerCase().split('/');
  const basename = segments.at(-1) || '';
  const normalized = segments.join('/');
  if (EXCLUDED_ROOT_DIRECTORIES.has(segments[0])) return false;
  if (segments.some(segment => EXCLUDED_ANY_LEVEL_DIRECTORIES.has(segment))) return false;
  if (KNOWN_GENERATED_SUBTREE_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;
  if (SENSITIVE_FILE_RE.test(basename) || SENSITIVE_EXTENSION_RE.test(basename)) return false;
  if (isDependencyLockfile(canonical)) return false;
  return SOURCE_EXTENSIONS.has(path.posix.extname(basename));
}

function selectedUntrackedSources(root, paths, cache) {
  return paths
    .filter(isSelectedTaskRegressionUntrackedSource)
    .map(relativePath => {
      const content = contentDescriptor(root, relativePath, cache);
      if (!content) fail('untracked_candidate_missing');
      return { path: relativePath, content };
    });
}

function isDependencyLockfile(relativePath) {
  const basename = canonicalRelativePath(relativePath).split('/').at(-1).toLowerCase();
  return LOCKFILE_BASENAMES.has(basename);
}

function dependencyLockfiles(root, untrackedPaths, trackedChanges, cache) {
  const trackedPaths = splitNull(git(root, ['ls-files', '-z']))
    .map(canonicalRelativePath)
    .filter(isDependencyLockfile);
  const provenance = new Map();
  for (const relativePath of trackedPaths) provenance.set(relativePath, 'tracked');
  for (const entry of trackedChanges) {
    if (isDependencyLockfile(entry.path)) provenance.set(entry.path, 'tracked');
  }
  for (const relativePath of untrackedPaths.filter(isDependencyLockfile)) {
    if (!provenance.has(relativePath)) provenance.set(relativePath, 'untracked');
  }
  return [...provenance]
    .sort(([left], [right]) => compareCanonicalPaths(left, right))
    .map(([relativePath, source]) => {
      const content = contentDescriptor(root, relativePath, cache);
      return {
        path: relativePath,
        provenance: source,
        state: content ? 'present' : 'deleted',
        content,
      };
    });
}

function safeEnvironmentField(value, code, kind) {
  const normalized = String(value || '').trim().toLowerCase();
  const valid = kind === 'platform'
    ? BUILD_PLATFORMS.has(normalized)
    : kind === 'architecture'
      ? BUILD_ARCHITECTURES.has(normalized)
      : kind === 'nodeVersion'
        ? /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-z0-9.-]{1,24})?$/.test(normalized)
        : /^(?:\d{1,5}|unknown)$/.test(normalized);
  if (!valid) fail(code);
  return normalized;
}

function buildEnvironment(overrides, objectFormat) {
  const source = overrides || {};
  return {
    platform: safeEnvironmentField(source.platform || process.platform, 'build_platform_invalid', 'platform'),
    architecture: safeEnvironmentField(source.architecture || process.arch, 'build_architecture_invalid', 'architecture'),
    nodeVersion: safeEnvironmentField(source.nodeVersion || process.versions.node, 'build_node_version_invalid', 'nodeVersion'),
    nodeAbi: safeEnvironmentField(source.nodeAbi || process.versions.modules || 'unknown', 'build_node_abi_invalid', 'nodeAbi'),
    repositoryObjectFormat: objectFormat,
  };
}

function capture(root, environmentOverrides) {
  const headCommit = gitHead(root);
  const objectFormat = gitObjectFormat(root, headCommit);
  const cache = new Map();
  const untrackedPaths = allUntrackedPaths(root);
  const trackedFiles = parseTrackedChanges(root, cache);
  const untrackedFiles = selectedUntrackedSources(root, untrackedPaths, cache);
  const lockfiles = dependencyLockfiles(root, untrackedPaths, trackedFiles, cache);
  const environment = buildEnvironment(environmentOverrides, objectFormat);

  const trackedChanges = {
    count: trackedFiles.length,
    digest: digestJson(trackedFiles),
    files: trackedFiles,
  };
  const selectedUntrackedSourcesManifest = {
    policy: TASK_REGRESSION_UNTRACKED_SOURCE_POLICY,
    count: untrackedFiles.length,
    digest: digestJson(untrackedFiles),
    files: untrackedFiles,
  };
  const dependencyLockfilesManifest = {
    count: lockfiles.length,
    digest: digestJson(lockfiles),
    files: lockfiles,
  };
  const sourceBasis = {
    headCommit,
    repositoryObjectFormat: objectFormat,
    trackedChanges,
    selectedUntrackedSources: selectedUntrackedSourcesManifest,
    dependencyLockfiles: dependencyLockfilesManifest,
  };
  const sourceFingerprint = digestJson(sourceBasis);
  const buildIdentity = digestJson({ sourceFingerprint, environment });
  const dirty = trackedFiles.length > 0
    || untrackedFiles.length > 0
    || lockfiles.some(entry => entry.provenance === 'untracked');

  return {
    ok: true,
    kind: TASK_REGRESSION_BUILD_IDENTITY_KIND,
    schemaVersion: TASK_REGRESSION_BUILD_IDENTITY_SCHEMA_VERSION,
    hashAlgorithm: 'sha256',
    identityScope: 'head_plus_worktree_plus_dependencies_plus_environment',
    identityBasis: [...IDENTITY_BASIS],
    candidate: {
      ...sourceBasis,
      dirty,
    },
    environment,
    sourceFingerprint,
    buildIdentity,
    privacy: {
      absolutePathsIncluded: false,
      fileContentsIncluded: false,
      processEnvironmentIncluded: false,
      repositoryRelativePathsOnly: true,
    },
  };
}

function validatePathManifest(files, errors, prefix, { tracked = false, lockfiles = false } = {}) {
  if (!Array.isArray(files)) {
    errors.push(`${prefix}_files_missing`);
    return;
  }
  const paths = [];
  for (const [index, entry] of files.entries()) {
    const itemPrefix = `${prefix}_${index}`;
    let relativePath;
    try {
      relativePath = canonicalRelativePath(entry?.path);
    } catch {
      errors.push(`${itemPrefix}_path_invalid`);
      continue;
    }
    if (relativePath !== entry.path) errors.push(`${itemPrefix}_path_not_canonical`);
    paths.push(relativePath);
    if (tracked) {
      if (!['added', 'deleted', 'modified', 'type_changed', 'unmerged', 'other'].includes(entry?.change)) {
        errors.push(`${itemPrefix}_change_invalid`);
      }
      if (!MODE_RE.test(String(entry?.baseMode || '')) || !MODE_RE.test(String(entry?.candidateMode || ''))) {
        errors.push(`${itemPrefix}_mode_invalid`);
      }
    }
    if (lockfiles && (!isDependencyLockfile(relativePath)
      || !['tracked', 'untracked'].includes(entry?.provenance)
      || !['present', 'deleted'].includes(entry?.state))) {
      errors.push(`${itemPrefix}_lockfile_invalid`);
    }
    const content = entry?.content;
    if (content !== null) {
      if (!['file', 'symlink'].includes(content?.kind)
        || !['utf8_bomless_lf', 'binary_exact', 'normalized_link_target'].includes(content?.normalization)
        || !Number.isSafeInteger(content?.byteLength)
        || content.byteLength < 0
        || !SHA256_RE.test(String(content?.sha256 || ''))) {
        errors.push(`${itemPrefix}_content_invalid`);
      }
    } else if ((tracked && entry?.change !== 'deleted') || (lockfiles && entry?.state !== 'deleted')) {
      errors.push(`${itemPrefix}_content_missing`);
    }
  }
  const sorted = [...paths].sort(compareCanonicalPaths);
  if (new Set(paths).size !== paths.length || stableTaskRegressionBuildIdentityJson(paths) !== stableTaskRegressionBuildIdentityJson(sorted)) {
    errors.push(`${prefix}_paths_not_unique_sorted`);
  }
}

export function verifyTaskRegressionBuildIdentity(value) {
  const errors = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['identity_document_missing'] };
  if (value.ok !== true) errors.push('identity_success_marker_invalid');
  if (value.kind !== TASK_REGRESSION_BUILD_IDENTITY_KIND) errors.push('identity_kind_invalid');
  if (value.schemaVersion !== TASK_REGRESSION_BUILD_IDENTITY_SCHEMA_VERSION) errors.push('identity_schema_invalid');
  if (value.hashAlgorithm !== 'sha256') errors.push('identity_hash_algorithm_invalid');
  if (value.identityScope !== 'head_plus_worktree_plus_dependencies_plus_environment') {
    errors.push('identity_scope_invalid');
  }
  if (stableTaskRegressionBuildIdentityJson(value.identityBasis) !== stableTaskRegressionBuildIdentityJson(IDENTITY_BASIS)) {
    errors.push('identity_basis_incomplete');
  }
  const candidate = value.candidate;
  if (!candidate || typeof candidate !== 'object') {
    errors.push('identity_candidate_missing');
    return { ok: false, errors };
  }
  if (!GIT_OID_RE.test(String(candidate.headCommit || ''))) errors.push('identity_head_invalid');
  if (!['sha1', 'sha256'].includes(candidate.repositoryObjectFormat)) errors.push('identity_object_format_invalid');

  const tracked = candidate.trackedChanges;
  const untracked = candidate.selectedUntrackedSources;
  const locks = candidate.dependencyLockfiles;
  validatePathManifest(tracked?.files, errors, 'tracked', { tracked: true });
  validatePathManifest(untracked?.files, errors, 'untracked');
  validatePathManifest(locks?.files, errors, 'lockfiles', { lockfiles: true });
  for (const [name, manifest] of [['tracked', tracked], ['untracked', untracked], ['lockfiles', locks]]) {
    if (!manifest || manifest.count !== manifest.files?.length) errors.push(`${name}_count_invalid`);
    if (!SHA256_RE.test(String(manifest?.digest || ''))
      || manifest?.digest !== digestJson(manifest?.files || [])) errors.push(`${name}_digest_invalid`);
  }
  if (untracked?.policy !== TASK_REGRESSION_UNTRACKED_SOURCE_POLICY) errors.push('untracked_policy_invalid');
  const expectedDirty = Boolean(
    tracked?.files?.length
    || untracked?.files?.length
    || locks?.files?.some(entry => entry?.provenance === 'untracked'),
  );
  if (candidate.dirty !== expectedDirty) errors.push('candidate_dirty_invalid');

  const environment = value.environment;
  if (!environment || typeof environment !== 'object') {
    errors.push('identity_environment_missing');
  } else {
    for (const field of ['platform', 'architecture', 'nodeVersion', 'nodeAbi']) {
      try {
        const kind = field === 'nodeAbi' ? 'nodeAbi' : field;
        safeEnvironmentField(environment[field], `identity_environment_${field}_invalid`, kind);
      } catch {
        errors.push(`identity_environment_${field}_invalid`);
      }
    }
    if (environment.repositoryObjectFormat !== candidate.repositoryObjectFormat) {
      errors.push('identity_environment_object_format_invalid');
    }
  }

  const sourceBasis = {
    headCommit: candidate.headCommit,
    repositoryObjectFormat: candidate.repositoryObjectFormat,
    trackedChanges: tracked,
    selectedUntrackedSources: untracked,
    dependencyLockfiles: locks,
  };
  const expectedSourceFingerprint = digestJson(sourceBasis);
  if (!SHA256_RE.test(String(value.sourceFingerprint || ''))
    || value.sourceFingerprint !== expectedSourceFingerprint) errors.push('source_fingerprint_invalid');
  const expectedBuildIdentity = digestJson({ sourceFingerprint: expectedSourceFingerprint, environment });
  if (!SHA256_RE.test(String(value.buildIdentity || ''))
    || value.buildIdentity !== expectedBuildIdentity) errors.push('build_identity_invalid');
  if (value.buildIdentity === sha256(Buffer.from(String(candidate.headCommit || ''), 'utf8'))) {
    errors.push('head_only_identity_rejected');
  }
  if (value.privacy?.absolutePathsIncluded !== false
    || value.privacy?.fileContentsIncluded !== false
    || value.privacy?.processEnvironmentIncluded !== false
    || value.privacy?.repositoryRelativePathsOnly !== true) {
    errors.push('identity_privacy_contract_invalid');
  }
  return { ok: errors.length === 0, errors };
}

export function assertTaskRegressionBuildIdentity(value) {
  const verification = verifyTaskRegressionBuildIdentity(value);
  if (!verification.ok) fail(verification.errors[0] || 'build_identity_invalid');
  return value;
}

function canonicalCollectedAt(value) {
  if (typeof value !== 'string'
    || !CANONICAL_ISO_INSTANT_RE.test(value)
    || !Number.isFinite(Date.parse(value))) {
    fail('matrix_build_identity_collected_at_invalid');
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail('matrix_build_identity_collected_at_invalid');
  }
  if (canonical !== value) fail('matrix_build_identity_collected_at_invalid');
  return value;
}

function sourceDerivedDigests(identity) {
  const values = new Set([
    identity.sourceFingerprint,
    identity.buildIdentity,
    identity.candidate?.trackedChanges?.digest,
    identity.candidate?.selectedUntrackedSources?.digest,
    identity.candidate?.dependencyLockfiles?.digest,
  ]);
  for (const manifest of [
    identity.candidate?.trackedChanges,
    identity.candidate?.selectedUntrackedSources,
    identity.candidate?.dependencyLockfiles,
  ]) {
    for (const entry of manifest?.files || []) values.add(entry?.content?.sha256);
  }
  const revision = String(identity.candidate?.headCommit || '');
  if (SHA256_RE.test(revision)) values.add(revision);
  if (GIT_OID_RE.test(revision)) {
    values.add(sha256(Buffer.from(revision, 'utf8')));
    values.add(sha256(Buffer.from(revision, 'hex')));
  }
  return new Set([...values].filter(value => SHA256_RE.test(String(value || ''))));
}

function verifyRuntimeArtifactFile(runtimeArtifactPath, expectedSha256) {
  if (typeof runtimeArtifactPath !== 'string' || !path.isAbsolute(runtimeArtifactPath)) {
    fail('runtime_artifact_path_required');
  }
  const lexicalPath = path.resolve(runtimeArtifactPath);
  let lexicalStat;
  let canonicalPath;
  try {
    lexicalStat = fs.lstatSync(lexicalPath);
    canonicalPath = fs.realpathSync.native(lexicalPath);
  } catch {
    fail('runtime_artifact_unreadable');
  }
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
    fail('runtime_artifact_regular_file_required');
  }
  const bytes = stableFileBytes(canonicalPath);
  if (sha256(bytes) !== expectedSha256) fail('runtime_artifact_sha256_mismatch');
}

export function projectTaskRegressionMatrixBuildIdentity(identity, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('matrix_build_identity_projection_options_invalid');
  }
  const optionKeys = Object.keys(options).sort();
  if (optionKeys.some(key => !['collectedAt', 'runtimeArtifactPath', 'runtimeArtifactSha256'].includes(key))) {
    fail('matrix_build_identity_projection_options_invalid');
  }
  const { runtimeArtifactPath, runtimeArtifactSha256, collectedAt } = options;
  const verifiedIdentity = assertTaskRegressionBuildIdentity(identity);
  if (typeof runtimeArtifactSha256 !== 'string' || !SHA256_RE.test(runtimeArtifactSha256)) {
    fail('runtime_artifact_sha256_required');
  }
  if (sourceDerivedDigests(verifiedIdentity).has(runtimeArtifactSha256)) {
    fail('runtime_artifact_sha256_not_independent');
  }
  verifyRuntimeArtifactFile(runtimeArtifactPath, runtimeArtifactSha256);
  return {
    kind: TASK_REGRESSION_MATRIX_BUILD_IDENTITY_KIND,
    revision: verifiedIdentity.candidate.headCommit,
    sourceFingerprintSha256: verifiedIdentity.sourceFingerprint,
    sourceDirty: verifiedIdentity.candidate.dirty,
    runtimeFingerprintSha256: runtimeArtifactSha256,
    collectedAt: canonicalCollectedAt(collectedAt),
  };
}

export function computeTaskRegressionBuildIdentity(root = process.cwd(), options = {}) {
  const canonicalRoot = repositoryRoot(root);
  const maxAttempts = Number.isInteger(options.maxSnapshotAttempts)
    ? Math.max(2, Math.min(10, options.maxSnapshotAttempts))
    : MAX_SNAPSHOT_ATTEMPTS;
  let prior = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = capture(canonicalRoot, options.environment);
    const serialized = stableTaskRegressionBuildIdentityJson(current);
    if (prior === serialized) return assertTaskRegressionBuildIdentity(current);
    prior = serialized;
  }
  fail('candidate_snapshot_unstable');
}
