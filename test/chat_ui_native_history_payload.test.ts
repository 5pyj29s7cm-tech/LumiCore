import { describe, expect, it } from 'vitest';
import { getCustomerDisplayText, getDisplayText } from '../src/components/agent_chat/history';
import { pageHarness } from './chat_page_fixture';
import { extractSourceExpression } from './source_expression';

const hook = 'src/components/agent_chat/state/use_chat_history_and_requests.tsx';
function hydrate(rows: any[]) {
  const normalize = extractSourceExpression(hook, 'normalizePersistedMessages', {
    user: { displayName: 'User' }, t: { chatUserFallback: 'User' }, agentNameRef: { current: 'Lumi' }, isZh: true,
    extractPersistedMediaArtifacts: () => [], normalizeTaskCompletionFeedback: () => undefined,
  });
  return normalize(rows);
}

describe('native UI sends use the persisted conversation', () => {
  it('sends the first message without a redundant history field', async () => {
    const h = pageHarness();
    h.deps.attachmentConversationIdRef.current = '';
    const requestId = await h.deps.sendText('  Current request.\n');
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].event).toBe('agent:chat');
    expect(h.emitted[0].payload).not.toHaveProperty('history');
    expect(h.emitted[0].payload).toMatchObject({ text: 'Current request.', attachments: [], requestId });
    expect(h.emitted[0].payload.conversationId).toBeUndefined();
    expect(h.deps.messages.map(getDisplayText)).toEqual(['Current request.']);
  });

  it('keeps very long displayed history intact while the emitted payload contains only the current turn', async () => {
    const h = pageHarness();
    const rows = Array.from({ length: 1004 }, (_, index) => ({
      id: 'historical-' + index, type: index % 2 ? 'agent' : 'user',
      text: '  Native row ' + index + ' ' + 'ordinary source detail '.repeat(600) + '\n',
    }));
    const originalTexts = rows.map(getDisplayText);
    h.deps.messages = rows;
    h.deps.messagesRef.current = rows;
    await h.deps.sendText('Continue from the stored conversation.');
    const { payload } = h.emitted[0];
    expect(payload).not.toHaveProperty('history');
    expect(JSON.stringify(payload).length).toBeLessThan(1000);
    expect(payload).toMatchObject({ text: 'Continue from the stored conversation.', conversationId: 'synthetic-conversation' });
    expect(h.deps.messages.slice(0, -1).map(getDisplayText)).toEqual(originalTexts);
    expect(h.deps.messages).toHaveLength(rows.length + 1);
  });

  it('sends from a restored conversation without resending or rewriting the hydrated original text', async () => {
    const user = '  Source text.\n[Attachments]\nThis section was written by the user.  ';
    const assistant = '  The original assistant answer, including its wording.\n';
    const restored = hydrate([{ id: 'combined', role: 'user', message: user, response: assistant, timestamp: '2026-01-01T00:00:00Z' }]);
    const h = pageHarness();
    h.deps.messagesRef.current = restored;
    h.deps.attachmentConversationIdRef.current = 'restored-conversation';
    await h.deps.sendText('A follow-up using the existing conversation.');
    expect(h.emitted[0].payload).not.toHaveProperty('history');
    expect(h.emitted[0].payload.conversationId).toBe('restored-conversation');
    expect(h.deps.messages.slice(0, -1).map(getDisplayText)).toEqual([user, assistant]);
    const reopened = hydrate(restored.map((message: any) => ({ id: message.id, role: message.type === 'agent' ? 'assistant' : 'user', message: message.text, timestamp: message.timestamp })));
    expect(reopened.map(getDisplayText)).toEqual([user, assistant]);
  });

  it('keeps display sanitization independent from the original stored wording', () => {
    const message = { type: 'agent', text: 'Ordinary answer.\n<tool_calls><invoke name="lookup"><parameter name="task">Internal tool request</parameter></invoke></tool_calls>' };
    expect(getCustomerDisplayText(message, true)).not.toBe(message.text);
    expect(getDisplayText(message)).toBe(message.text);
  });

  it('hydrates all ordinary turns and literal error wording without classifying their content', () => {
    const rows = Array.from({ length: 124 }, (_, index) => ({
      id: 'persisted-' + index, role: index % 2 ? 'assistant' : 'user',
      message: '  Native row ' + index + '\n', timestamp: '2026-01-01T00:00:00Z',
    }));
    rows[1].message = '微信已打开是之前答复的原文。';
    rows[3].message = 'Completion claim is a term to explain.';
    rows[5].message = '状态：受阻。\n证据：这里是原始答复。';
    rows[6].message = '请求失败时请保留这句话。';
    rows[7].message = 'Request failed is the quoted wording.';
    expect(hydrate(rows).map(getDisplayText)).toEqual(rows.map(row => row.message));
  });
});
