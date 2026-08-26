import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '../config/data_path';
import type { ModelGraphNodeEvidenceKind } from '../agents/model_execution_graph';
import {
  hostPrivateFilePersistenceAdapter,
  windowsDpapiKeyProtectionAdapter,
  type PrivateFilePersistenceAdapter,
  type PrivateKeyProtectionAdapter,
} from '../adapters/private_persistence';

export const PRIVATE_MODEL_HANDOFF_MAX_CHARS = 4_000;
export const PRIVATE_MODEL_HANDOFF_MAX_BATCH = 64;
export const PRIVATE_MODEL_HANDOFF_MAX_RECORDS = 256;
const PRIVATE_MODEL_HANDOFF_MAX_FILE_BYTES = 4 * 1024 * 1024;
const PRIVATE_MODEL_HANDOFF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const ACCEPTED_EVIDENCE_KINDS = new Set<ModelGraphNodeEvidenceKind>([
  'tool_terminal_verification',
  'validated_model_output',
]);

export interface PrivateModelHandoffBinding {
  userId: string;
  conversationId: string;
  taskId: string;
  graphId: string;
  nodeId: string;
  outputDigest: string;
}

export interface PrivateModelHandoffInput extends PrivateModelHandoffBinding {
  outputSummary: string;
  evidenceKind: ModelGraphNodeEvidenceKind;
}

export interface PrivateModelHandoffLoadBinding extends PrivateModelHandoffBinding {
  evidenceKind?: ModelGraphNodeEvidenceKind;
}

interface EncryptedHandoffRecord {
  schemaVersion: 1;
  bindingDigest: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

interface EncryptedHandoffFile {
  schemaVersion: 1;
  records: EncryptedHandoffRecord[];
}

interface PrivateModelHandoffEnvelope extends PrivateModelHandoffBinding {
  schemaVersion: 1;
  outputSummary: string;
  summaryDigest: string;
  evidenceKind: ModelGraphNodeEvidenceKind;
}

export interface PrivateModelHandoffStoreOptions {
  storePath: string;
  keyPath: string;
  platform?: NodeJS.Platform;
  keyProtectionAdapter?: PrivateKeyProtectionAdapter;
  filePersistenceAdapter?: PrivateFilePersistenceAdapter;
  now?: () => Date;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizeId(value: unknown, max: number): string {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= max && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : '';
}

function normalizeBinding(value: PrivateModelHandoffBinding): PrivateModelHandoffBinding | null {
  const binding = {
    userId: normalizeId(value.userId, 256),
    conversationId: normalizeId(value.conversationId, 240),
    taskId: normalizeId(value.taskId, 240),
    graphId: normalizeId(value.graphId, 240),
    nodeId: normalizeId(value.nodeId, 240),
    outputDigest: String(value.outputDigest || '').trim().toLowerCase(),
  };
  return binding.userId
    && binding.conversationId
    && binding.taskId
    && binding.graphId
    && binding.nodeId
    && /^[a-f0-9]{64}$/.test(binding.outputDigest)
    ? binding
    : null;
}

function bindingAad(binding: PrivateModelHandoffBinding): Buffer {
  return Buffer.from(JSON.stringify({
    schema: 'lumi.private-model-handoff.v1',
    userId: binding.userId,
    conversationId: binding.conversationId,
    taskId: binding.taskId,
    graphId: binding.graphId,
    nodeId: binding.nodeId,
    outputDigest: binding.outputDigest,
  }), 'utf8');
}

function compactOutputSummary(value: unknown): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, PRIVATE_MODEL_HANDOFF_MAX_CHARS);
}

export class PrivateModelHandoffStore {
  private readonly storePath: string;
  private readonly keyPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly keyProtectionAdapter: PrivateKeyProtectionAdapter;
  private readonly filePersistenceAdapter: PrivateFilePersistenceAdapter;
  private readonly now: () => Date;
  private cachedKey: Buffer | null = null;

