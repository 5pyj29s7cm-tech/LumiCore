import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { socketService } from '@/services/socketService';

export type FocusThreadStatus =
  | 'created'
  | 'planning'
  | 'executing'
  | 'waiting_confirmation'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ConversationFocusThread {
  schemaVersion: 1;
  threadId: string;
  taskId: string;
  evidenceTaskId: string;
  goal: string;
  status: FocusThreadStatus;
  commitment: string;
  nextAction: string;
  waitingFor: string;
  interruption: string;
  resumePoint: string;
  dueAt: string;
  updatedAt: string;
}

interface FocusListResponse {
  ok?: boolean;
  domain?: 'personal' | 'work';
  orgId?: string;
  threads?: ConversationFocusThread[];
  error?: string;
}

function sameScope(
  payload: { domain?: string; orgId?: string } | undefined,
  domain: 'personal' | 'work',
  orgId: string,
): boolean {
  if (!payload) return false;
  if (payload.domain && payload.domain !== domain) return false;
  return domain !== 'work' || !payload.orgId || payload.orgId === orgId;
}

function sortThreads(threads: ConversationFocusThread[]): ConversationFocusThread[] {
  return [...threads].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

export function useFocusThreads(input: {
  domain: 'personal' | 'work';
  orgId?: string;
  enabled?: boolean;
}) {
  const { domain, enabled = true } = input;
  const orgId = domain === 'work' ? String(input.orgId || '') : '';
  const [threads, setThreads] = useState<ConversationFocusThread[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const requestGenerationRef = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled || (domain === 'work' && !orgId)) {
      setThreads([]);
      setLoading(false);
      setError('');
      return;
    }
    const socket = socketService.connect() as Socket;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    socket.emit('focus:list', { domain, orgId: orgId || undefined }, (response: FocusListResponse = {}) => {
      if (generation !== requestGenerationRef.current) return;
      setLoading(false);
      if (!response.ok || !Array.isArray(response.threads)) {
        setError(String(response.error || 'focus_list_failed'));
        return;
      }
      setError('');
      setThreads(sortThreads(response.threads));
    });
  }, [domain, enabled, orgId]);

  useEffect(() => {
    if (!enabled || (domain === 'work' && !orgId)) {
      requestGenerationRef.current += 1;
      setThreads([]);
      setLoading(false);
      setError('');
      return;
    }

    const socket = socketService.connect() as Socket;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 120);
    };
    const onFocusUpdated = (payload: {
      domain?: 'personal' | 'work';
      orgId?: string;
      thread?: ConversationFocusThread;
    }) => {
      if (!sameScope(payload, domain, orgId) || !payload.thread) return;
      setThreads(current => sortThreads([
        payload.thread!,
        ...current.filter(thread => thread.taskId !== payload.thread!.taskId),
      ]).filter(thread => !['completed', 'failed', 'cancelled'].includes(thread.status)));
    };

    refresh();
    socket.on('connect', refresh);
    socket.on('focus:updated', onFocusUpdated);
    socket.on('agent:status', scheduleRefresh);
    socket.on('agent:progress', scheduleRefresh);
    socket.on('audio:work_progress', scheduleRefresh);
    socket.on('chat:conversation_updated', scheduleRefresh);
    const interval = window.setInterval(refresh, 15_000);

    return () => {
      requestGenerationRef.current += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(interval);
      socket.off('connect', refresh);
      socket.off('focus:updated', onFocusUpdated);
      socket.off('agent:status', scheduleRefresh);
      socket.off('agent:progress', scheduleRefresh);
      socket.off('audio:work_progress', scheduleRefresh);
      socket.off('chat:conversation_updated', scheduleRefresh);
    };
  }, [domain, enabled, orgId, refresh]);

  return { threads, loading, error, refresh };
}
