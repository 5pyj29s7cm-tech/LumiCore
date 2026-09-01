export {
  mcpManager,
  assertMCPPackageRunnerPolicy,
  SKILLS_DIR,
  mcpRegistryToolName,
  mcpServerConfigFingerprint,
  normalizeSkillInstallName,
  requireSafeMCPServerName,
  requireSafeMCPToolName,
} from './client';
export type {
  MCPServerConfig,
  MCPToolCapabilityDeclaration,
  MCPToolDef,
  SkillPackage,
} from './client';

import { getToolExecutionTimeoutMs, toolRegistry } from '../tools/registry';
import type { ToolRegistry } from '../tools/registry';
import {
  mcpManager,
  assertMCPPackageRunnerPolicy,
  mcpRegistryToolName,
  mcpServerConfigFingerprint,
  requireSafeMCPServerName,
  requireSafeMCPToolName,
} from './client';
import type { MCPClientManager, MCPToolDef, MCPServerConfig } from './client';
import type { ToolCapabilityMetadata, ToolDefinition, ToolContext } from '../tools/types';

function shortMCPToolName(tool: MCPToolDef): string {
  if (tool.rawName) return tool.rawName;
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
  const providerDeclaredLimitation = source === 'skill'
    ? 'This Skill-provided verification declaration cannot independently prove the final business outcome; LumiCore must corroborate it with host-owned evidence.'
    : 'This MCP provider verification declaration cannot independently prove the final business outcome; LumiCore must corroborate it with host-owned evidence.';
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
      limitations: Array.from(new Set([
        ...declared.verification.limitations,
        providerDeclaredLimitation,
      ])),
    },
    provenance: {
      kind: source,
      provider: tool.serverName,
      // A provider cannot promote itself to LumiCore's core/official trust
      // classes. Trust is assigned by the host installation boundary.
      trust: source === 'skill' ? 'user-reviewed' : 'third-party',
    },
    prerequisites: declared.prerequisites ? [...declared.prerequisites] : undefined,
  };
}

export function resolveMCPToolSecurity(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
): 'safe' | 'confirm' {
  // MCP annotations and package capability declarations are provider input.
  // They may make routing more precise, but cannot lower the host execution
  // boundary. A future host-signed grant may selectively relax this floor.
  return 'confirm';
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

  const toolsByServer = new Map<string, MCPToolDef[]>();
  for (const tool of mcpTools) {
    const list = toolsByServer.get(tool.serverName) || [];
    list.push(tool);
    toolsByServer.set(tool.serverName, list);
  }
  for (const [serverName, tools] of toolsByServer) {
    try {
      registered.push(...await recoverServerTools(
        serverName,
        tools,
        toolRegistry,
        Object.prototype.hasOwnProperty.call(serverConfig, serverName)
          ? serverConfig[serverName]
          : undefined,
      ));
    } catch (error: any) {
      console.warn(`[MCP] Refused tool registration for "${serverName}": ${error?.message || error}`);
    }
  }

  mcpManager.setOnServerRecovered(recoverServerTools);

  return registered;
}

type RegistryMCPToolOwnership = {
  byServer: Map<string, Set<string>>;
  byTool: Map<string, string>;
};

const registryMCPToolOwnership = new WeakMap<ToolRegistry, RegistryMCPToolOwnership>();

function getRegistryMCPToolOwnership(registry: ToolRegistry): RegistryMCPToolOwnership {
  let ownership = registryMCPToolOwnership.get(registry);
  if (!ownership) {
    ownership = { byServer: new Map(), byTool: new Map() };
    registryMCPToolOwnership.set(registry, ownership);
  }
  return ownership;
}

/** Resolve the exact live registry owner; no parsing of underscore-delimited names. */
export function getRegisteredMCPToolOwner(
  toolName: string,
  registry: ToolRegistry = toolRegistry,
): string | null {
  return getRegistryMCPToolOwnership(registry).byTool.get(String(toolName || '')) || null;
}

export function getRegisteredMCPToolNames(
  serverName: string,
  registry: ToolRegistry = toolRegistry,
): string[] {
  const safeName = requireSafeMCPServerName(serverName);
  return Array.from(getRegistryMCPToolOwnership(registry).byServer.get(safeName) || []).sort();
}

