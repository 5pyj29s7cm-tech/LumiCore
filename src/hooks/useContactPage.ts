import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../services/apiClient';
import { withRequestDeadline } from '../lib/requestDeadline';
import type { Contact } from '../../server/contacts/types';

export const CONTACT_PAGE_SIZE = 25;
/** The parent remounts this hook for each account/work scope. */
export function useContactPage(isContact: (value: any) => value is Contact) {
  const [items, setItems] = useState<Contact[] | null>(null), [total, setTotal] = useState(0);
  const [page, setPage] = useState(0), [search, setSearchValue] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const owner = useRef<AbortController | null>(null), read = useRef<AbortController | null>(null), writing = useRef(false);
  const position = useRef({ page, search }); position.current = { page, search };
  const load = useCallback(async () => {
    if (!owner.current || owner.current.signal.aborted) return false;
    read.current?.abort();
    const controller = read.current = new AbortController();
    const signal = AbortSignal.any([controller.signal, owner.current.signal]);
    const query = position.current;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ limit: String(CONTACT_PAGE_SIZE), offset: String(query.page * CONTACT_PAGE_SIZE), search: query.search.trim() });
      const data = await withRequestDeadline(signal => apiJson(`/api/contacts?${params}`, { signal }), signal);
      signal.throwIfAborted();
      if (!Array.isArray(data?.contacts) || !data.contacts.every(isContact) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Invalid contacts page');
      if (query.page > 0 && query.page * CONTACT_PAGE_SIZE >= data.total) { setPage(Math.max(0, Math.ceil(data.total / CONTACT_PAGE_SIZE) - 1)); return true; }
      setItems(data.contacts); setTotal(data.total); return true;
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { if (!signal.aborted && !writing.current) setBusy(false); }
  }, [isContact]);
  useEffect(() => { const controller = owner.current = new AbortController(); return () => { controller.abort(); read.current?.abort(); }; }, []);
  useEffect(() => { void load(); }, [load, page, search]);
  const sync = useCallback(async (method = 'GET', id = '', body?: unknown, action = '') => {
    if (method === 'GET') return writing.current ? false : load();
    const current = owner.current;
    if (!current || current.signal.aborted || writing.current) return false;
    writing.current = true; read.current?.abort(); setBusy(true); setError('');
    try {
      const data = await withRequestDeadline(signal => apiJson('/api/contacts' + (id ? `/${encodeURIComponent(id)}` : '') + action, {
        method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }), current.signal);
      current.signal.throwIfAborted();
      if (method === 'DELETE' ? data?.success !== true : !isContact(data) || Boolean(id && data.id !== id)) throw new Error('Contact change was not confirmed');
      await load(); return true;
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { writing.current = false; if (!current.signal.aborted) setBusy(false); }
  }, [isContact, load]);
  return { items, total, page, search, busy, error, sync, setPage,
    setSearch: (value: string) => { setPage(0); setSearchValue(value); } };
}
