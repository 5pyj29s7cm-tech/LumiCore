import crypto from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,255}$/u;

export interface NativeVoiceRequestBinding {
  nativeDeviceId: string;
  executionSessionId: string;
  nativeClientIdentitySha256: string;
}

export interface SyntheticAcceptedVoiceBinding {
  acceptanceRunId: string;
  sandboxId: string;
  buildIdentityDigest: string;
  sttAccessSha256: string;
}

export interface VoiceCaptureProvenanceState {
  captureSessionId: string;
  contextChainId: string;
  nativeDeviceId: string;
  executionSessionId: string;
  nativeClientIdentitySha256: string;
  audioInputKind: 'physical_microphone' | 'synthetic_accepted_transcript' | 'unverified';
  syntheticAudio: boolean | null;
  syntheticBindingSha256: string;
  chunkSequence: number;
  lastIssuedChunkSequence: number;
  lastRequestId: string;
}

export interface PhysicalVoiceTurnProvenance {
  audioInputKind: 'physical_microphone';
  syntheticAudio: false;
  captureSessionId: string;
  nativeDeviceId: string;
  executionSessionId: string;
  nativeClientIdentitySha256: string;
  sttReceiptId: string;
  contextChainId: string;
  previousRequestId: string;
}

export interface SyntheticVoiceTurnProvenance {
  audioInputKind: 'synthetic_accepted_transcript';
  syntheticAudio: true;
  captureSessionId?: never;
  nativeDeviceId?: never;
  executionSessionId?: never;
  nativeClientIdentitySha256?: never;
  sttReceiptId?: never;
  contextChainId?: never;
  previousRequestId?: never;
}

export type VoiceTurnProvenance = PhysicalVoiceTurnProvenance | SyntheticVoiceTurnProvenance;

function emptyProvenanceField(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Accepts only a complete physical-turn tuple; partial provenance is erased. */
export function normalizeVoiceTurnProvenance(value: unknown): VoiceTurnProvenance | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.audioInputKind === 'synthetic_accepted_transcript'
    && candidate.syntheticAudio === true
    && emptyProvenanceField(candidate.captureSessionId)
    && emptyProvenanceField(candidate.nativeDeviceId)
    && emptyProvenanceField(candidate.executionSessionId)
    && emptyProvenanceField(candidate.nativeClientIdentitySha256)
    && emptyProvenanceField(candidate.sttReceiptId)
    && emptyProvenanceField(candidate.contextChainId)
    && emptyProvenanceField(candidate.previousRequestId)
  ) {
    return {
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
    };
  }
  const captureSessionId = normalizedId(candidate.captureSessionId);
  const nativeDeviceId = normalizedId(candidate.nativeDeviceId);
  const executionSessionId = normalizedSha256(candidate.executionSessionId);
  const nativeClientIdentitySha256 = normalizedSha256(candidate.nativeClientIdentitySha256);
  const sttReceiptId = String(candidate.sttReceiptId || '').trim();
  const contextChainId = normalizedSha256(candidate.contextChainId);
  const previousRequestId = candidate.previousRequestId === ''
    ? ''
    : normalizedId(candidate.previousRequestId);
  if (
    candidate.audioInputKind !== 'physical_microphone'
    || candidate.syntheticAudio !== false
    || !captureSessionId
    || !nativeDeviceId
    || !executionSessionId
    || !nativeClientIdentitySha256
    || !/^stt_[0-9a-f-]{36}$/u.test(sttReceiptId)
    || !contextChainId
    || (candidate.previousRequestId !== '' && !previousRequestId)
  ) return null;
  return {
    audioInputKind: 'physical_microphone',
    syntheticAudio: false,
    captureSessionId,
    nativeDeviceId,
    executionSessionId,
    nativeClientIdentitySha256,
    sttReceiptId,
    contextChainId,
    previousRequestId,
  };
}

function normalizedId(value: unknown): string {
  const result = String(value || '').trim();
  return ID_RE.test(result) ? result : '';
}

function normalizedSha256(value: unknown): string {
  const result = String(value || '').trim().toLowerCase();
  return SHA256_RE.test(result) ? result : '';
}

function emptyState(captureSessionId = ''): VoiceCaptureProvenanceState {
  return {
    captureSessionId,
    contextChainId: '',
    nativeDeviceId: '',
    executionSessionId: '',
    nativeClientIdentitySha256: '',
    audioInputKind: 'unverified',
    syntheticAudio: null,
    syntheticBindingSha256: '',
    chunkSequence: 0,
    lastIssuedChunkSequence: 0,
    lastRequestId: '',
  };
}

/**
 * Establishes a capture chain only for a proof-bound native request. The
 * browser payload is an intent claim; it cannot create native provenance on
 * its own because the server also requires the authenticated socket binding.
 */
