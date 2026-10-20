import { expect, it } from 'vitest';
import { withoutUnsupportedOngoingExecutionTail } from '../server/cognition/result_claim_guards';
import type { LumiResultFinalizerInput } from '../server/cognition/result_finalizer_types';
import type { ToolExecutionRecord } from '../server/tools/types';

const input = (responseText: string): LumiResultFinalizerInput => ({
  taskText: 'Create a local text file with the exact contents "verified artifact body".',
  responseText, source: 'chat', requestId: 'tail-current-request', taskId: 'tail-current-task', toolRecords: [],
});

it('corrects only the unsupported terminal status tail and retains meaningful model analysis byte for byte', () => {
  const analysis = 'The file was created and verified.\nAnalysis: both supplied records agree.';
  const result = withoutUnsupportedOngoingExecutionTail(input(analysis+'\n正在执行——'), []);
  expect(result).toBe(analysis+'\n');
  expect(result).toContain(analysis); expect(result).not.toContain('正在执行——');
});

it('preserves an explicitly requested standalone ongoing phrase in its literal protected span', () => {
  const literal = '正在执行——', response = 'Verified file content:\n'+literal;
  const result = withoutUnsupportedOngoingExecutionTail({ ...input(response),
    taskText: 'Create a file with the exact text "'+literal+'".' }, [literal]);
  expect(result).toBe(response); expect(result).toContain('Verified file content:\n'+literal);
});

it('preserves an original source protected span including the same terminal status sentence and trailing newline', () => {
  const sourceBody = 'ORIGINAL_SOURCE.\n正在执行——\n', response = 'Original source:\n'+sourceBody;
  const result = withoutUnsupportedOngoingExecutionTail(input(response), [sourceBody]);
  expect(result).toBe(response); expect(result).toContain(sourceBody);
});

it('retains the status suffix when the existing same-scope runtime snapshot reports an active background run', () => {
  // Existing accepted runtime_work_status unit-receipt shape; no canonical
  // mutation record, live job, filesystem permission or confirmation is forged.
  const response = 'Artifact verified.\n正在执行——';
  const state = input(response);
  const active: ToolExecutionRecord = { name: 'runtime_work_status', arguments: {}, requestId: state.requestId, taskId: state.taskId,
    result: JSON.stringify({ ok: true, status: 'active', activeCount: 2, items: [{ id: 'task-a' }, { id: 'task-b' }] }),
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'server-owned runtime snapshot' } };
  const result = withoutUnsupportedOngoingExecutionTail({ ...state,
    taskText: '后台工作现在怎么样？请核对哪些仍可撤回。', toolRecords: [active] }, []);
  expect(result).toBe(response);
});
