import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPresenceHeartbeat } from '../src/hooks/usePresence';
import { waitForVoiceSocket } from '../src/hooks/useVoiceCall';
import { addEchoText, isEchoText, isPureInterruptCommand } from '../server/socket/voice';

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

  it('keeps realtime microphone levels outside the DesktopUI React state', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/hooks/useVoiceCall.ts'), 'utf8');
    expect(source).toContain('rawAudioLevelRef.current = frameRms');
    expect(source).toContain("new CustomEvent('lumi:voice-audio-level'");
    expect(source).not.toContain('setAudioLevel(');
    expect(source).not.toContain('setElapsedSeconds(');
    expect(source).not.toContain('requestAnimationFrame(updateAudioLevel)');
    expect(source).toContain('rms: rawAudioLevelRef.current');
    expect(source).toContain('audioLevel: 0');
  });

  it('releases streaming TTS nodes and contexts when a call ends', () => {
    const root = process.cwd();
    const source = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const button = readFileSync(path.join(root, 'src/components/VoiceCallButton.tsx'), 'utf8');
    const subtitle = readFileSync(path.join(root, 'src/components/VoiceSubtitle.tsx'), 'utf8');

    expect(source).toContain('releaseAudioBufferSource(source)');
    expect(source).toContain('disposePlaybackContexts()');
    expect(source).toContain('void context.close().catch');
    expect(source).not.toContain('audioQueueContext');
    expect(source).not.toContain('pendingAudio');
    expect(button).not.toContain('useLiveVoiceAudioLevel');
    expect(subtitle).not.toContain('useLiveVoiceAudioLevel');
  });

  it('keeps the active voice work request alive while handling a conversational aside', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');

    expect(server).toContain("socket.emit('audio:sidecar_response'");
    expect(server).toContain('workContinues: true, requestId: workRequestId');
    expect(server).toContain('interruptVoiceSpeech(session)');
    expect(client).toContain("socket.on('audio:sidecar_response'");
    expect(client).toContain('if (data?.workContinues)');
  });

  it('keeps a semantic stop lane open during TTS before voiceprint gating', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const priorityStop = server.indexOf('isPureInterruptCommand(immediateText)');
    const voiceprintGate = server.indexOf('if (!session.transcriptionOnly && !isVoiceprintGateOpen(session))', priorityStop);

    expect(isPureInterruptCommand('闭嘴')).toBe(true);
    expect(isPureInterruptCommand('先别说了')).toBe(true);
    expect(isPureInterruptCommand('闭嘴，然后继续画图')).toBe(false);
    expect(priorityStop).toBeGreaterThan(0);
    expect(voiceprintGate).toBeGreaterThan(priorityStop);
    expect(server).toContain('await waitForVoiceprintGate(session)');
    expect(client).toContain("if (isTtsPlaying.current) {");
    expect(client).toContain("currentSocket.volatile.emit('audio:chunk', chunk)");
    expect(client).not.toContain('ttsPreRollChunks');
    const voiceprint = readFileSync(path.join(root, 'src/hooks/useVoiceprint.ts'), 'utf8');
    expect(voiceprint).toContain('createScriptProcessor(2048, 1, 1)');
  });

  it('matches recent TTS by sequence without treating every short utterance as echo', () => {
    addEchoText('这是 Lumi 正在播放的一段完整句子。');
    expect(isEchoText('这是Lumi正在播放的一段完整句子')).toBe(true);
    expect(isEchoText('我现在要打开浏览器')).toBe(false);
    expect(isEchoText('嗯')).toBe(false);
  });

  it('advances the same latest-turn generation from chat, voice, and task surfaces', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const task = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');

    expect(chat).toContain('markLatestUserTurn(executionScope, requestId)');
    expect(voice).toContain('markLatestUserTurn({');
    expect(voice).toContain('domain: voiceScope.domain');
    expect(task).toContain('markLatestUserTurn(executionScope, requestId)');
  });
});
