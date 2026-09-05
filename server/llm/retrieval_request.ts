/** Bound retrieval waits even when an SDK/transport ignores cancellation. */
export function runRetrievalRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const controller = new AbortController();
  if (callerSignal?.aborted) return Promise.reject(callerSignal.reason || new DOMException('Retrieval cancelled', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(controller.signal.reason));
    const onCallerAbort = () => controller.abort(callerSignal?.reason || new DOMException('Retrieval cancelled', 'AbortError'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(new DOMException('Retrieval request timed out', 'TimeoutError')), timeoutMs);
    }
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
