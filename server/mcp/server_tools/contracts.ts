import type { ToolExecutionRecord } from "../../tools/types";
import type { createMcpToolRuntime } from './runtime';

export type ToolRecordEvent = Omit<ToolExecutionRecord, 'result'> & { result?: string };

export type McpToolRuntime = ReturnType<typeof createMcpToolRuntime>;

export interface McpConversationEntry {
  source: 'mcp_chat' | 'mcp_route_task'; action: 'chat' | 'route_task';
  maxTokens: number; maxIterations: number; responseMedia: boolean; turnMemory: boolean;
}

export const MCP_CHAT_ENTRY: McpConversationEntry = { source: 'mcp_chat', action: 'chat', maxTokens: 2048, maxIterations: 4, responseMedia: true, turnMemory: true };

export const MCP_TASK_ENTRY: McpConversationEntry = { source: 'mcp_route_task', action: 'route_task', maxTokens: 4096, maxIterations: 8, responseMedia: false, turnMemory: false };

export interface McpConversationInput { message: string; personalityId?: string; conversationId?: string; }
