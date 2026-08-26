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

function expectNoGuardLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(INTERNAL_GUARD_COPY);
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
    const result = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
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
    expect(result.responseText).toContain('\u72b6\u6001\uff1a\u5df2\u5b8c\u6210');
    expect(result.responseText).toContain('\u8bc1\u636e\uff1a\u5ba2\u6237\u7aef\u64cd\u4f5c');
    expect(result.responseText).toContain('\u5df2\u9a8c\u8bc1');
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
    expect(result.responseText).toContain('\u72b6\u6001\uff1a\u5931\u8d25');
    expect(result.responseText).toContain('\u8bc1\u636e\uff1a\u684c\u9762\u64cd\u4f5c');
    expect(result.responseText).toContain('target window was not found');
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
    expect(result.responseText).toContain('\u72b6\u6001\uff1a\u53d7\u963b');
    expectNoGuardLeak(result);
  });
});
