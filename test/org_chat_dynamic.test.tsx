// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CentralLumiChat } from '../src/components/org/CentralLumiChat';
import { canAccessOrganizationWorkspaceView } from '../shared/org_workspace';

// The component, request correlation, delivery guard, history normalization and
// attachment lifecycle are real. Only context, transport and leaf renderers are
// fixtures: no backend, organization, model or file service is contacted.
const fixture = vi.hoisted(() => ({
  uid: 'user-a', role: 'user', orgId: 'org-a', orgRole: 'member', workDomain: 'work',
  available: true, net: vi.fn(), emit: vi.fn(), listeners: new Map<string, Set<Function>>(),
}));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({
  user: { uid: fixture.uid, role: fixture.role }, workDomain: fixture.workDomain,
  orgConnection: { orgId: fixture.orgId, orgRole: fixture.orgRole },
}) }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => fixture.available ? socket : null }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en', orgChat: 'Organization chat' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1] }));
vi.mock('../src/components/ChatMessageMarkdown', () => ({ ChatMessageMarkdown: ({ children }: any) => <div data-testid="message-body">{children}</div> }));
vi.mock('../src/components/ChatArtifactCards', () => ({ ChatArtifactCards: ({ files }: any) => <div data-testid="artifacts">{files.map((file: any) => file.name).join(',')}</div> }));
vi.mock('../src/components/ChatFilePreview', () => ({ ChatFilePreview: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const socket = {
  id: 'org-chat-fixture', emit: fixture.emit,
  on(name: string, callback: Function) {
    if (!fixture.listeners.has(name)) fixture.listeners.set(name, new Set());
    fixture.listeners.get(name)!.add(callback);
  },
  off: (name: string, callback: Function) => fixture.listeners.get(name)?.delete(callback),
};
const event = (name: string, data: unknown) => { for (const callback of fixture.listeners.get(name) || []) callback(data); };
const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const conversation = () => `${fixture.uid}-${fixture.orgId}-${fixture.orgRole}`;
const historyText = () => `History for ${conversation()}`;
const ready = () => screen.findByText(historyText());
const sendButton = () => screen.getByRole('textbox').nextElementSibling as HTMLButtonElement;
const draft = (text: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
function send(text = 'Explain the fixture policy') {
  draft(text);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  return fixture.emit.mock.calls.at(-1)?.[1]?.requestId as string;
}
function finish(requestId: string, text = 'The fixture policy permits a review.') {
  act(() => event('agent:response', { requestId, text, finalized: true, conversationId: conversation() }));
}
function defaultFetch(url: string) {
  if (url.includes('/active?')) return reply({ activeConversation: fixture.orgId ? { id: conversation() } : null });
  if (url.includes('/messages?')) return reply({ messages: [{ id: conversation(), role: 'user', content: historyText() }] });
  if (url === '/api/preferences/llm') return reply({ provider: 'fixture', model: 'offline' });
  throw new Error(`Unexpected fixture request: ${url}`);
}

beforeEach(() => {
  Object.assign(fixture, { uid: 'user-a', role: 'user', orgId: 'org-a', orgRole: 'member', workDomain: 'work', available: true });
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  fixture.net.mockImplementation(async (url: string) => defaultFetch(url));
  vi.stubGlobal('fetch', fixture.net);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.net.mockReset();
  fixture.emit.mockReset();
  fixture.listeners.clear();
});

it.each(['active', 'messages'])('history recovery shows the failed %s read and retries without sending a business turn', async stage => {
  let failing = true;
  fixture.net.mockImplementation(async (url: string) => {
    if (failing && url.includes(stage === 'active' ? '/active?' : '/messages?')) return reply({ error: 'Forbidden fixture history' }, 403);
    return defaultFetch(url);
  });
  render(<CentralLumiChat />); await screen.findByRole('alert'); expect(screen.queryByText(historyText())).toBeNull();
  failing = false; fireEvent.click(screen.getByRole('button', { name: 'Retry history' })); await ready();
  expect(screen.queryByRole('alert')).toBeNull(); expect(fixture.emit).not.toHaveBeenCalled();
});

it('loads older history and selects another authorized conversation without sending a model turn', async () => {
  fixture.net.mockImplementation(async (url: string) => {
    if(url.includes('/conversations?')) return reply({conversations:[{id:'other-conversation',displayTitle:'Earlier discussion'}],hasMore:false});
    if(url.endsWith('/other-conversation/activate')) return reply({conversation:{id:'other-conversation'}});
    if(url.includes('other-conversation/messages')) return reply({messages:[{id:'other-message',role:'user',content:'Other conversation source'}],hasMore:false});
    if(url.includes('/messages?')) return url.includes('&before=') ? reply({messages:[{id:'older-row',role:'user',content:'Older source'}],hasMore:false}) : reply({messages:[{id:'latest-row',role:'user',content:historyText()}],hasMore:true,nextCursor:'latest-row'});
    return defaultFetch(url);
  });
  render(<CentralLumiChat/>); await ready();
  fireEvent.click(screen.getByRole('button',{name:'Load older messages'})); await screen.findByText('Older source'); expect(screen.getByText(historyText())).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Organization conversations'})); fireEvent.click(await screen.findByRole('button',{name:'Earlier discussion'}));
  await screen.findByText('Other conversation source'); expect(screen.queryByText('Older source')).toBeNull(); expect(fixture.emit).not.toHaveBeenCalled();
});
it('stop control sends only the exact scoped abort request and waits for terminal evidence', async () => {
  render(<CentralLumiChat />); await ready(); const requestId = send('Long review');
  act(() => event('agent:chunk', { requestId, text: 'Partial review' })); draft('Keep next draft');
  const stop = screen.getByRole('button', { name: 'Stop this request' });
  act(() => { fireEvent.click(stop); fireEvent.click(stop); });
  const cancel = fixture.emit.mock.calls.filter(([name]) => name === 'agent:abort_chat'); expect(cancel).toHaveLength(1);
  expect(cancel[0][1]).toEqual({ requestId, source: 'org-chat', domain: 'work', orgId: 'org-a', conversationId: conversation() });
  act(() => cancel[0][2]({ ok: true, requestId, status: 'cancelling' }));
  expect(sendButton().disabled).toBe(true); expect(screen.getByText('Cancellation requested; waiting for the final result.')).toBeTruthy();
  act(() => event('agent:response', { requestId, text: 'Stopped by the fixture backend.', finalized: true, status: 'cancelled' }));
  expect(sendButton().disabled).toBe(false); expect(screen.getByRole('textbox')).toHaveProperty('value', 'Keep next draft');
  expect(screen.queryByRole('button', { name: 'Stop this request' })).toBeNull();
});
it('stop control permits retry after a denial and ignores its old acknowledgement after scope change', async () => {
  const view = render(<CentralLumiChat />); await ready(); const requestId = send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' })); const first = fixture.emit.mock.calls.at(-1)!;
  act(() => first[2]({ ok: false, requestId, error: 'Cancellation denied' }));
  expect(screen.getByText('Cancellation denied')).toBeTruthy(); expect(sendButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' })); expect(fixture.emit.mock.calls.filter(([name]) => name === 'agent:abort_chat')).toHaveLength(2);
  const old = fixture.emit.mock.calls.at(-1)!; fixture.orgId = 'org-b'; view.rerender(<CentralLumiChat />); await ready();
  send('New organization review'); act(() => old[2]({ ok: false, error: 'Stale cancellation denied' }));
  expect(screen.queryByText('Stale cancellation denied')).toBeNull();
});
it('stop control retains the active request and permits retry when no acknowledgement arrives', async () => {
  render(<CentralLumiChat />); await ready(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' }));
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.getByText('Cancellation was not confirmed. You can retry stopping this request.')).toBeTruthy();
  expect(sendButton().disabled).toBe(true); expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
});
it('stop control rejects a mismatched ACK and ignores an old ACK after the original terminal', async () => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' })); const first = fixture.emit.mock.calls.at(-1)!;
  act(() => first[2]({ ok: true, requestId: 'another-request' })); expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' })); const old = fixture.emit.mock.calls.at(-1)!;
  finish(requestId); send('Next request'); act(() => old[2]({ ok: false, error: 'Old terminal callback' }));
  expect(screen.queryByText('Old terminal callback')).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
});
it.each(['completed', 'cancelled', 'failed'])('terminal stop recovery requests the existing %s result instead of inventing a cancellation', async status => {
  render(<CentralLumiChat />); await ready(); const requestId = send('Recover existing result'); draft('Preserved next draft');
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' })); const abort = fixture.emit.mock.calls.at(-1)!;
  act(() => abort[2]({ ok: true, requestId, status }));
  const resumes = fixture.emit.mock.calls.filter(([name]) => name === 'agent:execution_resume'); expect(resumes).toHaveLength(1);
  expect(resumes[0][1]).toEqual(abort[1]);
  expect(sendButton().disabled).toBe(true); expect(screen.queryByText('Recovered final result')).toBeNull();
  act(() => resumes[0][2]({ ok: true, snapshot: { requestId, source: 'org-chat', conversationId: conversation(), terminal: true, status } }));
  expect(sendButton().disabled).toBe(true);
  act(() => event('agent:response', { requestId, text: 'Recovered final result', finalized: true, replayed: true }));
  expect(screen.getByText('Recovered final result')).toBeTruthy(); expect(sendButton().disabled).toBe(false);
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Preserved next draft');
  expect(screen.queryByRole('button', { name: 'Stop this request' })).toBeNull();
});
it('terminal stop recovery denial permits retry without releasing the unresolved request', async () => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' }));
  act(() => fixture.emit.mock.calls.at(-1)![2]({ ok: true, requestId, status: 'completed' }));
  const recoveryCall = fixture.emit.mock.calls.find(([name]) => name === 'agent:execution_resume'); expect(recoveryCall).toBeTruthy();
  act(() => recoveryCall![2]({ ok: false, error: 'Workspace access is unavailable.' }));
  expect(screen.getByText('Workspace access is unavailable.')).toBeTruthy(); expect(sendButton().disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
});
it('terminal stop recovery remains retryable if its successful ACK has no terminal replay', async () => {
  render(<CentralLumiChat />); await ready(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const requestId = send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' }));
  act(() => fixture.emit.mock.calls.at(-1)![2]({ ok: true, requestId, status: 'completed' }));
  const recoveryCall = fixture.emit.mock.calls.find(([name]) => name === 'agent:execution_resume'); expect(recoveryCall).toBeTruthy();
  act(() => recoveryCall![2]({ ok: true, snapshot: { requestId, source: 'org-chat', conversationId: conversation(), terminal: true } }));
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.getByText('The final result could not be recovered. You can retry.')).toBeTruthy();
  expect(sendButton().disabled).toBe(true); expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
});
it('terminal stop recovery rejects an unrelated snapshot and ignores stale callbacks after scope change', async () => {
  const view = render(<CentralLumiChat />); await ready(); const requestId = send();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' }));
  act(() => fixture.emit.mock.calls.at(-1)![2]({ ok: true, requestId, status: 'completed' }));
  const recoveryCall = fixture.emit.mock.calls.find(([name]) => name === 'agent:execution_resume'); expect(recoveryCall).toBeTruthy();
  act(() => recoveryCall![2]({ ok: true, snapshot: { requestId: 'wrong-request', source: 'org-chat', terminal: true } }));
  expect(screen.getByRole('button', { name: 'Stop this request' })).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Stop this request' }));
  act(() => fixture.emit.mock.calls.at(-1)![2]({ ok: true, requestId, status: 'completed' })); const old = fixture.emit.mock.calls.at(-1)!;
  fixture.orgId = 'org-b'; view.rerender(<CentralLumiChat />); await ready(); send('New scope request');
  act(() => old[2]({ ok: false, error: 'Stale recovery failure' }));
  act(() => event('agent:response', { requestId, text: 'Stale recovered result', finalized: true, replayed: true }));
  expect(screen.queryByText('Stale recovery failure')).toBeNull(); expect(screen.queryByText('Stale recovered result')).toBeNull();
});
it('history recovery cannot overwrite a turn sent while the retry read was pending', async () => {
  fixture.net.mockImplementation(async (url: string) => url.includes('/active?') ? reply({}, 503) : defaultFetch(url));
  render(<CentralLumiChat />); await screen.findByRole('alert');
  let resolve!: (value: any) => void; const pending = new Promise<any>(done => { resolve = done; });
  fixture.net.mockImplementation(async (url: string) => url.includes('/active?') ? pending : defaultFetch(url));
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' })); const requestId = send('Current visible turn');
  await act(async () => resolve(reply({ activeConversation: { id: 'obsolete-retry' } })));
  expect(fixture.net.mock.calls.some(([url]) => String(url).includes('obsolete-retry'))).toBe(false);
  expect(screen.getByText('Current visible turn')).toBeTruthy(); finish(requestId);
});

it.each(['owner', 'admin', 'member', 'viewer'])('sends within the selected organization for allowed %s chat access', async role => {
  fixture.orgRole = role;
  expect(canAccessOrganizationWorkspaceView(role, 'chat')).toBe(true);
  render(<CentralLumiChat />); await ready();
  const requestId = send('  Explain this policy  ');
  expect(requestId).toMatch(/^org_chat_/);
  expect(fixture.emit).toHaveBeenCalledExactlyOnceWith('agent:chat', expect.objectContaining({
    text: 'Explain this policy', domain: 'work', orgId: 'org-a', category: 'organization',
    source: 'org-chat', agentId: 'lumi', history: [{ role: 'user', content: historyText() }], attachments: [],
  }));
  expect(fixture.emit.mock.calls[0][1]).not.toHaveProperty('orgRole');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  finish(requestId); expect(screen.getByText('The fixture policy permits a review.')).toBeTruthy();
});

it('requires an organization binding before emitting or uploading', async () => {
  fixture.orgId = '';
  render(<CentralLumiChat />); await act(async () => {});
  send();
  expect(fixture.emit).not.toHaveBeenCalled();
  expect(screen.getByText('please-connect-or-switch-to')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['fixture'], 'unbound.txt')] } });
  await act(async () => {});
  expect(fixture.net.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('keeps the draft and shows an unavailable channel without emitting when the socket is absent', async () => {
  fixture.available = false;
  render(<CentralLumiChat />); await ready();
  send('Keep this unsent question');
  expect(fixture.emit).not.toHaveBeenCalled();
  expect(screen.getByText('the-organization-chat-channel-is')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep this unsent question');
});

it.each([
  ['active', '403'], ['active', 'rejected'], ['active', 'invalid-json'],
  ['messages', '403'], ['messages', 'rejected'], ['messages', 'invalid-json'],
])('keeps sending usable and excludes failed %s history after %s', async (stage, failure) => {
  let handled = false;
  fixture.net.mockImplementation(async (url: string) => {
    if (url.includes(stage === 'active' ? '/active?' : '/messages?')) {
      handled = true;
      if (failure === 'rejected') throw new Error('Fixture history unavailable');
      if (failure === 'invalid-json') return { ok: true, json: async () => { throw new SyntaxError('Fixture invalid JSON'); } };
      return reply({ activeConversation: { id: 'forbidden' }, messages: [{ role: 'user', content: 'Forbidden history' }] }, 403);
    }
    return defaultFetch(url);
  });
  render(<CentralLumiChat />); await waitFor(() => expect(handled).toBe(true)); await act(async () => {});
  expect(screen.queryByText('Forbidden history')).toBeNull();
  const requestId = send();
  expect(fixture.emit.mock.calls[0][1].history).toEqual([]);
  finish(requestId); expect(screen.getByText('The fixture policy permits a review.')).toBeTruthy();
});

it('normalizes history, hides tool and attachment metadata, and sends only visible user/assistant turns', async () => {
  fixture.net.mockImplementation(async (url: string) => url.includes('/messages?') ? reply({ messages: [
    { id: 'u', role: 'user', content: 'Visible question\n[Attachments]\nPrivate attachment metadata' },
    { id: 'a', role: 'assistant', content: 'Visible historical answer.' },
    { id: 't', role: 'tool', content: 'Private tool payload' },
    { id: 's', role: 'system', content: 'Private system payload' },
  ] }) : defaultFetch(url));
  render(<CentralLumiChat />); await screen.findByText('Visible historical answer.');
  expect(screen.queryByText(/Private/)).toBeNull();
  send();
  expect(fixture.emit.mock.calls[0][1].history).toEqual([
    { role: 'user', content: 'Visible question' }, { role: 'assistant', content: 'Visible historical answer.' },
  ]);
});

it('correlates chunks and final receipts, updates one bubble, and projects final artifact props', async () => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  act(() => {
    event('agent:chunk', { requestId: 'other', text: 'An unrelated stream must stay hidden.' });
    event('agent:error', { requestId: 'other', message: 'Unrelated error' });
    event('agent:status', { requestId: 'other', status: 'idle' });
    event('agent:response', { requestId: 'other', text: 'Unrelated response', finalized: true });
    event('agent:chunk', { requestId, text: 'The first part of the policy. ' });
    event('agent:chunk', { requestId, text: 'The second part.' });
  });
  expect(screen.getAllByText('The first part of the policy. The second part.')).toHaveLength(1);
  expect(screen.queryByText(/Unrelated|unrelated/)).toBeNull();
  act(() => event('agent:response', { requestId, text: 'Final policy answer.', finalized: true,
    fileArtifacts: [{ id: 'file-1', name: 'fixture-policy.txt' }], conversationId: conversation() }));
  expect(screen.getAllByText('Final policy answer.')).toHaveLength(1);
  expect(screen.queryByText(/The first part/)).toBeNull();
  expect(screen.getByText('fixture-policy.txt')).toBeTruthy();
  act(() => event('agent:chunk', { requestId, text: 'A duplicate after completion is ignored.' }));
  expect(screen.queryByText(/duplicate after/)).toBeNull();
  send('Next question'); expect(fixture.emit).toHaveBeenCalledTimes(2);
});

it.each(['blocked', 'waiting_confirmation'])('shows the %s receipt without presenting it as a completed operation', async status => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  const text = status === 'blocked' ? 'The file was written, but readback failed.' : 'Please confirm before sending this fixture message.';
  act(() => event('agent:response', { requestId, status, text }));
  expect(screen.getAllByText(text)).toHaveLength(1);
  send('Another question'); expect(fixture.emit).toHaveBeenCalledTimes(2);
});

it('suppresses unverified success and removes its stream preview', async () => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  act(() => event('agent:chunk', { requestId, text: 'A preliminary answer that must be replaced.' }));
  act(() => event('agent:response', { requestId, text: 'I sent the message.', finalized: false }));
  expect(screen.queryByText('I sent the message.')).toBeNull();
  expect(screen.queryByText(/preliminary answer/)).toBeNull();
  send('Try another question'); expect(fixture.emit).toHaveBeenCalledTimes(2);
});

it.each(['error', 'cancelled'])('releases the active request after %s without leaking an error into later history', async terminal => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  act(() => event('agent:chunk', { requestId, text: 'This is a provisional policy response.' }));
  act(() => event(terminal === 'error' ? 'agent:error' : 'agent:status', { requestId, status: terminal, message: 'Fixture permission denied' }));
  if (terminal === 'error') expect(screen.getByText('Fixture permission denied')).toBeTruthy();
  else expect(screen.queryByText(/provisional policy/)).toBeNull();
  send('Follow-up');
  expect(fixture.emit).toHaveBeenCalledTimes(2);
  expect(fixture.emit.mock.calls[1][1].history.every((turn: any) => !turn.content.includes('Fixture permission denied'))).toBe(true);
});

