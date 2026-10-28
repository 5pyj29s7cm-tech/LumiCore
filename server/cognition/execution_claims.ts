/** Shared by streamed previews and terminal replies: immediate first-person
 * execution promises require a real execution path, even on conversational turns. */
export function hasImmediateExecutionPromise(value: string): boolean {
  // i18n-allow: A short imperative promise can omit the first-person pronoun.
  if (/^(?:好的?[，,\s]*)?(?:我)?(?:这就|马上|现在就)(?:帮你|为你|给你)?(?:打开|播放|启动|发送|生成|创建)[^？?\n]{1,80}[。.!！]?$/u.test(value.trim())) return true;
  const unquoted = String(value || '')
    .replace(/```[\s\S]*?```|`[^`]*`|[“「『][^”」』]*[”」』]|"[^"\n]*"/gu, ' ');
  return unquoted.split(/[。！？.!?\n]/u).some(clause => {
    // i18n-allow: Exclude hypothetical, reported, negated and explanatory speech.
    if (/(?:如果|假如|假设|例如|比如|之前|刚才|上次|不该|不应|不能|不会|没有|并未|我说过|我反复说)|\b(?:if|example|previously|earlier|said|shouldn't|cannot|can't|won't|didn't)\b/iu.test(clause)) return false;
    // i18n-allow: Immediate observable action promises, including multi-sentence replies.
    return /(?:我(?:这就|现在|马上|立即|来|再|会立即)|(?:现在|这次|这一轮)我(?:再|真正|会|就)?|我这就调用)[^？?\n]{0,24}(?:生成|调用|发起|发一次|试一次|重试|执行|打开|播放|发送|创建|写入|保存)|\bI\s*(?:will|['’]ll|am going to)\b[^.!?\n]{0,45}\b(?:generate|retry|execute|open|play|send|create|write|save)\b/iu.test(clause);
  });
}

const TERMINAL_EXECUTION_CLAIM_RE =
  /(?:\b(?:workflow|task|step|operation|action|write|open|send|save|transcription|verification|review)?\s*(?:completed|succeeded|successful|done|finished|saved|written|opened|sent|verified)\b|\b(?:workflow|task|operation|file|document|transcription|verification|review)\s+(?:is\s+)?(?:complete|completed|done|finished|saved|written|verified)\b|\b(?:i(?:'ve| have| am|'m)|we(?:'ve| have| are|'re))\b[^.!?\n]{0,48}\b(?:completed|finished|saved|written|opened|sent|created|generated|executing|processing)\b|\bsuccess(?:fully)?\b|\u5df2(?:\u7ecf)?(?:\u5b8c\u6210|\u5199\u597d|\u5199\u5b8c|\u6253\u5f00|\u521b\u5efa|\u65b0\u5efa|\u53d1\u9001|\u4fdd\u5b58|\u5199\u5165|\u5bfc\u51fa|\u751f\u6210|\u6267\u884c|\u5904\u7406)|(?:\u6587\u4ef6|\u6587\u6863|\u4efb\u52a1|\u5de5\u4f5c|\u8f6c\u5199|\u8bc6\u522b|\u590d\u6838|\u9a8c\u8bc1|\u4e0b\u8f7d|\u5904\u7406)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u5df2(?:\u7ecf)?|\u6210\u529f)?(?:\u5b8c\u6210|\u5199\u5b8c|\u5199\u597d|\u641e\u5b9a|\u4fdd\u5b58|\u6210\u529f)(?:\u4e86)?|(?:\u5b8c\u6210|\u5199\u597d|\u5199\u5b8c|\u641e\u5b9a|\u4fdd\u5b58|\u6253\u5f00|\u521b\u5efa|\u65b0\u5efa|\u53d1\u9001|\u5bfc\u51fa|\u751f\u6210|\u6267\u884c|\u5904\u7406)(?:\u597d|\u5b8c)?\u4e86|\u6267\u884c\u6210\u529f|\u64cd\u4f5c\u6210\u529f|\u6210\u529f(?:\u5b8c\u6210|\u6253\u5f00|\u5199\u5165|\u521b\u5efa|\u53d1\u9001|\u4fdd\u5b58|\u5bfc\u51fa)|(?:\u6211|\u6211\u4eec|\u8fd9\u8fb9)[^\u3002\uff01\uff1f.!?\n]{0,24}(?:\u73b0\u5728|\u9a6c\u4e0a|\u6b63\u5728)[^\u3002\uff01\uff1f.!?\n]{0,18}(?:\u6267\u884c|\u5904\u7406|\u5199\u5165|\u6253\u5f00|\u4fdd\u5b58|\u53d1\u9001|\u751f\u6210))/iu;

/** The existing stream marker grammar, shared without changing stream behavior. */
export function hasTerminalExecutionClaim(value: string): boolean {
  return TERMINAL_EXECUTION_CLAIM_RE.test(String(value || ''));
}

// This is a subset of the terminal grammar above, not a new action vocabulary.
// A bare completion word can describe an inline calculation without a tool.
const CONCRETE_EXECUTION_PREDICATE_RE = /写好|写完|打开|创建|新建|发送|保存|写入|导出|生成|执行|处理|\b(?:saved|written|opened|sent|created|generated|executing|processing)\b/iu; // i18n-allow: Existing terminal execution predicates.

export function hasConcreteTerminalExecutionClaim(value: string): boolean {
  for (const match of String(value || '').matchAll(new RegExp(TERMINAL_EXECUTION_CLAIM_RE.source, 'giu'))) {
    if (CONCRETE_EXECUTION_PREDICATE_RE.test(match[0])) return true;
  }
  return false;
}
