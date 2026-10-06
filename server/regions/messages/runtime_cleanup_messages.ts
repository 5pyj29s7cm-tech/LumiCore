export interface RuntimeCleanupReceiptProjection {
  ok?: boolean;
  status?: string;
  requestedTaskIds?: unknown;
  cancelledTaskIds?: unknown;
  cancellingTaskIds?: unknown;
  notCancelledTaskIds?: unknown;
  targetResults?: unknown;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').trim())
    .filter(Boolean)));
}

function joined(value: string[]): string {
  return value.join(', ');
}

/** Render only facts present in the canonical runtime cancellation receipt. */
export function formatRuntimeCleanupReceipt(
  userText: string,
  receipt: RuntimeCleanupReceiptProjection,
): string {
  const requested = ids(receipt.requestedTaskIds);
  const cancelled = ids(receipt.cancelledTaskIds);
  const cancelling = ids(receipt.cancellingTaskIds);
  const notCancelled = ids(receipt.notCancelledTaskIds);
  const alreadyTerminal = Array.isArray(receipt.targetResults)
    ? receipt.targetResults
      .filter(item => item && typeof item === 'object' && (item as any).status === 'already_terminal')
      .map(item => String((item as any).taskId || '').trim())
      .filter(Boolean)
    : [];
  const chinese = /[\u3400-\u9fff]/u.test(userText);

  if (requested.length === 0 && receipt.status === 'idle') {
    return chinese
      ? '\u5f53\u524d\u6ca1\u6709\u9700\u8981\u6e05\u7406\u7684\u540e\u53f0\u4efb\u52a1\u3002'
      : 'There are no background tasks to clean up.';
  }

  if (chinese) {
    return [
      cancelled.length ? `\u5df2\u53d6\u6d88\uff1a${joined(cancelled)}\u3002` : '',
      cancelling.length ? `\u6b63\u5728\u53d6\u6d88\uff1a${joined(cancelling)}\u3002` : '',
      alreadyTerminal.length ? `\u5df2\u7ec8\u6b62\uff0c\u65e0\u9700\u91cd\u590d\u53d6\u6d88\uff1a${joined(alreadyTerminal)}\u3002` : '',
      notCancelled.length ? `\u672a\u53d6\u6d88\uff1a${joined(notCancelled)}\u3002` : '',
      !cancelled.length && !cancelling.length && !alreadyTerminal.length && !notCancelled.length
        ? '\u8fd9\u6b21\u6ca1\u6709\u53d6\u6d88\u4efb\u4f55\u540e\u53f0\u4efb\u52a1\u3002'
        : '',
    ].filter(Boolean).join(' ');
  }

  return [
    cancelled.length ? `Cancelled: ${joined(cancelled)}.` : '',
    cancelling.length ? `Cancellation in progress: ${joined(cancelling)}.` : '',
    alreadyTerminal.length ? `Already terminal (not cancelled again): ${joined(alreadyTerminal)}.` : '',
    notCancelled.length ? `Not cancelled: ${joined(notCancelled)}.` : '',
    !cancelled.length && !cancelling.length && !alreadyTerminal.length && !notCancelled.length
      ? 'No background tasks were cancelled.'
      : '',
  ].filter(Boolean).join(' ');
}
