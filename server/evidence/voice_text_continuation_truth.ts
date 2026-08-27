import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import path from 'node:path';
import { readDB } from '../../db_layer';

export const VOICE_TEXT_CONTINUATION_TRUTH_KIND =
  'lumi.voice-text-continuation-truth' as const;
export const VOICE_TEXT_CONTINUATION_TRUTH_SCHEMA_VERSION = 1 as const;
export const VOICE_TEXT_CONTINUATION_TRUTH_SIGNER_KIND =
  'lumi.voice-text-continuation-truth-signer' as const;
export const VOICE_TEXT_CONTINUATION_TRUTH_ENVELOPE_KIND =
  'lumi.voice-text-continuation-truth-envelope' as const;
export const VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_KIND =
  'lumi.voice-text-continuation-truth-attestation' as const;
export const VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION = 1 as const;

const VOICE_TEXT_CONTINUATION_SIGNATURE_DOMAIN =
  'lumi-voice-text-continuation-truth-attestation-v1\0';
const VOICE_TEXT_CONTINUATION_KEY_ID_DOMAIN =
  'lumi-voice-text-continuation-truth-ed25519-key-v1\0';

const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface BuildVoiceTextContinuationTruthInput {
  db: any;
  scenarioId: string;
  acceptanceRunId: string;
  buildIdentityDigest: string;
  userId: string;
  conversationId: string;
  textRequestId: string;
  taskId: string;
  capturedAt?: string;
}

export type CaptureVoiceTextContinuationTruthInput = Omit<
  BuildVoiceTextContinuationTruthInput,
  'db'
>;

export interface VoiceTextContinuationTruth {
  kind: typeof VOICE_TEXT_CONTINUATION_TRUTH_KIND;
  schemaVersion: typeof VOICE_TEXT_CONTINUATION_TRUTH_SCHEMA_VERSION;
  scenarioId: 'voice_to_text_continuation';
  acceptanceRunId: string;
  buildIdentityDigest: string;
  conversationId: string;
  capturedAt: string;
  task: {
    recordId: string;
    taskId: string;
    revision: number;
    finalStatus: 'completed';
  };
  voiceStart: {
    request: CanonicalRequest;
    userMessage: CanonicalVoiceMessage;
    capture: {
      captureMode: 'synthetic_accepted_transcript';
      audioInputKind: 'synthetic_accepted_transcript';
      syntheticAudio: true;
      captureSessionId: null;
      sttReceiptId: null;
      contextChainId: null;
      previousRequestId: null;
      nativeDeviceId: null;
      executionSessionId: null;
      nativeClientIdentitySha256: null;
    };
    receipt: CanonicalReadReceipt & { outcome: 'failed' };
  };
  textContinue: {
    request: CanonicalRequest;
    userMessage: CanonicalTextCorrectionMessage;
    receipt: CanonicalReadReceipt & { outcome: 'verified_success' };
  };
  channelHandoff: {
    sourceRequestId: string;
    targetRequestId: string;
    sourceTaskId: string;
    targetTaskId: string;
    sourceChannel: 'voice';
    targetChannel: 'text';
    sourceMessageIds: [string, string];
    targetMessageId: string;
    recordedAt: string;
  };
  targetCorrection: {
    recordId: string;
    source: 'user_correction';
    sourceRequestId: string;
    targetRequestId: string;
    taskId: string;
    correctionMessageId: string;
    previousTarget: string;
    replacementTarget: string;
    previousTaskTargetSha256: string;
    replacementTaskTargetSha256: string;
    rejectedTargetSha256: string;
    recordedAt: string;
  };
  evidenceDigestSha256: string;
}

export interface VoiceTextContinuationTruthSignerDescriptor {
  kind: typeof VOICE_TEXT_CONTINUATION_TRUTH_SIGNER_KIND;
  schemaVersion: typeof VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION;
  algorithm: 'ed25519';
  keyId: string;
  publicKeySpkiBase64: string;
  serverInstanceNonce: string;
  acceptanceRunId: string;
  buildIdentityDigest: string;
  dataRootIdentitySha256: string;
}

