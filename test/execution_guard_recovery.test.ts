import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildExecutionGuardRecoveryInstruction,
  classifyExecutionGuardIntent,
  decideExecutionGuardRecovery,
  formatExecutionRecoveryFailure,
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
  summarizePriorToolReceipts,
} from '../server/cognition/execution_guard_recovery';
import type { ExecutionGuardRecoveryFinalization } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';
import { sanitizeToolRecordsForPersistence } from '../server/cognition/user_output_protection';
import {
  clearAllPendingConfirmationsForTests,
  formatPendingConfirmationRequest,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

function record(patch: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    name: 'test_tool',
    arguments: {},
    result: '',
    ...patch,
  };
}

describe('execution guard recovery', () => {
  it('keeps conceptual evidence questions in conversation while preserving real task-status queries', () => {
    expect(classifyExecutionGuardIntent('“文件保存成功”应该依据什么证据判断？请只解释，不执行任何操作。'))
      .toBe('conversation');
    expect(classifyExecutionGuardIntent('什么是任务完成证据？只解释概念。'))
      .toBe('conversation');
    expect(classifyExecutionGuardIntent('What evidence should count as a successful file save? Explain only; do not execute anything.'))
      .toBe('conversation');

    expect(classifyExecutionGuardIntent('刚才任务的结果是什么？')).toBe('status_query');
    expect(classifyExecutionGuardIntent('当前任务进度怎么样了？')).toBe('status_query');
    expect(classifyExecutionGuardIntent('刚才那次执行有什么证据？')).toBe('status_query');
  });

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
    expect(text).toContain('客户端操作');
    expect(text).not.toContain('client_action');
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
      reason: 'execution_capability_unavailable',
      notification: undefined,
    });
    expect(recovered.finalization.text).toContain('状态：受阻');
    expect(recovered.finalization.text).toContain('证据：');
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

    const secretNotification = sanitizeExecutionResponseForDelivery({
      text: 'Operation failed: password=hunter2',
      finalized: true,
      blocked: false,
      notification: {
        type: 'warning',
        message: 'password=hunter2; internal=/srv/private/config.json',
        details: { apiToken: 'top-secret', stack: 'at /srv/private/worker.js:12' },
      },
    });
    expect(JSON.stringify(secretNotification)).not.toContain('hunter2');
    expect(JSON.stringify(secretNotification)).not.toContain('top-secret');
    expect(JSON.stringify(secretNotification)).not.toContain('/srv/private');
    expect(secretNotification.notification).toMatchObject({
      type: 'warning',
      details: { apiToken: '[redacted]', stack: '[internal detail omitted]' },
    });
  });

  it('applies one readable layout at the final delivery boundary for model and deterministic replies', () => {
    const concept = sanitizeExecutionResponseForDelivery({
      text: '需要三类证据：- **视觉证据**：看见结果。- **系统证据**：读取状态。',
      finalized: true,
      blocked: false,
    }, { task: '只解释判断成功需要哪些证据，不要执行工具。' });
    expect(concept.text).toBe('需要三类证据：\n\n- **视觉证据**：看见结果。\n- **系统证据**：读取状态。');

    const fields = sanitizeExecutionResponseForDelivery({
      text: 'D:\\lumiOS\\package.json  lumi-core  3.1.0',
      finalized: true,
      blocked: false,
    }, { task: '把路径、name 和 version 分三行告诉我，不要重新读取。' });
    expect(fields.text).toBe('D:\\lumiOS\\package.json\nlumi-core\n3.1.0');
  });

  it('routes every socket notification event through the shared sanitizer', () => {
    for (const file of ['chat.ts', 'task.ts', 'voice.ts']) {
      const source = readFileSync(path.resolve('server/socket', file), 'utf8');
      expect(source).toContain("event === 'agent:notification'");
      expect(source).toContain('sanitizeExecutionNotificationForDelivery');
    }
  });

  it('never exposes the production completion-guard interruption as assistant prose', () => {
    const delivery = sanitizeExecutionResponseForDelivery({
      text: [
        '我还不能说正在执行：No successful current-turn tool execution was recorded for that execution-status claim.',
        '这一轮没有记录到成功的真实工具执行。',
        '我需要先真正调用对应工具，再按当前轮回执汇报进度。',
      ].join('\n'),
      finalized: true,
      blocked: false,
      reason: 'chat',
    }, { task: '打开浏览器' });

    expect(delivery.blocked).toBe(true);
    expect(delivery.reason).toBe('execution_recovery_incomplete');
    expect(delivery.text).toContain('还没有执行成功');
    expect(JSON.stringify(delivery)).not.toMatch(/No successful current-turn|我还不能说正在执行|真实工具执行|先真正调用对应工具/iu);
  });

  it('summarizes screenshot payloads without forwarding base64 or internal receipt objects', () => {
    const delivery = sanitizeExecutionResponseForDelivery({
      text: JSON.stringify({
        active_window: { window_id: '42', process_name: 'chrome.exe' },
        image_base64: 'A'.repeat(16_000),
        terminalVerification: { status: 'verified' },
      }),
      finalized: true,
      blocked: false,
    }, {
      task: '看看当前屏幕是什么',
      toolRecords: [record({
        name: 'desktop_capture_screen',
        result: JSON.stringify({ image_base64: 'A'.repeat(16_000), width: 1920, height: 1080 }),
        terminalVerification: { status: 'verified', strategy: 'visual', reason: 'captured' },
      }), record({
        name: 'computer_vision',
        error: 'vision provider unavailable',
      })],
    });

    expect(delivery.blocked).toBe(false);
    expect(delivery.text).toContain('已获取屏幕画面');
    expect(delivery.text).toContain('视觉识别没有完成');
    expect(delivery.text).not.toMatch(/image_base64|data:image|AAAAA|window_id|terminalVerification/iu);
    expect(String(delivery.text).length).toBeLessThan(300);
  });

  it('turns raw directory JSON and tasklist tables into bounded human summaries', () => {
    const directoryResult = JSON.stringify([
      { path: 'C:\\Users\\test-user\\Desktop\\alpha.docx', type: 'file', modifiedMs: 1 },
      { path: 'C:\\Users\\test-user\\Desktop\\beta.xlsx', type: 'file', modifiedMs: 2 },
    ]);
    const directory = sanitizeExecutionResponseForDelivery({
      text: directoryResult,
      finalized: true,
      blocked: false,
    }, {
      task: '列出桌面文件',
      toolRecords: [record({ name: 'desktop_list_files', result: directoryResult })],
    });
    expect(directory.text).toContain('已读取目录');
    expect(directory.text).toContain('alpha.docx');
    expect(directory.text).not.toMatch(/C:\\Users|modifiedMs|"path"/u);

    const tasklist = sanitizeExecutionResponseForDelivery({
      text: [
        'Image Name                     PID Session Name        Session#    Mem Usage',
        'chrome.exe                   12345 Console                    1    100,000 K',
        'wps.exe                      23456 Console                    1     80,000 K',
      ].join('\n'),
      finalized: true,
      blocked: false,
    }, { task: '看看运行中的程序' });
    expect(tasklist.text).toContain('已检查运行中的程序');
    expect(tasklist.text).toContain('chrome.exe');
    expect(tasklist.text).not.toMatch(/PID Session Name|100,000 K/iu);
    expect(String(tasklist.text).length).toBeLessThan(300);
  });

  it('preserves only the exact safe pending-confirmation envelope with path fields', () => {
    clearAllPendingConfirmationsForTests();
    try {
      const pending = recordPendingConfirmation(
        'trusted-confirmation-output',
        'web_login',
        {
          path: 'C:\\isolated\\lumi-task-regression\\account.json',
          username: 'owner',
          password: 'must-never-leak',
          clientSecret: 'also-must-never-leak',
        },
        'chat',
        { actionIntent: 'Log in with the isolated account' },
      );
      const confirmationRequest = formatPendingConfirmationRequest(pending);
      expect(confirmationRequest).toContain('C:\\isolated\\lumi-task-regression\\account.json');
      expect(confirmationRequest).toContain('[redacted]');
      expect(confirmationRequest).not.toContain('must-never-leak');
      expect(confirmationRequest).not.toContain('also-must-never-leak');

      const trusted = sanitizeExecutionResponseForDelivery({
        text: confirmationRequest,
        finalized: true,
        blocked: false,
        reason: 'waiting_confirmation',
      }, {
        task: 'Log in with the isolated account',
        trustedConfirmationRequestText: confirmationRequest,
      });
      expect(trusted.text).toBe(confirmationRequest);
      expect(trusted.text).toContain('lumi-task-regression');
      expect(trusted.reason).toBe('waiting_confirmation');
      expect(JSON.stringify(trusted)).not.toContain('must-never-leak');
      expect(JSON.stringify(trusted)).not.toContain('also-must-never-leak');

      const untrusted = sanitizeExecutionResponseForDelivery({
        text: confirmationRequest,
        finalized: true,
        blocked: false,
        reason: 'waiting_confirmation',
      }, { task: 'Log in with the isolated account' });
      expect(untrusted.text).not.toBe(confirmationRequest);
      expect(untrusted.text).not.toContain('C:\\isolated\\account.json');
    } finally {
      clearAllPendingConfirmationsForTests();
    }
  });

  it('persists verified receipt facts without storing screenshot or oversized raw payloads', () => {
    const records = sanitizeToolRecordsForPersistence([record({
      name: 'desktop_capture_screen',
      arguments: {
        target: 'desktop',
        credential: 'must-not-persist',
        preview: `data:image/png;base64,${'A'.repeat(12_000)}`,
      },
      result: JSON.stringify({
        image_base64: 'B'.repeat(20_000),
        width: 1920,
        height: 1080,
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'visual',
        reason: 'capture completed',
      },
      envelope: {
        version: 1,
        status: 'verified_success',
        toolName: 'desktop_capture_screen',
        taskId: 'task-screen',
        turnId: 'turn-screen',
        requestId: 'request-screen',
        idempotencyKey: 'screen-key',
        targetIdentity: 'desktop',
        completedAt: '2026-08-25T09:10:00.000Z',
        result: { image_base64: 'C'.repeat(20_000) },
        verification: { status: 'verified', reason: 'capture completed' },
      },
    }), record({
      name: 'read_file',
      result: 'plain text '.repeat(2_000),
    })]);
    const serialized = JSON.stringify(records);

    expect(records?.[0].terminalVerification.status).toBe('verified');
    expect(records?.[0].envelope.status).toBe('verified_success');
    expect(serialized).toContain('binary image omitted');
    expect(serialized).toContain('stored result truncated');
    expect(serialized).not.toMatch(/must-not-persist|data:image|AAAAA|BBBBB|CCCCC/iu);
    expect(serialized.length).toBeLessThan(12_000);
  });

  it('keeps long desktop inventory receipts as valid bounded JSON with document and window evidence', () => {
    const targetPath = 'C:\\Users\\Administrator\\Desktop\\Lumi_路演.pptx';
    const files = Array.from({ length: 180 }, (_, index) => ({
      name: `ordinary-${index}.cache`,
      path: `C:\\Users\\Administrator\\Desktop\\ordinary-${index}.cache`,
      type: 'file',
      modifiedMs: index,
    }));
    files[137] = {
      name: 'Lumi_路演.pptx',
      path: targetPath,
      type: 'file',
      modifiedMs: 137,
    };
    const processes = Array.from({ length: 140 }, (_, index) => ({
      pid: 10_000 + index,
      name: `ordinary-${index}.exe`,
      window_title: '',
      window_titles: [],
    }));
    processes[121] = {
      pid: 88_712,
      name: 'wpp.exe',
      window_title: 'Lumi_路演.pptx - WPS Office',
      window_titles: ['Lumi_路演.pptx - WPS Office'],
    };
    const records = sanitizeToolRecordsForPersistence([record({
      name: 'desktop_list_files',
      arguments: { path: '~/Desktop', limit: 1_000 },
      result: JSON.stringify(files),
      envelope: {
        version: 1,
        status: 'verified_success',
        toolName: 'desktop_list_files',
        taskId: 'inventory-task',
        turnId: 'inventory-turn',
        requestId: 'inventory-request',
        idempotencyKey: 'inventory-files',
        targetIdentity: '~/Desktop',
        completedAt: '2026-08-28T12:00:00.000Z',
        result: files,
        verification: { status: 'verified', reason: 'Directory listing returned.' },
      },
    }), record({
      name: 'desktop_running_processes',
      arguments: { top: 200 },
      result: JSON.stringify(processes),
      envelope: {
        version: 1,
        status: 'verified_success',
        toolName: 'desktop_running_processes',
        taskId: 'inventory-task',
        turnId: 'inventory-turn',
        requestId: 'inventory-request',
        idempotencyKey: 'inventory-processes',
        targetIdentity: 'desktop:local',
        completedAt: '2026-08-28T12:00:01.000Z',
        result: processes,
        verification: { status: 'verified', reason: 'Process list returned.' },
      },
    })]);

    const persistedFiles = JSON.parse(records?.[0].result || '{}');
    const persistedProcesses = JSON.parse(records?.[1].result || '{}');
    expect(persistedFiles).toMatchObject({
      kind: 'desktop_files_summary',
      originalCount: 180,
      truncated: true,
    });
    expect(persistedProcesses).toMatchObject({
      kind: 'running_processes_summary',
      originalCount: 140,
      truncated: true,
    });
    expect(persistedFiles.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: targetPath }),
    ]));
    expect(persistedProcesses.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ window_title: 'Lumi_路演.pptx - WPS Office' }),
    ]));
    expect(records?.[0].result.length).toBeLessThanOrEqual(4_000);
    expect(records?.[1].result.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(records)).not.toContain('stored result truncated');
    expect(records?.[0].envelope.result).toEqual(persistedFiles);
    expect(records?.[1].envelope.result).toEqual(persistedProcesses);
  });

  it('stores a bounded client state summary instead of duplicating the full self model', () => {
    const fullState = {
      detail: 'full',
      stateDigest: { mode: 'assistant', wallpaperMode: false },
      state: {
        updatedAt: Date.now(),
        platform: 'desktop',
        mode: 'assistant',
        activeTab: 'home',
        viewMode: 'personal',
        workDomain: 'personal',
        windows: { focused: 'home', open: ['home'] },
        surfaces: { wallpaperMode: false, widgetMode: false },
      },
      health: { level: 'ok', stateAgeSeconds: 1, findings: [] },
      capabilityRuntime: { registeredTools: 371 },
      scope: { domain: 'personal' },
      capabilities: Array.from({ length: 80 }, (_, index) => ({ id: `cap-${index}`, notes: 'x'.repeat(600) })),
      interfaceSurfaces: Array.from({ length: 50 }, (_, index) => ({ id: `surface-${index}`, notes: 'y'.repeat(400) })),
    };
    const records = sanitizeToolRecordsForPersistence([record({
      name: 'client_get_state',
      result: JSON.stringify(fullState),
      receipt: fullState,
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'state read' },
      envelope: {
        version: 1,
        status: 'verified_success',
        toolName: 'client_get_state',
        taskId: 'task-client-state',
        turnId: 'turn-client-state',
        requestId: 'request-client-state',
        idempotencyKey: 'client-state-idempotency-key',
        targetIdentity: 'desktop:local',
        completedAt: '2026-08-25T14:30:00.000Z',
        result: fullState,
        verification: { status: 'verified', reason: 'state read' },
      },
    })]);
    const serialized = JSON.stringify(records);
    const compacted = JSON.parse(records?.[0].result || '{}');

    expect(compacted).toMatchObject({
      kind: 'client_state_summary',
      fullDiagnosticsOmittedFromConversation: true,
      capabilityRuntime: { registeredTools: 371 },
    });
    expect(serialized).not.toContain('cap-79');
    expect(serialized).not.toContain('surface-49');
    expect(serialized.length).toBeLessThan(6_000);
  });

  it('redacts nested and serialized credential aliases before persisting tool receipts', () => {
    const records = sanitizeToolRecordsForPersistence([record({
      name: 'credential_probe',
      arguments: {
        access_token: 'access-must-not-persist',
        refreshToken: 'refresh-must-not-persist',
        appSecret: 'secret-must-not-persist',
        verificationToken: 'verification-must-not-persist',
        nested: {
          client_secret: 'client-secret-must-not-persist',
          tokenCount: 42,
          maxTokens: 4_096,
        },
      },
      result: JSON.stringify({
        accessToken: 'result-access-must-not-persist',
        secretAccessKey: 'result-secret-must-not-persist',
        verification_code: 'code-must-not-persist',
        promptTokens: 128,
      }),
    })]);
    const serialized = JSON.stringify(records);

    expect(serialized).not.toMatch(/access-must-not-persist|refresh-must-not-persist|secret-must-not-persist|verification-must-not-persist|code-must-not-persist/u);
    expect(serialized.match(/\[redacted\]/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(records?.[0].arguments.nested).toMatchObject({ tokenCount: 42, maxTokens: 4_096 });
    expect(JSON.parse(records?.[0].result || '{}')).toMatchObject({
      accessToken: '[redacted]',
      secretAccessKey: '[redacted]',
      verification_code: '[redacted]',
      promptTokens: 128,
    });
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
    expect(recovered.responseText).toContain('客户端操作');
    expect(recovered.responseText).not.toContain('client_action');
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
    expect(recovered.responseText).toContain('client operation');
    expect(recovered.responseText).not.toContain('client_action');
    expect(recovered.responseText).not.toContain('provider disconnected');
    expect(recovered.finalization).toMatchObject({
      reason: 'execution_recovery_incomplete',
      notification: undefined,
    });
    expect(JSON.stringify(recovered.finalization)).not.toContain('No successful current-turn');
  });

  it('preserves a confirmation request created during recovery even if the provider then fails', async () => {
    let waitingForConfirmation = false;
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
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

  it('self-recovers a missing fresh correction confirmation even when the model draft looked unblocked', async () => {
    let waitingForConfirmation = false;
    let attempts = 0;
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '最后一次纠正目标，内容不变；等待我的确认。',
      responseText: '目标已经更新，请确认。',
      finalization: {
        text: '目标已经更新，请确认。',
        blocked: false,
      },
      allowToolUse: true,
      pendingConfirmation: false,
      requiresFreshConfirmation: true,
      toolRecords: [],
      isPendingConfirmation: () => waitingForConfirmation,
      attempt: async () => {
        attempts += 1;
        waitingForConfirmation = true;
        return { text: '新的精确操作正在等待确认。', toolRecords: [] };
      },
      finalize: text => ({
        text,
        blocked: false,
        reason: waitingForConfirmation ? 'waiting_confirmation' : undefined,
      }),
    });

    expect(attempts).toBe(1);
    expect(recovered).toMatchObject({
      attempted: true,
      recoveryFailed: false,
      finalization: { blocked: false, reason: 'waiting_confirmation' },
    });
  });

  it('never reports an unrecorded fresh confirmation boundary as unblocked', async () => {
    const recovered = await recoverBlockedExecutionOnce<ExecutionGuardRecoveryFinalization>({
      task: '最后一次纠正目标，内容不变；等待我的确认。',
      responseText: '请确认。',
      finalization: { text: '请确认。', blocked: false },
      allowToolUse: true,
      requiresFreshConfirmation: true,
      toolRecords: [],
      isPendingConfirmation: () => false,
      attempt: async () => ({ text: '请确认。', toolRecords: [] }),
      finalize: text => ({ text, blocked: false }),
    });

    expect(recovered.attempted).toBe(true);
    expect(recovered.recoveryFailed).toBe(true);
    expect(recovered.finalization.blocked).toBe(true);
    expect(recovered.finalization.reason).toBe('execution_recovery_incomplete');
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
      expect(source).toContain('requiresFreshConfirmation: correctionRequiresFreshConfirmation');
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
    expect(taskSource).toContain('isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn)');
    expect(voiceSource).toContain("source: 'voice_guard_recovery'");
    expect(voiceSource).toContain('isAborted: () => !isCurrentTurn()');

    for (const source of [chatSource, taskSource, voiceSource]) {
      expect(source).toMatch(/correctionRequiresFreshConfirmation\s+&& !pendingConfirmationMatchesExactProposal\(/);
      expect(source).toContain("throw new Error('Corrected action confirmation was not bound to the current task request')");
    }
  });
});
