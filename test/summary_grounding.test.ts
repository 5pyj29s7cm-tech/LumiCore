import './helpers';
import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '../server/conversation/manager';
import {
  buildCompactToolEvidenceNote,
  buildEvidenceGroundedSummaryTranscript,
  sanitizeSummaryForPrompt,
} from '../server/conversation/summary_grounding';

function message(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    id: Math.random().toString(36),
    userId: 'u',
    conversationId: 'c',
    message: '',
    role: 'user',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('evidence-grounded conversation summaries', () => {
  it('omits unverified execution outcomes but keeps ordinary conversation', () => {
    const transcript = buildEvidenceGroundedSummaryTranscript([
      message({ role: 'user', message: '帮我深度测试网络' }),
      message({ role: 'assistant', message: '深度测试已完成，DNS、端口和 MCP 心跳全部通过。' }),
      message({ role: 'assistant', message: '好的，你说。' }),
    ]);
    expect(transcript).toContain('帮我深度测试网络');
    expect(transcript).toContain('好的，你说');
    expect(transcript).not.toContain('MCP 心跳全部通过');
  });

  it('annotates current-turn tool-backed outcomes for the summarizer', () => {
    const transcript = buildEvidenceGroundedSummaryTranscript([
      message({
        role: 'assistant',
        message: '网络采样已完成。',
        toolCalls: [{ name: 'network_stability_check', arguments: {}, result: '{"ok":true}' }],
      }),
    ]);
    expect(transcript).toContain('verified current-turn tools: network_stability_check');
    expect(transcript).toContain('网络采样已完成');
  });

  it('removes unsupported legacy facts while preserving preferences and marked facts', () => {
    const sanitized = sanitizeSummaryForPrompt([
      '用户希望 Lumi 边工作边自然聊天。',
      'Lumi 已完成深度网络检查，全部通过。',
      'Verified by current-turn tool receipts: vision model test passed.',
    ].join(' '));
    expect(sanitized).toContain('边工作边自然聊天');
    expect(sanitized).not.toContain('全部通过');
    expect(sanitized).toContain('Verified by current-turn tool receipts');
  });

  it('quarantines the unsupported outcomes seen in the real network/model summary', () => {
    const sanitized = sanitizeSummaryForPrompt('用户多次要求进行连接稳定性测试，并明确偏好直接响应。用户询问并切换至工具模式后，完成了外网可达性、MCP 链路和系统服务的实际测试。最后检查视觉模型状态，确认当前模型为 DeepSeek v4 Pro。');
    expect(sanitized).toContain('偏好直接响应');
    expect(sanitized).not.toContain('完成了外网可达性');
    expect(sanitized).not.toContain('DeepSeek v4 Pro');
  });

  it('keeps a compact factual receipt ledger for later turns', () => {
    const note = buildCompactToolEvidenceNote([{
      name: 'model_configuration_test',
      arguments: { role: 'reasoning' },
      result: JSON.stringify({
        ok: true,
        result: { provider: 'deepseek', model: 'deepseek-v4-pro', latencyMs: 1229 },
      }),
    }]);
    expect(note).toContain('model_configuration_test');
    expect(note).toContain('role=reasoning');
    expect(note).toContain('deepseek-v4-pro');
    expect(note).toContain('latencyMs=1229');
  });

  it('preserves verified client navigation evidence after prompt compaction', () => {
    const note = buildCompactToolEvidenceNote([{
      name: 'client_action',
      arguments: { action: 'open_settings', section: 'voice' },
      result: JSON.stringify({
        ok: true,
        action: 'open_settings',
        target: 'settings',
        section: 'voice',
        verification: {
          status: 'verified',
          matched: ['surface:settings:open', 'settings-section:voice'],
        },
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'state_diff',
        reason: 'voice settings rendered',
      },
    }]);
    expect(note).toContain('client_action');
    expect(note).toContain('action=open_settings');
    expect(note).toContain('target=settings');
    expect(note).toContain('section=voice');
    expect(note).toContain('outcome=verified_success');
    expect(note).toContain('verification=verified');
    expect(note).toContain('settings-section:voice');
  });
});
