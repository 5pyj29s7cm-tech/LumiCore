import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
const task = readFileSync(path.join(process.cwd(), 'server/socket/task.ts'), 'utf8');

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
      'chatExecutionQueue.cancelRequest(sessionKey, cancellationTargetRequestId)',
    );
    expect(chat).not.toContain("reason: 'missing_control_target'");
    expect(task).toContain(
      'if (controlTargetRequestId && controlTargetRequestId !== runningTask.requestId)',
    );
    expect(task).toContain(
      'const cancellationTargetRequestId = controlTargetRequestId || previous.requestId',
    );
    expect(task).not.toContain("reason: 'missing_control_target'");
  });

  it('propagates foreground cancellation through classification and the tool/model loop', () => {
    const classifier = chat.indexOf('const llmClassifier = async');
    const classifierCall = chat.indexOf('const result = await makeLLMCall(', classifier);
    const toolLoop = chat.indexOf('const result = await runWithTools(', classifierCall);
    const cancellationCatch = chat.lastIndexOf("if (abortController.signal.aborted || error?.name === 'AbortError')");

    expect(classifier).toBeGreaterThan(-1);
    expect(classifierCall).toBeGreaterThan(classifier);
    expect(chat.slice(classifierCall, classifierCall + 1_200)).toContain('signal: abortController.signal');
    expect(toolLoop).toBeGreaterThan(classifierCall);
    expect(chat.slice(toolLoop, toolLoop + 1_200)).toContain('signal: abortController.signal');
    expect(cancellationCatch).toBeGreaterThan(toolLoop);
    expect(chat.slice(cancellationCatch, cancellationCatch + 1_800)).toContain('cancelConversationActionExecution(');
    expect(chat.slice(cancellationCatch, cancellationCatch + 1_800)).toContain("cognitiveIntent: 'task_cancelled'");
  });

  it('settles a repeated confirmation as a no-op before binding a new task', () => {
    const duplicateConfirmation = chat.indexOf('const adjacentConfirmedAction = !pendingConfirmation');
    const bindTurn = chat.indexOf('const boundTurn = bindConversationActionExecutionTurn({', duplicateConfirmation);

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
    const admission = chat.indexOf('const chatAdmission = await admitAcceptedUserTurnDurably({');
    const persistUser = chat.indexOf('persistAcceptedUserTurn: () => addMessageIdempotent({', admission);
    const flush = chat.indexOf('flush: flushDBOrThrow', persistUser);
    const accepted = chat.indexOf('const acceptedUserMessageId = chatAdmission.persisted;', flush);
    const wait = chat.indexOf('await sessionLease.waitForTurn()', accepted);
    const refresh = chat.indexOf('const refreshedConversation = getConversationForScope(', wait);
    const stale = chat.indexOf("resolvedTaskRelation.binding === 'stale'", refresh);
    const bind = chat.indexOf('const boundTurn = bindConversationActionExecutionTurn({', stale);

    expect(admission).toBeGreaterThan(-1);
    expect(persistUser).toBeGreaterThan(admission);
    expect(chat.slice(persistUser, flush)).toContain('deferActionPreparation: !confirmationCancellationRequested');
    expect(flush).toBeGreaterThan(persistUser);
    expect(accepted).toBeGreaterThan(flush);
    expect(wait).toBeGreaterThan(accepted);
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
