import { matchesCnActionContinuation } from '../regions/packs/cn/action_continuation';
import { isGuardGeneratedConversationRecord } from '../conversation/guard_history';
import { buildActionContract } from './action_contract';

export interface ActionContinuationHistoryItem {
  role?: string;
  type?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
  toolCalls?: unknown;
  cognitiveIntent?: string;
}

export interface RecentActionContinuationState {
  goal: string;
  appTarget: string;
  sourcePaths: string[];
  latestBlocker: string;
  unfinished: boolean;
  evidenceTools: string[];
}

/**
 * Compact, conversation-scoped execution pointer persisted alongside the
 * conversation. It is deliberately evidence-derived: a plain assistant claim
 * can never create or advance this state without terminal tool records.
 */
export interface ConversationActionContinuationState extends RecentActionContinuationState {
  version: 1;
  latestInstruction: string;
  assistantState: string;
  toolSummaries: string[];
  updatedAt: string;
  evidenceMessageId?: string;
}

export interface ConversationActionContinuationUpdate {
  previous?: ConversationActionContinuationState | null;
  userText: string;
  assistantText: string;
  toolCalls: unknown;
  updatedAt?: string;
  evidenceMessageId?: string;
}

const ENGLISH_SHORT_CONTINUATION_RE =
  /^(?:(?:continue|resume|proceed)(?: this| that| it| the task)?|next(?: step)?|run it|execute it|start it|try again|retry|draw it|open it|save it|export it|send it|submit it|do it|(?:continue|run|execute|handle|do)(?: this| that| it| the task)? in (?:the )?background)[.!?]*$/i;

const ENGLISH_REFERENTIAL_ACTION_RE =
  /(?:according to|based on|use)(?: what is| what's)? (?:inside|above|before|previous|earlier)|(?:run|execute|open|process|draw|save|export|send|submit|continue) (?:it|that|this|the previous one)/i;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const CURRENT_APP_EDIT_RE =
  /(?:在|到|往)?\s*(?:这里面|这里|里面|这个软件里|这个应用里|当前软件里|当前应用里|当前窗口里|刚打开的里面|刚才打开的里面|刚打开的软件里|刚才打开的软件里).{0,96}(?:新建|创建|写|写入|输入|填写|编辑|粘贴|保存)|\b(?:create|write|type|paste|edit|save)\b.{0,80}\b(?:in|inside)\b.{0,32}\b(?:here|this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)?\b|\b(?:in|inside)\b.{0,32}\b(?:this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)\b.{0,80}\b(?:create|write|type|paste|edit|save)\b/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const CONCRETE_LOCAL_SOURCE_RE =
  /(?:[A-Za-z]:[\\/]|(?:桌面上?|本地|下载|文档|图片|图纸|文件夹).{0,24}(?:叫|名为|名称是|里的|中的).{1,36}|(?:named|called)\s+.{1,48}\s+(?:file|image|drawing|folder))/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const EXPLICIT_ACTION_TARGET_RE =
  /(?:打开|启动|运行|读取|查看|画|绘制|保存|导出|发送|提交|放到|导入|写入|\b(?:open|launch|run|read|inspect|draw|draft|save|export|send|submit|import|write)\b).{0,96}(?:AutoCAD|CAD|微信|WeChat|浏览器|browser|网站|文件|图片|图纸|文件夹)/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

function compact(value: unknown, limit = 700): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function recordRole(item: ActionContinuationHistoryItem): string {
  return String(item.role || item.type || '').toLowerCase();
}

function recordText(item: ActionContinuationHistoryItem): string {
  if (isGuardGeneratedConversationRecord(item)) return '';
  const role = recordRole(item);
  if (role === 'assistant' || role === 'agent') {
    return compact(item.response || item.message || item.content || item.text);
  }
  return compact(item.message || item.content || item.text || item.response);
}

function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let index = 0; index < 3 && typeof parsed === 'string'; index += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

function parseToolCalls(item: ActionContinuationHistoryItem): any[] {
  if (isGuardGeneratedConversationRecord(item)) return [];
  const parsed = parseNestedJson(item.toolCalls);
  return Array.isArray(parsed) ? parsed : [];
}

function collectPathValues(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 4 || paths.size >= 5 || value == null) return;
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value.trim())) paths.add(value.trim().slice(0, 500));
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach(item => collectPathValues(item, paths, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>)
      .slice(0, 24)
      .forEach(item => collectPathValues(item, paths, depth + 1));
  }
}

