import { readImplementationSource } from './implementation_source';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chat = readImplementationSource(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');

describe('chat task feedback binding integration', () => {
  it('resolves and exposes a structured relation before queue control', () => {
    const exactReplayGuard = chat.indexOf('if (existingExecution)');
    const relation = chat.indexOf('acceptedTurnResolution = resolveUserTurn({', exactReplayGuard);
    const queueControl = chat.indexOf('const previousSession = existingSession;', relation);

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

  it('binds typed or spoken status/cancel controls to the server-owned lease', () => {
    expect(chat).toContain(
      'if (controlTargetRequestId && controlTargetRequestId !== existingSession.requestId)',
    );
    expect(chat).toContain('const cancellationTargetRequestId = controlTargetRequestId');
    expect(chat).toContain('|| resolvedTaskRelation.targetRequestId');
    expect(chat).toContain(
      'persistChatSidecarCancellationIntent(executionScope, requestId, cancellationTargetRequestId)',
    );
    expect(chat).toContain(
      'cancelConversationExecution(executionScope, cancellationTargetRequestId)',
    );
    expect(chat).not.toContain("reason: 'missing_control_target'");
  });

  // Cancellation is exercised through real Socket handlers in
  // chat_authorization_terminal.test.ts: parent cancellation during optional
  // classification, and revoked cancellation while a foreground model is held.
  // intent_classifier_budget.test.ts covers the child deadline and late SDK
  // completion. Keep that behavioral coverage instead of coupling this file
  // to a helper's spelling, its source position, or a fixed character window.

  it('settles a repeated confirmation as a no-op before binding a new task', () => {
    const duplicateConfirmation = chat.indexOf('const adjacentConfirmedAction = !pendingConfirmation');
    const bindTurn = chat.indexOf('preparePlannedConversationExecution({', duplicateConfirmation);

    expect(duplicateConfirmation).toBeGreaterThan(-1);
    expect(chat.slice(duplicateConfirmation, duplicateConfirmation + 900)).toContain('findAdjacentVerifiedConfirmedAction({');
    expect(chat.slice(duplicateConfirmation, duplicateConfirmation + 900)).toContain('currentRequestId: requestId');
    expect(chat.slice(duplicateConfirmation, duplicateConfirmation + 900)).not.toContain("resolvedTaskRelation.binding === 'previous_task'");
    expect(chat.slice(duplicateConfirmation, duplicateConfirmation + 2_000)).toContain('CN_TASK_EXECUTION_MESSAGES.noPendingConfirmation');
    expect(chat.slice(duplicateConfirmation, duplicateConfirmation + 2_000)).toContain("cognitiveIntent: 'duplicate_confirmation_noop'");
    expect(bindTurn).toBeGreaterThan(duplicateConfirmation);
  });

  it('routes bound correction/retry/accept feedback through the existing task revision', () => {
    const plannerContext = chat.indexOf('formatActiveTaskRelationContext(');
    const prepare = chat.indexOf('preparePlannedConversationExecution({', plannerContext);
    const owner = readFileSync('server/conversation/planned_execution.ts', 'utf8');
    expect(plannerContext).toBeGreaterThan(-1);
    const acceptedRelation = chat.indexOf('resolvedTaskRelation = executionPipeline.taskRelation;');
    expect(acceptedRelation).toBeGreaterThan(plannerContext);
    expect(prepare).toBeGreaterThan(acceptedRelation);
    expect(owner).toContain("['continue', 'correction', 'accept', 'retry']");
    expect(owner).toContain('const relation = execution.taskRelation;');
    expect(owner).toContain('forceTask, forceResume:');
    expect(chat).toContain('userMessageId: acceptedUserMessageId');
  });

  it('persists queued transcript first, then refreshes and binds its exact row after lease ownership', () => {
    const admission = chat.indexOf('const chatAdmission = await admitAcceptedUserTurnDurably({');
    const persistUser = chat.indexOf('persistAcceptedUserTurn: () => addMessageIdempotent({', admission);
    const flush = chat.indexOf('flush: flushDBOrThrow', persistUser);
    const accepted = chat.indexOf('const acceptedUserMessageId = chatAdmission.persisted;', flush);
    const wait = chat.indexOf('await sessionLease.waitForTurn()', accepted);
    const refresh = chat.indexOf('const refreshedConversation = getConversationForScope(', wait);
    const stale = chat.indexOf("resolvedTaskRelation.binding === 'stale'", refresh);
    const bind = chat.indexOf('preparePlannedConversationExecution({', stale);

    expect(admission).toBeGreaterThan(-1);
    expect(persistUser).toBeGreaterThan(admission);
    expect(chat.slice(persistUser, flush)).toContain('deferActionPreparation: !confirmationCancellationRequested');
    expect(flush).toBeGreaterThan(persistUser);
    expect(accepted).toBeGreaterThan(flush);
    expect(wait).toBeGreaterThan(accepted);
    expect(refresh).toBeGreaterThan(wait);
    expect(stale).toBeGreaterThan(refresh);
    expect(bind).toBeGreaterThan(stale);
    expect(chat.slice(bind, bind + 650)).toContain('userMessageId: acceptedUserMessageId');
    expect(chat.slice(bind, bind + 650)).toContain('bindConversationTurn: true');
    expect(chat).not.toContain('bindConversationActionExecutionTurn({');
    const owner = readFileSync('server/conversation/planned_execution.ts', 'utf8');
    expect(owner).toContain('prepareConversationActionExecution({');
  });

  it('revalidates the accepted task binding after waiting through the shared identity/version guard', () => {
    const refresh = chat.indexOf('const refreshedConversation = getConversationForScope(');
    const resolve = chat.indexOf('resolvedTaskRelation = revalidateAcceptedTaskRelation(', refresh);
    expect(resolve).toBeGreaterThan(refresh);
    expect(chat.slice(resolve,resolve+180)).toContain('conversation.actionContinuationState');
    expect(chat.slice(refresh,resolve)).not.toContain('resolveActiveTaskMessageRelation(');
  });

  it('does not report an older durable pointer as the current runtime status', () => {
    expect(chat).toContain('activeConversation && resolvedTaskRelation.taskId');
    expect(chat).toContain('CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt');
  });
});
