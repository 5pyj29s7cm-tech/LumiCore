import { describe, expect, it } from 'vitest';
import { updatePresence } from '../server/biometrics/presence';

describe('owner presence signals', () => {
  it('does not treat an unmatched face as the owner', () => {
    const userId = `presence-test-${Date.now()}`;
    const stranger = updatePresence(userId, {
      facePresent: true,
      faceMatched: false,
      faceConfidence: 0.92,
      voiceprintMatched: false,
      voiceprintConfidence: 0,
    });

    expect(stranger.facePresent).toBe(true);
    expect(stranger.faceMatched).toBe(false);
    expect(stranger.lastFaceSeenAt).toBe(0);
    expect(stranger.isAway).toBe(true);

    const owner = updatePresence(userId, {
      facePresent: true,
      faceMatched: true,
      faceConfidence: 0.88,
      voiceprintMatched: false,
      voiceprintConfidence: 0,
    });

    expect(owner.faceMatched).toBe(true);
    expect(owner.lastFaceSeenAt).toBeGreaterThan(0);
    expect(owner.isAway).toBe(false);
  });
});
