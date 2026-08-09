import { describe, expect, it } from 'vitest';
import {
  isCurrentVoiceInputSource,
  isRepeatedVoiceFinal,
} from '../server/cognition/voice_input_guard';
import { addEchoText, isEchoText } from '../server/socket/voice';

describe('voice input source and duplicate guards', () => {
  it('accepts only the active STT instance belonging to the current session', () => {
    const currentStt = {};
    expect(isCurrentVoiceInputSource({
      sessionActive: true,
      currentSessionId: 'session-new',
      callbackSessionId: 'session-new',
      currentSttSession: currentStt,
      callbackSttSession: currentStt,
    })).toBe(true);
    expect(isCurrentVoiceInputSource({
      sessionActive: true,
      currentSessionId: 'session-new',
      callbackSessionId: 'session-old',
      currentSttSession: currentStt,
      callbackSttSession: currentStt,
    })).toBe(false);
    expect(isCurrentVoiceInputSource({
      sessionActive: true,
      currentSessionId: 'session-new',
      callbackSessionId: 'session-new',
      currentSttSession: currentStt,
      callbackSttSession: {},
    })).toBe(false);
  });

  it('rejects provider duplicate finals until new microphone audio arrives', () => {
    const base = {
      commandKey: 'open-chat',
      lastCommandKey: 'open-chat',
      lastAcceptedAt: 1_000,
      laneActive: false,
    };
    expect(isRepeatedVoiceFinal({
      ...base,
      currentChunkAt: 2_000,
      lastAcceptedChunkAt: 2_000,
      now: 20_000,
    })).toBe(true);
    expect(isRepeatedVoiceFinal({
      ...base,
      currentChunkAt: 2_001,
      lastAcceptedChunkAt: 2_000,
      now: 20_000,
    })).toBe(false);
    expect(isRepeatedVoiceFinal({
      ...base,
      currentChunkAt: 2_001,
      lastAcceptedChunkAt: 2_000,
      lastAcceptedAt: 19_000,
      laneActive: true,
      now: 20_000,
    })).toBe(true);
  });

  it('isolates TTS echo history by user and voice session', () => {
    const spoken = '\u8fd9\u662f\u4e00\u6bb5\u53ea\u5c5e\u4e8e\u4f1a\u8bdd\u7532\u7684\u72ec\u7279\u64ad\u62a5\u6587\u672c';
    addEchoText(spoken, 'user-a:session-a');
    expect(isEchoText(spoken, false, 'user-a:session-a')).toBe(true);
    expect(isEchoText(spoken, false, 'user-b:session-b')).toBe(false);
  });
});
