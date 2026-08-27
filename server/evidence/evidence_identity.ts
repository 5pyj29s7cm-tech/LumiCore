import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '../config/data_path';

interface EvidenceIdentityFile {
  version: 1;
  secret: string;
  createdAt: string;
}

export interface EvidenceKeyMaterial {
  key: Buffer;
  keyId: string;
}

const EVIDENCE_IDENTITY_PATH = getDataPath('evidence_identity.json');
const MAX_IDENTITY_BYTES = 4 * 1024;
const SECRET_BYTES = 48;
let cached: EvidenceKeyMaterial | null = null;

function parseIdentity(value: unknown): EvidenceIdentityFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<EvidenceIdentityFile>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 3 || keys.join(',') !== 'createdAt,secret,version') return null;
  if (candidate.version !== 1
    || typeof candidate.secret !== 'string'
    || typeof candidate.createdAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.createdAt))) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(candidate.secret, 'base64url');
  } catch {
    return null;
  }
  return decoded.length === SECRET_BYTES && decoded.toString('base64url') === candidate.secret
    ? candidate as EvidenceIdentityFile
    : null;
}

function readIdentity(): EvidenceIdentityFile | null {
  if (!fs.existsSync(EVIDENCE_IDENTITY_PATH)) return null;
  const metadata = fs.lstatSync(EVIDENCE_IDENTITY_PATH);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_IDENTITY_BYTES) {
    throw new Error('Evidence identity file is not a private regular file');
  }
  try {
    const parsed = parseIdentity(JSON.parse(fs.readFileSync(EVIDENCE_IDENTITY_PATH, 'utf8')));
    if (parsed) return parsed;
  } catch {}
  throw new Error(`Invalid evidence identity file: ${EVIDENCE_IDENTITY_PATH}`);
}

function createIdentity(): EvidenceIdentityFile {
  const identity: EvidenceIdentityFile = {
    version: 1,
    secret: crypto.randomBytes(SECRET_BYTES).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(EVIDENCE_IDENTITY_PATH), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(EVIDENCE_IDENTITY_PATH, JSON.stringify(identity, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return identity;
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      const existing = readIdentity();
      if (existing) return existing;
    }
    throw error;
  }
}

export function getEvidenceKeyMaterial(): EvidenceKeyMaterial {
  if (cached) return { key: Buffer.from(cached.key), keyId: cached.keyId };
  const identity = readIdentity() || createIdentity();
  const key = Buffer.from(identity.secret, 'base64url');
  const keyId = crypto.createHash('sha256')
    .update('lumi.provider-outbound.evidence-key.v1\0', 'utf8')
    .update(key)
    .digest('hex');
  cached = { key, keyId };
  return { key: Buffer.from(key), keyId };
}

export function getEvidenceIdentityPath(): string {
  return EVIDENCE_IDENTITY_PATH;
}

export function resetEvidenceIdentityCacheForTests(): void {
  cached = null;
}
