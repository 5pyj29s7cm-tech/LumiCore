import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  bindConversationActionExecutionTurn,
  cancelConversationActionExecution,
  closeConversation,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  recoverOrphanedConversationActionExecutions,
  renewConversationActionExecutionLease,
  setConversationActionExecutionStatus,
  startConversationActionExecutionHeartbeat,
  CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS,
} from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { commitChatTerminalBoundary } from '../server/socket/chat_terminal_boundary';
import {
  classifyConversationActionFollowupIntent,
  formatConversationActionTaskStatus,
} from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import {
  buildTransportNeutralConfirmationScope,
  clearAllPendingConfirmationsForTests,
  getPendingConfirmation,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

const CUSTOMER_INTERNAL_EXECUTION_COPY = /(?:^|\n)\s*(?:\u72b6\u6001|\u8bc1\u636e|\u5177\u4f53\u963b\u585e|\u6267\u884c\u56de\u9988)\s*[:\uff1a]|\u56de\u6267|target_mismatch|terminalVerification|\b(?:taskId|requestId|desktop_open|client_action|desktop_execution_plan_receipt|verified|blocked|failed)\b|No successful current-turn tool execution/iu;

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 5,
};

function scope(label: string) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `manager-turn-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  return { userId, conversation };
}

function persistUser(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  text?: string;
}): string {
  return addMessageIdempotent({
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    role: 'user',
    content: input.text || 'Open the desktop application.',
    requestId: input.requestId,
    deferActionPreparation: true,
    domain: 'personal',
    source: 'test',
    channel: 'chat',
  });
}

function persistAssistant(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  text?: string;
}): string {
  return addMessageIdempotent({
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    role: 'assistant',
    content: input.text || 'Done.',
    requestId: input.requestId,
    domain: 'personal',
    source: 'test',
    channel: 'chat',
  });
}

function prepareWaitingConfirmation(label: string) {
  const current = scope(label);
  const requestId = `request-${label}`;
  const userText = 'Delete the selected temporary file after review.';
  const messageId = persistUser({
    userId: current.userId,
    conversationId: current.conversation.id,
    requestId,
    text: userText,
  });
  const prepared = prepareConversationActionExecution({
    conversationId: current.conversation.id,
    userId: current.userId,
    userText,
    requestId,
    userMessageId: messageId,
    toolPolicy: TOOL_POLICY,
    forceTask: true,
  });
  expect(prepared.state?.taskId).toBeTruthy();
  setConversationActionExecutionStatus(
    current.conversation.id,
    current.userId,
    'waiting_confirmation',
    { requestId, assistantState: 'Waiting for review of an exact action.' },
  );
  return {
    ...current,
    requestId,
    taskId: prepared.state!.taskId!,
    userText,
  };
}

describe('manager conversation action-turn integration', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    clearAllPendingConfirmationsForTests();
  });

  it('accepts the persisted user row exactly once and reconstructs acceptance on replay', () => {
    const { userId, conversation } = scope('accept');
    const requestId = 'request-accept';
    const messageId = persistUser({ userId, conversationId: conversation.id, requestId });
    const replayedId = persistUser({ userId, conversationId: conversation.id, requestId });

    expect(replayedId).toBe(messageId);
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({
        userMessageId: messageId,
        status: 'accepted',
        revision: 1,
      });
  });

  it('serializes different requests with the durable lease and unblocks the next after exact assistant commit', () => {
    const { userId, conversation } = scope('serial');
    const firstId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: 'request-first',
      text: 'First request',
    });
    const secondId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: 'request-second',
      text: 'Second request',
    });

    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'First request',
      requestId: 'request-first',
      userMessageId: firstId,
    })).toMatchObject({ requestId: 'request-first', messageId: firstId });
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'First request',
      requestId: 'request-first',
      userMessageId: firstId,
    })).toBeNull();
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Second request',
      requestId: 'request-second',
      userMessageId: secondId,
    })).toBeNull();

    const assistantId = persistAssistant({
      userId,
      conversationId: conversation.id,
      requestId: 'request-first',
    });
    const terminalTurn = getConversationActionTurn({
      conversationId: conversation.id,
      userId,
      requestId: 'request-first',
    });
    expect(terminalTurn).toMatchObject({ status: 'terminal', terminalMessageId: assistantId });
    expect(persistAssistant({
      userId,
      conversationId: conversation.id,
      requestId: 'request-first',
    })).toBe(assistantId);
    expect(getConversationActionTurn({
      conversationId: conversation.id,
      userId,
      requestId: 'request-first',
    })?.revision).toBe(terminalTurn?.revision);
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Second request',
      requestId: 'request-second',
      userMessageId: secondId,
    })).toMatchObject({ requestId: 'request-second' });
    persistAssistant({ userId, conversationId: conversation.id, requestId: 'request-second' });
  });

  it('uses pendingActionContinuation only as a projection, never as the lock', () => {
    const { userId, conversation } = scope('legacy-projection');
    conversation.pendingActionContinuation = {
      userText: 'orphaned legacy text',
      messageId: 'missing-message',
      requestId: 'orphaned-request',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    const requestId = 'request-current';
    const messageId = persistUser({ userId, conversationId: conversation.id, requestId });

    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Open the desktop application.',
      requestId,
      userMessageId: messageId,
    })).toMatchObject({ requestId });
    expect(conversation.pendingActionContinuation).toMatchObject({ requestId, messageId });
    persistAssistant({ userId, conversationId: conversation.id, requestId });
  });

  it('binds the task once and keeps the request lease until the waiting terminal is durable', () => {
    const { userId, conversation } = scope('confirmation');
    const requestId = 'request-confirmation';
    const messageId = persistUser({ userId, conversationId: conversation.id, requestId });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Delete the selected temporary file.',
      requestId,
      userMessageId: messageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    expect(prepared.state?.taskId).toBeTruthy();
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({ status: 'leased', taskId: prepared.state?.taskId });
    expect(renewConversationActionExecutionLease(conversation.id, userId, requestId)).toBe(true);

    setConversationActionExecutionStatus(
      conversation.id,
      userId,
      'waiting_confirmation',
      { requestId, assistantState: 'Waiting for confirmation.' },
    );
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({
        status: 'leased',
        taskId: prepared.state?.taskId,
      });
    expect(renewConversationActionExecutionLease(conversation.id, userId, requestId)).toBe(true);

    const assistantId = persistAssistant({
      userId,
      conversationId: conversation.id,
      requestId,
      text: 'Please confirm before I continue.',
    });
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({ status: 'terminal', terminalMessageId: assistantId });
    expect(renewConversationActionExecutionLease(conversation.id, userId, requestId)).toBe(false);
  });

  it('terminal_flush_failure_quarantines_action_turn_before_lease_release', async () => {
    const { userId, conversation } = scope('terminal-flush-quarantine');
    const requestId = 'request-terminal-flush-quarantine';
    const userText = 'Create the requested desktop artifact.';
    const userMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId,
      text: userText,
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
    const flush = vi.fn()
      .mockRejectedValueOnce(new Error('strict flush unavailable'))
      .mockResolvedValueOnce(undefined);
    const successReceipt = vi.fn(async () => true);
    const unknownReceipt = vi.fn(async () => true);

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => setConversationActionExecutionStatus(
        conversation.id,
        userId,
        'completed',
        { requestId, assistantState: 'STAGED_SUCCESS_PROJECTION' },
      ),
      persistAssistantMessage: () => addMessageIdempotent({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'STAGED_SUCCESS_PROJECTION',
        requestId,
        domain: 'personal',
        source: 'test',
        channel: 'chat',
        cognitiveIntent: 'completed',
        completionFeedback: { status: 'completed', completed: ['artifact created'] },
      }),
      flush,
      persistTerminalReceipt: successReceipt,
      persistUnknownReceipt: unknownReceipt,
      publishCommitted: vi.fn(),
      publishUnknown: vi.fn(),
      persistenceUnknownProjection: {
        text: 'SAFE_PERSISTENCE_UNKNOWN',
        completionFeedback: {
          status: 'unknown',
          incomplete: ['Terminal durability is unknown.'],
        },
        reason: 'Terminal persistence outcome is unknown.',
      },
    })).resolves.toBe(false);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(successReceipt).not.toHaveBeenCalled();
    expect(unknownReceipt).toHaveBeenCalledOnce();
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({
        status: 'persistence_unknown',
        leaseOwnerId: '',
        terminalMessageId: '',
      });
    expect(renewConversationActionExecutionLease(conversation.id, userId, requestId)).toBe(false);

    const db = readDB();
    const assistant = db.interactions.find((row: any) => (
      row.userId === userId
      && row.conversationId === conversation.id
      && row.role === 'assistant'
      && row.requestId === requestId
    ));
    const durableConversation = db.conversations.find((row: any) => (
      row.userId === userId && row.id === conversation.id
    ));
    const durableTask = db.conversationActionTasks.find((row: any) => row.id === prepared.state?.taskId);
    expect(assistant).toMatchObject({
      message: 'SAFE_PERSISTENCE_UNKNOWN',
      response: '',
      toolCalls: [],
      cognitiveIntent: 'persistence_unknown',
      completionFeedback: { status: 'unknown' },
    });
    expect(durableConversation.actionContinuationState).toMatchObject({
      taskId: prepared.state?.taskId,
      status: 'blocked',
      unfinished: true,
      terminalPersistence: { status: 'persistence_unknown', requestId },
    });
    expect(durableTask).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completionSource: '',
      completedAt: '',
    });
    expect(JSON.parse(durableTask.context)).toMatchObject({
      terminalPersistence: { status: 'persistence_unknown', requestId },
      actionState: {
        status: 'blocked',
        terminalPersistence: { status: 'persistence_unknown', requestId },
      },
    });

    expect(persistAssistant({
      userId,
      conversationId: conversation.id,
      requestId,
      text: 'A delayed replay must not republish success.',
    })).toBe(assistant.id);
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({ status: 'persistence_unknown', terminalMessageId: '' });
    expect(durableTask).toMatchObject({ status: 'blocked', completedAt: '' });
  });

  it('keeps the action lease busy while the terminal receipt is pending', async () => {
    const { userId, conversation } = scope('terminal-receipt-pending');
    const firstRequestId = 'request-terminal-receipt-pending-a';
    const secondRequestId = 'request-terminal-receipt-pending-b';
    const firstMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: firstRequestId,
      text: 'Run task A.',
    });
    const secondMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: secondRequestId,
      text: 'Run task B.',
    });
    prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Run task A.',
      requestId: firstRequestId,
      userMessageId: firstMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const receiptStarted = vi.fn();

    const terminal = commitChatTerminalBoundary({
      persistTerminalState: () => undefined,
      persistAssistantMessage: () => addMessageIdempotent({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Task A terminal.',
        requestId: firstRequestId,
        domain: 'personal',
        source: 'test',
        channel: 'chat',
      }),
      flush: async () => undefined,
      persistTerminalReceipt: async () => {
        receiptStarted();
        await receiptGate;
        return true;
      },
      persistUnknownReceipt: async () => true,
      publishCommitted: vi.fn(),
      publishUnknown: vi.fn(),
    });
    await vi.waitFor(() => expect(receiptStarted).toHaveBeenCalledOnce());

    expect(getConversationActionTurn({
      conversationId: conversation.id,
      userId,
      requestId: firstRequestId,
    })).toMatchObject({ status: 'leased' });
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Run task B.',
      requestId: secondRequestId,
      userMessageId: secondMessageId,
    })).toBeNull();

    releaseReceipt();
    await expect(terminal).resolves.toBe(true);
    expect(getConversationActionTurn({
      conversationId: conversation.id,
      userId,
      requestId: firstRequestId,
    })).toMatchObject({ status: 'terminal' });
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Run task B.',
      requestId: secondRequestId,
      userMessageId: secondMessageId,
    })).toMatchObject({ requestId: secondRequestId });
    persistAssistant({
      userId,
      conversationId: conversation.id,
      requestId: secondRequestId,
    });
  });

  it('terminal_receipt_failure_quarantines_before_releasing_the_action_lease', async () => {
    const { userId, conversation } = scope('terminal-receipt-failure');
    const requestId = 'request-terminal-receipt-failure';
    const userMessageId = persistUser({ userId, conversationId: conversation.id, requestId });
    prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open the desktop application.',
      requestId,
      userMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    const flush = vi.fn(async () => undefined);

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => undefined,
      persistAssistantMessage: () => addMessageIdempotent({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'UNRECEIPTED_SUCCESS',
        requestId,
        domain: 'personal',
        source: 'test',
        channel: 'chat',
      }),
      flush,
      persistTerminalReceipt: async () => { throw new Error('receipt fsync failed'); },
      persistUnknownReceipt: async () => true,
      publishCommitted: vi.fn(),
      publishUnknown: vi.fn(),
      persistenceUnknownProjection: { text: 'RECEIPT_PERSISTENCE_UNKNOWN' },
    })).resolves.toBe(false);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({ status: 'persistence_unknown', terminalMessageId: '' });
    const assistant = readDB().interactions.find((row: any) => (
      row.userId === userId
      && row.conversationId === conversation.id
      && row.role === 'assistant'
      && row.requestId === requestId
    ));
    expect(assistant).toMatchObject({
      message: 'RECEIPT_PERSISTENCE_UNKNOWN',
      cognitiveIntent: 'persistence_unknown',
    });
    expect(JSON.stringify(readDB())).not.toContain('UNRECEIPTED_SUCCESS');
  });

  it('duplicate_terminal_owner_settles_its_stage_without_republishing_or_leaking_the_lease', async () => {
    const { userId, conversation } = scope('duplicate-terminal-owner');
    const requestId = 'request-duplicate-terminal-owner';
    const userMessageId = persistUser({ userId, conversationId: conversation.id, requestId });
    prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open the desktop application.',
      requestId,
      userMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    const publishCommitted = vi.fn();
    const publishUnknown = vi.fn();

    await expect(commitChatTerminalBoundary({
      persistTerminalState: () => undefined,
      persistAssistantMessage: () => addMessageIdempotent({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Idempotent durable terminal.',
        requestId,
        domain: 'personal',
        source: 'test',
        channel: 'chat',
      }),
      flush: async () => undefined,
      // False is returned only after the shared durable terminal barrier owned
      // by the first identical handler has completed.
      persistTerminalReceipt: async () => false,
      persistUnknownReceipt: async () => true,
      publishCommitted,
      publishUnknown,
    })).resolves.toBe(false);

    expect(publishCommitted).not.toHaveBeenCalled();
    expect(publishUnknown).not.toHaveBeenCalled();
    expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
      .toMatchObject({ status: 'terminal', leaseOwnerId: '' });
    expect(renewConversationActionExecutionLease(conversation.id, userId, requestId)).toBe(false);
  });

  it.each(['task', 'voice'] as const)(
    '%s_terminal_flush_failure_cannot_later_persist_success_projection',
    async channel => {
      const { userId, conversation } = scope(`delayed-${channel}`);
      const requestId = `request-delayed-${channel}`;
      const userMessageId = persistUser({
        userId,
        conversationId: conversation.id,
        requestId,
        text: `Run the ${channel} task.`,
      });
      prepareConversationActionExecution({
        conversationId: conversation.id,
        userId,
        userText: `Run the ${channel} task.`,
        requestId,
        userMessageId,
        toolPolicy: TOOL_POLICY,
        forceTask: true,
      });
      const flush = vi.fn()
        .mockRejectedValueOnce(new Error('strict flush unavailable'))
        .mockResolvedValueOnce(undefined);

      await commitChatTerminalBoundary({
        persistTerminalState: () => setConversationActionExecutionStatus(
          conversation.id,
          userId,
          'completed',
          { requestId, assistantState: `FALSE_${channel.toUpperCase()}_SUCCESS` },
        ),
        persistAssistantMessage: () => addMessageIdempotent({
          userId,
          agentId: 'lumi',
          conversationId: conversation.id,
          role: 'assistant',
          content: `FALSE_${channel.toUpperCase()}_SUCCESS`,
          requestId,
          domain: 'personal',
          source: channel,
          channel,
          mode: channel,
          cognitiveIntent: 'completed',
          completionFeedback: { status: 'completed', completed: [`${channel} completed`] },
        }),
        flush,
        persistTerminalReceipt: async () => true,
        persistUnknownReceipt: async () => true,
        publishCommitted: vi.fn(),
        publishUnknown: vi.fn(),
        persistenceUnknownProjection: {
          text: `${channel.toUpperCase()}_PERSISTENCE_UNKNOWN`,
          completionFeedback: { status: 'unknown', incomplete: [`${channel} durability unknown`] },
        },
      });

      // A future debounced full snapshot sees the already-quarantined live
      // object. It cannot resurrect the text or completion projection staged
      // before the failed strict flush.
      const delayedSnapshot = structuredClone(readDB());
      const serialized = JSON.stringify(delayedSnapshot);
      expect(serialized).not.toContain(`FALSE_${channel.toUpperCase()}_SUCCESS`);
      const assistant = delayedSnapshot.interactions.find((row: any) => (
        row.userId === userId
        && row.conversationId === conversation.id
        && row.role === 'assistant'
        && row.requestId === requestId
      ));
      const turn = delayedSnapshot.conversationActionTurns.find((row: any) => (
        row.userId === userId
        && row.conversationId === conversation.id
        && row.requestId === requestId
      ));
      expect(assistant).toMatchObject({
        message: `${channel.toUpperCase()}_PERSISTENCE_UNKNOWN`,
        completionFeedback: { status: 'unknown' },
      });
      expect(turn).toMatchObject({ status: 'persistence_unknown', terminalMessageId: '' });
    },
  );

  it('darwin_restart_reconciles_orphaned_waiting_confirmation', () => {
    const waiting = prepareWaitingConfirmation('darwin-memory-only-orphan');
    // macOS intentionally has no durable exact-argument adapter. A fresh
    // process therefore starts with an empty in-memory confirmation store.
    clearAllPendingConfirmationsForTests();

    recoverOrphanedConversationActionExecutions('2026-08-27T03:00:00.000Z');

    const db = readDB();
    const durableConversation = db.conversations.find((item: any) => (
      item.id === waiting.conversation.id && item.userId === waiting.userId
    ));
    const durableTask = db.conversationActionTasks.find((item: any) => item.id === waiting.taskId);
    expect(durableConversation.actionContinuationState).toMatchObject({
      taskId: waiting.taskId,
      status: 'blocked',
      unfinished: true,
      activeRequestId: undefined,
    });
    expect(durableConversation.actionContinuationState.latestBlocker)
      .toMatch(/^reconfirmation_required:/);
    expect(durableConversation.actionContinuationState.goal).toBe(waiting.userText);
    expect(durableTask).toMatchObject({
      id: waiting.taskId,
      status: 'blocked',
      blocker: expect.stringMatching(/^reconfirmation_required:/),
      activeRequestId: '',
    });
  });

  it('confirmation_reply_after_memory_only_restart_requests_fresh_review', () => {
    const waiting = prepareWaitingConfirmation('darwin-fresh-review');
    clearAllPendingConfirmationsForTests();
    recoverOrphanedConversationActionExecutions('2026-08-27T03:05:00.000Z');

    const durableConversation = readDB().conversations.find((item: any) => (
      item.id === waiting.conversation.id && item.userId === waiting.userId
    ));
    const state = durableConversation.actionContinuationState;
    expect(classifyConversationActionFollowupIntent('确认', state)).toBe('status');
    expect(resolveActiveTaskMessageRelation('确认', state)).toMatchObject({
      relation: 'status',
      feedback: 'status',
      binding: 'active_task',
      operation: 'inspect',
      taskId: waiting.taskId,
    });
    const reply = formatConversationActionTaskStatus(state);
    expect(reply).toMatch(/没有(?:重新|再次)?执行旧操作|旧操作.*没有执行/u);
    expect(reply).toMatch(/重新(?:生成|展示)/u);
    expect(reply).toMatch(/(?:审阅|查看).*(?:再确认|重新确认)/u);
    expect(reply).not.toMatch(CUSTOMER_INTERNAL_EXECUTION_COPY);
  });

  it('preserves a hydrated exact confirmation across restart recovery', () => {
    const waiting = prepareWaitingConfirmation('dpapi-hydrated');
    const confirmationScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      orgId: '',
      conversationId: waiting.conversation.id,
      taskId: waiting.taskId,
    });
    const pending = recordPendingConfirmation(
      waiting.userId,
      'desktop_write_text_file',
      { path: 'C:\\Users\\Example\\Desktop\\approved.txt', content: 'approved' },
      'chat',
      confirmationScope,
    );

    recoverOrphanedConversationActionExecutions('2026-08-27T03:10:00.000Z');

    const db = readDB();
    const durableConversation = db.conversations.find((item: any) => (
      item.id === waiting.conversation.id && item.userId === waiting.userId
    ));
    const durableTask = db.conversationActionTasks.find((item: any) => item.id === waiting.taskId);
    expect(durableConversation.actionContinuationState).toMatchObject({
      taskId: waiting.taskId,
      status: 'waiting_confirmation',
      unfinished: true,
    });
    expect(durableTask).toMatchObject({ id: waiting.taskId, status: 'waiting_confirmation' });
    expect(getPendingConfirmation(waiting.userId, confirmationScope)?.id).toBe(pending.id);
  });

  it('keeps request A busy beyond the five-minute TTL while its executor heartbeat is alive', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T01:00:00.000Z'));
    const { userId, conversation } = scope('heartbeat-busy');
    const firstRequestId = 'request-heartbeat-a';
    const secondRequestId = 'request-heartbeat-b';
    const firstMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: firstRequestId,
      text: 'Run the long task A.',
    });
    const secondMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: secondRequestId,
      text: 'Run task B.',
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Run the long task A.',
      requestId: firstRequestId,
      userMessageId: firstMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    expect(prepared.state?.taskId).toBeTruthy();
    const controller = new AbortController();
    const heartbeat = startConversationActionExecutionHeartbeat({
      conversationId: conversation.id,
      userId,
      requestId: firstRequestId,
      abortController: controller,
    });

    try {
      await vi.advanceTimersByTimeAsync(300_001);
      expect(controller.signal.aborted).toBe(false);
      expect(getConversationActionTurn({
        conversationId: conversation.id,
        userId,
        requestId: firstRequestId,
      })?.leaseHeartbeatAt).toBe('2026-08-27T01:05:00.000Z');

      const competing = prepareConversationActionExecution({
        conversationId: conversation.id,
        userId,
        userText: 'Run task B.',
        requestId: secondRequestId,
        userMessageId: secondMessageId,
        toolPolicy: TOOL_POLICY,
        forceTask: true,
      });
      expect(competing).toMatchObject({
        state: null,
        bindingFailure: 'busy',
        diagnosticCode: 'conversation_action_turn_busy',
      });
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it('recovers an expired in-process owner instead of leaving an exact request permanently busy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T01:30:00.000Z'));
    const { userId, conversation } = scope('expired-manager-owner');
    const requestId = 'request-expired-manager-owner';
    const userText = 'Continue the exact accepted task after its abandoned executor expires.';
    const messageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId,
      text: userText,
    });
    const first = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText,
      requestId,
      userMessageId: messageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    expect(first.state?.taskId).toBeTruthy();

    const abandonedController = new AbortController();
    const heartbeat = startConversationActionExecutionHeartbeat({
      conversationId: conversation.id,
      userId,
      requestId,
      abortController: abandonedController,
    });
    heartbeat.stop();

    try {
      await vi.advanceTimersByTimeAsync(300_001);
      const retried = prepareConversationActionExecution({
        conversationId: conversation.id,
        userId,
        userText,
        requestId,
        userMessageId: messageId,
        toolPolicy: TOOL_POLICY,
        forceTask: true,
      });

      expect(abandonedController.signal.aborted).toBe(true);
      expect(retried).toMatchObject({
        kind: 'resume',
        state: { taskId: first.state?.taskId, activeRequestId: requestId },
      });
      expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
        .toMatchObject({ status: 'leased', taskId: first.state?.taskId });
      persistAssistant({ userId, conversationId: conversation.id, requestId });
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it('aborts an expired competing owner before a newer request acquires the conversation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T01:45:00.000Z'));
    const { userId, conversation } = scope('expired-competing-owner');
    const firstRequestId = 'request-expired-competing-a';
    const secondRequestId = 'request-expired-competing-b';
    const firstMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: firstRequestId,
      text: 'Run the abandoned first task.',
    });
    const secondMessageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId: secondRequestId,
      text: 'Run the newer replacement task.',
    });
    prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Run the abandoned first task.',
      requestId: firstRequestId,
      userMessageId: firstMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    const abandonedController = new AbortController();
    const heartbeat = startConversationActionExecutionHeartbeat({
      conversationId: conversation.id,
      userId,
      requestId: firstRequestId,
      abortController: abandonedController,
    });
    heartbeat.stop();

    try {
      await vi.advanceTimersByTimeAsync(300_001);
      const replacement = prepareConversationActionExecution({
        conversationId: conversation.id,
        userId,
        userText: 'Run the newer replacement task.',
        requestId: secondRequestId,
        userMessageId: secondMessageId,
        toolPolicy: TOOL_POLICY,
        forceTask: true,
        forceNewTask: true,
      });

      expect(abandonedController.signal.aborted).toBe(true);
      expect(replacement.state?.taskId).toBeTruthy();
      expect(getConversationActionTurn({
        conversationId: conversation.id,
        userId,
        requestId: secondRequestId,
      })).toMatchObject({ status: 'leased', taskId: replacement.state?.taskId });
      persistAssistant({ userId, conversationId: conversation.id, requestId: secondRequestId });
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it('aborts the executor and durably receipts persistence_unknown when renewal loses ownership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T02:00:00.000Z'));
    const { userId, conversation } = scope('heartbeat-loss');
    const requestId = 'request-heartbeat-loss';
    const messageId = persistUser({
      userId,
      conversationId: conversation.id,
      requestId,
      text: 'Run a task until its lease is lost.',
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Run a task until its lease is lost.',
      requestId,
      userMessageId: messageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    expect(prepared.state?.taskId).toBeTruthy();

    const controller = new AbortController();
    let executorRunning = true;
    controller.signal.addEventListener('abort', () => { executorRunning = false; }, { once: true });
    const receipt = vi.fn();
    const heartbeat = startConversationActionExecutionHeartbeat({
      conversationId: conversation.id,
      userId,
      requestId,
      abortController: controller,
      onPersistenceUnknown: receipt,
    });

    try {
      const db = readDB();
      const turn = db.conversationActionTurns.find((item: any) => (
        item.conversationId === conversation.id
        && item.userId === userId
        && item.requestId === requestId
      ));
      turn.leaseOwnerId = 'different-owner-after-cas-loss';
      writeDB(db);

      await vi.advanceTimersByTimeAsync(CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS);
      const loss = await heartbeat.leaseLoss;
      expect(controller.signal.aborted).toBe(true);
      expect(executorRunning).toBe(false);
      expect(heartbeat.isLeaseLost()).toBe(true);
      expect(loss).toMatchObject({
        conversationId: conversation.id,
        userId,
        requestId,
        status: 'persistence_unknown',
        persisted: true,
      });
      expect(receipt).toHaveBeenCalledOnce();
      expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
        .toMatchObject({
          status: 'persistence_unknown',
          terminalReason: loss.reason,
        });
      const durableConversation = readDB().conversations.find((item: any) => (
        item.id === conversation.id && item.userId === userId
      ));
      expect(durableConversation.actionContinuationState).toMatchObject({
        status: 'blocked',
        activeRequestId: undefined,
      });
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it('cancels the exact leased turn and cancels all open turns when the conversation closes', () => {
    const cancelledScope = scope('cancel');
    const cancelRequestId = 'request-cancel';
    const cancelMessageId = persistUser({
      userId: cancelledScope.userId,
      conversationId: cancelledScope.conversation.id,
      requestId: cancelRequestId,
    });
    const prepared = prepareConversationActionExecution({
      conversationId: cancelledScope.conversation.id,
      userId: cancelledScope.userId,
      userText: 'Open the desktop application.',
      requestId: cancelRequestId,
      userMessageId: cancelMessageId,
      toolPolicy: TOOL_POLICY,
      forceTask: true,
    });
    expect(prepared.state).toBeTruthy();
    cancelConversationActionExecution(
      cancelledScope.conversation.id,
      cancelledScope.userId,
      'Cancelled in test.',
      cancelRequestId,
    );
    expect(getConversationActionTurn({
      conversationId: cancelledScope.conversation.id,
      userId: cancelledScope.userId,
      requestId: cancelRequestId,
    })).toMatchObject({ status: 'cancelled', terminalReason: 'Cancelled in test.' });

    const closedScope = scope('close');
    const closeRequestId = 'request-close';
    const closeMessageId = persistUser({
      userId: closedScope.userId,
      conversationId: closedScope.conversation.id,
      requestId: closeRequestId,
    });
    bindConversationActionExecutionTurn({
      conversationId: closedScope.conversation.id,
      userId: closedScope.userId,
      userText: 'Open the desktop application.',
      requestId: closeRequestId,
      userMessageId: closeMessageId,
    });
    closeConversation(closedScope.conversation.id, '', closedScope.userId);
    expect(getConversationActionTurn({
      conversationId: closedScope.conversation.id,
      userId: closedScope.userId,
      requestId: closeRequestId,
    })).toMatchObject({ status: 'cancelled' });
  });

  it('reconciles a crash-window assistant transcript and releases a transcript-only orphan on restart', () => {
    const durable = scope('restart-durable');
    const durableRequestId = 'request-restart-durable';
    const durableUserMessageId = persistUser({
      userId: durable.userId,
      conversationId: durable.conversation.id,
      requestId: durableRequestId,
    });
    bindConversationActionExecutionTurn({
      conversationId: durable.conversation.id,
      userId: durable.userId,
      userText: 'Open the desktop application.',
      requestId: durableRequestId,
      userMessageId: durableUserMessageId,
    });
    const crashAssistantId = `crash-assistant-${Date.now()}-${Math.random()}`;
    const db = readDB();
    db.interactions.push({
      id: crashAssistantId,
      userId: durable.userId,
      agentId: 'lumi',
      conversationId: durable.conversation.id,
      message: 'Durable before the process exited.',
      content: 'Durable before the process exited.',
      role: 'assistant',
      requestId: durableRequestId,
      externalMessageId: durableRequestId,
      timestamp: '2026-08-27T00:00:00.000Z',
    });
    writeDB(db);

    const orphan = scope('restart-orphan');
    const orphanRequestId = 'request-restart-orphan';
    const orphanUserMessageId = persistUser({
      userId: orphan.userId,
      conversationId: orphan.conversation.id,
      requestId: orphanRequestId,
    });
    bindConversationActionExecutionTurn({
      conversationId: orphan.conversation.id,
      userId: orphan.userId,
      userText: 'Open the desktop application.',
      requestId: orphanRequestId,
      userMessageId: orphanUserMessageId,
    });

    expect(recoverOrphanedConversationActionExecutions('2026-08-27T00:00:10.000Z'))
      .toBeGreaterThanOrEqual(2);
    expect(getConversationActionTurn({
      conversationId: durable.conversation.id,
      userId: durable.userId,
      requestId: durableRequestId,
    })).toMatchObject({ status: 'terminal', terminalMessageId: crashAssistantId });
    expect(getConversationActionTurn({
      conversationId: orphan.conversation.id,
      userId: orphan.userId,
      requestId: orphanRequestId,
    })).toMatchObject({
      status: 'accepted',
      leaseOwnerId: '',
      recoveryReason: 'process_epoch_changed',
    });
  });
});
