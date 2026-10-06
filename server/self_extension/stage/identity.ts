import crypto from "node:crypto";
import type { SelfImprovementProposal } from "../improvement_program";
import { resolveTrustedSelfImprovementRepository, sameSelfImprovementRepository, type SelfImprovementRepositoryIdentity } from "../repository_identity";
import type { SelfImprovementStagingOptions } from './contracts';

export function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeBranchId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function assertStagingMayContinue(options: SelfImprovementStagingOptions): void {
  if (options.isCancelled?.()) {
    throw new Error('Self-improvement staging stopped because its durable task was cancelled, paused, or lost its execution lease.');
  }
}

function repositoryIdentityFromProposal(proposal: SelfImprovementProposal) {
  if (
    !proposal.repositoryId
    || !proposal.repositoryRoot
    || !proposal.repositoryOrigin
    || !proposal.repositoryObjectFormat
  ) {
    throw new Error('Self-improvement proposal is missing its trusted repository identity.');
  }
  return {
    repositoryId: proposal.repositoryId,
    root: proposal.repositoryRoot,
    origin: proposal.repositoryOrigin,
    objectFormat: proposal.repositoryObjectFormat,
  };
}

export function resolveBoundRepository(
  proposal: SelfImprovementProposal,
  options: SelfImprovementStagingOptions,
): SelfImprovementRepositoryIdentity {
  const explicitRoot = options.repoRoot && (
    process.env.NODE_ENV === 'test'
    || Boolean(options.commandRunner)
    || Boolean(options.verificationRunner)
  ) ? options.repoRoot : undefined;
  const repository = resolveTrustedSelfImprovementRepository(explicitRoot);
  if (!sameSelfImprovementRepository(repositoryIdentityFromProposal(proposal), repository)) {
    throw new Error('The active repository does not match the repository identity persisted with this proposal.');
  }
  return repository;
}
