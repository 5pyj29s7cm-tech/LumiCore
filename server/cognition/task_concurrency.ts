import {
  classifyConversationActionFollowupIntent,
  type ConversationActionContinuationState,
} from './action_continuation';

export type ActiveTaskMessageRelation =
  | 'status'
  | 'continue'
  | 'cancel'
  | 'replace'
  | 'queue';

// These are task-control utterances, not domain intents. Keeping them here
// prevents every socket surface from inventing a different cancellation rule.
// i18n-allow: multilingual task-control recognition; not user-visible copy.
const CANCEL_ONLY_RE =
  /^(?:取消|停止|停下|别做了|不要做了|终止)(?:这个|那个|当前)?(?:任务|操作|工作)?[。！？.!?]*$|^(?:cancel|stop|abort|terminate)(?:\s+(?:this|that|the current)\s+(?:task|operation|work))?[.!?]*$/iu; // i18n-allow: multilingual task-control recognition; not user-visible copy.
// i18n-allow: multilingual task-replacement recognition; not user-visible copy.
const REPLACE_RE =
  /(?:取消|停止|停下|别做|不要做|终止|放弃).{0,24}(?:改成|换成|改做|转去|重新做|而是)|\b(?:cancel|stop|abort|drop)\b.{0,40}\b(?:instead|replace|switch|change\s+to|do)\b/iu; // i18n-allow: multilingual task-replacement recognition; not user-visible copy.

export function classifyActiveTaskMessage(
  text: string,
  state?: ConversationActionContinuationState | null,
): ActiveTaskMessageRelation {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'queue';
  const followup = classifyConversationActionFollowupIntent(normalized, state);
  if (followup === 'status') return 'status';
  if (CANCEL_ONLY_RE.test(normalized)) return 'cancel';
  if (REPLACE_RE.test(normalized)) return 'replace';
  if (followup === 'execute') return 'continue';
  // Independent new work is queued behind the active foreground task. It
  // does not destroy the active task ledger or interleave terminal replies.
  return 'queue';
}
