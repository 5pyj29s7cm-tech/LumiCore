import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const artifactExts = new Set(['.exe', '.msi', '.dmg', '.deb', '.rpm', '.appimage']);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function artifactKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.exe' || ext === '.msi') return 'windows-installer';
  if (ext === '.dmg') return 'macos-disk-image';
  if (ext === '.deb') return 'linux-deb';
  if (ext === '.rpm') return 'linux-rpm';
  if (ext === '.appimage') return 'linux-appimage';
  return 'artifact';
}

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const pkg = await readJson(path.join(root, 'package.json'));
  const tauri = await readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const head = git(['rev-parse', 'HEAD'], 'unknown');
  const runtimeMetaPath = path.join(root, 'desktop-resources', 'dist-server', 'runtime-meta.json');
  if (!existsSync(runtimeMetaPath)) throw new Error('Packaged runtime metadata is missing. Build desktop resources first.');
  const runtimeMeta = await readJson(runtimeMetaPath);
  if (runtimeMeta.version !== tauri.version || runtimeMeta.buildId !== head) {
    throw new Error(`Packaged runtime metadata does not match ${tauri.version}/${head}`);
  }
  const allFiles = await walk(bundleDir);
  const artifacts = allFiles
    .filter(filePath => artifactExts.has(path.extname(filePath).toLowerCase()))
    .filter(filePath => !filePath.toLowerCase().endsWith('.sha256'))
    .filter(filePath => path.basename(filePath).includes(tauri.version))
    .sort((a, b) => a.localeCompare(b));

  if (artifacts.length === 0) {
    throw new Error(`No release artifacts found under ${bundleDir}. Run npm run tauri:build first.`);
  }

  const entries = [];
  for (const filePath of artifacts) {
    const stat = await fs.stat(filePath);
    const digest = await sha256(filePath);
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const shaFile = `${filePath}.sha256`;
    await fs.writeFile(shaFile, `${digest}  ${path.basename(filePath)}\n`);
    const updaterSignaturePath = `${filePath}.sig`;
    entries.push({
      file: relativePath,
      name: path.basename(filePath),
      kind: artifactKind(filePath),
      sizeBytes: stat.size,
      sha256: digest,
      sha256File: path.relative(root, shaFile).split(path.sep).join('/'),
      ...(existsSync(updaterSignaturePath) ? {
        updaterSignatureFile: path.relative(root, updaterSignaturePath).split(path.sep).join('/'),
      } : {}),
    });
  }

  const manifest = {
    productName: tauri.productName || pkg.name,
    packageName: pkg.name,
    version: tauri.version || pkg.version,
    runtime: runtimeMeta,
    generatedAt: new Date().toISOString(),
    git: {
      branch: git(['branch', '--show-current'], 'unknown'),
      commit: head,
      status: git(['status', '--short'], ''),
    },
    artifacts: entries,
  };

  const manifestPath = path.join(bundleDir, 'release-manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    manifest: path.relative(root, manifestPath).split(path.sep).join('/'),
    artifacts: entries.map(item => ({
      name: item.name,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    })),
  }, null, 2));
}

main().catch(err => {
  console.error('[release-manifest] Failed:', err.message);
  process.exit(1);
});
