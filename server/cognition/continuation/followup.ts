import type { ActionIntentAnalysis } from "../normalized_action_intent";
import { buildTaskTargetAnchorProjection } from "../../conversation/task_target_anchor";
import { hasMixedStatusExecutionIntent, isImmediateAssistantRestatementRequest, normalizeActionIntent, type NormalizedActionIntent } from "../normalized_action_intent";
import { matchesCnActionContinuation, matchesCnBoundArtifactEdit, matchesCnExplicitPlaybackRetry } from "../../regions/input/zh_action_continuation";
import { hasExplicitNoMutationInstruction } from "../tool_intent";
import { buildActionContract, requestedMediaPlayerTarget, requiresMediaPlaybackAction } from "../action_contract";
import { isExplicitConfirmationReply } from "../../tools/pending_confirmation";
import { isTaskCapsuleTargetContinuation } from "../../conversation/task_capsule";
import type { ConversationActionContinuationState, RecentActionFollowupIntent } from './contracts';
import { normalizeConversationActionState } from './state_normalization';
import { compact, REFERENTIAL_CONTEXT_MAX_AGE_MS } from './history_values';
import { NEGATIVE_RESULT_CORRECTION_RE, ASSISTANT_REQUESTED_READINESS_RE, BLOCKED_TASK_READINESS_RE, BARE_BLOCKED_TASK_READINESS_RE, currentTurnText, CURRENT_APP_EDIT_RE, CURRENT_APP_WINDOW_ACTION_RE, CURRENT_APP_DOCUMENT_CREATE_RE, MIXED_STATUS_QUESTION_RE, STATUS_FOLLOWUP_RE, STATUS_RESULT_DEMAND_RE, ENGLISH_STATUS_FOLLOWUP_RE, CN_SHORT_EXECUTION_CONTINUATION_RE, ENGLISH_SHORT_CONTINUATION_RE, ENGLISH_REFERENTIAL_ACTION_RE, explicitDurableTaskReference, AMBIGUOUS_UNFINISHED_TASK_STATUS_RE, CONCRETE_LOCAL_SOURCE_RE, EXPLICIT_ACTION_TARGET_RE } from './recognition';
import { conversationActionRequiresFreshConfirmationReview } from './confirmation';

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

/** Acceptance resumes an evidenced, blocked task only when its last reply
 * actually proposed retrying it. It never reconstructs a lost confirmation. */
export function isBlockedTaskRetryAcceptance(
  text: string,
  state?: ConversationActionContinuationState | null,
): boolean {
  if (!state?.taskId || !state.unfinished || state.status !== 'blocked'
    || !state.receipts?.length || conversationActionRequiresFreshConfirmationReview(state)
    || !isExplicitConfirmationReply(text.trim())) return false;
  const age = Date.now() - Date.parse(state.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age > REFERENTIAL_CONTEXT_MAX_AGE_MS) return false;
  // i18n-allow: Server-bound retry-offer recognition, not user-facing copy.
  return /(?:我|这次|现在|可以|要不要).{0,30}(?:再试一次|重试|重新生成|再生成|再发起)|\b(?:I (?:can|will|could)|shall I|try)\b.{0,45}\b(?:retry|try again|generate again)\b/iu.test(state.assistantState || '');
}

