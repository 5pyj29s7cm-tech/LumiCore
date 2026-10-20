import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { isLegalSourceMaterial, legalCaseSourceFingerprint, type LegalWorkflowRun } from '../../shared/legal_workflow_receipts';
import type { LegalReasoningLink } from '../../shared/legal_workflow_receipts';
import { getDataPath, resolveMigratedDataFile } from '../config/data_path';
import { sameArtifactPath } from '../tools/artifact_evidence';
import * as EDB from './db';
import { recordLegalCaseWrite } from '../legal/execution';
import { searchKnowledgeText, type KnowledgeSearchResult } from './kb';
import { CN_LEGAL_CASE_DEFAULTS } from '../regions/messages/skill_messages';
import {
  assertOrganizationResourceAccess,
  authorizeOrganizationResource,
  getOrganizationResourcePolicy,
  removeOrganizationResourcePolicy,
  type OrganizationResourcePermission,
} from './resource_acl';
import {
  evaluateLegalCaseWorkflow,
  type LegalCaseWorkflowEvaluation,
  type LegalCaseWorkflowOptions,
  type LegalCaseWorkflowStep,
  type LegalCaseWorkflowStepState,
} from '../../shared/legal_case_workflow';

export type {
  LegalCaseWorkflowEvaluation,
  LegalCaseWorkflowOptions,
  LegalCaseWorkflowStep,
  LegalCaseWorkflowStepState,
} from '../../shared/legal_case_workflow';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';
export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface OrgLegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  content: string;
  fileName?: string;
  localPath?: string;
  source: 'manual' | 'meeting' | 'feishu' | 'wecom' | 'wechat' | 'tool' | 'import';
  createdBy: string;
  createdAt: string;
  reasoningLinks?: LegalReasoningLink[];
  reasoningBasis?: string;
}

