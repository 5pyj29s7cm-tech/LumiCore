import { randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';
import { getMember, logAudit, type OrgMembership, type OrgRole } from './db';

export type OrganizationResourceType =
  | 'knowledge_article'
  | 'legal_case'
  | 'conversation'
  | 'credential_reference'
  | 'branch_device'
  | 'work_item'
  | string;

export type OrganizationResourceClassification = 'organization' | 'department' | 'restricted';
export type OrganizationResourcePermission =
  | 'read'
  | 'write'
  | 'execute'
  | 'share'
  | 'admin'
  | 'credential_use'
  | 'sync_write';
export type OrganizationResourceSubjectType = 'role' | 'department' | 'position' | 'member' | 'branch';

export interface OrganizationResourcePolicy {
  id: string;
  orgId: string;
  resourceType: OrganizationResourceType;
  resourceId: string;
  ownerUserId: string;
  classification: OrganizationResourceClassification;
  departmentId: string | null;
  status: 'active' | 'archived';
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationResourceGrant {
  id: string;
  orgId: string;
  resourceType: OrganizationResourceType;
  resourceId: string;
  subjectType: OrganizationResourceSubjectType;
  subjectId: string;
  permissions: OrganizationResourcePermission[];
  effect: 'allow' | 'deny';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationResourceAccessDecision {
  allowed: boolean;
  reason: string;
  policy: OrganizationResourcePolicy | null;
  matchedGrantIds: string[];
}

export interface OrganizationCredentialReference {
  id: string;
  orgId: string;
  name: string;
  provider: string;
  credentialRef: string;
  purpose: string;
  status: 'active' | 'revoked';
  createdBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type OrganizationDevicePermission = 'sync_write' | 'kb_read' | 'status_read';

export interface OrganizationDeviceAccess {
  id: string;
  orgId: string;
  branchId: string;
  userId: string;
  label: string;
  status: 'active' | 'revoked';
  permissions: OrganizationDevicePermission[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastRegisteredAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export class OrganizationResourceAuthorizationError extends Error {
  constructor(message: string, public readonly statusCode = 403) {
    super(message);
    this.name = 'OrganizationResourceAuthorizationError';
  }
}

const ALL_PERMISSIONS: OrganizationResourcePermission[] = [
  'read', 'write', 'execute', 'share', 'admin', 'credential_use', 'sync_write',
];
const DEFAULT_DEVICE_PERMISSIONS: OrganizationDevicePermission[] = ['sync_write', 'kb_read', 'status_read'];
const CREDENTIAL_REFERENCE_PATTERN = /^(?:web_login|settings|env|extension|session|vault|os_credential):[A-Za-z0-9._:/-]{1,220}$/;
const FORBIDDEN_CREDENTIAL_INPUT = /password|passphrase|secret|token|api.?key|cookie|authorization|private.?key/i;

function now(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown, max = 240): string {
  return String(value || '').trim().slice(0, max);
}

function normalizeIds(value: unknown, max = 100): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(values.map(item => normalizeText(item)).filter(Boolean))).slice(0, max);
}

function normalizePermissions(value: unknown): OrganizationResourcePermission[] {
  const valid = new Set(ALL_PERMISSIONS);
  return normalizeIds(value, ALL_PERMISSIONS.length)
    .filter((item): item is OrganizationResourcePermission => valid.has(item as OrganizationResourcePermission));
}

function normalizeDevicePermissions(value: unknown): OrganizationDevicePermission[] {
  const valid = new Set<OrganizationDevicePermission>(DEFAULT_DEVICE_PERMISSIONS);
  return normalizeIds(value, DEFAULT_DEVICE_PERMISSIONS.length)
    .filter((item): item is OrganizationDevicePermission => valid.has(item as OrganizationDevicePermission));
}

function ensureTables(db: any): void {
  if (!Array.isArray(db.orgResourcePolicies)) db.orgResourcePolicies = [];
  if (!Array.isArray(db.orgResourceGrants)) db.orgResourceGrants = [];
  db.orgResourceGrants = db.orgResourceGrants.filter((grant: any) => grant?.subjectType !== 'agent');
  if (!Array.isArray(db.orgCredentialReferences)) db.orgCredentialReferences = [];
  if (!Array.isArray(db.orgDevices)) db.orgDevices = [];
  for (const device of db.orgDevices) {
    device.permissions = normalizeDevicePermissions(device.permissions);
  }
}

function activeMembership(orgId: string, userId: string): OrgMembership | null {
  const membership = getMember(orgId, userId);
  return membership?.status === 'active' ? membership : null;
}

function requireAdministrator(orgId: string, userId: string): OrgMembership {
  const membership = activeMembership(orgId, userId);
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    throw new OrganizationResourceAuthorizationError('Organization owner or administrator access is required');
  }
  return membership;
}

function policyKey(orgId: string, resourceType: string, resourceId: string): string {
  return `${orgId}\0${resourceType}\0${resourceId}`;
}

function findPolicy(db: any, orgId: string, resourceType: string, resourceId: string): OrganizationResourcePolicy | null {
  ensureTables(db);
  return (db.orgResourcePolicies as OrganizationResourcePolicy[]).find(policy => (
    policy.orgId === orgId
    && policy.resourceType === resourceType
    && policy.resourceId === resourceId
    && policy.status === 'active'
  )) || null;
}

function grantsFor(db: any, orgId: string, resourceType: string, resourceId: string): OrganizationResourceGrant[] {
  ensureTables(db);
  return (db.orgResourceGrants as OrganizationResourceGrant[]).filter(grant => (
    grant.orgId === orgId && grant.resourceType === resourceType && grant.resourceId === resourceId
  ));
}

function roleCanWrite(role: OrgRole): boolean {
  return role !== 'viewer';
}

function defaultDecision(input: {
  resourceType: OrganizationResourceType;
  permission: OrganizationResourcePermission;
  membership: OrgMembership;
  actorUserId: string;
  ownerUserId?: string;
}): OrganizationResourceAccessDecision {
  const owner = Boolean(input.ownerUserId && input.ownerUserId === input.actorUserId);
  if (owner) return { allowed: true, reason: 'resource_owner', policy: null, matchedGrantIds: [] };
  if (input.permission === 'read') {
    if (input.resourceType === 'conversation') {
      return { allowed: false, reason: 'conversation_is_member_private_by_default', policy: null, matchedGrantIds: [] };
    }
    if (input.resourceType === 'credential_reference') {
      return { allowed: false, reason: 'credential_reference_is_restricted_by_default', policy: null, matchedGrantIds: [] };
    }
    return { allowed: true, reason: 'legacy_organization_read_default', policy: null, matchedGrantIds: [] };
  }
  if (input.permission === 'write') {
    const legacyWritable = ['knowledge_article', 'legal_case'].includes(String(input.resourceType));
    return {
      allowed: legacyWritable && roleCanWrite(input.membership.role),
      reason: legacyWritable ? 'legacy_organization_write_default' : 'write_requires_owner_or_policy',
      policy: null,
      matchedGrantIds: [],
    };
  }
  return { allowed: false, reason: 'explicit_resource_policy_required', policy: null, matchedGrantIds: [] };
}

function subjectMatches(input: {
  grant: OrganizationResourceGrant;
  membership: OrgMembership;
  actorUserId: string;
  branchId?: string;
  positions: any[];
}): boolean {
  const { grant, membership } = input;
  if (grant.subjectType === 'member') return grant.subjectId === input.actorUserId;
  if (grant.subjectType === 'role') return grant.subjectId === membership.role;
  if (grant.subjectType === 'department') return Boolean(membership.departmentId && grant.subjectId === membership.departmentId);
  if (grant.subjectType === 'branch') return Boolean(input.branchId && grant.subjectId === input.branchId);
  if (grant.subjectType === 'position') {
    return input.positions.some(position => (
      position.orgId === membership.orgId
      && position.id === grant.subjectId
      && position.status === 'active'
      && Array.isArray(position.memberIds)
      && position.memberIds.includes(input.actorUserId)
    ));
  }
  return false;
}

function grantCovers(grant: OrganizationResourceGrant, permission: OrganizationResourcePermission): boolean {
  return grant.permissions.includes('admin') || grant.permissions.includes(permission);
}

export function getOrganizationResourcePolicy(
  orgId: string,
  resourceType: OrganizationResourceType,
  resourceId: string,
): { policy: OrganizationResourcePolicy | null; grants: OrganizationResourceGrant[] } {
  const db = readDB();
  const policy = findPolicy(db, orgId, normalizeText(resourceType, 80), normalizeText(resourceId));
  return {
    policy,
    grants: policy ? grantsFor(db, orgId, policy.resourceType, policy.resourceId).map(grant => ({ ...grant, permissions: [...grant.permissions] })) : [],
  };
}

export function authorizeOrganizationResource(input: {
  orgId: string;
  actorUserId: string;
  resourceType: OrganizationResourceType;
  resourceId: string;
  permission: OrganizationResourcePermission;
  ownerUserId?: string;
  branchId?: string;
}): OrganizationResourceAccessDecision {
  const membership = activeMembership(input.orgId, input.actorUserId);
  if (!membership) return { allowed: false, reason: 'active_membership_required', policy: null, matchedGrantIds: [] };
  if (['owner', 'admin'].includes(membership.role)) {
    return { allowed: true, reason: 'organization_administrator', policy: null, matchedGrantIds: [] };
  }
  if (membership.role === 'viewer' && input.permission !== 'read') {
    return { allowed: false, reason: 'viewer_is_read_only', policy: null, matchedGrantIds: [] };
  }

  const db = readDB();
  ensureTables(db);
  const resourceType = normalizeText(input.resourceType, 80);
  const resourceId = normalizeText(input.resourceId);
  const policy = findPolicy(db, input.orgId, resourceType, resourceId);
  if (!policy) return defaultDecision({ ...input, resourceType, membership });
  if (policy.ownerUserId === input.actorUserId) {
    return { allowed: true, reason: 'resource_owner', policy, matchedGrantIds: [] };
  }

  const positions = db.orgPositions || [];
  const matches = grantsFor(db, input.orgId, resourceType, resourceId)
    .filter(grant => subjectMatches({ grant, membership, actorUserId: input.actorUserId, branchId: input.branchId, positions }))
    .filter(grant => grantCovers(grant, input.permission));
  const denied = matches.filter(grant => grant.effect === 'deny');
  if (denied.length > 0) {
    return { allowed: false, reason: 'matching_deny_grant', policy, matchedGrantIds: denied.map(grant => grant.id) };
  }
  const allowed = matches.filter(grant => grant.effect === 'allow');
  if (allowed.length > 0) {
    return { allowed: true, reason: 'matching_allow_grant', policy, matchedGrantIds: allowed.map(grant => grant.id) };
  }

  if (policy.classification === 'organization') {
    const canUse = input.permission === 'read' || (input.permission === 'write' && roleCanWrite(membership.role));
    return { allowed: canUse, reason: 'organization_classification_default', policy, matchedGrantIds: [] };
  }
  if (policy.classification === 'department') {
    const sameDepartment = Boolean(policy.departmentId && membership.departmentId === policy.departmentId);
    const canUse = sameDepartment && (input.permission === 'read' || (input.permission === 'write' && roleCanWrite(membership.role)));
    return { allowed: canUse, reason: sameDepartment ? 'department_classification_default' : 'different_department', policy, matchedGrantIds: [] };
  }
  return { allowed: false, reason: 'restricted_resource_requires_explicit_grant', policy, matchedGrantIds: [] };
}

export function assertOrganizationResourceAccess(input: Parameters<typeof authorizeOrganizationResource>[0]): OrganizationResourceAccessDecision {
  const decision = authorizeOrganizationResource(input);
  if (decision.allowed) return decision;
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'resource.access.denied',
    resourceType: String(input.resourceType),
    resourceId: input.resourceId,
    details: { permission: input.permission, reason: decision.reason, matchedGrantIds: decision.matchedGrantIds },
  });
  throw new OrganizationResourceAuthorizationError(`Resource access denied: ${decision.reason}`);
}

export function setOrganizationResourcePolicy(input: {
  orgId: string;
  actorUserId: string;
  resourceType: OrganizationResourceType;
  resourceId: string;
  ownerUserId?: string;
  classification: OrganizationResourceClassification;
  departmentId?: string | null;
  grants?: Array<{
    subjectType: OrganizationResourceSubjectType;
    subjectId: string;
    permissions: OrganizationResourcePermission[];
    effect?: 'allow' | 'deny';
  }>;
}): { policy: OrganizationResourcePolicy; grants: OrganizationResourceGrant[] } {
  const resourceType = normalizeText(input.resourceType, 80);
  const resourceId = normalizeText(input.resourceId);
  if (!resourceType || !resourceId) throw new OrganizationResourceAuthorizationError('resourceType and resourceId are required', 400);
  const actorMembership = activeMembership(input.orgId, input.actorUserId);
  if (!actorMembership) throw new OrganizationResourceAuthorizationError('Active organization membership is required');
  const initialDb = readDB();
  ensureTables(initialDb);
  const existingPolicy = findPolicy(initialDb, input.orgId, resourceType, resourceId);
  const requestedOwner = normalizeText(input.ownerUserId) || input.actorUserId;
  const administrator = ['owner', 'admin'].includes(actorMembership.role);
  const mayCreateOwnPolicy = !existingPolicy && requestedOwner === input.actorUserId && actorMembership.role !== 'viewer';
  const mayManageExisting = Boolean(existingPolicy && existingPolicy.ownerUserId === input.actorUserId);
  if (!administrator && !mayCreateOwnPolicy && !mayManageExisting) {
    throw new OrganizationResourceAuthorizationError('Resource owner or organization administrator access is required');
  }
  const classification: OrganizationResourceClassification = ['department', 'restricted'].includes(input.classification)
    ? input.classification
    : 'organization';
  const departmentId = normalizeText(input.departmentId) || null;
  if (classification === 'department') {
    const department = (readDB().departments || []).find((item: any) => item.id === departmentId && item.orgId === input.orgId);
    if (!department) throw new OrganizationResourceAuthorizationError('A valid organization department is required', 400);
  }
  const ownerUserId = requestedOwner;
  if (!administrator && ownerUserId !== input.actorUserId) {
    throw new OrganizationResourceAuthorizationError('Only an organization administrator can transfer resource ownership');
  }
  if (!activeMembership(input.orgId, ownerUserId)) {
    throw new OrganizationResourceAuthorizationError('Resource owner must be an active organization member', 400);
  }
  const db = readDB();
  ensureTables(db);
  const timestamp = now();
  let policy = findPolicy(db, input.orgId, resourceType, resourceId);
  if (policy) {
    policy.ownerUserId = ownerUserId;
    policy.classification = classification;
    policy.departmentId = classification === 'department' ? departmentId : null;
    policy.revision += 1;
    policy.updatedBy = input.actorUserId;
    policy.updatedAt = timestamp;
  } else {
    policy = {
      id: randomUUID(), orgId: input.orgId, resourceType, resourceId, ownerUserId,
      classification, departmentId: classification === 'department' ? departmentId : null,
      status: 'active', revision: 1, createdBy: input.actorUserId, updatedBy: input.actorUserId,
      createdAt: timestamp, updatedAt: timestamp,
    };
    db.orgResourcePolicies.push(policy);
  }

  const nextGrants: OrganizationResourceGrant[] = [];
  for (const raw of input.grants || []) {
    const subjectType = normalizeText(raw.subjectType, 40) as OrganizationResourceSubjectType;
    const subjectId = normalizeText(raw.subjectId);
    const permissions = normalizePermissions(raw.permissions);
    if (!['role', 'department', 'position', 'member', 'branch'].includes(subjectType) || !subjectId || permissions.length === 0) {
      throw new OrganizationResourceAuthorizationError('Every grant requires a valid subject and permission', 400);
    }
    if (subjectType === 'role' && !['owner', 'admin', 'member', 'viewer'].includes(subjectId)) {
      throw new OrganizationResourceAuthorizationError('Unknown organization role grant', 400);
    }
    if (subjectType === 'member' && !activeMembership(input.orgId, subjectId)) {
      throw new OrganizationResourceAuthorizationError('Grant member must be active in this organization', 400);
    }
    if (subjectType === 'department' && !(db.departments || []).some((item: any) => item.id === subjectId && item.orgId === input.orgId)) {
      throw new OrganizationResourceAuthorizationError('Grant department must belong to this organization', 400);
    }
    if (subjectType === 'position' && !(db.orgPositions || []).some((item: any) => item.id === subjectId && item.orgId === input.orgId && item.status === 'active')) {
      throw new OrganizationResourceAuthorizationError('Grant position must be active in this organization', 400);
    }
    if (subjectType === 'branch' && !(db.orgDevices || []).some((item: any) => item.branchId === subjectId && item.orgId === input.orgId)) {
      throw new OrganizationResourceAuthorizationError('Grant branch must be registered to this organization', 400);
    }
    nextGrants.push({
      id: randomUUID(), orgId: input.orgId, resourceType, resourceId, subjectType, subjectId,
      permissions, effect: raw.effect === 'deny' ? 'deny' : 'allow', createdBy: input.actorUserId,
      createdAt: timestamp, updatedAt: timestamp,
    });
  }
  db.orgResourceGrants = (db.orgResourceGrants as OrganizationResourceGrant[])
    .filter(grant => policyKey(grant.orgId, grant.resourceType, grant.resourceId) !== policyKey(input.orgId, resourceType, resourceId));
  db.orgResourceGrants.push(...nextGrants);
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'resource.policy.set',
    resourceType,
    resourceId,
    details: { classification, departmentId: policy.departmentId, ownerUserId, revision: policy.revision, grantCount: nextGrants.length },
  });
  return { policy: { ...policy }, grants: nextGrants.map(grant => ({ ...grant, permissions: [...grant.permissions] })) };
}

