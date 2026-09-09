import { hasExplicitNoMutationInstruction, hasExplicitNoToolInstruction } from '../cognition/tool_intent';
import { resolveAcceptedTaskTarget } from './task_target_anchor';

/** Accept only the immediately preceding user-owned file plan. Assistant prose
 * cannot introduce a target or authorize additional actions. */
export function resolveAcceptedFilePlan(input: {
  text: string;
  history?: Parameters<typeof resolveAcceptedTaskTarget>[0]['persistedHistory'];
}): { text: string; sourceId: string } | undefined {
  // i18n-allow: exact acceptance of a preceding plan, not user-facing copy.
  if (!/^(?:请|现在)?(?:按|按照)(?:刚才|刚刚|之前)(?:的)?计划(?:来)?执行[。.!！\s]*$|^(?:now\s+)?(?:execute|run|follow)\s+(?:the\s+)?(?:previous|preceding|above)\s+plan[.!\s]*$/iu.test(input.text.trim())) return;
  const prior = [...(input.history || [])].reverse().find(row => row.role === 'user');
  const original = String(prior?.message || prior?.content || '').trim();
  if (!original || !hasExplicitNoToolInstruction(original)) return;
  const clauses = original.split(/[。！？!?;；\n]/u).map(value => value.trim()).filter(Boolean);
  const retained: string[] = [];
  for (const clause of clauses) {
    // i18n-allow: temporary planning-phase prohibitions, not permanent policy.
    const phaseOnly = hasExplicitNoToolInstruction(clause)
      || /^(?:暂时|现在|先)(?:不要|别)(?:读取文件|执行(?:操作|任务)?)[，,\s]*$/u.test(clause);
    if (phaseOnly) {
      // Do not discard a permanent constraint combined with a phase clause.
      if (hasExplicitNoMutationInstruction(clause)) return;
    } else retained.push(clause);
  }
  const text = retained.join('。');
  const target = resolveAcceptedTaskTarget({ text });
  if (!text || !target?.target.path || hasExplicitNoToolInstruction(text)) return;
  return { text, sourceId: prior?.id || prior?.requestId || '' };
}
