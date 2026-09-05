/**
 * Autonomous Task Executor — processes the autonomous task queue.
 * Executes tasks via runWithTools with tighter safety policy than user-initiated autonomous mode.
 */
import {
  attachAutonomousExecutionPlan,
  checkpointAutonomousTask,
  dequeue,
  markRunning,
  markCompleted,
  markCancelled,
  getRunningTask,
  heartbeatAutonomousTask,
  isTaskCancellationRequested,
  isTaskPauseRequested,
  markPaused,
  requestPauseAutonomousTask,
  recordAutonomousTaskFailure,
} from './task_queue';
import { getGateConfig, isAutonomousWorkAllowed, recordAutonomousTokens } from './safety_gate';
import { runWithTools } from '../llm/adapter';
import { toolRegistry, type ToolRegistry } from '../tools/registry';
import { ToolContext, ToolExecutionRecord } from '../tools/types';
import { attachAutonomousHostAuthority } from '../tools/host_execution_authority';
import { canAutoApproveAction } from '../tools/action_constitution';
import { Server as SocketIOServer } from 'socket.io';
import type { AutonomousTask } from './task_queue';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { formatLumiConstitutionForPrompt } from '../personality/constitution';
import { getPlan, updatePlan, updatePlanStep } from './planner';
import { createDesktopRelay } from '../socket/desktop_relay';
import type { PlanScope } from './planner';
import { isRealtimeUserActive } from './foreground_activity';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import { finalizeExecutionForOutboundDelivery } from '../cognition/execution_guard_recovery';
import {
  buildActionContract,
  hasCoreActionEvidence,
} from '../cognition/action_contract';
import {
  buildLumiExecutionPipeline,
  type LumiExecutionPipeline,
} from '../cognition/execution_pipeline';
import { sanitizeCapabilityExecutionPlan } from '../conversation/action_ledger';
import { snapshotDurableToolRecords } from '../cognition/durable_task_recovery';
import {
  buildTaskCompletionFeedback,
  buildTaskTerminalReceipt,
  type TaskCompletionFeedback,
  validateCompletionTerminalReceipt,
} from '../cognition/acceptance_evidence';
import {
  containsInternalExecutionLanguage,
  sanitizePublicExecutionText,
  type PublicExecutionLanguage,
} from '../../shared/public_execution_language';
import { CN_AUTONOMOUS_CUSTOMER_MESSAGES } from '../regions/packs/cn/autonomous_customer_messages';
import {
  canUseQueuedSelfImprovementStageAuthorization,
  isLocalAdminAuthorizedSelfImprovementTask,
} from '../self_extension/improvement_program';

interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

/** Tight tool policy for autonomous background work — more conservative than user-initiated mode */
const AUTONOMOUS_POLICY = {
  allowedTools: ['*'],
  requireConfirmation: [],
  forbiddenTools: [
    'delete_file',
    'run_command',   // shell remains available but gated below
    'system_command',
  ],
  maxIterations: 50,
};

const LOCAL_BODY_LEARNING_TOOLS = [
  'desktop_system_info',
  'desktop_list_apps',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_running_processes',
  'desktop_active_window',
  'get_active_window_info',
  'get_running_processes',
  'desktop_idle_time',
  'desktop_poll_activity',
  'adapter_registry_list',
  'work_product_plan',
  'work_product_verify',
];

const SELF_IMPROVEMENT_TASK_TOOLS = [
  'self_improvement_read_scope',
  'self_improvement_stage_patch',
  'self_improvement_replay_verified_stage',
];

function isSelfImprovementTask(task: Partial<Pick<AutonomousTask, 'idempotencyKey'>>): boolean {
  return /^self-improvement:improvement_[a-z0-9_-]+:\d+$/i.test(String(task.idempotencyKey || ''));
}

export function isLocalBodyLearningTask(task: Pick<AutonomousTask, 'title' | 'description'>): boolean {
  return /本机身体|local machine body|desktop body|local body|desktop_body_map|local_machine_awareness/i
    .test(`${task.title || ''}\n${task.description || ''}`);
}

