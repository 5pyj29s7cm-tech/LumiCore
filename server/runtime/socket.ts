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

interface SocketContext {
  io: Server;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any; getOllama: any; isOllamaAvailable: any; getLmStudio: any; isLmStudioAvailable: any; getXiaomi: any; getKimi: any; getGlm: any; getRelay: any;
  };
}

function getUserIdFromSocket(socket: any, jwtSecret: string): string {
  try {
    const authToken = socket.handshake?.auth?.token;
    if (authToken) {
      const decoded: any = jwt.verify(authToken, jwtSecret);
      return decoded.uid || 'anonymous';
    }
    const cookies = socket.handshake.headers.cookie;
    if (cookies) {
      const token = cookies.split(';').find((c: string) => c.trim().startsWith('token='))?.split('=')[1];
      if (token) {
        const decoded: any = jwt.verify(token, jwtSecret);
        return decoded.uid || 'anonymous';
      }
    }
  } catch {}
  return 'anonymous';
}

export function initSocketRuntime({ io, jwtSecret, llm }: SocketContext) {
  // Personality loading
  personalityRegistry.load();

  // Set up broadcast callbacks
  deviceRegistry.setBroadcast((event, data) => { io.emit(event, data); });
  personalityRegistry.setBroadcast((event, data) => { io.emit(event, data); });

  // Wire up agent promotion notifications
  setOnAgentPromoted((agent) => {
    io.emit('agent:promoted', {
      id: agent.id, name: agent.name,
      skillTags: agent.skillTags, autoCreated: true,
    });
  });

  // Initialize memory sync
  initMemorySync(io);
  initMemoryAssociations();

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
    const uid = getUserIdFromSocket(socket, jwtSecret);
    // Join user room so all this user's sockets (DesktopUI, AgentChatPage, etc.) share events
    socket.join(`user:${uid}`);
    console.log(`[Socket] Client connected: ${socket.id} (uid=${uid})`);

    const getUserId = (s: any) => getUserIdFromSocket(s, jwtSecret);

    // DEBUG: log all incoming events
    socket.onAny((event, ...args) => {
      if (event.startsWith('tool:desktop_result:')) {
        const correlationId = event.slice('tool:desktop_result:'.length);
        handleDesktopRelayResult(correlationId, args[0] || {});
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
      if (event !== 'device:register' && !noisyEvents.has(event)) {
        console.log(`[Socket:${socket.id}] event: ${event} args:`, JSON.stringify(args).slice(0, 200));
      }
    });

    // Ping/pong
    socket.on("ping", () => { socket.emit("pong"); });

    // Clean up perception events on disconnect
    socket.on("disconnect", () => {
      const uid = getUserId(socket);
      perceptionEvents.delete(uid);
    });

    // Skill event relay — forward client-emitted skill events to all connected clients
    socket.on("skill:installed", (data) => { socket.broadcast.emit("skill:installed", data); });
    socket.on("skill:uninstalled", (data) => { socket.broadcast.emit("skill:uninstalled", data); });
    socket.on("skill:updated", (data) => { socket.broadcast.emit("skill:updated", data); });

    // Register all handlers
    registerDeviceHandlers(socket, getUserId, io);
    registerPerceptionHandlers(socket, getUserId, io);
    registerAmbientHandlers(socket, getUserId, io);
    registerConversationHandlers(socket, getUserId);
    registerWakeHandlers(socket, getUserId);
    registerTerminalHandlers(socket, getUserId);
    registerMusicHandlers(socket, getUserId, io);
    registerClientSelfHandlers(socket, getUserId, io);
    registerChatHandler(socket, llmGetters, (uid: string) => getSensory(uid), getUserId, io);
    registerTaskHandler(socket, llmGetters, (uid: string) => getSensory(uid), getUserId, io);
    registerVoiceHandlers(socket, llmGetters, (uid: string) => getSensory(uid), getUserId, io);
  });
}
