export { mcpManager, SKILLS_DIR, normalizeSkillInstallName } from './client';
export type {
  MCPServerConfig,
  MCPToolCapabilityDeclaration,
  MCPToolDef,
  SkillPackage,
} from './client';

import { getToolExecutionTimeoutMs, toolRegistry } from '../tools/registry';
import { mcpManager, MCPToolDef, MCPServerConfig } from './client';
import type { ToolCapabilityMetadata, ToolDefinition, ToolContext } from '../tools/types';

function shortMCPToolName(tool: MCPToolDef): string {
  const prefix = `mcp_${tool.serverName}_`;
  return tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
}

function declaredMCPToolCapability(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
) {
  const shortName = shortMCPToolName(tool);
  return tool.capability
    || serverConfig?.toolCapabilities?.[shortName]
    || serverConfig?.capabilityDefault;
}

export function resolveMCPToolCapability(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
): ToolCapabilityMetadata | undefined {
  const declared = declaredMCPToolCapability(tool, serverConfig);
  if (!declared) return undefined;
  const shortName = shortMCPToolName(tool);
  const source = serverConfig?.source === 'local' ? 'skill' : 'mcp';
  return {
    id: declared.id || `${source}.${tool.serverName}.${shortName}`,
    family: declared.family || tool.serverName,
    lane: declared.lane,
    source,
    provider: tool.serverName,
    operation: declared.operation,
    domains: declared.domains ? [...declared.domains] : undefined,
    tags: Array.from(new Set([tool.serverName, ...(declared.tags || [])])),
    intents: declared.intents ? [...declared.intents] : undefined,
    modes: declared.modes ? [...declared.modes] : undefined,
    risk: declared.risk,
    sideEffects: declared.sideEffects.map(effect => ({ ...effect })),
    verification: {
      ...declared.verification,
      requiredFields: [...declared.verification.requiredFields],
      requiredValues: declared.verification.requiredValues
        ? { ...declared.verification.requiredValues }
        : undefined,
      successStatuses: declared.verification.successStatuses
        ? [...declared.verification.successStatuses]
        : undefined,
      failureStatuses: declared.verification.failureStatuses
        ? [...declared.verification.failureStatuses]
        : undefined,
      requiredArtifacts: declared.verification.requiredArtifacts
        ? [...declared.verification.requiredArtifacts]
        : undefined,
      requiredArtifactCollections: declared.verification.requiredArtifactCollections
        ? [...declared.verification.requiredArtifactCollections]
        : undefined,
      successSignals: [...declared.verification.successSignals],
      limitations: [...declared.verification.limitations],
    },
    provenance: {
      kind: source,
      provider: tool.serverName,
      trust: declared.trust || (source === 'skill' ? 'user-reviewed' : 'third-party'),
    },
    prerequisites: declared.prerequisites ? [...declared.prerequisites] : undefined,
  };
}

export function resolveMCPToolSecurity(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
): 'safe' | 'confirm' {
  if (tool.annotations?.destructiveHint === true) return 'confirm';
  const capability = declaredMCPToolCapability(tool, serverConfig);
  if (capability) {
    const stateChanging = capability.sideEffects.some(effect => [
      'local_write',
      'local_state_change',
      'desktop_control',
      'external_state_change',
      'external_communication',
      'credential_access',
      'process_execution',
      'installation',
    ].includes(effect.type));
    if (
      stateChanging
      || ['mutate', 'communicate'].includes(capability.operation)
      || ['high', 'critical'].includes(capability.risk)
    ) return 'confirm';
    return 'safe';
  }
  return tool.annotations?.readOnlyHint === true ? 'safe' : 'confirm';
}

export function resolveMCPToolOperation(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
): 'observe' | 'mutate' | undefined {
  if (tool.annotations?.destructiveHint === true) return 'mutate';
  const operation = declaredMCPToolCapability(tool, serverConfig)?.operation;
  if (operation === 'observe') return 'observe';
  if (operation && operation !== 'test') return 'mutate';
  if (tool.annotations?.readOnlyHint === true) return 'observe';
  return undefined;
}

/**
 * Register all discovered MCP tools into our tool registry.
 * Each MCP tool gets prefixed: mcp_{serverName}_{toolName}
 */
export async function registerMCPTools(io?: any): Promise<string[]> {
  if (io) mcpManager.setSocketIO(io);

  mcpManager.syncFactoryCapabilityMetadata();
  mcpManager.syncBundledSkillUpgrades();
  const mcpTools = await mcpManager.connectAll();
  const serverConfig = mcpManager.getConfig();
  const registered: string[] = [];

  for (const tool of mcpTools) {
    registerTool(tool, serverConfig[tool.serverName]);
    registered.push(tool.name);
  }

  mcpManager.setOnServerRecovered(recoverServerTools);

  return registered;
}

function registerTool(tool: MCPToolDef, serverConfig?: MCPServerConfig): void {
  const capability = resolveMCPToolCapability(tool, serverConfig);
  const def: ToolDefinition = {
    name: tool.name,
    description: tool.description || `MCP tool: ${tool.name}`,
    permission: 'public',
    securityLevel: resolveMCPToolSecurity(tool, serverConfig),
    capability: capability || {
      source: serverConfig?.source === 'local' ? 'skill' : 'mcp',
      provider: tool.serverName,
      family: tool.serverName,
      tags: [tool.serverName],
      ...(resolveMCPToolOperation(tool, serverConfig)
        ? { operation: resolveMCPToolOperation(tool, serverConfig) }
        : {}),
    },
    parameters: mcpSchemaToParams(tool.inputSchema),
    handler: async (params: Record<string, any>, _ctx: ToolContext) => {
      return mcpManager.callTool(tool.name, params, {
        timeoutMs: getToolExecutionTimeoutMs(tool.name),
      });
    },
  };
  toolRegistry.register(def);
}

export async function recoverServerTools(name: string, tools: MCPToolDef[]): Promise<string[]> {
  const prefix = `mcp_${name}_`;
  toolRegistry.unregisterByPrefix(prefix);

  const registered: string[] = [];
  const serverConfig = mcpManager.getConfig()[name];
  for (const tool of tools) {
    registerTool(tool, serverConfig);
    registered.push(tool.name);
  }
  console.log(`[MCP] Re-registered ${registered.length} tools for recovered server "${name}"`);
  return registered;
}

/**
 * Get MCP server config (for listing in UI)
 */
export function getMCPConfig(): Record<string, MCPServerConfig> {
  return mcpManager.getConfig();
}

/**
 * Update MCP server config and reconnect
 */
export async function updateMCPConfig(servers: Record<string, MCPServerConfig>): Promise<string[]> {
  mcpManager.saveConfig(servers);
  return registerMCPTools();
}

function mcpSchemaToParams(schema: Record<string, any>): Record<string, any> {
  if (!schema || !schema.properties) return {};

  const params: Record<string, any> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    params[key] = {
      type: prop.type || 'string',
      description: prop.description || '',
      required: (schema.required || []).includes(key),
    };
  }

  return params;
}
