import { randomUUID } from 'node:crypto';
import {
  hasMixedStatusExecutionIntent,
  isImmediateAssistantRestatementRequest,
  normalizeActionIntent,
} from './normalized_action_intent';
import { matchesCnActionContinuation } from '../regions/packs/cn/action_continuation';
import {
  CN_TASK_EXECUTION_MESSAGES,
  formatCnToolFailureDetail,
} from '../regions/packs/cn/voice_fast_path_messages';
import { isGuardGeneratedConversationRecord } from '../conversation/guard_history';
import { findLatestRepeatableAssistantReply } from '../conversation/assistant_restatement';
import {
  buildActionContract,
  buildActionEvidenceContract,
  requestedMediaPlayerTarget,
  requiresMediaPlaybackAction,
} from './action_contract';
import type { ToolPolicy } from '../personality/types';
import { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
import { isExplicitConfirmationReply } from '../tools/pending_confirmation';
import {
  coalesceToolExecutionRecords,
  applyTaskPolicySnapshot,
  CONVERSATION_TASK_STATUSES,
  conversationTaskStatusOwnsExecutionLease,
  isTerminalConversationTaskStatus,
  mergeTaskReceipts,
  normalizeConversationTaskReceipt,
  snapshotTaskPolicy,
  taskCompletionFromReceipts,
  toolRecordSucceeded,
  type ConversationTaskPolicySnapshot,
  type ConversationTaskReceipt,
  type ConversationTaskStatus,
} from './task_execution_ledger';
import {
  buildTaskCapsuleV1,
  formatTaskCapsuleForPrompt,
  isTaskCapsuleTargetContinuation,
  normalizeTaskCapsuleV1,
  type TaskCapsuleV1,
} from '../conversation/task_capsule';
import { isUnconfirmedRuntimeCandidate } from '../conversation/task_target_anchor';
import {
  parseNestedJson,
  toolRecordHasTerminalPayload,
  toolRecordTerminalPayload,
} from '../tools/receipt_payload';
import type { ToolExecutionRecord } from '../tools/types';

export interface ActionContinuationHistoryItem {
  role?: string;
  type?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
  toolCalls?: unknown;
  cognitiveIntent?: string;
  timestamp?: string;
  receivedAt?: string;
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
  version: 1 | 2;
  /** Stable identity shared by every turn that advances the same task. */
  taskId?: string;
  status?: ConversationTaskStatus;
  /** Capability envelope selected from the original complete instruction. */
  policySnapshot?: ConversationTaskPolicySnapshot;
  /** Coalesced terminal receipts. A successful retry supersedes its failure. */
  receipts?: ConversationTaskReceipt[];
  activeRequestId?: string;
  supersededTaskId?: string;
  revision?: number;
  latestInstruction: string;
  /** Persisted user message id, falling back to the owning request id. */
  latestInstructionRef?: string;
  assistantState: string;
  toolSummaries: string[];
  /** Durable semantic projection shared by chat, voice, and restart hydration. */
  taskCapsule?: TaskCapsuleV1;
  updatedAt: string;
  evidenceMessageId?: string;
  completionSource?: 'tool_receipt' | 'user_observation';
  /**
   * A terminal projection was staged in memory, but its strict persistence
   * fence failed.  Keep this marker with the resumable task so restart
   * hydration cannot turn the staged success back into an authoritative one.
   */
  terminalPersistence?: {
    status: 'persistence_unknown';
    requestId: string;
    quarantinedAt: string;
  };
}

export interface PendingRuntimeCancellationRecheck {
  taskId: string;
  taskIds: string[];
  priorReceiptId: string;
  priorStatus: 'cancelling';
}

export interface ConversationActionContinuationUpdate {
  previous?: ConversationActionContinuationState | null;
  userText: string;
  assistantText: string;
  toolCalls: unknown;
  updatedAt?: string;
  evidenceMessageId?: string;
  /** Exact persisted user message that supplied userText, when available. */
  userMessageId?: string;
  requestId?: string;
  toolPolicy?: ToolPolicy;
}

export type ToolRecordTaskDurability = 'observation_only' | 'durable' | 'unknown';

/**
 * Durable conversation state follows the capability contract selected by the
 * model, not the wording or name of a tool. Pure reads remain ordinary turn
 * evidence; mutations and any persistent/external side effect may own a task
 * pointer. Legacy records without a capability snapshot stay unknown so a
 * migration caller can handle them explicitly.
 */
export function classifyToolRecordTaskDurability(
  record: Pick<import('../tools/types').ToolExecutionRecord, 'capability'>,
): ToolRecordTaskDurability {
  const capability = record?.capability;
  if (!capability || !Array.isArray(capability.sideEffects)) return 'unknown';
  const safeObservationEffects = capability.sideEffects.every(effect => (
    effect.type === 'none'
    || effect.type === 'local_read'
    || effect.type === 'network_read'
  ));
  if (
    (capability.operation === 'observe' || capability.operation === 'test')
    && safeObservationEffects
  ) return 'observation_only';
  if (
    capability.operation === 'mutate'
    || capability.operation === 'create'
    || capability.operation === 'communicate'
    || !safeObservationEffects
  ) return 'durable';
  return 'unknown';
}

const ENGLISH_SHORT_CONTINUATION_RE =
  /^(?:(?:continue|resume|proceed)(?: this| that| it| the task)?|next(?: step)?|run it|execute it|start it|try again|retry|draw it|open it|save it|export it|send it|submit it|do it|(?:continue|run|execute|handle|do)(?: this| that| it| the task)? in (?:the )?background)[.!?]*$/i;

const ENGLISH_REFERENTIAL_ACTION_RE =
  /(?:according to|based on|use)(?: what is| what's)? (?:inside|above|before|previous|earlier)|(?:run|execute|open|process|draw|save|export|send|submit|continue) (?:it|that|this|the previous one)/i;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const CURRENT_APP_EDIT_RE =
  /(?:在|到|往)?\s*(?:这里面|这里|里面|这个软件里|这个应用里|当前软件里|当前应用里|当前窗口里|刚打开的里面|刚才打开的里面|刚打开的软件里|刚才打开的软件里).{0,96}(?:新建|创建|写|写入|输入|填写|编辑|粘贴|保存)|\b(?:create|write|type|paste|edit|save)\b.{0,80}\b(?:in|inside)\b.{0,32}\b(?:here|this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)?\b|\b(?:in|inside)\b.{0,32}\b(?:this|that|the current|the opened)\b.{0,16}\b(?:app|application|document|window)\b.{0,80}\b(?:create|write|type|paste|edit|save)\b/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

const CURRENT_APP_WINDOW_ACTION_RE =
  /(?:\u6700\u5927\u5316|\u6700\u5c0f\u5316|\u8fd8\u539f\u7a97\u53e3|\u6062\u590d\u7a97\u53e3|\u6536\u5230\u4efb\u52a1\u680f|\u94fa\u6ee1\u5c4f\u5e55)|\b(?:maximi[sz]e|minimi[sz]e|restore)\b.{0,12}\b(?:it|that|this|window|app|application)?\b/iu;

const CURRENT_APP_DOCUMENT_CREATE_RE =
  /^(?:\u65b0\u5efa|\u521b\u5efa)(?:(?:\u4e00\u4e2a|\u4e00\u4efd|\u4e00\u9875|\u6211\u7684|\u65b0\u7684?)\s*)?(?:\u7a7a\u767d)?(?:Word|WPS)?(?:\u6587\u6863|\u9875\u9762|\u8868\u683c|\u6f14\u793a\u6587\u7a3f)|^(?:new|create)(?:\s+(?:a|my|the))?\s+(?:blank\s+)?(?:document|page|workbook|presentation)$/iu;

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const CONCRETE_LOCAL_SOURCE_RE =
  /(?:[A-Za-z]:[\\/]|(?:桌面上?|本地|下载|文档|图片|图纸|文件夹).{0,24}(?:叫|名为|名称是|里的|中的).{1,36}|(?:named|called)\s+.{1,48}\s+(?:file|image|drawing|folder))/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const EXPLICIT_ACTION_TARGET_RE =
  /(?:打开|启动|运行|读取|查看|画|绘制|保存|导出|发送|提交|放到|导入|写入|\b(?:open|launch|run|read|inspect|draw|draft|save|export|send|submit|import|write)\b).{0,96}(?:AutoCAD|CAD|微信|WeChat|浏览器|browser|网站|文件|图片|图纸|文件夹)/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

const REFERENTIAL_CONTEXT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function recordTimestamp(item: ActionContinuationHistoryItem): number | null {
  const value = String(item.timestamp || item.receivedAt || '').trim();
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function explicitDurableTaskReference(text: string): boolean {
  // i18n-allow: Reviewed multilingual durable-task reference recognition; not user-visible copy.
  return /(?:这个|那个|之前|昨天|上次|未完成|原来|刚才).{0,12}(?:任务|工作|操作)|(?:任务|工作).{0,12}(?:继续|执行|状态|进度)|AutoCAD|\bCAD\b|图纸|平面图|WPS|Word|Excel|PowerPoint|微信|WeChat/iu.test(text);
}

function compact(value: unknown, limit = 700): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function compactAssistantState(value: unknown, status: ConversationTaskStatus): string {
  const exact = String(value || '').trim();
  // A bounded confirmation request is itself the user-visible authorization
  // boundary. Preserve its line structure so the durable pending checkpoint
  // can be byte-for-byte identical to the Socket terminal and transcript.
  // Oversized/untrusted state keeps the ordinary compact projection.
  if (status === 'waiting_confirmation' && exact.length <= 700) return exact;
  return compact(exact, 700);
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

function resultCarriesDirectSourcePath(toolName: string): boolean {
  return !/^(?:desktop_list_files|desktop_list_apps|desktop_running_processes)$/i.test(toolName);
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
  return toolRecordTerminalPayload({
    receipt: call?.receipt,
    result: call?.result,
  });
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
      || payload?.verificationStatus
      || verification.status
      || call?.status,
    120,
  ).toLowerCase();
  const raw = compact(typeof result === 'string' ? result : JSON.stringify(result || ''), 320);
  const incompleteStatus = /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|incomplete|needs_confirmation|not_ready|partial|pending|queued|requires_confirmation|requires_setup|submitted_unverified|unverified)$/i;
  const structuredFailure = Boolean(payload && (
    payload.ok === false
    || payload.success === false
    || payload.sent === false
    || payload.opened === false
    || payload.saved === false
    || payload.targetMatched === false
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
      || payload?.verificationReason
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
  const name = toolCallName(call);
  if (!name) return false;
  const result = typeof call?.result === 'string'
    ? call.result
    : JSON.stringify(call?.result ?? '');
  return toolRecordSucceeded({
    id: compact(call?.id, 180),
    name,
    arguments: toolCallArguments(call),
    result,
    ...(call?.receipt !== undefined ? { receipt: call.receipt } : {}),
    error: compact(call?.error, 700) || undefined,
    ...(call?.terminalVerification && typeof call.terminalVerification === 'object'
      ? { terminalVerification: call.terminalVerification }
      : {}),
    ...(call?.capability && typeof call.capability === 'object'
      ? { capability: call.capability }
      : {}),
  } as ToolExecutionRecord);
}

function normalizeApplicationTarget(value: unknown): string {
  return compact(value, 500)
    .replace(/[\s。！？.!?，,；;：:、]+$/gu, '')
    .trim();
}

function looksLikeApplicationTarget(value: string): boolean {
  const clean = normalizeApplicationTarget(value);
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
    ].map(normalizeApplicationTarget).filter(Boolean);
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
  /^(?:在执行吗|有没有在执行(?:(?:这个|那个)?任务)?|执行了吗|做了吗|完成了吗|好了没|结果呢|怎么样了|怎么还没|为什么(?:会)?失败|怎么(?:会)?失败|失败(?:在)?哪里|(?:我问你)?(?:你)?为什么(?:没(?:有)?(?:完成|执行)|不(?:去)?执行)(?:[，,。！？?!\s]*(?:你)?为什么不(?:去)?执行)?|我刚刚给你了什么任务|我刚才给你的任务是什么|你在搞什么|你在干嘛|你在干啥|回答我)[啊呀吧嘛呢，,。！？?!]*$/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const CN_SHORT_EXECUTION_CONTINUATION_RE =
  /^(?:确认(?:了)?|确定(?:了)?|继续|继续执行|接着做|执行|开始|开始执行|重试|再试|再来一次|建立|创建|打开|保存|发送|提交|就这么做|按这个做|做吧|弄吧)[。！？.!?]*$/u; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

const ENGLISH_STATUS_FOLLOWUP_RE =
  /^(?:are you (?:doing|running) it|did you do it|is it (?:done|running)|what(?:'s| is) the result|why (?:didn'?t|haven'?t) you|what was my task)[.!?]*$/i;

const MIXED_STATUS_QUESTION_RE =
  /(?:\u5b8c\u6210|\u505a\u5b8c|\u6267\u884c\u5b8c)(?:\u4e86)?(?:\u5417|\u6ca1|\u4e86\u6ca1).*[\uff1f?].*(?:\u7ee7\u7eed|\u63a5\u7740|\u6062\u590d|\u91cd\u8bd5|\u6267\u884c|\u63a8\u8fdb)(?:\u6267\u884c|\u5904\u7406|\u4efb\u52a1)?(?:\u4e86)?(?:\u5417|\u6ca1|\u6ca1\u6709|\u5462)?[\uff1f?]\s*$|\b(?:is|was|has)\b.{0,28}\b(?:done|complete|completed|finished)\b.*\?\s*(?:(?:are|did|will)\s+you\s+)?(?:continue|continuing|resume|retry|execute|executing|run|running)(?:\s+(?:it|this|that|the\s+task|executing))?\s*\?\s*$/iu;

// A short failure question becomes task status only while a durable task is
// unfinished. The state check prevents stale completed work from hijacking
// an unrelated conversational question.
// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const AMBIGUOUS_UNFINISHED_TASK_STATUS_RE =
  /^(?:怎么回事|什么情况|出什么问题了|哪里(?:出|有)问题了|卡在哪(?:里)?|为什么(?:停了|没继续|没完成|没做完)|what happened|what went wrong|where (?:is|was) it blocked)[啊呀吧嘛呢，,。！？?!\s]*$/iu; // i18n-allow: Chinese input-recognition pattern; not user-visible copy.

// A terse negative observation such as "还没播放" is not merely a request to
// read status. While the matching durable task is unfinished it corrects the
// result of that same action and authorizes another attempt under the existing
// task id. Matching the verb back to the original goal prevents an unrelated
// blocked task from capturing the utterance.
const NEGATIVE_RESULT_CORRECTION_RE = /^(?:(?:(?:\u8fd8|\u4ecd\u7136|\u4f9d\u7136|\u8fd8\u662f)\s*)?\u6ca1(?:\u6709)?|\u5e76\u672a|\u672a\u80fd)\s*(?:\u6210\u529f\s*)?(\u64ad\u653e|\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u4fdd\u5b58|\u521b\u5efa|\u751f\u6210|\u5199\u5165|\u53d1\u9001|\u5173\u95ed|\u5220\u9664)(?:\u51fa\u6765|\u6210\u529f|\u5b8c\u6210)?[\u3002\uff01!\s]*$|^(?:it\s+)?(?:still\s+)?(?:hasn['\u2019]?t|isn['\u2019]?t|didn['\u2019]?t|not)\s+(play(?:ing|ed)?|open(?:ing|ed)?|start(?:ing|ed)?|run(?:ning)?|sav(?:e|ed|ing)|creat(?:e|ed|ing)|generat(?:e|ed|ing)|writ(?:e|ten|ing)|send(?:ing)?|sent|clos(?:e|ed|ing)|delet(?:e|ed|ing))[.!\s]*$/iu;

function isNegativeResultCorrectionForTask(
  text: string,
  state: ConversationActionContinuationState | null | undefined,
): boolean {
  const durableState = normalizeConversationActionState(state);
  if (!durableState?.unfinished) return false;
  const match = compact(text, 240).match(NEGATIVE_RESULT_CORRECTION_RE);
  const operation = compact(match?.[1] || match?.[2], 40).toLowerCase();
  if (!operation) return false;
  const goal = `${durableState.goal} ${durableState.latestInstruction}`;
  if (/^(?:\u64ad\u653e|play)/iu.test(operation)) {
    return /(?:\u64ad\u653e|\u97f3\u4e50|\u6b4c\u66f2|\u6b4c|\u7f51\u6613\u4e91|QQ\s*\u97f3\u4e50|Spotify|\bplay\b|\bmusic\b|\bsong\b)/iu.test(goal);
  }
  const operationFamilies: Array<[RegExp, RegExp]> = [
    [/^(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|open|start|run)/iu, /(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\bopen\b|\bstart\b|\brun\b)/iu],
    [/^(?:\u4fdd\u5b58|save)/iu, /(?:\u4fdd\u5b58|\bsav(?:e|ed|ing)\b)/iu],
    [/^(?:\u521b\u5efa|\u751f\u6210|\u5199\u5165|creat|generat|writ)/iu, /(?:\u521b\u5efa|\u751f\u6210|\u5199\u5165|\bcreat|\bgenerat|\bwrit)/iu],
    [/^(?:\u53d1\u9001|send|sent)/iu, /(?:\u53d1\u9001|\bsend\b|\bsent\b)/iu],
    [/^(?:\u5173\u95ed|close)/iu, /(?:\u5173\u95ed|\bclos(?:e|ed|ing)\b)/iu],
    [/^(?:\u5220\u9664|delet)/iu, /(?:\u5220\u9664|\bdelet(?:e|ed|ing)\b)/iu],
  ];
  const family = operationFamilies.find(([operationPattern]) => operationPattern.test(operation));
  return Boolean(family?.[1].test(goal));
}

// A user may satisfy the exact condition Lumi just asked for outside the
// client (for example by foregrounding WPS), then report only that readiness
// fact. These acknowledgements are executable continuation only while the
// durable task is blocked; without that state they remain ordinary dialogue.
// i18n-allow: Multilingual blocked-task readiness acknowledgement recognition; not user-visible copy.
const BLOCKED_TASK_READINESS_RE =
  /^(?:(?:(?:已经|已|现在|刚才|刚刚)\s*)?(?:把|将)?(?:它|这个|那个|文件|文档|窗口|应用|软件)?\s*(?:切换|切|换|放|调)\s*(?:到|至)?\s*(?:前台|当前窗口)(?:了)?|(?:已经|已|现在)\s*(?:打开|开启)(?:了|好了)?|(?:已经)?\s*(?:准备好|准备就绪)(?:了)?|(?:it(?:'s| is)\s+)?(?:in (?:the )?foreground|open|ready)(?:\s+now)?|ready\s+to\s+continue)[\s啊呀啦吧呢，,。！!]*$/iu;

// A bare acknowledgement is ambiguous by itself. It becomes executable only
// when the exact blocked task's last assistant state explicitly asked the
// user to prepare/foreground something and report back. This keeps “可以” from
// becoming a new durable task while preventing it from authorizing an
// unrelated or reconstructed confirmation boundary.
const BARE_BLOCKED_TASK_READINESS_RE =
  // i18n-allow: Reviewed multilingual readiness acknowledgement recognition; not user-visible copy.
  /^(?:可以|可以了|行|好|好了|已好|就绪|ok(?:ay)?|done|ready)[\s啊呀啦吧呢，,。！!]*$/iu;
const ASSISTANT_REQUESTED_READINESS_RE =
  // i18n-allow: Reviewed multilingual assistant readiness-request recognition; not user-visible copy.
  /(?:请|麻烦|一旦|当|等|完成后|准备好后|切到前台后)[^。！？.!?\n]{0,120}(?:告诉我|跟我说|说一声|回复我|回我|通知我)|(?:请|麻烦)[^。！？.!?\n]{0,120}(?:切到|切换到|打开|前台|准备好|发给我)|\b(?:tell|let)\s+me\s+(?:know|when|once)\b[^.!?\n]{0,80}\b(?:ready|foreground|open|done)\b|\b(?:please\s+)?(?:put|bring|switch|open)\b[^.!?\n]{0,80}\b(?:foreground|open|ready)\b|\b(?:reply|say)\b[^.!?\n]{0,80}\b(?:ready|foreground|open|done)\b/iu;

function isBlockedTaskReadinessAcknowledgement(
  text: string,
  state: ConversationActionContinuationState | null | undefined,
): boolean {
  const durableState = normalizeConversationActionState(state);
  if (!durableState?.unfinished || durableState.status !== 'blocked') return false;
  const assistantState = durableState.assistantState || '';
  if (!ASSISTANT_REQUESTED_READINESS_RE.test(assistantState)) return false;
  // A request to attach/send a file is not satisfied by a textual "ready".
  // The attachment pipeline must provide its own current-turn evidence. A
  // mixed alternative that also asks the user to foreground/open something
  // may still resume through that explicitly requested readiness condition.
  // i18n-allow: Reviewed multilingual attachment-only readiness recognition; not user-visible copy.
  const attachmentHandoffRequested = /(?:\u53d1\u7ed9\u6211|\u628a[^\n\u3002\uff01\uff1f]{0,48}\u6587\u4ef6[^\n\u3002\uff01\uff1f]{0,24}\u53d1\u6765)|\b(?:send|attach|upload)\b[^.!?\n]{0,80}\b(?:file|document|attachment)\b/iu.test(assistantState);
  // i18n-allow: Reviewed multilingual foreground/open readiness recognition; not user-visible copy.
  const foregroundOrOpenRequested = /(?:\u5207\u5230|\u5207\u6362\u5230|\u524d\u53f0|\u6253\u5f00|\u51c6\u5907\u597d)|\b(?:foreground|open|ready)\b/iu.test(assistantState);
  if (attachmentHandoffRequested && !foregroundOrOpenRequested) return false;
  return BLOCKED_TASK_READINESS_RE.test(text)
    || BARE_BLOCKED_TASK_READINESS_RE.test(text);
}

function normalizeMediaTarget(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isMediaPlaybackContinuationForTask(
  text: string,
  state: ConversationActionContinuationState | null | undefined,
): boolean {
  const durableState = normalizeConversationActionState(state);
  if (
    !durableState?.unfinished
    || !requiresMediaPlaybackAction(durableState.goal)
    || !requiresMediaPlaybackAction(text)
  ) return false;
  const previousTarget = normalizeMediaTarget(requestedMediaPlayerTarget(durableState.goal));
  const currentTarget = normalizeMediaTarget(requestedMediaPlayerTarget(text));
  // An explicitly different player is new work; an omitted/deictic target
  // continues the exact unfinished playback goal.
  return !previousTarget || !currentTarget
    || previousTarget.includes(currentTarget)
    || currentTarget.includes(previousTarget);
}

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.
const STATUS_RESULT_DEMAND_RE =
  /^(?:\u6211\u8ba9\u4f60(?:\u5e2e\u6211)?(?:\u770b(?:\u4e0b|\u4e00\u4e0b|\u770b)?|\u67e5(?:\u4e0b|\u4e00\u4e0b)?).{0,16}\u684c\u9762(?:\u4e0a)?.{0,16}(?:\u591a\u5c11|\u51e0\u4e2a)(?:\u4e2a)?(?:\u8f6f\u4ef6|\u5e94\u7528).{0,20}(?:\u4f60\u5012\u662f)?(?:\u8ddf\u6211|\u7ed9\u6211)?\u8bf4(?:\u5440|\u554a|\u561b)?)[\u554a\u5440\u5427\u561b\u5462\uff0c,\u3002\uff01\uff1f?!]*$/iu;

export type RecentActionFollowupIntent = 'execute' | 'status' | 'repeat' | 'none';

function currentTurnText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}

/**
 * Durable fail-closed marker used when a restart cannot recover the exact
 * confirmation envelope. The old task description remains available for
 * context, but it is not authority to reconstruct dangerous tool arguments.
 */
export const RECONFIRMATION_REQUIRED_BLOCKER =
  'reconfirmation_required: The exact pending confirmation is unavailable after runtime restart. Generate and display a fresh review proposal before accepting confirmation.';

export function conversationActionRequiresFreshConfirmationReview(
  value: ConversationActionContinuationState | null | undefined,
): boolean {
  return Boolean(
    value?.unfinished
    && value.status === 'blocked'
    && /^reconfirmation_required(?:\b|:)/iu.test(String(value.latestBlocker || '').trim()),
  );
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
  const current = currentTurnText(text);
  return CURRENT_APP_EDIT_RE.test(current)
    || CURRENT_APP_WINDOW_ACTION_RE.test(current)
    || CURRENT_APP_DOCUMENT_CREATE_RE.test(current);
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
  if (isImmediateAssistantRestatementRequest(clean)) return 'repeat';
  const normalizedIntent = normalizeActionIntent(clean);
  if (normalizedIntent.kind === 'status_query') return 'status';
  if (normalizedIntent.kind !== 'none' && normalizedIntent.relation === 'new') return 'none';
  if (hasMixedStatusExecutionIntent(clean)) return 'execute';
  if (MIXED_STATUS_QUESTION_RE.test(clean)) return 'status';
  if (
    STATUS_FOLLOWUP_RE.test(clean)
    || STATUS_RESULT_DEMAND_RE.test(clean)
    || ENGLISH_STATUS_FOLLOWUP_RE.test(clean)
  ) return 'status';
  if (
    matchesCnActionContinuation(clean)
    || CN_SHORT_EXECUTION_CONTINUATION_RE.test(clean)
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
        && (toolCallFailure(call) || toolRecordHasTerminalPayload(call)),
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
      if (resultCarriesDirectSourcePath(name)) {
        collectPathValues(toolCallResult(call), sourcePaths);
      }
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
    sourcePaths: Array.from(sourcePaths)
      .filter(candidate => !isUnconfirmedRuntimeCandidate(candidate, goal))
      .slice(0, 8),
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
      const resultObject = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, any>
        : {};
      const liveResult = resultObject.result && typeof resultObject.result === 'object'
        ? resultObject.result as Record<string, any>
        : resultObject;
      const verification = liveResult.verification && typeof liveResult.verification === 'object'
        ? liveResult.verification as Record<string, any>
        : resultObject.verification && typeof resultObject.verification === 'object'
          ? resultObject.verification as Record<string, any>
          : {};
      const status = compact(
        call?.error
        || resultObject.status
        || call?.terminalVerification?.status
        || verification.status
        || call?.status
        || '',
        120,
      );
      const args = toolCallArguments(call);
      const paths = new Set<string>();
      collectPathValues(args, paths);
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
        args.action || liveResult.action ? `action=${compact(args.action || liveResult.action, 100)}` : '',
        args.target || liveResult.target ? `target=${compact(args.target || liveResult.target, 100)}` : '',
        args.section || liveResult.section ? `section=${compact(args.section || liveResult.section, 100)}` : '',
        verification.status ? `verification=${compact(verification.status, 80)}` : '',
        paths.size ? `paths=${Array.from(paths).slice(0, 3).join(' | ')}` : '',
        resultEvidence,
      ].filter(Boolean).join(' | '));
    }
  }
  return Array.from(new Set(summaries)).slice(-10);
}

export function normalizeConversationActionState(
  value: Partial<ConversationActionContinuationState> | null | undefined,
): ConversationActionContinuationState | null {
  if (!value || typeof value !== 'object') return null;
  const goal = compact(value.goal, 700);
  if (!goal) return null;
  const statusValue = compact(value.status, 40) as ConversationTaskStatus;
  const status: ConversationTaskStatus = (CONVERSATION_TASK_STATUSES as readonly string[]).includes(statusValue)
    ? statusValue
    : value.unfinished ? 'blocked' : 'completed';
  const receipts = (Array.isArray(value.receipts) ? value.receipts : [])
    .map((receipt: any): ConversationTaskReceipt | null => normalizeConversationTaskReceipt(receipt))
    .filter((receipt): receipt is ConversationTaskReceipt => Boolean(receipt))
    .slice(-40);
  const storedCapsule = normalizeTaskCapsuleV1(value.taskCapsule);
  const receiptCompletion = receipts.length > 0
    ? taskCompletionFromReceipts(goal, receipts, storedCapsule)
    : null;
  const unfinished = isTerminalConversationTaskStatus(status)
    ? false
    : Boolean(value.unfinished);
  const requestLeaseActive = conversationTaskStatusOwnsExecutionLease(status);
  const normalizedState: ConversationActionContinuationState = {
    version: Number(value.version) === 1 && !value.taskId ? 1 : 2,
    taskId: compact(value.taskId, 180) || undefined,
    status,
    policySnapshot: snapshotTaskPolicy(value.policySnapshot as ToolPolicy) || undefined,
    receipts,
    activeRequestId: requestLeaseActive
      ? compact(value.activeRequestId, 180) || undefined
      : undefined,
    supersededTaskId: compact(value.supersededTaskId, 180) || undefined,
    revision: Math.max(0, Math.trunc(Number(value.revision) || 0)),
    goal,
    latestInstruction: compact(value.latestInstruction || goal, 700),
    latestInstructionRef: compact(value.latestInstructionRef, 180) || undefined,
    appTarget: compact(value.appTarget, 160),
    sourcePaths: Array.from(new Set(Array.isArray(value.sourcePaths) ? value.sourcePaths : []))
      .map(path => compact(path, 500))
      .filter(Boolean)
      .filter(candidate => !isUnconfirmedRuntimeCandidate(
        candidate,
        `${value.latestInstruction || ''}\n${goal}`,
      ))
      .slice(0, 8),
    latestBlocker: status === 'completed' || status === 'waiting_confirmation' || status === 'cancelled'
      ? ''
      : compact(receiptCompletion?.blocker || value.latestBlocker, 380),
    unfinished,
    evidenceTools: Array.from(new Set(Array.isArray(value.evidenceTools) ? value.evidenceTools : []))
      .map(name => compact(name, 120))
      .filter(Boolean)
      .slice(-10),
    assistantState: compactAssistantState(value.assistantState, status),
    toolSummaries: Array.from(new Set(Array.isArray(value.toolSummaries) ? value.toolSummaries : []))
      .map(summary => compact(summary, 700))
      .filter(Boolean)
      .slice(-10),
    updatedAt: compact(value.updatedAt, 80) || new Date(0).toISOString(),
    evidenceMessageId: compact(value.evidenceMessageId, 160) || undefined,
    completionSource: value.completionSource === 'user_observation'
      ? 'user_observation'
      : value.completionSource === 'tool_receipt'
        ? 'tool_receipt'
        : undefined,
    terminalPersistence: value.terminalPersistence?.status === 'persistence_unknown'
      ? {
          status: 'persistence_unknown',
          requestId: compact(value.terminalPersistence.requestId, 180),
          quarantinedAt: compact(value.terminalPersistence.quarantinedAt, 80),
        }
      : undefined,
  };
  const previousCapsule = storedCapsule
    && (!normalizedState.taskId || storedCapsule.taskId === normalizedState.taskId)
    ? storedCapsule
    : null;
  const taskCapsule = buildTaskCapsuleV1(normalizedState, {
    previousCapsule,
    observedAt: normalizedState.updatedAt,
  });
  return {
    ...normalizedState,
    ...(taskCapsule ? { taskCapsule } : {}),
  };
}

/**
 * Return the exact immutable runtime targets of a cancellation that the
 * server already accepted but has not terminally verified. A caller may use
 * this only to recheck/reconcile that same cancellation; the helper never
 * widens an empty or malformed target set into cancel-all authority.
 */
export function pendingRuntimeCancellationRecheck(
  value: ConversationActionContinuationState | null | undefined,
): PendingRuntimeCancellationRecheck | null {
  const state = normalizeConversationActionState(value);
  if (!state?.taskId || !state.unfinished) return null;
  // New cleanup flows own a dedicated cancel task, so later status rechecks
  // must keep authority from the immutable root goal. The latest instruction
  // is retained only as a compatibility fallback for older ledgers that
  // attached the accepted cleanup to an observe task.
  const hasCancellationContract = [state.goal, state.latestInstruction]
    .filter(Boolean)
    .some(candidate => {
      const contract = buildActionEvidenceContract(candidate);
      return contract.kind === 'task_control'
        && contract.preferredTools.includes('runtime_work_cancel');
    });
  if (!hasCancellationContract) {
    return null;
  }
  const latestCancellation = [...(state.receipts || [])]
    .reverse()
    .find(receipt => receipt.name === 'runtime_work_cancel');
  if (!latestCancellation) return null;
  const payload = toolRecordTerminalPayload({
    receipt: latestCancellation.receipt,
    result: latestCancellation.result,
  });
  const result = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, any>
    : null;
  if (
    result?.ok !== true
    || String(result.status || '').toLowerCase() !== 'cancelling'
    || Number(result.failedCount || 0) !== 0
    || latestCancellation.terminalVerification?.status === 'verified'
  ) return null;
  // The original tool arguments are the only mutation authority. A handler
  // receipt is evidence about that call; it cannot add targets by reporting a
  // wider `requestedTaskIds` set. Require both sides to carry a non-empty
  // exact-ID set and fail closed when the receipt over-reports even one id.
  const exactTaskIds = (candidate: unknown): string[] | null => {
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 64) return null;
    const normalized: string[] = [];
    for (const item of candidate) {
      if (typeof item !== 'string') return null;
      const taskId = item.trim();
      if (!taskId || taskId.length > 180) return null;
      normalized.push(taskId);
    }
    const unique = Array.from(new Set(normalized));
    return unique.length > 0 ? unique : null;
  };
  const authorizedTaskIds = exactTaskIds(latestCancellation.arguments?.taskIds);
  const requestedTaskIds = exactTaskIds(result.requestedTaskIds);
  if (!authorizedTaskIds || !requestedTaskIds) return null;
  const authorizedTaskIdSet = new Set(authorizedTaskIds);
  // Reconcile the complete original set. A subset cannot escalate authority,
  // but accepting it would silently stop tracking omitted cancellations and
  // could later claim the multi-target task completed from partial evidence.
  if (
    requestedTaskIds.length !== authorizedTaskIdSet.size
    || requestedTaskIds.some(taskId => !authorizedTaskIdSet.has(taskId))
  ) return null;
  return {
    taskId: state.taskId,
    taskIds: requestedTaskIds,
    priorReceiptId: compact(latestCancellation.id, 180),
    priorStatus: 'cancelling',
  };
}

export function classifyConversationActionFollowupIntent(
  text: string,
  state?: ConversationActionContinuationState | null,
): RecentActionFollowupIntent {
  if (isImmediateAssistantRestatementRequest(text)) return 'repeat';
  const durableState = normalizeConversationActionState(state);
  const compactText = compact(text, 500);
  // Never let a readiness acknowledgement reconstruct a one-time dangerous
  // confirmation that was lost across restart.
  if (
    conversationActionRequiresFreshConfirmationReview(durableState)
    && isExplicitConfirmationReply(compactText)
  ) return 'status';
  if (
    isBlockedTaskReadinessAcknowledgement(compactText, durableState)
  ) return 'execute';
  if (isNegativeResultCorrectionForTask(compactText, durableState)) return 'execute';
  if (isMediaPlaybackContinuationForTask(compactText, durableState)) return 'execute';
  const normalizedIntent = normalizeActionIntent(text);
  if (
    durableState?.unfinished
    && normalizedIntent.relation === 'correction'
    && normalizedIntent.kind !== 'none'
    && normalizedIntent.kind !== 'correction_explanation'
    && normalizedIntent.operation !== 'status'
  ) return 'execute';
  // A self-contained normalized action is new work. Resolve this before a
  // TaskCapsule path/detail heuristic, otherwise a new artifact path or client
  // navigation can be swallowed by an unrelated unfinished file task.
  if (normalizedIntent.kind !== 'none' && normalizedIntent.relation === 'new') return 'none';
  if (
    durableState?.unfinished
    && isTaskCapsuleTargetContinuation(compactText, durableState)
  ) return 'execute';
  if (
    normalizedIntent.kind === 'correction_explanation'
    || normalizedIntent.kind === 'work_task'
  ) return 'none';
  if (hasMixedStatusExecutionIntent(text)) return 'execute';
  if (normalizedIntent.kind === 'status_query') return 'status';
  const direct = classifyRecentActionFollowupIntent(text);
  if (direct !== 'none') return direct;
  if (!durableState?.unfinished) return 'none';
  return AMBIGUOUS_UNFINISHED_TASK_STATUS_RE.test(compact(text, 500)) ? 'status' : 'none';
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
  const calls = coalesceToolExecutionRecords(parseToolCalls({ toolCalls: input.toolCalls }))
    .filter(call => toolCallName(call) && (toolCallFailure(call) || toolRecordHasTerminalPayload(call)));
  if (!userText || calls.length === 0) return null;

  const previous = normalizeConversationActionState(input.previous);
  const followupIntent = classifyConversationActionFollowupIntent(userText, previous);
  const samePreparedTurn = Boolean(
    previous
    && previous.latestInstruction === userText
    && ['planning', 'executing', 'waiting_confirmation'].includes(previous.status || ''),
  );
  const inheritsPrevious = (
    followupIntent === 'execute'
    || followupIntent === 'status'
    || samePreparedTurn
  ) && Boolean(previous);
  const currentHistory: ActionContinuationHistoryItem[] = [
    { role: 'user', message: userText },
    { role: 'assistant', message: assistantText, toolCalls: calls },
  ];
  const current = extractRecentActionContinuationState(currentHistory);
  const currentSummaries = summarizeToolCalls(currentHistory);
  const goal = inheritsPrevious ? previous!.goal : userText;
  const receipts = mergeTaskReceipts(
    inheritsPrevious ? previous?.receipts || [] : [],
    calls,
    input.updatedAt || new Date().toISOString(),
  );
  // A terse confirmation/continue turn advances the original contract. Using
  // "确认" itself as the contract makes one confirmed sub-step look like the
  // whole task completed. Only a concrete action-bearing extension replaces
  // the completion target for this turn.
  const completionGoal = inheritsPrevious
    && followupIntent === 'execute'
    && isActionBearingGoal(userText)
    ? userText
    : goal;
  const completion = taskCompletionFromReceipts(
    completionGoal,
    receipts,
    inheritsPrevious ? previous?.taskCapsule : undefined,
  );
  const currentFailure = [...calls].reverse().find(record => !toolCallSucceeded(record));
  const waitingForConfirmation = calls.some(isConfirmationBlockedToolRecord);
  const hasFailure = completion.records.some(record => !toolCallSucceeded(record));
  const status: ConversationTaskStatus = followupIntent === 'status' && currentFailure
    ? 'blocked'
    : completion.complete
    ? 'completed'
    : waitingForConfirmation
      ? 'waiting_confirmation'
    : hasFailure
      ? 'blocked'
      : 'executing';
  const currentInstructionRef = compact(input.userMessageId, 180)
    || compact(input.requestId, 180);

  return normalizeConversationActionState({
    version: 2,
    taskId: inheritsPrevious && previous?.taskId ? previous.taskId : `task_${randomUUID()}`,
    status,
    policySnapshot: snapshotTaskPolicy(input.toolPolicy) || (inheritsPrevious ? previous?.policySnapshot : undefined),
    receipts,
    activeRequestId: input.requestId || (inheritsPrevious ? previous?.activeRequestId : undefined),
    supersededTaskId: !inheritsPrevious && previous?.unfinished ? previous.taskId : undefined,
    revision: (inheritsPrevious ? previous?.revision || 0 : 0) + 1,
    goal,
    latestInstruction: followupIntent === 'status' && previous
      ? previous.latestInstruction
      : userText,
    latestInstructionRef: followupIntent === 'status' && previous
      ? previous.latestInstructionRef
      : currentInstructionRef || undefined,
    appTarget: current.appTarget || (inheritsPrevious ? previous!.appTarget : ''),
    sourcePaths: Array.from(new Set([
      ...(inheritsPrevious ? previous!.sourcePaths : []),
      ...current.sourcePaths,
    ])).slice(0, 8),
    latestBlocker: waitingForConfirmation
      ? ''
      : completion.blocker || (currentFailure ? toolCallFailure(currentFailure) : ''),
    unfinished: status !== 'completed',
    evidenceTools: Array.from(new Set([
      ...(inheritsPrevious ? previous!.evidenceTools : []),
      ...current.evidenceTools,
    ])).slice(-10),
    assistantState: compactAssistantState(input.assistantText, status),
    toolSummaries: Array.from(new Set([
      ...(inheritsPrevious ? previous!.toolSummaries : []),
      ...currentSummaries,
    ])).slice(-10),
    taskCapsule: inheritsPrevious ? previous?.taskCapsule : undefined,
    updatedAt: input.updatedAt || new Date().toISOString(),
    evidenceMessageId: input.evidenceMessageId,
    completionSource: completion.complete
      ? 'tool_receipt'
      : inheritsPrevious
        ? previous?.completionSource
        : undefined,
  });
}

export function prepareConversationActionTaskState(
  previousValue: ConversationActionContinuationState | null | undefined,
  input: {
    userText: string;
    requestId: string;
    toolPolicy: ToolPolicy;
    /** Exact persisted user message, preferred over requestId as event identity. */
    userMessageId?: string;
    forceResume?: boolean;
    /** The current explicit workflow must supersede, never resume, older unfinished work. */
    forceNewTask?: boolean;
    /** Canonical capability planning determined that this turn needs a ledger. */
    forceTask?: boolean;
    now?: string;
  },
): { state: ConversationActionContinuationState | null; kind: 'new' | 'resume' | 'status' | 'conversation' } {
  const userText = compact(input.userText, 700);
  const previous = normalizeConversationActionState(previousValue);
  const followupIntent = classifyConversationActionFollowupIntent(userText, previous);
  const resume = !input.forceNewTask && Boolean(
    previous && previous.unfinished && (input.forceResume || followupIntent === 'execute'),
  );
  // A plain status question is observational. Internal deterministic recovery
  // may deliberately resume that exact unfinished task so a fresh receipt can
  // be adjudicated under a new request lease. Likewise, an accepted proposal
  // may force a new task even when its terse wording is referential.
  if (
    followupIntent === 'status'
    && previous
    && !input.forceResume
    && !input.forceNewTask
  ) return { state: previous, kind: 'status' };
  const contract = buildActionContract(userText);
  const isAction = (contract.applies && contract.kind !== 'none') || input.forceTask === true;
  // An unrelated conversational turn may inspect the same conversation, but
  // it does not own the durable action pointer. Returning the previous task
  // here caused callers to bind the new turn's execution plan and receipts to
  // an older blocked task (for example, a model question being attached to an
  // earlier "open browser" task). The conversation manager keeps the durable
  // ledger separately; callers receive no task identity for a plain turn.
  if (!resume && !isAction) return { state: null, kind: 'conversation' };

  const now = input.now || new Date().toISOString();
  const latestInstructionRef = compact(input.userMessageId, 180)
    || compact(input.requestId, 180);
  if (resume && previous) {
    return {
      kind: 'resume',
      state: normalizeConversationActionState({
        ...previous,
        version: 2,
        // `waiting_confirmation` describes an idle task with no foreground
        // request owner. Once a new accepted turn resumes that exact pending
        // action, the successor request must enter an owning phase so its
        // verified receipt can be adjudicated against the task after restart.
        // Keeping the task in `waiting_confirmation` makes normalization drop
        // activeRequestId, which archives the confirmed receipt but leaves the
        // task and live pointer stuck at the old confirmation checkpoint.
        status: 'planning',
        latestInstruction: userText,
        latestInstructionRef: latestInstructionRef || undefined,
        activeRequestId: input.requestId,
        policySnapshot: snapshotTaskPolicy(
          applyTaskPolicySnapshot(input.toolPolicy, previous.policySnapshot),
        ) || previous.policySnapshot,
        revision: (previous.revision || 0) + 1,
        updatedAt: now,
      }),
    };
  }

  return {
    kind: 'new',
    state: normalizeConversationActionState({
      version: 2,
      taskId: `task_${randomUUID()}`,
      status: 'planning',
      policySnapshot: snapshotTaskPolicy(input.toolPolicy),
      receipts: [],
      activeRequestId: input.requestId,
      supersededTaskId: previous?.unfinished ? previous.taskId : undefined,
      revision: 1,
      goal: userText,
      latestInstruction: userText,
      latestInstructionRef: latestInstructionRef || undefined,
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: [],
      assistantState: '',
      toolSummaries: [],
      updatedAt: now,
    }),
  };
}

export function formatConversationActionTaskStatus(
  value: ConversationActionContinuationState | null | undefined,
  options: { executionActive?: boolean } = {},
): string {
  const state = normalizeConversationActionState(value);
  if (!state) return CN_TASK_EXECUTION_MESSAGES.noResumableTask;
  const rootGoal = state.goal.slice(0, 80);
  const latestInstruction = state.latestInstruction.slice(0, 80);
  const goal = latestInstruction && latestInstruction !== rootGoal
    ? CN_TASK_EXECUTION_MESSAGES.goalWithCurrentStep(rootGoal, latestInstruction)
    : rootGoal;
  const successes = (state.receipts || []).filter(receipt => receipt.outcome === 'success').length;
  if (state.status === 'cancelled') {
    return CN_TASK_EXECUTION_MESSAGES.statusCancelled(goal);
  }
  if (conversationActionRequiresFreshConfirmationReview(state)) {
    return CN_TASK_EXECUTION_MESSAGES.statusFreshConfirmation(goal);
  }
  if (state.status === 'waiting_confirmation') {
    return CN_TASK_EXECUTION_MESSAGES.statusWaitingConfirmation(goal);
  }
  if (state.status === 'failed' || state.latestBlocker) {
    const detail = formatCnToolFailureDetail(
      state.latestBlocker || 'The task ended without a verified result.',
    ).replace(/[。；;]+$/u, '');
    return CN_TASK_EXECUTION_MESSAGES.statusFailed(goal, detail, successes);
  }
  if (state.status === 'completed' || !state.unfinished) {
    if (state.completionSource === 'user_observation') {
      return CN_TASK_EXECUTION_MESSAGES.completedFromUserObservation(goal);
    }
    return CN_TASK_EXECUTION_MESSAGES.statusCompleted(goal);
  }
  if (
    options.executionActive === true
    || (
      options.executionActive === undefined
      && Boolean(String(state.activeRequestId || '').trim())
      && ['planning', 'executing', 'verifying'].includes(state.status || '')
    )
  ) {
    return CN_TASK_EXECUTION_MESSAGES.statusActive(goal, successes);
  }
  return CN_TASK_EXECUTION_MESSAGES.statusResumable(goal, successes);
}

/**
 * The person at the computer can be the final visible-state verifier. This is
 * only accepted as a declarative correction for an unfinished task that
 * already has an actuation receipt; questions, negations, and bare praise do
 * not alter execution state.
 */
export function isUserObservedTaskCompletion(
  text: string,
  value: ConversationActionContinuationState | null | undefined,
): boolean {
  const state = normalizeConversationActionState(value);
  const clean = compact(text, 260);
  if (!state?.unfinished || !(state.receipts || []).length || !clean) return false;
  if (/[？?]/u.test(clean)) return false;
  // i18n-allow: Chinese user-observation recognition; not user-visible copy.
  if (/(?:没有|没|未|并未|不是|并不是|不算|并不)|\b(?:not|didn'?t|hasn'?t|isn'?t|wasn'?t)\b/iu.test(clean)) return false;
  const cnObservationCue = /(?:^|[，,\s])(?:你|它|这个|那个|消息|文件|文档|窗口|页面|软件|任务|实际|其实|确实|已经|刚才|刚刚|都)/u; // i18n-allow: Chinese input recognition.
  const cnCompletedAction = /(?:完成|做完|执行完|发(?:送)?(?:出)?(?:去)?|打开|保存|写入|生成|创建|关闭|最大化|最小化)(?:成功|好|完|出去|出来)?了[。！!\s]*$/u; // i18n-allow: Chinese input recognition.
  return (cnObservationCue.test(clean) && cnCompletedAction.test(clean))
    || /^(?:you|it|that|the\s+(?:message|file|window|task))\s+(?:already\s+)?(?:did|has|was|is)?[^.!?]{0,24}(?:completed|finished|sent|opened|saved|created|closed|maximized|minimized)(?:\s+successfully)?[.!\s]*$/iu.test(clean);
}

export function needsRecentActionContinuationContext(userText: string): boolean {
  const clean = compact(userText, 500);
  if (!clean || (clean.length > 180 && !isCurrentAppEditingRequest(clean))) return false;
  const normalizedIntent = normalizeActionIntent(clean);
  if (normalizedIntent.kind === 'work_task') return false;
  if (
    normalizedIntent.kind === 'correction_explanation'
    || normalizedIntent.kind === 'status_query'
    || normalizedIntent.relation === 'child'
  ) return true;
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
  const normalizedIntent = normalizeActionIntent(userText);
  if (
    normalizedIntent.kind === 'status_query'
    || normalizedIntent.kind === 'correction_explanation'
  ) return null;
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
  currentTurnRef?: string,
): string {
  const currentText = compact(userText, 700);
  const normalizedDurableState = normalizeConversationActionState(persistedState);
  const durableUpdatedAt = normalizedDurableState
    ? new Date(normalizedDurableState.updatedAt).getTime()
    : Number.NaN;
  const staleReferentialExecution = Boolean(
    normalizedDurableState
    && Number.isFinite(durableUpdatedAt)
    && Date.now() - durableUpdatedAt > REFERENTIAL_CONTEXT_MAX_AGE_MS
    && classifyConversationActionFollowupIntent(currentText, normalizedDurableState) === 'execute'
    && !explicitDurableTaskReference(currentText),
  );
  const durableState = staleReferentialExecution ? null : normalizedDurableState;
  const followupIntent = classifyConversationActionFollowupIntent(currentText, durableState);
  if (
    !(needsRecentActionContinuationContext(userText) || followupIntent !== 'none')
    || ((!Array.isArray(history) || history.length === 0) && !durableState)
  ) {
    return '';
  }

  const recent = (Array.isArray(history) ? history : [])
    .slice(-18)
    .filter(item => {
      const timestamp = recordTimestamp(item);
      return timestamp === null || Date.now() - timestamp <= REFERENTIAL_CONTEXT_MAX_AGE_MS;
    })
    .filter(item => ['user', 'assistant', 'agent'].includes(recordRole(item)) && recordText(item))
    .filter(item => !(recordRole(item) === 'user' && recordText(item) === currentText));

  if (followupIntent === 'repeat') {
    const reply = findLatestRepeatableAssistantReply(recent);
    if (!reply) return '';
    return [
      '## Recent action continuation context',
      'The newest user turn asks to hear the immediately preceding Lumi reply again.',
      'Recovered structured action state:',
      '- followupIntent: repeat',
      'Immediate prior Lumi reply:',
      `- ${reply}`,
      'Rules:',
      '- Repeat or lightly restate only the immediate prior Lumi reply so it is easy to hear.',
      '- Do not fall back to an older user task, work-takeover record, tool receipt, or unrelated conversation topic.',
      '- Do not call tools, resume work, diagnose the old task, or claim a new action completed.',
    ].join('\n');
  }
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
  const taskCapsule = durableState
    ? buildTaskCapsuleV1(durableState, {
        previousCapsule: durableState.taskCapsule,
        currentTurnText: currentText,
        currentTurnRef: compact(currentTurnRef, 180) || undefined,
      })
    : null;
  const taskCapsulePrompt = taskCapsule ? formatTaskCapsuleForPrompt(taskCapsule) : '';

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
    'The current message is referential or underspecified. Resolve it against the recent task below before routing or choosing tools.',
    'Recovered structured action state:',
    `- followupIntent: ${followupIntent}`,
    durableState?.taskId ? `- taskId: ${durableState.taskId}` : '',
    durableState?.status ? `- taskStatus: ${durableState.status}` : '',
    state.goal ? `- originalGoal: ${state.goal}` : '',
    durableState?.latestInstruction ? `- latestInstruction: ${durableState.latestInstruction}` : '',
    state.appTarget ? `- appTarget: ${state.appTarget}` : '',
    state.sourcePaths.length ? `- sourcePaths: ${state.sourcePaths.join(' | ')}` : '',
    state.latestBlocker ? `- latestBlocker: ${state.latestBlocker}` : '',
    `- unfinished: ${state.unfinished ? 'yes' : 'no'}`,
    durableState?.updatedAt ? `- stateUpdatedAt: ${durableState.updatedAt}` : '',
    taskCapsulePrompt,
    userTurns.length ? 'Recent user task context:' : '',
    ...userTurns.map(turn => `- ${turn}`),
    assistantTurns.length ? 'Recent Lumi execution state:' : '',
    ...assistantTurns.map(turn => `- ${turn}`),
    toolSummaries.length ? 'Recent tool evidence:' : '',
    ...toolSummaries.map(summary => `- ${summary}`),
    'Rules:',
    '- Continue the same target, application, files, and acceptance criteria unless the user clearly starts a new task.',
    '- Preserve this task id and its original capability envelope for execute/confirmation follow-ups. Do not recalculate a narrower permission set from the short follow-up alone.',
    '- A tool retry is one logical step: a later successful receipt for the same tool and arguments supersedes its earlier failed attempt.',
    // i18n-allow: Quoted Chinese phrases are input examples inside an internal routing prompt.
    '- appTarget is recovered only from a successful desktop_open receipt. For wording like "在这里面 / 这个软件里 / 刚打开的里面", continue inside that application with active-window and UI typing/control tools.',
    '- This is conversation-scoped persisted execution state, not a task-center record. Do not route to work_takeover/task-center tools unless the evidence above explicitly contains a work_takeover tool or task id.',
    '- Do not reinterpret an underspecified verb such as draw, run, send, open, or continue into another domain.',
    '- Preparation is not completion. Preserve the latest blocker and require evidence for the original task contract.',
    '- Historical attachments are not current inputs; reuse only explicit local paths or artifacts shown in this context.',
  ].filter(Boolean).join('\n');
}
