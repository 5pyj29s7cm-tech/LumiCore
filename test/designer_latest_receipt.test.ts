import './helpers';
import { expect, it } from 'vitest';
import { designerRequest, verifiedDesignerReceipt } from '../server/cognition/designer_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';

const cases = [
  { task: '查询当前设计项目状态', tool: 'interior_design_project_status', kind: 'status' },
  { task: '执行当前设计项目的提案 PPT 阶段。', tool: 'industry_workflow_complete', kind: 'stage' },
];
function receipt(test: typeof cases[number], status: 'verified' | 'failed' | 'unverified', requestId = 'current-request'): ToolExecutionRecord {
  const payload = test.kind === 'status'
    ? { ok: true, persisted: true, project: { id: 'fixture-project', name: 'Fixture project' }, workflow: { stages: {}, nextStage: 'presentation' } }
    : { ok: true, persisted: true, status: 'verified', verification: { passed: true }, task: { id: 'fixture-workflow',
      metadata: { industryWorkflow: { productLine: 'design', entryId: 'presentation', requestId, conversationTaskId: 'current-task' } } } };
  return { name: test.tool, arguments: { projectId: 'fixture-project' }, requestId, taskId: 'current-task',
    result: JSON.stringify(status === 'verified' ? payload : { ok: false, status, persisted: false }),
    terminalVerification: { status, strategy: 'measured', reason: 'Isolated host-shaped receipt fixture' } } as ToolExecutionRecord;
}
for (const test of cases) {
  it.each(['failed', 'unverified'] as const)(`does not revive an earlier ${test.kind} success after a current %s receipt`, status => {
    const records = [receipt(test, 'verified'), receipt(test, status)];
    const request = designerRequest(test.task)!;
    expect(request).not.toBeNull();
    expect(verifiedDesignerReceipt(records, request, { requestId: 'current-request', taskId: 'current-task' })).toBeNull();
    expect(finalizeLumiResponse({ taskText: test.task, source: 'chat', responseText: 'The operation is complete.',
      requestId: 'current-request', taskId: 'current-task', toolRecords: records }).blocked).toBe(true);
  });
  it(`accepts the latest current ${test.kind} success after an earlier failure`, () => {
    expect(finalizeLumiResponse({ taskText: test.task, source: 'chat', responseText: '',
      requestId: 'current-request', taskId: 'current-task',
      toolRecords: [receipt(test, 'failed'), receipt(test, 'verified')] }).blocked).toBe(false);
  });
  it(`does not replace current ${test.kind} success with another request's late failure`, () => {
    expect(finalizeLumiResponse({ taskText: test.task, source: 'chat', responseText: '',
      requestId: 'current-request', taskId: 'current-task',
      toolRecords: [receipt(test, 'verified'), receipt(test, 'failed', 'other-request')] }).blocked).toBe(false);
  });
}

