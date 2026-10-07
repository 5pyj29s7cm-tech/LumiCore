import fs from "fs";
import path from "path";
import { computeSkillContentDigest, createBundledSkillIdentity, createManagedSkillRuntimeIdentity, signManagedSkillIdentity, verifyManagedSkillIdentitySignature, verifyManagedSkillRuntimeIdentity, type ManagedSkillIdentity } from "../../marketplace/official_identity";
import { getJwtSecret } from "../../config/local_identity";
import type { MCPServerConfig } from "./contracts";
import { requireSafeMCPServerName } from "./security";
import { ownServerConfig } from "./fingerprints";
import { resolveDirectSkillDirectory } from "./package_sources";
import { readPkg } from "./package_files";
import { resolveRuntimeNodeModulesDir } from "./dependencies";
import { managedSkillRuntimeEnvironment } from "./managed_identity";
import { packagePath } from "./package_paths";
import type { MCPConfigurationAccess } from './contracts';

export class ManagedSkillRuntime {
  readonly failures = new Map<string, string>();
  constructor(private host: MCPConfigurationAccess) {}

deriveManagedSkillRuntime(directory: string) {
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

bindManagedSkillRuntime(
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
  deriveBundledHostRuntimeRebind(
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
      const config = suppliedConfig || ownServerConfig(this.host.getConfig(), safeName);
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
      this.failures.delete(safeName);
      return packageIdentity;
    } catch (error: any) {
      this.failures.set(safeName, String(error?.message || error));
      throw error;
    }
  }

collectManagedRuntimeDependencyDirectories(skillDir: string): string[] {
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

resolveRuntimeTsxCli(): string | null {
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
}
