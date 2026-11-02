import type { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import { runSerializedMutation } from '../../persistence/durable_scope_mutation';
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { ingestDocument } from "../../agents/rag";
import { createRequestAbortController } from "../../http/request_abort";
import { registerGeneratedKnowledgeFile } from "../generated_archive";
import { requireAdmin as requireUnifiedAdmin, requireAuth as requireUnifiedAuth, requireLocalRequest as requireUnifiedLocalRequest } from "../../middleware/auth";
import * as OrgKB from "../../org/kb";
import { requireAuth, getUserId, getFileScope, assertKnowledgeWriteAccess, sendRouteError, assertLocalHostRequest, metaMatchesScope, archiveFileMeta, findFileMeta } from './ownership';
import { upload, MAX_UPLOAD_FILES, captureUploadAuthorization, uploadItemIdentities, saveUploadedKnowledgeFile, MAX_UPLOAD_BYTES, validateMediaSourceUpload } from './uploads';
import { repairFilename, getDownloadMime, sanitizeKnowledgeFilename } from './formats';
import { resolveLocalImportPath } from './paths';
import { captureKnowledgeSource, extractGeneratedTextKnowledge } from './extraction';
import { applyExtractionMeta, applyIngestionManifest, sameKnowledgeFileOwnership, buildEntry } from './metadata';
import { ensureOrgArticleFromFile } from './file_ingestion';
import { getInteriorProject, personalInteriorProjectScope } from '../../design/projects';
import { createInteriorProjectAsset, normalizeInteriorAssetCategory } from '../../design/project_assets';
import { logAudit } from '../../org/db';

export function registerKnowledgeImportRoutes(router: Router): void {


// ── POST /files/upload — upload files + auto-ingest into Lumi's memory ──
router.post('/files/upload', requireAuth, upload.array('files', MAX_UPLOAD_FILES), async (req: Request, res: Response) => {
  const request = createRequestAbortController(req, res);
  const uploadedFiles = (req.files || []) as Express.Multer.File[];
  try {
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const mediaSource = req.body?.purpose === 'media_source';
    const interiorProjectId = String(req.body?.interiorProjectId || '').trim();
    const interiorAssetCategory = interiorProjectId ? normalizeInteriorAssetCategory(req.body?.interiorAssetCategory) : undefined;
    const interiorProjectScopeId = scope.domain === 'work' ? String(scope.orgId || '') : personalInteriorProjectScope(userId);
    if (interiorProjectId && !getInteriorProject(interiorProjectScopeId, interiorProjectId)) {
      return res.status(404).json({ error: 'Interior project not found' });
    }
    if (mediaSource) {
      if (uploadedFiles.length !== 1) throw new Error('Choose one source image at a time.');
      await validateMediaSourceUpload(uploadedFiles[0], request.signal);
    }
    const db = readKnowledgeFileState();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];

    const saved: any[] = [];
    const failed: Array<{ index: number; itemId?: string; fileName: string; error: string }> = [];
    const authorization = captureUploadAuthorization(scope);
    const identities = uploadItemIdentities(req.body, uploadedFiles.length);
    for (const [index, file] of uploadedFiles.entries()) {
      request.signal.throwIfAborted();
      try {
        const entry = await saveUploadedKnowledgeFile({
          signal: request.signal,
          sourcePath: file.path,
          mediaSource,
          originalName: file.originalname,
          size: file.size,
          mimeType: file.mimetype || '',
          move: true,
        }, userId, scope, db, authorization, identities[index]);
        saved.push({ ...entry, uploadIndex: index, uploadItemId: identities[index]?.itemId });
      } catch (error: any) {
        request.signal.throwIfAborted();
        authorization.assertCurrent();
        failed.push({ index, itemId: identities[index]?.itemId, fileName: repairFilename(file.originalname), error: error?.message || 'Upload failed' });
      }
    }
    authorization.assertCurrent();
    commitKnowledgeFileState(db);
    await flushDBOrThrow();
    if (interiorProjectId && saved.length) {
      // Knowledge bytes have their own durable owner. Only project associations
      // share the project CRUD lock and rollback boundary.
      await runSerializedMutation(`interior-project:${interiorProjectScopeId}`, async () => {
        authorization.assertCurrent();
        request.signal.throwIfAborted();
        if (!getInteriorProject(interiorProjectScopeId, interiorProjectId)) {
          throw Object.assign(new Error('Interior project not found; uploaded knowledge files were retained.'), {status:404});
        }
        const writes: Array<{table:'interiorProjectAssets'|'auditLog'; before?:any; after:any}> = [];
        let persisted = false;
        const associations: any[] = [];
        try {
          for (const entry of saved) {
            const existing = readDatabaseTables(['interiorProjectAssets']).interiorProjectAssets.find((row:any) =>
              row.orgId === interiorProjectScopeId && row.projectId === interiorProjectId && row.fileId === entry.id && row.status === 'active');
            const before = existing ? structuredClone(existing) : undefined;
            const uploadedFile = uploadedFiles[entry.uploadIndex];
            const asset = createInteriorProjectAsset({
              orgId:interiorProjectScopeId, projectId:interiorProjectId, fileId:entry.id,
              displayName:entry.displayName || entry.name || entry.id, mimeType:uploadedFile?.mimetype || '', rawSize:entry.rawSize ?? uploadedFile?.size,
              category:interiorAssetCategory, uploadedBy:userId, extractionStatus:entry.extractionStatus, orgArticleId:entry.orgArticleId,
            });
            writes.push({table:'interiorProjectAssets',before,after:asset});
            associations.push(asset);
          }
          if (scope.domain === 'work' && scope.orgId) {
            const beforeIds = new Set(readDatabaseTables(['auditLog']).auditLog.map((row:any)=>row.id));
            logAudit({orgId:scope.orgId,userId,action:'interior_project.assets_uploaded',resourceType:'interior_project',resourceId:interiorProjectId,
              details:{category:interiorAssetCategory,fileCount:saved.length,fileIds:saved.map(file=>file.id)},ipAddress:req.ip,userAgent:req.get('user-agent')});
            for (const row of readDatabaseTables(['auditLog']).auditLog) {
              if (!beforeIds.has(row.id)) writes.push({table:'auditLog',after:structuredClone(row)});
            }
          }
          await flushDBOrThrow();
          persisted = true;
          authorization.assertCurrent();request.signal.throwIfAborted();
          saved.forEach((entry,index)=>{entry.interiorProjectAsset=associations[index];});
        } catch (error) {
          if (persisted || writes.length === 0) throw error;
          const state=readDatabaseTables(['interiorProjectAssets','auditLog']);
          for (const write of [...writes].reverse()) {
            const index=state[write.table].findIndex((row:any)=>row.id===write.after.id);
            if (index < 0 || JSON.stringify(state[write.table][index]) !== JSON.stringify(write.after)) continue;
            if (write.before) state[write.table][index]=write.before;
            else state[write.table].splice(index,1);
          }
          commitDatabaseTables(state);
          let rollbackPersisted=false;
          try { await flushDBOrThrow();rollbackPersisted=true; } catch { /* Disk outcome remains unknown; memory no longer retains the failed association. */ }
          authorization.assertCurrent();request.signal.throwIfAborted();
          throw Object.assign(new Error(rollbackPersisted
            ? 'Knowledge files were saved, but their project association could not be saved and was rolled back.'
            : 'Knowledge files were saved; the project association disk state is unknown. Reload project assets before retrying.'),
          {status:503,code:'PROJECT_ASSET_PERSISTENCE_UNAVAILABLE',knowledgeFilesRetained:true,
            associationState:rollbackPersisted ? 'rolled_back' : 'unknown',files:saved});
        }
      });
    }
    authorization.assertCurrent();
    request.signal.throwIfAborted();
    res.status(saved.length > 0 ? 200 : 400).json({
      success: failed.length === 0, partial: saved.length > 0 && failed.length > 0,
      files: saved, failed, ...(saved.length === 0 ? { error: failed[0]?.error || 'No files uploaded' } : {}),
    });
  } catch (err: any) {
    if (!request.signal.aborted) {
      if (err?.code === 'PROJECT_ASSET_PERSISTENCE_UNAVAILABLE') return res.status(503).json({
        error:err.message,code:err.code,knowledgeFilesRetained:true,associationState:err.associationState,files:err.files,
      });
      sendRouteError(res, err);
    }
  } finally {
    request.dispose();
    // Multer owns these temporary paths; a replay/failure must not leave its staged copy behind.
    for (const file of uploadedFiles) {
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
    }
  }
});


// ── POST /files/import-paths — import local files dropped into the desktop widget ──
router.post('/files/import-paths', requireUnifiedAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, async (req: Request, res: Response) => {
  const request = createRequestAbortController(req, res);
  try {
    assertLocalHostRequest(req);
    const requestedPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const uniquePaths: string[] = [...new Set<string>(
      requestedPaths.map((p: unknown) => String(p || '').trim()).filter(Boolean),
    )].slice(0, MAX_UPLOAD_FILES);
    if (uniquePaths.length === 0) {
      return res.status(400).json({ error: 'No file paths provided' });
    }

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readKnowledgeFileState();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];

    const saved: any[] = [];
    const skipped: Array<{ path: string; error: string }> = [];
    const failed: Array<{ index: number; itemId?: string; fileName: string; error: string }> = [];
    const authorization = captureUploadAuthorization(scope);
    const identities = uploadItemIdentities(req.body, uniquePaths.length);
    for (const [index, rawPath] of uniquePaths.entries()) {
      request.signal.throwIfAborted();
      try {
        const sourcePath = resolveLocalImportPath(rawPath);
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) throw new Error('Only files can be imported');
        if (stat.size > MAX_UPLOAD_BYTES) throw new Error('File is larger than 500 MB');
        const entry = await saveUploadedKnowledgeFile({
          signal: request.signal,
          sourcePath,
          originalName: path.basename(sourcePath),
          size: stat.size,
          mimeType: getDownloadMime(sourcePath) || '',
          move: false,
        }, userId, scope, db, authorization, identities[index]);
        saved.push({ ...entry, uploadIndex: index, uploadItemId: identities[index]?.itemId });
      } catch (err: any) {
        request.signal.throwIfAborted();
        authorization.assertCurrent();
        skipped.push({ path: rawPath, error: err?.message || String(err) });
        failed.push({ index, itemId: identities[index]?.itemId, fileName: path.basename(rawPath), error: err?.message || String(err) });
      }
    }

    authorization.assertCurrent();
    if (saved.length === 0) {
      return res.status(400).json({ error: skipped[0]?.error || 'No files imported', files: [], failed, skipped });
    }

    commitKnowledgeFileState(db);
    await flushDBOrThrow();
    authorization.assertCurrent();
    request.signal.throwIfAborted();
    res.json({ success: failed.length === 0, partial: failed.length > 0, files: saved, failed, skipped });
  } catch (err: any) {
    if (!request.signal.aborted) sendRouteError(res, err);
  } finally {
    request.dispose();
  }
});


