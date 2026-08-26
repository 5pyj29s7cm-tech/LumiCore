import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildVariantMetadata,
  buildVariantPaths,
  discoverVariants,
  normalizeVariantId,
  normalizeVariantMetadata,
  parseRepositoryUrl,
} from '../scripts/variant-manager.mjs';

const root = process.cwd();
const source = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const managerPath = path.join(root, 'scripts', 'variant-manager.mjs');

function executeResult(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function execute(command: string, args: string[], cwd?: string) {
  const result = executeResult(command, args, cwd);
  if (result.status !== 0) throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n'));
  return String(result.stdout || '').trim();
}

function git(cwd: string, ...args: string[]) {
  return execute('git', args, cwd);
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseLastJson(output: string) {
  const start = output.lastIndexOf('\n{');
  return JSON.parse(start >= 0 ? output.slice(start + 1) : output);
}

describe('Lumi variant release train', () => {
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
    const paths = buildVariantPaths(path.join('D:', 'LumiCore'), 'cad-client');
    expect(paths.id).toBe('cad-client');
    expect(paths.branch).toBe('variant/cad-client');
    expect(paths.remote).toBe('cad-client');
    expect(path.basename(paths.worktree)).toBe('lumi-cad-client');
    expect(path.basename(paths.workspace)).toBe('lumi-cad-client.code-workspace');
  });

  it('records explicit core, local delivery, remote delivery, default branch, and gates', () => {
    const metadata = buildVariantMetadata({
      id: 'legal-client',
      displayName: 'Lumi 律师客户定制版',
      productLine: 'legal',
      upstreamRepository: 'https://github.com/lumi/lumi-core.git',
      baselineCommit: '1234567890abcdef',
      repository: 'https://github.com/lumi/lumi-legal-client.git',
      localBranch: 'feature/legal-delivery',
      remoteBranch: 'release/legal',
    });

    expect(metadata.schemaVersion).toBe(2);
    expect(metadata.upstream).toMatchObject({
      repository: 'https://github.com/lumi/lumi-core.git',
      branch: 'main',
      baselineCommit: '1234567890abcdef',
      lastSyncedCommit: '1234567890abcdef',
    });
    expect(metadata.delivery).toEqual({
      localBranch: 'feature/legal-delivery',
      remoteBranch: 'release/legal',
      defaultBranch: 'main',
    });
    expect(metadata.verification.requiredGates).toEqual(['lint', 'test', 'build']);
  });

  it('migrates schema v1 using the real worktree and tracking branches', () => {
    const migrated = normalizeVariantMetadata({
      schemaVersion: 1,
      variantId: 'ecommerce-client',
      displayName: 'Lumi 电商定制版',
      productLine: 'ecommerce',
      upstream: {
        repository: 'https://github.com/lumi/lumi-core.git',
        branch: 'main',
        baselineCommit: '1234567890abcdef',
        lastSyncedCommit: '1234567890abcdef',
      },
      repository: 'https://github.com/lumi/lumi-ecommerce-client.git',
    }, {
      currentBranch: 'feature/ecommerce-workbench-mvp',
      trackingBranch: 'feature/ecommerce-workbench-mvp',
    });

    expect(migrated.needsMigration).toBe(true);
    expect(migrated.metadata.delivery).toMatchObject({
      localBranch: 'feature/ecommerce-workbench-mvp',
      remoteBranch: 'feature/ecommerce-workbench-mvp',
      defaultBranch: 'main',
    });
  });

  it('exposes status, dry-run/all sync, gated default publication, and destructive safeguards', () => {
    const packageJson = JSON.parse(source('package.json'));
    expect(packageJson.scripts).toMatchObject({
      'variant:new': 'node scripts/variant-manager.mjs new',
      'variant:status': 'node scripts/variant-manager.mjs status',
      'variant:check': 'node scripts/variant-manager.mjs status --all --fetch --strict',
      'variant:sync': 'node scripts/variant-manager.mjs sync',
      'variant:publish-default': 'node scripts/variant-manager.mjs publish-default',
      'variant:promote': 'node scripts/variant-manager.mjs promote',
    });

    const manager = source('scripts/variant-manager.mjs');
    expect(manager).toContain("assertClean(coreRoot, 'Lumi main worktree')");
    expect(manager).toContain("repository.private !== true");
    expect(manager).toContain("body: JSON.stringify({ enabled: false })");
    expect(manager).toContain("['worktree', 'add', '-b'");
    expect(manager).toContain("['merge', '--no-edit'");
    expect(manager).toContain("['cherry-pick', ...resolved]");
    const mergePreviewSource = manager.slice(
      manager.indexOf('function mergePreview('),
      manager.indexOf('function worktreeSnapshot('),
    );
    expect(mergePreviewSource).toContain("'merge-tree',");
    expect(mergePreviewSource).toContain("'--write-tree',");
    expect(mergePreviewSource).not.toContain("'--quiet',");
    expect(manager).toContain('default_branch_not_fast_forwardable');
    expect(manager).toContain('remote_state_unknown');
    expect(manager).not.toContain('--force');
  });

  it('documents discovery, status, synchronization, default alignment, and failure recovery', () => {
    const guide = source('VARIANT_WORKFLOW.md');
    expect(guide).toContain('npm run variant:status');
    expect(guide).toContain('npm run variant:check');
    expect(guide).toContain('npm run variant:sync -- --all --dry-run');
    expect(guide).toContain('npm run variant:publish-default');
    expect(guide).toContain('lint、全量测试、build');
    expect(guide).toContain('失败恢复');
    expect(guide).toContain('不会自动删除');
  });

  it('discovers metadata on a nonstandard branch and runs the complete gated release flow', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-variant-test-'));
    const mainRepository = path.join(temporaryRoot, 'lumi-core');
    const mainOrigin = path.join(temporaryRoot, 'lumi-core-origin.git');
    const childOrigin = path.join(temporaryRoot, 'lumi-test-client.git');
    const childWorktree = path.join(temporaryRoot, 'lumi-core-variants', 'lumi-test-client');

    try {
      fs.mkdirSync(mainRepository);
      execute('git', ['init', '--bare', '--initial-branch=main', mainOrigin]);
      execute('git', ['init', '--bare', '--initial-branch=main', childOrigin]);
      git(mainRepository, 'init', '-b', 'main');
      git(mainRepository, 'config', 'user.name', 'Lumi Variant Test');
      git(mainRepository, 'config', 'user.email', 'variant-test@localhost');
      fs.writeFileSync(path.join(mainRepository, 'core.txt'), 'baseline\n', 'utf8');
      fs.writeFileSync(path.join(mainRepository, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
      writeJson(path.join(mainRepository, 'package.json'), {
        name: 'variant-test',
        version: '1.0.0',
        private: true,
        scripts: {
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)" --',
          build: 'node -e "process.exit(0)"',
        },
      });
      writeJson(path.join(mainRepository, 'package-lock.json'), {
        name: 'variant-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'variant-test', version: '1.0.0' } },
      });
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
        '--skip-open',
      ]);

      const createdMetadataPath = path.join(childWorktree, '.lumi', 'variant.json');
      const createdMetadata = JSON.parse(fs.readFileSync(createdMetadataPath, 'utf8'));
      expect(createdMetadata.schemaVersion).toBe(2);
      expect(createdMetadata.delivery).toEqual({
        localBranch: 'variant/test-client',
        remoteBranch: 'main',
        defaultBranch: 'main',
      });

      git(childWorktree, 'switch', '-c', 'feature/real-delivery');
      const featureMetadata = JSON.parse(fs.readFileSync(createdMetadataPath, 'utf8'));
      featureMetadata.delivery.localBranch = 'feature/real-delivery';
      featureMetadata.delivery.remoteBranch = 'feature/real-delivery';
      writeJson(createdMetadataPath, featureMetadata);
      fs.writeFileSync(path.join(childWorktree, 'industry.txt'), 'real capability\n', 'utf8');
      git(childWorktree, 'add', '.lumi/variant.json', 'industry.txt');
      git(childWorktree, 'commit', '-m', 'feat: real delivery branch');
      git(childWorktree, 'push', '-u', 'test-client', 'HEAD:feature/real-delivery');

      const discovered = discoverVariants(mainRepository);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({
        id: 'test-client',
        currentBranch: 'feature/real-delivery',
        metadata: { delivery: { localBranch: 'feature/real-delivery', remoteBranch: 'feature/real-delivery' } },
      });

      const defaultBefore = git(mainRepository, 'rev-parse', 'test-client/main');
      const publishDryRun = parseLastJson(execute(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
        '--dry-run',
      ]));
      expect(publishDryRun).toMatchObject({ ok: true, dryRun: true, changed: false });
      expect(git(mainRepository, 'rev-parse', 'test-client/main')).toBe(defaultBefore);

      git(childWorktree, 'switch', 'variant/test-client');
      fs.writeFileSync(path.join(childWorktree, 'default-only.txt'), 'independent default change\n', 'utf8');
      git(childWorktree, 'add', 'default-only.txt');
      git(childWorktree, 'commit', '-m', 'fix: independent default branch change');
      git(childWorktree, 'push', 'test-client', 'HEAD:main');
      git(childWorktree, 'switch', 'feature/real-delivery');
      const divergentPublish = executeResult(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
      ]);
      expect(divergentPublish.status).not.toBe(0);
      expect(divergentPublish.stderr).toContain('default_branch_not_fast_forwardable');

      git(childWorktree, 'merge', '--no-edit', 'test-client/main');
      git(childWorktree, 'push', 'test-client', 'HEAD:feature/real-delivery');

      const failingPackage = JSON.parse(fs.readFileSync(path.join(childWorktree, 'package.json'), 'utf8'));
      failingPackage.scripts.test = 'node -e "process.exit(7)" --';
      writeJson(path.join(childWorktree, 'package.json'), failingPackage);
      git(childWorktree, 'add', 'package.json');
      git(childWorktree, 'commit', '-m', 'test: exercise failed publication gate');
      git(childWorktree, 'push', 'test-client', 'HEAD:feature/real-delivery');
      const gateFailureHead = git(childWorktree, 'rev-parse', 'HEAD');
      const gateFailure = executeResult(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
      ]);
      expect(gateFailure.status).not.toBe(0);
      expect(gateFailure.stderr).toContain('temporary default-branch metadata commit was rolled back');
      expect(gateFailure.stderr).toContain('"phase": "rolled_back"');
      expect(git(childWorktree, 'rev-parse', 'HEAD')).toBe(gateFailureHead);
      expect(git(childWorktree, 'status', '--porcelain')).toBe('');
      expect(JSON.parse(fs.readFileSync(createdMetadataPath, 'utf8')).delivery.remoteBranch).toBe('feature/real-delivery');

      const passingPackage = JSON.parse(fs.readFileSync(path.join(childWorktree, 'package.json'), 'utf8'));
      passingPackage.scripts.test = 'node -e "process.exit(0)" --';
      writeJson(path.join(childWorktree, 'package.json'), passingPackage);
      git(childWorktree, 'add', 'package.json');
      git(childWorktree, 'commit', '-m', 'test: restore publication gates');
      git(childWorktree, 'push', 'test-client', 'HEAD:feature/real-delivery');

      const rejectDefaultHook = path.join(childOrigin, 'hooks', 'pre-receive');
      fs.writeFileSync(rejectDefaultHook, [
        '#!/bin/sh',
        'while read old new ref',
        'do',
        '  if test "$ref" = "refs/heads/main"; then exit 1; fi',
        'done',
        'exit 0',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(rejectDefaultHook, 0o755);
      const pushFailureHead = git(childWorktree, 'rev-parse', 'HEAD');
      const pushFailure = executeResult(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
      ]);
      expect(pushFailure.status).not.toBe(0);
      expect(pushFailure.stderr).toContain('temporary default-branch metadata commit was rolled back');
      expect(git(childWorktree, 'rev-parse', 'HEAD')).toBe(pushFailureHead);
      expect(git(childWorktree, 'status', '--porcelain')).toBe('');
      expect(JSON.parse(fs.readFileSync(createdMetadataPath, 'utf8')).delivery.remoteBranch).toBe('feature/real-delivery');
      fs.unlinkSync(rejectDefaultHook);

      const published = parseLastJson(execute(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
      ]));
      expect(published.fastForward).toBe(true);
      expect(published.gates.map((gate: { name: string }) => gate.name)).toEqual(
        expect.arrayContaining(['lint', 'test', 'build']),
      );
      expect(git(mainRepository, 'rev-parse', 'test-client/main')).toBe(git(childWorktree, 'rev-parse', 'HEAD'));
      const alignedCommit = git(childWorktree, 'rev-parse', 'HEAD');
      const repeatedPublish = parseLastJson(execute(process.execPath, [
        managerPath,
        'publish-default',
        '--root', mainRepository,
        '--id', 'test-client',
      ]));
      expect(repeatedPublish).toMatchObject({ changed: false, status: 'already_aligned' });
      expect(git(childWorktree, 'rev-parse', 'HEAD')).toBe(alignedCommit);

      fs.appendFileSync(path.join(mainRepository, 'core.txt'), 'upstream change\n', 'utf8');
      git(mainRepository, 'add', 'core.txt');
      git(mainRepository, 'commit', '-m', 'update core');
      const updatedMainCommit = git(mainRepository, 'rev-parse', 'HEAD');
      git(mainRepository, 'push', 'origin', 'main');

      const coreTextBeforeDryRun = fs.readFileSync(path.join(childWorktree, 'core.txt'), 'utf8');
      const syncDryRun = parseLastJson(execute(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
        '--dry-run',
      ]));
      expect(syncDryRun).toMatchObject({ ok: true, dryRun: true, changed: false });
      expect(syncDryRun.variants[0].state).toBe('needs_core_sync');
      expect(fs.readFileSync(path.join(childWorktree, 'core.txt'), 'utf8')).toBe(coreTextBeforeDryRun);

      const synced = parseLastJson(execute(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
      ]));
      expect(synced.allGatesPassed).toBe(true);
      expect(synced.variants[0].gates.map((gate: { name: string }) => gate.name)).toEqual(
        expect.arrayContaining(['lint', 'test', 'build']),
      );
      const syncedMetadata = JSON.parse(fs.readFileSync(createdMetadataPath, 'utf8'));
      expect(syncedMetadata.upstream.lastSyncedCommit).toBe(updatedMainCommit);
      expect(syncedMetadata.delivery.remoteBranch).toBe('main');
      expect(fs.readFileSync(path.join(childWorktree, 'core.txt'), 'utf8')).toContain('upstream change');

      const status = parseLastJson(execute(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--id', 'test-client',
      ]));
      expect(status.variants[0]).toMatchObject({
        state: 'ready',
        blockers: [],
        core: { commitsBehind: 0 },
        delivery: { remoteBranch: 'main', defaultAligned: true },
        gates: { status: 'remote_check_required', current: false },
      });
      expect(status.releaseReady).toBe(false);
      expect(status.variants[0].warnings).toContain('live_remote_check_required');

      const strictStatus = parseLastJson(execute(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
        '--fetch',
        '--strict',
      ]));
      expect(strictStatus).toMatchObject({ releaseReady: true, liveRemote: true });
      expect(strictStatus.variants[0]).toMatchObject({
        state: 'ready',
        delivery: { remoteSource: 'live' },
        gates: { status: 'passed', current: true, source: 'variant_sync' },
      });

      const commonDir = path.resolve(mainRepository, git(mainRepository, 'rev-parse', '--git-common-dir'));
      const receiptPath = path.join(commonDir, 'lumi', 'variant-gate-receipts', 'test-client.json');
      const durableReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      expect(durableReceipt).toMatchObject({
        schemaVersion: 1,
        variantId: 'test-client',
        source: 'variant_sync',
        coreCommit: updatedMainCommit,
        variantCommit: git(childWorktree, 'rev-parse', 'HEAD'),
        remoteCommit: git(childWorktree, 'rev-parse', 'HEAD'),
        integrity: { algorithm: 'sha256' },
      });
      expect(durableReceipt.gates.map((gate: { name: string }) => gate.name)).toEqual(
        expect.arrayContaining(['lint', 'test', 'build']),
      );
      durableReceipt.integrity.digest = '0'.repeat(64);
      writeJson(receiptPath, durableReceipt);
      const invalidReceiptStatus = executeResult(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
        '--fetch',
        '--strict',
      ]);
      expect(invalidReceiptStatus.status).not.toBe(0);
      expect(parseLastJson(String(invalidReceiptStatus.stdout))).toMatchObject({
        releaseReady: false,
        variants: [expect.objectContaining({
          gates: expect.objectContaining({ status: 'invalid', staleReasons: ['integrity_mismatch'] }),
        })],
      });
      const repairedReceiptStatus = parseLastJson(execute(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
        '--fetch',
        '--verify',
        '--strict',
      ]));
      expect(repairedReceiptStatus).toMatchObject({
        releaseReady: true,
        variants: [expect.objectContaining({ gates: expect.objectContaining({ status: 'passed', current: true }) })],
      });

      fs.writeFileSync(path.join(childWorktree, 'generic.txt'), 'reusable capability\n', 'utf8');
      git(childWorktree, 'add', 'generic.txt');
      git(childWorktree, 'commit', '-m', 'feat: reusable capability');
      const genericCommit = git(childWorktree, 'rev-parse', 'HEAD');
      git(childWorktree, 'push', 'test-client', 'HEAD:main');

      const promoted = parseLastJson(execute(process.execPath, [
        managerPath,
        'promote',
        '--root', mainRepository,
        '--id', 'test-client',
        '--commits', genericCommit,
      ]));
      expect(promoted.gates.map((gate: { name: string }) => gate.name)).toEqual(
        expect.arrayContaining(['lint', 'test', 'build']),
      );
      const integrationBranch = `integrate/test-client-${genericCommit.slice(0, 8)}`;
      expect(git(mainRepository, 'branch', '--show-current')).toBe('main');
      expect(git(mainRepository, 'show', `${integrationBranch}:generic.txt`)).toBe('reusable capability');
      expect(git(mainRepository, 'ls-remote', '--heads', 'origin', integrationBranch)).toContain(`refs/heads/${integrationBranch}`);

      const skipped = executeResult(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--id', 'test-client',
        '--skip-verify',
      ]);
      expect(skipped.status).not.toBe(0);
      expect(skipped.stderr).toContain('cannot be skipped');

      fs.writeFileSync(path.join(childWorktree, 'conflict.txt'), 'variant side\n', 'utf8');
      git(childWorktree, 'add', 'conflict.txt');
      git(childWorktree, 'commit', '-m', 'test: variant conflict side');
      fs.writeFileSync(path.join(mainRepository, 'conflict.txt'), 'core side\n', 'utf8');
      git(mainRepository, 'add', 'conflict.txt');
      git(mainRepository, 'commit', '-m', 'test: core conflict side');
      const childBeforeConflictPreview = git(childWorktree, 'rev-parse', 'HEAD');
      const coreBeforeConflictPreview = git(mainRepository, 'rev-parse', 'HEAD');
      const objectsBeforePreview = git(mainRepository, 'count-objects', '-v');
      const conflictPreview = parseLastJson(execute(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--id', 'test-client',
        '--dry-run',
      ]));
      expect(conflictPreview).toMatchObject({ ok: false, dryRun: true, readyToExecute: false });
      expect(conflictPreview.variants[0].blockers).toContain('core_merge_conflict_preview');
      expect(conflictPreview.variants[0].mergePreview).toMatchObject({
        attempted: true,
        mode: 'isolated_git_merge_tree',
        conflictFree: false,
      });
      expect(git(childWorktree, 'rev-parse', 'HEAD')).toBe(childBeforeConflictPreview);
      expect(git(mainRepository, 'rev-parse', 'HEAD')).toBe(coreBeforeConflictPreview);
      expect(git(childWorktree, 'status', '--porcelain')).toBe('');
      expect(git(mainRepository, 'status', '--porcelain')).toBe('');
      expect(git(mainRepository, 'count-objects', '-v')).toBe(objectsBeforePreview);
    } finally {
      const resolvedTemporaryRoot = path.resolve(temporaryRoot);
      if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir())) && path.basename(resolvedTemporaryRoot).startsWith('lumi-variant-test-')) {
        fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('rolls back an interrupted all-variant preparation and preserves a durable partial-push recovery state', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-variant-transaction-test-'));
    const mainRepository = path.join(temporaryRoot, 'lumi-core');
    const mainOrigin = path.join(temporaryRoot, 'lumi-core-origin.git');
    const variantsRoot = path.join(temporaryRoot, 'lumi-core-variants');

    try {
      fs.mkdirSync(mainRepository);
      execute('git', ['init', '--bare', '--initial-branch=main', mainOrigin]);
      git(mainRepository, 'init', '-b', 'main');
      git(mainRepository, 'config', 'user.name', 'Lumi Variant Transaction Test');
      git(mainRepository, 'config', 'user.email', 'variant-transaction-test@localhost');
      fs.writeFileSync(path.join(mainRepository, 'shared.txt'), 'baseline\n', 'utf8');
      fs.writeFileSync(path.join(mainRepository, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
      writeJson(path.join(mainRepository, 'package.json'), {
        name: 'variant-transaction-test',
        version: '1.0.0',
        private: true,
        scripts: {
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)" --',
          build: 'node -e "process.exit(0)"',
        },
      });
      writeJson(path.join(mainRepository, 'package-lock.json'), {
        name: 'variant-transaction-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'variant-transaction-test', version: '1.0.0' } },
      });
      git(mainRepository, 'add', '.');
      git(mainRepository, 'commit', '-m', 'initial core');
      const baselineCommit = git(mainRepository, 'rev-parse', 'HEAD');
      git(mainRepository, 'remote', 'add', 'origin', mainOrigin);
      git(mainRepository, 'push', '-u', 'origin', 'main');

      const variants = ['alpha-client', 'beta-client'].map(id => {
        const childOrigin = path.join(temporaryRoot, `lumi-${id}.git`);
        const worktree = path.join(variantsRoot, `lumi-${id}`);
        execute('git', ['init', '--bare', '--initial-branch=main', childOrigin]);
        git(mainRepository, 'worktree', 'add', '-b', `variant/${id}`, worktree, baselineCommit);
        git(mainRepository, 'remote', 'add', id, childOrigin);
        const metadataPath = path.join(worktree, '.lumi', 'variant.json');
        fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
        writeJson(metadataPath, buildVariantMetadata({
          id,
          displayName: `Lumi ${id}`,
          productLine: id,
          upstreamRepository: mainOrigin,
          baselineCommit,
          repository: childOrigin,
          localBranch: `variant/${id}`,
        }));
        git(worktree, 'add', '.lumi/variant.json');
        git(worktree, 'commit', '-m', `chore: initialize ${id}`);
        git(worktree, 'push', '-u', id, 'HEAD:main');
        return { id, childOrigin, worktree, metadataPath };
      });
      const [alpha, beta] = variants;

      const userFile = path.join(alpha.worktree, 'user-uncommitted.txt');
      fs.writeFileSync(userFile, 'preserve me\n', 'utf8');
      const dirtyAttempt = executeResult(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
      ]);
      expect(dirtyAttempt.status).not.toBe(0);
      expect(dirtyAttempt.stderr).toContain('uncommitted changes');
      expect(fs.readFileSync(userFile, 'utf8')).toBe('preserve me\n');
      fs.unlinkSync(userFile);

      fs.writeFileSync(path.join(beta.worktree, 'shared.txt'), 'variant side\n', 'utf8');
      git(beta.worktree, 'add', 'shared.txt');
      git(beta.worktree, 'commit', '-m', 'test: beta conflict side');
      git(beta.worktree, 'push', beta.id, 'HEAD:main');
      fs.writeFileSync(path.join(mainRepository, 'shared.txt'), 'core side\n', 'utf8');
      git(mainRepository, 'add', 'shared.txt');
      git(mainRepository, 'commit', '-m', 'feat: update shared core');
      git(mainRepository, 'push', 'origin', 'main');

      const initialHeads = Object.fromEntries(variants.map(variant => [
        variant.id,
        git(variant.worktree, 'rev-parse', 'HEAD'),
      ]));
      const interrupted = executeResult(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
      ]);
      expect(interrupted.status).not.toBe(0);
      expect(interrupted.stderr).toContain('"phase": "rolled_back"');
      expect(interrupted.stderr).toContain('"remoteChanges": false');
      for (const variant of variants) {
        expect(git(variant.worktree, 'rev-parse', 'HEAD')).toBe(initialHeads[variant.id]);
        expect(git(variant.worktree, 'status', '--porcelain')).toBe('');
      }

      const betaMerge = executeResult('git', ['merge', '--no-edit', 'main'], beta.worktree);
      expect(betaMerge.status).not.toBe(0);
      fs.writeFileSync(path.join(beta.worktree, 'shared.txt'), 'reviewed resolution\n', 'utf8');
      git(beta.worktree, 'add', 'shared.txt');
      git(beta.worktree, 'commit', '-m', 'merge: resolve core update');
      git(beta.worktree, 'push', beta.id, 'HEAD:main');
      const betaRemoteBeforeRelease = git(beta.worktree, 'rev-parse', 'HEAD');

      const rejectBetaHook = path.join(beta.childOrigin, 'hooks', 'pre-receive');
      fs.writeFileSync(rejectBetaHook, '#!/bin/sh\nexit 1\n', 'utf8');
      fs.chmodSync(rejectBetaHook, 0o755);
      const partial = executeResult(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
      ]);
      expect(partial.status).not.toBe(0);
      expect(partial.stderr).toContain('"phase": "partial_remote_publish"');
      expect(partial.stderr).toContain('"remoteChanges": true');
      const alphaPreparedHead = git(alpha.worktree, 'rev-parse', 'HEAD');
      const betaPreparedHead = git(beta.worktree, 'rev-parse', 'HEAD');
      expect(git(alpha.worktree, 'ls-remote', '--heads', alpha.id, 'refs/heads/main')).toContain(alphaPreparedHead);
      expect(git(beta.worktree, 'ls-remote', '--heads', beta.id, 'refs/heads/main')).toContain(betaRemoteBeforeRelease);
      expect(betaPreparedHead).not.toBe(betaRemoteBeforeRelease);
      expect(git(alpha.worktree, 'status', '--porcelain')).toBe('');
      expect(git(beta.worktree, 'status', '--porcelain')).toBe('');

      const commonDir = path.resolve(mainRepository, git(mainRepository, 'rev-parse', '--git-common-dir'));
      const releaseStateFile = path.join(commonDir, 'lumi', 'variant-release-state.json');
      const releaseState = JSON.parse(fs.readFileSync(releaseStateFile, 'utf8'));
      expect(releaseState).toMatchObject({ phase: 'partial_remote_publish', recovery: 'npm run variant:sync -- --all' });
      expect(releaseState.variants).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: alpha.id, status: 'published', targetCommit: alphaPreparedHead }),
        expect.objectContaining({ id: beta.id, status: 'pending', targetCommit: betaPreparedHead }),
      ]));

      fs.unlinkSync(rejectBetaHook);
      const recovered = parseLastJson(execute(process.execPath, [
        managerPath,
        'sync',
        '--root', mainRepository,
        '--all',
      ]));
      expect(recovered.ok).toBe(true);
      expect(recovered.variants).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: alpha.id, publicationStatus: 'already_published' }),
        expect.objectContaining({ id: beta.id, publicationStatus: 'published' }),
      ]));
      expect(git(beta.worktree, 'ls-remote', '--heads', beta.id, 'refs/heads/main')).toContain(betaPreparedHead);
      expect(fs.existsSync(releaseStateFile)).toBe(false);

      const strictBeforeRemoteChange = parseLastJson(execute(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
        '--fetch',
        '--strict',
      ]));
      expect(strictBeforeRemoteChange.releaseReady).toBe(true);

      const externalWriter = path.join(temporaryRoot, 'alpha-remote-writer');
      execute('git', ['clone', alpha.childOrigin, externalWriter]);
      git(externalWriter, 'config', 'user.name', 'External Variant Writer');
      git(externalWriter, 'config', 'user.email', 'external-variant@localhost');
      fs.writeFileSync(path.join(externalWriter, 'remote-only.txt'), 'advanced outside the cached worktree\n', 'utf8');
      git(externalWriter, 'add', 'remote-only.txt');
      git(externalWriter, 'commit', '-m', 'test: advance live remote only');
      const liveRemoteHead = git(externalWriter, 'rev-parse', 'HEAD');
      git(externalWriter, 'push', 'origin', 'main');

      const cachedStatus = parseLastJson(execute(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
      ]));
      const cachedAlpha = cachedStatus.variants.find((variant: { id: string }) => variant.id === alpha.id);
      expect(cachedAlpha).toMatchObject({
        delivery: { remoteHead: alphaPreparedHead, remoteSource: 'cached' },
        gates: { status: 'remote_check_required', current: false },
      });
      expect(cachedStatus.releaseReady).toBe(false);

      const liveStatus = executeResult(process.execPath, [
        managerPath,
        'status',
        '--root', mainRepository,
        '--all',
        '--fetch',
        '--strict',
      ]);
      expect(liveStatus.status).not.toBe(0);
      const liveReport = parseLastJson(String(liveStatus.stdout));
      const liveAlpha = liveReport.variants.find((variant: { id: string }) => variant.id === alpha.id);
      expect(liveAlpha).toMatchObject({
        state: 'blocked',
        delivery: { remoteHead: liveRemoteHead, remoteSource: 'live', localBehind: 1 },
        gates: { status: 'stale', current: false },
      });
      expect(liveAlpha.blockers).toContain('remote_delivery_ahead');
      expect(liveAlpha.gates.staleReasons).toContain('remote_commit_changed');
    } finally {
      const resolvedTemporaryRoot = path.resolve(temporaryRoot);
      if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()))
        && path.basename(resolvedTemporaryRoot).startsWith('lumi-variant-transaction-test-')) {
        fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
      }
    }
  }, 90_000);
});
