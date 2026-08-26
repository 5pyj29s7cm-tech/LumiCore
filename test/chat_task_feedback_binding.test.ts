import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');

describe('chat task feedback binding integration', () => {
  it('resolves and exposes a structured relation before queue control', () => {
    const exactReplayGuard = chat.indexOf('if (existingExecution)');
    const relation = chat.indexOf('resolvedTaskRelation = resolveActiveTaskMessageRelation(', exactReplayGuard);
    const queueControl = chat.indexOf('const previousSession = chatExecutionQueue.getTail(sessionKey)', relation);

    expect(exactReplayGuard).toBeGreaterThan(-1);
    expect(relation).toBeGreaterThan(exactReplayGuard);
    expect(queueControl).toBeGreaterThan(relation);
    expect(chat).toContain("emitAgent('agent:task_relation', { relation: resolvedTaskRelation })");
    expect(chat).toContain('taskRelation: resolvedTaskRelation');
  });

  it('supports optimistic task/revision controls and rejects stale feedback', () => {
    expect(chat).toContain('controlTargetTaskId?: string');
    expect(chat).toContain('controlTargetRevision?: number');
    expect(chat).toContain("resolvedTaskRelation.binding === 'stale'");
    expect(chat).toContain('reason: resolvedTaskRelation.reason');
  });

  it('routes bound correction/retry/accept feedback through the existing task revision', () => {
    const plannerContext = chat.indexOf('formatActiveTaskRelationContext(');
    const boundExecution = chat.indexOf('const bindsExistingAction = Boolean(', plannerContext);
    const prepare = chat.indexOf('prepareConversationActionExecution({', boundExecution);

    expect(plannerContext).toBeGreaterThan(-1);
    expect(boundExecution).toBeGreaterThan(plannerContext);
    expect(prepare).toBeGreaterThan(boundExecution);
    expect(chat.slice(boundExecution, prepare)).toContain("['continue', 'correction', 'accept', 'retry']");
    expect(chat).toContain('forceResume: true');
    expect(chat).toContain('userMessageId: acceptedUserMessageId');
  });

  it('persists queued transcript first, then refreshes and binds its exact row after lease ownership', () => {
    const persistUser = chat.indexOf('const acceptedUserMessageId = addMessageIdempotent({');
    const wait = chat.indexOf('await sessionLease.waitForTurn()', persistUser);
    const refresh = chat.indexOf('const refreshedConversation = getConversationForScope(', wait);
    const stale = chat.indexOf("resolvedTaskRelation.binding === 'stale'", refresh);
    const bind = chat.indexOf('const boundTurn = bindConversationActionExecutionTurn({', stale);

    expect(persistUser).toBeGreaterThan(-1);
    expect(chat.slice(persistUser, wait)).toContain('deferActionPreparation: !confirmationCancellationRequested');
    expect(wait).toBeGreaterThan(persistUser);
    expect(refresh).toBeGreaterThan(wait);
    expect(stale).toBeGreaterThan(refresh);
    expect(bind).toBeGreaterThan(stale);
    expect(chat.slice(bind, bind + 500)).toContain('userMessageId: acceptedUserMessageId');
  });

  it('revalidates every explicit control fence after waiting without merging receive-time state', () => {
    const refresh = chat.indexOf('const refreshedConversation = getConversationForScope(');
    const resolve = chat.indexOf('resolvedTaskRelation = resolveActiveTaskMessageRelation(', refresh);
    const section = chat.slice(resolve, resolve + 800);
    expect(section).toContain('controlTargetRequestId');
    expect(section).toContain('controlTargetTaskId');
    expect(section).toContain('controlTargetRevision');
    expect(section).not.toContain('receivedTaskRelation');
  });

  it('does not report an older durable pointer as the current runtime status', () => {
    expect(chat).toContain('activeConversation && resolvedTaskRelation.taskId');
    expect(chat).toContain('CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt');
  });
});
