import path from "path";
import fs from "fs";
import crypto from "crypto";
import { readKnowledgeFileState, commitKnowledgeFileState } from "../knowledge_state";
import { ingestDocument } from "../../agents/rag";
import type { KnowledgeIngestionManifest } from "../../knowledge/ingestion_manifest";
import { evaluateKnowledgeManifest } from "../../knowledge/ingestion_manifest";
import { getDataPath } from "../../config/data_path";
import { PERSONAL_KNOWLEDGE_DIR } from './paths';
import { normalizeFileDomain } from './ownership';
import { applyIngestionManifest, applyExtractionMeta, buildNonIndexedManifest } from './metadata';
import type { KnowledgeExtractionResult } from './contracts';
import { extractKnowledgeFileContent } from './extraction';
import { findExistingFileMemories } from './memory_references';

export let legacyRevalidationTimer: ReturnType<typeof setTimeout> | null = null;

export let legacyRevalidationRunning = false;

export function personalKnowledgeDirectoryForMeta(meta: any, db: any): string {
  const userId = String(meta?.userId || '');
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  if (primaryAdmin?.uid && primaryAdmin.uid === userId) return PERSONAL_KNOWLEDGE_DIR;
  const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return getDataPath(path.join('knowledge', '_users', directoryId));
}

export async function revalidateOneLegacyKnowledgeFile(): Promise<'verified' | 'unverified' | 'failed' | 'idle'> {
  if (legacyRevalidationRunning) return 'idle';
  legacyRevalidationRunning = true;
  let activeIdentity: { userId: string; filename: string } | null = null;
  try {
    const db = readKnowledgeFileState();
    const now = Date.now();
    const meta = (db.knowledgeFiles || []).find((item: any) => {
      const domain = normalizeFileDomain(item?.domain || (item?.orgId ? 'work' : 'personal'));
      if (domain !== 'personal') return false;
      const storedManifest = item?.ingestionManifest as KnowledgeIngestionManifest | undefined;
      if (storedManifest?.schemaVersion === 1) {
        return storedManifest.coverage?.verified === true
          && storedManifest.retrieval?.method !== 'golden_qa_v1';
      }
      const legacyStatus = String(item?.extractionStatus || item?.status || '').toLowerCase();
      const attempts = Number(item?.legacyRevalidationAttempts || 0);
      const retryAt = Number(item?.legacyRevalidationRetryAt || 0);
      return (legacyStatus === 'indexed' || Boolean(item?.agentIds?.length))
        && attempts < 3
        && retryAt <= now;
    });
    if (!meta) return 'idle';

    const userId = String(meta.userId || '');
    const filename = String(meta.filename || '');
    activeIdentity = { userId, filename };
    const storedManifest = meta.ingestionManifest as KnowledgeIngestionManifest | undefined;
    if (storedManifest?.schemaVersion === 1
      && storedManifest.coverage?.verified === true
      && storedManifest.retrieval?.method !== 'golden_qa_v1') {
      const invalidated = { ...storedManifest, ...evaluateKnowledgeManifest(storedManifest) };
      applyIngestionManifest(meta, invalidated);
      meta.status = 'indexed';
      meta.legacyRevalidationLastAt = new Date().toISOString();
      meta.legacyRevalidationError = 'Prior synthetic retrieval probes are not golden QA; owner-supplied cases are required.';
      commitKnowledgeFileState(db);
      return 'unverified';
    }
    const filePath = path.join(personalKnowledgeDirectoryForMeta(meta, db), filename);
    meta.legacyRevalidationAttempts = Number(meta.legacyRevalidationAttempts || 0) + 1;
    meta.legacyRevalidationLastAt = new Date().toISOString();
    if (!userId || !filename || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const extraction: KnowledgeExtractionResult = {
        content: null,
        method: 'unsupported',
        status: 'failed',
        error: 'Legacy knowledge source is missing; existing index remains read-only and unverified.',
        failureKind: 'extraction_error',
      };
      applyExtractionMeta(meta, extraction, null);
      applyIngestionManifest(meta, buildNonIndexedManifest(filePath || filename, extraction));
      meta.status = 'failed';
      commitKnowledgeFileState(db);
      return 'failed';
    }

    const extraction = await extractKnowledgeFileContent(filePath, userId);
    if (!extraction.content?.trim()) {
      applyExtractionMeta(meta, extraction, null);
      applyIngestionManifest(meta, buildNonIndexedManifest(filePath, extraction));
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      commitKnowledgeFileState(db);
      return 'failed';
    }

    const legacyMemories = findExistingFileMemories(db, filename, {
      domain: 'personal',
      userId,
      orgId: '',
      dir: personalKnowledgeDirectoryForMeta(meta, db),
      legacyPersonalOwner: Boolean((db.users || []).find((user: any) => user?.role === 'admin' && user.uid === userId)),
    }, { userId });
    const agentIds = Array.from(new Set<string>(
      (Array.isArray(meta.agentIds) && meta.agentIds.length ? meta.agentIds : ['lumi'])
        .map((value: unknown) => String(value || '').trim())
        .filter((value: string): value is string => Boolean(value)),
    ));
    let latestResult: Awaited<ReturnType<typeof ingestDocument>> | null = null;
    for (const agentId of agentIds) {
      latestResult = await ingestDocument(userId, agentId, filename, extraction.content, {
        filePath,
        domain: 'personal',
        sourceMetadata: extraction.sourceMetadata,
        extraction,
      });
    }
    if (!latestResult) throw new Error('No target agent was available for legacy knowledge revalidation.');

    const oldIds = new Set(legacyMemories.map((memory: any) => String(memory.id || '')));
    if (oldIds.size) db.memories = (db.memories || []).filter((memory: any) => !oldIds.has(String(memory.id || '')));
    applyExtractionMeta(meta, extraction, extraction.content);
    applyIngestionManifest(meta, latestResult.manifest);
    meta.status = latestResult.manifest.status === 'partial' ? 'partial' : 'indexed';
    delete meta.legacyRevalidationRetryAt;
    commitKnowledgeFileState(db);
    return latestResult.manifest.coverage.verified ? 'verified' : 'unverified';
  } catch (error: any) {
    try {
      const db = readKnowledgeFileState();
      const candidate = activeIdentity
        ? (db.knowledgeFiles || []).find((item: any) => (
            String(item.userId || '') === activeIdentity!.userId
            && String(item.filename || '') === activeIdentity!.filename
          ))
        : null;
      if (candidate) {
        const attempts = Number(candidate.legacyRevalidationAttempts || 1);
        candidate.legacyRevalidationError = String(error?.message || error).slice(0, 500);
        candidate.legacyRevalidationRetryAt = Date.now() + Math.min(24 * 60 * 60_000, 2 ** attempts * 60_000);
        commitKnowledgeFileState(db);
      }
    } catch {}
    return 'failed';
  } finally {
    legacyRevalidationRunning = false;
  }
}

export function scheduleLegacyKnowledgeRevalidation(delayMs = 60_000): void {
  if (legacyRevalidationTimer) return;
  legacyRevalidationTimer = setTimeout(async () => {
    legacyRevalidationTimer = null;
    const result = await revalidateOneLegacyKnowledgeFile();
    if (result !== 'idle') scheduleLegacyKnowledgeRevalidation(60_000);
  }, Math.max(1_000, delayMs));
  if (typeof (legacyRevalidationTimer as any).unref === 'function') (legacyRevalidationTimer as any).unref();
}