function normalizeServerToolDeclaration(serverName: string, tool: MCPToolDef): MCPToolDef {
  const safeServerName = requireSafeMCPServerName(serverName);
  if (tool.serverName !== safeServerName) {
    throw new Error(`MCP server "${safeServerName}" returned a declaration owned by "${tool.serverName}".`);
  }
  const prefix = `mcp_${safeServerName}_`;
  if (!String(tool.name || '').startsWith(prefix)) {
    throw new Error(`MCP server "${safeServerName}" returned a tool outside its registry namespace.`);
  }
  const rawName = requireSafeMCPToolName(
    tool.rawName || String(tool.name).slice(prefix.length),
  );
  const canonicalName = mcpRegistryToolName(safeServerName, rawName);
  if (tool.name !== canonicalName) {
    throw new Error(`MCP server "${safeServerName}" returned a non-canonical tool name.`);
  }
  return { ...tool, serverName: safeServerName, name: canonicalName, rawName };
}

function validateServerToolInventory(serverName: string, tools: MCPToolDef[]): MCPToolDef[] {
  const safeServerName = requireSafeMCPServerName(serverName);
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('MCP Skill activation requires a connected non-empty tool inventory.');
  }
  const normalized = tools.map(tool => normalizeServerToolDeclaration(safeServerName, tool));
  const names = normalized.map(tool => tool.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`MCP server "${safeServerName}" returned duplicate tool declarations.`);
  }
  return normalized;
}

function buildRegisteredTool(
  tool: MCPToolDef,
  serverConfig?: MCPServerConfig,
): ToolDefinition {
  const capability = resolveMCPToolCapability(tool, serverConfig);
  const rawToolName = requireSafeMCPToolName(tool.rawName || shortMCPToolName(tool));
  return {
    name: tool.name,
    description: tool.description || `MCP tool: ${tool.name}`,
    // Connected MCP adapters execute against user-configured services and may
    // expose private data or side effects. They are never anonymous/public,
    // even when the provider annotation marks the individual call read-only.
    permission: 'user',
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
      return mcpManager.callToolForServer(tool.serverName, rawToolName, params, {
        timeoutMs: getToolExecutionTimeoutMs(tool.name),
      });
    },
  };
}

function replaceServerTools(
  name: string,
  tools: MCPToolDef[],
  registry: ToolRegistry,
  serverConfig?: MCPServerConfig,
): string[] {
  const safeName = requireSafeMCPServerName(name);
  // Build and validate every declaration before changing the live registry.
  const normalizedTools = validateServerToolInventory(safeName, tools);
  const definitions = normalizedTools.map(tool => buildRegisteredTool(tool, serverConfig));
  const ownership = getRegistryMCPToolOwnership(registry);
  const previousNames = new Set(ownership.byServer.get(safeName) || []);

  for (const definition of definitions) {
    const existing = registry.get(definition.name);
    const existingOwner = ownership.byTool.get(definition.name);
    if (existing && existingOwner !== safeName) {
      throw new Error(
        `MCP tool "${definition.name}" collides with ${existingOwner ? `server "${existingOwner}"` : 'an unowned registry entry'}.`,
      );
    }
  }

  const previousDefinitions = Array.from(previousNames)
    .map(toolName => registry.get(toolName))
    .filter((definition): definition is ToolDefinition => Boolean(definition));
  const registeredNames: string[] = [];
  try {
    for (const toolName of previousNames) registry.unregister(toolName);
    for (const definition of definitions) {
      if (!registry.register(definition)) {
        throw new Error(`MCP tool "${definition.name}" could not be registered.`);
      }
      registeredNames.push(definition.name);
    }
  } catch (error) {
    for (const toolName of registeredNames) registry.unregister(toolName);
    for (const definition of previousDefinitions) registry.register(definition);
    throw error;
  }

  for (const toolName of previousNames) ownership.byTool.delete(toolName);
  const nextNames = new Set(registeredNames);
  ownership.byServer.set(safeName, nextNames);
  for (const toolName of nextNames) ownership.byTool.set(toolName, safeName);
  return registeredNames;
}

