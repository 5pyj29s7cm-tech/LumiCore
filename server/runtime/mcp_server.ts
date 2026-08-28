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
) {
  const scopedBroadcast = (scope: NonNullable<ReturnType<typeof mcpScopeFromAuthUser>>) => {
    const room = scope.domain === 'work'
      ? `user:${scope.userId}:org:${scope.orgId}`
      : `user:${scope.userId}:personal`;
    return (event: string, data: any) => io.to(room).emit(event, data);
  };

  app.get('/mcp/sse', requireAuth, (req, res) => {
    const scope = mcpScopeFromAuthUser(req.user);
    if (!scope) return res.status(401).json({ error: 'Authentication required' });
    const scopedMcp = createLumiMcpServer(llm, toolRegistry, scopedBroadcast(scope), scope);
    return handleMcpSSE(scopedMcp, req, res, scope);
  });
  app.post('/mcp/message', requireAuth, (req, res) => handleMcpMessage(req, res));

  attachMcpWebSocket(server, async (transport, _request, user) => {
    try {
      const scope = mcpScopeFromAuthUser(user);
      if (!scope) {
        await transport.close();
        return;
      }
      const scopedMcp = createLumiMcpServer(llm, toolRegistry, scopedBroadcast(scope), scope);
      await scopedMcp.connect(transport);
      console.log(`[MCP Server] WebSocket client connected: ${transport.sessionId}`);
    } catch (err: any) {
      console.error(`[MCP Server] WebSocket connection error:`, err.message);
    }
  });

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
  const remoteMcp = createLumiMcpServer(
    llm,
    toolRegistry,
    scopedBroadcast(remoteScope),
    remoteScope,
  );
  const remoteDevices = mcpManager.getRemoteDevices();
  for (const [name, url] of Object.entries(remoteDevices)) {
    if (!url) continue;
    console.log(`[MCP Server] Connecting to remote device: ${name}`);
    connectMcpServerToRemote(
      url as string, remoteMcp, name as string,
      () => { deviceRegistry.registerMcpDevice(name as string, 'mcp_remote', { audio: true, video: false, spatial: false, haptic: false, holographic: false }); },
      () => { deviceRegistry.unregisterMcpDevice(name as string); },
    );
  }
}
