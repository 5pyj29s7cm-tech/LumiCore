import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  formatKnowledgeCitation,
  ingestDocument,
  isKnowledgeMemorySourceCurrent,
  retrieveChunks,
} from '../server/agents/rag';
import type { Memory } from '../server/memory/types';
import { removeMemory } from '../server/memory/store';
import { readDB } from '../db_layer';
import crypto from 'node:crypto';

const temporaryRoots: string[] = [];
const createdMemoryIds: string[] = [];

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

afterEach(() => {
  for (const id of createdMemoryIds.splice(0)) removeMemory(id);
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function provenanceMemory(sourcePath: string): Memory {
  const stat = fs.statSync(sourcePath);
  return {
    id: 'knowledge-memory',
    userId: 'knowledge-user',
    type: 'knowledge',
    content: '[source.txt #1/1] verified content',
    keywords: ['source:source.txt', 'chunk:1/1'],
    confidence: 0.7,
    sourceInteractionId: sourcePath,
    knowledgeProvenance: {
      sourceId: sourcePath,
      sourceLabel: 'source.txt',
      sourcePath,
      sourceRevision: 'source-revision-digest',
      sourceFileHash: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
      sourceModifiedAtMs: stat.mtimeMs,
      sourceSizeBytes: stat.size,
      chunkIndex: 0,
      chunkCount: 1,
      chunkContentHash: 'chunk-content-digest',
      citationKey: 'source:source.txt#chunk:1/1#sha256:chunk-content-digest',
      ingestedAt: '2026-01-01T00:00:00.000Z',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRetrievedAt: null,
    retrieveCount: 0,
    tier: 'internalized',
    perspective: 'lumi_self',
    importance: 0.4,
    parentId: null,
    agentId: 'lumi',
    nodeType: 'leaf',
  };
}

describe('knowledge source revision safety', () => {
  it('persists immutable provenance and excludes the chunk from recall after the source changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-knowledge-ingest-'));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, 'source.txt');
    const content = 'The verified launch code is ALPHA-742 and applies only to the July release.';
    fs.writeFileSync(sourcePath, content, 'utf8');

    const result = await ingestDocument(
      'knowledge-provenance-user',
      'knowledge-provenance-agent',
      'source.txt',
      content,
      {
        filePath: sourcePath,
        domain: 'personal',
        verifyEmbeddings: false,
        verifyRetrieval: false,
      },
    );
    createdMemoryIds.push(...result.memoryIds);
    const memory = (readDB().memories || []).find((item: Memory) => item.id === result.memoryIds[0]) as Memory;

    expect(memory.knowledgeProvenance).toMatchObject({
      sourceId: sourcePath,
      sourceLabel: 'source.txt',
      sourcePath: path.resolve(sourcePath),
      sourceRevision: result.manifest.sourceRevision,
      sourceFileHash: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
      chunkIndex: 0,
      chunkCount: 1,
      chunkContentHash: result.manifest.chunks[0].contentHash,
      citationKey: result.manifest.chunks[0].citationKey,
    });
    const current = await retrieveChunks(
      'knowledge-provenance-user',
      'knowledge-provenance-agent',
      'ALPHA-742 July release',
      5,
      { domain: 'personal' },
    );
    expect(current.map(item => item.id)).toContain(memory.id);
    expect(current.find(item => item.id === memory.id)?.citation).toContain(result.manifest.chunks[0].contentHash);

    fs.writeFileSync(sourcePath, 'The launch code has been replaced.', 'utf8');
    const changedAt = new Date(memory.knowledgeProvenance!.sourceModifiedAtMs! + 5_000);
    fs.utimesSync(sourcePath, changedAt, changedAt);
    const stale = await retrieveChunks(
      'knowledge-provenance-user',
      'knowledge-provenance-agent',
      'ALPHA-742 July release',
      5,
      { domain: 'personal' },
    );
    expect(stale.map(item => item.id)).not.toContain(memory.id);
  });

  it('rejects a file-backed knowledge chunk after its source is changed or removed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-knowledge-revision-'));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, 'source.txt');
    fs.writeFileSync(sourcePath, 'verified content', 'utf8');
    const memory = provenanceMemory(sourcePath);

    expect(isKnowledgeMemorySourceCurrent(memory)).toBe(true);

    fs.writeFileSync(sourcePath, 'changed content with a different size', 'utf8');
    const changedAt = new Date(memory.knowledgeProvenance!.sourceModifiedAtMs! + 5_000);
    fs.utimesSync(sourcePath, changedAt, changedAt);
    expect(isKnowledgeMemorySourceCurrent(memory)).toBe(false);

    fs.unlinkSync(sourcePath);
    expect(isKnowledgeMemorySourceCurrent(memory)).toBe(false);
  });

  it('detects a same-size source rewrite even when its timestamp is restored', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-knowledge-same-size-'));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, 'source.txt');
    fs.writeFileSync(sourcePath, 'AAAA', 'utf8');
    const memory = provenanceMemory(sourcePath);
    const originalTime = new Date(memory.knowledgeProvenance!.sourceModifiedAtMs!);

    fs.writeFileSync(sourcePath, 'BBBB', 'utf8');
    fs.utimesSync(sourcePath, originalTime, originalTime);

    expect(fs.statSync(sourcePath).size).toBe(memory.knowledgeProvenance!.sourceSizeBytes);
    expect(isKnowledgeMemorySourceCurrent(memory)).toBe(false);
  });

  it('formats hash-addressed citations without leaking an absolute local path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-knowledge-citation-'));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, 'source.txt');
    fs.writeFileSync(sourcePath, 'verified content', 'utf8');
    const citation = formatKnowledgeCitation(provenanceMemory(sourcePath));

    expect(citation).toBe('[Source: source:source.txt#chunk:1/1#sha256:chunk-content-digest]');
    expect(citation).not.toContain(root);
  });

  it('keeps legacy virtual knowledge readable but explicitly on the legacy citation path', () => {
    const citation = formatKnowledgeCitation({
      sourceInteractionId: 'virtual-source.md',
      keywords: ['chunk:2/3'],
    });

    expect(isKnowledgeMemorySourceCurrent({})).toBe(true);
    expect(citation).toBe('[Source: virtual-source.md, chunk:2/3]');
  });
});
