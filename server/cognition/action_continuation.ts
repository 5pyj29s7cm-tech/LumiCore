import type { ActiveTaskMessageResolution } from "./task_concurrency";
import type { ActionIntentAnalysis } from "./normalized_action_intent";
import { randomUUID } from "node:crypto";
import { buildActionContract } from "./action_contract";
import type { ToolPolicy } from "../personality/types";
import { isConfirmationBlockedToolRecord } from "../tools/confirmation_block";
import { coalesceToolExecutionRecords, applyTaskPolicySnapshot, mergeTaskReceipts, snapshotTaskPolicy, taskCompletionFromReceipts, type ConversationTaskStatus } from "./task_execution_ledger";
import { toolRecordHasTerminalPayload } from "../tools/receipt_payload";
import type { ConversationActionContinuationUpdate, ConversationActionContinuationState, ActionContinuationHistoryItem, RecentActionFollowupIntent } from './continuation/contracts';
import { compact, parseToolCalls, toolCallName, compactAssistantState } from './continuation/history_values';
import { toolCallFailure, summarizeToolCalls, toolCallSucceeded } from './continuation/tool_receipts';
import { normalizeConversationActionState } from './continuation/state_normalization';
import { classifyConversationActionFollowupIntent, isActionBearingGoal, isTaskPreparationContinuation } from './continuation/followup';
import { extractRecentActionContinuationState } from './continuation/history_projection';

export type { ActionContinuationHistoryItem } from './continuation/contracts';
export type { RecentActionContinuationState } from './continuation/contracts';
export type { ConversationActionContinuationState } from './continuation/contracts';
export type { PendingRuntimeCancellationRecheck } from './continuation/contracts';
export type { ConversationActionContinuationUpdate } from './continuation/contracts';
export type { ToolRecordTaskDurability } from './continuation/contracts';
export { classifyToolRecordTaskDurability } from './continuation/tool_receipts';
export { isBlockedTaskRetryAcceptance } from './continuation/followup';
export type { RecentActionFollowupIntent } from './continuation/contracts';
export { RECONFIRMATION_REQUIRED_BLOCKER } from './continuation/confirmation';
export { conversationActionRequiresFreshConfirmationReview } from './continuation/confirmation';
export { isCurrentAppEditingRequest } from './continuation/followup';
export { classifyRecentActionFollowupIntent } from './continuation/followup';
export { extractRecentActionContinuationState } from './continuation/history_projection';
export { normalizeConversationActionState } from './continuation/state_normalization';
export { pendingRuntimeCancellationRecheck } from './continuation/runtime_cancellation';
export { isCurrentContinuationTask } from './continuation/followup';
export { explicitlyReferencesUnfinishedTask } from './continuation/followup';
export { isExplicitUnfinishedTaskContinuation } from './continuation/followup';
export { isTaskPreparationContinuation } from './continuation/followup';
export { isReferentialArtifactEdit } from './continuation/followup';
export { classifyConversationActionFollowupIntent } from './continuation/followup';
export { formatConversationActionTaskStatus } from './continuation/status';
export { isUserObservedTaskCompletion } from './continuation/user_observation';
export { needsRecentActionContinuationContext } from './continuation/followup';
export { buildRecentActionContinuationBridge } from './continuation/prompt';

/**
 * Advance the durable conversation pointer from terminal tool evidence.
 * Referential/status turns inherit the original target; a concrete new turn
 * starts a fresh pointer and cannot accidentally absorb an older task.
 */
