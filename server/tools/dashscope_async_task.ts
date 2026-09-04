export type DashScopeRemoteCancelOutcome =
  | 'remote_cancelled'
  | 'remote_cancel_rejected_state'
  | 'remote_cancel_failed';

export interface DashScopeRemoteCancelResult {
  outcome: DashScopeRemoteCancelOutcome;
  httpStatus?: number;
  errorCode?: string;
}

const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;

/**
 * Best-effort cancellation for a submitted DashScope asynchronous task.
 *
 * DashScope only permits cancellation while a task is still PENDING. This
 * request deliberately owns its AbortController: callers invoke it after the
 * generation signal has already been aborted, so reusing that signal would
 * prevent the cancellation request from ever leaving the process.
 */
export async function cancelDashScopeTaskBestEffort(
  taskId: string,
  apiKey: string,
  timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
): Promise<DashScopeRemoteCancelResult> {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedApiKey = String(apiKey || '').trim();
  if (!normalizedTaskId || !normalizedApiKey) return { outcome: 'remote_cancel_failed' };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('DashScope remote cancellation timed out', 'TimeoutError')),
    Math.max(1, timeoutMs),
  );

  try {
    const response = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(normalizedTaskId)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${normalizedApiKey}` },
        signal: controller.signal,
      },
    );
    if (response.ok) {
      return { outcome: 'remote_cancelled', httpStatus: response.status };
    }

    let errorCode = '';
    try {
      const body = await response.json() as { code?: unknown };
      errorCode = String(body?.code || '').trim();
    } catch {
      // A non-JSON error remains a failed cancellation, never a confirmed one.
    }
    if (response.status === 400 && errorCode === 'UnsupportedOperation') {
      return {
        outcome: 'remote_cancel_rejected_state',
        httpStatus: response.status,
        errorCode,
      };
    }
    return {
      outcome: 'remote_cancel_failed',
      httpStatus: response.status,
      ...(errorCode ? { errorCode } : {}),
    };
  } catch {
    return { outcome: 'remote_cancel_failed' };
  } finally {
    clearTimeout(timeout);
  }
}
