// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CentralLumiChat } from '../src/components/org/CentralLumiChat';
import { toast } from 'sonner';
const fixture = vi.hoisted(() => ({ uid: 'owner-a', orgId: 'org-a', langCode: 'en', net: vi.fn(), emit: vi.fn(), listeners: new Map<string, Set<Function>>() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid, role: 'user' }, workDomain: 'work', orgConnection: { orgId: fixture.orgId, orgRole: 'member' } }) }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: fixture.langCode, orgChat: 'Organization chat' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1] }));
vi.mock('../src/components/ChatMessageMarkdown', () => ({ ChatMessageMarkdown: ({ children }: any) => <>{children}</> }));
vi.mock('../src/components/ChatArtifactCards', () => ({ ChatArtifactCards: () => null }));
vi.mock('../src/components/ChatFilePreview', () => ({ ChatFilePreview: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const socket = { id: 'synthetic-client', emit: fixture.emit, on: (name: string, callback: Function) => { if (!fixture.listeners.has(name)) fixture.listeners.set(name, new Set()); fixture.listeners.get(name)!.add(callback); }, off: (name: string, callback: Function) => fixture.listeners.get(name)?.delete(callback) };
const event = (name: string, data: unknown) => { for (const handler of fixture.listeners.get(name) || []) handler(data); };
function deferred() { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const reply = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data });
const conversation = () => `${fixture.uid}-${fixture.orgId}`;
const uploaded = (name: string) => reply({ files: [{ id: name, name, path: `D:/synthetic/${name}`, content: 'synthetic document' }] });
const requests: Array<ReturnType<typeof deferred> & { url: string; init: RequestInit }> = [];
const notification = vi.fn();
const root = () => <CentralLumiChat />;
const attachButton = () => screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement;
const ready = async (id = conversation()) => { await screen.findByText(`history-${id}`); };
function importFile(kind: string, name = 'selected.txt') {
  if (kind === 'drop') fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { types: ['Files'], files: [new File(['synthetic'], name)] } });
  else fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], name)] } });
}
beforeEach(() => {
  fixture.uid = 'owner-a'; fixture.orgId = 'org-a'; fixture.langCode = 'en'; requests.length = 0; localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn(); window.addEventListener('lumi:knowledge-updated', notification);
  fixture.net.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { const request = { ...deferred(), url, init }; requests.push(request); return request.promise; }
    if (url.includes('/active?')) return reply({ activeConversation: { id: conversation() } });
    if (url.includes('/messages?')) { const id = url.split('/')[3]; return reply({ messages: [{ id, role: 'user', content: `history-${id}` }] }); }
    return reply({ provider: 'synthetic', model: 'offline' });
  }); vi.stubGlobal('fetch', fixture.net);
});
afterEach(() => { cleanup(); window.removeEventListener('lumi:knowledge-updated', notification); vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.net.mockReset(); fixture.listeners.clear(); });

it.each(['files', 'drop'])('isolates late %s results across account and organization changes', async kind => {
  const view = render(root()); await ready();
  for (const scope of ['uid', 'orgId'] as const) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Old account draft' } });
    act(() => importFile(kind, `old-${scope}.txt`)); const old = requests.at(-1)!;
    fixture[scope] += '-new'; view.rerender(root()); await ready();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    act(() => importFile(kind, `new-${scope}.txt`)); const current = requests.at(-1)!;
    const previousNotifications = notification.mock.calls.length, previousToasts = vi.mocked(toast.success).mock.calls.length;
    await act(async () => { old.resolve(uploaded(`old-${scope}.txt`)); });
    expect(screen.queryByText(`old-${scope}.txt`)).toBeNull(); expect(old.init.signal?.aborted).toBe(true); expect(attachButton().disabled).toBe(true);
    expect(notification).toHaveBeenCalledTimes(previousNotifications); expect(toast.success).toHaveBeenCalledTimes(previousToasts);
    await act(async () => { current.resolve(uploaded(`new-${scope}.txt`)); });
    expect(await screen.findByText(`new-${scope}.txt`)).toBeTruthy(); expect(attachButton().disabled).toBe(false);
    const body = current.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('orgId')).toBe(fixture.orgId); expect((body as FormData).get('domain')).toBe('work');
    expect(current.url).toBe('/api/files/upload');
  }
});

it.each(['files', 'drop'])('serializes %s with the other upload entry and blocks sending until receipt', async kind => {
  render(root()); await ready();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use this document' } });
  act(() => { importFile(kind); importFile(kind === 'files' ? 'drop' : 'files', 'duplicate.txt'); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); });
  expect(requests).toHaveLength(1); expect(fixture.emit).not.toHaveBeenCalled();
  await act(async () => { requests[0].resolve(uploaded('selected.txt')); });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  expect(fixture.emit.mock.calls[0][1]).toMatchObject({ orgId: fixture.orgId, attachments: [{ fileId: 'selected.txt', content: 'synthetic document' }] });
});

