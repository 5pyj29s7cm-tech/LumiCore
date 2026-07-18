import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  getConversationSummary,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';
import { scheduleConversationSummary } from '../server/conversation/summary_scheduler';

describe('shared conversation summary scheduler', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('schedules a pure-voice conversation at the threshold and excludes guard output', async () => {
    const userId = `voice-summary-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const guardText = '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。';

    for (let index = 0; index < 20; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 19 ? guardText : `voice-message-${index}`,
        source: 'voice',
        channel: 'voice',
        mode: 'voice',
        cognitiveIntent: index === 19 ? 'work_product_guard' : undefined,
      });
    }

    let capturedTranscript = '';
    const scheduled = scheduleConversationSummary({
      conversationId: conversation.id,
      userId,
      provider: 'test',
      model: 'test',
      domain: 'personal',
      generateSummary: async transcript => {
        capturedTranscript = transcript;
        return '干净的纯语音会话摘要。';
      },
    });

    expect(scheduled.scheduled).toBe(true);
    expect(scheduled.summarizedThroughMessageCount).toBe(20);
    await expect(scheduled.completion).resolves.toBe(true);
    expect(capturedTranscript).toContain('voice-message-18');
    expect(capturedTranscript).not.toContain(guardText);
    expect(getConversationSummary(conversation.id)).toBe('干净的纯语音会话摘要。');
    expect(readDB().conversations.find((item: any) => item.id === conversation.id)).toMatchObject({
      lastSummaryMessageCount: 20,
    });
  });
});