export function buildConversationActionContinuationState(
  input: ConversationActionContinuationUpdate, analysis?: ActionIntentAnalysis
): ConversationActionContinuationState | null {
  const userText = String(input.userText || '').trim();
  const assistantText = compact(input.assistantText, 700);
  const calls = coalesceToolExecutionRecords(parseToolCalls({ toolCalls: input.toolCalls }))
    .filter(call => toolCallName(call) && (toolCallFailure(call) || toolRecordHasTerminalPayload(call)));
  if (!userText || calls.length === 0) return null;

  const previous = normalizeConversationActionState(input.previous);
  const followupIntent = classifyConversationActionFollowupIntent(userText, previous, undefined, analysis);
  const samePreparedTurn = Boolean(
    previous
    && previous.latestInstruction === userText
    && ['planning', 'executing', 'waiting_confirmation'].includes(previous.status || ''),
  );
  const inheritsPrevious = (
    followupIntent === 'execute'
    || followupIntent === 'status'
    || samePreparedTurn
  ) && Boolean(previous);
  const currentHistory: ActionContinuationHistoryItem[] = [
    { role: 'user', message: userText },
    { role: 'assistant', message: assistantText, toolCalls: calls },
  ];
  const current = extractRecentActionContinuationState(currentHistory, analysis);
  const currentSummaries = summarizeToolCalls(currentHistory);
  const goal = inheritsPrevious ? previous!.goal : userText;
  const receipts = mergeTaskReceipts(
    inheritsPrevious ? previous?.receipts || [] : [],
    calls,
    input.updatedAt || new Date().toISOString(),
  );
  // A terse confirmation/continue turn advances the original contract. Using
  // "确认" itself as the contract makes one confirmed sub-step look like the
  // whole task completed. Only a concrete action-bearing extension replaces
  // the completion target for this turn.
  const preparationContinuation = isTaskPreparationContinuation(userText, previous, undefined, analysis);
  const completionGoal = inheritsPrevious
    && followupIntent === 'execute'
    && isActionBearingGoal(userText, analysis)
    && !preparationContinuation
    ? userText
    : goal;
  const taskId = inheritsPrevious && previous?.taskId ? previous.taskId : `task_${randomUUID()}`;
  const completion = taskCompletionFromReceipts(
    completionGoal,
    receipts,
    inheritsPrevious ? previous?.taskCapsule : undefined,
    input.requestId ? { requestId: input.requestId, taskId } : undefined,
  );
  const currentFailure = [...calls].reverse().find(record => !toolCallSucceeded(record));
  const waitingForConfirmation = calls.some(isConfirmationBlockedToolRecord);
  const hasFailure = completion.records.some(record => !toolCallSucceeded(record));
  const status: ConversationTaskStatus = followupIntent === 'status' && currentFailure
    ? 'blocked'
    : completion.complete
    ? 'completed'
    : waitingForConfirmation
      ? 'waiting_confirmation'
    : hasFailure
      ? 'blocked'
      : 'executing';
  const currentInstructionRef = compact(input.userMessageId, 180)
    || compact(input.requestId, 180);

  return normalizeConversationActionState({
    version: 2,
    taskId,
    status,
    policySnapshot: preparationContinuation && previous?.policySnapshot
      ? previous.policySnapshot : snapshotTaskPolicy(input.toolPolicy) || (inheritsPrevious ? previous?.policySnapshot : undefined),
    receipts,
    activeRequestId: input.requestId || (inheritsPrevious ? previous?.activeRequestId : undefined),
    supersededTaskId: !inheritsPrevious && previous?.unfinished ? previous.taskId : undefined,
    revision: (inheritsPrevious ? previous?.revision || 0 : 0) + 1,
    goal,
    latestInstruction: followupIntent === 'status' && previous
      ? previous.latestInstruction
      : userText,
    latestInstructionRef: followupIntent === 'status' && previous
      ? previous.latestInstructionRef
      : currentInstructionRef || undefined,
    appTarget: current.appTarget || (inheritsPrevious ? previous!.appTarget : ''),
    sourcePaths: Array.from(new Set([
      ...(inheritsPrevious ? previous!.sourcePaths : []),
      ...current.sourcePaths,
    ])).slice(0, 8),
    latestBlocker: waitingForConfirmation
      ? ''
      : completion.blocker || (currentFailure ? toolCallFailure(currentFailure) : ''),
    unfinished: status !== 'completed',
    evidenceTools: Array.from(new Set([
      ...(inheritsPrevious ? previous!.evidenceTools : []),
      ...current.evidenceTools,
    ])).slice(-10),
    assistantState: compactAssistantState(input.assistantText, status),
    toolSummaries: Array.from(new Set([
      ...(inheritsPrevious ? previous!.toolSummaries : []),
      ...currentSummaries,
    ])).slice(-10),
    taskCapsule: inheritsPrevious ? previous?.taskCapsule : undefined,
    updatedAt: input.updatedAt || new Date().toISOString(),
    evidenceMessageId: input.evidenceMessageId,
    completionSource: completion.complete
      ? 'tool_receipt'
      : inheritsPrevious
        ? previous?.completionSource
        : undefined,
  });
}

