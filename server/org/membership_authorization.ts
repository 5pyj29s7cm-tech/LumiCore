import { getMember, getOrgById, type OrgRole } from './db';

/** Authority accepted with a durable request; a later rejoin is a new identity. */
export interface OrganizationMembershipAuthorization {
  orgId: string;
  userId: string;
  membershipId: string;
  role: OrgRole;
}

export function captureOrganizationMembershipAuthorization(orgId: string, userId: string): OrganizationMembershipAuthorization {
  const member = getMember(orgId, userId);
  if (!getOrgById(orgId) || !member || member.status !== 'active' || member.role === 'viewer') {
    throw new Error('Active writable organization membership is required for this work request.');
  }
  return { orgId, userId, membershipId: member.id, role: member.role };
}

export function isOrganizationMembershipAuthorizationCurrent(
  snapshot: OrganizationMembershipAuthorization | undefined,
  orgId: string,
  userId: string,
): boolean {
  if (!snapshot || snapshot.orgId !== orgId || snapshot.userId !== userId || !snapshot.membershipId) return false;
  const member = getMember(orgId, userId);
  return Boolean(getOrgById(orgId) && member && member.id === snapshot.membershipId
    && member.status === 'active' && member.role !== 'viewer' && member.role === snapshot.role);
}

/** Polls long-running adapters; callers also use isAuthorized at every boundary. */
export function watchOrganizationMembershipAuthorization(
  snapshot: OrganizationMembershipAuthorization | undefined,
  orgId: string,
  userId: string,
  onRevoked: () => void,
): { isAuthorized(): boolean; dispose(): void } {
  let revoked = false;
  const isAuthorized = () => {
    if (revoked) return false;
    let current = false;
    try { current = isOrganizationMembershipAuthorizationCurrent(snapshot, orgId, userId); } catch { /* Fail closed. */ }
    if (!current) {
      revoked = true;
      try { onRevoked(); } catch { /* The failed authority remains revoked. */ }
    }
    return !revoked;
  };
  const timer = setInterval(isAuthorized, 100);
  timer.unref?.();
  isAuthorized();
  return { isAuthorized, dispose: () => clearInterval(timer) };
}
