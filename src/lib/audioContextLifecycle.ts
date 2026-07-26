export type ClosableAudioContext = Pick<AudioContext, 'state' | 'close'>;

const closeOperations = new WeakMap<object, Promise<void>>();

/**
 * AudioContext.close() rejects when lifecycle callbacks race. Treat cleanup as
 * an idempotent best-effort operation so interrupt, disconnect, and unmount can
 * safely converge on the same context without an unhandled rejection.
 */
export function closeAudioContext(context: ClosableAudioContext | null | undefined): Promise<void> {
  if (!context || context.state === 'closed') return Promise.resolve();
  const key = context as object;
  const existing = closeOperations.get(key);
  if (existing) return existing;

  const operation = Promise.resolve()
    .then(async () => {
      if (context.state !== 'closed') await context.close();
    })
    .catch(() => {
      // Cleanup must remain failure-soft. The context is no longer retained by
      // callers after this function is scheduled, so retrying would only race.
    });
  closeOperations.set(key, operation);
  return operation;
}
