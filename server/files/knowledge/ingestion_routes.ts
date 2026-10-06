import type { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { flushDBOrThrow } from "../../../db_layer";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { chunkText, ingestDocument, verifyIngestedDocument } from "../../agents/rag";
import type { KnowledgeIngestionManifest } from "../../knowledge/ingestion_manifest";
import { createRequestAbortController } from "../../http/request_abort";
import { hashKnowledgeContent } from "../../knowledge/ingestion_manifest";
import * as OrgKB from "../../org/kb";
import { requireAuth, getFileScope, findFileMeta, sendRouteError, assertKnowledgeWriteAccess, getUserId, readRequestArchive } from './ownership';
import { readCurrentIngestionManifest, applyIngestionManifest, hasCurrentVerifiedManifest, applyExtractionMeta, buildNonIndexedManifest } from './metadata';
import { extractKnowledgeFileContent } from './extraction';
import { repairFilename } from './formats';
import { findExistingFileMemories } from './memory_references';
import { ensureOrgArticleFromFile } from './file_ingestion';

export function registerKnowledgeIngestionRoutes(router: Router): void {


// ── Verifiable knowledge absorption: manifest + owner-supplied golden QA ──
router.get('/files/ingestion/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const db = readKnowledgeFileState();
    const meta = findFileMeta(db, safeName, scope);
    if (!meta) return res.status(404).json({ error: 'Knowledge file metadata not found' });
    const manifest = scope.domain === 'work' && scope.orgId && meta.orgArticleId
      ? OrgKB.getArticleIngestionManifest(scope.orgId, meta.orgArticleId)
      : readCurrentIngestionManifest(meta);
    if (!manifest) return res.status(404).json({ error: 'Knowledge ingestion manifest not found' });
    res.json({
      filename: safeName,
      domain: scope.domain,
      orgId: scope.orgId,
      agentIds: meta.agentIds || [],
      ingestionManifest: manifest,
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});


router.post('/files/ingestion/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope, scope.domain === 'work');
    const cases = req.body?.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'cases must contain at least one golden question with a reference answer and expected chunk indexes' });
    }
    const safeName = path.basename(req.params.id);
    const db = readKnowledgeFileState();
    const meta = findFileMeta(db, safeName, scope);
    if (!meta) return res.status(404).json({ error: 'Knowledge file metadata not found' });

    let verified: KnowledgeIngestionManifest;
    if (scope.domain === 'work') {
      if (!scope.orgId || !meta.orgArticleId) {
        return res.status(409).json({ error: 'The work knowledge file is not linked to an indexed organization article' });
      }
      verified = await OrgKB.verifyArticleKnowledge(scope.orgId, meta.orgArticleId, scope.userId, cases);
    } else {
      const manifest = readCurrentIngestionManifest(meta);
      if (!manifest) return res.status(409).json({ error: 'Index the knowledge file before golden verification' });
      const filePath = path.join(scope.dir, safeName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(409).json({ error: 'The source file is missing; the existing index cannot be verified' });
      }
      const extraction = await extractKnowledgeFileContent(filePath, scope.userId);
      if (!extraction.content?.trim() || hashKnowledgeContent(extraction.content) !== manifest.sourceRevision) {
        return res.status(409).json({ error: 'The source content changed after indexing; re-index it before golden verification' });
      }
      const agentIds = Array.isArray(meta.agentIds)
        ? meta.agentIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : [];
      const requestedAgentId = String(req.body?.agentId || '').trim();
      const agentId = requestedAgentId || (agentIds.includes('lumi') ? 'lumi' : agentIds[0]);
      if (!agentId || !agentIds.includes(agentId)) {
        return res.status(400).json({ error: 'agentId must identify an agent that indexed this exact file' });
      }
      verified = await verifyIngestedDocument(
        scope.userId,
        agentId,
        manifest,
        cases,
        { domain: 'personal', orgId: '' },
      );
    }

    const latestDb = readKnowledgeFileState();
    const latestMeta = findFileMeta(latestDb, safeName, scope);
    if (!latestMeta) return res.status(409).json({ error: 'Knowledge file metadata changed during verification' });
    applyIngestionManifest(latestMeta, verified);
    commitKnowledgeFileState(latestDb);
    res.json({
      success: true,
      ingestionStatus: verified.status,
      coverage: verified.coverage,
      retrieval: verified.retrieval,
      ingestionManifestId: verified.manifestId,
    });
  } catch (err: any) {
    sendRouteError(res, err, 400);
  }
});


