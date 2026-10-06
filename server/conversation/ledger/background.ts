import { normalizeConversationActionState, type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { normalizeActionIntent } from "../../cognition/normalized_action_intent";
import type { ToolExecutionRecord } from "../../tools/types";
import type { ConversationActionTaskRow } from './contracts';
import { ensureTables, parseObject } from './serialization';
import { appendConversationActionReceipts } from './receipt_store';
import { finalizeConversationActionTask } from './task_lifecycle';

/**
 * Create the durable action row owned by a scheduled/background plan before
 * it enters the runtime queue. The deterministic task id is also the restart
 * and idempotency boundary for downstream execution.
 */
export function ensureBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    conversationId: string;
    userId: string;
    domain: string;
    orgId: string;
    goal: string;
    target: string;
    requestId: string;
    source: string;
    context?: Record<string, unknown>;
    now?: string;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  const existing = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.userId === input.userId
  ));
  if (existing) return existing;
  const now = input.now || new Date().toISOString();
  const intent = normalizeActionIntent(input.goal);
  const actionState = normalizeConversationActionState({
    version: 2,
    taskId: input.taskId,
    goal: input.goal,
    latestInstruction: input.goal,
    latestInstructionRef: input.requestId,
    status: 'executing',
    unfinished: true,
    latestBlocker: '',
    appTarget: input.target,
    activeRequestId: input.requestId,
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: 1,
    updatedAt: now,
  });
  const task: ConversationActionTaskRow = {
    id: input.taskId,
    conversationId: input.conversationId,
    userId: input.userId,
    domain: input.domain || 'personal',
    orgId: input.orgId || '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: intent.kind === 'none' ? 'background_work' : intent.kind,
    operation: intent.kind === 'none' ? 'mutate' : intent.operation,
    goal: input.goal,
    target: input.target,
    status: 'executing',
    blocker: '',
    activeRequestId: input.requestId,
    completionSource: '',
    context: JSON.stringify({
      ...(input.context || {}),
      source: input.source,
      actionState,
    }),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  };
  (db.conversationActionTasks as ConversationActionTaskRow[]).push(task);
  return task;
}

/** Settle a background-owned action only from terminal records/finalization. */
export function settleBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    userId: string;
    records: ToolExecutionRecord[];
    status: 'completed' | 'blocked' | 'cancelled';
    blocker?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  appendConversationActionReceipts(db, {
    task,
    records: input.records,
    requestId: input.requestId,
    now,
  });
  const previous = normalizeConversationActionState(parseObject(task.context).actionState);
  const baseState: ConversationActionContinuationState = previous || {
    version: 2,
    taskId: task.id,
    goal: task.goal,
    appTarget: task.target,
    latestInstruction: task.goal,
    latestInstructionRef: task.activeRequestId || undefined,
    unfinished: true,
    latestBlocker: '',
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: task.revision,
    updatedAt: task.updatedAt,
  };
  const conversation = (db.conversations || []).find((candidate: any) => (
    candidate.id === task.conversationId && candidate.userId === task.userId
  ));
  const finalized = finalizeConversationActionTask(db, {
    conversation: conversation || {
      id: task.conversationId,
      userId: task.userId,
      domain: task.domain,
      orgId: task.orgId,
    },
    state: baseState,
    outcome: input.status,
    requestId: input.requestId || task.activeRequestId,
    blocker: input.status === 'blocked'
      ? String(input.blocker || 'Background execution did not reach verified completion.')
      : '',
    completionSource: input.status === 'completed' ? 'tool_receipt' : undefined,
    now,
    updateLivePointer: false,
  });
  return finalized?.task || task;
}
