export interface PendingInterruptedVoiceTurn {
  text: string;
  interruptedAt: number;
}

const CORRECTION_CONTINUATION_PATTERNS: RegExp[] = [
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  /(?:\u4e0d\u662f|\u4e0d\u5bf9|\u9519\u4e86|\u641e\u9519\u4e86|\u5f04\u9519\u4e86|\u542c\u9519\u4e86|\u8bc6\u522b\u9519\u4e86|\u5bf9\u8c61\u9519\u4e86|\u4eba\u540d\u9519\u4e86|\u540d\u5b57\u9519\u4e86|\u5e94\u8be5\u662f|\u6539\u6210|\u66f4\u6b63\u4e3a|\u6211\u8bf4\u7684\u662f).{0,80}(?:\u4e0d\u662f|\u800c\u662f|\u662f|\u95ee|\u53d1|\u6253\u5f00|\u641c\u7d22|\u8054\u7cfb\u4eba|\u5bf9\u8c61|\u4eba\u540d|\u540d\u5b57)/u,
  // Spoken spelling correction: "the Lu I said is the Lu in mainland, not road".
  /\u6211\u8bf4\u7684.{1,16}\u662f.{0,12}\u7684.{1,2}.{0,12}\u4e0d\u662f.{0,12}\u7684.{1,2}/u,
  /[^\s\uff0c\u3002\uff01\uff1f,.!?]{1,16}\u7684[\u3400-\u9fff]\s*\u4e0d\u662f[^\s\uff0c\u3002\uff01\uff1f,.!?]{1,16}\u7684[\u3400-\u9fff]/u,
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  /^(?:\u4e0d\u662f|\u4e0d\u5bf9|\u9519\u4e86|\u5e94\u8be5\u662f|\u6539\u6210|\u66f4\u6b63\u4e3a|\u6211\u8bf4\u7684\u662f)/u,
  /\b(?:no|not that|wrong|I said|I meant|change (?:it )?to|correct (?:it )?to)\b/i,
];

export function isVoiceCorrectionContinuation(text: string): boolean {
  const normalized = String(text || '').trim();
  return Boolean(normalized) && CORRECTION_CONTINUATION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isVoiceCurrentActivityQuestion(text: string): boolean {
  const normalized = String(text || '')
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001]+/gu, '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized.length > 28) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(?:你)?(?:刚才|刚刚|现在)?(?:在)?(?:干嘛|干什么|做什么|忙什么|处理什么|跑什么|弄什么|搞什么|what(?:are|were)youdoing)$/iu.test(normalized);
}

export function isVoiceFiller(text: string): boolean {
  const compact = String(text || '')
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\uFF5E~\u2026\u3001]+/gu, '')
    .trim();
  if (!compact || compact.length > 24) return false;
  // Keep greetings/attention words such as "hello" out of this set. Repeated
  // hesitation sounds must not cancel a task that is already executing.
  return /^[\u55ef\u554a\u54e6\u5443\u54fc\u5509\u5440\u8bf6\u5514\u5636\u5567\u54ce\u54df\u561b\u54c7\u5566\u561e]+$/u.test(compact);
}

export function isSpeechClearlyDirectedAwayFromLumi(text: string): boolean {
  const compact = String(text || '').replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001]+/gu, '');
  if (!compact) return false;
  const mentionsTalkingToAssistant = /(?:\u5728\u8ddf|\u6b63\u5728\u8ddf|\u5728\u548c|\u6b63\u5728\u548c).{0,12}(?:AI|\u4eba\u5de5\u667a\u80fd|\u673a\u5668\u4eba|Lumi|\u9732\u7c73|\u7490\u7c73).{0,8}\u8bf4\u8bdd/i.test(compact);
  const tellsOtherPersonToWait = /\u4f60(?:\u4eec)?(?:\u5148)?(?:\u7b49\u4e00\u4e0b|\u7b49\u4f1a|\u7a0d\u7b49|\u522b\u8bf4\u8bdd|\u4e0d\u8981\u8bf4\u8bdd)/u.test(compact);
  return mentionsTalkingToAssistant && tellsOtherPersonToWait;
}

export function isVoiceReferentialFollowup(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 18) return false;
  const compact = raw
    .replace(/[\s\u3002\uFF01\uFF1F.!?\uFF0C,\u3001\u2026\uFF5E~\u201C\u201D\u2018\u2019]/gu, '')
    .toLowerCase();
  if (!compact) return false;
  if (/(?:\u6253\u5f00|\u542f\u52a8|\u8fd0\u884c|\u53d1\u9001|\u53d1\u7ed9|\u95ee\u4e00\u4e0b|\u8be2\u95ee|\u641c\u7d22|\u67e5\u627e|\u77e5\u8bc6\u5e93|\u6587\u4ef6|\u5fae\u4fe1|\u4e0d\u662f|\u9519\u4e86|\u6211\u8bf4\u7684|\u6211\u8ba9\u4f60)/u.test(compact)) return false;
  return /^(?:\u55ef|\u54e6|\u597d|\u597d\u7684|\u53ef\u4ee5|\u884c|\u6765\u5427|\u5f00\u59cb|\u7ee7\u7eed|\u63a5\u7740|\u987a\u7740|\u90a3\u4e2a|\u8fd9\u4e2a|\u5c31\u8fd9\u4e2a|\u5bf9|yes|ok|okay|go|continue|doit)$/u.test(compact);
}

export function mergeInterruptedVoiceTurn(
  pending: PendingInterruptedVoiceTurn | null | undefined,
  currentText: string,
  now = Date.now(),
  maxAgeMs = 30_000,
): { routingText: string; usedInterruptedTurn: boolean } {
  const current = String(currentText || '').trim();
  const prior = String(pending?.text || '').trim();
  const ageMs = pending ? now - pending.interruptedAt : Number.POSITIVE_INFINITY;
  const canUsePrior = Boolean(
    prior
    && current
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs <= maxAgeMs
    && isVoiceCorrectionContinuation(current),
  );
  if (!canUsePrior) return { routingText: current, usedInterruptedTurn: false };
  return {
    routingText: `${prior}\n\nUser correction to the interrupted request: ${current}`,
    usedInterruptedTurn: true,
  };
}