function toolCallName(call: any): string {
  return compact(call?.name || call?.toolName, 120);
}

function toolCallArguments(call: any): Record<string, any> {
  const parsed = parseNestedJson(call?.arguments ?? call?.args);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : {};
}

function toolCallResult(call: any): unknown {
  return parseNestedJson(call?.result);
}

function toolCallFailure(call: any): string {
  const name = toolCallName(call);
  const explicitError = compact(call?.error, 260);
  if (explicitError) return `${name || 'tool'}: ${explicitError}`;

  const result = toolCallResult(call);
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, any>
    : null;
  const verification = payload?.verification && typeof payload.verification === 'object'
    ? payload.verification as Record<string, any>
    : {};
  const status = compact(
    payload?.status
      || verification.status
      || call?.status,
    120,
  ).toLowerCase();
  const raw = compact(typeof result === 'string' ? result : JSON.stringify(result || ''), 320);
  const incompleteStatus = /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|incomplete|needs_confirmation|not_ready|partial|pending|queued|requires_confirmation|requires_setup|submitted_unverified|unverified)$/i;
  const structuredFailure = Boolean(payload && (
    payload.ok === false
    || payload.success === false
    || payload.failed === true
    || payload.completed === false
    || payload.verified === false
    || payload.completionMarkerExists === false
    || payload.requiresConfirmation === true
    || payload.confirmationRequired === true
    || incompleteStatus.test(status)
    || compact(payload.error || verification.error, 260)
  ));
  if (
    structuredFailure
    || incompleteStatus.test(status)
    || /requires? (?:user )?confirmation|timed out|permission denied|not allowed|outside (?:the )?allowed|forbidden|(?:^|\b)(?:failed|error|blocked)(?:\b|:)/i.test(raw)
  ) {
    const detail = compact(
      payload?.error
      || payload?.reason
      || payload?.blocker
      || verification.error
      || verification.reason
      || status
      || raw,
      320,
    );
    return `${name || 'tool'}: ${detail}`.slice(0, 380);
  }
  return '';
}

function toolCallSucceeded(call: any): boolean {
  if (!toolCallName(call) || toolCallFailure(call)) return false;
  const result = toolCallResult(call);
  if (result && typeof result === 'object') {
    if ((result as any).ok === false || (result as any).success === false) return false;
    const status = compact((result as any).status || (result as any)?.verification?.status, 80);
    if (/^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|incomplete|needs_confirmation|not_ready|partial|pending|queued|requires_confirmation|requires_setup|submitted_unverified|unverified)$/i.test(status)) return false;
    if ((result as any).ok === true || (result as any).success === true) return true;
    if (/^(?:ok|success|succeeded|completed|opened|verified|done)$/i.test(status)) return true;
  }
  return Boolean(compact(call?.result, 240));
}

