import './helpers';
import { describe, expect, it } from 'vitest';
import { resolveConversationModelConfig } from '../server/llm/conversation_profile';
import { getExplicitSentenceCountConstraint } from '../server/cognition/response_constraints';
import { compactRecordForPrompt } from '../server/conversation/manager';
import { normalizeVoiceHistory } from '../server/socket/voice_history';
import { normalizeChatHistoryRecord } from '../server/socket/chat';
import { buildLumiTurnFlow } from '../server/cognition/turn_flow';
import { initDatabase } from '../db_layer';

describe('conversation latency and historical reply boundaries', () => {
  const config = { provider: 'relay', model: 'aliyun/deepseek-v4-pro', noImplicitFailover: true, maxTokens: 8192 };

  it('uses the configured provider and token limit for a short social turn without extended reasoning', () => {
    expect(resolveConversationModelConfig('今天有点累，你用两句话陪我聊聊。', config)).toEqual({ ...config, thinkingMode: 'disabled' });
    expect(config).not.toHaveProperty('thinkingMode');
  });

  it.each([
    '陪我聊聊这个合同的法律风险。',
    '今天有点累，但请详细分析这段代码为什么慢。',
    '请证明这个结论。',
    '刚才实际做到了哪一步？不要重新执行。',
    '陪我聊聊这个案件，再计算一下赔偿。',
    '我想自杀，安慰我。',
  ])('retains reasoning for complex or task-related input: %s', text => {
    expect(resolveConversationModelConfig(text, config)).toBe(config);
  });

  it('preserves local/private configuration and explicit thinking settings', () => {
    const local = { ...config, provider: 'ollama' };
    expect(resolveConversationModelConfig('陪我聊聊', local)).toBe(local);
    const explicit = { ...config, thinkingMode: 'disabled' as const };
    expect(resolveConversationModelConfig('陪我聊聊', explicit)).toBe(explicit);
  });

  it('recognizes a literal sentence request without treating casual 聊两句 as a constraint', () => {
    expect(getExplicitSentenceCountConstraint('你用两句话陪我聊聊。', '我在。慢慢说。')).toEqual({ expected: 2, actual: 2 });
    expect(getExplicitSentenceCountConstraint('用3句话解释这个概念。', '一。二。')).toEqual({ expected: 3, actual: 2 });
    expect(getExplicitSentenceCountConstraint('我们先聊两句。', '好。')).toBeNull();
  });

  it('keeps an answered status turn paired while excluding unsupported success claims in text and voice', () => {
    const raw = {
      id: 'status-reply', userId: 'latency-fixture', conversationId: 'latency-fixture',
      timestamp: new Date().toISOString(), role: 'assistant' as const,
      message: '已保存并回读文件：D:/fixture/report.xlsx。总额108。',
      source: 'chat_conversation_execution_facts', cognitiveIntent: 'execution_facts', llmWasCalled: false,
    };
    const user = { ...raw, role: 'user' as const, message: '做到哪一步了？', source: 'chat', cognitiveIntent: '' };
    const compacted = compactRecordForPrompt(raw);
    const records = [user, compacted];
    for (const history of [records.flatMap(row => normalizeChatHistoryRecord(row, { serverOwned: true })), normalizeVoiceHistory(records)]) {
      expect(history.map(row => row.role)).toEqual(['user', 'assistant']);
      expect(history[1].content).toContain('not a pending instruction');
      expect(JSON.stringify(history)).not.toContain('已保存');
      expect(JSON.stringify(history)).not.toContain('总额108');
    }
    expect(raw.message).toContain('总额108'); // Persistence and real receipts are untouched.
  });

  it.each(['chat', 'voice'] as const)('omits execution manuals for an ordinary %s turn', async channel => {
    await initDatabase();
    const flow = buildLumiTurnFlow({ userId: 'latency-flow', text: '今天有点累，陪我聊聊，不要执行任务。', channel, operationMode: 'assistant', targetIsLumi: true });
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.promptOverlay).toContain('newest user message');
    expect(flow.promptOverlay).not.toContain('capability_gap_autofix');
    expect(flow.promptOverlay).not.toContain('work_product_verify');
  });
});
