import type { PreparedConversationTurnUpgrade } from './action_execution_runtime';

export type PreparedSelectedToolCall = (signal: AbortSignal) => Promise<{ taskId: string; turnRowId?: string }>;
import type { LumiExecutionPipeline } from '../cognition/execution_pipeline';
import type { PendingToolConfirmation } from '../tools/pending_confirmation';
import { prepareConversationActionExecution, prepareAndPersistConversationActionExecution, type ConversationActionExecutionPreparation } from './manager/execution_preparation';

type PlannedConversationExecutionPreparation = ConversationActionExecutionPreparation & {
  prepareSelectedToolCall?: PreparedSelectedToolCall;
};

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
  preparedTurnUpgrade?: PreparedConversationTurnUpgrade;
}

/** Bind the final accepted relation and policy once; never classify the wording again here. */
export function preparePlannedConversationExecution(input: PlannedConversationExecutionInput): PlannedConversationExecutionPreparation {
  const { execution } = input;
  if (input.requestId !== execution.resolution.requestId
    || input.preparedTurnUpgrade && input.userText !== execution.resolution.userText) throw new Error('Task preparation does not belong to the accepted turn');
  const conversation = { state: null, kind: 'conversation' as const, turnRowId: undefined,
    prepareSelectedToolCall: undefined as PreparedSelectedToolCall | undefined };
  if (!input.conversationId || input.observationOnly) return conversation;
  const relation = execution.taskRelation;
  const stale = { ...conversation, bindingFailure: 'stale' as const,
    diagnosticCode: 'conversation_action_task_binding_stale' as const };
  if (relation.binding === 'stale' || input.pendingConfirmation?.taskId && relation.taskId && input.pendingConfirmation.taskId !== relation.taskId) return stale;
  const tasklessGrant = Boolean(input.pendingConfirmation && !input.pendingConfirmation.taskId);
  const boundFeedback = Boolean(relation.taskId
    && (relation.binding === 'active_task' || relation.binding === 'previous_task')
    && ['continue', 'correction', 'accept', 'retry'].includes(relation.feedback));
  const forceResume = Boolean(boundFeedback || input.pendingConfirmation || input.acceptedInterruptedTurn || execution.trustedActionContinuation);
  const forceTask = Boolean(execution.capabilityPlan.taskLedgerRequired || input.pendingConfirmation || input.additionalLedgerRequired || input.acceptedRuntimeCleanup);
  if (!input.bindConversationTurn && !forceResume && !forceTask) return conversation;
  const preparationInput: Parameters<typeof prepareConversationActionExecution>[0] = {
    conversationId: input.conversationId, userId: input.userId, requestId: input.requestId,
    userText: input.userText, userMessageId: input.userMessageId,
    preparedTurnUpgrade: input.preparedTurnUpgrade,
    toolPolicy: input.acceptedRuntimeCleanup
      ? { allowedTools: ['runtime_work_cancel'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 }
      : execution.authorizationPolicy,
    followupIntent: execution.actionFollowupIntent,
    acceptedTaskRelation: relation, confirmationTaskId: input.pendingConfirmation?.taskId,
    forceTask, forceResume: !input.acceptedRuntimeCleanup && !tasklessGrant && forceResume,
    forceNewTask: input.acceptedRuntimeCleanup || tasklessGrant,
    preserveExistingTask: input.acceptedRuntimeCleanup ? false : forceResume || forceTask,
  };
  const prepared = prepareConversationActionExecution(preparationInput);
  if ('bindingFailure' in prepared) return { ...prepared, prepareSelectedToolCall: undefined };
  execution.taskId = prepared.state?.taskId;
  let selectedPreparation: ReturnType<PreparedSelectedToolCall> | undefined;
  const result = { ...prepared, prepareSelectedToolCall: undefined as PreparedSelectedToolCall | undefined };
  result.prepareSelectedToolCall = signal => {
    signal.throwIfAborted();
    return selectedPreparation ||= (async () => {
    if (!result.state?.taskId) {
      if (!result.turnRowId || typeof prepared.acceptedTranscriptText !== 'string') {
        throw new Error('The selected tool lost its accepted transcript.');
      }
      const upgraded = await prepareAndPersistConversationActionExecution({ ...preparationInput, forceTask: true,
        detachedTaskReference: prepared.detachedTaskReference,
        preserveExistingTask: !input.acceptedRuntimeCleanup,
        preparedTurnUpgrade: { turnRowId: result.turnRowId, signal, transcriptText: prepared.acceptedTranscriptText } });
      if ('bindingFailure' in upgraded || !upgraded.state?.taskId) {
        throw new Error('The selected tool could not bind its audit task.');
      }
      Object.assign(result, upgraded);
      execution.taskId = upgraded.state.taskId;
      signal.throwIfAborted();
    }
    return { taskId: result.state!.taskId, turnRowId: result.turnRowId };
    })();
  };
  return result;
}
