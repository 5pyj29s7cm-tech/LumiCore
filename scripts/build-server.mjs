import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { computeSourceIdentity } from './lib/source-identity.mjs';

const packageMeta = JSON.parse(readFileSync('package.json', 'utf8'));
function git(args, fallback = 'development') {
  try {
    return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const sourceIdentity = computeSourceIdentity(process.cwd());
const runtimeMeta = {
  schemaVersion: 1,
  name: packageMeta.name || 'lumi-core',
  version: packageMeta.version,
  buildId: process.env.LUMI_BUILD_ID || process.env.GIT_COMMIT || git(['rev-parse', 'HEAD']),
  sourceFingerprint: sourceIdentity.fingerprint,
  sourceDirty: sourceIdentity.dirty,
  builtAt: new Date().toISOString(),
  channel: process.env.LUMI_RELEASE_CHANNEL || 'internal',
};

await build({
  // This entry migrates the legacy product data root before dynamically
  // importing the application graph. Building server.ts directly would let
  // top-level provider path resolution create the new root too early.
  entryPoints: ['server/runtime/server_entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-server/server.mjs',
  // Keep CommonJS runtimes that depend on module-scoped globals external.
  // Bundling the Lark SDK into this ESM file leaves its `__dirname` reference
  // unresolved and crashes the packaged backend before it can bind its port.
  external: [
    'sqlite3',
    'sharp',
    '@img/sharp-win32-x64',
    '@img/sharp-libvips-win32-x64',
    'lightningcss',
    'playwright-core',
    '@larksuiteoapi/node-sdk',
  ],
  banner: {
    js: "import { createRequire as __lumiCreateRequire } from 'module'; const require = __lumiCreateRequire(import.meta.url);",
  },
});

await build({
  entryPoints: ['server/autonomy/system_explorer_worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist-server/system-explorer-worker.mjs',
  external: [
    'sqlite3',
    'sharp',
    '@img/sharp-win32-x64',
    '@img/sharp-libvips-win32-x64',
    'lightningcss',
    'playwright-core',
    '@larksuiteoapi/node-sdk',
  ],
  banner: {
    js: "import { createRequire as __lumiCreateRequire } from 'module'; const require = __lumiCreateRequire(import.meta.url);",
  },
});

// Generate entry.cjs for CommonJS environments (Tauri node.exe, production serve)
mkdirSync('dist-server', { recursive: true });
writeFileSync('dist-server/runtime-meta.json', `${JSON.stringify(runtimeMeta, null, 2)}\n`);
writeFileSync('dist-server/entry.cjs', `// CJS entry point - dynamically imports the ESM server bundle.
process.env.LUMI_RUNTIME_META_FILE ||= require('path').join(__dirname, 'runtime-meta.json');

// Monkey-patch child_process to hide console windows on Windows (desktop app)
if (process.platform === 'win32') {
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  const origExec = cp.exec;
  const origExecSync = cp.execSync;
  const origFork = cp.fork;

  cp.spawn = function (cmd, args, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origSpawn.call(this, cmd, args, opts);
  };
  cp.exec = function (cmd, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origExec.call(this, cmd, opts, cb);
  };
  cp.execSync = function (cmd, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origExecSync.call(this, cmd, opts);
  };
  cp.fork = function (mod, args, opts) {
    if (!opts) opts = {};
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return origFork.call(this, mod, args, opts);
  };
}

import('./server.mjs').catch(err => {
  console.error('Failed to start LumiCore server:', err);
  process.exit(1);
});
`);

// Generate hide-console.cjs — required by Tauri production spawn via NODE_OPTIONS (Windows only)
if (process.platform === 'win32') {
writeFileSync('dist-server/hide-console.cjs', `// Hide console window on Windows desktop app
if (process.platform === 'win32') {
  const { exec } = require('child_process');
  exec('powershell -WindowStyle Hidden -Command ""', { windowsHide: true });
}
`);
console.log('[build-server] Generated dist-server/hide-console.cjs');
} else {
console.log('[build-server] Skipped hide-console.cjs (not Windows)');
}

console.log(`[build-server] Generated runtime metadata ${runtimeMeta.version} ${runtimeMeta.buildId.slice(0, 7)} (${runtimeMeta.channel}, source ${runtimeMeta.sourceFingerprint.slice(0, 12)}${runtimeMeta.sourceDirty ? ', dirty' : ''})`);
console.log('[build-server] Generated dist-server/server.mjs + dist-server/system-explorer-worker.mjs + dist-server/entry.cjs + dist-server/runtime-meta.json + dist-server/hide-console.cjs');
