import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { memoryAvatarService } from '../services/memoryAvatarService';
import { memoryTerritoryCopy } from '../i18n/locales/memoryTerritory';
import { chatExecutionStorageKey, ownedPendingChatExecutions } from '../lib/chatExecutionRecovery';
import { upsertPersistedPendingChatExecution, removePersistedPendingChatExecution, type PersistedPendingChatExecution } from '../lib/chatEventReceipts';
import { sanitizeAgentResponseTextForDisplay, sanitizeAgentStreamingTextForDisplay, shouldDisplayAgentResponse, isTerminalAgentStatus } from '../lib/agentResponseDelivery';

export interface TerritoryMessage { id: string; role: 'user' | 'assistant'; text: string; requestId?: string; pending?: boolean }
function readPendingStorage(key: string): unknown {
  try { return key ? JSON.parse(localStorage.getItem(key) || 'null') : null; }
  catch { return null; }
}
export function useMemoryAvatarConversation({ socket, avatarId, ownerId, locale }: {
  socket: any; avatarId: string; ownerId: string; locale: 'zh' | 'en';
}) {
  const copy = memoryTerritoryCopy(locale);
  const [messages, setMessages] = useState<TerritoryMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<PersistedPendingChatExecution | null>(null);
  const raw = useRef('');
  const generation = useRef(0);
  const owner = useMemo(() => ({ userId: ownerId, agentId: avatarId, source: 'memory-avatar', domain: 'personal' as const, orgId: '' }), [ownerId, avatarId]);
  const currentOwner = useRef(owner);
  const mounted = useRef(false);
  currentOwner.current = owner;
  const ownsView = useCallback(() => mounted.current && currentOwner.current === owner, [owner]);
  const key = chatExecutionStorageKey(owner);
  const storage = useCallback((execution: PersistedPendingChatExecution | null, finished?: string) => {
    if (!key) return;
    try {
      const current = readPendingStorage(key);
      localStorage.setItem(key, JSON.stringify(execution ? upsertPersistedPendingChatExecution(current, execution) : removePersistedPendingChatExecution(current, finished || '')));
    } catch { /* Requests remain scoped in memory when local storage is unavailable. */ }
  }, [key]);
  const put = useCallback((role: TerritoryMessage['role'], text: string, requestId?: string, pending = false) => {
    if (!text.trim()) return;
    const id = requestId ? `${requestId}:${role}` : crypto.randomUUID();
    setMessages(rows => rows.some(row => row.id === id) ? rows.map(row => row.id === id ? { ...row, text, pending } : row) : [...rows, { id, role, text, requestId, pending }]);
  }, []);
  const finish = useCallback(() => {
    if (active.current) storage(null, active.current.requestId);
    active.current = null; raw.current = ''; setBusy(false);
  }, [storage]);
  const refresh = useCallback(async () => {
    if (!ownerId || !avatarId || !ownsView()) return;
    const current = generation.current;
    setLoading(true); setError('');
    try {
      const rows = await memoryAvatarService.history(avatarId);
      if (current !== generation.current || !ownsView()) return;
      const history = rows.filter(row => row.role === 'user' || row.role === 'assistant').map((row, index) => ({
        id: row.requestId ? `${row.requestId}:${row.role}` : row.id || `history:${index}`,
        role: row.role as TerritoryMessage['role'], requestId: row.requestId,
        text: row.role === 'assistant' ? sanitizeAgentResponseTextForDisplay(row.content, locale) : row.content,
      }));
      setMessages(currentRows => {
        const persisted = new Map(history.map(row => [row.id, row]));
        // Keep only locally received turns which have not appeared in the durable history yet.
        return [...history, ...currentRows.filter(row => !persisted.has(row.id))];
      });
    } catch { if (current === generation.current) setError(copy.historyError); }
    finally { if (current === generation.current) setLoading(false); }
  }, [ownerId, avatarId, locale, copy.historyError, ownsView]);

  useEffect(() => {
    const current = ++generation.current;
    mounted.current = true;
    setMessages([]); setError(''); raw.current = '';
    active.current = ownedPendingChatExecutions(readPendingStorage(key), owner)[0] || null;
    setBusy(Boolean(active.current));
    void refresh();
    const belongs = (data: any) => current === generation.current && active.current && data?.requestId === active.current.requestId && (!data.agentId || data.agentId === avatarId) && (!data.source || data.source === owner.source);
    const response = (data: any) => {
      if (!belongs(data)) return;
      const publicText = shouldDisplayAgentResponse(data) ? sanitizeAgentResponseTextForDisplay(data.text, locale) : '';
      if (publicText) put('assistant', publicText, data.requestId);
      else setMessages(rows => rows.filter(row => row.id !== `${data.requestId}:assistant`));
      finish();
    };
    const chunk = (data: any) => {
      if (!belongs(data)) return;
      raw.current += String(data.text || '');
      put('assistant', sanitizeAgentStreamingTextForDisplay(raw.current, locale), data.requestId, true);
    };
    const status = (data: any) => {
      if (!belongs(data)) return;
      if (data.conversationId && active.current) { active.current.conversationId = data.conversationId; storage(active.current); }
      if (isTerminalAgentStatus(data.status)) {
        setMessages(rows => rows.filter(row => row.id !== `${data.requestId}:assistant` || !row.pending));
        finish(); void refresh();
      }
    };
    const failed = (data: any) => {
      if (!belongs(data)) return;
      setMessages(rows => rows.filter(row => row.id !== `${data.requestId}:assistant` || !row.pending));
      setError(sanitizeAgentResponseTextForDisplay(data.message || copy.callUnavailable, locale)); finish();
    };
    const resume = () => {
      const execution = active.current;
      if (!execution || !socket?.connected) return;
      socket.emit('agent:execution_resume', { requestId: execution.requestId, source: owner.source, domain: 'personal', orgId: null, conversationId: execution.conversationId }, (result?: any) => {
        if (current !== generation.current || active.current?.requestId !== execution.requestId) return;
        if (result?.ok && result.snapshot?.requestId === execution.requestId && result.snapshot.source === owner.source) {
          if (result.snapshot.conversationId) { execution.conversationId = result.snapshot.conversationId; storage(execution); }
          // The server replays the durable terminal after this acknowledgement.
          setBusy(!result.snapshot.terminal || Boolean(result.snapshot.terminalEvent));
          if (result.snapshot.terminal && !result.snapshot.terminalEvent) { finish(); void refresh(); }
        } else if (result?.ok === false && result.error === 'Execution not found or no longer recoverable') {
          setError(copy.timeout); finish(); void refresh();
        } else {
          // A missing/malformed/transient acknowledgement does not establish a
          // terminal result. Keep the exact request for reconnect reconciliation.
          setError(copy.timeout);
        }
      });
    };
    socket?.on('agent:chunk', chunk); socket?.on('agent:response', response); socket?.on('agent:status', status); socket?.on('agent:error', failed); socket?.on('connect', resume);
    resume();
    const timer = setInterval(resume, 15000);
    return () => {
      mounted.current = false; generation.current = current + 1; clearInterval(timer);
      socket?.off('agent:chunk', chunk); socket?.off('agent:response', response); socket?.off('agent:status', status); socket?.off('agent:error', failed); socket?.off('connect', resume);
    };
  }, [socket, avatarId, owner, key, locale, copy.callUnavailable, copy.timeout, finish, put, refresh, storage]);

  const send = useCallback((text: string): boolean => {
    if (!ownerId || !avatarId || !ownsView() || !text.trim() || active.current || loading) return false;
    if (!socket?.connected) { setError(copy.reconnect); return false; }
    const current = generation.current;
    const requestId = `memory_avatar_${crypto.randomUUID()}`;
    active.current = { requestId, userId: ownerId, source: owner.source, domain: 'personal', orgId: '', startedAt: new Date().toISOString() };
    storage(active.current); setBusy(true); setError(''); raw.current = '';
    put('user', text.trim(), requestId);
    socket.emit('agent:chat', { text: text.trim(), personalityId: 'lumi', agentId: avatarId, requestId, source: owner.source, domain: 'personal', orgId: null }, (ack?: any) => {
      if (current !== generation.current || active.current?.requestId !== requestId) return;
      if (ack?.ok === false) { setError(String(ack.error || copy.callUnavailable)); finish(); }
    });
    return true;
  }, [socket, avatarId, ownerId, owner.source, loading, copy.reconnect, copy.callUnavailable, storage, put, finish, ownsView]);
  const interrupt = useCallback(() => {
    const execution = active.current;
    if (!ownsView() || !execution || !socket?.connected) return;
    socket.emit('agent:abort_chat', { requestId: execution.requestId, source: owner.source, domain: 'personal', orgId: null, conversationId: execution.conversationId });
  }, [socket, owner.source, ownsView]);
  const appendVoiceTranscript = useCallback((text: string, isFinal: boolean, meta?: { requestId?: string }) => { if (ownsView() && isFinal) put('user', text, meta?.requestId); }, [put, ownsView]);
  const appendVoiceResponse = useCallback((text: string, meta?: { requestId?: string }) => { if (ownsView()) put('assistant', sanitizeAgentResponseTextForDisplay(text, locale), meta?.requestId); }, [put, locale, ownsView]);
  return { messages, busy, loading, error, send, interrupt, refresh, appendVoiceTranscript, appendVoiceResponse };
}
