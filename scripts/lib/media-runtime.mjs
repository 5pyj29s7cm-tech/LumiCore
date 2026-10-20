import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function checkedFile(root, entry) {
  if (!['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'].includes(entry.path)) throw new Error('Unexpected media runtime manifest path.');
  const file = path.join(root, entry.path);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || await digest(file) !== entry.sha256) throw new Error('Media runtime input differs from pinned manifest: ' + entry.path);
  return file;
}
/** Copy only pinned executables and upstream notices; never scan machine PATH or user data. */
export async function prepareMediaRuntime({ sourceDirectory, destinationDirectory, manifestPath, runtimeMetadataPath }) {
  if (!sourceDirectory || !path.isAbsolute(sourceDirectory)) throw new Error('Set LUMI_MEDIA_RUNTIME_SOURCE to the absolute, verified FFmpeg input directory before packaging.');
  const bytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  const runtime = JSON.parse(await fs.readFile(runtimeMetadataPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.files?.length !== 4) throw new Error('Media runtime platform or manifest does not match this desktop build.');
  if (runtime.mediaRuntime?.manifestSha256 !== manifestSha256) throw new Error('Rebuild the server after changing the pinned media runtime manifest.');
  const inputs = await Promise.all(manifest.files.map(entry => checkedFile(sourceDirectory, entry)));
  await fs.mkdir(path.join(destinationDirectory, 'bin'), { recursive: true });
  for (let index = 0; index < inputs.length; index++) {
    const entry = manifest.files[index];
    const destination = path.join(destinationDirectory, entry.path);
    try { if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error('Refusing linked media runtime output.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.copyFile(inputs[index], destination);
    await checkedFile(destinationDirectory, entry);
  }
  const receipt = { schemaVersion: 1, version: manifest.version, platform: manifest.platform, arch: manifest.arch, manifestSha256,
    sourceFingerprint: runtime.sourceFingerprint, buildId: runtime.buildId, files: manifest.files, license: manifest.license, source: manifest.source };
  await fs.writeFile(path.join(destinationDirectory, 'media-runtime-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
