import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { buildDesktopWithReceipt } from '../scripts/build-desktop-with-receipt.mjs';
import { verifyBuildReceipt } from '../scripts/lib/release-receipt.mjs';
const identity = { head: 'synthetic-commit', fingerprint: 'synthetic-fingerprint', dirty: false };
const runtime = { version: '3.1.0', buildId: identity.head, sourceFingerprint: identity.fingerprint, sourceDirty: false };
async function fixture() {
  const root = getDataPath(`synthetic-build-${Date.now()}-${Math.random()}`);
  const bundle = path.join(root, 'src-tauri/target/release/bundle');
  await fs.mkdir(bundle, { recursive: true });
  await fs.mkdir(path.join(root, 'desktop-resources/dist-server'), { recursive: true });
  await fs.writeFile(path.join(root, 'desktop-resources/dist-server/runtime-meta.json'), JSON.stringify(runtime));
  await fs.writeFile(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: runtime.version }));
  const artifact = path.join(bundle, 'LumiCore_3.1.0_x64-setup.exe');
  await fs.writeFile(artifact, 'synthetic previous installer');
  return { root, bundle, artifact };
}
describe('desktop build receipt', () => {
  it('isolates old packages and binds only artifacts produced by the completed build', async () => {
    const { root, bundle, artifact } = await fixture();
    const receipt = await buildDesktopWithReceipt({ root, sourceIdentity: () => identity, runBuild: async () => {
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.mkdir(bundle, { recursive: true }); await fs.writeFile(artifact, 'synthetic latest installer');
    } });
    expect(receipt.artifacts).toHaveLength(1);
    expect(() => verifyBuildReceipt(receipt, runtime, receipt.artifacts)).not.toThrow();
    expect(() => verifyBuildReceipt(receipt, { ...runtime, sourceFingerprint: 'new-source' }, receipt.artifacts)).toThrow('identity mismatch');
    expect(() => verifyBuildReceipt(receipt, runtime, [{ ...receipt.artifacts[0], sha256: 'old-bytes' }])).toThrow('does not bind');
    const folders = await fs.readdir(path.dirname(bundle));
    expect(folders.some(name => name.startsWith('bundle.previous-'))).toBe(true);
  });
  it('restores the previous package when a build fails and does not certify it as the new one', async () => {
    const { root, bundle, artifact } = await fixture();
    await expect(buildDesktopWithReceipt({ root, sourceIdentity: () => identity, runBuild: async () => {
      await fs.mkdir(bundle, { recursive: true }); await fs.writeFile(artifact, 'partial synthetic build');
      throw new Error('synthetic compile failure');
    } })).rejects.toThrow('synthetic compile failure');
    expect(await fs.readFile(artifact, 'utf8')).toBe('synthetic previous installer');
    await expect(fs.stat(path.join(bundle, 'build-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'src-tauri/target/.lumicore-build.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a successful CLI exit that produced no packages', async () => {
    const { root, artifact } = await fixture();
    await expect(buildDesktopWithReceipt({ root, sourceIdentity: () => identity, runBuild: async () => {} })).rejects.toThrow('artifact set mismatch');
    expect(await fs.readFile(artifact, 'utf8')).toBe('synthetic previous installer');
  });
  it('refuses legacy manifests without an artifact build receipt', () => {
    expect(() => verifyBuildReceipt(undefined, runtime, [{ file: 'old.exe', sha256: 'old', sizeBytes: 10 }])).toThrow('completed desktop build receipt');
  });
});
