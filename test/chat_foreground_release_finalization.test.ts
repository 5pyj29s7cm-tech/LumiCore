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
  convergeChatForegroundRequestBeforeRelease,
  type ChatForegroundRequestIdentity,
} from '../server/socket/chat';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareChatRequest(label: string): ChatForegroundRequestIdentity {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `chat-release-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Run the ${label} task.`;
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
    channel: 'chat',
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

function taskFor(identity: ChatForegroundRequestIdentity): any {
  return readDB().conversationActionTasks.find((row: any) => (
    row.id === identity.expectedTaskId
    && row.conversationId === identity.conversationId
    && row.userId === identity.userId
  ));
}

describe('chat foreground release convergence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('blocks and quarantines a non-aborted executor before resource release', async () => {
    const identity = prepareChatRequest('blocked');
    const result = await convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'Chat executor left without an assistant terminal.',
    });

    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: false, reason: 'nonterminal_task_still_active' },
      finalization: {
        requestedOutcome: 'blocked',
        effectiveOutcome: 'blocked',
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

  it('cancels an aborted executor before resource release', async () => {
    const identity = prepareChatRequest('cancelled');
    const result = await convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: true,
      reason: 'Chat request was aborted.',
    });

    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: false },
      finalization: {
        requestedOutcome: 'cancelled',
        effectiveOutcome: 'cancelled',
        taskStatus: 'cancelled',
        actionTurnStatus: 'cancelled',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'cancelled', activeRequestId: '' });
  });

  it('accepts a durable natural assistant failure as the request terminal while keeping task resumable', async () => {
    const identity = prepareChatRequest('natural-failure');
    const assistantMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'assistant',
      content: '这次没有完成处理，已经停止，你可以直接继续说。',
      requestId: identity.requestId,
      domain: 'personal',
      source: 'test',
      channel: 'chat',
      cognitiveIntent: 'chat_execution_failed',
      llmWasCalled: false,
    });

    const result = await convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: false,
    });
    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: true, finalStatus: 'terminal' },
      finalization: null,
    });
    expect(taskFor(identity)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
    });
  });

  it('finalizes the task when an assistant row exists but its execution lease was not settled', async () => {
    const identity = prepareChatRequest('assistant-before-task-settlement');
    const assistantMessageId = `assistant-${identity.requestId}`;
    const db = readDB();
    const now = new Date().toISOString();
    db.interactions.push({
      id: assistantMessageId,
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      message: 'The executor returned text before settling its durable task.',
      response: '',
      role: 'assistant',
      requestId: identity.requestId,
      domain: 'personal',
      source: 'test',
      channel: 'chat',
      timestamp: now,
      receivedAt: now,
    });
    writeDB(db);

    const result = await convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: false,
      reason: 'Assistant text existed but the durable task still owned the request lease.',
    });
    expect(result).toMatchObject({
      converged: true,
      convergence: {
        converged: false,
        finalStatus: 'terminal',
        assistantMessageId,
      },
      finalization: {
        requestedOutcome: 'blocked',
        effectiveOutcome: 'blocked',
        taskStatus: 'blocked',
        actionTurnStatus: 'terminal',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
      leaseOwnerId: '',
    });
  });

  it('keeps a taskless Chat identity retryable across a strict flush exception', async () => {
    const nonce = `${Date.now()}-${Math.random()}`;
    const userId = `chat-release-taskless-${nonce}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-taskless-${nonce}`;
    const userText = 'Hello, introduce yourself briefly.';
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
      channel: 'chat',
    });
    expect(prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText,
      requestId,
      userMessageId,
      toolPolicy: TOOL_POLICY,
    })).toMatchObject({ kind: 'conversation', state: null });
    const identity: ChatForegroundRequestIdentity = Object.freeze({
      conversationId: conversation.id,
      userId,
      requestId,
    });
    const assistantMessageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Hello, I am Lumi.',
      requestId,
      domain: 'personal',
      source: 'test',
      channel: 'chat',
    });
    let flushCalls = 0;
    const flush = async () => {
      flushCalls += 1;
      if (flushCalls === 1) throw new Error('taskless Chat flush failed');
    };

    await expect(convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: false,
    }, { flush })).rejects.toThrow('taskless Chat flush failed');
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
    });
    expect(await convergeChatForegroundRequestBeforeRelease({
      identity,
      aborted: false,
    }, { flush })).toMatchObject({
      converged: true,
      convergence: { reason: 'already_converged' },
      finalization: null,
    });
    expect(flushCalls).toBe(2);
  });

  it('places convergence before desktop/serial release and persists ordinary failures as assistant responses', () => {
    const source = readFileSync('server/socket/chat.ts', 'utf8');
    const releaseStart = source.indexOf('const chatReleaseGate = createDurableForegroundReleaseGate({');
    const convergeAt = source.indexOf('convergeChatForegroundRequestBeforeRelease({', releaseStart);
    const durableSuccessAt = source.indexOf('if (!releaseResult.converged)', convergeAt);
    const transportReleaseAt = source.indexOf('releaseResources: releaseChatTransportResources', durableSuccessAt);
    const transportHelperStart = source.indexOf('const releaseChatTransportResources = (): void => {');
    const desktopReleaseAt = source.indexOf('releaseDesktopControlLease?.();', transportHelperStart);
    const serialReleaseAt = source.indexOf('sessionLease.release();', transportHelperStart);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(convergeAt).toBeGreaterThan(releaseStart);
    expect(durableSuccessAt).toBeGreaterThan(convergeAt);
    expect(transportReleaseAt).toBeGreaterThan(durableSuccessAt);
    expect(transportHelperStart).toBeGreaterThan(-1);
    expect(desktopReleaseAt).toBeGreaterThan(transportHelperStart);
    expect(serialReleaseAt).toBeGreaterThan(desktopReleaseAt);

    const ordinaryFailureStart = source.indexOf('console.error("[Socket Agent Error]:", error);');
    const ordinaryFailureEnd = source.indexOf('} finally {', ordinaryFailureStart);
    const ordinaryFailure = source.slice(ordinaryFailureStart, ordinaryFailureEnd);
    expect(ordinaryFailure).toContain('persistAssistantMessage: () => addMessageIdempotent({');
    expect(ordinaryFailure).toContain("role: 'assistant'");
    expect(ordinaryFailure).toContain('CN_VOICE_WORK_MESSAGES.processingFailed');
    expect(ordinaryFailure).not.toContain("event: 'agent:error'");
  });
});