export function buildAutonomousToolPolicy(
  task: Pick<AutonomousTask, 'title' | 'description'> & Partial<Pick<AutonomousTask, 'idempotencyKey' | 'executionPlan' | 'recovery'>>,
  maxIterations: number,
) {
  const recoveryToolBoundary = task.recovery?.planRevisions?.length && task.executionPlan
    ? Array.from(new Set(task.executionPlan.nodes
        .map(node => node.toolName)
        .filter((name): name is string => Boolean(name))))
    : [];
  const narrowForRecovery = (policy: typeof AUTONOMOUS_POLICY) => {
    if (recoveryToolBoundary.length === 0) return policy;
    const permitted = policy.allowedTools.includes('*')
      ? recoveryToolBoundary
      : recoveryToolBoundary.filter(tool => policy.allowedTools.includes(tool));
    return { ...policy, allowedTools: permitted };
  };
  if (isSelfImprovementTask(task)) {
    // A prior diagnostic/read-only plan is not a complete self-improvement
    // capability boundary. Recovery must retain the dedicated stage tool or a
    // persisted read-only plan can deadlock the exact task forever.
    return {
      allowedTools: SELF_IMPROVEMENT_TASK_TOOLS,
      requireConfirmation: ['self_improvement_stage_patch'],
      forbiddenTools: AUTONOMOUS_POLICY.forbiddenTools,
      maxIterations: Math.min(maxIterations, 8),
    };
  }
  if (isLocalBodyLearningTask(task)) {
    return narrowForRecovery({
      allowedTools: LOCAL_BODY_LEARNING_TOOLS,
      requireConfirmation: [],
      forbiddenTools: AUTONOMOUS_POLICY.forbiddenTools,
      maxIterations: Math.min(maxIterations, 16),
    });
  }
  return narrowForRecovery({ ...AUTONOMOUS_POLICY, maxIterations });
}

export function buildAutonomousCapabilityPipeline(
  task: Pick<AutonomousTask, 'id' | 'userId' | 'description' | 'source' | 'title'>
    & Partial<Pick<AutonomousTask, 'idempotencyKey' | 'executionPlan' | 'recovery'>>,
  maxIterations: number,
  registry: ToolRegistry = toolRegistry,
): LumiExecutionPipeline {
  const policy = buildAutonomousToolPolicy(task, maxIterations);
  return buildLumiExecutionPipeline({
    dispatch: {
      userId: task.userId,
      text: task.description || task.title,
      channel: task.source === 'scheduler' ? 'scheduler' : 'autonomy',
      source: `autonomous:${task.source}`,
      operationMode: 'autonomous',
      targetIsLumi: true,
      surface: 'work',
    },
    registry,
    personalityToolPolicy: policy,
    decisionText: task.description || task.title,
    traceText: task.description || task.title,
    source: `autonomous:${task.source}`,
    taskId: task.id,
  });
}

function clipPlanResult(value: string, max = 1800): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

// A task record keeps the original exception, recovery diagnosis, receipts,
// and tool ledger for durable recovery. Socket clients receive only this
// compact projection; none of those machine fields belongs in customer copy.
// i18n-allow -- recognition only; mapped to the localized copy below.
const AUTONOMOUS_MACHINE_DETAIL_RE = /(?:\b(?:receipt|terminalVerification|verificationStatus|requestId|taskId|idempotencyKey|target_mismatch|execution_recovery_incomplete)\b|\b(?:desktop|web|url|write|read|extract|work_product|adapter_registry|self_improvement|client|system)_[a-z0-9_]+\b|No successful (?:current-turn )?tool execution|Missing (?:core|verified|current-turn|desktop|client|action) evidence)/iu;

function inferAutonomousPublicLanguage(value: unknown): PublicExecutionLanguage {
  return /[\u3400-\u9fff]/u.test(String(value || '')) ? 'zh' : 'en';
}

function autonomousFallbackText(
  language: PublicExecutionLanguage,
  state: 'completed' | 'failed' | 'retrying' | 'cancelled',
): string {
  if (language === 'zh') {
    if (state === 'completed') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.completed;
    if (state === 'retrying') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.retrying;
    if (state === 'cancelled') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.cancelled;
    return CN_AUTONOMOUS_CUSTOMER_MESSAGES.failed;
  }
  if (state === 'completed') return 'This autonomous task is complete.';
  if (state === 'retrying') return 'This autonomous task has not finished yet. I kept its progress and will try again later.';
  if (state === 'cancelled') return 'This autonomous task was stopped.';
  return 'This autonomous task did not finish. You can ask me to retry later.';
}

