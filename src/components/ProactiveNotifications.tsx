import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';
import { useT } from '../lib/useT';

type ProactivePayload = {
  type?: string;
  taskId?: string;
  message: string;
  timestamp?: string;
  action?: string;
  context?: Record<string, any>;
};

function openProactiveChat(data: ProactivePayload) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('lumi:open-proactive-chat', {
    detail: {
      type: data.type || data.taskId || 'unknown',
      message: data.message,
      action: data.action,
      proactiveContext: data.context,
      timestamp: data.timestamp,
    },
  }));
}

function toastOptions(data: ProactivePayload, duration: number, actionLabel: string) {
  return {
    duration,
    id: `proactive-${data.timestamp || Date.now()}`,
    action: {
      label: actionLabel,
      onClick: () => openProactiveChat(data),
    },
  };
}

/**
 * Bridge between backend socket events and frontend toast notifications.
 * Mounts once at the app root. No visual rendering.
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
      const actionLabel = t.langCode === 'en' ? 'Continue' : '继续';
      const notify = (item: { type: string; title: string; message: string }) => {
        addNotification({
          ...item,
          action: data.action,
          proactiveContext: data.context,
        });
      };

      // Voice-appropriate proactive events: also trigger spoken output
      const voiceTasks = new Set(['proactive_lumi_scan', 'greeting', 'daily_summary', 'evening_wrapup']);
      if (voiceTasks.has(taskId) && proactiveGreetingEnabled) {
        socket.emit('proactive:request_speak', { message: data.message });
      }

      switch (taskId) {
        case 'greeting':
          notify({ type: 'system', title: t.notifLumi || 'Lumi', message: data.message });
          toast(data.message, toastOptions(data, 8000, actionLabel));
          break;
        case 'reminder_check':
          notify({ type: 'info', title: t.notifReminder || 'Reminder', message: data.message });
          toast.info(data.message, toastOptions(data, 8000, actionLabel));
          break;
        case 'memory_decay':
          notify({ type: 'warning', title: t.notifMemoryAlert || 'Memory Alert', message: data.message });
          toast.warning(data.message, toastOptions(data, 6000, actionLabel));
          break;
        case 'daily_summary':
          notify({ type: 'success', title: t.notifDailySummary || 'Daily Summary', message: data.message });
          toast.success(data.message, toastOptions(data, 12000, actionLabel));
          break;
        case 'evening_wrapup':
          notify({ type: 'system', title: t.notifEveningWrapup || 'Evening Wrap-up', message: data.message });
          toast(data.message, { ...toastOptions(data, 10000, actionLabel), style: { background: '#1e1b4b', color: '#e0e7ff' } });
          break;
        case 'behavioral_analysis':
          notify({ type: 'success', title: t.notifBehavioralInsight || 'Behavioral Insight', message: data.message });
          toast.success(data.message, toastOptions(data, 8000, actionLabel));
          break;
        default:
          notify({ type: 'info', title: t.notifLumi || 'Lumi', message: data.message });
          toast(data.message, toastOptions(data, 5000, actionLabel));
      }
    };

    const handleToolCall = (data: { name: string; arguments: Record<string, any>; result?: string; error?: string }) => {
      if (data.error) {
        toast.error(`Tool "${data.name}" failed: ${data.error}`, { duration: 4000 });
      } else if (data.result) {
        const preview = data.result.length > 80 ? data.result.slice(0, 80) + '...' : data.result;
        toast.success(`Tool: ${data.name} — ${preview}`, { duration: 3000 });
      } else {
        toast(`Running tool: ${data.name}...`, { duration: 2000 });
      }
    };

    const handleAwaySummary = (data: { awayMinutes: number; taskCount: number; summary: string }) => {
      addNotification({ type: 'success', title: t.notifAwaySummary || 'While you were away', message: data.summary });
      toast.success(data.summary, { duration: 10000, id: `away-${Date.now()}` });
    };

    socket.on('agent:proactive', handleProactive);
    socket.on('agent:tool_call', handleToolCall);
    socket.on('autonomous:away_summary', handleAwaySummary);

    return () => {
      socket.off('agent:proactive', handleProactive);
      socket.off('agent:tool_call', handleToolCall);
      socket.off('autonomous:away_summary', handleAwaySummary);
    };
  }, [socket, addNotification]);

  return null;
}
