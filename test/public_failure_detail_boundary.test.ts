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
