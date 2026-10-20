import './helpers';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, flushDBOrThrow, readDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution,
  cancelConversationActionExecution, setConversationActionExecutionStatus, settleConversationActionExecutionRequest,
  runWithConversationTerminalDurabilityStage, commitConversationTerminalDurabilityStage } from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';

beforeAll(() => initDatabase());
const policy = { allowedTools: ['read_file'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 };
async function accepted(userId: string, conversationId: string, userText: string, forceTask = false) {
  const requestId = randomUUID();
  const userMessageId = addMessageIdempotent({ userId, conversationId, requestId, agentId: 'lumi', role: 'user',
    content: userText, domain: 'personal', orgId: '', deferActionPreparation: true });
  await flushDBOrThrow();
  const prepared = prepareConversationActionExecution({ userId, conversationId, requestId, userMessageId, userText, toolPolicy: policy, forceTask });
  if ('bindingFailure' in prepared) throw new Error(prepared.bindingFailure);
  await flushDBOrThrow();
  return { requestId, prepared };
}

describe('exact taskless turn cancellation at the existing manager owner', () => {
  it('stages only the exact admitted turn and does not create a durable task', async () => {
    const userId = 'taskless-cancel-' + randomUUID(), conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const current = await accepted(userId, conversationId, 'How are you?');
    expect(current.prepared.state).toBeNull();
    expect(getConversationActionTurn({ userId, conversationId, requestId: current.requestId })).toMatchObject({ taskId: '', status: 'leased' });
    for (const input of [{ userId: 'another-user', requestId: current.requestId }, { userId, requestId: 'not-the-accepted-request' }]) {
      cancelConversationActionExecution(conversationId, input.userId, 'Exact isolated cancellation', input.requestId);
      expect(getConversationActionTurn({ userId, conversationId, requestId: current.requestId })?.status).toBe('leased');
    }
    await runWithConversationTerminalDurabilityStage(async stage => {
      cancelConversationActionExecution(conversationId, userId, 'Exact isolated cancellation', current.requestId);
      expect(getConversationActionTurn({ userId, conversationId, requestId: current.requestId })?.status).toBe('leased');
      await flushDBOrThrow();
      expect(commitConversationTerminalDurabilityStage(stage)).toBe(1);
    });
    await flushDBOrThrow();
    expect(getConversationActionTurn({ userId, conversationId, requestId: current.requestId })).toMatchObject({ taskId: '', status: 'cancelled' });
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === userId)).toEqual([]);
    expect(readDB().conversations.find((row: any) => row.id === conversationId)?.actionContinuationState).toBeUndefined();
  });

  it('does not cancel or rewrite an older durable task beside the new taskless request', async () => {
    const userId = 'taskless-old-task-' + randomUUID(), conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const previous = await accepted(userId, conversationId, 'Read the fictional source document.', true);
    const taskId = previous.prepared.state!.taskId;
    setConversationActionExecutionStatus(conversationId, userId, 'blocked', { requestId: previous.requestId, blocker: 'Fictional source remains unavailable.' });
    settleConversationActionExecutionRequest(conversationId, userId, previous.requestId);
    await flushDBOrThrow();
    const current = await accepted(userId, conversationId, 'How are you?');
    expect(current.prepared.state).toBeNull();
    const oldRow = JSON.stringify(readDB().conversationActionTasks.find((row: any) => row.id === taskId));
    const oldTurn = JSON.stringify(getConversationActionTurn({ userId, conversationId, requestId: previous.requestId }));
    cancelConversationActionExecution(conversationId, userId, 'Only cancel this new request.', current.requestId);
    await flushDBOrThrow();
    expect(getConversationActionTurn({ userId, conversationId, requestId: current.requestId })?.status).toBe('cancelled');
    expect(JSON.stringify(readDB().conversationActionTasks.find((row: any) => row.id === taskId))).toBe(oldRow);
    expect(JSON.stringify(getConversationActionTurn({ userId, conversationId, requestId: previous.requestId }))).toBe(oldTurn);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === userId)).toHaveLength(1);
  });
});
