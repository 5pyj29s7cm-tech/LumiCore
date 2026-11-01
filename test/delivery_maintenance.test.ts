import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanFrontendOutput } from '../scripts/clean-build-output.mjs';
import { buildVariantMetadata, resolveCoreRoot } from '../scripts/variant-manager.mjs';

const roots: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-delivery-test-')); roots.push(root); return root; }
function write(root: string, name: string, data: string) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lumi-delivery-test-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
describe('bounded delivery maintenance', () => {
  it('cleans all frontend targets while preserving backend resources and data', () => {
    const root = fixture();
    for (const f of ['dist/desktop/index.html', 'dist/mobile/index.html', 'dist-server/server.mjs', 'desktop-resources/node', 'data/keep']) write(root, f, 'retained-or-output');
    expect(cleanFrontendOutput(root).removed).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
    for (const f of ['dist-server/server.mjs', 'desktop-resources/node', 'data/keep']) expect(fs.readFileSync(path.join(root, f), 'utf8')).toBe('retained-or-output');
    expect(cleanFrontendOutput(root).removed).toBe(false);
  });
  it('refuses a redirected frontend directory without deleting its target', () => {
    const root = fixture(), external = fixture(); write(external, 'keep', 'owned elsewhere');
    fs.symlinkSync(external, path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => cleanFrontendOutput(root)).toThrow(/redirected/);
    expect(fs.readFileSync(path.join(external, 'keep'), 'utf8')).toBe('owned elsewhere');
  });
  function coreFixture() {
    const root = fixture(); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'fixture@localhost'); git(root, 'config', 'user.name', 'Local fixture');
    write(root, 'src-tauri/tauri.conf.json', JSON.stringify({ productName: 'LumiCore', identifier: 'com.lumiai.os' }));
    git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture'); git(root, 'switch', '-c', 'feature/review'); return root;
  }
  it('permits explicit inspection of the main product without inventing a main worktree', () => {
    const root = coreFixture();
    expect(() => resolveCoreRoot(root, '')).toThrow(/main worktree was not found/);
    expect(resolveCoreRoot(root, root)).toBe(fs.realpathSync.native(root));
    expect(git(root, 'branch', '--show-current')).toBe('feature/review');
  });
  it('rejects foreign repositories, child editions, relative paths and forged product identity', () => {
    const root = coreFixture(), foreign = coreFixture();
    expect(() => resolveCoreRoot(root, foreign)).toThrow(/registered worktree/);
    expect(() => resolveCoreRoot(root, '.')).toThrow(/absolute path/);
    write(root, '.lumi/variant.json', '{}'); expect(() => resolveCoreRoot(root, root)).toThrow(/variant worktree/);
    fs.unlinkSync(path.join(root, '.lumi/variant.json'));
    write(root, 'src-tauri/tauri.conf.json', JSON.stringify({ productName: 'Lumi Designer', identifier: 'com.lumiai.designer' }));
    expect(() => resolveCoreRoot(root, root)).toThrow(/trusted LumiCore/);
  });
  it('refuses publication from a feature worktree before any remote or delivery lookup', () => {
    const root = coreFixture(), before = git(root, 'rev-parse', 'HEAD');
    const result = spawnSync(process.execPath, [path.resolve('scripts/variant-manager.mjs'), 'publish-default', '--root', root, '--core-root', root, '--id', 'test-client'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('must be on main');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before); expect(git(root, 'status', '--porcelain')).toBe('');
  });
  it.each(['feature', 'dirty-main'])('refuses promotion before adding a missing remote: %s', state => {
    const root = coreFixture(), child = fixture(), baseline = git(root, 'rev-parse', 'HEAD');
    git(root, 'worktree', 'add', '-b', 'feature/delivery', child);
    write(child, '.lumi/variant.json', JSON.stringify(buildVariantMetadata({
      id: 'test-client', displayName: 'Lumi Test Client', productLine: 'test-client',
      upstreamRepository: 'https://github.com/lumi/core.git', baselineCommit: baseline,
      repository: 'https://github.com/lumi/test-client.git', localBranch: 'feature/delivery',
    })));
    git(child, 'add', '.lumi/variant.json'); git(child, 'commit', '-m', 'fixture identity');
    if (state === 'dirty-main') { git(root, 'switch', 'main'); write(root, 'uncommitted.txt', 'keep'); }
    const config = fs.readFileSync(path.join(root, '.git/config'), 'utf8');
    const result = spawnSync(process.execPath, [path.resolve('scripts/variant-manager.mjs'), 'promote',
      '--root', root, '--core-root', root, '--id', 'test-client', '--commits', baseline],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(state === 'feature' ? /must be on main/ : /has uncommitted changes/);
    expect(git(root, 'remote')).toBe('');
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).toBe(config);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(baseline);
  });
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : '/bin/bash';
describe.skipIf(!fs.existsSync(bash))('checked Unix backend copy in synthetic directories', () => {
  it('refuses a fake macOS .app destination before reaching build or install commands', () => {
    const root = fixture();
    const result = spawnSync(bash, [path.resolve('scripts/deploy-macos.sh').replaceAll('\\', '/'), path.join(root, 'Fake.app').replaceAll('\\', '/')], { encoding:'utf8',windowsHide:true,timeout:10000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('refuses .app paths');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  function copy(mode: 'success' | 'missing' | 'copy-failure') {
    const root = fixture(), source = path.join(root, 'source backend'), destination = path.join(root, 'new install/dist-server');
    for (const name of ['entry.cjs', 'server.mjs', 'runtime-meta.json', 'node', '.hidden']) write(source, name, 'fixture-'+name);
    if (mode === 'missing') fs.unlinkSync(path.join(source, 'server.mjs'));
    const script = `set -euo pipefail\nsudo() { ${mode === 'copy-failure' ? 'if [ "$1" = "cp" ]; then return 31; fi; ' : ''}"$@"; }\nsource "$LUMI_TEST_HELPER"\ninstall_backend_resources "$LUMI_TEST_SOURCE" "$LUMI_TEST_DEST"\nprintf 'copy-completed'\n`;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, LUMI_TEST_HELPER: path.resolve('scripts/lib/deploy-backend.sh').replaceAll('\\', '/'), LUMI_TEST_SOURCE: source.replaceAll('\\', '/'), LUMI_TEST_DEST: destination.replaceAll('\\', '/') } });
    return { result, destination };
  }
  it('creates a new backend destination and copies required and hidden files', () => {
    const { result, destination } = copy('success'); expect(result.status, result.stderr).toBe(0);
    for (const name of ['entry.cjs', 'server.mjs', 'runtime-meta.json', 'node', '.hidden']) expect(fs.readFileSync(path.join(destination, name), 'utf8')).toBe('fixture-'+name);
  });
  it('rejects missing packaged files before creating the install destination', () => {
    const { result, destination } = copy('missing'); expect(result.status).toBe(1); expect(result.stderr).toContain('server.mjs'); expect(fs.existsSync(destination)).toBe(false);
  });
  it('propagates a copy failure instead of continuing as deployed', () => {
    const { result } = copy('copy-failure'); expect(result.status).toBe(31); expect(result.stdout).not.toContain('copy-completed');
  });
});
