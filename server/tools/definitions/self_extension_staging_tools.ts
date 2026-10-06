import crypto from 'node:crypto';
import { canUseQueuedSelfImprovementStageAuthorization, enqueueSelfImprovementProposal, getSelfImprovementProposal, recordSelfImprovementPatchReview } from '../../self_extension/improvement_program';
import { activateSelfImprovementStage, replayVerifiedSelfImprovementStage, stageSelfImprovementPatch } from '../../self_extension/staging';
import type { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { selfImprovementScope, registerLocalSelfImprovementTool } from './self_extension_shared';

export function registerSelfExtensionStagingTools(registry: ToolRegistry): void {
  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_replay_verified_stage',
    description: 'Recover an exact terminal receipt for this same durable task when static documentation staging was already persisted before a worker restart. It revalidates the repository, task, ref, parent commit, path set, tree digest, and isolated files; it does not regenerate a patch, activate, push, or deploy.',
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
    },
    handler: async (args, context) => {
      const proposalId = String(args.proposalId || '');
      const taskId = String(context?.taskId || '');
      if (context?.autonomous !== true || !canUseQueuedSelfImprovementStageAuthorization(
        selfImprovementScope(context),
        proposalId,
        taskId,
      )) {
        throw new Error('Verified stage replay requires the same live, locally authorized durable task lease.');
      }
      return JSON.stringify(await replayVerifiedSelfImprovementStage(
        selfImprovementScope(context),
        { proposalId, taskId },
        { isCancelled: context?.isCancelled },
      ), null, 2);
    },
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'self-improvement.patch.replay-verified-stage',
      family: 'self-improvement',
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'isolated', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'proposal.taskId', 'baseCommit', 'branch', 'commit', 'treeDigest', 'repositoryId', 'worktreePath', 'changedPaths', 'verification', 'replayed'],
        requiredValues: {
          ok: true,
          status: 'verified',
          persisted: true,
          isolated: true,
          activated: false,
          pushed: false,
          replayed: true,
          'proposal.status': 'verified',
        },
        successStatuses: ['verified'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['the exact persisted task-bound static stage was revalidated without repeating its write side effect'],
        limitations: ['This proves only the already-persisted isolated stage; activation and publication remain separate reviewed workflows.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.replay-verified-stage',
      operation: 'observe',
      subjectArgument: 'proposalId',
    }),
  });

  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_stage_patch',
    description: 'Apply one authorized unified diff in a separate Git worktree, run the proposal\'s fixed verification profile, and optionally create a local isolated commit. The live worktree is never modified; activation, push, deployment, dependency changes, secret paths, undeclared files, deletions, and unverified results are rejected.',
    parameters: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Persisted proposal id bound to the current authorization revision.' },
        patch: { type: 'string', description: 'Text-only unified diff whose exact target paths match the reviewed proposal.' },
        commitMessage: { type: 'string', description: 'Optional local isolated commit message.' },
        expectedBaseCommit: { type: 'string', description: 'Exact base commit returned by self_improvement_read_scope.' },
        expectedDeliveryBranch: { type: 'string', description: 'Exact delivery branch returned by self_improvement_read_scope.' },
      },
      required: ['proposalId', 'patch', 'expectedBaseCommit', 'expectedDeliveryBranch'],
    },
    handler: async (args, context) => {
      const proposalId = String(args.proposalId || '');
      const patch = String(args.patch || '');
      const expectedBaseCommit = String(args.expectedBaseCommit || '').trim().toLowerCase();
      const expectedDeliveryBranch = String(args.expectedDeliveryBranch || '').trim();
      const proposal = getSelfImprovementProposal(selfImprovementScope(context), proposalId);
      if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
      const expectedHashLength = proposal.repositoryObjectFormat === 'sha256' ? 64 : 40;
      if (!new RegExp(`^[0-9a-f]{${expectedHashLength}}$`, 'i').test(expectedBaseCommit)) {
        throw new Error('Self-improvement staging requires the exact non-empty base commit returned by scope inspection.');
      }
      if (
        !expectedDeliveryBranch
        || expectedDeliveryBranch.startsWith('-')
        || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(expectedDeliveryBranch)
        || expectedDeliveryBranch.includes('..')
        || expectedDeliveryBranch.includes('@{')
      ) {
        throw new Error('Self-improvement staging requires a valid non-empty delivery branch returned by scope inspection.');
      }
      if (context?.autonomous === true && !canUseQueuedSelfImprovementStageAuthorization(
        selfImprovementScope(context),
        proposalId,
        String(context.taskId || ''),
      )) {
        throw new Error('Autonomous self-improvement staging lost its exact queued task authorization or lease.');
      }
      if (proposal.evaluation.decision === 'eligible_supervised') {
        if (context?.userConfirmed !== true) {
          throw new Error('Supervised self-improvement requires foreground confirmation of the exact patch and pinned Git identity.');
        }
        await recordSelfImprovementPatchReview(selfImprovementScope(context), proposalId, {
          patchDigest: crypto.createHash('sha256').update(patch).digest('hex'),
          baseCommit: expectedBaseCommit,
          deliveryBranch: expectedDeliveryBranch,
          verificationProfile: proposal.verificationProfile || 'standard',
        });
      }
      return JSON.stringify(await stageSelfImprovementPatch(
        selfImprovementScope(context),
        {
          proposalId,
          patch,
          commitMessage: args.commitMessage ? String(args.commitMessage) : undefined,
          expectedBaseCommit,
          expectedDeliveryBranch,
        },
        { isCancelled: context?.isCancelled },
      ), null, 2);
    },
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.patch.stage',
      family: 'self-improvement',
      lane: 'system',
      operation: 'create',
      risk: 'high',
      sideEffects: [
        { type: 'process_execution', scope: 'fixed Git and verification commands in an isolated worktree', reversible: true },
        { type: 'local_write', scope: 'isolated self-improvement worktree and optional local branch commit', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'isolated', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'baseCommit', 'branch', 'worktreePath', 'changedPaths', 'verification'],
        requiredValues: {
          ok: true,
          status: 'verified',
          persisted: true,
          isolated: true,
          activated: false,
          pushed: false,
          'proposal.status': 'verified',
        },
        successStatuses: ['verified'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['patch paths match the reviewed scope and every fixed verification command passed before the isolated receipt was persisted'],
        limitations: ['A verified isolated branch is not activated, merged, pushed, deployed, or proven safe in the running desktop instance.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.stage',
      operation: 'create',
      subjectArgument: 'proposalId',
      limitations: ['Activation and remote publication require separate reviewed workflows.'],
    }),
  });

  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_queue',
    description: 'Queue one persisted, currently authorized improvement proposal for durable execution. Supervised proposals require this exact confirmed call. The worker may stage only in isolation and can never activate, push, deploy, or touch secrets.',
    parameters: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
    },
    handler: async (args, context) => {
      const result = await enqueueSelfImprovementProposal(
        selfImprovementScope(context),
        String(args.proposalId || ''),
        { reviewed: true, localAdminAuthorized: true },
      );
      return JSON.stringify({
        ok: true,
        status: 'queued',
        persisted: true,
        proposal: result.proposal,
        task: { id: result.task.id, status: result.task.status, idempotencyKey: result.task.idempotencyKey },
      }, null, 2);
    },
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.proposal.queue',
      family: 'self-improvement',
      lane: 'system',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'durable autonomous task queue', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'proposal.id', 'proposal.taskId', 'task.id', 'task.status'],
        requiredValues: { ok: true, status: 'queued', persisted: true, 'task.status': 'pending' },
        successStatuses: ['queued'],
        successSignals: ['the proposal is bound to a persisted pending task with an idempotency key'],
        limitations: ['Queueing does not prove the patch was staged, tested, committed, activated, or pushed.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.proposal.queue',
      operation: 'create',
      subjectArgument: 'proposalId',
    }),
  });

  registerLocalSelfImprovementTool(registry, {
    name: 'self_improvement_activate',
    description: 'After exact user confirmation, re-verify one isolated local self-improvement commit and fast-forward the currently checked-out clean delivery branch only when it still equals the reviewed base. This never pushes, deploys, rebases, overwrites local changes, or activates variant repositories.',
    parameters: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Verified proposal id whose exact staged commit should be activated locally.' },
        expectedRepositoryId: { type: 'string', description: 'Exact trusted repository identity shown for confirmation.' },
        expectedBaseCommit: { type: 'string', description: 'Exact reviewed base commit.' },
        expectedDeliveryBranch: { type: 'string', description: 'Exact live branch allowed to fast-forward.' },
        expectedStagedBranch: { type: 'string', description: 'Exact isolated staging branch.' },
        expectedStagedCommit: { type: 'string', description: 'Exact verified commit to activate.' },
        expectedTreeDigest: { type: 'string', description: 'Exact SHA-256 manifest digest of reviewed paths.' },
        expectedPatchDigest: { type: 'string', description: 'Exact SHA-256 digest of the staged patch.' },
        expectedVerificationProfile: { type: 'string', enum: ['targeted', 'standard', 'full'] },
        expectedChangedPaths: { type: 'array', items: { type: 'string' }, description: 'Exact reviewed repository-relative path set.' },
      },
      required: [
        'proposalId', 'expectedRepositoryId', 'expectedBaseCommit', 'expectedDeliveryBranch',
        'expectedStagedBranch', 'expectedStagedCommit', 'expectedTreeDigest', 'expectedPatchDigest',
        'expectedVerificationProfile', 'expectedChangedPaths',
      ],
    },
    handler: async (args, context) => {
      if (context?.userConfirmed !== true) {
        throw new Error('Self-improvement activation requires explicit confirmation for the exact verified proposal.');
      }
      const scope = selfImprovementScope(context);
      const proposalId = String(args.proposalId || '');
      const proposal = getSelfImprovementProposal(scope, proposalId);
      if (!proposal) throw new Error('Self-improvement proposal not found in this user scope.');
      const expectedPaths = Array.isArray(args.expectedChangedPaths)
        ? args.expectedChangedPaths.map(String).sort()
        : [];
      const actualPaths = (proposal.changedPaths || []).map(String).sort();
      const exactIdentity = (
        String(args.expectedRepositoryId || '') === String(proposal.repositoryId || '')
        && String(args.expectedBaseCommit || '') === String(proposal.baseCommit || '')
        && String(args.expectedDeliveryBranch || '') === String(proposal.deliveryBranch || '')
        && String(args.expectedStagedBranch || '') === String(proposal.stagedBranch || '')
        && String(args.expectedStagedCommit || '') === String(proposal.stagedCommit || '')
        && String(args.expectedTreeDigest || '') === String(proposal.stagedTreeDigest || '')
        && String(args.expectedPatchDigest || '') === String(proposal.stagedPatchDigest || '')
        && String(args.expectedVerificationProfile || '') === String(proposal.verificationProfile || 'standard')
        && JSON.stringify(expectedPaths) === JSON.stringify(actualPaths)
      );
      if (!exactIdentity) {
        throw new Error('Self-improvement activation confirmation does not match the exact repository, commit, tree, patch, branch, profile, and path set.');
      }
      return JSON.stringify(await activateSelfImprovementStage(
        scope,
        { proposalId },
        { confirmed: true },
      ), null, 2);
    },
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'self-improvement.patch.activate',
      family: 'self-improvement',
      lane: 'system',
      operation: 'mutate',
      risk: 'critical',
      sideEffects: [
        { type: 'process_execution', scope: 'fixed Git and verification commands for the reviewed proposal', reversible: true },
        { type: 'local_write', scope: 'fast-forward the clean checked-out delivery branch to the exact verified commit', reversible: true },
        { type: 'local_state_change', scope: 'persisted self-improvement activation receipt', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'activated', 'pushed', 'proposal.id', 'proposal.status', 'proposal.activatedCommit', 'branch', 'baseCommit', 'commit', 'verification', 'cleanup'],
        requiredValues: {
          ok: true,
          status: 'activated',
          persisted: true,
          activated: true,
          pushed: false,
          'proposal.status': 'activated',
        },
        successStatuses: ['activated'],
        failureStatuses: ['blocked', 'failed', 'unverified'],
        successSignals: ['the clean delivery branch reaches the exact staged commit after a fresh all-passing verification run'],
        limitations: ['Activation is local only. It does not push, deploy, publish, or prove the packaged desktop runtime.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'self-improvement.patch.activate',
      operation: 'mutate',
      subjectArgument: 'proposalId',
      limitations: ['Remote publication and runtime release remain separate reviewed workflows.'],
    }),
  });
}
