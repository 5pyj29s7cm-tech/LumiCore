import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBundledSkillIdentity,
  createManagedSkillRuntimeIdentity,
  signManagedSkillIdentity,
  projectOfficialBundledIdentity,
} from '../server/marketplace/official_identity';

const roots: string[] = [];
const IDENTITY_SECRET = 'test-identity-secret-at-least-thirty-two-bytes';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-official-skill-'));
  roots.push(root);
  return root;
}

function writeSkill(directory: string, code = 'export const value = 1;\n'): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.ts'), code, 'utf8');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'lumi-skill-calculator',
    version: '1.0.0',
    description: 'Official calculator',
    lumi: { toolCount: 1 },
  }), 'utf8');
}

function installManagedCopy(source: string, installed: string) {
  fs.cpSync(source, installed, { recursive: true });
  const baseIdentity = createBundledSkillIdentity('skill-calculator', source);
  const entry = path.resolve(installed, 'index.ts');
  const identity = signManagedSkillIdentity({
    ...baseIdentity,
    runtime: createManagedSkillRuntimeIdentity({
      command: process.execPath,
      args: [entry],
      cwd: installed,
      files: [process.execPath, entry],
    }),
  }, IDENTITY_SECRET);
  const packagePath = path.join(installed, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  pkg.lumi.installedAt = '2026-09-01T00:00:00.000Z';
  pkg.lumi.installedVersion = '1.0.0';
  pkg.lumi.managedSkill = identity;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2), 'utf8');
  return identity;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('official Skill Hall identity', () => {
  it('does not treat a same-name hand-created directory as an official install', () => {
    const root = makeRoot();
    const source = path.join(root, 'bundled', 'calculator');
    const installed = path.join(root, 'lumi_skills', 'calculator');
    writeSkill(source);
    writeSkill(installed);

    expect(projectOfficialBundledIdentity({
      skillId: 'skill-calculator',
      sourceDirectory: source,
      installedDirectory: installed,
      identitySecret: IDENTITY_SECRET,
    })).toMatchObject({ identityStatus: 'conflict', installed: false });
  });

  it('requires the managed official config as well as the managed package', () => {
    const root = makeRoot();
    const source = path.join(root, 'bundled', 'calculator');
    const installed = path.join(root, 'lumi_skills', 'calculator');
    writeSkill(source);
    const identity = installManagedCopy(source, installed);

    const projection = projectOfficialBundledIdentity({
      skillId: 'skill-calculator',
      sourceDirectory: source,
      installedDirectory: installed,
      identitySecret: IDENTITY_SECRET,
      config: {
        source: 'external',
        transport: 'stdio',
        command: identity.runtime!.command,
        args: identity.runtime!.args,
        cwd: identity.runtime!.cwd,
        managedSkill: identity,
      },
    });
    expect(projection).toMatchObject({ identityStatus: 'conflict', installed: false });
    expect(projection.conflictReason).toMatch(/configuration/i);
  });

  it('verifies matching package identity, digest, and portable local config', () => {
    const root = makeRoot();
    const source = path.join(root, 'bundled', 'calculator');
    const installed = path.join(root, 'lumi_skills', 'calculator');
    writeSkill(source);
    const identity = installManagedCopy(source, installed);

    expect(projectOfficialBundledIdentity({
      skillId: 'skill-calculator',
      sourceDirectory: source,
      installedDirectory: installed,
      identitySecret: IDENTITY_SECRET,
      config: {
        source: 'local',
        transport: 'stdio',
        command: identity.runtime!.command,
        args: identity.runtime!.args,
        cwd: identity.runtime!.cwd,
        managedSkill: identity,
      },
    })).toMatchObject({ identityStatus: 'verified', installed: true });
  });

  it('rejects an official package after executable content is modified', () => {
    const root = makeRoot();
    const source = path.join(root, 'bundled', 'calculator');
    const installed = path.join(root, 'lumi_skills', 'calculator');
    writeSkill(source);
    const identity = installManagedCopy(source, installed);
    fs.writeFileSync(path.join(installed, 'index.ts'), 'export const value = 999;\n', 'utf8');

    const projection = projectOfficialBundledIdentity({
      skillId: 'skill-calculator',
      sourceDirectory: source,
      installedDirectory: installed,
      identitySecret: IDENTITY_SECRET,
      config: {
        source: 'local', transport: 'stdio', command: identity.runtime!.command,
        args: identity.runtime!.args, cwd: identity.runtime!.cwd, managedSkill: identity,
      },
    });
    expect(projection).toMatchObject({ identityStatus: 'conflict', installed: false });
    expect(projection.conflictReason).toMatch(/content|runtime file changed/i);
  });
});
