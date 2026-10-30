import path from 'node:path';
import type { ToolExecutionRecord } from '../tools/types';
import { buildTaskTargetAnchorProjection, canonicalPathIdentity, sourceDocumentInstruction } from '../conversation/task_target_anchor';
import { FILE_NAME_RE } from '../conversation/targets/recognition';
import { targetReferenceMatches } from '../conversation/targets/paths';
import { parseReceiptObject, toolRecordSucceeded, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { normalizeActionIntent } from './normalized_action_intent';
import { COMPLETENESS_BOUNDARY_MESSAGES } from '../regions/messages/completeness_boundary_messages';

export const MISSING_TASK_INPUT_REASON = 'required_input_file_missing';
const FILE_READERS = new Set(['read_file', 'read_xlsx', 'read_docx', 'read_pdf', 'extract_document_text']);

// search_files returns path arrays during execution; only persisted display
// records use the summary shape. Reaching its 200-path cap is not absence proof.
function fileSearchResult(record: ToolExecutionRecord): Record<string, any> | null {
  const payload = toolRecordTerminalPayload(record);
  return Array.isArray(payload)
    ? { kind: 'desktop_files_summary', originalCount: payload.length, truncated: payload.length >= 200, entries: payload }
    : parseReceiptObject(payload);
}

/** Missing input is a user-input boundary. Callers fence receipts to this turn;
 * reader errors and complete scoped searches must retain the exact input role.
 */
export function missingTaskInputResult(taskText: string, records: ToolExecutionRecord[]): {
  text: string; blocked: true; reason: typeof MISSING_TASK_INPUT_REASON;
} | null {
  const sourceText = sourceDocumentInstruction(taskText);
  const intent = normalizeActionIntent(sourceText);
  // i18n-allow: existing source operations and standard user-folder recognition.
  if (!['read', 'inspect', 'edit'].includes(intent.operation)
    && !/读取|读入|分析|修改|根据|基于|\b(?:read|load|inspect|analy[sz]e|modify|edit|using|based on)\b/iu.test(sourceText)
    // i18n-allow: Existing source-input and standard user-folder recognition grammar.
    && !/合并|汇总|整合|\b(?:merge|combine)\b/iu.test(taskText)) return null;
  const primary = buildTaskTargetAnchorProjection({ taskText: sourceText }).target.path;
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(primary || '');
  // i18n-allow: Existing source-input and standard user-folder recognition grammar.
  const folder = /桌面|\bdesktop\b/iu.test(sourceText) ? 'Desktop'
    // i18n-allow: Existing source-input and standard user-folder recognition grammar.
    : /下载|\bdownloads\b/iu.test(sourceText) ? 'Downloads'
      // i18n-allow: Existing source-input and standard user-folder recognition grammar.
      : /文档(?:目录|文件夹)|\bdocuments\b/iu.test(sourceText) ? 'Documents' : '';
  const names = [...sourceText.matchAll(new RegExp(FILE_NAME_RE.source, 'giu'))].map(match => match[1]);
  const sources = absolute ? [primary] : folder ? names.map(name => canonicalPathIdentity('~/' + folder) + '/' + name) : [];
  for (const source of new Set(sources)) {
    const sourceId = canonicalPathIdentity(source);
    if (!sourceId) continue;
    const name = source.split(/[\\/]/u).at(-1)!;
    const directory = sourceId.slice(0, sourceId.lastIndexOf('/'));
    const latest = [...records].reverse().find(record => FILE_READERS.has(record.name)
      && canonicalPathIdentity(record.arguments?.filePath || record.arguments?.path) === sourceId);
    if (latest) {
      if (!latest.error || latest.adapterStarted === false) continue;
      const missingPath = latest.error.match(/^(?:(?:XLSX|DOCX|PDF|Audio)\s+)?file\s+(?:not found|does not exist):\s*(.+)$/iu)?.[1]
        || latest.error.match(/\bENOENT:\s*no such file or directory,\s*(?:open|stat|access)\s+['"](.+)['"]\s*$/iu)?.[1];
      if (!missingPath || canonicalPathIdentity(missingPath) !== sourceId) continue;
    } else {
      const observed = [...records].reverse().find(record => {
        if (record.name !== 'search_files' || !toolRecordSucceeded(record) || record.terminalVerification?.status !== 'verified') return false;
        const pattern = String(record.arguments?.pattern || '');
        if (!pattern || /[\\/\[\]{}!]/u.test(pattern) || !path.matchesGlob(name, pattern)
          || canonicalPathIdentity(record.arguments?.directory) !== directory) return false;
        const result = fileSearchResult(record);
        return result?.kind === 'desktop_files_summary' && Array.isArray(result.entries)
          && result.entries.every((entry: unknown) => typeof entry === 'string' && canonicalPathIdentity(entry).startsWith(directory + '/'));
      });
      const result = observed && fileSearchResult(observed);
      if (!result || result.entries.some((entry: string) => targetReferenceMatches(entry, name))
        || result.truncated !== false || result.originalCount !== result.entries.length || result.originalCount >= 200) continue;
    }
    const text = /[\u3400-\u9fff]/u.test(taskText)
      ? COMPLETENESS_BOUNDARY_MESSAGES.zh.missingSource(source, name, folder, absolute)
      : COMPLETENESS_BOUNDARY_MESSAGES.en.missingSource(source);
    return { text, blocked: true, reason: MISSING_TASK_INPUT_REASON };
  }
  return null;
}