export function unregisterServerTools(
  name: string,
  registry: ToolRegistry = toolRegistry,
): string[] {
  const safeName = requireSafeMCPServerName(name);
  const ownership = getRegistryMCPToolOwnership(registry);
  const ownedNames = Array.from(ownership.byServer.get(safeName) || []);
  const removed: string[] = [];
  for (const toolName of ownedNames) {
    if (ownership.byTool.get(toolName) !== safeName) continue;
    if (registry.unregister(toolName)) removed.push(toolName);
    ownership.byTool.delete(toolName);
  }
  ownership.byServer.delete(safeName);
  return removed;
}

export async function recoverServerTools(
  name: string,
  tools: MCPToolDef[],
  registry: ToolRegistry = toolRegistry,
  serverConfig?: MCPServerConfig,
): Promise<string[]> {
  const safeName = requireSafeMCPServerName(name);
  if (!Array.isArray(tools) || tools.length === 0) {
    unregisterServerTools(safeName, registry);
    return [];
  }
  const config = mcpManager.getConfig();
  const resolvedConfig = serverConfig || (
    Object.prototype.hasOwnProperty.call(config, safeName) ? config[safeName] : undefined
  );
  const registered = replaceServerTools(safeName, tools, registry, resolvedConfig);
  console.log(`[MCP] Re-registered ${registered.length} tools for recovered server "${name}"`);
  return registered;
}

export interface ActivatedSkillRuntime {
  skillName: string;
  runtimeStatus: 'registered';
  usable: true;
  toolCount: number;
  registeredToolNames: string[];
  manifestCapabilityIds: string[];
}

/**
 * Publish declarations from one already-connected MCP Skill into the current
 * registry and verify the exact manifest entries. A successful MCP handshake
 * alone is not enough: the model cannot use the Skill until this registry
 * boundary has completed.
 */
export async function registerConnectedSkillTools(
  name: string,
  tools: MCPToolDef[],
  options: {
    registry?: ToolRegistry;
    serverConfig?: MCPServerConfig;
  } = {},
): Promise<ActivatedSkillRuntime> {
  const skillName = requireSafeMCPServerName(name);
  const registry = options.registry || toolRegistry;
  const normalizedTools = validateServerToolInventory(skillName, tools);
  const expectedNames = normalizedTools.map(tool => tool.name);

  const registeredToolNames = await recoverServerTools(
    skillName,
    normalizedTools,
    registry,
    options.serverConfig,
  );
  try {
    if (
      registeredToolNames.length !== expectedNames.length
      || expectedNames.some(toolName => !registeredToolNames.includes(toolName))
    ) {
      throw new Error(`MCP Skill "${skillName}" declarations were not registered completely.`);
    }
    const manifestByName = new Map(
      registry.getCapabilityManifest()
        .filter(entry => expectedNames.includes(entry.toolName))
        .map(entry => [entry.toolName, entry]),
    );
    const unavailable = expectedNames.filter(toolName => (
      !registry.get(toolName)
      || manifestByName.get(toolName)?.executable !== true
    ));
    if (unavailable.length > 0) {
      throw new Error(`MCP Skill "${skillName}" is missing executable manifest entries.`);
    }
    const manifestCapabilityIds = registeredToolNames.map(toolName => (
      String(manifestByName.get(toolName)?.capabilityId || '')
    ));
    if (manifestCapabilityIds.some(capabilityId => !capabilityId)) {
      throw new Error(`MCP Skill "${skillName}" is missing exact manifest capability identifiers.`);
    }
    return {
      skillName,
      runtimeStatus: 'registered',
      usable: true,
      toolCount: registeredToolNames.length,
      registeredToolNames,
      manifestCapabilityIds,
    };
  } catch (error) {
    unregisterServerTools(skillName, registry);
    throw error;
  }
}

/**
 * Complete the post-install activation transaction under the caller's
 * existing confirmation boundary: connect/list, register, then verify the
 * current manifest. When a fresh install cannot activate, remove its config
 * and package instead of leaving a result that looks usable.
 */
