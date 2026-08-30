import { readDB } from '../../db_layer';
import { CN_CONVERSATION_EXECUTION_FACT_MESSAGES } from '../regions/packs/cn/conversation_execution_facts_messages';
import { isPriorTurnToolReceiptQuestion } from '../cognition/normalized_action_intent';
import { toolRecordSucceeded } from '../cognition/task_execution_ledger';

export interface ConversationExecutionFactScope {
  conversationId: string;
  userId: string;
  domain?: string;
  orgId?: string;
  /** The just-persisted user request, used to locate the immediately preceding turn. */
  currentRequestId?: string;
  /** Optional server-bound durable task identity for exact status projection. */
  taskId?: string;
}

export interface ConversationExecutionFacts {
  toolCalls: ConversationExecutionToolFact[];
  /** Tool receipts belonging only to the user turn immediately before this one. */
  priorTurnToolCalls?: ConversationExecutionToolFact[];
  tasks: Array<{ id: string; status: string }>;
  recentUserMessages?: string[];
}

export interface ConversationExecutionToolFact {
  name: string;
  error: boolean;
  errorDetail?: string;
  turnId?: string;
  requestId?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  terminalVerification?: { status?: string };
  envelope?: {
    status?: string;
    verification?: { status?: string };
  };
}

function parseToolCalls(value: unknown): any[] {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string' && parsed.trim(); depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

export function isConversationExecutionFactQuestion(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (isPriorTurnToolReceiptQuestion(normalized)) return true;
  // i18n-allow -- Chinese prior-open fact-question recognition; not user-visible copy.
  const asksAboutPriorOpen = /(?:你)?(?:不是|不都|难道没)?(?:已经|刚才|刚刚|之前).{0,16}(?:打开|启动|运行).{0,24}(?:吗|没有|没|不知道|忘了)|(?:你)?(?:已经|刚才|刚刚).{0,16}(?:打开|启动|运行)了[，,。！？!?\s]*(?:你)?(?:自己)?(?:不知道|忘了)|\b(?:didn'?t|did\s+you\s+not|you\s+already).{0,40}\b(?:open|launch|start)(?:ed)?\b/iu.test(normalized);
  if (asksAboutPriorOpen) return true;
  const conversationScope = /(?:这|本|当前|刚才|刚刚|整个).{0,10}(?:轮|段|次)?(?:对话|会话|聊天)|\b(?:this|current|that)\s+(?:conversation|chat|session)\b/iu.test(normalized);
  const asksWhether = /(?:有没有|有没|是否|究竟|到底|真的)|\b(?:did|have|was|were)\b/iu.test(normalized);
  const executionSubject = /(?:(?:调用|执行|使用|跑).{0,10}(?:工具|插件|技能)|(?:创建|新建|建立).{0,10}(?:任务|计划))|\b(?:call|use|run|execute)(?:d|ing)?\s+(?:any\s+)?tools?\b|\bcreat(?:e|ed|ing)\s+(?:any\s+)?tasks?\b/iu.test(normalized);
  const asksVerifiedClientNavigation = /(?:成功|实际|真实|回执).{0,24}(?:客户端)?(?:导航|界面动作|页面动作)|(?:哪一个|哪个|什么).{0,24}(?:客户端)?(?:导航动作|界面动作)/u.test(normalized);
  return (conversationScope && asksWhether && executionSubject) || asksVerifiedClientNavigation;
}

function parseRecordArguments(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseRecordResult(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
}

function interactionRequestId(item: any): string {
  return String(item?.requestId || item?.externalMessageId || '').trim();
}

function verifiedPriorOpen(record: ConversationExecutionFacts['toolCalls'][number]): boolean {
  if (!/^(?:desktop_open|browser_open_task)$/i.test(record.name) || record.error) return false;
  const payload = parseRecordResult(record.result);
  const status = String(payload.status || payload.verification?.status || '').trim().toLowerCase();
  const targetMatched = payload.targetMatched === true || payload.verification?.targetMatched === true;
  if (payload.ok === false || payload.success === false || payload.opened === false) return false;
  return (
    record.envelope?.status === 'verified_success'
      && record.envelope.verification?.status === 'verified'
  ) || (
    record.terminalVerification?.status === 'verified'
      && targetMatched
  ) || (
    status === 'verified'
      && targetMatched
  );
}

function priorOpenTarget(record: ConversationExecutionFacts['toolCalls'][number]): string {
  const payload = parseRecordResult(record.result);
  const invoked = String(
    record.arguments?.target
    || record.arguments?.path
    || record.arguments?.url
    || payload.target
    || '',
  ).trim();
  const actual = `${payload.actualTarget?.processName || ''} ${payload.actualTarget?.title || ''} ${invoked}`;
  if (/chrome/iu.test(actual)) return 'Google Chrome';
  if (/msedge|microsoft\s*edge/iu.test(actual)) return 'Microsoft Edge';
  if (/firefox/iu.test(actual)) return 'Firefox';
  return invoked.split(/[\\/]/).pop() || invoked || CN_CONVERSATION_EXECUTION_FACT_MESSAGES.unnamedOpenTarget;
}

function optionalOpenObservationFailed(
  records: ConversationExecutionFacts['toolCalls'],
  openIndex: number,
): boolean {
  const openTurnId = records[openIndex]?.turnId;
  return records.slice(openIndex + 1).some(record => {
    if (openTurnId && record.turnId && record.turnId !== openTurnId) return false;
    if (!record.error && record.terminalVerification?.status !== 'failed' && record.terminalVerification?.status !== 'unverified') {
      return false;
    }
    if (/^(?:desktop_execution_plan_receipt|desktop_active_window|get_active_window_info|desktop_running_processes|get_running_processes|desktop_capture_screen|desktop_ocr|computer_vision)$/i.test(record.name)) {
      return true;
    }
    return /^desktop_run_command$/i.test(record.name)
      && /(?:fingerprint|target[_ ]?mismatch|focus|foreground|window|display|paused_for_user_activity)/iu
        .test(record.errorDetail || record.result || '');
  });
}

function verifiedClientAction(record: ConversationExecutionFacts['toolCalls'][number]): string {
  if (record.name !== 'client_action' || record.error) return '';
  const action = String(record.arguments?.action || '').trim();
  if (!action) return '';
  let payload: any = null;
  try { payload = JSON.parse(String(record.result || '{}')); } catch {}
  const status = String(payload?.verification?.status || payload?.status || '').toLowerCase();
  return payload?.ok !== false && /^(?:verified|not_applicable)$/.test(status) ? action : '';
}

function clientActionLabel(action: string): string {
  const labels: Record<string, string> = {
    open_command_center: '打开指挥中心',
    open_chat: '打开聊天界面',
    open_nexus: '打开 OS 核心',
    open_skills: '打开技能大厅',
    show_knowledge_base: '打开知识库',
    open_settings: '打开设置',
    focus_home: '返回主界面',
  };
  return labels[action] || action;
}

function recalledAcceptanceCode(messages: string[]): string {
  for (const message of [...messages].reverse()) {
    const match = String(message || '').match(/验收代号(?:是|为|：|:)\s*[“"']?([^，。！？!?\s”"']{2,40})/u);
    if (match?.[1]) return match[1];
  }
  return '';
}

export function getConversationExecutionFacts(scope: ConversationExecutionFactScope): ConversationExecutionFacts {
  const db = readDB();
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  const orgId = domain === 'work' ? String(scope.orgId || '') : '';
  const interactions = (db.interactions || []).filter((item: any) => (
    String(item.conversationId || '') === scope.conversationId
    && String(item.userId || '') === scope.userId
    && String(item.domain || 'personal') === domain
    && (domain !== 'work' || String(item.orgId || '') === orgId)
  ));
  const mapInteractionToolCalls = (item: any): ConversationExecutionToolFact[] => (
    parseToolCalls(item.toolCalls).map((record: any) => ({
      name: String(record?.name || record?.toolName || '').trim(),
      error: Boolean(record?.error),
      errorDetail: String(record?.error || '').trim() || undefined,
      turnId: String(record?.turnId || record?.requestId || item?.requestId || item?.turnId || '').trim() || undefined,
      requestId: String(record?.requestId || item?.requestId || item?.externalMessageId || '').trim() || undefined,
      arguments: parseRecordArguments(record?.arguments ?? record?.args),
      result: typeof record?.result === 'string' ? record.result : JSON.stringify(record?.result ?? ''),
      terminalVerification: record?.terminalVerification && typeof record.terminalVerification === 'object'
        ? { status: String(record.terminalVerification.status || '') }
        : undefined,
      envelope: record?.envelope && typeof record.envelope === 'object'
        ? {
            status: String(record.envelope.status || ''),
            verification: record.envelope.verification && typeof record.envelope.verification === 'object'
              ? { status: String(record.envelope.verification.status || '') }
              : undefined,
          }
        : undefined,
    })).filter((record: ConversationExecutionToolFact) => Boolean(record.name))
  );
  const toolCalls = interactions.flatMap(mapInteractionToolCalls);
  const currentUserIndex = (() => {
    const exactRequestId = String(scope.currentRequestId || '').trim();
    if (!exactRequestId) return -1;
    if (exactRequestId) {
      for (let index = interactions.length - 1; index >= 0; index -= 1) {
        const item = interactions[index];
        if (
          String(item?.role || '').toLowerCase() === 'user'
          && String(item?.requestId || item?.externalMessageId || '') === exactRequestId
        ) return index;
      }
    }
    return -1;
  })();
  let previousUserIndex = -1;
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (String(interactions[index]?.role || '').toLowerCase() === 'user') {
      previousUserIndex = index;
      break;
    }
  }
  const previousUserRequestId = previousUserIndex >= 0
    ? interactionRequestId(interactions[previousUserIndex])
    : '';
  const priorTurnToolCalls = scope.currentRequestId
    ? previousUserIndex >= 0
      ? previousUserRequestId
        // Accepted user turns are persisted before they wait for an older
        // foreground lease. A queued transcript can therefore be ordered as
        // user1, user2, assistant1. Bind receipts to user1's immutable request
        // id instead of assuming assistant1 must sit between the two users.
        ? interactions.flatMap((item: any) => {
            const itemRequestId = interactionRequestId(item);
            return mapInteractionToolCalls(item).filter(record => (
              itemRequestId === previousUserRequestId
              || record.requestId === previousUserRequestId
            ));
          })
        // Legacy rows may predate durable request ids. Preserve the original
        // adjacency fallback only for those rows; a modern request with no
        // matching receipt must remain an authoritative empty result.
        : interactions
          .slice(previousUserIndex + 1, currentUserIndex >= 0 ? currentUserIndex : interactions.length)
          .flatMap(mapInteractionToolCalls)
      : []
    : undefined;
  const tasks = (db.conversationActionTasks || []).filter((task: any) => (
    String(task.conversationId || '') === scope.conversationId
    && String(task.userId || '') === scope.userId
    && String(task.domain || 'personal') === domain
    && (domain !== 'work' || String(task.orgId || '') === orgId)
    && (!scope.taskId || String(task.id || '') === scope.taskId)
  )).map((task: any) => ({
    id: String(task.id || ''),
    status: String(task.status || 'unknown'),
  }));
  const recentUserMessages = interactions
    .filter((item: any) => String(item.role || '').toLowerCase() === 'user')
    .map((item: any) => String(item.message || '').trim())
    .filter(Boolean)
    .slice(-24);
  return { toolCalls, priorTurnToolCalls, tasks, recentUserMessages };
}

function priorTurnToolOutcome(record: ConversationExecutionToolFact): 'success' | 'failed' {
  if (record.error) return 'failed';
  if (
    record.terminalVerification?.status === 'verified'
    || (
      record.envelope?.status === 'verified_success'
      && record.envelope.verification?.status === 'verified'
    )
  ) return 'success';
  return toolRecordSucceeded(record as any) ? 'success' : 'failed';
}

export function formatConversationExecutionFactAnswer(
  facts: ConversationExecutionFacts,
  text: string,
): string {
  const zh = /[\u3400-\u9fff]/u.test(text);
  if (isPriorTurnToolReceiptQuestion(text)) {
    const records = facts.priorTurnToolCalls || (() => {
      const latest = facts.toolCalls[facts.toolCalls.length - 1];
      if (!latest) return [];
      const turnId = String(latest.turnId || latest.requestId || '').trim();
      return turnId
        ? facts.toolCalls.filter(record => String(record.turnId || record.requestId || '').trim() === turnId)
        : [latest];
    })();
    if (records.length === 0) {
      return zh
        ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.noPriorTurnToolReceipt
        : 'No tool-call receipt was recorded for the previous turn.';
    }
    const outcomes = records.map(record => ({
      name: record.name,
      outcome: priorTurnToolOutcome(record),
    }));
    // i18n-allow -- Multilingual receipt-detail recognition; not user-visible copy.
    const asksWindowTitle = /(?:窗口标题|观察到的窗口)|\b(?:window\s+title|observed\s+window)\b/iu.test(text);
    const observedWindowRecord = asksWindowTitle
      ? [...records].reverse().find(record => /^(?:desktop_active_window|get_active_window_info)$/i.test(record.name))
      : undefined;
    const observedWindowResult = observedWindowRecord
      ? parseRecordResult(observedWindowRecord.result)
      : {};
    const observedWindowTitle = String(
      observedWindowResult.windowTitle
      || observedWindowResult.window_title
      || observedWindowResult.title
      || '',
    ).trim();
    // i18n-allow -- Multilingual receipt-detail recognition; not user-visible copy.
    const asksTaskStatus = /(?:任务|当前|真实).{0,20}状态|\b(?:task|current|real)\b.{0,24}\bstatus\b/iu.test(text);
    const taskStatus = facts.tasks[0]?.status || '';
    if (zh) {
      return [
        CN_CONVERSATION_EXECUTION_FACT_MESSAGES.priorTurnTools(outcomes),
        asksTaskStatus ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.taskStatus(taskStatus) : '',
        asksWindowTitle ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.observedWindowTitle(observedWindowTitle) : '',
      ].filter(Boolean).join('\n');
    }
    return [
      `The previous turn called: ${outcomes.map(item => `${item.name} (${item.outcome})`).join(', ')}.`,
      asksTaskStatus ? `Task status: ${taskStatus || 'not recorded'}.` : '',
      asksWindowTitle ? `Observed window title: ${observedWindowTitle || 'not recorded'}.` : '',
    ].filter(Boolean).join('\n');
  }
  const toolNames = Array.from(new Set(facts.toolCalls.map(record => record.name)));
  const taskStatuses = Array.from(new Set(facts.tasks.map(task => task.status)));
  // i18n-allow -- Chinese prior-open fact-question recognition; not user-visible copy.
  const asksAboutPriorOpen = /(?:你)?(?:不是|不都|难道没)?(?:已经|刚才|刚刚|之前).{0,16}(?:打开|启动|运行).{0,24}(?:吗|没有|没|不知道|忘了)|(?:你)?(?:已经|刚才|刚刚).{0,16}(?:打开|启动|运行)了[，,。！？!?\s]*(?:你)?(?:自己)?(?:不知道|忘了)|\b(?:didn'?t|did\s+you\s+not|you\s+already).{0,40}\b(?:open|launch|start)(?:ed)?\b/iu.test(text);
  if (asksAboutPriorOpen) {
    let openIndex = -1;
    for (let index = facts.toolCalls.length - 1; index >= 0; index -= 1) {
      if (verifiedPriorOpen(facts.toolCalls[index])) {
        openIndex = index;
        break;
      }
    }
    if (openIndex < 0) {
      return zh
        ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.noVerifiedOpen
        : 'I checked this conversation and found no verified successful open receipt.';
    }
    const target = priorOpenTarget(facts.toolCalls[openIndex]);
    const observationFailed = optionalOpenObservationFailed(facts.toolCalls, openIndex);
    if (zh) {
      return [
        CN_CONVERSATION_EXECUTION_FACT_MESSAGES.verifiedOpen(target),
        ...(observationFailed
          ? [CN_CONVERSATION_EXECUTION_FACT_MESSAGES.laterObservationIncomplete]
          : []),
      ].join('');
    }
    return [
      `Yes. ${target} was opened and the action has a verified receipt.`,
      ...(observationFailed
        ? [' A later window/focus check did not finish, but it does not undo the completed open action.']
        : []),
    ].join('');
  }
  const asksVerifiedClientNavigation = /(?:成功|实际|真实|回执).{0,24}(?:客户端)?(?:导航|界面动作|页面动作)|(?:哪一个|哪个|什么).{0,24}(?:客户端)?(?:导航动作|界面动作)/u.test(text);
  if (zh && asksVerifiedClientNavigation) {
    const action = [...facts.toolCalls].reverse().map(verifiedClientAction).find(Boolean) || '';
    const acceptanceCode = /验收代号/u.test(text)
      ? recalledAcceptanceCode(facts.recentUserMessages || [])
      : '';
    const parts = [
      acceptanceCode ? `刚才的验收代号是${acceptanceCode}。` : '',
      action
        ? `成功执行过的客户端导航动作是“${clientActionLabel(action)}”（client_action:${action}），已由真实回执验证。`
        : '当前会话没有找到已验证成功的客户端导航回执。',
    ].filter(Boolean);
    return parts.join('');
  }
  if (zh) {
    if (facts.toolCalls.length === 0 && facts.tasks.length === 0) {
      return '没有。这段对话没有记录到工具调用，也没有创建任务。';
    }
    const parts = [
      facts.toolCalls.length > 0
        ? `记录到 ${facts.toolCalls.length} 次工具调用：${toolNames.join('、')}。`
        : '没有记录到工具调用。',
      facts.tasks.length > 0
        ? `创建了 ${facts.tasks.length} 个任务，当前状态：${taskStatuses.join('、')}。`
        : '没有创建任务。',
    ];
    return parts.join('');
  }
  if (facts.toolCalls.length === 0 && facts.tasks.length === 0) {
    return 'No. This conversation has no recorded tool calls and no created tasks.';
  }
  return [
    facts.toolCalls.length > 0
      ? `${facts.toolCalls.length} tool call(s) were recorded: ${toolNames.join(', ')}.`
      : 'No tool calls were recorded.',
    facts.tasks.length > 0
      ? `${facts.tasks.length} task(s) were created; current status: ${taskStatuses.join(', ')}.`
      : 'No tasks were created.',
  ].join(' ');
}