export interface OrgLegalCaseFile {
  id: string;
  orgId: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  factDate?: string;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  clientPartyName?: string;
  clientRole?: string;
  objective?: string;
  workflowRuns?: LegalWorkflowRun[];
  materials: OrgLegalCaseMaterial[];
  removedMaterialIds?: string[];
  assetTraceWorkflow?: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const STORE_PATH = getDataPath(path.join('org', 'legal_cases.json'));

interface StoreShape {
  cases: OrgLegalCaseFile[];
}

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { cases: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...parsed, cases: Array.isArray(parsed?.cases) ? parsed.cases : [] };
  } catch {
    return { cases: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeSnapshotId(value: unknown): string {
  const normalized = normalizeText(value).slice(0, 200);
  if (!normalized || !/^[a-zA-Z0-9_.:@-]+$/.test(normalized)) {
    throw new Error('A valid client case id is required.');
  }
  return normalized;
}

function normalizeSnapshotMaterial(
  value: Partial<OrgLegalCaseMaterial>,
  userId: string,
): OrgLegalCaseMaterial {
  const type = ['consultation', 'evidence', 'pleading', 'judgment', 'contract', 'note'].includes(String(value.type || ''))
    ? value.type as LegalCaseMaterialType
    : 'note';
  const source = ['manual', 'meeting', 'feishu', 'wecom', 'wechat', 'tool', 'import'].includes(String(value.source || ''))
    ? value.source as OrgLegalCaseMaterial['source']
    : 'manual';
  return {
    ...value,
    id: normalizeText(value.id) || randomUUID(),
    type,
    title: normalizeText(value.title) || CN_LEGAL_CASE_DEFAULTS.materialTitle,
    content: normalizeText(value.content),
    fileName: normalizeText(value.fileName) || undefined,
    localPath: normalizeText(value.localPath) || undefined,
    source,
    createdBy: normalizeText(value.createdBy) || userId,
    createdAt: normalizeText(value.createdAt) || now(),
  };
}

function mergeSnapshotMaterials(
  current: OrgLegalCaseMaterial[],
  incoming: Partial<OrgLegalCaseMaterial>[],
  userId: string,
): OrgLegalCaseMaterial[] {
  const existingById = new Map((current || []).map(material => [material.id, material]));
  const seen = new Set<string>();
  const merged = incoming.map(value => {
    const normalized = normalizeSnapshotMaterial(value, userId);
    const existing = existingById.get(normalized.id);
    seen.add(normalized.id);
    if (!existing) return normalized;
    if (existing.source === 'tool') {
      // Server tools own their generated material and artifact paths. A stale
      // browser snapshot must never replace that richer persisted receipt.
      return { ...normalized, ...existing };
    }
    return {
      ...existing,
      ...normalized,
      fileName: normalized.fileName || existing.fileName,
      localPath: normalized.localPath || existing.localPath,
      createdBy: existing.createdBy || normalized.createdBy,
      createdAt: existing.createdAt || normalized.createdAt,
    };
  });
  for (const material of current || []) {
    if (!seen.has(material.id)) merged.push(material);
  }
  return merged;
}

/**
 * Mirrors a client-owned case into the server case ledger without creating a
 * second identity. Chat, voice and direct legal tools can then resolve the
 * exact case selected in the client instead of searching the source tree.
 */
export function upsertCaseSnapshot(
  orgId: string,
  userId: string,
  input: Partial<OrgLegalCaseFile> & { id: string },
): OrgLegalCaseFile {
  const store = readStore();
  const caseId = normalizeSnapshotId(input.id);
  const index = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  const current = index >= 0 ? store.cases[index] : null;
  if (current && getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId,
      actorUserId: userId,
      resourceType: 'legal_case',
      resourceId: caseId,
      permission: 'write',
      ownerUserId: current.createdBy,
    });
  }
  const incomingTime = Date.parse(String(input.updatedAt || ''));
  if (current && (!Number.isFinite(incomingTime) || incomingTime < Date.parse(current.updatedAt))) return current;
  const ts = now();
  const stage = ['consultation', 'filing', 'trial', 'judgment', 'enforcement', 'closed'].includes(String(input.stage || ''))
    ? input.stage as LegalCaseStage
    : current?.stage || 'consultation';
  // Snapshots preserve historical tombstones; existing server materials must
  // be unlinked through the revision-checked removal owner.
  const removedMaterialIds = [...new Set([...(current?.removedMaterialIds || []), ...(Array.isArray(input.removedMaterialIds) ? input.removedMaterialIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !current?.materials.some(material => material.id === id)) : [])])];
  const removed = new Set(removedMaterialIds);
  const materials = (Array.isArray(input.materials)
    ? mergeSnapshotMaterials(current?.materials || [], input.materials, userId)
    : current?.materials || []).filter(material => !removed.has(material.id));
  const caseFile: OrgLegalCaseFile = {
    ...current,
    ...input,
    id: caseId,
    orgId,
    title: normalizeText(input.title) || current?.title || CN_LEGAL_CASE_DEFAULTS.title,
    caseNumber: Object.hasOwn(input, 'caseNumber') ? normalizeText(input.caseNumber) : current?.caseNumber || '',
    party: Object.hasOwn(input, 'party') ? normalizeText(input.party) : current?.party || '',
    cause: Object.hasOwn(input, 'cause') ? normalizeText(input.cause) : current?.cause || '',
    court: Object.hasOwn(input, 'court') ? normalizeText(input.court) : current?.court || '',
    judge: Object.hasOwn(input, 'judge') ? normalizeText(input.judge) : current?.judge || '',
    stage,
    factDate: normalizeText(input.factDate) || current?.factDate,
    hearingDate: Object.hasOwn(input, 'hearingDate') ? normalizeText(input.hearingDate) : current?.hearingDate || '',
    judgmentDate: Object.hasOwn(input, 'judgmentDate') ? normalizeText(input.judgmentDate) : current?.judgmentDate || '',
    appealDeadline: Object.hasOwn(input, 'appealDeadline') ? normalizeText(input.appealDeadline) : current?.appealDeadline || '',
    enforcementDeadline: Object.hasOwn(input, 'enforcementDeadline') ? normalizeText(input.enforcementDeadline) : current?.enforcementDeadline || '',
    notes: Object.hasOwn(input, 'notes') ? normalizeText(input.notes) : current?.notes || '',
    clientPartyName: Object.hasOwn(input, 'clientPartyName') ? normalizeText(input.clientPartyName) : current?.clientPartyName,
    clientRole: normalizeText(input.clientRole) || current?.clientRole,
    objective: normalizeText(input.objective) || current?.objective,
    workflowRuns: current?.workflowRuns?.filter(run => !run.materialIds.some(id => removed.has(id))),
    materials,
    removedMaterialIds,
    assetTraceWorkflow: input.assetTraceWorkflow && typeof input.assetTraceWorkflow === 'object'
      ? input.assetTraceWorkflow
      : current?.assetTraceWorkflow,
    createdBy: current?.createdBy || userId,
    updatedBy: userId,
    createdAt: normalizeText(input.createdAt) || current?.createdAt || ts,
    updatedAt: ts,
  };
  // A sync acknowledgement causes the client to refresh its snapshot. Avoid
  // turning that refresh into an endless write -> new timestamp -> sync loop.
  if (current && JSON.stringify({ ...caseFile, updatedAt: current.updatedAt }) === JSON.stringify(current)) return current;
  if (index >= 0) store.cases[index] = caseFile;
  else store.cases.unshift(caseFile);
  writeStore(store);
  recordLegalCaseWrite(orgId, userId, caseFile.id, caseFile.materials.filter(material => !current?.materials.some(prior => prior.id === material.id)).map(material => material.id));
  EDB.logAudit({
    orgId,
    userId,
    action: current ? 'legal_case.client_snapshot.update' : 'legal_case.client_snapshot.create',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber, materialCount: materials.length },
  });
  return caseFile;
}

