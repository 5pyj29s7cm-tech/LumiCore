import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDB, initDatabase, querySQL } from '../db_layer';
import { addScopedVoiceProfile, listScopedVoiceProfiles, voiceProfileScope } from '../server/tts/profile_store';

describe.sequential('voice profile creation durability', () => {
  beforeAll(async () => { await initDatabase(); });

  it.each([
    { domain: 'personal', orgId: '', createdAt: undefined },
    { domain: 'work', orgId: 'voice-persistence-org', createdAt: null },
  ])('generates a missing timestamp once and preserves it across reopening ($domain)', async ({ domain, orgId, createdAt }) => {
    const scope = voiceProfileScope('voice-persistence-owner', domain, orgId);
    const voiceId = `voice-persistence-${domain}`;
    const before = Date.now();
    const stored = addScopedVoiceProfile(scope, {
      voiceId, name: 'Stored test voice', provider: 'cosyvoice', createdAt,
    });
    expect(Number.isFinite(Date.parse(stored.createdAt))).toBe(true);
    expect(Date.parse(stored.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored.createdAt)).toBeLessThanOrEqual(Date.now());

    await flushDB();
    await closeDatabase();
    await initDatabase();

    expect(listScopedVoiceProfiles(scope)).toContainEqual({
      voiceId, name: 'Stored test voice', provider: 'cosyvoice', createdAt: stored.createdAt,
    });
    expect(await querySQL('SELECT userId, createdAt FROM voice_profiles WHERE voiceId = ?', [voiceId]))
      .toEqual([{ userId: domain === 'work' ? `org:${orgId}` : scope.userId, createdAt: stored.createdAt }]);
  });

  it('preserves an explicitly supplied creation timestamp', async () => {
    const scope = voiceProfileScope('voice-persistence-explicit', 'personal', '');
    const createdAt = '2025-08-01T12:30:00.000Z';
    const stored = addScopedVoiceProfile(scope, {
      voiceId: 'voice-persistence-explicit', name: 'Existing creation date', provider: 'cosyvoice', createdAt,
    });
    expect(stored.createdAt).toBe(createdAt);
    await closeDatabase();
    await initDatabase();
    expect(listScopedVoiceProfiles(scope)[0]).toMatchObject({ voiceId: stored.voiceId, createdAt });
  });
});
