import { randomUUID } from "crypto";
import type { Server, Socket } from "socket.io";
import { deviceRegistry } from "../devices";
import { captureWindowsUiSnapshot, runWindowsUiAction } from "../external_control/windows_uia";

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
};

const pendingDesktopRelays = new Map<string, PendingDesktopRelay>();
const LOCAL_DESKTOP_UI_TOOLS = new Set([
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_invoke',
  'desktop_ui_type',
]);

async function runLocalDesktopUiTool(
  toolName: string,
  args: Record<string, any>,
): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  if (toolName === 'desktop_ui_snapshot') {
    return JSON.stringify(await captureWindowsUiSnapshot(args), null, 2);
  }
  const action = {
    desktop_ui_focus: 'focus',
    desktop_ui_click: 'click',
    desktop_ui_invoke: 'invoke',
    desktop_ui_type: 'type',
  }[toolName] as 'focus' | 'click' | 'invoke' | 'type' | undefined;
  if (!action) return null;
  return JSON.stringify(await runWindowsUiAction({ ...args, action }), null, 2);
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

  if (data.error) pending.reject(new Error(data.error));
  else pending.resolve(data.output || '');
  return true;
}

export function getPendingDesktopRelayCount(): number {
  return pendingDesktopRelays.size;
}

export function createDesktopRelay(options: DesktopRelayOptions) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const cancelOnDisconnect = options.cancelOnRequestSocketDisconnect ?? false;
  const scope = normalizeDesktopScope(options.domain, options.orgId);

  return async (toolName: string, args: Record<string, any> = {}): Promise<string> => {
    if (process.platform === 'win32' && LOCAL_DESKTOP_UI_TOOLS.has(toolName)) {
      const localUiCorrelationId = `desktop-${options.source}_${randomUUID()}`;
      try {
        const localUiResult = await runLocalDesktopUiTool(toolName, args);
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

    return new Promise((resolve, reject) => {
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
        requestSocket: cancelOnDisconnect ? options.requestSocket : undefined,
      });

      const emitToDesktopTarget = (socketId: string): boolean => {
        const targetSocket = options.io.sockets.sockets.get(socketId);
        if (!targetSocket?.connected) return false;
        const pending = pendingDesktopRelays.get(cid);
        if (!pending) return false;
        pending.targetSocketId = socketId;
        targetSocket.emit('tool:desktop_exec', payload);
        return true;
      };

      if (cancelOnDisconnect && options.requestSocket) {
        options.requestSocket.once('disconnect', onDisconnect);
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
  };
}
