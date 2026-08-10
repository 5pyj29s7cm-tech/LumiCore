import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import type { ConversationFocusThread } from './useFocusThreads';

export interface RuntimeEvidenceReceipt {
  receiptId: string;
  taskId: string;
  toolName: string;
  targetIdentity: string;
  outcome: string;
  verification: 'verified' | 'unverified' | 'failed';
  requestId: string;
  idempotencyRef: string;
  createdAt: string;
}

export interface RuntimeTaskProjection {
  taskId: string;
  parentTaskId: string;
  goal: string;
  target: string;
  intentKind: string;
  operation: string;
  status: string;
  blocker: string;
  activeRequest: boolean;
  completionSource: string;
  revision: number;
  updatedAt: string;
  focus: ConversationFocusThread;
  plan?: {
    planId: string;
    sideEffectClass: string;
    requiresConfirmation: boolean;
    nodeCount: number;
    decisionAuthority: string;
    scriptAuthority: string;
  };
  evidence: {
    total: number;
    verified: number;
    failed: number;
    unknown: number;
    latest: RuntimeEvidenceReceipt[];
  };
}

export interface StructuredRuntimeStatus {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  scope: { domain: 'personal' | 'work'; orgId: string };
  level: 'ready' | 'working' | 'attention';
  attentionReasons: string[];
  counts: {
    activeTasks: number;
    waitingConfirmation: number;
    blockedTasks: number;
    verifiedReceipts: number;
    failedReceipts: number;
    unknownReceipts: number;
    backgroundActive: number;
    autonomousActive: number;
    durableBlocked: number;
  };
  tasks: RuntimeTaskProjection[];
  durableWork: Array<{
    taskId: string;
    runtime: 'background' | 'autonomous';
    status: string;
    title: string;
    checkpoint: string;
    updatedAt: string;
  }>;
  runtime: Record<string, any>;
  safety: {
    externalCommitConfirmationRequired: true;
    unknownExternalOutcomeReplayBlocked: true;
    legacyExternalFallbackDisabled: true;
    payloadsExcluded: true;
  };
}

export function useRuntimeStatus(input: { enabled?: boolean; scopeKey?: string } = {}) {
  const { enabled = true, scopeKey = 'personal' } = input;
  const [status, setStatus] = useState<StructuredRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const generationRef = useRef(0);
  const hasStatusRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    if (!hasStatusRef.current) setLoading(true);
    try {
      const response = await apiFetch('/api/runtime/status', { signal: AbortSignal.timeout(6_000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `runtime_status_http_${response.status}`);
      if (generation !== generationRef.current) return;
      setStatus(payload as StructuredRuntimeStatus);
      hasStatusRef.current = true;
      setError('');
    } catch (refreshError: any) {
      if (generation !== generationRef.current) return;
      setError(String(refreshError?.message || 'runtime_status_failed'));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      hasStatusRef.current = false;
      setStatus(null);
      setLoading(false);
      setError('');
      return;
    }
    const socket = socketService.connect();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 160);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    socket.on('connect', scheduleRefresh);
    socket.on('agent:status', scheduleRefresh);
    socket.on('agent:tool', scheduleRefresh);
    socket.on('agent:tool_call', scheduleRefresh);
    socket.on('focus:updated', scheduleRefresh);
    socket.on('audio:work_progress', scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => {
      generationRef.current += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(interval);
      socket.off('connect', scheduleRefresh);
      socket.off('agent:status', scheduleRefresh);
      socket.off('agent:tool', scheduleRefresh);
      socket.off('agent:tool_call', scheduleRefresh);
      socket.off('focus:updated', scheduleRefresh);
      socket.off('audio:work_progress', scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh, scopeKey]);

  return { status, loading, error, refresh };
}
