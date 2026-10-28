import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getDataPath } from '../config/data_path';
import { getJwtSecret } from '../config/local_identity';
import type { XiaozhiPrivateBinding } from './xiaozhi_mcp_gateway';

export interface XiaozhiBindingRepository {
  load(): XiaozhiPrivateBinding[];
  save(bindings: XiaozhiPrivateBinding[]): void;
}
export interface XiaozhiRepositoryOptions { filePath?: string | (() => string); secret?: () => string }
const PURPOSE = 'lumi.xiaozhi.private-bindings.v1';
const MAX_BYTES = 4 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
function validate(bindings: unknown): asserts bindings is XiaozhiPrivateBinding[] {
  if (!Array.isArray(bindings)) throw new Error('Invalid Xiaozhi private binding store.');
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!object(b) || typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(b.id) || seen.has(b.id)
      || !id(b.ownerUid) || !id(b.deviceId) || !(b.clientId === null || id(b.clientId))
      || !Number.isFinite(b.createdAt) || !Number.isFinite(b.pairingExpiresAt) || !(b.pairedAt === null || Number.isFinite(b.pairedAt))
      || ![b.bootstrapSecret, b.deviceSecret, b.bridgeSecret].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new Error('Invalid Xiaozhi private binding store.');
    try {
      const u = new URL(String(b.publicBaseUrl));
      if (u.protocol !== 'http:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || ['0.0.0.0', '[::]'].includes(u.hostname)) throw new Error();
    } catch { throw new Error('Invalid Xiaozhi private binding store.'); }
    seen.add(b.id);
  }
}
function decode(value: unknown, size: number | null): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted Xiaozhi binding store.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== null && bytes.length !== size)) throw new Error('Invalid encrypted Xiaozhi binding store.');
  return bytes;
}

/** Private, installation-key-bound storage. No plaintext owner or device credential is persisted. */
export class EncryptedXiaozhiRepository implements XiaozhiBindingRepository {
  constructor(private readonly options: XiaozhiRepositoryOptions = {}) {}
  private file(): string {
    return typeof this.options.filePath === 'function' ? this.options.filePath() : this.options.filePath ?? getDataPath('devices/xiaozhi-bindings.enc.json');
  }
  private key(salt: Buffer): Buffer {
    const secret = (this.options.secret ?? getJwtSecret)();
    if (!secret) throw new Error('The installation identity is unavailable for Xiaozhi binding storage.');
    return Buffer.from(hkdfSync('sha256', secret, salt, PURPOSE, 32));
  }
  load(): XiaozhiPrivateBinding[] {
    const file = this.file();
    let encoded: string;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid encrypted Xiaozhi binding store.');
      encoded = fs.readFileSync(file, 'utf8');
    } catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
    try {
      const outer: unknown = JSON.parse(encoded);
      if (!object(outer) || outer.version !== 1 || outer.algorithm !== 'aes-256-gcm') throw new Error();
      const salt = decode(outer.salt, 16), iv = decode(outer.iv, 12), tag = decode(outer.tag, 16), ciphertext = decode(outer.ciphertext, null);
      const decipher = createDecipheriv('aes-256-gcm', this.key(salt), iv);
      decipher.setAAD(Buffer.from(PURPOSE)); decipher.setAuthTag(tag);
      const payload: unknown = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      if (!object(payload) || payload.version !== 1) throw new Error();
      validate(payload.bindings);
      return structuredClone(payload.bindings);
    } catch { throw new Error('The encrypted Xiaozhi binding store could not be restored. The existing file was preserved.'); }
  }
  save(bindings: XiaozhiPrivateBinding[]): void {
    validate(bindings);
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(salt), iv);
    cipher.setAAD(Buffer.from(PURPOSE));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 1, bindings }), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('Xiaozhi binding storage is too large.');
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Xiaozhi binding storage must be a regular file.'); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp';
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, body, 'utf8'); fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
}
