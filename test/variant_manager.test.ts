import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildVariantMetadata,
  buildVariantPaths,
  normalizeVariantId,
  parseRepositoryUrl,
} from '../scripts/variant-manager.mjs';

const root = process.cwd();
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const managerPath = path.join(root, 'scripts', 'variant-manager.mjs');

function execute(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n'));
  }
  return String(result.stdout || '').trim();
}

function git(cwd: string, ...args: string[]) {
  return execute('git', args, cwd);
}

describe('Lumi variant manager', () => {
  it('normalizes safe variant identifiers and rejects reserved identifiers', () => {
    expect(normalizeVariantId(' Lumi_Legal-Client ')).toBe('legal-client');
    expect(() => normalizeVariantId('main')).toThrow(/reserved/i);
    expect(() => normalizeVariantId('../legal')).toThrow(/only lowercase/i);
  });

  it('parses supported child repository addresses without credentials', () => {
    expect(parseRepositoryUrl('https://github.com/lumi/lumi-legal-client.git')).toEqual({
      repository: 'https://github.com/lumi/lumi-legal-client.git',
      github: { owner: 'lumi', repo: 'lumi-legal-client' },
    });
    expect(parseRepositoryUrl('git@github.com:lumi/lumi-cad-client.git').github).toEqual({
      owner: 'lumi',
      repo: 'lumi-cad-client',
    });
    expect(() => parseRepositoryUrl('https://token@github.com/lumi/private.git')).toThrow();
  });

  it('creates a separate worktree, branch, remote, and workspace identity', () => {
    const paths = buildVariantPaths(path.join('D:', 'lumiOS'), 'cad-client');
    expect(paths.id).toBe('cad-client');
    expect(paths.branch).toBe('variant/cad-client');
    expect(paths.remote).toBe('cad-client');
    expect(path.basename(paths.worktree)).toBe('lumi-cad-client');
    expect(path.basename(paths.workspace)).toBe('lumi-cad-client.code-workspace');
  });

  it('records the main repository as upstream and the child repository separately', () => {
    const metadata = buildVariantMetadata({
      id: 'legal-client',
      displayName: 'Lumi 律师客户定制版',
      productLine: 'legal',
      upstreamRepository: 'https://github.com/lumi/lumi-core.git',
      baselineCommit: '1234567890abcdef',
      repository: 'https://github.com/lumi/lumi-legal-client.git',
    });

    expect(metadata.upstream).toMatchObject({
      repository: 'https://github.com/lumi/lumi-core.git',
      branch: 'main',
      baselineCommit: '1234567890abcdef',
      lastSyncedCommit: '1234567890abcdef',
    });
    expect(metadata.repository).toBe('https://github.com/lumi/lumi-legal-client.git');
  });

  it('exposes the three production commands and keeps destructive safeguards', () => {
    const packageJson = JSON.parse(source('package.json'));
    expect(packageJson.scripts).toMatchObject({
      'variant:new': 'node scripts/variant-manager.mjs new',
      'variant:sync': 'node scripts/variant-manager.mjs sync',
      'variant:promote': 'node scripts/variant-manager.mjs promote',
    });

    const manager = source('scripts/variant-manager.mjs');
    expect(manager).toContain("assertClean(coreRoot, 'Lumi main worktree')");
    expect(manager).toContain("repository.private !== true");
    expect(manager).toContain("body: JSON.stringify({ enabled: false })");
    expect(manager).toContain("['worktree', 'add', '-b'");
    expect(manager).toContain("['merge', '--no-edit', 'main']");
    expect(manager).toContain("['cherry-pick', ...resolved]");
    expect(manager).toContain('must be split into linear generic commits');
  });

  it('documents creation, synchronization, promotion, and failure recovery', () => {
    const guide = source('VARIANT_WORKFLOW.md');
    expect(guide).toContain('npm run variant:new');
    expect(guide).toContain('npm run variant:sync');
    expect(guide).toContain('npm run variant:promote');
    expect(guide).toContain('失败恢复');
    expect(guide).toContain('不会自动删除');
  });

  it('runs the complete create, sync, and promote flow against isolated repositories', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-variant-test-'));
    const mainRepository = path.join(temporaryRoot, 'lumi-core');
    const mainOrigin = path.join(temporaryRoot, 'lumi-core-origin.git');
    const childOrigin = path.join(temporaryRoot, 'lumi-test-client.git');
    const childWorktree = path.join(temporaryRoot, 'lumi-core-variants', 'lumi-test-client');

    try {
      fs.mkdirSync(mainRepository);
      execute('git', ['init', '--bare', mainOrigin]);
      execute('git', ['init', '--bare', childOrigin]);
      git(mainRepository, 'init', '-b', 'main');
      git(mainRepository, 'config', 'user.name', 'Lumi Variant Test');
      git(mainRepository, 'config', 'user.email', 'variant-test@localhost');
      fs.writeFileSync(path.join(mainRepository, 'core.txt'), 'baseline\n', 'utf8');
      fs.writeFileSync(path.join(mainRepository, 'package.json'), '{"private":true}\n', 'utf8');
      git(mainRepository, 'add', '.');
      git(mainRepository, 'commit', '-m', 'initial core');
      git(mainRepository, 'remote', 'add', 'origin', mainOrigin);
      git(mainRepository, 'push', '-u', 'origin', 'main');

      execute(process.execPath, [
        managerPath,
        'new',
        '--root', mainRepository,
        '--name', 'Lumi Test Client',
        '--id', 'test-client',
        '--repo', childOrigin,
        '--skip-install',
        '--skip-open',
      ]);

      const createdMetadata = JSON.parse(fs.readFileSync(path.join(childWorktree, '.lumi', 'variant.json'), 'utf8'));
      expect(createdMetadata.upstream.repository).toBe(mainOrigin);
      expect(createdMetadata.repository).toBe(childOrigin);
      expect(git(mainRepository, 'remote', 'get-url', 'test-client')).toBe(childOrigin);
      expect(git(childWorktree, 'branch', '--show-current')).toBe('variant/test-client');

      fs.appendFileSync(path.join(mainRepository, 'core.txt'), 'upstream change\n', 'utf8');
      git(mainRepository, 'add', 'core.txt');
      git(mainRepository, 'commit', '-m', 'update core');
      const updatedMainCommit = git(mainRepository, 'rev-parse', 'HEAD');
      git(mainRepository, 'push', 'origin', 'main');

      execute(process.execPath, [managerPath, 'sync', '--root', mainRepository, '--id', 'test-client', '--skip-verify']);
      const syncedMetadata = JSON.parse(fs.readFileSync(path.join(childWorktree, '.lumi', 'variant.json'), 'utf8'));
      expect(syncedMetadata.upstream.lastSyncedCommit).toBe(updatedMainCommit);
      expect(fs.readFileSync(path.join(childWorktree, 'core.txt'), 'utf8')).toContain('upstream change');

      fs.writeFileSync(path.join(childWorktree, 'generic.txt'), 'reusable capability\n', 'utf8');
      git(childWorktree, 'add', 'generic.txt');
      git(childWorktree, 'commit', '-m', 'feat: reusable capability');
      const genericCommit = git(childWorktree, 'rev-parse', 'HEAD');
      git(childWorktree, 'push', 'test-client', 'HEAD:main');

      execute(process.execPath, [
        managerPath,
        'promote',
        '--root', mainRepository,
        '--id', 'test-client',
        '--commits', genericCommit,
        '--skip-verify',
      ]);

      const integrationBranch = `integrate/test-client-${genericCommit.slice(0, 8)}`;
      expect(git(mainRepository, 'branch', '--show-current')).toBe('main');
      expect(git(mainRepository, 'show', `${integrationBranch}:generic.txt`)).toBe('reusable capability');
      expect(git(mainRepository, 'ls-remote', '--heads', 'origin', integrationBranch)).toContain(`refs/heads/${integrationBranch}`);
    } finally {
      const resolvedTemporaryRoot = path.resolve(temporaryRoot);
      if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir())) && path.basename(resolvedTemporaryRoot).startsWith('lumi-variant-test-')) {
        fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
