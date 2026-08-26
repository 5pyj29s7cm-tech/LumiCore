import {
  classifyConversationActionFollowupIntent,
  type ConversationActionContinuationState,
} from './action_continuation';

/**
 * Legacy queue-control classification retained for callers that only need to
 * decide whether an in-flight foreground lease is cancelled or superseded.
 */
export type ActiveTaskMessageRelation =
  | 'status'
  | 'continue'
  | 'cancel'
  | 'replace'
  | 'queue';

export type ActiveTaskFeedbackKind =
  | 'status'
  | 'continue'
  | 'cancel'
  | 'replace'
  | 'correction'
  | 'accept'
  | 'retry'
  | 'repeat'
  | 'new_task';

export type ActiveTaskFeedbackBinding =
  | 'active_task'
  | 'previous_task'
  | 'new_task'
  | 'conversation'
  | 'stale';

export type ActiveTaskFeedbackOperation =
  | 'inspect'
  | 'resume'
  | 'cancel'
  | 'supersede'
  | 'replan'
  | 'verify'
  | 'retry'
  | 'repeat'
  | 'enqueue'
  | 'reject_stale';

/**
 * Server-owned relation between the newest utterance and a durable action.
 * `taskId` and `revision` are observations, not client-authoritative values;
 * optional control targets are checked before a mutating relation is applied.
 */
export interface ActiveTaskMessageResolution {
  relation: ActiveTaskMessageRelation;
  feedback: ActiveTaskFeedbackKind;
  binding: ActiveTaskFeedbackBinding;
  operation: ActiveTaskFeedbackOperation;
  taskId?: string;
  revision?: number;
  targetRequestId?: string;
  preservesRootGoal: boolean;
  requiresRootVerification: boolean;
  reason: string;
}

export interface ActiveTaskRelationOptions {
  /** Request currently holding (or immediately preceding) the foreground lease. */
  activeRequestId?: string;
  /** Optional immutable target supplied by a client control event. */
  controlTargetRequestId?: string;
  /** Optional durable identity supplied by a client that rendered task state. */
  controlTargetTaskId?: string;
  /** Optional optimistic-concurrency revision supplied by that client. */
  controlTargetRevision?: number;
}

// These are task-control utterances, not domain intents. Keeping them here
// prevents every socket surface from inventing a different cancellation rule.
// i18n-allow: multilingual task-control recognition; not user-visible copy.
const CANCEL_ONLY_RE =
  /^(?:(?:等一下|等等|先别急)[，,\s]*)?(?:你)?(?:先)?(?:取消|停止|停下|别做了|不要做了|终止)(?:这个|那个|当前)?(?:任务|操作|工作)?[。！？.!?]*$|^(?:(?:wait|hold\s+on)[,!\s]*)?(?:please\s+)?(?:cancel|stop|abort|terminate)(?:\s+(?:this|that|the current)\s+(?:task|operation|work))?[.!?]*$/iu; // i18n-allow: multilingual task-control recognition; not user-visible copy.
// i18n-allow: multilingual task-replacement recognition; not user-visible copy.
const REPLACE_RE =
  /(?:取消|停止|停下|别做|不要做|终止|放弃).{0,24}(?:改成|换成|改做|转去|重新做|而是)|\b(?:cancel|stop|abort|drop)\b.{0,40}\b(?:instead|replace|switch|change\s+to|do)\b/iu; // i18n-allow: multilingual task-replacement recognition; not user-visible copy.

// A retry is materially different from a generic continuation: successful
// receipts must be reused and only the failed/blocked step may run again.
// i18n-allow: multilingual task-feedback recognition; not user-visible copy.
const RETRY_ONLY_RE =
  /^(?:(?:请|麻烦你|现在|那就)\s*)?(?:重试|再试(?:一次|一下)?|重新(?:执行|跑|做)(?:一次|一下)?|从失败(?:的)?(?:步骤|地方)重来)(?:这个|那个|当前)?(?:任务|步骤|操作)?[。！？.!?]*$|^(?:(?:please|now)\s+)?(?:retry|re-try|try\s+again|rerun)(?:\s+(?:this|that|the current)\s+(?:task|step|operation))?[.!?]*$/iu; // i18n-allow: multilingual task-feedback recognition; not user-visible copy.

