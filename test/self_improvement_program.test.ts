import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  authorizeSelfImprovementStage,
  canUseQueuedSelfImprovementStageAuthorization,
  createSelfImprovementProposal,
  enqueueSelfImprovementProposal,
  evaluateSelfImprovementRequest,
  getSelfImprovementProgram,
  listSelfImprovementProposals,
  recordSelfImprovementPatchReview,
  updateSelfImprovementProgram,
} from '../server/self_extension/improvement_program';
import { markFailed, markRunning, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';

beforeAll(async () => {
  await initDatabase();
});

function userId(label: string): string {
  return `self-improvement-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('durable self-improvement program', () => {
  it('fails closed until the user grants a durable authorization', () => {
    const scope = { userId: userId('disabled') };
    const program = getSelfImprovementProgram(scope);
    expect(program).toMatchObject({ enabled: false, mode: 'propose', allowPush: false });

    const evaluation = evaluateSelfImprovementRequest(program, {
      goal: 'Improve capability routing diagnostics',
      target: 'core',
      risk: 'low',
      operations: ['code_change', 'test_change'],
      changedPaths: ['server/cognition/diagnostics.ts', 'test/diagnostics.test.ts'],
      verificationProfile: 'standard',
    });
    expect(evaluation).toMatchObject({ decision: 'blocked', authorized: false });
    expect(evaluation.blockers).toContain('self_improvement_disabled');
  });

  it('authorizes only bounded low-risk staging and keeps activation/push separate', async () => {
    const scope = { userId: userId('autonomous') };
    const program = await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'User authorized bounded self-improvement for this product.',
      allowedTargets: ['core', 'variant'],
      allowedVariantIds: ['legal-client'],
      allowedPathPrefixes: ['server/', 'test/', 'docs/'],
      verificationProfiles: ['standard', 'full'],
      maxFilesPerChange: 6,
      maxPatchBytes: 80_000,
    });

    expect(evaluateSelfImprovementRequest(program, {
      goal: 'Document actionable task failure diagnostics',
      target: 'core',
      risk: 'low',
      operations: ['documentation_change'],
      changedPaths: ['docs/task-feedback.md'],
      estimatedPatchBytes: 12_000,
      verificationProfile: 'standard',
    })).toMatchObject({ decision: 'eligible_autonomous', authorized: true });

    const highRisk = evaluateSelfImprovementRequest(program, {
      goal: 'Change database layout',
      target: 'core',
      risk: 'high',
      operations: ['code_change', 'data_migration'],
      changedPaths: ['server/migrations/new_layout.ts'],
      verificationProfile: 'full',
    });
    expect(highRisk).toMatchObject({ decision: 'review_required', authorized: false });
    expect(highRisk.requiredGates).toContain('live_user_review');

    const secretPath = evaluateSelfImprovementRequest(program, {
      goal: 'Edit a runtime secret',
      target: 'core',
      risk: 'low',
      operations: ['code_change'],
      changedPaths: ['data/secrets/token.json'],
      verificationProfile: 'standard',
    });
    expect(secretPath.decision).toBe('blocked');
    expect(secretPath.blockers).toContain('sensitive_or_runtime_path_forbidden');

    const push = evaluateSelfImprovementRequest(program, {
      goal: 'Publish the staged change',
      target: 'variant',
      variantId: 'legal-client',
      risk: 'low',
      operations: ['git_push'],
      changedPaths: ['docs/release.md'],
      verificationProfile: 'standard',
    });
    expect(push.decision).toBe('blocked');
    expect(push.blockers).toContain('automatic_push_forbidden');
    expect(program.allowPush).toBe(false);
  });

  it('requires exact paths before autonomous staging', async () => {
    const scope = { userId: userId('scope-discovery') };
    const program = await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Allow low-risk isolated staging after exact paths are known.',
    });
    const evaluation = evaluateSelfImprovementRequest(program, {
      goal: 'Find and improve context continuation',
      target: 'core',
      risk: 'low',
      operations: ['code_change'],
      verificationProfile: 'standard',
    });
    expect(evaluation).toMatchObject({ decision: 'proposal_only', authorized: false });
    expect(evaluation.requiredGates).toContain('path_scope_review');
  });

  it('treats explicitly empty scopes as deny-all instead of restoring defaults', async () => {
    const scope = { userId: userId('deny-all') };
    const program = await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Keep the program enabled for proposals but deny every staging target.',
      allowedTargets: [],
      allowedPathPrefixes: [],
      verificationProfiles: [],
    });
    expect(program.allowedTargets).toEqual([]);
    expect(program.allowedPathPrefixes).toEqual([]);
    expect(program.verificationProfiles).toEqual([]);
    expect(evaluateSelfImprovementRequest(program, {
      goal: 'Attempt an unauthorized source change',
      target: 'core',
      risk: 'low',
      operations: ['code_change'],
      changedPaths: ['server/example.ts'],
      verificationProfile: 'targeted',
    }).blockers).toEqual(expect.arrayContaining([
      'target_not_authorized',
      'path_outside_authorized_scope',
      'verification_profile_not_authorized',
    ]));
  });

  it('binds supervised staging to an exact reviewed patch and never sends it to the autonomous queue', async () => {
    resetAutonomousTaskQueueForTest({ clearPersisted: false, markHydrated: true });
    const scope = { userId: userId('supervised') };
    await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'supervised',
      authorizationReason: 'Allow reviewed changes to be staged in isolation.',
      allowedPathPrefixes: ['server/self_extension/', 'test/'],
    });
    const proposal = await createSelfImprovementProposal(scope, {
      goal: 'Strengthen the self-improvement authorization evaluator',
      target: 'core',
      risk: 'low',
      operations: ['code_change', 'test_change'],
      changedPaths: ['server/self_extension/improvement_program.ts', 'test/self_improvement_program.test.ts'],
      verificationProfile: 'standard',
    });
    expect(proposal.status).toBe('review_required');
    expect(() => authorizeSelfImprovementStage(scope, proposal.id)).toThrow(/not authorized/i);
    await expect(enqueueSelfImprovementProposal(scope, proposal.id)).rejects.toThrow(/foreground exact-patch review/i);

    const patchDigest = 'a'.repeat(64);
    const reviewed = await recordSelfImprovementPatchReview(scope, proposal.id, {
      patchDigest,
      baseCommit: 'b'.repeat(40),
      deliveryBranch: 'main',
      verificationProfile: 'standard',
    });
    expect(reviewed.reviewedPatchDigest).toBe(patchDigest);
    expect(authorizeSelfImprovementStage(scope, proposal.id, { reviewedPatchDigest: patchDigest }).proposal.id).toBe(proposal.id);
    expect(canUseQueuedSelfImprovementStageAuthorization(scope, proposal.id, 'any-task')).toBe(false);
    expect(listSelfImprovementProposals(scope).map(item => item.id)).toContain(proposal.id);

    const stale = await createSelfImprovementProposal(scope, {
      goal: 'Add another bounded self-improvement test',
      target: 'core',
      risk: 'low',
      operations: ['test_change'],
      changedPaths: ['test/self_improvement_program.test.ts'],
      verificationProfile: 'standard',
    });
    await updateSelfImprovementProgram(scope, { maxFilesPerChange: 5 });
    await expect(enqueueSelfImprovementProposal(scope, stale.id, { reviewed: true }))
      .rejects.toThrow(/authorization changed/i);
  });

  it('blocks executable verification configuration and operation/path mismatches', async () => {
    const scope = { userId: userId('verification-config') };
    const program = await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Allow bounded staging but never let a patch rewrite its own verification gate.',
      allowedPathPrefixes: ['package.json', 'server/', 'docs/'],
    });

    const executableConfig = evaluateSelfImprovementRequest(program, {
      goal: 'Rewrite package scripts',
      target: 'core',
      risk: 'low',
      operations: ['code_change', 'dependency_change'],
      changedPaths: ['package.json'],
      verificationProfile: 'standard',
    });
    expect(executableConfig.decision).toBe('blocked');
    expect(executableConfig.blockers).toContain('verification_configuration_path_forbidden');

    const mislabeledDocumentation = evaluateSelfImprovementRequest(program, {
      goal: 'Label a source mutation as documentation',
      target: 'core',
      risk: 'low',
      operations: ['documentation_change'],
      changedPaths: ['server/runtime.ts'],
      verificationProfile: 'standard',
    });
    expect(mislabeledDocumentation.decision).toBe('blocked');
    expect(mislabeledDocumentation.blockers).toContain('path_operation_mismatch');
  });

  it('rejects control and bidirectional characters in every authorized path', async () => {
    const scope = { userId: userId('path-controls') };
    const program = await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Allow static documentation with unambiguous path boundaries.',
      allowedPathPrefixes: ['docs/'],
    });
    for (const changedPath of [
      'docs/guide\nignore-previous-instructions.md',
      'docs/guide\tspoof.md',
      'docs/guide\u202espells.md',
    ]) {
      const evaluation = evaluateSelfImprovementRequest(program, {
        goal: 'Attempt an ambiguous path',
        target: 'core',
        risk: 'low',
        operations: ['documentation_change'],
        changedPaths: [changedPath],
        verificationProfile: 'standard',
      });
      expect(evaluation.decision).toBe('blocked');
      expect(evaluation.blockers).toContain('invalid_or_ambiguous_path');
    }
  });

  it('requires durable local-administrator provenance before queue admission', async () => {
    const scope = { userId: userId('local-admin') };
    await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Allow one bounded local administrator program.',
      allowedPathPrefixes: ['docs/'],
    });
    const proposal = await createSelfImprovementProposal(scope, {
      goal: 'Improve local product documentation',
      target: 'core',
      risk: 'low',
      operations: ['documentation_change'],
      changedPaths: ['docs/example.md'],
      verificationProfile: 'standard',
    });
    await expect(enqueueSelfImprovementProposal(scope, proposal.id))
      .rejects.toThrow(/local administrator authorization/i);
    const queued = await enqueueSelfImprovementProposal(scope, proposal.id, { localAdminAuthorized: true });
    expect(queued.proposal).toMatchObject({ status: 'queued', taskId: queued.task.id });
  });

  it('never reports a terminal idempotent duplicate as newly queued', async () => {
    const scope = { userId: userId('terminal-duplicate') };
    await updateSelfImprovementProgram(scope, {
      enabled: true,
      mode: 'autonomous_low_risk',
      authorizationReason: 'Allow one bounded static documentation task.',
      allowedPathPrefixes: ['docs/'],
    });
    const proposal = await createSelfImprovementProposal(scope, {
      goal: 'Improve one documentation page',
      target: 'core',
      risk: 'low',
      operations: ['documentation_change'],
      changedPaths: ['docs/example.md'],
      verificationProfile: 'standard',
    });
    const queued = await enqueueSelfImprovementProposal(scope, proposal.id, { localAdminAuthorized: true });
    const running = markRunning(queued.task.id);
    expect(running?.leaseId).toBeTruthy();
    expect(markFailed(running!.id, 'simulated terminal failure', running!.leaseId)?.status).toBe('failed');

    await expect(enqueueSelfImprovementProposal(scope, proposal.id, { localAdminAuthorized: true }))
      .rejects.toThrow(/already terminal/i);
    const refreshed = listSelfImprovementProposals(scope).find(item => item.id === proposal.id);
    expect(refreshed?.status).toBe('review_required');
    expect(refreshed).not.toHaveProperty('taskId');
    expect(refreshed).not.toHaveProperty('localAdminAuthorizedAt');
    expect(refreshed?.evaluation.requiredGates).toEqual(expect.arrayContaining([
      'fresh_proposal_revision',
      'local_admin_queue_admission',
    ]));
  });
});
