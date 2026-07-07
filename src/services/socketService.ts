import { io, Socket } from "socket.io-client";
import { getSocketOrigin } from "./apiBridge";
import { getStoredToken } from "./authService";

function getDeviceFingerprint(): string {
  const key = 'lumi_device_fingerprint';
  let fp: string | null = null;
  try { fp = localStorage.getItem(key); } catch {}
  if (!fp) {
    fp = `${navigator.platform || 'unknown'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try { localStorage.setItem(key, fp); } catch {}
  }
  return fp;
}

const DEVICE_FINGERPRINT = getDeviceFingerprint();

const HEARTBEAT_KEY = 'lumi_page_heartbeat';
const RUNTIME_EVENTS_KEY = 'lumi_runtime_events';
const LAST_RELOAD_REASON_KEY = 'lumi_last_reload_reason';
const MAX_RUNTIME_EVENTS = 80;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let disconnectSince: number | null = null;
let reportedPreviousReload = false;
const DISCONNECT_RELOAD_MS = 120_000; // 2 minutes disconnected → reload
const HEARTBEAT_INTERVAL_MS = 5_000;

type RuntimeEvent = {
  at: string;
  type: string;
  detail?: Record<string, unknown>;
};

function recordRuntimeEvent(type: string, detail: Record<string, unknown> = {}) {
  const event: RuntimeEvent = { at: new Date().toISOString(), type, detail };
  try {
    const parsed = JSON.parse(localStorage.getItem(RUNTIME_EVENTS_KEY) || '[]');
    const history = Array.isArray(parsed) ? parsed.slice(-(MAX_RUNTIME_EVENTS - 1)) : [];
    history.push(event);
    localStorage.setItem(RUNTIME_EVENTS_KEY, JSON.stringify(history));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('lumi:runtime-event', { detail: event }));
  } catch {}
  return event;
}

function markReloadReason(reason: string, detail: Record<string, unknown>) {
  const payload = { at: new Date().toISOString(), reason, detail };
  try {
    sessionStorage.setItem(LAST_RELOAD_REASON_KEY, JSON.stringify(payload));
    localStorage.setItem(LAST_RELOAD_REASON_KEY, JSON.stringify(payload));
  } catch {}
  recordRuntimeEvent('watchdog_reload_requested', payload);
  return payload;
}

function reportPreviousReloadReason() {
  if (reportedPreviousReload) return;
  reportedPreviousReload = true;
  try {
    const raw = sessionStorage.getItem(LAST_RELOAD_REASON_KEY) || localStorage.getItem(LAST_RELOAD_REASON_KEY);
    if (!raw) {
      recordRuntimeEvent('page_started');
      return;
    }
    const payload = JSON.parse(raw);
    console.warn('[Lumi runtime] Previous WebView reload reason:', payload);
    recordRuntimeEvent('page_recovered_after_reload', payload);
    sessionStorage.removeItem(LAST_RELOAD_REASON_KEY);
  } catch {
    recordRuntimeEvent('page_started');
  }
}

function startWatchdog(socket: Socket) {
  // Heartbeat to localStorage — survives page crashes and lets us detect recovery
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      try { localStorage.setItem(HEARTBEAT_KEY, String(Date.now())); } catch {}
    }, HEARTBEAT_INTERVAL_MS);
  }

  socket.on("connect", () => {
    recordRuntimeEvent('socket_connected', { id: socket.id });
    disconnectSince = null;
  });

  socket.on("disconnect", (reason) => {
    recordRuntimeEvent('socket_disconnected', { reason });
    if (disconnectSince === null) disconnectSince = Date.now();
  });

  socket.on("connect_error", (err) => {
    recordRuntimeEvent('socket_connect_error', { message: err.message });
  });

  // Periodic check: if disconnected for too long, reload to restore the WebView2 renderer
  const checkInterval = setInterval(() => {
    if (disconnectSince && (Date.now() - disconnectSince) > DISCONNECT_RELOAD_MS) {
      const durationMs = Date.now() - disconnectSince;
      const payload = markReloadReason('socket_disconnected_timeout', { durationMs });
      console.warn('[Watchdog] Socket disconnected for >2min, reloading page to recover renderer', payload);
      clearInterval(checkInterval);
      window.location.reload();
    }
    // Also ping the server directly as a secondary health check
    const token = getStoredToken();
    if (token) {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {
        // If fetch fails AND socket is disconnected, reload sooner
        if (disconnectSince && (Date.now() - disconnectSince) > 60_000) {
          const durationMs = Date.now() - disconnectSince;
          const payload = markReloadReason('server_unreachable_socket_disconnected', { durationMs });
          console.warn('[Watchdog] Server unreachable + socket disconnected >1min, reloading', payload);
          clearInterval(checkInterval);
          window.location.reload();
        }
      });
    }
  }, 30_000);

  // Visibility: when the user returns to the tab, check if we're still connected
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      if (!socket.connected && disconnectSince && (Date.now() - disconnectSince) > 30_000) {
        const durationMs = Date.now() - disconnectSince;
        recordRuntimeEvent('socket_reconnect_on_visible', { durationMs });
        console.warn('[Watchdog] Page became visible but socket disconnected >30s, reconnecting', { durationMs });
        socket.connect();
      }
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  // Return cleanup
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(checkInterval);
  };
}

class SocketService {
  private socket: Socket | null = null;
  private token: string | null = null;
  private watchdogCleanup: (() => void) | null = null;

  connect() {
    reportPreviousReloadReason();
    const token = getStoredToken();

    if (!this.socket) {
      this.token = token;
      this.socket = io(getSocketOrigin(), {
        withCredentials: true,
        auth: { token, fingerprint: DEVICE_FINGERPRINT },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      });

      this.socket.on("connect", () => {
        console.log("[SocketService] Connected, id:", this.socket?.id);
      });

      this.socket.on("disconnect", (reason) => {
        console.log("[SocketService] Disconnected:", reason);
      });

      this.socket.on("connect_error", (err) => {
        console.error("[SocketService] Connect error:", err.message);
      });

      this.watchdogCleanup = startWatchdog(this.socket);
    } else if (token !== this.token) {
      this.token = token;
      this.socket.auth = { token, fingerprint: DEVICE_FINGERPRINT };
      recordRuntimeEvent('socket_auth_token_changed');
      this.socket.disconnect().connect();
    }
    return this.socket;
  }

  refreshAuth() {
    const token = getStoredToken();
    this.token = token;
    if (!this.socket) return null;
    this.socket.auth = { token, fingerprint: DEVICE_FINGERPRINT };
    recordRuntimeEvent('socket_auth_refreshed');
    if (this.socket.connected) {
      this.socket.disconnect().connect();
    } else {
      this.socket.connect();
    }
    return this.socket;
  }

  getSocket() {
    return this.socket;
  }

  disconnect() {
    if (this.watchdogCleanup) {
      this.watchdogCleanup();
      this.watchdogCleanup = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.token = null;
    }
  }
}

export const socketService = new SocketService();