export function evaluateCaseWorkflow(
  caseFile: Partial<OrgLegalCaseFile>,
  options: LegalCaseWorkflowOptions = {},
): LegalCaseWorkflowEvaluation {
  return evaluateLegalCaseWorkflow(caseFile, options);
}

function normalizeLegalDateMatch(match?: RegExpMatchArray | null): string {
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    + (match[4] ? ` ${match[4].padStart(2, '0')}:${(match[5] || '00').padStart(2, '0')}` : '');
}

function extractHearingDate(text: string): string {
  const datePattern = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/;
  const hearingWindow = text.match(new RegExp(`(?:开庭|庭审|审理)[^\n。；;]{0,80}${datePattern.source}|${datePattern.source}[^\n。；;]{0,40}(?:开庭|庭审|审理)`));
  if (hearingWindow) {
    const nested = hearingWindow[0].match(datePattern);
    if (nested) return normalizeLegalDateMatch(nested);
  }
  return '';
}

export function extractLegalCaseHints(text: string): Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> {
  const hints: Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> = {};
  const caseNumber = text.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
  const court = text.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
  const hearingDate = extractHearingDate(text);
  const cause = text.match(/案由[：:\s]+([^\n，。；;]{2,40})/)?.[1] || '';
  if (caseNumber) hints.caseNumber = caseNumber;
  if (court) hints.court = court;
  if (hearingDate) hints.hearingDate = hearingDate;
  if (cause) hints.cause = cause.trim();
  return hints;
}

function canAccessCase(
  caseFile: OrgLegalCaseFile,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): boolean {
  const { policy } = getOrganizationResourcePolicy(caseFile.orgId, 'legal_case', caseFile.id);
  if (!policy) return true;
  if (!actorUserId) return false;
  return authorizeOrganizationResource({
    orgId: caseFile.orgId,
    actorUserId,
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    permission,
    ownerUserId: caseFile.createdBy,
  }).allowed;
}

export function legalWorkspaceNamespace(userId: string, orgId?: string): string {
  return orgId || `personal:${String(userId || '').trim().replace(/[^a-zA-Z0-9_.@-]+/g, '_').replace(/^_+|_+$/g, '') || 'anonymous'}`;
}