// ── POST /files/save — save generated content as a file ──
router.post('/files/save', requireAuth, async (req: Request, res: Response) => {
  const request = createRequestAbortController(req, res);
  try {
    const { name, content } = req.body;
    if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const safeName = sanitizeKnowledgeFilename(name);
    const contentText = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const filePath = path.join(scope.dir, safeName);
    fs.writeFileSync(filePath, contentText, 'utf-8');
    const assertSourceCurrent = captureKnowledgeSource(filePath);
    const archived = await registerGeneratedKnowledgeFile(scope, safeName);
    assertSourceCurrent();
    const db = readKnowledgeFileState();
    db.knowledgeFiles ||= [];
    let meta = db.knowledgeFiles.find((item: any) => item.filename === safeName && metaMatchesScope(item, scope));
    if (!meta) { meta = { agentIds: [], status: 'ready' }; db.knowledgeFiles.push(meta); }
    Object.assign(meta, archiveFileMeta(archived), { updatedAt: new Date().toISOString() });
    meta.indexingRevision = crypto.randomUUID();
    commitKnowledgeFileState(db);
    const generatedExtraction = extractGeneratedTextKnowledge(safeName, contentText);
    const generatedKnowledgeContent = generatedExtraction.content || contentText;
    if (meta) applyExtractionMeta(meta, generatedExtraction, generatedKnowledgeContent);
    let orgArticleId: string | undefined;
    if (scope.domain === 'work') {
      const article = await ensureOrgArticleFromFile(scope, userId, safeName, generatedKnowledgeContent, meta?.orgArticleId, generatedExtraction.sourceMetadata, request.signal);
      orgArticleId = article?.id;
      if (meta) {
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        meta.orgArticleId = orgArticleId;
        meta.status = 'indexed';
        if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
        const manifest = article?.id && scope.orgId
          ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
          : null;
        if (manifest) applyIngestionManifest(meta, manifest);
      }
    } else if (meta) {
      try {
        const result = await ingestDocument(userId, 'lumi', safeName, generatedKnowledgeContent, {
          signal: request.signal,
          filePath,
          domain: scope.domain,
          orgId: scope.orgId || '',
          sourceMetadata: generatedExtraction.sourceMetadata,
          extraction: generatedExtraction,
        });
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
        meta.status = 'indexed';
        applyExtractionMeta(meta, generatedExtraction, generatedKnowledgeContent);
        applyIngestionManifest(meta, result.manifest);
        console.log(`[AutoIngest] "${safeName}" -> ${result.chunkCount} chunks`);
      } catch (ingestErr: any) {
        console.warn(`[AutoIngest] Failed for generated "${safeName}": ${ingestErr.message}`);
      }
    }
    request.signal.throwIfAborted();
    assertSourceCurrent();
    if (!sameKnowledgeFileOwnership(findFileMeta(readKnowledgeFileState(), safeName, scope), meta)) throw Object.assign(new Error('Knowledge file metadata changed during indexing.'), { status: 409 });
    commitKnowledgeFileState(db);
    await flushDBOrThrow();
    request.signal.throwIfAborted();
    assertSourceCurrent();
    res.json({ success: true, filename: safeName, orgArticleId, entry: buildEntry(safeName, 'generated', meta?.agentIds || [], scope, meta?.status, meta) });
  } catch (err: any) {
    if (!request.signal.aborted) sendRouteError(res, err);
  } finally {
    request.dispose();
  }
});
}