export function projectAutonomousCustomerMessage(
  value: unknown,
  options: {
    language?: PublicExecutionLanguage;
    state: 'completed' | 'failed' | 'retrying' | 'cancelled';
    preserveCleanText?: boolean;
  },
): string {
  const raw = String(value || '').trim();
  const language = options.language || inferAutonomousPublicLanguage(raw);
  const projected = sanitizePublicExecutionText(raw, language);
  const wasInternal = containsInternalExecutionLanguage(raw);
  if (
    projected
    && !AUTONOMOUS_MACHINE_DETAIL_RE.test(projected)
    && (wasInternal || options.preserveCleanText === true)
  ) {
    return projected;
  }
  return autonomousFallbackText(language, options.state);
}

export function projectAutonomousCompletionFeedback(
  feedback: TaskCompletionFeedback,
): TaskCompletionFeedback {
  // The detailed receipt-backed feedback remains on the durable task. The
  // public event needs only its semantic status; result/error already carries
  // the single customer-facing sentence.
  return {
    status: feedback.status,
    completed: [],
    evidence: [],
    incomplete: [],
    blockers: [],
    nextSteps: [],
  };
}

const INCOMPLETE_AUTONOMOUS_TOOL_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'draft',
  'error',
  'failed',
  'in_progress',
  'partial',
  'pending',
  'prepared',
  'queued',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
  'unknown',
  'unverified',
]);