function looksLikeApplicationTarget(value: string): boolean {
  const clean = compact(value, 500);
  if (!clean || /^https?:\/\//i.test(clean)) return false;
  if (/\.(?:png|jpe?g|gif|webp|bmp|pdf|docx?|xlsx?|pptx?|txt|md|csv|dxf|dwg|json)$/i.test(clean)) return false;
  return true;
}

function successfulApplicationTarget(call: any): string {
  if (!toolCallSucceeded(call)) return '';
  const name = toolCallName(call);
  const args = toolCallArguments(call);
  const result = toolCallResult(call);
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, any>
    : {};

  if (name === 'desktop_open' || /(?:wps|wechat|weixin|autocad|cad.*playback|computer_use)/i.test(name)) {
    const candidates = [
      args.appTarget,
      args.applicationTarget,
      args.target,
      payload.appTarget,
      payload.applicationTarget,
      payload.target,
      payload.resolvedTarget,
    ].map(value => compact(value, 500)).filter(Boolean);
    const explicitTarget = candidates.find(looksLikeApplicationTarget);
    if (explicitTarget) return explicitTarget;
  }

  const signature = [
    name,
    payload.processName,
    payload.applicationName,
    payload.appName,
    payload.windowTitle,
  ].map(value => compact(value, 180)).join(' ');
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:^|\b)(?:wps|wps\.exe|et\.exe|wpp\.exe)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu.test(signature)) return 'WPS';
  if (/(?:acad\.exe|\bAutoCAD\b|mcp_cad-drafting_autocad)/i.test(signature)) return 'AutoCAD';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:WeChat\.exe|Weixin\.exe|\bWeChat\b|微信)/iu.test(signature)) return 'WeChat';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:mspaint\.exe|Microsoft Paint|\bPaint\b|画图)/iu.test(signature)) return 'Paint';
  // i18n-allow: Process/window-name recognition; these strings are not user-visible copy.
  if (/(?:notepad\.exe|\bNotepad\b|记事本)/iu.test(signature)) return 'Notepad';
  return '';
}

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const STATUS_FOLLOWUP_RE =
  /^(?:在执行吗|有没有在执行(?:(?:这个|那个)?任务)?|执行了吗|做了吗|完成了吗|好了没|结果呢|怎么还没|(?:我问你)?(?:你)?为什么(?:没(?:有)?(?:完成|执行)|不(?:去)?执行)(?:[，,。！？?!\s]*(?:你)?为什么不(?:去)?执行)?|我刚刚给你了什么任务|我刚才给你的任务是什么|你在搞什么|你在干嘛|回答我)[啊呀吧嘛呢，,。！？?!]*$/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

