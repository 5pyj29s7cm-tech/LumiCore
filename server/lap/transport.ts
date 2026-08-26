import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { loadOrCreateLAPIdentity } from './identity';
import {
  getSession,
  removeSession,
  updateHeartbeat,
  validateHandshake,
  buildHandshakeResponse,
} from './session';
import {
  delegateTask,
  updateTaskStatus,
  getTask,
  getTasksForAgent,
  buildTaskListResponse,
  cancelTasksForSession,
  registerOutboundTask,
} from './delegate';
import { shareContext, getActiveSharedContexts, getSharedContext, removeSharedContexts } from './context';
import type {
  LAPAgentIdentity,
  LAPRequest,
  LAPMessage,
  LAPScope,
} from './types';
import { consumePairingTicket, inspectPairingTicket } from './pairing';

// Local agent identity — configurable per LumiCore instance
let localAgent: LAPAgentIdentity = loadOrCreateLAPIdentity();

export function setLocalAgent(identity: Partial<LAPAgentIdentity>): void {
  localAgent = {
    ...localAgent,
    ...identity,
    publicKey: String(identity.publicKey || localAgent.publicKey),
  };
}

export function getLocalAgent(): LAPAgentIdentity {
  return localAgent;
}

type LAPMessageHandler = (request: LAPRequest, ws: WebSocket) => Promise<void>;

