import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerGitTools } from '../server/tools/definitions/git_tools';

describe('Git tools use repository context and literal arguments', () => {
  it('handles spaces and shell punctuation literally in paths and commit text', async () => {
    const cwd = path.join(process.env.LUMI_DATA_DIR!, 'git-fixture');
    fs.mkdirSync(cwd);
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    git(['init', '-q']);
    git(['config', 'user.name', 'Synthetic Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    const hooks = path.join(cwd, 'empty-hooks');
    fs.mkdirSync(hooks);
    git(['config', 'core.hooksPath', hooks]);
    const filename = 'literal & spaces.txt';
    fs.writeFileSync(path.join(cwd, filename), 'one');
    fs.writeFileSync(path.join(cwd, 'untouched.txt'), 'two');
    const registry = new ToolRegistry();
    registerGitTools(registry);
    const call = (name: string, args: Record<string, unknown>) => registry.get(name)!.handler(args, { cwd, userId: 'git-fixture' });
    expect(JSON.parse(await call('git_stage', { files: [filename] })).status).toBe('staged');
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe(filename);
    const message = 'Literal "quotes" & $(echo no) `no` %PATH%';
    const body = 'Line one\nLine two & echo no';
    expect(JSON.parse(await call('git_commit', { message, body })).revision).toMatch(/^[a-f0-9]{40}$/);
    expect(git(['log', '-1', '--format=%B']).trim()).toBe(`${message}\n\n${body}`);
    fs.writeFileSync(path.join(cwd, filename), 'changed');
    expect(await call('git_diff', { file: filename })).toContain('+changed');
    // Normal chat contexts do not provide cwd. The advertised argument must
    // work through the executor, without relying on a test-only context field.
    expect(await registry.execute('git_status', { repositoryPath: cwd }, { userId: 'git-fixture' })).toContain('untouched.txt');
    expect(await registry.execute('git_diff', { repositoryPath: cwd, file: filename }, { userId: 'git-fixture' })).toContain('+changed');
    await expect(registry.get('git_status')!.handler({ repositoryPath: 'relative' }, { cwd })).rejects.toThrow(/working directory/);
    await expect(registry.get('git_status')!.handler({}, {})).rejects.toThrow(/working directory/);
  });
});