it.each(['uid', 'orgId', 'orgRole', 'role', 'workDomain'] as const)('isolates active socket callbacks and drafts after a %s context change', async key => {
  const view = render(<CentralLumiChat />); await ready(); const oldRequest = send('Old scope question');
  const oldCallbacks = new Map([...fixture.listeners].map(([name, callbacks]) => [name, [...callbacks]]));
  draft('Old draft');
  fixture[key] = key === 'orgRole' ? 'viewer' : key === 'role' ? 'admin' : key === 'workDomain' ? 'personal' : `${fixture[key]}-new`;
  view.rerender(<CentralLumiChat />); await ready();
  expect(screen.queryByText('Old scope question')).toBeNull();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  const currentRequest = send('New scope question');
  const reads = fixture.net.mock.calls.length;
  act(() => {
    for (const [name, callbacks] of oldCallbacks) for (const callback of callbacks) callback({
      requestId: name === 'agent:chunk' ? currentRequest : oldRequest,
      text: 'Stale scope response must never appear.', message: 'Stale scope error', status: 'idle',
      agentId: 'lumi', conversationId: 'stale-conversation', rolledOver: true,
    });
  });
  expect(fixture.net).toHaveBeenCalledTimes(reads);
  expect(screen.queryByText(/Stale scope/)).toBeNull();
  expect(fixture.emit.mock.calls[1][1]).toMatchObject({ orgId: fixture.orgId, history: [{ role: 'user', content: historyText() }] });
  finish(currentRequest); expect(screen.getByText('The fixture policy permits a review.')).toBeTruthy();
});

