import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertNoRunningDebugClients } from '../scripts/prepare-tauri-dev.mjs';
import { fingerprintSourceSnapshot } from '../scripts/lib/source-identity.mjs';
describe('native and package boundaries', () => {
  it('blocks a live development client, leaving the save/exit protocol to its owner', () => {
    const executable = 'D:/synthetic/src-tauri/target/debug/lumi-core.exe';
    expect(() => assertNoRunningDebugClients([{ Name: 'lumi-core.exe', ExecutablePath: executable, ProcessId: 4242, activeTask: true }], [executable])).toThrow('Close it through the client');
    expect(() => assertNoRunningDebugClients([{ Name: 'lumi-core.exe', ExecutablePath: 'D:/other/lumi-core.exe', ProcessId: 4242 }], [executable])).not.toThrow();
  });
  it('matches the Rust UTF-8 source-fingerprint ordering for mixed-case and Unicode paths', () => {
    const input = { head: 'synthetic', untracked: [{ path: 'a.ts', content: 'a' }, { path: 'B.ts', content: 'B' }, { path: '中.ts', content: 'c' }] };
    const hash = crypto.createHash('sha256');
    const part = (label: string, value: string) => { const bytes = Buffer.from(value); hash.update(label); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes); hash.update('\0'); };
    part('head', input.head); part('status', ''); part('diff', '');
    for (const item of [input.untracked[1], input.untracked[0], input.untracked[2]]) { part('untracked-path', item.path); part('untracked-content', item.content); }
    expect(fingerprintSourceSnapshot(input)).toBe(hash.digest('hex'));
  });
  it('uses a Pressed-edge guard for the native window toggle (static Rust verification)', () => {
    const source = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
    const callback = source.slice(source.indexOf('reg.on_shortcut(WINDOW_TOGGLE_SHORTCUT'), source.indexOf('reg.on_shortcut(COMMAND_CENTER_SHORTCUT'));
    expect(callback.indexOf('event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed')).toBeGreaterThan(0);
    expect(callback.indexOf('return;')).toBeLessThan(callback.indexOf('window.hide()'));
  });
  it('applies the same forbidden-file filter to direct server-resource copies', async () => {
    const copies: string[] = [];
    const file = path.resolve('scripts/prepare-desktop-resources.mjs');
    const source = fs.readFileSync(file, 'utf8');
    const entrypoint = source.indexOf('\nasync function prepareDesktopResources(');
    expect(entrypoint).toBeGreaterThan(0);
    const moduleSource = source.slice(0, entrypoint).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)) + '\nexport { prepareServer, copyIfExists };';
    const output = ts.transpileModule(moduleSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const runtime = { schemaVersion: 1, name: 'synthetic', version: '3.1.0', buildId: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), sourceDirty: false, builtAt: 'synthetic', channel: 'internal' };
    const imports: Record<string, any> = {
      'node:fs': { existsSync: () => true }, 'node:path': path, 'node:url': { fileURLToPath },
      'node:fs/promises': { mkdir: async () => {}, rm: async () => {}, cp: async () => {}, lstat: async () => ({ isSymbolicLink: () => false }), copyFile: async (from: string) => copies.push(from), readFile: async (from: string) => JSON.stringify(from.endsWith('runtime-meta.json') ? runtime : {}) },
    };
    const module = { exports: {} as any };
    vm.runInNewContext(output, { module, exports: module.exports, require: (name: string) => {
      if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`); return imports[name];
    }, process: { platform: 'win32', arch: 'x64', env: {} }, console });
    await module.exports.prepareServer();
    await module.exports.copyIfExists('D:/synthetic/.env.production', 'D:/synthetic/output/.env.production');
    expect(copies.some(filename => path.basename(filename).startsWith('.env'))).toBe(false);
    expect(copies.some(filename => path.basename(filename) === 'server.mjs')).toBe(true);
  });
});
