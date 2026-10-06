import fs from "fs";
import path from "path";
import type { ManagedSkillIdentity } from "../../marketplace/official_identity";
import { readPkg } from './package_files';
import { FORBIDDEN_MANAGED_ENV_KEYS } from './security';

export function stampManagedSkillIdentity(
    directory: string,
    identity?: ManagedSkillIdentity,
  ): void {
    const pkgPath = path.join(directory, 'package.json');
    const pkg = readPkg(directory);
    if (!pkg.lumi) pkg.lumi = {};
    if (identity) pkg.lumi.managedSkill = identity;
    else delete pkg.lumi.managedSkill;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

export function managedSkillRuntimeEnvironment(pkg: any): Record<string, string> | undefined {
    const lumi = pkg?.lumi || {};
    const keys = new Set<string>();
    if (Array.isArray(lumi.envKeys)) {
      for (const value of lumi.envKeys) keys.add(String(value || '').trim());
    }
    if (lumi.requiresApiKey && lumi.apiKeyEnv) keys.add(String(lumi.apiKeyEnv).trim());
    const env: Record<string, string> = {};
    for (const key of Array.from(keys).sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || FORBIDDEN_MANAGED_ENV_KEYS.has(key.toUpperCase())) {
        throw new Error(`Managed Skill environment key is unsafe: ${key || '(empty)'}`);
      }
      env[key] = `\${${key}}`;
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }
