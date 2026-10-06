import { normalizeConversationActionState, type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { hasMixedStatusExecutionIntent, normalizeActionIntent } from "../../cognition/normalized_action_intent";
import { conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";
import type { ConversationActionTaskRow, ConversationActionReceiptRow } from './contracts';
import { ensureTables, parseObject } from './serialization';

export function findConversationActionTask(
  db: any,
  input: { conversationId: string; userId: string; query?: string; taskId?: string; latest?: boolean },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const intent = normalizeActionIntent(input.query || '');
  const query = String(input.query || '').toLowerCase();
  const queryMentionsWps = /\bwps\b/iu.test(query);
  const explicitTargets = Array.from(String(input.query || '').matchAll(
    /([^\s\\/:*?"<>|\r\n]{1,160}\.(?:txt|md|docx?|xlsx?|pptx?|pdf|csv))\b/giu,
  )).map(match => String(match[1] || '').trim().toLowerCase()).filter(Boolean);
  const scopedReceipts = (db.conversationActionReceipts as ConversationActionReceiptRow[])
    .filter(receipt => receipt.conversationId === input.conversationId);
  const scopedTasks = (db.conversationActionTasks as ConversationActionTaskRow[])
    .filter(task => task.conversationId === input.conversationId && task.userId === input.userId);
  const exactTaskId = String(input.taskId || '').trim();
  if (exactTaskId) {
    return scopedTasks.find(task => task.id === exactTaskId) || null;
  }
  // Older clients sometimes persisted a read-only progress question as a new
  // blocked task. It must not displace the actual action during implicit
  // history lookup. Keep these rows (and exact-ID access) for audit purposes;
  // genuine failed actions, even before their first receipt, remain eligible.
  const actionTasks = scopedTasks.filter(task => (
    scopedReceipts.some(receipt => receipt.taskId === task.id)
    || normalizeActionIntent(task.goal).kind !== 'status_query'
    || hasMixedStatusExecutionIntent(task.goal)
  ));
  if (input.latest || (intent.kind === 'status_query' && intent.target === 'previous_action')) {
    const latestTaskEventAt = (task: ConversationActionTaskRow): string => (
      scopedReceipts
        .filter(receipt => receipt.taskId === task.id)
        .reduce((latest, receipt) => (
          receipt.createdAt.localeCompare(latest) > 0 ? receipt.createdAt : latest
        ), task.createdAt || task.updatedAt)
    );
    return actionTasks
      .map((task, insertionOrder) => ({ task, insertionOrder, eventAt: latestTaskEventAt(task) }))
      .sort((left, right) => (
        right.eventAt.localeCompare(left.eventAt)
        || right.task.createdAt.localeCompare(left.task.createdAt)
        || right.insertionOrder - left.insertionOrder
      ))[0]?.task || null;
  }
  return actionTasks
    .map(task => {
      const context = parseObject(task.context);
      const actionState = normalizeConversationActionState(context.actionState);
      const haystack = `${task.intentKind} ${task.goal} ${task.target} ${task.context}`.toLowerCase();
      // Receipt context contains before/after snapshots. Those observations
      // prove an action but do not identify its target: a command-center action
      // may legitimately contain before.activeTab=home, for example.
      const targetHaystack = [
        task.intentKind,
        task.goal,
        task.target,
        actionState?.appTarget || '',
        actionState?.latestInstruction || '',
      ].join(' ').toLowerCase();
      const taskReceipts = scopedReceipts.filter(receipt => receipt.taskId === task.id);
      let score = 0;
      if (intent.target && targetHaystack.includes(intent.target.toLowerCase())) score += 8;
      if (intent.target === 'AutoCAD' && /cad|图纸|平面图/i.test(targetHaystack)) score += 8; // i18n-allow: Chinese CAD task matching; not user-visible copy.
      if (intent.kind !== 'status_query' && intent.kind !== 'none' && task.intentKind === intent.kind) score += 6;
      if (query && haystack.includes(query)) score += 3;
      for (const target of explicitTargets) {
        if (haystack.includes(target)) score += 16;
        if (taskReceipts.some(receipt => (
          receipt.targetIdentity.toLowerCase().includes(target)
          || receipt.envelope.toLowerCase().includes(target)
        ))) score += 32;
      }
      // WPS creation receipts are stronger task identity evidence than
      // recency. A later client navigation (for example, returning to the
      // command center to inspect the result) must not steal a status query
      // that explicitly names WPS.
      if (queryMentionsWps) {
        if (/\bwps\b/iu.test(targetHaystack)) score += 12;
        if (taskReceipts.some(receipt => /^wps_/i.test(receipt.toolName))) score += 32;
      }
      if (taskReceipts.some(receipt => receipt.outcome === 'verified_success')) score += 4;
      return { task, score };
    })
    .sort((left, right) => (
      right.score - left.score
      || (query
        ? right.task.updatedAt.localeCompare(left.task.updatedAt)
        : right.task.createdAt.localeCompare(left.task.createdAt)
          || right.task.updatedAt.localeCompare(left.task.updatedAt))
    ))[0]?.task || null;
}

export function conversationActionStateFromTask(
  task: ConversationActionTaskRow | null | undefined,
): ConversationActionContinuationState | null {
  if (!task) return null;
  const context = parseObject(task.context);
  const persisted = normalizeConversationActionState(context.actionState);
  const requestLeaseActive = conversationTaskStatusOwnsExecutionLease(task.status);
  return normalizeConversationActionState({
    ...(persisted || {}),
    version: 2,
    taskId: task.id,
    goal: persisted?.goal || task.goal,
    latestInstruction: persisted?.latestInstruction || persisted?.goal || task.goal,
    status: task.status,
    latestBlocker: task.blocker,
    activeRequestId: requestLeaseActive ? task.activeRequestId || undefined : undefined,
    completionSource: task.completionSource === 'user_observation'
      ? 'user_observation'
      : task.completionSource === 'tool_receipt'
        ? 'tool_receipt'
        : undefined,
    unfinished: !isTerminalConversationTaskStatus(task.status),
    updatedAt: task.updatedAt,
    appTarget: persisted?.appTarget || task.target,
    sourcePaths: persisted?.sourcePaths || [],
    evidenceTools: persisted?.evidenceTools || [],
    assistantState: persisted?.assistantState || '',
    toolSummaries: persisted?.toolSummaries || [],
    receipts: persisted?.receipts || [],
  } as ConversationActionContinuationState);
}

export function getConversationActionStateFromLedger(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionContinuationState | null {
  return conversationActionStateFromTask(findConversationActionTask(db, input));
}

/**
 * Resolve the immutable task already bound to a request. Unlike the general
 * ledger selector, this cannot be displaced by a newer status/audit task.
 */
export function getConversationActionStateByTaskId(
  db: any,
  input: { conversationId: string; userId: string; taskId: string },
): ConversationActionContinuationState | null {
  ensureTables(db);
  const taskId = String(input.taskId || '').trim();
  if (!taskId) return null;
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  return conversationActionStateFromTask(task);
}

/** Return the most recently evidenced action in one conversation, including terminal tasks. */
export function getLatestConversationActionState(
  db: any,
  input: { conversationId: string; userId: string },
): ConversationActionContinuationState | null {
  return conversationActionStateFromTask(findConversationActionTask(db, {
    ...input,
    latest: true,
  }));
}
