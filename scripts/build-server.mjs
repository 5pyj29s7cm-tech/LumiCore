import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['server.ts'],
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

// Generate entry.cjs for CommonJS environments (Tauri node.exe, production serve)
mkdirSync('dist-server', { recursive: true });
writeFileSync('dist-server/entry.cjs', `// CJS entry point - dynamically imports the ESM server bundle.

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
  console.error('Failed to start Lumi OS server:', err);
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

console.log('[build-server] Generated dist-server/server.mjs + dist-server/entry.cjs + dist-server/hide-console.cjs');
