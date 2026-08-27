import './helpers';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
} from '../server/conversation/manager';
import {
  convergeVoiceForegroundRequestBeforeRelease,
  reservePriorityVoiceHandoff,
  type VoiceForegroundRequestIdentity,
} from '../server/socket/voice';
import { mergeInterruptedVoiceTurn } from '../server/socket/voice_turn_state';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import {
  buildTransportNeutralConfirmationScope,
  consumePendingConfirmationDurably,
  getPendingConfirmationDurably,
  recordPendingConfirmationDurably,
} from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareVoiceRequest(label: string): VoiceForegroundRequestIdentity {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `voice-release-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Run the ${label} voice task.`;
  const userMessageId = addMessageIdempotent({
    userId,
    agentId: 'lumi',
    conversationId: conversation.id,
    role: 'user',
    content: userText,
    requestId,
    deferActionPreparation: true,
    domain: 'personal',
    source: 'test',
    channel: 'voice',
  });
  const prepared = prepareConversationActionExecution({
    conversationId: conversation.id,
    userId,
    userText,
    requestId,
    userMessageId,
    toolPolicy: TOOL_POLICY,
    forceTask: true,
  });
  expect(prepared.state?.taskId).toBeTruthy();
  return Object.freeze({
    conversationId: conversation.id,
    userId,
    requestId,
    expectedTaskId: prepared.state!.taskId!,
  });
}

function taskFor(identity: VoiceForegroundRequestIdentity): any {
  return readDB().conversationActionTasks.find((row: any) => (
    row.id === identity.expectedTaskId
    && row.conversationId === identity.conversationId
    && row.userId === identity.userId
  ));
}

function buildPriorityHandoffSession(identity: VoiceForegroundRequestIdentity): any {
  return {
    activeForegroundRequestIdentity: identity,
    activeRoutingText: `Run the ${identity.expectedTaskId} voice task.`,
    pendingInterruptedTurn: null,
    activeTaskConversationId: identity.conversationId,
    activeTaskRequestId: identity.requestId,
    activeTaskId: identity.expectedTaskId,
    userId: identity.userId,
    bgGeneration: 1,
    isSpeaking: false,
    ttsPlaybackUntil: 0,
    isProcessing: true,
    isOrchestrating: true,
    inputQueue: [],
    accumulatedText: '',
    bargeinTimer: null,
    ttsAbortController: null,
    pipelineAbortController: new AbortController(),
    sidecarAbortController: null,
    sidecarGeneration: 0,
    sidecarHistory: [],
    isBackgroundWork: true,
    activeWorkStatus: 'executing',
    activeWorkStep: 'Executing the durable voice task.',
    activeWorkToolCalls: 0,
    workHeartbeatTimer: null,
    activeTurnRequestId: identity.requestId,
    activeTurnProvenance: null,
    ttsDecayTimers: [],
  };
}

