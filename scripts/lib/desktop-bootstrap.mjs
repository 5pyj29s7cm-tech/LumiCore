import fs from 'node:fs/promises';
import path from 'node:path';

const HEADER = 'X-Lumi-Desktop-Bootstrap';

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

/** Test/local-runtime helper. Production UI bootstrap stays inside Tauri. */
export async function bootstrapDesktopTestSession(baseUrl, dataRoot, options = {}) {
  const endpoint = new URL(`${String(baseUrl).replace(/\/$/, '')}/auth/bootstrap`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error(`Refusing to send a desktop bootstrap proof to ${endpoint.hostname}`);
  }

  let lastFailure = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const proof = await readProof(dataRoot);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        [HEADER]: proof,
        ...(options.existingToken ? { Authorization: `Bearer ${options.existingToken}` } : {}),
      },
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
