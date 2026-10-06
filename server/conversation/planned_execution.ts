import type { LumiExecutionPipeline } from '../cognition/execution_pipeline';
import type { PendingToolConfirmation } from '../tools/pending_confirmation';
import { prepareConversationActionExecution } from './manager/execution_preparation';

export interface PlannedConversationExecutionInput {
  execution: LumiExecutionPipeline;
  conversationId?: string;
  userId: string;
  requestId: string;
  userMessageId: string;
  userText: string;
  pendingConfirmation?: PendingToolConfirmation | null;
  /** A verified merge of an interrupted user turn, not a model suggestion. */
  acceptedInterruptedTurn?: boolean;
  /** A server-bound cleanup offer creates its own task with only cancellation authority. */
  acceptedRuntimeCleanup?: boolean;
  /** Entry-owned observational exits must not acquire an action task. */
  observationOnly?: boolean;
  /** Entries with a persisted user row also bind ordinary conversation turns. */
  bindConversationTurn?: boolean;
  /** A regional organization route may require a ledger without a model tool call. */
  additionalLedgerRequired?: boolean;
}

/** Bind the final accepted relation and policy once; never classify the wording again here. */
export function preparePlannedConversationExecution(input: PlannedConversationExecutionInput) {
  const { execution } = input;
  if (input.requestId !== execution.resolution.requestId) throw new Error('Task preparation does not belong to the accepted turn');
  const conversation = { state: null, kind: 'conversation' as const, turnRowId: undefined };
  if (!input.conversationId || input.observationOnly) return conversation;
  const relation = execution.taskRelation;
  const stale = { state: null, kind: 'conversation' as const, bindingFailure: 'stale' as const,
    diagnosticCode: 'conversation_action_task_binding_stale' as const };
  if (relation.binding === 'stale' || input.pendingConfirmation?.taskId && relation.taskId && input.pendingConfirmation.taskId !== relation.taskId) return stale;
  const tasklessGrant = Boolean(input.pendingConfirmation && !input.pendingConfirmation.taskId);
  const boundFeedback = Boolean(relation.taskId
    && (relation.binding === 'active_task' || relation.binding === 'previous_task')
    && ['continue', 'correction', 'accept', 'retry'].includes(relation.feedback));
  const forceResume = Boolean(boundFeedback || input.pendingConfirmation || input.acceptedInterruptedTurn || execution.trustedActionContinuation);
  const forceTask = Boolean(execution.capabilityPlan.taskLedgerRequired || input.pendingConfirmation || input.additionalLedgerRequired || input.acceptedRuntimeCleanup);
  if (!input.bindConversationTurn && !forceResume && !forceTask) return conversation;
  return prepareConversationActionExecution({
    conversationId: input.conversationId, userId: input.userId, requestId: input.requestId,
    userText: input.userText, userMessageId: input.userMessageId,
    toolPolicy: input.acceptedRuntimeCleanup
      ? { allowedTools: ['runtime_work_cancel'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 }
      : execution.authorizationPolicy,
    followupIntent: execution.actionFollowupIntent,
    acceptedTaskRelation: relation, confirmationTaskId: input.pendingConfirmation?.taskId,
    forceTask, forceResume: !input.acceptedRuntimeCleanup && !tasklessGrant && forceResume,
    forceNewTask: input.acceptedRuntimeCleanup || tasklessGrant,
    preserveExistingTask: input.acceptedRuntimeCleanup ? false : forceResume || forceTask,
  });
}
