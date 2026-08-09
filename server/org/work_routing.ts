import { createHash, randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';
import { getMember, listDepartments, listMembers, logAudit } from './db';
import { authorizeOrganizationResource } from './resource_acl';

export type OrganizationPositionStatus = 'active' | 'archived';
export type OrganizationWorkApprovalMode = 'none' | 'admin';
export type OrganizationWorkItemStatus =
  | 'waiting_approval'
  | 'assigned'
  | 'executing'
  | 'waiting_human'
  | 'completed'
  | 'blocked'
  | 'cancelled';
export type OrganizationWorkApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type OrganizationWorkHandoffStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type OrganizationWorkHandoffType = 'transfer' | 'human_takeover' | 'return_to_agent';

export interface OrganizationPosition {
  id: string;
  orgId: string;
  departmentId: string | null;
  name: string;
  description: string;
  skillTags: string[];
  memberIds: string[];
  agentIds: string[];
  isManager: boolean;
  status: OrganizationPositionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationWorkRoutingRule {
  id: string;
  orgId: string;
  name: string;
  enabled: boolean;
  priority: number;
  platforms: string[];
  keywords: string[];
  skillTags: string[];
  departmentId: string | null;
  positionId: string | null;
  memberId: string | null;
  agentIds: string[];
  approvalMode: OrganizationWorkApprovalMode;
  requireApprovalForExternalCommit: boolean;
  createdBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationWorkItem {
  id: string;
  orgId: string;
  idempotencyKey: string;
  requestId: string;
  source: string;
  requesterUserId: string;
  conversationId: string;
  taskId: string;
  textDigest: string;
  intentKind: string;
  operation: string;
  sideEffectClass: string;
  status: OrganizationWorkItemStatus;
  departmentId: string | null;
  positionId: string | null;
  assignedMemberId: string | null;
  collaboratorMemberIds: string[];
  assignedAgentIds: string[];
  skillTags: string[];
  routingRuleId: string | null;
  approvalId: string | null;
  humanOwnerUserId: string | null;
  revision: number;
  lastBlocker: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationWorkApproval {
  id: string;
  orgId: string;
  workItemId: string;
  workItemRevision: number;
  actionDigest: string;
  status: OrganizationWorkApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

export interface OrganizationWorkHandoffTarget {
  departmentId: string | null;
  positionId: string | null;
  memberId: string | null;
  agentIds: string[];
}

export interface OrganizationWorkHandoff {
  id: string;
  orgId: string;
  workItemId: string;
  workItemRevision: number;
  type: OrganizationWorkHandoffType;
  status: OrganizationWorkHandoffStatus;
  actorUserId: string;
  from: OrganizationWorkHandoffTarget;
  to: OrganizationWorkHandoffTarget;
  reason: string;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

export interface RouteOrganizationWorkInput {
  orgId: string;
  requesterUserId: string;
  source: string;
  requestId: string;
  idempotencyKey?: string;
  text: string;
  intentKind: string;
  operation: string;
  sideEffectClass: string;
  conversationId?: string;
  taskId?: string;
  platform?: string;
  skillTags?: string[];
  targetDepartmentId?: string;
  targetPositionId?: string;
  targetMemberId?: string;
  targetMemberIds?: string[];
  targetAgentIds?: string[];
}

export interface RouteOrganizationWorkResult {
  workItem: OrganizationWorkItem;
  approval: OrganizationWorkApproval | null;
  routingRule: OrganizationWorkRoutingRule | null;
  created: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown, limit = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeList(value: unknown, max = 50): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(new Set(values
    .map(item => normalizeText(item, 120).toLowerCase())
    .filter(Boolean)))
    .slice(0, max);
}

function normalizeIds(value: unknown, max = 100): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(new Set(values.map(item => normalizeText(item, 180)).filter(Boolean))).slice(0, max);
}

function digest(value: unknown): string {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function ensureTables(db: any): void {
  if (!Array.isArray(db.orgPositions)) db.orgPositions = [];
  if (!Array.isArray(db.orgWorkRoutingRules)) db.orgWorkRoutingRules = [];
  if (!Array.isArray(db.orgWorkItems)) db.orgWorkItems = [];
  if (!Array.isArray(db.orgWorkApprovals)) db.orgWorkApprovals = [];
  if (!Array.isArray(db.orgWorkHandoffs)) db.orgWorkHandoffs = [];
}

function assertActiveMember(orgId: string, userId: string, writable = false) {
  const membership = getMember(orgId, userId);
  if (!membership || membership.status !== 'active') {
    throw new Error('The organization member is not active');
  }
  if (writable && membership.role === 'viewer') {
    throw new Error('The organization member has read-only access');
  }
  return membership;
}

function assertAdministrator(orgId: string, userId: string): void {
  const membership = assertActiveMember(orgId, userId, true);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new Error('Only an organization owner or administrator may perform this operation');
  }
}

function organizationAgents(db: any, orgId: string): any[] {
  return (db.agents || []).filter((agent: any) => (
    String(agent.orgId || '') === orgId
    && (agent.domain || 'work') === 'work'
    && !['offline', 'terminated'].includes(String(agent.status || 'active'))
    && agent.isFrozen !== true
    && (agent.runtime !== 'external' || agent.healthStatus === 'online')
  ));
}

function validateDepartment(orgId: string, departmentId?: string | null): string | null {
  const id = normalizeText(departmentId, 180);
  if (!id) return null;
  if (!listDepartments(orgId).some(department => department.id === id)) {
    throw new Error('The target department does not belong to this organization');
  }
  return id;
}

function validateMember(orgId: string, memberId?: string | null): string | null {
  const id = normalizeText(memberId, 180);
  if (!id) return null;
  assertActiveMember(orgId, id, true);
  return id;
}

function validateAgents(db: any, orgId: string, agentIds: unknown): string[] {
  const ids = normalizeIds(agentIds);
  if (ids.length === 0) return [];
  const allowed = new Set(organizationAgents(db, orgId).map(agent => String(agent.id)));
  if (ids.some(id => !allowed.has(id))) {
    throw new Error('One or more target agents are unavailable or outside this organization');
  }
  return ids;
}

function getPositionFromDb(db: any, orgId: string, positionId?: string | null): OrganizationPosition | null {
  const id = normalizeText(positionId, 180);
  if (!id) return null;
  return (db.orgPositions as OrganizationPosition[]).find(position => (
    position.id === id && position.orgId === orgId && position.status === 'active'
  )) || null;
}

function validatePosition(db: any, orgId: string, positionId?: string | null): OrganizationPosition | null {
  if (!normalizeText(positionId, 180)) return null;
  const position = getPositionFromDb(db, orgId, positionId);
  if (!position) throw new Error('The target position is unavailable or outside this organization');
  return position;
}

export function listOrganizationPositions(orgId: string, includeArchived = false): OrganizationPosition[] {
  const db = readDB();
  ensureTables(db);
  return (db.orgPositions as OrganizationPosition[])
    .filter(position => position.orgId === orgId && (includeArchived || position.status === 'active'))
    .map(position => ({ ...position, skillTags: [...position.skillTags], memberIds: [...position.memberIds], agentIds: [...position.agentIds] }));
}

export function createOrganizationPosition(input: {
  orgId: string;
  actorUserId: string;
  departmentId?: string | null;
  name: string;
  description?: string;
  skillTags?: string[];
  memberIds?: string[];
  agentIds?: string[];
  isManager?: boolean;
}): OrganizationPosition {
  assertAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const name = normalizeText(input.name, 120);
  if (!name) throw new Error('Position name is required');
  const departmentId = validateDepartment(input.orgId, input.departmentId);
  const memberIds = normalizeIds(input.memberIds);
  for (const memberId of memberIds) validateMember(input.orgId, memberId);
  const agentIds = validateAgents(db, input.orgId, input.agentIds);
  if ((db.orgPositions as OrganizationPosition[]).some(position => (
    position.orgId === input.orgId
    && position.status === 'active'
    && position.departmentId === departmentId
    && position.name.toLowerCase() === name.toLowerCase()
  ))) {
    throw new Error('An active position with this name already exists in the department');
  }
  const timestamp = now();
  const position: OrganizationPosition = {
    id: randomUUID(),
    orgId: input.orgId,
    departmentId,
    name,
    description: normalizeText(input.description, 500),
    skillTags: normalizeList(input.skillTags),
    memberIds,
    agentIds,
    isManager: input.isManager === true,
    status: 'active',
    createdBy: input.actorUserId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.orgPositions.push(position);
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'work.position.create',
    resourceType: 'organization_position',
    resourceId: position.id,
    details: { departmentId, memberIds, agentIds, skillTags: position.skillTags, isManager: position.isManager },
  });
  return position;
}

export function updateOrganizationPosition(input: {
  orgId: string;
  actorUserId: string;
  positionId: string;
  name?: string;
  description?: string;
  departmentId?: string | null;
  skillTags?: string[];
  memberIds?: string[];
  agentIds?: string[];
  isManager?: boolean;
  status?: OrganizationPositionStatus;
}): OrganizationPosition | null {
  assertAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const position = (db.orgPositions as OrganizationPosition[]).find(item => item.id === input.positionId && item.orgId === input.orgId);
  if (!position) return null;
  if (input.name !== undefined) {
    const name = normalizeText(input.name, 120);
    if (!name) throw new Error('Position name is required');
    position.name = name;
  }
  if (input.description !== undefined) position.description = normalizeText(input.description, 500);
  if (input.departmentId !== undefined) position.departmentId = validateDepartment(input.orgId, input.departmentId);
  if (input.skillTags !== undefined) position.skillTags = normalizeList(input.skillTags);
  if (input.memberIds !== undefined) {
    const memberIds = normalizeIds(input.memberIds);
    for (const memberId of memberIds) validateMember(input.orgId, memberId);
    position.memberIds = memberIds;
  }
  if (input.agentIds !== undefined) position.agentIds = validateAgents(db, input.orgId, input.agentIds);
  if (input.isManager !== undefined) position.isManager = input.isManager === true;
  if (input.status !== undefined) position.status = input.status === 'archived' ? 'archived' : 'active';
  position.updatedAt = now();
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'work.position.update',
    resourceType: 'organization_position',
    resourceId: position.id,
    details: { status: position.status, departmentId: position.departmentId, memberIds: position.memberIds, agentIds: position.agentIds },
  });
  return position;
}

export function listOrganizationWorkRoutingRules(orgId: string, includeDisabled = false): OrganizationWorkRoutingRule[] {
  const db = readDB();
  ensureTables(db);
  return (db.orgWorkRoutingRules as OrganizationWorkRoutingRule[])
    .filter(rule => rule.orgId === orgId && (includeDisabled || rule.enabled))
    .sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt))
    .map(rule => ({ ...rule, platforms: [...rule.platforms], keywords: [...rule.keywords], skillTags: [...rule.skillTags], agentIds: [...rule.agentIds] }));
}

