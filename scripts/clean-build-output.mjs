import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Frontend output only. Backend resources, Rust caches and user data are retained.
export function cleanFrontendOutput(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  const target = path.join(root, 'dist');
  if (!fs.existsSync(target)) return { removed: false, target };
  const stat = fs.lstatSync(target);
  const relative = path.relative(root, fs.realpathSync(target));
  if (stat.isSymbolicLink() || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to clean a redirected or out-of-project frontend output.');
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { removed: true, target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('clean-build-output takes no path arguments.');
  cleanFrontendOutput(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