function normalizeMediaTarget(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isMediaPlaybackContinuationForTask(
  text: string,
  state: ConversationActionContinuationState | null | undefined, analysis?: ActionIntentAnalysis
): boolean {
  const durableState = normalizeConversationActionState(state);
  if (
    !durableState?.unfinished
    || !requiresMediaPlaybackAction(durableState.goal)
  ) return false;
  // This reuses only an already bound playback goal. It does not change the
  // operating mode or grant permissions, and an unrelated 'allow' has no task.
  // i18n-allow: Short acknowledgements for the same unfinished media request.
  if (/^(?:允许|可以|继续)[，,。.!！\s]*$/u.test(text)) return true;
  if (matchesCnExplicitPlaybackRetry(text)) return true;
  const previousTarget = normalizeMediaTarget(requestedMediaPlayerTarget(durableState.goal, analysis));
  const currentTarget = normalizeMediaTarget(requestedMediaPlayerTarget(text, analysis));
  // i18n-allow: Restating the same named player after a failed attempt.
  if (/^(?:用|使用|还是用|就用)\s*[^，,。.!！?？]{1,32}[，,。.!！\s]*$/u.test(text)) {
    return Boolean(previousTarget && currentTarget && previousTarget === currentTarget);
  }
  if (!requiresMediaPlaybackAction(text)) return false;
  // An explicitly different player is new work; an omitted/deictic target
  // continues the exact unfinished playback goal.
  return !previousTarget || !currentTarget
    || previousTarget.includes(currentTarget)
    || currentTarget.includes(previousTarget);
}

export function isCurrentAppEditingRequest(text: string): boolean {
  const current = currentTurnText(text);
  return CURRENT_APP_EDIT_RE.test(current)
    || CURRENT_APP_WINDOW_ACTION_RE.test(current)
    || CURRENT_APP_DOCUMENT_CREATE_RE.test(current);
}

export function classifyRecentActionFollowupIntent(text: string, analysis?: ActionIntentAnalysis): RecentActionFollowupIntent {
  const clean = compact(text, 500);
  if (!clean) return 'none';
  if (isImmediateAssistantRestatementRequest(clean)) return 'repeat';
  const normalizedIntent = normalizeActionIntent(clean, analysis);
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

export function isContinuationOrPressureText(text: string, analysis?: ActionIntentAnalysis): boolean {
  return classifyRecentActionFollowupIntent(text, analysis) !== 'none';
}

export function isActionBearingGoal(goal: string, analysis?: ActionIntentAnalysis): boolean {
  const contract = buildActionContract(goal, undefined, analysis);
  return contract.applies && contract.kind !== 'none';
}

function explicitlyReferencesUnfinishedTask(text: string): boolean {
  const value = compact(text, 700);
  // i18n-allow: referential task resumption, not arbitrary continuation verbs.
  return /(?:^|[，,。；;！!？?])\s*(?:(?:请|现在|那就)\s*)?(?:继续|接着)(?:完成|处理|执行|做)?(?:刚才|之前|上述|当前|这个|上次|上一个|上个|原)(?:的)?(?:未完成的|没完成的|剩余的)?(?:任务|工作|操作|流程|步骤)?|(?:^|[,.!?;])\s*(?:please\s+)?(?:continue|resume|finish)\s+(?:(?:the|this|that)\s+)?(?:(?:previous|current|original|unfinished|remaining)\s+)(?:task|work|workflow|step)\b/iu.test(value);
}

/** A vague retry cannot silently reattach to an expired task pointer. */
export function isCurrentContinuationTask(text: string, state: ConversationActionContinuationState): boolean {
  const updatedAt = new Date(state.updatedAt).getTime();
  return !Number.isFinite(updatedAt)
    || Date.now() - updatedAt <= REFERENTIAL_CONTEXT_MAX_AGE_MS
    || explicitDurableTaskReference(text);
}

/** Explicitly referential resumption precedes the self-contained action gate. */
export function isExplicitUnfinishedTaskContinuation(text: string, state?: ConversationActionContinuationState | null, analysis?: ActionIntentAnalysis): boolean {
  if (!state?.unfinished || !state.taskId || !state.goal) return false;
  const comparable = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const repeatsUnfinishedGoal = comparable(text) === comparable(state.goal)
    && normalizeActionIntent(text, analysis).operation !== 'status' && buildActionContract(text, undefined, analysis).applies;
  if (!repeatsUnfinishedGoal && !explicitlyReferencesUnfinishedTask(text)) return false;
  const value = compact(text, 700);
  const current = buildActionContract(value, undefined, analysis);
  const root = buildActionContract(state.goal, undefined, analysis);
  if (!current.applies) return true;
  const kinds = new Set([root.kind, ...(root.components || []).map(part => part.contract.kind)]);
  if (kinds.has(current.kind)) return true;
  // A workflow's named output step is still part of that workflow even though
  // the latest sentence describes a file write rather than the whole recipe.
  if (normalizeActionIntent(state.goal, analysis).kind === 'workflow' && current.kind === 'artifact_work') {
    const target = buildTaskTargetAnchorProjection({ taskText: value }).target.path;
    if (target) {
      const normalized = (text: string) => text.replace(/\\/g, '/').toLowerCase();
      const escaped = normalized(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped + '(?:$|[\\s,，。;；"\u201d])', 'u').test(normalized(state.goal)); // i18n-allow: file-reference boundary punctuation.
    }
  }
  return false;
}

/** An explicitly ordered preparation step retains the matching unfinished goal. */
export function isTaskPreparationContinuation(text: string, state?: ConversationActionContinuationState | null, acceptedIntent?: NormalizedActionIntent, analysis?: ActionIntentAnalysis): boolean {
  if (!state?.unfinished || !state.goal) return false;
  const intent = acceptedIntent || normalizeActionIntent(text, analysis);
  if (intent.kind !== 'desktop_operation' || intent.operation !== 'navigate' || !intent.target) return false;
  const browserPlaybackStep = requiresMediaPlaybackAction(state.goal)
    && /^(?:浏览器|默认浏览器|Chrome|Edge|Firefox|browser)$/iu.test(intent.target) // i18n-allow: Explicit browser as the medium for an unfinished viewing task.
    && /(?:^|[，,。；;])\s*用[^，,。；;]{1,40}打开/iu.test(text); // i18n-allow: Object omitted because the original viewing goal owns it.
  if (!browserPlaybackStep && !/(?:先|首先|第一步)|\bfirst\b/iu.test(text)) return false; // i18n-allow: Sequencing a prerequisite, not replacing the task.
  const key = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s_.-]+/gu, '');
  const target = key(intent.target).replace(/exe$/u, '');
  const goal = key(state.goal);
  const rootContract = buildActionContract(state.goal, undefined, analysis);
  return target.length > 1 && (goal.includes(target) || browserPlaybackStep) && rootContract.applies && rootContract.kind !== 'none';
}

