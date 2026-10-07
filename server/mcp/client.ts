import type { MCPSkillInstallOptions } from './client/contracts';
import { resolveDirectSkillDirectory } from './client/package_sources';
import { MCPConfigStore } from './client/config_store';
import { ManagedSkillRuntime } from './client/skill_runtime';
import { MCPInstalledSkills } from './client/installed_skills';
import { MCPSkillRecovery } from './client/skill_recovery';
import { MCPHealthMonitor } from './client/health_monitor';
import { MCPConnectionLifecycle } from "./client/connection_lifecycle";
import { createMCPTransport } from "./client/transport";
import { isProcessBacked, isInstallationPending, isMissingRequiredApiKey } from "./client/readiness";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { type ManagedSkillIdentity } from "../marketplace/official_identity";
import { SKILLS_DIR } from "./skill_paths";
import type { MCPToolDef, MCPServerConfig, SkillPackage, SkillRepairResult, MCPCallOptions } from "./client/contracts";
import { requireSafeMCPServerName, normalizeSkillInstallName, requireSafeMCPToolName, mapMCPTools, mcpRegistryToolName } from "./client/security";
import { ownServerConfig, mcpServerConfigFingerprint, hasCurrentCachedToolInventory, mcpToolInventoryAttestation } from "./client/fingerprints";
import { ensureSkillsDir } from "./client/package_files";
import { ensureRuntimeNodeModulesLink } from "./client/dependencies";
import { comparePackageVersions, assertMCPPackageRunnerPolicy } from "./client/package_paths";
import { withMCPWallTimeout, PROCESS_CONNECT_TIMEOUT_MS, MCPRuntimeTimeoutError, DEFAULT_TOOL_CALL_WALL_TIMEOUT_MS } from "./client/timeouts";

export { SKILLS_DIR };
export type { MCPToolCapabilityDeclaration } from './client/contracts';
export type { MCPServerConfig } from './client/contracts';
export type { MCPToolDef } from './client/contracts';
export type { MCPCallOptions } from './client/contracts';
export type { SkillPackage } from './client/contracts';
export type { SkillRepairResult } from './client/contracts';
export { comparePackageVersions } from './client/package_paths';
export { assertMCPPackageRunnerPolicy } from './client/package_paths';
export { normalizeSkillInstallName } from './client/security';
export { requireSafeMCPServerName } from './client/security';
export { requireSafeMCPToolName } from './client/security';
export { mcpRegistryToolName } from './client/security';
export { mcpServerConfigFingerprint } from './client/fingerprints';
export { mcpPublicRuntimeContractFingerprint } from './client/fingerprints';

globalThis.WebSocket = WebSocket as any;

export class MCPClientManager {
  private configuration: MCPConfigStore;
  private runtime: ManagedSkillRuntime;
  private installed: MCPInstalledSkills;
  private recovery: MCPSkillRecovery;
  private health: MCPHealthMonitor;

  constructor(configPath?: string, runtimePaths?: { skillsDir?: string; quarantineRoot?: string }) {
    this.configuration = new MCPConfigStore(configPath, runtimePaths);
    const config = { getConfig: () => this.getConfig(), saveConfig: (servers: Record<string, MCPServerConfig>) => this.saveConfig(servers) };
    this.runtime = new ManagedSkillRuntime(config);
    this.installed = new MCPInstalledSkills(config, this.runtime, this.configuration.quarantineRoot);
    this.recovery = new MCPSkillRecovery({ ...config, restartServer: name => this.restartServer(name), disconnectServer: name => this.disconnectServer(name) }, this.runtime);
    this.health = new MCPHealthMonitor({ ...config, ensureServerConnected: (name, settings) => this.ensureServerConnected(name, settings), cacheToolDefinitions: (name, tools) => this.cacheToolDefinitions(name, tools) }, this.runtime, this.connections);
  }

