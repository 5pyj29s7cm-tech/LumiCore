import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataRoot } from './data_path';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from './runtime_file_security';

export const DESKTOP_BOOTSTRAP_HEADER = 'x-lumi-desktop-bootstrap';

const PROOF_VERSION = 1;
const PROOF_BYTES = 48;
const PROOF_TTL_MS = 5 * 60 * 1000;
const DESKTOP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DESKTOP_SESSIONS = 32;

interface BootstrapProofState {
  digest: Buffer;
  expiresAtMs: number;
}

interface DesktopSessionState {
  digest: Buffer;
  uid: string;
  expiresAtMs: number;
}

interface BootstrapProofFile {
  version: 1;
  proof: string;
  createdAt: string;
  expiresAt: string;
}

let bootstrapProofState: BootstrapProofState | null = null;
let desktopSessions: DesktopSessionState[] = [];

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function timingSafeDigestEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function writeProofFile(value: BootstrapProofFile): void {
  const proofPath = getDesktopBootstrapProofPath();
  const runtimeDir = path.dirname(proofPath);
  ensurePrivateRuntimeDirectory(runtimeDir);

  const temporaryPath = path.join(
    runtimeDir,
    `.desktop-bootstrap-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const serialized = `${JSON.stringify(value)}\n`;
  try {
    fs.writeFileSync(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    restrictOwnerAccess(temporaryPath);
    fs.renameSync(temporaryPath, proofPath);
    restrictOwnerAccess(proofPath);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function rotateBootstrapProof(nowMs = Date.now()): void {
  const proof = crypto.randomBytes(PROOF_BYTES).toString('base64url');
  const expiresAtMs = nowMs + PROOF_TTL_MS;
  writeProofFile({
    version: PROOF_VERSION,
    proof,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  // Keep only a digest in server memory. The plaintext lives only in the
  // owner-readable handoff file until the native client consumes it.
  bootstrapProofState = { digest: sha256(proof), expiresAtMs };
}

export function getDesktopBootstrapProofPath(): string {
  return path.join(getDataRoot(), 'runtime', 'desktop-bootstrap.json');
}

export function initializeDesktopBootstrapProof(): void {
  rotateBootstrapProof();
  desktopSessions = [];
}

/**
 * Atomically validates and consumes the current proof. A successful consume
 * installs a fresh proof before returning, so replay and concurrent reuse fail.
 */
export function consumeDesktopBootstrapProof(value: unknown): boolean {
  const supplied = typeof value === 'string' ? value.trim() : '';
  const current = bootstrapProofState;
  if (!current || supplied.length < 32 || supplied.length > 256) return false;

  const nowMs = Date.now();
  if (current.expiresAtMs <= nowMs) {
    rotateBootstrapProof(nowMs);
    return false;
  }

  if (!timingSafeDigestEqual(current.digest, sha256(supplied))) return false;
  rotateBootstrapProof(nowMs);
  return true;
}

export function issueDesktopSessionProof(uid: string): { proof: string; expiresAt: string } {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) throw new Error('A user id is required for a desktop session proof');

  const nowMs = Date.now();
  desktopSessions = desktopSessions.filter(session => session.expiresAtMs > nowMs);
  const proof = crypto.randomBytes(PROOF_BYTES).toString('base64url');
  const expiresAtMs = nowMs + DESKTOP_SESSION_TTL_MS;
  desktopSessions.push({ digest: sha256(proof), uid: normalizedUid, expiresAtMs });
  if (desktopSessions.length > MAX_DESKTOP_SESSIONS) {
    desktopSessions.splice(0, desktopSessions.length - MAX_DESKTOP_SESSIONS);
  }
  return { proof, expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Verifies a capability issued by this exact backend process. Capabilities are
 * held as hashes only, expire automatically, and are bound to the JWT subject.
 */
export function verifyDesktopSessionProof(value: unknown, expectedUid?: string): boolean {
  const supplied = typeof value === 'string' ? value.trim() : '';
  if (supplied.length < 32 || supplied.length > 256) return false;
  const normalizedUid = expectedUid === undefined ? undefined : String(expectedUid).trim();
  if (normalizedUid !== undefined && !normalizedUid) return false;

  const nowMs = Date.now();
  desktopSessions = desktopSessions.filter(session => session.expiresAtMs > nowMs);
  const suppliedDigest = sha256(supplied);
  return desktopSessions.some(session => (
    (normalizedUid === undefined || session.uid === normalizedUid)
    && timingSafeDigestEqual(session.digest, suppliedDigest)
  ));
}

export function resetDesktopBootstrapStateForTests(options: { removeFile?: boolean } = {}): void {
  bootstrapProofState = null;
  desktopSessions = [];
  if (options.removeFile) {
    try { fs.rmSync(getDesktopBootstrapProofPath(), { force: true }); } catch {}
  }
}