  /**
   * `options.platform` selects the key-protection branch in cross-platform
   * tests. File-mode enforcement must follow the filesystem host: Windows
   * cannot emulate POSIX 0600/0700 semantics, while every real non-Windows
   * production process must verify them.
   */
  private get requireHostPosixMode(): boolean {
    return process.platform !== 'win32';
  }

  constructor(options: PrivateModelHandoffStoreOptions) {
    this.storePath = path.resolve(options.storePath);
    this.keyPath = path.resolve(options.keyPath);
    this.platform = options.platform || process.platform;
    this.keyProtectionAdapter = options.keyProtectionAdapter || windowsDpapiKeyProtectionAdapter;
    this.filePersistenceAdapter = options.filePersistenceAdapter || hostPrivateFilePersistenceAdapter;
    this.now = options.now || (() => new Date());
  }

  persistBatch(inputs: PrivateModelHandoffInput[]): boolean {
    if (!Array.isArray(inputs) || inputs.length > PRIVATE_MODEL_HANDOFF_MAX_BATCH) return false;
    if (inputs.length === 0) return true;

    const prepared = inputs.map(input => {
      const binding = normalizeBinding(input);
      const outputSummary = compactOutputSummary(input.outputSummary);
      if (!binding || !outputSummary || !ACCEPTED_EVIDENCE_KINDS.has(input.evidenceKind)) return null;
      return { binding, outputSummary, evidenceKind: input.evidenceKind };
    });
    if (prepared.some(item => !item)) return false;

    const key = this.getKey();
    const updatedAt = this.now().toISOString();
    const nextByBinding = new Map(this.readFile().records.map(record => [record.bindingDigest, record]));
    for (const item of prepared) {
      if (!item) continue;
      const aad = bindingAad(item.binding);
      const bindingDigest = sha256(aad);
      const envelope: PrivateModelHandoffEnvelope = {
        schemaVersion: 1,
        ...item.binding,
        outputSummary: item.outputSummary,
        summaryDigest: sha256(item.outputSummary),
        evidenceKind: item.evidenceKind,
      };
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(envelope), 'utf8'),
        cipher.final(),
      ]);
      const record: EncryptedHandoffRecord = {
        schemaVersion: 1,
        bindingDigest,
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        updatedAt,
      };
      nextByBinding.delete(bindingDigest);
      nextByBinding.set(bindingDigest, record);
    }

    const cutoff = this.now().getTime() - PRIVATE_MODEL_HANDOFF_MAX_AGE_MS;
    const records = [...nextByBinding.values()]
      .filter(record => (Date.parse(record.updatedAt) || 0) >= cutoff)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(-PRIVATE_MODEL_HANDOFF_MAX_RECORDS);
    this.writeFile({ schemaVersion: 1, records });
    return true;
  }

  load(bindingInput: PrivateModelHandoffLoadBinding): string | null {
    const binding = normalizeBinding(bindingInput);
    const expectedEvidenceKind = bindingInput.evidenceKind;
    if (!binding) return null;
    try {
      const aad = bindingAad(binding);
      const expectedBindingDigest = sha256(aad);
      const record = this.readFile().records.find(candidate => (
        constantTimeHexEqual(candidate.bindingDigest, expectedBindingDigest)
      ));
      if (!record) return null;
      if ((Date.parse(record.updatedAt) || 0) < this.now().getTime() - PRIVATE_MODEL_HANDOFF_MAX_AGE_MS) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(record.iv, 'base64'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const envelope = JSON.parse(plaintext) as Partial<PrivateModelHandoffEnvelope>;
      const storedBinding = normalizeBinding(envelope as PrivateModelHandoffBinding);
      const outputSummary = compactOutputSummary(envelope.outputSummary);
      if (
        envelope.schemaVersion !== 1
        || !storedBinding
        || Object.keys(binding).some(key => storedBinding[key as keyof PrivateModelHandoffBinding] !== binding[key as keyof PrivateModelHandoffBinding])
        || !ACCEPTED_EVIDENCE_KINDS.has(envelope.evidenceKind as ModelGraphNodeEvidenceKind)
        || (expectedEvidenceKind !== undefined && envelope.evidenceKind !== expectedEvidenceKind)
        || !outputSummary
        || envelope.outputSummary !== outputSummary
        || !constantTimeHexEqual(String(envelope.summaryDigest || ''), sha256(outputSummary))
      ) return null;
      return outputSummary;
    } catch {
      return null;
    }
  }

  private getKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    this.filePersistenceAdapter.ensurePrivateDirectory(
      path.dirname(this.keyPath),
      this.requireHostPosixMode,
    );
    if (fs.existsSync(this.keyPath)) {
      const stored = fs.readFileSync(this.keyPath, 'utf8').trim();
      const key = this.platform === 'win32'
        ? stored.startsWith('dpapi:')
          ? this.keyProtectionAdapter.unprotectKey(stored.slice('dpapi:'.length))
          : Buffer.alloc(0)
        : stored.startsWith('plain:')
          ? Buffer.from(stored.slice('plain:'.length), 'base64')
          : Buffer.alloc(0);
      if (key.length !== 32) throw new Error('Private model handoff key is unavailable or invalid.');
      this.cachedKey = key;
      return key;
    }

    const key = crypto.randomBytes(32);
    let serialized: string;
    if (this.platform === 'win32') {
      const protectedKey = this.keyProtectionAdapter.protectKey(key);
      const roundTrip = protectedKey
        ? this.keyProtectionAdapter.unprotectKey(protectedKey)
        : Buffer.alloc(0);
      if (roundTrip.length !== key.length || !crypto.timingSafeEqual(roundTrip, key)) {
        throw new Error('Windows DPAPI did not return a recoverable private model handoff key.');
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

  private readFile(): EncryptedHandoffFile {
    if (!fs.existsSync(this.storePath)) return { schemaVersion: 1, records: [] };
    try {
      const stat = fs.statSync(this.storePath);
      if (!stat.isFile() || stat.size > PRIVATE_MODEL_HANDOFF_MAX_FILE_BYTES) return { schemaVersion: 1, records: [] };
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Partial<EncryptedHandoffFile>;
      const records = Array.isArray(parsed.records)
        ? parsed.records.filter((record): record is EncryptedHandoffRecord => Boolean(
            record
            && record.schemaVersion === 1
            && /^[a-f0-9]{64}$/.test(String(record.bindingDigest || ''))
            && typeof record.iv === 'string' && record.iv.length <= 64
            && typeof record.authTag === 'string' && record.authTag.length <= 64
            && typeof record.ciphertext === 'string' && record.ciphertext.length <= PRIVATE_MODEL_HANDOFF_MAX_CHARS * 3
            && typeof record.updatedAt === 'string' && record.updatedAt.length <= 80,
          )).slice(-PRIVATE_MODEL_HANDOFF_MAX_RECORDS)
        : [];
      return { schemaVersion: 1, records };
    } catch {
      return { schemaVersion: 1, records: [] };
    }
  }

  private writeFile(value: EncryptedHandoffFile): void {
    this.filePersistenceAdapter.writeTextAtomic(
      this.storePath,
      `${JSON.stringify(value)}\n`,
      0o600,
      this.requireHostPosixMode,
    );
  }
}

let defaultStore: PrivateModelHandoffStore | null = null;

function getDefaultStore(): PrivateModelHandoffStore {
  if (!defaultStore) {
    defaultStore = new PrivateModelHandoffStore({
      storePath: getDataPath('private/model_handoffs.v1.json'),
      keyPath: getDataPath('private/model_handoffs.key'),
    });
  }
  return defaultStore;
}

export function persistPrivateModelHandoffs(inputs: PrivateModelHandoffInput[]): boolean {
  try {
    return getDefaultStore().persistBatch(inputs);
  } catch {
    return false;
  }
}

export function loadPrivateModelHandoff(binding: PrivateModelHandoffLoadBinding): string | null {
  try {
    return getDefaultStore().load(binding);
  } catch {
    return null;
  }
}