export function createOrganizationWorkRoutingRule(input: {
  orgId: string;
  actorUserId: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  platforms?: string[];
  keywords?: string[];
  skillTags?: string[];
  departmentId?: string | null;
  positionId?: string | null;
  memberId?: string | null;
  agentIds?: string[];
  approvalMode?: OrganizationWorkApprovalMode;
  requireApprovalForExternalCommit?: boolean;
}): OrganizationWorkRoutingRule {
  assertAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const name = normalizeText(input.name, 120);
  if (!name) throw new Error('Routing rule name is required');
  const position = validatePosition(db, input.orgId, input.positionId);
  const departmentId = validateDepartment(input.orgId, input.departmentId ?? position?.departmentId);
  if (position && departmentId && position.departmentId && position.departmentId !== departmentId) {
    throw new Error('The target position does not belong to the target department');
  }
  const memberId = validateMember(input.orgId, input.memberId);
  const agentIds = validateAgents(db, input.orgId, input.agentIds);
  if (!departmentId && !position && !memberId && agentIds.length === 0) {
    throw new Error('A routing rule must target a department, position, member, or agent');
  }
  const timestamp = now();
  const rule: OrganizationWorkRoutingRule = {
    id: randomUUID(),
    orgId: input.orgId,
    name,
    enabled: input.enabled !== false,
    priority: Math.max(-1000, Math.min(1000, Math.trunc(Number(input.priority) || 0))),
    platforms: normalizeList(input.platforms, 20),
    keywords: normalizeList(input.keywords, 100),
    skillTags: normalizeList(input.skillTags, 50),
    departmentId,
    positionId: position?.id || null,
    memberId,
    agentIds,
    approvalMode: input.approvalMode === 'admin' ? 'admin' : 'none',
    requireApprovalForExternalCommit: input.requireApprovalForExternalCommit === true,
    createdBy: input.actorUserId,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.orgWorkRoutingRules.push(rule);
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'work.routing_rule.create',
    resourceType: 'organization_work_routing_rule',
    resourceId: rule.id,
    details: { priority: rule.priority, departmentId, positionId: rule.positionId, memberId, agentIds, approvalMode: rule.approvalMode },
  });
  return rule;
}

