import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { readPkg } from './package_files';
import { packageExists } from './package_paths';

export function installDepsSync(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec('npm install --ignore-scripts --loglevel=error --no-audit --no-fund', {
        timeout: 120000,
        cwd: dir,
      }, (error, _stdout, stderr) => {
        if (error) {
          console.warn(`[MCP] npm install failed in ${path.basename(dir)}:`, stderr.trim() || error.message);
          reject(new Error(stderr.trim() || error.message));
        } else {
          console.log(`[MCP] Dependencies installed in ${path.basename(dir)}`);
          resolve();
        }
      });
    });
  }

export function resolveRuntimeNodeModulesDir(): string | null {
    const candidates = [
      path.join(process.cwd(), 'node_modules'),
      path.join(path.dirname(process.execPath), 'node_modules'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

export function dependenciesAvailableIn(skillDir: string, nodeModulesDir: string): boolean {
    const pkg = readPkg(skillDir);
    const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies)
      : [];
    return dependencies.every(dep => packageExists(nodeModulesDir, dep));
  }

export function ensureRuntimeNodeModulesLink(skillDir: string): boolean {
    const runtimeNodeModules = resolveRuntimeNodeModulesDir();
    if (!runtimeNodeModules) return false;
    if (!dependenciesAvailableIn(skillDir, runtimeNodeModules)) return false;

    const localNodeModules = path.join(skillDir, 'node_modules');
    if (fs.existsSync(localNodeModules)) {
      return dependenciesAvailableIn(skillDir, localNodeModules);
    }

    try {
      fs.symlinkSync(runtimeNodeModules, localNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      console.log(`[MCP] Linked runtime node_modules for ${path.basename(skillDir)}`);
      return true;
    } catch (err: any) {
      console.warn(`[MCP] Could not link runtime node_modules for ${path.basename(skillDir)}: ${err?.message || err}`);
      return false;
    }
  }

export async function prepareLocalSkillDependenciesSync(dir: string): Promise<void> {
    if (ensureRuntimeNodeModulesLink(dir)) return;
    await installDepsSync(dir);
  }

export function installLockedDepsWithoutScripts(dir: string): Promise<void> {
    const lockfile = path.join(dir, 'package-lock.json');
    if (!fs.existsSync(lockfile) || !fs.statSync(lockfile).isFile()) {
      return Promise.reject(new Error('Approved generated skill is missing its reviewed package-lock.json'));
    }
    return new Promise((resolve, reject) => {
      exec('npm ci --ignore-scripts --loglevel=error --no-audit --no-fund', {
        timeout: 120000,
        maxBuffer: 512 * 1024,
        cwd: dir,
      }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve();
      });
    });
  }
