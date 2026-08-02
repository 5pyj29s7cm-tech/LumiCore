/**
 * Org DB abstraction layer.
 *
 * All org data access goes through this module instead of touching
 * memoryDB.organizations etc. directly. This keeps the door open for a future
 * PostgreSQL migration — swap the implementation here, zero changes elsewhere.
 */

import { randomUUID } from 'crypto';
import { readDB, writeDB } from '../../db_layer';

// ── Types ────────────────────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerUid: string;
  settings: string; // JSON
  createdAt: string;
  updatedAt: string;
}

export interface Department {
  id: string;
  orgId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'left';

export interface OrgMembership {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  departmentId: string | null;
  status: MembershipStatus;
  invitedBy: string | null;
  joinedAt: string | null;
  createdAt: string;
}

export interface OrgInvitation {
  id: string;
  orgId: string;
  code: string;
  createdBy: string;
  role: OrgRole;
  departmentId: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface KbArticle {
  id: string;
  orgId: string;
  title: string;
  content: string;
  category: string;
  tags: string; // JSON array
  authorId: string;
  status: 'draft' | 'published' | 'archived';
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  ingestionManifest: string;
}

export interface KbEmbedding {
  id: string;
  articleId: string;
  chunkIndex: number;
  embedding: string; // JSON array of floats
  content: string;
  modelName: string;
  createdAt: string;
}

export type TemplateStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'published';

export interface AgentTemplate {
  id: string;
  orgId: string;
  name: string;
  description: string;
  category: string;
  config: string; // JSON
  icon: string;
  version: number;
  status: TemplateStatus;
  authorId: string;
  reviewedBy: string | null;
  reviewComment: string | null;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  orgId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: string; // JSON
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string;
}

// ── Generic helpers ──────────────────────────────────────────────────────

function entDB() {
  return readDB();
}

function entWrite() {
  const db = entDB();
  writeDB(db);
}

function now(): string {
  return new Date().toISOString();
}

function genId(): string {
  return randomUUID();
}

// ── Organizations ────────────────────────────────────────────────────────

export function getOrgById(orgId: string): Organization | undefined {
  return entDB().organizations?.find((o: Organization) => o.id === orgId);
}

export function getOrgBySlug(slug: string): Organization | undefined {
  return entDB().organizations?.find((o: Organization) => o.slug === slug);
}

export function listUserOrgs(userId: string): Organization[] {
  const memberships: OrgMembership[] = entDB().orgMemberships?.filter(
    (m: OrgMembership) => m.userId === userId && m.status === 'active'
  ) || [];
  const orgIds = new Set(memberships.map(m => m.orgId));
  return (entDB().organizations || []).filter((o: Organization) => orgIds.has(o.id));
}

export function createOrg(name: string, slug: string, ownerUid: string): Organization {
  const db = entDB();
  const org: Organization = {
    id: genId(),
    name,
    slug,
    ownerUid,
    settings: '{}',
    createdAt: now(),
    updatedAt: now(),
  };
  if (!db.organizations) db.organizations = [];
  db.organizations.push(org);
  entWrite();
  return org;
}

function fallbackOrganizationName(org: Pick<Organization, 'id' | 'slug'>): string {
  const fromSlug = String(org.slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (fromSlug) {
    return fromSlug.replace(/\b[a-z]/g, character => character.toUpperCase());
  }
  return `Organization ${String(org.id || '').slice(0, 8) || 'Local'}`;
}

export function repairCorruptedOrganizationNames(): number {
  const db = entDB();
  const organizations: Organization[] = db.organizations || [];
  let repaired = 0;
  for (const org of organizations) {
    if (!String(org.name || '').includes('\uFFFD')) continue;
    org.name = fallbackOrganizationName(org);
    org.updatedAt = now();
    repaired += 1;
  }
  if (repaired > 0) writeDB(db);
  return repaired;
}

export function updateOrgProfile(
  orgId: string,
  updates: Record<string, any>,
): Organization | null {
  const db = entDB();
  const org = db.organizations?.find((candidate: Organization) => candidate.id === orgId);
  if (!org) return null;

  if (typeof updates.name === 'string' && updates.name.trim()) {
    org.name = updates.name.trim();
  }

  const explicitSettings = updates.settings && typeof updates.settings === 'object' && !Array.isArray(updates.settings)
    ? updates.settings
    : {};
  const legacySettings = Object.fromEntries(
    Object.entries(updates).filter(([key]) => !['id', 'name', 'slug', 'ownerUid', 'createdAt', 'updatedAt', 'settings'].includes(key)),
  );
  const settingsUpdate = { ...legacySettings, ...explicitSettings };
  if (Object.keys(settingsUpdate).length > 0) {
    const current = JSON.parse(org.settings || '{}');
    org.settings = JSON.stringify({ ...current, ...settingsUpdate });
  }

  org.updatedAt = now();
  writeDB(db);
  return org;
}

export function updateOrgSettings(orgId: string, settings: Record<string, any>): Organization | null {
  const db = entDB();
  const org = db.organizations?.find((o: Organization) => o.id === orgId);
  if (!org) return null;
  const current = JSON.parse(org.settings || '{}');
  org.settings = JSON.stringify({ ...current, ...settings });
  org.updatedAt = now();
  entWrite();
  return org;
}

export function deleteOrg(orgId: string): boolean {
  const db = entDB();
  const idx = db.organizations?.findIndex((o: Organization) => o.id === orgId);
  if (idx === undefined || idx < 0) return false;
  db.organizations.splice(idx, 1);
  // Cascade: remove memberships, departments, invitations
  db.orgMemberships = (db.orgMemberships || []).filter((m: OrgMembership) => m.orgId !== orgId);
  db.departments = (db.departments || []).filter((d: Department) => d.orgId !== orgId);
  db.orgPositions = (db.orgPositions || []).filter((item: any) => item.orgId !== orgId);
  db.orgWorkRoutingRules = (db.orgWorkRoutingRules || []).filter((item: any) => item.orgId !== orgId);
  db.orgWorkItems = (db.orgWorkItems || []).filter((item: any) => item.orgId !== orgId);
  db.orgWorkApprovals = (db.orgWorkApprovals || []).filter((item: any) => item.orgId !== orgId);
  db.orgWorkHandoffs = (db.orgWorkHandoffs || []).filter((item: any) => item.orgId !== orgId);
  db.orgResourcePolicies = (db.orgResourcePolicies || []).filter((item: any) => item.orgId !== orgId);
  db.orgResourceGrants = (db.orgResourceGrants || []).filter((item: any) => item.orgId !== orgId);
  db.orgCredentialReferences = (db.orgCredentialReferences || []).filter((item: any) => item.orgId !== orgId);
  db.orgDevices = (db.orgDevices || []).filter((item: any) => item.orgId !== orgId);
  db.orgInvitations = (db.orgInvitations || []).filter((i: OrgInvitation) => i.orgId !== orgId);
  entWrite();
  return true;
}

// ── Memberships ──────────────────────────────────────────────────────────

export function getMember(orgId: string, userId: string): OrgMembership | undefined {
  return entDB().orgMemberships?.find(
    (m: OrgMembership) => m.orgId === orgId && m.userId === userId
  );
}

export function listMembers(orgId: string): OrgMembership[] {
  return (entDB().orgMemberships || []).filter((m: OrgMembership) => m.orgId === orgId);
}

export function addMember(orgId: string, userId: string, role: OrgRole = 'member', departmentId?: string, invitedBy?: string): OrgMembership {
  const db = entDB();
  const existing = db.orgMemberships?.find(
    (m: OrgMembership) => m.orgId === orgId && m.userId === userId
  );
  if (existing) return existing;

  const membership: OrgMembership = {
    id: genId(),
    orgId,
    userId,
    role,
    departmentId: departmentId || null,
    status: 'active',
    invitedBy: invitedBy || null,
    joinedAt: now(),
    createdAt: now(),
  };
  if (!db.orgMemberships) db.orgMemberships = [];
  db.orgMemberships.push(membership);
  entWrite();
  return membership;
}

export function updateMemberRole(orgId: string, userId: string, newRole: OrgRole): OrgMembership | null {
  const db = entDB();
  const m = db.orgMemberships?.find(
    (m: OrgMembership) => m.orgId === orgId && m.userId === userId
  );
  if (!m) return null;
  m.role = newRole;
  entWrite();
  return m;
}

export function removeMember(orgId: string, userId: string): boolean {
  const db = entDB();
  const idx = db.orgMemberships?.findIndex(
    (m: OrgMembership) => m.orgId === orgId && m.userId === userId
  );
  if (idx === undefined || idx < 0) return false;
  db.orgMemberships.splice(idx, 1);
  entWrite();
  return true;
}

export function setMemberStatus(orgId: string, userId: string, status: MembershipStatus): OrgMembership | null {
  const db = entDB();
  const m = db.orgMemberships?.find(
    (m: OrgMembership) => m.orgId === orgId && m.userId === userId
  );
  if (!m) return null;
  m.status = status;
  if (status === 'left') m.joinedAt = null as any; // clear join date
  entWrite();
  return m;
}

// ── Departments ──────────────────────────────────────────────────────────

export function listDepartments(orgId: string): Department[] {
  return (entDB().departments || []).filter((d: Department) => d.orgId === orgId);
}

export function createDepartment(orgId: string, name: string, parentId?: string): Department {
  const db = entDB();
  const dept: Department = {
    id: genId(),
    orgId,
    name,
    parentId: parentId || null,
    createdAt: now(),
  };
  if (!db.departments) db.departments = [];
  db.departments.push(dept);
  entWrite();
  return dept;
}

// ── Invitations ──────────────────────────────────────────────────────────

export function createInvitation(
  orgId: string,
  createdBy: string,
  opts: { role?: OrgRole; departmentId?: string; maxUses?: number; expiresAt?: string } = {}
): OrgInvitation {
  const db = entDB();
  const code = generateCode();
  const inv: OrgInvitation = {
    id: genId(),
    orgId,
    code,
    createdBy,
    role: opts.role || 'member',
    departmentId: opts.departmentId || null,
    maxUses: opts.maxUses || 0,
    useCount: 0,
    expiresAt: opts.expiresAt || null,
    createdAt: now(),
  };
  if (!db.orgInvitations) db.orgInvitations = [];
  db.orgInvitations.push(inv);
  entWrite();
  return inv;
}

export function getInvitationByCode(code: string): OrgInvitation | undefined {
  return entDB().orgInvitations?.find((i: OrgInvitation) => i.code === code);
}

export function useInvitation(code: string): OrgInvitation | null {
  const db = entDB();
  const inv = db.orgInvitations?.find((i: OrgInvitation) => i.code === code);
  if (!inv) return null;
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return null;
  if (inv.maxUses > 0 && inv.useCount >= inv.maxUses) return null;
  inv.useCount++;
  entWrite();
  return inv;
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  // Check uniqueness
  if (entDB().orgInvitations?.find((i: OrgInvitation) => i.code === code)) {
    return generateCode();
  }
  return code;
}

// ── Knowledge Base ───────────────────────────────────────────────────────

export function listKbArticles(orgId: string, filters?: { category?: string; status?: string }): KbArticle[] {
  let articles = (entDB().orgKbArticles || []).filter((a: KbArticle) => a.orgId === orgId);
  if (filters?.category) articles = articles.filter((a: KbArticle) => a.category === filters.category);
  if (filters?.status) articles = articles.filter((a: KbArticle) => a.status === filters.status);
  return articles;
}

export function getKbArticle(orgId: string, articleId: string): KbArticle | undefined {
  return entDB().orgKbArticles?.find(
    (a: KbArticle) => a.orgId === orgId && a.id === articleId
  );
}

export function createKbArticle(
  orgId: string,
  authorId: string,
  data: { title: string; content: string; category?: string; tags?: string[]; status?: 'draft' | 'published' }
): KbArticle {
  const db = entDB();
  const article: KbArticle = {
    id: genId(),
    orgId,
    title: data.title,
    content: data.content,
    category: data.category || 'general',
    tags: JSON.stringify(data.tags || []),
    authorId,
    status: data.status || 'published',
    viewCount: 0,
    createdAt: now(),
    updatedAt: now(),
    ingestionManifest: '{}',
  };
  if (!db.orgKbArticles) db.orgKbArticles = [];
  db.orgKbArticles.push(article);
  entWrite();
  return article;
}

export function updateKbArticle(orgId: string, articleId: string, updates: Partial<Pick<KbArticle, 'title' | 'content' | 'category' | 'tags' | 'status'>>): KbArticle | null {
  const db = entDB();
  const article = db.orgKbArticles?.find(
    (a: KbArticle) => a.orgId === orgId && a.id === articleId
  );
  if (!article) return null;
  Object.assign(article, updates, { updatedAt: now() });
  entWrite();
  return article;
}

/** Persist index evidence without changing the source article revision timestamp. */
export function setKbArticleIngestionManifest(
  orgId: string,
  articleId: string,
  manifest: string,
): KbArticle | null {
  const article = entDB().orgKbArticles?.find(
    (candidate: KbArticle) => candidate.orgId === orgId && candidate.id === articleId,
  );
  if (!article) return null;
  article.ingestionManifest = manifest || '{}';
  entWrite();
  return article;
}

export function deleteKbArticle(orgId: string, articleId: string): boolean {
  const db = entDB();
  const idx = db.orgKbArticles?.findIndex(
    (a: KbArticle) => a.orgId === orgId && a.id === articleId
  );
  if (idx === undefined || idx < 0) return false;
  db.orgKbArticles.splice(idx, 1);
  // Cascade: remove embeddings
  db.orgKbEmbeddings = (db.orgKbEmbeddings || []).filter(
    (e: KbEmbedding) => e.articleId !== articleId
  );
  entWrite();
  return true;
}

// ── KB Embeddings ────────────────────────────────────────────────────────

export function saveKbEmbedding(articleId: string, chunkIndex: number, embedding: number[], content: string, modelName: string = 'text-embedding-3-small'): KbEmbedding {
  const db = entDB();
  const emb: KbEmbedding = {
    id: genId(),
    articleId,
    chunkIndex,
    embedding: JSON.stringify(embedding),
    content,
    modelName,
    createdAt: now(),
  };
  if (!db.orgKbEmbeddings) db.orgKbEmbeddings = [];
  db.orgKbEmbeddings.push(emb);
  entWrite();
  return emb;
}

export function getKbEmbeddings(articleId: string): KbEmbedding[] {
  return (entDB().orgKbEmbeddings || []).filter((e: KbEmbedding) => e.articleId === articleId);
}

export function getAllKbEmbeddings(orgId: string): KbEmbedding[] {
  const articles = (entDB().orgKbArticles || []).filter((a: KbArticle) => a.orgId === orgId);
  const articleIds = new Set(articles.map(a => a.id));
  return (entDB().orgKbEmbeddings || []).filter((e: KbEmbedding) => articleIds.has(e.articleId));
}

export function deleteKbEmbeddings(articleId: string): void {
  const db = entDB();
  db.orgKbEmbeddings = (db.orgKbEmbeddings || []).filter(
    (e: KbEmbedding) => e.articleId !== articleId
  );
  entWrite();
}

// ── Agent Templates ──────────────────────────────────────────────────────

export function listTemplates(orgId: string, filters?: { status?: TemplateStatus; category?: string; authorId?: string }): AgentTemplate[] {
  let templates = (entDB().agentTemplates || []).filter((t: AgentTemplate) => t.orgId === orgId);
  if (filters?.status) templates = templates.filter((t: AgentTemplate) => t.status === filters.status);
  if (filters?.category) templates = templates.filter((t: AgentTemplate) => t.category === filters.category);
  if (filters?.authorId) templates = templates.filter((t: AgentTemplate) => t.authorId === filters.authorId);
  return templates;
}

export function getTemplate(orgId: string, templateId: string): AgentTemplate | undefined {
  return entDB().agentTemplates?.find(
    (t: AgentTemplate) => t.orgId === orgId && t.id === templateId
  );
}

export function createTemplate(
  orgId: string,
  authorId: string,
  data: { name: string; description: string; category: string; config: any; icon?: string }
): AgentTemplate {
  const db = entDB();
  const template: AgentTemplate = {
    id: genId(),
    orgId,
    name: data.name,
    description: data.description,
    category: data.category,
    config: JSON.stringify(data.config),
    icon: data.icon || 'Bot',
    version: 1,
    status: 'draft',
    authorId,
    reviewedBy: null,
    reviewComment: null,
    downloadCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  if (!db.agentTemplates) db.agentTemplates = [];
  db.agentTemplates.push(template);
  entWrite();
  return template;
}

export function updateTemplateStatus(
  orgId: string,
  templateId: string,
  status: TemplateStatus,
  reviewerId?: string,
  comment?: string
): AgentTemplate | null {
  const db = entDB();
  const t = db.agentTemplates?.find(
    (t: AgentTemplate) => t.orgId === orgId && t.id === templateId
  );
  if (!t) return null;
  t.status = status;
  t.updatedAt = now();
  if (reviewerId) t.reviewedBy = reviewerId;
  if (comment !== undefined) t.reviewComment = comment;
  entWrite();
  return t;
}

export function incrementTemplateDownloads(orgId: string, templateId: string): void {
  const db = entDB();
  const t = db.agentTemplates?.find(
    (t: AgentTemplate) => t.orgId === orgId && t.id === templateId
  );
  if (t) {
    t.downloadCount = (t.downloadCount || 0) + 1;
    entWrite();
  }
}

// ── Audit Log ────────────────────────────────────────────────────────────

export function logAudit(entry: {
  orgId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}): void {
  const db = entDB();
  const log: AuditEntry = {
    id: genId(),
    orgId: entry.orgId,
    userId: entry.userId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    details: JSON.stringify(entry.details || {}),
    ipAddress: entry.ipAddress || null,
    userAgent: entry.userAgent || null,
    timestamp: now(),
  };
  if (!db.auditLog) db.auditLog = [];
  db.auditLog.push(log);
  entWrite();
}

export function listAuditLog(orgId: string, limit: number = 50, offset: number = 0): AuditEntry[] {
  const entries = (entDB().auditLog || []).filter((e: AuditEntry) => e.orgId === orgId);
  return entries.sort((a: AuditEntry, b: AuditEntry) => b.timestamp.localeCompare(a.timestamp)).slice(offset, offset + limit);
}

// ── Domain helpers ───────────────────────────────────────────────────────

/** Set domain on existing memories/interactions/agents in bulk */
export function setDomain(collection: 'memories' | 'interactions' | 'agents', ids: string[], domain: 'personal' | 'work', orgId: string | null): void {
  const db = entDB();
  const items = db[collection] as any[] | undefined;
  if (!items) return;
  for (const item of items) {
    if (ids.includes(item.id)) {
      item.domain = domain;
      item.orgId = orgId || '';
    }
  }
  entWrite();
}