export function removeOrganizationResourcePolicy(input: {
  orgId: string;
  actorUserId: string;
  resourceType: OrganizationResourceType;
  resourceId: string;
}): boolean {
  const db = readDB();
  ensureTables(db);
  const policy = findPolicy(db, input.orgId, input.resourceType, input.resourceId);
  if (!policy) return false;
  const membership = activeMembership(input.orgId, input.actorUserId);
  if (!membership || (!['owner', 'admin'].includes(membership.role) && policy.ownerUserId !== input.actorUserId)) {
    throw new OrganizationResourceAuthorizationError('Resource owner or organization administrator access is required');
  }
  policy.status = 'archived';
  policy.revision += 1;
  policy.updatedBy = input.actorUserId;
  policy.updatedAt = now();
  db.orgResourceGrants = (db.orgResourceGrants as OrganizationResourceGrant[]).filter(grant => (
    grant.orgId !== input.orgId || grant.resourceType !== input.resourceType || grant.resourceId !== input.resourceId
  ));
  writeDB(db);
  logAudit({ orgId: input.orgId, userId: input.actorUserId, action: 'resource.policy.remove', resourceType: input.resourceType, resourceId: input.resourceId });
  return true;
}

function assertCredentialReferenceInput(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_CREDENTIAL_INPUT.test(key) && key !== 'credentialRef') {
      throw new OrganizationResourceAuthorizationError('Secret values are forbidden; provide only a credentialRef to an existing secure store', 400);
    }
  }
  if (!CREDENTIAL_REFERENCE_PATTERN.test(String(input.credentialRef || ''))) {
    throw new OrganizationResourceAuthorizationError('credentialRef must identify an existing approved secure-store namespace', 400);
  }
}

