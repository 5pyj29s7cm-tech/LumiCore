import { useEffect } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { useT } from '../lib/useT';
import {
  sanitizeAgentResponseTextForDisplay,
  shouldDisplayAgentResponse,
  shouldSpeakAgentResponse,
} from '@/lib/agentResponseDelivery';

type ProactivePayload = {
  type?: string;
  taskId?: string;
  interactionId?: string;
  message: string;
  timestamp?: string;
  action?: string;
  context?: Record<string, any>;
  finalized?: boolean;
  blocked?: boolean;
  reason?: string;
};

/**
 * Bridge between backend socket events and the persistent notification center.
 * It intentionally never opens transient popups; users review notifications from the bell.
 */
export function ProactiveNotifications() {
  const socket = useSocket();
  const { addNotification } = useApp();
  const t = useT();
  const language = t.langCode === 'en' ? 'en' : 'zh';

  useEffect(() => {
    if (!socket) return;

    const handleProactive = (data: ProactivePayload) => {
      const taskId = data.type || data.taskId || 'unknown';
      const isReminder = taskId === 'reminder_check'
        && /^proactive_[a-f0-9]{24}$/.test(data.interactionId || '');
      const proactiveGreetingEnabled = localStorage.getItem('lumi_allow_proactive_voice') === 'true';
      if (taskId === 'greeting' && !proactiveGreetingEnabled) return;
      const publicMessage = sanitizeAgentResponseTextForDisplay(
        data.message,
        language,
      );
      const delivery = { ...data, text: publicMessage };
      if (!shouldDisplayAgentResponse(delivery) && !isReminder) return;
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
        (voiceTasks.has(taskId) || isReminder)
        && proactiveGreetingEnabled
        && (isReminder || shouldSpeakAgentResponse(delivery))
      ) {
        socket.emit('proactive:request_speak', { message: publicMessage,
          ...(isReminder ? { interactionId: data.interactionId } : {}),
        });
      }

      switch (taskId) {
        case 'greeting':
          notify({ type: 'system', title: t.notifLumi || 'Lumi', message: publicMessage });
          break;
        case 'reminder_check':
          notify({ type: 'info', title: t.notifReminder || 'Reminder', message: publicMessage });
          break;
        case 'memory_decay':
          notify({ type: 'warning', title: t.notifMemoryAlert || 'Memory Alert', message: publicMessage });
          break;
        case 'daily_summary':
          notify({ type: 'success', title: t.notifDailySummary || 'Daily Summary', message: publicMessage });
          break;
        case 'evening_wrapup':
          notify({ type: 'system', title: t.notifEveningWrapup || 'Evening Wrap-up', message: publicMessage });
          break;
        case 'behavioral_analysis':
          notify({ type: 'success', title: t.notifBehavioralInsight || 'Behavioral Insight', message: publicMessage });
          break;
        default:
          notify({ type: 'info', title: t.notifLumi || 'Lumi', message: publicMessage });
      }
    };

    const handleAwaySummary = (data: { awayMinutes: number; taskCount: number; summary: string }) => {
      addNotification({
        type: 'success',
        title: t.notifAwaySummary || 'While you were away',
        message: sanitizeAgentResponseTextForDisplay(data.summary, language),
      });
    };

    socket.on('agent:proactive', handleProactive);
    socket.on('autonomous:away_summary', handleAwaySummary);

    return () => {
      socket.off('agent:proactive', handleProactive);
      socket.off('autonomous:away_summary', handleAwaySummary);
    };
  }, [
    socket,
    addNotification,
    language,
    t.notifAwaySummary,
    t.notifBehavioralInsight,
    t.notifDailySummary,
    t.notifEveningWrapup,
    t.notifLumi,
    t.notifMemoryAlert,
    t.notifReminder,
  ]);

  return null;
}
