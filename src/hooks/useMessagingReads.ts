import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/apiClient';

/** Read failures remain visible without discarding the last confirmed channel state. */
export function useMessagingReads() {
  const owner = useRef<AbortController | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const read = async (path: string) => {
    const controller = owner.current;
    if (!controller || controller.signal.aborted) throw new Error('Settings view closed');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    try {
      const response = await apiFetch(path, { signal });
      const data = await response.json(); signal.throwIfAborted();
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error(data?.error || `HTTP ${response.status}`);
      if (path.endsWith('/bindings') && !Array.isArray(data.bindings)) throw new Error('Invalid bindings response');
      setErrors(current => { const next = { ...current }; delete next[path]; return next; });
      return data;
    } catch (error) {
      if (!controller.signal.aborted) setErrors(current => ({ ...current, [path]: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  };
  return { read, error: Object.values(errors).join('; '), configFailed: Object.keys(errors).some(path => path.endsWith('/config')) };
}
