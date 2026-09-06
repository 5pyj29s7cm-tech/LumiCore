import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { KNOWLEDGE_RESULT_MESSAGES } from '../i18n/knowledge_result_messages';

/** Statistics prove an inventory/processing-state query, never a UI action or a content review. */
export function isKnowledgeInventoryRequest(taskText: string): boolean {
  const text = String(taskText || '');
  // i18n-allow: Recognition patterns for knowledge inventory, not response copy.
  if (!/(?:知识库|知识文件|knowledge\s*(?:base|files?))/iu.test(text)) return false;
  // i18n-allow: Reject other goals even when an inventory tool happened to run.
  if (/(?:打开|进入|跳转|切换|删除|移除|上传|添加|导入|重新索引|重建|读取正文|全文|内容|审阅|审查|总结|分析)|\b(?:open|navigate|switch|delete|remove|upload|add|import|reindex|rebuild|contents?|full\s*text|review|summari[sz]e|analy[sz]e)\b/iu.test(text)) return false;
  // i18n-allow: Read-only inventory and coverage requests.
  return /(?:查看|看看|看一下|查一下|查询|统计|数量|多少|哪些|文件|列表|清单|吸收|索引|处理|验证|状态)|\b(?:list|show|check|count|how\s+many|which|files?|inventory|status|coverage|absorbed|indexed|verified)\b/iu.test(text);
}

export function formatGroundedKnowledgeObservation(input: {
  taskText: string;
  toolRecords?: ToolExecutionRecord[];
  taskId?: string;
  requestId?: string;
}): string | null {
  if (!isKnowledgeInventoryRequest(input.taskText)) return null;
  const records = input.toolRecords || [];
  const record = [...records].reverse().find(item => (
    /^(?:knowledge_file_stats|knowledge_coverage_report)$/.test(item.name)
    && (!input.taskId || [item.taskId, item.envelope?.taskId].filter(Boolean).length > 0
      && [item.taskId, item.envelope?.taskId].filter(Boolean).every(id => id === input.taskId))
    && (!input.requestId || [item.requestId, item.turnId, item.envelope?.requestId, item.envelope?.turnId].filter(Boolean).length > 0
      && [item.requestId, item.turnId, item.envelope?.requestId, item.envelope?.turnId].filter(Boolean).every(id => id === input.requestId))
  ));
  // A newer failure must not be hidden by an older successful observation.
  if (!record || record.error || record.terminalVerification?.status !== 'verified') return null;
  if (record.envelope && record.envelope.status !== 'verified_success') return null;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  if (!payload || !Number.isSafeInteger(payload.totalFiles) || Number(payload.totalFiles) < 0 || !Array.isArray(payload.files)) return null;
  const files = payload.files as Array<{ name?: unknown; status?: unknown }>;
  if (files.length !== payload.totalFiles) return null;
  const copy = KNOWLEDGE_RESULT_MESSAGES[/[\u3400-\u9fff]/u.test(input.taskText) ? 'zh' : 'en'];
  type Status = keyof typeof copy.statuses;
  if (files.some(file => !file || typeof file.name !== 'string' || !file.name.trim()
    || typeof file.status !== 'string' || !Object.hasOwn(copy.statuses, file.status))) return null;
  if (files.length === 0) return copy.empty;
  const count = (...statuses: Status[]) => files.filter(file => statuses.includes(file.status as Status)).length;
  const lines = [copy.summary(files.length, count('verified'), count('indexed_unverified'), count('pending'), count('partial'), count('stale'), count('failed', 'unsupported'))];
  lines.push(count('verified') === files.length ? copy.complete : copy.incomplete);
  lines.push('', ...files.slice(0, 20).map(file => `- ${String(file.name).replace(/[\r\n\t]/g, ' ').slice(0, 240)} — ${copy.statuses[file.status as Status]}`));
  if (files.length > 20) lines.push(copy.more(files.length - 20));
  return lines.join('\n');
}
