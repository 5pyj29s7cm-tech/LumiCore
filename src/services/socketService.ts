import { io, Socket } from "socket.io-client";
import { getSocketOrigin } from "./apiBridge";
import {
  bootstrap,
  getDesktopSessionProof,
  getStoredToken,
  isNativeDesktopRuntime,
} from "./authService";

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
const LAST_RECOVERY_REASON_KEY = 'lumi_last_recovery_reason';
const MAX_RUNTIME_EVENTS = 80;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let disconnectSince: number | null = null;
let lastForcedReconnectAt = 0;
let reportedPreviousRecovery = false;
const HEARTBEAT_INTERVAL_MS = 5_000;
const DISCONNECT_RECOVERY_MS = 30_000;
const SERVER_UNREACHABLE_RECOVERY_MS = 60_000;
const FORCE_RECONNECT_THROTTLE_MS = 10_000;

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

function markRecoveryReason(reason: string, detail: Record<string, unknown>) {
  const payload = { at: new Date().toISOString(), reason, detail };
  try {
    sessionStorage.setItem(LAST_RECOVERY_REASON_KEY, JSON.stringify(payload));
    localStorage.setItem(LAST_RECOVERY_REASON_KEY, JSON.stringify(payload));
  } catch {}
  recordRuntimeEvent('socket_recovery_requested', payload);
  return payload;
}

function reportPreviousRecoveryReason() {
  if (reportedPreviousRecovery) return;
  reportedPreviousRecovery = true;
  try {
    const raw = sessionStorage.getItem(LAST_RECOVERY_REASON_KEY) || localStorage.getItem(LAST_RECOVERY_REASON_KEY);
    if (!raw) {
      recordRuntimeEvent('page_started');
      return;
    }
    const payload = JSON.parse(raw);
    console.warn('[Lumi runtime] Previous socket recovery:', payload);
    recordRuntimeEvent('page_started_after_socket_recovery', payload);
    sessionStorage.removeItem(LAST_RECOVERY_REASON_KEY);
  } catch {
    recordRuntimeEvent('page_started');
  }
}

function forceReconnect(socket: Socket, reason: string, detail: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastForcedReconnectAt < FORCE_RECONNECT_THROTTLE_MS) return;
  lastForcedReconnectAt = now;
  const payload = markRecoveryReason(reason, detail);
  console.warn('[Watchdog] Socket disconnected; forcing reconnect instead of reloading WebView', payload);
  try {
    socket.disconnect();
  } catch {}
  window.setTimeout(() => {
    try {
      socket.connect();
    } catch (err: any) {
      recordRuntimeEvent('socket_force_reconnect_failed', { message: err?.message || String(err) });
    }
  }, 250);
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

  // Periodic check: keep reconnecting in place. The native shell owns backend restarts.
  const checkInterval = setInterval(() => {
    if (disconnectSince && (Date.now() - disconnectSince) > DISCONNECT_RECOVERY_MS) {
      const durationMs = Date.now() - disconnectSince;
      forceReconnect(socket, 'socket_disconnected_reconnect', { durationMs });
    }
    // Also ping the server directly as a secondary health check
    const token = getStoredToken();
    if (token) {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {
        // If fetch fails AND socket is disconnected, keep nudging the socket.
        if (disconnectSince && (Date.now() - disconnectSince) > SERVER_UNREACHABLE_RECOVERY_MS) {
          const durationMs = Date.now() - disconnectSince;
          forceReconnect(socket, 'server_unreachable_socket_reconnect', { durationMs });
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
        forceReconnect(socket, 'socket_visible_reconnect', { durationMs });
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
  private desktopSessionProof: string | null = null;
  private watchdogCleanup: (() => void) | null = null;
  private nativeProofRefreshInFlight = false;
  private lastNativeProofRefreshAt = 0;

  private async refreshExpiredNativeProof(reason: string) {
    if (!isNativeDesktopRuntime() || this.nativeProofRefreshInFlight) return;
    const now = Date.now();
    if (now - this.lastNativeProofRefreshAt < 5_000) return;
    this.lastNativeProofRefreshAt = now;
    this.nativeProofRefreshInFlight = true;
    recordRuntimeEvent('desktop_session_proof_refresh_started', { reason });
    try {
      const result = await bootstrap();
      if (!result.success || !result.desktopSessionProof) {
        recordRuntimeEvent('desktop_session_proof_refresh_failed', {
          reason,
          message: result.error || 'Native bootstrap returned no desktop session proof',
        });
        return;
      }
      recordRuntimeEvent('desktop_session_proof_refreshed', { reason });
      this.refreshAuth();
    } catch (error: any) {
      recordRuntimeEvent('desktop_session_proof_refresh_failed', {
        reason,
        message: error?.message || String(error),
      });
    } finally {
      this.nativeProofRefreshInFlight = false;
    }
  }

  connect() {
    reportPreviousRecoveryReason();
    const token = getStoredToken();
    const desktopSessionProof = getDesktopSessionProof();

    if (!this.socket) {
      this.token = token;
      this.desktopSessionProof = desktopSessionProof;
      this.socket = io(getSocketOrigin(), {
        withCredentials: true,
        auth: { token, fingerprint: DEVICE_FINGERPRINT, desktopSessionProof },
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
        if ((err as any)?.data?.code === 'DESKTOP_SESSION_PROOF_REQUIRED') {
          void this.refreshExpiredNativeProof('socket_connect_error');
        }
      });

      this.socket.on('runtime:execution_boundary', (boundary: any) => {
        if (boundary?.trustedLocalExecution !== true) {
          void this.refreshExpiredNativeProof('socket_remote_restricted_boundary');
        }
      });

      this.watchdogCleanup = startWatchdog(this.socket);
    } else if (token !== this.token || desktopSessionProof !== this.desktopSessionProof) {
      this.token = token;
      this.desktopSessionProof = desktopSessionProof;
      this.socket.auth = { token, fingerprint: DEVICE_FINGERPRINT, desktopSessionProof };
      recordRuntimeEvent('socket_auth_token_changed');
      this.socket.disconnect().connect();
    }
    return this.socket;
  }

  refreshAuth() {
    const token = getStoredToken();
    const desktopSessionProof = getDesktopSessionProof();
    this.token = token;
    this.desktopSessionProof = desktopSessionProof;
    if (!this.socket) return null;
    this.socket.auth = { token, fingerprint: DEVICE_FINGERPRINT, desktopSessionProof };
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
      this.desktopSessionProof = null;
    }
  }
}

export const socketService = new SocketService();
