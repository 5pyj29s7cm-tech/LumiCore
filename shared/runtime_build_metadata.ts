import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeBuildMetadata {
  schemaVersion: 1;
  name: string;
  version: string;
  buildId: string;
  sourceFingerprint?: string;
  sourceDirty?: boolean;
  builtAt: string;
  channel: string;
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRuntimeBuildMetadata(value: unknown): RuntimeBuildMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const name = compact(candidate.name);
  const version = compact(candidate.version);
  const buildId = compact(candidate.buildId);
  const sourceFingerprint = compact(candidate.sourceFingerprint);
  const sourceDirty = typeof candidate.sourceDirty === 'boolean' ? candidate.sourceDirty : undefined;
  const builtAt = compact(candidate.builtAt);
  const channel = compact(candidate.channel);
  if (candidate.schemaVersion !== 1 || !name || !version || !buildId || !builtAt || !channel) return null;
  if ((sourceFingerprint && sourceDirty === undefined) || (!sourceFingerprint && sourceDirty !== undefined)) return null;
  if (sourceFingerprint && !/^[a-f0-9]{64}$/i.test(sourceFingerprint)) return null;
  if (version === '0.0.0') return null;
  if (Number.isNaN(Date.parse(builtAt))) return null;
  return {
    schemaVersion: 1,
    name,
    version,
    buildId,
    ...(sourceFingerprint ? { sourceFingerprint, sourceDirty } : {}),
    builtAt,
    channel,
  };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readGitBuildId(root: string): string {
  try {
    const gitPath = path.join(root, '.git');
    const stat = fs.statSync(gitPath);
    let gitDir = gitPath;
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return '';
      gitDir = path.resolve(root, pointer);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ...ref.split('/')), 'utf8').trim();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      return packed.split(/\r?\n/).find(line => line.endsWith(` ${ref}`))?.split(' ')[0] || '';
    }
  } catch {
    return '';
  }
}

export function loadRuntimeBuildMetadata(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
} = {}): RuntimeBuildMetadata {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const explicitFile = compact(env.LUMI_RUNTIME_META_FILE);
  const metadataPath = explicitFile ? path.resolve(explicitFile) : path.join(cwd, 'runtime-meta.json');
  const packaged = normalizeRuntimeBuildMetadata(readJson(metadataPath));
  if (packaged) return packaged;

  const packageMeta = (readJson(path.join(cwd, 'package.json')) || {}) as Record<string, unknown>;
  const version = compact(env.LUMI_VERSION)
    || compact(env.LUMI_APP_VERSION)
    || compact(packageMeta.version)
    || 'development';
  return {
    schemaVersion: 1,
    name: compact(packageMeta.name) || 'lumi-core',
    version: version === '0.0.0' ? 'development' : version,
    buildId: compact(env.LUMI_BUILD_ID)
      || compact(env.GIT_COMMIT)
      || readGitBuildId(cwd)
      || 'development',
    builtAt: compact(env.LUMI_BUILT_AT) || options.now || new Date().toISOString(),
    channel: compact(env.LUMI_RELEASE_CHANNEL) || 'internal',
  };
}
