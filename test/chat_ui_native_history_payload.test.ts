import { describe, expect, it } from 'vitest';
import { buildChatHistoryPayload, getCustomerDisplayText, getDisplayText } from '../src/components/agent_chat/history';
import { extractSourceExpression } from './source_expression';

const hook = 'src/components/agent_chat/state/use_chat_history_and_requests.tsx';
function hydrate(rows: any[]) {
  const normalize = extractSourceExpression(hook, 'normalizePersistedMessages', {
    user: { displayName: 'User' }, t: { chatUserFallback: 'User' }, agentNameRef: { current: 'Lumi' }, isZh: true,
    stripStoredAttachmentSummary: (text: string) => String(text || '').replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '').trim(),
    hasInternalAgentExecutionDetail: () => true,
    sanitizeAgentResponseTextForDisplay: () => 'DISPLAY-ONLY-SANITIZED',
    extractPersistedMediaArtifacts: () => [], normalizeTaskCompletionFeedback: () => undefined,
  });
  return normalize(rows);
}

describe('native UI chat history payload', () => {
  it('keeps all ordinary turns and complete text beyond the former eighty-row limit', () => {
    const rows = Array.from({ length: 124 }, (_, index) => ({ type: index % 2 ? 'agent' : 'user', text: '  Native row ' + index + '\n' }));
    expect(buildChatHistoryPayload(rows)).toEqual(rows.map(row => ({ role: row.type === 'agent' ? 'assistant' : 'user', content: row.text })));
  });

  it('preserves assistant wording, legacy flags and literal error prefixes instead of classifying their content', () => {
    const rows = [
      { type: 'agent', text: '微信已打开是之前答复的原文。', legacyExecutionReport: true },
      { type: 'agent', text: 'Completion claim is a term to explain.' },
      { type: 'agent', text: '状态：受阻。\n证据：这里是原始答复。' },
      { type: 'user', text: '请求失败时请保留这句话。' },
      { type: 'agent', text: 'Request failed is the quoted wording.' },
    ];
    expect(buildChatHistoryPayload(rows)).toEqual(rows.map(row => ({ role: row.type === 'agent' ? 'assistant' : 'user', content: row.text })));
  });

  it('retains structured file context and source text while excluding actual UI-only metadata and tool messages', () => {
    const text = '  Native user text.\n[Attachments]\nA literal section that is part of the user message.  ';
    expect(buildChatHistoryPayload([{ type: 'file_context', text }, { type: 'tool', text: 'PRIVATE-TOOL' }, { type: 'agent', source: 'error', text: 'UI ERROR' }, { type: 'agent', source: 'proactive', text: 'UI PROACTIVE' }, { type: 'user', text: '   ' }])).toEqual([{ role: 'user', content: text }]);
  });

  it('keeps display sanitization independent from the native payload', () => {
    const message = { type: 'agent', text: 'Ordinary answer.\n<tool_calls><invoke name="lookup"><parameter name="task">Internal tool request</parameter></invoke></tool_calls>' };
    expect(getCustomerDisplayText(message, true)).not.toBe(message.text);
    expect(buildChatHistoryPayload([message])).toEqual([{ role: 'assistant', content: message.text }]);
  });

  it('preserves persisted user attachment-like text and original combined assistant responses through hydration', () => {
    const user = '  Source text.\n[Attachments]\nThis section was written by the user.  ';
    const assistant = '  The original assistant answer, including its wording.\n';
    const messages = hydrate([{ id: 'combined', role: 'user', message: user, response: assistant, timestamp: '2026-01-01T00:00:00Z' }]);
    expect(buildChatHistoryPayload(messages)).toEqual([{ role: 'user', content: user }, { role: 'assistant', content: assistant }]);
    expect(messages.map((message: any) => getDisplayText(message))).toEqual([user, assistant]);
    const reopened = hydrate(messages.map((message: any) => ({ id: message.id, role: message.type === 'agent' ? 'assistant' : 'user', message: message.text, timestamp: message.timestamp })));
    expect(buildChatHistoryPayload(reopened)).toEqual(buildChatHistoryPayload(messages));
  });
});