export function updateOrganizationWorkRoutingRule(input: {
  orgId: string;
  actorUserId: string;
  ruleId: string;
  updates: Partial<Omit<OrganizationWorkRoutingRule, 'id' | 'orgId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'revision'>>;
}): OrganizationWorkRoutingRule | null {
  assertAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const rule = (db.orgWorkRoutingRules as OrganizationWorkRoutingRule[]).find(item => item.id === input.ruleId && item.orgId === input.orgId);
  if (!rule) return null;
  const next = input.updates || {};
  if (next.name !== undefined) {
    const name = normalizeText(next.name, 120);
    if (!name) throw new Error('Routing rule name is required');
    rule.name = name;
  }
  if (next.enabled !== undefined) rule.enabled = next.enabled === true;
  if (next.priority !== undefined) rule.priority = Math.max(-1000, Math.min(1000, Math.trunc(Number(next.priority) || 0)));
  if (next.platforms !== undefined) rule.platforms = normalizeList(next.platforms, 20);
  if (next.keywords !== undefined) rule.keywords = normalizeList(next.keywords, 100);
  if (next.skillTags !== undefined) rule.skillTags = normalizeList(next.skillTags, 50);
  const position = next.positionId !== undefined ? validatePosition(db, input.orgId, next.positionId) : getPositionFromDb(db, input.orgId, rule.positionId);
  if (next.positionId !== undefined) rule.positionId = position?.id || null;
  if (next.departmentId !== undefined) rule.departmentId = validateDepartment(input.orgId, next.departmentId);
  if (position && rule.departmentId && position.departmentId && position.departmentId !== rule.departmentId) {
    throw new Error('The target position does not belong to the target department');
  }
  if (next.memberId !== undefined) rule.memberId = validateMember(input.orgId, next.memberId);
  if (next.agentIds !== undefined) rule.agentIds = validateAgents(db, input.orgId, next.agentIds);
  if (next.approvalMode !== undefined) rule.approvalMode = next.approvalMode === 'admin' ? 'admin' : 'none';
  if (next.requireApprovalForExternalCommit !== undefined) rule.requireApprovalForExternalCommit = next.requireApprovalForExternalCommit === true;
  if (!rule.departmentId && !rule.positionId && !rule.memberId && rule.agentIds.length === 0) {
    throw new Error('A routing rule must target a department, position, member, or agent');
  }
  rule.revision += 1;
  rule.updatedAt = now();
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'work.routing_rule.update',
    resourceType: 'organization_work_routing_rule',
    resourceId: rule.id,
    details: { revision: rule.revision, enabled: rule.enabled },
  });
  return rule;
}

