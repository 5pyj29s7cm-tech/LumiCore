import { describe, expect, it } from 'vitest';
import { buildPresenceHeartbeat } from '../src/hooks/usePresence';
import { waitForVoiceSocket } from '../src/hooks/useVoiceCall';

class FakeSocket {
  connected = false;
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(event: string, listener: (...args: any[]) => void) {
    const set = this.listeners.get(event) || new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  off(event: string, listener: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  connect() {}
  emitEvent(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

describe('voice reconnect and perception continuity', () => {
  it('waits for the socket before starting microphone streaming', async () => {
    const socket = new FakeSocket();
    const pending = waitForVoiceSocket(socket, 1000);
    socket.connected = true;
    socket.emitEvent('connect');
    await expect(pending).resolves.toBeUndefined();
  });

  it('builds heartbeats from the latest face and voice signals', () => {
    expect(buildPresenceHeartbeat({
      facePresent: true,
      ownerPresent: true,
      confidence: 0.91,
      bestMatch: null,
      allMatches: [],
      threshold: 'high',
      faceCount: 2,
    }, {
      isOwnerSpeaking: false,
      confidence: 0.2,
      speakerLabel: null,
      source: 'local',
    } as any)).toEqual({
      facePresent: true,
      faceMatched: true,
      faceConfidence: 0.91,
      voiceprintMatched: false,
      voiceprintConfidence: 0.2,
    });
  });
});
