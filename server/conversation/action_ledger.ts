import crypto from 'node:crypto';
import {
  formatConversationActionTaskStatus,
  normalizeConversationActionState,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import { normalizeActionIntent, type NormalizedActionIntent } from '../cognition/normalized_action_intent';
import { taskReceiptsToRecords, type ConversationTaskStatus } from '../cognition/task_execution_ledger';
import { buildToolExecutionEnvelope, toolRecordIdempotencyKey } from '../tools/execution_envelope';
import type { ToolExecutionRecord } from '../tools/types';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type {
  ModelExecutionGraph,
  ModelGraphArbitrationReceipt,
  ModelGraphNodeReceipt,
} from '../agents/model_execution_graph';

export interface ConversationActionTaskRow {
  id: string;
  conversationId: string;
  userId: string;
  domain: string;
  orgId: string;
  parentTaskId: string;
  rootUserMessageId: string;
  intentKind: string;
  operation: string;
  goal: string;
  target: string;
  status: ConversationTaskStatus;
  blocker: string;
  activeRequestId: string;
  completionSource: string;
  context: string | Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface ConversationActionReceiptRow {
  id: string;
  taskId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  idempotencyKey: string;
  toolName: string;
  targetIdentity: string;
  inputDigest: string;
  envelope: string;
  outcome: string;
  createdAt: string;
}

export interface PersistedCapabilityExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  intent: Omit<NormalizedActionIntent, 'payload'> & {
    payload: '';
    payloadDigest: string;
  };
  nodes: Array<{
    nodeId: string;
    type: string;
    capabilityId: string;
    toolName?: string;
    lane: string;
    operation: string;
    risk: string;
    requiresConfirmation: boolean;
    verificationStrategy: string;
    executionRole: 'planner' | 'adapter' | 'verifier' | 'join';
    selectionGroup?: string;
    selectionRank?: number;
  }>;
  edges: CapabilityExecutionPlan['edges'];
  expectedEvidence: CapabilityExecutionPlan['expectedEvidence'];
  risk: CapabilityExecutionPlan['risk'];
  fallbackPolicy: CapabilityExecutionPlan['fallbackPolicy'];
  contextRefs: CapabilityExecutionPlan['contextRefs'];
  decisionAuthority: 'semantic_planner';
  scriptAuthority: 'adapter_only';
  persistedAt: string;
}

export interface ConversationModelExecutionRecovery {
  graph: ModelExecutionGraph;
  receipts: ModelGraphNodeReceipt[];
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key], depth + 1),
  ]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function redactArguments(args: Record<string, any>): Record<string, any> {
  const sensitive = /^(?:message|text|content|body|payload|draft|password|secret|token|api.?key)$/i;
  return Object.fromEntries(Object.entries(args || {}).map(([key, value]) => (
    sensitive.test(key)
      ? [key, { digest: digest(value), length: typeof value === 'string' ? value.length : undefined }]
      : [key, stableValue(value)]
  )));
}

function redactGoal(goal: string, intent: NormalizedActionIntent): string {
  if (intent.sideEffectClass !== 'external_commit' || !intent.payload) return String(goal || '').slice(0, 700);
  return `${intent.kind}:${intent.target || '(unresolved target)'} payload_sha256=${digest(intent.payload)}`;
}

function sanitizeState(state: ConversationActionContinuationState): ConversationActionContinuationState {
  return {
    ...state,
    receipts: (state.receipts || []).map(receipt => ({
      ...receipt,
      arguments: redactArguments(receipt.arguments || {}),
    })),
  };
}

export function sanitizeCapabilityExecutionPlan(
  plan: CapabilityExecutionPlan,
  persistedAt: string,
): PersistedCapabilityExecutionPlan {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    intent: {
      ...plan.intent,
      payload: '',
      payloadDigest: digest(plan.intent.payload),
    },
    nodes: plan.nodes.map(node => ({
      nodeId: node.nodeId,
      type: node.type,
      capabilityId: node.capabilityId,
      ...(node.toolName ? { toolName: node.toolName } : {}),
      lane: node.lane,
      operation: node.operation,
      risk: node.risk,
      requiresConfirmation: node.requiresConfirmation,
      verificationStrategy: node.verification.strategy,
      executionRole: node.executionRole,
      ...(node.selectionGroup ? { selectionGroup: node.selectionGroup } : {}),
      ...(node.selectionRank !== undefined ? { selectionRank: node.selectionRank } : {}),
    })),
    edges: plan.edges.map(edge => ({ ...edge })),
    expectedEvidence: plan.expectedEvidence.map(requirement => ({
      ...requirement,
      requiredFields: [...requirement.requiredFields],
      ...(requirement.requiredValues ? { requiredValues: { ...requirement.requiredValues } } : {}),
      requiredArtifacts: [...requirement.requiredArtifacts],
      successStatuses: [...requirement.successStatuses],
    })),
    risk: {
      ...plan.risk,
      reasons: [...plan.risk.reasons],
      ...(plan.risk.confirmationBinding
        ? { confirmationBinding: { ...plan.risk.confirmationBinding } }
        : {}),
    },
    fallbackPolicy: { ...plan.fallbackPolicy },
    contextRefs: plan.contextRefs.map(ref => ({ ...ref })),
    decisionAuthority: plan.decisionAuthority,
    scriptAuthority: plan.scriptAuthority,
    persistedAt,
  };
}

