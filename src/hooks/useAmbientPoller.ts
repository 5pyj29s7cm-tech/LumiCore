/**
 * Ambient Poller — periodically reports desktop state to the server
 * for activity stream tracking and proactive trigger evaluation.
 */
import { useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/services/apiBridge';
import { wasDesktopAutomationRecentlyActive } from '@/services/desktopAutomationActivity';

const isTauri = isTauriRuntime();

interface ActivitySnapshot {
  window: { title: string; process_name: string; pid: number };
  idle: { idle_ms: number; idle_seconds: number };
}

let lastWindowTitle = '';
let lastWindowProc = '';
let lastClipboardText = '';

export function useAmbientPoller(socket: Socket | null) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastIdleSecondsRef = useRef<number | null>(null);
  const deferredPhysicalActivityRef = useRef(false);

  useEffect(() => {
    if (!socket || !isTauri) return;

    // Poll window activity every 5s
    const pollWindow = async () => {
      try {
        const snap = await invoke<ActivitySnapshot>('poll_activity');
        const { window: win, idle } = snap;

        // Emit idle report
        socket.emit('ambient:idle_report', idle);
        const previousIdleSeconds = lastIdleSecondsRef.current;
        const idleReset = previousIdleSeconds !== null
          && previousIdleSeconds >= 3
          && idle.idle_seconds <= 2
          && idle.idle_seconds < previousIdleSeconds;
        if (idleReset && !wasDesktopAutomationRecentlyActive()) {
          socket.emit('desktop:user_activity', {
            kind: 'physical_input',
            observedAt: new Date().toISOString(),
            previousIdleSeconds,
            idleSeconds: idle.idle_seconds,
          });
          deferredPhysicalActivityRef.current = false;
        } else if (idleReset) {
          // Lumi input and physical input are indistinguishable at the OS idle
          // counter. Recheck after the automation grace period instead of
          // permanently discarding a possible user takeover.
          deferredPhysicalActivityRef.current = true;
        } else if (
          deferredPhysicalActivityRef.current
          && idle.idle_seconds <= 2
          && !wasDesktopAutomationRecentlyActive()
        ) {
          socket.emit('desktop:user_activity', {
            kind: 'physical_input_after_automation',
            observedAt: new Date().toISOString(),
            previousIdleSeconds,
            idleSeconds: idle.idle_seconds,
          });
          deferredPhysicalActivityRef.current = false;
        } else if (idle.idle_seconds > 2 && !wasDesktopAutomationRecentlyActive()) {
          deferredPhysicalActivityRef.current = false;
        }
        lastIdleSecondsRef.current = idle.idle_seconds;

        // Emit window update if changed
        if (win.title !== lastWindowTitle || win.process_name !== lastWindowProc) {
          lastWindowTitle = win.title;
          lastWindowProc = win.process_name;
          socket.emit('ambient:window_update', win);
        }
      } catch {
        // Tauri commands not available (web mode or app not ready)
      }
    };

    // Poll clipboard every 3s
    const pollClipboard = async () => {
      try {
        const text = await invoke<string>('get_clipboard_text');
        if (text !== lastClipboardText) {
          lastClipboardText = text;
          socket.emit('ambient:clipboard_report', { text });
        }
      } catch {
        // Tauri clipboard not available
      }
    };

    pollWindow(); // initial poll
    pollClipboard();

    const id = setInterval(() => {
      pollWindow();
      pollClipboard();
    }, 5000);
    intervalRef.current = id;

    return () => {
      clearInterval(id);
      lastIdleSecondsRef.current = null;
      deferredPhysicalActivityRef.current = false;
    };
  }, [socket]);
}
