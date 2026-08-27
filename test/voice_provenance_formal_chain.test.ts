import { describe, expect, it } from 'vitest';
import { validateManualVoiceConversationEvidence } from '../scripts/formal-client-e2e.mjs';
import {
  createVoiceCaptureProvenance,
  issueVoiceTurnProvenance,
  recordVoiceCaptureChunk,
} from '../server/socket/voice_provenance';

describe('voice provenance formal evidence bridge', () => {
  it('produces the exact twenty-turn chain consumed by the formal validator', () => {
    const state = createVoiceCaptureProvenance({
      captureSessionId: 'capture-formal-live-chain-0001',
      audioInputKind: 'physical_microphone',
      nativeBinding: {
        nativeDeviceId: 'device-formal-tauri-0001',
        executionSessionId: 'a'.repeat(64),
        nativeClientIdentitySha256: 'b'.repeat(64),
      },
    });
    const base = Date.parse('2026-08-27T06:00:00.000Z');
    const messages: any[] = [];
    const routingReceipts: any[] = [];

    for (let index = 0; index < 20; index += 1) {
      const requestId = `voice-formal-request-${String(index + 1).padStart(2, '0')}`;
      const provenance = issueVoiceTurnProvenance(state, {
        requestId,
        chunkSequence: recordVoiceCaptureChunk(state),
        sttProvider: 'ark',
      });
      expect(provenance).not.toBeNull();
      messages.push({
        id: `voice-formal-user-${index + 1}`,
        role: 'user',
        requestId,
        source: 'voice',
        channel: 'voice',
        message: `真实麦克风测试第 ${index + 1} 轮`,
        timestamp: new Date(base + index * 2_000).toISOString(),
        ...provenance,
      }, {
        id: `voice-formal-assistant-${index + 1}`,
        role: 'assistant',
        requestId,
        source: 'voice',
        channel: 'voice',
        message: `自然回复第 ${index + 1} 轮`,
        timestamp: new Date(base + index * 2_000 + 1_000).toISOString(),
        ...provenance,
      });
      routingReceipts.push({
        id: `voice-formal-route-${index + 1}`,
        requestId,
        source: 'voice',
        status: 'succeeded',
        durationMs: 1_000,
        selectedProvider: 'lmstudio',
        selectedModel: 'formal-local-model',
        fallbackReason: '',
        attempts: [{
          provider: 'lmstudio',
          model: 'formal-local-model',
          status: 'succeeded',
        }],
        ...provenance,
      });
    }

    const validation = validateManualVoiceConversationEvidence({
      messages,
      routingReceipts,
      since: '2026-08-27T06:00:00.000Z',
      expectedTurns: 20,
    });
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    expect(validation).toMatchObject({
      ok: true,
      evidence: {
        requiredTurns: 20,
        observedTurns: 20,
        syntheticSttEmitted: false,
        physicalMicrophoneProvenanceVerified: true,
        captureSessionId: 'capture-formal-live-chain-0001',
        nativeDeviceId: 'device-formal-tauri-0001',
      },
    });
  });
});
