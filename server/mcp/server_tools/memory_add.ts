import { z } from "zod";
import { addMemory } from "../../memory";
import type { McpToolRuntime } from './contracts';
import { mcpToolFailure } from './failure';

export function registerLumiMemoryAddTool({ mcp, isWorkViewer, viewerMutationDenied, scope }: Pick<McpToolRuntime, "mcp" | "isWorkViewer" | "viewerMutationDenied" | "scope">) {


  // Tool: add a memory
  mcp.registerTool(
    'lumi_memory_add',
    {
      description: 'Teach Lumi something new — add a memory entry about a user preference, fact, habit, or knowledge.',
      inputSchema: {
        type: z.enum(['preference', 'fact', 'habit', 'knowledge']).describe('Type of memory'),
        content: z.string().describe('What Lumi should remember'),
        keywords: z.array(z.string()).optional().describe('Search keywords for this memory'),
      },
    },
    async ({ type, content, keywords }) => {
      try {
        if (isWorkViewer) return viewerMutationDenied();
        const kw = keywords || content.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const entry = addMemory({
          userId: scope.userId,
          type,
          content,
          keywords: kw,
          confidence: 0.7,
          sourceInteractionId: 'mcp_manual',
        }, {
          domain: scope.domain,
          orgId: scope.orgId,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Memory added: [${entry.type}] ${entry.content} (${kw.length} keywords)`,
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('memory add', err);
      }
    },
  );
}
