import type { WorkTakeoverTask } from './tasks';
import { listWorkTakeoverTasks } from './tasks';
import { getWorkTakeoverExecutionProgress, planWorkTakeoverExecution } from './execution_planner';

export type WorkTakeoverContinuationIntent = 'advance' | 'status';
export type WorkTakeoverTurnSurface = 'chat' | 'work' | 'voice';
export type WorkTakeoverContinuationStrength = 'none' | 'hint' | 'direct';

export interface WorkTakeoverContinuityContext {
  activeTasks: WorkTakeoverTask[];
  latestTask: WorkTakeoverTask | null;
  intent: WorkTakeoverContinuationIntent | null;
  strength: WorkTakeoverContinuationStrength;
  surface: WorkTakeoverTurnSurface;
  shouldResumeTask: boolean;
  routeText: string;
  promptOverlay: string;
}

export interface WorkTakeoverContinuationCommand {
  intent: WorkTakeoverContinuationIntent;
  task: WorkTakeoverTask;
  toolCall: { name: string; arguments: Record<string, any> };
  responseText: string;
  formatToolResult: (raw: string, error?: string) => string;
}

const MUSIC_CONTINUATION_RE = /继续播放|继续.*音乐|继续.*歌|resume\s+(music|song|playback)/i;
const STATUS_RE = /^(做完了吗|好了没|好了嘛|完成了吗|跑完了吗|结束了吗|结果呢|结果怎么样|进度呢|现在什么进度|状态呢|状态怎么样|怎么样了|现在怎么样|成功了吗|失败了吗|有没有成功|卡在哪|哪里卡了|哪里卡住了|为什么没做完|为什么失败|怎么回事)[。！？?!?]*$/u;
const ACTION_RE = /^(继续|继续做|继续推进|继续执行|继续处理|接着|接着做|往下|往下走|下一步|下一步呢|接下来呢|做下一步|跑下一步|再跑一步|然后呢|然后|开始吧|来吧|继续吧|继续一下|推进一下)[。！？?!?]*$/u;
const STRONG_ACTION_RE = /继续(?:做|推进|执行|处理)|接着做|做下一步|跑下一步|再跑一步|继续一下|推进一下/u;
const REFERENTIAL_STATUS_RE = /(刚刚|刚才|上一个|上一条|这个任务|这个事|那件事|它|这个).*(做完|完成|结果|进度|状态|卡|失败|成功|怎么回事)/u;
const REFERENTIAL_ACTION_RE = /(刚刚|刚才|上一个|上一条|这个任务|这个事|那件事|它|这个).*(继续|下一步|接着|推进|执行|处理|跑|做)/u;
const AFFIRMATIVE_RE = /^(好|好的|可以|行|嗯|嗯嗯|嗯哼|ok|okay|收到|继续吧)[。！？?!?]*$/i;
const WORK_CONTEXT_RE = /任务|工作|客户|微信|接管|任务中心|交付|方案|报价|店铺|账号|发布|立案|装修|设计|cad|revit|短视频|电商|自动化/u;
const WORK_STATUS_RE = /做完|完成|结果|进度|状态|卡|失败|成功|怎么回事|验证|检查/u;
const WORK_ACTION_RE = /继续|下一步|接着|推进|执行|处理|跑|做|开始/u;

const EN_WORK_CONTEXT_RE = /\b(task|work|customer|client|wechat|message|takeover|delivery|package|store|account|seller|creator|publish|filing|case|renovation|design|cad|revit|short\s*video|ecommerce)\b/i;
const EN_WORK_STATUS_RE = /\b(status|progress|done|finished|complete|completed|result|blocked|failed|success|verify|check|what\s+happened)\b/i;
const EN_WORK_ACTION_RE = /\b(continue|resume|advance|next\s+step|keep\s+going|go\s+on|run\s+next|proceed|carry\s+on|push\s+forward)\b/i;