function ensureTables(db: any): void {
  if (!Array.isArray(db.conversationActionTasks)) db.conversationActionTasks = [];
  if (!Array.isArray(db.conversationActionReceipts)) db.conversationActionReceipts = [];
}

function latestParentTask(
  tasks: ConversationActionTaskRow[],
  conversationId: string,
  currentTaskId: string,
): ConversationActionTaskRow | undefined {
  return tasks
    .filter(task => task.conversationId === conversationId && task.id !== currentTaskId)
    .filter(task => task.intentKind === 'cad_drafting' || /(?:Auto\s*CAD|\bCAD\b|图纸|平面图)/iu.test(`${task.goal} ${task.target}`)) // i18n-allow: Chinese CAD task matching; not user-visible copy.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function syncConversationActionTaskLedger(
  db: any,
  input: {
    conversation: { id: string; userId: string; domain?: string; orgId?: string };
    state: ConversationActionContinuationState;
    userText?: string;
    rootUserMessageId?: string;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const state = normalizeConversationActionState(input.state);
  if (!state?.taskId) return null;
  const now = input.now || state.updatedAt || new Date().toISOString();
  const intent = normalizeActionIntent(input.userText || state.latestInstruction || state.goal);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let task = tasks.find(candidate => candidate.id === state.taskId);
  const parent = intent.relation === 'child'
    ? latestParentTask(tasks, input.conversation.id, state.taskId)
    : undefined;
  const parentContext = parent ? parseObject(parent.context) : {};
  const parentState = normalizeConversationActionState(parentContext.actionState);
  const context = {
    ...parentContext,
    sourceTaskId: parent?.id || parentContext.sourceTaskId || '',
    inheritedArtifacts: Array.from(new Set([
      ...(Array.isArray(parentContext.inheritedArtifacts) ? parentContext.inheritedArtifacts : []),
      ...(parentState?.sourcePaths || []),
    ])).slice(0, 20),
    inheritedReceipts: parentState?.receipts || parentContext.inheritedReceipts || [],
    actionState: sanitizeState(state),
  };
  const completed = state.status === 'completed' || !state.unfinished;
  const values: ConversationActionTaskRow = {
    id: state.taskId,
    conversationId: input.conversation.id,
    userId: input.conversation.userId,
    domain: input.conversation.domain || 'personal',
    orgId: input.conversation.orgId || '',
    parentTaskId: parent?.id || task?.parentTaskId || '',
    rootUserMessageId: task?.rootUserMessageId || input.rootUserMessageId || '',
    intentKind: intent.kind === 'none' ? task?.intentKind || 'desktop_operation' : intent.kind,
    operation: intent.kind === 'none' ? task?.operation || 'mutate' : intent.operation,
    goal: redactGoal(state.goal, intent),
    target: intent.target || state.appTarget || task?.target || '',
    status: state.status || (state.unfinished ? 'blocked' : 'completed'),
    blocker: state.latestBlocker || '',
    activeRequestId: state.activeRequestId || '',
    completionSource: state.completionSource || '',
    context: JSON.stringify(context),
    revision: Math.max(task?.revision || 0, state.revision || 0, 1),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: completed ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const records = taskReceiptsToRecords(state.receipts || []);
  appendConversationActionReceipts(db, {
    task,
    records,
    turnId: state.evidenceMessageId || input.rootUserMessageId || '',
    requestId: state.activeRequestId || '',
    now,
  });
  return task;
}

export function appendConversationActionReceipts(
  db: any,
  input: {
    task: ConversationActionTaskRow;
    records: ToolExecutionRecord[];
    turnId?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionReceiptRow[] {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const appended: ConversationActionReceiptRow[] = [];
  input.records.forEach((rawRecord, index) => {
    const record: ToolExecutionRecord = {
      ...rawRecord,
      taskId: rawRecord.taskId || input.task.id,
      turnId: rawRecord.turnId || input.turnId,
      requestId: rawRecord.requestId || input.requestId,
      idempotencyKey: rawRecord.idempotencyKey || toolRecordIdempotencyKey(rawRecord),
    };
    const envelope = buildToolExecutionEnvelope(record, {
      taskId: input.task.id,
      turnId: input.turnId,
      requestId: input.requestId,
      completedAt: now,
    });
    const duplicate = receipts.some(candidate => (
      candidate.taskId === input.task.id
      && candidate.idempotencyKey === envelope.idempotencyKey
      && candidate.toolName === record.name
      && candidate.outcome === envelope.status
    ));
    if (duplicate) return;
    const row: ConversationActionReceiptRow = {
      id: String(record.id || `receipt_${crypto.randomUUID()}_${index}`),
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      turnId: envelope.turnId,
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      toolName: envelope.toolName,
      targetIdentity: envelope.targetIdentity,
      inputDigest: digest(record.arguments || {}),
      envelope: JSON.stringify(envelope),
      outcome: envelope.status,
      createdAt: now,
    };
    receipts.push(row);
    appended.push(row);
  });
  return appended;
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
  },
): ConversationActionTaskRow {
  ensureTables(db);
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
    ...existingContext,
    source: 'scheduler',
    scheduledTaskId: input.scheduledTaskId,
    executionPlan: persistedPlan,
    executionPlans: [
      ...(Array.isArray(existingContext.executionPlans)
        ? existingContext.executionPlans.filter((candidate: any) => candidate?.planId !== persistedPlan.planId)
        : []),
      persistedPlan,
    ].slice(-12),
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

/**
 * Persists the semantic plan in the existing append-compatible task context.
 * Raw message payloads are never stored; confirmation uses the digest already
 * bound to the durable task identity.
 */
export function attachConversationExecutionPlan(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    plan: CapabilityExecutionPlan;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persisted = sanitizeCapabilityExecutionPlan(input.plan, now);
  const history = (Array.isArray(context.executionPlans) ? context.executionPlans : [])
    .filter((candidate: any) => candidate?.planId !== persisted.planId)
    .slice(-11);
  history.push(persisted);
  task.context = JSON.stringify({
    ...context,
    executionPlan: persisted,
    executionPlans: history,
  });
  task.updatedAt = now;
  return task;
}

/** Stores the compiled graph and digest-only node receipts for restart recovery. */
export function attachConversationModelExecutionGraph(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    taskId: string;
    graph: ModelExecutionGraph;
    receipts: ModelGraphNodeReceipt[];
    arbitrationReceipt?: ModelGraphArbitrationReceipt;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task || input.graph.taskId !== task.id) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persistedGraph = {
    ...input.graph,
    nodes: input.graph.nodes.map(node => ({
      ...node,
      candidates: node.candidates.map(candidate => ({ ...candidate })),
      dependsOn: [...node.dependsOn],
      inputRefs: [...node.inputRefs],
      outputSchema: { ...node.outputSchema },
    })),
    edges: input.graph.edges.map(edge => ({ ...edge })),
    budgets: { ...input.graph.budgets },
    persistedAt: now,
  };
  const graphHistory = (Array.isArray(context.modelExecutionGraphs) ? context.modelExecutionGraphs : [])
    .filter((candidate: any) => candidate?.graphId !== persistedGraph.graphId)
    .slice(-7);
  graphHistory.push(persistedGraph);
  const priorReceipts = Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [];
  const receiptKeys = new Set(input.receipts.map(receipt => `${receipt.graphId}:${receipt.nodeId}`));
  const modelNodeReceipts = [
    ...priorReceipts.filter((receipt: any) => !receiptKeys.has(`${receipt?.graphId}:${receipt?.nodeId}`)),
    ...input.receipts.map(receipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: receipt.status,
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: receipt.agentId } : {}),
      dependencyReceiptIds: [...receipt.dependencyReceiptIds],
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      durationMs: receipt.durationMs,
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      verified: receipt.verified,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: receipt.estimatedInputTokens }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: receipt.estimatedCostUsd }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: receipt.reusedFromReceipt } : {}),
      // Model output and free-form errors can contain user data. Durable recovery
      // intentionally stores only digests and bounded structural metadata.
      ...(receipt.error ? { error: 'model_node_execution_failed' } : {}),
    })),
  ].slice(-120);
  task.context = JSON.stringify({
    ...context,
    modelExecutionGraph: persistedGraph,
    modelExecutionGraphs: graphHistory,
    modelNodeReceipts,
    ...(input.arbitrationReceipt ? {
      modelArbitrationReceipt: {
        ...input.arbitrationReceipt,
        selectedNodeIds: [...input.arbitrationReceipt.selectedNodeIds],
        consideredNodeIds: [...input.arbitrationReceipt.consideredNodeIds],
      },
    } : {}),
  });
  task.updatedAt = now;
  return task;
}