/** A value edit with a deictic file reference keeps the existing file task.
 * A separately named save destination is not a replacement input. */
export function isReferentialArtifactEdit(text: string, state?: ConversationActionContinuationState | null): boolean {
  if (!state?.goal || !state.unfinished) return false;
  if (hasExplicitNoMutationInstruction(text)) return false;
  const hasFileTask = /\.(?:xlsx?|docx?|csv|txt|md)\b/i.test(state.goal)
    || state.sourcePaths.some(value => /\.(?:xlsx?|docx?|csv|txt|md)$/i.test(value));
  if (hasFileTask && matchesCnBoundArtifactEdit(text, `${state.goal}\n${state.latestInstruction}\n${state.toolSummaries.join('\n')}`)) return true;
  return hasFileTask
    && /(?:\u521a\u624d|\u521a\u521a|\u4e0a\u4e00\u6b65|\u8fd9\u4efd|\u8be5).{0,16}(?:\u62a5\u8868|\u8868\u683c|\u6587\u4ef6|\u6587\u6863)|\b(?:that|previous|last)\s+(?:file|workbook|document|spreadsheet)\b/iu.test(text)
    && /(?:\u6539\u6210|\u6539\u4e3a|\u4fee\u6539|\u8c03\u6574)|\b(?:change|update|edit|modify)\b/iu.test(text);
}

export function classifyConversationActionFollowupIntent(
  text: string,
  state?: ConversationActionContinuationState | null,
  acceptedIntent?: NormalizedActionIntent, analysis?: ActionIntentAnalysis
): RecentActionFollowupIntent {
  if (isImmediateAssistantRestatementRequest(text)) return 'repeat';
  const durableState = normalizeConversationActionState(state);
  const compactText = compact(text, 500);
  // Status must win before retry/target heuristics inspect the task's old goal.
  const normalizedIntent = acceptedIntent || normalizeActionIntent(compactText, analysis);
  if (normalizedIntent.kind === 'status_query') return 'status';
  // Never let a readiness acknowledgement reconstruct a one-time dangerous
  // confirmation that was lost across restart.
  if (
    conversationActionRequiresFreshConfirmationReview(durableState)
    && isExplicitConfirmationReply(compactText)
  ) return 'status';
  if (
    isBlockedTaskReadinessAcknowledgement(compactText, durableState)
  ) return 'execute';
  if (isBlockedTaskRetryAcceptance(compactText, durableState)) return 'execute';
  if (isNegativeResultCorrectionForTask(compactText, durableState)) return 'execute';
  if (isMediaPlaybackContinuationForTask(compactText, durableState, analysis)) return 'execute';
  if (isTaskPreparationContinuation(compactText, durableState, normalizedIntent, analysis)) return 'execute';
  if (isReferentialArtifactEdit(text, durableState)) return 'execute';
  if (isExplicitUnfinishedTaskContinuation(compactText, durableState, analysis)) return 'execute';
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
  const direct = classifyRecentActionFollowupIntent(text, analysis);
  if (direct !== 'none') return direct;
  if (!durableState?.unfinished) return 'none';
  return AMBIGUOUS_UNFINISHED_TASK_STATUS_RE.test(compact(text, 500)) ? 'status' : 'none';
}

export function needsRecentActionContinuationContext(userText: string, analysis?: ActionIntentAnalysis): boolean {
  const clean = compact(userText, 500);
  if (explicitlyReferencesUnfinishedTask(clean)) return true;
  if (!clean || (clean.length > 180 && !isCurrentAppEditingRequest(clean))) return false;
  const normalizedIntent = normalizeActionIntent(clean, analysis);
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
  return classifyRecentActionFollowupIntent(clean, analysis) !== 'none';
}
