import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDatabaseInitialized,
  querySQL,
  runSQL,
  withDatabaseSqlWriteLock,
  type DatabaseSqlWriteSession,
} from '../../db_layer';
import { getDataPath } from '../config/data_path';
import {
  hostPrivateFilePersistenceAdapter,
  windowsDpapiKeyProtectionAdapter,
  type PrivateFilePersistenceAdapter,
  type PrivateKeyProtectionAdapter,
} from '../adapters/private_persistence';
import {
  buildPendingConfirmationPersistenceRecord,
  configurePendingConfirmationPersistence,
  hydratePendingConfirmationFromPersistence,
  restorePendingConfirmationForRuntime,
  type PendingConfirmationPersistenceAdapter,
  type PendingConfirmationPersistenceRecord,
  type PendingToolConfirmation,
} from './pending_confirmation';

const KEY_BYTES = 32;
const MAX_CIPHERTEXT_CHARS = 16 * 1024 * 1024;
const MAX_REVOCATION_FILE_BYTES = 1024 * 1024;
const REVOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;

interface SqlAdapter {
  initialize(): Promise<void>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<void>;
  withWriteLock<T>(operation: (session: DatabaseSqlWriteSession) => Promise<T>): Promise<T>;
}

interface CipherEnvelope {
  schemaVersion: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface EncryptedPendingPayload {
  schemaVersion: 1;
  exactArgs: Record<string, any>;
  safeArgs: Record<string, any>;
  target: string;
  actionIntent: string;
}

interface PendingConfirmationRevocation {
  fingerprint: string;
  revision: number;
  expiresAt: number;
  revokedAt: string;
}

interface PendingConfirmationRevocationFile {
  schemaVersion: 1;
  revocations: PendingConfirmationRevocation[];
}

export interface PendingConfirmationRepositoryOptions {
  keyPath: string;
  platform?: NodeJS.Platform;
  keyProtectionAdapter?: PrivateKeyProtectionAdapter;
  filePersistenceAdapter?: PrivateFilePersistenceAdapter;
  sql?: SqlAdapter;
  now?: () => Date;
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function recordAad(record: PendingConfirmationPersistenceRecord): Buffer {
  return Buffer.from(JSON.stringify(stableValue({
    schema: 'lumicore.pending-confirmation.v1',
    id: record.id,
    userId: record.userId,
    toolName: record.toolName,
    argsHash: record.argsHash,
    target: record.target,
    payloadDigest: record.payloadDigest,
    safeArgs: record.safeArgs,
    actionIntent: record.actionIntent,
    source: record.source,
    domain: record.domain,
    orgId: record.orgId,
    channelId: record.channelId,
    taskId: record.taskId,
    originRequestId: record.originRequestId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  })), 'utf8');
}

function parseSafeArgs(value: unknown): Record<string, any> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function rowToRecord(row: any): PendingConfirmationPersistenceRecord | null {
  const safeArgs = parseSafeArgs(row?.safeArgs);
  const revision = Number(row?.revision);
  const expiresAt = Number(row?.expiresAt);
  if (
    !row || Number(row.schemaVersion) !== 1 || !safeArgs
    || !Number.isSafeInteger(revision) || revision < 1
    || !Number.isFinite(expiresAt)
  ) return null;
  const exactArgsCiphertext = String(row.exactArgsCiphertext || '');
  if (!exactArgsCiphertext || exactArgsCiphertext.length > MAX_CIPHERTEXT_CHARS) return null;
  return {
    schemaVersion: 1,
    revision,
    status: String(row.status || '') as PendingConfirmationPersistenceRecord['status'],
    id: String(row.id || ''),
    userId: String(row.userId || ''),
    toolName: String(row.toolName || ''),
    argsHash: String(row.argsHash || ''),
    target: String(row.target || ''),
    payloadDigest: String(row.payloadDigest || ''),
    exactArgsCiphertext,
    safeArgs,
    actionIntent: String(row.actionIntent || ''),
    source: String(row.source || ''),
    domain: String(row.domain || ''),
    orgId: String(row.orgId || ''),
    channelId: String(row.channelId || ''),
    taskId: String(row.taskId || ''),
    originRequestId: String(row.originRequestId || ''),
    createdAt: String(row.createdAt || ''),
    updatedAt: String(row.updatedAt || ''),
    expiresAt,
  };
}

const sqliteAdapter: SqlAdapter = {
  initialize: ensureDatabaseInitialized,
  query: querySQL,
  run: runSQL,
  withWriteLock: withDatabaseSqlWriteLock,
};

export class PendingConfirmationRepository implements PendingConfirmationPersistenceAdapter {
  private readonly keyPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly keyProtectionAdapter: PrivateKeyProtectionAdapter;
  private readonly filePersistenceAdapter: PrivateFilePersistenceAdapter;
  private readonly sql: SqlAdapter;
  private readonly now: () => Date;
  private cachedKey: Buffer | null = null;