/**
 * Loads restart state only from the exact scoped task. Legacy receipts without
 * a semantic node fingerprint are excluded and therefore cannot be replayed.
 */
export function loadConversationModelExecutionRecovery(
  db: any,
  input: { conversationId: string; userId: string; taskId: string },
): ConversationModelExecutionRecovery | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const context = parseObject(task.context);
  const graph = context.modelExecutionGraph as ModelExecutionGraph | undefined;
  if (!graph || graph.taskId !== task.id || !Array.isArray(graph.nodes)) return null;
  const receipts = (Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [])
    .filter((receipt: any) => (
      receipt
      && receipt.taskId === task.id
      && receipt.graphId === graph.graphId
      && typeof receipt.nodeId === 'string'
      && typeof receipt.nodeFingerprint === 'string'
      && receipt.nodeFingerprint.length === 64
      && typeof receipt.outputDigest === 'string'
      && receipt.outputDigest.length === 64
      && receipt.status === 'succeeded'
      && receipt.verified === true
    ))
    .map((receipt: any): ModelGraphNodeReceipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: 'succeeded',
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: String(receipt.agentId) } : {}),
      dependencyReceiptIds: Array.isArray(receipt.dependencyReceiptIds)
        ? receipt.dependencyReceiptIds.map(String)
        : [],
      startedAt: String(receipt.startedAt || ''),
      completedAt: String(receipt.completedAt || ''),
      durationMs: Math.max(0, Number(receipt.durationMs) || 0),
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      verified: true,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: Math.max(0, Number(receipt.estimatedInputTokens) || 0) }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: Math.max(0, Number(receipt.estimatedCostUsd) || 0) }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: String(receipt.reusedFromReceipt) } : {}),
    }));
  return { graph, receipts };
}

