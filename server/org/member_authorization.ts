import { getMember, getOrgById, type OrgRole } from './db';
export class OrganizationMemberAuthorizationError extends Error {
    constructor(message: string, readonly statusCode = 403) { super(message); }
}
const roles = new Set<OrgRole>(['owner', 'admin', 'member', 'viewer']);
export function assertMemberOperation(orgId: string, actorId: string, targetId?: string, newRole?: OrgRole): void {
    const org = getOrgById(orgId);
    const actor = getMember(orgId, actorId);
    if (!org || !actor || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) {
        throw new OrganizationMemberAuthorizationError('Active organization administrator required.');
    }
    if (newRole !== undefined && !roles.has(newRole)) {
        throw new OrganizationMemberAuthorizationError('Invalid organization role.', 400);
    }
    const target = targetId ? getMember(orgId, targetId) : undefined;
    if (newRole === 'owner' || targetId === org.ownerUid || target?.role === 'owner') {
        throw new OrganizationMemberAuthorizationError('Ownership changes require the dedicated transfer operation.');
    }
    if (actor.role !== 'owner' && (newRole === 'admin' || target?.role === 'admin')) {
        throw new OrganizationMemberAuthorizationError('Only the owner can manage administrators.');
    }
}
