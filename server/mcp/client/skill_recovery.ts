import { reconcileMCPDeclaredCapabilities } from "./capability_metadata";
import fs from "fs";
import path from "path";
import { computeSkillContentDigest, configTargetsInstalledPackage, createBundledSkillIdentity, verifyManagedSkillIdentitySignature, type ManagedSkillIdentity } from "../../marketplace/official_identity";
import { getJwtSecret } from "../../config/local_identity";
import { SKILLS_DIR } from "../skill_paths";
import type { MCPToolDef, MCPServerConfig, SkillRepairResult } from "./contracts";
import { requireSafeMCPServerName, normalizeSkillInstallName } from "./security";
import { ownServerConfig } from "./fingerprints";
import { resolveDirectSkillDirectory } from "./package_sources";
import { readPkg, ensureSkillsDir } from "./package_files";
import { stampManagedSkillIdentity } from "./managed_identity";
import { comparePackageVersions } from "./package_paths";
import type { MCPConfigurationAccess } from './contracts';
import type { ManagedSkillRuntime } from './skill_runtime';

interface SkillRecoveryHost extends MCPConfigurationAccess {
  restartServer(name: string): Promise<MCPToolDef[]>;
  disconnectServer(name: string): Promise<void>;
}

export class MCPSkillRecovery {
  constructor(private host: SkillRecoveryHost, private runtime: ManagedSkillRuntime) {}

syncBundledCapabilityMetadata(name: string, lumi: Record<string, any>): void {
    const config = this.host.getConfig();
    const server = config[name];
    if (!server) return;
    if (!reconcileMCPDeclaredCapabilities(server, lumi)) return;
    this.host.saveConfig(config);
  }

reconcileBundledSkillRuntimes(
    bundledRoot = path.join(process.cwd(), 'server', 'skills', 'bundled'),
  ): void {
    ensureSkillsDir();
    if (!fs.existsSync(bundledRoot) || !fs.statSync(bundledRoot).isDirectory()) return;
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
      const config = this.host.getConfig();
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
          const boundIdentity = this.runtime.bindManagedSkillRuntime(installedDir, officialIdentity);
          stampManagedSkillIdentity(installedDir, boundIdentity);
          serverConfig.command = boundIdentity.runtime!.command;
          serverConfig.args = boundIdentity.runtime!.args;
          serverConfig.cwd = boundIdentity.runtime!.cwd;
          serverConfig.transport = 'stdio';
          serverConfig.managedSkill = boundIdentity;
          config[name] = serverConfig;
          this.host.saveConfig(config);
          installedIdentity = boundIdentity;
        } catch (error: any) {
          serverConfig.enabled = false;
          serverConfig.installationState = 'disabled';
          config[name] = serverConfig;
          this.host.saveConfig(config);
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
              === JSON.stringify(this.runtime.deriveManagedSkillRuntime(installedDir));
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
        this.host.saveConfig(config);
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
        this.host.saveConfig(config);
      }
      console.warn(
        `[MCP] Bundled Skill "${name}" ${installedVersion} is older than ${sourceVersion}; `
        + 'automatic non-transactional replacement is disabled. Reinstall the official Skill Hall entry explicitly.',
      );
    }
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
    const config = this.host.getConfig();
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

    const latest = this.host.getConfig();
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
        this.runtime.assertLocalSkillRuntimeIdentity(safeName, latestServer);
      } catch (error: any) {
        const reboundIdentity = this.runtime.deriveBundledHostRuntimeRebind(
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
          this.host.saveConfig(latest);
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
      const tools = await this.host.restartServer(safeName);
      return { success: true, action, directory: exists ? skillDir : undefined, toolCount: tools.length, tools };
    } catch (restartError: any) {
      if (!reboundRollback) throw restartError;
      try { await this.host.disconnectServer(safeName); } catch {}

      const rollbackFailures: string[] = [];
      try {
        stampManagedSkillIdentity(skillDir, reboundRollback.identity);
      } catch (error: any) {
        rollbackFailures.push(`package identity: ${error?.message || error}`);
      }
      try {
        const rollbackConfig = this.host.getConfig();
        rollbackConfig[safeName] = reboundRollback.serverConfig;
        this.host.saveConfig(rollbackConfig);
      } catch (error: any) {
        rollbackFailures.push(`runtime configuration: ${error?.message || error}`);
      }
      this.runtime.failures.set(safeName, reboundRollback.originalFailure);

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
}
