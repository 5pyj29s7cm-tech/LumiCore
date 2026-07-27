import path from 'path';
import { addMemory, queryMemoriesVector } from '../memory/store';
import { generateConfiguredEmbedding } from '../llm/embedding_provider';
import { Memory } from '../memory/types';
import type { MarkdownKnowledgeMetadata } from '../knowledge/markdown';
import {
  buildKnowledgeIngestionManifest,
  chunkKnowledgeText,
  evaluateKnowledgeManifest,
  evaluateKnowledgeRetrievalCases,
  type KnowledgeChunkManifest,
  type KnowledgeIngestionManifest,
  type KnowledgeRetrievalCaseEvidence,
} from '../knowledge/ingestion_manifest';

export interface ChunkOptions {
  maxChunkSize?: number;
  overlapSize?: number;
  agentId?: string;
}

export interface IngestDocumentOptions {
  chunkSize?: number;
  tier?: 'episodic' | 'internalized';
  filePath?: string;
  domain?: string;
  orgId?: string;
  sourceMetadata?: MarkdownKnowledgeMetadata;
  extraction?: {
    status?: string;
    method?: string;
    warning?: string;
    error?: string;
  };
  verifyEmbeddings?: boolean;
  verifyRetrieval?: boolean;
}

export interface IngestDocumentResult {
  chunkCount: number;
  memoryIds: string[];
  manifest: KnowledgeIngestionManifest;
}

/**
 * Split text into overlapping chunks for memory ingestion.
 * Default chunk size ~500 chars with 50 char overlap.
 */
