import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('keeps one wake owner per user and backs off provider retries', () => {
    const root = process.cwd();
    const wakeSocket = readFileSync(path.join(root, 'server/socket/wake.ts'), 'utf8');
    const wakeHook = readFileSync(path.join(root, 'src/hooks/useWakeWord.ts'), 'utf8');

    expect(wakeSocket).toContain('wakeOwnerByUser');
    expect(wakeSocket).toContain('taking ownership from');
    expect(wakeHook).toContain('retryScheduledRef');
    expect(wakeHook).toContain('Math.min(30_000');
    expect(wakeHook).toContain('scheduleRetry()');
    expect(wakeHook).toContain('canSendWakeAudioRef.current');
    expect(wakeHook).toContain('canAcceptWakeRef.current');
  });

  it('does not rerender the desktop tree on every analyser animation frame', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/hooks/useVoiceCall.ts'), 'utf8');
    expect(source).toContain('rawAudioLevelRef.current = rms');
    expect(source).toContain('lastAudioLevelPublishAtRef.current >= 250');
    expect(source).not.toContain('const rms = Math.sqrt(sum / dataArray.length);\n    setAudioLevel(rms);');
    expect(source).toContain('rms: rawAudioLevelRef.current');
    expect(source).toContain('}, [socket, callState]);');
  });
});
