import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProfileSkills } from '../server/mcp/skill_profile_migration';
import { createGeneratedSkillIdentity, createManagedSkillRuntimeIdentity, signManagedSkillIdentity } from '../server/marketplace/official_identity';
import type { MCPServerConfig } from '../server/mcp/client';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-profile-skill-')); roots.push(root);
  const legacyRoot = path.join(root, 'shared');
  const skillsRoot = path.join(root, 'main', 'skills');
  const source = path.join(legacyRoot, 'calculator');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'index.ts'), 'export const calculate = (value: number) => value * 2;');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'calculator', version: '1.0.0', lumi: {} }));
  const command = path.join(root, 'trusted-node'); fs.writeFileSync(command, 'synthetic runtime');
  const secret = 'synthetic-profile-signing-secret';
  const bindRuntime = (directory: string, identity: any) => signManagedSkillIdentity({ ...identity,
    runtime: createManagedSkillRuntimeIdentity({ command, args: [path.join(directory, 'index.ts')], cwd: directory,
      files: [command, path.join(directory, 'index.ts')] }) }, secret);
  const identity = bindRuntime(source, createGeneratedSkillIdentity('calculator', source, 'reviewed-source-hash'));
  let servers: Record<string, MCPServerConfig> = { calculator: { enabled: true, source: 'local', installationState: 'active',
    ...identity.runtime, managedSkill: identity } };
  const run = (overrides: any = {}) => migrateProfileSkills({ legacyRoot, skillsRoot, servers, secret, bindRuntime,
    saveServers: next => { servers = structuredClone(next); }, ...overrides });
  return { root, source, skillsRoot, legacyRoot, identity, bindRuntime, run, get servers() { return servers; } };
}
describe('per-profile executable Skill migration', () => {
  it('isolates unchanged approved code for two profiles without moving shared files or sharing dependency links', () => {
    const f = fixture();
    const foreignDeps = path.join(f.root, 'variant-node_modules'); fs.mkdirSync(foreignDeps);
    fs.symlinkSync(foreignDeps, path.join(f.source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.readFileSync(path.join(f.source, 'index.ts'), 'utf8');
    expect(f.run().migrated).toEqual(['calculator']);
    const secondRoot = path.join(f.root, 'second', 'skills');
    const original = { ...f.servers.calculator, ...f.identity.runtime, managedSkill: f.identity };
    expect(f.run({ skillsRoot: secondRoot, servers: { calculator: original }, saveServers: () => {} }).migrated).toEqual(['calculator']);
    expect(f.servers.calculator.cwd).toBe(path.join(f.skillsRoot, 'calculator'));
    expect(fs.existsSync(path.join(f.skillsRoot, 'calculator', 'node_modules'))).toBe(false);
    fs.writeFileSync(path.join(secondRoot, 'calculator', 'index.ts'), 'a different variant update');
    expect(fs.readFileSync(path.join(f.skillsRoot, 'calculator', 'index.ts'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(f.source, 'index.ts'), 'utf8')).toBe(before);
    expect(f.run().migrated).toEqual([]);
  });
  it.each(['unsigned', 'changed-content', 'changed-command', 'foreign-signature'])('does not adopt %s packages', reason => {
    const f = fixture();
    if (reason === 'unsigned') delete f.servers.calculator.managedSkill;
    if (reason === 'changed-content') fs.appendFileSync(path.join(f.source, 'index.ts'), ' changed');
    if (reason === 'changed-command') f.servers.calculator.command = 'unapproved';
    if (reason === 'foreign-signature') f.servers.calculator.managedSkill = signManagedSkillIdentity(f.identity, 'other-profile');
    expect(f.run().migrated).toEqual([]);
    expect(fs.existsSync(path.join(f.skillsRoot, 'calculator'))).toBe(false);
  });
  it('resumes after a failed config commit, while leaving the registration unmodified until persistence succeeds', () => {
    const f = fixture();
    expect(f.run({ saveServers: () => { throw new Error('disk full'); } }).skipped[0].reason).toBe('disk full');
    expect(f.servers.calculator.cwd).toBe(f.source);
    expect(f.run().migrated).toEqual(['calculator']);
    expect(f.servers.calculator.cwd).toBe(path.join(f.skillsRoot, 'calculator'));
  });
  it('does not overwrite an unrelated destination', () => {
    const f = fixture(); const destination = path.join(f.skillsRoot, 'calculator');
    fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'keep.txt'), 'user data');
    expect(f.run().skipped[0].reason).toMatch(/different installation/);
    expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('user data');
  });
});
