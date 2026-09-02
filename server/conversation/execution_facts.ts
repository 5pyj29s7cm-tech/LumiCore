import { readDB } from '../../db_layer';
import { CN_CONVERSATION_EXECUTION_FACT_MESSAGES } from '../regions/packs/cn/conversation_execution_facts_messages';
import { isPriorTurnToolReceiptQuestion } from '../cognition/normalized_action_intent';
import { toolRecordSucceeded } from '../cognition/task_execution_ledger';
import { formatCnToolFailureDetail } from '../regions/packs/cn/voice_fast_path_messages';

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
    toolName?: string;
    requestId?: string;
    targetIdentity?: string;
    result?: unknown;
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
  if (isPriorFailureExplanationQuestion(normalized)) return true;
  if (isPriorTurnToolReceiptQuestion(normalized)) return true;
  if (isPriorSingleFileReadFactQuestion(normalized)) return true;
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

function isPriorSingleFileReadFactQuestion(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return false;
  // A correction that names a concrete file is executable work even when it
  // also says "previous task" or contains the word "path".  Let the normal
  // task-continuation path bind it to the server-owned task; never consume it
  // as a read-only history lookup before the tool loop runs.
  // i18n-allow: multilingual action/target recognition; not user-visible copy.
  const hasExplicitFileTarget = /(?:[A-Za-z]:[\\/]|\\\\)[^\r\n“”"'<>|?*，,；;。！？!?]{1,440}\.[A-Za-z0-9]{1,16}(?=$|[\s，,；;。！？!?)）\]}'"])/u.test(normalized)
    || /\/(?:Users|home|tmp|var|opt|Volumes)\/[^\r\n“”"'<>]{1,440}\.[A-Za-z0-9]{1,16}(?=$|[\s，,；;。！？!?)）\]}'"])/u.test(normalized);
  // i18n-allow: multilingual correction/continuation recognition; not user-visible copy.
  const explicitTargetAction = /(?:不是|不对|纠正|改成|改为|换成|而是|应该是)|(?:继续|接着|重试).{0,32}(?:任务|读取|读|打开|分析)|(?:请|帮我|现在|然后|继续|接着|重新|再次|再|改成|改为|换成)\s*(?:读取|读一下|打开|分析)|\b(?:instead|correct|change|replace|continue|resume|retry|re-?read|read\s+again)\b/iu.test(normalized);
  if (hasExplicitFileTarget && explicitTargetAction) return false;
  // A request to re-read is executable work. This fast path is only for
  // recalling the immediately preceding, already verified read receipt.
  // i18n-allow: multilingual previous-file fact recognition; not user-visible copy.
  const freshReadMarkers = Array.from(normalized.matchAll(
    /(?:重新\s*读取|再次\s*读取|再\s*读(?:取)?|重读)|\b(?:re-?read(?:ing)?|read\s+again)\b/giu,
  ));
  const asksForFreshRead = freshReadMarkers.some(marker => {
    const markerIndex = marker.index ?? 0;
    const prefix = normalized.slice(Math.max(0, markerIndex - 48), markerIndex);
    const clausePrefix = prefix.slice(Math.max(
      prefix.lastIndexOf('，'),
      prefix.lastIndexOf(','),
      prefix.lastIndexOf('。'),
      prefix.lastIndexOf('.'),
      prefix.lastIndexOf('！'),
      prefix.lastIndexOf('!'),
      prefix.lastIndexOf('？'),
      prefix.lastIndexOf('?'),
      prefix.lastIndexOf('；'),
      prefix.lastIndexOf(';'),
    ) + 1);
    // "不要重新读取" and "without re-reading" explicitly forbid a new
    // tool call. They must not be mistaken for an executable re-read request.
    // Keep the negation close to the marker so a separate clause such as
    // "不要猜，重新读取" still requests fresh work.
    // i18n-allow: multilingual negated re-read recognition; not user-visible copy.
    const negated = /(?:不要|别|无需|无须|不用|不必|不需要|请勿|禁止|不是(?:要|让你)?|并非(?:要|让你)?)[^，,。.!！？?；;\n]{0,6}$/u.test(clausePrefix)
      || /(?:do\s+not|don't|dont|never|without|no\s+need\s+to|need\s+not|needn't|must\s+not)(?:\s+(?:actually|really|ever|please|the\s+file|it)){0,3}\s*$/iu.test(clausePrefix);
    return !negated;
  });
  if (asksForFreshRead) return false;
  // i18n-allow: multilingual previous-file fact recognition; not user-visible copy.
  const prior = /(?:刚才|刚刚|上一轮|上次|前一轮|此前)|\b(?:just\s+now|previous(?:ly)?|last\s+turn|prior\s+turn|earlier)\b/iu.test(normalized);
  // i18n-allow: multilingual previous-file fact recognition; not user-visible copy.
  const read = /(?:读取|读过|读的|所读)|\b(?:read|file)\b/iu.test(normalized);
  // i18n-allow: multilingual previous-file fact recognition; not user-visible copy.
  const asksFact = /(?:哪个|哪一个|什么|精确|路径|字段|值|名称|版本)|\b(?:which|what|exact|path|field|value|name|version)\b/iu.test(normalized);
  // A fact lookup must actually ask for, recall, or request presentation of a
  // stored value. Merely mentioning "previous", "read", and "path" is not a
  // question and must not steal an executable correction from the task lane.
  // i18n-allow: multilingual fact-query recognition; not user-visible copy.
  const asksForRecall = /[？?]/u.test(normalized)
    || /(?:告诉我|列出|给我|回答|说(?:一)?下|回忆|根据.{0,20}回执|分.{0,8}(?:行|列))/u.test(normalized)
    || /\b(?:tell|report|list|give|recall|show|based\s+(?:only\s+)?on)\b/iu.test(normalized);
  return prior && read && asksFact && asksForRecall;
}