const ENGLISH_STATUS_FOLLOWUP_RE =
  /^(?:are you (?:doing|running) it|did you do it|is it (?:done|running)|what(?:'s| is) the result|why (?:didn'?t|haven'?t) you|what was my task)[.!?]*$/i;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const STATUS_RESULT_DEMAND_RE =
  /^(?:\u6211\u8ba9\u4f60(?:\u5e2e\u6211)?(?:\u770b(?:\u4e0b|\u4e00\u4e0b|\u770b)?|\u67e5(?:\u4e0b|\u4e00\u4e0b)?).{0,16}\u684c\u9762(?:\u4e0a)?.{0,16}(?:\u591a\u5c11|\u51e0\u4e2a)(?:\u4e2a)?(?:\u8f6f\u4ef6|\u5e94\u7528).{0,20}(?:\u4f60\u5012\u662f)?(?:\u8ddf\u6211|\u7ed9\u6211)?\u8bf4(?:\u5440|\u554a|\u561b)?)[\u554a\u5440\u5427\u561b\u5462\uff0c,\u3002\uff01\uff1f?!]*$/iu;

export type RecentActionFollowupIntent = 'execute' | 'status' | 'none';

function currentTurnText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}

function recoveredStructuredState(text: string): string {
  const raw = String(text || '');
  const markerIndex = raw.search(/## Recent action continuation context\b/i);
  if (markerIndex < 0) return '';
  const context = raw.slice(markerIndex);
  const stateIndex = context.search(/Recovered structured action state:/i);
  if (stateIndex < 0) return '';
  return context
    .slice(stateIndex)
    .split(/\s+(?:Recent user task context|Recent Lumi execution state|Recent tool evidence|Rules):/i, 1)[0];
}

export function isCurrentAppEditingRequest(text: string): boolean {
  return CURRENT_APP_EDIT_RE.test(currentTurnText(text));
}

export function getRecoveredApplicationContinuationTarget(text: string): string {
  const state = recoveredStructuredState(text);
  if (!state) return '';
  const target = state.match(
    /(?:^|\s)- appTarget:\s*(.+?)(?=\s+- (?:sourcePaths|latestBlocker|unfinished):|\s+(?:Recent user task context|Recent Lumi execution state|Recent tool evidence|Rules):|$)/i,
  )?.[1] || '';
  return compact(target, 160);
}

export function isRecoveredCurrentAppEditingContinuation(text: string): boolean {
  const state = recoveredStructuredState(text);
  return Boolean(
    state
    && /(?:^|\s)- followupIntent:\s*execute(?=\s+- |$)/i.test(state)
    && getRecoveredApplicationContinuationTarget(text)
    && isCurrentAppEditingRequest(text),
  );
}

export function classifyRecentActionFollowupIntent(text: string): RecentActionFollowupIntent {
  const clean = compact(text, 500);
  if (!clean) return 'none';
  if (
    STATUS_FOLLOWUP_RE.test(clean)
    || STATUS_RESULT_DEMAND_RE.test(clean)
    || ENGLISH_STATUS_FOLLOWUP_RE.test(clean)
  ) return 'status';
  if (
    matchesCnActionContinuation(clean)
    || isCurrentAppEditingRequest(clean)
    || ENGLISH_SHORT_CONTINUATION_RE.test(clean)
    || ENGLISH_REFERENTIAL_ACTION_RE.test(clean)
  ) return 'execute';
  return 'none';
}

function isContinuationOrPressureText(text: string): boolean {
  return classifyRecentActionFollowupIntent(text) !== 'none';
}

function findTaskAnchorIndex(history: ActionContinuationHistoryItem[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (recordRole(history[index]) !== 'user') continue;
    const text = recordText(history[index]);
    if (text && !isContinuationOrPressureText(text)) return index;
  }

  // A complete task can still contain a referential pronoun (for example,
  // "read the desktop image and draw it in AutoCAD") and therefore look like
  // a continuation to the terse-language classifier. Recover that task only
  // when the same history contains a terminal tool receipt after it. This
  // preserves evidence-backed CAD/status continuity without promoting an
  // ordinary reflective chat followed by "continue" into executable work.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (recordRole(history[index]) !== 'user') continue;
    const text = recordText(history[index]);
    if (!text || !isActionBearingGoal(text)) continue;
    const hasTerminalEvidence = history.slice(index + 1).some(item =>
      parseToolCalls(item).some(call => Boolean(
        toolCallName(call)
        && (toolCallFailure(call) || compact(call?.result, 240)),
      )),
    );
    if (hasTerminalEvidence) return index;
  }
  return -1;
}

function isActionBearingGoal(goal: string): boolean {
  const contract = buildActionContract(goal);
  return contract.applies && contract.kind !== 'none';
}

export function extractRecentActionContinuationState(
  history: ActionContinuationHistoryItem[] | undefined,
): RecentActionContinuationState {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      goal: '',
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: false,
      evidenceTools: [],
    };
  }

  const anchorIndex = findTaskAnchorIndex(history);
  const relevant = anchorIndex >= 0 ? history.slice(anchorIndex) : history.slice(-12);
  const goal = anchorIndex >= 0 ? recordText(history[anchorIndex]) : '';
  const sourcePaths = new Set<string>();
  const evidenceTools: string[] = [];
  let appTarget = '';
  let latestBlocker = '';

  for (const item of relevant) {
    for (const call of parseToolCalls(item)) {
      const name = toolCallName(call);
      if (name) evidenceTools.push(name);
      collectPathValues(toolCallArguments(call), sourcePaths);
      collectPathValues(toolCallResult(call), sourcePaths);
      const openedTarget = successfulApplicationTarget(call);
      if (openedTarget) appTarget = openedTarget;
      const failure = toolCallFailure(call);
      if (failure) latestBlocker = failure;
    }
  }

  const assistantState = relevant
    .filter(item => ['assistant', 'agent'].includes(recordRole(item)))
    .map(recordText)
    .join('\n');
  // i18n-allow: Chinese execution-state recognition; not user-visible copy.
  const unfinished = Boolean(
    latestBlocker
    || /(?:还没|没有|未)(?:完成|执行|开始|画|写|保存)|(?:失败|受阻|阻塞|等待确认|没有真正)|not (?:completed|done|executed)|incomplete|blocked|failed/i.test(assistantState), // i18n-allow: Chinese execution-state recognition; not user-visible copy.
  );

  return {
    goal,
    appTarget,
    sourcePaths: Array.from(sourcePaths).slice(0, 8),
    latestBlocker,
    unfinished,
    evidenceTools: Array.from(new Set(evidenceTools)).slice(-10),
  };
}