export function chunkText(
  text: string,
  options: ChunkOptions = {},
): string[] {
  return chunkKnowledgeText(text, {
    maxChunkSize: options.maxChunkSize || 500,
    overlapSize: options.overlapSize || 50,
  }).map(chunk => chunk.text);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

/**
 * Ingest a document into an agent's private memory.
 * Each chunk becomes an internalized memory with source citation metadata.
 */
export async function ingestDocument(
  userId: string,
  agentId: string,
  documentTitle: string,
  content: string,
  options?: IngestDocumentOptions,
): Promise<IngestDocumentResult> {
  const chunks = chunkKnowledgeText(content, {
    maxChunkSize: options?.chunkSize || 500,
  });

  const memoryIds: string[] = [];
  const sourceFile = options?.filePath || documentTitle;
  const metadataKeywords = buildSourceMetadataKeywords(options?.sourceMetadata);

  const verifyEmbeddings = options?.verifyEmbeddings !== false;
  const embeddingResults = verifyEmbeddings
    ? await mapWithConcurrency(chunks, 3, async chunk => {
        try {
          return await generateConfiguredEmbedding(
            `knowledge: ${chunk.text} ${documentTitle} source:${path.basename(sourceFile)}`,
            userId,
          );
        } catch (error: any) {
          return { error: String(error?.message || error || 'embedding_failed').slice(0, 300) };
        }
      })
    : chunks.map(() => null);
  const chunkManifests: KnowledgeChunkManifest[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddingResults[i] && !('error' in (embeddingResults[i] as any))
      ? embeddingResults[i] as Awaited<ReturnType<typeof generateConfiguredEmbedding>>
      : null;
    const embeddingError = embeddingResults[i] && 'error' in (embeddingResults[i] as any)
      ? String((embeddingResults[i] as any).error)
      : undefined;
    const mem = addMemory(
      {
        userId,
        type: 'knowledge',
        content: `[${documentTitle} #${i + 1}/${chunks.length}] ${chunk.text}`,
        keywords: [
          documentTitle,
          `source:${path.basename(sourceFile)}`,
          `chunk:${i + 1}/${chunks.length}`,
          'ingested',
          'document',
          ...metadataKeywords,
        ],
        confidence: 0.7,
        sourceInteractionId: sourceFile,
        embedding: embedding?.vector,
      },
      {
        tier: options?.tier || 'internalized',
        perspective: 'lumi_self',
        importance: 0.4,
        agentId,
        domain: options?.domain || 'personal',
        orgId: options?.orgId || '',
        source: 'import',
        deduplicate: false,
        generateEmbedding: !verifyEmbeddings,
      },
    );
    memoryIds.push(mem.id);
    chunkManifests.push({
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      charCount: chunk.charCount,
      contentHash: chunk.contentHash,
      memoryId: mem.id,
      stored: true,
      embeddingStatus: embedding ? 'verified' : verifyEmbeddings ? 'failed' : 'pending',
      embeddingProvider: embedding?.provider,
      embeddingModel: embedding?.model,
      embeddingDimensions: embedding?.vector.length,
      citationKey: `source:${path.basename(sourceFile)}#chunk:${i + 1}/${chunks.length}#sha256:${chunk.contentHash}`,
      error: embeddingError,
    });
  }

  let manifest = buildKnowledgeIngestionManifest({
    sourceId: sourceFile,
    content,
    chunks: chunkManifests,
    extraction: options?.extraction,
  });

  if (options?.verifyRetrieval !== false && chunks.length > 0) {
    const sampleIndexes = chunks.length <= 12
      ? chunks.map(chunk => chunk.index)
      : Array.from(new Set(Array.from({ length: 12 }, (_, index) => Math.round(index * (chunks.length - 1) / 11))));
    const cases: KnowledgeRetrievalCaseEvidence[] = [];
    for (const index of sampleIndexes) {
      const chunk = chunks[index];
      const probe = chunk.text.replace(/\s+/g, ' ').trim().slice(0, 180);
      const retrieved = await retrieveChunks(userId, agentId, probe, 5, {
        domain: options?.domain,
        orgId: options?.orgId,
      });
      cases.push({
        caseId: `chunk_${index + 1}`,
        expectedChunkIndexes: [index],
        retrievedMemoryIds: retrieved.map(memory => memory.id),
        citedChunkHashes: retrieved
          .map(memory => chunkManifests.find(candidate => candidate.memoryId === memory.id)?.contentHash || '')
          .filter(Boolean),
      });
    }
    const retrieval = evaluateKnowledgeRetrievalCases({ cases, chunks: chunkManifests, topK: 5 });
    const base = { ...manifest, retrieval, updatedAt: new Date().toISOString() };
    manifest = { ...base, ...evaluateKnowledgeManifest(base) };
  }

  console.log(`[RAG] Ingested "${documentTitle}" -> ${chunks.length} chunks for agent ${agentId}`);
  return { chunkCount: chunks.length, memoryIds, manifest };
}

function buildSourceMetadataKeywords(metadata?: MarkdownKnowledgeMetadata): string[] {
  if (!metadata) return [];
  const values = [
    metadata.title ? `title:${metadata.title}` : '',
    ...metadata.aliases.map(alias => `alias:${alias}`),
    ...metadata.tags.map(tag => `tag:${tag.replace(/^#/, '')}`),
    ...metadata.wikiLinks.map(link => `wikilink:${link}`),
    ...metadata.markdownLinks.map(link => `link:${link}`),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = String(value || '').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result.slice(0, 120);
}

/**
 * Retrieve relevant chunks for a query from agent-scoped knowledge.
 * Each result includes a citation string tracking source document and chunk position.
 */
export async function retrieveChunks(
  userId: string,
  agentId: string,
  query: string,
  limit = 5,
  scope: { domain?: string; orgId?: string } = {},
): Promise<Array<Memory & { citation: string }>> {
  const memories = await queryMemoriesVector({
    userId,
    agentId,
    type: 'knowledge',
    query,
    limit,
    minConfidence: 0.3,
    domain: scope.domain,
    orgId: scope.orgId,
    useVector: true,
  });

  return memories.map(m => {
    const source = m.sourceInteractionId
      ? path.basename(m.sourceInteractionId)
      : 'unknown';
    const chunkInfo = (m.keywords || []).find((k: string) => k.startsWith('chunk:')) || 'unknown';
    return {
      ...m,
      citation: `[Source: ${source}, ${chunkInfo}]`,
    };
  });
}
