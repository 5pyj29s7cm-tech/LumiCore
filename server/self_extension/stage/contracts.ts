import type { SelfImprovementProposal } from "../improvement_program";

export interface SelfImprovementVerificationReceipt {
  profile: 'targeted' | 'standard' | 'full';
  command: string;
  status: 'passed';
  exitCode: 0;
  durationMs: number;
  outputDigest: string;
  summary: string;
}

export interface SelfImprovementStageResult {
  ok: true;
  status: 'verified';
  persisted: true;
  isolated: true;
  activated: false;
  pushed: false;
  proposal: SelfImprovementProposal;
  baseCommit: string;
  branch: string;
  commit?: string;
  worktreePath: string;
  changedPaths: string[];
  repositoryId?: string;
  treeDigest?: string;
  verification: SelfImprovementVerificationReceipt[];
  replayed?: boolean;
}

export interface SelfImprovementActivationResult {
  ok: true;
  status: 'activated';
  persisted: true;
  activated: true;
  pushed: false;
  proposal: SelfImprovementProposal;
  branch: string;
  baseCommit: string;
  commit: string;
  verification: SelfImprovementVerificationReceipt[];
  cleanup: { worktreeRemoved: boolean; stagingBranchRemoved: boolean };
  replayed?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

type VerificationRunner = (
  worktreePath: string,
  profile: 'targeted' | 'standard' | 'full',
  changedPaths: string[],
) => Promise<SelfImprovementVerificationReceipt[]>;

export interface SelfImprovementStagingOptions {
  repoRoot?: string;
  worktreeParent?: string;
  commandRunner?: CommandRunner;
  verificationRunner?: VerificationRunner;
  /** Cooperative cancellation/lease guard supplied by the durable task runtime. */
  isCancelled?: () => boolean;
}

export interface SelfImprovementActivationOptions extends SelfImprovementStagingOptions {
  confirmed?: boolean;
}

export interface GitBlobEntry {
  path: string;
  mode: string;
  type: string;
  objectId: string;
}
