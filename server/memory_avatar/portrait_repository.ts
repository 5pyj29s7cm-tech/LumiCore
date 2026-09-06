import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '../config/data_path';
import { hostPrivateFilePersistenceAdapter, windowsDpapiKeyProtectionAdapter, type PrivateFilePersistenceAdapter, type PrivateKeyProtectionAdapter } from '../adapters/private_persistence';
import { PortraitError, type ProviderPortraitStream } from './portrait_provider';

export interface PortraitSessionRecord {
  id: string; avatarId: string; callSessionId: string; clientRequestId: string; mediaId: string;
  createdAt: number; expiresAt: number; epoch: string;
  status: 'creating' | 'offered' | 'ready' | 'unknown' | 'stopped' | 'failed';
  step?: string; errorCode?: string; stopRequested?: boolean;
  imageId?: string; agentId?: string; stream?: ProviderPortraitStream;
  answerHash?: string;
  credential?: string;
  unlocatedUploads?: number;
  unlocatedCreation?: 'agent' | 'stream';
  audioIds: string[];
  speeches: Record<string, { hash: string; status: 'started' | 'accepted' | 'unknown' | 'failed' }>;
}
export interface PortraitUserRecord {
  version: 1;
  config: { apiKey?: string; consent: boolean; generation: number };
  sessions: PortraitSessionRecord[];
}
const empty = (): PortraitUserRecord => ({ version: 1, config: { consent: false, generation: 0 }, sessions: [] });

/** Private local storage, using the same host ACL/DPAPI and atomic fsync adapter
 * as durable tool confirmations. Windows protection failures never fall back to
 * plaintext. On POSIX, the key and encrypted records require owner-only modes. */
export class PortraitRepository {
  private masterKey?: Buffer;
  private readonly directory: string;
  private readonly platform: NodeJS.Platform;
  private readonly files: PrivateFilePersistenceAdapter;
  private readonly protection: PrivateKeyProtectionAdapter;
  constructor(options: { directory?: string; platform?: NodeJS.Platform; files?: PrivateFilePersistenceAdapter; protection?: PrivateKeyProtectionAdapter } = {}) {
    this.directory = options.directory || getDataPath('memory-avatar-portrait');
    this.platform = options.platform || process.platform;
    this.files = options.files || hostPrivateFilePersistenceAdapter;
    this.protection = options.protection || windowsDpapiKeyProtectionAdapter;
  }
  private key(): Buffer {
    if (this.masterKey) return this.masterKey;
    this.files.ensurePrivateDirectory(this.directory, this.platform !== 'win32');
    const filename = path.join(this.directory, 'key');
    if (fs.existsSync(filename)) {
      const value = this.readFile(filename, 16_384);
      const key = this.platform === 'win32'
        ? value.startsWith('dpapi:') ? this.protection.unprotectKey(value.slice(6)) : Buffer.alloc(0)
        : value.startsWith('plain:') ? Buffer.from(value.slice(6), 'base64') : Buffer.alloc(0);
      if (key.length !== 32) throw new Error('Portrait encryption key unavailable.');
      this.masterKey = key; return key;
    }
    const key = crypto.randomBytes(32);
    const encoded = this.platform === 'win32' ? `dpapi:${this.protection.protectKey(key)}` : `plain:${key.toString('base64')}`;
    if (this.platform === 'win32' && !crypto.timingSafeEqual(this.protection.unprotectKey(encoded.slice(6)), key)) throw new Error('Portrait key protection failed.');
    this.files.writeTextAtomic(filename, encoded, 0o600, this.platform !== 'win32');
    this.masterKey = key; return key;
  }
  private filename(userId: string): string { return path.join(this.directory, `${crypto.createHash('sha256').update(userId).digest('hex')}.json`); }
  private aad(userId: string): Buffer { return Buffer.from(JSON.stringify(['LumiCore.memory-avatar-portrait.v1', userId])); }
  private readFile(filename: string, limit: number): string {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Unsafe portrait persistence file.');
    return fs.readFileSync(filename, 'utf8');
  }
  read(userId: string): PortraitUserRecord {
    const filename = this.filename(userId);
    try {
      if (!fs.existsSync(filename)) return empty();
      const envelope = JSON.parse(this.readFile(filename, 16 * 1024 * 1024));
      if (envelope.version !== 1) throw new Error('Unknown portrait persistence schema.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(this.aad(userId)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      if (record.version !== 1 || !record.config || !Array.isArray(record.sessions)) throw new Error('Invalid portrait record.');
      return record;
    } catch { throw new PortraitError('portrait_storage_unavailable', 'The private portrait configuration or recovery log could not be opened.', 503); }
  }
  write(userId: string, value: PortraitUserRecord): void {
    try {
      const plain = JSON.stringify(value);
      if (Buffer.byteLength(plain) > 10 * 1024 * 1024) throw new Error('Portrait log is full.');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv); cipher.setAAD(this.aad(userId));
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      this.files.writeTextAtomic(this.filename(userId), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), 0o600, this.platform !== 'win32');
    } catch { throw new PortraitError('portrait_save_failed', 'The private portrait state could not be saved. No new remote operation will be started.', 503); }
  }
}