export async function activateInstalledSkill(
  name: string,
  options: {
    registry?: ToolRegistry;
    manager?: Pick<
      MCPClientManager,
      'getConfig' | 'restartServer' | 'disconnectServer' | 'uninstallSkill'
    > & Partial<Pick<
      MCPClientManager,
      'saveConfig' | 'beginSkillActivation' | 'commitSkillActivation'
    >>;
    rollbackInstallOnFailure?: boolean;
  } = {},
): Promise<ActivatedSkillRuntime> {
  const skillName = requireSafeMCPServerName(name);
  const registry = options.registry || toolRegistry;
  const manager = options.manager || mcpManager;
  let originalServerConfig: MCPServerConfig | undefined;
  let pendingActivation = false;
  try {
    const config = manager.getConfig();
    const serverConfig = Object.prototype.hasOwnProperty.call(config, skillName)
      ? config[skillName]
      : undefined;
    if (!serverConfig) throw new Error(`MCP Skill "${skillName}" has no installed runtime configuration.`);
    originalServerConfig = structuredClone(serverConfig);
    pendingActivation = serverConfig.installationState === 'pending';
    let activationConfig = serverConfig;
    if (pendingActivation) {
      if (!manager.beginSkillActivation || !manager.commitSkillActivation || !manager.saveConfig) {
        throw new Error(`MCP Skill "${skillName}" activation manager cannot commit a pending installation.`);
      }
      activationConfig = manager.beginSkillActivation(skillName);
    } else if (serverConfig.enabled !== true) {
      throw new Error(`MCP Skill "${skillName}" is installed but cannot start until its required configuration is available.`);
    }
    const tools = await manager.restartServer(skillName);
    const activation = await registerConnectedSkillTools(skillName, tools, {
      registry,
      serverConfig: activationConfig,
    });
    if (pendingActivation) manager.commitSkillActivation!(skillName);
    return activation;
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await manager.disconnectServer(skillName);
    } catch (rollbackError: any) {
      rollbackErrors.push(`disconnect: ${rollbackError?.message || rollbackError}`);
    }
    unregisterServerTools(skillName, registry);
    if (options.rollbackInstallOnFailure === true) {
      try {
        manager.uninstallSkill(skillName);
      } catch (rollbackError: any) {
        rollbackErrors.push(`uninstall: ${rollbackError?.message || rollbackError}`);
      }
    } else if (pendingActivation && originalServerConfig) {
      try {
        const config = manager.getConfig();
        config[skillName] = originalServerConfig;
        manager.saveConfig!(config);
      } catch (rollbackError: any) {
        rollbackErrors.push(`configuration: ${rollbackError?.message || rollbackError}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${String((error as any)?.message || error)} Rollback incomplete (${rollbackErrors.join(' | ')}).`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Get MCP server config (for listing in UI)
 */
export function getMCPConfig(): Record<string, MCPServerConfig> {
  return mcpManager.getConfig();
}

export type MCPConfigUpdateMode = 'merge' | 'replace';

export interface MCPServerConfigResult {
  serverName: string;
  action: 'added' | 'changed' | 'restarted' | 'disabled' | 'deleted' | 'unchanged' | 'rolled_back' | 'disabled_after_failure';
  configured: boolean;
  connected: boolean;
  registered: boolean;
  usable: boolean;
  enabled: boolean;
  toolCount: number;
  registeredToolNames: string[];
  error?: string;
  rollbackError?: string;
}

export interface MCPConfigUpdateResult {
  ok: boolean;
  mode: MCPConfigUpdateMode;
  services: MCPServerConfigResult[];
}

type MCPConfigRuntimeManager = Pick<
  MCPClientManager,
  'getConfig' | 'saveConfig' | 'restartServer' | 'disconnectServer' | 'getConnectedServers'
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error(`${field} must be an object of string values.`);
  if (Object.keys(value).length > 256) throw new Error(`${field} has too many entries.`);
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (
      !key
      || key.length > 256
      || /[\u0000-\u001f\u007f]/.test(key)
      || typeof item !== 'string'
      || item.length > 65_536
      || /[\u0000\r\n]/.test(item)
    ) {
      throw new Error(`${field} contains an invalid entry.`);
    }
    result[key] = item;
  }
  return result;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/** Validate one user/config supplied MCP entry and remove runtime-owned cache fields. */
export function validateMCPServerConfig(
  serverName: string,
  value: unknown,
): MCPServerConfig {
  requireSafeMCPServerName(serverName);
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`MCP server "${serverName}" must have a non-empty configuration object.`);
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`MCP server "${serverName}" must declare enabled as a boolean.`);
  }
  if (value.source !== undefined && value.source !== 'local' && value.source !== 'external') {
    throw new Error(`MCP server "${serverName}" has an invalid source.`);
  }
  if (value.installationState !== undefined) {
    throw new Error(`MCP server "${serverName}" installationState is runtime-managed.`);
  }

  const rawCommand = typeof value.command === 'string' ? value.command.trim() : '';
  const rawUrl = typeof value.url === 'string' ? value.url.trim() : '';
  const inferredTransport = rawUrl
    ? (/^wss?:/i.test(rawUrl) ? 'ws' : 'http')
    : 'stdio';
  const transport = value.transport === undefined ? inferredTransport : value.transport;
  if (!['stdio', 'http', 'ws'].includes(String(transport))) {
    throw new Error(`MCP server "${serverName}" has an invalid transport.`);
  }

  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 256 || value.args.some(item => (
    typeof item !== 'string' || item.length > 4096 || /[\u0000\r\n]/.test(item)
  )))) {
    throw new Error(`MCP server "${serverName}" has invalid command arguments.`);
  }

  if (transport === 'stdio') {
    if (!rawCommand || rawCommand.length > 4096 || /[\u0000-\u001f\u007f]/.test(rawCommand)) {
      throw new Error(`MCP server "${serverName}" requires a valid non-empty command.`);
    }
    if (rawUrl) throw new Error(`MCP stdio server "${serverName}" cannot also declare a URL.`);
  } else {
    if (rawCommand) throw new Error(`Remote MCP server "${serverName}" cannot also declare a command.`);
    let parsed: URL;
    if (!rawUrl || rawUrl.length > 4096) {
      throw new Error(`MCP server "${serverName}" requires a valid URL.`);
    }
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`MCP server "${serverName}" requires a valid URL.`);
    }
    const acceptedProtocols = transport === 'http' ? ['http:', 'https:'] : ['ws:', 'wss:'];
    if (!acceptedProtocols.includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`MCP server "${serverName}" has an invalid ${transport} URL.`);
    }
    const insecure = parsed.protocol === 'http:' || parsed.protocol === 'ws:';
    if (insecure && !isLoopbackHostname(parsed.hostname)) {
      throw new Error(`MCP server "${serverName}" must use TLS unless it targets loopback.`);
    }
  }

  const normalized = JSON.parse(JSON.stringify(value)) as MCPServerConfig;
  normalized.enabled = value.enabled;
  normalized.transport = transport as MCPServerConfig['transport'];
  if (transport === 'stdio') {
    normalized.command = rawCommand;
    normalized.args = Array.isArray(value.args) ? [...value.args] as string[] : [];
    delete normalized.url;
    delete normalized.headers;
  } else {
    normalized.url = rawUrl;
    delete normalized.command;
    delete normalized.args;
    delete normalized.env;
  }
  const env = validateStringRecord(value.env, 'env');
  const headers = validateStringRecord(value.headers, 'headers');
  if (env) normalized.env = env;
  if (headers) normalized.headers = headers;
  delete normalized.cachedTools;
  delete normalized.cachedToolsFingerprint;
  delete normalized.cachedToolsAttestation;
  delete normalized.toolCount;
  assertMCPPackageRunnerPolicy(normalized);
  return normalized;
}