const handlers: Map<string, LAPMessageHandler> = new Map();
const socketSessions = new WeakMap<WebSocket, Set<string>>();
const socketPeerAgentIds = new WeakMap<WebSocket, Map<string, string>>();
const sessionSockets = new Map<string, WebSocket>();
const pendingResponses = new Map<string, {
  sessionId: string;
  resolve: (value: Record<string, any>) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function bindSocketSession(ws: WebSocket, sessionId: string, peerAgentId: string): void {
  const ids = socketSessions.get(ws) || new Set<string>();
  ids.add(sessionId);
  socketSessions.set(ws, ids);
  const peers = socketPeerAgentIds.get(ws) || new Map<string, string>();
  peers.set(sessionId, peerAgentId);
  socketPeerAgentIds.set(ws, peers);
  sessionSockets.set(sessionId, ws);
}

function socketOwnsSession(ws: WebSocket, sessionId: string): boolean {
  return Boolean(sessionId && socketSessions.get(ws)?.has(sessionId));
}

function requireSocketSession(ws: WebSocket, sessionId: string): ReturnType<typeof getSession> {
  if (!socketOwnsSession(ws, sessionId)) return undefined;
  return getSession(sessionId);
}

export function registerHandler(method: string, handler: LAPMessageHandler): void {
  handlers.set(method, handler);
}

// ── Default handlers ──

registerHandler('lap.handshake', async (req, ws) => {
  const request = req as import('./types').LAPHandshakeRequest;
  const pairing = inspectPairingTicket(request.pairingToken || '', request.agent?.agentId || '', request.proposedScope);
  if (pairing.ok === false) {
    sendLAPResponse(ws, {
      accepted: false,
      reason: pairing.reason,
      sessionId: '',
      agent: localAgent,
      trustLevel: 'public',
      scope: [],
    }, request);
    return;
  }
  const securedRequest = {
    ...request,
    target: pairing.ticket.target,
    proposedScope: pairing.grantedScopes,
  };
  const validation = validateHandshake(securedRequest, localAgent);
  if (!validation.valid) {
    sendLAPResponse(ws, {
      accepted: false,
      reason: validation.reason,
      sessionId: '',
      agent: localAgent,
      trustLevel: 'public',
      scope: [],
    }, request);
    return;
  }
  const consumed = consumePairingTicket(request.pairingToken || '', request.agent.agentId, pairing.grantedScopes);
  if (consumed.ok === false) {
    sendLAPResponse(ws, {
      accepted: false,
      reason: consumed.reason,
      sessionId: '',
      agent: localAgent,
      trustLevel: 'public',
      scope: [],
    }, request);
    return;
  }
  const response = buildHandshakeResponse(securedRequest, localAgent, validation.trustLevel!, consumed.grantedScopes);
  bindSocketSession(ws, response.sessionId, securedRequest.agent.agentId);
  sendLAPResponse(ws, response, request);
  console.log(`[LAP] Handshake complete: ${localAgent.agentId} ↔ ${request.agent.agentId} (session: ${response.sessionId})`);
});

registerHandler('lap.task.delegate', async (req, ws) => {
  const request = req as import('./types').LAPTaskDelegateRequest;
  const session = requireSocketSession(ws, request.sessionId);
  if (!session) {
    sendLAPResponse(ws, { accepted: false, taskId: request.task.taskId, reason: 'Session not found' }, request);
    return;
  }
  updateHeartbeat(request.sessionId);
  const response = delegateTask(request, session, socketPeerAgentIds.get(ws)?.get(request.sessionId));
  sendLAPResponse(ws, response, request);
  if (response.accepted) {
    console.log(`[LAP] Task delegated: "${request.task.type}" → ${session.peerB.name}`);
  }
});

registerHandler('lap.task.result', async (req, ws) => {
  const request = req as import('./types').LAPTaskResultRequest;
  const session = requireSocketSession(ws, request.sessionId);
  if (!session) {
    sendLAPResponse(ws, { acknowledged: false }, request);
    return;
  }
  if (session.authorizationStatus !== 'approved' || !session.scope.includes('delegate_task')) {
    sendLAPResponse(ws, { acknowledged: false }, request);
    return;
  }
  updateHeartbeat(request.sessionId);
  const acknowledged = updateTaskStatus(
    request.sessionId,
    request.taskId,
    request.status,
    request.output,
    request.error,
    socketPeerAgentIds.get(ws)?.get(request.sessionId),
  );
  sendLAPResponse(ws, { acknowledged }, request);
  console.log(`[LAP] Task ${request.taskId} → ${request.status}`);
});

registerHandler('lap.context.share', async (req, ws) => {
  const request = req as import('./types').LAPContextShareRequest;
  const session = requireSocketSession(ws, request.sessionId);
  if (!session) {
    sendLAPResponse(ws, { accepted: false, acceptedEntries: 0, rejectedEntries: request.contexts.length, reason: 'Session not found' }, request);
    return;
  }
  updateHeartbeat(request.sessionId);
  const response = shareContext(request, session);
  sendLAPResponse(ws, response, request);
});

registerHandler('lap.revoke', async (req, ws) => {
  const request = req as import('./types').LAPRevokeRequest;
  if (!requireSocketSession(ws, request.sessionId)) {
    sendLAPResponse(ws, { revoked: false, affectedTasks: [] }, request);
    return;
  }
  let affected = 0;
  if (request.scope === 'all' || request.scope === 'session') {
    const session = getSession(request.sessionId);
    if (session) {
      affected += cancelTasksForSession(request.sessionId);
      affected += removeSharedContexts(request.sessionId);
      removeSession(request.sessionId);
    }
  } else if (request.scope === 'delegate') {
    affected += cancelTasksForSession(request.sessionId);
  } else if (request.scope === 'context') {
    affected += removeSharedContexts(request.sessionId);
  }
  sendLAPResponse(ws, { revoked: true, affectedTasks: [`${affected} resources cleaned`] as any }, request);
  console.log(`[LAP] Revoked session ${request.sessionId}: ${affected} resources (reason: ${request.reason})`);
});

registerHandler('lap.heartbeat', async (req, ws) => {
  const request = req as import('./types').LAPHeartbeatRequest;
  const session = requireSocketSession(ws, request.sessionId);
  if (session) updateHeartbeat(request.sessionId);
  sendLAPResponse(ws, { alive: !!session, serverTime: new Date().toISOString() }, request);
});

// ── Message helpers ──

function sendLAPResponse(ws: WebSocket, payload: Record<string, any>, request?: Pick<LAPMessage, 'id' | 'sessionId'>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      lap: '2.0',
      ...(request?.id ? { id: request.id } : {}),
      ...(request?.sessionId ? { sessionId: request.sessionId } : {}),
      ...payload,
    }));
  }
}

