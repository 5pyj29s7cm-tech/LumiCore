import type { CapabilityExecutionPlan, CapabilityNode } from './capability_execution_plan';

export type CapabilityRolloutStage =
  | 'shadow'
  | 'internal_read'
  | 'local_action'
  | 'core_application'
  | 'external_commit';

const STAGES: CapabilityRolloutStage[] = [
  'shadow',
  'internal_read',
  'local_action',
  'core_application',
  'external_commit',
];

export function getCapabilityRolloutStage(
  env: NodeJS.ProcessEnv = process.env,
): CapabilityRolloutStage {
  const requested = String(env.LUMI_CAPABILITY_ROLLOUT_STAGE || '').trim().toLowerCase();
  return STAGES.includes(requested as CapabilityRolloutStage)
    ? requested as CapabilityRolloutStage
    : 'external_commit';
}

export function evaluateCapabilityRollout(
  plan: CapabilityExecutionPlan,
  node: CapabilityNode,
  env: NodeJS.ProcessEnv = process.env,
): { allowed: boolean; stage: CapabilityRolloutStage; reason: string } {
  const stage = getCapabilityRolloutStage(env);
  const rollbackExternalDisabled = /^(?:1|true|yes|on)$/i.test(
    String(env.LUMI_CAPABILITY_ROLLBACK_DISABLE_EXTERNAL || ''),
  );
  if (plan.risk.sideEffectClass === 'external_commit' && rollbackExternalDisabled) {
    return {
      allowed: false,
      stage,
      reason: 'External commits are disabled by the rollback safety switch.',
    };
  }
  if (stage === 'shadow') {
    return { allowed: false, stage, reason: 'Capability rollout is shadow-decision only.' };
  }
  if (stage === 'internal_read') {
    const readOnly = plan.risk.sideEffectClass === 'none'
      && ['observe', 'read', 'status'].includes(node.operation);
    return readOnly
      ? { allowed: true, stage, reason: 'Read-only capability enabled by rollout.' }
      : { allowed: false, stage, reason: 'Capability rollout currently allows internal reads only.' };
  }
  if (plan.risk.sideEffectClass === 'external_commit' && stage !== 'external_commit') {
    return {
      allowed: false,
      stage,
      reason: `External commits are disabled at rollout stage '${stage}'.`,
    };
  }
  return { allowed: true, stage, reason: `Capability enabled at rollout stage '${stage}'.` };
}
