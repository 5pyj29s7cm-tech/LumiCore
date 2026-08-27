import { createHash, randomUUID } from "crypto";
import type { Server, Socket } from "socket.io";
import { deviceRegistry } from "../devices";
import { captureNativeUiSnapshot, runNativeUiAction } from "../external_control/native_ui";
import {
  executeTaskRegressionDesktopRelay,
  hasTaskRegressionDesktopRelayAuthorization,
} from "../evidence/task_regression_desktop_relay";
import {
  acquireDesktopControlLease,
  type DesktopControlLeaseHandle,
  type DesktopControlLeaseSnapshot,
  type DesktopControlWindowBinding,
} from "../desktop/control_lease";

type DesktopRelayPayload = {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
};

type DesktopRelayResult = {
  output?: string;
  error?: string;
};

type PendingDesktopRelay = {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  onDisconnect?: () => void;
  onAbort?: () => void;
  signal?: AbortSignal;
  requestSocket?: Socket;
  targetSocketId?: string;
};

export type DesktopRelayLifecycle = (event: {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  error?: string;
}) => void;

export type DesktopRelayOptions = {
  io: Server;
  userId: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  source: 'chat' | 'task' | 'voice' | 'autonomous' | string;
  requestSocket?: Socket;
  emitToolLifecycle?: DesktopRelayLifecycle;
  formatResultForLifecycle?: (output: string) => string;
  timeoutMs?: number;
  cancelOnRequestSocketDisconnect?: boolean;
  signal?: AbortSignal;
  taskId?: string;
  requestId?: string;
  leaseTimeoutMs?: number;
  leaseDurationMs?: number;
  onControlPaused?: (reason: string) => void;
};

export type DesktopRelay = ((toolName: string, args?: Record<string, any>) => Promise<string>) & {
  releaseControlLease: (reason?: string) => void;
  getControlLease: () => DesktopControlLeaseSnapshot | null;
};

const pendingDesktopRelays = new Map<string, PendingDesktopRelay>();
const LOCAL_DESKTOP_UI_TOOLS = new Set([
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
]);

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return { signal: active[0], dispose: () => undefined };
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of active) {
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) listener();
    else {
      signal.addEventListener('abort', listener, { once: true });
      listeners.push({ signal, listener });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of listeners) item.signal.removeEventListener('abort', item.listener);
    },
  };
}