function publicCredentialReference(item: OrganizationCredentialReference): Omit<OrganizationCredentialReference, 'credentialRef'> & { referenceNamespace: string; hasReference: true } {
  return {
    id: item.id,
    orgId: item.orgId,
    name: item.name,
    provider: item.provider,
    purpose: item.purpose,
    status: item.status,
    createdBy: item.createdBy,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    referenceNamespace: item.credentialRef.split(':', 1)[0],
    hasReference: true,
  };
}

export function createOrganizationCredentialReference(input: {
  orgId: string;
  actorUserId: string;
  name: string;
  provider: string;
  credentialRef: string;
  purpose?: string;
  grants?: Parameters<typeof setOrganizationResourcePolicy>[0]['grants'];
}): ReturnType<typeof publicCredentialReference> {
  requireAdministrator(input.orgId, input.actorUserId);
  assertCredentialReferenceInput(input as unknown as Record<string, unknown>);
  const name = normalizeText(input.name, 120);
  const provider = normalizeText(input.provider, 120);
  if (!name || !provider) throw new OrganizationResourceAuthorizationError('name and provider are required', 400);
  const db = readDB();
  ensureTables(db);
  if ((db.orgCredentialReferences as OrganizationCredentialReference[]).some(item => item.orgId === input.orgId && item.name.toLowerCase() === name.toLowerCase() && item.status === 'active')) {
    throw new OrganizationResourceAuthorizationError('An active credential reference with this name already exists', 409);
  }
  const timestamp = now();
  const item: OrganizationCredentialReference = {
    id: randomUUID(), orgId: input.orgId, name, provider,
    credentialRef: String(input.credentialRef), purpose: normalizeText(input.purpose, 500), status: 'active',
    createdBy: input.actorUserId, revision: 1, createdAt: timestamp, updatedAt: timestamp,
  };
  db.orgCredentialReferences.push(item);
  writeDB(db);
  setOrganizationResourcePolicy({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    resourceType: 'credential_reference',
    resourceId: item.id,
    ownerUserId: input.actorUserId,
    classification: 'restricted',
    grants: input.grants,
  });
  logAudit({
    orgId: input.orgId, userId: input.actorUserId, action: 'credential_reference.create',
    resourceType: 'credential_reference', resourceId: item.id,
    details: { provider, referenceNamespace: item.credentialRef.split(':', 1)[0], purpose: item.purpose },
  });
  return publicCredentialReference(item);
}

