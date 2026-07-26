const RECEIPT_MARKER = '\n\u001eLUMI_TOOL_RECEIPT:';

export interface DecodedToolResult {
  content: string;
  receipt?: unknown;
}

/**
 * Keep a tool's human-readable result backward compatible while attaching a
 * machine-readable terminal receipt for the canonical executor. Direct legacy
 * callers still see the original content before the record-separator marker.
 */
export function encodeToolResult(content: string, receipt: unknown): string {
  return `${String(content || '')}${RECEIPT_MARKER}${JSON.stringify(receipt)}`;
}

export function decodeToolResult(value: string): DecodedToolResult {
  const raw = String(value || '');
  const markerIndex = raw.lastIndexOf(RECEIPT_MARKER);
  if (markerIndex < 0) return { content: raw };

  const content = raw.slice(0, markerIndex);
  const encodedReceipt = raw.slice(markerIndex + RECEIPT_MARKER.length).trim();
  if (!encodedReceipt) return { content: raw };
  try {
    return { content, receipt: JSON.parse(encodedReceipt) };
  } catch {
    // A malformed envelope is not proof. Preserve the complete raw output so
    // verification fails closed instead of silently discarding information.
    return { content: raw };
  }
}
