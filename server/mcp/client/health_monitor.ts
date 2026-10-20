import { MCPConnectionLifecycle } from "./connection_lifecycle";
import { isProcessBacked, isInstallationPending, isMissingRequiredApiKey } from "./readiness";
import { mayReceiveMcpHealthUpdate, projectMcpServerHealth } from "../public_security";
import type { MCPToolDef, CrashTracker, MCPServerConfig } from "./contracts";
import { hasCurrentCachedToolInventory } from "./fingerprints";
import { assertMCPPackageRunnerPolicy } from './package_paths';
import type { MCPConfigurationAccess } from './contracts';
import type { ManagedSkillRuntime } from './skill_runtime';

interface MCPHealthHost extends MCPConfigurationAccess {
  ensureServerConnected(name: string, config: MCPServerConfig): Promise<MCPToolDef[]>;
  cacheToolDefinitions(name: string, tools: MCPToolDef[]): void;
}

export class MCPHealthMonitor {
  recordConnected(name: string): void {
    const tracker = this.trackers.get(name) || { consecutiveCrashes: 0, lastCrashTime: '', lastSuccessfulConnect: '', restartTimer: null };
    tracker.consecutiveCrashes = 0;
    tracker.lastSuccessfulConnect = new Date().toISOString();
    delete tracker.lastError;
    if (tracker.restartTimer) clearTimeout(tracker.restartTimer);
    tracker.restartTimer = null;
    this.trackers.set(name, tracker);
  }

  recordCrash(name: string): void {
    const tracker = this.trackers.get(name);
    if (tracker) tracker.lastCrashTime = new Date().toISOString();
    this.scheduleRestart(name);
    this.broadcastHealth();
  }

  stopRestarts(): void {
    for (const tracker of this.trackers.values()) {
      if (tracker.restartTimer) clearTimeout(tracker.restartTimer);
      tracker.restartTimer = null;
    }
  }

  readonly trackers = new Map<string, CrashTracker>();
  onServerRecovered?: (name: string, tools: MCPToolDef[]) => void | Promise<unknown>;
  ioRef?: any;
  constructor(private host: MCPHealthHost, private runtime: ManagedSkillRuntime, private connections: MCPConnectionLifecycle) {}

scheduleRestart(name: string): void {
    const tracker = this.trackers.get(name);
    if (!tracker) return;

    if (tracker.restartTimer) {
      clearTimeout(tracker.restartTimer);
    }

    // Max 5 consecutive crashes before giving up
    if (tracker.consecutiveCrashes >= 5) {
      console.error(`[MCP] "${name}" crashed ${tracker.consecutiveCrashes} times — giving up. Manual intervention required.`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, tracker.consecutiveCrashes), 60000);
    tracker.consecutiveCrashes++;

    console.log(`[MCP] Scheduling restart for "${name}" in ${delay}ms (crash #${tracker.consecutiveCrashes})`);

    tracker.restartTimer = setTimeout(async () => {
      tracker.restartTimer = null;
      try {
        const config = this.host.getConfig();
        const serverConfig = config[name];
        if (!serverConfig || !serverConfig.enabled || isInstallationPending(name, serverConfig)) {
          console.log(`[MCP] Server "${name}" is now disabled, skipping restart`);
          return;
        }

        const tools = await this.host.ensureServerConnected(name, serverConfig);
        console.log(`[MCP] "${name}" restarted successfully with ${tools.length} tools`);

        tracker.consecutiveCrashes = 0;
        tracker.lastSuccessfulConnect = new Date().toISOString();

        await this.onServerRecovered?.(name, tools);
        this.host.cacheToolDefinitions(name, tools);
        this.connections.scheduleIdle(name);
      } catch (err: any) {
        tracker.lastError = String(err?.message || err);
        console.error(`[MCP] Restart attempt for "${name}" failed: ${err.message}`);
        // A failed recovery attempt is still part of the same crash sequence.
        // Keep retrying with the tracker-controlled exponential backoff until
        // the five-crash circuit breaker opens. Without this reschedule, one
        // failed restart left an enabled MCP server permanently disconnected.
        this.scheduleRestart(name);
      }
      this.broadcastHealth();
    }, delay);
  }

recordStartupFailure(name: string, err: any): void {
    let tracker = this.trackers.get(name);
    if (!tracker) {
      tracker = {
        consecutiveCrashes: 0,
        lastCrashTime: '',
        lastSuccessfulConnect: '',
        restartTimer: null,
      };
      this.trackers.set(name, tracker);
    }
    tracker.lastCrashTime = new Date().toISOString();
    tracker.lastError = String(err?.message || err);
    this.scheduleRestart(name);
    this.broadcastHealth();
  }

getServerHealth(): Record<string, { status: string; consecutiveCrashes: number; lastCrashTime?: string; lastSuccessfulConnect?: string; lastError?: string }> {
    const config = this.host.getConfig();
    const health: Record<string, any> = {};
    for (const [name] of Object.entries(config)) {
      const tracker = this.trackers.get(name);
      const isRestarting = !!tracker?.restartTimer;
      const identityFailure = config[name]?.source === 'local'
        ? this.runtime.failures.get(name)
        : undefined;
      let configurationError: string | undefined;
      if (config[name]?.enabled) {
        try {
          if (isMissingRequiredApiKey(config[name])) throw new Error(`Required API key is not configured: ${config[name].apiKeyEnv || '(undeclared key)'}`);
          if (isInstallationPending(name, config[name])) throw new Error('Skill activation transaction is pending.');
          assertMCPPackageRunnerPolicy(config[name]);
        } catch (error: any) { configurationError = String(error?.message || error); }
      }
      const readyOnDemand = Boolean(
        config[name]?.enabled
        && !identityFailure
        && isProcessBacked(config[name])
        && hasCurrentCachedToolInventory(config[name]),
      );
      health[name] = {
        status: identityFailure ? 'failed'
          : configurationError ? 'configuration_required'
          : isRestarting ? 'restarting'
          : this.connections.live.has(name) ? 'connected'
          : (tracker?.consecutiveCrashes ?? 0) >= 5 ? 'failed'
          : (tracker?.consecutiveCrashes ?? 0) > 0 ? 'crashed'
          : readyOnDemand ? 'idle'
          : 'disconnected',
        consecutiveCrashes: tracker?.consecutiveCrashes || 0,
        lastCrashTime: tracker?.lastCrashTime || undefined,
        lastSuccessfulConnect: tracker?.lastSuccessfulConnect || undefined,
        lastError: identityFailure || configurationError || tracker?.lastError || undefined,
      };
    }
    return health;
  }

broadcastHealth(): void {
    const sockets = this.ioRef?.sockets?.sockets;
    if (!sockets || typeof sockets.values !== 'function') return;
    const payload = { servers: projectMcpServerHealth(this.getServerHealth()) };
    for (const socket of sockets.values()) {
      if (mayReceiveMcpHealthUpdate(socket?.data)) {
        socket.emit('mcp:health_update', payload);
      }
    }
  }
}