export function createVoiceCaptureProvenance(input: {
  captureSessionId?: unknown;
  audioInputKind?: unknown;
  nativeBinding?: NativeVoiceRequestBinding | null;
  syntheticBinding?: SyntheticAcceptedVoiceBinding | null;
}): VoiceCaptureProvenanceState {
  const captureSessionId = normalizedId(input.captureSessionId);
  const nativeDeviceId = normalizedId(input.nativeBinding?.nativeDeviceId);
  const executionSessionId = normalizedSha256(input.nativeBinding?.executionSessionId);
  const nativeClientIdentitySha256 = normalizedSha256(
    input.nativeBinding?.nativeClientIdentitySha256,
  );
  if (
    input.audioInputKind === 'physical_microphone'
    && captureSessionId
    && nativeDeviceId
    && executionSessionId
    && nativeClientIdentitySha256
  ) {
    const contextChainId = crypto.createHash('sha256')
      .update([
        'lumi-physical-voice-context-v1',
        captureSessionId,
        nativeDeviceId,
        executionSessionId,
        nativeClientIdentitySha256,
      ].join('\0'), 'utf8')
      .digest('hex');
    return {
      captureSessionId,
      contextChainId,
      nativeDeviceId,
      executionSessionId,
      nativeClientIdentitySha256,
      audioInputKind: 'physical_microphone',
      syntheticAudio: false,
      syntheticBindingSha256: '',
      chunkSequence: 0,
      lastIssuedChunkSequence: 0,
      lastRequestId: '',
    };
  }

  const synthetic = input.syntheticBinding;
  const acceptanceRunId = normalizedId(synthetic?.acceptanceRunId);
  const sandboxId = String(synthetic?.sandboxId || '').trim().toLowerCase();
  const buildIdentityDigest = normalizedSha256(synthetic?.buildIdentityDigest);
  const sttAccessSha256 = normalizedSha256(synthetic?.sttAccessSha256);
  if (
    input.audioInputKind === 'synthetic_accepted_transcript'
    && acceptanceRunId
    && /^[a-f0-9]{32}$/u.test(sandboxId)
    && buildIdentityDigest
    && sttAccessSha256
  ) {
    const state = emptyState();
    state.audioInputKind = 'synthetic_accepted_transcript';
    state.syntheticAudio = true;
    state.syntheticBindingSha256 = crypto.createHash('sha256')
      .update([
        'lumi-synthetic-accepted-voice-v1',
        acceptanceRunId,
        sandboxId,
        buildIdentityDigest,
        sttAccessSha256,
      ].join('\0'), 'utf8')
      .digest('hex');
    return state;
  }
  return emptyState(captureSessionId);
}

/** Records one server-observed PCM frame and returns its monotonic sequence. */
export function recordVoiceCaptureChunk(state: VoiceCaptureProvenanceState): number {
  if (state.audioInputKind === 'unverified') return 0;
  state.chunkSequence += 1;
  return state.chunkSequence;
}

/**
 * Issues exactly one receipt for a new, server-observed chunk watermark. A
 * repeated provider final or caller-authored transcript cannot reuse audio to
 * manufacture another formal microphone turn.
 */
export function issueVoiceTurnProvenance(
  state: VoiceCaptureProvenanceState,
  input: {
    requestId?: unknown;
    chunkSequence?: unknown;
    sttProvider?: unknown;
  },
): VoiceTurnProvenance | null {
  const requestId = normalizedId(input.requestId);
  const chunkSequence = Math.trunc(Number(input.chunkSequence));
  const sttProvider = String(input.sttProvider || '').trim().toLowerCase();
  if (
    state.audioInputKind === 'unverified'
    || !requestId
    || !Number.isSafeInteger(chunkSequence)
    || chunkSequence <= state.lastIssuedChunkSequence
    || chunkSequence > state.chunkSequence
    || !sttProvider
  ) {
    return null;
  }

  if (state.audioInputKind === 'synthetic_accepted_transcript') {
    if (!state.syntheticBindingSha256 || state.syntheticAudio !== true) return null;
    state.lastIssuedChunkSequence = chunkSequence;
    state.lastRequestId = requestId;
    return {
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
    };
  }

  const previousRequestId = state.lastRequestId;
  state.lastIssuedChunkSequence = chunkSequence;
  state.lastRequestId = requestId;
  const sttReceiptId = `stt_${crypto.randomUUID()}`;
  return {
    audioInputKind: 'physical_microphone',
    syntheticAudio: false,
    captureSessionId: state.captureSessionId,
    nativeDeviceId: state.nativeDeviceId,
    executionSessionId: state.executionSessionId,
    nativeClientIdentitySha256: state.nativeClientIdentitySha256,
    sttReceiptId,
    contextChainId: state.contextChainId,
    previousRequestId,
  };
}