// A terse imperative is common after Lumi has explained a blocker or proposed
// a fix. Generic referents bind to that action; concrete new objects do not.
// i18n-allow: multilingual task-feedback recognition; not user-visible copy.
const CONTINUE_ONLY_RE =
  /^(?:(?:请|现在|那就|赶紧|快点)\s*)?(?:修|修复|处理|继续|接着|推进|执行|完成|做)(?:一下)?(?:它|这个|这些|上述|当前)?(?:问题|任务|工作|操作)?[了吧啊呀。！？.!?]*$|^(?:(?:please|now|then)\s+)?(?:fix|continue|resume|proceed|execute|finish|do)(?:\s+(?:it|this|these|that|the\s+(?:current\s+)?(?:issue|task|work)))?[.!?]*$/iu; // i18n-allow: multilingual task-feedback recognition; not user-visible copy.

// Keep acceptance narrow. Longer action-bearing messages such as “好的，帮我
// 写一份报告” are new work, while these terse replies bind to the adjacent
// pending action or root-task verification.
// i18n-allow: multilingual task-feedback recognition; not user-visible copy.
const ACCEPT_ONLY_RE =
  /^(?:(?:我)?(?:确认|同意|接受|批准|授权)(?:(?:这个|该|上述|当前|刚才的)?(?:操作|方案|修改|执行|权限扩张))?|(?:嗯|好|好的|可以|行|没问题|就这样|按这个做|开始吧)|(?:yes|ok|okay|confirmed?|approved?|accepted?|go\s+ahead|looks\s+good))[。！？.!?]*$/iu; // i18n-allow: multilingual task-feedback recognition; not user-visible copy.

