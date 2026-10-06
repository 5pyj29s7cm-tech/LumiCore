import fs from "node:fs";
import path from "node:path";
import { authorizeSelfImprovementActivation, recordSelfImprovementActivation, type SelfImprovementProposal, type SelfImprovementScope } from "../improvement_program";
import type { SelfImprovementActivationOptions, SelfImprovementActivationResult } from './contracts';
import { defaultCommandRunner } from './command';
import { resolveBoundRepository, safeBranchId } from './identity';
import { assertSafePlainStageRoot, assertWithin } from './filesystem_boundary';
import { makeRestrictedGitContext, assertNoRepositoryGitContentDrivers, runRestrictedGit, exactCommitManifest, assertStageFilesMatchCommit, assertNoGitContentTransforms, runRestrictedGitProbe } from './restricted_git';
import { parseNullSeparatedPaths, assertExactPathSet } from './patch_policy';
import { assertStaticDocumentationContent, verifyStaticDocumentation } from './documentation_policy';

export async function activateStaticDocumentationStage(
  scope: SelfImprovementScope,
  proposal: SelfImprovementProposal,
  options: SelfImprovementActivationOptions,
): Promise<SelfImprovementActivationResult> {
  const runner = options.commandRunner || defaultCommandRunner;
  const repository = resolveBoundRepository(proposal, options);
  const stageRoot = path.resolve(proposal.worktreePath!);
  const securityParent = assertSafePlainStageRoot(stageRoot, proposal, repository);
  const gitContext = makeRestrictedGitContext(securityParent);
  const expectedBranch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  const ref = `refs/heads/${expectedBranch}`;
  try {
    await assertNoRepositoryGitContentDrivers(runner, repository, gitContext);
    if (proposal.stagedBranch !== expectedBranch) throw new Error('The staged branch identity does not match this proposal.');
    const branchCommit = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', ref])).stdout.trim();
    if (branchCommit !== proposal.stagedCommit) throw new Error('The staging branch moved after verification.');
    const parent = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['rev-parse', `${proposal.stagedCommit}^`],
    )).stdout.trim();
    if (parent !== proposal.baseCommit) throw new Error('Activation requires exactly one reviewed commit on top of the recorded base.');
    const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['diff', '--no-ext-diff', '--name-only', '-z', proposal.baseCommit!, proposal.stagedCommit!],
    )).stdout);
    assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified self-improvement commit');
    const manifest = await exactCommitManifest(
      runner,
      repository,
      gitContext,
      proposal.stagedCommit!,
      proposal.changedPaths || [],
    );
    if (!proposal.stagedTreeDigest || manifest.digest !== proposal.stagedTreeDigest) {
      throw new Error('The staged documentation tree digest no longer matches the persisted verification receipt.');
    }
    assertStaticDocumentationContent(stageRoot, proposal.changedPaths || []);
    await assertStageFilesMatchCommit(runner, repository, gitContext, stageRoot, manifest.entries);
    const verification = verifyStaticDocumentation(
      stageRoot,
      proposal.verificationProfile || 'standard',
      proposal.changedPaths || [],
    );

    const liveStatus = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (liveStatus) throw new Error('The live worktree is not clean; activation stopped without changing it.');
    const currentBranch = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    if (!currentBranch || currentBranch !== proposal.deliveryBranch) {
      throw new Error(`Activation is bound to delivery branch ${proposal.deliveryBranch}; current branch is ${currentBranch || 'detached'}.`);
    }
    const currentHead = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    if (currentHead !== proposal.baseCommit && currentHead !== proposal.stagedCommit) {
      throw new Error('The live branch moved beyond the reviewed base; create and verify a new proposal instead of merging stale work.');
    }

    const refreshed = authorizeSelfImprovementActivation(scope, proposal.id).proposal;
    if (
      refreshed.stagedCommit !== proposal.stagedCommit
      || refreshed.stagedPatchDigest !== proposal.stagedPatchDigest
      || refreshed.stagedTreeDigest !== proposal.stagedTreeDigest
      || refreshed.repositoryId !== proposal.repositoryId
      || refreshed.deliveryBranch !== proposal.deliveryBranch
    ) {
      throw new Error('Self-improvement authorization or reviewed artifact changed during verification; activation stopped.');
    }
    await assertNoGitContentTransforms(runner, repository, gitContext, proposal.changedPaths || []);
    if (fs.readdirSync(gitContext.hooksPath).length > 0) {
      throw new Error('The isolated no-hooks directory changed during activation.');
    }
    const branchImmediatelyBeforeMerge = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    const headImmediatelyBeforeMerge = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    const statusImmediatelyBeforeMerge = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (
      branchImmediatelyBeforeMerge !== proposal.deliveryBranch
      || headImmediatelyBeforeMerge !== currentHead
      || statusImmediatelyBeforeMerge
    ) {
      throw new Error('The live delivery branch changed during verification; activation stopped before merge.');
    }

    if (currentHead === proposal.baseCommit) {
      await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['merge', '--ff-only', '--no-edit', proposal.stagedCommit!],
        repository.root,
        2 * 60_000,
      );
    }
    const activatedHead = (await runRestrictedGit(runner, repository, gitContext, ['rev-parse', 'HEAD'])).stdout.trim();
    const activatedBranch = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    )).stdout.trim();
    const activatedStatus = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['status', '--porcelain', '--untracked-files=all'],
    )).stdout.trim();
    if (activatedHead !== proposal.stagedCommit || activatedBranch !== proposal.deliveryBranch || activatedStatus) {
      throw new Error('Activation did not reach the exact verified commit on a clean delivery branch.');
    }
    const finalManifest = await exactCommitManifest(
      runner,
      repository,
      gitContext,
      activatedHead,
      proposal.changedPaths || [],
    );
    if (finalManifest.digest !== proposal.stagedTreeDigest) {
      throw new Error('Activated commit tree does not match the reviewed tree digest.');
    }
    const persistedProposal = await recordSelfImprovementActivation(scope, proposal.id, {
      commit: activatedHead,
      evidence: [
        ...verification.map(receipt => ({
          kind: 'activation_verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
        })),
        {
          kind: 'activation',
          ref: `${proposal.deliveryBranch}@${activatedHead}`,
          status: 'verified',
          summary: 'delivery branch fast-forwarded locally to the exact reviewed documentation tree; no push or deployment performed',
        },
      ],
    });

    let worktreeRemoved = false;
    let stagingBranchRemoved = false;
    const cleanupRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
    worktreeRemoved = !fs.existsSync(cleanupRoot);
    if (worktreeRemoved) {
      const deletion = await runRestrictedGitProbe(
        runner,
        repository,
        gitContext,
        ['update-ref', '-d', ref, proposal.stagedCommit!],
      );
      stagingBranchRemoved = deletion.exitCode === 0;
    }
    return {
      ok: true,
      status: 'activated',
      persisted: true,
      activated: true,
      pushed: false,
      proposal: persistedProposal,
      branch: proposal.deliveryBranch!,
      baseCommit: proposal.baseCommit!,
      commit: activatedHead,
      verification,
      cleanup: { worktreeRemoved, stagingBranchRemoved },
    };
  } finally {
    try {
      assertWithin(securityParent, gitContext.hooksPath);
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}