export function findConversationActionTask(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const intent = normalizeActionIntent(input.query || '');
  const query = String(input.query || '').toLowerCase();
  return (db.conversationActionTasks as ConversationActionTaskRow[])
    .filter(task => task.conversationId === input.conversationId && task.userId === input.userId)
    .map(task => {
      const haystack = `${task.intentKind} ${task.goal} ${task.target}`.toLowerCase();
      let score = 0;
      if (intent.target && haystack.includes(intent.target.toLowerCase())) score += 8;
      if (intent.target === 'AutoCAD' && /cad|图纸|平面图/i.test(haystack)) score += 8; // i18n-allow: Chinese CAD task matching; not user-visible copy.
      if (intent.kind !== 'status_query' && intent.kind !== 'none' && task.intentKind === intent.kind) score += 6;
      if (query && haystack.includes(query)) score += 3;
      return { task, score };
    })
    .sort((left, right) => right.score - left.score || right.task.updatedAt.localeCompare(left.task.updatedAt))[0]?.task || null;
}

export function formatConversationActionLedgerStatus(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): string | null {
  const task = findConversationActionTask(db, input);
  if (!task) return null;
  const context = parseObject(task.context);
  const persisted = normalizeConversationActionState(context.actionState);
  const state = normalizeConversationActionState({
    ...(persisted || {}),
    version: 2,
    taskId: task.id,
    goal: persisted?.goal || task.goal,
    latestInstruction: persisted?.latestInstruction || persisted?.goal || task.goal,
    status: task.status,
    latestBlocker: task.blocker,
    activeRequestId: task.activeRequestId || undefined,
    completionSource: task.completionSource === 'user_observation' ? 'user_observation' : task.completionSource === 'tool_receipt' ? 'tool_receipt' : undefined,
    unfinished: task.status !== 'completed' && task.status !== 'cancelled',
    updatedAt: task.updatedAt,
    appTarget: persisted?.appTarget || task.target,
    sourcePaths: persisted?.sourcePaths || [],
    evidenceTools: persisted?.evidenceTools || [],
    assistantState: persisted?.assistantState || '',
    toolSummaries: persisted?.toolSummaries || [],
    receipts: persisted?.receipts || [],
  } as ConversationActionContinuationState);
  return formatConversationActionTaskStatus(state);
}

export function migrateLegacyConversationActionLedger(db: any): number {
  ensureTables(db);
  let migrated = 0;
  for (const conversation of db.conversations || []) {
    const state = normalizeConversationActionState(conversation.actionContinuationState);
    if (!state?.taskId) continue;
    if ((db.conversationActionTasks as ConversationActionTaskRow[]).some(task => task.id === state.taskId)) continue;
    if (syncConversationActionTaskLedger(db, { conversation, state, now: state.updatedAt })) migrated += 1;
  }
  return migrated;
}
