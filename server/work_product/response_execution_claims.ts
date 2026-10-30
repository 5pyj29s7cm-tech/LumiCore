import { actionInstructionClauses, affirmativeActionInstructionClauses } from '../cognition/action_instruction_clauses';
import { hasConcreteTerminalExecutionClaim, hasImmediateExecutionPromise, hasTerminalExecutionClaim } from '../cognition/execution_claims';
import { withoutLocationLiterals } from '../cognition/location_literals';
import { claimsCurrentAppSaveCompletion } from '../cognition/action_request';
import { ABSOLUTE_FILE_RE, FILE_NAME_RE, POSIX_ABSOLUTE_FILE_RE } from '../conversation/targets/recognition';

export type ResponseExecutionClaim = { kind: 'artifact' | 'read' | 'source' | 'source_verification' | 'send' | 'open' | 'generic'; text: string; immediate: boolean };

/** Reply evidence requirements only. These declarations never authorize an action. */
export function responseExecutionClaims(response: string): { claims: ResponseExecutionClaim[]; deferred: boolean } {
  const claims: ResponseExecutionClaim[] = [];
  // The affirmative projection omits hypothetical clauses altogether. Remember
  // their existence separately; an independent claim below still wins.
  // i18n-allow: Explicit future-input explanations, not completed actions.
  let hasDeferred = actionInstructionClauses(response).some(({ probe }) => /(?:如果|假如|假设|确认后再|请先核对|请(?:先)?把[^。！？!?\n]{0,80}告诉我)|\b(?:if\s+you|once\s+you|after\s+you)\b/iu.test(probe));
  let waitingForInput = false;
  let priorEnd = -1;
  for (const clause of affirmativeActionInstructionClauses(response)) {
    if (clause.start !== priorEnd) waitingForInput = false;
    let text = withoutLocationLiterals(clause.probe).trim();
    // i18n-allow: Pending user-input grammar, not an action vocabulary or UI copy.
    const pendingInput = /(?:请(?:先)?(?:确认|补齐|补充|提供)|(?:等|待)你|你(?:回复|补齐|确认)[^。！？!?；;\n]{0,32}(?:后|→)|(?:在)?你确认[^。！？!?；;\n]{0,32}后)|\b(?:once\s+you|after\s+you|please\s+(?:confirm|provide))\b/iu.test(text)
      && !/(?:已经|已)确认|\byou\s+have\s+(?:already\s+)?confirmed\b/iu.test(text);
    // A new independent present-tense promise ends a preceding comma-delimited
    // condition. Semicolons and sentence boundaries end it unconditionally.
    // i18n-allow: First-person temporal scope in a model reply.
    const independentNow = /^(?:(?:但是|不过|但)\s*)?(?:(?:现在|马上|这就)我|我(?:现在|马上|这就|先|正在))|\bI\s+(?:will\s+now|am\s+(?:now\s+)?(?:opening|creating|sending|writing|reading))\b/iu.test(text);
    const deferred = pendingInput || (waitingForInput && !independentNow);
    waitingForInput = deferred && /[，,]\s*$/u.test(clause.text);
    priorEnd = clause.start + clause.text.length;
    if (deferred) { hasDeferred = true; continue; }

    // Metadata is not an artifact. Match the metadata subject directly, so
    // "the log shows the report was saved" still has a real file-save claim.
    // i18n-allow: Receipt-subject and negated reported-action grammar.
    text = text.replace(/^(?:(?:上一轮|本轮|已保存的)\s*)?(?:回执|执行记录|任务账本|(?:the\s+)?(?:receipt|execution\s+log))\s*(?:(?:已经|已|was|is|has\s+been)\s*)?(?:保存|saved|显示执行成功)/iu, '').trim();
    // i18n-allow: Negative execution claims stay negative after quotation projection.
    if (/^(?:(?:本轮|当前|我|我们)\s*)*(?:没有|并未|尚未|未|不曾)|^(?:I\s+)?(?:have\s+not|haven't|did\s+not|didn't)\b/iu.test(text)) { hasDeferred = true; continue; }
    // i18n-allow: Instructions addressed to the user are advice, not Lumi execution.
    hasDeferred ||= /^(?:你可以|请你|请(?:先)?(?:读取|打开|保存))|^(?:you\s+(?:can|should|may|need\s+to)|please\s+(?:read|open|save)|to\s+(?:read|open|save))\b/iu.test(text);
    // i18n-allow: A source-context preface and self-reflection are not new external work.
    if (/^(?:根据|基于|依据)[^，,。！？!?\n]{0,24}(?:刚才|之前|已经读出|已读)|(?:自己|自身)[^，,。！？!?\n]{0,24}(?:能力|理解)/u.test(text)) continue;
    // i18n-allow: Interrogative reported speech is not an asserted execution.
    if (/^(?:did|have|had|would|could)\s+(?:I|we)\s+(?:say|said|claim|claimed|mean|meant)\b/iu.test(text)
      && /[?？]\s*$/u.test(text)) continue;

    // The shared terminal grammar handles existing completion predicates.
    // These two additional forms distinguish a physical source-read or a
    // recipient-directed send from an inline answer such as "analysis complete".
    // i18n-allow: Completed source reads and recipient-directed delivery predicates.
    const read = /(?:已(?:经)?(?:重新)?(?:读取|读出|阅读)|已(?:经)?核对原件)|\b(?:I|we)\s+(?:have\s+)?(?:read|re-?read|reviewed|inspected)\b/iu.test(text)
      && (responseClaimFileTargets(clause.probe).length > 0
        // i18n-allow: Physical document operands, excluding conversational reading.
        || /(?:文件|文档|附件|原件|正文)|\b(?:the|this|that|attached|source)\s+(?:file|document|attachment|report)\b/iu.test(text));
    const send = /(?:已(?:经)?发送|(?:已|把)[^。！？!?；;\n]{0,48}发给[^。！？!?；;\n]{1,48}了)|\b(?:sent|delivered)\b/iu.test(text);
    // i18n-allow: Asserted source search/inspection, excluding inline calculation checks.
    const source = /^(?:(?:我|我们|本轮)\s*)?已(?:经)?(?:检索|查询)(?:并|且)(?:核验|查阅)|\b(?:I|we)\s+have\s+searched\s+and\s+verified\b/iu.test(text)
      // i18n-allow: A source operand makes a standalone completed search explicit.
      || /^(?:(?:我|我们|本轮)\s*)?已(?:经)?(?:检索|查询|核验|查阅)[^。！？!?\n]{0,32}(?:来源|网页|网站)|\b(?:I|we)\s+have\s+(?:searched|verified|checked)[^.!?\n]{0,32}\b(?:sources?|websites?|webpages?)\b/iu.test(text);
    // i18n-allow: Immediate execution status, including short standalone replies.
    const immediate = hasImmediateExecutionPromise(text)
      || /^(?:我)?(?:现在就做|马上动手|正在执行)[。.!！]?$/u.test(text)
      // i18n-allow: First-person source-reading execution-promise grammar.
      || /(?:我(?:先|立即|现在就开始)|接下来我会先)[^。！？!?；;\n]{0,24}(?:读取|检查|审查|执行)|\bI\s+(?:will|am\s+going\s+to)\s+(?:read|review|inspect|check)\b/iu.test(text);
    // A past participle in guidance or a third-party sentence is not by itself
    // the assistant's claim. Keep explicit first-person, bare completion, and
    // completed file/document subjects; quoted text was removed above.
    // i18n-allow: Execution-claim subject/tense grammar, not an authorization rule.
    const ownsAction = /(?:我|我们)(?:已经|已|现在|正在|马上|先)|^(?:(?:并|并且)\s*)?(?:本轮|当前|已(?:经)?|成功|写好|写完|保存|打开|创建|新建|发送|把)|\b(?:I|we)\s+(?:have\s+|am\s+|are\s+)?(?:saved|written|opened|sent|created|generated|read|reviewed|inspected)|^(?:saved|written|opened|sent|created|generated)\s+(?!(?:files|documents)\b)|(?:文件|文档|报告|结果)[^。！？!?\n]{0,24}(?:已|保存成功)|\b(?:the\s+)?(?:file|document|report|result)\s+(?:(?:was|is|has\s+been)\s+)?(?:saved|written|opened|sent|created|generated)\b/iu.test(text)
      || responseClaimFileTargets(clause.probe).length > 0 && /(?:已|已经)|\b(?:was|has\s+been)\s+(?:saved|written|created|read)\b/iu.test(text);
    const concrete = ownsAction && (hasConcreteTerminalExecutionClaim(text) || claimsCurrentAppSaveCompletion(text));
    // A bare acknowledgement has no analytical object. Longer ordinary facts
    // and reflective statements do not become external execution assertions.
    // i18n-allow: Bare task completion and explicit first-person physical-project claims.
    const generic = hasTerminalExecutionClaim(text) && (/^(?:(?:所有|任务|操作|工作|合并|文件|已经|已|成功|the\s+task\s+is|the\s+task|is|task|operation)\s*)*(?:完成|完成了|搞定|completed|complete|done|finished|successful)(?:\s+successfully)?[。.!！\s]*$/iu.test(text)
      || /(?:我|我们)(?:已经|已)完成了?(?:项目|工程)/u.test(text));
    if (!(ownsAction && (read || send)) && !source && !immediate && !concrete && !generic) continue;
    // i18n-allow: Categorize existing predicates for receipt selection, not permission.
    // i18n-allow: Source verification is a stronger claim than retrieving text.
    const sourceVerification = source && /核验|\bverified\b/iu.test(text);
    const kind = send ? 'send' : read ? 'read' : sourceVerification ? 'source_verification' : source ? 'source'
      // i18n-allow: Artifact predicates select the matching receipt category only.
      : /(?:保存|写好|写完|写入|创建|新建|生成|导出)|\b(?:save|saved|write|written|create|created|generate|generated|exported)\b/iu.test(text) ? 'artifact'
        // i18n-allow: Existing open predicates select a receipt category, not UI copy.
        : /(?:打开)|\b(?:open|opened|opening)\b/iu.test(text) ? 'open' : 'generic';
    claims.push({ kind, text: clause.text, immediate });
  }
  return { claims, deferred: hasDeferred };
}

/** Reuse existing file operand grammar; this never turns a reply into a task. */
export function responseClaimFileTargets(text: string): string[] {
  const targets: string[] = [];
  let rest = text;
  for (const pattern of [ABSOLUTE_FILE_RE, POSIX_ABSOLUTE_FILE_RE]) {
    rest = rest.replace(new RegExp(pattern.source, 'giu'), target => { targets.push(target.trim()); return ' '; });
  }
  for (const match of rest.matchAll(new RegExp(FILE_NAME_RE.source, 'giu'))) targets.push(match[1].trim());
  return targets;
}
