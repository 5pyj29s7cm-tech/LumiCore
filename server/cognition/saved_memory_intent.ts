import { affirmativeActionClauses } from './action_instruction_clauses';
import { isStoredMemoryRecallQuestion, normalizeActionIntent } from './normalized_action_intent';
import { hasExplicitToolIntent } from './tool_intent';

/** Saved-memory lookup is supplied by channel context, not web/file tools. */
export function isSavedMemoryLookupOnlyRequest(text: string): boolean {
  const clauses = affirmativeActionClauses(text).map(clause => clause.trim()).filter(Boolean);
  let lookup = false;
  for (const clause of clauses) {
    if (isStoredMemoryRecallQuestion(clause)) continue;
    // i18n-allow: Explicit lookup of the current user's saved memories only.
    const prefix = clause.match(/^(?:(?:请|请帮我|帮我)\s*)*(?:查询|搜索|检索|查找|读取|查看)\s*(?:(?:我(?:的)?|我们(?:的)?|已保存的?|保存的?|跨会话的?|长期|历史|以前的?|之前的?)\s*)+记忆|^(?:please\s+)?(?:search|query|retrieve|read|check|look\s+up)\s+(?:(?:(?:my|our|the|saved|stored|cross-session|long-term|previous|past)\s+)+memories|(?:(?:my|our|the)\s+)?(?:saved|stored|cross-session|long-term)\s+memory)\b/iu)
      // i18n-allow: Legacy lookup-name phrasing still denotes local saved-memory data, not a new tool.
      || (/\b(?:my\s+)?(?:saved|stored|cross-session)\s+memories\b/iu.test(clause)
        ? clause.match(/^(?:please\s+)?(?:use|call)\s+memory_search\s+to\s+(?:look\s+up|search|retrieve|query)\b/iu) : null);
    if (!prefix) return false;
    const remainder = clause.slice(prefix[0].length);
    // i18n-allow: A memory-named filesystem operand still requires the file owner.
    if (/^\s*(?:\.[a-z0-9]|文件|文档|目录|\b(?:file|document|folder|directory)\b)/iu.test(remainder)) return false;
    // A second coordinated command must still reach normal action planning.
    // i18n-allow: Coordination grammar, deliberately not an action-verb inventory.
    if (/(?:并且|然后|接着|(?<!合)并)|\b(?:and\s+then|then|afterwards|also)\b|\band\s+(?:please\s+)?\w+/iu.test(remainder)) return false;
    // i18n-allow: Short Chinese sequence markers defer their following action to the existing intent owner.
    if (remainder.split(/之后|以后|后|再/u).slice(1).some(part => hasExplicitToolIntent(part))) return false;
    if (normalizeActionIntent(clause).kind !== 'none') return false;
    lookup = true;
  }
  return lookup;
}
