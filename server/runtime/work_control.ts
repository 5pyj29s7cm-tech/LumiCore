import {
  cancelTask,
  getTaskHistory,
  getTaskQueue,
  requestPauseAutonomousTask,
  resumeAutonomousTask,
  type AutonomousTask,
} from '../autonomy/task_queue';
import {
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverTask,
} from '../work_takeover/tasks';
import {
  buildTaskCompletionFeedback,
  type TaskCompletionFeedback,
  type TaskTerminalReceipt,
} from '../cognition/acceptance_evidence';
import {
  redactDiagnosticSecrets,
  sanitizeDiagnosticValue,
} from '../client/diagnostic_sanitizer';

export type RuntimeWorkKind = 'autonomy' | 'takeover';

export type RuntimeWorkPhase =
  | 'queued'
  | 'working'
  | 'pausing'
  | 'paused'
  | 'waiting_confirmation'
  | 'cancelling'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RuntimeWorkScope {
  domain: 'personal' | 'work';
  orgId?: string;
}

export interface RuntimeWorkProgress {
  checkpoint: string;
  completedUnits: number;
  totalUnits: number;
  receiptCount: number;
  toolCallCount: number;
  attempt: number;
  recoveryCount: number;
}

export interface RuntimeWorkControls {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
}

export interface RuntimeWorkEvidence {
  terminal: boolean;
  verification: 'verified' | 'unverified' | 'failed' | 'pending';
  evidenceCount: number;
  toolCount: number;
  reasonCode: string;
}

export interface RuntimeWorkItem {
  id: string;
  kind: RuntimeWorkKind;
  title: string;
  status: string;
  phase: RuntimeWorkPhase;
  updatedAt: string;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  scope: RuntimeWorkScope;
  conversationId: string;
  parentTaskId: string;
  source: string;
  nextAttemptAt: string;
  blocker: string;
  nextAction: string;
  progress: RuntimeWorkProgress;
  controls: RuntimeWorkControls;
  evidence: RuntimeWorkEvidence;
  completionFeedback: TaskCompletionFeedback;
}

export type RuntimeWorkDiagnostic = {
  source: RuntimeWorkKind | 'scope';
  code: 'runtime_work_source_unavailable' | 'runtime_work_invalid_scope';
};

export interface RuntimeWorkSnapshot {
  ok: boolean;
  status: 'idle' | 'active' | 'paused' | 'attention' | 'degraded';
  degraded: boolean;
  diagnostics: RuntimeWorkDiagnostic[];
  activeCount: number;
  pausedCount: number;
  blockedCount: number;
  scope?: RuntimeWorkScope;
  items: RuntimeWorkItem[];
  observedAt: string;
}

export interface RuntimeWorkCancellationResult {
  ok: boolean;
  status: 'idle' | 'cancelled' | 'cancelling' | 'partial' | 'failed';
  requestedTaskIds: string[];
  cancelledTaskIds: string[];
  cancellingTaskIds: string[];
  notCancelledTaskIds: string[];
  targetResults: Array<{
    taskId: string;
    status: 'cancelled' | 'cancelling' | 'already_terminal' | 'not_found' | 'failed';
  }>;
  matchedCount: number;
  cancelledCount: number;
  cancellingCount: number;
  failedCount: number;
  items: RuntimeWorkItem[];
  observedAt: string;
}