// Corrections re-plan the same root task. Requiring either an explicit error
// marker or a referential object prevents an unrelated concrete instruction
// from being swallowed by an older task.
// i18n-allow: multilingual task-feedback recognition; not user-visible copy.
const CORRECTION_RE =
  /^(?:(?:不对|错了|搞错了|弄错了|纠正一下|更正一下|不是这样)[，,:：\s]*|(?:no|wrong|that(?:'s| is)\s+wrong|correction)\b[,:\s]*).{1,500}$|^(?:把|将)(?:它|这个|那个|刚才的|上一步|当前步骤).{0,80}(?:改成|换成|更正为|调整为).{1,360}$|^(?:不是).{1,160}(?:而是|应该是).{1,320}$|^(?:(?:我说的|我的意思|刚才说的).{0,80}(?:是|要).{1,220}(?:不是|而不是).{1,220})$|^(?:change|correct|update)\s+(?:it|this|that|the\s+(?:last|current)\s+step)\b.{1,360}$|^(?:I\s+meant|what\s+I\s+meant\s+was)\b.{1,220}\b(?:not|instead\s+of)\b.{1,220}$/iu; // i18n-allow: multilingual task-feedback recognition; not user-visible copy.

function compact(value: unknown, limit = 180): string {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function finiteRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : undefined;
}

function feedbackKind(
  normalized: string,
  state?: ConversationActionContinuationState | null,
): ActiveTaskFeedbackKind {
  if (REPLACE_RE.test(normalized)) return 'replace';
  if (CANCEL_ONLY_RE.test(normalized)) return 'cancel';
  if (RETRY_ONLY_RE.test(normalized)) return 'retry';
  if (ACCEPT_ONLY_RE.test(normalized)) return 'accept';
  if (CONTINUE_ONLY_RE.test(normalized)) return 'continue';

  if (CORRECTION_RE.test(normalized)) return 'correction';

  const followup = classifyConversationActionFollowupIntent(normalized, state);
  if (followup === 'status') return 'status';
  if (followup === 'execute') return 'continue';
  if (followup === 'repeat') return 'repeat';
  return 'new_task';
}

function queueRelation(feedback: ActiveTaskFeedbackKind): ActiveTaskMessageRelation {
  if (feedback === 'cancel' || feedback === 'replace' || feedback === 'status') return feedback;
  if (feedback === 'continue' || feedback === 'retry' || feedback === 'correction' || feedback === 'accept') {
    return 'continue';
  }
  return 'queue';
}

function feedbackOperation(feedback: ActiveTaskFeedbackKind): ActiveTaskFeedbackOperation {
  switch (feedback) {
    case 'status': return 'inspect';
    case 'continue': return 'resume';
    case 'cancel': return 'cancel';
    case 'replace': return 'supersede';
    case 'correction': return 'replan';
    case 'accept': return 'verify';
    case 'retry': return 'retry';
    case 'repeat': return 'repeat';
    default: return 'enqueue';
  }
}

function relationNeedsActiveTask(feedback: ActiveTaskFeedbackKind): boolean {
  return feedback !== 'new_task' && feedback !== 'repeat';
}

/**
 * Resolve the utterance and its exact task binding in one pass. The result is
 * safe to expose to the client and to inject into the model planner: the model
 * can choose steps, but it cannot silently change which root task/revision the
 * user was responding to.
 */
export function resolveActiveTaskMessageRelation(
  text: string,
  state?: ConversationActionContinuationState | null,
  options: ActiveTaskRelationOptions = {},
): ActiveTaskMessageResolution {
  const normalized = compact(text, 700);
  const feedback = normalized ? feedbackKind(normalized, state) : 'new_task';
  const relation = queueRelation(feedback);
  const terminalState = Boolean(
    state
    && (!state.unfinished || ['completed', 'cancelled'].includes(String(state.status || ''))),
  );
  const runtimeRequestId = compact(options.activeRequestId, 120);
  const activeRequestId = compact(
    runtimeRequestId || (!terminalState ? state?.activeRequestId : ''),
    120,
  );
  // Report the server-observed request target, never echo a stale client
  // target as though it were current. This lets the client refresh its fence
  // instead of retrying the same obsolete request id indefinitely.
  const targetRequestId = activeRequestId;
  const durableTaskId = compact(state?.taskId, 180);
  const revision = finiteRevision(state?.revision);
  const explicitTaskId = compact(options.controlTargetTaskId, 180);
  const explicitRevision = finiteRevision(options.controlTargetRevision);
  const activeMatchesState = Boolean(
    durableTaskId
    && (
      !activeRequestId
      || compact(state.activeRequestId, 120) === activeRequestId
    ),
  );
  const canBindPreviousStatus = feedback === 'status' && Boolean(durableTaskId);
  const canBindDurableTask = Boolean(
    activeMatchesState
    && (state?.unfinished || canBindPreviousStatus || activeRequestId),
  );
  const hasRuntimeTarget = Boolean(activeRequestId);

  const explicitRequestId = compact(options.controlTargetRequestId, 120);
  const exactDurableFence = Boolean(
    explicitTaskId
    && explicitRevision !== undefined
    && durableTaskId
    && explicitTaskId === durableTaskId
    && explicitRevision === revision,
  );
  // Once no process-local request owns the task, taskId+revision is the
  // authoritative fence. This permits controls for an idle-but-unfinished
  // durable task and read-only inspection of a completed task, while a bare
  // historical request id remains stale.
  const durableFenceOwnsIdleTask = Boolean(
    !activeRequestId
    && exactDurableFence
    && (state?.unfinished || (feedback === 'status' && terminalState)),
  );
  const requestMismatch = Boolean(
    explicitRequestId
    && (!activeRequestId || explicitRequestId !== activeRequestId),
  ) && !durableFenceOwnsIdleTask;
  const taskMismatch = Boolean(explicitTaskId && (!durableTaskId || explicitTaskId !== durableTaskId));
  const revisionMismatch = explicitRevision !== undefined && revision !== explicitRevision;
  const stale = relationNeedsActiveTask(feedback) && (requestMismatch || taskMismatch || revisionMismatch);

  if (stale) {
    return {
      relation,
      feedback,
      binding: 'stale',
      operation: 'reject_stale',
      ...(durableTaskId ? { taskId: durableTaskId } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(targetRequestId ? { targetRequestId } : {}),
      preservesRootGoal: true,
      requiresRootVerification: feedback === 'accept',
      reason: requestMismatch
        ? 'control_target_request_mismatch'
        : taskMismatch
          ? 'control_target_task_mismatch'
          : 'control_target_revision_mismatch',
    };
  }

  if (feedback === 'repeat') {
    return {
      relation,
      feedback,
      binding: 'conversation',
      operation: 'repeat',
      preservesRootGoal: false,
      requiresRootVerification: false,
      reason: 'adjacent_assistant_reply',
    };
  }

  if (feedback === 'new_task') {
    return {
      relation,
      feedback,
      binding: 'new_task',
      operation: 'enqueue',
      preservesRootGoal: false,
      requiresRootVerification: false,
      reason: 'independent_instruction',
    };
  }

  const completedStatusLookup = Boolean(
    feedback === 'status'
    && terminalState
    && durableTaskId
    && !runtimeRequestId,
  );
  const binding: ActiveTaskFeedbackBinding = completedStatusLookup
    ? 'previous_task'
    : canBindDurableTask || hasRuntimeTarget
      ? 'active_task'
      : canBindPreviousStatus
        ? 'previous_task'
        : 'conversation';
  const boundTaskId = canBindDurableTask ? durableTaskId : '';
  return {
    relation,
    feedback,
    binding,
    operation: feedbackOperation(feedback),
    ...(boundTaskId ? { taskId: boundTaskId } : {}),
    ...(boundTaskId && revision !== undefined ? { revision } : {}),
    ...(targetRequestId ? { targetRequestId } : {}),
    preservesRootGoal: feedback !== 'replace',
    requiresRootVerification: feedback === 'accept',
    reason: binding === 'active_task'
      ? 'adjacent_active_action'
      : binding === 'previous_task'
        ? 'durable_previous_action'
        : 'no_bindable_action',
  };
}

/**
 * Compact planner context. In addition to routing the turn, it fixes the
 * orchestration invariant that worker/sub-step completion is only evidence;
 * the root coordinator must verify the entire goal before reporting done.
 */
export function formatActiveTaskRelationContext(
  resolution: ActiveTaskMessageResolution | null | undefined,
  state?: ConversationActionContinuationState | null,
): string {
  if (!resolution || !['active_task', 'previous_task'].includes(resolution.binding)) return '';
  const execute = ['continue', 'correction', 'accept', 'retry'].includes(resolution.feedback);
  const rootGoal = compact(state?.goal, 700);
  const latestInstruction = compact(state?.latestInstruction, 700);
  const lines = [
    '## Bound task feedback',
    `- followupIntent: ${resolution.feedback === 'status' ? 'status' : execute ? 'execute' : 'none'}`,
    `- feedbackRelation: ${resolution.feedback}`,
    `- feedbackOperation: ${resolution.operation}`,
    resolution.taskId ? `- taskId: ${resolution.taskId}` : '',
    resolution.revision !== undefined ? `- taskRevision: ${resolution.revision}` : '',
    resolution.targetRequestId ? `- targetRequestId: ${resolution.targetRequestId}` : '',
    rootGoal ? `- rootGoal: ${rootGoal}` : '',
    latestInstruction && latestInstruction !== rootGoal ? `- previousStep: ${latestInstruction}` : '',
    '- Keep the stable root goal and task identity across this turn. Treat worker or sub-step completion as evidence only; the root coordinator alone may report terminal completion after checking the whole goal, success criteria, and receipts.',
  ].filter(Boolean);

  if (resolution.feedback === 'correction') {
    lines.push('- Re-plan the unfinished portion from the newest correction. Reuse valid receipts, do not repeat successful side effects, and advance the durable revision when canonical execution writes back.');
  } else if (resolution.feedback === 'retry') {
    lines.push('- Retry only the failed or blocked step. Reconcile prior receipts before any non-idempotent side effect.');
  } else if (resolution.feedback === 'accept') {
    lines.push('- Acceptance may authorize the exact pending operation or request final verification; it is not proof that the root task completed. Verify the root outcome before closing it.');
  } else if (resolution.feedback === 'continue') {
    lines.push('- Continue from the next unfinished step; do not restart the task or discard prior evidence.');
  } else if (resolution.feedback === 'status') {
    lines.push('- Inspect and report the bound task only. Do not start, retry, or mutate work from a status question.');
  }
  return lines.join('\n');
}

export function classifyActiveTaskMessage(
  text: string,
  state?: ConversationActionContinuationState | null,
): ActiveTaskMessageRelation {
  return resolveActiveTaskMessageRelation(text, state).relation;
}