function inferSkillTags(text: string, requested: unknown, agents: any[]): string[] {
  const explicit = normalizeList(requested, 50);
  if (explicit.length > 0) return explicit;
  const haystack = normalizeText(text, 8000).toLowerCase();
  const candidates = new Set<string>();
  for (const agent of agents) {
    for (const tag of [...(agent.skillTags || []), ...(agent.knowledgeDomains || [])]) {
      const normalized = normalizeText(tag, 120).toLowerCase();
      if (normalized && haystack.includes(normalized)) candidates.add(normalized);
    }
  }
  return Array.from(candidates).slice(0, 20);
}

function ruleScore(rule: OrganizationWorkRoutingRule, text: string, platform: string, skills: string[]): number | null {
  if (!rule.enabled) return null;
  const normalizedPlatform = platform.toLowerCase();
  if (rule.platforms.length > 0 && !rule.platforms.includes(normalizedPlatform)) return null;
  const haystack = text.toLowerCase();
  const matchedKeywords = rule.keywords.filter(keyword => haystack.includes(keyword));
  const matchedSkills = rule.skillTags.filter(skill => skills.includes(skill) || haystack.includes(skill));
  if (rule.keywords.length > 0 && matchedKeywords.length === 0) return null;
  if (rule.skillTags.length > 0 && matchedSkills.length === 0) return null;
  return rule.priority * 1000 + matchedKeywords.length * 100 + matchedSkills.length * 50
    + (rule.memberId ? 25 : 0) + rule.agentIds.length * 10 + (rule.positionId ? 5 : 0);
}

function selectRule(
  rules: OrganizationWorkRoutingRule[],
  text: string,
  platform: string,
  skills: string[],
): OrganizationWorkRoutingRule | null {
  return rules
    .map(rule => ({ rule, score: ruleScore(rule, text, platform, skills) }))
    .filter((candidate): candidate is { rule: OrganizationWorkRoutingRule; score: number } => candidate.score !== null)
    .sort((a, b) => b.score - a.score || b.rule.updatedAt.localeCompare(a.rule.updatedAt))[0]?.rule || null;
}