/** Only server-issued receipts grant access; editable case prose does not. */
export function canReadCaseOutput(orgId: string, userId: string, filePath: string): boolean {
  return readStore().cases.some(item => item.orgId === orgId && canAccessCase(item, userId, 'read')
    && (item.workflowRuns || []).some(run => run.artifacts.some(artifact => sameArtifactPath(artifact, filePath))));
}

export function listCases(orgId: string, query = '', limit: number | null = 50, actorUserId?: string): OrgLegalCaseFile[] {
  const q = query.trim().toLowerCase();
  let cases = readStore().cases.filter(item => item.orgId === orgId && canAccessCase(item, actorUserId, 'read'));
  if (q) {
    cases = cases.filter(item => {
      const haystack = [
        item.title,
        item.caseNumber,
        item.party,
        item.cause,
        item.court,
        item.judge,
        item.notes,
        ...(item.materials || []).map(mat => `${mat.title}\n${mat.content.slice(0, 2000)}`),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  }
  cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return limit === null ? cases : cases.slice(0, Math.max(1, Math.min(limit, 200)));
}

/** Personal deletions reuse the complete durable audit ledger, never an org listing. */
export function listPersonalDeletedCaseIds(userId: string): string[] {
  const orgId = legalWorkspaceNamespace(userId);
  const liveIds = new Set(readStore().cases.filter(item => item.orgId === orgId).map(item => item.id));
  return [...new Set(EDB.listAuditLog(orgId, null).filter(entry => entry.userId === userId
    && entry.action === 'legal_case.delete' && entry.resourceType === 'legal_case'
    && !liveIds.has(entry.resourceId)).map(entry => entry.resourceId))];
}

export function recordPersonalCaseDeletion(userId: string, caseId: string): void {
  const id = normalizeSnapshotId(caseId);
  if (listPersonalDeletedCaseIds(userId).includes(id)) return;
  EDB.logAudit({ orgId: legalWorkspaceNamespace(userId), userId, action: 'legal_case.delete',
    resourceType: 'legal_case', resourceId: id, details: { source: 'personal_client' } });
}

export function getCase(
  orgId: string,
  caseId: string,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): OrgLegalCaseFile | null {
  const caseFile = readStore().cases.find(item => item.orgId === orgId && item.id === caseId) || null;
  return caseFile && canAccessCase(caseFile, actorUserId, permission) ? caseFile : null;
}

export interface LegalMaterialReview {
  revision: string;
  status: 'pending' | 'confirmed' | 'revoked' | 'stale';
  reviewedAt?: string;
  reviewerId?: string;
  scope: 'archived_text' | 'archived_text_and_file';
}

const MATERIAL_REVIEW_ACTION = 'legal_case.material.review';

function materialReviewRevision(caseFile: OrgLegalCaseFile, material: OrgLegalCaseMaterial): Pick<LegalMaterialReview, 'revision' | 'scope'> {
  let fileState = material.localPath ? 'unavailable' : 'none';
  let fileHash = '';
  if (material.localPath) {
    try {
      const filePath = resolveMigratedDataFile(path.resolve(material.localPath));
      if (fs.statSync(filePath).isFile()) {
        fileHash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        fileState = 'file';
      } else fileState = 'directory';
    } catch { /* An absent/unreadable file is never confirmed as a file version. */ }
  }
  const revision = createHash('sha256').update(JSON.stringify({
    caseId: caseFile.id, orgId: caseFile.orgId,
    caseSourceFingerprint: legalCaseSourceFingerprint(caseFile),
    sources: (caseFile.materials || []).filter(isLegalSourceMaterial).map(item => [
      item.id, item.type, item.source, item.title, item.content, item.localPath,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    stage: caseFile.stage, judge: caseFile.judge,
    dates: [caseFile.factDate, caseFile.hearingDate, caseFile.judgmentDate, caseFile.appealDeadline, caseFile.enforcementDeadline],
    material: [material.id, material.type, material.source, material.title, material.content, material.fileName,
      material.localPath, material.reasoningLinks, material.reasoningBasis],
    fileState, fileHash,
  })).digest('hex');
  return { revision, scope: fileState === 'file' ? 'archived_text_and_file' : 'archived_text' };
}

/** The audit event is the only review authority; editable case snapshots are not. */
export function getMaterialReview(orgId: string, userId: string, caseId: string, materialId: string): LegalMaterialReview | null {
  const caseFile = getCase(orgId, caseId, userId);
  const material = caseFile?.materials.find(item => item.id === materialId);
  if (!caseFile || !material) return null;
  const current = materialReviewRevision(caseFile, material);
  let latest: { timestamp: string; userId: string; revision: string; decision: 'confirmed' | 'revoked' } | undefined;
  for (const entry of EDB.listAuditLog(orgId, null)) {
    if (entry.action !== MATERIAL_REVIEW_ACTION || entry.resourceType !== 'legal_case' || entry.resourceId !== caseId) continue;
    try {
      const details = JSON.parse(entry.details);
      if (details.materialId !== materialId || !['confirmed', 'revoked'].includes(details.decision)
        || !/^[a-f0-9]{64}$/.test(String(details.revision || ''))) continue;
      // listAuditLog sorts newest first, retaining append order for equal timestamps.
      // The last appended event therefore wins a confirmation/revocation in one ms.
      if (!latest || entry.timestamp >= latest.timestamp) latest = {
        timestamp: entry.timestamp, userId: entry.userId, revision: details.revision, decision: details.decision,
      };
    } catch { /* Ignore unrelated or malformed audit details. */ }
  }
  if (!latest) return { ...current, status: 'pending' };
  return { ...current, status: latest.revision === current.revision ? latest.decision : 'stale',
    reviewedAt: latest.timestamp, reviewerId: latest.userId };
}

/** Called only by the authenticated human review route, never by a model tool. */
export function recordMaterialReview(orgId: string, userId: string, caseId: string, materialId: string,
  input: { expectedRevision: string; decision: 'confirmed' | 'revoked' }): LegalMaterialReview | null {
  const caseFile = getCase(orgId, caseId, userId, 'write');
  const material = caseFile?.materials.find(item => item.id === materialId);
  if (!caseFile || !material) return null;
  const current = materialReviewRevision(caseFile, material);
  if (input.expectedRevision !== current.revision) throw Object.assign(new Error('The archived material changed after review. Review its current version again.'),
    { code: 'LEGAL_MATERIAL_REVISION_CHANGED', statusCode: 409 });
  if (!['confirmed', 'revoked'].includes(input.decision)) throw Object.assign(new Error('A confirmed or revoked review decision is required.'), { statusCode: 400 });
  EDB.logAudit({ orgId, userId, action: MATERIAL_REVIEW_ACTION, resourceType: 'legal_case', resourceId: caseId,
    details: { materialId, revision: current.revision, decision: input.decision, scope: current.scope } });
  return getMaterialReview(orgId, userId, caseId, materialId);
}

/** Removes only this case association; original files and knowledge entries remain. */
export function removeMaterial(orgId: string, userId: string, caseId: string, materialId: string, expectedRevision: string): OrgLegalCaseFile | null {
  const caseFile = getCase(orgId, caseId, userId, 'write');
  const material = caseFile?.materials.find(item => item.id === materialId);
  if (!caseFile || !material) return null;
  const current = materialReviewRevision(caseFile, material);
  if (expectedRevision !== current.revision) throw Object.assign(new Error('The archived material changed. Read its current version before removing it.'),
    { code: 'LEGAL_MATERIAL_REVISION_CHANGED', statusCode: 409 });
  const saved = updateCase(orgId, userId, caseId, { removedMaterialIds: [...(caseFile.removedMaterialIds || []), materialId] });
  EDB.logAudit({ orgId, userId, action: 'legal_case.material.remove', resourceType: 'legal_case', resourceId: caseId,
    details: { materialId, revision: current.revision, retainedFilesAndKnowledge: true } });
  return saved;
}

export interface LegalCaseKnowledgeResult extends KnowledgeSearchResult {
  caseId: string;
  materialId?: string;
  materialSource: string;
}

/** Read the case ledger itself: no duplicate archive, model dependency or
 * newest-200 truncation. New and edited materials are visible on the next turn. */
export function searchCaseKnowledge(orgId: string, userId: string, query: string, limit = 5): LegalCaseKnowledgeResult[] {
  const articles: EDB.KbArticle[] = [];
  const sources = new Map<string, Pick<LegalCaseKnowledgeResult, 'caseId' | 'materialId' | 'materialSource'>>();
  for (const item of readStore().cases) {
    if (item.orgId !== orgId || !canAccessCase(item, userId, 'read')) continue;
    const add = (id: string, title: string, content: string, materialSource: string, materialId?: string) => {
      if (!content.trim()) return;
      sources.set(id, { caseId: item.id, materialId, materialSource });
      articles.push({
        id, orgId, title, content, category: 'legal_case_material',
        tags: JSON.stringify([`case-id:${item.id}`, `source:${materialSource}`]),
        authorId: item.createdBy, status: 'published', viewCount: 0,
        createdAt: item.createdAt, updatedAt: item.updatedAt, ingestionManifest: '{}',
      });
    };
    add(`case:${item.id}`, item.title,
      [item.caseNumber, item.party, item.cause, item.court, item.notes].filter(Boolean).join('\n'), 'case_record');
    for (const material of item.materials || []) {
      add(`case:${item.id}:material:${material.id}`, `${item.title} / ${material.title}`,
        material.content, material.source === 'tool' ? 'generated_draft_not_evidence' : material.source, material.id);
    }
  }
  return searchKnowledgeText(articles, query, limit).map(result => ({ ...result, ...sources.get(result.articleId)! }));
}

export function createCase(orgId: string, userId: string, input: Partial<OrgLegalCaseFile>): OrgLegalCaseFile {
  const store = readStore();
  const ts = now();
  const caseFile: OrgLegalCaseFile = {
    id: randomUUID(),
    orgId,
    title: normalizeText(input.title) || CN_LEGAL_CASE_DEFAULTS.title,
    caseNumber: normalizeText(input.caseNumber),
    party: normalizeText(input.party),
    cause: normalizeText(input.cause),
    court: normalizeText(input.court),
    judge: normalizeText(input.judge),
    stage: (input.stage as LegalCaseStage) || 'consultation',
    factDate: normalizeText(input.factDate) || undefined,
    hearingDate: normalizeText(input.hearingDate),
    judgmentDate: normalizeText(input.judgmentDate),
    appealDeadline: normalizeText(input.appealDeadline),
    enforcementDeadline: normalizeText(input.enforcementDeadline),
    notes: normalizeText(input.notes),
    clientPartyName: normalizeText(input.clientPartyName),
    clientRole: normalizeText(input.clientRole),
    objective: normalizeText(input.objective),
    materials: Array.isArray(input.materials) ? input.materials : [],
    assetTraceWorkflow: input.assetTraceWorkflow && typeof input.assetTraceWorkflow === 'object'
      ? input.assetTraceWorkflow
      : undefined,
    createdBy: userId,
    updatedBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  store.cases.unshift(caseFile);
  writeStore(store);
  recordLegalCaseWrite(orgId, userId, caseFile.id, caseFile.materials.map(material => material.id));
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.create',
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber },
  });
  return caseFile;
}

export function updateCase(orgId: string, userId: string, caseId: string, patch: Partial<OrgLegalCaseFile>): OrgLegalCaseFile | null {
  const store = readStore();
  const idx = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (idx < 0) return null;
  const current = store.cases[idx];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const removedMaterialIds = [...new Set([...(current.removedMaterialIds || []), ...(Array.isArray(patch.removedMaterialIds) ? patch.removedMaterialIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200) : [])])];
  const removed = new Set(removedMaterialIds);
  const next: OrgLegalCaseFile = {
    ...current,
    ...patch,
    // Browser snapshots and case updates cannot manufacture verification receipts.
    workflowRuns: current.workflowRuns?.filter(run => !run.materialIds.some(id => removed.has(id))),
    id: current.id,
    orgId: current.orgId,
    materials: (patch.materials || current.materials || []).filter(material => !removed.has(material.id)),
    removedMaterialIds,
    updatedBy: userId,
    updatedAt: now(),
  };
  store.cases[idx] = next;
  writeStore(store);
  recordLegalCaseWrite(orgId, userId, caseId, next.materials.filter(material => !current.materials.some(prior => prior.id === material.id)).map(material => material.id));
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.update',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { fields: Object.keys(patch) },
  });
  return next;
}

