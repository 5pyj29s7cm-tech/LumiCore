import { Server as SocketIOServer } from 'socket.io';

let _io: SocketIOServer | null = null;
const userSockets: Map<string, Set<string>> = new Map();

export function initMemorySync(io: SocketIOServer): void {
  _io = io;
}

export function registerUserSocket(userId: string, socketId: string): void {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId)!.add(socketId);
}

export function getUserSockets(userId: string): Set<string> {
  return userSockets.get(userId) || new Set();
}

export function unregisterUserSocket(socketId: string): void {
  for (const [uid, sockets] of userSockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) userSockets.delete(uid);
  }
}

/** Broadcast memory change to all connected devices of a user */
export function broadcastMemoryChange(userId: string, action: 'added' | 'updated' | 'deleted', memoryId?: string): void {
  if (!_io) return;
  _io.to(`user:${userId}:personal`).emit('memories:changed', { action, memoryId, userId, domain: 'personal', timestamp: new Date().toISOString() });
}

/** Broadcast device list change */
export function broadcastDeviceChange(userId: string): void {
  if (!_io) return;
  const sockets = userSockets.get(userId);
  if (sockets) {
    for (const sid of sockets) {
      _io.to(sid).emit('devices:update', { timestamp: new Date().toISOString() });
    }
  }
}

/** Broadcast preference change to all devices of a user (pet, accessories, wallpaper, etc.) */
export function broadcastPreferenceChange(userId: string, key: string, value: any): void {
  if (!_io) return;
  const payload = { key, value, userId, domain: 'personal', orgId: '', timestamp: new Date().toISOString() };
  _io.to(`user:${userId}:personal`).emit('preferences:changed', payload);
}
