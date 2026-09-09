import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { addMemory, removeMemory } from '../server/memory/store';
import { extractMemories } from '../server/memory/extractor';
import { consolidateEpisodic, selfReflect, consolidateNarrative } from '../server/memory/consolidator';
import { makeLLMCall } from '../server/llm/providers';

vi.mock('../server/llm/providers', () => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ provider: 'openai', model: 'synthetic', vector: [1, 0] })),
}));

describe('memory extraction and derived data lifecycle', () => {
  beforeAll(async () => { await initDatabase(); });
  it.each(['object', 'array', 'fenced'])('parses a normal %s JSON model response', async shape => {
    const memories = [{ type: 'preference', content: 'The user prefers concise answers.', keywords: ['concise'], confidence: 0.8 }];
    const json = shape === 'array' ? JSON.stringify(memories) : JSON.stringify({ memories, reminders: [] });
    vi.mocked(makeLLMCall).mockResolvedValueOnce({ text: shape === 'fenced' ? `\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060` : json } as any);
    const result = await extractMemories({ userMessage: 'Please keep answers concise.', assistantResponse: 'Understood.', existingMemories: [], provider: 'openai', model: 'synthetic' }, () => null, () => null);
    expect(result.memories[0]?.content).toBe(memories[0].content);
  });

  it.each(['episodic', 'reflection', 'narrative'])('discards a late %s result after its source was deleted', async kind => {
    const userId = `source-lifecycle-${kind}`;
    const memory = addMemory({ userId, type: 'fact', content: 'A source statement', keywords: ['source'], confidence: 0.8, sourceInteractionId: 'synthetic' }, { tier: kind === 'reflection' ? 'growth' : 'episodic', generateEmbedding: false });
    let finish!: (value: any) => void;
    vi.mocked(makeLLMCall).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const ctx = { userId, provider: 'openai' as const, model: 'synthetic' };
    const pending = kind === 'episodic' ? consolidateEpisodic(ctx, 1, () => null, () => null)
      : kind === 'reflection' ? selfReflect(ctx, () => null, () => null)
        : consolidateNarrative(ctx, 7, 1, () => null, () => null);
    expect(finish).toBeTypeOf('function');
    removeMemory(memory.id);
    finish({ text: JSON.stringify({ content: 'Derived old statement', narrative: 'Derived old statement', title: 'Synthetic', keywords: [], importance: 0.5 }) });
    expect(await pending).toBeNull();
    expect(readDB().memories.filter(item => item.userId === userId)).toEqual([]);
  });

  it('discards reflection after an in-place source edit', async () => {
    const userId = 'source-edit';
    const memory = addMemory({ userId, type: 'fact', content: 'Original source', keywords: [], confidence: 0.8, sourceInteractionId: 'synthetic' }, { tier: 'growth', generateEmbedding: false });
    let finish!: (value: any) => void;
    vi.mocked(makeLLMCall).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = selfReflect({ userId, provider: 'openai', model: 'synthetic' }, () => null, () => null);
    const db = readDB();
    db.memories.find(item => item.id === memory.id)!.content = 'Corrected source';
    writeDB(db);
    finish({ text: '{"content":"Old reflection","keywords":[]}' });
    expect(await pending).toBeNull();
    expect(readDB().memories.filter(item => item.userId === userId)).toHaveLength(1);
  });
});
