import type { ProviderGetters as SharedProviderGetters } from "../../llm/provider_getters";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolRegistry, type ToolRegistry } from "../../tools/registry";
import { getScopedPreferredLLM } from "../../llm/user_preferences";
import type { McpCallerScope } from "../auth";
import { attachMcpCallLifecycle, type McpCallLifecycle } from "../lifecycle";

export function createMcpToolRuntime(llmGetters?: Partial<SharedProviderGetters>, toolReg?: ToolRegistry, broadcast?: (event: string, data: any) => void, callerScope?: McpCallerScope, lifecycle?: McpCallLifecycle) {

  const g = llmGetters || {};
  const tr = toolReg || toolRegistry;
  const bc = broadcast || (() => {});
  const scope: McpCallerScope = callerScope ? { ...callerScope } : {
    userId: 'mcp_remote',
    username: 'mcp_remote',
    role: 'user',
    authenticated: false,
    trustedServiceExecution: false,
    domain: 'personal',
    orgId: '',
  };
  const mcpToolSecurityContext = {
    authenticated: scope.authenticated === true,
    authRole: scope.role,
    orgRole: scope.orgRole,
    localExecution: false,
    executionBoundary: 'remote_restricted' as const,
    trustedServiceExecution: scope.trustedServiceExecution === true,
  };
  const memoryScope = {
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  const isWorkViewer = scope.domain === 'work' && scope.orgRole === 'viewer';
  const viewerMutationDenied = () => ({
    content: [{ type: 'text' as const, text: 'This organization role has read-only MCP access.' }],
    isError: true,
  });
  const resolveMcpLLM = () => {
    const preferred = getScopedPreferredLLM(scope.userId, {
      domain: scope.domain,
      orgId: scope.orgId,
    });
    const providerOverride = String(process.env.LUMI_MCP_LLM_PROVIDER || '').trim();
    const modelOverride = String(process.env.LUMI_MCP_LLM_MODEL || '').trim();
    const overridden = Boolean(providerOverride || modelOverride);
    return {
      provider: (providerOverride || preferred.provider) as any,
      model: modelOverride || preferred.model,
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId,
      selectionMode: overridden ? 'pinned' as const : preferred.selectionMode,
      fallbackCandidates: overridden ? [] : preferred.fallbackCandidates,
      allowCloudFallback: overridden ? false : preferred.allowCloudFallback,
      source: 'mcp_remote',
    };
  };
  const mcp = new McpServer({
    name: 'lumi-mcp',
    version: '2.0.0',
  }, {
    capabilities: { tools: {} },
  });
  if (lifecycle) attachMcpCallLifecycle(mcp, lifecycle);

  const chatConversations = new Map<string, string>();
  return { g, tr, bc, scope, mcpToolSecurityContext, memoryScope, isWorkViewer, viewerMutationDenied, resolveMcpLLM, mcp, chatConversations, lifecycle };
}
