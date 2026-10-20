import './helpers';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, flushDBOrThrow, querySQL } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, getConversationForScope, prepareConversationActionExecution, setConversationActionExecutionStatus, settleConversationActionExecutionRequest, startConversationActionExecutionHeartbeat } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { resolveUserTurn } from '../server/cognition/turn_resolution';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { preparePlannedConversationExecution } from '../server/conversation/planned_execution';
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation } from '../server/socket/action_turn_durability';
import { buildTransportNeutralConfirmationScope, recordPendingConfirmationDurably, getPendingConfirmation, clearPendingConfirmationDurably, clearAllPendingConfirmationsForTests } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized, resetPendingConfirmationRepositoryForTests } from '../server/tools/pending_confirmation_repository';
import { RECONFIRMATION_REQUIRED_BLOCKER } from '../server/cognition/continuation/confirmation';
import { DesktopExecutionTracker } from '../server/desktop/execution_runtime';
import { buildDesktopExecutionPlan } from '../server/desktop/execution_plan';
import { executeConfirmedToolStep } from '../server/tools/confirmed_step';
import { executeVoiceConfirmedAndDeterministicTurn } from '../server/socket/voice/turn/execute_voice_confirmed_and_deterministic_turn';
import { toolRegistry } from '../server/tools/registry';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerInputTools } from '../server/tools/definitions/input_tools';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import type { NormalizedLLMResponse, ToolExecutionRecord } from '../server/tools/types';

const provider = vi.hoisted(() => vi.fn());
// Only the provider and native OS relay are offline adapters. Admission, task
// binding, encrypted one-time grants, registry and receipt persistence are real.
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => provider(...args),
  makeLLMCallStreaming: (...args: any[]) => provider(...args),
}));

beforeAll(async () => { await initDatabase(); registerDesktopTools(toolRegistry); registerInputTools(toolRegistry); });
beforeEach(async () => {
  clearAllPendingConfirmationsForTests();
  resetPendingConfirmationRepositoryForTests();
  await ensurePendingConfirmationPersistenceInitialized();
  provider.mockReset();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('VOICE_CONFIRMATION_FIXTURE_NETWORK_FORBIDDEN'));
});
afterEach(() => vi.restoreAllMocks());

const rootGoal = '我让你用网易云播放音乐给我听。';
const policy = { allowedTools: ['desktop_open', 'desktop_keyboard_press'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 };
async function waitingFixture() {
  const userId = 'voice-confirmation-' + randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const originRequestId = randomUUID();
  const userMessageId = addMessageIdempotent({ userId, conversationId, agentId: 'lumi', requestId: originRequestId,
    source: 'voice-fixture', channel: 'voice', domain: 'personal', orgId: '', role: 'user', content: rootGoal, deferActionPreparation: true });
  await flushDBOrThrow();
  const initial = prepareConversationActionExecution({ userId, conversationId, requestId: originRequestId,
    userMessageId, userText: rootGoal, toolPolicy: policy, forceTask: true });
  if (!initial.state?.taskId) throw new Error('Original task was not bound');
  const taskId = initial.state.taskId;
  setConversationActionExecutionStatus(conversationId, userId, 'waiting_confirmation', { requestId: originRequestId, assistantState: 'Switch to external mode and open the requested player?' });
  settleConversationActionExecutionRequest(conversationId, userId, originRequestId);
  await flushDBOrThrow();
  const taskScope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId, taskId });
  const channelScope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId });
  const pending = await recordPendingConfirmationDurably(userId, 'desktop_open', { target: '网易云音乐' }, 'voice', {
    ...taskScope, originRequestId, actionIntent: rootGoal, switchToExternalExecution: true, externalDesktopHandoff: true });
  return { userId, conversationId, taskId, originRequestId, pending, taskScope, channelScope };
}
async function accept(f: Awaited<ReturnType<typeof waitingFixture>>, userText: string) {
  const requestId = randomUUID();
  const admission = await admitAcceptedUserTurnDurably({
    persistAcceptedUserTurn: () => addMessageIdempotent({ userId: f.userId, conversationId: f.conversationId,
      agentId: 'lumi', requestId, source: 'voice-fixture', channel: 'voice', domain: 'personal', orgId: '', role: 'user', content: userText, deferActionPreparation: true }),
    flush: flushDBOrThrow, onPersistenceUnknown: () => { throw new Error('Isolated accepted turn was not durable'); },
  });
  if (!admission) throw new Error('Admission missing');
  const conversation = getConversationForScope(f.conversationId, f.userId, 'personal', '')!;
  const resolution = resolveUserTurn({ requestId, userText, state: conversation.actionContinuationState });
  const confirmation = await resolveAcceptedTurnConfirmation({ admission, userId: f.userId, userText,
    actionState: conversation.actionContinuationState, taskRelation: resolution.taskRelation, taskScope: f.taskScope, channelScope: f.channelScope });
  const execution = buildLumiExecutionPipeline({ requestId, userText, acceptedResolution: resolution,
    dispatch: { userId: f.userId, text: userText, continuationContext: confirmation.prompt,
      channel: 'voice', source: 'voice', domain: 'personal', orgId: '', operationMode: 'assistant', targetIsLumi: true },
    registry: toolRegistry, personalityToolPolicy: policy, actionTaskState: conversation.actionContinuationState,
    executionBoundary: 'trusted_local', source: 'voice' });
  return { requestId, userText, admission, conversation, resolution, confirmation, execution };
}

