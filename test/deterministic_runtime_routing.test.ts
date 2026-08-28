import { describe, expect, it } from 'vitest';
import {
  buildPendingAssistantOfferContextFromTranscript,
  createPendingRuntimeCleanupOffer,
  resolvePendingRuntimeCleanupOffer,
} from '../server/cognition/pending_assistant_offer';
import { classifyRuntimeWorkIntent } from '../server/cognition/runtime_work_intent';
import { routeToolsForTurn } from '../server/cognition/tool_router';

function declaration(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const TOOLS = [
  'runtime_work_status',
  'runtime_work_cancel',
  'desktop_running_processes',
  'database_query',
  'run_command',
].map(declaration);

describe('deterministic runtime-work routing', () => {
  it('does not turn a negated status-output constraint into a status command', () => {
    const text = 'Write the requested file exactly once. Do not report task status. Stop when confirmation is required.';
    expect(classifyRuntimeWorkIntent(text)).toBe('none');
    const route = routeToolsForTurn(text, TOOLS);
    expect(route.toolNames).not.toEqual(['runtime_work_status']);
    expect(route.categories).not.toEqual(['task_control']);
  });

  it('still honors a positive runtime command after a negated status-output clause', () => {
    expect(classifyRuntimeWorkIntent('Do not report task status; cancel the current task.')).toBe('cancel');
  });

  it.each([
    '\u6e05\u7406\u4e00\u4e0b',
    '\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1',
    '\u6e05\u7406\u4e0a\u8ff0\u4efb\u52a1',
  ])('does not grant cancel-all authority without an adjacent frozen offer: %s', text => {
    expect(classifyRuntimeWorkIntent(text)).toBe('none');
    const route = routeToolsForTurn(text, TOOLS);
    expect(route.toolNames).not.toContain('runtime_work_cancel');
    expect(route.forbiddenToolNames).toContain('runtime_work_cancel');
  });

  it.each([
    '你现在后台在执行什么',
    '显示有四个在执行',
    '显示你有四个在执行',
  ])('routes the observed status wording through only the runtime ledger: %s', text => {
    expect(classifyRuntimeWorkIntent(text)).toBe('status');
    const route = routeToolsForTurn(text, TOOLS);
    expect(route.toolNames).toEqual(['runtime_work_status']);
    expect(route.categories).toEqual(['task_control']);
    expect(route.hardAllowlist).toBe(true);
    expect(route.maxIterations).toBe(1);
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining([
      'runtime_work_cancel',
      'desktop_running_processes',
      'database_query',
      'run_command',
    ]));
  });

  it('accepts cleanup only from the explicitly adjacent assistant offer', () => {
    const now = Date.parse('2026-08-27T00:00:00.000Z');
    const offer = createPendingRuntimeCleanupOffer({
      assistantText: '我看到有四个任务在执行，要不要我帮你清理这些后台任务？',
      scope: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        assistantTurnId: 'assistant-turn-7',
      },
      targetTaskIds: ['runtime-task-1'],
      now,
    });
    expect(offer).not.toBeNull();

    const context = {
      offer,
      userId: 'user-1',
      conversationId: 'conversation-1',
      previousAssistantTurnId: 'assistant-turn-7',
      now: now + 1_000,
    };
    expect(resolvePendingRuntimeCleanupOffer('清理一下', context)).toMatchObject({
      intent: 'cancel',
      toolCall: { name: 'runtime_work_cancel', arguments: { taskIds: ['runtime-task-1'] } },
    });
    expect(classifyRuntimeWorkIntent('清理一下', context)).toBe('cancel');

    const route = routeToolsForTurn('清理一下', TOOLS, {
      pendingAssistantOfferContext: context,
    });
    expect(route.toolNames).toEqual(['runtime_work_cancel']);
    expect(route.hardAllowlist).toBe(true);
    expect(route.forbiddenToolNames).toEqual(expect.arrayContaining([
      'runtime_work_status',
      'database_query',
      'run_command',
    ]));
  });

  it('does not adopt a stale, unrelated, or implicit cleanup offer', () => {
    const now = Date.parse('2026-08-27T00:00:00.000Z');
    expect(createPendingRuntimeCleanupOffer({
      assistantText: '我可以整理一下说明。',
      scope: { conversationId: 'conversation-1', assistantTurnId: 'assistant-turn-1' },
      targetTaskIds: ['runtime-task-1'],
      now,
    })).toBeNull();

    const offer = createPendingRuntimeCleanupOffer({
      assistantText: '需要我清理这些后台任务吗？',
      scope: { conversationId: 'conversation-1', assistantTurnId: 'assistant-turn-1' },
      targetTaskIds: ['runtime-task-1'],
      now,
    });
    expect(classifyRuntimeWorkIntent('清理一下', {
      offer,
      conversationId: 'conversation-1',
      previousAssistantTurnId: 'assistant-turn-2',
      now: now + 1_000,
    })).toBe('none');
    expect(classifyRuntimeWorkIntent('清理一下', {
      offer,
      conversationId: 'another-conversation',
      previousAssistantTurnId: 'assistant-turn-1',
      now: now + 1_000,
    })).toBe('none');
    expect(classifyRuntimeWorkIntent('清理一下', {
      offer,
      conversationId: 'conversation-1',
      previousAssistantTurnId: 'assistant-turn-1',
      now: now + 3 * 60_000,
    })).toBe('none');
  });

  it('derives cleanup authority only from the immediately adjacent durable assistant turn and task', () => {
    const now = Date.parse('2026-08-27T00:01:00.000Z');
    const assistant = {
      id: 'assistant-adjacent',
      role: 'assistant',
      message: '\u8981\u4e0d\u8981\u6211\u5e2e\u4f60\u6e05\u7406\u8fd9\u4e9b\u540e\u53f0\u4efb\u52a1\uff1f',
      timestamp: '2026-08-27T00:00:30.000Z',
      toolCalls: [{
        name: 'runtime_work_status',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          items: [{ id: 'runtime-task-1', controls: { canCancel: true } }],
        }),
        error: '',
        terminalVerification: { status: 'verified' },
      }],
    };
    const context = buildPendingAssistantOfferContextFromTranscript({
      messages: [
        { id: 'user-before', role: 'user', message: 'status', timestamp: '2026-08-27T00:00:00.000Z' },
        assistant,
      ],
      userId: 'user-1',
      conversationId: 'conversation-1',
      taskId: 'task-1',
      now,
    });
    expect(classifyRuntimeWorkIntent('\u6e05\u7406\u4e00\u4e0b', context)).toBe('cancel');
    expect(resolvePendingRuntimeCleanupOffer('\u6e05\u7406\u4e00\u4e0b', {
      ...context,
      taskId: 'task-2',
    })).toBeNull();

    expect(buildPendingAssistantOfferContextFromTranscript({
      messages: [
        assistant,
        { id: 'intervening-user', role: 'user', message: 'another turn', timestamp: '2026-08-27T00:00:40.000Z' },
      ],
      userId: 'user-1',
      conversationId: 'conversation-1',
      taskId: 'task-1',
      now,
    })).toBeUndefined();
  });

  it('binds the production cleanup wording to the frozen cancellable ids', () => {
    const now = Date.parse('2026-08-28T06:37:50.000Z');
    const context = buildPendingAssistantOfferContextFromTranscript({
      messages: [{
        id: 'assistant-production-offer',
        role: 'assistant',
        message: '\u53e6\u5916\u53f0\u8d26\u91cc\u8fd8\u6709 51 \u4e2a\u5386\u53f2\u963b\u585e\u8bb0\u5f55\uff0c\u591a\u4e3a\u65e7\u4efb\u52a1\u7684\u9057\u7559\u6807\u8bb0\u3002\u6216\u8005\u4f60\u60f3\u6e05\u6389\u90a3\u4e9b\u5931\u8d25/\u963b\u585e\u7684\u65e7\u4efb\u52a1\uff0c\u4e5f\u53ef\u4ee5\u8bf4\u4e00\u58f0\u3002',
        timestamp: '2026-08-28T06:37:30.000Z',
        toolCalls: [{
          name: 'runtime_work_status',
          result: JSON.stringify({
            ok: true,
            items: [
              { id: 'runtime-task-a', controls: { canCancel: true } },
              { id: 'runtime-task-complete', controls: { canCancel: false } },
              { id: 'runtime-task-b', controls: { canCancel: true } },
            ],
          }),
          error: '',
          terminalVerification: { status: 'verified' },
          envelope: { status: 'verified_success' },
        }],
      }],
      userId: 'user-production',
      conversationId: 'conversation-production',
      taskId: 'conversation-task-production',
      now,
    });

    expect(resolvePendingRuntimeCleanupOffer('\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1', context)).toMatchObject({
      intent: 'cancel',
      toolCall: {
        name: 'runtime_work_cancel',
        arguments: { taskIds: ['runtime-task-a', 'runtime-task-b'] },
      },
    });
  });
});
