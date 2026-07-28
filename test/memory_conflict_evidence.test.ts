import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMemory,
  queryMemories,
  removeMemory,
  resolveMemoryConflict,
} from '../server/memory/store';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

describe('memory conflict evidence', () => {
  it('preserves both contradictory memories and resolves them only by explicit choice', () => {
    const userId = `memory-conflict-${Date.now()}-${Math.random()}`;
    const common = {
      userId,
      type: 'preference' as const,
      keywords: ['coffee'],
      confidence: 0.8,
      sourceInteractionId: 'manual-conflict-test',
    };
    const liked = addMemory({ ...common, content: 'User likes dark coffee every morning.' }, {
      domain: 'personal', source: 'manual', userApproved: true,
    });
    const disliked = addMemory({ ...common, content: 'User dislikes dark coffee every morning.' }, {
      domain: 'personal', source: 'manual', userApproved: true,
    });

    expect(liked.id).not.toBe(disliked.id);
    const unresolved = queryMemories({ userId, domain: 'personal', minConfidence: 0, limit: 10 });
    const storedLiked = unresolved.find(memory => memory.id === liked.id)!;
    const storedDisliked = unresolved.find(memory => memory.id === disliked.id)!;
    expect(storedLiked.conflict).toMatchObject({ status: 'unresolved' });
    expect(storedLiked.conflict?.relatedMemoryIds).toContain(disliked.id);
    expect(storedDisliked.conflict?.relatedMemoryIds).toContain(liked.id);

    const resolved = resolveMemoryConflict({
      userId,
      memoryId: liked.id,
      resolution: 'prefer_one',
      chosenMemoryId: disliked.id,
      domain: 'personal',
    });
    expect(resolved).toHaveLength(2);
    expect(resolved.every(memory => memory.conflict?.status === 'resolved')).toBe(true);
    expect(resolved.every(memory => memory.conflict?.chosenMemoryId === disliked.id)).toBe(true);
    expect(resolved.find(memory => memory.id === disliked.id)!.confidence)
      .toBeGreaterThan(resolved.find(memory => memory.id === liked.id)!.confidence);

    expect(removeMemory(liked.id)).toBe(true);
    const survivor = queryMemories({ userId, domain: 'personal', minConfidence: 0, limit: 10 })
      .find(memory => memory.id === disliked.id)!;
    expect(survivor.conflict).toMatchObject({
      status: 'resolved',
      resolution: 'related_removed',
      relatedMemoryIds: [],
    });
    removeMemory(disliked.id);
  });
});