  getConfig(): Record<string, MCPServerConfig> { return this.configuration.getConfig(); }
  saveConfig(servers: Record<string, MCPServerConfig>): void { return this.configuration.saveConfig(servers); }
  getRemoteDevices(): Record<string, string> { return this.configuration.getRemoteDevices(); }
  saveRemoteDevices(devices: Record<string, string>): void { return this.configuration.saveRemoteDevices(devices); }
  getConfigPath(): string { return this.configuration.getConfigPath(); }
  syncFactoryCapabilityMetadata(): string[] { return this.configuration.syncFactoryCapabilityMetadata(); }
  beginSkillActivation(name: string): MCPServerConfig { return this.installed.beginSkillActivation(name); }
  commitSkillActivation(name: string): void { return this.installed.commitSkillActivation(name); }
  migrateLegacySkills() { return this.installed.migrateLegacySkills(); }
  listLocalSkills(): SkillPackage[] { return this.installed.listLocalSkills(); }
  async installSkillValidated(
    name: string,
    sourceDir: string,
    options?: MCPSkillInstallOptions,
  ): Promise<string> { return this.installed.installSkillValidated(name, sourceDir, options); }
  cleanupBrokenSkills(): string[] { return this.installed.cleanupBrokenSkills(); }
  uninstallSkill(name: string): void { return this.installed.uninstallSkill(name); }
  assertLocalSkillRuntimeIdentity(
    name: string,
    suppliedConfig?: MCPServerConfig,
  ): ManagedSkillIdentity { return this.runtime.assertLocalSkillRuntimeIdentity(name, suppliedConfig); }
  reconcileBundledSkillRuntimes(
    bundledRoot?: string,
  ): void { return this.recovery.reconcileBundledSkillRuntimes(bundledRoot); }
  async repairSkill(name: string): Promise<SkillRepairResult> { return this.recovery.repairSkill(name); }
  getServerHealth(): Record<string, { status: string; consecutiveCrashes: number; lastCrashTime?: string; lastSuccessfulConnect?: string; lastError?: string }> { return this.health.getServerHealth(); }

  private connections = new MCPConnectionLifecycle(
    (name, config, epoch) => this.connectServer(name, config, epoch),
    name => {
      console.log('[MCP] ' + name + ': released idle on-demand process');
      this.health.broadcastHealth();
    },
  );

  private discoveryInitialized = false;

  setSocketIO(io: any): void { this.health.ioRef = io; }
  setOnServerRecovered(cb: (name: string, tools: MCPToolDef[]) => void | Promise<unknown>): void { this.health.onServerRecovered = cb; }

  private cacheToolDefinitions(name: string, tools: MCPToolDef[]): void {
    const safeName = requireSafeMCPServerName(name);
    const config = this.getConfig();
    if (!ownServerConfig(config, safeName)) return;
    config[safeName].cachedTools = tools.map(tool => ({
      serverName: safeName,
      name: tool.name,
      rawName: tool.rawName || requireSafeMCPToolName(
        tool.name.slice(`mcp_${safeName}_`.length),
      ),
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      capability: tool.capability,
    }));
    config[safeName].cachedToolsFingerprint = mcpServerConfigFingerprint(config[safeName]);
    if (config[safeName].source === 'local') {
      config[safeName].cachedToolsAttestation = mcpToolInventoryAttestation(config[safeName]).toString('base64url');
    } else {
      delete config[safeName].cachedToolsAttestation;
    }
    config[safeName].toolCount = tools.length;
    this.saveConfig(config);
  }

  private ensureServerConnected(name: string, config: MCPServerConfig): Promise<MCPToolDef[]> {
    return this.connections.ensure(name, config);
  }

