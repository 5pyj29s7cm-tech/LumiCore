import { reconcileMCPDeclaredCapabilities } from "./capability_metadata";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataPath } from "../../config/data_path";
import { runRuntimeCapabilityCleanup } from "../runtime_cleanup";
import { SKILLS_DIR } from "../skill_paths";
import type { MCPServerConfig, MCPConfigFile } from "./contracts";
import { DEFAULT_RUNTIME_CONFIG, FACTORY_CONFIG, DEFAULT_CONFIG_FILE } from "./defaults";

export class MCPConfigStore {
private configPath: string;
private factoryConfigPath: string;
private cleanupSkillsDir: string;
readonly quarantineRoot: string;
private runtimeCleanupApplied = false;
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
getConfig(): Record<string, MCPServerConfig> {
    return this.readConfigFile().mcpServers || {};
  }

saveConfig(servers: Record<string, MCPServerConfig>): void {
    const config = this.readConfigFile();
    config.mcpServers = servers;
    this.saveConfigFile(config);
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
      if (!reconcileMCPDeclaredCapabilities(runtimeServer, factoryServer)) continue;
      updated.push(name);
    }
    const migrations = runtime.migrations || {};
    const markerChanged = Number(migrations.mcpCapabilityDeclarationsV1 || 0) < 1;
    if (markerChanged) runtime.migrations = { ...migrations, mcpCapabilityDeclarationsV1: 1 };
    if (updated.length > 0 || markerChanged) this.saveConfigFile(runtime);
    return updated.sort((left, right) => left.localeCompare(right));
  }

readConfigFile(): MCPConfigFile {
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

saveConfigFile(config: MCPConfigFile): void {
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

ensureRuntimeConfig(): void {
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
}