it.each(['files', 'drop'])('cancels %s on conversation rollover and closure without carrying pending files', async kind => {
  render(root()); await ready();
  act(() => importFile(kind)); const old = requests.at(-1)!;
  act(() => event('chat:conversation_updated', { agentId: 'lumi', conversationId: 'next-conversation', previousConversationId: conversation(), rolledOver: true }));
  await ready('next-conversation'); expect(old.init.signal?.aborted).toBe(true);
  await act(async () => { old.reject(new Error('late old failure')); }); expect(toast.error).not.toHaveBeenCalled();
  act(() => importFile(kind, 'pending.txt')); await act(async () => { requests.at(-1)!.resolve(uploaded('pending.txt')); });
  expect(await screen.findByText('pending.txt')).toBeTruthy();
  act(() => importFile(kind, 'closing.txt')); const closing = requests.at(-1)!;
  act(() => window.dispatchEvent(new CustomEvent('lumi:conversation-closed', { detail: { conversationId: 'next-conversation' } })));
  expect(closing.init.signal?.aborted).toBe(true); expect(screen.queryByText('pending.txt')).toBeNull();
  await act(async () => { closing.resolve(uploaded('closing.txt')); }); expect(screen.queryByText('closing.txt')).toBeNull();
});

it.each(['files', 'drop'])('keeps %s valid across language changes, handles failure and cancels on unmount', async kind => {
  const view = render(<StrictMode>{root()}</StrictMode>); await ready();
  act(() => importFile(kind)); const first = requests.at(-1)!;
  fixture.langCode = 'zh'; view.rerender(<StrictMode>{root()}</StrictMode>);
  await act(async () => { first.resolve(reply({ error: 'denied' }, 403)); });
  expect(toast.error).toHaveBeenCalledWith('denied'); expect(attachButton().disabled).toBe(false);
  act(() => importFile(kind)); const second = requests.at(-1)!; view.unmount();
  expect(second.init.signal?.aborted).toBe(true); vi.clearAllMocks();
  await act(async () => { second.resolve(uploaded('unmounted.txt')); });
  expect(toast.success).not.toHaveBeenCalled(); expect(notification).not.toHaveBeenCalled();
  expect([...fixture.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it('does not let a late initial conversation lookup rebind or cancel a newer upload', async () => {
  const initial = deferred(), transport = fixture.net.getMockImplementation()!;
  fixture.net.mockImplementation((url: string, init?: RequestInit) => url.includes('/active?') ? initial.promise : transport(url, init));
  render(root()); await waitFor(() => expect(fixture.net).toHaveBeenCalled());
  act(() => event('chat:conversation_updated', { agentId: 'lumi', conversationId: 'accepted-conversation' }));
  await ready('accepted-conversation'); act(() => importFile('files', 'current.txt')); const current = requests.at(-1)!;
  await act(async () => { initial.resolve(reply({ activeConversation: { id: 'stale-conversation' } })); });
  expect(fixture.net.mock.calls.some(([url]) => url.includes('/stale-conversation/messages'))).toBe(false);
  expect(current.init.signal?.aborted).toBe(false); expect(screen.getByText('history-accepted-conversation')).toBeTruthy();
  await act(async () => { current.resolve(uploaded('current.txt')); }); expect(await screen.findByText('current.txt')).toBeTruthy();
});

function delayHistory() {
  const reads: Array<ReturnType<typeof deferred> & { signal?: AbortSignal | null }> = [], transport = fixture.net.getMockImplementation()!;
  fixture.net.mockImplementation((url: string, init?: RequestInit) => {
    if (!url.includes('/messages?')) return transport(url, init);
    const read = { ...deferred(), signal: init?.signal }; reads.push(read); return read.promise;
  }); return reads;
}
const historyReply = (text: string) => reply({ messages: [{ id: text, role: 'user', content: text }] });
const refreshHistory = (extra = {}) => event('chat:conversation_updated', { agentId: 'lumi', conversationId: conversation(), ...extra });
const send = (text = 'New user question') => { fireEvent.change(screen.getByRole('textbox'), { target: { value: text } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); return fixture.emit.mock.calls.at(-1)![1].requestId; };

it.each(['initial', 'socket'])('accepts only the latest history response after a delayed %s read', async first => {
  let reads: ReturnType<typeof delayHistory>;
  if (first === 'initial') { reads = delayHistory(); render(root()); await waitFor(() => expect(reads).toHaveLength(1)); }
  else { render(root()); await ready(); reads = delayHistory(); act(() => refreshHistory()); }
  act(() => refreshHistory()); expect(reads).toHaveLength(2);
  await act(async () => { reads[1].resolve(historyReply('Newest history')); });
  await screen.findByText('Newest history'); await act(async () => { reads[0].resolve(historyReply('Stale history')); });
  expect(screen.queryByText('Stale history')).toBeNull(); expect(screen.getByText('Newest history')).toBeTruthy();
  expect(reads[0].signal?.aborted).toBe(true);
});

it.each(['streaming', 'finished'])('preserves new messages and the same response bubble while history arrives during %s', async phase => {
  render(root()); await ready(); const reads = delayHistory(); act(() => refreshHistory());
  const requestId = send(); act(() => event('agent:chunk', { requestId, text: 'Here is the first part of the answer. ' }));
  act(() => refreshHistory()); act(() => event('agent:chunk', { requestId, text: 'Here is the second part.' }));
  expect(screen.getByText('Here is the first part of the answer. Here is the second part.')).toBeTruthy();
  if (phase === 'finished') act(() => event('agent:response', { requestId, text: 'Finished response', finalized: true }));
  await act(async () => { reads.forEach(read => read.resolve(historyReply('Old server snapshot'))); });
  expect(screen.queryByText('Old server snapshot')).toBeNull(); expect(screen.getByText('New user question')).toBeTruthy();
  if (phase === 'streaming') act(() => event('agent:response', { requestId, text: 'Finished response', finalized: true }));
  expect(screen.getAllByText('Finished response')).toHaveLength(1); expect(screen.queryByText(/Here is the first part/)).toBeNull();
});

it('keeps an active reply attached when the display language changes', async () => {
  const view = render(root()); await ready(); const requestId = send();
  act(() => event('agent:chunk', { requestId, text: 'The first part precedes a language change. ' }));
  fixture.langCode = 'zh'; view.rerender(root());
  await act(async () => {});
  act(() => event('agent:chunk', { requestId, text: 'The second part follows.' }));
  expect(screen.getByText('The first part precedes a language change. The second part follows.')).toBeTruthy();
  act(() => event('agent:response', { requestId, text: 'Language change preserved reply', finalized: true }));
  expect(screen.getByText('Language change preserved reply')).toBeTruthy(); expect(fixture.emit).toHaveBeenCalledTimes(1);
});

it('invalidates pending history on rollover, closure and unmount, including retained socket callbacks', async () => {
  const view = render(root()); await ready(); const reads = delayHistory(); act(() => refreshHistory());
  act(() => refreshHistory({ conversationId: 'new-conversation', previousConversationId: conversation(), rolledOver: true }));
  await act(async () => { reads[1].resolve(historyReply('New conversation history')); reads[0].resolve(historyReply('Old conversation history')); });
  expect(screen.queryByText('Old conversation history')).toBeNull(); expect(reads[0].signal?.aborted).toBe(true);
  act(() => refreshHistory({ conversationId: 'new-conversation' }));
  act(() => window.dispatchEvent(new CustomEvent('lumi:conversation-closed', { detail: { conversationId: 'new-conversation' } })));
  await act(async () => { reads[2].resolve(historyReply('Closed conversation history')); });
  expect(screen.queryByText('Closed conversation history')).toBeNull(); expect(reads[2].signal?.aborted).toBe(true);
  act(() => refreshHistory()); const callback = [...fixture.listeners.get('chat:conversation_updated')!][0];
  view.unmount(); const count = fixture.net.mock.calls.length; callback({ agentId: 'lumi', conversationId: conversation() });
  expect(fixture.net).toHaveBeenCalledTimes(count); expect(reads[3].signal?.aborted).toBe(true);
  await act(async () => { reads[3].resolve(historyReply('Unmounted history')); });
});

it('ignores rejected, malformed and unrelated history without cancelling a current upload', async () => {
  render(root()); await ready(); const reads = delayHistory();
  for (const payload of [reply({ messages: [{ role: 'user', content: 'Unauthorized history' }] }, 403), reply({ messages: null })]) {
    act(() => refreshHistory()); await act(async () => { reads.at(-1)!.resolve(payload); });
    expect(screen.getByText(`history-${conversation()}`)).toBeTruthy(); expect(screen.queryByText('Unauthorized history')).toBeNull();
  }
  act(() => { refreshHistory({ agentId: 'other' }); refreshHistory({ conversationId: 'unrelated' }); refreshHistory({ originSocketId: socket.id }); });
  expect(reads).toHaveLength(2); act(() => importFile('files')); const upload = requests.at(-1)!;
  act(() => { refreshHistory(); refreshHistory(); }); expect(upload.init.signal?.aborted).toBe(false);
  await act(async () => { reads[3].resolve(historyReply('Recovered history')); upload.resolve(uploaded('kept.txt')); });
  expect(screen.getByText('Recovered history')).toBeTruthy(); expect(screen.getByText('kept.txt')).toBeTruthy();
});