export function listOrganizationCredentialReferences(orgId: string, actorUserId: string): ReturnType<typeof publicCredentialReference>[] {
  const db = readDB();
  ensureTables(db);
  return (db.orgCredentialReferences as OrganizationCredentialReference[])
    .filter(item => item.orgId === orgId && item.status === 'active')
    .filter(item => authorizeOrganizationResource({ orgId, actorUserId, resourceType: 'credential_reference', resourceId: item.id, permission: 'read', ownerUserId: item.createdBy }).allowed)
    .map(publicCredentialReference);
}

export function resolveOrganizationCredentialReference(input: {
  orgId: string;
  actorUserId: string;
  credentialId: string;
}): string {
  const db = readDB();
  ensureTables(db);
  const item = (db.orgCredentialReferences as OrganizationCredentialReference[]).find(candidate => (
    candidate.id === input.credentialId && candidate.orgId === input.orgId && candidate.status === 'active'
  ));
  if (!item) throw new OrganizationResourceAuthorizationError('Credential reference not found', 404);
  assertOrganizationResourceAccess({
    orgId: input.orgId, actorUserId: input.actorUserId,
    resourceType: 'credential_reference', resourceId: item.id, permission: 'credential_use', ownerUserId: item.createdBy,
  });
  logAudit({
    orgId: input.orgId, userId: input.actorUserId, action: 'credential_reference.used',
    resourceType: 'credential_reference', resourceId: item.id,
    details: { provider: item.provider },
  });
  return item.credentialRef;
}

