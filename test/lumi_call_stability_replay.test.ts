import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { matchQuickCommand } from '../server/cognition/quick_commands';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs } from '../server/agents/nl_chainer';
import {
  findConversationActionTask,
  formatConversationActionLedgerStatus,
  syncConversationActionTaskLedger,
} from '../server/conversation/action_ledger';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';
import { ToolRegistry } from '../server/tools/registry';

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
