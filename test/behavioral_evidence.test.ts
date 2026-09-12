import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { analyzeBehavioralPatterns } from '../server/memory/behavioral';
import { addMemory, queryMemories } from '../server/memory/store';
import { isDerivedLearningMemory, isOwnerInteractionEvidence, repairRuntimeLearningEvidence } from '../server/memory/provenance';

beforeAll(async () => { await initDatabase(); });
describe('owner learning evidence boundaries', () => {
  it('counts verified tools rather than scheduling characters, failed retries, tests or other users', () => {
    const db = readDB();
    const userId = 'behavior-evidence';
    const common = { userId, domain: 'personal', orgId: '', timestamp: new Date().toISOString() };
    for (let i = 0; i < 12; i++) db.interactions.push({ ...common, id: `owner-${i}`, role: 'user', content: '我的项目需要设计', source: 'command-center-chat' });
    db.interactions.push({ ...common, id: 'actual-tool', role: 'assistant', toolCalls: [
      { name: 'read_file', result: 'actual text' }, { name: 'search_files', error: 'access denied', result: '' },
    ] });
    db.interactions.push({ ...common, id: 'scheduler', mode: 'proactive', toolCalls: '{"executionId":"eeeeeeeeee","scheduledTaskId":"daily_summary"}' });
    db.interactions.push({ ...common, id: 'harness', source: 'local_acceptance_harness', role: 'user', content: 'test words should never become owner topics', toolCalls: [{ name: 'write_file', result: 'done' }] });
    db.interactions.push({ ...common, id: 'foreign', userId: 'another-owner', role: 'assistant', toolCalls: [{ name: 'delete_file', result: 'done' }] });
    const patterns = analyzeBehavioralPatterns(userId);
    expect(patterns.find(p => p.type === 'frequent_tool')?.content).toBe('Most used tools: read_file(1x)');
    expect(analyzeBehavioralPatterns('anonymous')).toEqual([]);
    expect(JSON.stringify(patterns)).not.toContain('never');
  });
  it('keeps invalid legacy habits and explicit live-test data in storage but excludes them from recall', () => {
    const userId = 'invalid-habits';
    for (const [content, sourceInteractionId] of [
      ['Most used tools: "(16x), generate_image(15x), e(13x)', 'behavioral_123'],
      ['{"interactionSample":["[LC-LIVE-20260908-123] backend acceptance"]}', 'growth_journal_scheduler'],
    ]) addMemory({ userId, type: 'habit', content, sourceInteractionId, keywords: [], confidence: .9 }, { generateEmbedding: false });
    addMemory({ userId, type: 'preference', content: '用户喜欢看蜡笔小新', sourceInteractionId: 'manual', keywords: [], confidence: .9 }, { generateEmbedding: false });
    expect(queryMemories({ userId }).map(m => m.content)).toEqual(['用户喜欢看蜡笔小新']);
    expect(readDB().memories.filter(m => m.userId === userId)).toHaveLength(3);
  });
  it('does not recycle system reflections or agent test requests into new learning', () => {
    expect(isDerivedLearningMemory({ sourceInteractionId: 'growth_journal_scheduler', content: '{"date":"today"}' })).toBe(true);
    expect(isDerivedLearningMemory({ sourceInteractionId: 'narrative_consolidation_123', content: 'a generated reflection' })).toBe(true);
    expect(isOwnerInteractionEvidence({ source: 'command-center-chat', message: '[LC-LIVE-20260908-1] 验收' })).toBe(false);
    expect(isOwnerInteractionEvidence({ source: 'command-center-chat', role: 'user', message: '帮我做一个设计' })).toBe(true);
  });
  it('archives corrupt evidence before quarantine and repairs stale summaries only once', () => {
    const db = readDB();
    const memory = addMemory({ userId: 'repair-owner', type: 'habit', content: 'Most used tools: e(26x), "(17x)', sourceInteractionId: 'behavioral_old', keywords: [], confidence: .9 }, { generateEmbedding: false });
    const summary = '用户喜欢看蜡笔小新。语音通道只能对话而无法执行实际操作任务。';
    db.conversations.push({ id: 'repair-summary', userId: 'repair-owner', summary, summaryChain: [summary], lastSummaryMessageCount: 83, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() } as any);
    expect(repairRuntimeLearningEvidence()).toBeGreaterThan(0);
    const archive = JSON.parse(db.settings.find(s => s.key === 'learning_evidence_repair_v2')!.value);
    expect(archive.memories).toEqual(expect.arrayContaining([expect.objectContaining({ id: memory.id, sourceInteractionId: 'behavioral_old' })]));
    expect(archive.summaries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'repair-summary', summary, lastSummaryMessageCount: 83 })]));
    expect(db.memories.find(m => m.id === memory.id)?.content).toBe(memory.content);
    expect(queryMemories({ userId: 'repair-owner' })).toEqual([]);
    expect(db.conversations.find(c => c.id === 'repair-summary')).toMatchObject({ summary: '用户喜欢看蜡笔小新。', lastSummaryMessageCount: 0 });
    expect(repairRuntimeLearningEvidence()).toBe(0);
  });
});
