import { z } from "zod";
import { CN_MCP_MESSAGES } from "../../regions/messages/mcp_messages";
import { runMcpConversationTurn } from './conversation';
import type { McpToolRuntime } from './contracts';
import { MCP_TASK_ENTRY } from './contracts';

export function registerLumiRouteTaskTool(runtime: Parameters<typeof runMcpConversationTurn>[0] & Pick<McpToolRuntime, 'viewerMutationDenied'>) {
  const { mcp, isWorkViewer, viewerMutationDenied } = runtime;
  mcp.registerTool(
    'lumi_route_task',
    {
      description: CN_MCP_MESSAGES.routeTaskDescription,
      inputSchema: {
        task: z.string().describe(CN_MCP_MESSAGES.routeTaskInputDescription),
      },
    },
    async ({ task }) => {
      if (isWorkViewer) return viewerMutationDenied();
      const response = await runMcpConversationTurn(runtime, { message: task, personalityId: 'lumi' }, MCP_TASK_ENTRY);
      if ('isError' in response && response.isError) return response;
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        handledBy: 'LumiCore', result: response.content[0].text,
        toolCalls: 'toolCalls' in response ? response.toolCalls : 0,
        finalized: response.finalized, blocked: response.blocked, reason: response.reason || '',
        ...('requestId' in response ? { requestId: response.requestId, conversationId: response.conversationId } : {}),
      }, null, 2) }] };
    },
  );
}
