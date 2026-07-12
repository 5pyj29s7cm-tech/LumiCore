// Socket aggregator — mounts all Socket.IO handlers
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { registerChatHandler } from "../socket/chat";
import { registerTaskHandler } from "../socket/task";
import { registerVoiceHandlers } from "../socket/voice";
import { registerDeviceHandlers } from "../socket/device";
import { registerPerceptionHandlers } from "../socket/perception";
import { registerAmbientHandlers } from "../socket/ambient";
import { registerConversationHandlers } from "../socket/conversations";
import { registerWakeHandlers } from "../socket/wake";
import { registerTerminalHandlers } from "../socket/terminal";
import { registerMusicHandlers } from "../socket/music";
import { registerClientSelfHandlers } from "../socket/client_self";
import { getSensory } from "../socket/shared";
import { perceptionEvents } from "../socket/shared";
import { deviceRegistry } from "../devices";
import { personalityRegistry } from "../personality";
import { setOnAgentPromoted } from "../agents/orchestrator";
import { initMemorySync, initMemoryAssociations } from "../memory";
import { handleDesktopRelayResult } from "../socket/desktop_relay";
import { getMember } from "../org/db";
import { resolveSocketScope, runtimeScopeStorageKey } from "../socket/scope";

interface SocketContext {
  io: Server;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any; getOllama: any; isOllamaAvailable: any; getLmStudio: any; isLmStudioAvailable: any; getXiaomi: any; getKimi: any; getGlm: any; getRelay: any;
  };
}

function getSocketAuth(socket: any, jwtSecret: string): { uid: string; orgId: string; orgRole: string } | null {
  if (typeof socket.data?.authenticatedUserId === 'string') {
    return {
      uid: socket.data.authenticatedUserId,
      orgId: socket.data.authenticatedOrgId || '',
      orgRole: socket.data.authenticatedOrgRole || '',
    };
  }
  try {
    const authToken = socket.handshake?.auth?.token;
    if (authToken) {
      const decoded: any = jwt.verify(authToken, jwtSecret);
      return decoded.uid ? { uid: decoded.uid, orgId: decoded.orgId || '', orgRole: decoded.orgRole || '' } : null;
    }
    const cookies = socket.handshake.headers.cookie;
    if (cookies) {
      const token = cookies.split(';').find((c: string) => c.trim().startsWith('token='))?.split('=')[1];
      if (token) {
        const decoded: any = jwt.verify(token, jwtSecret);
        return decoded.uid ? { uid: decoded.uid, orgId: decoded.orgId || '', orgRole: decoded.orgRole || '' } : null;
      }
    }
  } catch {}
  return null;
}

function getUserIdFromSocket(socket: any, jwtSecret: string): string | null {
  return getSocketAuth(socket, jwtSecret)?.uid || null;
}

