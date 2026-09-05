import { describe, expect, it } from 'vitest';
import {
  classifyExecutionGuardIntent,
  finalizeExecutionForOutboundDelivery,
  recoverBlockedExecutionOnce,
  type ExecutionGuardRecoveryFinalization,
} from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';

const INTERNAL_GUARD = 'No successful current-turn tool execution was recorded for that execution-status claim.';
const INTERNAL_GUARD_COPY = /No successful current-turn tool execution|\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u771f\u5b9e\u5de5\u5177\u6267\u884c|\u6211\u9700\u8981\u5148\u771f\u6b63\u8c03\u7528\u5bf9\u5e94\u5de5\u5177/u;
const CUSTOMER_INTERNAL_EXECUTION_COPY = /(?:^|\n)\s*(?:\u72b6\u6001|\u8bc1\u636e|\u5177\u4f53\u963b\u585e|\u6267\u884c\u56de\u9988)\s*[:\uff1a]|\u56de\u6267|target_mismatch|terminalVerification|\b(?:taskId|requestId|desktop_open|client_action|desktop_execution_plan_receipt|verified|blocked|failed)\b/iu;

function expectNoGuardLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(INTERNAL_GUARD_COPY);
}

function expectNaturalCustomerStatus(value: string): void {
  expect(value).not.toMatch(CUSTOMER_INTERNAL_EXECUTION_COPY);
  expect(value).not.toMatch(INTERNAL_GUARD_COPY);
}

function receipt(patch: Partial<ToolExecutionRecord>): ToolExecutionRecord {
  return {
    name: 'client_action',
    arguments: {},
    result: '',
    ...patch,
  };
}

