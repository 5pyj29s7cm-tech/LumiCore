import { describe, expect, it } from 'vitest';
import { missingTaskInputResult, MISSING_TASK_INPUT_REASON } from '../server/cognition/missing_task_input';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { decideExecutionGuardRecovery } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';

const task = '把 D:/orders.xlsx 的水杯数量改成4，保留原文件和公式，另存为 D:/result.xlsx，保存后回读金额。';
function missing(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { name: 'read_xlsx', arguments: { filePath: 'D:/orders.xlsx' }, result: '', adapterStarted: true,
    taskId: 'task', requestId: 'turn', error: 'XLSX file not found: D:/orders.xlsx', ...overrides };
}
describe('required source failure boundary', () => {
  it('returns the actual missing path before generic progress guards and suppresses recovery', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: '正在重试', toolRecords: [missing()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('D:/orders.xlsx');
    expect(result.text).not.toContain('执行失败');
    expect(decideExecutionGuardRecovery({ ...result, allowToolUse: true, toolRecords: [missing()], task }).recoverable).toBe(false);
  });
  it.each([
    missing({ error: 'Permission denied: D:/orders.xlsx' }),
    missing({ error: 'XLSX file not found: D:/dependency.xlsx' }),
    missing({ arguments: { filePath: 'D:/optional.xlsx' }, error: 'XLSX file not found: D:/optional.xlsx' }),
    missing({ arguments: { filePath: 'D:/result.xlsx' }, error: 'XLSX file not found: D:/result.xlsx' }),
    missing({ name: 'search_files' }),
    missing({ adapterStarted: false }),
    missing({ error: undefined, result: 'XLSX file not found: D:/orders.xlsx' }),
  ])('does not confuse other failures, outputs, or file contents with required missing input', record => {
    expect(missingTaskInputResult(task, [record])).toBeNull();
  });
  it('does not block creation of a new output', () => {
    expect(missingTaskInputResult('Create D:/orders.xlsx with a price column.', [missing()])).toBeNull();
  });
  it('allows a later verified read and ignores a previous-turn missing receipt', () => {
    expect(missingTaskInputResult(task, [missing(), missing({ error: undefined, result: 'verified contents' })])).toBeNull();
    const result = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: '', toolRecords: [missing()], taskId: 'task', requestId: 'next-turn' });
    expect(result.reason).not.toBe(MISSING_TASK_INPUT_REASON);
  });
});
