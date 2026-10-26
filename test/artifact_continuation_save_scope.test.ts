import { describe, expect, it } from 'vitest';
import { normalizeActionIntent, hasAffirmativeArtifactMutationAction } from '../server/cognition/normalized_action_intent';
import { needsCompletionEvidence } from '../server/work_product/completion_guard';
describe('existing artifact actions after a continuation prefix',()=>{
 it.each([
  'Save the analysis as D:/synthetic/findings.docx and return the document here.',
  'Continue the same task: save the analysis as D:/synthetic/findings.docx and return the document here.',
  'Please continue the same task: save the summary as D:/synthetic/summary.pdf.',
  'Resume this task: export the notes to D:/synthetic/notes.txt.',
  '将分析保存为 D:/synthetic/分析.docx。',
  '继续同一任务：将分析保存为 D:/synthetic/分析.docx。',
  '请继续当前任务：把结果另存为 D:/synthetic/结果.pdf。',
 ])('requires real artifact evidence for %s',task=>{expect(normalizeActionIntent(task).sideEffectClass).toBe('local_write');expect(needsCompletionEvidence(task)).toBe(true);});
 it.each([
  'Continue the same task: do not save D:/synthetic/findings.docx. Answer in this chat only.',
  'Please continue the same task: no need to save the analysis as D:/synthetic/findings.docx.',
  'Continue the same task: explain the analysis. Do not create or save files.',
  '继续同一任务：不要把分析保存为 D:/synthetic/分析.docx，只在聊天回答。',
  '请继续当前任务：不另存为 D:/synthetic/结果.pdf，只解释已有内容。',
  'If I continued the same task: save the analysis as D:/synthetic/findings.docx, what would change?',
  'Continue the same task: explain why saving a file can be useful; do not create files.',
 ])('keeps negated, quoted and hypothetical artifact wording non-actionable: %s',task=>{expect(hasAffirmativeArtifactMutationAction(task)).toBe(false);expect(normalizeActionIntent(task).sideEffectClass).toBe('none');expect(needsCompletionEvidence(task)).toBe(false);});
 it('does not treat a quoted continuation sentence as artifact mutation authorization',()=>{const task='Explain this quoted instruction: "Continue the same task: save the analysis as D:/synthetic/findings.docx."';expect(hasAffirmativeArtifactMutationAction(task)).toBe(false);expect(normalizeActionIntent(task).sideEffectClass).toBe('none');});
});
