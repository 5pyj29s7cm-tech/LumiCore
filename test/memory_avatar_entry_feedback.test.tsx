// @vitest-environment jsdom
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { useDesktopCaptureAndIdentity } from '../src/components/desktop/state/use_desktop_capture_and_identity';
import { AgentChatView } from '../src/components/agent_chat/AgentChatView';
import { MemoryAvatarEntryFeedback } from '../src/components/MemoryAvatarEntryFeedback';
import { MemoryAvatarApiError } from '../src/services/memoryAvatarService';

const fixtures = vi.hoisted(() => ({ list: vi.fn(), error: vi.fn(), click: vi.fn(), noop: vi.fn(),
  voice: { templatesLoaded: false, enrolledCount: 0, result: {}, loadTemplates: vi.fn(), startListening: vi.fn(), stopListening: vi.fn() },
  call: { callState: 'idle', audioLevel: 0, switchVoice: vi.fn(), startCall: vi.fn(), endCall: vi.fn() },
  meeting: { meetingCaptureResetRef: { current: null }, meetingVoiceActiveRef: { current: false }, meetingPaused: true,
    meetingIdentityRef: { current: { meetingId: 'fixture' } }, setMeetingPaused: vi.fn() },
}));
vi.mock('../src/services/memoryAvatarService', async importOriginal => ({ ...await importOriginal<typeof import('../src/services/memoryAvatarService')>(), memoryAvatarService: { list: fixtures.list } }));
vi.mock('../src/services/soundService', () => ({ sounds: { playClick: fixtures.click } }));
vi.mock('sonner', () => ({ toast: { error: fixtures.error, info: fixtures.noop, success: fixtures.noop } }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/hooks/useAmbientPoller', () => ({ useAmbientPoller: () => undefined }));
vi.mock('../src/hooks/useVoiceCall', () => ({ useVoiceCall: () => fixtures.call }));
vi.mock('../src/hooks/useVoiceprint', () => ({ useVoiceprint: () => fixtures.voice }));
vi.mock('../src/components/desktop/useMeetingTranscript', () => ({ useMeetingTranscript: () => fixtures.meeting }));
vi.mock('../src/services/sensorPermissionService', () => ({ isBackgroundFacePresenceEnabled: () => false,
  isSensorEnabled: () => false, BACKGROUND_FACE_PRESENCE_CHANGED: 'fixture-presence', BACKGROUND_FACE_PRESENCE_ENABLED_KEY: 'fixture-enabled', SENSOR_ACCESS_CHANGED: 'fixture-access' }));
vi.mock('../src/components/desktop/launcher', () => ({ externalCapabilityDesktopIcon: () => null }));
vi.mock('../src/components/agent_chat/chat_toolbar_view', () => ({ renderChatToolbar: () => null }));
vi.mock('../src/components/agent_chat/conversation_history_rail_view', () => ({ ConversationHistoryRail: () => null }));
vi.mock('../src/components/agent_chat/chat_panel_header_view', () => ({ renderChatPanelHeader: () => null }));
vi.mock('../src/components/agent_chat/chat_message_feed_view', () => ({ renderChatMessageFeed: () => null }));
vi.mock('../src/components/agent_chat/chat_composer_view', () => ({ renderChatComposer: () => null }));
vi.mock('../src/components/agent_chat/chat_activity_rail_view', () => ({ renderChatActivityRail: () => null }));
vi.mock('../src/components/CommandCenterPanel', () => ({ CommandCenterPanel: () => null }));
vi.mock('../src/components/ActiveTaskWidget', () => ({ ActiveTaskWidget: () => null }));
vi.mock('../src/components/CommandCenterPlanner', () => ({ CommandCenterPlanner: () => null }));
vi.mock('../src/components/ChatFilePreview', () => ({ ChatFilePreview: () => null }));
vi.mock('../src/components/WeChatSettings', () => ({ WeChatSettings: () => null }));
vi.mock('../src/components/MediaGenerationStudio', () => ({ MediaGenerationStudio: () => null }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: { div: ({ children }: React.PropsWithChildren) => <div>{children}</div>, section: ({ children }: React.PropsWithChildren) => <section>{children}</section> } }));

let current: ReturnType<typeof useDesktopCaptureAndIdentity>;
let state: { chat: boolean; lab: boolean; sanctuary: boolean; selected: string | null };
let cachedAvatarIds: string[];
function Harness({ owner = 'owner-a', login = 1, lang = 'en', domain = 'personal', orgId = '' }: { owner?: string; login?: number; lang?: 'en' | 'zh'; domain?: 'personal' | 'work'; orgId?: string }) {
  const [avatars, setMemoryAvatars] = useState<any[]>([]);
  const [agent, setSanctuaryAgent] = useState<any>(null);
  const [chat, setChat] = useState(true);
  const [lab, setMemoryLabOpen] = useState(false);
  const [sanctuary, setSanctuaryOpen] = useState(false);
  const ownerScope = useMemo(() => ({ userId: owner }), [owner, login]);
  const ownerRef = useRef(ownerScope); ownerRef.current = ownerScope;
  const generation = useRef(0);
  const listOwner = useRef('');
  const stable = useRef({ surfaceReturnTargetRef: { current: 'command-center' }, setSanctuaryLoaded: vi.fn(),
    inferSurfaceReturnTarget: () => 'command-center', setIsSearchOpen: vi.fn(), setViewMode: vi.fn(), setActiveTab: vi.fn(),
    setChatLoaded: vi.fn(), setKnowledgeLoaded: vi.fn(), setOperationMode: vi.fn(),
    desktopIconLayout: { startX: 0, startY: 0, cellWidth: 10, cellHeight: 10 }, desktopIconColumns: 3,
  });
  // The real upstream surface-state hook supplies these owner/generation refs.
  // Reproduce only that fixture boundary; the entry hook and click handler are actual imports.
  useEffect(() => { generation.current++; listOwner.current = ''; setMemoryAvatars([]); setSanctuaryAgent(null); setSanctuaryOpen(false); setMemoryLabOpen(false); }, [ownerScope]);
  current = useDesktopCaptureAndIdentity({ ...stable.current, memoryAvatarOwnerScope: ownerScope, memoryAvatarOwnerRef: ownerRef,
    memoryAvatarListOwnerRef: listOwner, memoryAvatarOpenGenerationRef: generation, memoryAvatarSurfaceGeneration: generation.current,
    memoryAvatars: avatars, setMemoryAvatars, setMemoryLabOpen, setSanctuaryAgent, setSanctuaryOpen,
    dismissUtilitySurfaces: () => setChat(false), restoreSurfaceReturnTarget: () => setChat(true),
    isTauri: false, chatOpen: chat, user: { uid: owner }, workDomain: domain, orgConnection: orgId ? { connected: true, orgId } : null, lang,
    operationMode: 'assistant', volume: 1, canUseExternalCapabilities: false,
  } as unknown as Parameters<typeof useDesktopCaptureAndIdentity>[0]);
  state = { chat, lab, sanctuary, selected: agent?.id || null };
  cachedAvatarIds = avatars.map(avatar => avatar.id);
  const input = { isOpen: chat, layout: 'command-center', commandCenterView: 'office', isOfficeCommandCenter: true,
    isZh: false, t: { memoryAvatars: 'Memory Territory' }, chatAccentTheme: {}, prefersReducedMotion: true,
    onOpenMemoryAvatar: () => { void current.openMemoryAvatar(); }, mediaGenerationText: {},
  } as unknown as React.ComponentProps<typeof AgentChatView>;
  return <><AgentChatView {...input} />
    {current.memoryAvatarEntryState && <MemoryAvatarEntryFeedback state={current.memoryAvatarEntryState} locale={lang}
      onClose={current.cancelMemoryAvatarEntry} onRetry={current.retryMemoryAvatarEntry} />}
    <button onClick={() => { generation.current++; setChat(false); }}>Open another surface</button>
    <button onClick={() => { void current.openMemoryAvatar('requested-person'); }}>Open requested person</button>
  </>;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const observations: unknown[] = [];
const button = () => screen.getByRole('button', { name: 'Memory Territory' });
function observe(id: string) { observations.push({ id, state: { ...state }, listCalls: fixtures.list.mock.calls.map(a => ({ args: a.length, signal: Boolean(a[0]) })),
  statusCount: screen.queryAllByRole('status').length, alertCount: screen.queryAllByRole('alert').length, errorNotices: fixtures.error.mock.calls.length }); }
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No network in entry probe')))); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); if (process.env.ENTRY_OBSERVATIONS) fs.writeFileSync(process.env.ENTRY_OBSERVATIONS, JSON.stringify(observations, null, 2)); });

it('provides a pending/error feedback surface instead of leaving the real entry click invisible for 30 seconds', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  render(<Harness />); fireEvent.click(button());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  observe('pending-30-seconds');
  expect(fixtures.list).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status') || screen.queryByRole('alert')).not.toBeNull();
});
it('does not treat a rejected list as a confirmed empty collection', async () => {
  fixtures.list.mockRejectedValueOnce(new Error('synthetic list failure'));
  render(<Harness />); fireEvent.click(button());
  await act(async () => { await Promise.resolve(); });
  observe('rejected-list');
  expect(state.lab).toBe(false);
  expect(screen.queryByRole('alert') || fixtures.error.mock.calls.length).toBeTruthy();
});
it('opens the selected existing person after the list resolves', async () => {
  fixtures.list.mockResolvedValueOnce({ avatars: [{ id: 'person-a' }] });
  render(<Harness />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  observe('successful-list'); expect(state).toEqual({ chat: false, lab: false, sanctuary: true, selected: 'person-a' });
});
it('only lets the last of repeated real entry clicks open its result', async () => {
  const first = deferred<{ avatars: any[] }>(); const second = deferred<{ avatars: any[] }>();
  fixtures.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(<Harness />); fireEvent.click(button()); fireEvent.click(button());
  expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { second.resolve({ avatars: [{ id: 'new-person' }] }); await second.promise; });
  await act(async () => { first.resolve({ avatars: [{ id: 'old-person' }] }); await first.promise; });
  observe('repeated-clicks'); expect(state.selected).toBe('new-person'); expect(state.sanctuary).toBe(true);
});
it('does not reopen a closed entry when its old list resolves', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  render(<Harness />); fireEvent.click(button()); act(() => current.closeMemoryAvatar());
  await act(async () => { held.resolve({ avatars: [{ id: 'old-person' }] }); await held.promise; });
  observe('closed-before-resolution'); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
});
it('does not open an old owner result after the upstream owner generation changes', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  const view = render(<Harness />); fireEvent.click(button()); view.rerender(<Harness owner="owner-b" />);
  await act(async () => { held.resolve({ avatars: [{ id: 'old-owner-person' }] }); await held.promise; });
  observe('owner-changed'); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false); expect(state.selected).toBeNull();
});