function parseStructuredToolResult(value: string): Record<string, unknown> | null {
  let parsed: unknown = String(value || '').trim();
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export function isSuccessfulAutonomousToolRecord(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return false;
  const payload = parseStructuredToolResult(record.result);
  if (!payload) return true;
  if (
    payload.ok === false
    || payload.success === false
    || payload.verified === false
    || payload.completed === false
    || payload.completionMarkerExists === false
  ) {
    return false;
  }
  if (typeof payload.error === 'string' && payload.error.trim()) return false;
  const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  return !status || !INCOMPLETE_AUTONOMOUS_TOOL_STATUSES.has(status);
}

function autonomousResponseReportsIncomplete(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return true;
  return /(?:\b(?:could\s+not|couldn't|unable\s+to|failed\s+to|not\s+completed|not\s+finished|incomplete|unfinished|blocked|requires?\s+(?:user\s+)?confirmation)\b|(?:\u672a\u5b8c\u6210|\u6ca1\u6709\u5b8c\u6210|\u65e0\u6cd5\u5b8c\u6210|\u4e0d\u80fd\u5b8c\u6210|\u53d7\u963b|\u6267\u884c\u5931\u8d25|\u9700\u8981\u7528\u6237\u786e\u8ba4))/iu.test(text);
}

function selfImprovementProposalId(
  task?: Partial<Pick<AutonomousTask, 'idempotencyKey'>>,
): string {
  const match = /^self-improvement:(improvement_[a-z0-9_-]+):\d+$/i
    .exec(String(task?.idempotencyKey || ''));
  return match?.[1] || '';
}

function selfImprovementProgramRevision(
  task?: Partial<Pick<AutonomousTask, 'idempotencyKey'>>,
): number {
  const match = /^self-improvement:improvement_[a-z0-9_-]+:(\d+)$/i
    .exec(String(task?.idempotencyKey || ''));
  return Number(match?.[1] || -1);
}

/**
 * A queued self-improvement task ends at a verified isolated stage. Activation
 * is deliberately outside the autonomous task and still requires a separate
 * foreground confirmation.  Do not make an honest boundary explanation look
 * like a failed task, and do not accept generic file-write evidence in place
 * of the exact proposal receipt.
 */
export function hasVerifiedSelfImprovementStageReceipt(
  task: Partial<Pick<AutonomousTask, 'id' | 'idempotencyKey'>> | undefined,
  toolRecords: ToolExecutionRecord[],
): boolean {
  const proposalId = selfImprovementProposalId(task);
  const programRevision = selfImprovementProgramRevision(task);
  const taskId = String(task?.id || '').trim();
  if (!proposalId || !taskId || !Number.isSafeInteger(programRevision) || programRevision < 0) return false;
  return toolRecords.some(record => {
    if (
      !['self_improvement_stage_patch', 'self_improvement_replay_verified_stage'].includes(record.name)
      || record.error
      || !String(record.id || '').trim()
      || String(record.arguments?.proposalId || '') !== proposalId
      || record.taskId !== taskId
      || record.terminalVerification?.status !== 'verified'
      || record.terminalVerification.strategy !== 'terminal_receipt'
      || record.envelope?.version !== 1
      || record.envelope.status !== 'verified_success'
      || record.envelope.toolName !== record.name
      || record.envelope.taskId !== taskId
      || record.envelope.verification.status !== 'verified'
      || !String(record.envelope.idempotencyKey || '').trim()
      || record.envelope.idempotencyKey !== record.idempotencyKey
    ) return false;
    const payload = parseStructuredToolResult(record.result);
    if (!payload) return false;
    const proposal = payload.proposal && typeof payload.proposal === 'object'
      ? payload.proposal as Record<string, unknown>
      : null;
    const commit = String(payload.commit || '');
    const treeDigest = String(payload.treeDigest || '');
    const repositoryId = String(payload.repositoryId || '');
    const baseCommit = String(payload.baseCommit || '');
    const branch = String(payload.branch || '');
    return payload.ok === true
      && payload.status === 'verified'
      && payload.persisted === true
      && payload.isolated === true
      && payload.activated === false
      && payload.pushed === false
      && /^[0-9a-f]{40,64}$/i.test(commit)
      && /^[0-9a-f]{64}$/i.test(treeDigest)
      && /^[0-9a-f]{64}$/i.test(repositoryId)
      && /^[0-9a-f]{40,64}$/i.test(baseCommit)
      && branch === `lumi/self-improvement/${proposalId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}`
      && String(proposal?.id || '') === proposalId
      && proposal?.status === 'verified'
      && proposal?.stagingProtocol === 'static_git_plumbing_v1'
      && proposal?.taskId === taskId
      && Number(proposal?.programRevision) === programRevision
      && proposal?.stagedCommit === commit
      && proposal?.stagedTreeDigest === treeDigest
      && proposal?.repositoryId === repositoryId
      && proposal?.baseCommit === baseCommit
      && proposal?.stagedBranch === branch;
  });
}

export interface AutonomousTaskOutcome {
  text: string;
  blocked: boolean;
  verified: boolean;
  reason: string;
  successfulToolRecords: ToolExecutionRecord[];
}

export function evaluateAutonomousTaskOutcome(
  taskText: string,
  responseText: string,
  toolRecords: ToolExecutionRecord[],
  task?: Partial<Pick<AutonomousTask, 'id' | 'idempotencyKey'>>,
): AutonomousTaskOutcome {
  const candidateText = String(responseText || '').trim();
  const selfImprovementTask = Boolean(selfImprovementProposalId(task));
  const verifiedSelfImprovementStage = hasVerifiedSelfImprovementStageReceipt(task, toolRecords);
  const finalized = finalizeLumiResponse({
    taskText,
    responseText: candidateText || 'Autonomous task returned no final summary.',
    toolRecords,
    source: 'autonomous',
  });
  const successfulToolRecords = toolRecords.filter(isSuccessfulAutonomousToolRecord);
  const actionContract = buildActionContract(taskText);
  const missingSummary = !candidateText;
  const reportedIncomplete = !verifiedSelfImprovementStage
    && autonomousResponseReportsIncomplete(candidateText);
  const missingEvidence = successfulToolRecords.length === 0;
  const missingCoreEvidence = !selfImprovementTask && actionContract.applies
    && !hasCoreActionEvidence(actionContract, toolRecords, taskText);
  const selfImprovementEvidenceMissing = selfImprovementTask && !verifiedSelfImprovementStage;
  const verified = (
    (!finalized.blocked || verifiedSelfImprovementStage)
    && !missingSummary
    && !reportedIncomplete
    && !missingEvidence
    && !missingCoreEvidence
    && !selfImprovementEvidenceMissing
  );
  const reason = selfImprovementEvidenceMissing
    ? 'The autonomous self-improvement task did not produce an exact verified isolated-stage receipt for its bound proposal.'
    : finalized.blocked && !verifiedSelfImprovementStage
    ? finalized.reason || 'Autonomous completion claim was not supported by its tool ledger.'
    : missingCoreEvidence
      ? `Missing core evidence for autonomous ${actionContract.kind}.`
      : missingEvidence
      ? 'No successful autonomous tool evidence was recorded.'
      : missingSummary
        ? 'Autonomous execution returned no final summary.'
        : reportedIncomplete
          ? 'Autonomous execution reported that the task was incomplete or blocked.'
          : finalized.reason || '';

  return {
    text: verifiedSelfImprovementStage ? candidateText : finalized.text,
    blocked: (finalized.blocked && !verifiedSelfImprovementStage) || !verified,
    verified,
    reason,
    successfulToolRecords,
  };
}

export async function finalizeAutonomousTaskOutcomeForDelivery(
  taskText: string,
  outcome: Pick<AutonomousTaskOutcome, 'text' | 'blocked' | 'reason'>,
  toolRecords: ToolExecutionRecord[],
) {
  return (await finalizeExecutionForOutboundDelivery({
    task: taskText,
    responseText: outcome.text,
    finalization: {
      text: outcome.text,
      blocked: outcome.blocked,
      reason: outcome.reason,
    },
    // Autonomous retries are owned by the durable queue. The public boundary
    // sanitizes this attempt without starting an untracked nested executor.
    allowToolUse: false,
    toolRecords,
    finalize: candidateText => ({
      text: candidateText,
      blocked: outcome.blocked,
      reason: outcome.reason,
    }),
  })).finalization;
}

function upsertToolLedger(ledger: ToolExecutionRecord[], record: ToolExecutionRecord): void {
  const id = String(record.id || '').trim();
  const index = id
    ? ledger.findIndex(item => item.id === id)
    : ledger.findIndex(item => (
        item.name === record.name
        && JSON.stringify(item.arguments || {}) === JSON.stringify(record.arguments || {})
      ));
  const normalized: ToolExecutionRecord = {
    ...record,
    arguments: { ...(record.arguments || {}) },
    result: record.result || '',
  };
  if (index >= 0) ledger[index] = normalized;
  else ledger.push(normalized);
}

function planScopeForTask(task: AutonomousTask): PlanScope {
  const domain = task.domain === 'work' ? 'work' : 'personal';
  return {
    userId: task.userId,
    domain,
    orgId: domain === 'work' ? String(task.orgId || '') : '',
  };
}

function markLinkedPlanRunning(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan || plan.status !== 'active') return;
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');
  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'in_progress',
      result: `Autonomous task started: ${task.title}`,
    }, scope);
  }
}

