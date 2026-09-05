import { requireNotStrict } from '../config/privacy';

/** One bounded lifetime for an audio operation, including response bodies and polling. */
export function createTranscriptionControl(upstream?: AbortSignal, timeoutMs = 60 * 60_000) {
  const controller = new AbortController();
  const abort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abort();
  else upstream?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Audio transcription timed out.', 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abort);
    },
  };
}

/** Enforce privacy at every network step, including temporary upload/result URLs. */
export function transcriptionFetch(fetchImpl: typeof fetch, signal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal?.throwIfAborted();
    requireNotStrict('Cloud audio transcription');
    const response = await fetchImpl(input, { ...init, signal });
    signal?.throwIfAborted();
    return response;
  };
}