function bounded(value: unknown, max = 500): string {
  return redactDiagnosticSecrets(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizedScope(domain: unknown, orgId: unknown): RuntimeWorkScope {
  if (domain === 'work') {
    const normalizedOrgId = bounded(orgId, 180);
    return normalizedOrgId
      ? { domain: 'work', orgId: normalizedOrgId }
      : { domain: 'work' };
  }
  return { domain: 'personal' };
}

function invalidWorkScope(scope: RuntimeWorkScope | undefined): boolean {
  return scope?.domain === 'work' && !bounded(scope.orgId, 180);
}

function completionFeedbackProjection(input: {
  receipt?: TaskTerminalReceipt;
  title: string;
  status: string;
  reason?: string;
  accepted?: boolean;
}): TaskCompletionFeedback {
  const feedback = sanitizeDiagnosticValue(buildTaskCompletionFeedback(
    input.receipt,
    bounded(input.title, 240) || 'Task',
    {
      status: bounded(input.status, 60),
      reason: bounded(input.reason, 500),
      accepted: input.accepted,
    },
  ));
  return {
    ...feedback,
    blockers: feedback.blockers.length
      ? ['Runtime work is blocked or failed. Inspect the local runtime logs before retrying.']
      : [],
  };
}

function phaseForStatus(status: string): RuntimeWorkPhase {
  if (status === 'pending' || status === 'queued') return 'queued';
  if (status === 'running' || status === 'in_progress' || status === 'executing' || status === 'planning') return 'working';
  if (status === 'waiting_confirmation') return 'waiting_confirmation';
  if (status === 'pausing') return 'pausing';
  if (status === 'paused') return 'paused';
  if (status === 'cancelling') return 'cancelling';
  if (status === 'completed' || status === 'delivered') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'blocked';
}

function controlsForPhase(
  phase: RuntimeWorkPhase,
  checkpointCapable: boolean,
  blockedIsTerminal = false,
): RuntimeWorkControls {
  const terminal = ['completed', 'failed', 'cancelled'].includes(phase)
    || (blockedIsTerminal && phase === 'blocked');
  return {
    canPause: checkpointCapable && ['queued', 'working'].includes(phase),
    canResume: checkpointCapable && phase === 'paused',
    canCancel: !terminal && phase !== 'cancelling',
  };
}

function nextActionForPhase(
  phase: RuntimeWorkPhase,
  nextAttemptAt: unknown,
  activeAction = 'continue_execution',
): string {
  if (['completed', 'failed', 'cancelled'].includes(phase)) return '';
  if (phase === 'paused') return 'resume_from_checkpoint';
  if (bounded(nextAttemptAt, 80)) return 'retry_after_backoff';
  if (phase === 'blocked') return 'resolve_blocker';
  if (phase === 'waiting_confirmation') return 'provide_confirmation';
  if (phase === 'pausing') return 'wait_for_pause_checkpoint';
  if (phase === 'cancelling') return 'wait_for_cancellation';
  return activeAction;
}

function evidenceProjection(receipt: AutonomousTask['terminalReceipt']): RuntimeWorkEvidence {
  return receipt ? {
    terminal: true,
    verification: receipt.verification,
    evidenceCount: receipt.evidenceRefs.length,
    toolCount: receipt.toolNames.length,
    reasonCode: bounded(receipt.reasonCode, 120),
  } : {
    terminal: false,
    verification: 'pending',
    evidenceCount: 0,
    toolCount: 0,
    reasonCode: '',
  };
}

function autonomyItem(task: AutonomousTask): RuntimeWorkItem {
  const phase = phaseForStatus(task.status);
  const planNodes = task.executionPlan?.nodes || [];
  const completedNodeIds = task.checkpoint?.receiptIds || [];
  const title = bounded(task.title, 240) || task.id;
  const blocker = task.error || task.verificationReason || task.recovery?.blockedReason
    ? 'Autonomous task is blocked or failed. Inspect the local runtime logs before retrying.'
    : '';
  return {
    id: task.id,
    kind: 'autonomy',
    title,
    status: task.status,
    phase,
    updatedAt: task.updatedAt || task.startedAt || task.createdAt,
    cancellationRequested: Boolean(task.cancelRequestedAt),
    pauseRequested: Boolean(task.pauseRequestedAt),
    scope: { domain: 'personal' },
    conversationId: '',
    parentTaskId: bounded(task.planId, 180),
    source: bounded(task.source, 120),
    nextAttemptAt: bounded(task.nextAttemptAt, 80),
    blocker,
    nextAction: nextActionForPhase(phase, task.nextAttemptAt),
    progress: {
      checkpoint: bounded(task.checkpoint?.phase, 120),
      completedUnits: completedNodeIds.length,
      totalUnits: Math.max(planNodes.length, completedNodeIds.length),
      receiptCount: task.checkpoint?.receiptIds?.length || 0,
      toolCallCount: task.toolCallsCount || 0,
      attempt: task.attempt || 0,
      recoveryCount: task.recoveryCount || 0,
    },
    controls: controlsForPhase(phase, true, true),
    evidence: evidenceProjection(task.terminalReceipt),
    completionFeedback: completionFeedbackProjection({
      receipt: task.terminalReceipt,
      title,
      status: task.status,
      reason: blocker,
    }),
  };
}

function takeoverItem(task: WorkTakeoverTask): RuntimeWorkItem {
  const rawPhase = phaseForStatus(task.status);
  const verification = task.metadata?.workTakeoverVerification as {
    passed?: boolean;
    status?: string;
    checks?: Array<{ passed?: boolean }>;
  } | undefined;
  const deliveredWithoutVerification = task.status === 'delivered' && verification?.passed !== true;
  const phase: RuntimeWorkPhase = deliveredWithoutVerification ? 'blocked' : rawPhase;
  const verifiedChecks = verification?.checks?.filter(check => check.passed === true).length || 0;
  const title = bounded(task.title, 240) || task.id;
  const blocker = deliveredWithoutVerification
    ? 'Takeover delivery is present, but no verified terminal result was accepted.'
    : task.blockedBy.length > 0
      ? 'Takeover work is blocked. Inspect the local runtime details before retrying.'
      : '';
  return {
    id: task.id,
    kind: 'takeover',
    title,
    status: task.status,
    phase,
    updatedAt: task.updatedAt,
    cancellationRequested: false,
    pauseRequested: false,
    scope: normalizedScope(task.domain, task.orgId),
    conversationId: bounded(task.metadata?.conversationId, 180),
    parentTaskId: bounded(task.metadata?.actionTaskId, 180),
    source: bounded(task.source, 120),
    nextAttemptAt: '',
    blocker,
    nextAction: nextActionForPhase(
      phase,
      '',
      'continue_current_action',
    ),
    progress: {
      checkpoint: `action_${Math.max(0, task.currentActionIndex)}`,
      completedUnits: phase === 'completed'
        ? task.nextActions.length
        : Math.min(task.currentActionIndex, task.nextActions.length),
      totalUnits: task.nextActions.length,
      receiptCount: task.events.length,
      toolCallCount: 0,
      attempt: 0,
      recoveryCount: 0,
    },
    controls: controlsForPhase(phase, false),
    evidence: {
      terminal: task.status === 'delivered' || phase === 'cancelled',
      verification: verification?.passed === true
        ? 'verified'
          : verification?.status === 'blocked' || deliveredWithoutVerification
          ? 'failed'
          : phase === 'cancelled'
            ? 'unverified'
            : 'pending',
      evidenceCount: verifiedChecks,
      toolCount: 0,
      reasonCode: deliveredWithoutVerification ? 'missing_verified_takeover_result' : '',
    },
    completionFeedback: completionFeedbackProjection({
      title,
      status: task.status,
      reason: blocker,
      accepted: task.status === 'delivered' && verification?.passed === true,
    }),
  };
}

function itemMatchesScope(item: RuntimeWorkItem, scope?: RuntimeWorkScope): boolean {
  if (!scope) return true;
  if (item.scope.domain !== scope.domain) return false;
  return scope.domain !== 'work' || item.scope.orgId === bounded(scope.orgId, 180);
}

function normalizeKinds(kinds?: RuntimeWorkKind[]): Set<RuntimeWorkKind> {
  const valid = (kinds || []).filter((kind): kind is RuntimeWorkKind => (
    kind === 'autonomy' || kind === 'takeover'
  ));
  return new Set(valid.length > 0 ? valid : ['autonomy', 'takeover']);
}

export function getRuntimeWorkSnapshot(
  userId: string,
  kinds?: RuntimeWorkKind[],
  scope?: RuntimeWorkScope,
): RuntimeWorkSnapshot {
  const selected = normalizeKinds(kinds);
  const items: RuntimeWorkItem[] = [];
  const diagnostics: RuntimeWorkSnapshot['diagnostics'] = [];
  if (invalidWorkScope(scope)) {
    diagnostics.push({ source: 'scope', code: 'runtime_work_invalid_scope' });
    return {
      ok: false,
      status: 'degraded',
      degraded: true,
      diagnostics,
      activeCount: 0,
      pausedCount: 0,
      blockedCount: 0,
      scope: normalizedScope(scope?.domain, scope?.orgId),
      items: [],
      observedAt: new Date().toISOString(),
    };
  }
  if (selected.has('autonomy')) {
    if (!scope || scope.domain === 'personal') {
      try {
        const byId = new Map<string, AutonomousTask>();
        for (const task of [...getTaskQueue(userId), ...getTaskHistory(50, 0, userId)]) {
          if (!byId.has(task.id)) byId.set(task.id, task);
        }
        items.push(...Array.from(byId.values()).map(autonomyItem));
      } catch {
        diagnostics.push({ source: 'autonomy', code: 'runtime_work_source_unavailable' });
      }
    }
  }
  if (selected.has('takeover')) {
    try {
      const filter = {
        userId,
        ...(scope ? { domain: scope.domain, orgId: scope.domain === 'work' ? scope.orgId : '' } : {}),
      };
      const active = listWorkTakeoverTasks({ ...filter, status: 'active', limit: 150 });
      const delivered = listWorkTakeoverTasks({ ...filter, status: 'delivered', limit: 25 });
      const cancelled = listWorkTakeoverTasks({ ...filter, status: 'cancelled', limit: 25 });
      const byId = new Map<string, WorkTakeoverTask>();
      for (const task of [...active, ...delivered, ...cancelled]) byId.set(task.id, task);
      items.push(...Array.from(byId.values()).map(takeoverItem));
    } catch {
      diagnostics.push({ source: 'takeover', code: 'runtime_work_source_unavailable' });
    }
  }
  const scopedItems = items.filter(item => itemMatchesScope(item, scope));
  scopedItems.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeCount = scopedItems.filter(item => !['paused', 'blocked', 'failed', 'completed', 'cancelled'].includes(item.phase)).length;
  const pausedCount = scopedItems.filter(item => item.phase === 'paused').length;
  const blockedCount = scopedItems.filter(item => item.phase === 'blocked' || item.phase === 'failed').length;
  return {
    ok: diagnostics.length === 0,
    status: activeCount > 0
      ? 'active'
      : blockedCount > 0
        ? 'attention'
        : pausedCount > 0
          ? 'paused'
          : diagnostics.length > 0
            ? 'degraded'
            : 'idle',
    degraded: diagnostics.length > 0,
    diagnostics,
    activeCount,
    pausedCount,
    blockedCount,
    ...(scope ? { scope: normalizedScope(scope.domain, scope.orgId) } : {}),
    items: scopedItems,
    observedAt: new Date().toISOString(),
  };
}

export function pauseRuntimeWork(input: {
  userId: string;
  taskId?: string;
  kinds?: RuntimeWorkKind[];
  scope?: RuntimeWorkScope;
}) {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected], input.scope);
  const matched = before.items.filter(item => (
    (!input.taskId || item.id === input.taskId)
    && item.controls.canPause
    && item.kind === 'autonomy'
  ));
  const items: RuntimeWorkItem[] = [];
  for (const item of matched) {
    const task = requestPauseAutonomousTask(item.id, input.userId);
    if (task) items.push(autonomyItem(task));
  }
  const pausingCount = items.filter(item => item.status === 'pausing').length;
  const pausedCount = items.filter(item => item.status === 'paused').length;
  const requestRejected = invalidWorkScope(input.scope) || Boolean(input.taskId && matched.length === 0);
  const failedCount = Math.max(0, matched.length - pausedCount - pausingCount) + (requestRejected ? 1 : 0);
  return {
    ok: !requestRejected && (matched.length === 0 || failedCount === 0),
    status: requestRejected
      ? 'failed' as const
      : matched.length === 0
      ? 'idle' as const
      : failedCount === matched.length
        ? 'failed' as const
        : failedCount > 0
          ? 'partial' as const
          : pausingCount > 0
            ? 'pausing' as const
            : 'paused' as const,
    matchedCount: matched.length,
    pausedCount,
    pausingCount,
    failedCount,
    items,
    observedAt: new Date().toISOString(),
  };
}