function markLinkedPlanCompleted(task: AutonomousTask, summary: string) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const clipped = clipPlanResult(summary);
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');
  if (!step) return;
  const updatedPlan = updatePlanStep(plan.id, step.id, {
    status: 'done',
    result: clipped,
  }, scope);
  if (updatedPlan?.status === 'completed') {
    updatePlan(plan.id, { result: clipped }, scope);
  }
}

function markLinkedPlanFailed(task: AutonomousTask, error: string) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const clipped = clipPlanResult(`自主学习受阻：${error}`, 1000);
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');

  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'skipped',
      result: clipped,
    }, scope);
  }

  updatePlan(plan.id, {
    status: 'paused',
    result: clipped,
  }, scope);
}

function markLinkedPlanCancelled(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const message = 'Autonomous task cancelled by user';
  const step = plan.steps.find(item => item.status === 'in_progress');
  if (step) updatePlanStep(plan.id, step.id, { status: 'skipped', result: message }, scope);
  updatePlan(plan.id, { status: 'cancelled', result: message }, scope);
}

export async function executeNextAutonomousTask(
  io: SocketIOServer,
  getters: LLMGetters,
  userId?: string,
): Promise<{ executed: boolean; taskId?: string; result?: string }> {
  if (userId && isRealtimeUserActive(userId)) {
    return { executed: false, result: 'Live user voice session has priority' };
  }
  // Don't start a new task if one is already running
  if (getRunningTask(userId)) {
    return { executed: false, result: 'Task already running' };
  }

  const task = dequeue(userId);
  if (!task) return { executed: false };
  const publicLanguage = inferAutonomousPublicLanguage(`${task.title}\n${task.description}`);

  const gate = isAutonomousWorkAllowed(task.userId);
  if (!gate.allowed) {
    return { executed: false, taskId: task.id, result: `Blocked by safety gate: ${gate.reason || 'not allowed'}` };
  }

  const running = markRunning(task.id);
  if (!running) return { executed: false };
  if (!running.leaseId) return { executed: false, taskId: task.id, result: 'Task lease was not created' };
  let leaseLost = false;
  const leaseHeartbeat = setInterval(() => {
    const renewed = heartbeatAutonomousTask(task.id, running.leaseId!);
    if (!renewed) {
      leaseLost = true;
      clearInterval(leaseHeartbeat);
    }
  }, 20_000);
  if (typeof (leaseHeartbeat as any).unref === 'function') (leaseHeartbeat as any).unref();
  markLinkedPlanRunning(running);
  let releaseDesktopControlLease = () => undefined;
  const toolLedger: ToolExecutionRecord[] = [];
  let sideEffectClass = running.executionPlan?.risk.sideEffectClass;

  const taskScope = planScopeForTask(running);
  const taskRoom = taskScope.domain === 'work' && taskScope.orgId
    ? `user:${task.userId}:org:${taskScope.orgId}`
    : `user:${task.userId}:personal`;
  io.to(taskRoom).emit('autonomous:task_started', {
    taskId: task.id,
    title: task.title,
    mode: task.mode,
    timestamp: new Date().toISOString(),
  });

  try {
    const currentGate = getGateConfig(task.userId);
    const maxIterations = currentGate.autonomyLevel === 'full' ? 50 : 30;
    // Build desktop relay using the user's registered desktop client, not a broad user-room broadcast.
    const desktopRelay = createDesktopRelay({
      io,
      userId: task.userId,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'autonomous',
      taskId: task.id,
      onControlPaused: () => {
        requestPauseAutonomousTask(task.id, task.userId);
      },
    });
    releaseDesktopControlLease = () => desktopRelay.releaseControlLease('autonomous_task_complete');

    const executionPipeline = buildAutonomousCapabilityPipeline(running, maxIterations);
    sideEffectClass = executionPipeline.executionPlan.risk.sideEffectClass;
    attachAutonomousExecutionPlan(
      running.id,
      sanitizeCapabilityExecutionPlan(executionPipeline.executionPlan, new Date().toISOString()),
      running.leaseId,
    );
    checkpointAutonomousTask(running.id, {
      phase: 'planned',
      receiptIds: running.checkpoint?.receiptIds,
      receipts: running.checkpoint?.receipts,
      detail: `Capability plan persisted for attempt ${running.attempt || 1}`,
    }, running.leaseId);
    if (executionPipeline.executionPlan.risk.sideEffectClass === 'external_commit') {
      throw new Error('Autonomous external commit blocked: an action-time immutable user confirmation is required.');
    }
    const toolPolicy = executionPipeline.authorizationPolicy;

    const context: ToolContext = attachAutonomousHostAuthority({
      userId: task.userId,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      conversationId: running.conversationId,
      taskId: running.id,
      desktopRelay: task.mode === 'desktop' ? desktopRelay : undefined,
      requestConfirmation: async (toolName, args) => {
        if (toolName === 'self_improvement_stage_patch') {
          return canUseQueuedSelfImprovementStageAuthorization(
            taskScope,
            String(args.proposalId || ''),
            running.id,
          );
        }
        return canAutoApproveAction(toolName, args, { actionIntent: task.description });
      },
      actionIntent: task.description,
      routedTaskText: executionPipeline.turnIntent.flow.routeText,
      toolPolicy,
      modelToolProjection: executionPipeline.modelToolProjection,
      isCancelled: () => isTaskCancellationRequested(task.id, task.userId)
        || isTaskPauseRequested(task.id, task.userId)
        || isRealtimeUserActive(task.userId)
        || leaseLost,
      autonomous: true,
      localExecution: isLocalAdminAuthorizedSelfImprovementTask(
        taskScope,
        running.id,
        running.idempotencyKey,
      ),
      source: 'autonomous',
      idempotencyKey: running.idempotencyKey,
    }, { ownerUserId: task.userId, taskId: running.id });

    const messages = [
      { role: 'system' as const, content: [
        `You are Lumi executing an autonomous background task. You work independently without user interaction. Be efficient and direct. Current task mode: ${task.mode}.`,
        formatLumiConstitutionForPrompt(),
        executionPipeline.capabilityPlan.promptOverlay,
        ...(running.recovery?.planRevisions?.length
          ? [`This is durable recovery attempt ${running.attempt}. Follow the latest persisted recovery revision: ${running.recovery.planRevisions.at(-1)?.strategy}. Do not repeat any side effect from a prior receipt. If exact prior state cannot be reconciled, stop and report the blocker.`]
          : []),
        'For concrete deliverables, define the work product with work_product_plan, verify it with work_product_verify or domain-specific verification tools, repair failed criteria, and only then mark the task complete. If confirmation or missing input blocks progress, report the blocker.',
        'For autonomous web learning, you may use public web_search, url_fetch, and authority_research. Treat them as observation: cite URLs, retrieval time, confidence, and uncertainty. Choose research topics from the user industry habits in the task context: common platforms, vocabulary, deliverable formats, verification standards, compliance boundaries, and repeated real workflows. Avoid generic trend learning unless it clearly improves that user’s industry workflow. For desktop AI/tool catalog learning, use desktop_ai_list_targets and desktop_ai_discovery_plan, then produce source-grounded candidate JSON for later registration. Do not use login-required, paid, captcha, QR/OTP, private, or account-authorization pages as completed sources. Do not call authority_research_save, desktop_ai_register_target, or other long-term knowledge/configuration writes unless the task itself contains explicit user authorization; otherwise produce source-grounded knowledge or target candidates for later absorption.',
        'For autonomous local machine/body learning, only use observation tools for OS info, top-level file/folder landmarks, launchable apps, active/running processes, idle/activity signals, and adapter inventory. Do not open apps or files, click, type, capture screenshots, run commands, read file contents, move/copy/delete files, or infer private facts from filenames. Produce a local body map with evidence, uncertainty, useful app/file landmarks, industry-relevant tools, and next exploration items that need user confirmation.',
        'Store internal reports and other files created by this background task with write_file. Lumi confines those files to its dedicated autonomy report data directory; never present a source-project path as the saved location.',
      ].join('\n\n') },
      { role: 'user' as const, content: task.description },
    ];

    const result = await runWithTools(
      messages,
      toolRegistry,
      getUserPreferredLLMConfig(task.userId, { maxTokens: 2000 }),
      (record) => {
        upsertToolLedger(toolLedger, record);
        if (record.result !== undefined || record.error !== undefined) {
          checkpointAutonomousTask(running.id, {
            phase: 'tool_execution',
            iteration: toolLedger.length,
            receiptIds: Array.from(new Set([
              ...(running.checkpoint?.receiptIds || []),
              ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
            ])),
            receipts: [
              ...(running.checkpoint?.receipts || []),
              ...snapshotDurableToolRecords(toolLedger),
            ],
            detail: `${toolLedger.length} terminal tool call(s) observed`,
          }, running.leaseId);
        }
      },
      maxIterations,
      getters.getDeepSeek, getters.getGemini,
      getters.getOpenAI || (() => null),
      getters.getAnthropic || (() => null),
      getters.getQwen || (() => null),
      undefined, // onStreamChunk
      context,
      getters.getOllama,
      getters.getLmStudio,
      getters.getArk,
      getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay,
    );

    for (const record of result.toolCalls) upsertToolLedger(toolLedger, record);
    const toolCallCount = toolLedger.length;
    const tokensUsed = result.usageRecords.reduce((sum, r) => sum + r.totalTokens, 0);
    recordAutonomousTokens(task.userId, tokensUsed);

    if (isTaskPauseRequested(task.id, task.userId)) {
      markPaused(task.id);
      io.to(taskRoom).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : 'Cancelled by user';
      const cancelled = markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      const machineFeedback = buildTaskCompletionFeedback(cancelled?.terminalReceipt, task.title, {
        status: cancelled?.status || 'cancelled',
        reason,
      });
      io.to(taskRoom).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }

    const outcome = evaluateAutonomousTaskOutcome(
      `${task.title}\n${task.description}`.trim(),
      result.text,
      toolLedger,
      task,
    );
    const publicOutcome = await finalizeAutonomousTaskOutcomeForDelivery(
      `${task.title}\n${task.description}`.trim(),
      outcome,
      toolLedger,
    );
    const terminalReceipt = buildTaskTerminalReceipt({
      taskId: task.id,
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: toolLedger,
      reason: outcome.verified
        ? undefined
        : outcome.reason || 'Autonomous completion could not be verified.',
    });
    const terminalAcceptance = outcome.verified
      ? validateCompletionTerminalReceipt(terminalReceipt, {
          taskId: task.id,
          runtime: 'autonomous',
        })
      : null;
    if (!outcome.verified || !terminalAcceptance?.accepted) {
      const failureReason = outcome.verified
        ? terminalAcceptance?.reason || 'Autonomous completion lacked a verified terminal receipt.'
        : outcome.reason || 'Autonomous completion could not be verified.';
      const receiptSnapshots = snapshotDurableToolRecords(toolLedger);
      checkpointAutonomousTask(task.id, {
        phase: 'failed_verification',
        receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
        receipts: receiptSnapshots,
        detail: failureReason,
      }, running.leaseId);
      const settled = recordAutonomousTaskFailure(task.id, {
        error: failureReason,
        verificationFailure: true,
        receiptSnapshots,
        sideEffectClass: executionPipeline.executionPlan.risk.sideEffectClass,
        leaseLost,
      }, running.leaseId);
      if (!settled) {
        return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
      }
      const willRetry = settled.status === 'pending';
      if (!willRetry) markLinkedPlanFailed(task, failureReason);
      const publicFailureText = projectAutonomousCustomerMessage(publicOutcome.text, {
        language: publicLanguage,
        state: willRetry ? 'retrying' : 'failed',
        preserveCleanText: true,
      });
      const machineFeedback = buildTaskCompletionFeedback(
        settled.terminalReceipt,
        task.title,
        { status: settled.status, reason: failureReason },
      );
      io.to(taskRoom).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
        taskId: task.id,
        title: task.title,
        error: publicFailureText,
        result: publicFailureText,
        toolCallsCount: toolCallCount,
        tokensUsed,
        finalized: !willRetry,
        blocked: !willRetry,
        verified: false,
        status: settled.status,
        nextAttemptAt: settled.nextAttemptAt,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      console.warn(
        `[AutoExecutor] Task "${task.title}" not marked complete: ${outcome.reason} `
        + `(${outcome.successfulToolRecords.length}/${toolCallCount} successful tools)`,
      );
      return {
        executed: true,
        taskId: task.id,
        result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : outcome.text || failureReason,
      };
    }

    const summary = publicOutcome.text;
    const publicSummary = projectAutonomousCustomerMessage(summary, {
      language: publicLanguage,
      state: 'completed',
      preserveCleanText: true,
    });
    checkpointAutonomousTask(task.id, {
      phase: 'verified',
      receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      receipts: snapshotDurableToolRecords(toolLedger),
      detail: outcome.reason || 'Completion verified',
    }, running.leaseId);
    const completed = markCompleted(task.id, summary, toolCallCount, tokensUsed, {
      finalized: true,
      blocked: false,
      verified: true,
      verificationReason: outcome.reason,
      terminalReceipt,
    }, running.leaseId);
    if (!completed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
    }
    markLinkedPlanCompleted(task, summary);

    io.to(taskRoom).emit('autonomous:task_completed', {
      taskId: task.id,
      title: task.title,
      result: publicSummary,
      toolCallsCount: toolCallCount,
      tokensUsed,
      finalized: true,
      blocked: false,
      verified: true,
      completionFeedback: projectAutonomousCompletionFeedback(buildTaskCompletionFeedback(
        completed.terminalReceipt,
        task.title,
        { status: completed.status, accepted: true },
      )),
      timestamp: new Date().toISOString(),
    });

    console.log(`[AutoExecutor] Task "${task.title}" completed: ${toolCallCount} tools, ${tokensUsed} tokens`);
    return { executed: true, taskId: task.id, result: summary };
  } catch (err: any) {
    const errorMsg = err.message || 'Unknown error';
    if (isTaskPauseRequested(task.id, task.userId)) {
      markPaused(task.id);
      io.to(taskRoom).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : errorMsg;
      const cancelled = markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      const machineFeedback = buildTaskCompletionFeedback(cancelled?.terminalReceipt, task.title, {
        status: cancelled?.status || 'cancelled',
        reason,
      });
      io.to(taskRoom).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }
    const checkpointed = checkpointAutonomousTask(task.id, {
      phase: 'failed',
      receiptIds: Array.from(new Set([
        ...(running.checkpoint?.receiptIds || []),
        ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      ])),
      receipts: [
        ...(running.checkpoint?.receipts || []),
        ...snapshotDurableToolRecords(toolLedger),
      ],
      detail: errorMsg,
    }, running.leaseId);
    if (!checkpointed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const settled = recordAutonomousTaskFailure(task.id, {
      error: errorMsg,
      receiptSnapshots: checkpointed.checkpoint?.receipts || [],
      sideEffectClass,
      leaseLost,
    }, running.leaseId);
    if (!settled) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const willRetry = settled.status === 'pending';
    if (!willRetry) markLinkedPlanFailed(task, errorMsg);
    const publicFailureText = projectAutonomousCustomerMessage(errorMsg, {
      language: publicLanguage,
      state: willRetry ? 'retrying' : 'failed',
    });
    const machineFeedback = buildTaskCompletionFeedback(settled.terminalReceipt, task.title, {
      status: settled.status,
      reason: errorMsg,
    });

    io.to(taskRoom).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
      taskId: task.id,
      title: task.title,
      error: publicFailureText,
      result: publicFailureText,
      status: settled.status,
      nextAttemptAt: settled.nextAttemptAt,
      completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
      timestamp: new Date().toISOString(),
    });

    console.warn(`[AutoExecutor] Task "${task.title}" failed:`, errorMsg);
    return {
      executed: true,
      taskId: task.id,
      result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : `Failed: ${errorMsg}`,
    };
  } finally {
    clearInterval(leaseHeartbeat);
    releaseDesktopControlLease();
  }
}
