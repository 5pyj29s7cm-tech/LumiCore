// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE, type MemoryAvatar } from '../shared/memory_avatar';
const fixture = vi.hoisted(() => ({ uid: 'owner-a', state: 'idle', mounts: [] as string[], released: [] as string[], callOptions: null as any,
  end: vi.fn(), startVoice: vi.fn(), startVideo: vi.fn(), send: vi.fn(), refresh: vi.fn(), interrupt: vi.fn(), transcript: vi.fn(), response: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: fixture.uid ? { uid: fixture.uid } : null }) }));
vi.mock('../src/lib/useT', () => ({ useLocale: () => 'en' }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => ({ connected: true }) }));
vi.mock('../src/hooks/useMemoryAvatarConversation', () => ({ useMemoryAvatarConversation: () => ({ messages: [], busy: false, loading: false, error: '', send: fixture.send,
  refresh: fixture.refresh, interrupt: fixture.interrupt, appendVoiceTranscript: fixture.transcript, appendVoiceResponse: fixture.response }) }));
vi.mock('../src/hooks/useMemoryAvatarCall', () => ({ useMemoryAvatarCall: (options: any) => {
  fixture.callOptions = options;
  useEffect(() => { const key = `${options.ownerId}:${options.avatarId}`; fixture.mounts.push(key); return () => { fixture.released.push(key); fixture.end(); }; }, [options.ownerId, options.avatarId]);
  return { state: fixture.state, error: null, errorCode: '', startVoice: fixture.startVoice, startVideo: fixture.startVideo, end: fixture.end,
    toggleMute: vi.fn(), toggleCamera: vi.fn(), interrupt: fixture.interrupt, isMuted: false, isCameraOn: false, cameraStream: null,
    outputLevelRef: { current: 0 }, inputLevelRef: { current: 0 }, elapsedSeconds: 0 };
} }));
vi.mock('../src/components/MemoryAvatarStage', () => ({ MemoryAvatarStage: (props: any) => <div data-testid="stage" data-skin={props.appearance.skinColor}>{props.name}</div> }));
vi.mock('../src/components/MemoryAvatarProfile', () => ({ MemoryAvatarProfile: (props: any) => <div>
  <button onClick={() => props.onPreviewAppearance({ ...props.avatar.appearance, skinColor: '#abcdef' })}>Preview fixture</button>
  <button onClick={async () => { await props.onBeforeMutation(); props.onUpdated({ ...props.avatar, name: 'Updated person', revision: props.avatar.revision + 1 }); }}>Save fixture</button>
  <button onClick={() => props.onArchived(props.avatar.id)}>Archive fixture</button>
</div> }));
import { Sanctuary } from '../src/components/Sanctuary';
const avatar: MemoryAvatar = { id: 'memory_avatar_a', name: 'Synthetic person', relationshipType: 'close_friend', revision: 1, status: 'active', narrative: '',
  appearance: { ...DEFAULT_MEMORY_AVATAR_APPEARANCE }, voice: {}, memoryCount: 2, isFrozen: true, personalityConfig: {}, evidenceMap: [], seedMemoryIds: [], createdAt: '', updatedAt: '' };
beforeEach(() => {
  fixture.uid = 'owner-a'; fixture.state = 'idle'; fixture.mounts = []; fixture.released = []; fixture.callOptions = null;
  for (const value of Object.values(fixture)) if (vi.isMockFunction(value)) value.mockReset();
  fixture.send.mockReturnValue(true); fixture.startVoice.mockResolvedValue(undefined); fixture.startVideo.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('does not mount devices while closed or unauthenticated, and releases each identity on close and owner switch', () => {
  const props = { agent: avatar, lang: 'en' as const, onClose: vi.fn() };
  const view = render(<Sanctuary {...props} isOpen={false} />); expect(fixture.mounts).toEqual([]);
  fixture.uid = ''; view.rerender(<Sanctuary {...props} isOpen />); expect(fixture.mounts).toEqual([]);
  fixture.uid = 'owner-a'; view.rerender(<Sanctuary {...props} isOpen />); expect(fixture.mounts).toEqual(['owner-a:memory_avatar_a']);
  fixture.uid = 'owner-b'; view.rerender(<Sanctuary {...props} isOpen />); expect(fixture.released).toContain('owner-a:memory_avatar_a');
  view.rerender(<Sanctuary {...props} isOpen={false} />); expect(fixture.released).toContain('owner-b:memory_avatar_a'); expect(screen.queryByRole('dialog')).toBeNull();
});

it('uses the shell locale and keeps a typed draft while an active call prevents text submission', async () => {
  const props = { agent: avatar, lang: 'en' as const, onClose: vi.fn(), isOpen: true };
  const view = render(<Sanctuary {...props} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'A typed draft' } });
  fixture.state = 'listening'; view.rerender(<Sanctuary {...props} />);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter' }); expect(fixture.send).not.toHaveBeenCalled(); expect((input as HTMLTextAreaElement).value).toBe('A typed draft');
  fixture.state = 'idle'; view.rerender(<Sanctuary {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(fixture.send).toHaveBeenCalledWith('A typed draft'); expect((input as HTMLTextAreaElement).value).toBe('');
  fixture.callOptions.onTranscript('Voice words', true, { requestId: 'voice-1' }); fixture.callOptions.onResponse('A reply', { requestId: 'voice-1' });
  expect(fixture.transcript).toHaveBeenCalledWith('Voice words', true, { requestId: 'voice-1' }); expect(fixture.response).toHaveBeenCalledWith('A reply', { requestId: 'voice-1' });
  view.rerender(<Sanctuary {...props} lang="zh" />); expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('记忆领地');
});

it('previews appearance immediately and ends the call before forwarding an updated profile or archive', async () => {
  const updated = vi.fn(); const archived = vi.fn();
  render(<Sanctuary agent={avatar} lang="en" isOpen onClose={vi.fn()} onAvatarUpdated={updated} onAvatarArchived={archived} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Person details' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Preview fixture' })); expect(screen.getByTestId('stage').getAttribute('data-skin')).toBe('#abcdef');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save fixture' })));
  expect(fixture.end).toHaveBeenCalled(); expect(updated).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, name: 'Updated person' }));
  expect(fixture.end.mock.invocationCallOrder[0]).toBeLessThan(updated.mock.invocationCallOrder[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Archive fixture' })); expect(archived).toHaveBeenCalledWith(avatar.id);
});