export function sendLAPSessionRequest(
  sessionId: string,
  method: string,
  payload: Record<string, any>,
  timeoutMs = 15_000,
): Promise<Record<string, any>> {
  const ws = sessionSockets.get(sessionId);
  const session = getSession(sessionId);
  if (!session || session.authorizationStatus !== 'approved') {
    return Promise.reject(new Error('LAP session is not locally authorized.'));
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('LAP peer transport is offline.'));
  }
  const id = randomUUID();
  const message = {
    lap: '2.0',
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    method,
    ...payload,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(id);
      reject(new Error('LAP peer request timed out; no retry was attempted.'));
    }, Math.max(1_000, Math.min(timeoutMs, 60_000)));
    pendingResponses.set(id, { sessionId, resolve, timer });
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      clearTimeout(timer);
      pendingResponses.delete(id);
      reject(error);
    }
  });
}

async function dispatchLAPMessage(data: Buffer, ws: WebSocket): Promise<void> {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    ws.send(JSON.stringify({ error: 'Invalid JSON', lap: '2.0' }));
    return;
  }

  const pending = typeof msg.id === 'string' ? pendingResponses.get(msg.id) : undefined;
  if (!msg.method && pending) {
    if (msg.sessionId && msg.sessionId !== pending.sessionId) return;
    if (!socketOwnsSession(ws, pending.sessionId)) return;
    clearTimeout(pending.timer);
    pendingResponses.delete(msg.id);
    pending.resolve(msg);
    return;
  }

  const method = msg.method as string;
  if (!method) {
    ws.send(JSON.stringify({ error: 'Missing method', lap: '2.0' }));
    return;
  }

  const handler = handlers.get(method);
  if (!handler) {
    ws.send(JSON.stringify({ error: `Unknown method: ${method}`, lap: '2.0', supportedMethods: Array.from(handlers.keys()) }));
    return;
  }

  try {
    await handler(msg as LAPRequest, ws);
  } catch (err: any) {
    console.error(`[LAP] Handler error for ${method}:`, err.message);
    sendLAPResponse(ws, { error: `Handler error: ${err.message}` }, msg as LAPMessage);
  }
}

// ── WebSocket server setup ──

export function attachLAPWebSocket(server: any, path = '/lap'): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname === path) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = randomUUID().slice(0, 8);
    console.log(`[LAP] Client connected: ${clientId} (${req.socket.remoteAddress})`);

    ws.on('message', (data: Buffer) => dispatchLAPMessage(data, ws));

    ws.on('close', () => {
      for (const sessionId of socketSessions.get(ws) || []) {
        sessionSockets.delete(sessionId);
        for (const [id, pending] of pendingResponses) {
          if (pending.sessionId !== sessionId) continue;
          clearTimeout(pending.timer);
          pendingResponses.delete(id);
          pending.resolve({ lap: '2.0', sessionId, error: 'LAP peer transport disconnected.', outcome: 'unknown' });
        }
        removeSession(sessionId);
      }
      console.log(`[LAP] Client disconnected: ${clientId}`);
    });

    ws.on('error', (err) => {
      console.error(`[LAP] WebSocket error (${clientId}):`, err.message);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      lap: '2.0',
      method: 'lap.welcome',
      agent: localAgent,
      supportedMethods: Array.from(handlers.keys()),
    }));
  });

  console.log(`[LAP] WebSocket transport ready at ws://0.0.0.0:${(server.address as any)?.()?.port || '?'}${path}`);
  return wss;
}

// ── Re-export query helpers for API routes ──

export { getSession } from './session';
export { getTask, getTasksForAgent, getTasksForSession, buildTaskListResponse, registerOutboundTask, updateTaskStatus } from './delegate';
export { getActiveSharedContexts } from './context';
export { getSharedContext } from './context';
