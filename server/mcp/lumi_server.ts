import type { ProviderGetters as SharedProviderGetters } from "../llm/provider_getters";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { ToolRegistry } from "../tools/registry";
import { logger } from "../../logger";
import type { Request, Response } from "express";
import { mcpScopeFromAuthUser, sameMcpScope, type McpCallerScope } from "./auth";
import { sanitizeMcpLogValue } from "./public_security";
import type { McpCallLifecycle } from "./lifecycle";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpToolRuntime } from './server_tools/runtime';
import { registerLumiChatTool } from './server_tools/chat';
import { registerLumiMemorySearchTool } from './server_tools/memory_search';
import { registerLumiMemoryAddTool } from './server_tools/memory_add';
import { registerLumiReminderListTool } from './server_tools/reminder_list';
import { registerLumiSpeakTool } from './server_tools/speak';
import { registerLumiNarrativeTool } from './server_tools/narrative';
import { registerLumiRouteTaskTool } from './server_tools/route_task';



// Track active transports per session
const transports: Map<string, { transport: SSEServerTransport; scope: McpCallerScope }> = new Map();

export function createLumiMcpServer(llmGetters?: Partial<SharedProviderGetters>, toolReg?: ToolRegistry, broadcast?: (event: string, data: any) => void, callerScope?: McpCallerScope, lifecycle?: McpCallLifecycle): McpServer {
  const runtime = createMcpToolRuntime(llmGetters, toolReg, broadcast, callerScope, lifecycle);
  registerLumiChatTool(runtime);
  registerLumiMemorySearchTool(runtime);
  registerLumiMemoryAddTool(runtime);
  registerLumiReminderListTool(runtime);
  registerLumiSpeakTool(runtime);
  registerLumiNarrativeTool(runtime);
  registerLumiRouteTaskTool(runtime);
  return runtime.mcp;
}

/**
 * Handle SSE connection — create transport and add to the Lumi MCP server.
 */
export async function handleMcpSSE(
  mcpServer: McpServer,
  req: Request,
  res: Response,
  callerScope?: McpCallerScope,
  onTransport?: (transport: Transport) => void,
) {
  try {
    const scope = callerScope || mcpScopeFromAuthUser(req.user);
    if (!scope) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const transport = new SSEServerTransport('/mcp/message', res);
    onTransport?.(transport);
    transports.set(transport.sessionId, { transport, scope });

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  } catch (err: any) {
    logger.error(`[MCP Server] SSE connection error: ${sanitizeMcpLogValue(err?.message || err)}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP SSE connection failed' });
    }
  }
}

/**
 * Handle incoming MCP messages (JSON-RPC via HTTP POST).
 */
export async function handleMcpMessage(req: Request, res: Response) {
  try {
    // The authenticated POST must name, and own, the SSE session explicitly.
    const requestScope = mcpScopeFromAuthUser(req.user);
    if (!requestScope) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const sessionId = String(req.query.sessionId || '').trim();
    let session: { transport: SSEServerTransport; scope: McpCallerScope } | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'MCP sessionId is required. Connect to /mcp/sse first.' });
      return;
    }
    session = transports.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'MCP session not found or expired.' });
      return;
    }

    if (!sameMcpScope(session.scope, requestScope)) {
      res.status(403).json({ error: 'MCP session does not belong to the authenticated user scope.' });
      return;
    }

    await session.transport.handlePostMessage(req, res);
  } catch (err: any) {
    logger.error(`[MCP Server] Message error: ${sanitizeMcpLogValue(err?.message || err)}`);
    res.status(500).json({ error: 'MCP message handling failed' });
  }
}
