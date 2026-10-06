import { isGuardGeneratedConversationRecord } from "../../conversation/guard_history";
import type { ConversationTaskStatus } from "../task_execution_ledger";
import { parseNestedJson, toolRecordTerminalPayload } from "../../tools/receipt_payload";
import type { ActionContinuationHistoryItem } from './contracts';

// i18n-allow: Chinese input-recognition pattern; not user-visible copy.

export const REFERENTIAL_CONTEXT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function recordTimestamp(item: ActionContinuationHistoryItem): number | null {
  const value = String(item.timestamp || item.receivedAt || '').trim();
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function compact(value: unknown, limit = 700): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function compactAssistantState(value: unknown, status: ConversationTaskStatus): string {
  const exact = String(value || '').trim();
  // A bounded confirmation request is itself the user-visible authorization
  // boundary. Preserve its line structure so the durable pending checkpoint
  // can be byte-for-byte identical to the Socket terminal and transcript.
  // Oversized/untrusted state keeps the ordinary compact projection.
  if (status === 'waiting_confirmation' && exact.length <= 700) return exact;
  return compact(exact, 700);
}

export function recordRole(item: ActionContinuationHistoryItem): string {
  return String(item.role || item.type || '').toLowerCase();
}

export function recordText(item: ActionContinuationHistoryItem): string {
  if (isGuardGeneratedConversationRecord(item)) return '';
  const role = recordRole(item);
  if (role === 'assistant' || role === 'agent') {
    return compact(item.response || item.message || item.content || item.text);
  }
  return compact(item.message || item.content || item.text || item.response);
}

export function parseToolCalls(item: ActionContinuationHistoryItem): any[] {
  if (isGuardGeneratedConversationRecord(item)) return [];
  const parsed = parseNestedJson(item.toolCalls);
  return Array.isArray(parsed) ? parsed : [];
}

export function collectPathValues(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 4 || paths.size >= 5 || value == null) return;
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value.trim())) paths.add(value.trim().slice(0, 500));
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 12).forEach(item => collectPathValues(item, paths, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>)
      .slice(0, 24)
      .forEach(item => collectPathValues(item, paths, depth + 1));
  }
}

export function resultCarriesDirectSourcePath(toolName: string): boolean {
  return !/^(?:desktop_list_files|desktop_list_apps|desktop_running_processes)$/i.test(toolName);
}

export function toolCallName(call: any): string {
  return compact(call?.name || call?.toolName, 120);
}

export function toolCallArguments(call: any): Record<string, any> {
  const parsed = parseNestedJson(call?.arguments ?? call?.args);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any>
    : {};
}

export function toolCallResult(call: any): unknown {
  return toolRecordTerminalPayload({
    receipt: call?.receipt,
    result: call?.result,
  });
}

export function normalizeApplicationTarget(value: unknown): string {
  return compact(value, 500)
    .replace(/[\s。！？.!?，,；;：:、]+$/gu, '')
    .trim();
}

export function looksLikeApplicationTarget(value: string): boolean {
  const clean = normalizeApplicationTarget(value);
  if (!clean || /^https?:\/\//i.test(clean)) return false;
  if (/\.(?:png|jpe?g|gif|webp|bmp|pdf|docx?|xlsx?|pptx?|txt|md|csv|dxf|dwg|json)$/i.test(clean)) return false;
  return true;
}