describe('repeated voice confirmation on the real durable task', () => {
  it('consumes the original exact grant once, keeps its root goal, and continues the media action', async () => {
    const f = await waitingFixture();
    const a = await accept(f, '确认，确认。');
    expect(a.resolution.taskRelation).toMatchObject({ feedback: 'accept', binding: 'active_task', taskId: f.taskId });
    expect(a.confirmation.pending?.id).toBe(f.pending.id);
    const wrong = await resolveAcceptedTurnConfirmation({ admission: a.admission, userId: f.userId, userText: a.userText,
      actionState: a.conversation.actionContinuationState, taskRelation: a.resolution.taskRelation,
      taskScope: { ...f.taskScope, channelId: 'conversation:another-conversation' },
      channelScope: { ...f.channelScope, channelId: 'conversation:another-conversation' } });
    expect(wrong.pending).toBeNull();
    expect(getPendingConfirmation(f.userId, f.taskScope)?.id).toBe(f.pending.id);
    const prepared = preparePlannedConversationExecution({ execution: a.execution, userId: f.userId,
      conversationId: f.conversationId, requestId: a.requestId, userMessageId: a.admission.persisted,
      userText: a.userText, pendingConfirmation: a.confirmation.pending, bindConversationTurn: true });
    if ('bindingFailure' in prepared) throw new Error(prepared.bindingFailure);
    expect(prepared.kind).toBe('resume');
    expect(prepared.state).toMatchObject({ taskId: f.taskId, goal: rootGoal, activeRequestId: a.requestId });
    await flushDBOrThrow();
    const controller = new AbortController();
    const heartbeat = startConversationActionExecutionHeartbeat({ userId: f.userId, conversationId: f.conversationId, requestId: a.requestId, abortController: controller });
    const receiptObserver = createConversationReceiptObserver({ userId: f.userId, conversationId: f.conversationId,
      taskId: f.taskId, requestId: a.requestId, turnRowId: prepared.turnRowId, domain: 'personal' }, () => true);
    const window = { processId: 4242, pid: 4242, processName: 'cloudmusic.exe', title: '网易云音乐' };
    const desktopRelay = vi.fn(async (name: string) => {
      if (name === 'desktop_open') return 'Focused running app 网易云音乐 (pid 4242, window "网易云音乐")';
      if (name === 'desktop_active_window') return JSON.stringify(window);
      if (name === 'desktop_keyboard_press' || name === 'desktop_set_wallpaper_mode') return JSON.stringify({ ok: true });
      throw new Error('Unexpected offline native command: ' + name);
    });
    const desktopExecutionTracker = new DesktopExecutionTracker(buildDesktopExecutionPlan({ text: rootGoal, lane: 'desktop_control' }));
    const observed: ToolExecutionRecord[] = [];
    const toolContext = { userId: f.userId, conversationId: f.conversationId, requestId: a.requestId, turnId: a.requestId,
      turnRowId: prepared.turnRowId, taskId: f.taskId, domain: 'personal' as const, orgId: '', authenticated: true,
      authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const,
      currentTurnExecutionRequested: true, trustedActionContinuation: true, source: 'voice',
      actionIntent: a.userText, routedTaskText: a.execution.turnIntent.flow.routeText, desktopRelay, desktopExecutionTracker,
      executionSignal: controller.signal, isCancelled: () => false,
      prepareSelectedToolCall: () => prepared.prepareSelectedToolCall!(controller.signal),
      onToolRecord: async (record: ToolExecutionRecord) => { observed.push(record); await receiptObserver.onToolRecord(record); },
      toolPolicy: a.execution.authorizationPolicy };
    provider.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'continue-original-player', name: 'desktop_keyboard_press',
      arguments: { key: 'media_play_pause', expectedProcessId: 4242 } }], finishReason: 'tool_calls' } satisfies NormalizedLLMResponse)
      .mockResolvedValue({ text: JSON.stringify({ answer: 'The player was opened and the media key dispatched; playback still needs verification.', goals: [] }), toolCalls: [], finishReason: 'stop' } satisfies NormalizedLLMResponse);
    const finishVoiceTerminal = vi.fn(async (_payload: any, _options?: any) => undefined);
    const context = { transcriptExecutionGuard: { action: 'allow' }, session: { userId: f.userId, agentId: 'lumi' },
      userText: a.userText, actionIntentText: a.userText, requestId: a.requestId, voiceScope: { domain: 'personal', orgId: '' },
      conversationTurn: { conversation: a.conversation }, recentVoiceHistory: [], actionTaskExecution: prepared,
      actionFollowupIntent: a.execution.actionFollowupIntent, executionPipeline: a.execution,
      pendingConfirmation: a.confirmation.pending, confirmationScope: a.confirmation.scope,
      turnFlow: a.execution.turnIntent.flow, toolContext, desktopExecutionTracker, routedToolPolicy: a.execution.authorizationPolicy,
      turnAuthorization: captureRequestAuthorization(() => true, 'Isolated request revoked'), pipelineAbort: controller,
      isCurrentTurn: () => true, voiceUserMessageId: a.admission.persisted, voiceSystemPrompt: 'Use genuine receipts; a media key does not prove audio playback.',
      provider: 'deepseek', voiceModel: 'isolated-normalized-provider', voiceInputTokenBudget: 20000, reasoningRoutePolicy: {},
      llmGetters: {}, finishVoiceTerminal, emitToolLifecycle: vi.fn(), formatToolResultForUi: (value: string) => value,
      taskAwareRecords: (records: ToolExecutionRecord[]) => records, observeVoiceTools: () => ({ onToolCall: async () => undefined }),
      persistVoiceLearning: vi.fn(), pendingConfirmationCreatedThisTurn: null };
    try {
      const result = await executeVoiceConfirmedAndDeterministicTurn(context as any);
      expect(result.terminal).toBe(true);
      expect(finishVoiceTerminal).toHaveBeenCalledOnce();
      expect(finishVoiceTerminal.mock.calls[0][0]).toMatchObject({ source: 'voice_confirmation', blocked: true });
      const aggregate = finishVoiceTerminal.mock.calls[0][0].toolCalls.find((record: ToolExecutionRecord) => record.name === 'desktop_execution_plan_receipt');
      expect(aggregate).toMatchObject({ taskId: f.taskId, requestId: a.requestId, turnId: a.requestId, turnRowId: prepared.turnRowId });
      expect(JSON.parse(aggregate.result).finalState).not.toBe('target_mismatch');
      expect(desktopRelay.mock.calls.filter(([name]) => name === 'desktop_open')).toHaveLength(1);
      expect(desktopRelay.mock.calls.filter(([name]) => name === 'desktop_keyboard_press')).toHaveLength(1);
      expect(provider).toHaveBeenCalled();
      expect(JSON.stringify(provider.mock.calls[0][0])).toContain(rootGoal);
      expect(observed.filter(record => record.name === 'desktop_open')).toHaveLength(1);
      expect(observed.filter(record => record.name === 'desktop_keyboard_press')).toHaveLength(1);
      for (const record of observed) expect(record).toMatchObject({ taskId: f.taskId, requestId: a.requestId, turnRowId: prepared.turnRowId });
      expect(getPendingConfirmation(f.userId, f.taskScope)).toBeNull();
      expect((await querySQL<any>('SELECT status FROM pending_tool_confirmations WHERE id = ?', [f.pending.id]))[0]?.status).toBe('consumed');
      const replay = await executeConfirmedToolStep({ registry: toolRegistry, userId: f.userId, pending: f.pending,
        scope: f.taskScope, id: 'replay-denied', context: toolContext });
      expect(replay.error).toContain('one-time confirmation');
      expect(replay.adapterStarted).not.toBe(true);
      expect(desktopRelay.mock.calls.filter(([name]) => name === 'desktop_open')).toHaveLength(1);
      const tasks = readDB().conversationActionTasks.filter((row: any) => row.userId === f.userId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ id: f.taskId, goal: rootGoal });
      const receipts = readDB().conversationActionReceipts.filter((row: any) => row.requestId === a.requestId);
      expect(receipts.filter((row: any) => ['desktop_open', 'desktop_keyboard_press'].includes(row.toolName))).toHaveLength(3);
      // Includes the canonical denied replay, never a second adapter dispatch.
    } finally { heartbeat.stop(); }
  });

  it('leaves a why complaint for the evidence/model path instead of inventing a task-status answer', async () => {
    const f = await waitingFixture();
    const a = await accept(f, '为什么没有控制，也没有正确的证据链？');
    expect(a.execution.normalizedIntent).toMatchObject({ kind: 'status_query', target: 'previous_action', sideEffectClass: 'none' });
    const finishVoiceTerminal = vi.fn(async (_payload: any, _options?: any) => undefined);
    const context = { transcriptExecutionGuard: { action: 'allow' }, session: { userId: f.userId, agentId: 'lumi' },
      userText: a.userText, actionIntentText: a.userText, requestId: a.requestId, voiceScope: { domain: 'personal', orgId: '' },
      conversationTurn: { conversation: a.conversation }, recentVoiceHistory: [], actionTaskExecution: { state: null },
      actionFollowupIntent: 'status', executionPipeline: a.execution, pendingConfirmation: null,
      turnFlow: a.execution.turnIntent.flow, finishVoiceTerminal, interruptedActivityResponse: null };
    const result = await executeVoiceConfirmedAndDeterministicTurn(context as any);
    expect(result).toEqual({ terminal: false, context });
    expect(finishVoiceTerminal).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(getPendingConfirmation(f.userId, f.taskScope)?.id).toBe(f.pending.id);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.userId)).toHaveLength(1);
  });

  it('keeps repeated confirmation behind the existing restart review fence when the exact grant is unavailable', async () => {
    const f = await waitingFixture();
    await clearPendingConfirmationDurably(f.userId, f.taskScope);
    setConversationActionExecutionStatus(f.conversationId, f.userId, 'blocked', { blocker: RECONFIRMATION_REQUIRED_BLOCKER, requestId: f.originRequestId });
    await flushDBOrThrow();
    const a = await accept(f, '确认，确认。');
    expect(a.resolution.taskRelation).toMatchObject({ feedback: 'status', taskId: f.taskId });
    expect(a.confirmation.pending).toBeNull();
    const finishVoiceTerminal = vi.fn(async (_payload: any) => undefined);
    const context = { transcriptExecutionGuard: { action: 'allow' }, session: { userId: f.userId, agentId: 'lumi' },
      userText: a.userText, actionIntentText: a.userText, requestId: a.requestId, voiceScope: { domain: 'personal', orgId: '' },
      conversationTurn: { conversation: a.conversation }, recentVoiceHistory: [], actionTaskExecution: { state: null },
      actionFollowupIntent: a.execution.actionFollowupIntent, executionPipeline: a.execution, pendingConfirmation: null,
      turnFlow: a.execution.turnIntent.flow, finishVoiceTerminal };
    const result = await executeVoiceConfirmedAndDeterministicTurn(context as any);
    expect(result.terminal).toBe(true);
    expect(finishVoiceTerminal).toHaveBeenCalledOnce();
    expect(finishVoiceTerminal.mock.calls[0][0]).toMatchObject({ source: 'voice_task_status', llmWasCalled: false });
    expect(provider).not.toHaveBeenCalled();
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.userId)).toHaveLength(1);
  });
});