export interface VoiceTextContinuationTruthEnvelope {
  kind: typeof VOICE_TEXT_CONTINUATION_TRUTH_ENVELOPE_KIND;
  schemaVersion: typeof VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION;
  binding: {
    acceptanceRunId: string;
    buildIdentityDigest: string;
    dataRootIdentitySha256: string;
    serverInstanceNonce: string;
    scenarioId: 'voice_to_text_continuation';
    conversationId: string;
    voiceRequestId: string;
    textRequestId: string;
    taskId: string;
    capturedAt: string;
    evidenceDigestSha256: string;
  };
  truth: VoiceTextContinuationTruth;
  attestation: {
    kind: typeof VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_KIND;
    schemaVersion: typeof VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION;
    algorithm: 'ed25519';
    keyId: string;
    signatureBase64: string;
  };
}

export interface VoiceTextContinuationTruthAttester {
  readonly descriptor: Readonly<VoiceTextContinuationTruthSignerDescriptor>;
  attest: (truth: VoiceTextContinuationTruth) => VoiceTextContinuationTruthEnvelope;
}

export interface CreateVoiceTextContinuationTruthAttesterInput {
  acceptanceRunId: string;
  buildIdentityDigest: string;
  dataRootIdentitySha256: string;
  serverInstanceNonce?: string;
}

interface CanonicalRequest {
  recordId: string;
  requestId: string;
  taskId: string;
  channel: 'voice' | 'text';
  source: string;
  terminalStatus: 'blocked' | 'completed';
  userMessageId: string;
  assistantMessageId: string;
  recordedAt: string;
}

interface CanonicalVoiceMessage {
  recordId: string;
  source: 'voice';
  channel: 'voice';
  mode: 'voice';
  textSha256: string;
  recordedAt: string;
}

interface CanonicalTextCorrectionMessage {
  recordId: string;
  source: string;
  channel: 'text';
  cognitiveIntent: 'task_correction';
  textSha256: string;
  recordedAt: string;
}

interface CanonicalReadReceipt {
  recordId: string;
  receiptId: string;
  requestId: string;
  taskId: string;
  toolName: 'read_file';
  outcome: 'failed' | 'verified_success';
  inputSha256: string;
  target: {
    targetKind: 'filesystem';
    targetId: string;
    targetSha256: string;
  };
  recordedAt: string;
}

function required(value: unknown, code: string, limit = 2_000): string {
  const result = String(value ?? '').trim().slice(0, limit);
  if (!result) throw new Error(code);
  return result;
}

