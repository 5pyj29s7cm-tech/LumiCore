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
