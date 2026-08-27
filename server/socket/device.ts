import { Socket, Server } from "socket.io";
import {
  deviceRegistry,
  nativeClientIdentitiesEqual,
  normalizeNativeClientIdentity,
} from "../devices";
import { registerUserSocket, unregisterUserSocket } from "../memory";
import { isDesktopDeviceType, joinDesktopRelayRoom } from "./desktop_relay";
import { resolveSocketScope } from './scope';

function socketGuard(fn: (...args: any[]) => void | Promise<void>) {
  return (...args: any[]) => {
    try {
      const ret = fn(...args);
      if (ret && typeof (ret as any).catch === 'function') {
        (ret as any).catch((e: any) => console.error('[Device] Handler error:', e.message || String(e)));
      }
    } catch (e: any) {
      console.error('[Device] Handler error:', e.message || String(e));
    }
  };
}

export function registerDeviceHandlers(socket: Socket, getUserId: (s: Socket) => string, io: Server) {
  socket.on("device:register", socketGuard((data: {
    name?: string;
    type?: string;
    capabilities?: Record<string, boolean>;
    osInfo?: string;
    nativeClientIdentity?: unknown;
  }) => {
    const payload = data && typeof data === 'object' ? data : {};
    const uid = getUserId(socket);
    const scope = resolveSocketScope(socket, uid);
    const desktopDevice = isDesktopDeviceType(payload.type);
    if (
      socket.data?.trustedLocalExecution === true
      && socket.data?.nativeClientIdentity?.clientKind === 'tauri'
      && !desktopDevice
    ) {
      socket.emit('device:registration_error', {
        code: 'NATIVE_DESKTOP_REGISTRATION_REQUIRED',
        message: 'A proof-bound native client may register only its desktop execution target.',
      });
      return;
    }
    if (desktopDevice && socket.data?.trustedLocalExecution !== true) {
      socket.emit('device:registration_error', {
        code: 'DESKTOP_SESSION_PROOF_REQUIRED',
        message: 'A verified native desktop session is required to register a desktop execution target.',
      });
      return;
    }
    let nativeClientIdentity = null;
    if (desktopDevice) {
      nativeClientIdentity = normalizeNativeClientIdentity(payload.nativeClientIdentity);
      const proofBoundIdentity = socket.data?.nativeClientIdentity || null;
      if (
        !nativeClientIdentity
        || nativeClientIdentity.clientKind !== 'tauri'
        || !nativeClientIdentitiesEqual(nativeClientIdentity, proofBoundIdentity)
      ) {
        socket.emit('device:registration_error', {
          code: 'NATIVE_CLIENT_IDENTITY_MISMATCH',
          message: 'The native client process identity did not match the verified desktop session.',
        });
        return;
      }
    } else if (payload.nativeClientIdentity !== undefined) {
      socket.emit('device:registration_error', {
        code: 'NATIVE_CLIENT_IDENTITY_NOT_ALLOWED',
        message: 'Native process identity is accepted only from a verified desktop session.',
      });
      return;
    }
    const fingerprint = (socket.handshake.auth as any)?.fingerprint || socket.id;
    const registeredDevice = deviceRegistry.register(uid, socket.id, {
      name: payload.name,
      type: payload.type as any,
      capabilities: payload.capabilities as any,
      osInfo: payload.osInfo,
      ipAddress: socket.handshake.address,
      deviceFingerprint: fingerprint,
      domain: scope.domain,
      orgId: scope.orgId,
      nativeClientIdentity,
    });
    socket.data.lumiDeviceId = registeredDevice.id;
    registerUserSocket(uid, socket.id);
    joinDesktopRelayRoom(socket, uid, payload.type, scope.domain, scope.orgId);
  }));

  socket.on("disconnect", socketGuard(() => {
    const uid = getUserId(socket);
    deviceRegistry.disconnect(socket.id);
    unregisterUserSocket(socket.id);
  }));
}
