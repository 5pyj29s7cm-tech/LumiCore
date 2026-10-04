import { Socket, Server } from "socket.io";
import { pushActivityEvent, setIdleState, getIdleState, clearActivityStream } from "../context/activity_stream";
import { detectClipboardChange } from "../context/clipboard_monitor";
import { reportIdleState } from "../autonomy/safety_gate";
import { getTaskHistory } from "../autonomy/task_queue";
import { reportDesktopUserActivity } from "../desktop/control_lease";

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

export function registerAmbientHandlers(socket: Socket, getUserId: (s: Socket) => string, _io: Server) {
  const isWorkDomainSocket = () => Boolean(String(socket.data?.authenticatedOrgId || '').trim());

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
    const event = { type: 'window_changed' as const, timestamp: new Date().toISOString(), data };
    pushActivityEvent(uid, event);
    // Passive desktop awareness is context only. It must never initiate a
    // suggestion, notification, chat message, spoken prompt, or popup.
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

  socket.on("desktop:user_activity", guard((data: { kind?: string; observedAt?: string; activityAt?: string }) => {
    const uid = getUserId(socket);
    if (!uid || socket.data?.lumiDeviceType !== 'desktop') return;
    const paused = reportDesktopUserActivity(uid, undefined, data?.activityAt);
    socket.emit('desktop:user_activity_ack', {
      ok: true,
      kind: String(data?.kind || 'physical_input'),
      observedAt: String(data?.observedAt || new Date().toISOString()),
      pausedTaskId: paused?.taskId || '',
      pausedLeaseId: paused?.leaseId || '',
    });
  }));

  socket.on("ambient:clipboard_report", guard((data: { text: string }) => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (!uid) return;
    // Clipboard observations remain available as short-lived context, but do
    // not turn copied content into unsolicited prompts.
    detectClipboardChange(uid, data.text || '');
  }));

  socket.on("disconnect", () => {
    if (isWorkDomainSocket()) return;
    const uid = getUserId(socket);
    if (uid) {
      clearActivityStream(uid);
    }
  });
}
