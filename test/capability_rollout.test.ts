import { describe, expect, it } from 'vitest';
import { evaluateCapabilityRollout, getCapabilityRolloutStage } from '../server/cognition/capability_rollout';
import type { CapabilityExecutionPlan, CapabilityNode } from '../server/cognition/capability_execution_plan';

function fixture(sideEffectClass: 'none' | 'local_write' | 'external_commit', operation: CapabilityNode['operation']) {
  const node = {
    nodeId: 'adapter-1', type: 'tool', state: 'candidate', capabilityId: 'test', toolName: 'test_tool',
    lane: 'system', operation, risk: 'none', sideEffects: [], requiresConfirmation: sideEffectClass === 'external_commit',
    verification: { strategy: 'none', required: false, requiredFields: [], requiredArtifacts: [], requiredArtifactCollections: [], successStatuses: [], failureStatuses: [], successSignals: [], limitations: [] },
    provenance: { source: 'builtin', provider: 'lumi-core', trust: 'core' }, executionRole: 'adapter',
  } as CapabilityNode;
  const plan = {
    risk: { sideEffectClass, requiresConfirmation: sideEffectClass === 'external_commit', failClosed: sideEffectClass === 'external_commit', reasons: [] },
  } as CapabilityExecutionPlan;
  return { plan, node };
}

describe('capability rollout safety stages', () => {
  it('defaults to the complete route while preserving explicit staged controls', () => {
    expect(getCapabilityRolloutStage({})).toBe('external_commit');
    const read = fixture('none', 'observe');
    expect(evaluateCapabilityRollout(read.plan, read.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'shadow' }).allowed).toBe(false);
    expect(evaluateCapabilityRollout(read.plan, read.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'internal_read' }).allowed).toBe(true);
    const write = fixture('local_write', 'mutate');
    expect(evaluateCapabilityRollout(write.plan, write.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'internal_read' }).allowed).toBe(false);
    expect(evaluateCapabilityRollout(write.plan, write.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'local_action' }).allowed).toBe(true);
  });

  it('blocks external commits before the final stage and whenever rollback disables them', () => {
    const commit = fixture('external_commit', 'communicate');
    expect(evaluateCapabilityRollout(commit.plan, commit.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'core_application' }).allowed).toBe(false);
    expect(evaluateCapabilityRollout(commit.plan, commit.node, { LUMI_CAPABILITY_ROLLOUT_STAGE: 'external_commit' }).allowed).toBe(true);
    expect(evaluateCapabilityRollout(commit.plan, commit.node, {
      LUMI_CAPABILITY_ROLLOUT_STAGE: 'external_commit',
      LUMI_CAPABILITY_ROLLBACK_DISABLE_EXTERNAL: 'true',
    })).toMatchObject({ allowed: false, reason: expect.stringMatching(/rollback safety switch/i) });
  });
});
