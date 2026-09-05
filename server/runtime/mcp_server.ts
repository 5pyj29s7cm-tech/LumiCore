// MCP Server + LAP + remote device setup
// Shared between personal and org servers
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createLumiMcpServer, handleMcpSSE, handleMcpMessage } from "../mcp/lumi_server";
import { attachMcpWebSocket, connectMcpServerToRemote } from "../mcp/ws_transport";
import { attachLAPWebSocket } from "../lap/transport";
import { toolRegistry } from "../tools/registry";
import { deviceRegistry } from "../devices";
import { mcpManager } from "../mcp/client";
import { requireAuth } from "../middleware/auth";
import { mcpScopeFromAuthUser } from "../mcp/auth";
import { McpCallLifecycle } from '../mcp/lifecycle';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

export function setupMcpServer(
  app: express.Express,
  server: http.Server,
  io: Server,
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
    getOllama?: any; getLmStudio?: any; getArk?: any; getXiaomi?: any;
    getKimi?: any; getGlm?: any; getRelay?: any;
  },
  __dirname: string,
): () => Promise<void> {
  const lifecycle = new McpCallLifecycle();
  const transports = new Set<Transport>();
  const rememberTransport = (transport: Transport) => {
    transports.add(transport);
    const previousClose = transport.onclose;
    transport.onclose = () => { transports.delete(transport); previousClose?.(); };
  };
  const scopedBroadcast = (scope: NonNullable<ReturnType<typeof mcpScopeFromAuthUser>>) => {
    const room = scope.domain === 'work'
      ? `user:${scope.userId}:org:${scope.orgId}`
      : `user:${scope.userId}:personal`;
    return (event: string, data: any) => io.to(room).emit(event, data);
  };

  app.get('/mcp/sse', requireAuth, (req, res) => {
    if (!lifecycle.accepting) return res.status(503).json({ error: 'MCP is shutting down' });
    const scope = mcpScopeFromAuthUser(req.user);
    if (!scope) return res.status(401).json({ error: 'Authentication required' });
    const scopedMcp = createLumiMcpServer(llm, toolRegistry, scopedBroadcast(scope), scope, lifecycle);
    return handleMcpSSE(scopedMcp, req, res, scope, rememberTransport);
  });
  app.post('/mcp/message', requireAuth, (req, res) => {
    if (!lifecycle.accepting) return res.status(503).json({ error: 'MCP is shutting down' });
    return handleMcpMessage(req, res);
  });

  const inboundSockets = attachMcpWebSocket(server, async (transport, _request, user) => {
    rememberTransport(transport);
    try {
      const scope = mcpScopeFromAuthUser(user);
      if (!scope) {
        await transport.close();
        return;
      }
      const scopedMcp = createLumiMcpServer(llm, toolRegistry, scopedBroadcast(scope), scope, lifecycle);
      await scopedMcp.connect(transport);
      console.log(`[MCP Server] WebSocket client connected: ${transport.sessionId}`);
    } catch (err: any) {
      console.error(`[MCP Server] WebSocket connection error:`, err.message);
    }
  }, () => lifecycle.accepting);

  console.log('[MCP Server] Lumi MCP server ready at /mcp/sse + /mcp/ws');

  attachLAPWebSocket(server);
  console.log('[LAP] Protocol ready at /lap');

  // Connect to remote devices from the runtime MCP config in the user data dir.
  // Outbound devices keep a dedicated identity and therefore cannot inherit a
  // signed-in desktop user's memory or organization scope.
  const remoteScope = {
    userId: 'mcp_remote',
    username: 'mcp_remote',
    role: 'user',
    authenticated: false,
    trustedServiceExecution: true,
    domain: 'personal' as const,
    orgId: '',
  };
  const createRemoteMcp = () => createLumiMcpServer(
    llm,
    toolRegistry,
    scopedBroadcast(remoteScope),
    remoteScope,
    lifecycle,
  );
  const remoteDevices = mcpManager.getRemoteDevices();
  const remoteConnections: Array<ReturnType<typeof connectMcpServerToRemote>> = [];
  for (const [name, url] of Object.entries(remoteDevices)) {
    if (!url) continue;
    console.log(`[MCP Server] Connecting to remote device: ${name}`);
    remoteConnections.push(connectMcpServerToRemote(
      url as string, createRemoteMcp, name as string,
      () => { deviceRegistry.registerMcpDevice(name as string, 'mcp_remote', { audio: true, video: false, spatial: false, haptic: false, holographic: false }); },
      () => { deviceRegistry.unregisterMcpDevice(name as string); },
    ));
  }
  let shutdownPromise: Promise<void> | undefined;
  let inboundClosed = false;
  const shutdownMcp = (): Promise<void> => {
    lifecycle.stopAdmission();
    for (const connection of remoteConnections) connection.stop();
    if (shutdownPromise) return shutdownPromise;
    const pending = (async () => {
      await lifecycle.drain();
      // The SDK queues the JSON-RPC reply after its tool callback settles.
      // Let those continuations send before beginning the close handshake.
      await nextEventLoopTurn();
      await Promise.all([...transports].map(transport => transport.close()));
      await Promise.all(remoteConnections.map(connection => connection.close()));
      if (!inboundClosed) {
        for (const socket of inboundSockets.clients) socket.terminate();
        await new Promise<void>((resolve, reject) => inboundSockets.close(error => {
          if (error) reject(error);
          else { inboundClosed = true; resolve(); }
        }));
      }
    })();
    shutdownPromise = pending;
    void pending.catch(() => { shutdownPromise = undefined; });
    return pending;
  };
  server.once('close', () => {
    void shutdownMcp().catch(() => console.error('[MCP Server] Shutdown did not finish; runtime cleanup remains pending.'));
  });
  return shutdownMcp;
}
