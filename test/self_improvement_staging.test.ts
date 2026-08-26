import './helpers';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  createSelfImprovementProposal,
  enqueueSelfImprovementProposal,
  getSelfImprovementProposal,
  listSelfImprovementProposals,
  recordSelfImprovementPatchReview,
  updateSelfImprovementProgram,
} from '../server/self_extension/improvement_program';
import {
  activateSelfImprovementStage,
  extractUnifiedPatchPaths,
  stageSelfImprovementPatch,
} from '../server/self_extension/staging';
import { markFailed, markRunning } from '../server/autonomy/task_queue';
import { registerSelfExtensionTools } from '../server/tools/definitions/self_extension_tools';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import {
  evaluateAutonomousTaskOutcome,
  hasVerifiedSelfImprovementStageReceipt,
} from '../server/autonomy/task_executor';

beforeAll(async () => {
  await initDatabase();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function createRepository(): { root: string; repo: string; worktrees: string; previousTrustedRoot?: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-self-improvement-stage-'));
  const repo = path.join(root, 'repo');
  const worktrees = path.join(root, 'worktrees');
  fs.mkdirSync(path.join(repo, 'server'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server', 'example.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'lumi-core' }), 'utf8');
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Lumi Test');
  git(repo, 'config', 'user.email', 'lumi-test@localhost');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/lumi-test.git');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  const previousTrustedRoot = process.env.LUMI_SELF_IMPROVEMENT_REPO_ROOT;
  process.env.LUMI_SELF_IMPROVEMENT_REPO_ROOT = repo;
  return { root, repo, worktrees, previousTrustedRoot };
}

function cleanupRepository(fixture: ReturnType<typeof createRepository>): void {
  if (fixture.previousTrustedRoot === undefined) delete process.env.LUMI_SELF_IMPROVEMENT_REPO_ROOT;
  else process.env.LUMI_SELF_IMPROVEMENT_REPO_ROOT = fixture.previousTrustedRoot;
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function patchValue(nextValue = 2): string {
  return [
    'diff --git a/server/example.ts b/server/example.ts',
    'index 9f8f66f..581ac84 100644',
    '--- a/server/example.ts',
    '+++ b/server/example.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    `+export const value = ${nextValue};`,
    '',
  ].join('\n');
}

function patchDocumentation(next = '# Guide\n\nVerified guidance.\n'): string {
  const body = next.replace(/\n$/, '').split('\n').map(line => `+${line}`);
  return [
    'diff --git a/docs/guide.md b/docs/guide.md',
    '--- a/docs/guide.md',
    '+++ b/docs/guide.md',
    `@@ -1 +1,${body.length} @@`,
    '-# Guide',
    ...body,
    '',
  ].join('\n');
}

async function createAutonomousDocumentationProposal(
  scope: { userId: string },
  patch = patchDocumentation(),
  changedPath = 'docs/guide.md',
) {
  await updateSelfImprovementProgram(scope, {
    enabled: true,
    mode: 'autonomous_low_risk',
    authorizationReason: 'Allow bounded static documentation improvement with verified local commits.',
    allowedTargets: ['core'],
    allowedPathPrefixes: ['docs/'],
    verificationProfiles: ['standard'],
    maxFilesPerChange: 2,
    maxPatchBytes: 20_000,
    allowLocalCommit: true,
  });
  return createSelfImprovementProposal(scope, {
    goal: 'Improve verified static documentation',
    target: 'core',
    risk: 'low',
    operations: ['documentation_change'],
    changedPaths: [changedPath],
    estimatedFiles: 1,
    estimatedPatchBytes: Buffer.byteLength(patch),
    verificationProfile: 'standard',
  });
}

async function reviewPatch(scope: { userId: string }, proposalId: string, repo: string, patch: string): Promise<void> {
  await recordSelfImprovementPatchReview(scope, proposalId, {
    patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
    baseCommit: git(repo, 'rev-parse', 'HEAD'),
    deliveryBranch: git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
    verificationProfile: 'standard',
  });
}

describe('isolated self-improvement staging', () => {
  it('stages, verifies, and commits without mutating the live worktree', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-${Date.now()}-${Math.random()}` };
      await updateSelfImprovementProgram(scope, {
        enabled: true,
        mode: 'supervised',
        authorizationReason: 'Allow bounded isolated source verification.',
        allowedTargets: ['core'],
        allowedPathPrefixes: ['server/'],
        verificationProfiles: ['standard'],
        maxFilesPerChange: 2,
        maxPatchBytes: 20_000,
        allowLocalCommit: true,
      });
      const proposal = await createSelfImprovementProposal(scope, {
        goal: 'Improve a bounded source value',
        target: 'core',
        risk: 'low',
        operations: ['code_change', 'git_commit'],
        changedPaths: ['server/example.ts'],
        estimatedFiles: 1,
        estimatedPatchBytes: Buffer.byteLength(patchValue()),
        verificationProfile: 'standard',
      });
      await reviewPatch(scope, proposal.id, fixture.repo, patchValue());

      const result = await stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch: patchValue(),
      }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
        verificationRunner: async (worktreePath, profile, changedPaths) => {
          expect(fs.readFileSync(path.join(worktreePath, 'server', 'example.ts'), 'utf8').replace(/\r\n/g, '\n'))
            .toBe('export const value = 2;\n');
          expect(profile).toBe('standard');
          expect(changedPaths).toEqual(['server/example.ts']);
          return [{
            profile,
            command: 'test:bounded',
            status: 'passed',
            exitCode: 0,
            durationMs: 1,
            outputDigest: 'a'.repeat(64),
            summary: 'bounded verification passed',
          }];
        },
      });

      expect(result).toMatchObject({
        ok: true,
        status: 'verified',
        isolated: true,
        activated: false,
        pushed: false,
        changedPaths: ['server/example.ts'],
      });
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.readFileSync(path.join(fixture.repo, 'server', 'example.ts'), 'utf8'))
        .toBe('export const value = 1;\n');
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
      expect(git(fixture.repo, 'show-ref', '--verify', `refs/heads/${result.branch}`)).toContain(result.commit);

      const replay = await stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch: patchValue(),
      }, { repoRoot: fixture.repo, worktreeParent: fixture.worktrees });
      expect(replay).toMatchObject({ status: 'verified', replayed: true, commit: result.commit });
      await expect(recordSelfImprovementPatchReview(scope, proposal.id, {
        patchDigest: 'f'.repeat(64),
        baseCommit: result.baseCommit,
        deliveryBranch: 'main',
        verificationProfile: 'standard',
      })).rejects.toThrow(/immutable after staging begins/i);

      await expect(activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        repoRoot: fixture.repo,
      })).rejects.toThrow(/explicit user confirmation/i);
      const activated = await activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        confirmed: true,
        repoRoot: fixture.repo,
        verificationRunner: async (_worktreePath, profile, changedPaths) => [{
          profile,
          command: `activate:${changedPaths.join(',')}`,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          outputDigest: 'b'.repeat(64),
          summary: 'activation verification passed',
        }],
      });
      expect(activated).toMatchObject({
        status: 'activated',
        activated: true,
        pushed: false,
        commit: result.commit,
        cleanup: { worktreeRemoved: true, stagingBranchRemoved: true },
        proposal: { status: 'activated', activatedCommit: result.commit },
      });
      expect(fs.readFileSync(path.join(fixture.repo, 'server', 'example.ts'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('export const value = 2;\n');
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
      expect(git(fixture.repo, 'branch', '--list', result.branch)).toBe('');
      expect(fs.existsSync(result.worktreePath)).toBe(false);

      const activationReplay = await activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        confirmed: true,
        repoRoot: fixture.repo,
      });
      expect(activationReplay).toMatchObject({ status: 'activated', replayed: true, commit: result.commit });
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('requires the patch path set to exactly match the reviewed proposal', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-scope-${Date.now()}-${Math.random()}` };
      await updateSelfImprovementProgram(scope, {
        enabled: true,
        mode: 'supervised',
        authorizationReason: 'Allow one reviewed isolated change.',
        allowedTargets: ['core'],
        allowedPathPrefixes: ['server/'],
        verificationProfiles: ['standard'],
      });
      const proposal = await createSelfImprovementProposal(scope, {
        goal: 'Review an exact two-file change',
        target: 'core',
        risk: 'low',
        operations: ['code_change'],
        changedPaths: ['server/example.ts', 'server/required.ts'],
        verificationProfile: 'standard',
      });
      await expect(stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch: patchValue(),
      }, { repoRoot: fixture.repo, worktreeParent: fixture.worktrees }))
        .rejects.toThrow(/not authorized/i);

      await reviewPatch(scope, proposal.id, fixture.repo, patchValue());
      await expect(stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch: patchValue(),
      }, { repoRoot: fixture.repo, worktreeParent: fixture.worktrees }))
        .rejects.toThrow(/missing: server\/required\.ts/i);
      expect(fs.existsSync(fixture.worktrees)).toBe(false);
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('refuses to activate a verified commit after the live delivery branch moves', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-stale-${Date.now()}-${Math.random()}` };
      await updateSelfImprovementProgram(scope, {
        enabled: true,
        mode: 'supervised',
        authorizationReason: 'Allow bounded staging but never merge across a moved delivery branch.',
        allowedTargets: ['core'],
        allowedPathPrefixes: ['server/'],
        verificationProfiles: ['standard'],
        allowLocalCommit: true,
      });
      const proposal = await createSelfImprovementProposal(scope, {
        goal: 'Stage a change against an exact base',
        target: 'core',
        risk: 'low',
        operations: ['code_change', 'git_commit'],
        changedPaths: ['server/example.ts'],
        verificationProfile: 'standard',
      });
      await reviewPatch(scope, proposal.id, fixture.repo, patchValue());
      await stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch: patchValue() }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
        verificationRunner: async (_worktreePath, profile) => [{
          profile,
          command: 'stage:stale-base',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          outputDigest: 'c'.repeat(64),
          summary: 'staging verification passed',
        }],
      });

      fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'delivery branch advanced\n', 'utf8');
      git(fixture.repo, 'add', 'README.md');
      git(fixture.repo, 'commit', '-m', 'advance delivery branch');
      const advancedHead = git(fixture.repo, 'rev-parse', 'HEAD');

      await expect(activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        confirmed: true,
        repoRoot: fixture.repo,
        verificationRunner: async () => { throw new Error('verification must not run after a stale-base rejection'); },
      })).rejects.toThrow(/moved beyond the reviewed base/i);
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(advancedHead);
      expect(fs.readFileSync(path.join(fixture.repo, 'server', 'example.ts'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('export const value = 1;\n');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('rejects files generated by verification instead of committing them with the reviewed patch', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-generated-${Date.now()}-${Math.random()}` };
      await updateSelfImprovementProgram(scope, {
        enabled: true,
        mode: 'supervised',
        authorizationReason: 'Allow one bounded isolated source verification.',
        allowedTargets: ['core'],
        allowedPathPrefixes: ['server/'],
        verificationProfiles: ['standard'],
      });
      const proposal = await createSelfImprovementProposal(scope, {
        goal: 'Reject verification side effects',
        target: 'core',
        risk: 'low',
        operations: ['code_change'],
        changedPaths: ['server/example.ts'],
        verificationProfile: 'standard',
      });
      await reviewPatch(scope, proposal.id, fixture.repo, patchValue());

      await expect(stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch: patchValue(),
      }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
        verificationRunner: async (worktreePath, profile) => {
          fs.writeFileSync(path.join(worktreePath, 'server', 'generated-by-test.tmp'), 'unexpected\n', 'utf8');
          return [{
            profile,
            command: 'test:side-effect',
            status: 'passed',
            exitCode: 0,
            durationMs: 1,
            outputDigest: 'd'.repeat(64),
            summary: 'runner claimed success after generating an undeclared file',
          }];
        },
      })).rejects.toThrow(/Post-verification worktree paths no longer match.*unexpected/i);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('stages autonomous documentation with plumbing only and activates the exact verified tree without hooks or signing', async () => {
    const fixture = createRepository();
    try {
      const sentinel = path.join(fixture.root, 'attacker-command-ran.txt');
      const maliciousHooks = path.join(fixture.root, 'malicious-hooks');
      fs.mkdirSync(maliciousHooks, { recursive: true });
      const hook = path.join(maliciousHooks, 'post-merge');
      fs.writeFileSync(hook, `#!/bin/sh\nprintf attacked > "${sentinel.replace(/\\/g, '/')}"\n`, 'utf8');
      fs.chmodSync(hook, 0o755);
      git(fixture.repo, 'config', 'core.hooksPath', maliciousHooks);
      git(fixture.repo, 'config', 'commit.gpgSign', 'true');
      git(fixture.repo, 'config', 'gpg.program', path.join(fixture.root, 'missing-attacker-gpg'));

      const scope = { userId: `self-stage-autonomous-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      expect(proposal).toMatchObject({
        status: 'proposed',
        evaluation: { decision: 'eligible_autonomous', authorized: true },
      });

      const result = await stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch,
      }, { repoRoot: fixture.repo, worktreeParent: fixture.worktrees });

      expect(result).toMatchObject({
        status: 'verified',
        isolated: true,
        activated: false,
        pushed: false,
        changedPaths: ['docs/guide.md'],
      });
      expect(result.repositoryId).toBe(proposal.repositoryId);
      expect(result.treeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.verification).toEqual([
        expect.objectContaining({ command: 'static-markdown-integrity', status: 'passed' }),
      ]);
      expect(fs.readFileSync(path.join(fixture.repo, 'docs', 'guide.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('# Guide\n');
      expect(git(fixture.repo, 'ls-tree', result.commit!, '--', 'docs/guide.md'))
        .toMatch(/^100644 blob [0-9a-f]+\s+docs\/guide\.md$/);
      expect(fs.existsSync(sentinel)).toBe(false);

      const activated = await activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        confirmed: true,
        repoRoot: fixture.repo,
      });
      expect(activated).toMatchObject({
        status: 'activated',
        activated: true,
        pushed: false,
        commit: result.commit,
        cleanup: { worktreeRemoved: true, stagingBranchRemoved: true },
      });
      expect(fs.readFileSync(path.join(fixture.repo, 'docs', 'guide.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('# Guide\n\nVerified guidance.\n');
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('rejects configured clean filters before staging and never invokes the filter command', async () => {
    const fixture = createRepository();
    try {
      const sentinel = path.join(fixture.root, 'filter-ran.txt');
      const filterScript = path.join(fixture.root, 'evil-filter.sh');
      fs.writeFileSync(filterScript, [
        '#!/bin/sh',
        `printf attacked > "${sentinel.replace(/\\/g, '/')}"`,
        'cat',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(filterScript, 0o755);
      fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '*.md filter=evil\n', 'utf8');
      git(fixture.repo, 'add', '.gitattributes');
      git(fixture.repo, 'commit', '-m', 'configure tracked attributes');
      git(fixture.repo, 'config', 'filter.evil.clean', filterScript.replace(/\\/g, '/'));

      const scope = { userId: `self-stage-filter-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      })).rejects.toThrow(/(?:content-transform attribute filter|content filter drivers).*forbidden/i);
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('rejects every Git content transform that could change verified documentation bytes', async () => {
    const fixture = createRepository();
    try {
      fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '*.md eol=crlf\n', 'utf8');
      git(fixture.repo, 'add', '.gitattributes');
      git(fixture.repo, 'commit', '-m', 'configure a working-tree conversion');
      const scope = { userId: `self-stage-transform-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      })).rejects.toThrow(/content-transform attribute eol is forbidden/i);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('checks repository filter drivers before any activation status command can execute them', async () => {
    const fixture = createRepository();
    try {
      fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), 'server/example.ts filter=evil\n', 'utf8');
      git(fixture.repo, 'add', '.gitattributes');
      git(fixture.repo, 'commit', '-m', 'declare an unrelated filter attribute');
      const scope = { userId: `self-stage-unrelated-filter-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      const staged = await stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      });
      const sentinel = path.join(fixture.root, 'unrelated-filter-ran.txt');
      const filterScript = path.join(fixture.root, 'unrelated-filter.sh');
      fs.writeFileSync(filterScript, [
        '#!/bin/sh',
        `printf attacked > "${sentinel.replace(/\\/g, '/')}"`,
        'cat',
        '',
      ].join('\n'), 'utf8');
      fs.chmodSync(filterScript, 0o755);
      git(fixture.repo, 'config', 'filter.evil.clean', filterScript.replace(/\\/g, '/'));
      fs.appendFileSync(path.join(fixture.repo, 'server', 'example.ts'), '// dirty\n', 'utf8');

      await expect(activateSelfImprovementStage(scope, { proposalId: proposal.id }, {
        confirmed: true,
        repoRoot: fixture.repo,
      })).rejects.toThrow(/content filter drivers are forbidden/i);
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(staged.baseCommit);
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('preserves the complete base blob for documentation larger than the command-output window', async () => {
    const fixture = createRepository();
    try {
      const prefixLines = Array.from({ length: 25_000 }, (_, index) => `stable prefix ${index.toString().padStart(5, '0')}`);
      const original = ['# Large', ...prefixLines, 'TAIL old', ''].join('\n');
      const expected = ['# Large', ...prefixLines, 'TAIL new', ''].join('\n');
      expect(Buffer.byteLength(original)).toBeGreaterThan(400_000);
      expect(Buffer.byteLength(original)).toBeLessThan(1_000_000);
      fs.writeFileSync(path.join(fixture.repo, 'docs', 'large.md'), original, 'utf8');
      git(fixture.repo, 'add', 'docs/large.md');
      git(fixture.repo, 'commit', '-m', 'add large static documentation');
      const tailLine = prefixLines.length + 2;
      const patch = [
        'diff --git a/docs/large.md b/docs/large.md',
        '--- a/docs/large.md',
        '+++ b/docs/large.md',
        `@@ -${tailLine} +${tailLine} @@`,
        '-TAIL old',
        '+TAIL new',
        '',
      ].join('\n');
      const scope = { userId: `self-stage-large-${Date.now()}-${Math.random()}` };
      const proposal = await createAutonomousDocumentationProposal(scope, patch, 'docs/large.md');
      const registry = new ToolRegistry();
      registerSelfExtensionTools(registry);
      let reconstructed = '';
      let byteOffset: number | null = 0;
      do {
        const chunk = JSON.parse(await registry.execute('self_improvement_read_scope', {
          proposalId: proposal.id,
          path: 'docs/large.md',
          byteOffset,
          maxBytes: 100_000,
        }, {
          userId: scope.userId,
          authenticated: true,
          authRole: 'admin',
          localExecution: true,
          executionBoundary: 'trusted_local',
        }));
        reconstructed += chunk.content;
        byteOffset = chunk.nextByteOffset;
      } while (byteOffset !== null);
      expect(reconstructed).toBe(original);
      const result = await stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      });
      const committed = git(fixture.repo, 'show', `${result.commit}:docs/large.md`).replace(/\r\n/g, '\n');
      expect(`${committed}\n`).toBe(expected);
      expect(committed.startsWith('# Large\nstable prefix 00000\n')).toBe(true);
    } finally {
      cleanupRepository(fixture);
    }
  }, 30_000);

  it('binds every proposal to one repository and rejects cwd or option redirection', async () => {
    const intended = createRepository();
    let other: ReturnType<typeof createRepository> | undefined;
    try {
      const scope = { userId: `self-stage-repository-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      other = createRepository();

      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: other.repo,
        worktreeParent: other.worktrees,
      })).rejects.toThrow(/repository identity changed|does not match the repository identity/i);
      expect(fs.readFileSync(path.join(intended.repo, 'docs', 'guide.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('# Guide\n');
      expect(fs.readFileSync(path.join(other.repo, 'docs', 'guide.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('# Guide\n');
    } finally {
      if (other) cleanupRepository(other);
      cleanupRepository(intended);
    }
  });

  it('never persists or returns credentials embedded in a Git origin or commit message input', async () => {
    const fixture = createRepository();
    try {
      const secret = 'origin-token-never-persist-123456789';
      git(fixture.repo, 'remote', 'set-url', 'origin', `https://lumi:${secret}@example.invalid/private.git?access_token=${secret}`);
      const scope = { userId: `self-stage-origin-secret-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      expect(proposal.repositoryOrigin).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(proposal)).not.toContain(secret);

      const result = await stageSelfImprovementPatch(scope, {
        proposalId: proposal.id,
        patch,
        commitMessage: `docs: ${secret}`,
      }, { repoRoot: fixture.repo, worktreeParent: fixture.worktrees });
      const observable = JSON.stringify({ result, proposals: listSelfImprovementProposals(scope) });
      expect(observable).not.toContain(secret);
      expect(git(fixture.repo, 'show', '-s', '--format=%B', result.commit!)).not.toContain(secret);
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('rejects a staging-parent junction without touching the live repository', async () => {
    const fixture = createRepository();
    let linked = false;
    try {
      const scope = { userId: `self-stage-junction-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      fs.symlinkSync(fixture.repo, fixture.worktrees, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      })).rejects.toThrow(/link|reparse|live repository/i);
      expect(fs.readFileSync(path.join(fixture.repo, 'docs', 'guide.md'), 'utf8').replace(/\r\n/g, '\n'))
        .toBe('# Guide\n');
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      if (linked && fs.existsSync(fixture.worktrees)) fs.unlinkSync(fixture.worktrees);
      cleanupRepository(fixture);
    }
  });

  it('stops before creating a staging ref when its durable task is cancelled mid-run', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-cancel-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      let cancellationChecks = 0;
      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
        isCancelled: () => ++cancellationChecks >= 3,
      })).rejects.toThrow(/cancelled|paused|lease/i);
      expect(git(fixture.repo, 'branch', '--list', `lumi/self-improvement/${proposal.id}`)).toBe('');
      expect(getSelfImprovementProposal(scope, proposal.id)?.status).not.toBe('verified');
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('rejects empty Git identity pins at the tool boundary', async () => {
    const fixture = createRepository();
    try {
      const scope = { userId: `self-stage-empty-pin-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      const registry = new ToolRegistry();
      registerSelfExtensionTools(registry);
      const context = {
        userId: scope.userId,
        authenticated: true,
        authRole: 'admin',
        localExecution: true,
        executionBoundary: 'trusted_local' as const,
        userConfirmed: true,
      };
      await expect(registry.execute('self_improvement_stage_patch', {
        proposalId: proposal.id,
        patch,
        expectedBaseCommit: '',
        expectedDeliveryBranch: 'main',
      }, context)).rejects.toThrow(/non-empty base commit/i);
      await expect(registry.execute('self_improvement_stage_patch', {
        proposalId: proposal.id,
        patch,
        expectedBaseCommit: git(fixture.repo, 'rev-parse', 'HEAD'),
        expectedDeliveryBranch: '',
      }, context)).rejects.toThrow(/valid non-empty delivery branch/i);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanupRepository(fixture);
    }
  });

  it('recovers a crash after durable staging through the registry and produces accepted task evidence', async () => {
    const fixture = createRepository();
    let runningTask: ReturnType<typeof markRunning> = null;
    try {
      const scope = { userId: `self-stage-replay-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      const queued = await enqueueSelfImprovementProposal(scope, proposal.id, {
        reviewed: true,
        localAdminAuthorized: true,
      });
      runningTask = markRunning(queued.task.id);
      expect(runningTask?.status).toBe('running');
      await stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: fixture.repo,
        worktreeParent: fixture.worktrees,
      });

      const registry = new ToolRegistry();
      registerSelfExtensionTools(registry);
      const record = await executeToolCall({
        registry,
        id: `replay-${proposal.id}`,
        name: 'self_improvement_replay_verified_stage',
        arguments: { proposalId: proposal.id },
        context: {
          userId: scope.userId,
          authenticated: true,
          authRole: 'admin',
          localExecution: true,
          executionBoundary: 'trusted_local',
          autonomous: true,
          taskId: runningTask!.id,
          idempotencyKey: runningTask!.idempotencyKey,
          isCancelled: () => false,
        },
      });
      expect(record.error).toBeUndefined();
      expect(JSON.parse(record.result)).toMatchObject({ status: 'verified', replayed: true });
      expect(hasVerifiedSelfImprovementStageReceipt(runningTask!, [record])).toBe(true);
      expect(evaluateAutonomousTaskOutcome(
        runningTask!.description,
        'The exact isolated documentation stage was recovered and verified.',
        [record],
        runningTask!,
      )).toMatchObject({ verified: true, blocked: false });
    } finally {
      if (runningTask?.leaseId) markFailed(runningTask.id, 'test cleanup', runningTask.leaseId);
      cleanupRepository(fixture);
    }
  });

  it('rejects symlink-mode source entries and credential-like documentation output', async () => {
    const symlinkFixture = createRepository();
    try {
      const blob = git(symlinkFixture.repo, 'hash-object', '-w', '--stdin');
      git(symlinkFixture.repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},docs/guide.md`);
      git(symlinkFixture.repo, 'commit', '-m', 'replace guide with a symlink entry');
      const scope = { userId: `self-stage-symlink-${Date.now()}-${Math.random()}` };
      const patch = patchDocumentation();
      const proposal = await createAutonomousDocumentationProposal(scope, patch);
      await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch }, {
        repoRoot: symlinkFixture.repo,
        worktreeParent: symlinkFixture.worktrees,
      })).rejects.toThrow(/regular 100644 Git blob/i);
    } finally {
      cleanupRepository(symlinkFixture);
    }

    const secretFixture = createRepository();
    try {
      const scope = { userId: `self-stage-secret-${Date.now()}-${Math.random()}` };
      const firstPatch = patchDocumentation('# Guide\n\napi_key=abcdefghijklmnop123456\n');
      const proposal = await createAutonomousDocumentationProposal(scope, firstPatch);
      const samples = [
        'api_key=abcdefghijklmnop123456',
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
        'github_pat_11AAabcdefghijklmnopqrstuvwxyz123456',
        'AKIAABCDEFGHIJKLMNOP',
        ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
        'eyJabcdefghijk.eyJabcdefghijkl.mnopqrstuvwxyz',
        'Bearer abcdefghijklmnopqrstuvwxyz123456',
        '-----BEGIN PRIVATE KEY-----',
      ];
      for (const sample of samples) {
        const secretPatch = patchDocumentation(`# Guide\n\n${sample}\n`);
        await expect(stageSelfImprovementPatch(scope, { proposalId: proposal.id, patch: secretPatch }, {
          repoRoot: secretFixture.repo,
          worktreeParent: secretFixture.worktrees,
        })).rejects.toThrow(/credential or private-key material/i);
      }
      expect(git(secretFixture.repo, 'branch', '--list', `lumi/self-improvement/${proposal.id}`)).toBe('');
    } finally {
      cleanupRepository(secretFixture);
    }
  });

  it('rejects destructive, binary, rename, and absolute patch targets', () => {
    expect(() => extractUnifiedPatchPaths('--- a/server/example.ts\n+++ /dev/null\n'))
      .toThrow(/deletion/i);
    expect(() => extractUnifiedPatchPaths('GIT binary patch\n+++ b/server/example.ts\n'))
      .toThrow(/binary/i);
    expect(() => extractUnifiedPatchPaths('rename from server/a.ts\nrename to server/b.ts\n'))
      .toThrow(/rename/i);
    expect(() => extractUnifiedPatchPaths('--- a/private/source.ts\n+++ b/server/example.ts\n'))
      .toThrow(/source and target paths differ/i);
    expect(() => extractUnifiedPatchPaths('--- a/server/example.ts\n+++ C:/secrets.txt\n'))
      .toThrow(/absolute/i);
    expect(() => extractUnifiedPatchPaths('diff --git a/docs/a.md b/docs/a.md\nold mode 100644\nnew mode 120000\n'))
      .toThrow(/mode|symlink/i);
  });
});
