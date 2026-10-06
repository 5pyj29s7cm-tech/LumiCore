import { planBindingCodeConsumption, commitBindingCodeConsumption } from '../server/messaging/bindings';
import { planPersonalOrganizationScope, commitPersonalOrganizationScopePlan } from '../server/messaging/personal_org_scope';

/** Fixture setup exercises the same planned commits used by the live durable ingress. */
export function consumeFixtureBindingCode(...args: Parameters<typeof planBindingCodeConsumption>) {
  const plan = planBindingCodeConsumption(...args);
  return plan ? commitBindingCodeConsumption(plan)?.binding || null : null;
}

export function commitFixturePersonalOrganizationScope(...args: Parameters<typeof planPersonalOrganizationScope>) {
  const plan = planPersonalOrganizationScope(...args);
  commitPersonalOrganizationScopePlan(plan);
  return plan.resolution;
}
