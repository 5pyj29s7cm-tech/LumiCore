import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: {} as any, reject: false }));
vi.mock('../db_layer', () => ({
  readDB: () => state.db,
  writeDB: vi.fn((next: any) => { if (state.reject) throw new Error('refused'); state.db = next; }),
  flushDBOrThrow: vi.fn(async () => {}),
}));
import { appendUserInteraction, conversationAccessStatus, listConversationHeaders, listUserInteractions, ownedConversationExists } from '../server/conversation/history_repository';
import { addScopedVoiceProfile, listScopedVoiceProfiles, removeScopedVoiceProfile, updateScopedVoiceProfile, voiceProfileScope } from '../server/tts/profile_store';
import { listTokenUsageRows, recordTokenUsage } from '../server/llm/token_tracker';
import { listModelRoutingReceipts, persistModelRoutingReceipt } from '../server/llm/model_routing_receipts';
import { registerUsageTools } from '../server/tools/definitions/usage_tools';
import { captureMemoryAvatarAuthorization } from '../server/memory_avatar/lifecycle';

afterEach(() => { state.db = {}; state.reject = false; vi.clearAllMocks(); });
const scope = voiceProfileScope('owner', 'personal', '');
const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

describe('owner-scoped history and staged storage', () => {
  it('selects owner, workspace, conversation, dates and mode before bounding detached history', () => {
    state.db.interactions = [
      { id: 'old', userId: 'owner', timestamp: '2026-01-01', conversationId: 'a', mode: 'chat', nested: { value: 1 } },
      { id: 'new', userId: 'owner', timestamp: '2026-01-02', conversationId: 'a', mode: 'chat' },
      { id: 'foreign', userId: 'other', timestamp: '2026-01-03', conversationId: 'a', mode: 'chat' },
      { id: 'work', userId: 'owner', timestamp: '2026-01-04', domain: 'work', orgId: 'org', conversationId: 'b', mode: 'voice' },
    ];
    const rows = listUserInteractions('owner', { domain: 'personal', orgId: '', conversationIds: ['a'], mode: 'chat', order: 'newest', limit: 1 });
    expect(rows.map(row => row.id)).toEqual(['new']);
    expect(listUserInteractions('owner', { after: '2026-01-02', before: '2026-01-04' }).map(row => row.id)).toEqual(['new']);
    listUserInteractions('owner')[0].nested.value = 99;
    expect(state.db.interactions[0].nested.value).toBe(1);
    expect(listUserInteractions('')).toEqual([]);
  });
  it('keeps authorization checks read-only and separates missing, foreign and work identities', () => {
    state.db.conversations = [
      { id: 'personal', userId: 'owner', lastActiveAt: '2026-01-01' },
      { id: 'foreign', userId: 'other' },
      { id: 'work', userId: 'owner', domain: 'work', orgId: 'org' },
      { id: 'legacy', userId: 'owner', domain: 'work', orgId: '' },
    ];
    const owner = { userId: 'owner', domain: 'personal' as const, orgId: '' };
    expect(conversationAccessStatus('absent', owner)).toBe('missing');
    expect(conversationAccessStatus('foreign', owner)).toBe('forbidden');
    expect(conversationAccessStatus('work', owner)).toBe('forbidden');
    expect(conversationAccessStatus('work', { ...owner, domain: 'work', orgId: 'org' })).toBe('allowed');
    expect(ownedConversationExists('legacy', owner)).toBe(false);
    expect(listConversationHeaders(owner).map(row => row.id)).not.toContain('work');
    expect(listConversationHeaders({ ...owner, userId: '' })).toEqual([]);
    expect(conversationAccessStatus('personal', { ...owner, userId: '' })).toBe('forbidden');
  });
  it('does not append or mutate submitted content when persistence refuses a message', () => {
    state.db.interactions = [{ id: 'existing', userId: 'owner' }];
    const before = structuredClone(state.db);
    state.reject = true;
    expect(() => appendUserInteraction('owner', { text: 'draft' }, 'user')).toThrow('refused');
    expect(state.db).toEqual(before);
    state.reject = false;
    const content = { text: 'accepted' };
    const stored = appendUserInteraction('owner', content, 'user');
    content.text = 'changed'; stored.content.text = 'changed again';
    expect(state.db.interactions.at(-1).content.text).toBe('accepted');
  });
  it('returns detached voice profiles and makes storage identity immutable during edits', () => {
    state.db.voiceProfiles = { other: [{ voiceId: 'other-voice' }] };
    const input = { voiceId: 'voice', settings: { rate: 1 } };
    const stored = addScopedVoiceProfile(scope, input);
    input.settings.rate = 2; stored.settings.rate = 3;
    listScopedVoiceProfiles(scope)[0].settings.rate = 4;
    expect(listScopedVoiceProfiles(scope)[0].settings.rate).toBe(1);
    const next = updateScopedVoiceProfile(scope, 'voice', { voiceId: 'hijack', domain: 'work', orgId: 'other', createdBy: 'other', name: 'renamed' });
    expect(next).toMatchObject({ voiceId: 'voice', domain: 'personal', orgId: '', createdBy: 'owner', name: 'renamed' });
    expect(state.db.voiceProfiles.other).toEqual([{ voiceId: 'other-voice' }]);
  });
  it('rejects malformed voice storage scopes before writing any profile', () => {
    for (const invalid of [{ ...scope, userId: '' }, { ...scope, orgId: 'stale' }, { ...scope, domain: 'work' as const }]) {
      expect(() => addScopedVoiceProfile(invalid, { voiceId: 'voice' })).toThrow('Invalid voice profile scope');
    }
    expect(state.db).toEqual({});
  });
  it.each(['add', 'update', 'remove'])('preserves voice data when %s is refused', operation => {
    addScopedVoiceProfile(scope, { voiceId: 'voice', name: 'before' });
    const before = structuredClone(state.db); state.reject = true;
    expect(() => operation === 'add' ? addScopedVoiceProfile(scope, { voiceId: 'new' })
      : operation === 'update' ? updateScopedVoiceProfile(scope, 'voice', { name: 'after' }) : removeScopedVoiceProfile(scope, 'voice')).toThrow('refused');
    expect(state.db).toEqual(before);
  });
  it('treats anonymous usage as a literal owner and does not share anonymous rows with signed-in users', async () => {
    state.db.tokenUsage = ['owner', 'other', 'anonymous'].map((userId, index) => ({ userId, ...usage, id: String(index), interactionId: userId, timestamp: '2026-01-01' }));
    expect(listTokenUsageRows('owner').map(row => row.userId)).toEqual(['owner']);
    expect(listTokenUsageRows('anonymous').map(row => row.userId)).toEqual(['anonymous']);
    expect(listTokenUsageRows('')).toEqual([]);
    let definition: any; registerUsageTools({ register: (tool: any) => { definition = tool; } } as any);
    for (const userId of ['owner', undefined]) {
      const result = JSON.parse(await definition.handler({ range: 'all', includeRecords: true }, { userId }));
      expect(result.recordCount).toBe(1);
      expect(result.recentRecords[0].interactionId).toBe(userId || 'anonymous');
    }
    state.reject = true; const before = structuredClone(state.db);
    expect(() => recordTokenUsage('owner', 'relay', 'model', usage, 'request')).toThrow('refused');
    expect(state.db).toEqual(before);
  });
  it('does not stage a model receipt before a rejected write and deeply isolates nested attempt evidence', () => {
    const receipt: any = { userId: 'owner', attempts: [{ provider: 'relay', model: 'm', status: 'succeeded' }], completedAt: '2026-01-01', startedAt: '2026-01-01', durationMs: 1 };
    state.db.modelRoutingReceipts = [{ ...receipt, id: 'before', attempts: [{ nested: { value: 1 } }] }];
    (listModelRoutingReceipts('owner')[0].attempts[0] as any).nested.value = 2;
    expect(state.db.modelRoutingReceipts[0].attempts[0].nested.value).toBe(1);
    const before = structuredClone(state.db); state.reject = true;
    expect(() => persistModelRoutingReceipt(receipt)).toThrow('refused');
    expect(state.db).toEqual(before);
  });
  it('does not authorize a normalized legacy avatar status and revokes changed source generations', () => {
    state.db.memoryAvatars = [{ id: 'avatar', userId: 'owner', status: 'unexpected', payload: { sourceGeneration: 1 } }];
    expect(captureMemoryAvatarAuthorization('owner', 'avatar').isCurrent()).toBe(false);
    state.db.memoryAvatars[0].status = 'active';
    const guard = captureMemoryAvatarAuthorization('owner', 'avatar');
    expect(guard.isCurrent()).toBe(true);
    state.db.memoryAvatars[0].payload.sourceGeneration = 2;
    expect(guard.isCurrent()).toBe(false);
  });
});
