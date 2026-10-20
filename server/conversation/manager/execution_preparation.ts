import type { IncomingMessage } from '../../messaging/types';
import type { ToolExecutionRecord } from '../../tools/types';
import { getCanonicalToolExecutionInputDigests } from '../../tools/canonical_execution_record';
import { toolRecordSucceeded } from '../../tools/receipt_payload';
import { parseObject } from '../ledger/serialization';
import type { ActiveTaskMessageResolution } from "../../cognition/task_concurrency";
import { bindConversationActionTurnTask, getConversationActionTurn } from "../action_turn_ledger";
import { readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { prepareConversationActionTaskState } from "../../cognition/action_continuation";
import { attachConversationExecutionPlan } from "../ledger/plans";
import { syncConversationActionTaskLedger } from "../ledger/task_lifecycle";
import { getConversationActionStateByTaskId } from "../ledger/queries";
import type { ToolPolicy } from "../../personality/types";
import type { CapabilityExecutionPlan } from "../../cognition/capability_execution_plan";
import { releaseManagerActionTurnLease, type PreparedConversationTurnUpgrade } from "../action_execution_runtime";
import { detachUnrelatedConversationActionState, hydrateConversationActionState } from "../action_state_hydration";
import { bindConversationActionExecutionTurnInDb } from './turn_binding';

type PreparedConversationActionExecution = ReturnType<typeof prepareConversationActionTaskState>;

interface DetachedTaskReference { readonly taskId: string; readonly revision: number; }

export type RejectedConversationActionExecution = {
  state: null;
  kind: 'conversation';
  bindingFailure: 'stale' | 'busy';
  diagnosticCode:
    | 'conversation_action_conversation_missing'
    | 'conversation_action_turn_not_persisted'
    | 'conversation_action_turn_busy'
    | 'conversation_action_task_binding_stale';
};

export type ConversationActionExecutionPreparation =
  | (PreparedConversationActionExecution & { turnRowId?: string; acceptedTranscriptText?: string; detachedTaskReference?: DetachedTaskReference })
  | RejectedConversationActionExecution;

function rejectedConversationActionExecution(
  bindingFailure: RejectedConversationActionExecution['bindingFailure'],
  diagnosticCode: RejectedConversationActionExecution['diagnosticCode'],
): RejectedConversationActionExecution {
  return { state: null, kind: 'conversation', bindingFailure, diagnosticCode };
}

export function prepareConversationActionExecution(input: {
  conversationId: string;
  userId: string;
  userText: string;
  requestId: string;
  /** Exact already-persisted user transcript row owning this serial turn. */
  userMessageId: string;
  toolPolicy: ToolPolicy;
  preparedTurnUpgrade?: PreparedConversationTurnUpgrade;
  detachedTaskReference?: DetachedTaskReference;
  forceResume?: boolean;
  forceNewTask?: boolean;
  forceTask?: boolean;
  /** Current-turn classification from the shared execution pipeline. */
  followupIntent?: import("../../cognition/action_continuation").RecentActionFollowupIntent;
  /** Preserve the current task while binding corrective/continuation feedback. */
  preserveExistingTask?: boolean;
  /** Final server-owned task relation; no downstream text-based reselection. */
  acceptedTaskRelation?: ActiveTaskMessageResolution;
  /** Exact accepted durable grant identity, independent of conversational wording. */
  confirmationTaskId?: string;
}): ConversationActionExecutionPreparation {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (!conversation) {
    return rejectedConversationActionExecution(
      'stale',
      'conversation_action_conversation_missing',
    );
  }
  hydrateConversationActionState(db, conversation, input.acceptedTaskRelation ? undefined : input.userText);
  const relation = input.acceptedTaskRelation;
  const detachedTaskReference = !input.preparedTurnUpgrade && relation?.binding === 'new_task'
    && conversation.actionContinuationState?.unfinished
    ? Object.freeze({ taskId: conversation.actionContinuationState.taskId, revision: conversation.actionContinuationState.revision || 0 }) : undefined;
  const expectedTaskId = input.confirmationTaskId || (relation && (relation.binding === 'active_task' || relation.binding === 'previous_task') ? relation.taskId : undefined);
  const existingTurn = (db.conversationActionTurns || []).find((turn: any) => turn.conversationId === input.conversationId && turn.userId === input.userId && turn.requestId === input.requestId);
  const currentTaskId = existingTurn?.taskId || conversation.actionContinuationState?.taskId;
  if (expectedTaskId && currentTaskId !== expectedTaskId) return rejectedConversationActionExecution('stale', 'conversation_action_task_binding_stale');
  const binding = bindConversationActionExecutionTurnInDb(db, conversation, {
    userId: input.userId,
    conversationId: input.conversationId,
    userText: input.userText,
    requestId: input.requestId,
    userMessageId: input.userMessageId,
    preparedTurnUpgrade: input.preparedTurnUpgrade,
    // A fresh executable turn still needs to see the prior unfinished state
    // long enough for prepareConversationActionTaskState to record an exact
    // supersession edge. Detachment is only for a genuinely conversational
    // turn; it must not erase the old identity before a replacement is built.
    preserveExistingTask: input.preserveExistingTask
      ?? (input.forceResume === true || input.forceTask === true),
  }, true);
  const boundTurn = binding.turn;
  // The durable transcript identity is the ownership fence for every channel.
  // A different pending request is busy; a missing/mismatched transcript is
  // stale. Neither case may fall through and mutate the prior task.
  if (!boundTurn) {
    return rejectedConversationActionExecution(
      binding.failure === 'busy' ? 'busy' : 'stale',
      binding.failure === 'busy'
        ? 'conversation_action_turn_busy'
        : 'conversation_action_turn_not_persisted',
    );
  }
  const acceptedTranscriptText = (db.interactions || []).find((row: any) => row.id === input.userMessageId)?.message;
  const persistedTurn = getConversationActionTurn({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
  });
  const exactBoundTaskState = persistedTurn?.taskId
    ? getConversationActionStateByTaskId(db, {
        conversationId: input.conversationId,
        userId: input.userId,
        taskId: persistedTurn.taskId,
      })
    : null;
  if (exactBoundTaskState) {
    // A replay of the same immutable request must continue the task already
    // bound to that request. Reclassifying the same text as a new task causes
    // a task_conflict after TTL recovery and turns self-recovery back into a
    // permanent busy response.
    conversation.actionContinuationState = exactBoundTaskState;
  }
  const detachedTaskState = input.detachedTaskReference ? getConversationActionStateByTaskId(db, {
    conversationId: input.conversationId, userId: input.userId, taskId: input.detachedTaskReference.taskId,
  }) : null;
  if (input.detachedTaskReference && (!input.preparedTurnUpgrade || relation?.binding !== 'new_task'
    || !detachedTaskState?.unfinished || (detachedTaskState.revision || 0) !== input.detachedTaskReference.revision
    || conversation.actionContinuationState && conversation.actionContinuationState.taskId !== input.detachedTaskReference.taskId)) {
    return rejectedConversationActionExecution('stale', 'conversation_action_task_binding_stale');
  }
  const prepared = prepareConversationActionTaskState(
    detachedTaskState || (input.acceptedTaskRelation?.operation === 'inspect' && input.forceTask && !input.forceResume
      && !input.confirmationTaskId && !exactBoundTaskState ? null : conversation.actionContinuationState), {
    ...input,
    forceResume: input.forceResume === true || Boolean(exactBoundTaskState),
    forceNewTask: exactBoundTaskState ? false : Boolean(detachedTaskState || input.forceNewTask),
  });
  if (prepared.kind === 'status') {
    commitDatabaseTables(db);
    return { ...prepared, state: null, turnRowId: persistedTurn?.id, acceptedTranscriptText };
  }
  if (prepared.state?.taskId) {
    const taskBinding = bindConversationActionTurnTask({
      conversationId: input.conversationId,
      userId: input.userId,
      requestId: input.requestId,
      taskId: prepared.state.taskId,
    }, input.preparedTurnUpgrade ? db : undefined);
    if (taskBinding.bound === false) {
      releaseManagerActionTurnLease({
        conversationId: input.conversationId,
        userId: input.userId,
        requestId: input.requestId,
        reason: `task binding failed: ${taskBinding.reason}`,
      });
      if (conversation.pendingActionContinuation?.requestId === input.requestId) {
        delete conversation.pendingActionContinuation;
      }
      commitDatabaseTables(db);
      return rejectedConversationActionExecution(
        taskBinding.reason === 'task_conflict' ? 'busy' : 'stale',
        taskBinding.reason === 'task_conflict'
          ? 'conversation_action_turn_busy'
          : 'conversation_action_turn_not_persisted',
      );
    }
  }
  if (prepared.kind === 'conversation') {
    const detached = detachUnrelatedConversationActionState(
      db,
      conversation,
      input.userText,
      new Date().toISOString(),
    );
    if (detached || boundTurn) {
      delete conversation.pendingActionContinuation;
      if (boundTurn && !detached) {
        // Keep the exact pending row until its assistant terminal arrives.
        conversation.pendingActionContinuation = {
          userText: input.userText,
          messageId: boundTurn.messageId,
          requestId: input.requestId,
          updatedAt: boundTurn.updatedAt,
        };
      }
      conversation.lastActiveAt = new Date().toISOString();
      commitDatabaseTables(db);
    }
    // The ledger may retain the previous task for status/history, but a plain
    // turn never receives that task id for plan/receipt binding.
    return { state: null, kind: 'conversation', turnRowId: persistedTurn?.id, acceptedTranscriptText, detachedTaskReference };
  }
  if (prepared.state !== conversation.actionContinuationState) {
    if (prepared.state) conversation.actionContinuationState = prepared.state;
    else delete conversation.actionContinuationState;
    conversation.lastActiveAt = new Date().toISOString();
    if (prepared.state) {
      const pending = conversation.pendingActionContinuation;
      const rootUserMessageId = pending
        && (!pending.requestId || pending.requestId === input.requestId)
        && pending.userText === input.userText
        ? pending.messageId
        : undefined;
      syncConversationActionTaskLedger(db, {
        conversation,
        state: prepared.state,
        userText: input.userText,
        rootUserMessageId,
        currentUserMessageId: rootUserMessageId,
        now: conversation.lastActiveAt,
      });
    }
    commitDatabaseTables(db);
  }
  return { ...prepared, turnRowId: persistedTurn?.id, acceptedTranscriptText };
}

export async function prepareAndPersistConversationActionExecution(
  input: Parameters<typeof prepareConversationActionExecution>[0],
): Promise<ConversationActionExecutionPreparation> {
  const prepared = prepareConversationActionExecution(input);
  if (!('bindingFailure' in prepared)) await flushDBOrThrow();
  return prepared;
}

export function persistConversationExecutionPlan(input: {
  conversationId: string;
  userId: string;
  plan: CapabilityExecutionPlan;
}): boolean {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const task = attachConversationExecutionPlan(db, input);
  if (!task) return false;
  commitDatabaseTables(db);
  return true;
}

interface ConversationNativeStageValue {
  receipt: { taskId?: string; requestId?: string; orgId?: string; pendingId?: string };
  content: string;
}
interface ConversationNativeStageOwner {
  userId: string; conversationId: string; taskId: string; domain: string; orgId: string;
}
export function captureConversationNativeStageContext<TStage extends ConversationNativeStageValue>(
  input: ConversationNativeStageOwner & { selection?: IncomingMessage['legalNoticeSelection'] },
): { selection?: IncomingMessage['legalNoticeSelection']; stage?: TStage } {
  let selection = input.selection;
  let stage: TStage | undefined;
  const db = readDatabaseTables(['conversationActionTasks']);
  const task = db.conversationActionTasks.find(row => row.id === input.taskId
    && row.userId === input.userId && row.conversationId === input.conversationId
    && (row.domain || 'personal') === input.domain && (row.orgId || '') === input.orgId);
  if (task) {
    const stored = parseObject(task.context);
    if (selection) {
      task.context = JSON.stringify({ ...stored, remoteLegalNoticeSelection: selection });
      commitDatabaseTables(db);
    } else if (stored.remoteLegalNoticeSelection?.target?.orgId === input.orgId) selection = stored.remoteLegalNoticeSelection;
    if (stored.nativeLegalStage?.receipt?.taskId === task.id
      && (stored.nativeLegalStage.receipt.orgId || '') === input.orgId) stage = stored.nativeLegalStage;
  }
  return { selection, stage };
}

export function retainConversationNativeStageContext(input: Omit<ConversationNativeStageOwner, 'conversationId' | 'taskId'> & {
  conversationId?: string; taskId?: string; requestId: string; value: ConversationNativeStageValue; selection?: IncomingMessage['legalNoticeSelection'];
  records: readonly ToolExecutionRecord[];
}) {
  const stage = input.value.receipt;
  if (stage.requestId !== input.requestId || stage.taskId !== input.taskId
    || (stage.orgId || '') !== input.orgId) throw new Error('The native stage lost its accepted task owner.');
  if (!input.conversationId || !stage.taskId) return;
  const db = readDatabaseTables(['conversationActionTasks', 'conversations']);
  const task = db.conversationActionTasks.find(row => row.id === stage.taskId && row.userId === input.userId
    && row.conversationId === input.conversationId && (row.domain || 'personal') === input.domain && (row.orgId || '') === input.orgId);
  const liveConversation = db.conversations.find(row => row.id === input.conversationId && row.userId === input.userId
    && (row.domain || 'personal') === input.domain && (row.orgId || '') === input.orgId);
  const stored = parseObject(task?.context);
  const state = liveConversation?.actionContinuationState;
  if (!task || !state || state.taskId !== task.id || state.activeRequestId !== input.requestId
    || stored.actionState?.activeRequestId !== input.requestId) throw new Error('The native stage lost its current request lease.');
  const binding = input.selection?.execution;
  const consumed = binding && stage.pendingId === input.selection?.pendingId
    && binding.sourceId === stage.pendingId && binding.scope.userId === input.userId
    && binding.scope.domain === input.domain && binding.scope.orgId === input.orgId
    && input.selection.target.orgId === input.orgId
    && input.records.some(record => record.taskId === task.id && record.requestId === input.requestId
      && record.name === binding.toolName && toolRecordSucceeded(record)
      && getCanonicalToolExecutionInputDigests(record)?.argumentsDigest === binding.argumentsDigest);
  const policySnapshot = consumed && state.policySnapshot?.allowedTools?.length
    ? { ...state.policySnapshot, forbiddenTools: Array.from(new Set([
        ...(state.policySnapshot.forbiddenTools || []), binding.toolName,
      ])) } : state.policySnapshot;
  task.context = JSON.stringify({ ...stored, nativeLegalStage: input.value,
    actionState: { ...stored.actionState, policySnapshot } });
  liveConversation.actionContinuationState = { ...state, policySnapshot };
  commitDatabaseTables(db);
  return policySnapshot;
}
