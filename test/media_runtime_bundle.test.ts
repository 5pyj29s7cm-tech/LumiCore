import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resolveMediaBinary, runMediaProcess } from '../server/media/process';
const directories: string[] = [];
const temp = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-media-bundle-')); directories.push(value); return value; };
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) { if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('lumi-media-bundle-')) throw new Error('Unsafe test cleanup path'); fs.rmSync(directory, { recursive: true, force: true }); } });
it('resolves the explicit bundled executable with an empty PATH and never uses a cwd impostor', () => {
  const root = temp(), bin = path.join(root, 'media', 'bin'); fs.mkdirSync(bin, { recursive: true });
  const name = 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''); fs.writeFileSync(path.join(bin, name), 'fixture; resolution only');
  vi.stubEnv('PATH', ''); vi.stubEnv('LUMI_MEDIA_BIN_DIR', bin);
  expect(resolveMediaBinary('ffprobe')).toBe(path.join(bin, name));
});
it('finds Windows media relative to packaged runtime metadata independently of cwd', () => {
  if (process.platform !== 'win32') return;
  const root = temp(), bin = path.join(root, 'media', 'bin'); fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'ffmpeg.exe'), 'fixture; resolution only');
  vi.stubEnv('PATH', ''); vi.stubEnv('LUMI_MEDIA_BIN_DIR', ''); vi.stubEnv('LUMI_RUNTIME_META_FILE', path.join(root, 'runtime-meta.json'));
  expect(resolveMediaBinary('ffmpeg')).toBe(path.join(bin, 'ffmpeg.exe'));
});
it('fails explicitly for missing bundled media even if PATH contains another executable', async () => {
  vi.stubEnv('LUMI_MEDIA_BIN_DIR', temp());
  await expect(runMediaProcess('ffprobe', ['-version'])).rejects.toMatchObject({ code: 'media_tool_unavailable', status: 503 });
  vi.stubEnv('LUMI_MEDIA_BIN_DIR', 'relative-directory'); expect(() => resolveMediaBinary('ffprobe')).toThrow(/absolute/);
});
it('copies only pinned media inputs and ties the receipt to the same server manifest', async () => {
  const { prepareMediaRuntime } = await import('../scripts/lib/media-runtime.mjs');
  const root = temp(), source = path.join(root, 'source'), destination = path.join(root, 'output'); fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  const files = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'].map(name => { const content = Buffer.from('Fixture: ' + name); fs.writeFileSync(path.join(source, name), content); return { path: name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }; });
  fs.writeFileSync(path.join(source, 'unwanted-user-data.txt'), 'must not ship');
  const manifestPath = path.join(root, 'manifest.json'), metadata = path.join(root, 'runtime-meta.json');
  const manifest = JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, version: 'fixture', files }); fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(metadata, JSON.stringify({ buildId: 'fixture-source', sourceFingerprint: 'source-freeze', mediaRuntime: { manifestSha256: createHash('sha256').update(manifest).digest('hex') } }));
  const receipt = await prepareMediaRuntime({ sourceDirectory: source, destinationDirectory: destination, manifestPath, runtimeMetadataPath: metadata });
  expect(receipt).toMatchObject({ buildId: 'fixture-source', sourceFingerprint: 'source-freeze', files });
  expect(fs.existsSync(path.join(destination, 'unwanted-user-data.txt'))).toBe(false);
  fs.writeFileSync(path.join(source, 'bin/ffmpeg.exe'), 'changed');
  await expect(prepareMediaRuntime({ sourceDirectory: source, destinationDirectory: destination, manifestPath, runtimeMetadataPath: metadata })).rejects.toThrow(/differs from pinned manifest/);
  fs.writeFileSync(metadata, JSON.stringify({ mediaRuntime: { manifestSha256: 'stale' } }));
  await expect(prepareMediaRuntime({ sourceDirectory: source, destinationDirectory: destination, manifestPath, runtimeMetadataPath: metadata })).rejects.toThrow(/Rebuild the server/);
});
