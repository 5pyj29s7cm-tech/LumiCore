import type { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { flushDBOrThrow } from "../../../db_layer";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { readDocumentPreview } from "../document_preview";
import { mutateGeneratedArchiveFile } from "../generated_archive";
import { streamLocalFile } from "../stream_local_file";
import { requireAdmin as requireUnifiedAdmin, requireAuth as requireUnifiedAuth, requireLocalRequest as requireUnifiedLocalRequest } from "../../middleware/auth";
import * as OrgKB from "../../org/kb";
import { assertLocalHostRequest, sendRouteError, requireAuth, getAuthPayload, getFileScope, readRequestArchive, findFileMeta, assertKnowledgeWriteAccess, removeFileMeta } from './ownership';
import { resolveGeneratedDownloadPath, resolveKnowledgeFilePath, openPathWithDefaultApp } from './paths';
import { getDownloadMime, SAFE_INLINE_EXTENSIONS, repairFilename, sanitizeKnowledgeFilename, formatSize } from './formats';
import { removeFileMemoryReferences, renameFileMemoryReferences, getSourceBacklinks } from './memory_references';
import { readCurrentIngestionManifest } from './metadata';

export function registerKnowledgeAccessRoutes(router: Router): void {


// ── GET /files/generated?path=... — download a generated work artifact ──
router.get('/files/generated', requireUnifiedAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const filePath = resolveGeneratedDownloadPath(req.query.path, req);
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
    const filePath = id
      ? resolveKnowledgeFilePath(req, id)
      : resolveGeneratedDownloadPath(rawPath);
    await openPathWithDefaultApp(filePath);
    res.json({ success: true, path: filePath, fileName: repairFilename(path.basename(filePath)) });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


// ── GET /files/download/:id — download or preview a file ──
router.get('/files/download/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
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