// ── POST /files/ingest — chunk into agent memory (RAG) ──
router.post('/files/ingest', requireAuth, async (req: Request, res: Response) => {
  const request = createRequestAbortController(req, res);
  try {
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const { fileId, agentId } = req.body;
    if (!fileId || !agentId) return res.status(400).json({ error: 'fileId and agentId required' });

    const safeName = path.basename(fileId);
    const filePath = path.join(scope.dir, safeName);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const archived = (await readRequestArchive(req, scope, safeName))[0];
    request.signal.throwIfAborted();
    const extraction = await extractKnowledgeFileContent(filePath, userId, request.signal);
    const content = extraction.content;

    // Mark as indexing
    const db = readKnowledgeFileState();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];
    let meta = findFileMeta(db, safeName, scope, archived);
    if (!meta) {
      meta = {
        filename: safeName,
        displayName: repairFilename(safeName),
        userId: scope.userId,
        domain: scope.domain,
        orgId: scope.orgId || '',
        source: 'upload',
        agentIds: [],
        createdAt: new Date().toISOString(),
      };
      db.knowledgeFiles.push(meta);
    }
    if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
    const existingMemories = scope.domain === 'personal'
      ? findExistingFileMemories(db, safeName, scope, { userId, agentId })
      : [];
    const canReuseExisting = existingMemories.length > 0
      && !['partial', 'failed'].includes(String(meta.status || meta.extractionStatus || ''));
    const expectedChunks = content?.trim() ? chunkText(content).length : 0;
    const hasCompleteExisting = canReuseExisting
      && (expectedChunks === 0 || existingMemories.length >= expectedChunks)
      && Boolean(content?.trim())
      && hasCurrentVerifiedManifest(meta, content!, existingMemories.map((memory: any) => String(memory.id || '')));
    if (hasCompleteExisting) {
      const currentManifest = readCurrentIngestionManifest(meta);
      if (currentManifest) applyIngestionManifest(meta, currentManifest);
      if (!meta.agentIds.includes(agentId)) meta.agentIds.push(agentId);
      meta.status = 'indexed';
      if (content?.trim()) applyExtractionMeta(meta, extraction, content);
      delete meta.indexingAt;
      commitKnowledgeFileState(db);
      await flushDBOrThrow();
      request.signal.throwIfAborted();
      return res.json({
        success: true,
        reused: true,
        chunkCount: existingMemories.length,
        memoryIds: existingMemories.map((m: any) => m.id).filter(Boolean),
        extractionStatus: content?.trim() ? extraction.status : (meta.extractionStatus || 'indexed'),
        ingestionStatus: currentManifest?.status || 'indexed_unverified',
        ingestionManifestId: meta.ingestionManifestId,
      });
    }
    applyExtractionMeta(meta, extraction, content);
    if (!content || !content.trim()) {
      const manifest = buildNonIndexedManifest(filePath, extraction);
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      applyIngestionManifest(meta, manifest);
      commitKnowledgeFileState(db);
      return res.status(415).json({
        error: extraction.error || extraction.warning || 'This file type has no extractable text or visual content for Lumi to absorb',
        extractionStatus: extraction.status,
        extractionMethod: extraction.method,
        extractionFailureKind: extraction.failureKind,
        ingestionStatus: manifest.status,
        ingestionManifestId: manifest.manifestId,
        coverage: manifest.coverage,
      });
    }
    meta.indexingRevision = crypto.randomUUID();
    meta.indexingAt = new Date().toISOString();
    commitKnowledgeFileState(db);

    if (scope.domain === 'work') {
      const article = await ensureOrgArticleFromFile(scope, userId, safeName, content, meta?.orgArticleId, extraction.sourceMetadata, request.signal);
      if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
      meta.orgArticleId = article?.id;
      meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
      applyExtractionMeta(meta, extraction, content);
      const manifest = article?.id && scope.orgId
        ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
        : null;
      if (manifest) applyIngestionManifest(meta, manifest);
      delete meta.indexingAt;
      commitKnowledgeFileState(db);
      await flushDBOrThrow();
      request.signal.throwIfAborted();
      res.json({
        success: true,
        orgArticleId: article?.id,
        memoryIds: [],
        extractionStatus: extraction.status,
        ingestionStatus: manifest?.status || 'indexed_unverified',
        ingestionManifestId: manifest?.manifestId,
        ingestionCoverage: manifest?.coverage,
      });
      return;
    }

    const result = await ingestDocument(userId, agentId, safeName, content, {
      signal: request.signal,
      filePath,
      domain: scope.domain,
      orgId: scope.orgId || '',
      sourceMetadata: extraction.sourceMetadata,
      extraction,
    });

    // Mark as indexed
    // Replace only the old chunks captured by this request, after new indexing
    // succeeds. A failed embedding must leave the previous index available.
    const replacedMemoryIds = new Set(existingMemories.map((memory: any) => memory.id));
    if (replacedMemoryIds.size) db.memories = (db.memories || []).filter((memory: any) => !replacedMemoryIds.has(memory.id));
    if (!meta.agentIds.includes(agentId)) meta.agentIds.push(agentId);
    meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
    applyExtractionMeta(meta, extraction, content);
    applyIngestionManifest(meta, result.manifest);
    delete meta.indexingAt;
    commitKnowledgeFileState(db);
    await flushDBOrThrow();
    request.signal.throwIfAborted();

    res.json({
      success: true,
      chunkCount: result.chunkCount,
      memoryIds: result.memoryIds,
      extractionStatus: extraction.status,
      ingestionStatus: result.manifest.status,
      ingestionManifestId: result.manifest.manifestId,
      coverage: result.manifest.coverage,
    });
  } catch (err: any) {
    if (!request.signal.aborted) sendRouteError(res, err, 500);
  } finally {
    request.dispose();
  }
});
}
