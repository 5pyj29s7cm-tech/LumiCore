import './helpers';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';

describe('home-relative local file paths', () => {
  it('resolves both home separators and keeps traversal outside allowed roots blocked', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-home-path-'));
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    try {
      fs.mkdirSync(path.join(home, 'Desktop'));
      fs.writeFileSync(path.join(home, 'Desktop', 'sample.txt'), 'verified local content');
      for (const target of ['~/Desktop/sample.txt', '~\\Desktop\\sample.txt']) {
        expect(await registry.get('read_file')!.handler({ path: target }, { cwd: process.cwd(), localExecution: true } as any)).toBe('verified local content');
      }
      await expect(registry.get('read_file')!.handler({ path: path.parse(home).root + 'outside-lumi-roots/secret.txt' }, { localExecution: true } as any)).rejects.toThrow('Access denied');
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