describe('voice foreground release convergence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('blocks and quarantines a non-aborted voice executor before resource release', async () => {
    const identity = prepareVoiceRequest('blocked');
    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'Voice executor left without an assistant terminal.',
    });

    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: false, reason: 'nonterminal_task_still_active' },
      finalization: {
        requestedOutcome: 'blocked',
        taskStatus: 'blocked',
        actionTurnStatus: 'persistence_unknown',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'persistence_unknown',
      leaseOwnerId: '',
    });
  });

  it('cancels an aborted voice executor before resource release', async () => {
    const identity = prepareVoiceRequest('cancelled');
    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: true,
      reason: 'Voice request was cancelled.',
    });

    expect(result).toMatchObject({
      converged: true,
      finalization: {
        requestedOutcome: 'cancelled',
        effectiveOutcome: 'cancelled',
        taskStatus: 'cancelled',
        actionTurnStatus: 'cancelled',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'cancelled', activeRequestId: '' });
  });

  it('also converges a taskless action-turn binding instead of leaking its pending row', async () => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const userId = `voice-release-conversation-${nonce}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-conversation-${nonce}`;
    const userText = '你好，简单介绍一下自己。';
    const userMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: userText,
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
      source: 'test',
      channel: 'voice',
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText,
      requestId,
      userMessageId,
      toolPolicy: TOOL_POLICY,
    });
    expect(prepared).toMatchObject({ state: null, kind: 'conversation' });
    const identity: VoiceForegroundRequestIdentity = Object.freeze({
      conversationId: conversation.id,
      userId,
      requestId,
    });
    const assistantMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '你好，我是 Lumi。',
      requestId,
      domain: 'personal',
      source: 'voice',
      channel: 'voice',
    });

    let flushCalls = 0;
    const flush = async () => {
      flushCalls += 1;
      if (flushCalls === 1) throw new Error('conceptual Voice flush failed');
    };
    await expect(convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
    }, { flush })).rejects.toThrow('conceptual Voice flush failed');
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
    });
    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
    }, { flush });
    expect(result).toMatchObject({ converged: true });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
    });
    expect(readDB().conversations.find((row: any) => row.id === conversation.id)
      ?.pendingActionContinuation).toBeUndefined();
    expect(flushCalls).toBe(2);
  });

  it('uses exact assistant evidence to clear a task lease left active after transcript persistence', async () => {
    const identity = prepareVoiceRequest('assistant-active-task');
    const assistantMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'assistant',
      content: '这次没有完成，任务已停在可继续的位置。',
      requestId: identity.requestId,
      domain: 'personal',
      source: 'voice_error',
      channel: 'voice',
      cognitiveIntent: 'voice_processing_failed',
      llmWasCalled: false,
    });

    // Reproduce the historical split-brain seam: the exact action turn and
    // assistant row are terminal, but the task/live projection still owns the
    // request. The release helper must not stop after observing only the turn.
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === identity.expectedTaskId);
    const conversation = db.conversations.find((row: any) => row.id === identity.conversationId);
    expect(task).toBeTruthy();
    task.status = 'executing';
    task.activeRequestId = identity.requestId;
    task.completedAt = '';
    const taskContext = JSON.parse(String(task.context || '{}'));
    taskContext.actionState = {
      ...(taskContext.actionState || {}),
      taskId: identity.expectedTaskId,
      status: 'executing',
      unfinished: true,
      activeRequestId: identity.requestId,
    };
    task.context = JSON.stringify(taskContext);
    conversation.actionContinuationState = taskContext.actionState;
    conversation.pendingActionContinuation = {
      userText: 'Run the assistant-active-task voice task.',
      messageId: 'stale-pending-row',
      requestId: identity.requestId,
      updatedAt: new Date().toISOString(),
    };
    writeDB(db);

    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'Voice failure was already persisted naturally.',
      assistantState: '这次没有完成，任务已停在可继续的位置。',
    });

    expect(result.convergence).toMatchObject({ converged: true, assistantMessageId });
    expect(result.finalization).toBeNull();
    expect(taskFor(identity).status).toBe('blocked');
    expect(taskFor(identity).activeRequestId).toBe('');
    expect(readDB().conversations.find((row: any) => row.id === identity.conversationId)
      ?.pendingActionContinuation).toBeUndefined();
  });

  it('settles a verified success receipt before fallback finalization can downgrade it', async () => {
    const identity = prepareVoiceRequest('verified-success');
    const assistantMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'assistant',
      content: '检查已经完成，并且结果已验证。',
      requestId: identity.requestId,
      domain: 'personal',
      source: 'voice',
      channel: 'voice',
      cognitiveIntent: 'task_completed',
      llmWasCalled: false,
    });
    const verifiedReceipt = {
      id: `verified-${identity.requestId}`,
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
      terminalVerification: {
        status: 'verified',
        strategy: 'state_diff',
        reason: 'The exact state was read back after execution.',
      },
      recordedAt: new Date().toISOString(),
    };
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === identity.expectedTaskId);
    const conversation = db.conversations.find((row: any) => row.id === identity.conversationId);
    const taskContext = JSON.parse(String(task.context || '{}'));
    const executingState = {
      ...(taskContext.actionState || {}),
      taskId: identity.expectedTaskId,
      goal: '返回 Lumi 个人主页。',
      latestInstruction: '返回 Lumi 个人主页。',
      status: 'executing',
      unfinished: true,
      activeRequestId: identity.requestId,
      receipts: [verifiedReceipt],
    };
    expect(taskCompletionFromReceipts(executingState.goal, [verifiedReceipt] as any).complete).toBe(true);
    task.status = 'executing';
    task.activeRequestId = identity.requestId;
    task.completedAt = '';
    task.context = JSON.stringify({ ...taskContext, actionState: executingState });
    conversation.actionContinuationState = executingState;
    writeDB(db);

    const result = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      assistantState: '检查已经完成，并且结果已验证。',
    });

    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: true, assistantMessageId },
      finalization: null,
    });
    expect(taskFor(identity)).toMatchObject({
      status: 'completed',
      activeRequestId: '',
      completionSource: 'tool_receipt',
    });
  });

  it('keeps repeated blocked release convergence idempotent', async () => {
    const identity = prepareVoiceRequest('repeated-blocked-release');
    const assistantMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'assistant',
      content: 'The current request is blocked and can be resumed.',
      requestId: identity.requestId,
      domain: 'personal',
      source: 'voice',
      channel: 'voice',
      taskIntent: 'task',
      terminalTaskDisposition: {
        outcome: 'blocked',
        taskId: identity.expectedTaskId,
        requestId: identity.requestId,
        reason: 'The exact voice request reached a verified blocker.',
      },
    });
    const before = taskFor(identity);
    const beforeRevision = before.revision;
    const beforeContext = before.context;

    const first = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'First idempotent release.',
    });
    const second = await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'Repeated idempotent release.',
    });

    expect(first).toMatchObject({
      converged: true,
      convergence: { converged: true, assistantMessageId },
      finalization: null,
    });
    expect(second).toMatchObject({
      converged: true,
      convergence: { converged: true, assistantMessageId },
      finalization: null,
    });
    expect(taskFor(identity)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      revision: beforeRevision,
      context: beforeContext,
    });
  });

  it.each([
    {
      label: 'priority-confirmation',
      initialStatus: 'waiting_confirmation',
      releasedStatus: 'blocked',
      preserveInterruptedTurn: false,
      continuationText: '确认',
      forceResume: true,
    },
    {
      label: 'priority-correction',
      initialStatus: 'executing',
      releasedStatus: 'blocked',
      preserveInterruptedTurn: true,
      continuationText: '不是这个，改用桌面上的最终版。',
      forceResume: false,
    },
  ])('rebinds the same durable task after a $label handoff', async ({
    label,
    initialStatus,
    releasedStatus,
    preserveInterruptedTurn,
    continuationText,
    forceResume,
  }) => {
    const identity = prepareVoiceRequest(label);
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === identity.expectedTaskId);
    const conversation = db.conversations.find((row: any) => row.id === identity.conversationId);
    const taskContext = JSON.parse(String(task.context || '{}'));
    const activeState = {
      ...(taskContext.actionState || {}),
      taskId: identity.expectedTaskId,
      status: initialStatus,
      unfinished: true,
      activeRequestId: identity.requestId,
    };
    task.status = initialStatus;
    task.activeRequestId = identity.requestId;
    task.context = JSON.stringify({ ...taskContext, actionState: activeState });
    conversation.actionContinuationState = activeState;
    writeDB(db);
    const session = buildPriorityHandoffSession(identity);

    expect(await reservePriorityVoiceHandoff(session, preserveInterruptedTurn)).toBe(true);

    // Supersession is a known control transition: the old request is cancelled
    // with an explicit reason, while its durable task remains resumable.
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'cancelled',
      terminalReason: expect.stringMatching(/^superseded:/),
      leaseOwnerId: '',
    });
    expect(taskFor(identity).status).toBe(releasedStatus);
    expect(taskFor(identity).activeRequestId).toBe('');
    expect(taskFor(identity).status).not.toBe('cancelled');

    const merged = mergeInterruptedVoiceTurn(session.pendingInterruptedTurn, continuationText);
    const nextUserText = merged.routingText || continuationText;
    const nextRequestId = `request-${label}-continuation-${Date.now()}-${Math.random()}`;
    const nextUserMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'user',
      content: nextUserText,
      requestId: nextRequestId,
      deferActionPreparation: true,
      domain: 'personal',
      source: 'test',
      channel: 'voice',
    });
    const resumed = prepareConversationActionExecution({
      conversationId: identity.conversationId,
      userId: identity.userId,
      userText: nextUserText,
      requestId: nextRequestId,
      userMessageId: nextUserMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
      forceResume: forceResume || merged.usedInterruptedTurn,
    });

    expect(resumed).not.toHaveProperty('bindingFailure');
    expect(resumed).toMatchObject({
      kind: 'resume',
      state: {
        taskId: identity.expectedTaskId,
        activeRequestId: nextRequestId,
        unfinished: true,
      },
    });
    expect(resumed.state?.status).not.toBe('cancelled');
    expect(taskFor(identity)).toMatchObject({
      id: identity.expectedTaskId,
      activeRequestId: nextRequestId,
    });
    expect(taskFor(identity).status).not.toBe('cancelled');
    const resumedTaskContext = JSON.parse(String(taskFor(identity).context || '{}'));
    expect(resumedTaskContext.terminalPersistence).toBeUndefined();
    expect(resumedTaskContext.actionState?.terminalPersistence).toBeUndefined();
    expect(getConversationActionTurn({
      conversationId: identity.conversationId,
      userId: identity.userId,
      requestId: nextRequestId,
    })).toMatchObject({
      taskId: identity.expectedTaskId,
      status: 'leased',
    });

    // Model the superseded pipeline's delayed finally after the successor has
    // already acquired the same task. It must converge request-scoped and leave
    // the new owner untouched.
    expect(await convergeVoiceForegroundRequestBeforeRelease({
      identity,
      aborted: true,
      reason: 'Old voice pipeline reached its delayed finally.',
    })).toMatchObject({
      converged: true,
      convergence: { finalStatus: 'cancelled', converged: true },
      finalization: null,
    });
    expect(taskFor(identity)).toMatchObject({
      id: identity.expectedTaskId,
      activeRequestId: nextRequestId,
    });
  });

  it('preserves and consumes the exact durable confirmation across a priority handoff', async () => {
    const identity = prepareVoiceRequest('priority-durable-confirmation');
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === identity.expectedTaskId);
    const conversation = db.conversations.find((row: any) => row.id === identity.conversationId);
    const taskContext = JSON.parse(String(task.context || '{}'));
    const waitingState = {
      ...(taskContext.actionState || {}),
      taskId: identity.expectedTaskId,
      status: 'waiting_confirmation',
      unfinished: true,
      activeRequestId: identity.requestId,
    };
    task.status = 'waiting_confirmation';
    task.activeRequestId = identity.requestId;
    task.context = JSON.stringify({ ...taskContext, actionState: waitingState });
    conversation.actionContinuationState = waitingState;
    writeDB(db);

    await ensurePendingConfirmationPersistenceInitialized();
    const confirmationScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: identity.conversationId,
      taskId: identity.expectedTaskId,
    });
    const exactArgs = {
      action: 'set_client_mode',
      mode: 'focus',
      confirmed: false,
      options: { source: 'voice', preserveContext: true },
    };
    const pending = await recordPendingConfirmationDurably(
      identity.userId,
      'client_action',
      exactArgs,
      'voice',
      {
        ...confirmationScope,
        originRequestId: identity.requestId,
        actionIntent: 'Switch the client to focus mode.',
      },
    );

    expect(await reservePriorityVoiceHandoff(buildPriorityHandoffSession(identity), false)).toBe(true);

    expect(await getPendingConfirmationDurably(identity.userId, confirmationScope)).toMatchObject({
      id: pending.id,
      toolName: 'client_action',
      exactArgs,
      taskId: identity.expectedTaskId,
      originRequestId: identity.requestId,
    });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'cancelled',
      terminalReason: expect.stringMatching(/^superseded:/),
    });

    const nextRequestId = `request-priority-confirmation-${Date.now()}-${Math.random()}`;
    const nextUserText = '确认';
    const nextUserMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'user',
      content: nextUserText,
      requestId: nextRequestId,
      deferActionPreparation: true,
      domain: 'personal',
      source: 'test',
      channel: 'voice',
    });
    expect(prepareConversationActionExecution({
      conversationId: identity.conversationId,
      userId: identity.userId,
      userText: nextUserText,
      requestId: nextRequestId,
      userMessageId: nextUserMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
      forceResume: true,
    })).toMatchObject({
      kind: 'resume',
      state: {
        taskId: identity.expectedTaskId,
        activeRequestId: nextRequestId,
      },
    });
    expect(await consumePendingConfirmationDurably(
      identity.userId,
      pending.id,
      pending.toolName,
      pending.exactArgs,
      confirmationScope,
    )).toBe(true);
    expect(await consumePendingConfirmationDurably(
      identity.userId,
      pending.id,
      pending.toolName,
      pending.exactArgs,
      confirmationScope,
    )).toBe(false);
    expect(await getPendingConfirmationDurably(identity.userId, confirmationScope)).toBeNull();
  });

  it('keeps immutable identity and converges before fast-path, exception, cancel, and finally release', () => {
    const source = readFileSync('server/socket/voice.ts', 'utf8');

    const identityAt = source.indexOf('const foregroundRequestIdentity: VoiceForegroundRequestIdentity = Object.freeze({');
    const bindingFailureAt = source.indexOf("if ('bindingFailure' in actionTaskExecution)");
    const freezeAt = source.indexOf('Object.freeze({', identityAt);
    expect(identityAt).toBeGreaterThan(bindingFailureAt);
    expect(freezeAt).toBeGreaterThan(identityAt);
    expect(source.slice(identityAt, identityAt + 420)).toContain("? { expectedTaskId: actionTaskExecution.state.taskId }");
    const prepareTaskAt = source.indexOf('prepareConversationActionExecution({');
    expect(source.slice(prepareTaskAt, prepareTaskAt + 520))
      .toContain('|| interruptedMerge.usedInterruptedTurn');

    const publicHelperStart = source.indexOf('export async function convergeVoiceForegroundRequestBeforeRelease');
    const settleBeforeFinalizeAt = source.indexOf('settleConversationActionExecutionRequest(', publicHelperStart);
    const fallbackFinalizeAt = source.indexOf('const finalization = await finalizeForegroundRequestDurably({', publicHelperStart);
    expect(settleBeforeFinalizeAt).toBeGreaterThan(publicHelperStart);
    expect(fallbackFinalizeAt).toBeGreaterThan(settleBeforeFinalizeAt);
    expect(source.slice(fallbackFinalizeAt, fallbackFinalizeAt + 360))
      .toContain('assistantMessageId: convergence.assistantMessageId || undefined');

    const releaseStart = source.indexOf('const voiceReleaseGate = createDurableForegroundReleaseGate({');
    const convergeAt = source.indexOf('enforceVoiceForegroundConvergenceBeforeRelease({', releaseStart);
    const durableSuccessAt = source.indexOf('return Boolean(releaseResult?.converged);', convergeAt);
    const transportReleaseAt = source.indexOf('releaseResources: releaseVoiceTransportResources', durableSuccessAt);
    const transportHelperStart = source.indexOf('const releaseVoiceTransportResources = (): void => {');
    const heartbeatReleaseAt = source.indexOf('actionLeaseHeartbeat?.stop();', transportHelperStart);
    const desktopReleaseAt = source.indexOf("desktopRelay.releaseControlLease('voice_turn_complete');", transportHelperStart);
    const workLaneReleaseAt = source.indexOf('session.isProcessing = false;', transportHelperStart);
    const workHeartbeatReleaseAt = source.indexOf('stopVoiceWorkHeartbeat(session);', transportHelperStart);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(convergeAt).toBeGreaterThan(releaseStart);
    expect(durableSuccessAt).toBeGreaterThan(convergeAt);
    expect(transportReleaseAt).toBeGreaterThan(durableSuccessAt);
    expect(transportHelperStart).toBeGreaterThan(-1);
    expect(heartbeatReleaseAt).toBeGreaterThan(transportHelperStart);
    expect(desktopReleaseAt).toBeGreaterThan(heartbeatReleaseAt);
    expect(workLaneReleaseAt).toBeGreaterThan(desktopReleaseAt);
    expect(workHeartbeatReleaseAt).toBeGreaterThan(workLaneReleaseAt);

    expect(source).toContain("releaseVoiceTurnResources('Voice quick-command fast path completed.')");
    expect(source).toContain("releaseVoiceTurnResources('Voice model/tool pipeline reached its finally boundary.')");

    const outerFailureStart = source.indexOf("logger.error('[Voice Error]:', err);");
    const outerFailureEnd = source.indexOf('} finally {', outerFailureStart);
    const outerFailure = source.slice(outerFailureStart, outerFailureEnd);
    expect(outerFailure).toContain('persistAssistantMessage: () => addMessageIdempotent({');
    expect(outerFailure).toContain("role: 'assistant'");
    expect(outerFailure).toContain('CN_VOICE_WORK_MESSAGES.processingFailed');
    expect(outerFailure).not.toContain("socket.emit('agent:error'");

    const mainFailureStart = source.indexOf('logger.error("[Audio Error]:", err);');
    const mainFailureEnd = source.indexOf('} finally {', mainFailureStart);
    const mainFailure = source.slice(mainFailureStart, mainFailureEnd);
    expect(mainFailure).toContain('await commitVoiceTerminal({');
    expect(mainFailure).toContain('CN_VOICE_WORK_MESSAGES.processingFailed');
    expect(mainFailure).not.toContain("emitAgent('agent:error'");
    const voiceTerminalStart = source.indexOf('const commitVoiceTerminal = async');
    const voiceTerminalEnd = source.indexOf('const maxIterations =', voiceTerminalStart);
    expect(source.slice(voiceTerminalStart, voiceTerminalEnd))
      .toContain('persistVoiceAssistantMessage(');

    const cancelStart = source.indexOf('function cancelActiveVoiceTurn(');
    const cancelEnd = source.indexOf('\n}\n\n/**', cancelStart);
    const cancelBody = source.slice(cancelStart, cancelEnd);
    const supersedeAt = cancelBody.indexOf('supersedeConversationActionExecutionRequest({');
    expect(cancelBody.indexOf('enforceVoiceForegroundConvergenceBeforeRelease({')).toBeGreaterThan(-1);
    expect(supersedeAt).toBeGreaterThan(-1);
    expect(cancelBody.indexOf('session.pipelineAbortController.abort()'))
      .toBeGreaterThan(supersedeAt);
    expect(cancelBody.indexOf('session.isProcessing = false'))
      .toBeGreaterThan(cancelBody.indexOf('enforceVoiceForegroundConvergenceBeforeRelease({'));
  });
});