function isPriorFailureExplanationQuestion(text: string): boolean {
  // i18n-allow: Chinese previous-turn failure question recognition; not user-visible copy.
  return /^(?:(?:这次|刚才|刚刚|上次|前面|那个任务)\s*)?(?:为什么|怎么(?:会)?|为何)\s*(?:失败|没(?:有)?(?:做成|完成|成功)|没做成|出错|报错|受阻|卡住)(?:了|的)?[啊呀呢，,。！？?!\s]*$/u.test(text)
    || /^why\s+(?:did\s+)?(?:it|that|the\s+(?:task|request))?\s*(?:fail|failed|not\s+(?:finish|complete|succeed))[?!.\s]*$/iu.test(text);
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
            toolName: String(record.envelope.toolName || '').trim() || undefined,
            requestId: String(record.envelope.requestId || '').trim() || undefined,
            targetIdentity: String(record.envelope.targetIdentity || '').trim() || undefined,
            result: record.envelope.result,
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

function latestTurnRecords(facts: ConversationExecutionFacts): ConversationExecutionToolFact[] {
  if (facts.priorTurnToolCalls) return facts.priorTurnToolCalls;
  const latest = facts.toolCalls[facts.toolCalls.length - 1];
  if (!latest) return [];
  const turnId = String(latest.turnId || latest.requestId || '').trim();
  return turnId
    ? facts.toolCalls.filter(record => String(record.turnId || record.requestId || '').trim() === turnId)
    : [latest];
}

const VERIFIED_FILE_READ_TOOL_RE = /^(?:read_file|read_pdf|read_docx|read_xlsx|extract_document_text|pdf_to_text|ocr_image_file)$/i;
const SENSITIVE_RESULT_FIELD_RE = /(?:api.?key|authorization|cookie|credential|password|passphrase|secret|token)/i;

function verifiedPriorFileReadRecord(record: ConversationExecutionToolFact): boolean {
  if (record.error || !VERIFIED_FILE_READ_TOOL_RE.test(record.name)) return false;
  const terminalStatus = String(record.terminalVerification?.status || '').trim();
  const envelopeStatus = String(record.envelope?.status || '').trim();
  const envelopeVerification = String(record.envelope?.verification?.status || '').trim();
  const envelopeToolName = String(record.envelope?.toolName || '').trim();
  const envelopeRequestId = String(record.envelope?.requestId || '').trim();
  const envelopeTarget = String(record.envelope?.targetIdentity || '').trim();
  const argumentTarget = String(
    record.arguments?.path
    || record.arguments?.filePath
    || record.arguments?.documentPath
    || record.arguments?.imagePath
    || '',
  ).trim();
  if (envelopeToolName && envelopeToolName !== record.name) return false;
  if (envelopeRequestId && envelopeRequestId !== String(record.requestId || '').trim()) return false;
  if (
    envelopeTarget
    && argumentTarget
    && envelopeTarget.replace(/\\/g, '/').toLowerCase() !== argumentTarget.replace(/\\/g, '/').toLowerCase()
  ) return false;
  if (terminalStatus && terminalStatus !== 'verified') return false;
  if (envelopeStatus && envelopeStatus !== 'verified_success') return false;
  if (envelopeVerification && envelopeVerification !== 'verified') return false;
  return terminalStatus === 'verified'
    || (envelopeStatus === 'verified_success' && envelopeVerification === 'verified');
}

function exactPriorReadTarget(record: ConversationExecutionToolFact): string {
  const envelopeVerified = record.envelope?.status === 'verified_success'
    && record.envelope.verification?.status === 'verified';
  const candidate = String(
    (envelopeVerified ? record.envelope?.targetIdentity : '')
    || record.arguments?.path
    || record.arguments?.filePath
    || record.arguments?.documentPath
    || record.arguments?.imagePath
    || '',
  ).trim();
  if (!candidate || candidate.includes('\0')) return '';
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(candidate);
  const finalSegment = candidate.split(/[\\/]/).pop() || '';
  return absolute && /\.[A-Za-z0-9]{1,16}$/u.test(finalSegment) ? candidate : '';
}

function priorReadResult(record: ConversationExecutionToolFact): Record<string, any> {
  const envelopeVerified = record.envelope?.status === 'verified_success'
    && record.envelope.verification?.status === 'verified';
  if (envelopeVerified) {
    const envelopeResult = parseRecordResult(record.envelope?.result);
    if (Object.keys(envelopeResult).length > 0) return envelopeResult;
  }
  return parseRecordResult(record.result);
}

function resultFieldRequested(text: string, fieldName: string): boolean {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifier = `(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`;
  return new RegExp('[\\x60"“‘]' + escaped + '[\\x60"”’]', 'iu').test(text)
    // i18n-allow: multilingual requested-field recognition; not user-visible copy.
    || new RegExp(`(?:其中|字段|键|它的|文件的)[^。！？!?]{0,100}${identifier}`, 'iu').test(text)
    // i18n-allow: multilingual requested-field recognition; not user-visible copy.
    || new RegExp(`${identifier}[^。！？!?]{0,60}(?:是什么|分别是什么|字段值|的值)`, 'iu').test(text)
    || new RegExp('\\b(?:field|fields|key|keys|its|their|what\\s+is|what\\s+are)\\b[^.!?]{0,100}' + identifier, 'iu').test(text);
}

function requestedPriorReadFields(
  text: string,
  result: Record<string, any>,
): { fields: Array<{ name: string; value: string }>; missingFields: string[] } {
  const requested = new Set<string>();
  // i18n-allow: multilingual requested-field recognition; not user-visible copy.
  if (/(?:项目)?名称|\bname\b/iu.test(text)) requested.add('name');
  // i18n-allow: multilingual requested-field recognition; not user-visible copy.
  if (/版本|\bversion\b/iu.test(text)) requested.add('version');
  for (const key of Object.keys(result).slice(0, 100)) {
    if (
      /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)
      && !SENSITIVE_RESULT_FIELD_RE.test(key)
      && resultFieldRequested(text, key)
    ) requested.add(key);
  }

  const fields: Array<{ name: string; value: string }> = [];
  const missingFields: string[] = [];
  for (const name of Array.from(requested).slice(0, 8)) {
    const value = result[name];
    if (value === undefined || value === null || (typeof value === 'object' && value !== null)) {
      missingFields.push(name);
      continue;
    }
    const rendered = String(value).replace(/\s+/gu, ' ').replace(/`/g, 'ˋ').trim().slice(0, 240);
    if (!rendered) {
      missingFields.push(name);
      continue;
    }
    fields.push({ name, value: rendered });
  }
  return { fields, missingFields };
}

function priorSingleFileReadFacts(facts: ConversationExecutionFacts): {
  status: 'missing' | 'ambiguous' | 'verified';
  target?: string;
  result?: Record<string, any>;
} {
  const reads = latestTurnRecords(facts).filter(verifiedPriorFileReadRecord).flatMap(record => {
    const target = exactPriorReadTarget(record);
    return target ? [{ record, target }] : [];
  });
  if (reads.length === 0) return { status: 'missing' };
  const identities = new Set(reads.map(item => item.target.replace(/\\/g, '/').toLowerCase()));
  if (identities.size !== 1) return { status: 'ambiguous' };
  const latest = reads.at(-1)!;
  return {
    status: 'verified',
    target: latest.target,
    result: priorReadResult(latest.record),
  };
}

function failedReceiptDetail(record: ConversationExecutionToolFact): string {
  if (record.errorDetail) return record.errorDetail;
  const payload = parseRecordResult(record.result);
  const verification = payload.verification && typeof payload.verification === 'object'
    ? payload.verification
    : {};
  return String(
    payload.error
    || payload.parseError
    || payload.reason
    || payload.blocker
    || verification.error
    || verification.reason
    || payload.status
    || '',
  ).trim();
}

function receiptFailed(record: ConversationExecutionToolFact): boolean {
  if (record.error || record.terminalVerification?.status === 'failed') return true;
  const payload = parseRecordResult(record.result);
  const status = String(payload.status || payload.verification?.status || '').trim().toLowerCase();
  return payload.ok === false
    || payload.success === false
    || payload.failed === true
    || /^(?:failed|error|blocked|timeout|timed_out|target_mismatch|unverified)$/.test(status);
}

function failureActionLabel(name: string): string {
  if (/(?:ocr|vision|capture_screen|computer_vision)/iu.test(name)) return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionVision;
  if (/(?:wechat|message|send_file|send_message)/iu.test(name)) return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionMessaging;
  if (/(?:read_pdf|read_docx|read_file|extract_document)/iu.test(name)) return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionFileRead;
  if (/(?:desktop_open|browser_open|open_item)/iu.test(name)) return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionOpen;
  if (/(?:desktop|keyboard|mouse|computer_use)/iu.test(name)) return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionDesktop;
  return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failureActionGeneric;
}

export function formatConversationExecutionFactAnswer(
  facts: ConversationExecutionFacts,
  text: string,
): string {
  const zh = /[\u3400-\u9fff]/u.test(text);
  if (isPriorSingleFileReadFactQuestion(text)) {
    const read = priorSingleFileReadFacts(facts);
    if (read.status === 'missing') {
      return zh
        ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.noVerifiedPriorFileRead
        : 'The previous turn has no verified single-file read receipt bound to this message, so I will not guess the file or its field values.';
    }
    if (read.status === 'ambiguous' || !read.target) {
      return zh
        ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.ambiguousPriorFileRead
        : 'The previous turn read multiple files, so the recorded receipts do not identify one exact file.';
    }
    const requested = requestedPriorReadFields(text, read.result || {});
    if (zh) {
      return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.priorFileReadFacts(
        read.target,
        requested.fields,
        requested.missingFields,
      );
    }
    return [
      `The exact file read in the previous turn was \`${read.target}\`.`,
      ...requested.fields.map(field => `- ${field.name}: \`${field.value}\``),
      requested.missingFields.length > 0
        ? `The verified read result did not retain these fields: ${requested.missingFields.join(', ')}.`
        : '',
    ].filter(Boolean).join('\n');
  }
  if (isPriorFailureExplanationQuestion(text)) {
    const failedRecord = [...latestTurnRecords(facts)].reverse().find(receiptFailed);
    if (!failedRecord) {
      return zh
        ? CN_CONVERSATION_EXECUTION_FACT_MESSAGES.noPriorFailureReceipt
        : 'No verifiable failure receipt was recorded for the previous turn, so I cannot infer a cause from an older task status.';
    }
    const detail = failedReceiptDetail(failedRecord);
    if (zh) {
      return CN_CONVERSATION_EXECUTION_FACT_MESSAGES.failedAt(
        failureActionLabel(failedRecord.name),
        formatCnToolFailureDetail(detail),
      );
    }
    return detail
      ? `The previous attempt failed while running ${failedRecord.name}: ${detail}`
      : `The previous attempt failed while running ${failedRecord.name}, but the service returned no further reason.`;
  }
  if (isPriorTurnToolReceiptQuestion(text)) {
    const records = latestTurnRecords(facts);
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
