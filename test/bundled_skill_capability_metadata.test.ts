import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLED_ROOT = path.join(process.cwd(), 'server', 'skills', 'bundled');
const VALID_OPERATIONS = new Set(['observe', 'test', 'mutate', 'create', 'communicate']);
const VALID_RISKS = new Set(['none', 'low', 'medium', 'high', 'critical']);
const VALID_EFFECTS = new Set([
  'local_read',
  'local_write',
  'local_state_change',
  'desktop_control',
  'network_read',
  'external_state_change',
  'external_communication',
  'credential_access',
  'process_execution',
  'installation',
  'none',
]);
const STATE_CHANGING_EFFECTS = new Set([
  'local_write',
  'local_state_change',
  'desktop_control',
  'external_state_change',
  'external_communication',
  'process_execution',
  'installation',
]);

function readTypeScriptTree(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? '' : readTypeScriptTree(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name)
      ? fs.readFileSync(target, 'utf8')
      : '';
  }).join('\n');
}

function declarations(pkg: any): any[] {
  return [
    pkg?.lumi?.capabilityDefault,
    ...Object.values(pkg?.lumi?.toolCapabilities || {}),
  ].filter(Boolean);
}

function expectValidDeclaration(skillName: string, declaration: any): void {
  expect(VALID_OPERATIONS.has(declaration.operation), `${skillName}: invalid operation`).toBe(true);
  expect(VALID_RISKS.has(declaration.risk), `${skillName}: invalid risk`).toBe(true);
  expect(Array.isArray(declaration.sideEffects), `${skillName}: sideEffects missing`).toBe(true);
  for (const sideEffect of declaration.sideEffects) {
    expect(VALID_EFFECTS.has(sideEffect?.type), `${skillName}: invalid side effect`).toBe(true);
    expect(String(sideEffect?.scope || '').trim(), `${skillName}: side-effect scope missing`).not.toBe('');
    expect(typeof sideEffect?.reversible, `${skillName}: reversible flag missing`).toBe('boolean');
  }
  expect(declaration.verification?.required, `${skillName}: verification must be required`).toBe(true);
  expect(String(declaration.verification?.strategy || ''), `${skillName}: verification strategy missing`).not.toBe('');
  expect(Array.isArray(declaration.verification?.requiredFields), `${skillName}: requiredFields missing`).toBe(true);
  expect(Array.isArray(declaration.verification?.successSignals), `${skillName}: successSignals missing`).toBe(true);
  expect(Array.isArray(declaration.verification?.limitations), `${skillName}: limitations missing`).toBe(true);
}

describe('Bundled Skill capability metadata', () => {
  it('requires every bundled Skill with IO, credentials, process execution, or an external runtime to declare its internal effects', () => {
    const checked: string[] = [];
    for (const entry of fs.readdirSync(BUNDLED_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = path.join(BUNDLED_ROOT, entry.name, 'package.json');
      if (!fs.existsSync(packagePath)) continue;
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const source = readTypeScriptTree(path.join(BUNDLED_ROOT, entry.name));
      const ownsIO = /\bfetch\s*\(|\bprocess\.env\b|\bfs\.(?:read|write|mkdir|rm|unlink|open|rename)|(?:node:)?child_process|\bspawn\s*\(|\bsharp\s*\(/.test(source);
      const externalRuntime = Boolean(pkg?.lumi?.runCommand);
      if (!ownsIO && !externalRuntime) continue;
      const declared = declarations(pkg);
      expect(declared.length, `${entry.name}: IO/runtime capability metadata missing`).toBeGreaterThan(0);
      for (const item of declared) expectValidDeclaration(entry.name, item);
      checked.push(entry.name);
    }
    expect(checked).toEqual(expect.arrayContaining([
      'cad-drafting',
      'code-sandbox',
      'legal-casework',
      'nanobanana',
      'notes',
      'pdftools',
      'stockbot',
      'video-editor',
    ]));
  });

  it('declares state-changing effects for every bundled Skill whose implementation mutates state', () => {
    const statefulSkills = [
      'cad-drafting',
      'code-sandbox',
      'desktop-automation',
      'legal-casework',
      'minimax',
      'nanobanana',
      'notes',
      'pdftools',
      'pixelle',
      'shorturl',
      'stockbot',
      'timer',
      'video-editor',
    ];
    for (const skillName of statefulSkills) {
      const pkg = JSON.parse(fs.readFileSync(
        path.join(BUNDLED_ROOT, skillName, 'package.json'),
        'utf8',
      ));
      const effects = declarations(pkg).flatMap(item => item.sideEffects || []);
      expect(
        effects.some(effect => STATE_CHANGING_EFFECTS.has(effect.type)),
        `${skillName}: no declared state-changing effect`,
      ).toBe(true);
    }
  });

  it('keeps per-tool overrides attached to real local MCP tool names', () => {
    for (const entry of fs.readdirSync(BUNDLED_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = path.join(BUNDLED_ROOT, entry.name, 'package.json');
      if (!fs.existsSync(packagePath)) continue;
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const overrides = Object.keys(pkg?.lumi?.toolCapabilities || {});
      if (overrides.length === 0) continue;
      const source = readTypeScriptTree(path.join(BUNDLED_ROOT, entry.name));
      for (const toolName of overrides) {
        expect(
          source.includes(`registerTool('${toolName}'`) || source.includes(`registerTool("${toolName}"`),
          `${entry.name}: capability override references unknown tool ${toolName}`,
        ).toBe(true);
      }
    }
  });
});
