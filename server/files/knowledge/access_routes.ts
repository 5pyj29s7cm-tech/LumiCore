import crypto from 'crypto';
import type { FileScope } from './contracts';
import { assertOrganizationResourceAccess } from '../../org/resource_acl';
import { parseDocument } from '../../legal/parser';
import { PdfPasswordError } from '../../utils/pdf_text';
import { createRequestAbortController } from '../../http/request_abort';
import { captureKnowledgeSource } from './extraction';
import type { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { flushDBOrThrow } from "../../../db_layer";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { readDocumentPreview } from "../document_preview";
import { mutateGeneratedArchiveFile, assertGeneratedArchiveFilePublic, assertGeneratedSourceFilePublic } from "../generated_archive";
import { streamLocalFile } from "../stream_local_file";
import { requireAdmin as requireUnifiedAdmin, requireAuth as requireUnifiedAuth, requireLocalRequest as requireUnifiedLocalRequest } from "../../middleware/auth";
import * as OrgKB from "../../org/kb";
import { assertLocalHostRequest, sendRouteError, requireAuth, getAuthPayload, getFileScope, readRequestArchive, findFileMeta, assertKnowledgeWriteAccess, removeFileMeta } from './ownership';
import { resolveGeneratedDownloadPath, resolveKnowledgeFilePath, openPathWithDefaultApp } from './paths';
import { getDownloadMime, SAFE_INLINE_EXTENSIONS, repairFilename, sanitizeKnowledgeFilename, formatSize } from './formats';
import { removeFileMemoryReferences, renameFileMemoryReferences, getSourceBacklinks } from './memory_references';
import { readCurrentIngestionManifest } from './metadata';

export async function readKnowledgeSourceText(fileId: string, getScope: () => FileScope, options: { password?: string; signal?: AbortSignal; permission?: 'read' | 'share' } = {}) {
  if (!fileId || path.basename(fileId) !== fileId || /[\\/]/.test(fileId)) throw Object.assign(new Error('An exact knowledge fileId is required.'), { status: 400 });
  const resolve = () => {
    const scope = getScope();
    const meta = findFileMeta(readKnowledgeFileState(), fileId, scope);
    if (!meta) throw Object.assign(new Error('Knowledge file is unavailable in this scope.'), { status: 403 });
    if (scope.domain === 'work') assertOrganizationResourceAccess({ orgId: scope.orgId!, actorUserId: scope.userId, resourceType: meta.orgArticleId ? 'knowledge_article' : 'knowledge_file', resourceId: meta.orgArticleId || fileId, ownerUserId: meta.userId, permission: options.permission || 'read' });
    return { filePath: resolveKnowledgeFilePath(scope, fileId), meta };
  };
  const { filePath, meta } = resolve();
  await assertGeneratedArchiveFilePublic(getScope(), fileId);
  const assertSourceCurrent = captureKnowledgeSource(filePath);
  if (!/\.(pdf|docx|txt|md|rtf|csv|xlsx|xls|pptx)$/i.test(filePath)) throw Object.assign(new Error('This format requires a separate extraction/OCR step.'), { status: 422, code: 'DOCUMENT_TEXT_UNAVAILABLE' });
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const document = await parseDocument(filePath, { password: options.password });
  const assertCurrent = () => { options.signal?.throwIfAborted(); if (resolve().filePath !== filePath) throw new Error('File changed during extraction'); assertSourceCurrent(); };
  assertCurrent();
  if (!document || !(document.format === 'pdf' ? document.text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').replace(/[\f\u0000]/g, '') : document.text).trim()) throw Object.assign(new Error('No readable text extracted; OCR or document repair is required.'), { status: 422, code: 'DOCUMENT_TEXT_UNAVAILABLE' });
  return { assertCurrent, fileId, name: meta.displayName || fileId, text: document.text, characters: document.text.length, truncated: false, format: document.format, sourceRevision: sourceHash, sourceHash, textHash: crypto.createHash('sha256').update(document.text).digest('hex') };
}

export function registerKnowledgeAccessRoutes(router: Router): void {
// Full source extraction for review; never use a chat preview as the document.
router.post('/files/text/:id', requireAuth, async (req: Request, res: Response) => {
  const request = createRequestAbortController(req, res);
  try {
    const document = await readKnowledgeSourceText(req.params.id, () => getFileScope(req), { password: typeof req.body?.password === 'string' ? req.body.password : undefined, signal: request.signal });
    res.setHeader('Cache-Control', 'no-store');
    res.json(document);
  } catch (error) {
    if (request.signal.aborted) return;
    if (error instanceof PdfPasswordError) return res.status(422).json({ code: error.code, error: error.code });
    if ((error as any)?.code === 'DOCUMENT_TEXT_UNAVAILABLE') return res.status(422).json({ code: (error as any).code, error: (error as Error).message });
    sendRouteError(res, error);
  } finally { request.dispose(); }
});




// ── GET /files/generated?path=... — download a generated work artifact ──
router.get('/files/generated', requireUnifiedAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const filePath = resolveGeneratedDownloadPath(req.query.path, req);
    await assertGeneratedSourceFilePublic(getFileScope(req), filePath);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
    if (req.query.preview === '1') return res.json(await readDocumentPreview(filePath));
    const fileName = path.basename(filePath);
    const mime = getDownloadMime(filePath);
    if (mime) res.setHeader('Content-Type', mime);
    const inline = req.query.inline === '1' && SAFE_INLINE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    const disposition = inline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    streamLocalFile(req, res, filePath, mime);
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// Open a knowledge/generated file with the OS default application.
router.post('/files/open', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const id = req.body?.id || req.query.id;
    const rawPath = req.body?.path || req.query.path;
    if (!id && getAuthPayload(req)?.role !== 'admin') {
      return res.status(403).json({ error: 'Generated artifacts may be opened only by the local Lumi administrator.' });
    }
    if (id) await assertGeneratedArchiveFilePublic(getFileScope(req), path.basename(String(id)));
    const filePath = id
      ? resolveKnowledgeFilePath(req, id)
      : resolveGeneratedDownloadPath(rawPath, req);
    if (!id) await assertGeneratedSourceFilePublic(getFileScope(req), filePath);
    const target = req.body?.reveal === true ? path.dirname(filePath) : filePath;
    await openPathWithDefaultApp(target);
    res.json({ success: true, path: target, fileName: repairFilename(path.basename(filePath)) });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── GET /files/download/:id — download or preview a file ──
router.get('/files/download/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    await assertGeneratedArchiveFilePublic(scope, safeName);
    const filePath = resolveKnowledgeFilePath(req, req.params.id);
    if (!safeName || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Cache-Control', 'no-store');
    if (req.query.preview === '1') return res.json(await readDocumentPreview(filePath));
    const ext = path.extname(safeName).toLowerCase();
    const mime = getDownloadMime(ext);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Applies even to downloaded active documents if a browser renders them.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");

    const inline = req.query.inline === '1' && SAFE_INLINE_EXTENSIONS.has(ext);
    if (inline) {
      res.setHeader('Content-Disposition', 'inline');
    } else {
      const archived = (await readRequestArchive(req, scope, safeName))[0];
      const meta = findFileMeta(readKnowledgeFileState(), safeName, scope, archived);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(repairFilename(meta?.displayName || safeName))}`);
    }
    streamLocalFile(req, res, filePath, mime);
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── GET /files/open-folder/:id — open the file's containing folder in the OS ──
router.get('/files/open-folder', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const scope = getFileScope(req);
    const folder = path.resolve(scope.dir);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    await openPathWithDefaultApp(folder);
    res.json({ success: true, path: folder });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


router.get('/files/open-folder/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

    const folder = path.resolve(path.dirname(filePath));
    await openPathWithDefaultApp(folder);
    res.json({ success: true, path: folder });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── DELETE /files/delete/:id ──
router.delete('/files/delete/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope, scope.domain === 'work');
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const db = readKnowledgeFileState();
    const meta = findFileMeta(db, safeName, scope);
    const removedMemoryCount = removeFileMemoryReferences(db, safeName, scope);
    await mutateGeneratedArchiveFile(scope, safeName);
    if (db.knowledgeFiles) {
      removeFileMeta(db, safeName, scope);
    }
    commitKnowledgeFileState(db);
    const removedOrgArticle = scope.domain === 'work' && scope.orgId && meta?.orgArticleId
      ? OrgKB.deleteArticle(scope.orgId, scope.userId, meta.orgArticleId)
      : false;
    await flushDBOrThrow();
    res.json({ success: true, removedMemoryCount, removedOrgArticle });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── POST /files/rename ──
router.post('/files/rename', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, newName } = req.body;
    if (!id || !newName) return res.status(400).json({ error: 'id and newName required' });

    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const oldPath = path.join(scope.dir, path.basename(id));
    const safeNewName = sanitizeKnowledgeFilename(newName);
    const newPath = path.join(scope.dir, safeNewName);

    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
    if (fs.existsSync(newPath)) return res.status(409).json({ error: 'Name already taken' });

    await mutateGeneratedArchiveFile(scope, path.basename(id), safeNewName);

    const db = readKnowledgeFileState();
    const oldName = path.basename(id);
    const renamedMemoryCount = renameFileMemoryReferences(db, oldName, safeNewName, newPath, scope);
    let orgArticleId = '';
    if (db.knowledgeFiles) {
      const meta = findFileMeta(db, oldName, scope);
      if (meta) {
        meta.filename = safeNewName;
        meta.displayName = repairFilename(safeNewName);
        meta.updatedAt = new Date().toISOString();
        orgArticleId = String(meta.orgArticleId || '');
      }
    }
    commitKnowledgeFileState(db);
    if (scope.domain === 'work' && scope.orgId && orgArticleId) {
      OrgKB.updateArticle(scope.orgId, scope.userId, orgArticleId, { title: repairFilename(safeNewName) });
    }
    await flushDBOrThrow();
    res.json({
      success: true,
      id: safeNewName,
      name: repairFilename(safeNewName),
      displayName: repairFilename(safeNewName),
      renamedMemoryCount,
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── GET /files/info/:id ──
router.get('/files/info/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    await assertGeneratedArchiveFilePublic(scope, safeName);
    const archived = (await readRequestArchive(req, scope, safeName))[0];
    const st = fs.statSync(filePath);
    const db = readKnowledgeFileState();
    const meta = findFileMeta(db, safeName, scope, archived);
    const currentManifest = readCurrentIngestionManifest(meta);
    res.json({
      id: safeName,
      name: repairFilename(safeName),
      displayName: repairFilename(safeName),
      domain: scope.domain,
      orgId: scope.orgId,
      size: st.size,
      formattedSize: formatSize(st.size),
      type: 'file',
      source: meta?.source || 'upload',
      agentIds: meta?.agentIds || [],
      status: meta?.status || ((meta?.agentIds || []).length > 0 ? 'indexed' : 'ready'),
      extractionStatus: meta?.extractionStatus,
      extractionMethod: meta?.extractionMethod,
      extractionWarning: meta?.extractionWarning || undefined,
      extractionError: meta?.extractionError || undefined,
      extractionFailureKind: meta?.extractionFailureKind || undefined,
      extractionProvider: meta?.extractionProvider || undefined,
      extractionModel: meta?.extractionModel || undefined,
      contentChars: meta?.contentChars || undefined,
      ingestionStatus: currentManifest?.status || meta?.ingestionStatus || (meta?.status === 'indexed' ? 'indexed_unverified' : undefined),
      ingestionManifestId: meta?.ingestionManifestId || undefined,
      ingestionCoverage: currentManifest?.coverage || meta?.ingestionCoverage || undefined,
      sourceTitle: meta?.sourceTitle || undefined,
      sourceAliases: Array.isArray(meta?.sourceAliases) ? meta.sourceAliases : undefined,
      sourceTags: Array.isArray(meta?.sourceTags) ? meta.sourceTags : undefined,
      sourceLinks: Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : undefined,
      sourceBacklinks: getSourceBacklinks(db, scope, safeName),
      sourceProperties: meta?.sourceProperties || undefined,
      obsidianVaultId: meta?.obsidianVaultId || undefined,
      obsidianVaultName: meta?.obsidianVaultName || undefined,
      obsidianVaultPath: meta?.obsidianVaultPath || undefined,
      obsidianRelativePath: meta?.obsidianRelativePath || undefined,
      obsidianSourcePath: meta?.obsidianSourcePath || undefined,
      updatedAt: st.mtime.toISOString(),
      createdAt: meta?.createdAt || st.birthtime.toISOString(),
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});
}