export function recordWorkflowRun(orgId: string, userId: string, caseId: string,
  run: Omit<LegalWorkflowRun, 'basis' | 'checkedAt'>): void {
  if (!getCase(orgId, caseId, userId, 'write')) return;
  const store = readStore();
  const item = store.cases.find(value => value.orgId === orgId && value.id === caseId);
  if (!item || run.materialIds.some(id => item.removedMaterialIds?.includes(id))) return;
  item.workflowRuns = [{ ...run, checkedAt: now(), basis: legalCaseSourceFingerprint(item) }, ...(item.workflowRuns || []).map(previous => {
    if (previous.tool !== run.tool) return previous;
    const { displayText: _displayText, ...metadata } = previous; return metadata;
  })].slice(0, 100);
  item.updatedAt = now();
  item.updatedBy = userId;
  writeStore(store);
}

export function deleteCase(orgId: string, userId: string, caseId: string): OrgLegalCaseFile | null {
  const store = readStore();
  const index = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (index < 0) return null;
  const current = store.cases[index];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const [deleted] = store.cases.splice(index, 1);
  writeStore(store);
  removeOrganizationResourcePolicy({
    orgId,
    actorUserId: userId,
    resourceType: 'legal_case',
    resourceId: caseId,
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.delete',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: {
      title: deleted.title,
      caseNumber: deleted.caseNumber,
      materialCount: deleted.materials?.length || 0,
    },
  });
  return deleted;
}