export function revokeOrganizationCredentialReference(input: { orgId: string; actorUserId: string; credentialId: string }): boolean {
  requireAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const item = (db.orgCredentialReferences as OrganizationCredentialReference[]).find(candidate => candidate.id === input.credentialId && candidate.orgId === input.orgId);
  if (!item) return false;
  item.status = 'revoked';
  item.revision += 1;
  item.updatedAt = now();
  writeDB(db);
  logAudit({ orgId: input.orgId, userId: input.actorUserId, action: 'credential_reference.revoked', resourceType: 'credential_reference', resourceId: item.id });
  return true;
}

export function registerOrganizationDevice(input: {
  orgId: string;
  branchId: string;
  userId: string;
  label?: string;
}): OrganizationDeviceAccess {
  const membership = activeMembership(input.orgId, input.userId);
  if (!membership) throw new OrganizationResourceAuthorizationError('Active organization membership is required');
  const orgId = normalizeText(input.orgId);
  const branchId = normalizeText(input.branchId);
  const userId = normalizeText(input.userId);
  if (!orgId || !branchId || !userId) throw new OrganizationResourceAuthorizationError('orgId, branchId, and userId are required', 400);
  const db = readDB();
  ensureTables(db);
  const conflicting = (db.orgDevices as OrganizationDeviceAccess[]).find(item => item.branchId === branchId && (item.orgId !== orgId || item.userId !== userId));
  if (conflicting) throw new OrganizationResourceAuthorizationError('This immutable branch identity belongs to another organization member', 409);
  const existing = (db.orgDevices as OrganizationDeviceAccess[]).find(item => item.branchId === branchId && item.orgId === orgId && item.userId === userId);
  const timestamp = now();
  if (existing) {
    if (existing.status === 'revoked') {
      throw new OrganizationResourceAuthorizationError('This organization device was revoked and requires administrator reactivation');
    }
    existing.lastRegisteredAt = timestamp;
    existing.updatedAt = timestamp;
    if (input.label) existing.label = normalizeText(input.label, 120);
    writeDB(db);
    return { ...existing, permissions: [...existing.permissions] };
  }
  const device: OrganizationDeviceAccess = {
    id: randomUUID(), orgId, branchId, userId, label: normalizeText(input.label, 120) || `Branch ${branchId.slice(0, 12)}`,
    status: 'active', permissions: [...DEFAULT_DEVICE_PERMISSIONS], revision: 1,
    createdAt: timestamp, updatedAt: timestamp, lastRegisteredAt: timestamp, revokedAt: null, revokedBy: null,
  };
  db.orgDevices.push(device);
  writeDB(db);
  logAudit({
    orgId, userId, action: 'branch_device.registered', resourceType: 'branch_device', resourceId: device.id,
    details: { branchId, permissions: device.permissions },
  });
  return { ...device, permissions: [...device.permissions] };
}

