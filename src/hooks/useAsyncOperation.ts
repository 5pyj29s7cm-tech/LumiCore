import { useCallback, useEffect, useRef, useState } from 'react';

/** Mount under an account/scope key. Only the current operation may commit its result. */
export function useAsyncOperation() {
  const [state, setState] = useState({ busy: '', error: '' });
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    return () => { owner.abort(); pending.current = null; };
  }, []);
  const cancel = useCallback(() => {
    pending.current?.abort(); pending.current = null;
    setState({ busy: '', error: '' });
  }, []);
  const run = useCallback(async (kind: string, operation: (signal: AbortSignal) => Promise<() => void>, timeout = 15_000) => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || pending.current) return false;
    const request = new AbortController(); pending.current = request;
    const signal = AbortSignal.any([owner.signal, request.signal, AbortSignal.timeout(timeout)]);
    const current = () => !owner.signal.aborted && pending.current === request;
    setState({ busy: kind, error: '' });
    let onAbort: (() => void) | undefined;
    try {
      const commit = await new Promise<() => void>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        operation(signal).then(resolve, reject);
      });
      signal.throwIfAborted();
      if (!current()) return false;
      commit(); return true;
    } catch (error) {
      if (current()) setState({ busy: '', error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (current()) { pending.current = null; setState(value => ({ ...value, busy: '' })); }
    }
  }, []);
  return { ...state, run, cancel };
}