// A question about how Lumi would help with work is ordinary conversation, not
// evidence that the user is referring to the latest persisted task.  In
// particular, the words “工作/任务” plus “完成/complete” are not sufficient:
// both appear naturally in hypothetical support questions.
const CN_WORK_SUPPORT_QUESTION_RE = /(?:(?:你|lumi)[^。！？!?；;\n]{0,32}(?:如何|怎么|怎样)[^。！？!?；;\n]{0,32}(?:陪|帮(?:助)?|协助|支持)[^。！？!?；;\n]{0,32}(?:完成|处理|推进|做)[^。！？!?；;\n]{0,20}(?:工作|任务)|(?:如何|怎么|怎样)[^。！？!?；;\n]{0,32}(?:你|lumi)[^。！？!?；;\n]{0,32}(?:陪|帮(?:助)?|协助|支持)[^。！？!?；;\n]{0,32}(?:工作|任务))/iu;
const EN_WORK_SUPPORT_QUESTION_RE = /\b(?:how|in\s+what\s+ways?)\b[^.!?;\n]{0,48}\b(?:would|will|can|could)\s+(?:you|lumi)\b[^.!?;\n]{0,48}\b(?:help|support|assist|accompany)\b[^.!?;\n]{0,64}\b(?:work|task)\b/i;
const INDEPENDENT_IMMEDIATE_WORK_ACTION_RE = /(?:[。！？?!；;：:]\s*)(?:(?:那|那么|然后)\s*)?(?:(?:现在|马上|立即|立刻|直接)(?:就)?\s*)?(?:开始|继续|执行|推进|处理|着手|做(?:吧|它|这个|这项|该任务|该工作)?)(?:[。！？.!?]|$)|(?:[.!?;:]\s*)(?:(?:then|and)\s+)?(?:(?:now|immediately|right\s+now)\s+)?(?:start|continue|resume|execute|proceed|do\s+it)\b/i;
const CN_EXPLICIT_WORK_EXECUTION_RE = /(?:^|[。！？?!；;：:]\s*)(?:请\s*)?(?:(?:你|lumi)[，,\s]*)?(?:(?:现在|马上|立即|立刻|直接|赶紧)(?:就)?\s*)?(?:(?:帮|替|给)\s*我\s*)?(?:继续|接着|开始|着手|执行|推进|处理|完成|做)[^。！？!?；;\n]{0,28}(?:工作|任务)/iu;
const EN_EXPLICIT_WORK_EXECUTION_RE = /(?:^|[.!?;:]\s*)(?:please\s+)?(?:(?:you|lumi)\s+)?(?:(?:now|immediately|directly|right\s+now)\s+)?(?:help\s+me\s+(?:complete|finish|handle|do)|continue|resume|start|execute|advance|proceed|complete|finish|handle|do)\b[^.!?;\n]{0,48}\b(?:work|task)\b/i;
const CN_WORK_EXECUTION_QUESTION_RE = /(?:完成|处理|执行|推进|做)[^。！？!?；;\n]{0,28}(?:工作|任务)[^。！？!?；;\n]{0,12}(?:了吗|了没|没有|没)[？?]?$/u;

function isConversationalWorkSupportQuestion(text: string): boolean {
  const supportQuestion = CN_WORK_SUPPORT_QUESTION_RE.test(text) || EN_WORK_SUPPORT_QUESTION_RE.test(text);
  return supportQuestion && !INDEPENDENT_IMMEDIATE_WORK_ACTION_RE.test(text);
}

