import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeSelectedVoiceId,
  prepareVoiceSwitch,
  type VoiceStartPayload,
} from '../src/hooks/useVoiceCall';
import {
  applyVoiceSwitchRequest,
  chooseVoiceForProvider,
  type VoiceSwitchSession,
} from '../server/socket/voice';

function startPayload(voiceId = 'voice-a'): VoiceStartPayload {
  return {
    voiceId,
    personalityId: 'lumi',
    agentId: 'lumi',
    transcriptionOnly: false,
    domain: 'personal',
    sessionId: 'session-current',
    audioInputKind: 'physical_microphone',
    captureSessionId: 'session-current',
  };
}

function activeSession(overrides: Partial<VoiceSwitchSession> = {}): VoiceSwitchSession {
  return {
    isActive: true,
    sessionId: 'session-current',
    userId: 'user-a',
    domain: 'personal',
    orgId: '',
    currentVoiceId: 'voice-a',
    ...overrides,
  };
}

describe('live voice selection', () => {
  it('updates both the live switch event and reconnect payload to the new voice', () => {
    const transition = prepareVoiceSwitch(startPayload(), ' voice-b ');

    expect(transition).toEqual({
      nextPayload: expect.objectContaining({
        voiceId: 'voice-b',
        sessionId: 'session-current',
        audioInputKind: 'physical_microphone',
        captureSessionId: 'session-current',
      }),
      event: { voiceId: 'voice-b', sessionId: 'session-current' },
    });
    expect(prepareVoiceSwitch(transition!.nextPayload, 'voice-b')?.event).toBeNull();
    expect(prepareVoiceSwitch(null, 'voice-b')).toBeNull();
  });

  it('rejects malformed client voice identifiers before emitting a switch', () => {
    expect(normalizeSelectedVoiceId('')).toBeUndefined();
    expect(normalizeSelectedVoiceId('bad\u0000voice')).toBeUndefined();
    expect(normalizeSelectedVoiceId('x'.repeat(257))).toBeUndefined();
    expect(prepareVoiceSwitch(startPayload(), 'bad\nvoice')).toBeNull();
  });

  it('atomically changes the active server session after session and scope validation', () => {
    const session = activeSession();
    const canAccess = vi.fn(() => true);

    const resolution = applyVoiceSwitchRequest(session, {
      voiceId: 'voice-b',
      sessionId: 'session-current',
    }, canAccess);

    expect(resolution).toEqual({
      accepted: true,
      voiceId: 'voice-b',
      previousVoiceId: 'voice-a',
      sessionId: 'session-current',
    });
    expect(session.currentVoiceId).toBe('voice-b');
    expect(canAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', domain: 'personal', orgId: '' }),
      'voice-b',
    );
  });

  it.each([
    ['inactive_session', activeSession({ isActive: false }), { voiceId: 'voice-b', sessionId: 'session-current' }],
    ['session_mismatch', activeSession(), { voiceId: 'voice-b', sessionId: 'session-stale' }],
    ['session_mismatch', activeSession(), { voiceId: 'voice-b' }],
    ['invalid_voice_id', activeSession(), { voiceId: 'bad\u0000voice', sessionId: 'session-current' }],
  ])('keeps the old voice when rejecting %s', (reason, session, request) => {
    const resolution = applyVoiceSwitchRequest(session, request, () => true);

    expect(resolution).toMatchObject({ accepted: false, reason, currentVoiceId: 'voice-a' });
    expect(session.currentVoiceId).toBe('voice-a');
  });

  it('rejects a voice profile from another Lumi domain without mutating the session', () => {
    const session = activeSession({ domain: 'work', orgId: 'org-a' });
    const resolution = applyVoiceSwitchRequest(
      session,
      { voiceId: 'personal-clone', sessionId: 'session-current' },
      () => false,
    );

    expect(resolution).toMatchObject({
      accepted: false,
      reason: 'voice_profile_scope_mismatch',
      requestedVoiceId: 'personal-clone',
      currentVoiceId: 'voice-a',
    });
    expect(session.currentVoiceId).toBe('voice-a');
  });

  it('rejects a syntactically valid voice that is absent from the active provider catalogue', () => {
    const session = activeSession();
    const resolution = applyVoiceSwitchRequest(
      session,
      { voiceId: 'unknown-voice', sessionId: 'session-current' },
      () => true,
      () => false,
    );

    expect(resolution).toMatchObject({
      accepted: false,
      reason: 'voice_not_available',
      requestedVoiceId: 'unknown-voice',
      currentVoiceId: 'voice-a',
    });
    expect(session.currentVoiceId).toBe('voice-a');
  });

  it('reconciles a stale voice from another provider before realtime synthesis', () => {
    expect(chooseVoiceForProvider(
      'zh_female_vv_uranus_bigtts',
      'relay',
      [],
      [{ voiceId: 'longxiaochun_v3' }],
    )).toEqual({
      voiceId: 'longxiaochun_v3',
      requestedVoiceId: 'zh_female_vv_uranus_bigtts',
      replaced: true,
    });
  });

  it('preserves a voice that belongs to the active realtime provider', () => {
    expect(chooseVoiceForProvider(
      'longxiaochun_v3',
      'relay',
      [],
      [{ voiceId: 'longxiaochun_v3' }, { voiceId: 'longwan_v3' }],
    )).toEqual({
      voiceId: 'longxiaochun_v3',
      requestedVoiceId: 'longxiaochun_v3',
      replaced: false,
    });
  });

  it('prefers a ready scoped voice from the active provider over an incompatible selection', () => {
    expect(chooseVoiceForProvider(
      'alloy',
      'relay',
      [{ voiceId: 'my-relay-clone', provider: 'relay', status: 'ready' }],
      [{ voiceId: 'longxiaochun_v3' }],
    )).toEqual({
      voiceId: 'my-relay-clone',
      requestedVoiceId: 'alloy',
      replaced: true,
    });
  });

  it('wires one shared UI state to the live switch protocol and acknowledgements', () => {
    const root = process.cwd();
    const context = fs.readFileSync(path.join(root, 'src/contexts/AppContext.tsx'), 'utf8');
    const chat = fs.readFileSync(path.join(root, 'src/components/AgentChatPage.tsx'), 'utf8');
    const desktop = fs.readFileSync(path.join(root, 'src/components/DesktopUI.tsx'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'src/hooks/useVoiceCall.ts'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');

    expect(context).toContain('const setSelectedVoiceId = useCallback(');
    expect(chat).not.toContain('const [selectedVoiceId, setSelectedVoiceId] = useState');
    expect(chat).toContain('selectedVoiceId,\n    setSelectedVoiceId,');
    expect(chat).toContain('setSelectedVoiceId(v.voiceId, v.provider)');
    expect(desktop).toContain('switchVoice(selectedVoiceId)');
    expect(client).toContain("socketRef.current.emit('audio:switch-voice', transition.event)");
    expect(client).toContain("socket.on('audio:voice_changed', onAudioVoiceChanged)");
    expect(client).toContain("socket.on('audio:voice_unavailable', onAudioVoiceUnavailable)");
    expect(server).toContain("socket.on('audio:switch-voice'");
    expect(server).toContain("socket.emit('audio:voice_changed'");
    expect(server).toContain('voiceSwitchGeneration');
  });
});