function validateMCPServerMap(value: unknown): Record<string, MCPServerConfig> {
  if (!isPlainRecord(value)) throw new Error('MCP servers config must be an object.');
  if (Object.keys(value).length > 256) throw new Error('MCP servers config has too many entries.');
  const normalized: Record<string, MCPServerConfig> = Object.create(null);
  for (const [name, server] of Object.entries(value)) {
    const safeName = requireSafeMCPServerName(name);
    if (safeName !== name) throw new Error('MCP server names may not contain surrounding whitespace.');
    normalized[safeName] = validateMCPServerConfig(safeName, server);
  }
  return normalized;
}

function configEquals(left: MCPServerConfig | undefined, right: MCPServerConfig | undefined): boolean {
  if (!left || !right) return left === right;
  return mcpServerConfigFingerprint(left) === mcpServerConfigFingerprint(right);
}

function runtimeResult(
  serverName: string,
  action: MCPServerConfigResult['action'],
  manager: MCPConfigRuntimeManager,
  registry: ToolRegistry,
  config?: MCPServerConfig,
  error?: unknown,
  rollbackError?: unknown,
): MCPServerConfigResult {
  const registeredToolNames = getRegisteredMCPToolNames(serverName, registry);
  const connected = manager.getConnectedServers().includes(serverName);
  const enabled = config?.enabled === true;
  return {
    serverName,
    action,
    configured: Boolean(config),
    connected,
    registered: registeredToolNames.length > 0,
    usable: enabled && registeredToolNames.length > 0,
    enabled,
    toolCount: registeredToolNames.length,
    registeredToolNames,
    ...(error ? { error: String((error as any)?.message || error) } : {}),
    ...(rollbackError ? { rollbackError: String((rollbackError as any)?.message || rollbackError) } : {}),
  };
}

