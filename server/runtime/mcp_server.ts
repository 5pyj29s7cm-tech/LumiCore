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
  const lumiMcp = createLumiMcpServer(llm, toolRegistry, (event, data) => io.emit(event, data));

  app.get('/mcp/sse', (req, res) => handleMcpSSE(lumiMcp, req, res));
  app.post('/mcp/message', (req, res) => handleMcpMessage(req, res));

  attachMcpWebSocket(server, async (transport) => {
    try {
      await lumiMcp.connect(transport);
      console.log(`[MCP Server] WebSocket client connected: ${transport.sessionId}`);
    } catch (err: any) {
      console.error(`[MCP Server] WebSocket connection error:`, err.message);
    }
  });

  console.log('[MCP Server] Lumi MCP server ready at /mcp/sse + /mcp/ws');

  attachLAPWebSocket(server);
  console.log('[LAP] Agent protocol ready at /lap');

  // Connect to remote devices from the runtime MCP config in the user data dir.
  const remoteDevices = mcpManager.getRemoteDevices();
  for (const [name, url] of Object.entries(remoteDevices)) {
    if (!url) continue;
    console.log(`[MCP Server] Connecting to remote device: ${name}`);
    connectMcpServerToRemote(
      url as string, lumiMcp, name as string,
      () => { deviceRegistry.registerMcpDevice(name as string, 'mcp_remote', { audio: true, video: false, spatial: false, haptic: false, holographic: false }); },
      () => { deviceRegistry.unregisterMcpDevice(name as string); },
    );
  }
}