  async connectAll(): Promise<MCPToolDef[]> {
    ensureSkillsDir();
    const finalConfig = this.getConfig();
    const allTools: MCPToolDef[] = [];

    for (const [serverName, serverConfig] of Object.entries(finalConfig)) {
      if (!serverConfig.enabled) continue;
      if (isInstallationPending(serverName, serverConfig)) {
        console.warn(`[MCP] ${serverName}: skipped local package with an uncommitted pending marker`);
        continue;
      }
      if (serverConfig.autoGenerated === true) {
        console.warn(`[MCP] ${serverName}: skipped unapproved auto-generated skill configuration`);
        continue;
      }
      if (isMissingRequiredApiKey(serverConfig)) {
        console.log(`[MCP] ${serverName}: skipped (missing ${serverConfig.apiKeyEnv})`);
        continue;
      }
      if (serverConfig.source === 'local') {
        try {
          ensureRuntimeNodeModulesLink(resolveDirectSkillDirectory(serverName));
          this.assertLocalSkillRuntimeIdentity(serverName, serverConfig);
        } catch (error: any) {
          await this.disconnectServer(serverName);
          console.warn(`[MCP] ${serverName}: skipped invalid managed runtime identity (${error?.message || error})`);
          continue;
        }
      }
      try {
        assertMCPPackageRunnerPolicy(serverConfig);
      } catch (error: any) {
        console.warn(`[MCP] ${serverName}: skipped unsafe package runner (${error?.message || error})`);
        continue;
      }

      const cacheMatchesConfig = hasCurrentCachedToolInventory(serverConfig);
      if (isProcessBacked(serverConfig) && cacheMatchesConfig) {
        allTools.push(...serverConfig.cachedTools);
        console.log(`[MCP] ${serverName}: ${serverConfig.cachedTools.length} cached tools ready on demand`);
        continue;
      }
      if (serverConfig.cachedTools?.length && !cacheMatchesConfig) {
        console.warn(`[MCP] ${serverName}: ignored stale tool inventory without a matching config fingerprint`);
      }

      try {
        const tools = await this.ensureServerConnected(serverName, serverConfig);
        allTools.push(...tools);

        this.cacheToolDefinitions(serverName, tools);

        console.log(`[MCP] ${serverName}: ${tools.length} tools discovered (${serverConfig.source || 'external'})`);
        if (isProcessBacked(serverConfig)) {
          await this.disconnectServer(serverName);
          console.log(`[MCP] ${serverName}: process released; tools will start on demand`);
        }
      } catch (err: any) {
        console.warn(`[MCP] Failed to connect to ${serverName}: ${err.message}`);
        if (serverConfig.source === 'local') {
          this.health.recordStartupFailure(serverName, err);
          console.warn(`[MCP] Local skill "${serverName}" failed to start. Keeping it enabled and marking health for repair.`);
        }
      }
    }

    this.discoveryInitialized = true;
    return allTools;
  }