function canonicalInstant(value: unknown, code: string): string {
  const result = required(value, code, 80);
  if (!Number.isFinite(Date.parse(result))) throw new Error(code);
  return new Date(result).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function signerKeyId(publicKeySpki: Buffer): string {
  return createHash('sha256')
    .update(VOICE_TEXT_CONTINUATION_KEY_ID_DOMAIN, 'utf8')
    .update(publicKeySpki)
    .digest('hex');
}

function signaturePayload(core: Pick<
  VoiceTextContinuationTruthEnvelope,
  'kind' | 'schemaVersion' | 'binding' | 'truth'
>): Buffer {
  return Buffer.concat([
    Buffer.from(VOICE_TEXT_CONTINUATION_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(stableJson(core), 'utf8'),
  ]);
}

function truthBindingForAttestation(
  descriptor: VoiceTextContinuationTruthSignerDescriptor,
  truth: VoiceTextContinuationTruth,
): VoiceTextContinuationTruthEnvelope['binding'] {
  const capturedAt = canonicalInstant(
    truth.capturedAt,
    'voice_text_truth_capture_time_invalid',
  );
  if (capturedAt !== truth.capturedAt) throw new Error('voice_text_truth_capture_time_invalid');
  const buildIdentityDigest = String(truth.buildIdentityDigest || '').trim().toLowerCase();
  const evidenceDigestSha256 = String(truth.evidenceDigestSha256 || '').trim().toLowerCase();
  const { evidenceDigestSha256: _digest, ...truthWithoutDigest } = truth;
  if (
    truth.kind !== VOICE_TEXT_CONTINUATION_TRUTH_KIND
    || truth.schemaVersion !== VOICE_TEXT_CONTINUATION_TRUTH_SCHEMA_VERSION
    || truth.scenarioId !== 'voice_to_text_continuation'
    || truth.acceptanceRunId !== descriptor.acceptanceRunId
    || buildIdentityDigest !== descriptor.buildIdentityDigest
    || !SHA256_RE.test(evidenceDigestSha256)
    || evidenceDigestSha256 !== sha256(stableJson(truthWithoutDigest))
  ) throw new Error('voice_text_truth_attestation_binding_invalid');
  const conversationId = required(
    truth.conversationId,
    'voice_text_truth_conversation_missing',
    180,
  );
  const taskId = required(truth.task?.taskId, 'voice_text_truth_task_missing', 180);
  if (truth.task?.recordId !== taskId) {
    throw new Error('voice_text_truth_task_record_binding_invalid');
  }
  for (const receipt of [truth.voiceStart?.receipt, truth.textContinue?.receipt]) {
    if (!receipt || receipt.recordId !== receipt.receiptId) {
      throw new Error('voice_text_truth_receipt_record_binding_invalid');
    }
  }
  return {
    acceptanceRunId: descriptor.acceptanceRunId,
    buildIdentityDigest: descriptor.buildIdentityDigest,
    dataRootIdentitySha256: descriptor.dataRootIdentitySha256,
    serverInstanceNonce: descriptor.serverInstanceNonce,
    scenarioId: 'voice_to_text_continuation',
    conversationId,
    voiceRequestId: required(
      truth.voiceStart?.request?.requestId,
      'voice_text_truth_voice_request_missing',
      180,
    ),
    textRequestId: required(
      truth.textContinue?.request?.requestId,
      'voice_text_truth_text_request_missing',
      180,
    ),
    taskId,
    capturedAt,
    evidenceDigestSha256,
  };
}

/**
 * Creates an isolated-backend attestation boundary. The Ed25519 private key is
 * captured only by the returned `attest` closure; it is never serialized or
 * returned with the public descriptor.
 */
export function createVoiceTextContinuationTruthAttester(
  input: CreateVoiceTextContinuationTruthAttesterInput,
): VoiceTextContinuationTruthAttester {
  const acceptanceRunId = required(
    input.acceptanceRunId,
    'voice_text_truth_attester_run_invalid',
    180,
  );
  const buildIdentityDigest = String(input.buildIdentityDigest || '').trim().toLowerCase();
  const dataRootIdentitySha256 = String(input.dataRootIdentitySha256 || '').trim().toLowerCase();
  const serverInstanceNonce = input.serverInstanceNonce === undefined
    ? randomBytes(32).toString('base64url')
    : String(input.serverInstanceNonce);
  if (
    !SHA256_RE.test(buildIdentityDigest)
    || !SHA256_RE.test(dataRootIdentitySha256)
    || !/^[A-Za-z0-9_-]{22,192}$/u.test(serverInstanceNonce)
  ) throw new Error('voice_text_truth_attester_binding_invalid');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' });
  const descriptor: Readonly<VoiceTextContinuationTruthSignerDescriptor> = Object.freeze({
    kind: VOICE_TEXT_CONTINUATION_TRUTH_SIGNER_KIND,
    schemaVersion: VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION,
    algorithm: 'ed25519',
    keyId: signerKeyId(publicKeySpki),
    publicKeySpkiBase64: publicKeySpki.toString('base64'),
    serverInstanceNonce,
    acceptanceRunId,
    buildIdentityDigest,
    dataRootIdentitySha256,
  });

  return Object.freeze({
    descriptor,
    attest(truth: VoiceTextContinuationTruth): VoiceTextContinuationTruthEnvelope {
      const binding = truthBindingForAttestation(descriptor, truth);
      const core = {
        kind: VOICE_TEXT_CONTINUATION_TRUTH_ENVELOPE_KIND,
        schemaVersion: VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION,
        binding,
        truth: JSON.parse(stableJson(truth)) as VoiceTextContinuationTruth,
      };
      const signature = signBytes(null, signaturePayload(core), privateKey);
      return {
        ...core,
        attestation: {
          kind: VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_KIND,
          schemaVersion: VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION,
          algorithm: 'ed25519',
          keyId: descriptor.keyId,
          signatureBase64: signature.toString('base64'),
        },
      };
    },
  });
}

/** Read-only verifier used by focused server tests; the portable adapter has an independent verifier. */
export function verifyVoiceTextContinuationTruthEnvelope(
  envelope: VoiceTextContinuationTruthEnvelope,
  descriptor: VoiceTextContinuationTruthSignerDescriptor,
): boolean {
  try {
    const publicKeySpki = Buffer.from(descriptor.publicKeySpkiBase64, 'base64');
    if (
      descriptor.kind !== VOICE_TEXT_CONTINUATION_TRUTH_SIGNER_KIND
      || descriptor.schemaVersion !== VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION
      || descriptor.algorithm !== 'ed25519'
      || publicKeySpki.toString('base64') !== descriptor.publicKeySpkiBase64
      || signerKeyId(publicKeySpki) !== descriptor.keyId
      || envelope.kind !== VOICE_TEXT_CONTINUATION_TRUTH_ENVELOPE_KIND
      || envelope.schemaVersion !== VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION
      || envelope.attestation?.kind !== VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_KIND
      || envelope.attestation?.schemaVersion
        !== VOICE_TEXT_CONTINUATION_TRUTH_ATTESTATION_SCHEMA_VERSION
      || envelope.attestation?.algorithm !== 'ed25519'
      || envelope.attestation?.keyId !== descriptor.keyId
      || envelope.binding?.acceptanceRunId !== descriptor.acceptanceRunId
      || envelope.binding?.buildIdentityDigest !== descriptor.buildIdentityDigest
      || envelope.binding?.dataRootIdentitySha256 !== descriptor.dataRootIdentitySha256
      || envelope.binding?.serverInstanceNonce !== descriptor.serverInstanceNonce
    ) return false;
    const signature = Buffer.from(envelope.attestation.signatureBase64, 'base64');
    if (signature.length !== 64
      || signature.toString('base64') !== envelope.attestation.signatureBase64) return false;
    const publicKey = createPublicKey({ key: publicKeySpki, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const { attestation: _attestation, ...core } = envelope;
    return verifyBytes(null, signaturePayload(core), publicKey, signature);
  } catch {
    return false;
  }
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function exactRow<T extends Record<string, any>>(
  rows: unknown,
  predicate: (row: T) => boolean,
  code: string,
): T {
  const matches = (Array.isArray(rows) ? rows : []).filter((row): row is T => (
    Boolean(row) && typeof row === 'object' && predicate(row as T)
  ));
  if (matches.length !== 1) throw new Error(matches.length ? `${code}_ambiguous` : code);
  return matches[0];
}

function exactReadReceipt(
  rows: unknown,
  input: {
    conversationId: string;
    taskId: string;
    requestId: string;
    outcome: 'failed' | 'verified_success';
  },
): Record<string, any> {
  return exactRow<Record<string, any>>(
    rows,
    row => row.conversationId === input.conversationId
      && row.taskId === input.taskId
      && row.requestId === input.requestId
      && row.toolName === 'read_file'
      && row.outcome === input.outcome,
    input.outcome === 'failed'
      ? 'voice_text_truth_voice_read_receipt_missing'
      : 'voice_text_truth_text_read_receipt_missing',
  );
}

function exactMessage(
  rows: unknown,
  input: {
    id: string;
    userId: string;
    conversationId: string;
    requestId: string;
    role: 'user' | 'assistant';
    code: string;
  },
): Record<string, any> {
  return exactRow<Record<string, any>>(
    rows,
    row => row.id === input.id
      && row.userId === input.userId
      && row.conversationId === input.conversationId
      && (row.requestId || row.externalMessageId) === input.requestId
      && row.role === input.role,
    input.code,
  );
}

function messageText(row: Record<string, any>): string {
  return required(row.message || row.content || row.response, 'voice_text_truth_message_text_missing', 100_000);
}

function basename(value: string): string {
  return value.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) || value;
}

function canonicalReceipt(
  receipt: Record<string, any>,
  outcome: 'failed' | 'verified_success',
): CanonicalReadReceipt {
  const inputSha256 = required(receipt.inputDigest, 'voice_text_truth_receipt_input_missing', 64)
    .toLowerCase();
  if (!SHA256_RE.test(inputSha256)) throw new Error('voice_text_truth_receipt_input_invalid');
  const targetId = required(receipt.targetIdentity, 'voice_text_truth_receipt_target_missing');
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(targetId)) {
    throw new Error('voice_text_truth_receipt_target_not_filesystem');
  }
  return {
    recordId: required(receipt.id, 'voice_text_truth_receipt_id_missing', 180),
    receiptId: required(receipt.id, 'voice_text_truth_receipt_id_missing', 180),
    requestId: required(receipt.requestId, 'voice_text_truth_receipt_request_missing', 180),
    taskId: required(receipt.taskId, 'voice_text_truth_receipt_task_missing', 180),
    toolName: 'read_file',
    outcome,
    inputSha256,
    target: {
      targetKind: 'filesystem',
      targetId,
      targetSha256: sha256(targetId),
    },
    recordedAt: canonicalInstant(receipt.createdAt, 'voice_text_truth_receipt_time_invalid'),
  };
}

function invalidSyntheticProvenance(row: Record<string, any>): boolean {
  return row.audioInputKind !== 'synthetic_accepted_transcript'
    || row.syntheticAudio !== true
    || [
    row.captureSessionId,
    row.sttReceiptId,
    row.contextChainId,
    row.previousRequestId,
    row.nativeDeviceId,
    row.executionSessionId,
    row.nativeClientIdentitySha256,
  ].some(value => String(value || '').trim());
}

function canonicalFilesystemIdentity(value: unknown): string | null {
  const supplied = String(value || '').trim();
  if (!supplied) return null;
  if (/^[a-z]:[\\/]/iu.test(supplied) || /^\\\\/u.test(supplied)) {
    if (!path.win32.isAbsolute(supplied)) return null;
    return path.win32.normalize(supplied.replace(/\//gu, '\\')).toLowerCase();
  }
  if (supplied.startsWith('/')) {
    if (!path.posix.isAbsolute(supplied)) return null;
    return path.posix.normalize(supplied);
  }
  return null;
}

function samePersistedTarget(value: unknown, receiptTarget: string): boolean {
  const persisted = canonicalFilesystemIdentity(value);
  const receipt = canonicalFilesystemIdentity(receiptTarget);
  return Boolean(persisted && receipt && persisted === receipt);
}

/**
 * Builds the S6 join exclusively from persisted runtime rows. The caller may
 * select only the manifest-bound text request and task; the voice request,
 * both receipts, correction, and handoff are derived here and require exact
 * cardinality.
 */
export function buildVoiceTextContinuationTruthFromSources(
  input: BuildVoiceTextContinuationTruthInput,
): VoiceTextContinuationTruth {
  if (input.scenarioId !== 'voice_to_text_continuation') {
    throw new Error('voice_text_truth_scenario_invalid');
  }
  const acceptanceRunId = required(input.acceptanceRunId, 'voice_text_truth_run_missing', 180);
  const buildIdentityDigest = required(
    input.buildIdentityDigest,
    'voice_text_truth_build_identity_missing',
    64,
  ).toLowerCase();
  if (!SHA256_RE.test(buildIdentityDigest)) throw new Error('voice_text_truth_build_identity_invalid');
  const userId = required(input.userId, 'voice_text_truth_user_missing', 180);
  const conversationId = required(input.conversationId, 'voice_text_truth_conversation_missing', 180);
  const textRequestId = required(input.textRequestId, 'voice_text_truth_text_request_missing', 180);
  const taskId = required(input.taskId, 'voice_text_truth_task_missing', 180);
  const suppliedCapturedAt = input.capturedAt || new Date().toISOString();
  const capturedAt = canonicalInstant(
    suppliedCapturedAt,
    'voice_text_truth_capture_time_invalid',
  );
  if (capturedAt !== suppliedCapturedAt) throw new Error('voice_text_truth_capture_time_invalid');
  const db = input.db || {};

  exactRow<Record<string, any>>(
    db.conversations,
    row => row.id === conversationId && row.userId === userId,
    'voice_text_truth_conversation_missing',
  );
  const task = exactRow<Record<string, any>>(
    db.conversationActionTasks,
    row => row.id === taskId && row.conversationId === conversationId && row.userId === userId,
    'voice_text_truth_task_missing',
  );
  const taskRecordId = required(task.id, 'voice_text_truth_task_record_missing', 180);
  if (taskRecordId !== taskId) throw new Error('voice_text_truth_task_record_binding_invalid');
  if (task.status !== 'completed') throw new Error('voice_text_truth_task_not_completed');
  const revision = Number(task.revision);
  if (!Number.isSafeInteger(revision) || revision < 2) {
    throw new Error('voice_text_truth_task_revision_invalid');
  }

  const textTurn = exactRow<Record<string, any>>(
    db.conversationActionTurns,
    row => row.conversationId === conversationId
      && row.userId === userId
      && row.taskId === taskId
      && row.requestId === textRequestId,
    'voice_text_truth_text_turn_missing',
  );
  if (textTurn.channel !== 'chat' || textTurn.status !== 'terminal') {
    throw new Error('voice_text_truth_text_turn_invalid');
  }

  const taskTurns = (Array.isArray(db.conversationActionTurns) ? db.conversationActionTurns : [])
    .filter((row: any) => row
      && row.conversationId === conversationId
      && row.userId === userId
      && row.taskId === taskId);
  if (taskTurns.length !== 2 || !taskTurns.includes(textTurn)) {
    throw new Error('voice_text_truth_task_turn_cardinality_invalid');
  }
  const voiceTurns = taskTurns.filter((row: any) => row
      && row.channel === 'voice'
      && row.status === 'terminal'
      && row.requestId !== textRequestId);
  if (voiceTurns.length !== 1) {
    throw new Error(voiceTurns.length
      ? 'voice_text_truth_voice_turn_ambiguous'
      : 'voice_text_truth_voice_turn_missing');
  }
  const voiceTurn = voiceTurns[0];
  const voiceRequestId = required(voiceTurn.requestId, 'voice_text_truth_voice_request_missing', 180);
  const voiceTime = canonicalInstant(
    voiceTurn.updatedAt || voiceTurn.createdAt,
    'voice_text_truth_voice_turn_time_invalid',
  );
  const textTime = canonicalInstant(
    textTurn.updatedAt || textTurn.createdAt,
    'voice_text_truth_text_turn_time_invalid',
  );
  if (Date.parse(voiceTime) >= Date.parse(textTime)) {
    throw new Error('voice_text_truth_turn_order_invalid');
  }
  if (voiceTurn.terminalReason !== 'task_outcome:blocked') {
    throw new Error('voice_text_truth_voice_blocked_state_missing');
  }
  if (textTurn.terminalReason !== 'task_outcome:completed') {
    throw new Error('voice_text_truth_text_completed_state_missing');
  }

  const voiceReceiptRow = exactReadReceipt(db.conversationActionReceipts, {
    conversationId,
    taskId,
    requestId: voiceRequestId,
    outcome: 'failed',
  });
  const textReceiptRow = exactReadReceipt(db.conversationActionReceipts, {
    conversationId,
    taskId,
    requestId: textRequestId,
    outcome: 'verified_success',
  });
  const allReadReceipts = (Array.isArray(db.conversationActionReceipts)
    ? db.conversationActionReceipts
    : []).filter((row: any) => row
      && row.conversationId === conversationId
      && row.taskId === taskId
      && row.toolName === 'read_file');
  if (allReadReceipts.length !== 2) throw new Error('voice_text_truth_read_receipt_cardinality_invalid');
  const voiceReceipt = canonicalReceipt(voiceReceiptRow, 'failed') as CanonicalReadReceipt & { outcome: 'failed' };
  const textReceipt = canonicalReceipt(
    textReceiptRow,
    'verified_success',
  ) as CanonicalReadReceipt & { outcome: 'verified_success' };
  if (
    voiceReceipt.recordId !== voiceReceipt.receiptId
    || textReceipt.recordId !== textReceipt.receiptId
  ) throw new Error('voice_text_truth_receipt_record_binding_invalid');
  if (
    voiceReceipt.inputSha256 === textReceipt.inputSha256
    || voiceReceipt.target.targetSha256 === textReceipt.target.targetSha256
  ) throw new Error('voice_text_truth_correction_target_not_changed');

  const voiceUser = exactMessage(db.interactions, {
    id: required(voiceTurn.userMessageId, 'voice_text_truth_voice_user_binding_missing', 180),
    userId,
    conversationId,
    requestId: voiceRequestId,
    role: 'user',
    code: 'voice_text_truth_voice_user_missing',
  });
  const voiceAssistant = exactMessage(db.interactions, {
    id: required(voiceTurn.terminalMessageId, 'voice_text_truth_voice_assistant_binding_missing', 180),
    userId,
    conversationId,
    requestId: voiceRequestId,
    role: 'assistant',
    code: 'voice_text_truth_voice_assistant_missing',
  });
  if (
    voiceUser.source !== 'voice'
    || voiceUser.channel !== 'voice'
    || voiceUser.mode !== 'voice'
    || voiceAssistant.source !== 'voice'
    || voiceAssistant.channel !== 'voice'
    || invalidSyntheticProvenance(voiceUser)
  ) throw new Error('voice_text_truth_voice_provenance_invalid');

  const textUser = exactMessage(db.interactions, {
    id: required(textTurn.userMessageId, 'voice_text_truth_text_user_binding_missing', 180),
    userId,
    conversationId,
    requestId: textRequestId,
    role: 'user',
    code: 'voice_text_truth_text_user_missing',
  });
  const textAssistant = exactMessage(db.interactions, {
    id: required(textTurn.terminalMessageId, 'voice_text_truth_text_assistant_binding_missing', 180),
    userId,
    conversationId,
    requestId: textRequestId,
    role: 'assistant',
    code: 'voice_text_truth_text_assistant_missing',
  });
  if (textUser.channel !== 'chat' || textUser.cognitiveIntent !== 'task_correction') {
    throw new Error('voice_text_truth_persisted_correction_missing');
  }
  if (textAssistant.channel !== 'chat') {
    throw new Error('voice_text_truth_text_assistant_channel_invalid');
  }
  const correctionText = messageText(textUser).toLowerCase();
  if (
    !correctionText.includes(basename(voiceReceipt.target.targetId).toLowerCase())
    || !correctionText.includes(basename(textReceipt.target.targetId).toLowerCase())
  ) throw new Error('voice_text_truth_persisted_correction_target_mismatch');

  const taskContext = parseObject(task.context);
  const actionState = parseObject(taskContext.actionState);
  const taskCapsule = parseObject(actionState.taskCapsule);
  const latestCorrection = parseObject(taskCapsule.latestCorrection);
  const capsuleTarget = parseObject(taskCapsule.target);
  const rejectedTargets = Array.isArray(taskCapsule.rejectedTargets)
    ? taskCapsule.rejectedTargets.filter((value: any) => value && typeof value === 'object')
    : [];
  const rejectedTarget = rejectedTargets.filter((value: any) => (
    samePersistedTarget(value.identity, voiceReceipt.target.targetId)
  ));
  const capsuleTargetPath = String(capsuleTarget.path || '').trim();
  if (taskCapsule.taskId !== taskId) {
    throw new Error('voice_text_truth_persisted_capsule_task_invalid');
  }
  if (
    !Number.isSafeInteger(Number(taskCapsule.revision))
    || Number(taskCapsule.revision) < 2
  ) throw new Error('voice_text_truth_persisted_capsule_revision_invalid');
  if (taskCapsule.status !== 'completed' || taskCapsule.unfinished !== false) {
    throw new Error('voice_text_truth_persisted_capsule_status_invalid');
  }
  if (!samePersistedTarget(latestCorrection.previousTarget, voiceReceipt.target.targetId)) {
    throw new Error('voice_text_truth_persisted_previous_target_invalid');
  }
  if (!samePersistedTarget(latestCorrection.replacementTarget, textReceipt.target.targetId)) {
    throw new Error('voice_text_truth_persisted_replacement_target_invalid');
  }
  if (!samePersistedTarget(capsuleTargetPath, textReceipt.target.targetId)) {
    throw new Error('voice_text_truth_persisted_final_target_invalid');
  }
  if (rejectedTargets.length !== 1 || rejectedTarget.length !== 1) {
    throw new Error('voice_text_truth_persisted_rejected_target_invalid');
  }
  const persistedCorrectionText = required(
    latestCorrection.text,
    'voice_text_truth_persisted_task_correction_invalid',
    500,
  ).toLowerCase();
  if (
    !persistedCorrectionText.includes(basename(voiceReceipt.target.targetId).toLowerCase())
    || !persistedCorrectionText.includes(basename(textReceipt.target.targetId).toLowerCase())
  ) throw new Error('voice_text_truth_persisted_correction_text_invalid');
  const correctionRecordedAt = canonicalInstant(
    latestCorrection.observedAt,
    'voice_text_truth_persisted_correction_time_invalid',
  );
  const rejectedRecordedAt = canonicalInstant(
    rejectedTarget[0].observedAt,
    'voice_text_truth_persisted_correction_time_invalid',
  );
  if (
    correctionRecordedAt !== rejectedRecordedAt
    || Date.parse(correctionRecordedAt) <= Date.parse(voiceTime)
    || Date.parse(correctionRecordedAt) > Date.parse(textTime)
  ) throw new Error('voice_text_truth_persisted_correction_time_invalid');

  const voiceUserRecordedAt = canonicalInstant(
    voiceUser.timestamp || voiceUser.receivedAt,
    'voice_text_truth_voice_user_time_invalid',
  );
  const textUserRecordedAt = canonicalInstant(
    textUser.timestamp || textUser.receivedAt,
    'voice_text_truth_text_user_time_invalid',
  );
  const previousTarget = voiceReceipt.target.targetId;
  const replacementTarget = textReceipt.target.targetId;
  const truthWithoutDigest = {
    kind: VOICE_TEXT_CONTINUATION_TRUTH_KIND,
    schemaVersion: VOICE_TEXT_CONTINUATION_TRUTH_SCHEMA_VERSION,
    scenarioId: 'voice_to_text_continuation' as const,
    acceptanceRunId,
    buildIdentityDigest,
    conversationId,
    capturedAt,
    task: {
      recordId: taskRecordId,
      taskId,
      revision,
      finalStatus: 'completed' as const,
    },
    voiceStart: {
      request: {
        recordId: required(voiceTurn.id, 'voice_text_truth_voice_turn_record_missing', 180),
        requestId: voiceRequestId,
        taskId,
        channel: 'voice' as const,
        source: required(voiceTurn.source || 'voice', 'voice_text_truth_voice_source_missing', 120),
        terminalStatus: 'blocked' as const,
        userMessageId: required(voiceUser.id, 'voice_text_truth_voice_user_id_missing', 180),
        assistantMessageId: required(voiceAssistant.id, 'voice_text_truth_voice_assistant_id_missing', 180),
        recordedAt: voiceTime,
      },
      userMessage: {
        recordId: required(voiceUser.id, 'voice_text_truth_voice_user_id_missing', 180),
        source: 'voice' as const,
        channel: 'voice' as const,
        mode: 'voice' as const,
        textSha256: sha256(messageText(voiceUser)),
        recordedAt: voiceUserRecordedAt,
      },
      capture: {
        captureMode: 'synthetic_accepted_transcript' as const,
        audioInputKind: 'synthetic_accepted_transcript' as const,
        syntheticAudio: true as const,
        captureSessionId: null,
        sttReceiptId: null,
        contextChainId: null,
        previousRequestId: null,
        nativeDeviceId: null,
        executionSessionId: null,
        nativeClientIdentitySha256: null,
      },
      receipt: voiceReceipt,
    },
    textContinue: {
      request: {
        recordId: required(textTurn.id, 'voice_text_truth_text_turn_record_missing', 180),
        requestId: textRequestId,
        taskId,
        channel: 'text' as const,
        source: required(textTurn.source || textUser.source, 'voice_text_truth_text_source_missing', 120),
        terminalStatus: 'completed' as const,
        userMessageId: required(textUser.id, 'voice_text_truth_text_user_id_missing', 180),
        assistantMessageId: required(textTurn.terminalMessageId, 'voice_text_truth_text_assistant_id_missing', 180),
        recordedAt: textTime,
      },
      userMessage: {
        recordId: required(textUser.id, 'voice_text_truth_text_user_id_missing', 180),
        source: required(textUser.source, 'voice_text_truth_text_message_source_missing', 120),
        channel: 'text' as const,
        cognitiveIntent: 'task_correction' as const,
        textSha256: sha256(messageText(textUser)),
        recordedAt: textUserRecordedAt,
      },
      receipt: textReceipt,
    },
    channelHandoff: {
      sourceRequestId: voiceRequestId,
      targetRequestId: textRequestId,
      sourceTaskId: taskId,
      targetTaskId: taskId,
      sourceChannel: 'voice' as const,
      targetChannel: 'text' as const,
      sourceMessageIds: [
        required(voiceUser.id, 'voice_text_truth_voice_user_id_missing', 180),
        required(voiceAssistant.id, 'voice_text_truth_voice_assistant_id_missing', 180),
      ] as [string, string],
      targetMessageId: required(textUser.id, 'voice_text_truth_text_user_id_missing', 180),
      recordedAt: textUserRecordedAt,
    },
    targetCorrection: {
      recordId: required(textUser.id, 'voice_text_truth_correction_record_missing', 180),
      source: 'user_correction' as const,
      sourceRequestId: voiceRequestId,
      targetRequestId: textRequestId,
      taskId,
      correctionMessageId: required(textUser.id, 'voice_text_truth_correction_record_missing', 180),
      previousTarget,
      replacementTarget,
      previousTaskTargetSha256: sha256(String(latestCorrection.previousTarget)),
      replacementTaskTargetSha256: sha256(String(latestCorrection.replacementTarget)),
      rejectedTargetSha256: sha256(String(rejectedTarget[0].identity)),
      recordedAt: correctionRecordedAt,
    },
  };
  return {
    ...truthWithoutDigest,
    evidenceDigestSha256: sha256(JSON.stringify(stableValue(truthWithoutDigest))),
  };
}

/** Captures from the isolated backend's own database, never request payload evidence. */
export async function captureVoiceTextContinuationTruth(
  input: CaptureVoiceTextContinuationTruthInput,
): Promise<VoiceTextContinuationTruth> {
  const db = typeof structuredClone === 'function'
    ? structuredClone(readDB())
    : JSON.parse(JSON.stringify(readDB()));
  return buildVoiceTextContinuationTruthFromSources({ ...input, db });
}
