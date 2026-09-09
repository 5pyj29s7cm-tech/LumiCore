import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeSourceIdentity } from './lib/source-identity.mjs';
import { hashArtifact, releaseArtifacts, verifyBuildReceipt } from './lib/release-receipt.mjs';

function runTauri(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Tauri build failed (${code}).`)));
  });
}

/** Isolate bundle outputs while retaining the existing Cargo compilation cache. */
export async function buildDesktopWithReceipt({ root, args = [], runBuild = runTauri, sourceIdentity = computeSourceIdentity }) {
  root = path.resolve(root);
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : (args.find(arg => arg.startsWith('--target=')) || '').slice(9);
  if (target && !/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('Unsupported build target.');
  if (targetIndex >= 0 && !target) throw new Error('A build target is required after --target.');
  if (args.some(arg => ['--debug', '--no-bundle', '--runner', '--config', '-c', '--target-dir'].includes(arg) || /^(--config|--runner|--target-dir)=/.test(arg))) {
    throw new Error('Release receipt builds require the repository release configuration and bundle output.');
  }
  const targetRoot = path.join(root, 'src-tauri', 'target');
  if (process.env.CARGO_TARGET_DIR && path.resolve(root, process.env.CARGO_TARGET_DIR) !== targetRoot) throw new Error('Release receipt requires the repository Cargo target directory.');
  const bundle = path.resolve(targetRoot, target || '', 'release', 'bundle');
  if (!bundle.startsWith(`${targetRoot}${path.sep}`)) throw new Error('Bundle directory escaped the Cargo target root.');
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  const lockPath = path.join(targetRoot, '.lumicore-build.lock');
  const lock = await fs.open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error(`A desktop build owns ${lockPath}. Wait for it to finish; after a crashed build, verify its recorded process has exited before removing the lock.`);
    throw error;
  });
  const backup = `${bundle}.previous-${crypto.randomUUID()}`;
  let moved = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), root, args }));
    const before = sourceIdentity(root);
    try { await fs.rename(bundle, backup); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await runBuild(root, args);
    const after = sourceIdentity(root);
    if (before.fingerprint !== after.fingerprint || before.head !== after.head || before.dirty !== after.dirty) throw new Error('Source changed during desktop build; no receipt issued.');
    const runtime = JSON.parse(await fs.readFile(path.join(root, 'desktop-resources/dist-server/runtime-meta.json'), 'utf8'));
    const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    if (runtime.buildId !== after.head || runtime.sourceFingerprint !== after.fingerprint || runtime.sourceDirty !== after.dirty || runtime.version !== config.version) {
      throw new Error('Prepared runtime identity does not match the completed desktop build.');
    }
    const artifacts = await Promise.all((await releaseArtifacts(bundle)).map(async filename => ({
      file: path.relative(root, filename).split(path.sep).join('/'),
      sha256: await hashArtifact(filename), sizeBytes: (await fs.stat(filename)).size,
    })));
    const receipt = { schema: 1, completedAt: new Date().toISOString(), runtime, artifacts };
    verifyBuildReceipt(receipt, runtime, artifacts);
    await fs.writeFile(path.join(bundle, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } catch (error) {
    // Preserve failed outputs for diagnosis; restore the previous reviewable build.
    if (moved) {
      try { await fs.rename(bundle, `${bundle}.failed-${crypto.randomUUID()}`); } catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; }
      await fs.rename(backup, bundle);
    }
    throw error;
  } finally {
    await lock.close(); await fs.unlink(lockPath);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  buildDesktopWithReceipt({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args: process.argv.slice(2) })
    .then(receipt => console.log(`Desktop build receipt saved for ${receipt.artifacts.length} artifact(s).`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
