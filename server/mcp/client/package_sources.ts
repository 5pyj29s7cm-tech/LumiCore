import fs from "fs";
import path from "path";
import { SKILLS_DIR } from "../skill_paths";
import { requireSafeMCPServerName } from './security';

export function resolveDirectSkillDirectory(name: string): string {
  const safeName = requireSafeMCPServerName(name);
  const root = path.resolve(SKILLS_DIR);
  const resolved = path.resolve(root, safeName);
  if (path.dirname(resolved) !== root) {
    throw new Error('Invalid skill directory target');
  }
  return resolved;
}

export function resolveValidatedSkillSourceDirectory(sourceDir: string): string {
  const requested = String(sourceDir || '').trim();
  if (!path.isAbsolute(requested)) {
    throw new Error('Local skill source directory must be absolute');
  }
  if (fs.lstatSync(requested).isSymbolicLink()) {
    throw new Error('Local skill source directory cannot be a symbolic link or junction');
  }
  const resolved = fs.realpathSync(requested);
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('Local skill source directory not found');
  }
  const skillsRoot = fs.existsSync(SKILLS_DIR)
    ? fs.realpathSync(SKILLS_DIR)
    : path.resolve(SKILLS_DIR);
  const relative = path.relative(skillsRoot, resolved);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Local skill source directory must be outside the installed skills directory');
  }
  validateSkillSourceTree(resolved, resolved);
  return resolved;
}

export function validateSkillSourceTree(root: string, current: string): void {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new Error('Local skill source cannot contain symbolic links or junctions');
  }
  const resolved = fs.realpathSync(current);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Local skill source entry escapes its source directory');
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // Installed dependencies are deliberately regenerated in staging.
      if (entry.name === 'node_modules') continue;
      validateSkillSourceTree(root, path.join(current, entry.name));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error('Local skill source may contain only regular files and directories');
  }
}
