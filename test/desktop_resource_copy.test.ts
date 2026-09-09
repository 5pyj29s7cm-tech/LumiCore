import './helpers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyDir } from '../scripts/prepare-desktop-resources.mjs';

describe('desktop runtime dependency copies', () => {
  it('materializes package junctions and permits nested dependencies without modifying the shared source', async () => {
    const fixture = path.join(process.env.LUMI_DATA_DIR!, 'desktop-copy-junction');
    const shared = path.join(fixture, 'shared-package');
    const source = path.join(fixture, 'node_modules', 'package-a');
    const output = path.join(fixture, 'desktop-resources');
    const target = path.join(output, 'node_modules', 'package-a');
    const dependency = path.join(shared, 'node_modules', 'nested-package');
    await fs.mkdir(dependency, { recursive: true });
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(path.join(shared, 'index.js'), 'export const marker = "shared";');
    await fs.writeFile(path.join(dependency, 'index.js'), 'export const dependency = true;');
    await fs.symlink(shared, source, process.platform === 'win32' ? 'junction' : 'dir');
    await copyDir(source, target);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
    // This was the failing shape: an explicitly resolved dependency is copied
    // again into a parent package that was previously emitted as a junction.
    await copyDir(dependency, path.join(target, 'node_modules', 'nested-package'));
    expect(await fs.readFile(path.join(target, 'node_modules', 'nested-package', 'index.js'), 'utf8')).toContain('dependency = true');
    await fs.writeFile(path.join(target, 'index.js'), 'independent output');
    expect(await fs.readFile(path.join(shared, 'index.js'), 'utf8')).toContain('"shared"');
    // Cleanup of a failed old output also leaves its linked source untouched.
    await fs.symlink(shared, path.join(output, 'old-junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.rm(output, { recursive: true, force: true });
    expect(await fs.readFile(path.join(shared, 'index.js'), 'utf8')).toContain('"shared"');
  });

  it('rejects a destination junction instead of writing through it', async () => {
    const fixture = path.join(process.env.LUMI_DATA_DIR!, 'desktop-copy-target-link');
    const source = path.join(fixture, 'source');
    const protectedDir = path.join(fixture, 'protected');
    const output = path.join(fixture, 'output');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(protectedDir, { recursive: true });
    await fs.writeFile(path.join(source, 'new.txt'), 'must not reach protected directory');
    await fs.writeFile(path.join(protectedDir, 'sentinel.txt'), 'unchanged');
    await fs.symlink(protectedDir, output, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(copyDir(source, path.join(output, 'nested'))).rejects.toThrow(/destination link/);
    expect(await fs.readdir(protectedDir)).toEqual(['sentinel.txt']);
  });

  it('rejects a directory link cycle before recursively copying it', async () => {
    const fixture = path.join(process.env.LUMI_DATA_DIR!, 'desktop-copy-cycle');
    const source = path.join(fixture, 'source');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'sentinel.txt'), 'preserved');
    await fs.symlink(source, path.join(source, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(copyDir(source, path.join(fixture, 'output'))).rejects.toThrow(/Cyclic directory link/);
    expect(await fs.readFile(path.join(source, 'sentinel.txt'), 'utf8')).toBe('preserved');
  });
});
