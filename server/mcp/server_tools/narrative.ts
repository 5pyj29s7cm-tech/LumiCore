import { z } from "zod";
import { buildNarrativeChain } from "../../memory";
import { CN_MCP_MESSAGES } from "../../regions/messages/mcp_messages";
import type { McpToolRuntime } from './contracts';
import { mcpToolFailure } from './failure';

export function registerLumiNarrativeTool({ mcp, scope, g }: Pick<McpToolRuntime, "mcp" | "scope" | "g">) {


  // Tool: memory narrative chain — weave related memories into a chronological story
  mcp.registerTool(
    'lumi_narrative',
    {
      description: CN_MCP_MESSAGES.narrativeDescription,
      inputSchema: {
        topic: z.string().describe(CN_MCP_MESSAGES.narrativeTopicDescription),
        limit: z.number().optional().default(10).describe(CN_MCP_MESSAGES.narrativeLimitDescription),
      },
    },
    async ({ topic, limit }) => {
      try {
        const result = await buildNarrativeChain({
          userId: scope.userId,
          domain: scope.domain,
          orgId: scope.orgId,
          topic,
          limit,
          getDeepSeek: g.getDeepSeek || (() => null),
          getGemini: g.getGemini || (() => null),
          getOpenAI: g.getOpenAI,
          getAnthropic: g.getAnthropic,
          getQwen: g.getQwen || (() => null),
          getOllama: g.getOllama,
          getLmStudio: g.getLmStudio,
          getArk: g.getArk,
          getXiaomi: g.getXiaomi,
          getKimi: g.getKimi,
          getGlm: g.getGlm,
          getRelay: g.getRelay,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              narrative: result.narrative,
              sourceMemoryIds: result.sourceMemoryIds,
              chainLength: result.memoryChain.length,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('memory narrative', err);
      }
    },
  );
}
