import './helpers';
import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import type { ToolExecutionRecord } from '../server/tools/types';

describe('pending-input prose cannot promote a failed current execution', () => {
  const scope = { requestId: 'deferred-current', taskId: 'deferred-task' };
  const task = 'Create D:/fixtures/output.txt.';
  const response = 'Please provide the missing input before continuing.';
  const record = (status: string, requestId = scope.requestId): ToolExecutionRecord => ({
    ...scope, requestId, name: 'write_file', arguments: { path: 'D:/fixtures/output.txt', content: 'draft' },
    result: JSON.stringify({ ok: false, status, error: 'Synthetic incomplete creation' }),
    terminalVerification: { status: 'unverified', strategy: 'terminal_receipt', reason: 'Incomplete fixture.' },
    capability: { capabilityId: 'fixture.create', lane: 'files', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'fixture', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [] } },
  });
  it.each(['partial', 'failed', 'unknown_outcome'])('keeps %s incomplete despite deferred wording', status => {
    expect(guardCompletionClaims({ ...scope, task, response, toolCalls: [record(status)] }).blocked).toBe(true);
  });
  it('does not borrow another request failure to alter a pending-input explanation', () => {
    expect(guardCompletionClaims({ ...scope, task, response, toolCalls: [record('partial', 'old-request')] })).toMatchObject({ text: response, blocked: false });
  });
  it('retains a pending-input explanation when no tool ran', () => {
    expect(guardCompletionClaims({ ...scope, task, response, toolCalls: [] })).toMatchObject({ text: response, blocked: false });
  });
  it('does not turn an optional failed observation into a required physical action', () => {
    const observation = { ...record('partial'), name: 'web_search', capability: undefined };
    expect(guardCompletionClaims({ ...scope, task: 'Explain the supplied paragraph in chat.', response,
      toolCalls: [observation] })).toMatchObject({ text: response, blocked: false });
  });
});
