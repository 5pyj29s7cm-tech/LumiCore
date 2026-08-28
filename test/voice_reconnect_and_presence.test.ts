import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPresenceHeartbeat } from '../src/hooks/usePresence';
import { shouldAcceptVoiceStatus, waitForVoiceSocket } from '../src/hooks/useVoiceCall';
import {
  addEchoText,
  isEchoedImmediateVoiceControl,
  isEchoText,
  isPureInterruptCommand,
  isVoiceCallEndCommand,
  isVoiceprintUtteranceAccepted,
} from '../server/socket/voice';

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
  it('ignores a stale turn status instead of clearing the current watchdog', () => {
    expect(shouldAcceptVoiceStatus({ status: 'listening', requestId: 'old' }, 'current')).toBe(false);
    expect(shouldAcceptVoiceStatus({ status: 'listening' }, 'current')).toBe(false);
    expect(shouldAcceptVoiceStatus({ status: 'speaking', requestId: 'current' }, 'current')).toBe(true);
    expect(shouldAcceptVoiceStatus({ status: 'thinking', requestId: 'next' }, 'current')).toBe(true);
  });

  it('durably delivers finalized text before queueing speech playback', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const terminalBoundarySource = readFileSync(path.join(root, 'server/socket/chat_terminal_boundary.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const terminalBoundary = server.indexOf('const committed = await commitChatTerminalBoundary<T | undefined>({');
    const publishCommitted = server.indexOf('publishCommitted: terminalState => {', terminalBoundary);
    const finalizedText = server.indexOf("publishRecordedAgent('agent:response', terminalPayload)", terminalBoundary);
    const speechQueue = server.indexOf('queueFinalizedSpeech(input.speechText!)', terminalBoundary);
    const publishUnknown = server.indexOf('publishUnknown: () => {', publishCommitted);

    const persistAssistant = terminalBoundarySource.indexOf('input.persistAssistantMessage();');
    const durableFlush = terminalBoundarySource.indexOf('await input.flush();', persistAssistant);
    const terminalReceipt = terminalBoundarySource.indexOf(
      'await input.persistTerminalReceipt(terminalState)',
      durableFlush,
    );
    const terminalPublish = terminalBoundarySource.indexOf(
      'input.publishCommitted(terminalState);',
      terminalReceipt,
    );

    expect(terminalBoundary).toBeGreaterThan(0);
    expect(publishCommitted).toBeGreaterThan(terminalBoundary);
    expect(finalizedText).toBeGreaterThan(publishCommitted);
    expect(speechQueue).toBeGreaterThan(finalizedText);
    expect(speechQueue).toBeLessThan(publishUnknown);
    expect(persistAssistant).toBeGreaterThan(0);
    expect(durableFlush).toBeGreaterThan(persistAssistant);
    expect(terminalReceipt).toBeGreaterThan(durableFlush);
    expect(terminalPublish).toBeGreaterThan(terminalReceipt);
    expect(client).not.toContain("if (data.finalized === true) activeVoiceRequestIdRef.current = null");
  });

  it('never substitutes the configured Lumi voice with browser speech synthesis', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');

    expect(server).not.toContain('audio:tts_fallback');
    expect(server).not.toContain('playBrowserSpeechFallback');
    expect(client).not.toContain('audio:tts_fallback');
    expect(client).not.toContain('SpeechSynthesisUtterance');
    expect(client).not.toContain('window.speechSynthesis');
  });

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
    expect(source).toContain('void closeAudioContext(context)');
    expect(source).not.toMatch(/proactiveContext\.current\.close\(\)/);
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
    expect(server).toContain('requestId: workRequestId');
    expect(server).toContain('workContinues: true, requestId: workRequestId');
    expect(server).toContain('cancelActiveVoiceTurn(session, false, true)');
    expect(server).toContain('interruptVoiceSpeech(session)');
    expect(client).toContain("socket.on('audio:sidecar_response'");
    expect(client).toContain('workRequestId !== activeVoiceRequestIdRef.current');
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
    expect(isVoiceCallEndCommand('关闭语音通话')).toBe(true);
    expect(isVoiceCallEndCommand('停止任务')).toBe(false);
    expect(priorityStop).toBeGreaterThan(0);
    expect(voiceprintGate).toBeGreaterThan(priorityStop);
    expect(server).toContain('await waitForVoiceprintGate(session)');
    expect(client).toContain("if (isTtsPlaying.current) {");
    expect(client).toContain("currentSocket.volatile.emit('audio:chunk', chunk)");
    expect(client).not.toContain('ttsPreRollChunks');
    expect(client).toContain("socket.on('audio:end-call-request'");
    const voiceprint = readFileSync(path.join(root, 'src/hooks/useVoiceprint.ts'), 'utf8');
    expect(voiceprint).toContain('createScriptProcessor(2048, 1, 1)');
  });

  it('rejects echoed priority controls only while scoped TTS is active', () => {
    const scope = `voice-echo-control-${Date.now()}`;
    addEchoText('stop', scope);

    expect(isEchoedImmediateVoiceControl('stop', true, scope)).toBe(true);
    expect(isEchoedImmediateVoiceControl('stop', false, scope)).toBe(false);
    expect(isEchoedImmediateVoiceControl('stop', true, `${scope}-other`)).toBe(false);
    expect(isEchoedImmediateVoiceControl('continue', true, scope)).toBe(false);

    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    expect(server).toContain('session.isSpeaking || Date.now() < session.ttsPlaybackUntil');
    expect(server).toContain("socket.on('audio:playback_started'");
    expect(client).toContain('durationMs: Math.max(1, Math.round(decoded.duration * 1_000))');
  });

  it('does not stop TTS from a raw local energy spike before semantic admission', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const client = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const semanticLane = client.indexOf('Keep realtime STT active while Lumi speaks');
    const branchStart = client.indexOf('if (isTtsPlaying.current) {', semanticLane);
    const branchEnd = client.indexOf('const micAllowed =', branchStart);
    const ttsBranch = client.slice(branchStart, branchEnd);

    expect(ttsBranch).toContain("currentSocket.emit('audio:interrupt-candidate'");
    expect(ttsBranch).not.toContain("currentSocket.emit('audio:interrupt')");
    expect(ttsBranch).not.toContain('stopAllPlayback()');
    expect(server).toContain("socket.on('audio:interrupt-candidate'");
    expect(server).toContain('source=semantic_transcript');
  });

  it('uses a bounded voice history and avoids the serial advisory classifier', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    expect(source).toContain('formatCompactClientSelfPrompt(session.userId, voiceScope)');
    expect(source).toContain('getMessagesByTokenBudget(conversationTurn.conversation.id, 6_000, 6, requestId)');
    expect(source).toContain('processInput(routedUserText, cognitiveCtx, undefined, toolContext)');
    expect(source).not.toContain('const llmClassifier = async');
    expect(source).toContain('Prompt budget request=${requestId}');
  });

  it('authorizes only a strong decision from the current utterance', () => {
    const base = {
      required: true,
      decided: true,
      matched: true,
      confidence: 0.9,
      quality: 0.8,
      frameCount: 6,
      source: 'server-local',
    };
    expect(isVoiceprintUtteranceAccepted(base)).toBe(true);
    expect(isVoiceprintUtteranceAccepted({ ...base, decided: false })).toBe(false);
    expect(isVoiceprintUtteranceAccepted({ ...base, confidence: 0.81 })).toBe(false);
    expect(isVoiceprintUtteranceAccepted({ ...base, quality: 0.54 })).toBe(false);
    expect(isVoiceprintUtteranceAccepted({ ...base, frameCount: 2 })).toBe(false);
    expect(isVoiceprintUtteranceAccepted({ ...base, source: 'speechbrain', confidence: 0.67, quality: 0.2 })).toBe(true);
    expect(isVoiceprintUtteranceAccepted({ ...base, source: 'speechbrain', confidence: 0.65 })).toBe(false);
    expect(isVoiceprintUtteranceAccepted({ ...base, required: false })).toBe(true);
  });

  it('uses the STT PCM stream and isolates voiceprint decisions by utterance', () => {
    const root = process.cwd();
    const server = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const call = readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const voiceprint = readFileSync(path.join(root, 'src/hooks/useVoiceprint.ts'), 'utf8');

    expect(server).not.toContain('voiceprintTrustedUntil');
    expect(server).toContain("socket.emit('voiceprint:utterance_reset'");
    expect(server).toContain('resultEpoch !== session.voiceprintUtteranceEpoch');
    expect(call).toContain("new CustomEvent('lumi:voice-pcm-frame'");
    expect(voiceprint).toContain("activeSocket.on('voiceprint:utterance_reset'");
    expect(voiceprint).toContain('utteranceEpoch,');
  });

  it('keeps meeting transcription multi-speaker while hiding unverified personal interim text', () => {
    const server = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');
    expect(server).toContain('session.transcriptionOnly || !session.voiceprintRequired || isVoiceprintGateOpen(session)');
    expect(server).toContain('voiceAuthorized = session.transcriptionOnly || isVoiceprintGateOpen(session)');
  });

  it('matches recent TTS by sequence without treating every short utterance as echo', () => {
    addEchoText('这是 Lumi 正在播放的一段完整句子。');
    expect(isEchoText('这是Lumi正在播放的一段完整句子')).toBe(true);
    expect(isEchoText('我现在要打开浏览器')).toBe(false);
    expect(isEchoText('嗯')).toBe(false);
  });

  it('binds accepted turns to durable request ownership across chat, voice, and task surfaces', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const task = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');

    expect(chat).toContain('const chatAdmission = await admitAcceptedUserTurnDurably({');
    expect(chat).toContain('() => beginChatExecutionDurably(executionScope, requestId');
    expect(voice).toContain('const voiceAdmission = await admitAcceptedUserTurnDurably({');
    expect(voice).toContain('() => beginChatExecutionDurably(');
    expect(task).toContain('const taskAdmission = await admitAcceptedUserTurnDurably({');
    expect(task).toContain('() => beginChatExecutionDurably(');
  });
});