  private async connectServer(
    name: string,
    config: MCPServerConfig,
    expectedEpoch = this.connections.currentEpoch(name),
  ): Promise<MCPToolDef[]> {
    name = requireSafeMCPServerName(name);
    if (!this.connections.isCurrent(name, expectedEpoch)) throw new Error('MCP connection was superseded.');
    assertMCPPackageRunnerPolicy(config);
    if (config.source === 'local') this.assertLocalSkillRuntimeIdentity(name, config);
    const existing = this.connections.live.get(name);
    if (existing && mcpServerConfigFingerprint(existing.config) === mcpServerConfigFingerprint(config)) {
      try {
        const result = await withMCPWallTimeout(
          existing.client.listTools() as ReturnType<Client["listTools"]>, PROCESS_CONNECT_TIMEOUT_MS,
          'MCP server "' + name + '" timed out while listing tools.',
          () => this.connections.timeout(name, existing.transport, expectedEpoch),
        );
        if (!this.connections.isCurrent(name, expectedEpoch) || this.connections.live.get(name) !== existing) {
          throw new Error('MCP connection was superseded.');
        }
        return mapMCPTools(name, result.tools);
      } catch (error) {
        if (!this.connections.isCurrent(name, expectedEpoch) || this.connections.live.get(name) !== existing) throw error;
      }
    }
    if (existing) await this.connections.retire(name, existing);
    const transport = createMCPTransport(name, config, () => this.runtime.resolveRuntimeTsxCli());
    const client = new Client({ name: 'lumiOS-mcp-client', version: '2.0' }, { capabilities: {} });
    try {
      this.connections.attachPending(name, expectedEpoch, transport);
      await withMCPWallTimeout(
        client.connect(transport), PROCESS_CONNECT_TIMEOUT_MS,
        'MCP server "' + name + '" timed out while connecting.',
        () => this.connections.timeout(name, transport, expectedEpoch),
      );
      if (!this.connections.isCurrent(name, expectedEpoch)) throw new Error('MCP connection was superseded.');
      const protocolClose = transport.onclose;
      transport.onclose = () => {
        try { protocolClose?.(); } finally {
          if (this.connections.unexpectedClose(name, transport)) {
            console.log('[MCP] CRASH DETECTED: "' + name + '" process exited unexpectedly');
            this.health.recordCrash(name);
          }
        }
      };
      const protocolError = transport.onerror;
      transport.onerror = (error: Error) => {
        try { protocolError?.(error); } finally {
          console.error('[MCP] Error in "' + name + '" transport:', error.message);
        }
      };
      const result = await withMCPWallTimeout(
        client.listTools(), PROCESS_CONNECT_TIMEOUT_MS,
        'MCP server "' + name + '" timed out while listing tools.',
        () => this.connections.timeout(name, transport, expectedEpoch),
      );
      const tools = mapMCPTools(name, result.tools);
      this.connections.publish(name, expectedEpoch, { client, transport, config });
      this.health.recordConnected(name);
      return tools;
    } catch (error) {
      await this.connections.closeTransport(name, transport).catch(() => undefined);
      throw error;
    }
  }

