import fs from "node:fs";
import path from "node:path";
import { authorizeSelfImprovementStage, isSelfImprovementVerificationConfigurationPath, recordSelfImprovementStage, type SelfImprovementScope } from "./improvement_program";
import type { SelfImprovementStagingOptions, SelfImprovementStageResult } from './stage/contracts';
import { assertStagingMayContinue, digest, resolveBoundRepository, safeBranchId } from './stage/identity';
import { extractUnifiedPatchPaths, assertExactPathSet, parseNullSeparatedPaths } from './stage/patch_policy';
import { defaultCommandRunner, runChecked, worktreeChangePaths } from './stage/command';
import { ensureTrustedStagingParent, registeredWorktrees, sameResolvedPath, assertWithin, snapshotReviewedFiles, assertSafePlainStageRoot } from './stage/filesystem_boundary';
import { makeRestrictedGitContext, assertNoRepositoryGitContentDrivers, runRestrictedGit, cleanupFailedWorktree } from './stage/restricted_git';
import { replayedStageResult, verifyStaticStageReplay } from './stage/stage_replay';
import { stageAutonomousStaticDocumentation } from './stage/static_staging';

export type { SelfImprovementVerificationReceipt } from './stage/contracts';
export type { SelfImprovementStageResult } from './stage/contracts';
export type { SelfImprovementActivationResult } from './stage/contracts';
export type { SelfImprovementStagingOptions } from './stage/contracts';
export type { SelfImprovementActivationOptions } from './stage/contracts';
export { extractUnifiedPatchPaths } from './stage/patch_policy';
export { activateSelfImprovementStage } from './stage/activation';