function summarizeToolCalls(history: ActionContinuationHistoryItem[]): string[] {
  const summaries: string[] = [];
  for (const item of history.slice(-12)) {
    for (const call of parseToolCalls(item).slice(-10)) {
      const name = toolCallName(call);
      if (!name) continue;
      const result = toolCallResult(call);
      const status = compact(call?.error || (result as any)?.status || call?.status || '', 120);
      const paths = new Set<string>();
      collectPathValues(toolCallArguments(call), paths);
      collectPathValues(result, paths);
      const resultEvidence = Array.isArray(result)
        ? [
            `items=${result.length}`,
            result.length
              ? `sample=${result.slice(0, 5)
                  .map(entry => compact(
                    (entry as any)?.label
                      || (entry as any)?.name
                      || (entry as any)?.appName
                      || (entry as any)?.title,
                    80,
                  ))
                  .filter(Boolean)
                  .join(' | ')}`
              : '',
          ].filter(Boolean).join(' | ')
        : '';
      summaries.push([
        name,
        status ? `status=${status}` : '',
        paths.size ? `paths=${Array.from(paths).slice(0, 3).join(' | ')}` : '',
        resultEvidence,
      ].filter(Boolean).join(' | '));
    }
  }
  return Array.from(new Set(summaries)).slice(-10);
}

function normalizeConversationActionState(
  value: ConversationActionContinuationState | null | undefined,
): ConversationActionContinuationState | null {
  if (!value || typeof value !== 'object') return null;
  const goal = compact(value.goal, 700);
  if (!goal) return null;
  return {
    version: 1,
    goal,
    latestInstruction: compact(value.latestInstruction || goal, 700),
    appTarget: compact(value.appTarget, 160),
    sourcePaths: Array.from(new Set(Array.isArray(value.sourcePaths) ? value.sourcePaths : []))
      .map(path => compact(path, 500))
      .filter(Boolean)
      .slice(0, 8),
    latestBlocker: compact(value.latestBlocker, 380),
    unfinished: Boolean(value.unfinished),
    evidenceTools: Array.from(new Set(Array.isArray(value.evidenceTools) ? value.evidenceTools : []))
      .map(name => compact(name, 120))
      .filter(Boolean)
      .slice(-10),
    assistantState: compact(value.assistantState, 700),
    toolSummaries: Array.from(new Set(Array.isArray(value.toolSummaries) ? value.toolSummaries : []))
      .map(summary => compact(summary, 700))
      .filter(Boolean)
      .slice(-10),
    updatedAt: compact(value.updatedAt, 80) || new Date(0).toISOString(),
    evidenceMessageId: compact(value.evidenceMessageId, 160) || undefined,
  };
}

/**
 * Advance the durable conversation pointer from terminal tool evidence.
 * Referential/status turns inherit the original target; a concrete new turn
 * starts a fresh pointer and cannot accidentally absorb an older task.
 */
