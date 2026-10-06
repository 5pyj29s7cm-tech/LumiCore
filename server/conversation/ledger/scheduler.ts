import { groupTaskReceipts, type ConversationTaskStatus } from "../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../tools/types";
import type { CapabilityExecutionPlan } from "../../cognition/capability_execution_plan";
import { digest, parseObject, ensureTables, contextWithExecutionPlan } from './serialization';
import type { ConversationActionTaskRow, ConversationActionReceiptRow } from './contracts';
import { sanitizeCapabilityExecutionPlan } from './plans';
import { appendConversationActionReceipts } from './receipt_store';

export type SchedulerAuditOutcome = 'executing' | 'verified' | 'blocked' | 'failed' | 'unknown';

export function compactSchedulerAuditTaskId(scheduledTaskId: string): string {
  return `scheduler_audit_${digest(scheduledTaskId).slice(0, 24)}`;
}

export function schedulerRecordOutcome(
  status: 'executing' | 'blocked' | 'completed',
  records: ToolExecutionRecord[],
): SchedulerAuditOutcome {
  const declared = records
    .map(record => String((record.receipt as any)?.status || ''))
    .find(Boolean);
  if (declared === 'failed' || declared === 'unknown' || declared === 'blocked') return declared;
  if (status === 'completed') return 'verified';
  return status;
}

export function parseSchedulerAudit(task: ConversationActionTaskRow | undefined): Record<string, any> {
  const context = parseObject(task?.context);
  const audit = parseObject(context.schedulerAudit);
  return {
    schemaVersion: 1,
    totalExecutions: 0,
    completedCount: 0,
    blockedCount: 0,
    failedCount: 0,
    unknownCount: 0,
    compactedReceiptCount: 0,
    receiptOutcomeCounts: {},
    recentExecutions: [],
    ...audit,
  };
}

/** Returns the durable state for one compact scheduler slot, if it is still in the replay window. */
export function getScheduledCapabilityExecutionStatus(
  db: any,
  input: { scheduledTaskId: string; executionId: string },
): SchedulerAuditOutcome | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === compactSchedulerAuditTaskId(input.scheduledTaskId)
  ));
  if (!task) return null;
  const audit = parseSchedulerAudit(task);
  if (audit.currentExecution?.executionId === input.executionId) {
    return audit.currentExecution.status || null;
  }
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .find((candidate: any) => candidate?.executionId === input.executionId);
  return recent?.status || null;
}

