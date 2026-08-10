import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function git(root, args, encoding = null) {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function updateHashPart(hash, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  hash.update(label, 'utf8');
  hash.update('\0');
  hash.update(String(bytes.length), 'utf8');
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
}

export function fingerprintSourceSnapshot({
  head,
  status = Buffer.alloc(0),
  diff = Buffer.alloc(0),
  untracked = [],
}) {
  const hash = crypto.createHash('sha256');
  updateHashPart(hash, 'head', head);
  updateHashPart(hash, 'status', status);
  updateHashPart(hash, 'diff', diff);
  for (const item of [...untracked].sort((left, right) => left.path.localeCompare(right.path))) {
    updateHashPart(hash, 'untracked-path', item.path);
    updateHashPart(hash, 'untracked-content', item.content);
  }
  return hash.digest('hex');
}

export function computeSourceIdentity(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const head = String(git(resolvedRoot, ['rev-parse', 'HEAD'], 'utf8')).trim();
  const status = git(resolvedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = git(resolvedRoot, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
  const untrackedPaths = status
    .toString('utf8')
    .split('\0')
    .filter(entry => entry.startsWith('?? '))
    .map(entry => entry.slice(3));
  const untracked = untrackedPaths.map(relativePath => ({
    path: relativePath.split(path.sep).join('/'),
    content: fs.readFileSync(path.join(resolvedRoot, relativePath)),
  }));
  return {
    head,
    dirty: status.length > 0,
    fingerprint: fingerprintSourceSnapshot({ head, status, diff, untracked }),
  };
}