  async callTool(fullName: string, args: Record<string, any>, options: MCPCallOptions = {}): Promise<string> {
    if (!fullName.startsWith('mcp_')) throw new Error(`Invalid MCP tool name: ${fullName}`);
    const config = this.getConfig();
    const candidates = Array.from(new Set([...Object.keys(config), ...this.connections.live.keys()]))
      .filter(name => {
        try {
          return fullName.startsWith(`mcp_${requireSafeMCPServerName(name)}_`);
        } catch {
          return false;
        }
      });
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length > 1
          ? `Ambiguous MCP tool owner: ${fullName}`
          : `Invalid MCP tool name: ${fullName}`,
      );
    }
    const serverName = candidates[0];
    const rawToolName = fullName.slice(`mcp_${serverName}_`.length);
    return this.callToolForServer(serverName, rawToolName, args, options);
  }

  /** Execute an already-declared tool against its exact owning server. */
  async callToolForServer(
    serverName: string,
    rawToolName: string,
    args: Record<string, any>,
    options: MCPCallOptions = {},
  ): Promise<string> {
    const safeServerName = requireSafeMCPServerName(serverName);
    const safeToolName = requireSafeMCPToolName(rawToolName);
    const fullName = mcpRegistryToolName(safeServerName, safeToolName);
    const config = this.getConfig();
    const existingServer = this.connections.live.get(safeServerName);
    const serverConfig = ownServerConfig(config, safeServerName) || existingServer?.config;
    if (!serverConfig) throw new Error(`MCP server "${safeServerName}" is not configured`);
    if (serverConfig.enabled === false) throw new Error(`MCP server "${safeServerName}" is disabled`);
    assertMCPPackageRunnerPolicy(serverConfig);
    if (isInstallationPending(safeServerName, serverConfig)) {
      throw new Error(`MCP server "${safeServerName}" is pending activation and is not callable yet`);
    }
    if (isMissingRequiredApiKey(serverConfig)) {
      throw new Error(`MCP server "${safeServerName}" requires ${serverConfig.apiKeyEnv}`);
    }
    if (serverConfig.source === 'local') {
      try {
        this.assertLocalSkillRuntimeIdentity(safeServerName, serverConfig);
      } catch (error) {
        if (existingServer) await this.disconnectServer(safeServerName);
        throw error;
      }
    }

    if (!existingServer || mcpServerConfigFingerprint(existingServer.config) !== mcpServerConfigFingerprint(serverConfig)) {
      await this.ensureServerConnected(safeServerName, serverConfig);
    }
    const server = this.connections.live.get(safeServerName);
    if (!server) throw new Error(`MCP server "${safeServerName}" failed to connect`);
    const releaseCall = this.connections.beginCall(safeServerName, server);

    try {
      const request = { name: safeToolName, arguments: args };
      const requestedTimeoutMs = Number(options.timeoutMs);
      const hasRequestedTimeout = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0;
      const timeoutMs = hasRequestedTimeout
        ? requestedTimeoutMs
        : DEFAULT_TOOL_CALL_WALL_TIMEOUT_MS;
      const call = hasRequestedTimeout
        ? server.client.callTool(request, undefined, {
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs,
          })
        : server.client.callTool(request);
      let result: Awaited<typeof call>;
      try {
        result = await withMCPWallTimeout(
          call,
          timeoutMs,
          `MCP tool "${fullName}" exceeded its wall timeout.`,
          () => this.connections.timeout(safeServerName, server.transport),
        );
      } catch (error) {
        if (!(error instanceof MCPRuntimeTimeoutError) && /timed?\s*out|timeout/i.test(String((error as any)?.message || error))) {
          this.connections.timeout(safeServerName, server.transport);
        }
        throw error;
      }

      const contents = (result as any).content || [];
      const text = contents
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      if ((result as any).isError === true) {
        throw new Error(text.trim() || `MCP tool "${fullName}" failed without an error message.`);
      }
      return text;
    } finally {
      releaseCall();
    }
  }

  async disconnectAll(): Promise<void> {
    this.health.stopRestarts();
    await this.connections.disconnectAll();
  }

  async restartServer(name: string): Promise<MCPToolDef[]> {
    name = requireSafeMCPServerName(name);
    const config = this.getConfig();
    const serverConfig = ownServerConfig(config, name);
    if (!serverConfig || !serverConfig.enabled) return [];
    if (serverConfig.source === 'local') this.assertLocalSkillRuntimeIdentity(name, serverConfig);
    await this.disconnectServer(name);

    const tools = await this.ensureServerConnected(name, serverConfig);
    this.cacheToolDefinitions(name, tools);
    this.connections.scheduleIdle(name);
    return tools;
  }

  /** Disconnect a server without restarting it (used when disabling) */
  async disconnectServer(name: string): Promise<void> {
    await this.connections.disconnect(name);
  }

  getConnectedServers(): string[] {
    return Array.from(this.connections.live.keys());
  }

  getAvailableServers(): string[] {
    const config = this.getConfig();
    return Object.entries(config)
      .filter(([name, serverConfig]) => (
        serverConfig.enabled
        && (serverConfig.source !== 'local' || !this.runtime.failures.has(name))
        && !isInstallationPending(name, serverConfig)
        && !isMissingRequiredApiKey(serverConfig)
      ))
      .filter(([, serverConfig]) => {
        try {
          assertMCPPackageRunnerPolicy(serverConfig);
          return true;
        } catch {
          return false;
        }
      })
      .filter(([name]) => (this.health.trackers.get(name)?.consecutiveCrashes || 0) < 5)
      .map(([name]) => name);
  }

  getRoutableServers(): string[] {
    if (!this.discoveryInitialized) return [];
    const config = this.getConfig();
    return this.getAvailableServers().filter(name => (
      this.connections.live.has(name)
      || (Boolean(config[name]) && hasCurrentCachedToolInventory(config[name]))
    ));
  }
}

export const mcpManager = new MCPClientManager();
