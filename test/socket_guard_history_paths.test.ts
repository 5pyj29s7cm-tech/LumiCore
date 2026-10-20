import './helpers';
import { describe, expect, it } from 'vitest';
import {
  normalizeChatHistoryRecord,
} from '../server/socket/chat';
import { normalizeVoiceHistoryRecord } from '../server/socket/voice';
import { sanitizePublicExecutionText } from '../shared/public_execution_language';

describe('socket guard-history delivery paths', () => {
  it('retains the public failure while isolating marked and legacy guard protocol', () => {
    expect(normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '客户端状态还没有拿到。',
      cognitiveIntent: 'work_product_guard',
    })).toEqual([{ role: 'assistant', content: '客户端状态还没有拿到。' }]);
    expect(normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。',
    })).toEqual([]);
  });

  it('quarantines legacy status/evidence reports in chat and voice history', () => {
    const reports = [
      [
        '状态：受阻。',
        '证据：暂时没有可核验的执行结果。',
        '下一步：保留已有进度，先核验目标状态再继续。',
      ].join('\n'),
      [
        '状态：失败。',
        '证据：文件操作 (失败: Desktop target application has not matched a fresh observation.)。',
        '具体阻塞：Desktop execution ended as target_mismatch.',
      ].join('\n'),
    ];

    for (const report of reports) {
      const publicReply = [{ role: 'assistant', content: sanitizePublicExecutionText(report) }];
      expect(normalizeChatHistoryRecord({ role: 'assistant', message: report }, { serverOwned: true })).toEqual(publicReply);
      expect(normalizeVoiceHistoryRecord({ role: 'assistant', message: report })).toEqual(publicReply);
      expect(normalizeVoiceHistoryRecord({
        role: 'user',
        message: '继续刚才的任务',
        response: report,
      })).toEqual([{ role: 'user', content: '继续刚才的任务' }]);
    }
  });

  it('keeps the user side of a legacy combined row but does not reconstruct its guard response', () => {
    const normalized = normalizeVoiceHistoryRecord({
      role: 'user',
      message: '你对目前自己的能力是否满意',
      response: '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。',
      cognitiveIntent: 'work_product_guard',
    });

    expect(normalized).toEqual([{
      role: 'user',
      content: '你对目前自己的能力是否满意',
    }]);
  });

  it('preserves a real assistant response from a legacy combined row', () => {
    const normalized = normalizeVoiceHistoryRecord({
      role: 'user',
      message: '早',
      response: '早，今天想先做什么？',
      source: 'chat',
    });

    expect(normalized).toEqual([
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早，今天想先做什么？' },
    ]);
  });
});
