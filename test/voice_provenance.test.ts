import { describe, expect, it } from 'vitest';
import {
  createVoiceCaptureProvenance,
  issueVoiceTurnProvenance,
  normalizeVoiceTurnProvenance,
  recordVoiceCaptureChunk,
} from '../server/socket/voice_provenance';

const binding = {
  nativeDeviceId: 'device-tauri-formal-1',
  executionSessionId: 'd'.repeat(64),
  nativeClientIdentitySha256: 'e'.repeat(64),
};

const syntheticBinding = {
  acceptanceRunId: 'task_regression_candidate_s6_voice_provenance',
  sandboxId: 'a'.repeat(32),
  buildIdentityDigest: 'b'.repeat(64),
  sttAccessSha256: 'c'.repeat(64),
};

describe('physical voice provenance', () => {
  it('binds sequential STT turns to one native capture and previous request chain', () => {
    const state = createVoiceCaptureProvenance({
      captureSessionId: 'capture-formal-session-1',
      audioInputKind: 'physical_microphone',
      nativeBinding: binding,
    });
    const firstChunk = recordVoiceCaptureChunk(state);
    const first = issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-0001',
      chunkSequence: firstChunk,
      sttProvider: 'ark',
    });
    const secondChunk = recordVoiceCaptureChunk(state);
    const second = issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-0002',
      chunkSequence: secondChunk,
      sttProvider: 'ark',
    });

    expect(first).toMatchObject({
      audioInputKind: 'physical_microphone',
      syntheticAudio: false,
      captureSessionId: 'capture-formal-session-1',
      nativeDeviceId: binding.nativeDeviceId,
      executionSessionId: binding.executionSessionId,
      previousRequestId: '',
    });
    expect(first?.sttReceiptId).toMatch(/^stt_[0-9a-f-]{36}$/u);
    expect(first?.contextChainId).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatchObject({
      contextChainId: first?.contextChainId,
      previousRequestId: 'voice-request-0001',
    });
    expect(second?.sttReceiptId).not.toBe(first?.sttReceiptId);
    expect(normalizeVoiceTurnProvenance(second)).toEqual(second);
  });

  it('issues the exact synthetic tuple only with both caller intent and a server-owned binding', () => {
    const state = createVoiceCaptureProvenance({
      audioInputKind: 'synthetic_accepted_transcript',
      nativeBinding: null,
      syntheticBinding,
    });
    const evidence = issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-synthetic-accepted',
      chunkSequence: recordVoiceCaptureChunk(state),
      sttProvider: 'doubao',
    });
    expect(evidence).toEqual({
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
    });
    expect(normalizeVoiceTurnProvenance(evidence)).toEqual(evidence);
  });

  it('keeps missing, partial, caller-only, and physical claims out of the synthetic lane', () => {
    for (const state of [
      createVoiceCaptureProvenance({
        audioInputKind: undefined,
        nativeBinding: null,
        syntheticBinding,
      }),
      createVoiceCaptureProvenance({
        audioInputKind: 'synthetic_accepted_transcript',
        nativeBinding: null,
        syntheticBinding: null,
      }),
      createVoiceCaptureProvenance({
        audioInputKind: 'physical_microphone',
        nativeBinding: null,
        syntheticBinding,
      }),
      createVoiceCaptureProvenance({
        audioInputKind: 'synthetic_accepted_transcript',
        nativeBinding: null,
        syntheticBinding: { ...syntheticBinding, sttAccessSha256: '' },
      }),
    ]) {
      expect(state.audioInputKind).toBe('unverified');
      expect(state.syntheticAudio).toBeNull();
      expect(recordVoiceCaptureChunk(state)).toBe(0);
      expect(issueVoiceTurnProvenance(state, {
        requestId: 'voice-request-synthetic-forged',
        chunkSequence: 1,
        sttProvider: 'doubao',
      })).toBeNull();
    }
    expect(normalizeVoiceTurnProvenance({
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
      nativeDeviceId: 0,
    })).toBeNull();
    expect(normalizeVoiceTurnProvenance({
      audioInputKind: 'synthetic_accepted_transcript',
    })).toBeNull();
  });

  it('erases partial or caller-mutated persisted tuples', () => {
    const state = createVoiceCaptureProvenance({
      captureSessionId: 'capture-formal-session-5',
      audioInputKind: 'physical_microphone',
      nativeBinding: binding,
    });
    const evidence = issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-normalize',
      chunkSequence: recordVoiceCaptureChunk(state),
      sttProvider: 'ark',
    });
    expect(evidence).not.toBeNull();
    expect(normalizeVoiceTurnProvenance({ ...evidence, sttReceiptId: '' })).toBeNull();
    expect(normalizeVoiceTurnProvenance({ ...evidence, syntheticAudio: true })).toBeNull();
    expect(normalizeVoiceTurnProvenance({ ...evidence, executionSessionId: '' })).toBeNull();
  });

  it('does not let a harness claim, missing binding, or caller text manufacture physical provenance', () => {
    for (const state of [
      createVoiceCaptureProvenance({
        captureSessionId: 'capture-formal-session-2',
        audioInputKind: 'physical_microphone',
        nativeBinding: null,
      }),
      createVoiceCaptureProvenance({
        captureSessionId: 'capture-formal-session-3',
        audioInputKind: 'synthetic_stt',
        nativeBinding: binding,
      }),
    ]) {
      expect(recordVoiceCaptureChunk(state)).toBe(0);
      expect(issueVoiceTurnProvenance(state, {
        requestId: 'voice-request-forged',
        chunkSequence: 1,
        sttProvider: 'ark',
      })).toBeNull();
    }
  });

  it('rejects duplicate finals, future watermarks, and turns without an STT provider', () => {
    const state = createVoiceCaptureProvenance({
      captureSessionId: 'capture-formal-session-4',
      audioInputKind: 'physical_microphone',
      nativeBinding: binding,
    });
    const chunkSequence = recordVoiceCaptureChunk(state);
    expect(issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-valid',
      chunkSequence,
      sttProvider: 'ark',
    })).not.toBeNull();
    expect(issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-duplicate',
      chunkSequence,
      sttProvider: 'ark',
    })).toBeNull();
    expect(issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-future',
      chunkSequence: chunkSequence + 10,
      sttProvider: 'ark',
    })).toBeNull();
    const next = recordVoiceCaptureChunk(state);
    expect(issueVoiceTurnProvenance(state, {
      requestId: 'voice-request-no-provider',
      chunkSequence: next,
      sttProvider: '',
    })).toBeNull();
  });
});
