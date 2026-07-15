import { describe, expect, it } from 'vitest';
import {
  hasClientActionOnlyIntent,
  isUserCorrectionOrExplanationQuestion,
  shouldAllowToolUseForTurn,
} from '../server/cognition/tool_intent';

describe('audio transcription tool intent', () => {
  it('keeps transcript file requests out of pure chat and enables them in assistant mode', () => {
    const text = 'Please transcribe this audio recording and save it as a text file.';
    expect(shouldAllowToolUseForTurn(text, undefined, 'chat')).toBe(false);
    expect(shouldAllowToolUseForTurn(text, undefined, 'assistant')).toBe(true);
  });

  it('distinguishes a WeChat inquiry from a channel correction', () => {
    const inquiry = '你打开微信问一下阿露在干嘛。';
    expect(isUserCorrectionOrExplanationQuestion(inquiry)).toBe(false);
    expect(hasClientActionOnlyIntent(inquiry)).toBe(false);
    expect(shouldAllowToolUseForTurn(inquiry, 'voice', 'autonomous')).toBe(true);

    const correction = '不是，我现在就在桌面客户端上，哪来的微信客户端啊？';
    expect(isUserCorrectionOrExplanationQuestion(correction)).toBe(true);
    expect(hasClientActionOnlyIntent(correction)).toBe(false);
    expect(shouldAllowToolUseForTurn(correction, 'voice', 'autonomous')).toBe(false);
  });
});
