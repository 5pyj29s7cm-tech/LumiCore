// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { EventEmitter } from 'node:events';
import { Encoder } from 'socket.io-parser';
import { extractSourceExpression } from './source_expression';

vi.mock('../src/components/LumiCoreOrb', () => ({ LumiCoreOrb: () => null }));
vi.mock('../src/components/SpriteAnimator', () => ({ PetAvatar: () => null }));
vi.mock('../src/pets/defaults', () => ({ getDefaultPets: () => [] }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({}) }));
vi.mock('../src/lib/voiceDevicePreferences', () => ({
  VOICE_DEVICE_PREFERENCE_CHANGED: 'fixture-voice-devices',
  applyPreferredVoiceOutputDevice: async () => {},
  requestPreferredMicrophoneStream: async () => {
    const track = { enabled: true, readyState: 'live', stop: vi.fn() };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
}));
import { useVoiceCall } from '../src/hooks/useVoiceCall';
import { LumiCoreAvatar } from '../src/components/LumiCoreAvatar';
import { DesktopWidgetPanel } from '../src/components/desktop/widget';
import { VoiceCallButton } from '../src/components/VoiceCallButton';

class SerializedClient extends EventEmitter {
  connected = true; volatile = this; outputs: Array<[string, any]> = [];
  emit(event: string, data?: any): boolean {
    new Encoder().encode({ type: 2, nsp: '/', data: [event, data] });
    this.outputs.push([event, data]); return true;
  }
}
class AudioContextFixture {
  state = 'running'; destination = {};
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
beforeEach(() => { vi.stubGlobal('AudioContext', AudioContextFixture); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('voice start UI and socket boundary', () => {
  it.each(['avatar', 'widget', 'chat'] as const)('starts from the real %s button without serializing the click event', async surface => {
    const client = new SerializedClient();
    const hook = renderHook(() => useVoiceCall({ socket: client }));
    let pending: Promise<void> | undefined;
    const startCall = vi.fn((...args: Parameters<typeof hook.result.current.startCall>) => {
      pending = hook.result.current.startCall(...args); return pending;
    });
    const start = extractSourceExpression('src/components/desktop/state/use_desktop_capture_and_identity.tsx', 'startStandardVoiceCall', {
      startCall, selectedVoiceId: 'selected-voice', getVoiceScopeOptions: () => ({ domain: 'personal' }),
    });
    if (surface === 'avatar') render(<LumiCoreAvatar t={{}} lang="en" onStartCall={start} />);
    else if (surface === 'widget') render(<DesktopWidgetPanel t={{}} lang="en" selectedPet={null} equippedAccessories={[]} petReaction={null} callState="idle" audioLevel={0} transcript="" operationMode="assistant" workDomain="personal" wakeEnabled={false} wakeListening={false} onStartVoice={start} onEndVoice={vi.fn()} onExpand={vi.fn()} onHide={vi.fn()} onOpenPersonalization={vi.fn()} />);
    else render(<VoiceCallButton callState="idle" audioLevel={0} onStart={start} onEnd={vi.fn()} />);
    const button = surface === 'widget' ? screen.getByRole('button', { name: 'Voice' }) : screen.getByRole('button');
    await act(async () => { fireEvent.click(button); await pending; });
    expect(hook.result.current.error).toBeNull();
    expect(startCall).toHaveBeenCalledExactlyOnceWith('selected-voice', 'lumi', 'lumi', { domain: 'personal', conversationId: undefined });
    expect(client.outputs.filter(([event]) => event === 'audio:start')).toHaveLength(1);
    expect(client.outputs.find(([event]) => event === 'audio:start')![1].conversationId).toBeUndefined();
    hook.unmount();
  });

  it.each([false, true])('serializes only a string conversation identity (invalid=%s)', async invalid => {
    const client = new SerializedClient();
    const hook = renderHook(() => useVoiceCall({ socket: client }));
    const circular: any = {}; circular.currentTarget = circular;
    await act(async () => { await hook.result.current.startCall(undefined, 'lumi', 'lumi', { conversationId: invalid ? circular : 'selected-conversation' }); });
    expect(hook.result.current.error).toBeNull();
    const payload = client.outputs.find(([event]) => event === 'audio:start')![1];
    expect(payload.conversationId).toBe(invalid ? undefined : 'selected-conversation');
    expect(() => new Encoder().encode({ type: 2, nsp: '/', data: ['audio:start', payload] })).not.toThrow();
    hook.unmount();
  });
});