function chooseAgents(input: {
  db: any;
  orgId: string;
  requesterUserId: string;
  text: string;
  skillTags: string[];
  explicitAgentIds?: string[];
  position?: OrganizationPosition | null;
  rule?: OrganizationWorkRoutingRule | null;
}): string[] {
  const agents = organizationAgents(input.db, input.orgId).filter(agent => authorizeOrganizationResource({
    orgId: input.orgId,
    actorUserId: input.requesterUserId,
    resourceType: 'agent',
    resourceId: String(agent.id),
    permission: 'execute',
    ownerUserId: String(agent.ownerUid || agent.userId || ''),
  }).allowed);
  const allowedIds = new Set(agents.map(agent => String(agent.id)));
  const explicit = normalizeIds(input.explicitAgentIds);
  if (explicit.length > 0) {
    const validated = validateAgents(input.db, input.orgId, explicit);
    if (validated.some(id => !allowedIds.has(id))) {
      throw new Error('The requester is not allowed to execute one or more target organization agents');
    }
    return validated;
  }
  const constrained = normalizeIds(input.rule?.agentIds?.length ? input.rule.agentIds : input.position?.agentIds);
  if (constrained.length > 0) return validateAgents(input.db, input.orgId, constrained).filter(id => allowedIds.has(id));
  const text = input.text.toLowerCase();
  const scored = agents.map(agent => {
    const tags = normalizeList([...(agent.skillTags || []), ...(agent.knowledgeDomains || []), agent.category]);
    const matches = tags.filter(tag => input.skillTags.includes(tag) || text.includes(tag)).length;
    return { id: String(agent.id), score: matches * 100 + (agent.status === 'idle' ? 5 : 0) };
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, 3).map(candidate => candidate.id);
}

function createApproval(db: any, workItem: OrganizationWorkItem): OrganizationWorkApproval {
  const timestamp = now();
  const approval: OrganizationWorkApproval = {
    id: randomUUID(),
    orgId: workItem.orgId,
    workItemId: workItem.id,
    workItemRevision: workItem.revision,
    actionDigest: digest(JSON.stringify({
      workItemId: workItem.id,
      revision: workItem.revision,
      departmentId: workItem.departmentId,
      positionId: workItem.positionId,
      assignedMemberId: workItem.assignedMemberId,
      collaboratorMemberIds: workItem.collaboratorMemberIds,
      assignedAgentIds: workItem.assignedAgentIds,
      textDigest: workItem.textDigest,
      sideEffectClass: workItem.sideEffectClass,
    })),
    status: 'pending',
    requestedBy: workItem.requesterUserId,
    decidedBy: null,
    reason: '',
    createdAt: timestamp,
    decidedAt: null,
    updatedAt: timestamp,
  };
  db.orgWorkApprovals.push(approval);
  workItem.approvalId = approval.id;
  workItem.status = 'waiting_approval';
  return approval;
}

function bypassRedundantSelfApproval(input: {
  orgId: string;
  requesterUserId: string;
  requesterRole: string;
  workItem: OrganizationWorkItem;
  approval: OrganizationWorkApproval | null;
}): { workItem: OrganizationWorkItem; approval: OrganizationWorkApproval | null } {
  const canBypass = ['owner', 'admin'].includes(input.requesterRole)
    && input.workItem.status === 'waiting_approval'
    && input.approval?.status === 'pending'
    && input.approval.requestedBy === input.requesterUserId;
  if (!canBypass || !input.approval) {
    return { workItem: input.workItem, approval: input.approval };
  }
  const decision = decideOrganizationWorkApproval({
    orgId: input.orgId,
    approvalId: input.approval.id,
    actorUserId: input.requesterUserId,
    decision: 'approve',
    reason: 'Redundant self-approval bypassed for an organization administrator.',
  });
  return decision || { workItem: input.workItem, approval: input.approval };
}

export function routeOrganizationWork(input: RouteOrganizationWorkInput): RouteOrganizationWorkResult {
  const requesterMembership = assertActiveMember(input.orgId, input.requesterUserId, true);
  const db = readDB();
  ensureTables(db);
  const requestId = normalizeText(input.requestId, 240);
  const source = normalizeText(input.source, 120);
  if (!requestId || !source) throw new Error('Organization work routing requires a source and request identity');
  const idempotencyKey = normalizeText(input.idempotencyKey, 240) || digest(`${input.orgId}\n${source}\n${requestId}`);
  const existing = (db.orgWorkItems as OrganizationWorkItem[]).find(item => (
    item.orgId === input.orgId && item.idempotencyKey === idempotencyKey
  ));
  if (existing) {
    const existingApproval = existing.approvalId
      ? (db.orgWorkApprovals as OrganizationWorkApproval[]).find(item => item.id === existing.approvalId && item.orgId === input.orgId) || null
      : null;
    const routingRule = existing.routingRuleId
      ? (db.orgWorkRoutingRules as OrganizationWorkRoutingRule[]).find(item => item.id === existing.routingRuleId && item.orgId === input.orgId) || null
      : null;
    const { workItem, approval } = bypassRedundantSelfApproval({
      orgId: input.orgId,
      requesterUserId: input.requesterUserId,
      requesterRole: requesterMembership.role,
      workItem: existing,
      approval: existingApproval,
    });
    return { workItem, approval, routingRule, created: false };
  }
  const taskId = normalizeText(input.taskId, 180);
  const existingTask = taskId
    ? (db.orgWorkItems as OrganizationWorkItem[]).find(item => (
        item.orgId === input.orgId
        && item.taskId === taskId
        && !['completed', 'cancelled'].includes(item.status)
      ))
    : null;
  if (existingTask) {
    const existingApproval = existingTask.approvalId
      ? (db.orgWorkApprovals as OrganizationWorkApproval[]).find(item => item.id === existingTask.approvalId && item.orgId === input.orgId) || null
      : null;
    const routingRule = existingTask.routingRuleId
      ? (db.orgWorkRoutingRules as OrganizationWorkRoutingRule[]).find(item => item.id === existingTask.routingRuleId && item.orgId === input.orgId) || null
      : null;
    const { workItem, approval } = bypassRedundantSelfApproval({
      orgId: input.orgId,
      requesterUserId: input.requesterUserId,
      requesterRole: requesterMembership.role,
      workItem: existingTask,
      approval: existingApproval,
    });
    return { workItem, approval, routingRule, created: false };
  }

  const agents = organizationAgents(db, input.orgId);
  const skillTags = inferSkillTags(input.text, input.skillTags, agents);
  const rules = (db.orgWorkRoutingRules as OrganizationWorkRoutingRule[]).filter(rule => rule.orgId === input.orgId);
  const explicitTarget = Boolean(
    input.targetDepartmentId || input.targetPositionId || input.targetMemberId || input.targetMemberIds?.length || input.targetAgentIds?.length,
  );
  const routingRule = explicitTarget ? null : selectRule(rules, input.text, input.platform || source, skillTags);
  const position = validatePosition(db, input.orgId, input.targetPositionId || routingRule?.positionId);
  const departmentId = validateDepartment(input.orgId, input.targetDepartmentId || routingRule?.departmentId || position?.departmentId);
  if (position && departmentId && position.departmentId && position.departmentId !== departmentId) {
    throw new Error('The routed position does not belong to the routed department');
  }
  const requestedMemberIds = normalizeIds(input.targetMemberIds);
  for (const memberId of requestedMemberIds) validateMember(input.orgId, memberId);
  const departmentMemberIds = departmentId
    ? listMembers(input.orgId)
        .filter(member => member.status === 'active' && member.role !== 'viewer' && member.departmentId === departmentId)
        .map(member => member.userId)
        .sort()
    : [];
  const assignedMemberId = validateMember(
    input.orgId,
    input.targetMemberId
      || requestedMemberIds[0]
      || routingRule?.memberId
      || position?.memberIds?.[0]
      || departmentMemberIds[0],
  );
  const collaboratorMemberIds = Array.from(new Set([
    ...requestedMemberIds,
    ...(position?.memberIds || []),
    ...departmentMemberIds,
  ].filter(memberId => memberId && memberId !== assignedMemberId)));
  const assignedAgentIds = chooseAgents({
    db,
    orgId: input.orgId,
    requesterUserId: input.requesterUserId,
    text: input.text,
    skillTags: normalizeList([...skillTags, ...(routingRule?.skillTags || []), ...(position?.skillTags || [])]),
    explicitAgentIds: input.targetAgentIds,
    position,
    rule: routingRule,
  });
  const timestamp = now();
  const workItem: OrganizationWorkItem = {
    id: randomUUID(),
    orgId: input.orgId,
    idempotencyKey,
    requestId,
    source,
    requesterUserId: input.requesterUserId,
    conversationId: normalizeText(input.conversationId, 180),
    taskId,
    textDigest: digest(input.text),
    intentKind: normalizeText(input.intentKind, 80),
    operation: normalizeText(input.operation, 40),
    sideEffectClass: normalizeText(input.sideEffectClass, 40),
    status: assignedMemberId && assignedAgentIds.length === 0 ? 'waiting_human' : 'assigned',
    departmentId,
    positionId: position?.id || null,
    assignedMemberId,
    collaboratorMemberIds,
    assignedAgentIds,
    skillTags: normalizeList([...skillTags, ...(routingRule?.skillTags || []), ...(position?.skillTags || [])]),
    routingRuleId: routingRule?.id || null,
    approvalId: null,
    humanOwnerUserId: assignedMemberId && assignedAgentIds.length === 0 ? assignedMemberId : null,
    revision: 1,
    lastBlocker: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const approvalPolicyMatched = routingRule?.approvalMode === 'admin'
    || (workItem.sideEffectClass === 'external_commit' && routingRule?.requireApprovalForExternalCommit === true);
  const requesterIsAdministrator = ['owner', 'admin'].includes(requesterMembership.role);
  const approvalRequired = approvalPolicyMatched && !requesterIsAdministrator;
  const approval = approvalRequired ? createApproval(db, workItem) : null;
  db.orgWorkItems.push(workItem);
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.requesterUserId,
    action: 'work.item.routed',
    resourceType: 'organization_work_item',
    resourceId: workItem.id,
    details: {
      source,
      requestId,
      status: workItem.status,
      departmentId,
      positionId: workItem.positionId,
      assignedMemberId,
      collaboratorMemberIds,
      assignedAgentIds,
      routingRuleId: workItem.routingRuleId,
      approvalId: workItem.approvalId,
      approvalBypassed: approvalPolicyMatched && requesterIsAdministrator,
      approvalBypassReason: approvalPolicyMatched && requesterIsAdministrator ? 'requester_is_organization_administrator' : '',
      textDigest: workItem.textDigest,
    },
  });
  return { workItem, approval, routingRule, created: true };
}

