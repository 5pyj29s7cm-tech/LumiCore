import { describe, expect, it } from 'vitest';
import { computeSourceIdentity, fingerprintSourceSnapshot } from '../scripts/lib/source-identity.mjs';
import { prepareWebViewLoader } from '../scripts/copy-webview2-dll.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('runtime source identity', () => {
  it('preserves identity when build tools rewrite a fresh Windows checkout with LF', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-build-crlf-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      fs.writeFileSync(path.join(root, '.gitattributes'), fs.readFileSync(new URL('../.gitattributes', import.meta.url)));
      const files = ['src-tauri/Cargo.toml', 'docs/generated/capability-stats.md'];
      for (const name of files) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), 'synthetic source\nsecond line\n');
      }
      git('init', '--quiet');
      git('config', 'core.autocrlf', 'true');
      git('add', '.');
      git('-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
      for (const name of files) fs.unlinkSync(path.join(root, name));
      git('checkout', 'HEAD', '--', ...files);
      const before = computeSourceIdentity(root);
      expect(before.dirty).toBe(false);
      for (const name of files) {
        const content = fs.readFileSync(path.join(root, name), 'utf8');
        expect(content).not.toContain('\r');
        fs.writeFileSync(path.join(root, name), content.replaceAll('\r\n', '\n'));
      }
      expect(computeSourceIdentity(root)).toEqual(before);
      fs.appendFileSync(path.join(root, files[0]), 'actual source change\n');
      expect(computeSourceIdentity(root).fingerprint).not.toBe(before.fingerprint);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps platform build outputs out of source identity while retaining real capabilities and installer hooks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-build-schema-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url)));
      fs.mkdirSync(path.join(root, 'src-tauri/capabilities'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src-tauri/capabilities/default.json'), '{"permissions":[]}');
      const hook = fs.readFileSync(new URL('../src-tauri/includes/include-dll.nsh', import.meta.url), 'utf8');
      fs.mkdirSync(path.join(root, 'src-tauri/includes'), { recursive: true });
      const hookPath = path.join(root, 'src-tauri/includes/include-dll.nsh');
      fs.writeFileSync(hookPath, hook);
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
      const before = computeSourceIdentity(root);
      fs.mkdirSync(path.join(root, 'src-tauri/gen/schemas'), { recursive: true });
      for (const name of ['macOS-schema.json', 'windows-schema.json', 'desktop-schema.json', 'acl-manifests.json', 'capabilities.json']) {
        fs.writeFileSync(path.join(root, 'src-tauri/gen/schemas', name), '{"generated":true}');
      }
      expect(computeSourceIdentity(root)).toEqual(before);
      await prepareWebViewLoader(root, 'win32');
      const loader = path.join(root, 'src-tauri/target/release/WebView2Loader.dll');
      const resource = path.join(root, 'desktop-resources/WebView2Loader.dll');
      fs.mkdirSync(path.dirname(loader), { recursive: true });
      fs.writeFileSync(loader, 'synthetic optional loader');
      await prepareWebViewLoader(root, 'win32');
      expect(fs.readFileSync(resource, 'utf8')).toBe('synthetic optional loader');
      fs.unlinkSync(loader);
      await prepareWebViewLoader(root, 'win32');
      expect(fs.existsSync(resource)).toBe(false);
      expect(fs.readFileSync(hookPath, 'utf8')).toBe(hook);
      expect(computeSourceIdentity(root)).toEqual(before);
      fs.appendFileSync(hookPath, '\n; changed installer behavior\n');
      expect(computeSourceIdentity(root).fingerprint).not.toBe(before.fingerprint);
      fs.writeFileSync(hookPath, hook);
      fs.writeFileSync(path.join(root, 'src-tauri/capabilities/default.json'), '{"permissions":["changed"]}');
      expect(computeSourceIdentity(root).fingerprint).not.toBe(before.fingerprint);
      fs.writeFileSync(path.join(root, 'src-tauri/new-source.rs'), 'fn new_source() {}');
      expect(computeSourceIdentity(root).dirty).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('is deterministic while binding tracked and untracked source content', () => {
    const base = {
      head: 'abc123',
      status: Buffer.from(' M server.ts\0?? security/policy.json\0'),
      diff: Buffer.from('diff --git a/server.ts b/server.ts'),
      untracked: [{ path: 'security/policy.json', content: Buffer.from('{"ok":true}') }],
    };
    const fingerprint = fingerprintSourceSnapshot(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintSourceSnapshot(base)).toBe(fingerprint);
    expect(fingerprintSourceSnapshot({
      ...base,
      untracked: [{ path: 'security/policy.json', content: Buffer.from('{"ok":false}') }],
    })).not.toBe(fingerprint);
  });

  it('does not depend on untracked input ordering', () => {
    const common = { head: 'abc123', status: Buffer.from('?? a\0?? b\0') };
    const left = fingerprintSourceSnapshot({
      ...common,
      untracked: [
        { path: 'b', content: Buffer.from('2') },
        { path: 'a', content: Buffer.from('1') },
      ],
    });
    const right = fingerprintSourceSnapshot({
      ...common,
      untracked: [
        { path: 'a', content: Buffer.from('1') },
        { path: 'b', content: Buffer.from('2') },
      ],
    });
    expect(left).toBe(right);
  });
});
