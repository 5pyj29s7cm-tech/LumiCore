/**
 * Org WebSocket Sync — real-time channel between branches and company server.
 *
 * Attaches to the existing Socket.IO server and adds org-scoped rooms.
 * Branches join their org room on connect; the company server broadcasts
 * events (member changes, template status, KB updates) to all branches in the org.
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { getMember } from './db';
import { removeBranchHeartbeat } from './main_api';

let io: SocketIOServer | null = null;
const branchSockets = new Map<string, Set<string>>(); // userId -> Set<socketId>

// ── Initialize ──────────────────────────────────────────────────────────

export function attachOrgWs(server: SocketIOServer) {
  io = server;

  io.on('connection', (socket: Socket) => {
    const userId = String(socket.data?.authenticatedUserId || 'anonymous');
    const requestedOrgId = String(socket.data?.authenticatedOrgId || '').trim();
    const membership = requestedOrgId ? getMember(requestedOrgId, userId) : null;
    const orgId = membership?.status === 'active' ? requestedOrgId : '';

    // Track branch socket
    if (userId !== 'anonymous') {
      if (!branchSockets.has(userId)) branchSockets.set(userId, new Set());
      branchSockets.get(userId)!.add(socket.id);
    }

    // Join org room if authenticated
    if (orgId) {
      socket.join(`org:${orgId}`);
      socket.data.orgId = orgId;
      socket.data.userId = userId;
      console.log(`[WS:Org] ${userId} joined org:${orgId} on socket ${socket.id}`);
    }

    // ── Branch heartbeat ──────────────────────────────────────────────

    socket.on('org:heartbeat', (data: { orgId: string }) => {
      if (data.orgId === orgId && userId !== 'anonymous') {
        socket.emit('org:heartbeat:ack', { serverTime: new Date().toISOString() });
      }
    });

    // ── Work domain sync push ─────────────────────────────────────────

    socket.on('org:sync', (data: { orgId: string; payload: any }) => {
      // WebSocket delivery has no durable request identity or receipt lookup.
      // Never acknowledge it as persisted: branches must use /branch/ingest.
      if (data.orgId === socket.data.orgId) {
        socket.emit('org:sync:ack', {
          received: false,
          persisted: false,
          count: countSyncItems(data.payload),
          error: 'Durable organization sync requires the branch ingest API and a batch receipt.',
        });
      }
    });

    // ── KB cache invalidation request ─────────────────────────────────

    socket.on('org:kb:invalidate', (data: { orgId: string }) => {
      const liveMembership = data.orgId === socket.data.orgId ? getMember(data.orgId, userId) : null;
      if (liveMembership?.status === 'active' && ['owner', 'admin'].includes(String(liveMembership.role || ''))) {
        // Notify all branches in the org to re-pull KB cache
        broadcastToOrg(data.orgId, 'org:kb:stale', {
          orgId: data.orgId,
          timestamp: new Date().toISOString(),
        });
      } else if (data.orgId === socket.data.orgId) {
        socket.emit('org:kb:invalidate:denied', { error: 'Organization administrator access is required.' });
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      if (userId !== 'anonymous') {
        const sockets = branchSockets.get(userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            branchSockets.delete(userId);
            removeBranchHeartbeat(userId);
          }
        }
      }
      if (socket.data.orgId) {
        console.log(`[WS:Org] ${userId} left org:${socket.data.orgId}`);
      }
    });
  });
}

// ── Broadcast helpers (called by routes / business logic) ───────────────

export function broadcastToOrg(orgId: string, event: string, data: any) {
  if (!io) return;
  const room = io.sockets.adapter.rooms.get(`org:${orgId}`);
  if (!room) return;
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    const userId = String(socket.data?.userId || socket.data?.authenticatedUserId || '');
    const membership = userId ? getMember(orgId, userId) : null;
    if (!membership || membership.status !== 'active') {
      socket.leave(`org:${orgId}`);
      continue;
    }
    socket.emit(event, data);
  }
}

export function broadcastToUser(userId: string, event: string, data: any) {
  if (!io) return;
  const sockets = branchSockets.get(userId);
  if (!sockets) return;
  for (const socketId of sockets) {
    io.to(socketId).emit(event, data);
  }
}

// ── Event emitters ──────────────────────────────────────────────────────

export function emitMemberJoined(orgId: string, userId: string, username: string) {
  broadcastToOrg(orgId, 'member:joined', { userId, username, orgId });
}

export function emitMemberLeft(orgId: string, userId: string) {
  broadcastToOrg(orgId, 'member:left', { userId, orgId });
}

export function emitTemplateSubmitted(orgId: string, templateId: string, authorId: string) {
  broadcastToOrg(orgId, 'template:submitted', { templateId, authorId, orgId });
}

export function emitTemplateStatusChange(orgId: string, templateId: string, status: string) {
  broadcastToOrg(orgId, 'template:status', { templateId, status, orgId });
}

export function emitKbUpdated(orgId: string, articleId: string, action: 'created' | 'updated' | 'deleted') {
  broadcastToOrg(orgId, 'kb:article', { articleId, action, orgId });
}

// ── Auth helpers ────────────────────────────────────────────────────────

function countSyncItems(payload: any): number {
  let count = 0;
  if (payload?.memories) count += payload.memories.length;
  if (payload?.interactions) count += payload.interactions.length;
  if (payload?.agents) count += payload.agents.length;
  return count;
}

// ── Status ──────────────────────────────────────────────────────────────

export function getBranchConnectionCount(): number {
  return branchSockets.size;
}

export function getOrgConnectionCount(orgId: string): number {
  if (io) {
    const room = io.sockets.adapter.rooms.get(`org:${orgId}`);
    return room ? room.size : 0;
  }
  return 0;
}
