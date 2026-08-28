import { Router } from 'express';
import { requireAuth, resolveDomain } from '../middleware/auth';
import { getGateConfig, saveGateConfig } from '../autonomy/safety_gate';
import {
  cancelTask,
  getTaskHistory,
  getTaskQueue,
  requestPauseAutonomousTask,
  resumeAutonomousTask,
  type AutonomousTask,
} from '../autonomy/task_queue';
import {
  buildTaskCompletionFeedback,
  type TaskTerminalReceipt,
} from '../cognition/acceptance_evidence';
import {
  cancelRuntimeWork,
  getRuntimeWorkSnapshot,
  pauseRuntimeWork,
  resumeRuntimeWork,
} from '../runtime/work_control';
import {
  redactDiagnosticSecrets,
  sanitizeDiagnosticValue,
} from '../client/diagnostic_sanitizer';

type TaskScope = { domain: 'personal' | 'work'; orgId: string };

function boundedText(value: unknown, limit = 700): string | undefined {
  const text = redactDiagnosticSecrets(value)
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, limit) : undefined;
}

function publicAutonomyIssue(status: string, present: boolean): string | undefined {
  if (!present) return undefined;
  if (status === 'blocked') return 'Autonomous task is blocked. Review its controls or local runtime logs before retrying.';
  if (status === 'failed') return 'Autonomous task failed. Inspect the local runtime logs before retrying.';
  return 'Autonomous task requires attention. Inspect the local runtime logs for details.';
}

function withCompletionFeedback<T extends {
  title?: string;
  status?: string;
  error?: string;
  terminalReceipt?: TaskTerminalReceipt;
}>(task: T): T & { completionFeedback: ReturnType<typeof buildTaskCompletionFeedback> } {
  const rawFeedback = sanitizeDiagnosticValue(buildTaskCompletionFeedback(
    task.terminalReceipt,
    task.title || 'Task',
    { status: task.status, reason: task.error },
  ));
  return {
    ...task,
    completionFeedback: {
      ...rawFeedback,
      blockers: rawFeedback.blockers.length
        ? [task.error || 'Autonomous task is not verified complete. Inspect local runtime details.']
        : [],
    },
  };
}

export function autonomousTaskMatchesScope(task: AutonomousTask, scope: TaskScope): boolean {
  // Autonomous execution is currently personal-only (the executor enforces the
  // same boundary). Keep future persisted scope fields forward-compatible.
  const record = task as AutonomousTask & { domain?: string; orgId?: string };
  const domain = record.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(record.orgId || '').trim() : '';
  if (scope.domain === 'work' && !scope.orgId.trim()) return false;
  if (domain === 'work' && !orgId) return false;
  return domain === scope.domain && (domain === 'personal' || orgId === scope.orgId);
}

function autonomousControls(status: string) {
  return {
    canPause: status === 'pending' || status === 'running',
    canResume: status === 'paused',
    canCancel: ['pending', 'running', 'pausing', 'paused'].includes(status),
  };
}

export function runtimeControlSucceeded(result: {
  ok: boolean;
  matchedCount: number;
  status?: string;
  failedCount?: number;
}): boolean {
  return result.ok
    && result.matchedCount > 0
    && Number(result.failedCount || 0) === 0
    && !['idle', 'failed', 'partial'].includes(String(result.status || ''));
}

function runtimeControlError(action: 'pause' | 'resume' | 'cancel', status: string): string {
  return `Runtime work ${action} did not reach an accepted state (${status}). Refresh the task state before retrying.`;
}

export function runtimeControlHttpOutcome(
  action: 'pause' | 'resume' | 'cancel',
  result: { ok: boolean; matchedCount: number; status: string; failedCount?: number },
) {
  const accepted = runtimeControlSucceeded(result);
  return {
    accepted,
    httpStatus: accepted ? 200 : 409,
    ...(accepted ? {} : { error: runtimeControlError(action, result.status) }),
  };
}

export function projectAutonomousTask(task: AutonomousTask) {
  const error = publicAutonomyIssue(task.status, Boolean(task.error));
  const verificationReason = task.verificationReason
    ? 'Autonomous task verification did not accept the current result.'
    : undefined;
  const projected = withCompletionFeedback({
    id: task.id,
    kind: 'autonomy' as const,
    title: boundedText(task.title, 240) || task.id,
    status: task.status,
    source: boundedText(task.source, 120) || '',
    planId: boundedText(task.planId, 180),
    priority: Math.max(0, Math.min(10, Number(task.priority || 0))),
    mode: task.mode,
    phase: boundedText(task.checkpoint?.phase, 80),
    toolCallsCount: Math.max(0, Number(task.toolCallsCount || 0)),
    tokensUsed: Math.max(0, Number(task.tokensUsed || 0)),
    cancelRequested: Boolean(task.cancelRequestedAt) || task.status === 'cancelled',
    pauseRequested: Boolean(task.pauseRequestedAt) || task.status === 'pausing',
    controls: autonomousControls(task.status),
    result: boundedText(task.result, 1_200),
    error,
    finalized: task.finalized === true,
    blocked: task.blocked === true,
    verified: task.verified === true,
    verificationReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    terminalReceipt: task.terminalReceipt,
  });
  const { terminalReceipt: _terminalReceipt, ...safe } = projected;
  return safe;
}

