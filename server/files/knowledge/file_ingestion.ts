import { CN_KNOWLEDGE_UPLOAD_MESSAGE } from '../../regions/messages/knowledge_result_messages';
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { ingestDocument } from "../../agents/rag";
import * as OrgKB from "../../org/kb";
import type { MarkdownKnowledgeMetadata } from "../../knowledge/markdown";
import type { FileScope, KnowledgeFileInput, KnowledgeExtractionResult } from './contracts';
import { findFileMeta } from './ownership';
import { sameKnowledgeFileOwnership, buildOrgArticleTags, applyExtractionMeta, applyIngestionManifest, buildNonIndexedManifest } from './metadata';
import { repairFilename, sanitizeKnowledgeFilename, getDownloadMime, IMAGE_KNOWLEDGE_EXTS, AUDIO_KNOWLEDGE_EXTS, formatSize, TEXT_KNOWLEDGE_EXTS, RTF_KNOWLEDGE_EXTS, EXTRACTABLE_KNOWLEDGE_EXTS } from './formats';
import { captureKnowledgeSource, extractAudioKnowledge, extractKnowledgeFileContent } from './extraction';

export async function ensureOrgArticleFromFile(
  scope: FileScope,
  userId: string,
  filename: string,
  content: string | null,
  articleId?: string,
  metadata?: MarkdownKnowledgeMetadata,
  signal?: AbortSignal,
): Promise<any | null> {
  signal?.throwIfAborted();
  if (scope.domain !== 'work' || !scope.orgId) return null;
  const sourcePath = path.join(scope.dir, filename);
  const sourceStat = fs.statSync(sourcePath);
  const fileState = readKnowledgeFileState();
  const fileMeta = findFileMeta(fileState, filename, scope);
  if (!fileMeta) throw Object.assign(new Error('Knowledge file metadata is unavailable.'), { status: 409 });
  const indexCurrentArticle = async (article: any) => {
    // Bind before the first await so deletion owns the newly created article.
    fileMeta.orgArticleId = article.id;
    commitKnowledgeFileState(fileState);
    await OrgKB.indexArticle(scope.orgId!, article.id, userId, { signal });
    signal?.throwIfAborted();
    const currentMeta = findFileMeta(readKnowledgeFileState(), filename, scope);
    const currentArticle = OrgKB.getArticle(scope.orgId!, article.id);
    let currentStat: fs.Stats | undefined;
    try { currentStat = fs.statSync(sourcePath); } catch {}
    if (!currentStat || !sameKnowledgeFileOwnership(currentMeta, fileMeta) || currentMeta.orgArticleId !== article.id || !currentArticle
      || currentStat.dev !== sourceStat.dev || currentStat.ino !== sourceStat.ino
      || currentStat.size !== sourceStat.size || currentStat.mtimeMs !== sourceStat.mtimeMs
      || currentStat.ctimeMs !== sourceStat.ctimeMs) {
      throw Object.assign(new Error('Knowledge source changed during indexing. Retry with the current file.'), { status: 409 });
    }
    return currentArticle;
  };
  const articleContent = (content && content.trim())
    ? content
    : CN_KNOWLEDGE_UPLOAD_MESSAGE(repairFilename(filename));
  const articleTags = buildOrgArticleTags(filename, metadata);
  if (articleId && OrgKB.getArticle(scope.orgId, articleId)) {
    const article = OrgKB.updateArticle(scope.orgId, userId, articleId, {
      title: repairFilename(filename),
      content: articleContent,
      category: 'files',
      tags: articleTags,
      status: 'published',
    }, { index: false });
    if (!article) return null;
    return indexCurrentArticle(article);
  }
  const article = OrgKB.createArticle(scope.orgId, userId, {
    title: repairFilename(filename),
    content: articleContent,
    category: 'files',
    tags: articleTags,
    status: 'published',
  }, { index: false });
  return indexCurrentArticle(article);
}

