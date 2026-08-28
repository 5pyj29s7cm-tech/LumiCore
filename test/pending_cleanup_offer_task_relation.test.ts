import './helpers';
import { describe, expect, it } from 'vitest';
import {
  buildPendingAssistantOfferContextFromTranscript,
  createPendingRuntimeCleanupOffer,
  resolvePendingRuntimeCleanupOffer,
  runtimeCleanupTargetTaskIdsFromAssistantTurn,
  type PendingAssistantOfferContext,
} from '../server/cognition/pending_assistant_offer';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
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
  declaration('runtime_work_cancel'),
  declaration('runtime_work_status'),
  declaration('run_command'),
];

function validContext(now: number): PendingAssistantOfferContext {
  const offer = createPendingRuntimeCleanupOffer({
    assistantText: '\u662f\u5426\u5e2e\u4f60\u6e05\u7406\u8fd9\u4e9b\u540e\u53f0\u4efb\u52a1\uff1f',
    scope: {
      userId: 'offer-user',
      domain: 'work',
      orgId: 'offer-org',
      conversationId: 'offer-conversation',
      taskId: 'conversation-task',
      assistantTurnId: 'assistant-offer-turn',
    },
    targetTaskIds: ['background-a', 'background-b'],
    now,
  });
  expect(offer).not.toBeNull();
  return {
    offer,
    userId: 'offer-user',
    domain: 'work',
    orgId: 'offer-org',
    conversationId: 'offer-conversation',
    taskId: 'conversation-task',
    previousAssistantTurnId: 'assistant-offer-turn',
    now: now + 1_000,
  };
}

describe('pending cleanup offer task relation', () => {
  const now = Date.parse('2026-08-27T08:00:00.000Z');
  const state = {
    version: 2 as const,
    taskId: 'conversation-task',
    revision: 3,
    goal: 'Inspect active background work.',
    latestInstruction: 'Inspect active background work.',
    appTarget: '',
    sourcePaths: [],
    latestBlocker: '',
    unfinished: true,
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    status: 'blocked' as const,
    updatedAt: new Date(now).toISOString(),
  };

  it('promotes only the exact adjacent offer acceptance to confirm and preserves target ids', () => {
    const context = validContext(now);
    expect(resolvePendingRuntimeCleanupOffer('\u6e05\u7406\u4e00\u4e0b', context)).toEqual({
      intent: 'cancel',
      offerId: context.offer?.id,
      toolCall: {
        name: 'runtime_work_cancel',
        arguments: { taskIds: ['background-a', 'background-b'] },
      },
    });
    expect(resolveActiveTaskMessageRelation('\u6e05\u7406\u4e00\u4e0b', state, {
      pendingAssistantOfferContext: context,
    })).toMatchObject({
      relation: 'continue',
      taskRelation: 'confirm',
      feedback: 'accept',
      binding: 'active_task',
      operation: 'verify',
      taskId: 'conversation-task',
    });
    expect(routeToolsForTurn('\u6e05\u7406\u4e00\u4e0b', TOOLS, {
      pendingAssistantOfferContext: context,
    })).toMatchObject({
      toolNames: ['runtime_work_cancel'],
      hardAllowlist: true,
      maxIterations: 1,
    });
  });

  it('uses the server-owned offer fence instead of stale rendered request metadata', () => {
    const context = validContext(now);
    expect(resolveActiveTaskMessageRelation('\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1', state, {
      pendingAssistantOfferContext: context,
      controlTargetRequestId: 'stale-rendered-request',
    })).toMatchObject({
      relation: 'continue',
      taskRelation: 'confirm',
      feedback: 'accept',
      binding: 'active_task',
      operation: 'verify',
      taskId: 'conversation-task',
    });
  });

  it.each([
    ['missing', undefined],
    ['expired', { ...validContext(now), now: now + 3 * 60_000 }],
    ['cross-conversation', { ...validContext(now), conversationId: 'other-conversation' }],
    ['cross-user', { ...validContext(now), userId: 'other-user' }],
    ['cross-domain', { ...validContext(now), domain: 'personal' }],
    ['cross-org', { ...validContext(now), orgId: 'other-org' }],
  ])('keeps referential cleanup fail-closed for %s offer authority', (_label, context) => {
    expect(resolvePendingRuntimeCleanupOffer('\u6e05\u7406\u4e00\u4e0b', context)).toBeNull();
    const relation = resolveActiveTaskMessageRelation('\u6e05\u7406\u4e00\u4e0b', state, {
      pendingAssistantOfferContext: context,
    });
    expect(relation.taskRelation).not.toBe('confirm');
    expect(relation.feedback).not.toBe('cancel');
    const route = routeToolsForTurn('\u6e05\u7406\u4e00\u4e0b', TOOLS, {
      pendingAssistantOfferContext: context,
    });
    expect(route.toolNames).not.toContain('runtime_work_cancel');
    expect(route.forbiddenToolNames).toContain('runtime_work_cancel');
  });

  it('rejects an offer whose conversation task changed while the accepted turn waited', () => {
    const context = validContext(now);
    const relation = resolveActiveTaskMessageRelation('\u6e05\u7406\u4e00\u4e0b', {
      ...state,
      taskId: 'newer-conversation-task',
    }, {
      pendingAssistantOfferContext: context,
    });
    expect(relation.taskRelation).not.toBe('confirm');
    expect(relation.taskId).toBe('newer-conversation-task');
  });

  it('does not create cancellation authority from prose without frozen verified targets', () => {
    expect(createPendingRuntimeCleanupOffer({
      assistantText: '\u662f\u5426\u5e2e\u4f60\u6e05\u7406\u8fd9\u4e9b\u540e\u53f0\u4efb\u52a1\uff1f',
      scope: {
        userId: 'offer-user',
        conversationId: 'offer-conversation',
        assistantTurnId: 'assistant-offer-turn',
      },
      targetTaskIds: [],
      now,
    })).toBeNull();
    expect(buildPendingAssistantOfferContextFromTranscript({
      messages: [{
        id: 'legacy-assistant-offer',
        role: 'assistant',
        message: '\u662f\u5426\u5e2e\u4f60\u6e05\u7406\u8fd9\u4e9b\u540e\u53f0\u4efb\u52a1\uff1f',
        timestamp: new Date(now).toISOString(),
      }],
      userId: 'offer-user',
      conversationId: 'offer-conversation',
      now: now + 1_000,
    })).toBeUndefined();
  });

  it('recovers frozen targets from a canonical envelope when the display result was truncated', () => {
    expect(runtimeCleanupTargetTaskIdsFromAssistantTurn({
      id: 'runtime-status-turn',
      role: 'assistant',
      toolCalls: [{
        name: 'runtime_work_status',
        result: '{"ok":true,"items":[',
        error: '',
        envelope: {
          status: 'verified_success',
          result: {
            ok: true,
            items: [
              { id: 'running-task', controls: { canCancel: true } },
              { id: 'terminal-task', controls: { canCancel: false } },
            ],
          },
        },
      }],
    })).toEqual(['running-task']);
  });
});
