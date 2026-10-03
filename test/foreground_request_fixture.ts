import './helpers';
import { expect } from 'vitest';
import { readDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, prepareConversationActionExecution, type ForegroundRequestIdentity } from '../server/conversation/manager';
import type { ToolPolicy } from '../server/personality/types';

export function prepareForegroundRequest(channel: 'chat' | 'task' | 'voice', label: string, toolPolicy: ToolPolicy): ForegroundRequestIdentity {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `${channel}-release-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Run the ${label}${channel === 'voice' ? ' voice' : ''} task.`;
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
    channel,
  });
  const prepared = prepareConversationActionExecution({
    conversationId: conversation.id,
    userId,
    userText,
    requestId,
    userMessageId,
    toolPolicy,
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

export function taskFor(identity: ForegroundRequestIdentity): any {
  return readDB().conversationActionTasks.find((row: any) => (
    row.id === identity.expectedTaskId
    && row.conversationId === identity.conversationId
    && row.userId === identity.userId
  ));
}
