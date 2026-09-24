import type { ToolExecutionRecord } from '../tools/types';
import { buildTaskTargetAnchorProjection, canonicalPathIdentity, sourceDocumentInstruction } from '../conversation/task_target_anchor';
import { matchesRequestedArtifactOutput } from './artifact_write_scope';
import { normalizeActionIntent } from './normalized_action_intent';

export const MISSING_TASK_INPUT_REASON = 'required_input_file_missing';

const FILE_READERS = new Set(['read_file', 'read_xlsx', 'read_docx', 'read_pdf', 'extract_document_text']);

/** A missing required source is a user-input boundary, not a model retry.
 * Only consume local reader failures for the exact input named by the task.
 * Callers must fence these receipts to the current turn; old failures do not
 * revoke a later user's permission to retry after supplying the source.
 */
export function missingTaskInputResult(taskText: string, records: ToolExecutionRecord[]): {
  text: string; blocked: true; reason: typeof MISSING_TASK_INPUT_REASON;
} | null {
  const sourceText = sourceDocumentInstruction(taskText);
  const source = buildTaskTargetAnchorProjection({ taskText: sourceText }).target.path;
  if (!source || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(source)) return null;
  if (matchesRequestedArtifactOutput(taskText, source)) return null;
  const intent = normalizeActionIntent(sourceText);
  // A new output may legitimately be absent before creation. Only an explicit
  // read/edit task owns an existing input requirement.
  // i18n-allow: recognition of required source-file use, not user-facing text.
  if (!['read', 'inspect', 'edit'].includes(intent.operation)
    && !/(?:读取|读入|分析|修改|改成|改为|根据|基于)|\b(?:read|load|inspect|analy[sz]e|modify|edit|using|based on)\b/iu.test(sourceText)) return null;
  const sourceId = canonicalPathIdentity(source);
  const latest = records.slice().reverse().find(record => FILE_READERS.has(record.name)
    && canonicalPathIdentity(String(record.arguments?.filePath || record.arguments?.path || '')) === sourceId);
  if (!latest?.error || latest.adapterStarted === false) return null;
  // The handler's failure, not model narration or a string inside the file.
  // Match the missing filename in the error too: a missing parser/dependency
  // must not be presented as a missing user document.
  const missingPath = latest.error.match(/^(?:(?:XLSX|DOCX|PDF|Audio)\s+)?file\s+(?:not found|does not exist):\s*(.+)$/iu)?.[1]
    || latest.error.match(/\bENOENT:\s*no such file or directory,\s*(?:open|stat|access)\s+['"](.+)['"]\s*$/iu)?.[1];
  if (!missingPath || canonicalPathIdentity(missingPath) !== sourceId) return null;
  // i18n-allow: exact-path, receipt-grounded missing-input explanation.
  const text = /[\u3400-\u9fff]/u.test(taskText)
    ? `没有找到这项任务需要的源文件：${source}\n任务尚未完成。请补齐文件或提供正确路径，再让我继续原任务。`
    : `The required source file was not found: ${source}\nThe task is incomplete. Supply the file or correct its path, then ask me to continue the original task.`;
  return { text, blocked: true, reason: MISSING_TASK_INPUT_REASON };
}