export function buildConversationActionContinuationState(
  input: ConversationActionContinuationUpdate,
): ConversationActionContinuationState | null {
  const userText = compact(input.userText, 700);
  const assistantText = compact(input.assistantText, 700);
  const calls = parseToolCalls({ toolCalls: input.toolCalls })
    .filter(call => toolCallName(call) && (toolCallFailure(call) || compact(call?.result, 240)));
  if (!userText || calls.length === 0) return null;

  const previous = normalizeConversationActionState(input.previous);
  const followupIntent = classifyRecentActionFollowupIntent(userText);
  const inheritsPrevious = followupIntent !== 'none' && Boolean(previous);
  const currentHistory: ActionContinuationHistoryItem[] = [
    { role: 'user', message: userText },
    { role: 'assistant', message: assistantText, toolCalls: calls },
  ];
  const current = extractRecentActionContinuationState(currentHistory);
  const currentSummaries = summarizeToolCalls(currentHistory);
  const hasFailure = Boolean(current.latestBlocker);
  const hasSuccess = calls.some(toolCallSucceeded);
  const preserveStatusBlocker = followupIntent === 'status' && Boolean(previous?.latestBlocker);

  return normalizeConversationActionState({
    version: 1,
    goal: inheritsPrevious ? previous!.goal : userText,
    latestInstruction: followupIntent === 'status' && previous
      ? previous.latestInstruction
      : userText,
    appTarget: current.appTarget || (inheritsPrevious ? previous!.appTarget : ''),
    sourcePaths: Array.from(new Set([
      ...(inheritsPrevious ? previous!.sourcePaths : []),
      ...current.sourcePaths,
    ])).slice(0, 8),
    latestBlocker: current.latestBlocker
      || (preserveStatusBlocker ? previous!.latestBlocker : ''),
    unfinished: hasFailure
      || (followupIntent === 'status' && Boolean(previous?.unfinished))
      || (!hasSuccess && current.unfinished),
    evidenceTools: Array.from(new Set([
      ...(inheritsPrevious ? previous!.evidenceTools : []),
      ...current.evidenceTools,
    ])).slice(-10),
    assistantState: assistantText,
    toolSummaries: Array.from(new Set([
      ...(inheritsPrevious ? previous!.toolSummaries : []),
      ...currentSummaries,
    ])).slice(-10),
    updatedAt: input.updatedAt || new Date().toISOString(),
    evidenceMessageId: input.evidenceMessageId,
  });
}

export function needsRecentActionContinuationContext(userText: string): boolean {
  const clean = compact(userText, 500);
  if (!clean || (clean.length > 180 && !isCurrentAppEditingRequest(clean))) return false;
  // A complete instruction can contain a pronoun ("把它画到 CAD 里") while
  // still naming its source and destination in the same sentence. Do not let
  // an older task overwrite that self-contained command.
  if (CONCRETE_LOCAL_SOURCE_RE.test(clean) && EXPLICIT_ACTION_TARGET_RE.test(clean)) return false;
  return classifyRecentActionFollowupIntent(clean) !== 'none';
}

/**
 * Resolve a terse, explicit open instruction from the durable receipt-backed
 * continuation state. This keeps "open it" deterministic without asking a
 * model to guess which earlier website or app the pronoun referred to.
 */
export function resolveRecentActionOpenTarget(
  userText: string,
  persistedState?: ConversationActionContinuationState | null,
): string | null {
  const clean = compact(userText, 120)
    .replace(/[。！？.!?]+$/u, '')
    .trim();
  const state = normalizeConversationActionState(persistedState);
  if (!clean || !state?.sourcePaths.length) return null;
  const explicitReferentialOpen = /^(?:请|麻烦)?(?:你)?(?:现在)?(?:直接)?(?:把)?(?:它|这个|那个|这个文件|那个文件|这个文档|那个文档|刚才的文件|刚生成的文件)?(?:给我)?打开(?:一下)?$/u.test(clean) // i18n-allow: Chinese referential-open recognition; not user-visible copy.
    || /^(?:please\s+)?(?:just\s+)?open\s+(?:it|that|this|the\s+file|the\s+document)$/i.test(clean);
  if (!explicitReferentialOpen) return null;
  return [...state.sourcePaths].reverse().find(Boolean) || null;
}

