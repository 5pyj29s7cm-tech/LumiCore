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
      toolCall: { name: 'runtime_work_cancel', arguments: {} },
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
      now,
    })).toBeNull();

    const offer = createPendingRuntimeCleanupOffer({
      assistantText: '需要我清理这些后台任务吗？',
      scope: { conversationId: 'conversation-1', assistantTurnId: 'assistant-turn-1' },
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
});