function hasExplicitWorkExecutionRequest(text: string): boolean {
  if (INDEPENDENT_IMMEDIATE_WORK_ACTION_RE.test(text)) return true;
  if (CN_WORK_EXECUTION_QUESTION_RE.test(text.trim())) return false;
  return CN_EXPLICIT_WORK_EXECUTION_RE.test(text) || EN_EXPLICIT_WORK_EXECUTION_RE.test(text);
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeText(text: string): string {
  return compact(text).replace(/\s+/g, '');
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function executionState(task?: WorkTakeoverTask | null): Record<string, any> | null {
  const state = task?.metadata?.workTakeoverExecution;
  return state && typeof state === 'object' ? state as Record<string, any> : null;
}

function hasRecoveryPressure(task?: WorkTakeoverTask | null): boolean {
  if (!task) return false;
  const state = executionState(task);
  const lastStatus = compact(state?.lastTurn?.status).toLowerCase();
  return Boolean(
    task.status === 'blocked'
      || task.status === 'waiting_confirmation'
      || compact(state?.lastFailure?.error)
      || compact(state?.resumeHint)
      || ['failed', 'blocked', 'waiting_confirmation'].includes(lastStatus),
  );
}

function isShortFollowUp(clean: string, original: string): boolean {
  return STATUS_RE.test(clean)
    || ACTION_RE.test(clean)
    || EN_WORK_STATUS_RE.test(original)
    || EN_WORK_ACTION_RE.test(original)
    || AFFIRMATIVE_RE.test(clean);
}

export function classifyWorkTakeoverContinuation(
  text: string,
  latestTask?: WorkTakeoverTask | null,
): WorkTakeoverContinuationIntent | null {
  return classifyWorkTakeoverContinuationSignal(text, latestTask, 'work').intent;
}

function normalizeSurface(surface?: WorkTakeoverTurnSurface): WorkTakeoverTurnSurface {
  return surface === 'work' || surface === 'voice' || surface === 'chat' ? surface : 'chat';
}

function classifyWorkTakeoverContinuationSignal(
  text: string,
  latestTask?: WorkTakeoverTask | null,
  surface?: WorkTakeoverTurnSurface,
): { intent: WorkTakeoverContinuationIntent | null; strength: WorkTakeoverContinuationStrength } {
  const clean = normalizeText(text);
  const normalizedSurface = normalizeSurface(surface);
  if (!clean || MUSIC_CONTINUATION_RE.test(clean)) return { intent: null, strength: 'none' };

  const hasWorkContext = WORK_CONTEXT_RE.test(clean);
  const hasEnglishWorkContext = EN_WORK_CONTEXT_RE.test(text);
  if (isConversationalWorkSupportQuestion(text)) return { intent: null, strength: 'none' };
  // Explicit execution wording must win over the generic status vocabulary.
  // Otherwise “现在帮我完成这项工作” is misread as a status query merely
  // because it contains “完成”.
  if (
    (hasWorkContext || hasEnglishWorkContext)
    && hasExplicitWorkExecutionRequest(text)
  ) return { intent: 'advance', strength: 'direct' };

  const isWorkSurface = normalizedSurface === 'work';
  const recoveryPressure = hasRecoveryPressure(latestTask);

  if (recoveryPressure && latestTask && isShortFollowUp(clean, text)) {
    const intent: WorkTakeoverContinuationIntent = STATUS_RE.test(clean) || EN_WORK_STATUS_RE.test(text)
      ? 'status'
      : 'advance';
    return { intent, strength: 'direct' };
  }

  if (EN_WORK_STATUS_RE.test(text) && (hasEnglishWorkContext || isWorkSurface)) {
    return { intent: 'status', strength: 'direct' };
  }
  if (EN_WORK_ACTION_RE.test(text) && (hasEnglishWorkContext || isWorkSurface)) {
    return { intent: 'advance', strength: 'direct' };
  }
  if (EN_WORK_STATUS_RE.test(text) && latestTask) {
    return { intent: 'status', strength: isWorkSurface ? 'direct' : 'hint' };
  }
  if (EN_WORK_ACTION_RE.test(text) && latestTask) {
    return { intent: 'advance', strength: isWorkSurface ? 'direct' : 'hint' };
  }

  if (REFERENTIAL_STATUS_RE.test(clean)) return { intent: 'status', strength: 'direct' };
  if (REFERENTIAL_ACTION_RE.test(clean)) return { intent: 'advance', strength: 'direct' };
  if (hasWorkContext && WORK_STATUS_RE.test(clean)) return { intent: 'status', strength: 'direct' };
  if (hasWorkContext && WORK_ACTION_RE.test(clean)) return { intent: 'advance', strength: 'direct' };

  if (STATUS_RE.test(clean)) {
    return {
      intent: 'status',
      strength: isWorkSurface || hasWorkContext ? 'direct' : 'hint',
    };
  }

  if (ACTION_RE.test(clean)) {
    const strongAction = STRONG_ACTION_RE.test(clean);
    return {
      intent: 'advance',
      strength: isWorkSurface || hasWorkContext || strongAction ? 'direct' : 'hint',
    };
  }

  if (latestTask?.status === 'waiting_confirmation' && AFFIRMATIVE_RE.test(clean)) {
    return {
      intent: 'advance',
      strength: isWorkSurface || recoveryPressure ? 'direct' : 'hint',
    };
  }

  return { intent: null, strength: 'none' };
}

export function getActiveWorkTakeoverTasksForContinuity(
  userId: string,
  scope: { domain?: string; orgId?: string; limit?: number } = {},
): WorkTakeoverTask[] {
  const limit = Math.max(1, Math.min(scope.limit || 3, 6));
  const scoped = listWorkTakeoverTasks({
    userId,
    domain: scope.domain,
    orgId: scope.orgId,
    status: 'active',
    limit,
  });
  if (scoped.length > 0) return scoped;
  return listWorkTakeoverTasks({ userId, status: 'active', limit });
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '待推进',
    in_progress: '推进中',
    waiting_confirmation: '等你确认',
    blocked: '受阻',
    delivered: '已交付',
    cancelled: '已取消',
  };
  return labels[status] || status;
}

function currentActionForTask(task: WorkTakeoverTask): string {
  return compact(task.nextActions[task.currentActionIndex])
    || compact(task.nextActions[0])
    || compact(task.metadata?.workTakeoverExecution?.lastPlan?.nextStep?.title)
    || '等待编排下一步';
}

function nextPlannedStep(task: WorkTakeoverTask): string {
  try {
    const plan = planWorkTakeoverExecution(task, { mode: 'prepare_work' });
    const progress = getWorkTakeoverExecutionProgress(task, plan);
    return compact(progress.nextStep?.title || progress.nextStep?.goal || plan.nextStep?.title || '');
  } catch {
    return '';
  }
}

function lastExecutionLine(task: WorkTakeoverTask): string {
  const execution = executionState(task);
  if (!execution) return '';
  const lastTurn = execution.lastTurn || {};
  const lastFailure = execution.lastFailure || {};
  const parts = [
    lastTurn.capabilityLane ? `lane=${compact(lastTurn.capabilityLane)}` : '',
    lastTurn.status ? `status=${compact(lastTurn.status)}` : '',
    lastFailure.tool ? `failedTool=${compact(lastFailure.tool)}` : '',
    lastFailure.error ? `error=${compact(lastFailure.error).slice(0, 120)}` : '',
    execution.resumeHint ? `resume=${compact(execution.resumeHint).slice(0, 180)}` : '',
  ].filter(Boolean);
  return parts.length ? `Last execution: ${parts.join(' | ')}` : '';
}

function taskLine(task: WorkTakeoverTask, index: number): string {
  const artifacts = task.artifacts
    .filter(artifact => artifact.status === 'prepared' || artifact.status === 'needs_review')
    .map(artifact => artifact.label)
    .slice(0, 3);
  const lastExecution = lastExecutionLine(task);
  const blockers = lastExecution
    ? [...task.blockedBy.slice(0, 1), lastExecution]
    : task.blockedBy.slice(0, 2);
  const confirmations = task.confirmationRequired.slice(0, 2);
  const nextStep = nextPlannedStep(task);
  return [
    `${index + 1}. ${task.title} [${task.id}]`,
    `状态：${statusLabel(task.status)}；类别：${task.category}`,
    task.summary ? `摘要：${compact(task.summary).slice(0, 180)}` : '',
    `当前动作：${currentActionForTask(task)}`,
    nextStep ? `计划下一步：${nextStep}` : '',
    artifacts.length ? `已准备：${artifacts.join('、')}` : '',
    blockers.length ? `阻塞：${blockers.join('、')}` : '',
    confirmations.length ? `确认边界：${confirmations.join('、')}` : '',
  ].filter(Boolean).join('；');
}

export function buildWorkTakeoverContinuityContext(
  userId: string,
  userText: string,
  scope: { domain?: string; orgId?: string; limit?: number; surface?: WorkTakeoverTurnSurface } = {},
): WorkTakeoverContinuityContext {
  const surface = normalizeSurface(scope.surface);
  const activeTasks = getActiveWorkTakeoverTasksForContinuity(userId, scope);
  const latestTask = activeTasks[0] || null;
  const signal = classifyWorkTakeoverContinuationSignal(userText, latestTask, surface);
  const intent = signal.intent;
  const strength = latestTask ? signal.strength : 'none';
  const shouldResumeTask = Boolean(latestTask && intent && strength === 'direct');
  const routeText = shouldResumeTask
    ? `${userText}\n\n任务中心 工作接管 ${intent === 'advance' ? '继续 下一步 推进 执行' : '状态 进度 结果 验证'}`
    : userText;

  const shouldMentionTasks = activeTasks.length > 0 && (surface === 'work' || strength !== 'none');
  const promptOverlay = shouldMentionTasks
    ? [
        '## Active Work Takeover Continuity',
        surface === 'work'
          ? 'This turn comes from a work surface. Unfinished work takeover tasks are likely relevant, but still respect the user wording.'
          : 'The user has unfinished work takeover tasks, but this turn may still be ordinary chat. Do not hijack casual conversation.',
        'Treat explicit task follow-ups like "继续这个任务 / 下一步 / 刚刚那个客户任务 / 做完了吗 / 卡在哪里" as references to the latest active task. For ambiguous chat like "继续聊 / 好的 / 然后呢", decide from context or ask one short clarification.',
        `Latest task id: ${latestTask?.id || 'none'}.`,
        `Continuation signal: ${intent || 'none'} / ${strength}.`,
        hasRecoveryPressure(latestTask)
          ? 'Latest task has recovery pressure from a blocker, failed tool, waiting confirmation, or resume hint. Short follow-ups should return to that exact failure point instead of starting a new chat.'
          : '',
        'Rules:',
        '- Do not create a new task for a follow-up or pronoun-only turn unless the user clearly starts new work.',
        '- For direct continue/next-step turns, use work_takeover_task_advance or work_takeover_task_autorun with the active task id, then report only what changed, blockers, and the next confirmation.',
        '- For status/problem turns, inspect the active task with work_takeover_task_continue/get/verify_result before answering.',
        '- For hint-level turns, prefer natural judgment: continue chatting if it sounds conversational; ask a short clarification if task binding is unclear.',
        '- Keep the answer human and compact; do not recite every internal step or fixed workflow language.',
        'Active tasks:',
        ...activeTasks.map(taskLine),
      ].filter(Boolean).join('\n')
    : '';

  return {
    activeTasks,
    latestTask,
    intent,
    strength,
    surface,
    shouldResumeTask,
    routeText,
    promptOverlay,
  };
}

function parseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatList(prefix: string, values: unknown, limit = 3): string {
  if (!Array.isArray(values)) return '';
  const items = unique(values.map(compact)).slice(0, limit);
  return items.length ? `${prefix}${items.join('；')}` : '';
}

function formatArtifacts(task: any): string {
  const artifacts = Array.isArray(task?.artifacts)
    ? task.artifacts
      .filter((artifact: any) => artifact?.status === 'prepared' || artifact?.status === 'needs_review')
      .map((artifact: any) => compact(artifact?.label))
      .filter(Boolean)
      .slice(0, 4)
    : [];
  return artifacts.length ? `已准备：${artifacts.join('；')}` : '';
}

function formatNext(task: any, progress?: any): string {
  const currentIndex = Number(task?.currentActionIndex) || 0;
  const nextFromTask = Array.isArray(task?.nextActions) ? compact(task.nextActions[currentIndex]) || compact(task.nextActions[currentIndex + 1]) : '';
  const nextFromProgress = compact(progress?.nextStep?.title || progress?.nextStep?.goal);
  const next = nextFromProgress || nextFromTask;
  return next ? `下一步：${next}` : '';
}

export function formatWorkTakeoverContinuationResult(
  intent: WorkTakeoverContinuationIntent,
  raw: string,
  error?: string,
): string {
  if (error) {
    return `我没能接上这个任务：${error}`;
  }
  const data = parseJson(raw);
  if (!data) {
    return raw ? raw.slice(0, 800) : '我已经尝试接上任务，但没有拿到可读的结果。';
  }

  if (intent === 'status') {
    const task = data.task || {};
    return [
      `这个任务还在${statusLabel(task.status || 'in_progress')}。`,
      formatArtifacts(task),
      formatList('卡住：', task.blockedBy),
      formatList('需要你确认：', data.confirmationRequired || task.confirmationRequired),
      formatNext(task),
    ].filter(Boolean).join('\n');
  }

  const task = data.task || {};
  const execution = data.execution || {};
  const packet = data.packet;
  const action = data.action;
  const headline = action === 'exported_packet' || packet
    ? '安全部分已经整理成任务包。'
    : execution.status === 'blocked'
      ? '我继续推进了一步，但这里卡住了。'
      : execution.status === 'waiting_confirmation'
        ? '我继续推进了一步，现在停在确认边界。'
        : '我继续推进了一步。';

  return [
    headline,
    execution.summary ? `完成：${compact(execution.summary)}` : '',
    formatArtifacts(task),
    formatList('卡住：', task.blockedBy),
    formatList('需要你确认：', task.confirmationRequired),
    formatNext(task, data.progress),
  ].filter(Boolean).join('\n');
}

export function getWorkTakeoverContinuationQuickCommand(
  text: string,
  userId: string,
  scope: { domain?: string; orgId?: string; surface?: WorkTakeoverTurnSurface } = {},
): WorkTakeoverContinuationCommand | null {
  const latestTask = getActiveWorkTakeoverTasksForContinuity(userId, { ...scope, limit: 1 })[0] || null;
  if (!latestTask) return null;
  const signal = classifyWorkTakeoverContinuationSignal(text, latestTask, normalizeSurface(scope.surface));
  const intent = signal.intent;
  if (!intent || signal.strength !== 'direct') return null;
  const toolName = intent === 'status' ? 'work_takeover_task_continue' : 'work_takeover_task_advance';
  return {
    intent,
    task: latestTask,
    toolCall: {
      name: toolName,
      arguments: {
        id: latestTask.id,
        ...(intent === 'advance' ? { mode: 'prepare_work', exportWhenComplete: true } : {}),
      },
    },
    responseText: intent === 'status'
      ? '我看一下这个任务现在卡在哪里。'
      : '我接着推进这个任务。',
    formatToolResult: (raw, error) => formatWorkTakeoverContinuationResult(intent, raw, error),
  };
}
