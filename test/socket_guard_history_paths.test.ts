import './helpers';
import { describe, expect, it } from 'vitest';
import { buildClientSurfaceContinuationBridge } from '../server/socket/chat';
import { normalizeVoiceHistoryRecord } from '../server/socket/voice';

describe('socket guard-history delivery paths', () => {
  it('does not turn marked or legacy guard text into client-surface continuation', () => {
    const marked = buildClientSurfaceContinuationBridge('继续', [{
      role: 'assistant',
      message: '客户端状态还没有拿到。',
      cognitiveIntent: 'work_product_guard',
    }]);
    const legacy = buildClientSurfaceContinuationBridge('继续', [{
      role: 'assistant',
      message: '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。',
    }]);

    expect(marked).toBe('');
    expect(legacy).toBe('');
  });

  it('preserves real client-surface continuity', () => {
    const bridge = buildClientSurfaceContinuationBridge('继续', [{
      role: 'user',
      message: '打开客户端的中枢世界',
    }]);

    expect(bridge).toContain('Internal client-surface continuation context');
    expect(bridge).toContain('client_get_state');
  });

  it('drops marked and legacy assistant guard records from voice history', () => {
    expect(normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '客户端状态还没有拿到。',
      cognitiveIntent: 'work_product_guard',
    })).toEqual([]);
    expect(normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。',
    })).toEqual([]);
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
