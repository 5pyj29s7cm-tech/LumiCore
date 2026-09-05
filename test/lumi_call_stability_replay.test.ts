import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { matchQuickCommand } from '../server/cognition/quick_commands';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs } from '../server/agents/nl_chainer';
import {
  findConversationActionTask,
  formatConversationActionLedgerStatus,
  getConversationActionStateFromLedger,
  repairContradictoryConversationActionReceipts,
  syncConversationActionTaskLedger,
} from '../server/conversation/action_ledger';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';
import { ToolRegistry } from '../server/tools/registry';
import { formatCnToolFailureDetail } from '../server/regions/packs/cn/voice_fast_path_messages';

const CUSTOMER_INTERNAL_EXECUTION_COPY = /(?:^|\n)\s*(?:\u72b6\u6001|\u8bc1\u636e|\u5177\u4f53\u963b\u585e|\u6267\u884c\u56de\u9988)\s*[:\uff1a]|\u56de\u6267|target_mismatch|terminalVerification|\b(?:taskId|requestId|desktop_open|client_action|desktop_execution_plan_receipt|verified|blocked|failed)\b|No successful current-turn tool execution/iu;

function expectNaturalCustomerStatus(value: string): void {
  expect(value).not.toMatch(CUSTOMER_INTERNAL_EXECUTION_COPY);
}

function actionState(overrides: Partial<ConversationActionContinuationState>): ConversationActionContinuationState {
  return {
    version: 2,
    taskId: 'task_test',
    status: 'completed',
    receipts: [],
    revision: 1,
    goal: '完成任务',
    latestInstruction: '完成任务',
    appTarget: '',
    sourcePaths: [],
    latestBlocker: '',
    unfinished: false,
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    updatedAt: '2026-07-26T12:00:00.000Z',
    completionSource: 'tool_receipt',
    ...overrides,
  };
}

