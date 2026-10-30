// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(), apiFetch: vi.fn(), success: vi.fn(), error: vi.fn(),
  user: { uid: 'personal-fixture-a', role: 'user' } as { uid: string; role: string } | null,
}));
vi.mock('../src/services/apiClient', () => ({ apiJson: mocks.apiJson, apiFetch: mocks.apiFetch }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: mocks.user }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../src/components/SharedUI', () => ({ GlassCard: ({ children, ...props }: any) => <div {...props}>{children}</div> }));
vi.mock('../src/components/DesktopDeviceWidget', () => ({ DesktopDeviceWidget: ({ onOpen }: any) => <button onClick={onOpen}>Fixture device widget</button> }));
vi.mock('../src/components/SpriteAnimator', () => ({ PetAvatar: ({ pet, animation }: any) => <span data-testid="pet-preview" data-pet={pet.id} data-animation={animation} /> }));
vi.mock('../src/pets/defaults', () => ({
  getDefaultPets: () => [
    { id: 'fixture-cat', name: 'Fixture Cat', author: 'Fixture', atlas: {}, spritesheet: 'data:image/png;base64,AA==' },
    { id: 'fixture-bird', name: 'Fixture Bird', author: 'Fixture', atlas: {}, spritesheet: 'data:image/png;base64,AA==' },
  ],
  generateCustomPet: vi.fn(() => { throw Error('Unexpected generation'); }),
  recolorPet: vi.fn(() => { throw Error('Unexpected recolor'); }),
}));
vi.mock('motion/react', async () => {
  const React = await import('react');
  const cache = new Map<string, any>();
  return {
    AnimatePresence: ({ children }: any) => children,
    motion: new Proxy({}, { get: (_target, tag: string) => {
      if (!cache.has(tag)) cache.set(tag, React.forwardRef(({ children, initial, animate, exit, transition, whileHover, whileTap, ...props }: any, ref: any) => React.createElement(tag, { ...props, ref }, children)));
      return cache.get(tag);
    } }),
  };
});

import { renderDesktopGrid } from '../src/components/desktop/desktop_grid_view';
import { Spotlight } from '../src/components/desktop/launcher';
import { MeshSyncSelector } from '../src/components/MeshSyncSelector';
import { ContactsPanel } from '../src/components/ContactsPanel';
import { AvatarStudio } from '../src/components/AvatarStudio';

beforeEach(() => {
  vi.clearAllMocks(); mocks.apiJson.mockReset(); mocks.apiFetch.mockReset();
  mocks.user = { uid: 'personal-fixture-a', role: 'user' }; localStorage.clear();
  mocks.apiJson.mockResolvedValue({ contacts: [], total: 0 });
  mocks.apiFetch.mockRejectedValue(Error('No real API in this fixture'));
});
afterEach(cleanup);

function desktopProps() {
  return { isWallpaperMode: false, desktopIconAreaHeight: 300,
    desktopIcons: [{ id: 'chat', label: 'Chat fixture', windowId: 'command-center', colorClass: '', icon: <span /> },
      { id: 'external', label: 'External fixture', colorClass: '', icon: <span />, externalLaunch: { capability: { id: 'fixture' }, action: { id: 'open' } } }],
    getDefaultDesktopIconPosition: (i: number) => ({ x: i * 80, y: 0 }), t: {}, openWindows: [], chatOpen: true, focusedWindow: '',
    launchExternalCapability: vi.fn(async () => {}), toggleWindow: vi.fn(), lang: 'en', socket: null, notifications: [], unreadCount: 0,
  } as any;
}

describe('all-partitions home', () => {
  it('routes keyboard activation to the selected window and preserves current chat focus', () => {
    const props = desktopProps(); render(renderDesktopGrid(props));
    const chat = screen.getByRole('button', { name: 'Chat fixture' });
    expect(chat.className).toContain('desktop-icon-focused');
    fireEvent.keyDown(chat, { key: 'Enter' }); fireEvent.keyDown(chat, { key: ' ' });
    expect(props.toggleWindow.mock.calls).toEqual([['command-center'], ['command-center']]);
    fireEvent.click(screen.getByRole('button', { name: 'Fixture device widget' }));
    expect(props.toggleWindow).toHaveBeenLastCalledWith('devices');
  });
  it('dispatches one external launch for a double-click sequence without toggling a window', () => {
    const props = desktopProps(); render(renderDesktopGrid(props));
    const button = screen.getByRole('button', { name: 'External fixture' });
    fireEvent.click(button, { detail: 1 }); fireEvent.click(button, { detail: 2 }); fireEvent.doubleClick(button);
    expect(props.launchExternalCapability).toHaveBeenCalledTimes(1);
    expect(props.toggleWindow).not.toHaveBeenCalled();
  });
  it('marks wallpaper content inert and hidden from accessibility', () => {
    const props = desktopProps(); props.isWallpaperMode = true;
    const view = render(renderDesktopGrid(props));
    expect(view.container.firstElementChild?.hasAttribute('inert')).toBe(true);
    expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('all-partitions launcher', () => {
  const apps = [{ id: 'chat', label: 'Conversation', color: '', icon: <span /> }, { id: 'files', label: 'Files', color: '', icon: <span /> }];
  it('filters by label or id, recovers from empty results, and selects exactly one app', () => {
    const onSelect = vi.fn(), onClose = vi.fn();
    render(<Spotlight isOpen apps={apps} t={{}} onSelect={onSelect} onClose={onClose} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'CHAT' } });
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Conversation/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'absent' } }); expect(screen.getByText('No neural nodes found')).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } }); fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('files'); expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('keeps internal clicks open, closes on backdrop, and renders nothing when closed', () => {
    const onClose = vi.fn(); const view = render(<Spotlight isOpen apps={apps} t={{}} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('textbox')); expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(view.container.firstElementChild!); expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<Spotlight isOpen={false} apps={apps} t={{}} onSelect={vi.fn()} onClose={onClose} />);
    expect(view.container.childElementCount).toBe(0);
  });
});

