import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { useT } from '../lib/useT';
import {
  shouldDisplayAgentResponse,
  shouldSpeakAgentResponse,
} from '@/lib/agentResponseDelivery';

type ProactivePayload = {
  type?: string;
  taskId?: string;
  message: string;
  timestamp?: string;
  action?: string;
  context?: Record<string, any>;
  finalized?: boolean;
  blocked?: boolean;
  reason?: string;
};

type ToolCallPayload = {
  name: string;
  arguments: Record<string, any>;
  result?: string;
  error?: string;
};

export type ToolNotificationState = 'running' | 'failed' | 'blocked' | 'verified' | 'result';

export function classifyToolNotification(data: ToolCallPayload): {
  state: ToolNotificationState;
  detail: string;
} {
  if (data.error) return { state: 'failed', detail: data.error };
  if (data.result === undefined) return { state: 'running', detail: '' };

  const detail = String(data.result || '').trim();
  let parsed: unknown = detail;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string' && parsed; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'result', detail };
  }

  const payload = parsed as Record<string, unknown>;
  const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  if (
    payload.ok === false
    || payload.success === false
    || ['error', 'failed'].includes(status)
    || (typeof payload.error === 'string' && payload.error.trim())
  ) {
    return {
      state: 'failed',
      detail: typeof payload.error === 'string' && payload.error.trim() ? payload.error : detail,
    };
  }
  if (
    payload.verified === false
    || payload.completed === false
    || ['blocked', 'cancelled', 'canceled', 'partial', 'pending', 'queued', 'timeout', 'timed_out', 'unverified'].includes(status)
  ) {
    return { state: 'blocked', detail };
  }
  if (
    payload.ok === true
    || payload.success === true
    || payload.verified === true
    || payload.completed === true
    || ['completed', 'done', 'ok', 'success', 'succeeded', 'verified'].includes(status)
  ) {
    return { state: 'verified', detail };
  }
  return { state: 'result', detail };
}

/**
 * Bridge between backend socket events and the persistent notification center.
 * It intentionally never opens transient popups; users review notifications from the bell.
 */
export function ProactiveNotifications() {
  const socket = useSocket();
  const { addNotification } = useApp();
  const t = useT();

  useEffect(() => {
    if (!socket) return;

    const handleProactive = (data: ProactivePayload) => {
      const taskId = data.type || data.taskId || 'unknown';
      const proactiveGreetingEnabled = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
      if (taskId === 'greeting' && !proactiveGreetingEnabled) return;
      const delivery = { ...data, text: data.message };
      if (!shouldDisplayAgentResponse(delivery)) return;
      const notify = (item: { type: string; title: string; message: string }) => {
        addNotification({
          ...item,
          action: data.action,
          proactiveContext: data.context,
        });
      };

      // Voice-appropriate proactive events: also trigger spoken output
      const voiceTasks = new Set(['proactive_lumi_scan', 'greeting', 'daily_summary', 'evening_wrapup']);
      if (
        voiceTasks.has(taskId)
        && proactiveGreetingEnabled
        && shouldSpeakAgentResponse(delivery)
      ) {
        socket.emit('proactive:request_speak', { message: data.message });
      }

      switch (taskId) {
        case 'greeting':
          notify({ type: 'system', title: t.notifLumi || 'Lumi', message: data.message });
          break;
        case 'reminder_check':
          notify({ type: 'info', title: t.notifReminder || 'Reminder', message: data.message });
          break;
        case 'memory_decay':
          notify({ type: 'warning', title: t.notifMemoryAlert || 'Memory Alert', message: data.message });
          break;
        case 'daily_summary':
          notify({ type: 'success', title: t.notifDailySummary || 'Daily Summary', message: data.message });
          break;
        case 'evening_wrapup':
          notify({ type: 'system', title: t.notifEveningWrapup || 'Evening Wrap-up', message: data.message });
          break;
        case 'behavioral_analysis':
          notify({ type: 'success', title: t.notifBehavioralInsight || 'Behavioral Insight', message: data.message });
          break;
        default:
          notify({ type: 'info', title: t.notifLumi || 'Lumi', message: data.message });
      }
    };

    const handleAwaySummary = (data: { awayMinutes: number; taskCount: number; summary: string }) => {
      addNotification({ type: 'success', title: t.notifAwaySummary || 'While you were away', message: data.summary });
    };

    socket.on('agent:proactive', handleProactive);
    socket.on('autonomous:away_summary', handleAwaySummary);

    return () => {
      socket.off('agent:proactive', handleProactive);
      socket.off('autonomous:away_summary', handleAwaySummary);
    };
  }, [socket, addNotification]);

  return null;
}
