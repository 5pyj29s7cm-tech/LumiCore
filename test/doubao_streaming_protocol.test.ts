import { gunzipSync, gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { __doubaoStreamingProtocolForTests } from '../server/stt/providers/ark_stream';

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

describe('Doubao streaming binary protocol', () => {
  it('allows provider VAD to finalize ordinary spoken turns by default', () => {
    const previous = process.env.DOUBAO_ASR_FORCE_TO_SPEECH_MS;
    delete process.env.DOUBAO_ASR_FORCE_TO_SPEECH_MS;
    try {
      expect((__doubaoStreamingProtocolForTests.buildRequest('zh-CN').request as any).force_to_speech_time).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.DOUBAO_ASR_FORCE_TO_SPEECH_MS;
      else process.env.DOUBAO_ASR_FORCE_TO_SPEECH_MS = previous;
    }
  });

  it('marks audio-only client payloads as raw bytes', () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const packet = __doubaoStreamingProtocolForTests.buildAudioRequest(2, audio);

    expect(packet[1]).toBe(0x21);
    expect(packet[2]).toBe(0x01);
    expect(packet.readInt32BE(4)).toBe(2);
    const payloadSize = packet.readUInt32BE(8);
    expect(gunzipSync(packet.subarray(12, 12 + payloadSize))).toEqual(audio);
  });

  it('parses an ACK sequence exactly once before its JSON body', () => {
    const message = { result: { text: '你好' } };
    const compressed = gzipSync(Buffer.from(JSON.stringify(message), 'utf8'));
    const packet = Buffer.concat([
      Buffer.from([0x11, 0xb1, 0x11, 0x00]),
      int32(7),
      uint32(compressed.length),
      compressed,
    ]);

    expect(__doubaoStreamingProtocolForTests.parseResponse(packet)).toMatchObject({
      sequence: 7,
      isLastPackage: false,
      message,
    });
  });

  it('keeps a growing latest utterance partial when only an older utterance is definite', () => {
    expect(__doubaoStreamingProtocolForTests.extractText({
      result: {
        text: 'first sentence, growing second sentence',
        utterances: [
          { text: 'first sentence', definite: true },
          { text: 'growing second sentence', definite: false },
        ],
      },
    })).toEqual({
      text: 'first sentence, growing second sentence',
      isFinal: false,
    });
  });

  it('finalizes only when the latest utterance is definite', () => {
    expect(__doubaoStreamingProtocolForTests.extractText({
      result: {
        text: 'first sentence, completed second sentence',
        utterances: [
          { text: 'first sentence', definite: true },
          { text: 'completed second sentence', definite: true },
        ],
      },
    })).toEqual({
      text: 'first sentence, completed second sentence',
      isFinal: true,
    });
  });

  it('uses a shorter stable-partial window for a completed sentence', () => {
    expect(__doubaoStreamingProtocolForTests.getStablePartialCommitDelayMs('Can you hear me?')).toBe(700);
    expect(__doubaoStreamingProtocolForTests.getStablePartialCommitDelayMs('continue speaking')).toBe(1200);
  });

  it('emits only the uncommitted tail of cumulative Doubao transcripts', () => {
    expect(__doubaoStreamingProtocolForTests.getUncommittedTranscript(
      'Can you hear me?',
      'Can you hear me? Please answer.',
    )).toBe('Please answer.');
    expect(__doubaoStreamingProtocolForTests.getUncommittedTranscript(
      'Can you hear me?',
      'Can you hear me?',
    )).toBe('');
  });
});