function saveOneServerConfig(
  manager: MCPConfigRuntimeManager,
  name: string,
  config?: MCPServerConfig,
): void {
  const current = { ...manager.getConfig() };
  if (config) current[name] = config;
  else delete current[name];
  manager.saveConfig(current);
}

async function activateMCPServerRuntime(
  manager: MCPConfigRuntimeManager,
  registry: ToolRegistry,
  name: string,
  config: MCPServerConfig,
): Promise<string[]> {
  const tools = await manager.restartServer(name);
  if (!Array.isArray(tools) || tools.length === 0) {
    unregisterServerTools(name, registry);
    throw new Error(`MCP server "${name}" connected without exposing any tools.`);
  }
  return recoverServerTools(name, tools, registry, config);
}

/**
 * Apply a config diff to the running MCP registry. Changed servers are torn
 * down before the new config is persisted, then connected/listed/registered
 * from the new transport. A failed activation restores the prior config and
 * runtime; if that rollback also fails, the server is persisted disabled.
 */
async function updateMCPConfigUnlocked(
  servers: Record<string, MCPServerConfig>,
  options: {
    mode?: MCPConfigUpdateMode;
    forceRestartNames?: string[];
    removeNames?: string[];
    manager?: MCPConfigRuntimeManager;
    registry?: ToolRegistry;
  } = {},
): Promise<MCPConfigUpdateResult> {
  const mode = options.mode || 'merge';
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Invalid MCP config update mode.');
  const manager = options.manager || mcpManager;
  const registry = options.registry || toolRegistry;
  const submitted = validateMCPServerMap(servers);
  const previous = manager.getConfig();
  const next = mode === 'replace'
    ? { ...submitted }
    : { ...previous, ...submitted };
  const forceRestart = new Set((options.forceRestartNames || []).map(requireSafeMCPServerName));
  const removeNames = new Set((options.removeNames || []).map(requireSafeMCPServerName));
  for (const name of removeNames) delete next[name];
  const submittedNames = new Set(Object.keys(submitted));
  const allNames = new Set([...Object.keys(previous), ...Object.keys(next), ...removeNames]);
  const affectedNames = Array.from(allNames).filter(name => (
    mode === 'replace'
    || submittedNames.has(name)
    || removeNames.has(name)
    || !Object.prototype.hasOwnProperty.call(next, name)
  )).sort();
  const cleanupErrors = new Map<string, unknown>();

  for (const name of affectedNames) {
    const before = previous[name];
    const after = next[name];
    const changed = !configEquals(before, after) || forceRestart.has(name);
    const mustWithdraw = Boolean(before) && (!after || after.enabled !== true || changed);
    const explicitDisabled = submittedNames.has(name) && after?.enabled === false;
    if (!mustWithdraw && !explicitDisabled) continue;
    try {
      await manager.disconnectServer(name);
    } catch (error) {
      cleanupErrors.set(name, error);
    } finally {
      unregisterServerTools(name, registry);
    }
  }

  try {
    manager.saveConfig(next);
    const persisted = manager.getConfig();
    const mismatch = affectedNames.find(name => !configEquals(next[name], persisted[name]));
    if (mismatch) {
      throw new Error(`MCP configuration persistence verification failed for "${mismatch}".`);
    }
  } catch (persistError) {
    let restorePersistError: unknown;
    try { manager.saveConfig(previous); } catch (error) { restorePersistError = error; }
    const services: MCPServerConfigResult[] = [];
    for (const name of affectedNames) {
      const before = previous[name];
      let rollbackError: unknown;
      let finalConfig = before;
      if (!restorePersistError && before?.enabled) {
        try {
          await activateMCPServerRuntime(manager, registry, name, before);
        } catch (error) {
          rollbackError = error;
          unregisterServerTools(name, registry);
        }
      } else if (restorePersistError) {
        rollbackError = restorePersistError;
      }
      if (rollbackError && before) {
        finalConfig = {
          ...before,
          enabled: false,
          cachedTools: undefined,
          cachedToolsFingerprint: undefined,
          toolCount: undefined,
        };
        try {
          saveOneServerConfig(manager, name, finalConfig);
        } catch (disableError) {
          rollbackError = new Error(
            `${String((rollbackError as any)?.message || rollbackError)}; disabling also failed: ${String((disableError as any)?.message || disableError)}`,
          );
        }
      }
      services.push(runtimeResult(
        name,
        rollbackError ? 'disabled_after_failure' : 'rolled_back',
        manager,
        registry,
        finalConfig,
        persistError,
        rollbackError,
      ));
    }
    return { ok: false, mode, services };
  }

  const services: MCPServerConfigResult[] = [];
  for (const name of affectedNames) {
    const before = previous[name];
    const after = next[name];
    const changed = !configEquals(before, after);
    const cleanupError = cleanupErrors.get(name);

    if (!after) {
      services.push(runtimeResult(name, 'deleted', manager, registry, undefined, cleanupError));
      continue;
    }
    if (!after.enabled) {
      services.push(runtimeResult(name, 'disabled', manager, registry, after, cleanupError));
      continue;
    }
    if (!changed && !forceRestart.has(name)) {
      services.push(runtimeResult(name, 'unchanged', manager, registry, after, cleanupError));
      continue;
    }

    try {
      await activateMCPServerRuntime(manager, registry, name, after);
      services.push(runtimeResult(
        name,
        before ? (forceRestart.has(name) && !changed ? 'restarted' : 'changed') : 'added',
        manager,
        registry,
        after,
        cleanupError,
      ));
    } catch (activationError) {
      try { await manager.disconnectServer(name); } catch {}
      unregisterServerTools(name, registry);
      let rollbackError: unknown;
      let finalConfig: MCPServerConfig | undefined = before;
      try {
        saveOneServerConfig(manager, name, before);
        if (before?.enabled) {
          await activateMCPServerRuntime(manager, registry, name, before);
        }
      } catch (error) {
        rollbackError = error;
        unregisterServerTools(name, registry);
        finalConfig = before ? {
          ...before,
          enabled: false,
          cachedTools: undefined,
          cachedToolsFingerprint: undefined,
          toolCount: undefined,
        } : undefined;
        try {
          saveOneServerConfig(manager, name, finalConfig);
        } catch (disableError) {
          rollbackError = new Error(
            `${String((error as any)?.message || error)}; disabling also failed: ${String((disableError as any)?.message || disableError)}`,
          );
        }
      }
      services.push(runtimeResult(
        name,
        rollbackError ? 'disabled_after_failure' : 'rolled_back',
        manager,
        registry,
        finalConfig,
        activationError,
        rollbackError,
      ));
    }
  }

  return {
    ok: services.every(service => !service.error && !service.rollbackError),
    mode,
    services,
  };
}

let mcpConfigUpdateTail: Promise<void> = Promise.resolve();

export function updateMCPConfig(
  servers: Record<string, MCPServerConfig>,
  options: {
    mode?: MCPConfigUpdateMode;
    forceRestartNames?: string[];
    removeNames?: string[];
    manager?: MCPConfigRuntimeManager;
    registry?: ToolRegistry;
  } = {},
): Promise<MCPConfigUpdateResult> {
  const run = mcpConfigUpdateTail.then(
    () => updateMCPConfigUnlocked(servers, options),
    () => updateMCPConfigUnlocked(servers, options),
  );
  mcpConfigUpdateTail = run.then(() => undefined, () => undefined);
  return run;
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
