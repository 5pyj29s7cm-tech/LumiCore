import { Socket, Server } from "socket.io";
import { readDB } from "../../db_layer";
import { pushActivityEvent, setIdleState, getIdleState, getLastEvent, clearActivityStream } from "../context/activity_stream";
import { detectClipboardChange } from "../context/clipboard_monitor";
import { processActivityEvent } from "../context/proactive_triggers";
import { reportIdleState } from "../autonomy/safety_gate";
import { getTaskHistory } from "../autonomy/task_queue";

const ambientNoise = new Map<string, { rms: number; lastUpdate: string }>();

export function isVerifiedAutonomousHistoryItem(task: {
  status?: string;
  result?: string;
  error?: string;
  toolCallsCount?: number;
  completedAt?: string;
  finalized?: boolean;
  blocked?: boolean;
  verified?: boolean;
}): boolean {
  return (
    task.status === 'completed'
    && !task.error
    && task.finalized === true
    && task.blocked === false
    && task.verified === true
    && Number(task.toolCallsCount || 0) > 0
    && Boolean(String(task.result || '').trim())
    && Boolean(task.completedAt && Number.isFinite(new Date(task.completedAt).getTime()))
  );
}

export function getAmbientNoise(userId: string): number | null {
  const info = ambientNoise.get(userId);
  if (!info) return null;
  if (Date.now() - new Date(info.lastUpdate).getTime() > 15000) return null;
  return info.rms;
}

export function registerAmbientHandlers(socket: Socket, getUserId: (s: Socket) => string, io: Server) {
  const isWorkDomainSocket = () => Boolean(String(socket.data?.authenticatedOrgId || '').trim());

  async function triggerIdleProcessing(userId: string, ioInstance: any) {
    try {
      const db = readDB();
      const activeConv = (db.conversations || []).find(
        (c: any) => c.userId === userId && c.status === 'active'
      );
      if (activeConv && activeConv.messageCount >= 10 && !activeConv.summary) {
        const { checkAutoSummary } = await import('../conversation/manager');
        checkAutoSummary(activeConv.id);
        console.log(`[IdleProcessing] Triggered auto-summary for conversation ${activeConv.id}`);
      }
    } catch (err: any) {
      console.warn(`[IdleProcessing] Summarize failed: ${err.message}`);
    }

    try {
      const { cleanupEphemeralAgents } = await import('../agents/orchestrator');
      const cleaned = cleanupEphemeralAgents(6);
      if (cleaned > 0) console.log(`[IdleProcessing] Cleaned up ${cleaned} ephemeral agents`);
    } catch {}
  }

  function guard(fn: (...args: any[]) => void | Promise<void>) {
    return (...args: any[]) => {
      try {
        const ret = fn(...args);
        if (ret && typeof (ret as any).catch === 'function') {
          (ret as any).catch((e: any) => console.error('[Ambient] Handler error:', e.message || String(e)));
        }
      } catch (e: any) {
        console.error('[Ambient] Handler error:', e.message || String(e));
      }
    };
  }

  socket.on("ambient:window_update", guard((data: { title: string; process_name: string; pid: number }) => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (!uid) return;
    const prev = getLastEvent(uid, 'window_changed');
    const prevTitle = prev?.data?.title || '';
    const prevProc = prev?.data?.process_name || '';
    const changed = data.title !== prevTitle || data.process_name !== prevProc;
    const event = { type: 'window_changed' as const, timestamp: new Date().toISOString(), data };
    pushActivityEvent(uid, event);
    if (changed) {
      processActivityEvent(event, uid, io);
    }
  }));

  socket.on("ambient:idle_report", guard((data: { idle_ms: number; idle_seconds: number }) => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (!uid) return;
    const isIdle = data.idle_seconds > 60;
    const prevState = getIdleState(uid);
    const wasIdle = prevState.isIdle;
    const idleSince = prevState.idleSince;
    setIdleState(uid, isIdle);
    reportIdleState(uid, data.idle_seconds);
    socket.emit("ambient:idle_echo", data);
    if (isIdle && !wasIdle) {
      triggerIdleProcessing(uid, io).catch(err =>
        console.warn(`[IdleProcessing] Background task failed for ${uid}:`, err.message)
      );
    }

    // Return-from-away summary: user was away, now back
    if (!isIdle && wasIdle && data.idle_seconds < 10 && idleSince) {
      const awayMinutes = Math.round((Date.now() - new Date(idleSince).getTime()) / 60000);
      if (awayMinutes >= 2) {
        const recentTasks = getTaskHistory(20, 0).filter(
          (t: any) => (
            t.userId === uid
            && isVerifiedAutonomousHistoryItem(t)
            && new Date(t.completedAt!).getTime() > new Date(idleSince).getTime()
          )
        );
        if (recentTasks.length > 0) {
          const summary = recentTasks.map((t: any) => `- ${t.title}: ${(t.result || '').slice(0, 80)}`).join('\n');
          socket.emit('autonomous:away_summary', {
            awayMinutes,
            taskCount: recentTasks.length,
            summary: `你离开的${awayMinutes}分钟里，Lumi完成了${recentTasks.length}项任务:\n${summary}`,
            tasks: recentTasks.map((t: any) => ({ id: t.id, title: t.title, result: t.result?.slice(0, 200) })),
          });
        }
      }
    }
  }));

  socket.on("ambient:noise_level", guard((data: { rms: number; isSpeaking: boolean; callState: string; timestamp: string }) => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (!uid) return;
    ambientNoise.set(uid, { rms: data.rms, lastUpdate: data.timestamp });
  }));

  socket.on("ambient:clipboard_report", guard((data: { text: string }) => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (!uid) return;
    const result = detectClipboardChange(uid, data.text || '');
    if (result.changed) {
      const event = getLastEvent(uid, 'clipboard_changed');
      if (event) {
        processActivityEvent(event, uid, io);
      }
    }
  }));

  socket.on("disconnect", () => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (uid) {
      ambientNoise.delete(uid);
      clearActivityStream(uid);
    }
  });
}
