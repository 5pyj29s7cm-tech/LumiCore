import './helpers';
import { createServer, type Server as HttpServer } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { addMember, createOrg } from '../server/org/db';
import { attachOrgWs, broadcastToOrg, getOrgConnectionCount } from '../server/org/ws_sync';

function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, value => {
      clearTimeout(timeout);
      resolve(value as T);
    });
  });
}

describe('organization WebSocket authorization', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `ws-owner-${suffix}`;
  const memberId = `ws-member-${suffix}`;
  let orgId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let ownerSocket: Socket;
  let memberSocket: Socket;

  beforeAll(async () => {
    await initDatabase();
    orgId = createOrg(`WS Org ${suffix}`, `ws-org-${suffix}`, ownerId).id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberId, 'member');

    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    io.use((socket, next) => {
      socket.data.authenticatedUserId = String(socket.handshake.auth.userId || '');
      socket.data.authenticatedOrgId = String(socket.handshake.auth.orgId || '');
      next();
    });
    attachOrgWs(io);
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to bind WebSocket test server');
    const url = `http://127.0.0.1:${address.port}`;
    ownerSocket = createSocketClient(url, { transports: ['websocket'], auth: { userId: ownerId, orgId } });
    memberSocket = createSocketClient(url, { transports: ['websocket'], auth: { userId: memberId, orgId } });
    await Promise.all([waitForEvent(ownerSocket, 'connect'), waitForEvent(memberSocket, 'connect')]);
  });

  afterAll(async () => {
    ownerSocket?.disconnect();
    memberSocket?.disconnect();
    await new Promise<void>(resolve => io?.close(() => resolve()));
    await new Promise<void>(resolve => httpServer?.close(() => resolve()));
  });

  it('never acknowledges volatile WebSocket sync as persisted', async () => {
    const ackPromise = waitForEvent<any>(memberSocket, 'org:sync:ack');
    memberSocket.emit('org:sync', {
      orgId,
      payload: { memories: [{ id: 'volatile-only' }] },
    });
    await expect(ackPromise).resolves.toMatchObject({
      received: false,
      persisted: false,
      count: 1,
    });
  });

  it('allows only live administrators to invalidate organization KB caches', async () => {
    const deniedPromise = waitForEvent<any>(memberSocket, 'org:kb:invalidate:denied');
    memberSocket.emit('org:kb:invalidate', { orgId });
    await expect(deniedPromise).resolves.toMatchObject({ error: expect.stringMatching(/administrator/i) });

    const stalePromise = waitForEvent<any>(ownerSocket, 'org:kb:stale');
    ownerSocket.emit('org:kb:invalidate', { orgId });
    await expect(stalePromise).resolves.toMatchObject({ orgId });
  });

  it('removes suspended members from resource notification broadcasts', async () => {
    const db = readDB();
    const membership = db.orgMemberships.find((item: any) => item.orgId === orgId && item.userId === memberId);
    membership.status = 'suspended';
    writeDB(db);
    let memberReceived = false;
    memberSocket.once('org:test:resource', () => { memberReceived = true; });
    const ownerReceived = waitForEvent<any>(ownerSocket, 'org:test:resource');
    broadcastToOrg(orgId, 'org:test:resource', { resourceId: 'metadata-only' });
    await expect(ownerReceived).resolves.toMatchObject({ resourceId: 'metadata-only' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(memberReceived).toBe(false);
    expect(getOrgConnectionCount(orgId)).toBe(1);
  });
});
