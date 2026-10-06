import fs from "node:fs";
import path from "node:path";
import { authorizeSelfImprovementActivation, getSelfImprovementProposal, isAutonomousSelfImprovementDocumentationPath, recordSelfImprovementActivation, type SelfImprovementScope } from "../improvement_program";
import { acquireSelfImprovementRepositoryLease } from "../repository_identity";
import type { SelfImprovementActivationOptions, SelfImprovementActivationResult } from './contracts';
import { defaultCommandRunner, runChecked, worktreeChangePaths } from './command';
import { resolveBoundRepository, safeBranchId } from './identity';
import { ensureTrustedStagingParent, assertWithin, registeredWorktrees, sameResolvedPath } from './filesystem_boundary';
import { makeRestrictedGitContext, runRestrictedGit, runRestrictedGitProbe } from './restricted_git';
import { activateStaticDocumentationStage } from './static_activation';
import { parseNullSeparatedPaths, assertExactPathSet } from './patch_policy';
import { verifyStaticDocumentation } from './documentation_policy';

const selfImprovementActivationLocks = new Set<string>();

async function activateSelfImprovementStageInternal(
  scope: SelfImprovementScope,
  input: { proposalId: string },
  options: SelfImprovementActivationOptions = {},
): Promise<SelfImprovementActivationResult> {
  if (options.confirmed !== true) {
    throw new Error('Self-improvement activation requires explicit user confirmation bound to this verified proposal.');
  }
  const existing = getSelfImprovementProposal(scope, String(input.proposalId || ''));
  if (!existing) throw new Error('Self-improvement proposal not found in this user scope.');
  if (existing.status === 'activated' && existing.activatedCommit && existing.baseCommit && existing.stagedBranch) {
    const replayRunner = options.commandRunner || defaultCommandRunner;
    const repository = resolveBoundRepository(existing, options);
    const requestedReplayParent = path.resolve(options.worktreeParent
      || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
    const replayParent = ensureTrustedStagingParent(requestedReplayParent, repository);
    const gitContext = makeRestrictedGitContext(replayParent);
    try {
      const deliveryBranch = String(existing.deliveryBranch || '');
      const currentBranch = (await runRestrictedGit(
        replayRunner,
        repository,
        gitContext,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      )).stdout.trim();
      if (!deliveryBranch || currentBranch !== deliveryBranch) {
        throw new Error('Activated self-improvement replay is not on its recorded delivery branch.');
      }
      const ancestor = await runRestrictedGitProbe(
        replayRunner,
        repository,
        gitContext,
        ['merge-base', '--is-ancestor', existing.activatedCommit, 'HEAD'],
      );
      if (ancestor.exitCode !== 0) {
        throw new Error('The recorded activated commit is no longer contained in the delivery branch.');
      }
      const branchProbe = await runRestrictedGitProbe(
        replayRunner,
        repository,
        gitContext,
        ['show-ref', '--verify', '--quiet', `refs/heads/${existing.stagedBranch}`],
      );
      return {
        ok: true,
        status: 'activated',
        persisted: true,
        activated: true,
        pushed: false,
        proposal: existing,
        branch: deliveryBranch,
        baseCommit: existing.baseCommit,
        commit: existing.activatedCommit,
        verification: [],
        cleanup: {
          worktreeRemoved: !fs.existsSync(existing.worktreePath || ''),
          stagingBranchRemoved: branchProbe.exitCode !== 0,
        },
        replayed: true,
      };
    } finally {
      try {
        assertWithin(replayParent, gitContext.hooksPath);
        fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
      } catch {}
    }
  }

  const { proposal } = authorizeSelfImprovementActivation(scope, existing.id);
  if (proposal.target !== 'core') {
    throw new Error('Variant activation must run through the variant release train.');
  }
  const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  if (proposal.stagedBranch !== expectedBranch) throw new Error('The staged branch identity does not match this proposal.');
  if (!/^[0-9a-f]{40,64}$/i.test(proposal.baseCommit || '') || !/^[0-9a-f]{40,64}$/i.test(proposal.stagedCommit || '')) {
    throw new Error('The persisted Git activation identity is invalid.');
  }
  const autonomousStaticStage = proposal.operations.length === 1
    && proposal.operations[0] === 'documentation_change'
    && (proposal.changedPaths || []).length > 0
    && (proposal.changedPaths || []).every(isAutonomousSelfImprovementDocumentationPath)
    && Boolean(proposal.stagedTreeDigest);
  if (autonomousStaticStage) {
    return activateStaticDocumentationStage(scope, proposal, options);
  }

  const runner = options.commandRunner || defaultCommandRunner;
  const initialRoot = path.resolve(options.repoRoot || process.cwd());
  const repoRoot = path.resolve((await runChecked(runner, 'git', ['rev-parse', '--show-toplevel'], initialRoot, 30_000)).stdout.trim());
  const worktreePath = path.resolve(proposal.worktreePath!);
  const listed = registeredWorktrees((await runChecked(runner, 'git', ['worktree', 'list', '--porcelain'], repoRoot, 30_000)).stdout);
  const registered = listed.find(item => sameResolvedPath(item.path, worktreePath));
  if (!registered || registered.branch !== expectedBranch || registered.head !== proposal.stagedCommit) {
    const mismatch = !registered
      ? 'worktree_not_registered'
      : registered.branch !== expectedBranch
        ? `branch_mismatch:${registered.branch || 'detached'}`
        : `head_mismatch:${registered.head || 'missing'}`;
    throw new Error(`The verified staging worktree, branch, and commit no longer match the persisted proposal (${mismatch}).`);
  }
  const branchCommit = (await runChecked(runner, 'git', ['rev-parse', `refs/heads/${expectedBranch}`], repoRoot, 30_000)).stdout.trim();
  if (branchCommit !== proposal.stagedCommit) throw new Error('The staging branch moved after verification.');
  const stagedParent = (await runChecked(runner, 'git', ['rev-parse', `${proposal.stagedCommit}^`], repoRoot, 30_000)).stdout.trim();
  if (stagedParent !== proposal.baseCommit) throw new Error('Activation requires exactly one reviewed commit on top of the recorded base.');
  const committedPaths = parseNullSeparatedPaths((await runChecked(
    runner,
    'git',
    ['diff', '--name-only', '-z', proposal.baseCommit, proposal.stagedCommit],
    worktreePath,
    30_000,
  )).stdout);
  assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified self-improvement commit');
  const stagingStatusBeforeVerification = await worktreeChangePaths(runner, worktreePath);
  if (stagingStatusBeforeVerification.length > 0) {
    throw new Error(`The verified staging worktree is dirty: ${stagingStatusBeforeVerification.join(', ')}.`);
  }

  const liveStatus = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (liveStatus) throw new Error('The live worktree is not clean; activation stopped without changing it.');
  const currentBranch = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (!currentBranch || currentBranch === expectedBranch) throw new Error('Activation requires a normal checked-out delivery branch.');
  if (currentBranch !== proposal.deliveryBranch) {
    throw new Error(`Activation is bound to delivery branch ${proposal.deliveryBranch}; current branch is ${currentBranch}.`);
  }
  const currentHead = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (currentHead !== proposal.baseCommit && currentHead !== proposal.stagedCommit) {
    throw new Error('The live branch moved beyond the reviewed base; rebase and re-verify a new proposal instead of merging stale work.');
  }

  const profile = proposal.verificationProfile || 'standard';
  const staticDocumentation = proposal.operations.length === 1
    && proposal.operations[0] === 'documentation_change'
    && (proposal.changedPaths || []).length > 0
    && (proposal.changedPaths || []).every(isAutonomousSelfImprovementDocumentationPath);
  if (!staticDocumentation && !options.verificationRunner) {
    throw new Error('Self-improvement activation is disabled until a trusted OS sandbox runner is configured for executable re-verification.');
  }
  const verification = staticDocumentation
    ? verifyStaticDocumentation(worktreePath, profile, proposal.changedPaths || [])
    : await options.verificationRunner!(worktreePath, profile, proposal.changedPaths || []);
  if (!verification.length || verification.some(receipt => receipt.status !== 'passed' || receipt.exitCode !== 0)) {
    throw new Error('Activation re-verification did not produce an all-passing receipt set.');
  }
  const stagingStatusAfterVerification = await worktreeChangePaths(runner, worktreePath);
  if (stagingStatusAfterVerification.length > 0) {
    throw new Error(`Activation verification changed the staged worktree: ${stagingStatusAfterVerification.join(', ')}.`);
  }

  const refreshedAuthorization = authorizeSelfImprovementActivation(scope, proposal.id).proposal;
  if (
    refreshedAuthorization.stagedCommit !== proposal.stagedCommit
    || refreshedAuthorization.stagedPatchDigest !== proposal.stagedPatchDigest
    || refreshedAuthorization.deliveryBranch !== proposal.deliveryBranch
  ) {
    throw new Error('Self-improvement authorization or reviewed artifact changed during verification; activation stopped.');
  }
  const branchImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const headImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const statusImmediatelyBeforeMerge = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (
    branchImmediatelyBeforeMerge !== proposal.deliveryBranch
    || headImmediatelyBeforeMerge !== currentHead
    || statusImmediatelyBeforeMerge
  ) {
    throw new Error('The live delivery branch changed during verification; activation stopped before merge.');
  }

  if (currentHead === proposal.baseCommit) {
    await runChecked(runner, 'git', [
      '-c', 'core.hooksPath=.lumi-disabled-hooks',
      'merge', '--ff-only', proposal.stagedCommit!,
    ], repoRoot, 2 * 60_000);
  }
  const activatedHead = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  if (activatedHead !== proposal.stagedCommit) {
    throw new Error('The live branch did not reach the verified staged commit.');
  }
  const activatedBranch = (await runChecked(runner, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot, 30_000)).stdout.trim();
  const activatedStatus = (await runChecked(runner, 'git', ['status', '--porcelain', '--untracked-files=all'], repoRoot, 30_000)).stdout.trim();
  if (activatedBranch !== proposal.deliveryBranch || activatedStatus) {
    throw new Error('Activation reached the reviewed commit but the delivery branch identity or clean-state verification failed.');
  }
  const persistedProposal = await recordSelfImprovementActivation(scope, proposal.id, {
    commit: activatedHead,
    evidence: [
      ...verification.map(receipt => ({
        kind: 'activation_verification',
        ref: receipt.command,
        status: receipt.status,
        summary: receipt.summary,
      })),
      {
        kind: 'activation',
        ref: `${currentBranch}@${activatedHead}`,
        status: 'verified',
        summary: 'delivery branch fast-forwarded locally to the exact reviewed commit; no push or deployment performed',
      },
    ],
  });

  let worktreeRemoved = false;
  let stagingBranchRemoved = false;
  try {
    await runChecked(runner, 'git', ['worktree', 'remove', worktreePath], repoRoot, 60_000);
    worktreeRemoved = true;
  } catch {}
  if (worktreeRemoved) {
    try {
      await runChecked(runner, 'git', ['branch', '-d', expectedBranch], repoRoot, 30_000);
      stagingBranchRemoved = true;
    } catch {}
  }

  return {
    ok: true,
    status: 'activated',
    persisted: true,
    activated: true,
    pushed: false,
    proposal: persistedProposal,
    branch: currentBranch,
    baseCommit: proposal.baseCommit!,
    commit: activatedHead,
    verification,
    cleanup: { worktreeRemoved, stagingBranchRemoved },
  };
}

export async function activateSelfImprovementStage(
  scope: SelfImprovementScope,
  input: { proposalId: string },
  options: SelfImprovementActivationOptions = {},
): Promise<SelfImprovementActivationResult> {
  if (options.confirmed !== true) {
    return activateSelfImprovementStageInternal(scope, input, options);
  }
  const existing = getSelfImprovementProposal(scope, String(input.proposalId || ''));
  if (!existing) throw new Error('Self-improvement proposal not found in this user scope.');
  const proposal = existing.status === 'activated'
    ? existing
    : authorizeSelfImprovementActivation(scope, existing.id).proposal;
  const repository = resolveBoundRepository(proposal, options);
  const lockKey = `${repository.repositoryId}\0${proposal.deliveryBranch}`;
  if (selfImprovementActivationLocks.has(lockKey)) {
    throw new Error('This self-improvement repository and delivery branch are already being activated.');
  }
  selfImprovementActivationLocks.add(lockKey);
  let repositoryLease: ReturnType<typeof acquireSelfImprovementRepositoryLease> | undefined;
  try {
    repositoryLease = acquireSelfImprovementRepositoryLease(repository, 'activation');
    return await activateSelfImprovementStageInternal(scope, input, options);
  } finally {
    repositoryLease?.release();
    selfImprovementActivationLocks.delete(lockKey);
  }
}