  constructor(options: PendingConfirmationRepositoryOptions) {
    this.keyPath = path.resolve(options.keyPath);
    this.platform = options.platform || process.platform;
    this.keyProtectionAdapter = options.keyProtectionAdapter || windowsDpapiKeyProtectionAdapter;
    this.filePersistenceAdapter = options.filePersistenceAdapter || hostPrivateFilePersistenceAdapter;
    this.sql = options.sql || sqliteAdapter;
    this.now = options.now || (() => new Date());
  }

  private get requireHostPosixMode(): boolean {
    return process.platform !== 'win32';
  }

  private getKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    if (this.platform === 'darwin') {
      throw new Error('Durable pending confirmations require macOS Keychain; using a plaintext data-root key is forbidden');
    }
    this.filePersistenceAdapter.ensurePrivateDirectory(path.dirname(this.keyPath), this.requireHostPosixMode);
    if (fs.existsSync(this.keyPath)) {
      const stored = fs.readFileSync(this.keyPath, 'utf8').trim();
      const key = this.platform === 'win32'
        ? stored.startsWith('dpapi:')
          ? this.keyProtectionAdapter.unprotectKey(stored.slice('dpapi:'.length))
          : Buffer.alloc(0)
        : stored.startsWith('plain:')
          ? Buffer.from(stored.slice('plain:'.length), 'base64')
          : Buffer.alloc(0);
      if (key.length !== KEY_BYTES) throw new Error('Pending confirmation key is unavailable or invalid');
      this.cachedKey = key;
      return key;
    }

    const key = crypto.randomBytes(KEY_BYTES);
    let serialized: string;
    if (this.platform === 'win32') {
      const protectedKey = this.keyProtectionAdapter.protectKey(key);
      const roundTrip = protectedKey
        ? this.keyProtectionAdapter.unprotectKey(protectedKey)
        : Buffer.alloc(0);
      if (roundTrip.length !== key.length || !crypto.timingSafeEqual(roundTrip, key)) {
        throw new Error('Windows DPAPI did not return a recoverable pending confirmation key');
      }
      serialized = `dpapi:${protectedKey}`;
    } else {
      serialized = `plain:${key.toString('base64')}`;
    }
    this.filePersistenceAdapter.writeTextAtomic(
      this.keyPath,
      serialized,
      0o600,
      this.requireHostPosixMode,
    );
    this.cachedKey = key;
    return key;
  }

  private get revocationPath(): string {
    return `${this.keyPath}.revocations.json`;
  }

  private revocationFingerprint(userId: string, id: string): string {
    return crypto.createHmac('sha256', this.getKey())
      .update(`${String(userId || '')}\u0000${String(id || '')}`, 'utf8')
      .digest('hex');
  }