export function authorizeOrganizationDevice(input: {
  orgId: string;
  branchId: string;
  userId: string;
  permission: OrganizationDevicePermission;
}): OrganizationDeviceAccess {
  const membership = activeMembership(input.orgId, input.userId);
  if (!membership) throw new OrganizationResourceAuthorizationError('Active organization membership is required');
  const db = readDB();
  ensureTables(db);
  let device = (db.orgDevices as OrganizationDeviceAccess[]).find(item => (
    item.orgId === input.orgId && item.branchId === input.branchId && item.userId === input.userId
  ));
  if (!device) {
    const legacyRaw = (db.settings || []).find((item: any) => item?.key === 'org.branch.registry.v1')?.value;
    try {
      const legacy = JSON.parse(String(legacyRaw || '{}'))?.[input.branchId];
      if (legacy?.status === 'active' && legacy.orgId === input.orgId && legacy.userId === input.userId) {
        device = registerOrganizationDevice({
          orgId: input.orgId,
          branchId: input.branchId,
          userId: input.userId,
          label: `Migrated branch ${input.branchId.slice(0, 12)}`,
        });
      }
    } catch { /* Invalid legacy device state is denied below. */ }
  }
  if (!device || device.status !== 'active') throw new OrganizationResourceAuthorizationError('Organization device is not active');
  if (!device.permissions.includes(input.permission)) {
    logAudit({
      orgId: input.orgId, userId: input.userId, action: 'branch_device.access.denied',
      resourceType: 'branch_device', resourceId: device.id,
      details: { branchId: input.branchId, permission: input.permission },
    });
    throw new OrganizationResourceAuthorizationError(`Organization device lacks ${input.permission} permission`);
  }
  return { ...device, permissions: [...device.permissions] };
}

