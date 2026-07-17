const VITE_IGNORED_ROOT_DIRECTORIES = [
  // Native/compiler output. Cargo has its own watcher during `tauri dev`.
  'src-tauri/target',
  'src-tauri/gen',

  // Local models and packaged runtime copies are immutable inputs to the UI.
  'local-tts',
  'gpt-sovits-src',
  'desktop-resources',

  // Runtime/generated state must never trigger frontend HMR.
  '.codex-run',
  '.lumi-runtime',
  '.tmp',
  'tmp',
  'data',
  'logs',
  'lumi_output',
  'release-out',

  // Build and test output/source are outside the frontend HMR graph.
  'dist',
  'dist-server',
  'coverage',
  'test',
  'tests',

  // Vite serves the frontend only. Backend changes are applied by the
  // supervised server restart flow, not by frontend HMR.
  'server',
] as const;

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function toProjectRelativePath(watchedPath: string, projectRoot: string): string | null {
  const normalizedPath = normalizeSlashes(String(watchedPath || '').trim());
  const normalizedRoot = normalizeSlashes(String(projectRoot || '').trim());
  if (!normalizedPath) return '';

  const comparablePath = normalizedPath.toLowerCase();
  const comparableRoot = normalizedRoot.toLowerCase();
  if (comparablePath === comparableRoot) return '';
  if (comparableRoot && comparablePath.startsWith(`${comparableRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  // Chokidar can supply either absolute paths or paths relative to its root.
  // An absolute path outside this project must not be filtered accidentally.
  if (isAbsoluteLike(normalizedPath)) return null;
  return normalizedPath.replace(/^\.\//, '');
}

function isAtOrBelow(relativePath: string, directory: string): boolean {
  const path = relativePath.toLowerCase();
  const root = directory.toLowerCase();
  return path === root || path.startsWith(`${root}/`);
}

export function shouldIgnoreViteWatchPath(watchedPath: string, projectRoot: string): boolean {
  const relativePath = toProjectRelativePath(watchedPath, projectRoot);
  if (relativePath === null || !relativePath) return false;

  if (VITE_IGNORED_ROOT_DIRECTORIES.some(directory => isAtOrBelow(relativePath, directory))) {
    return true;
  }

  const lower = relativePath.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf('/') + 1);
  return lower.endsWith('.db') || basename === 'db.json' || basename === '.keys.json';
}

export function createViteWatchIgnored(projectRoot: string) {
  return (watchedPath: string): boolean => shouldIgnoreViteWatchPath(watchedPath, projectRoot);
}

export const VITE_WATCH_IGNORED_ROOTS = VITE_IGNORED_ROOT_DIRECTORIES;
