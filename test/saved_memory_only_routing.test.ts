import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { isSavedMemoryLookupOnlyRequest } from '../server/cognition/saved_memory_intent';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const toolRegistry = new ToolRegistry();
beforeAll(async () => { await initDatabase(); registerAllTools(toolRegistry); });
const run = (text: string) => buildLumiExecutionPipeline({
  requestId: 'saved-memory-routing', userText: text,
  dispatch: { userId: 'memory-routing-fixture', text, channel: 'chat', source: 'chat', domain: 'personal', orgId: '', operationMode: 'assistant', targetIsLumi: true },
  registry: toolRegistry, personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 8 },
  source: 'chat',
});

describe('saved-memory-only requests use context without unrelated tools', () => {
  it.each([
    '请查询我已保存的记忆中关于项目标记的信息。',
    'Search my saved memories for the project marker.',
    '你还记得项目标记吗？请搜索我已保存的记忆。不要搜索网页。',
    'Do you remember the project marker? Search my saved memories. Do not search the web.',
    'Use memory_search to look up the project marker in my saved memories.',
  ])('keeps local context lookup tool-free: %s', text => {
    expect(isSavedMemoryLookupOnlyRequest(text)).toBe(true);
    const pipeline = run(text);
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.modelToolProjection.toolNames).toEqual([]);
    expect(pipeline.authorizationPolicy.allowedTools).toEqual([]);
  });
  it.each([
    '请查询我已保存的记忆。然后搜索官网公开资料。',
    'Search my saved memories for the project marker and then search the official website.',
    '请查询我已保存的记忆，然后在 D:/notes/output.txt 写入项目标记。',
    'Read my saved memory file D:/notes/memory.txt.',
    'Explain this sentence: "Search my saved memories for the project marker."',
    'If I search my saved memories, what happens?',
    '不要查询我已保存的记忆。',
    '查询我保存的记忆后搜索官方网站。',
    '查询我保存的记忆再搜索官方网站。',
    'Search my saved memories.txt',
    'Check memory usage.',
    'Read memory at 0x1000.',
    'Use memory_search to look up the project marker in my saved memories and open the browser.',
  ])('does not override other actions or treat quoted/negated text as a lookup: %s', text => {
    expect(isSavedMemoryLookupOnlyRequest(text)).toBe(false);
  });
  it('retains the explicit website search alongside memory context', () => {
    const pipeline = run('请查询我已保存的记忆。然后搜索官网公开资料。');
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.toolNames).toContain('web_search');
  });
});
