/** Bound even an adapter that ignores abort; late results can never update the caller. */
export async function withRequestDeadline<T>(request: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, milliseconds = 10_000): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}
