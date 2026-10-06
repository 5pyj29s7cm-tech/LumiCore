import './helpers';
import { beforeAll, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  getOrCreateActiveConversation,
  getConversationSummary,
  getMessages,
  getTopicContext,
  startNewConversation,
} from '../server/conversation/manager';
import { extractSourceExpression } from './source_expression';
import { captureVoiceTurnOwner } from '../server/socket/voice_transport_runtime';
import { TASK_TARGET_HISTORY_LIMIT } from '../server/conversation/task_target_anchor';

beforeAll(async () => { await initDatabase(); });

it('keeps voice history on the admitted conversation after the user opens a new chat', async () => {
  const userId = 'voice-pinned-history-' + Date.now() + '-' + Math.random();
  const admitted = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const next = startNewConversation(userId, 'lumi', 'personal', '');
  expect(next.id).not.toBe(admitted.id);
  const summary = vi.fn(getConversationSummary);
  const topics = vi.fn(getTopicContext);
  const activeLookup = vi.fn(getOrCreateActiveConversation);
  const stopBeforeModelPlanning = new Error('stop before isolated model planning');
  const prepare = extractSourceExpression(
    'server/socket/voice/turn/prepare_voice_context_and_routing.ts',
    'prepareVoiceContextAndRouting', {
      logger: { info: vi.fn(), warn: vi.fn() },
      captureVoiceTurnOwner,
      isCapabilityMetaQuestion: () => true,
      hasExplicitToolIntent: () => false,
      startVoiceLatencyTrace: vi.fn(),
      detectRequestedOperationMode: () => undefined,
      hasClientActionOnlyIntent: () => false,
      isUserCorrectionOrExplanationQuestion: () => false,
      shouldAllowVoiceLocalFileWriteForTurn: () => false,
      isVoiceReferentialFollowup: () => true,
      personalityRegistry: { getForUser: () => undefined, getDefault: () => ({}) },
      getStoredOperationMode: () => 'assistant',
      toolRegistry: {},
      getMessages,
      TASK_TARGET_HISTORY_LIMIT,
      getOrCreateActiveConversation: activeLookup,
      getConversationSummary: summary,
      getTopicContext: topics,
      buildLumiExecutionPipeline: () => { throw stopBeforeModelPlanning; },
    },
  );
  await expect(prepare({
    userText: 'Tell me about the earlier conversation.',
    actionIntentText: 'Tell me about the earlier conversation.',
    actionContinuationBridge: 'admitted history',
    pendingConfirmationPrompt: '',
    conversationTurn: { conversation: admitted, rolledOver: false },
    requestId: 'voice-pinned-request',
    session: {
      userId, agentId: 'lumi', domain: 'personal', orgId: '',
      voiceTurnGeneration: 0, callControlGeneration: 0, sessionId: 'history-call', activeRoutingText: '', activeTurnRequestId: null,
    },
    voiceScope: { domain: 'personal', orgId: '' },
    toolSecurityContext: { executionBoundary: 'trusted_local' },
    transcriptExecutionGuard: { action: 'allow' },
    inputTiming: {},
    pipelineAbort: new AbortController(),
    executionReceipts: {},
    turnAuthorization: { assertCurrent: vi.fn() },
    resources: {},
    emitAgent: vi.fn(),
    socket: { emit: vi.fn() },
    sensoryFn: () => ({}),
  })).rejects.toBe(stopBeforeModelPlanning);
  expect(summary).toHaveBeenCalledExactlyOnceWith(admitted.id);
  expect(topics).toHaveBeenCalledExactlyOnceWith(admitted.id);
  expect(activeLookup).not.toHaveBeenCalled();
});
