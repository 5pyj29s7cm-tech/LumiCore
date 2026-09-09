import './helpers';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { verifyCapabilityReceipt } from '../server/tools/capability_verification';
import { toolRecordSucceeded, recordsToTaskReceipts, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';

describe('workflow progress is a successful phase, not task completion', () => {
  const registry = new ToolRegistry(); registerWorkflowTools(registry);
  const identity = { taskId: 'workflow-task', requestId: 'workflow-request' };
  function makeRecord(name: string, payload: Record<string, unknown>): ToolExecutionRecord {
    const entry = registry.getCapabilityManifestEntry(name)!;
    const record: ToolExecutionRecord = { ...identity, name, arguments: {}, result: JSON.stringify(payload), capability: {
      capabilityId: entry.capabilityId, lane: entry.lane, operation: entry.operation, risk: entry.risk,
      sideEffects: entry.sideEffects, verification: entry.verification,
    } };
    record.terminalVerification = verifyCapabilityReceipt(entry, record);
    return record;
  }
  const task = '运行已经发布的工作流并计算新订单';
  const started = { ok: true, status: 'started', runStatus: 'running', runId: 'run-one', workflowId: 'flow-one', revision: 1, name: 'orders', completed: false, completedSteps: 0, totalSteps: 2, steps: [] };
  it('accepts the declared start receipt and preserves noncompletion', () => {
    const record = makeRecord('run_workflow', started);
    expect(record.terminalVerification?.status).toBe('verified');
    expect(toolRecordSucceeded(record)).toBe(true);
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts([record]), null, identity).complete).toBe(false);
    expect(finalizeLumiResponse({ ...identity, taskText: task, responseText: '已完成', source: 'chat', toolRecords: [record] })).toMatchObject({ blocked: false, reason: 'workflow_running' });
    expect(makeRecord('run_workflow', { ...started, ok: false }).terminalVerification?.status).toBe('failed');
    expect(makeRecord('run_workflow', { ...started, status: 'completed' }).terminalVerification?.status).toBe('failed');
  });
  it('delivers the exact step confirmation across shared channels instead of a failure', () => {
    const record = makeRecord('get_workflow_run', { ...started, status: 'waiting_confirmation', revision: 2,
      confirmation: { confirmationId: 'approval-one', capabilityId: 'read_file', argumentPreview: { path: 'C:/orders.csv' } } });
    for (const source of ['chat', 'voice', 'task', 'workflow']) {
      const result = finalizeLumiResponse({ ...identity, taskText: task, responseText: '没能开始', source, toolRecords: [record] });
      expect(result).toMatchObject({ blocked: false, reason: 'waiting_confirmation' });
      expect(result.text).toContain('approval-one');
      expect(result.text).toContain('C:/orders.csv');
    }
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts([record]), null, identity).complete).toBe(false);
  });
  it('reports an observed blocked workflow as incomplete despite a successful status query', () => {
    const { completed: _completed, ...observed } = started;
    const record = makeRecord('get_workflow_run', { ...observed, status: 'blocked', completedSteps: 1, reconciliationRequired: true });
    expect(record.terminalVerification?.status).toBe('verified');
    const final = finalizeLumiResponse({ ...identity, taskText: task, responseText: '任务已完成', source: 'chat', toolRecords: [record] });
    expect(final).toMatchObject({ blocked: true, reason: 'workflow_incomplete' });
    expect(final.text).toContain('1/2');
    expect(buildForegroundTaskCompletionFeedback({ taskId: identity.taskId, taskLabel: task, toolRecords: [record], blocked: final.blocked })?.status).not.toBe('completed');
    expect(buildForegroundTaskCompletionFeedback({ taskId: identity.taskId, taskLabel: task, toolRecords: [makeRecord('run_workflow', started)], status: 'executing' })?.status).toBe('working');
  });
  it('shows verified computation data instead of suppressing the whole workflow ledger', () => {
    const record = makeRecord('get_workflow_run', { ...started, status: 'completed', completed: true, completedSteps: 2,
      outputs: [{ status: 'verified', result: { status: 'completed', data: { items: [{ label: 'fresh', amount: 17 }], total: 17 } } }] });
    const result = finalizeLumiResponse({ ...identity, taskText: task, responseText: '已获取执行结果', source: 'chat', toolRecords: [record] });
    expect(result).toMatchObject({ blocked: false, reason: 'workflow_completed' });
    expect(result.text).toContain('total: 17');
    expect(result.text).toContain('| fresh | 17 |');
    expect(result.text).not.toContain('workflowId');
  });
});
