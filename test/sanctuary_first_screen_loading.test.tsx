// @vitest-environment jsdom
import React, { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE, type MemoryAvatar } from '../shared/memory_avatar';

const fixture = vi.hoisted(() => ({ pending: '' as string, wait: null as Promise<void> | null, send: vi.fn(), end: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'synthetic-owner' } }) }));
vi.mock('../src/lib/useT', () => ({ useLocale: () => 'en' }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));
vi.mock('../src/hooks/useAliyunAvatarConfig', () => ({ useAliyunAvatarConfig: () => null }));
vi.mock('../src/hooks/useMemoryAvatarConversation', () => ({ useMemoryAvatarConversation: () => ({ messages: [], busy: false, loading: false, error: '', send: fixture.send,
  refresh: vi.fn(), interrupt: vi.fn(), appendVoiceTranscript: vi.fn(), appendVoiceResponse: vi.fn() }) }));
vi.mock('../src/hooks/useMemoryAvatarCall', () => ({ useMemoryAvatarCall: () => ({ state: 'idle', error: null, errorCode: '', startVoice: vi.fn(), startVideo: vi.fn(), end: fixture.end,
  toggleMute: vi.fn(), toggleCamera: vi.fn(), interrupt: vi.fn(), isMuted: false, isCameraOn: false, cameraStream: null,
  outputLevelRef: { current: 0 }, inputLevelRef: { current: 0 }, elapsedSeconds: 0 }) }));
const avatar: MemoryAvatar = { id: 'synthetic-avatar', name: 'Synthetic person', relationshipType: 'close_friend', revision: 1, status: 'active', narrative: '',
  appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE, style: 'lumi2d' }, voice: {}, memoryCount: 0, isFrozen: true, personalityConfig: {}, evidenceMap: [], seedMemoryIds: [], createdAt: '', updatedAt: '' };
const modules = [
  ['../src/components/MemoryAvatarStage', 'MemoryAvatarStage', 'scene'],
  ['../src/components/MemoryAvatarPortraitStage', 'MemoryAvatarPortraitStage', 'portrait'],
  ['../src/components/MemoryAvatarProfile', 'MemoryAvatarProfile', 'profile'],
  ['../src/components/AvatarLiveWorkbench', 'AvatarLiveWorkbench', 'live'],
] as const;
function content(kind: string) {
  return function SyntheticHeavyComponent() {
    if (fixture.pending === kind) throw fixture.wait;
    return <div data-testid={`${kind}-loaded`}>Loaded synthetic {kind}</div>;
  };
}
let release: () => void;
beforeEach(() => {
  vi.resetModules(); fixture.pending = ''; fixture.wait = new Promise<void>(resolve => { release = resolve; }); fixture.send.mockReset().mockReturnValue(true); fixture.end.mockReset();
  for (const [path, name, kind] of modules) vi.doMock(path, () => ({ [name]: content(kind), default: content(kind) }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Error('No business requests in module boundary test'))));
});
afterEach(async () => { cleanup(); release(); await Promise.resolve(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const [path] of modules) vi.doUnmock(path); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { await act(async () => { await tick(); await tick(); }); };

it('resolves the real Sanctuary module and keeps text interaction while all heavy module factories are still pending', async () => {
  const loaded: string[] = [];
  for (const [path, name, kind] of modules) vi.doMock(path, async () => {
    loaded.push(kind); await fixture.wait; return { [name]: content(kind), default: content(kind) };
  });
  let resolved = false;
  const importing = import('../src/components/Sanctuary').then(module => { resolved = true; return module; });
  try {
    // Allow module evaluation; this is not an elapsed-time performance assertion.
    await vi.waitFor(() => expect(resolved, 'Sanctuary must not await unselected configuration/live or scene modules').toBe(true), { timeout: 2000, interval: 10 });
    expect(loaded).toEqual([]);
    const { Sanctuary } = await importing;
    render(<Suspense fallback={<p data-testid="whole-surface-loading">Whole surface pending</p>}><Sanctuary agent={avatar} lang="en" isOpen onClose={vi.fn()} /></Suspense>);
    await settle();
    expect(screen.queryByTestId('whole-surface-loading')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic draft while scene loads' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(fixture.send).toHaveBeenCalledWith('Synthetic draft while scene loads');
    await vi.waitFor(() => expect(loaded).toEqual(['scene']));
  } finally { release(); await importing; }
});

it.each(['scene', 'portrait', 'profile', 'live'] as const)('keeps a usable return path when the %s module suspends', async kind => {
  const { Sanctuary } = await import('../src/components/Sanctuary');
  const close = vi.fn();
  if (kind === 'scene' || kind === 'portrait') fixture.pending = kind;
  const person = kind === 'portrait' ? { ...avatar, appearance: { ...avatar.appearance, style: 'human3d' as const }, presentation: { mode: 'portrait' as const, mediaId: 'synthetic-media' } } : avatar;
  render(<Suspense fallback={<p data-testid="whole-surface-loading">Whole surface pending</p>}><Sanctuary agent={person} lang="en" isOpen onClose={close} /></Suspense>);
  await settle();
  if (kind === 'profile' || kind === 'live') {
    fixture.pending = kind;
    fireEvent.click(screen.getByRole('button', { name: kind === 'profile' ? 'Person details' : 'Avatar live preview' }));
    await settle();
  }
  expect(screen.queryByTestId('whole-surface-loading')).toBeNull();
  if (kind === 'scene' || kind === 'portrait') {
    const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'Preserved text' } });
    expect((input as HTMLTextAreaElement).value).toBe('Preserved text');
  }
  const returns = screen.getAllByRole('button', { name: /back|return|leave/i });
  fireEvent.click(returns[returns.length - 1]); await settle();
  if (kind === 'profile' || kind === 'live') expect(screen.getByRole('textbox')).toBeTruthy();
  else expect(close).toHaveBeenCalledTimes(1);
  expect(fixture.send).not.toHaveBeenCalled();
});
