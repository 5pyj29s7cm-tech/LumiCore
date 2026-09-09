import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export const artifactExts = new Set(['.exe', '.msi', '.dmg', '.deb', '.rpm', '.appimage']);
export async function releaseArtifacts(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await releaseArtifacts(filename));
    else if (entry.isFile() && artifactExts.has(path.extname(entry.name).toLowerCase())) found.push(filename);
  }
  return found.sort();
}
export async function hashArtifact(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export function verifyBuildReceipt(receipt, runtime, artifacts) {
  if (receipt?.schema !== 1 || !receipt.completedAt || !Array.isArray(receipt.artifacts)) {
    throw new Error('A completed desktop build receipt is required. Rebuild with npm run tauri:build.');
  }
  for (const key of ['version', 'buildId', 'sourceFingerprint', 'sourceDirty']) {
    if (receipt.runtime?.[key] !== runtime?.[key]) throw new Error(`Build receipt identity mismatch: ${key}`);
  }
  if (artifacts.length === 0 || artifacts.length !== receipt.artifacts.length) throw new Error('Build receipt artifact set mismatch.');
  const seen = new Set();
  for (const artifact of artifacts) {
    const captured = receipt.artifacts.find(item => item.file === artifact.file);
    if (seen.has(artifact.file) || !captured || captured.sha256 !== artifact.sha256 || captured.sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Build receipt does not bind artifact: ${artifact.file}`);
    }
    seen.add(artifact.file);
  }
}
