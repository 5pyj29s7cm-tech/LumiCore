import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = path.join(process.cwd(), 'server');
const CORE_DIRECTORIES = [
  'agents',
  'autonomy',
  'client',
  'cognition',
  'conversation',
  'routes',
  'socket',
];
const PROCESS_ADAPTER_EXCEPTIONS = new Set([
  path.join('agents', 'external_runtime.ts'),
  path.join('socket', 'terminal.ts'),
]);
const CHILD_PROCESS_IMPORT = /(?:from\s+|import\s*\(\s*)['"](?:node:)?child_process['"]/;

function sourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

describe('adapter-only script authority', () => {
  it('keeps OS process execution out of cognition, routes, autonomy, client, and conversation business layers', () => {
    const violations: string[] = [];
    for (const directory of CORE_DIRECTORIES) {
      for (const file of sourceFiles(path.join(SERVER_ROOT, directory))) {
        const relative = path.relative(SERVER_ROOT, file);
        if (PROCESS_ADAPTER_EXCEPTIONS.has(relative)) continue;
        if (CHILD_PROCESS_IMPORT.test(fs.readFileSync(file, 'utf8'))) violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not let the composite CAD skill call registered handlers directly', () => {
    const source = fs.readFileSync(
      path.join(SERVER_ROOT, 'tools', 'definitions', 'cad_workflow_tools.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.handler\s*\(/);
    expect(source).toContain('registry.execute(name, args');
  });
});
