import { randomUUID } from "crypto";
import type { Server, Socket } from "socket.io";
import { deviceRegistry } from "../devices";

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
  source: 'chat' | 'task' | 'voice' | 'autonomous' | string;
  requestSocket?: Socket;
  emitToolLifecycle?: DesktopRelayLifecycle;
  formatResultForLifecycle?: (output: string) => string;
  timeoutMs?: number;
  cancelOnRequestSocketDisconnect?: boolean;
};

const pendingDesktopRelays = new Map<string, PendingDesktopRelay>();

export function desktopRelayRoomForUser(userId: string): string {
  return `desktop:${userId || 'anonymous'}`;
}

export function isDesktopDeviceType(type?: string): boolean {
  return /^(desktop|tauri|windows|macos|linux)$/i.test(String(type || '').trim());
}

export function joinDesktopRelayRoom(socket: Socket, userId: string, deviceType?: string): boolean {
  if (!isDesktopDeviceType(deviceType)) return false;
  socket.join(desktopRelayRoomForUser(userId));
  socket.data.lumiDeviceType = 'desktop';
  return true;
}

export function getPreferredDesktopSocketId(userId: string): string | null {
  const devices = deviceRegistry.getActiveDevices(userId)
    .filter(device => isDesktopDeviceType(device.type) && Boolean(device.socketId))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return devices[0]?.socketId || null;
}

export function handleDesktopRelayResult(correlationId: string, data: DesktopRelayResult = {}): boolean {
  const pending = pendingDesktopRelays.get(correlationId);
  if (!pending) return false;

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
  const timeoutMs = options.timeoutMs ?? 30000;
  const cancelOnDisconnect = options.cancelOnRequestSocketDisconnect ?? false;

  return async (toolName: string, args: Record<string, any> = {}): Promise<string> => {
    return new Promise((resolve, reject) => {
      const cid = `${options.source}_${randomUUID()}`;
      const uiCid = `desktop-${cid}`;
      const room = desktopRelayRoomForUser(options.userId);
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

      if (cancelOnDisconnect && options.requestSocket) {
        options.requestSocket.once('disconnect', onDisconnect);
      }

      const preferredSocketId = getPreferredDesktopSocketId(options.userId);
      if (preferredSocketId) {
        const targetSocket = options.io.sockets.sockets.get(preferredSocketId);
        if (targetSocket?.connected) {
          targetSocket.emit('tool:desktop_exec', payload);
          return;
        }
      }

      const roomSockets = options.io.sockets.adapter.rooms.get(room);
      if (roomSockets?.size === 1) {
        options.io.to(Array.from(roomSockets)[0]).emit('tool:desktop_exec', payload);
        return;
      }

      if (options.requestSocket?.connected) {
        options.requestSocket.emit('tool:desktop_exec', payload);
        return;
      }

      finishWithError(`Desktop tool "${toolName}" cannot run: no desktop client is connected for this user`);
    });
  };
}