describe('all-partitions nexus', () => {
  it('dispatches each bounded sync rate and reflects controlled selection without network work', () => {
    const onSyncRateChange = vi.fn(); const view = render(<MeshSyncSelector syncRate={1} onSyncRateChange={onSyncRateChange} />);
    for (const rate of [0.5, 1, 1.5, 2]) fireEvent.click(screen.getByRole('button', { name: `${rate}x` }));
    expect(onSyncRateChange.mock.calls).toEqual([[0.5], [1], [1.5], [2]]);
    view.rerender(<MeshSyncSelector syncRate={2} onSyncRateChange={onSyncRateChange} />);
    expect(screen.getByRole('button', { name: '2x' }).className).toContain('bg-celestial-saturn/20');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('all-partitions contacts', () => {
  it('does not load or render contacts for a signed-out account', () => {
    mocks.user = null; const view = render(<ContactsPanel />);
    expect(view.container.childElementCount).toBe(0); expect(mocks.apiJson).not.toHaveBeenCalled();
  });
  it('filters contact fields and retains a failed save draft until the server confirms it', async () => {
    mocks.apiJson.mockResolvedValueOnce({ contacts: [{ id: 'one', name: 'Alice', tags: ['research'] }, { id: 'two', name: 'Bob' }], total: 2 });
    render(<ContactsPanel />); await screen.findByText('Alice');
    mocks.apiJson.mockResolvedValueOnce({ contacts: [{ id: 'one', name: 'Alice', tags: ['research'] }], total: 1 });
    fireEvent.change(screen.getByPlaceholderText('contacts-panel.search-contacts.fcf6775e68'), { target: { value: 'research' } });
    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
    mocks.apiJson.mockResolvedValueOnce({ contacts: [{ id: 'one', name: 'Alice' }, { id: 'two', name: 'Bob' }], total: 2 });
    fireEvent.change(screen.getByPlaceholderText('contacts-panel.search-contacts.fcf6775e68'), { target: { value: '' } });
    await screen.findByText('Bob');
    fireEvent.click(screen.getByRole('button', { name: 'contacts-panel.add.cd6f2f52ff' }));
    const name = screen.getByPlaceholderText('contacts-panel.name.f5479c3217');
    expect((screen.getByRole('button', { name: 'contacts-panel.save.ec8e6d5819' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  Carol  ' } });
    mocks.apiJson.mockRejectedValueOnce(Error('Fixture save rejected'));
    fireEvent.click(screen.getByRole('button', { name: 'contacts-panel.save.ec8e6d5819' }));
    await screen.findByRole('alert'); expect((name as HTMLInputElement).value).toBe('  Carol  '); expect(screen.queryByText('Carol')).toBeNull();
    mocks.apiJson.mockResolvedValueOnce({ id: 'three', name: 'Carol', relationship: 'friend' }).mockResolvedValueOnce({ contacts: [{ id: 'three', name: 'Carol' }], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'contacts-panel.save.ec8e6d5819' }));
    await screen.findByText('Carol'); expect(screen.queryByPlaceholderText('contacts-panel.name.f5479c3217')).toBeNull();
    const [url, options] = mocks.apiJson.mock.calls.filter(([, init]) => init.method === 'POST').at(-1)!;
    expect(url).toBe('/api/contacts'); expect(options.method).toBe('POST'); expect(JSON.parse(options.body)).toMatchObject({ name: 'Carol', relationship: 'friend' });
  });
  it('does not remove an existing contact for an unconfirmed delete response', async () => {
    mocks.apiJson.mockResolvedValueOnce({ contacts: [{ id: 'one', name: 'Alice' }], total: 1 });
    render(<ContactsPanel />); await screen.findByText('Alice');
    mocks.apiJson.mockResolvedValueOnce({ success: false });
    fireEvent.click(screen.getByTitle('reminder-panel.delete.5b875326d1'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));
    await screen.findByRole('alert'); expect(screen.getByText('Alice')).toBeTruthy();
    mocks.apiJson.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
  });
  it('aborts the old account load and cannot expose its late response in a new account', async () => {
    let finish!: (value: unknown) => void;
    mocks.apiJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<ContactsPanel />); const oldSignal = mocks.apiJson.mock.calls[0][1].signal;
    mocks.user = { uid: 'personal-fixture-b', role: 'user' }; mocks.apiJson.mockResolvedValueOnce({ contacts: [{ id: 'b', name: 'Current account' }], total: 1 });
    view.rerender(<ContactsPanel />); await screen.findByText('Current account'); expect(oldSignal.aborted).toBe(true);
    await act(async () => finish({ contacts: [{ id: 'a', name: 'Old account' }], total: 1 }));
    expect(screen.queryByText('Old account')).toBeNull();
  });
});

describe('all-partitions personalization', () => {
  it('previews a different avatar without committing it and applies or resets only on explicit action', () => {
    const onSelectPet = vi.fn(), onResetToSphere = vi.fn();
    render(<AvatarStudio t={{}} lang="en" selectedPetId="fixture-cat" onSelectPet={onSelectPet} onResetToSphere={onResetToSphere} />);
    fireEvent.click(screen.getByRole('button', { name: /Fixture Bird/ })); expect(onSelectPet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'avatar-studio.set-as-desktop-avatar.a24191c1bf' }));
    expect(onSelectPet).toHaveBeenCalledTimes(1); expect(onSelectPet.mock.calls[0][0].id).toBe('fixture-bird');
    fireEvent.click(screen.getByRole('button', { name: 'avatar-studio.restore-default-sphere.c8836d9f16' }));
    expect(onResetToSphere).toHaveBeenCalledTimes(1); expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
  it('keeps custom avatar storage separate when the shell remounts by account scope', () => {
    const custom = { id: 'custom-a', name: 'Account A avatar', atlas: {}, spritesheet: 'data:image/png;base64,AA==' };
    localStorage.setItem('lumi_custom_pets_account-a', JSON.stringify([custom]));
    const props = { t: {}, lang: 'en' as const, onSelectPet: vi.fn() };
    const view = render(<AvatarStudio key="a" {...props} storageScope="account-a" />);
    expect(screen.getByRole('button', { name: /Account A avatar/ })).toBeTruthy();
    view.rerender(<AvatarStudio key="b" {...props} storageScope="account-b" />);
    expect(screen.queryByRole('button', { name: /Account A avatar/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem('lumi_custom_pets_account-a') || '[]')).toEqual([custom]);
    expect(JSON.parse(localStorage.getItem('lumi_custom_pets_account-b') || '[]')).toEqual([]);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
  it('blocks blank generation and retains the selected avatar after a rejected mocked request', async () => {
    const onSelectPet = vi.fn(); render(<AvatarStudio t={{}} lang="en" onSelectPet={onSelectPet} />);
    fireEvent.click(screen.getByRole('button', { name: 'avatar-studio.ai-custom.7f25d48a69' }));
    const button = screen.getByRole('button', { name: 'avatar-studio.generate.8ddb57be93' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Synthetic pet request' } });
    mocks.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Fixture generation rejected' }) });
    fireEvent.click(button); await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Fixture generation rejected'));
    expect(onSelectPet).not.toHaveBeenCalled(); expect(screen.getByRole('heading', { name: 'Fixture Cat' })).toBeTruthy();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });
});
