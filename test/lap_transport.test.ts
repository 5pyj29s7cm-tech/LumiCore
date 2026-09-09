import './helpers';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachLAPWebSocket, setLocalAgent } from '../server/lap/transport';
import { createPairingTicket, resetPairingTicketsForTests } from '../server/lap/pairing';
import { approveSession, resetLAPSessionsForTests } from '../server/lap/session';

type WireMessage = Record<string, any>;

function waitForMessage(ws: WebSocket, predicate: (message: WireMessage) => boolean, timeoutMs = 2_000): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for LAP message.'));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('LAP WebSocket pairing boundary', () => {
  let server: http.Server;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    resetPairingTicketsForTests();
    resetLAPSessionsForTests();
    setLocalAgent({
      agentId: 'agent_local_test',
      userId: 'instance_local_test',
      name: 'Local Lumi',
      publicKey: 'ed25519:local-test-key',
    });
    server = http.createServer();
    attachLAPWebSocket(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as any).port}/lap`;
  });

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('does not accept inbound work when this instance has no delegated-task executor', async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
    const ticket = createPairingTicket({ userId: 'owner', domain: 'personal', orgId: '' }, ['delegate_task']);
    const peer = { agentId: 'agent_delegate_test', userId: 'remote-owner', name: 'Peer', capabilities: ['task_delegation'], publicKey: 'ed25519:delegate-test-key' };
    const ws = await connect(url);
    sockets.push(ws);
    const paired = waitForMessage(ws, message => message.id === 'paired');
    ws.send(JSON.stringify({ lap: '2.0', id: 'paired', sessionId: '', timestamp: new Date().toISOString(), method: 'lap.handshake', pairingToken: ticket.token, agent: peer, proposedScope: ['delegate_task'], nonce: 'd'.repeat(64) }));
    const session = await paired;
    expect(session.accepted).toBe(true);
    approveSession(session.sessionId);
    const delegated = waitForMessage(ws, message => message.id === 'delegate');
    ws.send(JSON.stringify({ lap: '2.0', id: 'delegate', sessionId: session.sessionId, timestamp: new Date().toISOString(), method: 'lap.task.delegate', task: { taskId: 'unexecutable', type: 'web_search', priority: 'normal', payload: { query: 'synthetic' } } }));
    expect(await delegated).toMatchObject({ accepted: false, reason: expect.stringContaining('does not currently execute') });
  });

  it('does not consume a pairing ticket on malformed handshake and consumes it once on success', async () => {
    const ticket = createPairingTicket({ userId: 'owner', domain: 'personal', orgId: '' }, ['notify']);
    const peer = { agentId: 'agent_remote_test', userId: 'remote-owner', name: 'Remote Lumi', capabilities: ['notify'], publicKey: 'ed25519:remote-test-key' };

    const invalid = await connect(url);
    sockets.push(invalid);
    const invalidResponse = waitForMessage(invalid, message => message.id === 'invalid');
    invalid.send(JSON.stringify({ lap: '2.0', id: 'invalid', sessionId: '', timestamp: new Date().toISOString(), method: 'lap.handshake', pairingToken: ticket.token, agent: peer, proposedScope: ['notify'], nonce: 'short' }));
    expect(await invalidResponse).toMatchObject({ accepted: false, reason: expect.stringContaining('Nonce') });

    const valid = await connect(url);
    sockets.push(valid);
    const validResponse = waitForMessage(valid, message => message.id === 'valid');
    valid.send(JSON.stringify({ lap: '2.0', id: 'valid', sessionId: '', timestamp: new Date().toISOString(), method: 'lap.handshake', pairingToken: ticket.token, agent: peer, proposedScope: ['notify'], nonce: 'a'.repeat(64) }));
    expect(await validResponse).toMatchObject({ accepted: true, scope: [], authorizationStatus: 'pending' });

    const replay = await connect(url);
    sockets.push(replay);
    const replayResponse = waitForMessage(replay, message => message.id === 'replay');
    replay.send(JSON.stringify({ lap: '2.0', id: 'replay', sessionId: '', timestamp: new Date().toISOString(), method: 'lap.handshake', pairingToken: ticket.token, agent: peer, proposedScope: ['notify'], nonce: 'b'.repeat(64) }));
    expect(await replayResponse).toMatchObject({ accepted: false, reason: expect.stringContaining('already used') });
  });
});