describe('Lumi field-call stability replay', () => {
  it('reports execution only when the exact task has a server-owned action turn', () => {
    const db: any = {
      conversationActionTasks: [],
      conversationActionReceipts: [],
      conversationActionTurns: [],
    };
    const conversation = { id: 'conv_truth', userId: 'user_truth', domain: 'personal', orgId: '' };
    const state = actionState({
      taskId: 'task_truth',
      status: 'executing',
      unfinished: true,
      activeRequestId: 'request_truth',
      completionSource: undefined,
    });
    syncConversationActionTaskLedger(db, { conversation, state });

    const unowned = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '现在进度怎么样',
    });
    expect(unowned).toMatch(/没有在后台运行|没有.*正在运行/u);
    expect(unowned).not.toMatch(/正在(?:处理|执行)|还在执行/u);
    expectNaturalCustomerStatus(unowned);

    db.conversationActionTurns.push({
      conversationId: conversation.id,
      userId: conversation.userId,
      taskId: state.taskId,
      requestId: state.activeRequestId,
      status: 'accepted',
    });
    const owned = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '现在进度怎么样',
    });
    expect(owned).toMatch(/正在(?:处理|执行)|还在执行/u);
    expect(owned).not.toContain('没有在后台运行');
    expectNaturalCustomerStatus(owned);
  });

  it('reports desktop relay timeouts as actionable Chinese instead of an opaque failure', () => {
    expect(formatCnToolFailureDetail('Desktop tool "desktop_open" timed out (60s)'))
      .toContain('窗口回执时超时');
  });

  it.each([
    '',
    'undefined',
    'null',
    '[object Object]',
  ])('normalizes an empty or undefined adapter failure: %s', (detail) => {
    const message = formatCnToolFailureDetail(detail);
    expect(message).toBe('系统没有返回可核实的失败原因。');
    expect(message).not.toMatch(/undefined|null|\[object Object\]|No successful|execution-status/iu);
  });

  it('normalizes internal guard copy and an HTTP response with no body', () => {
    const internal = formatCnToolFailureDetail(
      'No successful current-turn tool execution was recorded for that execution-status claim.',
    );
    expect(internal).toBe('这一步没有拿到可执行的入口或可验证的结果，已停止，没有冒充完成。');
    expect(internal).not.toMatch(/No successful|current-turn|execution-status|tool execution/iu);
    expect(formatCnToolFailureDetail('400 status code (no body)'))
      .toBe('服务返回 HTTP 400，但没有提供错误正文。');
  });

  it('treats inbound sender language as read-only in both channel routes', () => {
    const variants = [
      '看一下张勇最近给我发什么消息了',
      '张勇给我发了什么消息',
      '帮我读一下张勇最近发给我的消息',
    ];
    for (const text of variants) {
      expect(normalizeActionIntent(text)).toMatchObject({
        kind: 'messaging_read',
        operation: 'read',
        target: '张勇',
        sideEffectClass: 'none',
      });
      expect(buildForegroundWeChatReadArgs(text)).toMatchObject({ contact: '张勇', useSearch: true });
      expect(buildForegroundWeChatSendArgs(text)).toBeNull();
    }
  });

  it('requires an exact recipient and payload before constructing a send', () => {
    expect(buildForegroundWeChatSendArgs('给张勇发 明天上午十点开会')).toMatchObject({
      contact: '张勇',
      message: '明天上午十点开会',
    });
    expect(buildForegroundWeChatSendArgs('直接发明天见')).toBeNull();
    expect(buildForegroundWeChatSendArgs('我没有让你发消息')).toBeNull();
  });

  it('maps the Lumi chat surface only to the native client action', async () => {
    const intent = normalizeActionIntent('打开聊天界面');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      clientAction: 'open_chat',
    });
    const quick = await matchQuickCommand('打开聊天界面', 'field-replay', { surface: 'voice' });
    expect(quick?.toolCall).toEqual({ name: 'client_action', arguments: { action: 'open_chat' } });
  });

  it('classifies an angry correction as explanation-only and executes no quick tool', async () => {
    const text = '我操你打开了什么东西啊';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'correction_explanation',
      operation: 'explain',
      sideEffectClass: 'none',
      relation: 'correction',
    });
    expect(buildActionContract(text)).toMatchObject({ applies: false, kind: 'none' });
    expect(await matchQuickCommand(text, 'field-replay', { surface: 'chat' })).toBeNull();
  });

  it('keeps completed CAD receipts queryable after the legacy pointer disappears', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_1', userId: 'user_1', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_cad',
        goal: '在 AutoCAD 中绘制户型图',
        latestInstruction: '在 AutoCAD 中绘制户型图',
        appTarget: 'AutoCAD',
        sourcePaths: ['D:\\drawings\\floorplan.dwg'],
        evidenceTools: ['cad_draw_floorplan_in_autocad'],
        receipts: [{
          id: 'cad_receipt',
          key: 'cad_draw_floorplan_in_autocad:{}',
          name: 'cad_draw_floorplan_in_autocad',
          arguments: {},
          result: JSON.stringify({ completed: true, geometryVerified: true, entityCount: 375 }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'DWG geometry verified' },
          recordedAt: '2026-07-26T12:00:00.000Z',
        }],
      }),
    });

    expect(findConversationActionTask(db, {
      conversationId: 'conv_1',
      userId: 'user_1',
      query: 'CAD 画完了吗',
    })?.id).toBe('task_cad');
    expect(formatConversationActionLedgerStatus(db, {
      conversationId: 'conv_1',
      userId: 'user_1',
      query: 'CAD 画完了吗',
    })).toContain('已完成');
  });

  it('keeps a failed desktop launch queryable with the actionable provider blocker', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_notepad', userId: 'user_notepad', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_notepad',
        status: 'blocked',
        goal: '打开记事本，只打开，不输入任何内容，也不要打开替代软件。',
        latestInstruction: '打开记事本，只打开，不输入任何内容，也不要打开替代软件。',
        appTarget: '记事本',
        unfinished: true,
        latestBlocker: 'desktop_open: Qwen Vision returned 400 Access denied, please make sure your account is in good standing',
        completionSource: undefined,
        receipts: [{
          id: 'notepad_receipt',
          key: 'desktop_open:{"target":"记事本"}',
          name: 'desktop_open',
          arguments: { target: '记事本' },
          result: '',
          error: 'Qwen Vision returned 400 Access denied, please make sure your account is in good standing',
          outcome: 'failure',
          recordedAt: '2026-08-16T12:00:00.000Z',
        }],
      }),
    });

    const status = formatConversationActionLedgerStatus(db, {
      conversationId: 'conv_notepad',
      userId: 'user_notepad',
      query: '刚才打开记事本成功了吗？只根据最近一次任务的真实回执回答。',
    });
    expect(status).toContain('视觉核验服务拒绝了请求');
    expect(status).toContain('账号状态、余额和访问权限');
    expectNaturalCustomerStatus(status);
  });

  it('includes the verified output path when a completed artifact status query asks for it', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_artifact', userId: 'user_artifact', domain: 'personal', orgId: '' };
    const outputPath = 'D:\\outputs\\customer-followup.md';
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_artifact',
        goal: `创建并验证文件 ${outputPath}`,
        latestInstruction: `创建并验证文件 ${outputPath}`,
        sourcePaths: [outputPath],
        receipts: [{
          id: 'artifact_receipt',
          key: `write_file:{\"path\":\"${outputPath.replace(/\\/g, '\\\\')}\"}`,
          name: 'write_file',
          arguments: { path: outputPath },
          result: `File written: ${outputPath} (120 bytes)`,
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'non-empty file verified' },
          recordedAt: '2026-08-16T00:00:00.000Z',
        }],
      }),
    });

    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '任务完成了吗？告诉我产物路径。',
    });
    expect(status).toMatch(/(?:已|已经)完成/u);
    expect(status).toContain(`产物路径：${outputPath}`);
    expectNaturalCustomerStatus(status);
  });

  it('finds a completed named artifact through persistent receipts and reports the post-write readback', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_named_artifact', userId: 'user_named_artifact', domain: 'personal', orgId: '' };
    const outputPath = 'C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260816.txt';
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_named_artifact',
        goal: `创建并验证文件 ${outputPath}`,
        latestInstruction: `创建并验证文件 ${outputPath}`,
        sourcePaths: [outputPath],
        status: 'completed',
        unfinished: false,
        completionSource: 'tool_receipt',
        receipts: [
          {
            id: 'write_receipt',
            key: 'write_receipt',
            name: 'write_file',
            arguments: { path: outputPath },
            result: `File written: ${outputPath} (96 bytes)`,
            error: '',
            outcome: 'success',
            terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'non-empty file verified' },
            recordedAt: '2026-08-16T00:00:00.000Z',
          },
          {
            id: 'read_receipt',
            key: 'read_receipt',
            name: 'read_file',
            arguments: { path: outputPath },
            result: '版本：主程序\n状态：已回读\n代号：青穹-17',
            receipt: {
              kind: 'text_readback_metadata',
              encoding: 'UTF-8',
              lineCount: 3,
            },
            error: '',
            outcome: 'success',
            terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'readback returned content' },
            recordedAt: '2026-08-16T00:00:01.000Z',
          },
        ],
      }),
    });
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_bad_status_turn',
        goal: `刚才那个 ${outputPath.split('\\').at(-1)} 文件任务现在是什么状态？`,
        latestInstruction: 'status question',
        status: 'blocked',
        unfinished: true,
        receipts: [],
      }),
    });

    const query = '刚才那个 Lumi主程序实机验收_20260816.txt 文件任务现在是什么状态？请只根据持久任务账本和回执回答，告诉我路径、是否写入后回读、编码、行数以及最终状态，不要执行新工具。';
    expect(findConversationActionTask(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })?.id).toBe('task_named_artifact');
    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    });
    expect(status).toContain(`路径：${outputPath}`);
    expect(status).toContain('写入：已验证（write_file）');
    expect(status).toContain('写入后回读：是（read_file）');
    expect(status).toContain('编码：UTF-8');
    expect(status).toContain('总行数：3');
    expect(status).toContain('最终状态：已完成（持久回执已验证）');
  });

  it('separates source reading from target readback in a three-step artifact status', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_three_step_artifact', userId: 'user_three_step_artifact', domain: 'personal', orgId: '' };
    const sourcePath = 'C:\\Users\\test-user\\Documents\\source.txt';
    const outputPath = 'C:\\Users\\test-user\\Documents\\report.md';
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_three_step_artifact',
        goal: `\u8bfb\u53d6 ${sourcePath}\uff0c\u521b\u5efa ${outputPath}\uff0c\u518d\u56de\u8bfb\u3002`,
        latestInstruction: `\u8bfb\u53d6 ${sourcePath}\uff0c\u521b\u5efa ${outputPath}\uff0c\u518d\u56de\u8bfb\u3002`,
        sourcePaths: [sourcePath, outputPath],
        status: 'completed',
        unfinished: false,
        completionSource: 'tool_receipt',
        receipts: [{
          id: 'source_read',
          key: 'source_read',
          name: 'read_file',
          arguments: { path: sourcePath },
          result: '\u9a8c\u6536\u5bf9\u8c61\uff1aLumi \u4e3b\u7a0b\u5e8f',
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'source returned content' },
          recordedAt: '2026-08-17T00:00:00.000Z',
        }, {
          id: 'target_write',
          key: 'target_write',
          name: 'write_file',
          arguments: { path: outputPath },
          result: `File written: ${outputPath}`,
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'artifact exists' },
          recordedAt: '2026-08-17T00:00:01.000Z',
        }, {
          id: 'target_readback',
          key: 'target_readback',
          name: 'read_file',
          arguments: { path: outputPath },
          result: '# \u62a5\u544a\n\u9a8c\u6536\u5bf9\u8c61\uff1aLumi \u4e3b\u7a0b\u5e8f',
          receipt: { kind: 'text_readback_metadata', encoding: 'UTF-8', lineCount: 2 },
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'target readback returned content' },
          recordedAt: '2026-08-17T00:00:02.000Z',
        }],
      }),
    });

    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '\u8bf7\u5217\u51fa\u6e90\u6587\u4ef6\u8bfb\u53d6\u3001\u76ee\u6807\u5199\u5165\u3001\u76ee\u6807\u56de\u8bfb\u4e09\u6b65\u72b6\u6001\uff0c\u5e76\u62a5\u544a\u7f16\u7801\u548c\u603b\u884c\u6570\u3002',
    });
    expect(status).toContain(`\u6e90\u6587\u4ef6\u8bfb\u53d6\uff1a\u5df2\u9a8c\u8bc1\uff08read_file\uff0c${sourcePath}\uff09`);
    expect(status).toContain('\u5199\u5165\uff1a\u5df2\u9a8c\u8bc1\uff08write_file\uff09');
    expect(status).toContain('\u5199\u5165\u540e\u56de\u8bfb\uff1a\u662f\uff08read_file\uff09');
    expect(status).toContain('\u7f16\u7801\uff1aUTF-8');
    expect(status).toContain('\u603b\u884c\u6570\uff1a2');
  });

  it('answers a recent desktop-open receipt question with the concrete target', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_open', userId: 'user_open', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_open',
        goal: '\u6253\u5f00\u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u3002',
        latestInstruction: '\u6253\u5f00\u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u3002',
        appTarget: '\u8bb0\u4e8b\u672c',
        receipts: [{
          id: 'open_receipt',
          key: 'desktop_open:notepad',
          name: 'desktop_open',
          arguments: { target: '\u8bb0\u4e8b\u672c' },
          result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'target matched' },
          recordedAt: '2026-08-16T00:00:00.000Z',
        }],
      }),
    });

    expect(formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '\u521a\u624d\u6253\u5f00\u4e86\u4ec0\u4e48\uff1f\u53ea\u6839\u636e\u56de\u6267\u56de\u7b54\u3002',
    })).toBe('\u521a\u624d\u6253\u5f00\u7684\u662f\u8bb0\u4e8b\u672c\uff0c\u5df2\u901a\u8fc7\u7a97\u53e3\u56de\u6267\u786e\u8ba4\u3002');
  });

  it('selects a named desktop task ahead of a newer client navigation and reports verified window identity', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_named_desktop', userId: 'user_named_desktop', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_calculator',
        goal: '\u6253\u5f00 Windows \u8ba1\u7b97\u5668\uff0c\u5e76\u6838\u9a8c\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u3002',
        latestInstruction: '\u6253\u5f00 Windows \u8ba1\u7b97\u5668\uff0c\u5e76\u6838\u9a8c\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u3002',
        appTarget: 'Windows \u8ba1\u7b97\u5668',
        receipts: [
          {
            id: 'calculator_open',
            key: 'desktop_open:calculator',
            name: 'desktop_open',
            arguments: { target: '\u8ba1\u7b97\u5668' },
            result: JSON.stringify({
              ok: true,
              status: 'verified',
              targetMatched: true,
              actualTarget: { processName: 'ApplicationFrameHost.exe', title: '\u8ba1\u7b97\u5668' },
            }),
            error: '',
            outcome: 'success',
            terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'target matched' },
            recordedAt: '2026-08-17T04:39:00.000Z',
          },
          {
            id: 'calculator_active_window',
            key: 'desktop_active_window:{}',
            name: 'desktop_active_window',
            arguments: {},
            result: JSON.stringify({ process_name: 'ApplicationFrameHost.exe', title: '\u8ba1\u7b97\u5668' }),
            error: '',
            outcome: 'success',
            terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'active window returned' },
            recordedAt: '2026-08-17T04:39:01.000Z',
          },
        ],
      }),
    });
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_command_center',
        goal: '\u6253\u5f00 Lumi \u6307\u6325\u4e2d\u5fc3\u3002',
        latestInstruction: '\u6253\u5f00 Lumi \u6307\u6325\u4e2d\u5fc3\u3002',
        appTarget: 'command-center',
        receipts: [{
          id: 'command_center_open',
          key: 'client_action:command-center',
          name: 'client_action',
          arguments: { action: 'open_command_center' },
          result: JSON.stringify({ ok: true, verification: { status: 'verified' } }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'surface rendered' },
          recordedAt: '2026-08-17T04:41:00.000Z',
        }],
      }),
    });

    const query = '\u6253\u5f00 Windows \u8ba1\u7b97\u5668\u7684\u4efb\u52a1\u6700\u7ec8\u72b6\u6001\u662f\u4ec0\u4e48\uff1f\u8bf7\u544a\u8bc9\u6211\u51c6\u786e\u76ee\u6807\u3001\u5b9e\u9645\u8fdb\u7a0b\u3001\u5b9e\u9645\u7a97\u53e3\u6807\u9898\u3001\u662f\u5426\u7cbe\u786e\u5339\u914d\u548c\u6700\u7ec8\u72b6\u6001\u3002';
    expect(findConversationActionTask(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })?.id).toBe('task_calculator');
    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    });
    expect(status).toContain('\u51c6\u786e\u76ee\u6807\uff1aWindows \u8ba1\u7b97\u5668');
    expect(status).toContain('\u5b9e\u9645\u8fdb\u7a0b\uff1aApplicationFrameHost.exe');
    expect(status).toContain('\u5b9e\u9645\u7a97\u53e3\u6807\u9898\uff1a\u8ba1\u7b97\u5668');
    expect(status).toContain('\u7cbe\u786e\u5339\u914d\uff1a\u662f');
    expect(status).toContain('\u6700\u7ec8\u72b6\u6001\uff1a\u5df2\u5b8c\u6210');
  });

  it('selects a named completed client surface ahead of a newer navigation task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_named_client_surface', userId: 'user_named_client_surface', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_home',
        goal: '返回 Lumi 个人主页。',
        latestInstruction: '返回 Lumi 个人主页。',
        appTarget: 'home',
        status: 'completed',
        unfinished: false,
        completionSource: 'tool_receipt',
        receipts: [{
          id: 'home_open',
          key: 'client_action:focus_home',
          name: 'client_action',
          arguments: { action: 'focus_home' },
          result: JSON.stringify({
            ok: true,
            action: 'focus_home',
            target: 'home',
            verification: { status: 'verified' },
          }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'home surface rendered' },
          recordedAt: '2026-08-17T09:00:00.000Z',
        }],
      }),
    });
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_newer_command_center',
        goal: '打开 Lumi 指挥中心。',
        latestInstruction: '打开 Lumi 指挥中心。',
        appTarget: 'command-center',
        status: 'completed',
        unfinished: false,
        completionSource: 'tool_receipt',
        receipts: [{
          id: 'command_center_open_newer',
          key: 'client_action:open_command_center',
          name: 'client_action',
          arguments: { action: 'open_command_center' },
          result: JSON.stringify({
            ok: true,
            action: 'open_command_center',
            target: 'command-center',
            verification: {
              status: 'verified',
              before: { activeTab: 'home', openSurfaces: ['home'] },
              after: { activeTab: 'command-center', openSurfaces: ['command-center'] },
            },
          }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'command center rendered' },
          recordedAt: '2026-08-17T09:01:00.000Z',
        }],
      }),
    });

    const query = '刚才“返回 Lumi 个人主页”的任务最终状态是什么？请只根据持久任务账本和真实回执回答，说明执行动作、目标页面和验证状态。不要执行任何新工具。';
    expect(findConversationActionTask(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })?.id).toBe('task_home');
    expect(formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })).toBe([
      '执行动作：focus_home',
      '目标页面：home',
      '验证状态：verified',
      '最终状态：已完成（持久回执已验证）',
    ].join('\n'));
  });

  it('explains a prior verified client action from its durable receipt without requiring a new tool call', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = {
      id: 'conv_client_evidence_followup',
      userId: 'user_client_evidence_followup',
      domain: 'personal',
      orgId: '',
    };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_open_voice_settings',
        goal: '打开 Lumi 设置里的语音与声音。',
        latestInstruction: '打开 Lumi 设置里的语音与声音。',
        appTarget: 'settings',
        status: 'completed',
        unfinished: false,
        completionSource: 'tool_receipt',
        receipts: [{
          id: 'voice_settings_open',
          key: 'client_action:open_settings:voice',
          name: 'client_action',
          arguments: { action: 'open_settings', section: 'voice' },
          result: JSON.stringify({
            ok: true,
            action: 'open_settings',
            target: 'settings',
            section: 'voice',
            verification: {
              status: 'verified',
              matched: ['surface:settings:open', 'settings-section:voice'],
            },
          }),
          error: '',
          outcome: 'success',
          terminalVerification: {
            status: 'verified',
            strategy: 'state_diff',
            reason: 'voice settings rendered',
          },
          recordedAt: '2026-08-23T02:11:56.394Z',
        }],
      }),
    });

    const query = 'What did you just do, and what evidence proved it succeeded?';
    expect(formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })).toBe([
      'Executed action: open_settings',
      'Target: settings',
      'Target section: voice',
      'Verification status: verified',
      'Verification evidence: surface:settings:open; settings-section:voice',
      'Final status: completed (durable receipt verified)',
    ].join('\n'));
    expect(formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '你刚才做了什么，什么证据证明成功了？',
    })).toBe([
      '执行动作：open_settings',
      '目标页面：settings',
      '目标分区：voice',
      '验证状态：verified',
      '验证依据：surface:settings:open、settings-section:voice',
      '最终状态：已完成（持久回执已验证）',
    ].join('\n'));
  });

  it('does not let an older verified action hide the most recent failed action', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = {
      id: 'conv_latest_failed_action',
      userId: 'user_latest_failed_action',
      domain: 'personal',
      orgId: '',
    };
    syncConversationActionTaskLedger(db, {
      conversation,
      now: '2026-08-23T02:00:00.000Z',
      state: actionState({
        taskId: 'task_older_verified_action',
        goal: 'Open Settings.',
        latestInstruction: 'Open Settings.',
        appTarget: 'settings',
        receipts: [{
          id: 'older_verified_action',
          key: 'client_action:open_settings',
          name: 'client_action',
          arguments: { action: 'open_settings' },
          result: JSON.stringify({
            ok: true,
            action: 'open_settings',
            target: 'settings',
            verification: { status: 'verified' },
          }),
          error: '',
          outcome: 'success',
          terminalVerification: {
            status: 'verified',
            strategy: 'state_diff',
            reason: 'settings rendered',
          },
          recordedAt: '2026-08-23T02:00:00.000Z',
        }],
      }),
    });
    syncConversationActionTaskLedger(db, {
      conversation,
      now: '2026-08-23T02:01:00.000Z',
      state: actionState({
        taskId: 'task_latest_failed_action',
        goal: 'Open Voice & Sound.',
        latestInstruction: 'Open Voice & Sound.',
        appTarget: 'voice',
        status: 'blocked',
        unfinished: true,
        completionSource: undefined,
        latestBlocker: 'client_action: target state was not verified',
        receipts: [{
          id: 'latest_failed_action',
          key: 'client_action:open_settings:voice',
          name: 'client_action',
          arguments: { action: 'open_settings', section: 'voice' },
          result: JSON.stringify({ ok: false, verification: { status: 'failed' } }),
          error: 'target state was not verified',
          outcome: 'failure',
          terminalVerification: {
            status: 'failed',
            strategy: 'state_diff',
            reason: 'voice section did not render',
          },
          recordedAt: '2026-08-23T02:01:00.000Z',
        }],
      }),
    });

    const query = 'What did you just do, and what evidence proved it succeeded?';
    expect(findConversationActionTask(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })?.id).toBe('task_latest_failed_action');
    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    });
    expect(status).toContain('Final status: blocked — target state was not verified');
    expect(status).toContain('Verification status: failed');
    expect(status).not.toContain('open_settings');
    expect(status).not.toContain('durable receipt verified');
  });

  it('does not promote one verified client step into completion for a blocked multi-step task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = {
      id: 'conv_verified_client_step_then_blocked',
      userId: 'user_verified_client_step_then_blocked',
      domain: 'personal',
      orgId: '',
    };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_verified_client_step_then_blocked',
        goal: '打开设置，再完成后续核验。',
        latestInstruction: '打开设置，再完成后续核验。',
        appTarget: 'settings',
        status: 'blocked',
        unfinished: true,
        completionSource: undefined,
        latestBlocker: 'desktop_active_window: active window could not be verified',
        receipts: [{
          id: 'verified_settings_step',
          key: 'client_action:open_settings',
          name: 'client_action',
          arguments: { action: 'open_settings' },
          result: JSON.stringify({
            ok: true,
            action: 'open_settings',
            target: 'settings',
            verification: { status: 'verified', matched: ['surface:settings:open'] },
          }),
          error: '',
          outcome: 'success',
          terminalVerification: {
            status: 'verified',
            strategy: 'state_diff',
            reason: 'settings rendered',
          },
          recordedAt: '2026-08-23T02:00:00.000Z',
        }, {
          id: 'failed_followup_verification',
          key: 'desktop_active_window:failed',
          name: 'desktop_active_window',
          arguments: {},
          result: JSON.stringify({ ok: false, verification: { status: 'failed' } }),
          error: 'active window could not be verified',
          outcome: 'failure',
          terminalVerification: {
            status: 'failed',
            strategy: 'visual',
            reason: 'active window could not be verified',
          },
          recordedAt: '2026-08-23T02:00:01.000Z',
        }],
      }),
    });

    const status = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: '你刚才做了什么，什么证据证明成功了？',
    });
    expect(status).toContain('执行动作：open_settings');
    expect(status).toContain('验证状态：verified');
    expect(status).toContain('还没完成');
    expect(status).not.toContain('最终状态：已完成（持久回执已验证）');

    const englishStatus = formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query: 'What did you just do, and what evidence proved it succeeded?',
    });
    expect(englishStatus).toContain('Final status: blocked — active window could not be verified');
    expect(englishStatus).not.toContain('Final status: completed (durable receipt verified)');
  });

  it('reports verified WPS document, body readback, and unsaved state from the durable receipt', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_wps', userId: 'user_wps', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_wps',
        status: 'cancelled',
        goal: '\u6253\u5f00 WPS\uff0c\u65b0\u5efa Word \u6587\u6863\u5e76\u5199\u5165\u9a8c\u6536\u6b63\u6587',
        latestInstruction: '\u6253\u5f00 WPS\uff0c\u65b0\u5efa Word \u6587\u6863\u5e76\u5199\u5165\u9a8c\u6536\u6b63\u6587',
        appTarget: 'WPS',
        receipts: [{
          id: 'wps_receipt',
          key: 'wps_create_document_with_text:verified',
          name: 'wps_create_document_with_text',
          arguments: { text: 'Lumi WPS' },
          result: JSON.stringify({
            ok: true,
            status: 'verified',
            automation: 'KWPS.Application',
            processName: 'wps.exe',
            processId: 17472,
            documentCreated: true,
            documentName: '\u6587\u5b57\u6587\u7a3f1',
            windowTitle: '\u6587\u5b57\u6587\u7a3f1 - WPS Office',
            exactTextMatch: true,
            charactersRequested: 8,
            charactersReadBack: 8,
            saved: false,
            savePath: '',
          }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'exact body readback' },
          recordedAt: '2026-08-17T09:33:00.000Z',
        }],
      }),
    });
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_newer_command_center',
        goal: '\u8bf7\u6253\u5f00 Lumi \u6307\u6325\u4e2d\u5fc3\uff0c\u53ea\u6267\u884c\u5ba2\u6237\u7aef\u5bfc\u822a\u3002',
        latestInstruction: '\u8bf7\u6253\u5f00 Lumi \u6307\u6325\u4e2d\u5fc3\uff0c\u53ea\u6267\u884c\u5ba2\u6237\u7aef\u5bfc\u822a\u3002',
        appTarget: 'command-center',
        updatedAt: '2026-08-17T09:34:00.000Z',
        receipts: [{
          id: 'command_center_receipt',
          key: 'client_action:command-center',
          name: 'client_action',
          arguments: { action: 'open_command_center' },
          result: JSON.stringify({ ok: true, status: 'verified', activeTab: 'command-center' }),
          error: '',
          outcome: 'success',
          terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'command center visible' },
          recordedAt: '2026-08-17T09:34:00.000Z',
        }],
      }),
    });

    const query = '\u6253\u5f00 WPS \u7684\u4efb\u52a1\u6700\u7ec8\u72b6\u6001\u662f\u4ec0\u4e48\uff1f\u8bf4\u660e\u6587\u6863\u3001\u6b63\u6587\u9a8c\u8bc1\u548c\u4fdd\u5b58\u72b6\u6001\u3002';
    expect(formatConversationActionLedgerStatus(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
      query,
    })).toBe([
      '\u6587\u6863\uff1a\u6587\u5b57\u6587\u7a3f1',
      '\u7a97\u53e3\uff1a\u6587\u5b57\u6587\u7a3f1 - WPS Office',
      '\u8fdb\u7a0b\uff1awps.exe (PID 17472)',
      '\u6b63\u6587\u9a8c\u8bc1\uff1a\u5df2\u9a8c\u8bc1\uff08\u5199\u5165 8 \u5b57\u7b26\uff0c\u56de\u8bfb 8 \u5b57\u7b26\uff09',
      '\u4fdd\u5b58\u72b6\u6001\uff1a\u672a\u4fdd\u5b58',
      '\u6700\u7ec8\u72b6\u6001\uff1a\u5df2\u5b8c\u6210\uff08\u6301\u4e45\u56de\u6267\u5df2\u9a8c\u8bc1\uff09',
    ].join('\n'));
  });

  it('links a design follow-up to the CAD task and inherits its artifact context', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const conversation = { id: 'conv_2', userId: 'user_2', domain: 'personal', orgId: '' };
    syncConversationActionTaskLedger(db, {
      conversation,
      state: actionState({
        taskId: 'task_parent',
        goal: '在 AutoCAD 中画完平面图',
        latestInstruction: '在 AutoCAD 中画完平面图',
        sourcePaths: ['D:\\drawings\\source.png', 'D:\\drawings\\plan.dwg'],
      }),
    });
    const child = syncConversationActionTaskLedger(db, {
      conversation,
      userText: '画完后再出设计方案',
      state: actionState({
        taskId: 'task_child',
        status: 'planning',
        goal: '画完后再出设计方案',
        latestInstruction: '画完后再出设计方案',
        unfinished: true,
        completionSource: undefined,
      }),
    });
    expect(child?.parentTaskId).toBe('task_parent');
    expect(JSON.parse(String(child?.context)).inheritedArtifacts).toEqual(expect.arrayContaining([
      'D:\\drawings\\source.png',
      'D:\\drawings\\plan.dwg',
    ]));
  });

  it('repairs the historical verified client-action receipts misclassified by failed-zero diagnostics', () => {
    const db: any = { conversations: [], conversationActionTasks: [], conversationActionReceipts: [] };
    const goal = '\u8fdb\u5165\u58c1\u7eb8\u6a21\u5f0f';
    const result = JSON.stringify({
      ok: true,
      action: 'set_wallpaper_mode',
      verification: { status: 'verified', matched: ['surface:wallpaper:open'] },
      health: { failed: 0 },
    });
    const conversation: any = { id: 'conv_repair', userId: 'user_repair', domain: 'personal', orgId: '' };
    const state = actionState({
      taskId: 'task_repair',
      goal,
      latestInstruction: goal,
      status: 'blocked',
      unfinished: true,
      latestBlocker: result,
      activeRequestId: 'request_repair',
      completionSource: undefined,
      receipts: [{
        id: 'receipt_repair',
        key: 'client_action:{"action":"set_wallpaper_mode","enabled":true}',
        name: 'client_action',
        arguments: { action: 'set_wallpaper_mode', enabled: true },
        result,
        error: result,
        outcome: 'failure',
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'The receipt contains verified post-action state.',
        },
        recordedAt: '2026-08-08T12:42:09.107Z',
      }],
    });
    conversation.actionContinuationState = state;
    db.conversations.push(conversation);
    syncConversationActionTaskLedger(db, {
      conversation,
      state,
      currentUserMessageId: 'turn_repair',
    });

    expect(repairContradictoryConversationActionReceipts(db)).toBe(1);
    expect(db.conversationActionReceipts[0].outcome).toBe('verified_success');
    expect(db.conversationActionTasks[0]).toMatchObject({
      status: 'completed',
      blocker: '',
      completionSource: 'tool_receipt',
    });
    expect(getConversationActionStateFromLedger(db, {
      conversationId: conversation.id,
      userId: conversation.userId,
    })).toMatchObject({
      status: 'completed',
      unfinished: false,
    });
  });

  it('deduplicates an exactly confirmed external commit by idempotency key', async () => {
    const registry = new ToolRegistry();
    let sends = 0;
    registry.register({
      name: 'wechat_send_message',
      description: 'Send an external message.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: 'messaging.send',
        family: 'messaging',
        lane: 'messaging',
        operation: 'communicate',
        risk: 'high',
        sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
        verification: {
          strategy: 'provider_ack',
          required: true,
          requiredFields: ['status'],
          successSignals: ['verified'],
          limitations: [],
        },
      },
      handler: async () => {
        sends += 1;
        return JSON.stringify({ sent: true, verificationStatus: 'verified' });
      },
    } as any);
    const context: any = {
      userId: 'user_3',
      taskId: 'task_send',
      idempotencyKey: 'fixed-key',
      userConfirmed: true,
      actionIntent: '给张勇发 明天见',
    };
    const args = { contact: '张勇', message: '明天见' };
    const first = await registry.execute('wechat_send_message', args, context);
    const second = await registry.execute('wechat_send_message', args, context);
    expect(JSON.parse(first).sent).toBe(true);
    expect(second).toBe(first);
    expect(sends).toBe(1);
  });
});
