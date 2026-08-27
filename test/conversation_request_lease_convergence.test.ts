import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  convergeConversationActionRequestLease,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
} from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareLeasedRequest(label: string) {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `lease-convergence-${label}-${nonce}`;
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
  expect(getConversationActionTurn({ conversationId: conversation.id, userId, requestId }))
    .toMatchObject({ status: 'leased', taskId: prepared.state?.taskId });
  return {
    conversationId: conversation.id,
    userId,
    requestId,
    taskId: prepared.state!.taskId!,
  };
}

function persistAssistantEvidence(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  id: string;
}): void {
  const db = readDB();
  const now = new Date().toISOString();
  db.interactions.push({
    id: input.id,
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    message: 'The request reached its terminal assistant response.',
    response: '',
    role: 'assistant',
    requestId: input.requestId,
    domain: 'personal',
    source: 'test',
    channel: 'chat',
    timestamp: now,
    receivedAt: now,
  });
  writeDB(db);
}

describe('manager request lease convergence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('quarantines a leased turn even when the conversation row is missing and repeats as a no-op', () => {
    const request = prepareLeasedRequest('missing-conversation');
    const db = readDB();
    db.conversations = db.conversations.filter((row: any) => !(
      row.id === request.conversationId && row.userId === request.userId
    ));
    writeDB(db);

    const first = convergeConversationActionRequestLease(request);
    expect(first).toMatchObject({
      ...request,
      beforeStatus: 'leased',
      finalStatus: 'persistence_unknown',
      action: 'persistence_unknown',
      converged: true,
      changed: true,
      reason: 'conversation_missing',
      evidence: { conversation: 'missing', task: 'found', assistant: 'missing' },
      localOwnerCleared: true,
    });
    expect(first.turn).toMatchObject({ status: 'persistence_unknown', leaseOwnerId: '' });

    const repeated = convergeConversationActionRequestLease(request);
    expect(repeated).toMatchObject({
      beforeStatus: 'persistence_unknown',
      finalStatus: 'persistence_unknown',
      action: 'none',
      converged: true,
      changed: false,
      reason: 'already_converged',
      localOwnerCleared: false,
    });
  });

  it('quarantines a leased turn whose exact bound task row is missing', () => {
    const request = prepareLeasedRequest('missing-task');
    const db = readDB();
    db.conversationActionTasks = db.conversationActionTasks.filter((row: any) => row.id !== request.taskId);
    writeDB(db);

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      beforeStatus: 'leased',
      finalStatus: 'persistence_unknown',
      action: 'persistence_unknown',
      converged: true,
      reason: 'task_missing',
      evidence: { conversation: 'found', task: 'missing', assistant: 'missing' },
    });
  });

  it('terminals a leased turn from an exact assistant transcript even after its task is completed', () => {
    const request = prepareLeasedRequest('completed-with-assistant');
    const assistantMessageId = `assistant-${request.requestId}`;
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === request.taskId);
    task.status = 'completed';
    task.activeRequestId = '';
    task.completedAt = new Date().toISOString();
    writeDB(db);
    persistAssistantEvidence({ ...request, id: assistantMessageId });

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      beforeStatus: 'leased',
      finalStatus: 'terminal',
      action: 'terminal',
      converged: true,
      changed: true,
      reason: 'durable_assistant_transcript_found',
      assistantMessageId,
      evidence: { conversation: 'found', task: 'found', assistant: 'found' },
      localOwnerCleared: true,
    });
    expect(result.turn).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
      leaseOwnerId: '',
    });
  });

  it('does not call an assistant-bound action turn converged while its exact task still owns the lease', () => {
    const request = prepareLeasedRequest('assistant-with-active-task');
    const assistantMessageId = `assistant-${request.requestId}`;
    persistAssistantEvidence({ ...request, id: assistantMessageId });

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      beforeStatus: 'leased',
      finalStatus: 'terminal',
      action: 'terminal',
      converged: false,
      changed: true,
      reason: 'durable_assistant_transcript_found',
      assistantMessageId,
      evidence: { conversation: 'found', task: 'found', assistant: 'found' },
      localOwnerCleared: true,
    });
    expect(result.turn).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
      leaseOwnerId: '',
    });
    expect(readDB().conversationActionTasks.find((row: any) => row.id === request.taskId))
      .toMatchObject({
        status: 'planning',
        activeRequestId: request.requestId,
      });
  });

  it('quarantines a completed task when no durable assistant transcript proves the user-visible terminal', () => {
    const request = prepareLeasedRequest('completed-without-assistant');
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === request.taskId);
    task.status = 'completed';
    task.activeRequestId = '';
    task.completedAt = new Date().toISOString();
    writeDB(db);

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      finalStatus: 'persistence_unknown',
      action: 'persistence_unknown',
      converged: true,
      reason: 'terminal_task_without_assistant:completed',
      evidence: { conversation: 'found', task: 'found', assistant: 'missing' },
    });
    expect(db.conversationActionTasks.find((row: any) => row.id === request.taskId)).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      completedAt: '',
    });
  });

  it('cancels the leased turn when the exact durable task is cancelled', () => {
    const request = prepareLeasedRequest('cancelled-task');
    const db = readDB();
    const task = db.conversationActionTasks.find((row: any) => row.id === request.taskId);
    task.status = 'cancelled';
    task.activeRequestId = '';
    task.completedAt = new Date().toISOString();
    writeDB(db);

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      finalStatus: 'cancelled',
      action: 'cancelled',
      converged: true,
      reason: 'durable_task_cancelled',
      evidence: { conversation: 'found', task: 'found', assistant: 'missing' },
    });
  });

  it('does not release a current lease when its exact task is still nonterminal', () => {
    const request = prepareLeasedRequest('nonterminal-task');

    const result = convergeConversationActionRequestLease(request);
    expect(result).toMatchObject({
      beforeStatus: 'leased',
      finalStatus: 'leased',
      action: 'none',
      converged: false,
      changed: false,
      reason: 'nonterminal_task_still_active',
      evidence: { conversation: 'found', task: 'found', assistant: 'missing' },
      localOwnerCleared: false,
    });

    const db = readDB();
    db.conversationActionTasks = db.conversationActionTasks.filter((row: any) => row.id !== request.taskId);
    writeDB(db);
    expect(convergeConversationActionRequestLease(request)).toMatchObject({
      finalStatus: 'persistence_unknown',
      action: 'persistence_unknown',
    });
  });
});
