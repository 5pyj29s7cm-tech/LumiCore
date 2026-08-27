import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { computeSourceIdentity } from './source-identity.mjs';

const HEADER = 'X-Lumi-Desktop-Bootstrap';
export const DESKTOP_SESSION_HEADER = 'X-Lumi-Desktop-Session';

async function readProof(dataRoot) {
  const proofPath = path.join(path.resolve(dataRoot), 'runtime', 'desktop-bootstrap.json');
  const metadata = await fs.lstat(proofPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 4096) {
    throw new Error('Desktop bootstrap proof file is not a safe regular file');
  }
  const parsed = JSON.parse(await fs.readFile(proofPath, 'utf8'));
  const proof = String(parsed?.proof || '');
  if (parsed?.version !== 1 || !/^[A-Za-z0-9_-]{32,256}$/.test(proof)) {
    throw new Error('Desktop bootstrap proof file has an invalid format');
  }
  return proof;
}

async function sha256File(filePath) {
  const handle = await fs.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Describes this exact Node acceptance process. It is intentionally not a
 * Tauri identity and must never be used as proof that the product client ran.
 */
export async function buildLocalAcceptanceHarnessIdentity(sourceRoot = process.cwd()) {
  const root = path.resolve(sourceRoot);
  const executablePath = await fs.realpath(process.execPath);
  const [packageMeta, executableSha256] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    sha256File(executablePath),
  ]);
  const sourceIdentity = computeSourceIdentity(root);
  const appVersion = String(packageMeta?.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(appVersion)) {
    throw new Error('Acceptance harness package version is invalid');
  }
  return {
    schemaVersion: 1,
    clientKind: 'local_acceptance_harness',
    pid: process.pid,
    startedAtUnixMs: Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000,
    executablePath,
    executableSha256,
    binaryHashUnavailable: false,
    buildId: sourceIdentity.head,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint: sourceIdentity.fingerprint,
    sourceDirty: sourceIdentity.dirty,
    appVersion,
  };
}

/** Test/local-runtime helper. Production UI bootstrap stays inside Tauri. */
export async function bootstrapDesktopTestSession(baseUrl, dataRoot, options = {}) {
  const endpoint = new URL(`${String(baseUrl).replace(/\/$/, '')}/auth/bootstrap`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error(`Refusing to send a desktop bootstrap proof to ${endpoint.hostname}`);
  }

  const nativeClientIdentity = await buildLocalAcceptanceHarnessIdentity(
    options.sourceRoot || process.cwd(),
  );
  let lastFailure = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const proof = await readProof(dataRoot);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        [HEADER]: proof,
        'Content-Type': 'application/json',
        ...(options.existingToken ? { Authorization: `Bearer ${options.existingToken}` } : {}),
      },
      body: JSON.stringify({ nativeClientIdentity }),
      signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
    if (response.ok) return body;
    lastFailure = `${response.status}: ${text.slice(0, 500)}`;
    if (response.status !== 403 || attempt === 2) break;
  }
  throw new Error(`Desktop bootstrap failed: ${lastFailure || 'unknown response'}`);
}
