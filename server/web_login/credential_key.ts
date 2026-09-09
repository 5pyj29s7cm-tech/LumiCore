import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostPrivateFilePersistenceAdapter, windowsDpapiKeyProtectionAdapter, type PrivateFilePersistenceAdapter, type PrivateKeyProtectionAdapter } from '../adapters/private_persistence';

/** Retains legacy key bytes during migration; never silently weakens protection. */
export function getWebLoginCredentialKey(filename: string, options: {
  platform?: NodeJS.Platform; files?: PrivateFilePersistenceAdapter; protection?: PrivateKeyProtectionAdapter;
} = {}): Buffer {
  const platform = options.platform || process.platform;
  const files = options.files || hostPrivateFilePersistenceAdapter;
  const protection = options.protection || windowsDpapiKeyProtectionAdapter;
  files.ensurePrivateDirectory(path.dirname(filename), platform !== 'win32');
  const write = (key: Buffer) => {
    const encoded = platform === 'win32' ? `dpapi:${protection.protectKey(key)}` : `plain:${key.toString('base64')}`;
    if (platform === 'win32' && !crypto.timingSafeEqual(protection.unprotectKey(encoded.slice(6)), key)) {
      throw new Error('Web-login key protection could not be verified.');
    }
    files.writeTextAtomic(filename, encoded, 0o600, platform !== 'win32');
  };
  if (!fs.existsSync(filename)) {
    const key = crypto.randomBytes(32); write(key); return key;
  }
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error('Unsafe web-login credential key file.');
  const stored = fs.readFileSync(filename, 'utf8').trim();
  if (stored.startsWith('dpapi:')) {
    const key = protection.unprotectKey(stored.slice(6));
    if (key.length !== 32) throw new Error('Invalid web-login credential key.');
    return key;
  }
  const encoded = stored.startsWith('plain:') ? stored.slice(6) : stored;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid web-login credential key.');
  if (platform === 'win32') write(key);
  return key;
}
