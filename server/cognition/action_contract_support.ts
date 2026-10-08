import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordHasTerminalPayload, toolRecordTerminalPayload, toolRecordTerminalText } from '../tools/receipt_payload';

export function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function parseRecordJson(record: ToolExecutionRecord): Record<string, any> | null {
  return parseReceiptObject(toolRecordTerminalPayload(record));
}

export function expandSuccessfulRecords(records: ToolExecutionRecord[]): ToolExecutionRecord[] {
  const expanded: ToolExecutionRecord[] = [];
  for (const record of records) {
    if (
      record.error
      || !toolRecordHasTerminalPayload(record)
      || (record.terminalVerification && record.terminalVerification.status !== 'verified')
    ) continue;
    expanded.push(record);
    if (record.name !== 'work_takeover_task_run_suggested_tool') continue;
    const payload = parseRecordJson(record);
    const run = payload?.run;
    if (!run || run.status !== 'completed' || !run.toolName || !String(run.result || '').trim()) continue;
    expanded.push({
      id: run.id,
      name: String(run.toolName),
      arguments: run.toolArgs && typeof run.toolArgs === 'object' ? run.toolArgs : {},
      result: String(run.result),
    });
  }
  return expanded;
}

export function recordText(record: ToolExecutionRecord): string {
  return `${record.name}\n${JSON.stringify(record.arguments || {})}\n${String(record.result || '')}`;
}

export { toolRecordTerminalText as terminalPayloadText } from '../tools/receipt_payload';

export function hasVisualModelAvailabilityEvidence(
  records: ToolExecutionRecord[] = [],
): boolean {
  return expandSuccessfulRecords(records).some(record => {
    if (!/^(?:ocr_screen|ocr_region|computer_vision|vision_analyze|image_understanding)$/i.test(String(record.name || ''))) {
      return false;
    }
    const payload = toolRecordTerminalPayload(record);
    const text = toolRecordTerminalText(record);
    if (!text || /^\s*(?:\{\s*\}|\[\s*\])\s*$/u.test(text)) return false;
    if (
      payload && typeof payload === 'object' && !Array.isArray(payload)
      && (
        compact((payload as Record<string, any>).error)
        || compact((payload as Record<string, any>).note)
        || (payload as Record<string, any>).format === 'screenshot_base64'
      )
    ) return false;
    return !/(?:No configured visual-perception model|access denied|account is not in good standing|overdue|insufficient balance|\u6b20\u8d39|\u4f59\u989d\u4e0d\u8db3)/iu.test(text);
  });
}
