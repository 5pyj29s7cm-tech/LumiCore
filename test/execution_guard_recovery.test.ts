import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildExecutionGuardRecoveryInstruction,
  decideExecutionGuardRecovery,
  formatExecutionRecoveryFailure,
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
  summarizePriorToolReceipts,
} from '../server/cognition/execution_guard_recovery';
import type { ExecutionGuardRecoveryFinalization } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';

function record(patch: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'test_tool',
    arguments: {},
    result: '',
    ...patch,
  };
}

describe('execution guard recovery', () => {
  it('turns a missing current-turn receipt into an internal retry decision', () => {
    const decision = decideExecutionGuardRecovery({
      blocked: true,
      allowToolUse: true,
      reason: 'No successful current-turn tool execution was recorded for that execution-status claim.',
      toolRecords: [],
    });
    expect(decision).toMatchObject({ recoverable: true, code: 'missing_tool_execution' });
    expect(decideExecutionGuardRecovery({
      blocked: true,
      allowToolUse: true,
      reason: '这一轮没有成功执行任何工具',
      toolRecords: [],
    })).toMatchObject({ recoverable: true, code: 'missing_tool_execution' });
    const instruction = buildExecutionGuardRecoveryInstruction('检查并修复语音设置', decision);
    expect(instruction).toContain('Use a currently declared real tool');
    expect(instruction).toContain('Do not quote');
  });

  it('keeps a bounded redacted receipt ledger in the recovery instruction', () => {
    const records = Array.from({ length: 45 }, (_, index) => record({
      id: `receipt-${index}`,
      name: `tool_${index}`,
      arguments: { apiKey: `must-not-leak-${index}` },
      result: index === 44 ? 'authorization=Bearer-secret-token completed' : `result ${index}`,
      terminalVerification: index % 2 === 0 && index !== 44
        ? { status: 'verified', strategy: 'terminal_receipt', reason: 'terminal receipt' }
        : undefined,
    }));
    const summary = summarizePriorToolReceipts(records);
    expect(summary).toContain('5 older receipt(s) omitted');
    expect(summary).toContain('tool_44');
    expect(summary).toContain('[redacted]');
    expect(summary).not.toContain('must-not-leak');
    expect(summary).not.toContain('Bearer-secret-token');

    const longTask = `${'约束'.repeat(1_500)}保留这个末尾约束`;
    const instruction = buildExecutionGuardRecoveryInstruction(
      longTask,
      { recoverable: true, code: 'missing_tool_execution', reason: 'retry_real_tool_route' },
      records,
    );
    expect(instruction).toContain('保留这个末尾约束');
    expect(instruction).toContain('Prior immutable tool receipts');
  });

  it('does not automatically replay confirmation blocks or uncertain external commits', () => {
    expect(decideExecutionGuardRecovery({
      blocked: true,
      allowToolUse: true,
      reason: 'No successful tool execution was recorded.',
      pendingConfirmation: true,
    })).toMatchObject({ recoverable: false, reason: 'waiting_for_user_confirmation' });

    expect(decideExecutionGuardRecovery({
      blocked: true,
      allowToolUse: true,
      reason: 'Missing action evidence.',
      toolRecords: [record({
        name: 'send_message',
        error: 'timeout; outcome unknown',
        capability: {
          sideEffects: [{ type: 'external_communication', scope: 'message', reversible: false }],
        } as any,
      })],
    })).toMatchObject({ recoverable: false, reason: 'uncertain_external_commit_requires_reconciliation' });

    expect(decideExecutionGuardRecovery({
      blocked: true,
      allowToolUse: true,
      reason: 'Missing action evidence.',
      toolRecords: [record({
        name: 'send_message',
        result: 'provider returned no durable acknowledgement',
        terminalVerification: {
          status: 'unverified',
          strategy: 'provider_ack',
          reason: 'acknowledgement did not identify the committed message',
        },
        capability: {
          sideEffects: [{ type: 'external_communication', scope: 'message', reversible: false }],
        } as any,
      })],
    })).toMatchObject({ recoverable: false, reason: 'uncertain_external_commit_requires_reconciliation' });
  });

  it('formats a concrete user-facing blocker without leaking the internal guard or secrets', () => {
    const text = formatExecutionRecoveryFailure('检查并修复客户端', [record({
      name: 'client_action',
      error: 'authorization=Bearer-secret-token connection refused',
    })]);
    expect(text).toContain('这项任务还没有执行成功');
    expect(text).toContain('client_action');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('No successful current-turn tool execution');
    expect(text).not.toContain('我需要先真正调用');
    expect(text).not.toContain('Bearer-secret-token');
  });

  it('runs one internal attempt with immutable prior receipts and merges only new evidence', async () => {
    const prior = record({ id: 'prior-1', name: 'inspect_state', result: 'old receipt' });
    const newReceipt = record({ id: 'new-1', name: 'repair_state', result: 'verified' });
    let attempts = 0;
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '检查并修复客户端',
      responseText: '我马上检查。',
      finalization: {
        text: '没有执行证据。',
        blocked: true,
        reason: 'No successful current-turn tool execution was recorded.',
      },
      allowToolUse: true,
      toolRecords: [prior],
      attempt: async ({ instruction, priorToolRecords, recordTool }) => {
        attempts++;
        expect(instruction).toContain('Do not quote');
        expect(instruction).toContain('inspect_state');
        expect(priorToolRecords).toEqual([prior]);
        priorToolRecords.push(record({ id: 'local-only' }));
        recordTool(newReceipt);
        return {
          text: '修复完成。',
          toolRecords: [prior, newReceipt],
        };
      },
      finalize: (text, records) => ({
        text,
        blocked: !records.some(item => item.id === 'new-1'),
        reason: undefined as string | undefined,
      }),
    });

    expect(attempts).toBe(1);
    expect(recovered).toMatchObject({
      attempted: true,
      recoveryFailed: false,
      responseText: '修复完成。',
    });
    expect(recovered.toolRecords.map(item => item.id)).toEqual(['prior-1', 'new-1']);
  });

  it('never attempts recovery across confirmation, cancellation, or uncertain external commits', async () => {
    let attempts = 0;
    const attempt = async () => {
      attempts++;
      return { text: 'should not run', toolRecords: [] };
    };
    const blocked = {
      text: 'blocked',
      blocked: true,
      reason: 'Missing action evidence.',
    };
    const finalize = () => blocked;

    for (const input of [
      { pendingConfirmation: true, aborted: false, toolRecords: [] },
      { pendingConfirmation: false, aborted: true, toolRecords: [] },
      {
        pendingConfirmation: false,
        aborted: false,
        toolRecords: [record({
          name: 'send_message',
          error: 'timeout; outcome unknown',
          capability: {
            sideEffects: [{ type: 'external_communication', scope: 'message', reversible: false }],
          } as any,
        })],
      },
    ]) {
      const result = await recoverBlockedExecutionOnce({
        task: 'send it',
        responseText: blocked.text,
        finalization: blocked,
        allowToolUse: true,
        attempt,
        finalize,
        ...input,
      });
      expect(result.attempted).toBe(false);
    }
    expect(attempts).toBe(0);
  });

  it('scrubs guard diagnostics even when policy does not allow an internal retry', async () => {
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '检查客户端',
      responseText: '正在检查',
      finalization: {
        text: '当前无法继续执行。',
        blocked: true,
        reason: 'No successful current-turn tool execution was recorded.',
        notification: {
          type: 'work_product_guard',
          message: 'No successful current-turn tool execution was recorded.',
        },
      },
      allowToolUse: false,
      toolRecords: [],
      attempt: async () => {
        throw new Error('must not run');
      },
      finalize: text => ({ text, blocked: true }),
    });

    expect(recovered.attempted).toBe(false);
    expect(recovered.finalization).toMatchObject({
      text: '当前无法继续执行。',
      reason: 'execution_capability_unavailable',
      notification: undefined,
    });
    expect(JSON.stringify(recovered.finalization)).not.toContain('No successful current-turn');
  });

  it('sanitizes every terminal delivery boundary, including non-retry finalizer details', () => {
    const publicFailure = sanitizeExecutionResponseForDelivery({
      text: 'The write ran, but verification is incomplete.',
      finalized: true,
      blocked: true,
      reason: 'Requested post-write readback is missing or failed.',
      notification: { message: 'Missing verified action evidence.' },
    }, { task: 'write the file' });
    expect(publicFailure).toMatchObject({
      reason: 'execution_recovery_incomplete',
      notification: undefined,
    });
    expect(JSON.stringify(publicFailure)).not.toMatch(/Requested post-write|Missing verified/i);

    const successful = sanitizeExecutionResponseForDelivery({
      text: 'The requested result is ready.',
      finalized: true,
      blocked: false,
      reason: 'Grounded artifact completion from current-turn receipts.',
    });
    expect(successful.reason).toBe('');
  });

  it('returns only a human-readable blocker when the single recovery remains blocked', async () => {
    let attempts = 0;
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '检查并修复客户端',
      responseText: '<tool_calls>internal protocol</tool_calls>',
      finalization: {
        text: '内部协议已拦截。',
        blocked: true,
        reason: 'Legacy tool-call protocol leaked into assistant text.',
        notification: {
          type: 'work_product_guard',
          message: 'No successful current-turn tool execution was recorded.',
        },
      },
      allowToolUse: true,
      toolRecords: [],
      attempt: async () => {
        attempts++;
        return {
          text: 'Internal execution recovery. api_key=very-secret',
          toolRecords: [record({
            name: 'client_action',
            error: 'api_key=very-secret connection refused',
          })],
        };
      },
      finalize: text => ({
        text,
        blocked: true,
        reason: 'Missing action evidence.',
      }),
    });

    expect(attempts).toBe(1);
    expect(recovered.recoveryFailed).toBe(true);
    expect(recovered.responseText).toContain('这项任务还没有执行成功');
    expect(recovered.responseText).toContain('client_action');
    expect(recovered.responseText).not.toContain('Internal execution recovery');
    expect(recovered.responseText).not.toContain('very-secret');
    expect(recovered.finalization.reason).toBe('execution_recovery_incomplete');
    expect(recovered.finalization.notification).toBeUndefined();
    expect(JSON.stringify(recovered.finalization)).not.toContain('No successful current-turn');
  });

  it('retains terminal receipts when the recovery provider fails after a tool call', async () => {
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: 'repair the client',
      responseText: 'I will repair it.',
      finalization: {
        text: 'No execution started.',
        blocked: true,
        reason: 'No tool execution started.',
        notification: {
          type: 'work_product_guard',
          message: 'No successful current-turn tool execution was recorded.',
        },
      },
      allowToolUse: true,
      toolRecords: [],
      attempt: async ({ recordTool }) => {
        recordTool(record({
          id: 'terminal-before-provider-failure',
          name: 'client_action',
          error: 'terminal verification failed',
        }));
        throw new Error('provider disconnected');
      },
      finalize: text => ({ text, blocked: true, reason: undefined as string | undefined }),
    });

    expect(recovered.recoveryFailed).toBe(true);
    expect(recovered.toolRecords.map(item => item.id)).toEqual([
      'terminal-before-provider-failure',
    ]);
    expect(recovered.responseText).toContain('client_action');
    expect(recovered.responseText).not.toContain('provider disconnected');
    expect(recovered.finalization).toMatchObject({
      reason: 'execution_recovery_incomplete',
      notification: undefined,
    });
    expect(JSON.stringify(recovered.finalization)).not.toContain('No successful current-turn');
  });

  it('preserves a confirmation request created during recovery even if the provider then fails', async () => {
    let waitingForConfirmation = false;
    const recovered = await recoverBlockedExecutionOnce({
      task: 'send the message',
      responseText: 'I will send it.',
      finalization: {
        text: 'No tool execution started.',
        blocked: true,
        reason: 'No tool execution started.',
      },
      allowToolUse: true,
      toolRecords: [],
      isPendingConfirmation: () => waitingForConfirmation,
      attempt: async () => {
        waitingForConfirmation = true;
        throw new Error('provider failed after requesting confirmation');
      },
      finalize: () => waitingForConfirmation
        ? { text: 'Please confirm the exact action.', blocked: false, reason: 'waiting_confirmation' }
        : { text: 'blocked', blocked: true, reason: 'missing_evidence' },
    });

    expect(recovered).toMatchObject({
      attempted: true,
      recoveryFailed: false,
      responseText: 'Please confirm the exact action.',
      finalization: { blocked: false, reason: 'waiting_confirmation' },
    });
  });

  it('propagates cancellation instead of turning it into a recovery blocker', async () => {
    let aborted = false;
    await expect(recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: 'repair the client',
      responseText: 'Working on it.',
      finalization: {
        text: 'No execution started.',
        blocked: true,
        reason: 'No tool execution started.',
      },
      allowToolUse: true,
      toolRecords: [],
      isAborted: () => aborted,
      attempt: async () => {
        aborted = true;
        return { text: 'late response', toolRecords: [] };
      },
      finalize: text => ({ text, blocked: true }),
    })).rejects.toMatchObject({ name: 'AbortError', message: 'Request cancelled' });
  });

  it('wires the shared one-shot recovery into chat, task and voice terminal paths', () => {
    const root = process.cwd();
    const chatSource = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const taskSource = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');
    const voiceSource = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');

    for (const source of [chatSource, taskSource, voiceSource]) {
      expect(source).toContain('await recoverBlockedExecutionOnce({');
      expect(source).toContain('pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn)');
      expect(source).toContain('priorToolRecords,');
    }
    expect(chatSource).toContain('...normalTurnMessages');
    expect(chatSource).toContain('normalTurnMessages = messages;');
    expect(chatSource).toContain('recordTool(record);');
    expect(chatSource).toContain('...toolSecurityContext,');
    expect(chatSource).toContain('executionBoundary');
    expect(chatSource).not.toContain('const guardRecovery = decideExecutionGuardRecovery');
    expect(taskSource).toContain("source: 'task_guard_recovery'");
    expect(taskSource).toContain('normalizeTaskHistory(recentMsgs)');
    expect(voiceSource).toContain("source: 'voice_guard_recovery'");
    expect(voiceSource).toContain('isAborted: () => !isCurrentTurn()');
  });
});