describe('execution guard user-feedback sequence', () => {
  it('separates conversation, status and action turns before any retry is allowed', () => {
    expect(classifyExecutionGuardIntent('\u4f60\u597d\uff0c\u4ecb\u7ecd\u4e00\u4e0b\u81ea\u5df1'))
      .toBe('conversation');
    expect(classifyExecutionGuardIntent('\u521a\u624d\u6253\u5f00\u5ba2\u6237\u7aef\u6210\u529f\u4e86\u5417\uff1f'))
      .toBe('status_query');
    expect(classifyExecutionGuardIntent('\u6253\u5f00\u5ba2\u6237\u7aef\u7684\u8bed\u97f3\u8bbe\u7f6e'))
      .toBe('action_execution');
  });

  it('turns a guard-blocked casual turn into one natural clarification without tools', async () => {
    let attempts = 0;
    const result = await finalizeExecutionForOutboundDelivery<ExecutionGuardRecoveryFinalization>({
      task: '\u4f60\u597d\uff0c\u4ecb\u7ecd\u4e00\u4e0b\u81ea\u5df1',
      responseText: INTERNAL_GUARD,
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [],
      attempt: async () => {
        attempts += 1;
        return { text: 'must not execute', toolRecords: [] };
      },
      finalize: text => ({ text, blocked: false }),
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({
      attempted: false,
      recoveryFailed: false,
      decision: { intent: 'conversation' },
      finalization: { blocked: false, reason: 'clarification_needed' },
    });
    expect(result.responseText).toContain('\u666e\u901a\u5bf9\u8bdd');
    expectNoGuardLeak(result);
  });

  it('preserves a model answer for an explicit conceptual evidence question without tools', async () => {
    let attempts = 0;
    const answer = '文件保存成功应以目标路径存在、内容与预期一致，并且写入工具返回可核验回执为依据。';
    const result = await finalizeExecutionForOutboundDelivery<ExecutionGuardRecoveryFinalization>({
      task: '“文件保存成功”应该依据什么证据判断？请只解释，不执行任何操作。',
      responseText: answer,
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [],
      attempt: async () => {
        attempts += 1;
        return { text: 'must not execute', toolRecords: [] };
      },
      finalize: text => ({ text, blocked: false }),
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({
      attempted: false,
      recoveryFailed: false,
      decision: { intent: 'conversation' },
      responseText: answer,
      finalization: { text: answer, blocked: false, reason: '' },
    });
    expect(result.responseText).not.toContain('确认你的意图');
    expectNoGuardLeak(result);
  });

  it('does not unlock a bare terminal action claim merely because the task is conceptual', async () => {
    const result = await finalizeExecutionForOutboundDelivery<ExecutionGuardRecoveryFinalization>({
      task: '“文件保存成功”怎么判断？只解释，不执行任何操作。',
      responseText: '文件已经保存成功。',
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [],
      attempt: async () => ({ text: 'must not execute', toolRecords: [] }),
      finalize: text => ({ text, blocked: false }),
    });

    expect(result.attempted).toBe(false);
    expect(result.finalization.blocked).toBe(false);
    expect(result.responseText).not.toContain('文件已经保存成功');
    expect(result.responseText).toContain('确认你的意图');
    expectNoGuardLeak(result);
  });

  it('answers a status query from verified receipts instead of replaying the action', async () => {
    let attempts = 0;
    const verified = receipt({
      name: 'client_get_state',
      result: JSON.stringify({ surface: 'voice-settings', visible: true }),
      terminalVerification: {
        status: 'verified',
        strategy: 'state_diff',
        reason: 'voice settings surface is visible',
      },
    });
    const result = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '\u521a\u624d\u6253\u5f00\u8bed\u97f3\u8bbe\u7f6e\u6210\u529f\u4e86\u5417\uff1f',
      responseText: INTERNAL_GUARD,
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [verified],
      attempt: async () => {
        attempts += 1;
        return { text: 'must not execute', toolRecords: [] };
      },
      finalize: text => ({ text, blocked: false }),
    });

    expect(attempts).toBe(0);
    expect(result.finalization).toMatchObject({ blocked: false, reason: 'task_status' });
    expect(result.responseText).toMatch(/(?:\u5df2|\u5df2\u7ecf)\u5b8c\u6210/u);
    expect(result.responseText).toMatch(/\u786e\u8ba4|\u6838\u5b9e/u);
    expectNaturalCustomerStatus(result.responseText);
    expectNoGuardLeak(result);
  });

  it('performs exactly one real action recovery and reports the verified terminal result', async () => {
    let attempts = 0;
    const terminal = receipt({
      id: 'verified-open',
      name: 'desktop_open',
      result: JSON.stringify({ target: 'Lumi', visible: true }),
      terminalVerification: {
        status: 'verified',
        strategy: 'state_diff',
        reason: 'Lumi window is visible',
      },
    });
    const result = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '\u6253\u5f00 Lumi \u5ba2\u6237\u7aef',
      responseText: '\u6211\u6b63\u5728\u6253\u5f00\u3002',
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [],
      attempt: async ({ recordTool }) => {
        attempts += 1;
        recordTool(terminal);
        return { text: '\u5ba2\u6237\u7aef\u5df2\u6253\u5f00\uff0c\u7a97\u53e3\u53ef\u89c1\u3002', toolRecords: [terminal] };
      },
      finalize: (text, records) => ({
        text,
        blocked: !records.some(record => record.terminalVerification?.status === 'verified'),
        reason: records.length ? 'verified_receipt' : INTERNAL_GUARD,
      }),
    });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      attempted: true,
      recoveryFailed: false,
      decision: { intent: 'action_execution' },
      responseText: '\u5ba2\u6237\u7aef\u5df2\u6253\u5f00\uff0c\u7a97\u53e3\u53ef\u89c1\u3002',
    });
    expect(result.toolRecords.map(record => record.id)).toEqual(['verified-open']);
    expectNoGuardLeak(result.finalization);
  });

  it('reports a concrete failed state after the one bounded retry fails', async () => {
    let attempts = 0;
    const failed = receipt({
      id: 'failed-open',
      name: 'desktop_open',
      error: 'target window was not found',
      terminalVerification: {
        status: 'failed',
        strategy: 'state_diff',
        reason: 'target window was not found',
      },
    });
    const result = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '\u6253\u5f00 Lumi \u5ba2\u6237\u7aef',
      responseText: '\u6211\u6b63\u5728\u6253\u5f00\u3002',
      finalization: { text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD },
      allowToolUse: true,
      toolRecords: [],
      attempt: async ({ recordTool }) => {
        attempts += 1;
        recordTool(failed);
        return { text: '\u6253\u5f00\u5931\u8d25\u3002', toolRecords: [failed] };
      },
      finalize: () => ({ text: INTERNAL_GUARD, blocked: true, reason: INTERNAL_GUARD }),
    });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({ attempted: true, recoveryFailed: true });
    expect(result.responseText).toMatch(/\u6ca1\u6709\u5b8c\u6210|\u6ca1\u80fd\u5b8c\u6210|\u5931\u8d25/u);
    expect(result.responseText).toMatch(/\u6ca1\u6709\u627e\u5230.*(?:\u5e94\u7528|\u6587\u4ef6|\u7f51\u5740)/u);
    expect(result.responseText).toMatch(/\u91cd\u8bd5|\u7ee7\u7eed/u);
    expectNaturalCustomerStatus(result.responseText);
    expectNoGuardLeak(result.finalization);
  });

  it('uses one outbound boundary to sanitize text, reason and notification after recovery', async () => {
    let attempts = 0;
    const result = await finalizeExecutionForOutboundDelivery({
      task: '\u6253\u5f00 Lumi \u5ba2\u6237\u7aef',
      responseText: INTERNAL_GUARD,
      finalization: {
        text: INTERNAL_GUARD,
        blocked: true,
        reason: INTERNAL_GUARD,
        notification: { message: INTERNAL_GUARD },
      },
      allowToolUse: true,
      toolRecords: [],
      attempt: async () => {
        attempts += 1;
        return { text: INTERNAL_GUARD, toolRecords: [] };
      },
      finalize: () => ({
        text: INTERNAL_GUARD,
        blocked: true,
        reason: INTERNAL_GUARD,
        notification: { message: INTERNAL_GUARD },
      }),
    });

    expect(attempts).toBe(1);
    expect(result.finalization).toMatchObject({
      blocked: true,
      reason: 'execution_recovery_incomplete',
      notification: undefined,
    });
    expect(result.responseText).toMatch(/\u6ca1\u6709\u5b8c\u6210|\u6ca1\u80fd\u5b8c\u6210|\u8fd8\u6ca1\u5b8c\u6210/u);
    expect(result.responseText).toMatch(/\u6ca1\u6709\u62ff\u5230|\u65e0\u6cd5\u786e\u8ba4|\u4e0d\u80fd\u786e\u8ba4/u);
    expect(result.responseText).toMatch(/\u91cd\u8bd5|\u7ee7\u7eed/u);
    expectNaturalCustomerStatus(result.responseText);
    expectNoGuardLeak(result);
  });
});