export function persistCompactScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
  },
): ConversationActionTaskRow {
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const taskId = compactSchedulerAuditTaskId(input.scheduledTaskId);
  let task = tasks.find(candidate => candidate.id === taskId);
  const context = parseObject(task?.context);
  const audit = parseSchedulerAudit(task);
  const records = input.records || [];
  const outcome = schedulerRecordOutcome(input.status, records);
  const existing = audit.currentExecution?.executionId === input.plan.taskId
    ? audit.currentExecution
    : (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
      .find((candidate: any) => candidate?.executionId === input.plan.taskId);

  if (input.status === 'executing' && existing?.status && existing.status !== 'executing') {
    return task!;
  }

  const isNewExecution = input.status === 'executing' && !existing;
  if (isNewExecution) audit.totalExecutions = Number(audit.totalExecutions || 0) + 1;
  const priorOutcome = existing?.status && existing.status !== 'executing'
    ? existing.status
    : String(audit.lastOutcome || '');
  const entry = {
    executionId: input.plan.taskId,
    status: outcome,
    startedAt: existing?.startedAt || now,
    ...(outcome === 'executing' ? {} : { completedAt: now }),
  };
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .filter((candidate: any) => candidate?.executionId !== input.plan.taskId);
  recent.push(entry);
  audit.recentExecutions = recent.slice(-36);
  audit.currentExecution = entry;
  audit.firstExecutionAt = audit.firstExecutionAt || now;
  audit.lastExecutionAt = now;
  if (outcome !== 'executing' && existing?.status !== outcome) {
    if (outcome === 'verified') audit.completedCount = Number(audit.completedCount || 0) + 1;
    if (outcome === 'blocked') audit.blockedCount = Number(audit.blockedCount || 0) + 1;
    if (outcome === 'failed') audit.failedCount = Number(audit.failedCount || 0) + 1;
    if (outcome === 'unknown') audit.unknownCount = Number(audit.unknownCount || 0) + 1;
    audit.lastOutcome = outcome;
  }

  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const values: ConversationActionTaskRow = {
    id: taskId,
    conversationId: `scheduler:${input.scheduledTaskId}`,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Audit declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status: input.status,
    blocker: String(input.blocker || '').slice(0, 500),
    activeRequestId: input.status === 'executing' ? input.plan.taskId : '',
    completionSource: input.status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify({
      ...context,
      source: 'scheduler',
      scheduledTaskId: input.scheduledTaskId,
      compactAudit: true,
      executionPlan: persistedPlan,
      schedulerAudit: audit,
    }),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: input.status === 'completed' ? now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const lastReceiptAt = Date.parse(String(audit.lastReceiptAt || '')) || 0;
  const abnormal = outcome !== 'verified' && outcome !== 'executing';
  // The summary row itself keeps exact counters and the most recent 36 slot
  // identities. A successful receipt every six hours is enough to prove the
  // heartbeat while avoiding thousands of identical scheduler receipts.
  // Abnormal outcomes are still appended immediately.
  const checkpointDue = Date.parse(now) - lastReceiptAt >= 6 * 60 * 60 * 1000;
  if (records.length > 0 && (abnormal || priorOutcome !== outcome || checkpointDue)) {
    appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.plan.taskId,
      requestId: input.plan.taskId,
      now,
    });
    audit.lastReceiptAt = now;
    task.context = JSON.stringify({
      ...parseObject(task.context),
      schedulerAudit: audit,
    });
  }
  return task;
}

/**
 * One-version migration for the old 10-second/1-minute probe ledger. Only
 * verified completed rows are folded; failures, unknown outcomes and their
 * receipts remain append-only evidence.
 */