export function resumeRuntimeWork(input: {
  userId: string;
  taskId?: string;
  kinds?: RuntimeWorkKind[];
  scope?: RuntimeWorkScope;
}) {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected], input.scope);
  const matched = before.items.filter(item => (
    (!input.taskId || item.id === input.taskId)
    && item.status === 'paused'
    && item.kind === 'autonomy'
  ));
  const items: RuntimeWorkItem[] = [];
  for (const item of matched) {
    const task = resumeAutonomousTask(item.id, input.userId);
    if (task) {
      const projected = autonomyItem(task);
      if (projected.phase === 'queued' || projected.phase === 'working') items.push(projected);
    }
  }
  const resumedCount = items.length;
  const requestRejected = invalidWorkScope(input.scope) || Boolean(input.taskId && matched.length === 0);
  const failedCount = Math.max(0, matched.length - resumedCount) + (requestRejected ? 1 : 0);
  return {
    ok: !requestRejected && (matched.length === 0 || failedCount === 0),
    status: requestRejected
      ? 'failed' as const
      : matched.length === 0
      ? 'idle' as const
      : failedCount === matched.length
        ? 'failed' as const
        : failedCount > 0
          ? 'partial' as const
          : 'resumed' as const,
    matchedCount: matched.length,
    resumedCount,
    failedCount,
    items,
    observedAt: new Date().toISOString(),
  };
}