export function listOrganizationWorkItems(orgId: string, filters: {
  status?: OrganizationWorkItemStatus;
  requesterUserId?: string;
  taskId?: string;
  limit?: number;
} = {}): OrganizationWorkItem[] {
  const db = readDB();
  ensureTables(db);
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(filters.limit) || 100)));
  return (db.orgWorkItems as OrganizationWorkItem[])
    .filter(item => item.orgId === orgId)
    .filter(item => !filters.status || item.status === filters.status)
    .filter(item => !filters.requesterUserId || item.requesterUserId === filters.requesterUserId)
    .filter(item => !filters.taskId || item.taskId === filters.taskId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(item => ({
      ...item,
      collaboratorMemberIds: [...(item.collaboratorMemberIds || [])],
      assignedAgentIds: [...item.assignedAgentIds],
      skillTags: [...item.skillTags],
    }));
}

export function getOrganizationWorkItem(orgId: string, workItemId: string): OrganizationWorkItem | null {
  const db = readDB();
  ensureTables(db);
  return (db.orgWorkItems as OrganizationWorkItem[]).find(item => item.orgId === orgId && item.id === workItemId) || null;
}

export function bindOrganizationWorkItemTask(input: {
  orgId: string;
  workItemId: string;
  conversationId?: string;
  taskId?: string;
}): OrganizationWorkItem | null {
  const db = readDB();
  ensureTables(db);
  const item = (db.orgWorkItems as OrganizationWorkItem[]).find(candidate => candidate.orgId === input.orgId && candidate.id === input.workItemId);
  if (!item) return null;
  const conversationId = normalizeText(input.conversationId, 180);
  const taskId = normalizeText(input.taskId, 180);
  if (item.conversationId && conversationId && item.conversationId !== conversationId) {
    throw new Error('The work item is already bound to another conversation');
  }
  if (item.taskId && taskId && item.taskId !== taskId) {
    throw new Error('The work item is already bound to another task');
  }
  let changed = false;
  if (!item.conversationId && conversationId) { item.conversationId = conversationId; changed = true; }
  if (!item.taskId && taskId) { item.taskId = taskId; changed = true; }
  if (changed) {
    item.updatedAt = now();
    writeDB(db);
  }
  return item;
}

export function setOrganizationWorkItemExecutionStatus(input: {
  orgId: string;
  workItemId: string;
  status: Extract<OrganizationWorkItemStatus, 'executing' | 'completed' | 'blocked' | 'cancelled'>;
  actorUserId: string;
  blocker?: string;
}): OrganizationWorkItem | null {
  const db = readDB();
  ensureTables(db);
  const item = (db.orgWorkItems as OrganizationWorkItem[]).find(candidate => candidate.orgId === input.orgId && candidate.id === input.workItemId);
  if (!item) return null;
  if (item.status === 'waiting_approval' && input.status === 'executing') {
    throw new Error('The work item is still waiting for organization approval');
  }
  if (item.status === 'waiting_human' && input.status === 'executing') {
    throw new Error('The work item is owned by a human and cannot be started by an agent');
  }
  item.status = input.status;
  item.lastBlocker = input.status === 'blocked' ? normalizeText(input.blocker, 500) : '';
  item.updatedAt = now();
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: `work.item.${input.status}`,
    resourceType: 'organization_work_item',
    resourceId: item.id,
    details: { taskId: item.taskId, blocker: item.lastBlocker },
  });
  return item;
}