export function compactLegacyScheduledCapabilityExecutions(db: any): {
  tasksRemoved: number;
  receiptsRemoved: number;
  summariesUpdated: number;
} {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const receiptsByTask = groupTaskReceipts(tasks, receipts);
  let tasksRemoved = 0;
  let receiptsRemoved = 0;
  let summariesUpdated = 0;

  const scheduledTaskIds = new Set(tasks
    .filter(candidate => (
      candidate.intentKind === 'scheduled_task'
      && candidate.conversationId.startsWith('scheduler:')
      && candidate.target
    ))
    .map(candidate => candidate.target));

  for (const scheduledTaskId of scheduledTaskIds) {
    const summaryId = compactSchedulerAuditTaskId(scheduledTaskId);
    const candidates = tasks.filter(candidate => (
      candidate.id !== summaryId
      && candidate.conversationId === `scheduler:${scheduledTaskId}`
      && candidate.status === 'completed'
    ));
    const verified = candidates.filter(candidate => {
      const related = receiptsByTask.get(candidate.id) || [];
      return related.length > 0 && related.every(receipt => receipt.outcome === 'verified_success');
    });
    if (verified.length === 0) continue;

    verified.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removedIds = new Set(verified.map(candidate => candidate.id));
    const removedReceipts = verified.flatMap(candidate => receiptsByTask.get(candidate.id) || []);
    const summary = tasks.find(candidate => candidate.id === summaryId);
    const audit = parseSchedulerAudit(summary);
    const last = verified[verified.length - 1];
    const lastContext = parseObject(last.context);
    const migratedRecent = verified.slice(-36).map(candidate => ({
      executionId: candidate.id,
      status: 'verified',
      startedAt: candidate.createdAt,
      completedAt: candidate.completedAt || candidate.updatedAt,
    }));
    audit.totalExecutions = Number(audit.totalExecutions || 0) + verified.length;
    audit.completedCount = Number(audit.completedCount || 0) + verified.length;
    audit.compactedReceiptCount = Number(audit.compactedReceiptCount || 0) + removedReceipts.length;
    audit.receiptOutcomeCounts = {
      ...parseObject(audit.receiptOutcomeCounts),
      verified_success: Number(parseObject(audit.receiptOutcomeCounts).verified_success || 0) + removedReceipts.length,
    };
    audit.firstExecutionAt = audit.firstExecutionAt || verified[0].createdAt;
    audit.lastExecutionAt = last.updatedAt;
    audit.lastOutcome = 'verified';
    audit.currentExecution = migratedRecent[migratedRecent.length - 1];
    audit.recentExecutions = [
      ...(Array.isArray(audit.recentExecutions) ? audit.recentExecutions : []),
      ...migratedRecent,
    ].slice(-36);

    const values: ConversationActionTaskRow = {
      id: summaryId,
      conversationId: `scheduler:${scheduledTaskId}`,
      userId: 'system',
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: last.intentKind,
      operation: last.operation,
      goal: `Audit declared scheduled task ${scheduledTaskId}`,
      target: scheduledTaskId,
      status: 'completed',
      blocker: '',
      activeRequestId: '',
      completionSource: 'tool_receipt',
      context: JSON.stringify({
        ...parseObject(summary?.context),
        source: 'scheduler',
        scheduledTaskId,
        compactAudit: true,
        ...(lastContext.executionPlan ? { executionPlan: lastContext.executionPlan } : {}),
        schedulerAudit: audit,
      }),
      revision: Math.max(1, Number(summary?.revision || 0) + 1),
      createdAt: summary?.createdAt || verified[0].createdAt,
      updatedAt: last.updatedAt,
      completedAt: last.completedAt || last.updatedAt,
    };
    db.conversationActionTasks = tasks.filter(candidate => !removedIds.has(candidate.id));
    const refreshedTasks = db.conversationActionTasks as ConversationActionTaskRow[];
    const refreshedSummary = refreshedTasks.find(candidate => candidate.id === summaryId);
    if (refreshedSummary) Object.assign(refreshedSummary, values);
    else refreshedTasks.push(values);
    db.conversationActionReceipts = receipts.filter(receipt => !removedIds.has(receipt.taskId));
    tasks.splice(0, tasks.length, ...refreshedTasks);
    receipts.splice(0, receipts.length, ...(db.conversationActionReceipts as ConversationActionReceiptRow[]));
    tasksRemoved += verified.length;
    receiptsRemoved += removedReceipts.length;
    summariesUpdated += 1;
  }
  return { tasksRemoved, receiptsRemoved, summariesUpdated };
}

/**
 * Stores a scheduler execution in the shared action ledger. The scheduler has
 * no chat conversation, so it uses a namespaced conversation identity while
 * retaining the same append-only task/receipt schema and sanitization rules.
 */
export function persistScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
    compactAudit?: boolean;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  if (input.compactAudit) return persistCompactScheduledCapabilityExecution(db, input);
  const now = input.now || new Date().toISOString();
  const conversationId = `scheduler:${input.scheduledTaskId}`;
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let task = tasks.find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === conversationId
    && candidate.userId === 'system'
  ));
  const existingCompleted = task?.status === 'completed';
  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const existingContext = parseObject(task?.context);
  const context = {
    ...contextWithExecutionPlan(existingContext, persistedPlan),
    source: 'scheduler',
    scheduledTaskId: input.scheduledTaskId,
  };
  const status = existingCompleted ? 'completed' : input.status;
  const values: ConversationActionTaskRow = {
    id: input.plan.taskId,
    conversationId,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Execute declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status,
    blocker: existingCompleted ? '' : String(input.blocker || '').slice(0, 500),
    activeRequestId: input.plan.taskId,
    completionSource: status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify(context),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: existingCompleted ? task?.updatedAt || now : now,
    completedAt: status === 'completed' ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }
  appendConversationActionReceipts(db, {
    task,
    records: input.records || [],
    turnId: input.plan.taskId,
    requestId: input.plan.taskId,
    now,
  });
  return task;
}
