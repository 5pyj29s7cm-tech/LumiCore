import { useEffect, useState } from 'react';

export type ConversationHistoryMatch = {
  id?: string;
  conversationId: string;
  message: string;
  timestamp?: string;
  role?: string;
};

type SearchState = {
  requestUrl: string;
  scope?: (url: string) => string;
  loading: boolean;
  results: ConversationHistoryMatch[];
  error: string;
  capped: boolean;
};

const idle: SearchState = { requestUrl: '', loading: false, results: [], error: '', capped: false };

export function useConversationHistorySearch(query: string, scopedConversationUrl: (url: string) => string, retry: number) {
  const trimmed = query.trim();
  const requestUrl = trimmed
    ? scopedConversationUrl('/api/conversations/search?q=' + encodeURIComponent(trimmed) + '&limit=500')
    : '';
  const [state, setState] = useState<SearchState>(idle);

  useEffect(() => {
    if (!requestUrl) {
      setState(idle);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ ...idle, requestUrl, scope: scopedConversationUrl, loading: true });
    const timer = setTimeout(() => {
      fetch(requestUrl, { credentials: 'include', signal: controller.signal })
        .then(async response => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(String(payload.error || response.statusText || response.status));
          if (cancelled) return;
          const results = (Array.isArray(payload.results) ? payload.results : [])
            .filter((item: ConversationHistoryMatch) => item && typeof item.conversationId === 'string' && typeof item.message === 'string');
          setState({ requestUrl, scope: scopedConversationUrl, loading: false, results, error: '', capped: results.length >= 500 });
        })
        .catch(error => {
          if (cancelled) return;
          setState({ ...idle, requestUrl, scope: scopedConversationUrl, error: error instanceof Error ? error.message : String(error) });
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestUrl, retry, scopedConversationUrl]);

  // A scope or query change must never flash the preceding scope's results.
  return state.requestUrl === requestUrl && (!requestUrl || state.scope === scopedConversationUrl) ? state : { ...idle, requestUrl, loading: Boolean(requestUrl) };
}

export function matchingSnippet(message: string, query: string) {
  const text = message.replace(/\s+/g, ' ').trim();
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = index > 28 ? index - 28 : 0;
  const end = Math.min(text.length, start + 140);
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
