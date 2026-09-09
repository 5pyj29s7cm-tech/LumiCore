import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB, flushDBOrThrow, querySQL } from '../db_layer';
import { personalityRegistry } from '../server/personality/registry';
import { addMemory } from '../server/memory/store';
import { synthesizeOwnerProfile, lightweightEvolve, DEFAULT_EVOLUTION_CONFIG } from '../server/personality/evolution';
import {
  beginEvolutionSynthesis,
  buildEvolutionEvidenceCursor,
  getEvolutionSynthesisGuardState,
  recordEvolutionSynthesisFailure,
} from '../server/personality/evolution_synthesis_guard';

beforeAll(async () => {
  await initDatabase();
});

function cursor(id: string, at: string) {
  return buildEvolutionEvidenceCursor([{
    id,
    content: `owner evidence ${id}`,
    confidence: 0.8,
    createdAt: at,
    updatedAt: at,
  }]);
}

describe('personality evolution synthesis cost guard', () => {
  it('persists exponential backoff while retaining newer evidence for the next attempt', () => {
    const scope = { userId: `evolution-backoff-${Date.now()}`, domain: 'personal' as const, orgId: '' };
    const startedAt = Date.parse('2026-08-22T10:00:00.000Z');
    const firstEvidence = cursor('evidence-1', '2026-08-22T09:59:00.000Z');
    const newerEvidence = cursor('evidence-2', '2026-08-22T10:01:00.000Z');

    expect(beginEvolutionSynthesis(scope, firstEvidence, { now: startedAt }).allowed).toBe(true);
    const failed = recordEvolutionSynthesisFailure(
      scope,
      firstEvidence,
      { category: 'timeout', message: 'provider exceeded its deadline' },
      startedAt + 60_000,
    );
    expect(failed.status).toBe('backoff');
    expect(Date.parse(failed.retryAfter) - (startedAt + 60_000)).toBe(15 * 60 * 1000);

    const deferred = beginEvolutionSynthesis(scope, newerEvidence, { now: startedAt + 2 * 60_000 });
    expect(deferred).toMatchObject({ allowed: false, reason: 'backoff' });
    expect(getEvolutionSynthesisGuardState(scope)?.latestObservedEvidence.fingerprint)
      .toBe(newerEvidence.fingerprint);

    const resumed = beginEvolutionSynthesis(scope, newerEvidence, {
      now: Date.parse(failed.retryAfter) + 1,
    });
    expect(resumed.allowed).toBe(true);
    expect(getEvolutionSynthesisGuardState(scope)?.attemptedEvidence.fingerprint)
      .toBe(newerEvidence.fingerprint);
  });

  it('runs one model synthesis per scope and prevents followers from applying the same profile', async () => {
    const userId = `evolution-single-flight-${Date.now()}`;
    for (let index = 0; index < 10; index += 1) {
      addMemory({
        userId,
        type: 'preference',
        content: `Owner evidence ${index}: prefers concrete outcome ${index}.`,
        keywords: ['owner', `evidence-${index}`],
        confidence: 0.8,
        sourceInteractionId: `evolution-single-flight-${index}`,
      }, {
        domain: 'personal',
        source: 'manual',
        perspective: 'owner_trait',
        deduplicate: false,
        generateEmbedding: false,
      });
    }

    let release!: (value: any) => void;
    const create = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const getRelay = () => ({ chat: { completions: { create } } });
    const unavailable = () => null;
    const synthesize = () => synthesizeOwnerProfile(
      userId,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      undefined,
      undefined,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      getRelay,
    );
    const leader = synthesize();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const follower = synthesize();
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    release({
      choices: [{
        message: {
          content: JSON.stringify({
            dominantTone: 'warm',
            frequentExpressions: ['concrete outcome'],
            interestClusters: ['delivery quality'],
            formalityLevel: 0.3,
            emotionalExpressiveness: 0.6,
            communicationPatterns: ['prefers concrete outcomes'],
          }),
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });

    const [leaderResult, followerResult] = await Promise.all([leader, follower]);
    expect(leaderResult?.memoryCount).toBe(10);
    expect(followerResult).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(getEvolutionSynthesisGuardState({ userId, domain: 'personal', orgId: '' })?.completedFingerprint).toBeTruthy();
    expect(await synthesize()).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('applies growth from a full 50-item pool even when the old profile recorded 57 memories', async () => {
    const userId = `bounded-pool-${Date.now()}`;
    for (let i = 0; i < 60; i++) addMemory({ userId, type: 'preference', content: `Owner enduring preference number ${i}`,
      keywords: ['preference', String(i)], confidence: 0.9, sourceInteractionId: `bounded-pool-${i}` },
      { source: 'manual', perspective: 'owner_trait', deduplicate: false, generateEmbedding: false });
    const base = personalityRegistry.getDefault();
    const key = `personality_user_state:lumi:personal:${userId}`;
    const db = readDB(); db.settings.push({ key, value: JSON.stringify({ schemaVersion: 1, personalityVersion: base.version,
      lastEvolvedAt: null, growthState: { version: 1, ownerProfile: { memoryCount: 57 }, ownerInterests: [],
        ownerExpressions: [], communicationPatterns: [], adaptationNotes: [] } }) }); writeDB(db);
    const config = personalityRegistry.getForUser('lumi', userId)!;
    expect(config.growthState?.ownerProfile?.memoryCount).toBe(57);
    const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ dominantTone: 'warm',
      frequentExpressions: ['concise outcomes'], interestClusters: ['nature photography'], formalityLevel: 0.2,
      emotionalExpressiveness: 0.7, communicationPatterns: ['prefers a clear answer first'] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    const no = () => null;
    const step = await lightweightEvolve(config, userId, { ...DEFAULT_EVOLUTION_CONFIG, cooldownMs: 0 },
      no, no, no, no, no, undefined, no, no, no, no, no, no, () => ({ chat: { completions: { create } } }));
    expect(step?.ownerProfile.memoryCount).toBe(50);
    expect(step?.mutations.map(m => m.field)).toEqual(['growthState']);
    const updated = personalityRegistry.applyEvolution('lumi', step!, { userId });
    expect(updated?.coreMotivation).toBe(config.coreMotivation);
    await flushDBOrThrow();
    const saved = JSON.parse((await querySQL<{value: string}>('SELECT value FROM settings WHERE key=?', [key]))[0].value);
    expect(saved.growthState.ownerProfile.memoryCount).toBe(50);
    expect(saved.growthState.ownerInterests).toContain('nature photography');
    expect(create).toHaveBeenCalledTimes(1);
  });

});
