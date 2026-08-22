import './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMemory, queryMemories, removeMemory } from '../server/memory/store';

describe('memory tier priority', () => {
  const created: string[] = [];
  const userId = `memory_tier_priority_${Date.now()}`;

  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  afterEach(() => {
    while (created.length) removeMemory(created.pop()!);
  });

  it('keeps core identity ahead of episodic memories with and without a query', () => {
    const episodic = addMemory({
      userId,
      type: 'fact',
      content: 'Lumi continuity anchor from a recent episode.',
      keywords: ['continuity', 'anchor'],
      confidence: 1,
      sourceInteractionId: 'episodic_priority_test',
    }, {
      domain: 'personal',
      source: 'manual',
      tier: 'episodic',
      importance: 1,
      userApproved: true,
    });
    const identity = addMemory({
      userId,
      type: 'knowledge',
      content: 'Lumi continuity anchor is part of her stable identity.',
      keywords: ['continuity', 'anchor'],
      confidence: 0.2,
      sourceInteractionId: 'identity_priority_test',
    }, {
      domain: 'personal',
      source: 'manual',
      tier: 'core_identity',
      importance: 0.1,
      perspective: 'lumi_self',
      userApproved: true,
    });
    created.push(episodic.id, identity.id);

    const withoutQuery = queryMemories({ userId, domain: 'personal', minConfidence: 0, limit: 10 });
    expect(withoutQuery.findIndex(item => item.id === identity.id))
      .toBeLessThan(withoutQuery.findIndex(item => item.id === episodic.id));

    const withQuery = queryMemories({
      userId,
      domain: 'personal',
      query: 'continuity anchor',
      minConfidence: 0,
      limit: 10,
    });
    expect(withQuery.findIndex(item => item.id === identity.id))
      .toBeLessThan(withQuery.findIndex(item => item.id === episodic.id));
  });
});
