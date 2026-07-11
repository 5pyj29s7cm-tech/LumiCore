import crypto from 'crypto';
import fs from 'fs';
import { getDataPath } from './data_path';

interface LocalIdentity {
  version: 1;
  jwtSecret: string;
  adminPassword: string;
  createdAt: string;
}

const IDENTITY_FILE = getDataPath('local_identity.json');
let cachedIdentity: LocalIdentity | null = null;

function isValidIdentity(value: unknown): value is LocalIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<LocalIdentity>;
  return identity.version === 1
    && typeof identity.jwtSecret === 'string'
    && identity.jwtSecret.length >= 32
    && typeof identity.adminPassword === 'string'
    && identity.adminPassword.length >= 24
    && typeof identity.createdAt === 'string';
}

function readIdentity(): LocalIdentity | null {
  if (!fs.existsSync(IDENTITY_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    if (isValidIdentity(parsed)) return parsed;
  } catch {}
  throw new Error(`Invalid local identity file: ${IDENTITY_FILE}`);
}

function createIdentity(): LocalIdentity {
  const identity: LocalIdentity = {
    version: 1,
    jwtSecret: crypto.randomBytes(48).toString('base64url'),
    adminPassword: crypto.randomBytes(36).toString('base64url'),
    createdAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), {
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

function getLocalIdentity(): LocalIdentity {
  if (cachedIdentity) return cachedIdentity;
  cachedIdentity = readIdentity() || createIdentity();
  return cachedIdentity;
}

export function getJwtSecret(): string {
  const configured = String(process.env.JWT_SECRET || '').trim();
  return configured || getLocalIdentity().jwtSecret;
}

export function getLocalAdminPassword(): string {
  const configured = String(process.env.AUTO_LOGIN_PASSWORD || '').trim();
  return configured || getLocalIdentity().adminPassword;
}

export function getLocalIdentityPath(): string {
  return IDENTITY_FILE;
}

export function isLoopbackAddress(address?: string | null): boolean {
  const normalized = String(address || '').trim().toLowerCase().split('%')[0];
  if (!normalized) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.slice('::ffff:'.length));
  }

  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function resetLocalIdentityCacheForTests(): void {
  cachedIdentity = null;
}