export function cancelRuntimeWork(input: {
  userId: string;
  taskId?: string;
  taskIds?: string[];
  kinds?: RuntimeWorkKind[];
  scope?: RuntimeWorkScope;
}): RuntimeWorkCancellationResult {
  const selected = normalizeKinds(input.kinds);
  const before = getRuntimeWorkSnapshot(input.userId, [...selected], input.scope);
  const requestedTaskIds = Array.from(new Set([
    ...(Array.isArray(input.taskIds) ? input.taskIds : []),
    ...(input.taskId ? [input.taskId] : []),
  ].map(item => bounded(item, 180)).filter(Boolean))).slice(0, 64);
  const hasExactTargetSet = Array.isArray(input.taskIds) || Boolean(input.taskId);
  const requestedTaskIdSet = new Set(requestedTaskIds);
  const matched = hasExactTargetSet
    ? before.items.filter(item => requestedTaskIdSet.has(item.id) && item.controls.canCancel)
    : before.items.filter(item => item.controls.canCancel);
  // Rechecking an exact cancellation is idempotent. A task that already
  // entered `cancelling` must remain an accepted in-progress target instead of
  // being misreported as a fresh failure merely because canCancel is now false.
  const alreadyCancelling = hasExactTargetSet
    ? before.items.filter(item => (
        requestedTaskIdSet.has(item.id)
        && item.phase === 'cancelling'
      ))
    : [];

  const acceptedIds = new Set<string>(alreadyCancelling.map(item => item.id));
  for (const item of matched) {
    if (item.kind === 'autonomy') {
      if (cancelTask(item.id, input.userId)) acceptedIds.add(item.id);
      continue;
    }
    const updated = updateWorkTakeoverTask(input.userId, item.id, {
      status: 'cancelled',
      note: 'Cancelled by the user through runtime work control.',
    });
    if (updated?.status === 'cancelled') acceptedIds.add(item.id);
  }

  const afterItems = getRuntimeWorkSnapshot(input.userId, [...selected], input.scope).items;
  const outcomeCandidates = Array.from(new Map(
    [...matched, ...alreadyCancelling].map(item => [item.id, item]),
  ).values());
  const outcomeItems = outcomeCandidates.filter(item => acceptedIds.has(item.id)).map(item => {
    const remaining = afterItems.find(candidate => candidate.id === item.id);
    if (!remaining) return {
      ...item,
      status: 'cancelled',
      phase: 'cancelled' as const,
      cancellationRequested: true,
      pauseRequested: false,
      nextAction: '',
      controls: { canPause: false, canResume: false, canCancel: false },
      evidence: {
        terminal: true,
        verification: 'unverified' as const,
        evidenceCount: item.evidence.evidenceCount,
        toolCount: item.evidence.toolCount,
        reasonCode: item.evidence.reasonCode || 'user_cancelled',
      },
      completionFeedback: completionFeedbackProjection({
        title: item.title,
        status: 'cancelled',
        reason: 'user_cancelled',
      }),
    };
    return remaining;
  });
  const cancellingCount = outcomeItems.filter(item => (
    item.status === 'cancelling'
    || (item.status === 'running' && item.cancellationRequested)
  )).length;
  const cancelledCount = outcomeItems.filter(item => item.phase === 'cancelled').length;
  const cancelledTaskIds = outcomeItems
    .filter(item => item.phase === 'cancelled')
    .map(item => item.id);
  const cancellingTaskIds = outcomeItems
    .filter(item => item.phase === 'cancelling' || item.cancellationRequested)
    .map(item => item.id)
    .filter(id => !cancelledTaskIds.includes(id));
  const beforeById = new Map(before.items.map(item => [item.id, item]));
  const alreadyTerminalTaskIds = hasExactTargetSet
    ? requestedTaskIds.filter(id => {
        const item = beforeById.get(id);
        return Boolean(item && item.evidence.terminal && !item.controls.canCancel);
      })
    : [];
  const notCancelledTaskIds = hasExactTargetSet
    ? requestedTaskIds.filter(id => (
        !acceptedIds.has(id) && !alreadyTerminalTaskIds.includes(id)
      ))
    : [];
  const targetResults = requestedTaskIds.map(taskId => {
    if (cancelledTaskIds.includes(taskId)) return { taskId, status: 'cancelled' as const };
    if (cancellingTaskIds.includes(taskId)) return { taskId, status: 'cancelling' as const };
    if (alreadyTerminalTaskIds.includes(taskId)) return { taskId, status: 'already_terminal' as const };
    if (!beforeById.has(taskId)) return { taskId, status: 'not_found' as const };
    return { taskId, status: 'failed' as const };
  });
  const invalidScope = invalidWorkScope(input.scope);
  const requestRejected = invalidScope || Boolean(
    hasExactTargetSet
    && requestedTaskIds.length > 0
    && acceptedIds.size === 0
    && alreadyTerminalTaskIds.length === 0
  );
  const failedCount = invalidScope
    ? 1
    : hasExactTargetSet
      ? notCancelledTaskIds.length
      : Math.max(0, matched.length - acceptedIds.size);
  return {
    ok: !requestRejected && failedCount === 0,
    status: requestRejected
      ? 'failed'
      : hasExactTargetSet && requestedTaskIds.length === 0
        ? 'idle'
      : failedCount > 0
        ? acceptedIds.size > 0 || alreadyTerminalTaskIds.length > 0
          ? 'partial'
          : 'failed'
      : cancellingCount > 0
        ? 'cancelling'
      : acceptedIds.size > 0
        ? 'cancelled'
        : 'idle',
    requestedTaskIds,
    cancelledTaskIds,
    cancellingTaskIds,
    notCancelledTaskIds,
    targetResults,
    matchedCount: matched.length,
    cancelledCount,
    cancellingCount,
    failedCount,
    items: outcomeItems,
    observedAt: new Date().toISOString(),
  };
}
