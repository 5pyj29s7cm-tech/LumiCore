import { useCallback, useEffect, useRef, useState } from 'react';

// Each read belongs to one visible scope and one request. Timeout is an error;
// replacement/unmount cancellation cannot update the new owner's state.
export function useRecoverableRead<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000) {
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; error: string }>({ key, data: null, loading: Boolean(key), error: '' });
  const loader = useRef(load); loader.current = load;
  const owner = useRef(key); owner.current = key;
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    if (!key) { setState({ key, data: null, loading: false, error: '' }); return; }
    const controller = new AbortController(); request.current = controller;
    const current = () => owner.current === key && request.current === controller && !controller.signal.aborted;
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: '' }));
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      const data = await loader.current(signal);
      signal.throwIfAborted();
      if (current()) setState({ key, data, loading: false, error: '' });
    } catch (error) {
      if (current()) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Read failed' }));
    }
  }, [key, timeoutMs]);
  useEffect(() => { void refresh(); return () => { request.current?.abort(); }; }, [refresh]);
  const setData = useCallback((value: React.SetStateAction<T | null>) => {
    setState(previous => previous.key !== key ? previous : { ...previous, data: typeof value === 'function' ? (value as (previous: T | null) => T | null)(previous.data) : value });
  }, [key]);
  return { ...(state.key === key ? state : { data: null, loading: Boolean(key), error: '' }), refresh, setData };
}