export async function stageSelfImprovementPatch(
  scope: SelfImprovementScope,
  input: {
    proposalId: string;
    patch: string;
    commitMessage?: string;
    expectedBaseCommit?: string;
    expectedDeliveryBranch?: string;
  },
  options: SelfImprovementStagingOptions = {},
): Promise<SelfImprovementStageResult> {
  assertStagingMayContinue(options);
  const patchText = String(input.patch || '');
  const patchDigest = digest(patchText);
  const authorization = authorizeSelfImprovementStage(scope, String(input.proposalId || ''), {
    reviewedPatchDigest: patchDigest,
  });
  const { program, proposal } = authorization;
  if (proposal.target !== 'core') {
    throw new Error('Variant source staging must run through the variant release train so the correct repository and delivery branch are verified.');
  }
  const unsupportedOperations = proposal.operations.filter(operation => ![
    'code_change',
    'test_change',
    'documentation_change',
    'git_commit',
  ].includes(operation));
  if (unsupportedOperations.length > 0) {
    throw new Error(`Self-improvement staging does not support reviewed high-impact operations: ${unsupportedOperations.join(', ')}.`);
  }
  const patchBytes = Buffer.byteLength(patchText, 'utf8');
  if (patchBytes > program.maxPatchBytes) throw new Error('Patch exceeds the authorized byte budget.');
  const changedPaths = extractUnifiedPatchPaths(patchText);
  const verificationConfigurationPaths = changedPaths.filter(isSelfImprovementVerificationConfigurationPath);
  if (verificationConfigurationPaths.length > 0) {
    throw new Error(`Self-improvement staging cannot modify executable verification or dependency configuration: ${verificationConfigurationPaths.join(', ')}.`);
  }
  const profile = proposal.verificationProfile || 'standard';
  const changedTests = changedPaths.filter(file => /^test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
  if (profile === 'targeted' && proposal.operations.includes('code_change') && changedTests.length === 0) {
    throw new Error('Targeted self-improvement code changes must include an exact changed test path; otherwise use the standard or full verification profile.');
  }
  if (changedPaths.length > program.maxFilesPerChange) throw new Error('Patch exceeds the authorized file budget.');
  const declaredPaths = new Set(proposal.changedPaths || []);
  const unexpected = changedPaths.filter(file => !declaredPaths.has(file));
  const missing = [...declaredPaths].filter(file => !changedPaths.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      ...(unexpected.length > 0 ? [`undeclared: ${unexpected.join(', ')}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ];
    throw new Error(`Patch paths do not exactly match the reviewed proposal (${details.join('; ')}).`);
  }

  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const repoRoot = repository.root;
  const requestedIdentityParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repoRoot), '.lumi-self-improvement', path.basename(repoRoot)));
  const identityParent = ensureTrustedStagingParent(requestedIdentityParent, repository);
  const identityGitContext = makeRestrictedGitContext(identityParent);
  await assertNoRepositoryGitContentDrivers(runner, repository, identityGitContext);
  const baseCommit = (await runRestrictedGit(runner, repository, identityGitContext, ['rev-parse', 'HEAD'])).stdout.trim();
  const deliveryBranch = (await runRestrictedGit(
    runner,
    repository,
    identityGitContext,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  )).stdout.trim();
  if (!deliveryBranch) throw new Error('Self-improvement staging requires a normal checked-out delivery branch.');
  if (input.expectedBaseCommit && input.expectedBaseCommit !== baseCommit) {
    throw new Error('The repository HEAD changed after the self-improvement scope was inspected.');
  }
  if (input.expectedDeliveryBranch && input.expectedDeliveryBranch !== deliveryBranch) {
    throw new Error('The delivery branch changed after the self-improvement scope was inspected.');
  }
  if (authorization.evaluation.decision === 'eligible_supervised' && (
    proposal.reviewedBaseCommit !== baseCommit
    || proposal.reviewedDeliveryBranch !== deliveryBranch
    || proposal.reviewedVerificationProfile !== profile
  )) {
    throw new Error('The supervised patch review is not bound to this exact base commit, delivery branch, and verification profile.');
  }
  const autonomousStaticDocumentation = authorization.evaluation.decision === 'eligible_autonomous';
  if (proposal.status === 'verified' && proposal.worktreePath && proposal.baseCommit) {
    try {
      if (!proposal.stagedPatchDigest || proposal.stagedPatchDigest !== patchDigest) {
        throw new Error('Verified self-improvement replay requires the exact previously staged patch digest.');
      }
      if (!autonomousStaticDocumentation) {
        if (!proposal.stagedCommit || !proposal.stagedBranch) {
          throw new Error('Verified executable self-improvement replay is missing its exact commit identity.');
        }
        const listed = registeredWorktrees((await runChecked(
          runner,
          'git',
          ['worktree', 'list', '--porcelain'],
          repoRoot,
          30_000,
        )).stdout);
        const registered = listed.find(item => sameResolvedPath(item.path, proposal.worktreePath!));
        if (!registered || registered.branch !== proposal.stagedBranch || registered.head !== proposal.stagedCommit) {
          throw new Error('Verified executable self-improvement worktree no longer matches its persisted branch and commit.');
        }
        const status = await worktreeChangePaths(runner, proposal.worktreePath);
        if (status.length > 0) throw new Error('Verified executable self-improvement worktree is no longer clean.');
        return replayedStageResult(proposal, repository.repositoryId);
      }
      if (!proposal.stagedCommit || !proposal.stagedBranch || !proposal.stagedTreeDigest) {
        throw new Error('Verified self-improvement replay is missing its exact commit and tree identity.');
      }
      const treeDigest = await verifyStaticStageReplay(proposal, runner, repository, identityGitContext);
      return replayedStageResult(proposal, repository.repositoryId, treeDigest);
    } finally {
      try {
        assertWithin(identityParent, identityGitContext.hooksPath);
        fs.rmSync(identityGitContext.hooksPath, { recursive: true, force: true });
      } catch {}
    }
  }
  try {
    if (autonomousStaticDocumentation) {
      return await stageAutonomousStaticDocumentation({
        scope,
        program,
        proposal,
        patchText,
        patchDigest,
        changedPaths,
        profile,
        baseCommit,
        deliveryBranch,
        repository,
        runner,
        options,
        commitMessage: input.commitMessage,
      });
    }
  } finally {
    try {
      assertWithin(identityParent, identityGitContext.hooksPath);
      fs.rmSync(identityGitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
  if (!options.verificationRunner) {
    throw new Error('Executable self-improvement verification is disabled until a trusted OS sandbox runner is configured; use supervised external review.');
  }
  const requestedWorktreeParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repoRoot), '.lumi-self-improvement', path.basename(repoRoot)));
  const worktreeParent = ensureTrustedStagingParent(requestedWorktreeParent, repository);
  const worktreePath = path.join(worktreeParent, safeBranchId(proposal.id));
  assertWithin(worktreeParent, worktreePath);
  if (fs.existsSync(worktreePath)) throw new Error('The isolated self-improvement worktree already exists without a verified persisted receipt.');
  fs.mkdirSync(worktreeParent, { recursive: true });
  const patchDirectory = path.join(worktreeParent, 'patches');
  fs.mkdirSync(patchDirectory, { recursive: true });
  const patchPath = path.join(patchDirectory, `${safeBranchId(proposal.id)}.patch`);
  assertWithin(worktreeParent, patchPath);
  fs.writeFileSync(patchPath, patchText, { encoding: 'utf8', flag: 'wx' });
  const branch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  let worktreeCreated = false;
  let branchCreated = false;
  try {
    await runChecked(runner, 'git', ['worktree', 'add', '--detach', worktreePath, baseCommit], repoRoot, 2 * 60_000);
    worktreeCreated = true;
    await runChecked(runner, 'git', ['switch', '-c', branch], worktreePath, 30_000);
    branchCreated = true;
    await runChecked(runner, 'git', ['apply', '--check', '--whitespace=error-all', patchPath], worktreePath, 60_000);
    await runChecked(runner, 'git', ['apply', '--whitespace=error-all', patchPath], worktreePath, 60_000);
    fs.rmSync(patchPath, { force: true });
    const actualPaths = await worktreeChangePaths(runner, worktreePath);
    assertExactPathSet(actualPaths, changedPaths, 'Applied patch');
    const reviewedContentSnapshot = snapshotReviewedFiles(worktreePath, changedPaths);
    const verification = await options.verificationRunner(worktreePath, profile, changedPaths);
    if (!verification.length || verification.some(receipt => receipt.status !== 'passed' || receipt.exitCode !== 0)) {
      throw new Error('Self-improvement verification did not produce an all-passing receipt set.');
    }
    const postVerificationPaths = await worktreeChangePaths(runner, worktreePath);
    assertExactPathSet(postVerificationPaths, changedPaths, 'Post-verification worktree');
    if (snapshotReviewedFiles(worktreePath, changedPaths) !== reviewedContentSnapshot) {
      throw new Error('Verification changed reviewed file contents after the patch was applied; staging stopped.');
    }
    let commit: string | undefined;
    if (program.allowLocalCommit && proposal.operations.includes('git_commit')) {
      assertStagingMayContinue(options);
      await runChecked(runner, 'git', ['add', '--', ...changedPaths], worktreePath, 30_000);
      const message = `improve: verified proposal ${safeBranchId(proposal.id)}`;
      await runChecked(runner, 'git', [
        '-c', 'user.name=Lumi Self-Improvement',
        '-c', 'user.email=lumi-self-improvement@localhost',
        '-c', 'core.hooksPath=.lumi-disabled-hooks',
        'commit', '-m', message,
      ], worktreePath, 2 * 60_000);
      commit = (await runChecked(runner, 'git', ['rev-parse', 'HEAD'], worktreePath, 30_000)).stdout.trim();
      const committedPaths = parseNullSeparatedPaths((await runChecked(
        runner,
        'git',
        ['diff', '--name-only', '-z', baseCommit, commit],
        worktreePath,
        30_000,
      )).stdout);
      assertExactPathSet(committedPaths, changedPaths, 'Committed self-improvement');
      const postCommitPaths = await worktreeChangePaths(runner, worktreePath);
      if (postCommitPaths.length > 0) {
        throw new Error(`Self-improvement commit left undeclared worktree changes: ${postCommitPaths.join(', ')}.`);
      }
    }
    const evidence = [
      { kind: 'git', ref: branch, status: 'isolated', summary: `isolated branch at base ${baseCommit}` },
      ...verification.map(receipt => ({
        kind: 'verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
      })),
      ...(commit ? [{ kind: 'commit', ref: commit, status: 'verified', summary: 'local isolated commit created after verification' }] : []),
    ];
    assertStagingMayContinue(options);
    const persistedProposal = await recordSelfImprovementStage(scope, proposal.id, {
      status: 'verified', baseCommit, worktreePath, branch, commit, patchDigest,
      stagingProtocol: 'supervised_worktree_v1', deliveryBranch, evidence,
    });
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      isolated: true,
      activated: false,
      pushed: false,
      proposal: persistedProposal,
      baseCommit,
      branch,
      commit,
      worktreePath,
      changedPaths,
      verification,
    };
  } catch (error) {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    if (worktreeCreated) await cleanupFailedWorktree(runner, repoRoot, worktreePath, branch, branchCreated);
    throw error;
  }
}

/**
 * Reconstruct a terminal receipt after a crash that happened after durable
 * static staging but before the autonomous task recorded its tool receipt.
 * No patch bytes are needed: every persisted Git/ref/tree/path/task binding is
 * revalidated against the trusted repository before the receipt is returned.
 */
export async function replayVerifiedSelfImprovementStage(
  scope: SelfImprovementScope,
  input: { proposalId: string; taskId: string },
  options: SelfImprovementStagingOptions = {},
): Promise<SelfImprovementStageResult> {
  assertStagingMayContinue(options);
  const { evaluation, proposal } = authorizeSelfImprovementStage(scope, String(input.proposalId || ''));
  if (
    evaluation.decision !== 'eligible_autonomous'
    || proposal.status !== 'verified'
    || proposal.taskId !== String(input.taskId || '')
    || proposal.stagingProtocol !== 'static_git_plumbing_v1'
    || !proposal.worktreePath
    || !proposal.baseCommit
    || !proposal.stagedBranch
    || !proposal.stagedCommit
    || !proposal.stagedTreeDigest
  ) {
    throw new Error('No exact task-bound verified autonomous stage is available for durable replay.');
  }
  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const requestedParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
  const identityParent = ensureTrustedStagingParent(requestedParent, repository);
  const gitContext = makeRestrictedGitContext(identityParent);
  try {
    await assertNoRepositoryGitContentDrivers(runner, repository, gitContext);
    assertSafePlainStageRoot(proposal.worktreePath, proposal, repository);
    const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
    if (proposal.stagedBranch !== expectedBranch) throw new Error('Verified replay branch identity is invalid.');
    const treeDigest = await verifyStaticStageReplay(proposal, runner, repository, gitContext);
    assertStagingMayContinue(options);
    return replayedStageResult(proposal, repository.repositoryId, treeDigest);
  } finally {
    try {
      assertWithin(identityParent, gitContext.hooksPath);
      const hooksStat = fs.lstatSync(gitContext.hooksPath);
      if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) throw new Error('Unsafe restricted hooks cleanup target.');
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}
