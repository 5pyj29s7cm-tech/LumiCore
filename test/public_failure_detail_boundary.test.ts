import { describe, expect, it } from 'vitest';
import { formatCnToolFailureDetail } from '../server/regions/messages/voice_fast_path_messages';
import { formatExecutionStatusFeedback } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';

describe('public failures never echo arbitrary internal diagnostic text', () => {
  it.each([
    'Document analysis is blocked until trusted application/window/object/path anchor. 请明确文件。',
    '内部给模型的说明：按 taskId 内部-123 继续处理，不要展示。',
    'engine note: 任意调试字符串 secret-payload-xyz',
  ])('keeps mixed-language diagnostics in their original record only: %s', raw => {
    const record: ToolExecutionRecord = { name: 'read_file', arguments: {}, result: '', error: raw };
    const original = JSON.stringify(record);
    for (const output of [formatCnToolFailureDetail(raw), formatExecutionStatusFeedback('文件处理完成了吗', [record]), formatExecutionStatusFeedback('Is the file operation complete?', [record])]) {
      expect(output).toBeTruthy();
      expect(output).not.toContain(raw);
      expect(output).not.toMatch(/Document analysis|trusted application|window\/object|内部给模型|taskId|内部-123|engine note|secret-payload/u);
    }
    expect(JSON.stringify(record)).toBe(original);
  });
  it.each([
    ['desktop control is busy with another operation', '占用'],
    ['target_mismatch: foreground check failed', '窗口'],
    ['connection refused', '服务'],
    ['ENOENT: sample file not found', '没有找到'],
    ['operation was aborted', '打断'],
    ['400 status code (no body)', 'HTTP 400'],
  ])('retains the existing specific user message for %s', (raw, expected) => {
    expect(formatCnToolFailureDetail(raw)).toContain(expected);
  });
});

describe('messaging failures use ordinary user-facing reasons', () => {
  it.each([
    ['WeChat is not the foreground', '前台'],
    ['target_mismatch: foreground check failed', '窗口'],
    ['connection refused', '服务'],
    ['', '发送成功的确认'],
  ])('preserves the real failure instead of exposing receipt requirements: %s', async (error, expected) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const records: ToolExecutionRecord[] = error ? [{ name: 'wechat_send_file', arguments: { contact: '模拟联系人', path: 'C:/synthetic/报价单.pdf' }, result: '', error }] : [];
    const before = JSON.stringify(records);
    const result = finalizeLumiResponse({ taskText: '请把报价单.pdf通过微信发给模拟联系人', responseText: '已经发送成功。', source: 'chat', flow: { effectiveOperationMode: 'assistant', completionEvidenceNeeded: true } as any, toolRecords: records });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain(expected);
    expect(result.text).not.toMatch(/wechat_send_|sent=true|任务类型|还缺的证据|通道回执|继续文字或文件投递/u);
    expect(JSON.stringify(records)).toBe(before);
  });
});

it('does not present an earlier request failure as the current send failure', async () => {
  const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
  const old: ToolExecutionRecord = { name: 'wechat_send_file', arguments: { contact: '模拟联系人', path: 'C:/synthetic/报价单.pdf' }, result: '', error: 'connection refused', requestId: 'old-send', taskId: 'old-task' };
  const result = finalizeLumiResponse({ taskText: '请把报价单.pdf通过微信发给模拟联系人', responseText: '已经发送成功。', source: 'chat', requestId: 'current-send', taskId: 'current-task', flow: { effectiveOperationMode: 'assistant', completionEvidenceNeeded: true } as any, toolRecords: [old] });
  expect(result.blocked).toBe(true);
  expect(result.text).not.toContain('服务暂时不可用');
  expect(result.text).toContain('未返回具体失败原因');
});

it('explains a source-binding failure without inventing generated files or counting preparation as delivery', async () => {
  const { buildIterationLimitSummary } = await import('../server/llm/tool_loop/summaries');
  const records: ToolExecutionRecord[] = [
    { name: 'list_directory', arguments: {}, result: '[]', terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'bounded discovery returned' } },
    { name: 'search_files', arguments: {}, result: '[]', terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'bounded discovery returned' } },
    { name: 'read_file', arguments: {}, result: '', error: 'The current file reference is ambiguous or names an unbound produced file. Ask for its exact path; do not substitute the previous source.' },
  ];
  const text = buildIterationLimitSummary(records, '合并两份Word文件');
  expect(text).toContain('程序未能确认这次要读取的源文件');
  expect(text).toContain('文档正文尚未读取');
  expect(text).not.toMatch(/可能已生成|任务处理|文件系统访问|已验证|unbound|read_file|Ask for/u);
});