export function initSocketRuntime({ io, jwtSecret, llm }: SocketContext) {
  // Personality loading
  personalityRegistry.load();

  // Set up broadcast callbacks
  deviceRegistry.setBroadcast((event, data) => {
    if (String(data?.id || '').startsWith('mcp_')) {
      io.emit(event, data);
    } else if (data?.domain === 'work' && data?.orgId) {
      io.to(`org:${data.orgId}`).emit(event, data);
    } else if (data?.userId) {
      io.to(`user:${data.userId}:personal`).emit(event, data);
    }
  });
  personalityRegistry.setBroadcast((event, data) => {
    if (data?.orgId) io.to(`org:${data.orgId}`).emit(event, data);
    else if (data?.userId) io.to(`user:${data.userId}:personal`).emit(event, data);
  });

  // Wire up agent promotion notifications
  setOnAgentPromoted((agent) => {
    const payload = {
      id: agent.id, name: agent.name,
      skillTags: agent.skillTags, autoCreated: true,
      domain: agent.domain === 'work' ? 'work' : 'personal',
      orgId: agent.domain === 'work' ? (agent.orgId || '') : '',
    };
    if (payload.domain === 'work' && payload.orgId) {
      io.to(`org:${payload.orgId}`).emit('agent:promoted', payload);
    } else if (agent.ownerUid || agent.userId) {
      io.to(`user:${agent.ownerUid || agent.userId}:personal`).emit('agent:promoted', payload);
    }
  });

  // Initialize memory sync
  initMemorySync(io);
  initMemoryAssociations();

  io.use((socket, next) => {
    const auth = getSocketAuth(socket, jwtSecret);
    if (!auth) {
      next(new Error('Authentication required'));
      return;
    }
    if (auth.orgId) {
      const membership = getMember(auth.orgId, auth.uid);
      if (!membership || membership.status !== 'active') {
        next(new Error('Active organization membership required'));
        return;
      }
      socket.data.authenticatedOrgId = auth.orgId;
      socket.data.authenticatedOrgRole = membership.role;
    }
    socket.data.authenticatedUserId = auth.uid;
    next();
  });

  const llmGetters = {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getArk: llm.getArk,
    getOllama: llm.getOllama,
    isOllamaAvailable: llm.isOllamaAvailable,
    getLmStudio: llm.getLmStudio,
    isLmStudioAvailable: llm.isLmStudioAvailable,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  };

  io.on("connection", (socket) => {
    const uid = getUserIdFromSocket(socket, jwtSecret)!;
    // Work sockets use only their organization room; personal user broadcasts
    // must never reach an organization session merely because the uid matches.
    if (!socket.data.authenticatedOrgId) {
      socket.join(`user:${uid}`);
      socket.join(`user:${uid}:personal`);
    } else {
      socket.join(`user:${uid}:org:${socket.data.authenticatedOrgId}`);
    }
    console.log(`[Socket] Client connected: ${socket.id} (uid=${uid})`);

    const getUserId = (s: any) => getUserIdFromSocket(s, jwtSecret) || uid;

    // Optional diagnostics. Event payloads may contain private user content.
    socket.onAny((event, ...args) => {
      if (event.startsWith('tool:desktop_result:')) {
        const correlationId = event.slice('tool:desktop_result:'.length);
        handleDesktopRelayResult(correlationId, args[0] || {}, socket.id);
      }
      const noisyEvents = new Set([
        'audio:chunk',
        'wake:audio',
        'ambient:idle_report',
        'ambient:noise_level',
        'ambient:window_update',
        'ambient:clipboard_report',
        'client:state',
        'presence:heartbeat',
      ]);
      if (process.env.LUMI_SOCKET_DEBUG === '1' && event !== 'device:register' && !noisyEvents.has(event)) {
        console.log(`[Socket:${socket.id}] event=${event} argc=${args.length}`);
      }
    });

    // Ping/pong
    socket.on("ping", () => { socket.emit("pong"); });

    // Clean up perception events on disconnect
    socket.on("disconnect", () => {
      const uid = getUserId(socket);
      const scope = resolveSocketScope(socket, uid);
      perceptionEvents.delete(runtimeScopeStorageKey(uid, scope));
    });

    // Skill event relay — forward client-emitted skill events to all connected clients
    const relaySkillEvent = (event: string, data: any) => {
      const scope = resolveSocketScope(socket, uid, data || {});
      if (scope.domain === 'work') socket.to(`org:${scope.orgId}`).emit(event, { ...data, ...scope });
      else socket.to(`user:${uid}:personal`).emit(event, { ...data, domain: 'personal', orgId: '' });
    };
    socket.on("skill:installed", (data) => relaySkillEvent("skill:installed", data));
    socket.on("skill:uninstalled", (data) => relaySkillEvent("skill:uninstalled", data));
    socket.on("skill:updated", (data) => relaySkillEvent("skill:updated", data));

    // Register all handlers
    registerDeviceHandlers(socket, getUserId, io);
    registerPerceptionHandlers(socket, getUserId, io);
    registerAmbientHandlers(socket, getUserId, io);
    registerConversationHandlers(socket, getUserId);
    registerWakeHandlers(socket, getUserId);
    registerTerminalHandlers(socket, getUserId);
    registerMusicHandlers(socket, getUserId, io);
    registerClientSelfHandlers(socket, getUserId, io);
    const scopedSensory = (requestedUid: string) => {
      const scope = resolveSocketScope(socket, uid);
      return getSensory(requestedUid, undefined, scope);
    };
    registerChatHandler(socket, llmGetters, scopedSensory, getUserId, io);
    registerTaskHandler(socket, llmGetters, scopedSensory, getUserId, io);
    registerVoiceHandlers(socket, llmGetters, scopedSensory, getUserId, io);
  });
}
