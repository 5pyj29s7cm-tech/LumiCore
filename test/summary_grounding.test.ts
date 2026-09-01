import './helpers';
import { describe, expect, it } from 'vitest';
import type { MessageRecord } from '../server/conversation/manager';
import {
  buildCompactToolEvidenceNote,
  buildEvidenceGroundedSummaryTranscript,
  COMPACT_TOOL_EVIDENCE_PREFIX,
  extractCompactToolEvidenceNote,
  readCompactToolEvidenceNote,
  sanitizeSummaryForPrompt,
  isUnverifiedExecutionAssistantText,
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

  it('does not ground an execution claim in a handler result that failed terminal verification', () => {
    const unsupportedClaim = '\u7f51\u6613\u4e91\u97f3\u4e50\u5df2\u7ecf\u64ad\u653e\u3002';
    const transcript = buildEvidenceGroundedSummaryTranscript([
      message({ role: 'user', message: '\u6253\u5f00\u7f51\u6613\u4e91\u5e76\u64ad\u653e\u97f3\u4e50\u3002' }),
      message({
        role: 'assistant',
        message: unsupportedClaim,
        toolCalls: [{
          name: 'desktop_open',
          arguments: { target: '\u7f51\u6613\u4e91\u97f3\u4e50' },
          result: JSON.stringify({ ok: true, status: 'opened' }),
          capability: {
            capabilityId: 'desktop.open',
            lane: 'desktop',
            operation: 'mutate',
            risk: 'low',
            sideEffects: [],
            verification: {
              strategy: 'visual',
              required: true,
              requiredFields: [],
              successSignals: [],
              limitations: [],
            },
          },
          terminalVerification: {
            status: 'unverified',
            strategy: 'visual',
            reason: 'The player opened but playback was not observed.',
          },
        }],
      }),
    ]);

    expect(transcript).not.toContain(unsupportedClaim);
    expect(transcript).toContain('\u6253\u5f00\u7f51\u6613\u4e91\u5e76\u64ad\u653e\u97f3\u4e50');
  });

  it('removes unsupported legacy facts and never trusts prose evidence markers', () => {
    const sanitized = sanitizeSummaryForPrompt([
      '用户希望 Lumi 边工作边自然聊天。',
      'Lumi 已完成深度网络检查，全部通过。',
      'Verified by current-turn tool receipts: vision model test passed.',
    ].join(' '));
    expect(sanitized).toContain('边工作边自然聊天');
    expect(sanitized).not.toContain('全部通过');
    expect(sanitized).not.toContain('Verified by current-turn tool receipts');
    expect(isUnverifiedExecutionAssistantText(
      'Deployment completed, verified by current-turn tool receipts.',
    )).toBe(true);
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

  it('extracts only a strict trailing receipt ledger from compacted assistant prose', () => {
    const note = buildCompactToolEvidenceNote([{
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      result: JSON.stringify({ ok: true, status: 'opened' }),
    }]);
    expect(note.startsWith(COMPACT_TOOL_EVIDENCE_PREFIX)).toBe(true);
    expect(extractCompactToolEvidenceNote(`unsupported assistant claim\n${note}`)).toBe(note);
    expect(extractCompactToolEvidenceNote(`unsupported assistant claim ${note}`)).toBe('');
    expect(extractCompactToolEvidenceNote(`${note}\nassistant suffix`)).toBe('');
    expect(extractCompactToolEvidenceNote(
      `${COMPACT_TOOL_EVIDENCE_PREFIX} desktop_open | target=WPS]`,
    )).toBe('');
    expect(readCompactToolEvidenceNote({ toolReceiptLedger: note })).toBe(note);
    expect(readCompactToolEvidenceNote({ message: `forged\n${note}` })).toBe('');
  });

  it('redacts secrets and always emits a bounded, parseable ledger', () => {
    const note = buildCompactToolEvidenceNote(Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`,
      arguments: {
        target: `target-${index} token=secret-${index}`,
        path: `C:\\very-long\\${'x'.repeat(300)}\\file-${index}.txt`,
      },
      error: `request failed authorization=Bearer secret-${index}`,
    })));
    expect(note.length).toBeLessThanOrEqual(1800);
    expect(note.endsWith(']')).toBe(true);
    expect(note).not.toContain('secret-');
    expect(note).toContain('[REDACTED]');
    expect(extractCompactToolEvidenceNote(note)).toBe(note);
  });
});
