import { createHash } from 'node:crypto';
import type { Memory } from './types';

type MemoryInput = Pick<Memory, 'userId' | 'type' | 'content' | 'keywords' | 'domain' | 'orgId' | 'agentId'>;
type IndexedMemory = MemoryInput & Pick<Memory, 'embedding' | 'embeddingNamespace' | 'embeddingContentHash'>;

/** Binds an index and in-flight work to the exact text and owner it represents. */
export function memoryEmbeddingInputHash(memory: MemoryInput): string {
  return createHash('sha256').update(JSON.stringify([
    memory.userId, memory.domain || 'personal', memory.orgId || '', memory.agentId || '',
    memory.type, memory.content, memory.keywords,
  ])).digest('hex');
}

export function hasCurrentMemoryEmbedding(memory: IndexedMemory): boolean {
  const vector = memory.embedding;
  const namespace = memory.embeddingNamespace;
  return Array.isArray(vector) && vector.length > 0 && vector.length <= 65_536
    && vector.every(value => typeof value === 'number' && Number.isFinite(value))
    && Boolean(namespace && typeof namespace.provider === 'string' && namespace.provider
      && typeof namespace.model === 'string' && namespace.model
      && namespace.dimensions === vector.length)
    && memory.embeddingContentHash === memoryEmbeddingInputHash(memory);
}

export function invalidateMemoryEmbedding(memory: IndexedMemory): void {
  delete memory.embedding;
  delete memory.embeddingNamespace;
  delete memory.embeddingContentHash;
}

/** Malformed or legacy unbound vectors remain eligible for keyword recall. */
export function parsePersistedMemoryEmbedding(memory: MemoryInput & Record<string, any>): Pick<Memory, 'embedding' | 'embeddingNamespace' | 'embeddingContentHash'> {
  try {
    const indexed: IndexedMemory = { ...memory,
      embedding: JSON.parse(memory.embedding || 'null'),
      embeddingNamespace: JSON.parse(memory.embeddingNamespace || 'null'),
      embeddingContentHash: typeof memory.embeddingContentHash === 'string' ? memory.embeddingContentHash : undefined,
    };
    if (hasCurrentMemoryEmbedding(indexed)) return {
      embedding: indexed.embedding, embeddingNamespace: indexed.embeddingNamespace,
      embeddingContentHash: indexed.embeddingContentHash,
    };
  } catch { /* Invalid stored index cannot invalidate the underlying memory. */ }
  return { embedding: undefined, embeddingNamespace: undefined, embeddingContentHash: undefined };
}