export function uniqueKnowledgeDestination(scope: FileScope, originalName: string): string {
  const uploadName = sanitizeKnowledgeFilename(originalName, 'upload');
  let dest = path.join(scope.dir, uploadName);
  let counter = 1;
  const ext = path.extname(uploadName);
  const base = path.basename(uploadName, ext);
  while (fs.existsSync(dest)) {
    dest = path.join(scope.dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return dest;
}

export function copyOrMoveKnowledgeSource(input: KnowledgeFileInput, dest: string): void {
  if (!input.move) {
    fs.copyFileSync(input.sourcePath, dest);
    return;
  }

  try {
    fs.renameSync(input.sourcePath, dest);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(input.sourcePath, dest);
    fs.unlinkSync(input.sourcePath);
  }
}

export async function saveKnowledgeFile(
  input: KnowledgeFileInput,
  userId: string,
  scope: FileScope,
  db: any,
): Promise<any> {
  input.signal?.throwIfAborted();
  input.assertAuthorized?.();
  const dest = uniqueKnowledgeDestination(scope, input.originalName || path.basename(input.sourcePath));
  copyOrMoveKnowledgeSource(input, dest);
  const finalName = path.basename(dest);
  const assertSourceCurrent = captureKnowledgeSource(dest);
  const ext = path.extname(finalName);
  const stats = fs.statSync(dest);
  const mimeType = input.mimeType || getDownloadMime(dest) || '';

  const existing = findFileMeta(db, finalName, scope);
  if (existing) {
    existing.source = 'upload';
    existing.domain = scope.domain;
    existing.orgId = scope.orgId || '';
    existing.userId = scope.domain === 'personal' ? scope.userId : existing.userId;
    existing.updatedAt = new Date().toISOString();
  } else {
    db.knowledgeFiles.push({
      filename: finalName,
      displayName: repairFilename(finalName),
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId || '',
      source: 'upload',
      agentIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  findFileMeta(db, finalName, scope).indexingRevision = crypto.randomUUID();
  commitKnowledgeFileState(db);

  const isImageUpload = IMAGE_KNOWLEDGE_EXTS.test(ext) || mimeType.startsWith('image/');
  const isAudioUpload = AUDIO_KNOWLEDGE_EXTS.test(ext) || mimeType.startsWith('audio/');
  const entry: any = {
    id: finalName,
    name: repairFilename(finalName),
    displayName: repairFilename(finalName),
    type: 'file',
    kind: isImageUpload ? 'image' : isAudioUpload ? 'audio' : 'file',
    mimeType,
    size: formatSize(input.size || stats.size),
    rawSize: input.size || stats.size,
    path: dest,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  let extraction: KnowledgeExtractionResult = {
    content: null,
    method: 'unsupported',
    status: 'unsupported',
    warning: 'This file type has no supported text or visual extraction path yet.',
    failureKind: 'unsupported_format',
  };
  let extractedContent: string | null = null;

  // Extract supported document/media content so Lumi can retrieve it later.
  if (TEXT_KNOWLEDGE_EXTS.test(ext) || RTF_KNOWLEDGE_EXTS.test(ext) || EXTRACTABLE_KNOWLEDGE_EXTS.test(ext) || IMAGE_KNOWLEDGE_EXTS.test(ext) || AUDIO_KNOWLEDGE_EXTS.test(ext) || isAudioUpload) {
    extraction = isAudioUpload && !AUDIO_KNOWLEDGE_EXTS.test(ext)
      ? await extractAudioKnowledge(dest, input.signal)
      : await extractKnowledgeFileContent(dest, userId, input.signal);
    input.signal?.throwIfAborted();
    input.assertAuthorized?.();
    extractedContent = extraction.content;
    if (extractedContent) {
      entry.content = extractedContent.slice(0, 50000); // cap at 50KB for chat context
      entry.preview = extractedContent.slice(0, 1000);
      entry.extracted = true;
    }
  }
  entry.extractionStatus = extraction.status;
  entry.extractionMethod = extraction.method;
  entry.extractionWarning = extraction.warning;
  entry.extractionError = extraction.error;
  entry.extractionFailureKind = extraction.failureKind;
  entry.extractionProvider = extraction.provider;
  entry.extractionModel = extraction.model;

  // Personal files are ingested into personal memory; work files become org KB articles.
  if (scope.domain === 'work') {
    try {
      const meta = findFileMeta(db, finalName, scope);
      if (meta) applyExtractionMeta(meta, extraction, extractedContent);
      if (extractedContent?.trim()) {
        const article = await ensureOrgArticleFromFile(scope, userId, finalName, extractedContent, meta?.orgArticleId, extraction.sourceMetadata, input.signal);
        input.assertAuthorized?.();
        const manifest = article?.id && scope.orgId
          ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
          : null;
        if (meta) {
          if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
          meta.orgArticleId = article?.id;
          meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
          if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
          if (manifest) applyIngestionManifest(meta, manifest);
        }
        entry.orgArticleId = article?.id;
        entry.ingested = true;
        entry.partial = extraction.status === 'partial';
        if (manifest) {
          entry.ingestionStatus = manifest.status;
          entry.ingestionManifestId = manifest.manifestId;
          entry.ingestionCoverage = manifest.coverage;
        }
      } else if (meta) {
        const manifest = buildNonIndexedManifest(dest, extraction);
        meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
        applyIngestionManifest(meta, manifest);
        entry.ingestionStatus = manifest.status;
        entry.ingestionManifestId = manifest.manifestId;
        entry.ingestionCoverage = manifest.coverage;
        entry.syncError = extraction.error || extraction.warning || 'No extractable content found';
      }
    } catch (orgErr: any) {
      input.signal?.throwIfAborted();
      console.warn(`[OrgKB] Failed to sync "${finalName}": ${orgErr.message}`);
      entry.syncError = orgErr.message;
    }
  } else if (extractedContent?.trim()) {
    try {
      const result = await ingestDocument(userId, 'lumi', finalName, extractedContent, {
        signal: input.signal,
        filePath: dest,
        domain: scope.domain,
        orgId: scope.orgId || '',
        sourceMetadata: extraction.sourceMetadata,
        extraction,
      });
      input.assertAuthorized?.();
      const meta = findFileMeta(db, finalName, scope);
      if (meta) {
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
        meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
        applyExtractionMeta(meta, extraction, extractedContent);
        applyIngestionManifest(meta, result.manifest);
      }
      entry.ingested = true;
      entry.partial = extraction.status === 'partial';
      console.log(`[AutoIngest] "${finalName}" -> ${result.chunkCount} chunks`);
    } catch (ingestErr: any) {
      input.signal?.throwIfAborted();
      console.warn(`[AutoIngest] Failed for "${finalName}": ${ingestErr.message}`);
      const meta = findFileMeta(db, finalName, scope);
      if (meta) {
        meta.status = 'failed';
        meta.extractionError = ingestErr.message;
      }
      entry.syncError = ingestErr.message;
    }
  } else {
    const meta = findFileMeta(db, finalName, scope);
    if (meta) {
      applyExtractionMeta(meta, extraction, extractedContent);
      const manifest = buildNonIndexedManifest(dest, extraction);
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      applyIngestionManifest(meta, manifest);
      entry.ingestionStatus = manifest.status;
      entry.ingestionManifestId = manifest.manifestId;
      entry.ingestionCoverage = manifest.coverage;
      entry.syncError = extraction.error || extraction.warning || 'No extractable content found';
    }
  }

  input.signal?.throwIfAborted();
  input.assertAuthorized?.();
  assertSourceCurrent();
  if (!findFileMeta(readKnowledgeFileState(), finalName, scope)) throw Object.assign(new Error('Knowledge file was removed during indexing.'), { status: 409 });
  return entry;
}