export function autonomyRoutes(): Router {
  const router = Router();

  // Safety gate config
  router.get('/gate_config', requireAuth, (req, res) => {
    res.json(getGateConfig(req.user!.uid));
  });

  router.put('/gate_config', requireAuth, (req, res) => {
    const updated = saveGateConfig(req.body || {}, req.user!.uid);
    res.json(updated);
  });

  // Canonical, scope-bound task-center projection. It deliberately excludes
  // prompts, provider configuration, leases and raw tool payloads.
  router.get('/work', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    res.json(getRuntimeWorkSnapshot(req.user!.uid, undefined, scope));
  });

  router.post('/work/:id/pause', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const before = getRuntimeWorkSnapshot(req.user!.uid, undefined, scope);
    const task = before.items.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Runtime work item not found.' });
    if (!task.controls.canPause) return res.status(409).json({ error: 'Runtime work item is not pausable.', task });
    const result = pauseRuntimeWork({ userId: req.user!.uid, taskId: task.id, kinds: [task.kind], scope });
    const outcome = runtimeControlHttpOutcome('pause', result);
    res.status(outcome.httpStatus).json({
      ...result,
      ok: outcome.accepted,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  });

  router.post('/work/:id/resume', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const before = getRuntimeWorkSnapshot(req.user!.uid, undefined, scope);
    const task = before.items.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Runtime work item not found.' });
    if (!task.controls.canResume) return res.status(409).json({ error: 'Runtime work item is not resumable.', task });
    const result = resumeRuntimeWork({ userId: req.user!.uid, taskId: task.id, kinds: [task.kind], scope });
    const outcome = runtimeControlHttpOutcome('resume', result);
    res.status(outcome.httpStatus).json({
      ...result,
      ok: outcome.accepted,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  });

  router.post('/work/:id/cancel', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const before = getRuntimeWorkSnapshot(req.user!.uid, undefined, scope);
    const task = before.items.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Runtime work item not found.' });
    if (!task.controls.canCancel) return res.status(409).json({ error: 'Runtime work item is not cancellable.', task });
    const result = cancelRuntimeWork({ userId: req.user!.uid, taskId: task.id, kinds: [task.kind], scope });
    const outcome = runtimeControlHttpOutcome('cancel', result);
    res.status(outcome.httpStatus).json({
      ...result,
      ok: outcome.accepted,
      cancelRequested: result.items.some(item => item.cancellationRequested),
      cancelled: outcome.accepted && result.status === 'cancelled',
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  });

  // Task queue
  router.get('/queue', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const queue = getTaskQueue(req.user!.uid)
      .filter(task => autonomousTaskMatchesScope(task, scope))
      .map(projectAutonomousTask);
    res.json({ queue, scope });
  });

  router.get('/history', requireAuth, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const scope = resolveDomain(req.user!);
    const tasks = getTaskHistory(Math.min(200, limit + offset), 0, req.user!.uid)
      .filter(task => autonomousTaskMatchesScope(task, scope))
      .slice(offset, offset + limit)
      .map(projectAutonomousTask);
    res.json({ tasks, scope });
  });

  router.post('/tasks/:id/cancel', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const existing = getTaskQueue(req.user!.uid).find(task => (
      task.id === req.params.id && autonomousTaskMatchesScope(task, scope)
    ));
    if (!existing) return res.status(404).json({ error: 'Task not found or not cancellable' });
    const ok = cancelTask(req.params.id, req.user!.uid);
    if (!ok) return res.status(404).json({ error: 'Task not found or not cancellable' });
    const current = getTaskQueue(req.user!.uid).find(task => task.id === req.params.id);
    const terminal = current
      ? null
      : getTaskHistory(200, 0, req.user!.uid).find(task => task.id === req.params.id) || null;
    const task = projectAutonomousTask(current || terminal || { ...existing, status: 'cancelled' });
    res.json({
      id: task.id,
      status: task.status,
      cancelRequested: task.cancelRequested,
      cancelled: task.status === 'cancelled',
      task,
    });
  });

  router.post('/tasks/:id/pause', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const existing = getTaskQueue(req.user!.uid).find(task => (
      task.id === req.params.id && autonomousTaskMatchesScope(task, scope)
    ));
    if (!existing) return res.status(404).json({ error: 'Task not found or not pausable' });
    if (!autonomousControls(existing.status).canPause) {
      return res.status(409).json({ error: 'Task is not pausable', task: projectAutonomousTask(existing) });
    }
    const task = requestPauseAutonomousTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Task not found or not pausable' });
    res.json({ task: projectAutonomousTask(task) });
  });

  router.post('/tasks/:id/resume', requireAuth, (req, res) => {
    const scope = resolveDomain(req.user!);
    const existing = getTaskQueue(req.user!.uid).find(task => (
      task.id === req.params.id && autonomousTaskMatchesScope(task, scope)
    ));
    if (!existing) return res.status(404).json({ error: 'Task not found or not resumable' });
    if (!autonomousControls(existing.status).canResume) {
      return res.status(409).json({ error: 'Task is not resumable', task: projectAutonomousTask(existing) });
    }
    const task = resumeAutonomousTask(req.params.id, req.user!.uid);
    if (!task) return res.status(404).json({ error: 'Task not found or not resumable' });
    res.json({ task: projectAutonomousTask(task) });
  });

  return router;
}