it('unsubscribes on unmount and ignores retained socket handlers including timeout work', async () => {
  const view = render(<CentralLumiChat />); await ready();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const requestId = send(); const callbacks = [...fixture.listeners.values()].flatMap(set => [...set]);
  view.unmount();
  expect([...fixture.listeners.values()].every(set => set.size === 0)).toBe(true);
  const reads = fixture.net.mock.calls.length;
  act(() => {
    callbacks.forEach(callback => callback({ requestId, text: 'Late unmounted reply', message: 'Late error', status: 'idle', agentId: 'lumi', conversationId: 'late' }));
    vi.advanceTimersByTime(61000);
  });
  expect(fixture.net).toHaveBeenCalledTimes(reads);
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it.each(['initial', 'streaming', 'timeout'])('keeps one request active during %s and still accepts its late final receipt', async phase => {
  render(<CentralLumiChat />); await ready();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const requestId = send('First question');
  if (phase === 'streaming') act(() => event('agent:chunk', { requestId, text: 'A partial response while the request remains active.' }));
  if (phase === 'timeout') {
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByText('lumi-is-taking-longer-than')).toBeTruthy();
  }
  draft('Keep this next question as a draft');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  expect(sendButton().disabled).toBe(true);
  finish(requestId, 'Late final policy answer.');
  expect(screen.getByText('Late final policy answer.')).toBeTruthy();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep this next question as a draft');
  expect(sendButton().disabled).toBe(false);
  fireEvent.click(sendButton()); expect(fixture.emit).toHaveBeenCalledTimes(2);
});

it('rejects same-tick Enter and button submission before a rerender can disable the composer', async () => {
  render(<CentralLumiChat />); await ready(); draft('Submit this once');
  act(() => {
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(sendButton());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  });
  expect(fixture.emit).toHaveBeenCalledTimes(1);
  finish(fixture.emit.mock.calls[0][1].requestId);
  send('The next request'); expect(fixture.emit).toHaveBeenCalledTimes(2);
});

it.each(['idle', 'empty-response', 'unverified-response'])('refreshes the composer when %s silently clears a buffered stream', async terminal => {
  render(<CentralLumiChat />); await ready(); const requestId = send();
  act(() => event('agent:chunk', { requestId, text: 'Short' }));
  draft('Keep the next draft');
  act(() => {
    if (terminal === 'idle') event('agent:status', { requestId, status: 'idle' });
    else event('agent:response', { requestId, text: terminal === 'empty-response' ? '' : 'I sent the message.', finalized: false });
  });
  expect(sendButton().disabled).toBe(false);
  expect(screen.queryByText('I sent the message.')).toBeNull();
  fireEvent.click(sendButton()); expect(fixture.emit).toHaveBeenCalledTimes(2);
});
