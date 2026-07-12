/**
 * Organization model — CRUD, members, departments, invitations.
 *
 * Uses the Org DB abstraction layer for all data access.
 * Called from org routes and also from main_api.ts for branch-facing endpoints.
 */

import * as EDB from './db';
import { logAudit } from './db';

// ── Organization ─────────────────────────────────────────────────────────

export function createOrganization(name: string, slug: string, ownerUid: string) {
  const org = EDB.createOrg(name, slug, ownerUid);
  // Creator is automatically the owner member
  EDB.addMember(org.id, ownerUid, 'owner');
  logAudit({
    orgId: org.id,
    userId: ownerUid,
    action: 'org.create',
    resourceType: 'organization',
    resourceId: org.id,
    details: { name, slug },
  });
  // Auto-install legal and design agent templates (fire-and-forget)
  import('../legal/templates').then(({ installLegalTemplates }) => {
    const count = installLegalTemplates(org.id);
    if (count > 0) console.log(`[Org] Installed ${count} legal agent templates for org ${org.id}`);
  }).catch((err: any) => {
    console.warn('[Org] Failed to install legal templates:', err.message);
  });
  import('../design/templates').then(({ installDesignTemplates }) => {
    const count = installDesignTemplates(org.id);
    if (count > 0) console.log(`[Org] Installed ${count} design agent templates for org ${org.id}`);
  }).catch((err: any) => {
    console.warn('[Org] Failed to install design templates:', err.message);
  });
  return org;
}

export function getOrganization(orgId: string) {
  return EDB.getOrgById(orgId);
}

export function getOrganizationBySlug(slug: string) {
  return EDB.getOrgBySlug(slug);
}

export function listUserOrganizations(userId: string) {
  return EDB.listUserOrgs(userId);
}

export function updateOrganization(orgId: string, userId: string, settings: Record<string, any>) {
  const org = EDB.updateOrgProfile(orgId, settings);
  if (org) {
    logAudit({
      orgId,
      userId,
      action: 'org.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: settings,
    });
  }
  return org;
}

export function deleteOrganization(orgId: string, userId: string) {
  const org = EDB.getOrgById(orgId);
  if (!org || org.ownerUid !== userId) return false; // only owner can delete
  logAudit({
    orgId,
    userId,
    action: 'org.delete',
    resourceType: 'organization',
    resourceId: orgId,
  });
  return EDB.deleteOrg(orgId);
}

// ── Members ──────────────────────────────────────────────────────────────

export function inviteMember(orgId: string, invitedBy: string, userId: string, role: EDB.OrgRole = 'member', departmentId?: string) {
  const membership = EDB.addMember(orgId, userId, role, departmentId, invitedBy);
  logAudit({
    orgId,
    userId: invitedBy,
    action: 'member.invite',
    resourceType: 'member',
    resourceId: membership.id,
    details: { invitedUserId: userId, role, departmentId },
  });
  return membership;
}

export function removeOrgMember(orgId: string, removedBy: string, userId: string) {
  const result = EDB.removeMember(orgId, userId);
  if (result) {
    logAudit({
      orgId,
      userId: removedBy,
      action: 'member.remove',
      resourceType: 'member',
      resourceId: `${orgId}:${userId}`,
      details: { removedUserId: userId },
    });
  }
  return result;
}

export function changeMemberRole(orgId: string, changedBy: string, userId: string, newRole: EDB.OrgRole) {
  const m = EDB.updateMemberRole(orgId, userId, newRole);
  if (m) {
    logAudit({
      orgId,
      userId: changedBy,
      action: 'member.role_change',
      resourceType: 'member',
      resourceId: m.id,
      details: { targetUserId: userId, newRole },
    });
  }
  return m;
}

export function getOrgMember(orgId: string, userId: string) {
  return EDB.getMember(orgId, userId);
}

export function listOrgMembers(orgId: string) {
  return EDB.listMembers(orgId);
}

export function suspendMember(orgId: string, suspendedBy: string, userId: string) {
  return EDB.setMemberStatus(orgId, userId, 'suspended');
}

// ── Departments ──────────────────────────────────────────────────────────

export function getOrgDepartments(orgId: string) {
  return EDB.listDepartments(orgId);
}

export function createOrgDepartment(orgId: string, name: string, parentId?: string) {
  return EDB.createDepartment(orgId, name, parentId);
}

// ── Invitations ──────────────────────────────────────────────────────────

export function createOrgInvitation(
  orgId: string,
  createdBy: string,
  opts: { role?: EDB.OrgRole; departmentId?: string; maxUses?: number; expiresAt?: string } = {}
) {
  const inv = EDB.createInvitation(orgId, createdBy, opts);
  logAudit({
    orgId,
    userId: createdBy,
    action: 'member.invite',
    resourceType: 'invitation',
    resourceId: inv.id,
    details: { code: inv.code, role: opts.role, maxUses: opts.maxUses },
  });
  return inv;
}

export function validateInvitation(code: string): { valid: boolean; invitation?: EDB.OrgInvitation; org?: EDB.Organization; reason?: string } {
  const inv = EDB.getInvitationByCode(code);
  if (!inv) return { valid: false, reason: 'Invitation code not found' };
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
    return { valid: false, reason: 'Invitation has expired' };
  }
  if (inv.maxUses > 0 && inv.useCount >= inv.maxUses) {
    return { valid: false, reason: 'Invitation has reached maximum uses' };
  }
  const org = EDB.getOrgById(inv.orgId);
  if (!org) return { valid: false, reason: 'Organization not found' };
  return { valid: true, invitation: inv, org };
}

export function acceptInvitation(code: string, userId: string) {
  const validation = validateInvitation(code);
  if (!validation.valid || !validation.invitation) {
    return { success: false, reason: validation.reason };
  }
  const inv = validation.invitation;
  const used = EDB.useInvitation(code);
  if (!used) return { success: false, reason: 'Failed to use invitation' };

  const membership = EDB.addMember(inv.orgId, userId, inv.role, inv.departmentId || undefined);
  logAudit({
    orgId: inv.orgId,
    userId,
    action: 'member.join',
    resourceType: 'member',
    resourceId: membership.id,
    details: { invitationCode: code, role: inv.role },
  });
  return { success: true, membership, orgId: inv.orgId };
}

// ── Connection management ────────────────────────────────────────────────

export function revokeMemberConnection(orgId: string, revokedBy: string, userId: string) {
  const m = EDB.setMemberStatus(orgId, userId, 'left');
  if (m) {
    logAudit({
      orgId,
      userId: revokedBy,
      action: 'member.remove',
      resourceType: 'member',
      resourceId: m.id,
      details: { revokedUserId: userId, reason: 'connection_revoked' },
    });
  }
  return m;
}
