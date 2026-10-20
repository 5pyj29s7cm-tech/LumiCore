const EXPLICIT_NO_TOOL_PATTERNS: RegExp[] = [
  // i18n-allow: a complete current-turn "do not execute yet" clause, not a prohibition on one named operation.
  /(?:^|[，,。！？!?；;\n])\s*(?:(?:但|但是|不过)\s*)?(?:请)?(?:先|暂时|现在)?(?:不要|别|不用|无需|禁止|请勿)\s*(?:再|继续)?(?:执行|动手|操作)(?:了)?\s*(?=$|[，,。！？!?；;\n])/u,
  /(?:^|[.,;!?\n])\s*(?:please\s+)?(?:do\s+not|don't)\s+(?:execute|act|proceed|do\s+it)(?:\s+(?:yet|now))?\s*(?=$|[.,;!?\n])/iu,
  // i18n-allow: discussion-only planning requests, not user-facing copy.
  /(?:^|[。！？；;，,：:]|\s)(?:请)?(?:现在|这次|先)?(?:只|仅)(?:告诉我|说说|说明|解释)(?:你)?(?:准备|打算|计划)?(?:怎么做|如何做|怎样做|执行步骤|计划|方案)/u,
  /\b(?:first\s+)?(?:only|just)\s+(?:tell\s+me|explain|describe)\s+(?:how\s+you\s+(?:would|plan\s+to)|(?:the|your)\s+plan)\b/iu,
  /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u7528)\s*(?:\u518d)?(?:\u6267\u884c|\u8fdb\u884c|\u505a)\s*(?:\u4efb\u4f55|\u65b0\u7684?|\u5176\u4ed6|\u5176\u5b83)?\s*(?:\u64cd\u4f5c|\u52a8\u4f5c|\u4efb\u52a1)/u,
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  /(?:不要|别|无需|不需要|不用|禁止|请勿|勿)\s*(?:再|继续|再次)?\s*(?:调用|使用|执行|启动)?\s*(?:(?:任何|这些|外部|新(?:的)?|其他|其它)\s*){0,3}(?:工具|插件|技能|脚本)(?!(?:说明|介绍|解释|清单|列表|文档))/u,
  /不\s*(?:再|继续)?\s*(?:调用|使用|执行|启动)\s*(?:(?:任何|这些|外部|新(?:的)?|其他|其它)\s*){0,3}(?:工具|插件|技能|脚本)/u,
  // i18n-allow: Multilingual no-tool instruction recognition; not user-visible copy.
  /(?:只|仅)\s*(?:回复|回答|解释|复述|确认)\s*[,，、]?\s*(?:不要|别|无需|不用)\s*(?:调用|使用|执行)?\s*(?:工具|插件|技能|脚本)/u,
  /\b(?:do\s+not|don't|without|no)\s+(?:call(?:ing)?|use|using|run(?:ning)?|execute|executing)?\s*(?:any\s+)?(?:tools?|plugins?|skills?|scripts?)\b/i,
  /\b(?:reply|answer|explain|repeat)\s+only\b[^.!?\n]{0,24}\b(?:no|without)\s+(?:tools?|plugins?|skills?|scripts?)\b/i,
];

/** A hard, current-turn veto shared by chat and voice tool routing. */
export function hasExplicitNoToolInstruction(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  // i18n-allow: Multilingual double-negation input recognition; not user-visible copy.
  if (/(?:不是|并非|并不是)\s*(?:不要|别|不用|无需).{0,8}(?:工具|插件|技能|脚本)/u.test(normalized)) {
    return false;
  }
  return EXPLICIT_NO_TOOL_PATTERNS.some(pattern => pattern.test(normalized));
}
