import { describe, expect, it } from 'vitest';
import { hasVisionIntent } from '../server/cognition/vision_routing';
import { shouldAllowToolUseForTurn } from '../server/cognition/tool_intent';

describe('vision routing intent', () => {
  it('detects screen and image recognition requests', () => {
    expect(hasVisionIntent('帮我识别一下屏幕上的内容')).toBe(true);
    expect(hasVisionIntent('read this screenshot')).toBe(true);
    expect(hasVisionIntent('请分析 C:\\Users\\me\\Desktop\\plan.png')).toBe(true);
  });

  it('does not treat ordinary conversation as visual work', () => {
    expect(hasVisionIntent('你觉得这个想法怎么样')).toBe(false);
    expect(shouldAllowToolUseForTurn('你觉得这个想法怎么样', undefined, 'chat')).toBe(false);
  });

  it('keeps visual tools out of pure chat while preserving assistant and meeting boundaries', () => {
    const text = '识别一下这个人是谁';
    expect(shouldAllowToolUseForTurn(text, undefined, 'chat')).toBe(false);
    expect(shouldAllowToolUseForTurn(text, undefined, 'assistant')).toBe(true);
    expect(shouldAllowToolUseForTurn(text, undefined, 'meeting')).toBe(false);
  });
});