function extractDesktopWindowBinding(output: string): DesktopControlWindowBinding | null {
  try {
    const parsed = JSON.parse(output || '{}');
    const active = parsed?.activeWindow || parsed?.window || parsed?.foregroundWindow || parsed;
    if (!active || typeof active !== 'object') return null;
    const title = String(active.title || active.windowTitle || '').trim();
    const processName = String(active.process_name || active.processName || active.executable || '').trim();
    if (!title && !processName) return null;
    const identity = {
      title,
      processName,
      processId: Number(active.pid || active.processId || 0) || undefined,
      nativeWindowHandle: Number(active.nativeWindowHandle || active.hwnd || active.windowId || 0) || undefined,
      displayId: String(active.displayId || active.monitorId || '').trim() || undefined,
    };
    return {
      ...identity,
      fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      observedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function isCoLocatedNativeDesktopRuntime(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (platform === 'win32' || platform === 'darwin')
    && env.LUMI_DESKTOP === '1';
}

async function runLocalDesktopUiTool(
  toolName: string,
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
  if (toolName === 'desktop_ui_snapshot') {
    return JSON.stringify(await captureNativeUiSnapshot({ ...args, signal }), null, 2);
  }
  const action = {
    desktop_ui_focus: 'focus',
    desktop_ui_click: 'click',
    desktop_ui_invoke: 'invoke',
    desktop_ui_type: 'type',
  }[toolName] as 'focus' | 'click' | 'invoke' | 'type' | undefined;
  if (!action) return null;
  return JSON.stringify(await runNativeUiAction({ ...args, action, signal }), null, 2);
}

function normalizeDesktopScope(domain?: string, orgId?: string) {
  const normalizedOrgId = String(orgId || '').trim();
  return domain === 'work' && normalizedOrgId
    ? { domain: 'work' as const, orgId: normalizedOrgId }
    : { domain: 'personal' as const, orgId: '' };
}

export function desktopRelayRoomForUser(userId: string, domain?: 'personal' | 'work', orgId?: string): string {
  const scope = normalizeDesktopScope(domain, orgId);
  const suffix = scope.domain === 'work' ? `org:${scope.orgId}` : 'personal';
  return `desktop:${userId || 'anonymous'}:${suffix}`;
}

export function isDesktopDeviceType(type?: string): boolean {
  return /^(desktop|tauri|windows|macos|linux)$/i.test(String(type || '').trim());
}

export function joinDesktopRelayRoom(
  socket: Socket,
  userId: string,
  deviceType?: string,
  domain?: 'personal' | 'work',
  orgId?: string,
): boolean {
  // Device metadata is caller-controlled. A remote web/socket client must not
  // become an execution target merely by registering itself as "desktop".
  // The Socket.IO middleware owns this proof-backed bit.
  if (socket.data?.trustedLocalExecution !== true) return false;
  if (!isDesktopDeviceType(deviceType)) return false;
  const scope = normalizeDesktopScope(domain, orgId);
  socket.join(desktopRelayRoomForUser(userId, scope.domain, scope.orgId));
  socket.data.lumiDeviceType = 'desktop';
  socket.data.lumiDesktopDomain = scope.domain;
  socket.data.lumiDesktopOrgId = scope.orgId;
  return true;
}

export function getPreferredDesktopSocketId(userId: string, domain?: 'personal' | 'work', orgId?: string): string | null {
  const scope = normalizeDesktopScope(domain, orgId);
  const devices = deviceRegistry.getActiveDevices(userId, scope)
    .filter(device => isDesktopDeviceType(device.type) && Boolean(device.socketId))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return devices[0]?.socketId || null;
}

export function handleDesktopRelayResult(correlationId: string, data: DesktopRelayResult = {}, senderSocketId?: string): boolean {
  const pending = pendingDesktopRelays.get(correlationId);
  if (!pending) return false;
  if (!senderSocketId || !pending.targetSocketId || senderSocketId !== pending.targetSocketId) return false;

  pendingDesktopRelays.delete(correlationId);
  clearTimeout(pending.timeout);
  if (pending.requestSocket && pending.onDisconnect) {
    pending.requestSocket.off('disconnect', pending.onDisconnect);
  }
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener('abort', pending.onAbort);
  }

  if (data.error) pending.reject(new Error(data.error));
  else pending.resolve(data.output || '');
  return true;
}

export function getPendingDesktopRelayCount(): number {
  return pendingDesktopRelays.size;
}

export function createDesktopRelay(options: DesktopRelayOptions): DesktopRelay {
  const timeoutMs = options.timeoutMs ?? 60000;
  const cancelOnDisconnect = options.cancelOnRequestSocketDisconnect ?? false;
  const scope = normalizeDesktopScope(options.domain, options.orgId);
  const leaseTaskId = String(options.taskId || '').trim();
  const autoReleaseLease = !leaseTaskId;
  let controlLease: DesktopControlLeaseHandle | null = null;
  let acquiringLease: Promise<DesktopControlLeaseHandle> | null = null;
  let controlPausedReason = '';

  const emitControlState = (snapshot: DesktopControlLeaseSnapshot) => {
    const room = scope.domain === 'work' && scope.orgId
      ? `org:${scope.orgId}`
      : `user:${options.userId}:personal`;
    options.io.to(room).emit('agent:desktop_control_state', {
      ...snapshot,
      domain: scope.domain,
      orgId: scope.orgId,
    });
  };
  const ensureControlLease = async (): Promise<DesktopControlLeaseHandle> => {
    if (controlPausedReason) {
      throw new Error(`Desktop control is paused: ${controlPausedReason}`);
    }
    if (controlLease?.heartbeat(options.leaseDurationMs)) return controlLease;
    if (!acquiringLease) {
      acquiringLease = acquireDesktopControlLease({
        userId: options.userId,
        taskId: leaseTaskId || `${options.source}:${randomUUID()}`,
        source: options.source,
        signal: options.signal,
        timeoutMs: options.leaseTimeoutMs,
        leaseMs: options.leaseDurationMs,
        onStateChange: emitControlState,
        onPause: reason => {
          controlPausedReason = reason;
          options.onControlPaused?.(reason);
          emitControlState(controlLease?.snapshot() || {
            leaseId: '',
            userId: options.userId,
            taskId: leaseTaskId,
            source: options.source,
            priority: 0,
            status: 'paused',
            reason,
            updatedAt: new Date().toISOString(),
          });
        },
      }).then(lease => {
        controlLease = lease;
        return lease;
      }).finally(() => {
        acquiringLease = null;
      });
    }
    return acquiringLease;
  };

  const relay = async (toolName: string, args: Record<string, any> = {}): Promise<string> => {
    if (
      options.requestSocket
      && options.requestSocket.data?.trustedLocalExecution !== true
    ) {
      throw new Error(`Desktop tool "${toolName}" is unavailable on remote execution surfaces.`);
    }
    if (options.signal?.aborted) {
      throw new Error(`Desktop tool "${toolName}" cancelled before execution`);
    }
    const lease = await ensureControlLease();
    const combined = combineAbortSignals([options.signal, lease.signal]);
    const executionSignal = combined.signal;
    try {
      if (
        [
          'desktop_write_text_file',
          'desktop_active_window',
          'desktop_list_files',
          'desktop_read_text_file',
        ].includes(toolName)
        && options.requestSocket
        && hasTaskRegressionDesktopRelayAuthorization(options.requestSocket)
      ) {
        const regressionCorrelationId = `desktop-${options.source}_${randomUUID()}`;
        options.emitToolLifecycle?.({
          correlationId: regressionCorrelationId,
          name: toolName,
          arguments: args,
        });
        try {
          const regressionResult = executeTaskRegressionDesktopRelay(
            options.requestSocket,
            toolName,
            args,
            String(options.requestId || ''),
          );
          options.emitToolLifecycle?.({
            correlationId: regressionCorrelationId,
            name: toolName,
            arguments: args,
            result: options.formatResultForLifecycle
              ? options.formatResultForLifecycle(regressionResult)
              : regressionResult,
          });
          return regressionResult;
        } catch (error: any) {
          const message = error?.message || String(error);
          options.emitToolLifecycle?.({
            correlationId: regressionCorrelationId,
            name: toolName,
            arguments: args,
            error: message,
          });
          throw error;
        }
      }
      if (LOCAL_DESKTOP_UI_TOOLS.has(toolName) && !isCoLocatedNativeDesktopRuntime()) {
        throw new Error(
          `Native desktop UI tool "${toolName}" is blocked because the server is not proven to share the selected Windows/macOS desktop session. Use computer_use on the connected desktop instead.`,
        );
      }
      if (isCoLocatedNativeDesktopRuntime() && LOCAL_DESKTOP_UI_TOOLS.has(toolName)) {
        const localUiCorrelationId = `desktop-${options.source}_${randomUUID()}`;
        try {
          const localUiResult = await runLocalDesktopUiTool(toolName, args, executionSignal);
          if (localUiResult !== null) {
            options.emitToolLifecycle?.({
              correlationId: localUiCorrelationId,
              name: toolName,
              arguments: args,
            });
            options.emitToolLifecycle?.({
              correlationId: localUiCorrelationId,
              name: toolName,
              arguments: args,
              result: options.formatResultForLifecycle
                ? options.formatResultForLifecycle(localUiResult)
                : localUiResult,
            });
            if (/^(?:desktop_active_window|desktop_ui_snapshot)$/i.test(toolName)) {
              const binding = extractDesktopWindowBinding(localUiResult);
              if (binding) lease.bindWindow(binding);
            }
            return localUiResult;
          }
        } catch (error: any) {
          const message = error?.message || String(error);
          options.emitToolLifecycle?.({
            correlationId: localUiCorrelationId,
            name: toolName,
            arguments: args,
            error: message,
          });
          throw error;
        }
      }

      const output = await new Promise<string>((resolve, reject) => {
      const cid = `${options.source}_${randomUUID()}`;
      const uiCid = `desktop-${cid}`;
      const room = desktopRelayRoomForUser(options.userId, scope.domain, scope.orgId);
      const payload: DesktopRelayPayload = { correlationId: cid, name: toolName, arguments: args };
      let settled = false;

      options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args });

      const finishWithError = (message: string) => {
        if (settled) return;
        settled = true;
        const pending = pendingDesktopRelays.get(cid);
        if (pending) {
          pendingDesktopRelays.delete(cid);
          clearTimeout(pending.timeout);
          if (pending.requestSocket && pending.onDisconnect) {
            pending.requestSocket.off('disconnect', pending.onDisconnect);
          }
          if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener('abort', pending.onAbort);
          }
        }
        options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args, error: message });
        reject(new Error(message));
      };

      const timeout = setTimeout(() => {
        finishWithError(`Desktop tool "${toolName}" timed out (${Math.round(timeoutMs / 1000)}s)`);
      }, timeoutMs);

      const onDisconnect = () => {
        finishWithError(`Desktop tool "${toolName}" cancelled: requesting client disconnected before returning a result`);
      };

      const onAbort = () => {
        const targetSocketId = pendingDesktopRelays.get(cid)?.targetSocketId;
        if (targetSocketId) {
          options.io.sockets.sockets.get(targetSocketId)?.emit('tool:desktop_cancel', {
            correlationId: cid,
            name: toolName,
          });
        }
        finishWithError(`Desktop tool "${toolName}" cancelled because the active task was stopped or superseded`);
      };

      pendingDesktopRelays.set(cid, {
        resolve: (output: string) => {
          if (settled) return;
          settled = true;
          options.emitToolLifecycle?.({
            correlationId: uiCid,
            name: toolName,
            arguments: args,
            result: options.formatResultForLifecycle ? options.formatResultForLifecycle(output) : output,
          });
          resolve(output);
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          options.emitToolLifecycle?.({ correlationId: uiCid, name: toolName, arguments: args, error: err.message });
          reject(err);
        },
        timeout,
        onDisconnect: cancelOnDisconnect ? onDisconnect : undefined,
        onAbort,
        signal: executionSignal,
        requestSocket: cancelOnDisconnect ? options.requestSocket : undefined,
      });

      const emitToDesktopTarget = (socketId: string): boolean => {
        const targetSocket = options.io.sockets.sockets.get(socketId);
        if (!targetSocket?.connected || targetSocket.data?.trustedLocalExecution !== true) return false;
        const pending = pendingDesktopRelays.get(cid);
        if (!pending) return false;
        pending.targetSocketId = socketId;
        targetSocket.emit('tool:desktop_exec', payload);
        return true;
      };

      if (cancelOnDisconnect && options.requestSocket) {
        options.requestSocket.once('disconnect', onDisconnect);
      }
      if (executionSignal) {
        executionSignal.addEventListener('abort', onAbort, { once: true });
        if (executionSignal.aborted) {
          onAbort();
          return;
        }
      }

      const preferredSocketId = getPreferredDesktopSocketId(options.userId, scope.domain, scope.orgId);
      if (preferredSocketId && emitToDesktopTarget(preferredSocketId)) return;

      const roomSockets = options.io.sockets.adapter.rooms.get(room);
      if (roomSockets?.size === 1) {
        if (emitToDesktopTarget(Array.from(roomSockets)[0])) return;
      }

      const requestSocketMatchesScope = options.requestSocket?.data?.lumiDeviceType === 'desktop'
        && (options.requestSocket.data.lumiDesktopDomain || 'personal') === scope.domain
        && String(options.requestSocket.data.lumiDesktopOrgId || '') === scope.orgId;
      if (options.requestSocket?.connected && requestSocketMatchesScope) {
        if (emitToDesktopTarget(options.requestSocket.id)) return;
      }

      finishWithError(`Desktop tool "${toolName}" cannot run: no desktop client is connected for this user`);
      });
      if (/^(?:desktop_active_window|desktop_ui_snapshot)$/i.test(toolName)) {
        const binding = extractDesktopWindowBinding(output);
        if (binding) lease.bindWindow(binding);
      }
      return output;
    } finally {
      combined.dispose();
      if (autoReleaseLease) {
        lease.release('desktop_single_call_complete');
        if (controlLease?.leaseId === lease.leaseId) controlLease = null;
      }
    }
  };
  const typedRelay = relay as DesktopRelay;
  typedRelay.releaseControlLease = (reason = 'desktop_task_complete') => {
    controlLease?.release(reason);
    controlLease = null;
  };
  typedRelay.getControlLease = () => controlLease?.snapshot() || null;
  return typedRelay;
}
