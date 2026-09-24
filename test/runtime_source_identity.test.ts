import { describe, expect, it } from 'vitest';
import { computeSourceIdentity, fingerprintSourceSnapshot } from '../scripts/lib/source-identity.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('runtime source identity', () => {
  it('ignores regenerated Tauri schemas while retaining actual capability and source changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-build-schema-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url)));
      fs.mkdirSync(path.join(root, 'src-tauri/capabilities'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src-tauri/capabilities/default.json'), '{"permissions":[]}');
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
      const before = computeSourceIdentity(root);
      fs.mkdirSync(path.join(root, 'src-tauri/gen/schemas'), { recursive: true });
      for (const name of ['macOS-schema.json', 'windows-schema.json', 'desktop-schema.json', 'acl-manifests.json', 'capabilities.json']) {
        fs.writeFileSync(path.join(root, 'src-tauri/gen/schemas', name), '{"generated":true}');
      }
      expect(computeSourceIdentity(root)).toEqual(before);
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
