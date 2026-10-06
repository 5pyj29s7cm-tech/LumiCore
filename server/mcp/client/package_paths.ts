import fs from "fs";
import path from "path";
import os from "os";
import { SKILLS_DIR } from "../skill_paths";
import type { MCPServerConfig } from './contracts';

export function comparePackageVersions(left: string, right: string): number {
  const parts = (value: string) => String(value || '0.0.0')
    .split(/[.+-]/, 3)
    .map(part => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function expandPortablePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value.replace(/\$\{LUMI_SKILLS_DIR\}/g, SKILLS_DIR);
}

export function toPortableSkillPath(filePath: string): string {
  const relative = path.relative(SKILLS_DIR, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `\${LUMI_SKILLS_DIR}/${relative.split(path.sep).join('/')}`;
  }
  return filePath;
}

export function packagePath(baseDir: string, packageName: string): string {
  return path.join(baseDir, ...packageName.split('/'));
}

export function packageExists(nodeModulesDir: string, packageName: string): boolean {
  return fs.existsSync(path.join(packagePath(nodeModulesDir, packageName), 'package.json'));
}

export function isNpxCommand(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === 'npx' || base === 'npx.cmd' || base === 'npx.ps1';
}

/**
 * Package-manager launchers may fetch and execute mutable code while an MCP
 * runtime is enabled. Only an explicitly local npx resolution is accepted;
 * remote acquisition must use a separately approved immutable proposal.
 */
export function assertMCPPackageRunnerPolicy(config: MCPServerConfig): void {
  if (config.enabled !== true) return;
  const transport = config.transport || (config.url ? 'http' : 'stdio');
  if (transport !== 'stdio') return;
  const command = path.basename(String(config.command || '')).toLowerCase();
  const args = (config.args || []).map(value => String(value).toLowerCase());
  if (isNpxCommand(command)) {
    if (
      !args.includes('--no-install')
      || args.some(value => value === '-y' || value === '--yes' || value === '-p' || value === '--package')
    ) {
      throw new Error(
        'Online npx package execution is disabled. Use a pinned local runtime with --no-install or an immutable staged package proposal.',
      );
    }
    return;
  }
  const first = args[0] || '';
  const mutableRunner = command === 'bunx' || command === 'bunx.exe'
    || ((command === 'npm' || command === 'npm.cmd' || command === 'npm.ps1') && ['exec', 'x'].includes(first))
    || ((command === 'pnpm' || command === 'pnpm.cmd' || command === 'pnpm.ps1') && ['dlx', 'exec'].includes(first))
    || ((command === 'yarn' || command === 'yarn.cmd' || command === 'yarn.ps1') && first === 'dlx')
    || (command.startsWith('corepack') && ['npx', 'npm', 'pnpm', 'yarn', 'bunx'].includes(first));
  if (mutableRunner) {
    throw new Error(
      'Package-manager MCP execution is disabled until an immutable staged package proposal is approved.',
    );
  }
}