export function listOrganizationDevices(orgId: string, actorUserId: string): OrganizationDeviceAccess[] {
  requireAdministrator(orgId, actorUserId);
  const db = readDB();
  ensureTables(db);
  return (db.orgDevices as OrganizationDeviceAccess[])
    .filter(item => item.orgId === orgId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(item => ({ ...item, permissions: [...item.permissions] }));
}

export function updateOrganizationDevice(input: {
  orgId: string;
  actorUserId: string;
  deviceId: string;
  status?: 'active' | 'revoked';
  permissions?: OrganizationDevicePermission[];
  label?: string;
}): OrganizationDeviceAccess | null {
  requireAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const device = (db.orgDevices as OrganizationDeviceAccess[]).find(item => item.id === input.deviceId && item.orgId === input.orgId);
  if (!device) return null;
  const timestamp = now();
  if (input.permissions !== undefined) {
    const permissions = normalizeDevicePermissions(input.permissions);
    if (permissions.length === 0 && input.status !== 'revoked') {
      throw new OrganizationResourceAuthorizationError('An active device must have at least one permission', 400);
    }
    device.permissions = permissions;
  }
  if (input.label !== undefined) device.label = normalizeText(input.label, 120) || device.label;
  if (input.status !== undefined) {
    device.status = input.status === 'revoked' ? 'revoked' : 'active';
    device.revokedAt = device.status === 'revoked' ? timestamp : null;
    device.revokedBy = device.status === 'revoked' ? input.actorUserId : null;
  }
  device.revision += 1;
  device.updatedAt = timestamp;
  writeDB(db);
  logAudit({
    orgId: input.orgId, userId: input.actorUserId, action: `branch_device.${device.status === 'revoked' ? 'revoked' : 'updated'}`,
    resourceType: 'branch_device', resourceId: device.id,
    details: { branchId: device.branchId, status: device.status, permissions: device.permissions, revision: device.revision },
  });
  return { ...device, permissions: [...device.permissions] };
}
