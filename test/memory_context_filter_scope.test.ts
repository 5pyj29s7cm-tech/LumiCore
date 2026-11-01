import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Memory, MemoryQuery } from '../server/memory/types';
const state = vi.hoisted(() => ({ memories: [] as Memory[], writes: 0 }));
vi.mock('../db_layer', async () => {
  const { withTableDatabaseMock } = await import('./helpers/table_database_mock');
  return withTableDatabaseMock({
    readDB: () => ({ memories: state.memories, memoryAssociations: [], reminders: [] }),
    writeDB: () => { state.writes++; },
  });
});
import { queryMemories } from '../server/memory/store';

const row = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id, userId: 'context-owner', type: 'fact', content: 'marker source ' + id, keywords: ['marker'], confidence: .9,
  sourceInteractionId: 'owner-message', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  lastRetrievedAt: null, retrieveCount: 0, tier: 'episodic', perspective: 'owner_trait', importance: .5,
  parentId: null, agentId: '', nodeType: 'leaf', domain: 'personal', orgId: '', source: 'chat', ...overrides,
});
const scope: MemoryQuery = { userId: 'context-owner', domain: 'personal', orgId: '', query: 'marker', limit: 1, recordRetrieval: false };
const context: MemoryQuery = { ...scope, types: ['fact'], agentIds: ['', 'lumi'], excludePrivacyClasses: ['secret'],
  excludeRetentions: ['session', 'ephemeral'], requireAcceptedFirewall: true };
beforeEach(() => { state.memories = []; state.writes = 0; });

describe('automatic memory context filters precede ranking and limits', () => {
  it.each([
    ['type', { type: 'preference' }],
    ['private agent lane', { agentId: 'another-agent' }],
    ['secret', { privacyClass: 'secret' }],
    ['session retention', { retention: 'session' }],
    ['ephemeral retention', { retention: 'ephemeral' }],
    ['rejected firewall', { firewall: { accepted: false, reason: 'denied', appliedAt: '2026-10-01' } }],
  ] as const)('excludes %s before the one-result limit and performs no writes', (_label, excluded) => {
    state.memories = [row('excluded', { ...excluded, confidence: 1 }), row('allowed', { confidence: .6 })];
    const before = JSON.stringify(state.memories);
    expect(queryMemories(context).map(memory => memory.id)).toEqual(['allowed']);
    expect(JSON.stringify(state.memories)).toBe(before);
    expect(state.writes).toBe(0);
  });
  it('retains legacy rows without firewall/retention metadata and current private/shared lanes', () => {
    state.memories = [row('shared'), row('current', { agentId: 'lumi', privacyClass: 'private', retention: 'permanent' })];
    expect(queryMemories({ ...context, limit: 5 }).map(memory => memory.id)).toEqual(['shared', 'current']);
  });
  it('does not change existing explicit queries when the optional context filters are absent', () => {
    state.memories = [row('explicit-secret', { privacyClass: 'secret', retention: 'session', agentId: 'private-agent',
      firewall: { accepted: false, reason: 'fixture', appliedAt: '2026-10-01' } })];
    expect(queryMemories(scope).map(memory => memory.id)).toEqual(['explicit-secret']);
  });
  it('empty permitted types or agent lanes do not fall back to an unrestricted query', () => {
    state.memories = [row('shared')];
    expect(queryMemories({ ...context, types: [] })).toEqual([]);
    expect(queryMemories({ ...context, agentIds: [] })).toEqual([]);
  });
  it('does not weaken owner, organization, avatar or operational evidence filters', () => {
    state.memories = [row('other-user', { userId: 'another-user' }), row('work', { domain: 'work', orgId: 'one' }),
      row('avatar', { agentId: 'memory_avatar_a' }), row('operational', { sourceInteractionId: 'orch_run' }), row('allowed')];
    expect(queryMemories({ ...context, limit: 5, agentIds: ['', 'lumi', 'memory_avatar_a'] }).map(memory => memory.id)).toEqual(['allowed']);
  });
});
