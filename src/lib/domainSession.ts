export type DomainReconciliation = 'none' | 'switch_personal' | 'switch_work';

export function getDomainReconciliation(
  desiredDomain: 'personal' | 'work',
  authenticatedOrgId?: string | null,
  preferredOrgId?: string | null,
): DomainReconciliation {
  const activeOrgId = String(authenticatedOrgId || '').trim();
  const targetOrgId = String(preferredOrgId || '').trim();
  if (desiredDomain === 'personal') return activeOrgId ? 'switch_personal' : 'none';
  if (!activeOrgId) return 'switch_work';
  if (targetOrgId && targetOrgId !== activeOrgId) return 'switch_work';
  return 'none';
}
