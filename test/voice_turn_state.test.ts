import { describe, expect, it } from 'vitest';
import {
  isSpeechClearlyDirectedAwayFromLumi,
  isVoiceCorrectionContinuation,
  isVoiceFiller,
  isVoiceReferentialFollowup,
  mergeInterruptedVoiceTurn,
} from '../server/socket/voice_turn_state';

describe('voice interruption state', () => {
  it('merges an immediate recipient correction into the interrupted action', () => {
    const now = Date.now();
    const result = mergeInterruptedVoiceTurn({
      text: '你打开微信问一下阿洛在干嘛。',
      interruptedAt: now - 500,
    }, '让你问阿露，不是问阿洛。', now);

    expect(result.usedInterruptedTurn).toBe(true);
    expect(result.routingText).toContain('问一下阿洛在干嘛');
    expect(result.routingText).toContain('让你问阿露，不是问阿洛');
  });

  it('does not leak an interrupted question into unrelated new speech', () => {
    const now = Date.now();
    const result = mergeInterruptedVoiceTurn({
      text: '语音唤醒怎么叫不动你？',
      interruptedAt: now - 500,
    }, '我又没钱了。', now);

    expect(result).toEqual({ routingText: '我又没钱了。', usedInterruptedTurn: false });
  });

  it('expires old interrupted context', () => {
    const now = Date.now();
    expect(isVoiceCorrectionContinuation('我说的是阿露，不是阿洛。')).toBe(true);
    expect(mergeInterruptedVoiceTurn({
      text: '打开微信问一下阿洛在干嘛。',
      interruptedAt: now - 31_000,
    }, '我说的是阿露，不是阿洛。', now).usedInterruptedTurn).toBe(false);
  });

  it('ignores repeated hesitation without treating greetings as filler', () => {
    expect(isVoiceFiller('嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯。')).toBe(true);
    expect(isVoiceFiller('嗯。')).toBe(true);
    expect(isVoiceFiller('嗨，你好。')).toBe(false);
    expect(isVoiceFiller('嗯，在呢。')).toBe(false);
  });

  it('recognizes explicit speech to another person without swallowing a Lumi command', () => {
    expect(isSpeechClearlyDirectedAwayFromLumi('我我在跟我在跟AI说话，你等一下。')).toBe(true);
    expect(isSpeechClearlyDirectedAwayFromLumi('Lumi，你等一下，先打开WPS。')).toBe(false);
  });

  it('keeps proactive context limited to bare referential replies', () => {
    expect(isVoiceReferentialFollowup('继续。')).toBe(true);
    expect(isVoiceReferentialFollowup('那个。')).toBe(true);
    expect(isVoiceReferentialFollowup('看一下现在知识库里有多少的文件内容。')).toBe(false);
    expect(isVoiceReferentialFollowup('打开浏览器。')).toBe(false);
  });

  it('recognizes spoken name-spelling corrections as continuations', () => {
    expect(isVoiceCorrectionContinuation('我说的阿路是大陆的陆，不是道路的路。')).toBe(true);
  });
});