export function listOrganizationWorkApprovals(orgId: string, status?: OrganizationWorkApprovalStatus): OrganizationWorkApproval[] {
  const db = readDB();
  ensureTables(db);
  return (db.orgWorkApprovals as OrganizationWorkApproval[])
    .filter(item => item.orgId === orgId && (!status || item.status === status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function decideOrganizationWorkApproval(input: {
  orgId: string;
  approvalId: string;
  actorUserId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}): { approval: OrganizationWorkApproval; workItem: OrganizationWorkItem } | null {
  assertAdministrator(input.orgId, input.actorUserId);
  const db = readDB();
  ensureTables(db);
  const approval = (db.orgWorkApprovals as OrganizationWorkApproval[]).find(item => item.id === input.approvalId && item.orgId === input.orgId);
  if (!approval) return null;
  const workItem = (db.orgWorkItems as OrganizationWorkItem[]).find(item => item.id === approval.workItemId && item.orgId === input.orgId);
  if (!workItem) throw new Error('The work item for this approval no longer exists');
  if (approval.status !== 'pending') {
    if ((approval.status === 'approved' && input.decision === 'approve') || (approval.status === 'rejected' && input.decision === 'reject')) {
      return { approval, workItem };
    }
    throw new Error('This approval has already reached a terminal decision');
  }
  if (approval.workItemRevision !== workItem.revision) {
    approval.status = 'expired';
    approval.updatedAt = now();
    writeDB(db);
    throw new Error('This approval expired because the work item routing changed');
  }
  const timestamp = now();
  approval.status = input.decision === 'approve' ? 'approved' : 'rejected';
  approval.decidedBy = input.actorUserId;
  approval.reason = normalizeText(input.reason, 500);
  approval.decidedAt = timestamp;
  approval.updatedAt = timestamp;
  if (input.decision === 'approve') {
    workItem.status = workItem.humanOwnerUserId ? 'waiting_human' : 'assigned';
    workItem.lastBlocker = '';
  } else {
    workItem.status = 'blocked';
    workItem.lastBlocker = approval.reason || 'Organization approval was rejected';
  }
  workItem.updatedAt = timestamp;
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: input.decision === 'approve' ? 'work.approval.approved' : 'work.approval.rejected',
    resourceType: 'organization_work_approval',
    resourceId: approval.id,
    details: { workItemId: workItem.id, workItemRevision: workItem.revision, reason: approval.reason },
  });
  return { approval, workItem };
}

function handoffTarget(item: OrganizationWorkItem): OrganizationWorkHandoffTarget {
  return {
    departmentId: item.departmentId,
    positionId: item.positionId,
    memberId: item.humanOwnerUserId || item.assignedMemberId,
    agentIds: [...item.assignedAgentIds],
  };
}

export function requestOrganizationWorkHandoff(input: {
  orgId: string;
  workItemId: string;
  actorUserId: string;
  type?: OrganizationWorkHandoffType;
  targetDepartmentId?: string | null;
  targetPositionId?: string | null;
  targetMemberId?: string | null;
  targetAgentIds?: string[];
  reason: string;
}): OrganizationWorkHandoff | null {
  assertActiveMember(input.orgId, input.actorUserId, true);
  const db = readDB();
  ensureTables(db);
  const item = (db.orgWorkItems as OrganizationWorkItem[]).find(candidate => candidate.id === input.workItemId && candidate.orgId === input.orgId);
  if (!item) return null;
  if (['completed', 'cancelled'].includes(item.status)) throw new Error('A terminal work item cannot be transferred');
  const actor = getMember(input.orgId, input.actorUserId)!;
  const actorCanTransfer = ['owner', 'admin'].includes(actor.role)
    || item.requesterUserId === input.actorUserId
    || item.assignedMemberId === input.actorUserId
    || item.humanOwnerUserId === input.actorUserId;
  if (!actorCanTransfer) throw new Error('The member is not allowed to transfer this work item');
  const type = input.type || 'transfer';
  const position = validatePosition(db, input.orgId, input.targetPositionId);
  const departmentId = validateDepartment(input.orgId, input.targetDepartmentId ?? position?.departmentId);
  const memberId = validateMember(input.orgId, input.targetMemberId);
  const agentIds = validateAgents(db, input.orgId, input.targetAgentIds);
  if (type === 'human_takeover' && !memberId) throw new Error('Human takeover requires a target member');
  if (type === 'return_to_agent' && agentIds.length === 0) throw new Error('Returning work to agents requires at least one target agent');
  if (!departmentId && !position && !memberId && agentIds.length === 0) throw new Error('A handoff target is required');
  const timestamp = now();
  const handoff: OrganizationWorkHandoff = {
    id: randomUUID(),
    orgId: input.orgId,
    workItemId: item.id,
    workItemRevision: item.revision,
    type,
    status: 'pending',
    actorUserId: input.actorUserId,
    from: handoffTarget(item),
    to: { departmentId, positionId: position?.id || null, memberId, agentIds },
    reason: normalizeText(input.reason, 500),
    decidedBy: null,
    createdAt: timestamp,
    decidedAt: null,
    updatedAt: timestamp,
  };
  if (!handoff.reason) throw new Error('A handoff reason is required');
  db.orgWorkHandoffs.push(handoff);
  item.status = 'waiting_human';
  item.lastBlocker = `Waiting for handoff ${handoff.id} to be accepted`;
  item.updatedAt = timestamp;
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: 'work.handoff.requested',
    resourceType: 'organization_work_handoff',
    resourceId: handoff.id,
    details: { workItemId: item.id, type, to: handoff.to, reason: handoff.reason },
  });
  return handoff;
}

