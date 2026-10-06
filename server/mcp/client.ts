import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataPath } from "../config/data_path";
import { loadKeys } from "../config/keys";
import { runRuntimeCapabilityCleanup } from "./runtime_cleanup";
import { mayReceiveMcpHealthUpdate, projectMcpServerHealth } from "./public_security";
import { computeSkillContentDigest, configTargetsInstalledPackage, createBundledSkillIdentity, createGeneratedSkillIdentity, createManagedSkillRuntimeIdentity, signManagedSkillIdentity, verifyManagedSkillIdentitySignature, verifyManagedSkillRuntimeIdentity, type ManagedSkillIdentity } from "../marketplace/official_identity";
import { getJwtSecret } from "../config/local_identity";
import { SKILLS_DIR, LEGACY_SKILLS_DIR } from "./skill_paths";
import { migrateProfileSkills } from "./skill_profile_migration";
import type { ConnectedServer, MCPToolDef, CrashTracker, MCPServerConfig, MCPConfigFile, SkillPackage, SkillRepairResult, MCPCallOptions } from './client/contracts';
import { DEFAULT_RUNTIME_CONFIG, FACTORY_CONFIG, DEFAULT_CONFIG_FILE } from './client/defaults';
import { requireSafeMCPServerName, PENDING_SKILL_MARKER, normalizeSkillInstallName, requireSafeMCPToolName, mapMCPTools, mcpRegistryToolName } from './client/security';
import { ownServerConfig, mcpServerConfigFingerprint, stableConfigValue } from './client/fingerprints';
import { resolveDirectSkillDirectory, resolveValidatedSkillSourceDirectory } from './client/package_sources';
import { readPkg, ensureSkillsDir, assertManagedSkillSource, copyDirSync, patchInstalledMetadata, patchInstalledVersion } from './client/package_files';
import { ensureRuntimeNodeModulesLink, installLockedDepsWithoutScripts, prepareLocalSkillDependenciesSync, resolveRuntimeNodeModulesDir } from './client/dependencies';
import { managedSkillRuntimeEnvironment, stampManagedSkillIdentity } from './client/managed_identity';
import { comparePackageVersions, packagePath, toPortableSkillPath, assertMCPPackageRunnerPolicy, expandPortablePath, isNpxCommand } from './client/package_paths';
import { PROCESS_IDLE_TIMEOUT_MS, withMCPWallTimeout, PROCESS_CONNECT_TIMEOUT_MS, MCPRuntimeTimeoutError, DEFAULT_TOOL_CALL_WALL_TIMEOUT_MS } from './client/timeouts';

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
  private servers: Map<string, ConnectedServer> = new Map();
  private discoveryInitialized = false;
  private connectingServers: Map<string, { fingerprint: string; promise: Promise<MCPToolDef[]> }> = new Map();
  private connectionEpoch: Map<string, number> = new Map();
  private activeCalls: Map<string, number> = new Map();
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private configPath: string;
  private factoryConfigPath: string;
  private cleanupSkillsDir: string;
  private quarantineRoot: string;
  private runtimeCleanupApplied = false;
  private crashTrackers: Map<string, CrashTracker> = new Map();
  private invalidManagedRuntimes: Map<string, string> = new Map();
  private closingSet: Set<string> = new Set();
  private onServerRecovered?: (name: string, tools: MCPToolDef[]) => void | Promise<unknown>;
  private ioRef?: any;

  constructor(
    configPath?: string,
    runtimePaths?: { skillsDir?: string; quarantineRoot?: string },
  ) {
    this.configPath = configPath || getDataPath(DEFAULT_RUNTIME_CONFIG);
    this.factoryConfigPath = FACTORY_CONFIG;
    this.cleanupSkillsDir = runtimePaths?.skillsDir
      || (configPath ? path.join(path.dirname(configPath), 'lumi_skills') : SKILLS_DIR);
    this.quarantineRoot = runtimePaths?.quarantineRoot
      || (configPath
        ? path.join(path.dirname(configPath), 'quarantine', 'generated-skills')
        : path.dirname(getDataPath(path.join('quarantine', 'generated-skills', '.keep'))));
  }

  setSocketIO(io: any): void { this.ioRef = io; }
  setOnServerRecovered(cb: (name: string, tools: MCPToolDef[]) => void | Promise<unknown>): void { this.onServerRecovered = cb; }

  getConfig(): Record<string, MCPServerConfig> {
    return this.readConfigFile().mcpServers || {};
  }

  saveConfig(servers: Record<string, MCPServerConfig>): void {
    const config = this.readConfigFile();
    config.mcpServers = servers;
    this.saveConfigFile(config);
  }

  /** Make one pending package startable only for the explicit activation transaction. */
  beginSkillActivation(name: string): MCPServerConfig {
    const safeName = requireSafeMCPServerName(name);
    const config = this.getConfig();
    const current = ownServerConfig(config, safeName);
    if (!current) throw new Error(`MCP Skill "${safeName}" has no installed runtime configuration.`);
    if (current.source === 'local') this.assertLocalSkillRuntimeIdentity(safeName, current);
    const next: MCPServerConfig = {
      ...current,
      enabled: true,
      installationState: current.installationState === 'active' ? 'active' : 'pending',
    };
    config[safeName] = next;
    this.saveConfig(config);
    return next;
  }

  /** Commit activation only after the caller verified live tools and manifest entries. */
  commitSkillActivation(name: string): void {
    const safeName = requireSafeMCPServerName(name);
    const config = this.getConfig();
    const current = ownServerConfig(config, safeName);
    if (!current) throw new Error(`MCP Skill "${safeName}" disappeared before activation commit.`);
    if (current.source === 'local') this.assertLocalSkillRuntimeIdentity(safeName, current);
    if (current.source === 'local') {
      const skillDir = resolveDirectSkillDirectory(safeName);
      if (!fs.existsSync(skillDir)) throw new Error(`MCP Skill "${safeName}" package is missing.`);
      const pkg = readPkg(skillDir);
      if (!pkg.lumi) pkg.lumi = {};
      pkg.lumi.status = 'active';
      fs.writeFileSync(path.join(skillDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
    config[safeName] = {
      ...current,
      enabled: true,
      installationState: 'active',
    };
    this.saveConfig(config);
    if (current.source === 'local') {
      fs.rmSync(path.join(resolveDirectSkillDirectory(safeName), PENDING_SKILL_MARKER), { force: true });
    }
  }

  getRemoteDevices(): Record<string, string> {
    return this.readConfigFile().remoteDevices || {};
  }

  saveRemoteDevices(devices: Record<string, string>): void {
    const config = this.readConfigFile();
    config.remoteDevices = devices;
    this.saveConfigFile(config);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  migrateLegacySkills() {
    if (process.env.VITEST) return { migrated: [], skipped: [] };
    return migrateProfileSkills({
      legacyRoot: LEGACY_SKILLS_DIR, skillsRoot: SKILLS_DIR,
      servers: this.getConfig(), secret: getJwtSecret(),
      bindRuntime: (directory, identity) => {
        if (!ensureRuntimeNodeModulesLink(directory)) {
          throw new Error('Approved Skill dependencies are unavailable in this LumiCore host');
        }
        return this.bindManagedSkillRuntime(directory, identity);
      },
      saveServers: servers => this.saveConfig(servers),
    });
  }

  syncFactoryCapabilityMetadata(): string[] {
    if (!fs.existsSync(this.factoryConfigPath)) return [];
    let factory: MCPConfigFile;
    try {
      factory = JSON.parse(fs.readFileSync(this.factoryConfigPath, 'utf8'));
    } catch (error: any) {
      console.warn('[MCP] Factory capability metadata could not be read:', error?.message || error);
      return [];
    }
    const runtime = this.readConfigFile();
    const updated: string[] = [];
    for (const [name, factoryServer] of Object.entries(factory.mcpServers || {})) {
      const runtimeServer = runtime.mcpServers?.[name];
      if (!runtimeServer) continue;
      const nextDefault = factoryServer.capabilityDefault;
      const nextTools = factoryServer.toolCapabilities;
      if (
        JSON.stringify(runtimeServer.capabilityDefault || null) === JSON.stringify(nextDefault || null)
        && JSON.stringify(runtimeServer.toolCapabilities || null) === JSON.stringify(nextTools || null)
      ) continue;
      if (nextDefault) runtimeServer.capabilityDefault = JSON.parse(JSON.stringify(nextDefault));
      else delete runtimeServer.capabilityDefault;
      if (nextTools) runtimeServer.toolCapabilities = JSON.parse(JSON.stringify(nextTools));
      else delete runtimeServer.toolCapabilities;
      updated.push(name);
    }
    const migrations = runtime.migrations || {};
    const markerChanged = Number(migrations.mcpCapabilityDeclarationsV1 || 0) < 1;
    if (markerChanged) runtime.migrations = { ...migrations, mcpCapabilityDeclarationsV1: 1 };
    if (updated.length > 0 || markerChanged) this.saveConfigFile(runtime);
    return updated.sort((left, right) => left.localeCompare(right));
  }

  private readConfigFile(): MCPConfigFile {
    this.ensureRuntimeConfig();
    try {
      let raw = fs.readFileSync(this.configPath, 'utf-8');
      // Replace static relative paths with actual data directory paths
      raw = raw.replace(/"data\/lumi\.db"/g, JSON.stringify(getDataPath('lumi.db')));
      const parsed = JSON.parse(raw);
      const config = parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed
        : { mcpServers: parsed && typeof parsed === 'object' ? parsed : {} };
      return config;
    } catch (error: any) {
      console.error(`[MCP] Unable to read runtime config "${this.configPath}":`, error?.message || error);
      return { mcpServers: {} };
    }
  }

  private saveConfigFile(config: MCPConfigFile): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const temporaryPath = path.join(
      dir,
      `.${path.basename(this.configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      fs.renameSync(temporaryPath, this.configPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }

  private ensureRuntimeConfig(): void {
    if (!fs.existsSync(this.configPath)) {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(this.factoryConfigPath)) {
        fs.copyFileSync(this.factoryConfigPath, this.configPath);
      } else {
        this.saveConfigFile(DEFAULT_CONFIG_FILE);
      }
    }

    if (this.runtimeCleanupApplied) return;
    this.runtimeCleanupApplied = true;
    try {
      const report = runRuntimeCapabilityCleanup({
        configPath: this.configPath,
        skillsDir: this.cleanupSkillsDir,
        quarantineRoot: this.quarantineRoot,
      });
      if (report.applied) {
        console.log(
          `[MCP] Runtime cleanup applied: ${report.removedServerNames.length} generated servers removed, `
          + `${report.quarantinedSkills.length} skill directories quarantined, `
          + `filesystem ${report.filesystemDisabled ? 'disabled' : 'unchanged'}.`,
        );
      }
      if (report.errors.length > 0) {
        console.error(`[MCP] Runtime cleanup completed with ${report.errors.length} quarantine error(s).`);
      }
    } catch (error: any) {
      console.error('[MCP] Runtime cleanup failed; original config was left available:', error?.message || error);
    }
  }

  /** List all local skills in ~/lumi_skills/ */
  listLocalSkills(): SkillPackage[] {
    ensureSkillsDir();
    const skills: SkillPackage[] = [];
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.staging-')) continue;
      const skillDir = path.join(SKILLS_DIR, entry.name);
      const pkgPath = path.join(skillDir, 'package.json');
      const indexPath = path.join(skillDir, 'index.ts');

      let pkg: any = {};
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {}

      const hasIndex = fs.existsSync(indexPath);
      const hasRunCommand = !!pkg.lumi?.runCommand;
      const broken = !hasIndex && !hasRunCommand;

      skills.push({
        name: entry.name,
        description: pkg.description || pkg.lumi?.description || entry.name,
        toolCount: pkg.lumi?.toolCount || 0,
        autoGenerated: pkg.lumi?.autoGenerated || false,
        generatedFrom: pkg.lumi?.generatedFrom,
        installedAt: pkg.lumi?.installedAt || '',
        source: 'local',
        broken,
      });
    }
    return skills;
  }

  private syncBundledCapabilityMetadata(name: string, lumi: Record<string, any>): void {
    const config = this.getConfig();
    const server = config[name];
    if (!server) return;
    const nextDefault = lumi.capabilityDefault;
    const nextTools = lumi.toolCapabilities;
    if (
      JSON.stringify(server.capabilityDefault || null) === JSON.stringify(nextDefault || null)
      && JSON.stringify(server.toolCapabilities || null) === JSON.stringify(nextTools || null)
    ) return;
    if (nextDefault) server.capabilityDefault = nextDefault;
    else delete server.capabilityDefault;
    if (nextTools) server.toolCapabilities = nextTools;
    else delete server.toolCapabilities;
    this.saveConfig(config);
  }

  private deriveManagedSkillRuntime(directory: string) {
    const pkg = readPkg(directory);
    if (pkg.lumi?.runCommand) {
      throw new Error(
        'Official/generated Skills cannot execute an unbound runCommand. Configure a reviewed external MCP server instead.',
      );
    }
    const entry = path.resolve(directory, 'index.ts');
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error('Managed Skill runtime requires an installed index.ts entry point');
    }
    const tsxCli = this.resolveRuntimeTsxCli();
    if (!tsxCli) throw new Error('The trusted LumiCore TypeScript runtime is unavailable');
    const command = path.resolve(process.execPath);
    const dependencyDirectories = this.collectManagedRuntimeDependencyDirectories(directory);
    return createManagedSkillRuntimeIdentity({
      command,
      args: [path.resolve(tsxCli), entry],
      cwd: path.resolve(directory),
      env: {
        ...managedSkillRuntimeEnvironment(pkg),
        ...(pkg.lumi?.documentRuntime === true
          ? { LUMI_DOCUMENT_RUNTIME_ROOT: path.resolve(path.dirname(tsxCli), '../../..') } : {}),
      },
      files: [command, path.resolve(tsxCli), entry, ...dependencyDirectories,
        ...(pkg.lumi?.documentRuntime === true ? [
          'files/document_text.ts', 'knowledge/rtf.ts', 'knowledge/pptx.ts',
          'utils/pdf_text.ts', 'utils/spreadsheet.ts', 'utils/spreadsheet_formulas.ts', 'utils/spreadsheet_charts.ts',
        ].map(file => path.resolve(path.dirname(tsxCli), '../../../server', file)) : [])],
    });
  }

  private bindManagedSkillRuntime(
    directory: string,
    identity: ManagedSkillIdentity,
  ): ManagedSkillIdentity {
    const runtime = this.deriveManagedSkillRuntime(directory);
    return signManagedSkillIdentity({ ...identity, runtime, signature: undefined }, getJwtSecret());
  }

  /**
   * An explicit repair may rebind a still-identical official package to a
   * changed LumiCore host runtime. This is deliberately narrower than install:
   * it never adopts an unsigned/legacy/generated package and never repairs
   * package, command, entry-point, cwd, or environment drift.
   */
  private deriveBundledHostRuntimeRebind(
    name: string,
    directory: string,
    pkg: any,
    config: MCPServerConfig,
    assertionError: unknown,
  ): ManagedSkillIdentity | undefined {
    const failure = String((assertionError as any)?.message || assertionError || '');
    const runtimeDigestChanged = failure.includes(
      'runtime identity failed: Managed Skill runtime file changed:',
    );
    const hostRuntimeChanged = failure.includes(
      'runtime no longer matches the host-derived execution identity.',
    );
    if (!runtimeDigestChanged && !hostRuntimeChanged) return undefined;

    const packageIdentity = pkg.lumi?.managedSkill as ManagedSkillIdentity | undefined;
    const configIdentity = config.managedSkill;
    if (
      !packageIdentity
      || !configIdentity
      || JSON.stringify(packageIdentity) !== JSON.stringify(configIdentity)
      || packageIdentity.origin !== 'bundled'
      || !verifyManagedSkillIdentitySignature(packageIdentity, getJwtSecret())
    ) return undefined;

    const bundledDirectory = path.join(process.cwd(), 'server', 'skills', 'bundled', name);
    if (!fs.existsSync(bundledDirectory) || !fs.statSync(bundledDirectory).isDirectory()) {
      return undefined;
    }

    let expectedIdentity: ManagedSkillIdentity;
    try {
      expectedIdentity = createBundledSkillIdentity(`skill-${name}`, bundledDirectory);
      if (
        packageIdentity.origin !== expectedIdentity.origin
        || packageIdentity.skillId !== expectedIdentity.skillId
        || packageIdentity.packageName !== expectedIdentity.packageName
        || packageIdentity.packageVersion !== expectedIdentity.packageVersion
        || packageIdentity.contentDigest !== expectedIdentity.contentDigest
        || packageIdentity.reviewHash !== expectedIdentity.reviewHash
        || pkg.name !== expectedIdentity.packageName
        || String(pkg.lumi?.installedVersion || pkg.version || '') !== expectedIdentity.packageVersion
        || computeSkillContentDigest(directory) !== expectedIdentity.contentDigest
      ) return undefined;
    } catch {
      return undefined;
    }

    const oldRuntime = packageIdentity.runtime;
    const installedEntry = path.resolve(directory, 'index.ts');
    if (
      !oldRuntime
      || oldRuntime.transport !== 'stdio'
      || config.transport !== 'stdio'
      || Boolean(config.url)
      || Boolean(config.headers)
      || path.resolve(String(config.command || '')) !== oldRuntime.command
      || JSON.stringify(config.args || []) !== JSON.stringify(oldRuntime.args)
      || path.resolve(String(config.cwd || '')) !== oldRuntime.cwd
      || JSON.stringify(config.env || null) !== JSON.stringify(oldRuntime.env || null)
      || oldRuntime.cwd !== path.resolve(directory)
      || !oldRuntime.args.includes(installedEntry)
    ) return undefined;

    try {
      return this.bindManagedSkillRuntime(directory, expectedIdentity);
    } catch {
      return undefined;
    }
  }

  /** Fail closed before activation, process start, restart, or tool use. */
  assertLocalSkillRuntimeIdentity(
    name: string,
    suppliedConfig?: MCPServerConfig,
  ): ManagedSkillIdentity {
    const safeName = requireSafeMCPServerName(name);
    try {
      const config = suppliedConfig || ownServerConfig(this.getConfig(), safeName);
      if (!config || config.source !== 'local') {
        throw new Error(`Local Skill "${safeName}" has no managed local runtime configuration.`);
      }
      const directory = resolveDirectSkillDirectory(safeName);
      const pkg = readPkg(directory);
      const packageIdentity = pkg.lumi?.managedSkill as ManagedSkillIdentity | undefined;
      const configIdentity = config.managedSkill;
      if (!packageIdentity || !configIdentity || JSON.stringify(packageIdentity) !== JSON.stringify(configIdentity)) {
        throw new Error(`Local Skill "${safeName}" package and config identities do not match.`);
      }
      if (!verifyManagedSkillIdentitySignature(packageIdentity, getJwtSecret())) {
        throw new Error(`Local Skill "${safeName}" managed identity signature is invalid.`);
      }
      if (!['bundled', 'generated'].includes(packageIdentity.origin)) {
        throw new Error(`Local Skill "${safeName}" has an unsupported runtime origin.`);
      }
      if (
        pkg.name !== packageIdentity.packageName
        || String(pkg.lumi?.installedVersion || pkg.version || '') !== packageIdentity.packageVersion
        || computeSkillContentDigest(directory) !== packageIdentity.contentDigest
      ) {
        throw new Error(`Local Skill "${safeName}" package content changed after approval.`);
      }
      const runtimeVerification = verifyManagedSkillRuntimeIdentity(packageIdentity.runtime);
      if (!runtimeVerification.valid) {
        const reason = 'reason' in runtimeVerification
          ? runtimeVerification.reason
          : 'runtime identity is invalid';
        throw new Error(`Local Skill "${safeName}" runtime identity failed: ${reason}`);
      }
      const runtime = packageIdentity.runtime!;
      const expectedRuntime = this.deriveManagedSkillRuntime(directory);
      if (JSON.stringify(runtime) !== JSON.stringify(expectedRuntime)) {
        throw new Error(`Local Skill "${safeName}" runtime no longer matches the host-derived execution identity.`);
      }
      if (
        config.transport !== 'stdio'
        || Boolean(config.url)
        || Boolean(config.headers)
        || path.resolve(String(config.command || '')) !== runtime.command
        || JSON.stringify(config.args || []) !== JSON.stringify(runtime.args)
        || path.resolve(String(config.cwd || '')) !== runtime.cwd
        || JSON.stringify(config.env || null) !== JSON.stringify(runtime.env || null)
        || runtime.cwd !== path.resolve(directory)
        || !runtime.args.includes(path.resolve(directory, 'index.ts'))
      ) {
        throw new Error(`Local Skill "${safeName}" command, entry point, cwd, or environment differs from its approved runtime identity.`);
      }
      this.invalidManagedRuntimes.delete(safeName);
      return packageIdentity;
    } catch (error: any) {
      this.invalidManagedRuntimes.set(safeName, String(error?.message || error));
      throw error;
    }
  }

  syncBundledSkillUpgrades(
    bundledRoot = path.join(process.cwd(), 'server', 'skills', 'bundled'),
  ): Array<{ name: string; fromVersion: string; toVersion: string }> {
    ensureSkillsDir();
    if (!fs.existsSync(bundledRoot) || !fs.statSync(bundledRoot).isDirectory()) return [];
    const upgrades: Array<{ name: string; fromVersion: string; toVersion: string }> = [];
    for (const entry of fs.readdirSync(bundledRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = normalizeSkillInstallName(entry.name);
      const sourceDir = path.join(bundledRoot, entry.name);
      const installedDir = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(installedDir) || !fs.statSync(installedDir).isDirectory()) continue;
      const sourcePkg = readPkg(sourceDir);
      const installedPkg = readPkg(installedDir);
      const sourceVersion = String(sourcePkg.version || '0.0.0');
      const installedVersion = String(installedPkg.lumi?.installedVersion || installedPkg.version || '0.0.0');
      const samePackage = Boolean(sourcePkg.name) && sourcePkg.name === installedPkg.name;
      const managedInstall = Boolean(installedPkg.lumi?.installedVersion);
      const config = this.getConfig();
      const serverConfig = ownServerConfig(config, name);
      let officialIdentity: ManagedSkillIdentity | undefined;
      try {
        officialIdentity = createBundledSkillIdentity(`skill-${name}`, sourceDir);
      } catch {}
      let installedIdentity = installedPkg.lumi?.managedSkill as ManagedSkillIdentity | undefined;
      const safeCurrentLegacyInstall = Boolean(
        !installedIdentity
        && officialIdentity
        && sourceVersion === installedVersion
        && samePackage
        && managedInstall
        && installedPkg.lumi?.installedAt
        && serverConfig
        && configTargetsInstalledPackage(serverConfig, installedDir, sourcePkg)
        && (() => {
          try { return computeSkillContentDigest(installedDir) === officialIdentity!.contentDigest; }
          catch { return false; }
        })()
      );
      if (safeCurrentLegacyInstall && officialIdentity && serverConfig) {
        try {
          const boundIdentity = this.bindManagedSkillRuntime(installedDir, officialIdentity);
          stampManagedSkillIdentity(installedDir, boundIdentity);
          serverConfig.command = boundIdentity.runtime!.command;
          serverConfig.args = boundIdentity.runtime!.args;
          serverConfig.cwd = boundIdentity.runtime!.cwd;
          serverConfig.transport = 'stdio';
          serverConfig.managedSkill = boundIdentity;
          config[name] = serverConfig;
          this.saveConfig(config);
          installedIdentity = boundIdentity;
        } catch (error: any) {
          serverConfig.enabled = false;
          serverConfig.installationState = 'disabled';
          config[name] = serverConfig;
          this.saveConfig(config);
          console.warn(`[MCP] Disabled unbound bundled runtime "${name}": ${error?.message || error}`);
          continue;
        }
      }
      const contentMatches = Boolean(installedIdentity?.contentDigest)
        && (() => {
          try { return computeSkillContentDigest(installedDir) === installedIdentity!.contentDigest; }
          catch { return false; }
        })();
      const exactManagedRuntime = Boolean(
        samePackage
        && managedInstall
        && installedPkg.lumi?.installedAt
        && installedIdentity?.origin === 'bundled'
        && installedIdentity.skillId === `skill-${name}`
        && installedIdentity.packageName === installedPkg.name
        && installedIdentity.packageVersion === installedVersion
        && verifyManagedSkillIdentitySignature(installedIdentity, getJwtSecret())
        && (() => {
          try {
            return JSON.stringify(installedIdentity!.runtime)
              === JSON.stringify(this.deriveManagedSkillRuntime(installedDir));
          } catch { return false; }
        })()
        && serverConfig
        && JSON.stringify(serverConfig.managedSkill || null) === JSON.stringify(installedIdentity)
        && configTargetsInstalledPackage(serverConfig, installedDir, sourcePkg)
        && contentMatches
      );
      const currentOfficialIdentityMatches = Boolean(
        officialIdentity
        && installedIdentity?.origin === 'bundled'
        && installedIdentity.skillId === officialIdentity.skillId
        && installedIdentity.packageName === officialIdentity.packageName
        && installedIdentity.packageVersion === officialIdentity.packageVersion
        && installedIdentity.contentDigest === officialIdentity.contentDigest
      );
      if (
        exactManagedRuntime
        && sourceVersion === installedVersion
        && !currentOfficialIdentityMatches
        && serverConfig
      ) {
        serverConfig.enabled = false;
        serverConfig.installationState = 'disabled';
        config[name] = serverConfig;
        this.saveConfig(config);
        console.warn(`[MCP] Disabled bundled Skill "${name}" because its source changed without a version change.`);
        continue;
      }
      if (
        exactManagedRuntime
        && currentOfficialIdentityMatches
        && sourceVersion === installedVersion
      ) {
        this.syncBundledCapabilityMetadata(name, sourcePkg.lumi || {});
      }
      if (!exactManagedRuntime || comparePackageVersions(sourceVersion, installedVersion) <= 0) continue;
      if (serverConfig) {
        serverConfig.enabled = false;
        serverConfig.installationState = 'disabled';
        config[name] = serverConfig;
        this.saveConfig(config);
      }
      console.warn(
        `[MCP] Bundled Skill "${name}" ${installedVersion} is older than ${sourceVersion}; `
        + 'automatic non-transactional replacement is disabled. Reinstall the official Skill Hall entry explicitly.',
      );
    }
    return upgrades;
  }

  /** Install a local skill as one transaction: stage, prepare, then atomically publish. */
  async installSkillValidated(
    name: string,
    sourceDir: string,
    options?: {
      approvedGeneratedDraft?: {
        approvedAt: string;
        review: Record<string, unknown>;
      };
      managedSkill?: ManagedSkillIdentity;
    },
  ): Promise<string> {
    ensureSkillsDir();
    const skillName = normalizeSkillInstallName(name);
    const destDir = resolveDirectSkillDirectory(skillName);
    const sourceDirectory = resolveValidatedSkillSourceDirectory(sourceDir);
    const generatedReviewHash = String(
      options?.approvedGeneratedDraft?.review?.contentHash || '',
    ).trim();
    const managedIdentity = options?.managedSkill
      || (options?.approvedGeneratedDraft
        ? createGeneratedSkillIdentity(skillName, sourceDirectory, generatedReviewHash)
        : undefined);
    const stagingDir = path.resolve(
      SKILLS_DIR,
      `.staging-${skillName}-${process.pid}-${Date.now()}`,
    );
    if (path.dirname(stagingDir) !== path.resolve(SKILLS_DIR)) {
      throw new Error('Invalid skill staging directory target');
    }
    const config = this.getConfig();
    if (fs.existsSync(destDir) || ownServerConfig(config, skillName)) {
      throw new Error(`Skill "${skillName}" already exists. Uninstall it first.`);
    }

    try {
      assertManagedSkillSource(sourceDirectory, managedIdentity);
      copyDirSync(sourceDirectory, stagingDir);
      fs.writeFileSync(
        path.join(stagingDir, PENDING_SKILL_MARKER),
        `${new Date().toISOString()}\n`,
        'utf8',
      );
      const pkg = readPkg(stagingDir);
      const hasIndex = fs.existsSync(path.join(stagingDir, 'index.ts'));
      const hasRunCommand = Boolean(pkg.lumi?.runCommand);
      if (!hasIndex && !hasRunCommand) {
        throw new Error('Skill package must provide index.ts or lumi.runCommand');
      }
      if (options?.approvedGeneratedDraft) {
        pkg.lumi = {
          ...(pkg.lumi || {}),
          autoGenerated: false,
          generatedByLumi: true,
          status: 'pending',
          approvedAt: options.approvedGeneratedDraft.approvedAt,
          draftReview: options.approvedGeneratedDraft.review,
        };
        fs.writeFileSync(
          path.join(stagingDir, 'package.json'),
          `${JSON.stringify(pkg, null, 2)}\n`,
          'utf8',
        );
      }

      if (!pkg.lumi) pkg.lumi = {};
      pkg.lumi.status = 'pending';
      if (managedIdentity) pkg.lumi.managedSkill = managedIdentity;
      else delete pkg.lumi.managedSkill;
      fs.writeFileSync(
        path.join(stagingDir, 'package.json'),
        `${JSON.stringify(pkg, null, 2)}\n`,
        'utf8',
      );

      if (options?.approvedGeneratedDraft) {
        await installLockedDepsWithoutScripts(stagingDir);
      } else {
        await prepareLocalSkillDependenciesSync(stagingDir);
      }
      patchInstalledMetadata(stagingDir);
      patchInstalledVersion(stagingDir, readPkg(sourceDirectory).version || '0.0.0');
      fs.renameSync(stagingDir, destDir);
      try {
        const installedIdentity = managedIdentity
          ? this.bindManagedSkillRuntime(destDir, managedIdentity)
          : undefined;
        stampManagedSkillIdentity(destDir, installedIdentity);
        this.registerLocalSkill(skillName, destDir, readPkg(destDir), { pendingActivation: true });
      } catch (error) {
        fs.rmSync(destDir, { recursive: true, force: true });
        throw error;
      }
      return destDir;
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /** Remove incomplete local skill directories that cannot be started. */
  cleanupBrokenSkills(): string[] {
    const removed: string[] = [];
    for (const skill of this.listLocalSkills()) {
      if (!skill.broken) continue;
      this.uninstallSkill(skill.name);
      removed.push(skill.name);
    }
    return removed;
  }

  /**
   * Repair never follows mutable package metadata. Repository/npm changes must
   * enter a separately reviewed immutable proposal. An explicit repair may
   * rebind an unchanged, signed official bundle after only its trusted host
   * runtime changed; every other existing package receives a pure restart.
   */
  async repairSkill(name: string): Promise<SkillRepairResult> {
    ensureSkillsDir();
    let safeName: string;
    try {
      safeName = requireSafeMCPServerName(name);
    } catch {
      return { success: false, reason: 'Invalid skill name' };
    }

    const skillDir = resolveDirectSkillDirectory(safeName);
    const exists = fs.existsSync(skillDir);
    const config = this.getConfig();
    const serverConfig = ownServerConfig(config, safeName);
    if (!exists && !serverConfig) {
      return { success: false, reason: `Skill "${safeName}" not found` };
    }

    if (!exists && serverConfig?.source === 'local') {
      const bundledPath = path.join(process.cwd(), 'server', 'skills', 'bundled', safeName);
      if (fs.existsSync(bundledPath)) {
        return {
          success: false,
          reason: 'The managed package is missing. Repair will not replace it through the legacy non-transactional path; uninstall the stale registration, then explicitly install the official Skill Hall entry again.',
          reviewRequired: true,
        };
      }
    }

    const pkg = exists ? readPkg(skillDir) : {};
    const hasIndex = exists && fs.existsSync(path.join(skillDir, 'index.ts'));
    const hasRunCommand = !!pkg.lumi?.runCommand;
    const isBroken = exists && !hasIndex && !hasRunCommand;

    if (isBroken) {
      const bundledPath = path.join(process.cwd(), 'server', 'skills', 'bundled', safeName);

      if (fs.existsSync(bundledPath)) {
        return {
          success: false,
          reason: 'The managed package is incomplete. Repair will not overwrite it through the legacy non-transactional path; uninstall it, then explicitly install the official Skill Hall entry again.',
          reviewRequired: true,
        };
      }

      return {
        success: false,
        reason: pkg.lumi?.npmPackage || pkg.lumi?.repoUrl
          ? 'The installed third-party package is broken. Repair will not execute its mutable npmPackage/repoUrl metadata; create and approve an immutable staged package proposal first.'
          : 'Skill package is missing index.ts/runCommand and has no trusted bundled restore source. Clean it up, then reinstall an approved package or regenerate it.',
        ...(pkg.lumi?.npmPackage || pkg.lumi?.repoUrl
          ? { reviewRequired: true, requiredFlow: 'immutable_package_proposal' as const }
          : {}),
      };
    }

    if (exists) {
      if (!serverConfig) {
        return {
          success: false,
          reason: 'The local package has no approved runtime registration. Repair cannot register or execute it; reinstall it through the reviewed Skill Hall/draft flow.',
        };
      }
    }

    const latest = this.getConfig();
    const latestServer = ownServerConfig(latest, safeName);
    if (!latestServer || latestServer.installationState === 'pending') {
      return {
        success: false,
        reason: 'The skill is pending activation. Complete its original reviewed activation transaction instead of repairing it.',
      };
    }
    if (latestServer.enabled !== true) {
      return {
        success: false,
        reason: latestServer.requiresApiKey
          ? `Configure ${latestServer.apiKeyEnv || 'the required API key'} and enable the skill before restarting it.`
          : 'The skill is disabled. Enable it explicitly before requesting a restart.',
      };
    }
    let action: SkillRepairResult['action'] = 'restarted';
    let reboundRollback: {
      identity: ManagedSkillIdentity;
      serverConfig: MCPServerConfig;
      originalFailure: string;
    } | undefined;
    if (latestServer.source === 'local') {
      try {
        this.assertLocalSkillRuntimeIdentity(safeName, latestServer);
      } catch (error: any) {
        const reboundIdentity = this.deriveBundledHostRuntimeRebind(
          safeName,
          skillDir,
          pkg,
          latestServer,
          error,
        );
        if (!reboundIdentity?.runtime) {
          return {
            success: false,
            reason: error?.message || 'The local Skill runtime identity could not be verified.',
            reviewRequired: true,
          };
        }

        const previousIdentity = pkg.lumi?.managedSkill as ManagedSkillIdentity;
        const previousServerConfig = structuredClone(latestServer);
        stampManagedSkillIdentity(skillDir, reboundIdentity);
        try {
          latestServer.command = reboundIdentity.runtime.command;
          latestServer.args = reboundIdentity.runtime.args;
          latestServer.cwd = reboundIdentity.runtime.cwd;
          latestServer.transport = 'stdio';
          if (reboundIdentity.runtime.env) latestServer.env = reboundIdentity.runtime.env;
          else delete latestServer.env;
          delete latestServer.url;
          delete latestServer.headers;
          latestServer.managedSkill = reboundIdentity;
          delete latestServer.cachedTools;
          delete latestServer.cachedToolsFingerprint;
          delete latestServer.cachedToolsAttestation;
          latest[safeName] = latestServer;
          this.saveConfig(latest);
        } catch (writeError) {
          try {
            stampManagedSkillIdentity(skillDir, previousIdentity);
          } catch (rollbackError: any) {
            throw new Error(
              `Managed Skill "${safeName}" host-runtime rebind failed and its package identity rollback also failed: `
              + `${rollbackError?.message || rollbackError}. Original write error: ${(writeError as any)?.message || writeError}`,
            );
          }
          throw writeError;
        }
        reboundRollback = {
          identity: previousIdentity,
          serverConfig: previousServerConfig,
          originalFailure: String(error?.message || error),
        };
        action = 'runtime_rebound';
      }
    }
    try {
      const tools = await this.restartServer(safeName);
      return { success: true, action, directory: exists ? skillDir : undefined, toolCount: tools.length, tools };
    } catch (restartError: any) {
      if (!reboundRollback) throw restartError;
      try { await this.disconnectServer(safeName); } catch {}

      const rollbackFailures: string[] = [];
      try {
        stampManagedSkillIdentity(skillDir, reboundRollback.identity);
      } catch (error: any) {
        rollbackFailures.push(`package identity: ${error?.message || error}`);
      }
      try {
        const rollbackConfig = this.getConfig();
        rollbackConfig[safeName] = reboundRollback.serverConfig;
        this.saveConfig(rollbackConfig);
      } catch (error: any) {
        rollbackFailures.push(`runtime configuration: ${error?.message || error}`);
      }
      this.invalidManagedRuntimes.set(safeName, reboundRollback.originalFailure);

      if (rollbackFailures.length > 0) {
        throw new Error(
          `Managed Skill "${safeName}" restart failed after host-runtime rebind, and rollback was incomplete `
          + `(${rollbackFailures.join('; ')}). Original restart error: ${restartError?.message || restartError}`,
        );
      }
      throw new Error(
        `Managed Skill "${safeName}" restart failed after host-runtime rebind; package identity and runtime configuration were rolled back. `
        + `${restartError?.message || restartError}`,
      );
    }
  }

  private collectManagedRuntimeDependencyDirectories(skillDir: string): string[] {
    const runtimeNodeModules = resolveRuntimeNodeModulesDir();
    if (!runtimeNodeModules) throw new Error('LumiCore runtime dependencies are unavailable');
    const skillPackage = readPkg(skillDir);
    const skillDependencies = Object.keys(skillPackage.dependencies || {});
    const visited = new Set<string>();
    const directories: string[] = [];

    const resolveDependency = (name: string, parentDirectory?: string): string | undefined => {
      if (!parentDirectory) {
        const runtimePackage = packagePath(runtimeNodeModules, name);
        return fs.existsSync(path.join(runtimePackage, 'package.json'))
          ? runtimePackage
          : undefined;
      }

      // Mirror Node's upward node_modules lookup. npm commonly hoists a
      // transitive package to the Skill's top-level node_modules; checking only
      // dependency/node_modules and the LumiCore root could bind a different
      // package from the one the Skill will actually import.
      let cursor = path.resolve(parentDirectory);
      while (true) {
        const candidate = packagePath(path.join(cursor, 'node_modules'), name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return undefined;
    };
    const visit = (name: string, parentDirectory?: string, required = true): void => {
      const directory = resolveDependency(name, parentDirectory);
      if (!directory) {
        if (required) throw new Error(`Managed Skill dependency "${name}" is unavailable`);
        return;
      }
      const resolved = fs.realpathSync(directory);
      if (visited.has(resolved)) return;
      if (visited.size >= 512) throw new Error('Managed Skill dependency closure is unexpectedly large');
      visited.add(resolved);
      directories.push(resolved);
      const pkg = readPkg(resolved);
      for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, resolved, true);
      for (const dependency of Object.keys(pkg.optionalDependencies || {})) visit(dependency, resolved, false);
      for (const dependency of Object.keys(pkg.peerDependencies || {})) visit(dependency, resolved, false);
    };
    visit('tsx', undefined, true);
    if (skillPackage.lumi?.documentRuntime === true) {
      for (const dependency of ['exceljs', 'jszip', 'mammoth', 'pdf-parse']) visit(dependency, undefined, true);
    }
    for (const dependency of skillDependencies) visit(dependency, skillDir, true);
    return directories.sort((left, right) => left.localeCompare(right));
  }

  private resolveRuntimeTsxCli(): string | null {
    const nodeModules = resolveRuntimeNodeModulesDir();
    const candidates = [
      nodeModules ? path.join(nodeModules, 'tsx', 'dist', 'cli.mjs') : '',
      path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Uninstall a local skill */
  uninstallSkill(name: string): void {
    const skillName = normalizeSkillInstallName(name);
    const skillDir = resolveDirectSkillDirectory(skillName);
    // Remove the executable configuration first. If Windows has a locked file,
    // the package must still be unable to auto-start on the next boot.
    const config = this.getConfig();
    if (ownServerConfig(config, skillName)) {
      delete config[skillName];
      this.saveConfig(config);
    }
    if (!fs.existsSync(skillDir)) return;

    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
    } catch (error: any) {
      let quarantinePath = '';
      try {
        fs.mkdirSync(this.quarantineRoot, { recursive: true });
        quarantinePath = path.join(
          this.quarantineRoot,
          `${skillName}-failed-uninstall-${Date.now()}`,
        );
        fs.renameSync(skillDir, quarantinePath);
      } catch {
        try {
          fs.writeFileSync(
            path.join(skillDir, '.lumi-disabled'),
            `${new Date().toISOString()}\n`,
            'utf8',
          );
        } catch {}
      }
      throw new Error(
        quarantinePath
          ? `Skill "${skillName}" was disabled and quarantined after removal failed: ${error?.message || error}`
          : `Skill "${skillName}" was disabled but its locked package could not be removed or quarantined: ${error?.message || error}`,
      );
    }
  }

  /** Register a skill directory as an MCP server entry in config.json */
  private registerLocalSkill(
    name: string,
    skillDir: string,
    pkg: any,
    options: { pendingActivation?: boolean } = {},
  ): void {
    const safeName = requireSafeMCPServerName(name);
    if (resolveDirectSkillDirectory(safeName) !== path.resolve(skillDir)) {
      throw new Error('Local skill runtime path is outside the installed skills directory');
    }
    const config = this.getConfig();
    const lumi = pkg.lumi || {};
    const pendingActivation = options.pendingActivation === true
      || lumi.status === 'pending'
      || fs.existsSync(path.join(skillDir, PENDING_SKILL_MARKER));
    const installationState: MCPServerConfig['installationState'] = pendingActivation
      ? (lumi.requiresApiKey ? 'disabled' : 'pending')
      : 'active';
    const enabled = !pendingActivation && !lumi.requiresApiKey;

    // Support external MCP packages with custom run commands
    if (lumi.runCommand) {
      config[safeName] = {
        command: lumi.runCommand,
        args: lumi.runArgs || [],
        cwd: path.resolve(skillDir),
        env: lumi.requiresApiKey && lumi.apiKeyEnv
          ? { [lumi.apiKeyEnv]: `\${${lumi.apiKeyEnv}}` }
          : undefined,
        enabled,
        installationState,
        source: 'local',
        transport: 'stdio',
        autoGenerated: lumi.autoGenerated || false,
        generatedFrom: lumi.generatedFrom,
        description: pkg.description || lumi.description || safeName,
        toolCount: lumi.toolCount,
        requiresApiKey: lumi.requiresApiKey || false,
        apiKeyEnv: lumi.apiKeyEnv,
        apiKeyUrl: lumi.apiKeyUrl,
        capabilityDefault: lumi.capabilityDefault,
        toolCapabilities: lumi.toolCapabilities,
        managedSkill: lumi.managedSkill,
      };
    } else {
      const indexPath = toPortableSkillPath(path.join(skillDir, 'index.ts'));
      const managedRuntime = lumi.managedSkill?.runtime;
      // Build env map from lumi.envKeys (array of key names to pass through from stored keys)
      const env = managedRuntime?.env || managedSkillRuntimeEnvironment(pkg);
      config[safeName] = {
        command: managedRuntime?.command || 'npx',
        args: managedRuntime?.args || ['tsx', indexPath],
        cwd: managedRuntime?.cwd || path.resolve(skillDir),
        env,
        enabled,
        installationState,
        source: 'local',
        transport: 'stdio',
        autoGenerated: lumi.autoGenerated || false,
        generatedFrom: lumi.generatedFrom,
        description: pkg.description || lumi.description || safeName,
        toolCount: lumi.toolCount,
        requiresApiKey: lumi.requiresApiKey || false,
        apiKeyEnv: lumi.apiKeyEnv,
        apiKeyUrl: lumi.apiKeyUrl,
        capabilityDefault: lumi.capabilityDefault,
        toolCapabilities: lumi.toolCapabilities,
        managedSkill: lumi.managedSkill,
      };
    }

    this.saveConfig(config);
  }

  // ── MCP Server connection management ──

  private isProcessBacked(config: MCPServerConfig): boolean {
    const transportType = config.transport || (config.url
      ? (config.url.startsWith('wss://') || config.url.startsWith('ws://') ? 'ws' : 'http')
      : 'stdio');
    return transportType === 'stdio';
  }

  private isInstallationPending(name: string, config: MCPServerConfig): boolean {
    if (config.installationState === 'pending') return true;
    if (config.source !== 'local') return false;
    try {
      return fs.existsSync(path.join(resolveDirectSkillDirectory(name), PENDING_SKILL_MARKER));
    } catch {
      return true;
    }
  }

  private hasCurrentCachedToolInventory(config: MCPServerConfig): boolean {
    const current = Boolean(
      config.cachedTools?.length
      && config.cachedToolsFingerprint
      && config.cachedToolsFingerprint === mcpServerConfigFingerprint(config),
    );
    if (!current || config.source !== 'local') return current;
    if (!config.cachedToolsAttestation) return false;
    const expected = crypto
      .createHmac('sha256', getJwtSecret())
      .update(JSON.stringify({
        fingerprint: config.cachedToolsFingerprint,
        tools: stableConfigValue(config.cachedTools),
      }))
      .digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(config.cachedToolsAttestation, 'base64url'); } catch { return false; }
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

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
      config[safeName].cachedToolsAttestation = crypto
        .createHmac('sha256', getJwtSecret())
        .update(JSON.stringify({
          fingerprint: config[safeName].cachedToolsFingerprint,
          tools: stableConfigValue(config[safeName].cachedTools),
        }))
        .digest('base64url');
    } else {
      delete config[safeName].cachedToolsAttestation;
    }
    config[safeName].toolCount = tools.length;
    this.saveConfig(config);
  }

  private clearIdleTimer(name: string): void {
    const timer = this.idleTimers.get(name);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(name);
  }

  private scheduleIdleDisconnect(name: string): void {
    const config = this.getConfig()[name];
    if (!config || !this.isProcessBacked(config)) return;
    this.clearIdleTimer(name);
    const timer = setTimeout(() => {
      this.idleTimers.delete(name);
      if ((this.activeCalls.get(name) || 0) > 0) {
        this.scheduleIdleDisconnect(name);
        return;
      }
      void this.disconnectServer(name).then(() => {
        console.log(`[MCP] ${name}: released idle on-demand process`);
        this.broadcastHealth();
      });
    }, PROCESS_IDLE_TIMEOUT_MS);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    this.idleTimers.set(name, timer);
  }

  /** Withdraw a timed-out runtime immediately and actively close its transport. */
  private terminateTimedOutRuntime(
    name: string,
    explicitTransport?: ConnectedServer['transport'],
  ): void {
    const safeName = requireSafeMCPServerName(name);
    const connected = this.servers.get(safeName);
    const transport = explicitTransport || connected?.transport;
    this.connectionEpoch.set(safeName, (this.connectionEpoch.get(safeName) || 0) + 1);
    this.connectingServers.delete(safeName);
    this.clearIdleTimer(safeName);
    if (!explicitTransport || connected?.transport === explicitTransport) {
      this.servers.delete(safeName);
    }
    if (!transport) return;
    this.closingSet.add(safeName);
    void Promise.resolve(transport.close())
      .catch(() => undefined)
      .finally(() => this.closingSet.delete(safeName));
  }

  private async ensureServerConnected(name: string, config: MCPServerConfig): Promise<MCPToolDef[]> {
    if (this.servers.has(name)) return this.connectServer(name, config);
    const pending = this.connectingServers.get(name);
    const fingerprint = mcpServerConfigFingerprint(config);
    if (pending?.fingerprint === fingerprint) return pending.promise;
    const epoch = this.connectionEpoch.get(name) || 0;
    const connection = this.connectServer(name, config, epoch).finally(() => {
      if (this.connectingServers.get(name)?.promise === connection) {
        this.connectingServers.delete(name);
      }
    });
    this.connectingServers.set(name, { fingerprint, promise: connection });
    return connection;
  }

  async connectAll(): Promise<MCPToolDef[]> {
    // Scan local skills directory and register any unregistered skills
    ensureSkillsDir();
    const localEntries = fs.existsSync(SKILLS_DIR)
      ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      : [];
    const config = this.getConfig();

    for (const entry of localEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const skillDir = path.join(SKILLS_DIR, entry.name);
      if (fs.existsSync(path.join(skillDir, '.lumi-disabled'))) {
        console.warn(`[MCP] ${entry.name}: skipped disabled local skill package`);
        continue;
      }
      if (fs.existsSync(path.join(skillDir, PENDING_SKILL_MARKER))) {
        console.warn(`[MCP] ${entry.name}: skipped pending local skill package until activation commits`);
        continue;
      }
      const indexPath = path.join(skillDir, 'index.ts');
      if (!fs.existsSync(indexPath)) continue;
      const pkg = readPkg(skillDir);
      if (
        pkg?.lumi?.status === 'draft'
        || pkg?.lumi?.status === 'pending'
        || pkg?.lumi?.autoGenerated === true
      ) {
        console.warn(`[MCP] ${entry.name}: skipped unapproved generated skill draft`);
        continue;
      }
      const installedConfig = ownServerConfig(config, entry.name);
      if (!installedConfig || installedConfig.source !== 'local') {
        // A directory is package presence, not installation authority. Skill
        // Hall/runtime-state can display it as not_configured, but startup must
        // never turn copied files into an enabled executable configuration.
        console.warn(`[MCP] ${entry.name}: package present without an approved local runtime configuration; skipped`);
        continue;
      }
      ensureRuntimeNodeModulesLink(skillDir);
    }

    // Reload config after auto-registering local skills
    const finalConfig = this.getConfig();
    const allTools: MCPToolDef[] = [];

    for (const [serverName, serverConfig] of Object.entries(finalConfig)) {
      if (!serverConfig.enabled) continue;
      if (serverConfig.installationState === 'pending') {
        console.warn(`[MCP] ${serverName}: skipped pending installation until activation commits`);
        continue;
      }
      if (this.isInstallationPending(serverName, serverConfig)) {
        console.warn(`[MCP] ${serverName}: skipped local package with an uncommitted pending marker`);
        continue;
      }
      if (serverConfig.autoGenerated === true) {
        console.warn(`[MCP] ${serverName}: skipped unapproved auto-generated skill configuration`);
        continue;
      }
      if (this.isMissingRequiredApiKey(serverConfig)) {
        console.log(`[MCP] ${serverName}: skipped (missing ${serverConfig.apiKeyEnv})`);
        continue;
      }
      if (serverConfig.source === 'local') {
        try {
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

      const cacheMatchesConfig = this.hasCurrentCachedToolInventory(serverConfig);
      if (this.isProcessBacked(serverConfig) && cacheMatchesConfig) {
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
        if (this.isProcessBacked(serverConfig)) {
          await this.disconnectServer(serverName);
          console.log(`[MCP] ${serverName}: process released; tools will start on demand`);
        }
      } catch (err: any) {
        console.warn(`[MCP] Failed to connect to ${serverName}: ${err.message}`);
        if (serverConfig.source === 'local') {
          this.recordStartupFailure(serverName, err);
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
    expectedEpoch = this.connectionEpoch.get(name) || 0,
  ): Promise<MCPToolDef[]> {
    name = requireSafeMCPServerName(name);
    assertMCPPackageRunnerPolicy(config);
    if (config.source === 'local') this.assertLocalSkillRuntimeIdentity(name, config);
    // A config mutation must never reuse a client created for an older
    // command/URL/header set.
    let existing = this.servers.get(name);
    if (
      existing
      && mcpServerConfigFingerprint(existing.config) !== mcpServerConfigFingerprint(config)
    ) {
      await this.disconnectServer(name);
      existing = undefined;
      expectedEpoch = this.connectionEpoch.get(name) || 0;
    }
    // Dedup only when the live connection belongs to this exact config.
    if (existing) {
      try {
        const tools = await withMCPWallTimeout(
          existing.client.listTools(),
          PROCESS_CONNECT_TIMEOUT_MS,
          `MCP server "${name}" timed out while listing tools.`,
          () => this.terminateTimedOutRuntime(name, existing!.transport),
        );
        return mapMCPTools(name, tools.tools);
      } catch {
        // Stale connection — clean up and reconnect below
        await this.disconnectServer(name);
      }
    }

    const transportType = config.transport || (config.url ? (config.url.startsWith('wss://') || config.url.startsWith('ws://') ? 'ws' : 'http') : 'stdio');
    let transport: StdioClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;

    if (transportType === 'ws' && config.url) {
      transport = new WebSocketClientTransport(new URL(config.url));
    } else if (transportType === 'http' && config.url) {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        },
      );
    } else if (config.command) {
      const expandedCommand = expandPortablePath(config.command);
      const expandedArgs = (config.args || []).map(arg => expandPortablePath(arg));
      const tsxCli = isNpxCommand(expandedCommand) && expandedArgs[0] === 'tsx'
        ? this.resolveRuntimeTsxCli()
        : null;
      const command = tsxCli ? process.execPath : expandedCommand;
      const args = tsxCli ? [tsxCli, ...expandedArgs.slice(1)] : expandedArgs;
      // Expand ${VAR_NAME} placeholders in env values using process.env + stored keys
      const storedKeys: Record<string, string> = {};
      try {
        Object.assign(storedKeys, loadKeys());
      } catch {}
      const resolvedEnv: Record<string, string> = {};
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          resolvedEnv[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || storedKeys[name] || '');
        }
      }
      transport = new StdioClientTransport({
        command,
        args,
        cwd: config.cwd ? path.resolve(expandPortablePath(config.cwd)) : undefined,
        env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : (config.env || undefined),
      });
    } else {
      throw new Error(`MCP server "${name}": must provide "url" for http/ws transport or "command" for stdio transport`);
    }

    // Stable MCP initialize identity: changing it would alter protocol-visible
    // client attribution for already configured third-party servers.
    const client = new Client(
      { name: 'lumiOS-mcp-client', version: '2.0' },
      { capabilities: {} },
    );

    try {
      await withMCPWallTimeout(
        client.connect(transport),
        PROCESS_CONNECT_TIMEOUT_MS,
        `MCP server "${name}" timed out while connecting.`,
        () => this.terminateTimedOutRuntime(name, transport),
      );
    } catch (error) {
      if (!(error instanceof MCPRuntimeTimeoutError)) {
        try { await transport.close(); } catch {}
      }
      throw error;
    }

    if ((this.connectionEpoch.get(name) || 0) !== expectedEpoch) {
      try { await transport.close(); } catch {}
      throw new Error(`MCP server "${name}" connection was superseded by a newer configuration.`);
    }
    this.servers.set(name, { client, transport, config });

    // Initialize crash tracker
    if (!this.crashTrackers.has(name)) {
      this.crashTrackers.set(name, {
        consecutiveCrashes: 0,
        lastCrashTime: '',
        lastSuccessfulConnect: new Date().toISOString(),
        restartTimer: null,
      });
    }

    // Install crash detection on transport
    const self = this;
    transport.onclose = () => {
      // If intentionally closing, skip crash detection
      if (self.closingSet.has(name)) {
        self.closingSet.delete(name);
        return;
      }
      // A superseded/timed-out transport must never withdraw a newer live
      // connection that now owns the same server name.
      if (self.servers.get(name)?.transport !== transport) return;
      // If server still in map, this is an unexpected crash
      if (self.servers.has(name)) {
        console.log(`[MCP] CRASH DETECTED: "${name}" process exited unexpectedly`);
        self.servers.delete(name);
        const tracker = self.crashTrackers.get(name);
        if (tracker) {
          tracker.lastCrashTime = new Date().toISOString();
        }
        self.scheduleRestart(name);
        self.broadcastHealth();
      }
    };

    transport.onerror = (error: Error) => {
      console.error(`[MCP] Error in "${name}" transport:`, error.message);
    };

    // Reset crash counter on successful connect
    const tracker = self.crashTrackers.get(name)!;
    tracker.consecutiveCrashes = 0;
    tracker.lastSuccessfulConnect = new Date().toISOString();
    if (tracker.restartTimer) {
      clearTimeout(tracker.restartTimer);
      tracker.restartTimer = null;
    }

    let result: Awaited<ReturnType<Client['listTools']>>;
    try {
      result = await withMCPWallTimeout(
        client.listTools(),
        PROCESS_CONNECT_TIMEOUT_MS,
        `MCP server "${name}" timed out while listing tools.`,
        () => this.terminateTimedOutRuntime(name, transport),
      );
    } catch (error) {
      if (!(error instanceof MCPRuntimeTimeoutError)) {
        this.closingSet.add(name);
        try { await transport.close(); } catch {}
        this.servers.delete(name);
        this.closingSet.delete(name);
      }
      throw error;
    }
    return mapMCPTools(name, result.tools);
  }

  async callTool(fullName: string, args: Record<string, any>, options: MCPCallOptions = {}): Promise<string> {
    if (!fullName.startsWith('mcp_')) throw new Error(`Invalid MCP tool name: ${fullName}`);
    const config = this.getConfig();
    const candidates = Array.from(new Set([...Object.keys(config), ...this.servers.keys()]))
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
    let existingServer = this.servers.get(safeServerName);
    const serverConfig = ownServerConfig(config, safeServerName) || existingServer?.config;
    if (!serverConfig) throw new Error(`MCP server "${safeServerName}" is not configured`);
    if (serverConfig.enabled === false) throw new Error(`MCP server "${safeServerName}" is disabled`);
    assertMCPPackageRunnerPolicy(serverConfig);
    if (this.isInstallationPending(safeServerName, serverConfig)) {
      throw new Error(`MCP server "${safeServerName}" is pending activation and is not callable yet`);
    }
    if (this.isMissingRequiredApiKey(serverConfig)) {
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

    this.clearIdleTimer(safeServerName);
    if (
      existingServer
      && mcpServerConfigFingerprint(existingServer.config) !== mcpServerConfigFingerprint(serverConfig)
    ) {
      await this.disconnectServer(safeServerName);
      existingServer = undefined;
    }
    if (!this.servers.has(safeServerName)) {
      await this.ensureServerConnected(safeServerName, serverConfig);
    }
    const server = this.servers.get(safeServerName);
    if (!server) throw new Error(`MCP server "${safeServerName}" failed to connect`);
    this.activeCalls.set(safeServerName, (this.activeCalls.get(safeServerName) || 0) + 1);

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
          () => this.terminateTimedOutRuntime(safeServerName, server.transport),
        );
      } catch (error) {
        if (!(error instanceof MCPRuntimeTimeoutError) && /timed?\s*out|timeout/i.test(String((error as any)?.message || error))) {
          this.terminateTimedOutRuntime(safeServerName, server.transport);
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
      const remaining = Math.max(0, (this.activeCalls.get(safeServerName) || 1) - 1);
      if (remaining > 0) this.activeCalls.set(safeServerName, remaining);
      else this.activeCalls.delete(safeServerName);
      if (this.servers.has(safeServerName)) this.scheduleIdleDisconnect(safeServerName);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.activeCalls.clear();
    // Cancel all pending restart timers
    for (const tracker of this.crashTrackers.values()) {
      if (tracker.restartTimer) {
        clearTimeout(tracker.restartTimer);
        tracker.restartTimer = null;
      }
    }
    for (const [name, server] of this.servers) {
      this.closingSet.add(name);
      try {
        await server.transport.close();
      } catch {}
    }
    this.servers.clear();
    this.closingSet.clear();
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
    this.scheduleIdleDisconnect(name);
    return tools;
  }

  /** Disconnect a server without restarting it (used when disabling) */
  async disconnectServer(name: string): Promise<void> {
    name = requireSafeMCPServerName(name);
    this.connectionEpoch.set(name, (this.connectionEpoch.get(name) || 0) + 1);
    this.connectingServers.delete(name);
    this.clearIdleTimer(name);
    const server = this.servers.get(name);
    if (server) {
      this.closingSet.add(name);
      let closeError: unknown;
      try {
        await server.transport.close();
      } catch (error) {
        closeError = error;
      } finally {
        this.servers.delete(name);
        this.closingSet.delete(name);
      }
      if (closeError) {
        throw new Error(`MCP server "${name}" did not close cleanly: ${String((closeError as any)?.message || closeError)}`);
      }
    }
  }

  private scheduleRestart(name: string): void {
    const tracker = this.crashTrackers.get(name);
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
        const config = this.getConfig();
        const serverConfig = config[name];
        if (!serverConfig || !serverConfig.enabled || this.isInstallationPending(name, serverConfig)) {
          console.log(`[MCP] Server "${name}" is now disabled, skipping restart`);
          return;
        }

        const tools = await this.connectServer(name, serverConfig);
        console.log(`[MCP] "${name}" restarted successfully with ${tools.length} tools`);

        tracker.consecutiveCrashes = 0;
        tracker.lastSuccessfulConnect = new Date().toISOString();

        await this.onServerRecovered?.(name, tools);
        this.cacheToolDefinitions(name, tools);
        this.scheduleIdleDisconnect(name);
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

  private isMissingRequiredApiKey(config: MCPServerConfig): boolean {
    if (!config.requiresApiKey || !config.apiKeyEnv) return false;
    const fromEnv = process.env[config.apiKeyEnv]?.trim();
    if (fromEnv) return false;
    try {
      return !loadKeys()[config.apiKeyEnv]?.trim();
    } catch {
      return true;
    }
  }

  private recordStartupFailure(name: string, err: any): void {
    let tracker = this.crashTrackers.get(name);
    if (!tracker) {
      tracker = {
        consecutiveCrashes: 0,
        lastCrashTime: '',
        lastSuccessfulConnect: '',
        restartTimer: null,
      };
      this.crashTrackers.set(name, tracker);
    }
    tracker.lastCrashTime = new Date().toISOString();
    tracker.lastError = String(err?.message || err);
    this.scheduleRestart(name);
    this.broadcastHealth();
  }

  getServerHealth(): Record<string, { status: string; consecutiveCrashes: number; lastCrashTime?: string; lastSuccessfulConnect?: string; lastError?: string }> {
    const config = this.getConfig();
    const health: Record<string, any> = {};
    for (const [name] of Object.entries(config)) {
      const tracker = this.crashTrackers.get(name);
      const isRestarting = !!tracker?.restartTimer;
      const identityFailure = config[name]?.source === 'local'
        ? this.invalidManagedRuntimes.get(name)
        : undefined;
      const readyOnDemand = Boolean(
        config[name]?.enabled
        && !identityFailure
        && this.isProcessBacked(config[name])
        && this.hasCurrentCachedToolInventory(config[name]),
      );
      health[name] = {
        status: identityFailure ? 'failed'
          : isRestarting ? 'restarting'
          : this.servers.has(name) ? 'connected'
          : (tracker?.consecutiveCrashes ?? 0) >= 5 ? 'failed'
          : (tracker?.consecutiveCrashes ?? 0) > 0 ? 'crashed'
          : readyOnDemand ? 'idle'
          : 'disconnected',
        consecutiveCrashes: tracker?.consecutiveCrashes || 0,
        lastCrashTime: tracker?.lastCrashTime || undefined,
        lastSuccessfulConnect: tracker?.lastSuccessfulConnect || undefined,
        lastError: identityFailure || tracker?.lastError || undefined,
      };
    }
    return health;
  }

  private broadcastHealth(): void {
    const sockets = this.ioRef?.sockets?.sockets;
    if (!sockets || typeof sockets.values !== 'function') return;
    const payload = { servers: projectMcpServerHealth(this.getServerHealth()) };
    for (const socket of sockets.values()) {
      if (mayReceiveMcpHealthUpdate(socket?.data)) {
        socket.emit('mcp:health_update', payload);
      }
    }
  }

  getConnectedServers(): string[] {
    return Array.from(this.servers.keys());
  }

  getAvailableServers(): string[] {
    const config = this.getConfig();
    return Object.entries(config)
      .filter(([name, serverConfig]) => (
        serverConfig.enabled
        && (serverConfig.source !== 'local' || !this.invalidManagedRuntimes.has(name))
        && !this.isInstallationPending(name, serverConfig)
        && !this.isMissingRequiredApiKey(serverConfig)
      ))
      .filter(([, serverConfig]) => {
        try {
          assertMCPPackageRunnerPolicy(serverConfig);
          return true;
        } catch {
          return false;
        }
      })
      .filter(([name]) => (this.crashTrackers.get(name)?.consecutiveCrashes || 0) < 5)
      .map(([name]) => name);
  }

  getRoutableServers(): string[] {
    if (!this.discoveryInitialized) return [];
    const config = this.getConfig();
    return this.getAvailableServers().filter(name => (
      this.servers.has(name)
      || (Boolean(config[name]) && this.hasCurrentCachedToolInventory(config[name]))
    ));
  }
}

export const mcpManager = new MCPClientManager();