it('shows immediate loading in the real feedback while retaining the previous screen', () => {
  fixtures.list.mockReturnValueOnce(new Promise(() => {}));
  render(<Harness />); fireEvent.click(button());
  expect(screen.getByRole('status').textContent).toContain('Loading people');
  expect(state.chat).toBe(true); expect(state.lab).toBe(false); expect(state.sanctuary).toBe(false);
  expect(fixtures.list.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  expect(fixtures.list.mock.calls[0][0].aborted).toBe(false);
});

it('times out an abort-ignoring list and rejects its later response without opening a person', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  render(<Harness />); fireEvent.click(button());
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole('alert').textContent).toContain('timed out');
  expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { held.resolve({ avatars: [{ id: 'late-person' }] }); await held.promise; });
  expect(state.selected).toBeNull(); expect(state.chat).toBe(true); expect(state.lab).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('timed out');
});

it('retries a failed list only after the user requests it and then opens the confirmed person', async () => {
  fixtures.list.mockRejectedValueOnce(new Error('synthetic read failure')).mockResolvedValueOnce({ avatars: [{ id: 'retry-person' }] });
  render(<Harness />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(fixtures.list).toHaveBeenCalledOnce(); expect(state.chat).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reload people' }));
  await act(async () => { await Promise.resolve(); });
  expect(fixtures.list).toHaveBeenCalledTimes(2); expect(state.selected).toBe('retry-person');
  expect(state.sanctuary).toBe(true); expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('cancels through the real feedback button and ignores a later list response', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  render(<Harness />); fireEvent.click(button()); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { held.resolve({ avatars: [{ id: 'cancelled-person' }] }); await held.promise; });
  expect(state).toEqual({ chat: true, lab: false, sanctuary: false, selected: null });
});

it('opens the creation lab only after a successful confirmed empty list', async () => {
  fixtures.list.mockResolvedValueOnce({ avatars: [] });
  render(<Harness />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(state).toEqual({ chat: false, lab: true, sanctuary: false, selected: null });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not substitute another person when an explicit requested ID is absent', async () => {
  fixtures.list.mockResolvedValueOnce({ avatars: [{ id: 'unrelated-person' }] });
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Open requested person' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('alert').textContent).toContain('requested person was not found');
  expect(state).toEqual({ chat: true, lab: false, sanctuary: false, selected: null });
  fireEvent.click(screen.getByRole('button', { name: 'Back' })); expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([
  [401, 'unauthorized', 'sign-in'], [403, 'forbidden', 'sign-in'],
  [502, 'invalid_memory_avatar_response', 'validation'],
] as const)('surfaces list error %s without converting it into an empty collection', async (status, code, expected) => {
  fixtures.list.mockRejectedValueOnce(new MemoryAvatarApiError(status, code, 'private diagnostic must not be shown'));
  render(<Harness />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('alert').textContent).toContain(expected);
  expect(screen.queryByText(/private diagnostic/)).toBeNull();
  expect(state.lab).toBe(false); expect(state.sanctuary).toBe(false); expect(state.chat).toBe(true);
});

it('clears and aborts the previous login request even when the account ID is unchanged', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  const view = render(<Harness />); fireEvent.click(button()); view.rerender(<Harness login={2} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { held.resolve({ avatars: [{ id: 'old-login-person' }] }); await held.promise; });
  expect(state.selected).toBeNull(); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
});

it('dismisses a pending entry when upstream navigation changes the generation', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  render(<Harness />); fireEvent.click(button()); fireEvent.click(screen.getByRole('button', { name: 'Open another surface' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { held.resolve({ avatars: [{ id: 'old-surface-person' }] }); await held.promise; });
  expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
});

it('aborts on unmount and does not leave the deadline timer running', async () => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  const view = render(<Harness />); fireEvent.click(button()); view.unmount();
  await act(async () => { await Promise.resolve(); });
  expect(fixtures.list.mock.calls[0][0].aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  await act(async () => { held.resolve({ avatars: [{ id: 'unmounted-person' }] }); await held.promise; });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('provides localized Chinese pending and error actions without revealing server diagnostics', async () => {
  fixtures.list.mockRejectedValueOnce(new Error('private server path'));
  render(<Harness lang="zh" />); fireEvent.click(button());
  expect(screen.getByRole('status').textContent).toContain('正在读取人物列表');
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('alert').textContent).toContain('人物列表读取失败');
  expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(state.chat).toBe(true);
  expect(screen.queryByText(/private server path/)).toBeNull();
});

it.each([
  ['domain', 'personal', '', 'work', 'org-a'],
  ['organization', 'work', 'org-a', 'work', 'org-b'],
] as const)('rejects pending list data when the same account changes %s without changing its generation', async (_kind, firstDomain, firstOrg, nextDomain, nextOrg) => {
  const held = deferred<{ avatars: any[] }>(); fixtures.list.mockReturnValueOnce(held.promise);
  const view = render(<Harness domain={firstDomain} orgId={firstOrg} />); fireEvent.click(button());
  view.rerender(<Harness domain={nextDomain} orgId={nextOrg} />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(fixtures.list.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { held.resolve({ avatars: [{ id: 'old-scope-person' }] }); await held.promise; });
  expect(state.selected).toBeNull(); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
  expect(cachedAvatarIds).toEqual([]);
});

it('does not retry a failed previous-domain entry under the new domain', async () => {
  fixtures.list.mockRejectedValueOnce(new Error('Synthetic read failure'));
  const view = render(<Harness />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('button', { name: 'Reload people' })).toBeTruthy();
  const previousRetry = current.retryMemoryAvatarEntry;
  view.rerender(<Harness domain="work" orgId="org-b" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => previousRetry()); await act(async () => { await Promise.resolve(); });
  expect(fixtures.list).toHaveBeenCalledOnce(); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
});

it('shows a sign-in error without requesting a list when no owner is logged in', async () => {
  render(<Harness owner="" />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(fixtures.list).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toContain('sign-in');
  expect(state.lab).toBe(false); expect(state.sanctuary).toBe(false);
});

it('explains the personal-workspace requirement without silently switching scope or opening a lab', async () => {
  fixtures.list.mockRejectedValueOnce(new MemoryAvatarApiError(403, 'memory_avatar_personal_scope_required', 'private scope details'));
  render(<Harness domain="work" orgId="org-a" />); fireEvent.click(button()); await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('alert').textContent).toMatch(/personal workspace/i);
  expect(state.chat).toBe(true); expect(state.sanctuary).toBe(false); expect(state.lab).toBe(false);
  expect(fixtures.list).toHaveBeenCalledOnce(); expect(screen.queryByText(/private scope details/)).toBeNull();
});