export function addMaterial(
  orgId: string,
  userId: string,
  caseId: string,
  material: Omit<OrgLegalCaseMaterial, 'id' | 'createdBy' | 'createdAt'>,
): OrgLegalCaseMaterial | null {
  const current = getCase(orgId, caseId, userId, 'write');
  if (!current) return null;
  const nextMaterial: OrgLegalCaseMaterial = {
    id: randomUUID(),
    type: material.type,
    title: normalizeText(material.title) || CN_LEGAL_CASE_DEFAULTS.materialTitle,
    content: normalizeText(material.content),
    fileName: material.fileName,
    localPath: material.localPath,
    source: material.source,
    reasoningLinks: material.reasoningLinks,
    reasoningBasis: material.reasoningBasis,
    createdBy: userId,
    createdAt: now(),
  };
  const nextMaterials = [nextMaterial, ...(current.materials || [])];
  updateCase(orgId, userId, caseId, {
    materials: nextMaterials,
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.material.add',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: nextMaterial.title, source: nextMaterial.source, fileName: nextMaterial.fileName },
  });
  return nextMaterial;
}

export function createCaseFromRemoteMaterial(params: {
  orgId: string;
  userId: string;
  title: string;
  text: string;
  fileName?: string;
  localPath?: string;
  source?: OrgLegalCaseMaterial['source'];
}): OrgLegalCaseFile {
  const hints = extractLegalCaseHints(params.text);
  const caseFile = createCase(params.orgId, params.userId, {
    title: params.title || hints.caseNumber || params.fileName || '远程案件材料',
    caseNumber: hints.caseNumber || '',
    court: hints.court || '',
    cause: hints.cause || '',
    hearingDate: hints.hearingDate || '',
    notes: params.text.slice(0, 4000),
    stage: 'consultation',
  });
  addMaterial(params.orgId, params.userId, caseFile.id, {
    type: 'evidence',
    title: params.fileName || params.title || '远程案件材料',
    content: params.text,
    fileName: params.fileName,
    localPath: params.localPath,
    source: params.source || 'feishu',
  });
  return getCase(params.orgId, caseFile.id) || caseFile;
}
