import { describe, expect, it } from 'vitest';
import { normalizeVoiceAudioBuffer } from '../src/hooks/useVoiceCall';

describe('voice audio transport normalization', () => {
  it('copies ArrayBuffer views without leaking their surrounding bytes', () => {
    const source = new Uint8Array([9, 1, 2, 3, 8]);
    const result = normalizeVoiceAudioBuffer(source.subarray(1, 4));
    expect(result).not.toBeNull();
    expect(Array.from(new Uint8Array(result!))).toEqual([1, 2, 3]);
  });

  it('accepts a serialized Node Buffer envelope', () => {
    const result = normalizeVoiceAudioBuffer({ type: 'Buffer', data: [73, 68, 51] });
    expect(result).not.toBeNull();
    expect(Array.from(new Uint8Array(result!))).toEqual([73, 68, 51]);
  });

  it('unwraps the metadata envelope emitted by Socket.IO', () => {
    const result = normalizeVoiceAudioBuffer({
      buffer: new Uint8Array([1, 2, 3]),
      requestId: 'turn-1',
      lane: 'conversation',
    });
    expect(result).not.toBeNull();
    expect(Array.from(new Uint8Array(result!))).toEqual([1, 2, 3]);
  });

  it('rejects an empty or unrelated payload', () => {
    expect(normalizeVoiceAudioBuffer(null)).toBeNull();
    expect(normalizeVoiceAudioBuffer({ requestId: 'turn-1' })).toBeNull();
  });
});
