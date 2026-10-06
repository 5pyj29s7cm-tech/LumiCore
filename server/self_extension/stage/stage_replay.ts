import type { SelfImprovementProposal } from "../improvement_program";
import type { SelfImprovementRepositoryIdentity } from "../repository_identity";
import type { SelfImprovementStageResult, CommandRunner } from './contracts';
import type { makeRestrictedGitContext } from './restricted_git';
import { runRestrictedGit, exactCommitManifest, assertStageFilesMatchCommit } from './restricted_git';
import { parseNullSeparatedPaths, assertExactPathSet } from './patch_policy';
import { assertStaticDocumentationContent } from './documentation_policy';

export function replayedStageResult(
  proposal: SelfImprovementProposal,
  repositoryId: string,
  treeDigest?: string,
): SelfImprovementStageResult {
  return {
    ok: true,
    status: 'verified',
    persisted: true,
    isolated: true,
    activated: false,
    pushed: false,
    proposal,
    baseCommit: proposal.baseCommit!,
    branch: proposal.stagedBranch!,
    commit: proposal.stagedCommit,
    worktreePath: proposal.worktreePath!,
    changedPaths: proposal.changedPaths || [],
    repositoryId,
    ...(treeDigest === undefined ? {} : { treeDigest }),
    verification: (proposal.evidence || [])
      .filter(item => item.kind === 'verification')
      .map(item => ({
        profile: proposal.verificationProfile || 'standard',
        command: item.ref,
        status: 'passed',
        exitCode: 0,
        durationMs: 0,
        outputDigest: '',
        summary: item.summary,
      })),
    replayed: true,
  };
}

export async function verifyStaticStageReplay(
  proposal: SelfImprovementProposal,
  runner: CommandRunner,
  repository: SelfImprovementRepositoryIdentity,
  gitContext: ReturnType<typeof makeRestrictedGitContext>,
): Promise<string> {
  const branchCommit = (await runRestrictedGit(
    runner,
    repository,
    gitContext,
    ['rev-parse', `refs/heads/${proposal.stagedBranch}`],
  )).stdout.trim();
  if (branchCommit !== proposal.stagedCommit) throw new Error('Verified self-improvement branch moved after staging.');
  const parent = (await runRestrictedGit(
    runner,
    repository,
    gitContext,
    ['rev-parse', `${proposal.stagedCommit}^`],
  )).stdout.trim();
  if (parent !== proposal.baseCommit) throw new Error('Verified self-improvement commit parent no longer matches its base.');
  const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
    runner,
    repository,
    gitContext,
    ['diff', '--no-ext-diff', '--name-only', '-z', proposal.baseCommit!, proposal.stagedCommit!],
  )).stdout);
  assertExactPathSet(committedPaths, proposal.changedPaths || [], 'Verified replay commit');
  const manifest = await exactCommitManifest(
    runner,
    repository,
    gitContext,
    proposal.stagedCommit!,
    proposal.changedPaths || [],
  );
  if (manifest.digest !== proposal.stagedTreeDigest) {
    throw new Error('Verified self-improvement tree digest no longer matches the persisted receipt.');
  }
  assertStaticDocumentationContent(proposal.worktreePath!, proposal.changedPaths || []);
  await assertStageFilesMatchCommit(
    runner,
    repository,
    gitContext,
    proposal.worktreePath!,
    manifest.entries,
  );
  return manifest.digest;
}