export function prepareConversationActionTaskState(
  previousValue: ConversationActionContinuationState | null | undefined,
  input: {
    userText: string;
    requestId: string;
    toolPolicy: ToolPolicy;
    /** Exact persisted user message, preferred over requestId as event identity. */
    userMessageId?: string;
    forceResume?: boolean;
    /** The current explicit workflow must supersede, never resume, older unfinished work. */
    forceNewTask?: boolean;
    /** Canonical capability planning determined that this turn needs a ledger. */
    forceTask?: boolean;
    /** The existing accepted pipeline owns whether this turn needs a new task. */
    acceptedTaskRelation?: ActiveTaskMessageResolution;
    /** Resolved once by the shared pipeline; legacy callers may omit it. */
    followupIntent?: RecentActionFollowupIntent;
    now?: string;
  }, analysis?: ActionIntentAnalysis
): { state: ConversationActionContinuationState | null; kind: 'new' | 'resume' | 'status' | 'conversation' } {
  const userText = String(input.userText || '').trim();
  const previous = normalizeConversationActionState(previousValue);
  const followupIntent = input.followupIntent ?? classifyConversationActionFollowupIntent(userText, previous, undefined, analysis);
  const resume = !input.forceNewTask && Boolean(
    previous && previous.unfinished && (input.forceResume || followupIntent === 'execute'),
  );
  // A plain status question is observational. Internal deterministic recovery
  // may deliberately resume that exact unfinished task so a fresh receipt can
  // be adjudicated under a new request lease. Likewise, an accepted proposal
  // may force a new task even when its terse wording is referential.
  if (
    followupIntent === 'status'
    && previous
    && !input.forceResume
    && !input.forceNewTask
  ) return { state: previous, kind: 'status' };
  const contract = input.acceptedTaskRelation ? null : buildActionContract(userText, undefined, analysis);
  const isAction = input.forceTask === true || Boolean(contract?.applies && contract.kind !== 'none');
  // An unrelated conversational turn may inspect the same conversation, but
  // it does not own the durable action pointer. Returning the previous task
  // here caused callers to bind the new turn's execution plan and receipts to
  // an older blocked task (for example, a model question being attached to an
  // earlier "open browser" task). The conversation manager keeps the durable
  // ledger separately; callers receive no task identity for a plain turn.
  if (!resume && !isAction) return { state: null, kind: 'conversation' };

  const now = input.now || new Date().toISOString();
  const latestInstructionRef = compact(input.userMessageId, 180)
    || compact(input.requestId, 180);
  if (resume && previous) {
    return {
      kind: 'resume',
      state: normalizeConversationActionState({
        ...previous,
        version: 2,
        // `waiting_confirmation` describes an idle task with no foreground
        // request owner. Once a new accepted turn resumes that exact pending
        // action, the successor request must enter an owning phase so its
        // verified receipt can be adjudicated against the task after restart.
        // Keeping the task in `waiting_confirmation` makes normalization drop
        // activeRequestId, which archives the confirmed receipt but leaves the
        // task and live pointer stuck at the old confirmation checkpoint.
        status: 'planning',
        latestInstruction: userText,
        latestInstructionRef: latestInstructionRef || undefined,
        activeRequestId: input.requestId,
        policySnapshot: isTaskPreparationContinuation(userText, previous, undefined, analysis) ? previous.policySnapshot : snapshotTaskPolicy(
          applyTaskPolicySnapshot(input.toolPolicy, previous.policySnapshot),
        ) || previous.policySnapshot,
        revision: (previous.revision || 0) + 1,
        updatedAt: now,
      }),
    };
  }

  return {
    kind: 'new',
    state: normalizeConversationActionState({
      version: 2,
      taskId: `task_${randomUUID()}`,
      status: 'planning',
      policySnapshot: snapshotTaskPolicy(input.toolPolicy),
      receipts: [],
      activeRequestId: input.requestId,
      supersededTaskId: previous?.unfinished ? previous.taskId : undefined,
      revision: 1,
      goal: userText,
      latestInstruction: userText,
      latestInstructionRef: latestInstructionRef || undefined,
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: [],
      assistantState: '',
      toolSummaries: [],
      updatedAt: now,
    }),
  };
}
