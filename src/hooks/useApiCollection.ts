import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiJson } from '../services/apiClient';

/** Mount under an account/scope key; only confirmed responses change the list. */
export function useApiCollection<T extends { id: string }>(endpoint: string, isItem: (value: any) => value is T, collectionKey?: string, identity: keyof T = 'id') {
  const [items, setItems] = useState<T[] | null>(null);
  const [state, setState] = useState({ busy: true, error: '' });
  const lifetime = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null);
  const sync = useCallback(async (method = 'GET', id = '', body?: unknown, action = '') => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted || (pending.current && !pending.current.aborted)) return false;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    pending.current = signal;
    setState({ busy: true, error: '' });
    try {
      const data = await apiJson(endpoint + (id ? `/${encodeURIComponent(id)}` : '') + action, {
        method, signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      signal.throwIfAborted();
      if (method === 'GET') {
        const list = collectionKey ? data?.[collectionKey] : data;
        if (!Array.isArray(list) || !list.every(isItem)) throw new Error('Invalid collection response');
        setItems(list);
      } else if (method === 'DELETE') {
        if (data?.success !== true) throw new Error('Deletion was not confirmed');
        setItems(current => current?.filter(item => item[identity] !== id) ?? null);
      } else {
        if (!isItem(data) || (id && data[identity] !== id)) throw new Error('Save was not confirmed');
        setItems(current => current?.some(item => item[identity] === data[identity])
          ? current.map(item => item[identity] === data[identity] ? data : item) : [...(current ?? []), data]);
      }
      return true;
    } catch (error) {
      if (!owner.signal.aborted && pending.current === signal) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ busy: false, error: message }); toast.error(message);
      }
      return false;
    } finally {
      if (pending.current === signal) {
        pending.current = null;
        if (!owner.signal.aborted) setState(current => ({ ...current, busy: false }));
      }
    }
  }, [endpoint, isItem, collectionKey, identity]);
  useEffect(() => {
    const owner = new AbortController(); lifetime.current = owner;
    void sync();
    return () => owner.abort();
  }, [sync]);
  return { items, ...state, sync };
}
