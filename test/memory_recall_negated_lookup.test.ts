import { describe, it, expect } from 'vitest';
import { withoutNegatedLookupClauses, normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { hasExplicitToolIntent } from '../server/cognition/tool_intent';
import { classifyIntent } from '../server/cognition/intent';
import { buildActionContract } from '../server/cognition/action_contract';

describe('memory recall must not execute a forbidden lookup', () => {
  it.each([
    '你还记得岚桥记忆复核项目的专用标记和资料盒位置吗？如果没有已保存的记忆，请直接说不知道，不要猜测或搜索聊天记录。',
    '你记得资料盒在哪里吗？不需要查看聊天记录。',
    "Do you remember the project marker? If not, say you do not know. Don't guess or search chat history.",
  ])('preserves a recall question as conversation: %s', text => {
    expect(normalizeActionIntent(text).kind).not.toBe('messaging_read');
    expect(classifyIntent(text).category).not.toBe('web');
    expect(hasExplicitToolIntent(text)).toBe(false);
    expect(buildActionContract(text).applies).toBe(false);
  });
  it('keeps an affirmative search in another clause', () => {
    const text = '搜索公开项目资料，不要读取聊天记录。';
    expect(hasExplicitToolIntent(text)).toBe(true);
    expect(classifyIntent(text).category).toBe('web');
    expect(buildActionContract(text).kind).not.toBe('messaging_read');
  });
  it('keeps an affirmative operation after a contrast', () => {
    expect(withoutNegatedLookupClauses('不要搜索聊天记录，但是打开计算器')).toContain('打开计算器');
    expect(hasExplicitToolIntent('不要搜索聊天记录，但是打开计算器')).toBe(true);
  });
  it('does not rewrite a quoted artifact payload or erase a send prohibition', () => {
    for (const text of ['写入文件的内容是：“不要搜索聊天记录”。', '起草邮件，不要发送。', 'Write a file with this content: A sample. Do not search chat history.'])
      expect(withoutNegatedLookupClauses(text)).toBe(text);
  });
});