export function buildRecentActionContinuationBridge(
  userText: string,
  history: ActionContinuationHistoryItem[] | undefined,
  persistedState?: ConversationActionContinuationState | null,
): string {
  const durableState = normalizeConversationActionState(persistedState);
  if (
    !needsRecentActionContinuationContext(userText)
    || ((!Array.isArray(history) || history.length === 0) && !durableState)
  ) {
    return '';
  }

  const currentText = compact(userText, 700);
  const followupIntent = classifyRecentActionFollowupIntent(currentText);
  const recent = (Array.isArray(history) ? history : [])
    .slice(-18)
    .filter(item => ['user', 'assistant', 'agent'].includes(recordRole(item)) && recordText(item))
    .filter(item => !(recordRole(item) === 'user' && recordText(item) === currentText));
  const deduplicate = (items: ActionContinuationHistoryItem[]) => items.filter((item, index, candidates) => {
    const roleGroup = recordRole(item) === 'user' ? 'user' : 'assistant';
    const key = `${roleGroup}:${recordText(item)}`;
    return candidates.findIndex(candidate => {
      const candidateRoleGroup = recordRole(candidate) === 'user' ? 'user' : 'assistant';
      return `${candidateRoleGroup}:${recordText(candidate)}` === key;
    }) === index;
  });
  const anchorIndex = findTaskAnchorIndex(recent);
  const executionTail = anchorIndex >= 0 ? recent.slice(anchorIndex) : recent;
  const relevantDeduplicated = deduplicate(executionTail);
  const userTurns = relevantDeduplicated
    .filter(item => recordRole(item) === 'user')
    .map(recordText)
    .slice(-4);
  const assistantTurns = relevantDeduplicated
    .filter(item => ['assistant', 'agent'].includes(recordRole(item)))
    .map(recordText)
    .slice(-3);
  const toolSummaries = durableState?.toolSummaries.length
    ? durableState.toolSummaries
    : summarizeToolCalls(executionTail);
  const state = durableState || extractRecentActionContinuationState(executionTail);

  // A terse conversational follow-up must not promote an ordinary prior
  // exchange into executable work. Guard output is excluded above, and a
  // history-only bridge is allowed only when its actual user goal carries an
  // external-action contract. Durable state remains safe because it can only
  // be created from terminal tool evidence.
  if (!durableState && !isActionBearingGoal(state.goal)) return '';

  if (
    userTurns.length === 0
    && assistantTurns.length === 0
    && toolSummaries.length === 0
    && !durableState
  ) return '';

  return [
    '## Recent action continuation context',
    'The current message is referential or underspecified. Resolve it against the recent task below before routing, delegating, or choosing tools.',
    'Recovered structured action state:',
    `- followupIntent: ${followupIntent}`,
    state.goal ? `- originalGoal: ${state.goal}` : '',
    durableState?.latestInstruction ? `- latestInstruction: ${durableState.latestInstruction}` : '',
    state.appTarget ? `- appTarget: ${state.appTarget}` : '',
    state.sourcePaths.length ? `- sourcePaths: ${state.sourcePaths.join(' | ')}` : '',
    state.latestBlocker ? `- latestBlocker: ${state.latestBlocker}` : '',
    `- unfinished: ${state.unfinished ? 'yes' : 'no'}`,
    durableState?.updatedAt ? `- stateUpdatedAt: ${durableState.updatedAt}` : '',
    userTurns.length ? 'Recent user task context:' : '',
    ...userTurns.map(turn => `- ${turn}`),
    assistantTurns.length ? 'Recent Lumi execution state:' : '',
    ...assistantTurns.map(turn => `- ${turn}`),
    toolSummaries.length ? 'Recent tool evidence:' : '',
    ...toolSummaries.map(summary => `- ${summary}`),
    'Rules:',
    '- Continue the same target, application, files, and acceptance criteria unless the user clearly starts a new task.',
    // i18n-allow: Quoted Chinese phrases are input examples inside an internal routing prompt.
    '- appTarget is recovered only from a successful desktop_open receipt. For wording like "在这里面 / 这个软件里 / 刚打开的里面", continue inside that application with active-window and UI typing/control tools.',
    '- This is conversation-scoped persisted execution state, not a task-center record. Do not route to work_takeover/task-center tools unless the evidence above explicitly contains a work_takeover tool or task id.',
    '- Do not reinterpret an underspecified verb such as draw, run, send, open, or continue into another domain.',
    '- Preparation is not completion. Preserve the latest blocker and require evidence for the original task contract.',
    '- Historical attachments are not current inputs; reuse only explicit local paths or artifacts shown in this context.',
  ].filter(Boolean).join('\n');
}
