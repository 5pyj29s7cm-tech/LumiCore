import { describe, expect, it } from 'vitest';
import {
  buildConversationActionContinuationState,
  formatConversationActionTaskStatus,
  normalizeConversationActionState,
  prepareConversationActionTaskState,
} from '../server/cognition/action_continuation';
import {
  applyTaskPolicySnapshot,
  coalesceToolExecutionRecords,
  confirmedStepNeedsContinuation,
  recordsToTaskReceipts,
  taskCompletionFromReceipts,
  taskReceiptsToRecords,
  toolRecordSucceeded,
} from '../server/cognition/task_execution_ledger';

describe('durable conversation task execution ledger', () => {
  it('does not promote uncertain or target-mismatched actuation into success', () => {
    expect(toolRecordSucceeded({
      name: 'wechat_send_message',
      arguments: { text: '测试' },
      result: JSON.stringify({
        sent: false,
        sendAttempted: true,
        verificationStatus: 'uncertain',
        verificationReason: 'visual verification failed',
      }),
    })).toBe(false);
    expect(toolRecordSucceeded({
      name: 'desktop_window_control',
      arguments: { action: 'maximize', expectedTarget: '浏览器' },
      result: JSON.stringify({ ok: true, status: 'verified', targetMatched: false }),
    })).toBe(false);
    expect(toolRecordSucceeded({
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\Desktop\\plan.jpg' },
      result: JSON.stringify({
        failedStage: 'calibration',
        parsed: false,
        geometryReady: false,
        geometryVerified: false,
        executableGeometryAvailable: false,
        parseError: 'A confirmed physical width and height are required.',
      }),
    })).toBe(false);
  });

  it('keeps verified WPS document creation successful when the document is intentionally unsaved', () => {
    expect(toolRecordSucceeded({
      name: 'wps_create_document_with_text',
      arguments: { text: 'Lumi WPS' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        automation: 'KWPS.Application',
        visible: true,
        documentCreated: true,
        exactTextMatch: true,
        saved: false,
        savePath: '',
      }),
      terminalVerification: {
        status: 'verified',
        strategy: 'state_diff',
        reason: 'Exact WPS body readback matched.',
      },
    })).toBe(true);
  });

  it('lets a successful retry supersede the same failed step without deleting valid pre/post observations', () => {
    const records = coalesceToolExecutionRecords([
      { name: 'desktop_keyboard_press', arguments: { keys: ['CTRL', 'N'] }, result: '', error: 'snapshot required' },
      { name: 'desktop_ui_snapshot', arguments: { root: 'active' }, result: '{"status":"ok","phase":"before"}' },
      { name: 'desktop_keyboard_press', arguments: { keys: ['CTRL', 'N'] }, result: '{"ok":true,"status":"completed"}' },
      { name: 'desktop_ui_snapshot', arguments: { root: 'active' }, result: '{"status":"ok","phase":"after"}' },
    ]);

    expect(records.filter(record => record.name === 'desktop_keyboard_press')).toHaveLength(1);
    expect(records.find(record => record.name === 'desktop_keyboard_press')?.error).toBeUndefined();
    expect(records.filter(record => record.name === 'desktop_ui_snapshot')).toHaveLength(2);
  });

  it('creates state before tools run and preserves task identity and capability envelope on confirmation', () => {
    const initialPolicy = {
      allowedTools: ['desktop_open', 'desktop_ui_snapshot', 'desktop_keyboard_press'],
      requireConfirmation: ['desktop_keyboard_press'],
      forbiddenTools: [],
      maxIterations: 8,
    };
    const started = prepareConversationActionTaskState(null, {
      userText: '打开 WPS，新建一个 Word 文档',
      requestId: 'request-1',
      toolPolicy: initialPolicy,
      now: '2026-07-22T00:00:00.000Z',
    });
    const resumed = prepareConversationActionTaskState(started.state, {
      userText: '确认',
      requestId: 'request-2',
      toolPolicy: {
        allowedTools: ['desktop_keyboard_press'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 2,
      },
      forceResume: true,
      now: '2026-07-22T00:00:01.000Z',
    });

    expect(started.kind).toBe('new');
    expect(started.state?.status).toBe('planning');
    expect(started.state?.receipts).toEqual([]);
    expect(resumed.kind).toBe('resume');
    expect(resumed.state?.taskId).toBe(started.state?.taskId);
    expect(resumed.state?.policySnapshot?.allowedTools).toEqual(expect.arrayContaining(initialPolicy.allowedTools));
  });

  it('lets an explicitly selected workflow supersede an unrelated unfinished task', () => {
    const policy = { allowedTools: ['industry_output_create'], requireConfirmation: [], forbiddenTools: [], maxIterations: 5 };
    const oldTask = prepareConversationActionTaskState(null, {
      userText: 'Read the old task ledger only.', requestId: 'old', toolPolicy: policy, forceTask: true,
    });
    const currentTask = prepareConversationActionTaskState(oldTask.state, {
      userText: 'Continue the current project and create a new verified output.',
      requestId: 'current', toolPolicy: policy, forceTask: true, forceNewTask: true,
    });

    expect(currentTask.kind).toBe('new');
    expect(currentTask.state?.taskId).not.toBe(oldTask.state?.taskId);
    expect(currentTask.state?.supersededTaskId).toBe(oldTask.state?.taskId);
  });

  it('keeps prior permissions on terse replies and deliberately expands them for a real follow-up', () => {
    const merged = applyTaskPolicySnapshot(
      {
        allowedTools: ['desktop_ui_type'],
        requireConfirmation: [],
        forbiddenTools: ['desktop_run_command'],
        maxIterations: 10,
      },
      {
        allowedTools: ['desktop_open', 'desktop_ui_snapshot'],
        requireConfirmation: ['desktop_open'],
        forbiddenTools: [],
        maxIterations: 6,
      },
    );

    expect(merged.allowedTools).toEqual(expect.arrayContaining([
      'desktop_open',
      'desktop_ui_snapshot',
      'desktop_ui_type',
    ]));
    expect(merged.allowedTools).not.toContain('desktop_run_command');
    expect(merged.maxIterations).toBe(10);
  });

  it('keeps a zero-tool promise visibly unfinished and reports only terminal receipt facts', () => {
    const started = prepareConversationActionTaskState(null, {
      userText: '把桌面的方案打开并在 WPS 里修改',
      requestId: 'request-1',
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 5 },
    });
    expect(formatConversationActionTaskStatus(started.state)).toContain('还在执行链上');

    const blocked = buildConversationActionContinuationState({
      previous: started.state,
      userText: '继续',
      assistantText: '正在处理',
      toolCalls: [{ name: 'desktop_open', arguments: { target: 'WPS' }, error: 'application not found' }],
    });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.latestBlocker).toContain('application not found');
    expect(formatConversationActionTaskStatus(blocked)).toContain('还没完成');
    expect(recordsToTaskReceipts([])).toEqual([]);
  });

  it('keeps a terse confirmation attached to the original multi-step goal', () => {
    const started = prepareConversationActionTaskState(null, {
      userText: '打开 WPS，然后新建一个 Word 文档',
      requestId: 'request-1',
      toolPolicy: {
        allowedTools: ['desktop_open', 'wps_create_document_with_text'],
        requireConfirmation: ['desktop_open'],
        forbiddenTools: [],
        maxIterations: 8,
      },
    });
    const afterConfirmedOpen = buildConversationActionContinuationState({
      previous: started.state,
      userText: '确认',
      assistantText: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'WPS',
          targetMatched: true,
          actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
        }),
      }],
      requestId: 'request-2',
    });

    expect(afterConfirmedOpen?.goal).toBe('打开 WPS，然后新建一个 Word 文档');
    expect(afterConfirmedOpen?.latestInstruction).toBe('确认');
    expect(afterConfirmedOpen?.status).not.toBe('completed');
    expect(afterConfirmedOpen?.unfinished).toBe(true);
  });

  it('continues the original task after a confirmed boundary completes only one step', () => {
    const confirmedOpen = {
      name: 'desktop_open',
      arguments: { target: 'WPS' },
      result: JSON.stringify({
        ok: true,
        status: 'verified',
        opened: true,
        target: 'WPS',
        targetMatched: true,
        actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
      }),
    };

    expect(confirmedStepNeedsContinuation(
      'Open WPS and create a Word document',
      [confirmedOpen],
    )).toBe(true);
    expect(confirmedStepNeedsContinuation(
      'Open WPS',
      [confirmedOpen],
    )).toBe(false);
    expect(confirmedStepNeedsContinuation(
      'Open WPS and create a Word document',
      [{ ...confirmedOpen, result: '', error: 'permission denied' }],
    )).toBe(false);
  });

  it('keeps the substantive workflow failure ahead of a later permission drift', () => {
    const state = buildConversationActionContinuationState({
      userText: '读取桌面上的阿陆平面图并画进 AutoCAD。',
      assistantText: '任务被阻塞。',
      toolCalls: [
        {
          name: 'mcp_cad-drafting_autocad_playback_file',
          arguments: { operationsPath: 'C:\\cad\\plan_operations.json' },
          error: 'AutoCAD entity-count verification failed after operation 33.',
        },
        {
          name: 'desktop_open',
          arguments: { target: 'AutoCAD' },
          error: 'Tool "desktop_open" is forbidden: not in allowedTools list.',
        },
      ],
    });

    expect(state?.latestBlocker).toContain('operation 33');
    expect(state?.latestBlocker).not.toContain('allowedTools');
  });

  it('persists handler success without verification as partial instead of completed', () => {
    const record = {
      name: 'custom_desktop_action',
      arguments: { target: 'Example' },
      result: JSON.stringify({ ok: true, action: 'requested' }),
      receipt: {
        status: 'observed',
        target: { id: 'window-42', title: 'Target application' },
      },
      capability: {
        capabilityId: 'desktop.custom-action',
        lane: 'desktop' as const,
        operation: 'mutate' as const,
        risk: 'medium' as const,
        sideEffects: [{ type: 'desktop_control' as const, scope: 'desktop', reversible: true }],
        verification: {
          strategy: 'state_diff' as const,
          required: true,
          requiredFields: ['verification.status'],
          successSignals: ['verified post-state'],
          limitations: [],
        },
      },
      terminalVerification: {
        status: 'unverified' as const,
        strategy: 'state_diff' as const,
        reason: 'No post-action state was observed.',
      },
    };
    const receipts = recordsToTaskReceipts([record], '2026-07-26T00:00:00.000Z');

    expect(receipts[0].outcome).toBe('partial');
    expect(taskReceiptsToRecords(receipts)[0]).toMatchObject({
      receipt: {
        status: 'observed',
        target: { id: 'window-42' },
      },
      terminalVerification: { status: 'unverified' },
      capability: { capabilityId: 'desktop.custom-action' },
    });
    expect(taskCompletionFromReceipts('perform the requested custom operation', receipts)).toMatchObject({
      complete: false,
      blocker: 'No post-action state was observed.',
    });

    const reloaded = normalizeConversationActionState({
      version: 2,
      taskId: 'task-reload',
      status: 'blocked',
      goal: 'perform the requested custom operation',
      latestInstruction: 'perform the requested custom operation',
      appTarget: 'Target application',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: [],
      assistantState: '',
      toolSummaries: [],
      receipts: JSON.parse(JSON.stringify(receipts)),
      updatedAt: new Date().toISOString(),
    });
    expect(reloaded?.receipts?.[0]).toMatchObject({
      receipt: { status: 'observed', target: { id: 'window-42' } },
      terminalVerification: { status: 'unverified' },
      capability: {
        capabilityId: 'desktop.custom-action',
        verification: { required: true },
      },
    });
    expect(taskCompletionFromReceipts(
      reloaded?.goal || '',
      reloaded?.receipts || [],
    )).toMatchObject({
      complete: false,
      blocker: 'No post-action state was observed.',
    });
  });

  it('persists text readback metrics without storing another full-text copy', () => {
    const content = '第一行\n第二行\n第三行';
    const receipts = recordsToTaskReceipts([{
      id: 'readback-1',
      name: 'read_file',
      arguments: { path: 'C:\\Temp\\result.txt' },
      result: content,
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'read returned',
      },
    }]);
    expect(receipts[0].receipt).toMatchObject({
      kind: 'text_readback_metadata',
      encoding: 'UTF-8',
      lineCount: 3,
      byteLength: Buffer.byteLength(content, 'utf8'),
    });
    expect((receipts[0].receipt as any).contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps a verified client action successful when its health payload contains failed zero', () => {
    const record = {
      name: 'client_action',
      arguments: { action: 'set_wallpaper_mode', enabled: true },
      result: JSON.stringify({
        ok: true,
        action: 'set_wallpaper_mode',
        verification: { status: 'verified', matched: ['surface:wallpaper:open'] },
        health: { failed: 0, pending: 1 },
        diagnosticDetails: 'x'.repeat(4_000),
      }),
      capability: {
        capabilityId: 'client.surface.action',
        lane: 'client' as const,
        operation: 'mutate' as const,
        risk: 'low' as const,
        sideEffects: [{ type: 'desktop_control' as const, scope: 'Lumi client', reversible: true }],
        verification: {
          strategy: 'state_diff' as const,
          required: true,
          requiredFields: ['verification.status'],
          successSignals: ['verified client state'],
          limitations: [],
        },
      },
      terminalVerification: {
        status: 'verified' as const,
        strategy: 'state_diff' as const,
        reason: 'The receipt contains verified post-action state.',
      },
    };

    expect(toolRecordSucceeded(record)).toBe(true);
    const receipts = recordsToTaskReceipts([record]);
    expect(receipts[0].outcome).toBe('success');
    expect(receipts[0].result.length).toBeLessThan(record.result.length);
    expect(toolRecordSucceeded(taskReceiptsToRecords(receipts)[0])).toBe(true);
  });
});
