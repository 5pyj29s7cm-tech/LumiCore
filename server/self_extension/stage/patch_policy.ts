

const PATCH_FORBIDDEN = /(?:^|\n)(?:GIT binary patch|Binary files .* differ|Submodule )/m;

const PATCH_RENAME_OR_COPY = /(?:^|\n)(?:rename|copy) (?:from|to) /m;

const PATCH_MODE_CHANGE = /(?:^|\n)(?:old mode |new mode |deleted file mode |new file mode (?!100644(?:\r?$))|index [0-9a-f]+\.\.[0-9a-f]+ 120000(?:\r?$))/m;

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

export function normalizeRepositoryPath(value: string): string {
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

export function parsePorcelainStatus(output: string): string[] {
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

export function parseNullSeparatedPaths(output: string): string[] {
  return Array.from(new Set(String(output || '')
    .split('\0')
    .map(normalizeRepositoryPath)
    .filter(Boolean)))
    .sort();
}

export function assertExactPathSet(actual: string[], expected: string[], phase: string): void {
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
