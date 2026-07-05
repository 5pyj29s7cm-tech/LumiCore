import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFileSync, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const outDir = path.join(root, 'dist-server');

const NODE_VERSION = '20.19.0';

const platformMap = {
  'win32-x64':  { os: 'win',   arch: 'x64', ext: 'zip' },
  'darwin-x64': { os: 'darwin', arch: 'x64', ext: 'tar.gz' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64', ext: 'tar.gz' },
  'linux-x64':  { os: 'linux',  arch: 'x64', ext: 'tar.gz' },
};

const key = `${process.platform}-${process.arch}`;
const target = platformMap[key];
if (!target) {
  console.error(`[download-node] Unsupported platform: ${key}`);
  process.exit(1);
}

const { os: osName, arch, ext } = target;
const base = `node-v${NODE_VERSION}-${osName}-${arch}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${base}.${ext}`;
const nodeBinaryName = process.platform === 'win32' ? 'node.exe' : 'node';
const nodeBinaryPath = path.join(outDir, nodeBinaryName);

if (existsSync(nodeBinaryPath)) {
  try {
    const version = execFileSync(nodeBinaryPath, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
    if (version === NODE_VERSION) {
      console.log(`[download-node] Reusing ${nodeBinaryName} ${version} in dist-server/`);
      process.exit(0);
    }
    console.log(`[download-node] Replacing ${nodeBinaryName} ${version}; expected ${NODE_VERSION}.`);
  } catch {
    console.log(`[download-node] Existing ${nodeBinaryName} is not runnable; replacing it.`);
  }
}

console.log(`[download-node] Downloading Node.js ${NODE_VERSION} for ${key}...`);
console.log(`[download-node] ${url}`);

const res = await fetch(url);
if (!res.ok) {
  console.error(`[download-node] HTTP ${res.status}: ${res.statusText}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const tmpDir = path.join(os.tmpdir(), `lumi-node-${Date.now()}`);
await mkdir(tmpDir, { recursive: true });

const archivePath = path.join(tmpDir, `${base}.${ext}`);
const archiveFile = createWriteStream(archivePath);
await pipeline(res.body, archiveFile);

try {
  if (ext === 'zip') {
    execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'inherit' });
    await copyFile(path.join(tmpDir, base, 'node.exe'), path.join(outDir, 'node.exe'));
    console.log('[download-node] Extracted node.exe to dist-server/');
  } else {
    // macOS / Linux: extract only the node binary
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}" "${base}/bin/node"`, { stdio: 'inherit' });
    const extracted = path.join(tmpDir, base, 'bin', 'node');
    await copyFile(extracted, path.join(outDir, 'node'));
    // Ensure executable permission
    execSync(`chmod +x "${path.join(outDir, 'node')}"`, { stdio: 'inherit' });
    console.log('[download-node] Extracted node to dist-server/');
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log('[download-node] Done');
