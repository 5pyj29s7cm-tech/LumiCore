import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { computeRuntimePathDigest, readRuntimeIdentitySnapshot, verifyManagedSkillRuntimeIdentity } from '../server/marketplace/official_identity';
const root = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'runtime-digest-'));
const file = path.join(root, 'runtime.js'), second = path.join(root, 'entry.js');
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('shares reads only within one discovery, then detects changed files and dependencies', () => {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, 'original'); fs.writeFileSync(second, 'entry');
  const read = vi.spyOn(fs, 'readFileSync');
  const runtime = { transport: 'stdio' as const, command: file, cwd: root, args: [second], files: [file, second].map(target => ({ path: target, kind: 'file' as const, digest: computeRuntimePathDigest(target) })) };
  read.mockClear();
  readRuntimeIdentitySnapshot(() => { expect(verifyManagedSkillRuntimeIdentity(runtime).valid).toBe(true); expect(verifyManagedSkillRuntimeIdentity(runtime).valid).toBe(true); });
  expect(read.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(1);
  fs.writeFileSync(file, 'modified'); expect(verifyManagedSkillRuntimeIdentity(runtime).valid).toBe(false);
  expect(readRuntimeIdentitySnapshot(() => verifyManagedSkillRuntimeIdentity(runtime)).valid).toBe(false);
  const directoryHash = readRuntimeIdentitySnapshot(() => computeRuntimePathDigest(root));
  fs.writeFileSync(second, 'changed dependency'); expect(computeRuntimePathDigest(root)).not.toBe(directoryHash);
});

it('drops snapshots on errors and does not retain failed reads', () => {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, 'before'); let original = '';
  expect(() => readRuntimeIdentitySnapshot(() => { original = computeRuntimePathDigest(file); throw new Error('read failed'); })).toThrow('read failed');
  fs.writeFileSync(file, 'after'); expect(computeRuntimePathDigest(file)).not.toBe(original);
  readRuntimeIdentitySnapshot(() => {
    expect(() => computeRuntimePathDigest(second)).toThrow(); fs.writeFileSync(second, 'now present'); expect(computeRuntimePathDigest(second)).toMatch(/^sha256:/);
  });
});
