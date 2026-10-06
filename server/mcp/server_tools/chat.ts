import { z } from "zod";
import { runMcpConversationTurn } from './conversation';
import { MCP_CHAT_ENTRY } from './contracts';

export function registerLumiChatTool(runtime: Parameters<typeof runMcpConversationTurn>[0]) {
  const { mcp } = runtime;
  mcp.registerTool(
    'lumi_chat',
    {
      description: 'Send a message to Lumi and get an AI-powered response. Lumi will use its personality, memory, and tool capabilities.',
      inputSchema: {
        message: z.string().describe('The message to send to Lumi'),
        personalityId: z.string().optional().describe('Personality to use (default: "lumi")'),
        conversationId: z.string().optional().describe('Resume an owned conversation returned by lumi_chat.'),
      },
    },
    async args => {
      const response = await runMcpConversationTurn(runtime, args, MCP_CHAT_ENTRY);
      if ('toolCalls' in response) { const { toolCalls: _count, ...chatResponse } = response; return chatResponse; }
      return response;
    },
  );
}