export function decideOrganizationWorkHandoff(input: {
  orgId: string;
  handoffId: string;
  actorUserId: string;
  decision: 'accept' | 'decline';
}): { handoff: OrganizationWorkHandoff; workItem: OrganizationWorkItem } | null {
  assertActiveMember(input.orgId, input.actorUserId, true);
  const db = readDB();
  ensureTables(db);
  const handoff = (db.orgWorkHandoffs as OrganizationWorkHandoff[]).find(item => item.id === input.handoffId && item.orgId === input.orgId);
  if (!handoff) return null;
  const item = (db.orgWorkItems as OrganizationWorkItem[]).find(candidate => candidate.id === handoff.workItemId && candidate.orgId === input.orgId);
  if (!item) throw new Error('The work item for this handoff no longer exists');
  if (handoff.status !== 'pending') {
    if ((handoff.status === 'accepted' && input.decision === 'accept') || (handoff.status === 'declined' && input.decision === 'decline')) {
      return { handoff, workItem: item };
    }
    throw new Error('This handoff has already reached a terminal decision');
  }
  const membership = getMember(input.orgId, input.actorUserId)!;
  const canDecide = ['owner', 'admin'].includes(membership.role)
    || handoff.to.memberId === input.actorUserId;
  if (!canDecide) throw new Error('Only the target member or an organization administrator may decide this handoff');
  if (handoff.workItemRevision !== item.revision) throw new Error('This handoff expired because the work item routing changed');
  const timestamp = now();
  handoff.status = input.decision === 'accept' ? 'accepted' : 'declined';
  handoff.decidedBy = input.actorUserId;
  handoff.decidedAt = timestamp;
  handoff.updatedAt = timestamp;
  if (input.decision === 'accept') {
    item.departmentId = handoff.to.departmentId;
    item.positionId = handoff.to.positionId;
    item.assignedMemberId = handoff.to.memberId;
    item.collaboratorMemberIds = [];
    item.assignedAgentIds = [...handoff.to.agentIds];
    item.humanOwnerUserId = handoff.type === 'human_takeover' || (handoff.to.memberId && handoff.to.agentIds.length === 0)
      ? handoff.to.memberId
      : null;
    item.status = item.humanOwnerUserId ? 'waiting_human' : 'assigned';
    item.revision += 1;
    item.lastBlocker = '';
    if (item.approvalId) {
      const oldApproval = (db.orgWorkApprovals as OrganizationWorkApproval[]).find(candidate => candidate.id === item.approvalId);
      if (oldApproval?.status === 'pending') {
        oldApproval.status = 'expired';
        oldApproval.updatedAt = timestamp;
      }
      item.approvalId = null;
    }
  } else {
    item.departmentId = handoff.from.departmentId;
    item.positionId = handoff.from.positionId;
    item.assignedMemberId = handoff.from.memberId;
    item.collaboratorMemberIds = [];
    item.assignedAgentIds = [...handoff.from.agentIds];
    item.humanOwnerUserId = null;
    item.status = item.assignedAgentIds.length > 0 ? 'assigned' : item.assignedMemberId ? 'waiting_human' : 'blocked';
    item.lastBlocker = item.status === 'blocked' ? 'The requested handoff was declined and no executor remains assigned' : '';
  }
  item.updatedAt = timestamp;
  writeDB(db);
  logAudit({
    orgId: input.orgId,
    userId: input.actorUserId,
    action: input.decision === 'accept' ? 'work.handoff.accepted' : 'work.handoff.declined',
    resourceType: 'organization_work_handoff',
    resourceId: handoff.id,
    details: { workItemId: item.id, workItemRevision: item.revision, type: handoff.type },
  });
  return { handoff, workItem: item };
}

export function listOrganizationWorkHandoffs(orgId: string, workItemId?: string): OrganizationWorkHandoff[] {
  const db = readDB();
  ensureTables(db);
  return (db.orgWorkHandoffs as OrganizationWorkHandoff[])
    .filter(item => item.orgId === orgId && (!workItemId || item.workItemId === workItemId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(item => ({
      ...item,
      from: { ...item.from, agentIds: [...item.from.agentIds] },
      to: { ...item.to, agentIds: [...item.to.agentIds] },
    }));
}

export function resolveMentionedOrganizationMemberIds(input: {
  orgId: string;
  candidateUserIds?: string[];
}): string[] {
  const active = new Set(listMembers(input.orgId)
    .filter(member => member.status === 'active' && member.role !== 'viewer')
    .map(member => member.userId));
  return normalizeIds(input.candidateUserIds).filter(userId => active.has(userId));
}
