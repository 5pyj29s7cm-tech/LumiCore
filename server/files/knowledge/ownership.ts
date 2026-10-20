import type { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { getDataPath } from "../../config/data_path";
import { getPersonalKnowledgeDirectory } from "../knowledge_directory";
import { type GeneratedArchiveEntry, listGeneratedArchiveProjection } from "../generated_archive";
import { requireAuth as requireUnifiedAuth } from "../../middleware/auth";
import { getMember } from "../../org/db";
import type { FileScope } from './contracts';

export const requireAuth = requireUnifiedAuth;

export function getUserId(req: Request): string {
  return req.user?.uid || 'anonymous';
}

export function getAuthPayload(req: Request): any | null {
  return req.user || null;
}

export function normalizeFileDomain(value: unknown): 'personal' | 'work' {
  return String(value || '').toLowerCase() === 'work' ? 'work' : 'personal';
}

export function getRequestedDomain(req: Request): 'personal' | 'work' | null {
  const value = req.query.domain ?? req.body?.domain;
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return normalizeFileDomain(value);
}

export function assertLocalHostRequest(req: Request): void {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  const loopback = address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
  if (loopback) return;
  const err: any = new Error('This operation is available only from the local Lumi desktop client.');
  err.status = 403;
  throw err;
}

export function assertKnowledgeWriteAccess(scope: FileScope, adminOnly = false): void {
  if (scope.domain === 'personal') return;
  const membership = scope.orgId ? getMember(scope.orgId, scope.userId) : null;
  const allowedRoles = adminOnly ? ['owner', 'admin'] : ['owner', 'admin', 'member'];
  if (!membership || !allowedRoles.includes(membership.role)) {
    const err: any = new Error(adminOnly
      ? 'Organization owner or administrator access required.'
      : 'This organization role has read-only knowledge access.');
    err.status = 403;
    throw err;
  }
}

export function getFileScope(req: Request): FileScope {
  const payload = getAuthPayload(req);
  if (!payload?.uid) {
    const err: any = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  const requestedDomain = getRequestedDomain(req);
  const authenticatedDomain = payload.orgId ? 'work' : 'personal';
  if (requestedDomain && requestedDomain !== authenticatedDomain) {
    const err: any = new Error(authenticatedDomain === 'work'
      ? 'Personal knowledge is unavailable in organization context. Switch to personal Lumi first.'
      : 'Organization knowledge requires an active organization context.');
    err.status = 403;
    throw err;
  }

  if (authenticatedDomain === 'personal') {
    assertLocalHostRequest(req);
    const personal = getPersonalKnowledgeDirectory(payload.uid);
    return {
      domain: 'personal',
      userId: payload.uid,
      dir: personal.dir,
      legacyPersonalOwner: personal.legacyPersonalOwner,
    };
  }

  const requestedOrgId = String(req.query.orgId || req.body?.orgId || '').trim();
  const orgId = requestedOrgId || String(payload.orgId || '').trim();
  if (!orgId || !payload.orgId) {
    const err: any = new Error('Organization context required');
    err.status = 403;
    throw err;
  }
  if (orgId !== payload.orgId) {
    const err: any = new Error('Organization context does not match the requested organization');
    err.status = 403;
    throw err;
  }
  const membership = getMember(orgId, payload.uid);
  if (!membership || membership.status !== 'active') {
    const err: any = new Error('Active organization membership required');
    err.status = 403;
    throw err;
  }

  const dir = getDataPath(path.join('org', orgId, 'knowledge'));
  fs.mkdirSync(dir, { recursive: true });
  return { domain: 'work', userId: payload.uid, orgId, dir };
}

export function metaMatchesScope(meta: any, scope: FileScope): boolean {
  const metaDomain = normalizeFileDomain(meta?.domain || (meta?.orgId ? 'work' : 'personal'));
  if (metaDomain !== scope.domain) return false;
  if (scope.domain === 'work') return String(meta?.orgId || '') === scope.orgId;
  if (meta?.orgId) return false;
  if (meta?.userId) return String(meta.userId) === scope.userId;
  return scope.legacyPersonalOwner === true;
}

export function findFileMeta(db: any, filename: string, scope: FileScope, archived?: GeneratedArchiveEntry): any | undefined {
  const existing = (db.knowledgeFiles || []).find((m: any) => m.filename === filename && metaMatchesScope(m, scope));
  if (!archived) return existing;
  const meta = existing || { filename, agentIds: [], status: 'ready' };
  Object.assign(meta, archiveFileMeta(archived));
  if (!existing) { db.knowledgeFiles ||= []; db.knowledgeFiles.push(meta); }
  return meta;
}

export async function readRequestArchiveProjection(req: Request, scope: FileScope, filename?: string) {
  const member = scope.domain === 'work' ? getMember(scope.orgId!, scope.userId) : null;
  const identity = member && [member.id, member.role];
  const projection = await listGeneratedArchiveProjection(scope, filename);
  getFileScope(req);
  const current = identity && getMember(scope.orgId!, scope.userId);
  if (identity && (!current || current.id !== identity[0] || current.role !== identity[1])) {
    throw Object.assign(new Error('Organization access changed while reading files.'), { status: 403 });
  }
  return projection;
}

export function archiveFileMeta(entry: GeneratedArchiveEntry) {
  return { filename: entry.filename, displayName: entry.displayName, userId: entry.userId, domain: entry.domain,
    orgId: entry.orgId, source: 'generated', archiveId: entry.id, archiveKind: entry.kind,
    sourceConversationId: entry.sourceConversationId, createdAt: entry.createdAt };
}

export function removeFileMeta(db: any, filename: string, scope: FileScope): void {
  db.knowledgeFiles = (db.knowledgeFiles || []).filter((m: any) => !(m.filename === filename && metaMatchesScope(m, scope)));
}

export function sendRouteError(res: Response, err: any, fallbackStatus = 400): void {
  res.status(err?.status || fallbackStatus).json({ error: err?.message || 'Request failed' });
}

export async function readRequestArchive(req: Request, scope: FileScope, filename?: string) {
  return (await readRequestArchiveProjection(req, scope, filename)).entries;
}
