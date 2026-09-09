import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { ingestDocument } from '../server/agents/rag';
import { generateConfiguredEmbedding } from '../server/llm/embedding_provider';

vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/embedding_provider')>(), generateConfiguredEmbedding: vi.fn(),
}));

describe('knowledge import source ownership', () => {
  beforeAll(async () => { await initDatabase(); });
  it.each(['delete', 'replace', 'cancel'])('rejects a late embedding after source %s', async change => {
    const userId = `knowledge-late-${change}`;
    const sourcePath = path.join(process.env.LUMI_DATA_DIR!, `${change}.txt`);
    fs.writeFileSync(sourcePath, 'Original knowledge');
    let finish!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = ingestDocument(userId, 'lumi', `${change}.txt`, 'Original knowledge', { filePath: sourcePath, signal: controller.signal });
    const settled = expect(pending).rejects.toThrow();
    if (change === 'delete') fs.unlinkSync(sourcePath);
    else if (change === 'replace') fs.writeFileSync(sourcePath, 'Replacement knowledge');
    else controller.abort();
    finish({ provider: 'openai', model: 'synthetic', vector: [1, 0] });
    await settled;
    expect(readDB().memories.filter((memory: any) => memory.userId === userId)).toEqual([]);
  });
});