  private readRevocations(nowMs = this.now().getTime()): PendingConfirmationRevocation[] {
    if (!fs.existsSync(this.revocationPath)) return [];
    const metadata = fs.lstatSync(this.revocationPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_REVOCATION_FILE_BYTES) {
      throw new Error('Pending confirmation revocation barrier is invalid');
    }
    const parsed = JSON.parse(fs.readFileSync(this.revocationPath, 'utf8')) as Partial<PendingConfirmationRevocationFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.revocations)) {
      throw new Error('Pending confirmation revocation barrier has an unsupported schema');
    }
    return parsed.revocations.filter(item => (
      item
      && typeof item.fingerprint === 'string'
      && /^[a-f0-9]{64}$/i.test(item.fingerprint)
      && Number.isSafeInteger(item.revision)
      && item.revision >= 1
      && Number.isFinite(item.expiresAt)
      && item.expiresAt + REVOCATION_RETENTION_MS > nowMs
      && typeof item.revokedAt === 'string'
    )).slice(-10_000);
  }

  private writeRevocations(revocations: PendingConfirmationRevocation[]): void {
    this.filePersistenceAdapter.writeTextAtomic(
      this.revocationPath,
      JSON.stringify({ schemaVersion: 1, revocations } satisfies PendingConfirmationRevocationFile),
      0o600,
      this.requireHostPosixMode,
    );
  }

  private persistRevocationBarrier(input: {
    id: string;
    userId: string;
    revision: number;
    expiresAt?: number;
  }): void {
    const now = this.now();
    const fingerprint = this.revocationFingerprint(input.userId, input.id);
    const current = this.readRevocations(now.getTime())
      .filter(item => item.fingerprint !== fingerprint);
    current.push({
      fingerprint,
      revision: input.revision,
      expiresAt: Number.isFinite(input.expiresAt)
        ? Number(input.expiresAt)
        : now.getTime() + REVOCATION_RETENTION_MS,
      revokedAt: now.toISOString(),
    });
    this.writeRevocations(current.slice(-10_000));
  }

  private encrypt(pending: PendingToolConfirmation): PendingConfirmationPersistenceRecord {
    const fullRecord = buildPendingConfirmationPersistenceRecord(pending, 'pending-encryption');
    // User text, destinations, patches, and even the redacted review envelope
    // remain private data. Keep only digests/markers in queryable columns and
    // place all display material inside the authenticated ciphertext.
    const placeholder: PendingConfirmationPersistenceRecord = {
      ...fullRecord,
      target: fullRecord.target ? `sha256:${sha256(fullRecord.target)}` : '',
      safeArgs: {
        encrypted: true,
        sha256: sha256(JSON.stringify(stableValue(fullRecord.safeArgs))),
      },
      actionIntent: fullRecord.actionIntent ? '[encrypted]' : '',
    };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    cipher.setAAD(recordAad(placeholder));
    const payload: EncryptedPendingPayload = {
      schemaVersion: 1,
      exactArgs: stableValue(pending.exactArgs || {}),
      safeArgs: stableValue(fullRecord.safeArgs || {}),
      target: fullRecord.target,
      actionIntent: fullRecord.actionIntent,
    };
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const envelope: CipherEnvelope = {
      schemaVersion: 1,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return { ...placeholder, exactArgsCiphertext: JSON.stringify(envelope) };
  }

  private decrypt(record: PendingConfirmationPersistenceRecord): EncryptedPendingPayload | null {
    try {
      const envelope = JSON.parse(record.exactArgsCiphertext) as Partial<CipherEnvelope>;
      if (
        envelope.schemaVersion !== 1
        || typeof envelope.iv !== 'string' || envelope.iv.length > 64
        || typeof envelope.authTag !== 'string' || envelope.authTag.length > 64
        || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_CIPHERTEXT_CHARS
      ) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(recordAad(record));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as Partial<EncryptedPendingPayload>;
      if (
        parsed?.schemaVersion !== 1
        || !parsed.exactArgs || typeof parsed.exactArgs !== 'object' || Array.isArray(parsed.exactArgs)
        || !parsed.safeArgs || typeof parsed.safeArgs !== 'object' || Array.isArray(parsed.safeArgs)
        || typeof parsed.target !== 'string'
        || typeof parsed.actionIntent !== 'string'
      ) return null;
      if (record.target && record.target !== `sha256:${sha256(parsed.target)}`) return null;
      if (
        String(record.safeArgs?.sha256 || '')
        !== sha256(JSON.stringify(stableValue(parsed.safeArgs)))
      ) return null;
      return parsed as EncryptedPendingPayload;
    } catch {
      return null;
    }
  }

  async initializeAndHydrate(): Promise<number> {
    await this.sql.initialize();
    await this.sql.run(`CREATE TABLE IF NOT EXISTS pending_tool_confirmations (
      id TEXT PRIMARY KEY,
      schemaVersion INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      userId TEXT NOT NULL,
      toolName TEXT NOT NULL,
      argsHash TEXT NOT NULL,
      target TEXT NOT NULL,
      payloadDigest TEXT NOT NULL,
      exactArgsCiphertext TEXT NOT NULL,
      safeArgs TEXT NOT NULL,
      actionIntent TEXT NOT NULL,
      source TEXT NOT NULL,
      domain TEXT NOT NULL,
      orgId TEXT NOT NULL,
      channelId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      originRequestId TEXT NOT NULL,
      claimToken TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
    await this.sql.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_confirmation_active_scope
       ON pending_tool_confirmations(userId, domain, orgId, channelId)
       WHERE status = 'pending'`,
    );
    const now = this.now();
    const revocations = this.readRevocations(now.getTime());
    const rows = await this.sql.withWriteLock(async sql => {
      await sql.run(
        `UPDATE pending_tool_confirmations
         SET status = 'expired', revision = revision + 1, updatedAt = ?
         WHERE status = 'pending' AND expiresAt <= ?`,
        [now.toISOString(), now.getTime()],
      );
      const activeRows = await sql.query<any>(
        `SELECT * FROM pending_tool_confirmations
         WHERE status = 'pending' AND expiresAt > ?
         ORDER BY createdAt ASC`,
        [now.getTime()],
      );
      const restorable: any[] = [];
      for (const row of activeRows) {
        const fingerprint = this.revocationFingerprint(String(row.userId || ''), String(row.id || ''));
        const revoked = revocations.some(item => item.fingerprint === fingerprint);
        if (!revoked) {
          restorable.push(row);
          continue;
        }
        await sql.run(
          `UPDATE pending_tool_confirmations
           SET status = 'cancelled', revision = revision + 1, updatedAt = ?
           WHERE id = ? AND userId = ? AND status = 'pending' AND revision = ?`,
          [now.toISOString(), row.id, row.userId, row.revision],
        );
      }
      return restorable;
    });
    let restored = 0;
    for (const row of rows) {
      const record = rowToRecord(row);
      if (!record) continue;
      const decrypted = this.decrypt(record);
      if (!decrypted) continue;
      const hydratedRecord: PendingConfirmationPersistenceRecord = {
        ...record,
        target: decrypted.target,
        safeArgs: decrypted.safeArgs,
        actionIntent: decrypted.actionIntent,
      };
      const pending = hydratePendingConfirmationFromPersistence(
        hydratedRecord,
        decrypted.exactArgs,
        now.getTime(),
      );
      if (pending && restorePendingConfirmationForRuntime(pending, record.revision)) restored += 1;
    }
    return restored;
  }

  async persist(pending: PendingToolConfirmation): Promise<number> {
    const record = this.encrypt(pending);
    const nowIso = this.now().toISOString();
    // Invalidate an older proposal first. A crash between these statements is
    // fail-closed (no active grant), while the partial unique index prevents
    // two active grants for one conversation scope.
    await this.sql.withWriteLock(async sql => {
      await sql.run(
        `UPDATE pending_tool_confirmations
         SET status = 'cancelled', revision = revision + 1, updatedAt = ?
         WHERE status = 'pending' AND userId = ? AND domain = ? AND orgId = ?
           AND channelId = ? AND id <> ?`,
        [nowIso, record.userId, record.domain, record.orgId, record.channelId, record.id],
      );
      await sql.run(
        `INSERT INTO pending_tool_confirmations
          (id, schemaVersion, revision, status, userId, toolName, argsHash, target,
           payloadDigest, exactArgsCiphertext, safeArgs, actionIntent, source,
           domain, orgId, channelId, taskId, originRequestId, claimToken,
           createdAt, updatedAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        [
          record.id, record.schemaVersion, record.revision, record.status,
          record.userId, record.toolName, record.argsHash, record.target,
          record.payloadDigest, record.exactArgsCiphertext, JSON.stringify(record.safeArgs),
          record.actionIntent, record.source, record.domain, record.orgId,
          record.channelId, record.taskId, record.originRequestId,
          record.createdAt, record.updatedAt, record.expiresAt,
        ],
      );
    });
    return record.revision;
  }

  async consume(input: { id: string; userId: string; revision: number }): Promise<boolean> {
    return this.claim(input, 'consumed');
  }

  async cancel(input: {
    id: string;
    userId: string;
    revision: number;
    expiresAt?: number;
  }): Promise<boolean> {
    return this.claim(input, 'cancelled', () => this.persistRevocationBarrier(input));
  }

  private async claim(
    input: { id: string; userId: string; revision: number },
    status: 'consumed' | 'cancelled',
    beforeClaim?: () => void,
  ): Promise<boolean> {
    const claimToken = crypto.randomUUID();
    const now = this.now();
    const rows = await this.sql.withWriteLock(async sql => {
      beforeClaim?.();
      await sql.run(
        `UPDATE pending_tool_confirmations
         SET status = ?, revision = revision + 1, claimToken = ?, updatedAt = ?
         WHERE id = ? AND userId = ? AND status = 'pending'
           AND revision = ? AND expiresAt > ?`,
        [status, claimToken, now.toISOString(), input.id, input.userId, input.revision, now.getTime()],
      );
      return sql.query<any>(
        `SELECT claimToken FROM pending_tool_confirmations
         WHERE id = ? AND userId = ? AND status = ?`,
        [input.id, input.userId, status],
      );
    });
    const actual = String(rows[0]?.claimToken || '');
    return Boolean(actual) && actual === claimToken;
  }
}

let defaultRepository: PendingConfirmationRepository | null = null;
let initialization: Promise<number> | null = null;

function getDefaultRepository(): PendingConfirmationRepository {
  if (!defaultRepository) {
    defaultRepository = new PendingConfirmationRepository({
      keyPath: getDataPath('private/pending_confirmations.key'),
    });
  }
  return defaultRepository;
}

export function ensurePendingConfirmationPersistenceInitialized(): Promise<number> {
  if (!initialization) {
    if (process.platform === 'darwin') {
      // Until the native Keychain adapter is available, keep confirmations
      // memory-only on macOS. Exact arguments must never be encrypted with a
      // plaintext key stored beside their ciphertext.
      configurePendingConfirmationPersistence(null);
      initialization = Promise.resolve(0);
      return initialization;
    }
    const repository = getDefaultRepository();
    initialization = repository.initializeAndHydrate()
      .then(restored => {
        configurePendingConfirmationPersistence(repository);
        return restored;
      })
      .catch(error => {
        initialization = null;
        throw error;
      });
  }
  return initialization;
}

export function resetPendingConfirmationRepositoryForTests(): void {
  defaultRepository = null;
  initialization = null;
  configurePendingConfirmationPersistence(null);
}
