import { affirmativeActionClauses, negatedActionInstructions } from './action_instruction_clauses';
import { FILE_TASK_RE, FILE_NAME_RE, ABSOLUTE_FILE_RE, POSIX_ABSOLUTE_FILE_RE } from '../conversation/targets/recognition';
const EXPLICIT_NO_TOOL_PATTERNS: RegExp[] = [
  // i18n-allow: a complete current-turn "do not execute yet" clause, not a prohibition on one named operation.
  /(?:^|[，,。！？!?；;\n])\s*(?:(?:但|但是|不过)\s*)?(?:请)?(?:先|暂时|现在)?(?:不要|别|不用|无需|禁止|请勿)\s*(?:再|继续)?(?:执行|动手|操作)(?:了)?\s*(?=$|[，,。！？!?；;\n])/u,
  /(?:^|[.,;!?\n])\s*(?:please\s+)?(?:do\s+not|don't)\s+(?:execute|act|proceed|do\s+it)(?:\s+(?:yet|now))?\s*(?=$|[.,;!?\n])/iu,
  // i18n-allow: discussion-only planning requests, not user-facing copy.
  /(?:^|[。！？；;，,：:]|\s)(?:请)?(?:现在|这次|先)?(?:只|仅)(?:告诉我|说说|说明|解释)(?:你)?(?:准备|打算|计划)?(?:怎么做|如何做|怎样做|执行步骤|计划|方案)|(?:^|[。！？；;，,\n])\s*(?:请)?(?:这一步|这次|当前这一步)?\s*(?:先|只|仅)\s*(?:给(?:我)?|提供)\s*(?:具体的?)?(?:操作说明|操作步骤)\s*[。！!]*$/u,
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

/** A scoped veto on supplemental source lookups, independent of file-write prohibitions. */
export function hasExplicitNoLookupInstruction(text: string): boolean {
  const negative = negatedActionInstructions(text);
  if ([...affirmativeActionClauses(text), ...negative.map(clause => clause.text)]
    .some(clause => hasExplicitNoToolInstruction(clause))) return true;
  // i18n-allow: Lookup predicates reuse the shared quote/hypothesis/negation projection.
  return negative.some(clause => {
    // i18n-allow: Predicate modifiers and lookup operations in an already negated clause.
    const predicate = /^(?:(?:再(?:次)?|重新|继续|进行(?:任何)?|联网)\s*)*(?:查询|检索|搜索|浏览|补查|查资料|联网)|^(?:(?:again|further)\s+)*(?:search|query|retrieve|look\s+up|browse|fetch)\b/iu.exec(clause.instruction);
    if (!predicate) return false;
    // Object scope belongs to this lookup, not any later coordinated file action.
    // i18n-allow: Coordination delimiters and local scope qualifiers reuse shared file recognition.
    const objects = clause.instruction.slice(predicate[0].length).split(/或者|以及|并且|或|和|\s+(?:and|or)\s+/iu).map(value => value.trim());
    return !objects.every(object => FILE_NAME_RE.test(object) || ABSOLUTE_FILE_RE.test(object) || POSIX_ABSOLUTE_FILE_RE.test(object)
      // i18n-allow: Existing local-file operands in a negative action instruction.
      || ((FILE_TASK_RE.test(object) || /\b(?:files|documents|folders)\b/iu.test(object)) && /本地|桌面|\b(?:local|desktop)\b/iu.test(object)));
  });
}
