// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteMCPSettings } from './RemoteMCPSettings';
import { ContactsPanel } from './ContactsPanel';
import { PersonalityEditor } from './PersonalityEditor';
import { KnowledgeBaseEditor } from './org/KnowledgeBaseEditor';
import { TokenDashboard } from './TokenDashboard';
import { OrgMembers } from './org/OrgMembers';
import { GitHubMCPBrowser } from './GitHubMCPBrowser';
import { ReminderPanel } from './ReminderPanel';
import { VoiceProviderSwitch } from './VoiceProviderSwitch';
import { VoiceDeviceSelector } from './VoiceDeviceSelector';
import { setVoiceDevicePreference, VOICE_DEVICE_PREFERENCE_CHANGED } from '../lib/voiceDevicePreferences';
import { useLumiOfficialCatalog } from '../hooks/useLumiOfficialCatalog';
import { VOICE_PROVIDER_CHANGED_EVENT } from '../services/voiceService';
import { KnowledgeBase } from './KnowledgeBase';
import { MCPSettings } from './MCPSettings';
import { DeviceSyncCenter } from './DeviceSyncCenter';
import { usePlatform } from '../hooks/usePlatform';
import { LegalDataSourcesSettings } from './org/LegalDataSourcesSettings';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { getSavedKeyStatus, saveServerKeys } from '../services/settingsKeys';
import { apiFetch, apiJson } from '../services/apiClient';
import { getPersonalClientSurfaceByAction } from '../../shared/client_surfaces';
import { LUMI_OFFICIAL_BASE_URL, normalizeLumiOfficialBaseUrl } from '../../shared/model_provider_capabilities';
import { extractSourceExpression } from '../../test/source_expression';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), success: vi.fn(), on: vi.fn(), off: vi.fn() }));
const socketState = vi.hoisted(() => ({ enabled: true, registration: { status: 'disconnected' } }));
const account = vi.hoisted(() => ({ user: { uid: 'synthetic-user', role: 'admin' } as { uid: string; role: string; orgId?: string } | null, workDomain: 'personal' as 'personal' | 'work', orgConnection: null as { orgId: string } | null }));
vi.mock('@/contexts/AppContext', () => ({ useApp: () => account }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn() } }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => socketState.enabled ? mocks : null }));
vi.mock('@/services/socketService', () => ({ socketService: {
  getSocket: () => mocks,
  getDeviceRegistration: () => socketState.registration,
  subscribeDeviceRegistration: () => () => {},
} }));
vi.mock('./NodeDetailPanel', () => ({ NodeDetailPanel: () => null }));
vi.mock('./PersonalityEvolution', () => ({ PersonalityEvolution: ({ personalityId }: any) => <div data-testid="evolution-owner">{personalityId}</div> }));
vi.mock('./MemoryTree', () => ({
  layoutTree3D: (_memories: any[], files: any[]) => ({ nodes: files.map(file => ({ id: file.id, name: file.name })), curves: [] }),
  MemoryTreeScene: ({ nodes }: any) => <div data-testid="knowledge-tree">{nodes.map((node: any) => node.name).join(',')}</div>,
}));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { socketState.enabled = true; account.user = { uid: 'synthetic-user', role: 'admin' }; account.workDomain = 'personal'; account.orgConnection = null; localStorage.clear(); for (const mock of Object.values(mocks)) mock.mockReset(); vi.stubGlobal('fetch', mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function apiKeyField(name = 'ApiKeyField') {
  const deps: any = { React, useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback,
    useApp: () => ({ ...account, aiConfig: { provider: 'openai', model: 'model-a' }, updateAIConfig: async () => true }), AbortController, AbortSignal, localStorage, window, Event, CustomEvent, getSavedKeyStatus, saveServerKeys, apiFetch, uiMessage, formatUiMessage, toast: mocks,
    LUMI_OFFICIAL_BASE_URL, normalizeLumiOfficialBaseUrl,
    SettingsDisclosure: ({ children, badges }: any) => <div>{badges}{children}</div>, Button: ({ variant, ...props }: any) => <button {...props} />,
    Loader2: () => null, ExternalLink: () => null, Globe: () => null };
  for (const key of ['LUMI_RELAY_BASE_URL_PLACEHOLDER', 'readStoredRelayBaseUrl', 'useModelOperation', 'useServerCredentials', 'ModelSettingsStatus', 'runModelConnectionTest', 'useProviderModel', 'ServerApiKeyField', 'ApiKeyField', 'LLMProviderEditor', 'LLMProviderRow', 'RelayProviderEditor', 'RelayProviderRow']) deps[key] = extractSourceExpression('src/components/Settings.tsx', key, deps);
  if (name === 'OfficialProviderSettings') {
    Object.assign(deps, { SettingsSection: ({ children }: any) => <div>{children}</div>, RelayProviderRow: () => null, LumiOfficialCapabilityBadge: () => null, useLumiOfficialCatalog: () => null, Sparkle: () => null, Zap: () => null, LUMI_OFFICIAL_RECHARGE_URL: 'https://synthetic.invalid/recharge', LUMI_OFFICIAL_DOCS_URL: 'https://synthetic.invalid/docs' });
    for (const key of ['LUMI_OFFICIAL_APPLY_LABEL_KEY', 'LUMI_OFFICIAL_APPLY_DESCRIPTION_KEY', 'LUMI_OFFICIAL_APPLY_NOT_CONFIGURED_KEY', 'LUMI_OFFICIAL_APPLY_SUCCESS_KEY', 'LUMI_OFFICIAL_APPLY_PARTIAL_KEY', 'LUMI_OFFICIAL_APPLY_FAILED_KEY', 'LUMI_OFFICIAL_ADAPTER_UNAVAILABLE_KEY', 'LUMI_OFFICIAL_CONFIG_NOT_READY_KEY', 'lumiOfficialRoleReason', 'applyOfficialModelRoles', name]) deps[key] = extractSourceExpression('src/components/Settings.tsx', key, deps);
  }
  return deps[name];
}
const keyProps = { icon: null, label: 'Synthetic provider', placeholder: 'Synthetic key', storageKey: 'legacy-test-key', serverKey: 'DOUBAO_SPEECH_KEY', testEndpoint: '/api/voice/doubao/probe', t: { save: 'Save key', remove: 'Remove key' } };

describe('business views wait for the owning backend result', () => {
  it('updates members only from confirmed receipts using user IDs and retains failed inputs', async () => {
    account.orgConnection = { orgId: 'org/a' }; localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const member = (userId: string) => ({ id: 'membership-' + userId, orgId: 'org/a', userId, role: 'member', status: 'active', joinedAt: null });
    mocks.fetch.mockResolvedValueOnce(reply([member('User/a')])); const view = render(<OrgMembers />); await screen.findByText('User/a'); expect(mocks.fetch.mock.calls[0][0]).toContain('/org%2Fa/members');
    const input = screen.getByRole('textbox'), add = screen.getByRole('button', { name: uiMessage('org-members.add.cd6f2f52ff') }), pending = deferred<any>();
    fireEvent.change(input, { target: { value: ' User/b ' } }); mocks.fetch.mockReturnValueOnce(pending.promise); act(() => { fireEvent.click(add); fireEvent.click(add); }); expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const init = mocks.fetch.mock.calls.at(-1)![1]; expect(JSON.parse(init.body)).toEqual({ userId: 'User/b', role: 'member' }); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof'); expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => pending.resolve(reply({ error: 'Invite denied' }, 403))); await screen.findByText('Invite denied'); expect(input).toHaveProperty('value', ' User/b ');
    mocks.fetch.mockResolvedValueOnce(reply({ ...member('User/b'), orgId: 'wrong-org' })); fireEvent.click(add); await screen.findByText('Save was not confirmed'); expect(screen.queryByText('User/b')).toBeNull();
    mocks.fetch.mockResolvedValueOnce(reply(member('User/b'))); fireEvent.click(add); await screen.findByText('User/b'); expect(input).toHaveProperty('value', ''); expect(screen.getByText(uiMessage('org-members.member-added-to-the-organization.ccd3f9eeaa'))).toBeTruthy(); expect(mocks.fetch).toHaveBeenCalledTimes(4);
    const remove = () => fireEvent.click(screen.getAllByTitle(uiMessage('org-members.remove-member.9443c64435'))[0]);
    const confirm = () => fireEvent.click(screen.getByRole('button', { name: uiMessage('org-members.remove.78190c6054') }));
    mocks.fetch.mockResolvedValueOnce(reply({ ok: true })); remove(); confirm(); await screen.findByText('Deletion was not confirmed'); expect(screen.getByText('User/a')).toBeTruthy();
    mocks.fetch.mockResolvedValueOnce(reply({ success: true })); remove(); confirm(); await waitFor(() => expect(screen.queryByText('User/a')).toBeNull()); expect(screen.getByText('User/b')).toBeTruthy();
    expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('/members/User%2Fa'); expect(mocks.fetch.mock.calls.at(-1)![1].method).toBe('DELETE'); expect(mocks.fetch).toHaveBeenCalledTimes(6);
  });

  it('cancels old member reads, invitations and confirmations after organization or account changes', async () => {
    const member = (orgId: string) => ({ id: orgId + '-membership', orgId, userId: orgId + '-member', role: 'member', status: 'active', joinedAt: null }), old = deferred<any>();
    account.orgConnection = { orgId: 'org-a' }; mocks.fetch.mockReturnValueOnce(old.promise); const view = render(<OrgMembers />), signal = mocks.fetch.mock.calls[0][1].signal;
    account.orgConnection = { orgId: 'org-b' }; mocks.fetch.mockResolvedValue(reply([member('org-b')])); view.rerender(<OrgMembers />); await screen.findByText('org-b-member'); await act(async () => old.resolve(reply([member('org-a')]))); expect(signal.aborted).toBe(true); expect(screen.queryByText('org-a-member')).toBeNull();
    act(() => { fireEvent.click(screen.getByTitle(uiMessage('org-members.remove-member.9443c64435'))); fireEvent.click(screen.getByTitle(uiMessage('org-members.remove-member.9443c64435'))); }); expect(screen.getAllByRole('button', { name: uiMessage('org-members.remove.78190c6054') })).toHaveLength(1);
    const obsoleteConfirm = screen.getByRole('button', { name: uiMessage('org-members.remove.78190c6054') });
    account.orgConnection = { orgId: 'org-c' }; mocks.fetch.mockResolvedValue(reply([member('org-c')])); view.rerender(<OrgMembers />); await screen.findByText('org-c-member');
    expect(screen.queryByRole('alertdialog')).toBeNull(); await act(async () => fireEvent.click(obsoleteConfirm)); expect(mocks.fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false);
    const write = deferred<any>(); mocks.fetch.mockReturnValueOnce(write.promise); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'late-invite' } }); fireEvent.click(screen.getByRole('button', { name: uiMessage('org-members.add.cd6f2f52ff') })); const writeSignal = mocks.fetch.mock.calls.at(-1)![1].signal;
    account.user = { uid: 'another-account', role: 'user' }; mocks.fetch.mockResolvedValue(reply([])); view.rerender(<OrgMembers />); await waitFor(() => expect(screen.queryByText('org-c-member')).toBeNull()); await act(async () => write.resolve(reply({ ...member('org-c'), userId: 'late-invite' }))); expect(writeSignal.aborted).toBe(true); expect(screen.queryByText('late-invite')).toBeNull(); expect(screen.getByRole('textbox')).toHaveProperty('value', '');
    account.user = null; view.rerender(<OrgMembers />); expect(view.container.textContent).toBe('');
  });

  it('retries organization discovery and rejects malformed member lists without hiding confirmed rows', async () => {
    mocks.fetch.mockResolvedValue(reply([])); render(<React.StrictMode><OrgMembers /></React.StrictMode>); await screen.findByText(uiMessage('org-members.no-organization-found.90a2ad4211'));
    mocks.fetch.mockResolvedValueOnce(reply({ ok: true })); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') })); await screen.findByText('Invalid collection response');
    mocks.fetch.mockResolvedValueOnce(reply([{ id: 'discovered' }])).mockResolvedValue(reply([{ id: 'membership', orgId: 'discovered', userId: 'Visible member', role: 'owner', status: 'active', joinedAt: null }])); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') })); await screen.findByText('Visible member');
    mocks.fetch.mockResolvedValueOnce(reply({ members: [] })); fireEvent.click(screen.getByRole('button', { name: uiMessage('org-members.refresh.cba212b169') })); await screen.findByText('Invalid collection response'); expect(screen.getByText('Visible member')).toBeTruthy(); expect(screen.queryByText(uiMessage('org-members.no-members-yet-add-members.e1e3de9dd0'))).toBeNull();
  });

  it('separates failed MCP searches from empty results and ignores an obsolete source', async () => {
    const old = deferred<any>(), result = { id: 'npm-a', name: 'Npm candidate', stars: 0, url: 'https://www.npmjs.com/package/synthetic', description: null, language: null, topics: [] };
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); mocks.fetch.mockReturnValueOnce(old.promise); render(<GitHubMCPBrowser />); expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' synthetic & test ' } }); fireEvent.click(screen.getByRole('button', { name: 'Search' })); const init = mocks.fetch.mock.calls[0][1]; expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(mocks.fetch.mock.calls[0][0]).toContain('q=synthetic%20%26%20test');
    fireEvent.click(screen.getByRole('button', { name: 'npm' })); mocks.fetch.mockResolvedValueOnce(reply({ results: [result] })); fireEvent.click(screen.getByRole('button', { name: 'Search' })); await screen.findByText('Npm candidate'); expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('/mcp/npm/search');
    await act(async () => old.resolve(reply({ results: [{ ...result, name: 'Obsolete Github' }] }))); expect(init.signal.aborted).toBe(true); expect(screen.queryByText('Obsolete Github')).toBeNull(); expect(screen.getByRole('link')).toHaveProperty('href', result.url);
    for (const response of [reply({ error: 'Search denied' }, 403), reply({ results: [{ ...result, url: 'javascript:alert(1)' }] })]) {
      mocks.fetch.mockResolvedValueOnce(response); fireEvent.click(screen.getByRole('button', { name: 'Search' })); await screen.findByRole('alert'); expect(screen.queryByText('No MCP servers found')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
    }
    mocks.fetch.mockResolvedValueOnce(reply({ results: [] })); fireEvent.click(screen.getByRole('button', { name: 'Search' })); await screen.findByText('No MCP servers found'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves MCP sorting and filters while superseding searches and isolating accounts', async () => {
    const result = (id: number, language: string) => ({ id, name: 'Candidate ' + id, stars: id, url: 'https://github.com/synthetic/' + id, description: '', language, topics: ['mcp'] });
    mocks.fetch.mockResolvedValue(reply({ results: [result(1, 'Python'), result(2, 'TypeScript')] })); const view = render(<GitHubMCPBrowser embedded />), input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'first' } }); fireEvent.keyDown(input, { key: 'Enter' }); await screen.findByText('Candidate 2'); expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([result(2, '').url, result(1, '').url]);
    fireEvent.click(screen.getByRole('button', { name: 'Stars' })); expect(screen.getAllByRole('link')[0]).toHaveProperty('href', result(1, '').url); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Python' } }); expect(screen.queryByText('Candidate 2')).toBeNull();
    const previous = deferred<any>(), latest = deferred<any>(); mocks.fetch.mockReturnValueOnce(previous.promise).mockReturnValueOnce(latest.promise); fireEvent.keyDown(input, { key: 'Enter' }); const oldSignal = mocks.fetch.mock.calls.at(-1)![1].signal;
    fireEvent.change(input, { target: { value: 'latest' } }); fireEvent.keyDown(input, { key: 'Enter' }); const newSignal = mocks.fetch.mock.calls.at(-1)![1].signal; await act(async () => previous.resolve(reply({ results: [result(3, 'Python')] }))); expect(oldSignal.aborted).toBe(true); expect(screen.queryByText('Candidate 3')).toBeNull();
    account.user = { uid: 'other-search-user', role: 'user' }; view.rerender(<GitHubMCPBrowser embedded />); await act(async () => latest.resolve(reply({ results: [result(4, 'Python')] }))); expect(newSignal.aborted).toBe(true); expect(screen.queryByText('Candidate 4')).toBeNull(); expect(screen.getByRole('textbox')).toHaveProperty('value', '');
    account.user = null; view.rerender(<GitHubMCPBrowser />); expect(view.container.textContent).toBe('');
  });

  it('saves one knowledge draft only after a valid receipt and preserves failed edits', async () => {
    const saved = vi.fn(), changed = vi.fn(), pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const view = render(<KnowledgeBaseEditor onSaved={saved} />), [title, tags, content] = screen.getAllByRole('textbox'), save = view.container.querySelector('button.lumi-button-primary')!;
    fireEvent.change(title, { target: { value: ' Draft title ' } }); fireEvent.change(content, { target: { value: ' Draft body ' } }); fireEvent.change(tags, { target: { value: 'tag, tag, second' } });
    window.addEventListener('lumi:knowledge-updated', changed);
    try {
      act(() => { fireEvent.click(save); fireEvent.click(save); }); expect(mocks.fetch).toHaveBeenCalledOnce(); expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
      const init = mocks.fetch.mock.calls[0][1]; expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof'); expect(JSON.parse(init.body)).toEqual({ title: 'Draft title', content: 'Draft body', category: 'general', tags: ['tag', 'second'], status: 'draft' });
      expect(saved).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); await act(async () => pending.resolve(reply({ error: 'Save denied' }, 403))); await screen.findByText('Save denied'); expect(title).toHaveProperty('value', ' Draft title ');
      mocks.fetch.mockResolvedValueOnce(reply({ ok: true })); fireEvent.click(save); await screen.findByText('Article response was not confirmed'); expect(saved).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
      mocks.fetch.mockResolvedValueOnce(reply({ id: 'created', ...JSON.parse(init.body) })); fireEvent.click(save); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
      expect(title).toHaveProperty('value', ''); expect(tags).toHaveProperty('value', ''); expect(changed.mock.calls[0][0].detail.articleId).toBe('created'); expect(mocks.success).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('lumi:knowledge-updated', changed); }
  });

  it('owns article reads and saves across strict remounts, article changes and organization changes', async () => {
    const article = { id: 'a/b', title: 'Loaded title', content: 'Loaded content', category: 'general', status: 'draft', tags: '["one"]' }, old = deferred<any>(), saved = vi.fn(), changed = vi.fn();
    mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(reply(article)); const page = (id?: string) => <React.StrictMode><KnowledgeBaseEditor articleId={id} onSaved={saved} /></React.StrictMode>;
    const view = render(page(article.id)); await screen.findByDisplayValue('Loaded title'); expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('/a%2Fb');
    await act(async () => old.resolve(reply({ ...article, title: 'Obsolete title' }))); expect(screen.queryByDisplayValue('Obsolete title')).toBeNull();
    const write = deferred<any>(); mocks.fetch.mockReturnValueOnce(write.promise); window.addEventListener('lumi:knowledge-updated', changed);
    try {
      fireEvent.click(view.container.querySelector('button.lumi-button-primary')!); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
      account.workDomain = 'work'; account.orgConnection = { orgId: 'new-org' }; mocks.fetch.mockResolvedValue(reply({ ...article, title: 'New organization' })); view.rerender(page(article.id)); await screen.findByDisplayValue('New organization');
      await act(async () => write.resolve(reply(article))); expect(signal.aborted).toBe(true); expect(saved).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
      mocks.fetch.mockResolvedValue(reply({ error: 'Read denied' }, 403)); view.rerender(page('other')); await screen.findByText('Read denied'); expect(screen.queryByRole('textbox')).toBeNull();
      mocks.fetch.mockResolvedValue(reply({ ...article, id: 'other' })); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') })); await screen.findByDisplayValue('Loaded title');
      view.rerender(page()); expect(screen.queryByDisplayValue('Loaded title')).toBeNull(); expect(screen.getAllByRole('textbox')[0]).toHaveProperty('value', ''); account.user = null; view.rerender(page()); expect(view.container.textContent).toBe('');
    } finally { window.removeEventListener('lumi:knowledge-updated', changed); }
  });

  it('polls usage only after completion, surfaces failure, retries and stops after closing', async () => {
    vi.useFakeTimers(); const first = deferred<any>(), second = deferred<any>(), data = { byProvider: { Synthetic: { totalTokens: 10, calls: 1 } }, daily: [], grandTotal: 10, recordCount: 1 };
    mocks.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(reply(data)); const view = render(<TokenDashboard />);
    try {
      await act(() => vi.advanceTimersByTimeAsync(20_000)); expect(mocks.fetch).toHaveBeenCalledOnce(); await act(async () => first.resolve(reply(data))); expect(screen.getByText('Synthetic')).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(mocks.fetch).toHaveBeenCalledTimes(2); await act(() => vi.advanceTimersByTimeAsync(20_000)); expect(mocks.fetch).toHaveBeenCalledTimes(2);
      await act(async () => second.resolve(reply({ error: 'Usage denied' }, 403))); expect(screen.getByRole('alert').textContent).toBe('Usage denied'); expect(screen.queryByText('Synthetic')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(screen.getByText('Synthetic')).toBeTruthy(); const count = mocks.fetch.mock.calls.length; view.unmount(); await act(() => vi.advanceTimersByTimeAsync(30_000)); expect(mocks.fetch).toHaveBeenCalledTimes(count);
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it('ignores usage results from an older time range or account and permits manual retry', async () => {
    const pending = deferred<any>(), data = (name: string) => ({ byProvider: { [name]: { totalTokens: 10, calls: 1 } }, daily: [], grandTotal: 10, recordCount: 1 });
    mocks.fetch.mockReturnValueOnce(pending.promise).mockResolvedValue(reply(data('Seven days'))); const view = render(<TokenDashboard />), signal = mocks.fetch.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole('button', { name: '7' + uiMessage('token-dashboard.d.a2698d0e7d') })); await screen.findByText('Seven days'); expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('days=7');
    await act(async () => pending.resolve(reply(data('Old thirty days')))); expect(signal.aborted).toBe(true); expect(screen.queryByText('Old thirty days')).toBeNull();
    mocks.fetch.mockResolvedValueOnce(reply({ byProvider: {}, daily: 'invalid' })); fireEvent.click(screen.getByRole('button', { name: uiMessage('settings.refresh.cba212b169') })); await screen.findByRole('alert'); expect(screen.queryByText('Seven days')).toBeNull();
    mocks.fetch.mockResolvedValue(reply(data('New account'))); account.user = { uid: 'usage-b', role: 'user' }; view.rerender(<TokenDashboard />); await screen.findByText('New account'); expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('days=30');
    account.user = null; view.rerender(<TokenDashboard />); expect(view.container.textContent).toBe('');
  });

  it('keeps contacts accessible after personality failure and isolates retried configuration by account', async () => {
    const config = { id: 'lumi', name: 'Private configuration A', version: '1', coreMotivation: 'test', behavioralBoundaries: [], expressionStyle: { persona: 'test', tone: 'warm', verbosity: 'concise', languages: ['zh'] }, toolPolicy: {}, memoryPolicy: { includeTypes: [] }, personalityVector: { cognitiveStyle: { analytical: 0.5 }, socialStyle: { warmth: 0.7 } } };
    mocks.fetch.mockImplementation(async url => url.endsWith('/personalities') ? reply({ error: 'Personality denied' }, 403) : reply({ contacts: [] }));
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); const view = render(<PersonalityEditor t={{ contacts: 'Contacts tab', lumiCore: 'Core tab' }} />); await screen.findByRole('alert');
    expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer synthetic-token');
    fireEvent.click(screen.getByRole('button', { name: 'Contacts tab' })); await screen.findByRole('button', { name: uiMessage('contacts-panel.add.cd6f2f52ff') });
    fireEvent.click(screen.getByRole('button', { name: 'Core tab' })); mocks.fetch.mockResolvedValue(reply([config])); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') })); await screen.findByText('Private configuration A');
    expect(screen.getByText('50%')).toBeTruthy(); expect(screen.getByText('70%')).toBeTruthy(); expect(view.container.querySelectorAll('details[open]')).toHaveLength(3);
    const summary = screen.getByText(uiMessage('personality-editor.expression-style.ceeea2ddc5')); fireEvent.click(summary); await waitFor(() => expect(summary.closest('details')?.open).toBe(true));
    const obsolete = deferred<any>(); mocks.fetch.mockReturnValueOnce(obsolete.promise); account.user = { uid: 'account-b', role: 'user' }; view.rerender(<PersonalityEditor />); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
    expect(screen.queryByText('Private configuration A')).toBeNull(); mocks.fetch.mockResolvedValue(reply([{ ...config, name: 'Current configuration' }])); account.workDomain = 'work'; account.orgConnection = { orgId: 'org-c' }; view.rerender(<PersonalityEditor />); await screen.findByText('Current configuration');
    await act(async () => obsolete.resolve(reply([{ ...config, name: 'Obsolete configuration' }]))); expect(signal.aborted).toBe(true); expect(screen.queryByText('Obsolete configuration')).toBeNull();
    mocks.fetch.mockResolvedValue(reply([{ ...config, expressionStyle: { languages: 'invalid' } }])); account.user = { uid: 'account-c', role: 'user' }; view.rerender(<PersonalityEditor />); await screen.findByRole('alert');
    account.user = null; view.rerender(<PersonalityEditor />); expect(view.container.textContent).toBe('');
  });

  it('keeps the newest device refresh, clears failed lists and removes listeners when closed', async () => {
    const first = deferred<MediaDeviceInfo[]>(), afterClose = deferred<MediaDeviceInfo[]>(), media = new EventTarget();
    const enumerate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([{ kind: 'audioinput', deviceId: 'new', label: 'Latest microphone' }]);
    Object.assign(media, { enumerateDevices: enumerate }); vi.stubGlobal('navigator', { mediaDevices: media });
    const view = render(<VoiceDeviceSelector />); act(() => media.dispatchEvent(new Event('devicechange'))); await screen.findByRole('option', { name: 'Latest microphone' });
    await act(async () => first.resolve([{ kind: 'audioinput', deviceId: 'old', label: 'Old microphone' } as MediaDeviceInfo])); expect(screen.queryByRole('option', { name: 'Old microphone' })).toBeNull();
    enumerate.mockRejectedValueOnce(new Error('devices denied')); fireEvent.click(screen.getByRole('button', { name: uiMessage('settings.refresh.cba212b169') }));
    await screen.findByText(uiMessage('settings.audio-device-list-unavailable.a063f48e43')); expect(screen.queryByRole('option', { name: 'Latest microphone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: uiMessage('settings.refresh.cba212b169') })); await screen.findByRole('option', { name: 'Latest microphone' });
    enumerate.mockReturnValueOnce(afterClose.promise); act(() => media.dispatchEvent(new Event('devicechange'))); view.unmount(); act(() => media.dispatchEvent(new Event('devicechange')));
    await act(async () => afterClose.resolve([])); expect(enumerate).toHaveBeenCalledTimes(5);
  });

  it('preserves missing device selections, permits resetting them, and never announces a failed save', async () => {
    vi.stubGlobal('navigator', {}); localStorage.setItem('lumi_voice_output_device', 'missing-speaker');
    render(<VoiceDeviceSelector />); const output = screen.getByRole('combobox', { name: new RegExp(uiMessage('settings.speaker-output.3ce99de026')) });
    expect(output).toHaveProperty('value', 'missing-speaker'); expect(output).toHaveProperty('disabled', false); await screen.findByText(uiMessage('settings.audio-device-list-unavailable.a063f48e43'));
    const changed = vi.fn(); window.addEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, changed);
    try {
      fireEvent.change(output, { target: { value: '' } }); expect(localStorage.getItem('lumi_voice_output_device')).toBeNull(); expect(output).toHaveProperty('value', '');
      act(() => { setVoiceDevicePreference('output', 'elsewhere'); }); expect(output).toHaveProperty('value', 'elsewhere');
      localStorage.setItem('lumi_voice_output_device', 'another-window'); act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lumi_voice_output_device' }))); expect(output).toHaveProperty('value', 'another-window');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage denied'); }); fireEvent.change(output, { target: { value: '' } });
      expect(output).toHaveProperty('value', 'another-window'); expect(mocks.error).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledTimes(2);
      expect(setVoiceDevicePreference('input', 'mic', null)).toBe(false); expect(changed).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, changed); }
  });

  it('serializes official-role apply, retains receipts, and cancels publication after an account change', async () => {
    const Page = apiKeyField('OfficialProviderSettings'), pending = deferred<any>(), changed = vi.fn(), result = { ok: true, applied: ['reasoning'], skipped: [], failed: [] };
    window.addEventListener('lumi:model-configuration-changed', changed); mocks.fetch.mockReturnValueOnce(pending.promise);
    try {
      const view = render(<Page t={{ langCode: 'en' }} />), apply = screen.getByTestId('apply-official-api'); act(() => { fireEvent.click(apply); fireEvent.click(apply); }); expect(mocks.fetch).toHaveBeenCalledOnce();
      await act(async () => pending.resolve(reply(result))); await screen.findByRole('status'); expect(mocks.success).toHaveBeenCalledOnce(); expect(changed.mock.calls[0][0].detail.source).toBe('official-settings');
      mocks.fetch.mockResolvedValueOnce(reply({ code: 'OFFICIAL_API_NOT_CONFIGURED' }, 400)); fireEvent.click(apply); await screen.findByRole('alert'); expect(changed).toHaveBeenCalledOnce();
      const obsolete = deferred<any>(); mocks.fetch.mockReturnValueOnce(obsolete.promise); fireEvent.click(apply); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
      account.user = { uid: 'apply-owner-b', role: 'admin' }; view.rerender(<Page key="new-owner" t={{ langCode: 'en' }} />);
      await act(async () => obsolete.resolve(reply(result))); expect(signal.aborted).toBe(true); expect(changed).toHaveBeenCalledOnce(); expect(mocks.success).toHaveBeenCalledOnce(); expect(screen.queryByRole('status')).toBeNull();
    } finally { window.removeEventListener('lumi:model-configuration-changed', changed); }
  });

  it('owns settings provider reads by account and refresh, without remounting an official apply receipt', async () => {
    const mounted = vi.fn(), Page = () => { React.useEffect(() => { mounted(); }, []); return null; };
    const deps: any = { React, useState: React.useState, useEffect: React.useEffect, useApp: () => account, usePlatform: () => ({}), apiJson, toast: mocks, uiMessage, window, AbortController, AbortSignal,
      buildSidebarGroups: () => [], AIProvidersPage: ({ providerStatus }: any) => <><Page /><span>{Object.keys(providerStatus).join(',')}</span></>,
      AnimatePresence: ({ children }: any) => children, motion: { div: ({ children }: any) => <div>{children}</div> }, Globe: () => null, LogOut: () => null, ExternalLink: () => null };
    deps.SettingsView = extractSourceExpression('src/components/Settings.tsx', 'SettingsView', deps); const Settings = extractSourceExpression('src/components/Settings.tsx', 'Settings', deps);
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); const view = render(<Settings t={{}} activeSection="ai-providers" />); const signal = mocks.fetch.mock.calls[0][1].signal;
    mocks.fetch.mockResolvedValue(reply({ providers: { newest: {} } })); act(() => window.dispatchEvent(new CustomEvent('lumi:keys-changed'))); await screen.findByText('newest'); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(reply({ providers: { stale: {} } }))); expect(screen.queryByText('stale')).toBeNull();
    const count = mounted.mock.calls.length; act(() => window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed', { detail: { source: 'official-settings' } }))); expect(mounted).toHaveBeenCalledTimes(count);
    act(() => window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed'))); expect(mounted).toHaveBeenCalledTimes(count + 1);
    mocks.fetch.mockResolvedValue(reply({ providers: { otherAccount: {} } })); account.user = { uid: 'settings-owner-b', role: 'admin' }; view.rerender(<Settings t={{}} activeSection="ai-providers" />); expect(screen.queryByText('newest')).toBeNull(); await screen.findByText('otherAccount');
  });

  it('replaces an in-flight official catalog only after relay credentials change, without retaining an old cache', async () => {
    const old = deferred<any>(), latest = { ok: true, models: [{ id: 'current' }], byRole: { speech_synthesis: ['current'] } };
    mocks.fetch.mockReturnValueOnce(old.promise); const hook = renderHook(() => useLumiOfficialCatalog()); const signal = mocks.fetch.mock.calls[0][1].signal;
    act(() => window.dispatchEvent(new CustomEvent('lumi:keys-changed', { detail: { saved: ['OPENAI_API_KEY'], deleted: [] } }))); expect(mocks.fetch).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValue(reply(latest)); act(() => window.dispatchEvent(new CustomEvent('lumi:keys-changed', { detail: { saved: ['RELAY_API_KEY'] } })));
    await waitFor(() => expect(hook.result.current).toEqual(latest)); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(reply({ ok: true, models: [{ id: 'old' }], byRole: { speech_synthesis: ['old'] } }))); expect(hook.result.current).toEqual(latest);
    mocks.fetch.mockResolvedValueOnce(reply({ ok: true, models: [], byRole: { speech_synthesis: 'invalid' } }));
    act(() => window.dispatchEvent(new CustomEvent('lumi:keys-changed', { detail: { deleted: ['RELAY_API_KEY'] } }))); await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3)); expect(hook.result.current).toBeNull();
    hook.unmount(); const reopened = renderHook(() => useLumiOfficialCatalog()); await waitFor(() => expect(reopened.result.current).toEqual(latest)); expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it('clears catalog data immediately on account or scope changes and cancels obsolete reads', async () => {
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); const hook = renderHook(() => useLumiOfficialCatalog());
    const signal = mocks.fetch.mock.calls[0][1].signal; mocks.fetch.mockResolvedValue(reply({ ok: true, models: [], byRole: {} })); account.user = { uid: 'catalog-owner-b', role: 'admin' }; hook.rerender();
    expect(hook.result.current).toBeNull(); await waitFor(() => expect(hook.result.current?.models).toEqual([])); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(reply({ ok: true, models: [{ id: 'private' }], byRole: {} }))); expect(hook.result.current?.models).toEqual([]);
    mocks.fetch.mockResolvedValue(reply({ error: 'Catalog denied' }, 403)); account.workDomain = 'work'; account.orgConnection = { orgId: 'catalog-org' }; hook.rerender();
    expect(hook.result.current).toBeNull(); await act(async () => {}); account.user = null; hook.rerender(); expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('confirms voice changes with one write, preserves the other role, and does not wait for the catalog', async () => {
    const pendingCatalog = deferred<any>(), pendingSave = deferred<any>(), state = { pref: { stt: 'auto', tts: 'relay' }, active: { stt: 'local-whisper', streamingStt: null, tts: 'relay', ttsModel: 'existing-tts' } };
    mocks.fetch.mockImplementation(async (url, init) => url.endsWith('/official/models') ? pendingCatalog.promise : init.method ? pendingSave.promise : reply(state));
    const changed = vi.fn(); window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, changed);
    try {
      render(<VoiceProviderSwitch t={{ langCode: 'en' }} />); const stt = screen.getByRole('group', { name: 'STT' }); await waitFor(() => expect(stt).toHaveProperty('disabled', false));
      const choose = within(stt).getByRole('button', { name: 'Whisper' }); act(() => { fireEvent.click(choose); fireEvent.click(choose); });
      const writes = mocks.fetch.mock.calls.filter(([, init]) => init.method); expect(writes).toHaveLength(1); expect(JSON.parse(writes[0][1].body)).toEqual({ stt: 'whisper' }); expect(changed).not.toHaveBeenCalled();
      const confirmed = { success: true, ...state, pref: { ...state.pref, stt: 'whisper' }, active: { ...state.active, stt: 'whisper' } };
      await act(async () => pendingSave.resolve(reply(confirmed))); expect(changed).toHaveBeenCalledOnce(); expect(changed.mock.calls[0][0].detail).toEqual(confirmed); expect(mocks.fetch).toHaveBeenCalledTimes(3);
      await act(async () => pendingCatalog.resolve(reply({ ok: true, models: [], byRole: { speech_synthesis: ['next-tts'] } })));
      const select = within(screen.getByRole('group', { name: 'TTS' })).getByRole('combobox'); expect(select).toHaveProperty('value', 'existing-tts'); expect(within(select).getAllByRole('option').map(item => item.textContent)).toEqual(['existing-tts', 'next-tts']);
      mocks.fetch.mockResolvedValueOnce(reply({ ...confirmed, pref: { ...confirmed.pref, ttsModel: 'next-tts' } })); fireEvent.change(select, { target: { value: 'next-tts' } });
      await waitFor(() => expect(select).toHaveProperty('value', 'next-tts')); expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toEqual({ ttsModel: 'next-tts' }); expect(mocks.fetch).toHaveBeenCalledTimes(4);
    } finally { window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, changed); }
  });

  it('blocks non-admin voice controls and rejects failed or malformed confirmations without broadcasting intent', async () => {
    account.user = { uid: 'member', role: 'user' }; const view = render(<VoiceProviderSwitch />); expect(mocks.fetch).not.toHaveBeenCalled(); expect(screen.queryByRole('button')).toBeNull();
    account.user = { uid: 'admin', role: 'admin' }; mocks.fetch.mockResolvedValue(reply({ error: 'Access denied' }, 403)); view.rerender(<VoiceProviderSwitch />); await screen.findByRole('alert');
    expect(screen.getByRole('group', { name: 'STT' })).toHaveProperty('disabled', true);
    const state = { pref: { stt: 'auto', tts: 'auto' }, active: { stt: null, tts: null } }; mocks.fetch.mockResolvedValue(reply(state)); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'STT' })).toHaveProperty('disabled', false));
    const changed = vi.fn(); window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, changed);
    try {
      for (const response of [reply({ error: 'Save denied' }, 500), reply({ success: true })]) {
        mocks.fetch.mockResolvedValueOnce(response); fireEvent.click(within(screen.getByRole('group', { name: 'STT' })).getByRole('button', { name: 'Whisper' })); await screen.findByRole('alert'); await waitFor(() => expect(screen.getByRole('group', { name: 'STT' })).toHaveProperty('disabled', false));
      }
      expect(changed).not.toHaveBeenCalled(); expect(within(screen.getByRole('group', { name: 'STT' })).getByRole('button', { name: 'Auto' }).className).toContain('bg-celestial-saturn');
      const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); fireEvent.click(within(screen.getByRole('group', { name: 'STT' })).getByRole('button', { name: 'Whisper' })); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
      account.user = null; view.rerender(<VoiceProviderSwitch />); await act(async () => pending.resolve(reply({ success: true, ...state }))); expect(signal.aborted).toBe(true); expect(changed).not.toHaveBeenCalled();
    } finally { window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, changed); }
  });

  it.each(['LLMProviderRow', 'RelayProviderRow'])('%s verifies saves and removals through the common credential owner', async name => {
    const Field = apiKeyField(name), relay = name === 'RelayProviderRow', key = relay ? 'RELAY_API_KEY' : 'OPENAI_API_KEY';
    const status: Record<string, boolean> = { [key]: true, ...(relay ? { RELAY_BASE_URL: true } : {}) }, writes: any[] = [], pending = deferred<any>();
    const published = vi.fn(); window.addEventListener('lumi:keys-changed', published);
    localStorage.setItem(relay ? 'lumi_relay_key' : 'lumi_openai_key', 'old-browser-secret');
    mocks.fetch.mockImplementation(async (_url, init) => {
      if (!init.method) return reply({ ...status });
      const keys = JSON.parse(String(init.body)).keys; writes.push(keys); Object.assign(status, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, Boolean(v)])));
      return writes.length === 1 ? pending.promise : reply({ success: true });
    });
    try {
      render(<Field {...keyProps} providerId="openai" models={['model-a']} serverKey={key} />);
      const input = await screen.findByDisplayValue('');
      if (relay) fireEvent.change(screen.getByDisplayValue(LUMI_OFFICIAL_BASE_URL), { target: { value: 'https://synthetic.invalid/v1' } });
      else fireEvent.change(input, { target: { value: ' new-key ' } });
      act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save key' })); fireEvent.keyDown(input, { key: 'Enter' }); });
      expect(writes).toHaveLength(1); expect(input).toHaveProperty('disabled', true);
      expect(writes[0]).toEqual(relay ? { RELAY_BASE_URL: 'https://synthetic.invalid/v1' } : { OPENAI_API_KEY: 'new-key' });
      await act(async () => pending.resolve(reply({ success: true })));
      await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(mocks.fetch).toHaveBeenCalledTimes(3);
      expect(localStorage.getItem(relay ? 'lumi_relay_key' : 'lumi_openai_key')).toBeNull();
      if (relay) { expect(localStorage.getItem('lumi_relay_url')).toBe('https://synthetic.invalid/v1'); expect(status.RELAY_API_KEY).toBe(true); expect(published).toHaveBeenCalledOnce(); }
      fireEvent.click(screen.getByRole('button', { name: 'Remove key' })); await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
      expect(writes[1]).toEqual(relay ? { RELAY_API_KEY: '', RELAY_BASE_URL: '' } : { OPENAI_API_KEY: '' }); expect(status[key]).toBe(false); expect(mocks.fetch).toHaveBeenCalledTimes(5);
      if (relay) { expect(localStorage.getItem('lumi_relay_url')).toBeNull(); expect(published).toHaveBeenCalledTimes(2); }
    } finally { window.removeEventListener('lumi:keys-changed', published); }
  });

  it.each(['LLMProviderRow', 'RelayProviderRow'])('%s retains drafts on failure and suppresses obsolete account writes', async name => {
    const Field = apiKeyField(name), relay = name === 'RelayProviderRow', key = relay ? 'RELAY_API_KEY' : 'OPENAI_API_KEY', props = { ...keyProps, providerId: 'openai', models: ['model-a'], serverKey: key };
    mocks.fetch.mockResolvedValue(reply({ error: 'Status denied' }, 403)); const view = render(<Field {...props} />); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Save key' })).toBeNull();
    mocks.fetch.mockResolvedValue(reply({ [key]: false, RELAY_BASE_URL: false })); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') }));
    const input = await screen.findByDisplayValue(''); fireEvent.change(input, { target: { value: 'preserve-this-draft' } });
    mocks.fetch.mockResolvedValue(reply({ error: 'Write denied' }, 403)); fireEvent.click(screen.getByRole('button', { name: 'Save key' })); await screen.findByText('Write denied'); expect(input).toHaveProperty('value', 'preserve-this-draft');
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole('button', { name: 'Save key' })); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
    mocks.fetch.mockResolvedValue(reply({ [key]: false, RELAY_BASE_URL: false })); account.user = { uid: 'next-owner', role: 'admin' }; view.rerender(<Field {...props} />);
    await screen.findByDisplayValue(''); const count = mocks.fetch.mock.calls.length; expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(reply({ success: true }))); expect(mocks.fetch).toHaveBeenCalledTimes(count); expect(mocks.success).not.toHaveBeenCalled();
    account.user = null; view.rerender(<Field {...props} />); expect(screen.queryByRole('button', { name: 'Save key' })).toBeNull();
  });

  it.each(['web', 'electron', 'tauri'])('opens the existing computer surface from %s without a separate vault or system query', async host => {
    if (host !== 'web') vi.stubGlobal(host === 'electron' ? 'lumiElectron' : '__TAURI_INTERNALS__', {});
    mocks.fetch.mockImplementation(async (url: string) => reply({ devices: url.endsWith('/remote-devices') ? {} : [], pairedDeviceIds: [] }));
    const listener = vi.fn(); window.addEventListener('lumi:client-action', listener);
    try {
      render(<DeviceSyncCenter t={{}} />); await screen.findByText('No remote devices configured'); const count = mocks.fetch.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: 'Kernel Monitor' }));
      const action = listener.mock.calls[0][0].detail.action;
      expect(action).toBe('open_computer_adaptation'); expect(getPersonalClientSurfaceByAction(action)?.target).toBe('kernel');
      expect(mocks.fetch).toHaveBeenCalledTimes(count); expect(document.body.textContent).not.toMatch(/session:\/\/web\/vault|UNLOCKED|Open Web Vault|CONNECTED/);
    } finally { window.removeEventListener('lumi:client-action', listener); }
  });

  it('keeps API keys on the server, serializes saves and removals, and probes only saved credentials', async () => {
    const Field = apiKeyField(), pending = deferred<any>(); let configured = false;
    localStorage.setItem(keyProps.storageKey, 'obsolete-secret');
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/probe')) return reply({ ok: true, latencyMs: 27 });
      if (init.method) { configured = Boolean(JSON.parse(String(init.body)).keys.DOUBAO_SPEECH_KEY); return configured ? pending.promise : reply({ success: true }); }
      return reply({ DOUBAO_SPEECH_KEY: configured });
    });
    render(<Field {...keyProps} />); const input = await screen.findByPlaceholderText('Synthetic key');
    expect(localStorage.getItem(keyProps.storageKey)).toBeNull(); fireEvent.change(input, { target: { value: ' synthetic-key ' } });
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(input).toHaveProperty('disabled', true);
    await act(async () => pending.resolve(reply({ success: true })));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(input).toHaveProperty('value', ''); expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(keyProps.storageKey)).toBeNull();
    const probe = screen.getByRole('button', { name: uiMessage('settings.test.9408c1ff3a') });
    fireEvent.change(input, { target: { value: 'unsaved-key' } }); expect(probe).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '' } }); fireEvent.click(probe);
    await screen.findByText(/27/); expect(mocks.fetch.mock.calls.find(([url]) => url.endsWith('/probe'))![1].signal).toBeInstanceOf(AbortSignal);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' })); await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
    expect(mocks.fetch).toHaveBeenCalledTimes(6); expect(probe).toHaveProperty('disabled', true); expect(configured).toBe(false);
  });

  it('requires confirmed key status, permits refresh, and retains failed-save drafts', async () => {
    const Field = apiKeyField(); mocks.fetch.mockResolvedValue(reply({ error: 'Status denied' }, 403)); render(<Field {...keyProps} />);
    await screen.findByRole('alert'); expect(screen.queryByPlaceholderText('Synthetic key')).toBeNull();
    mocks.fetch.mockResolvedValue(reply({ DOUBAO_SPEECH_KEY: false })); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') }));
    const input = await screen.findByPlaceholderText('Synthetic key'); fireEvent.change(input, { target: { value: 'draft-key' } });
    mocks.fetch.mockImplementation(async (_url, init) => reply(init.method ? { success: true } : { DOUBAO_SPEECH_KEY: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Save key' })); await screen.findByText(/not persisted/);
    expect(input).toHaveProperty('value', 'draft-key'); expect(mocks.success).not.toHaveBeenCalled();
    mocks.fetch.mockImplementation(async (_url, init) => reply(init.method ? { success: true } : { DOUBAO_SPEECH_KEY: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Save key' })); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(input).toHaveProperty('value', '');
  });

  it('keeps both speech probe failure details and lets the user retry without editing the saved key', async () => {
    const Field = apiKeyField(); let accepted = false;
    mocks.fetch.mockImplementation(async url => reply(url.endsWith('/probe') ? accepted ? { ok: true, latencyMs: 42 } : { ok: false, streamingStt: { error: 'Recognition denied' }, speechSynthesis: { error: 'Synthesis denied' } } : { DOUBAO_SPEECH_KEY: true }));
    render(<Field {...keyProps} />); const probe = await screen.findByRole('button', { name: uiMessage('settings.test.9408c1ff3a') });
    fireEvent.click(probe); await screen.findByText('Recognition denied | Synthesis denied'); expect(mocks.success).not.toHaveBeenCalled();
    accepted = true; fireEvent.click(probe); await screen.findByText(/42/); expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/keys'))).toHaveLength(1);
  });

  it.each(['read', 'save', 'probe'])('discards late credential %s results when the account changes or exits', async stage => {
    const Field = apiKeyField(), pending = deferred<any>();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => (stage === 'read' || (init.method && (stage === 'save' || url.endsWith('/probe')))) ? pending.promise : reply({ DOUBAO_SPEECH_KEY: true }));
    const view = render(<Field {...keyProps} />);
    if (stage !== 'read') {
      const input = await screen.findByDisplayValue('');
      if (stage === 'save') { fireEvent.change(input, { target: { value: 'old-owner-key' } }); fireEvent.keyDown(input, { key: 'Enter' }); }
      else fireEvent.click(screen.getByRole('button', { name: uiMessage('settings.test.9408c1ff3a') }));
    }
    const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
    mocks.fetch.mockResolvedValue(reply({ DOUBAO_SPEECH_KEY: false })); account.user = { uid: 'other-owner', role: 'admin' }; view.rerender(<Field {...keyProps} />);
    const input = await screen.findByPlaceholderText('Synthetic key'); expect(input).toHaveProperty('value', ''); expect(signal.aborted).toBe(true);
    const calls = mocks.fetch.mock.calls.length; await act(async () => pending.resolve(reply({ success: true, ok: true, latencyMs: 91, DOUBAO_SPEECH_KEY: true })));
    expect(mocks.fetch).toHaveBeenCalledTimes(calls); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled(); expect(screen.queryByText(/91/)).toBeNull();
    account.user = null; view.rerender(<Field {...keyProps} />); expect(screen.queryByPlaceholderText('Synthetic key')).toBeNull();
  });

  it.each(['settings', 'legal'])('uses one verified data-source save path from the %s entry for group and field changes', async entry => {
    const status: Record<string, boolean> = { QICHACHA_APP_KEY: true, QICHACHA_BASE_URL: true, TIANYANCHA_API_KEY: true };
    const writes: Record<string, string>[] = [];
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (!init.method) return reply({ ...status });
      const keys = JSON.parse(String(init.body)).keys; writes.push(keys);
      for (const [name, value] of Object.entries(keys)) status[name] = Boolean(value);
      return reply({ success: true, saved: [], deleted: [] });
    });
    const Entry = entry === 'legal' ? LegalDataSourcesSettings : extractSourceExpression('src/components/Settings.tsx', 'ExternalConnectionsPage', {
      React, useState: React.useState, useEffect: React.useEffect, uiMessage, Database: () => null, FileText: () => null,
      LegalDataSourcesSettings, ApplicationConnections: () => null,
    });
    render(<Entry t={{}} />);
    const app = document.getElementById('legal-source-QICHACHA_APP_KEY') as HTMLInputElement;
    await waitFor(() => expect(app.disabled).toBe(false));
    const group = within(app.closest('[role="group"]') as HTMLElement);
    const secret = document.getElementById('legal-source-QICHACHA_SECRET_KEY') as HTMLInputElement;
    const unrelated = document.getElementById('legal-source-TIANYANCHA_API_KEY') as HTMLInputElement;
    fireEvent.change(app, { target: { value: ' new-app-key ' } }); fireEvent.change(secret, { target: { value: 'new-secret' } }); fireEvent.change(unrelated, { target: { value: 'keep-draft' } });
    fireEvent.click(group.getByRole('button', { name: uiMessage('settings.save-provider.2882e9668b') }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(writes).toEqual([{ QICHACHA_APP_KEY: 'new-app-key', QICHACHA_SECRET_KEY: 'new-secret' }]);
    expect(mocks.fetch).toHaveBeenCalledTimes(3); expect(app.value).toBe(''); expect(secret.value).toBe(''); expect(unrelated.value).toBe('keep-draft'); expect(status.QICHACHA_BASE_URL).toBe(true);
    fireEvent.click(within(app.parentElement!).getByTitle(uiMessage('legal-data-sources-settings.remove.78190c6054')));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2)); expect(writes[1]).toEqual({ QICHACHA_APP_KEY: '' }); expect(status.QICHACHA_SECRET_KEY).toBe(true);
    fireEvent.click(group.getByRole('button', { name: uiMessage('settings.remove-provider.47319e8331') }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(3)); expect(writes[2]).toEqual({ QICHACHA_APP_KEY: '', QICHACHA_SECRET_KEY: '', QICHACHA_BASE_URL: '' });
    fireEvent.keyDown(unrelated, { key: 'Enter' }); await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(4));
    expect(writes[3]).toEqual({ TIANYANCHA_API_KEY: 'keep-draft' }); expect(mocks.fetch).toHaveBeenCalledTimes(9);
  });

  it.each([403, 'malformed'])('blocks data-source changes after an unconfirmed status (%s) and permits read retry', async failure => {
    mocks.fetch.mockResolvedValue(reply(failure === 403 ? { error: 'Key status denied' } : { QICHACHA_APP_KEY: 'invalid' }, failure === 403 ? 403 : 200));
    render(<LegalDataSourcesSettings />); await screen.findByRole('alert');
    const input = document.getElementById('legal-source-QICHACHA_APP_KEY') as HTMLInputElement; expect(input.disabled).toBe(true);
    mocks.fetch.mockResolvedValue(reply({ QICHACHA_APP_KEY: false })); fireEvent.click(screen.getByRole('button', { name: uiMessage('legal-data-sources-settings.refresh.05348f5f9a') }));
    await waitFor(() => expect(input.disabled).toBe(false)); expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['rejected', 'not-persisted'])('retains the credential draft after %s and verifies a later retry', async failure => {
    let accept = false;
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => reply(init.method ? { success: accept || failure !== 'rejected', error: 'Save denied' } : { QICHACHA_APP_KEY: accept }));
    render(<LegalDataSourcesSettings />); const input = document.getElementById('legal-source-QICHACHA_APP_KEY') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false)); fireEvent.change(input, { target: { value: 'synthetic-key' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce()); expect(input.value).toBe('synthetic-key'); expect(mocks.success).not.toHaveBeenCalled();
    accept = true; fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce()); expect(input.value).toBe('');
  });

  it('clears data-source drafts on account switch and suppresses a late save and global key event after logout', async () => {
    const pending = deferred<any>(), published = vi.fn(); window.addEventListener('lumi:keys-changed', published);
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method ? pending.promise : reply({ QICHACHA_APP_KEY: false }));
    const view = render(<LegalDataSourcesSettings />);
    let input = document.getElementById('legal-source-QICHACHA_APP_KEY') as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false)); fireEvent.change(input, { target: { value: 'old-draft' } });
    account.user = { uid: 'new-owner', role: 'admin' }; view.rerender(<LegalDataSourcesSettings />);
    input = document.getElementById('legal-source-QICHACHA_APP_KEY') as HTMLInputElement; await waitFor(() => expect(input.disabled).toBe(false)); expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'synthetic-key' } }); fireEvent.keyDown(input, { key: 'Enter' });
    account.user = null; view.rerender(<LegalDataSourcesSettings />); const calls = mocks.fetch.mock.calls.length;
    try {
      await act(async () => pending.resolve(reply({ success: true })));
      expect(mocks.fetch).toHaveBeenCalledTimes(calls); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled();
    } finally { window.removeEventListener('lumi:keys-changed', published); }
  });

  it.each([
    ['web', '', null], ['electron', 'lumiElectron', {}], ['electron', 'userAgent', 'synthetic Electron/1'],
    ['tauri', '__TAURI_INTERNALS__', {}], ['tauri', '__TAURI_IPC__', {}], ['tauri', '__TAURI__', {}],
    ['ios', 'Capacitor', { platform: 'ios' }], ['android', 'Capacitor', { platform: 'android' }],
  ])('detects %s from %s once without a second platform correction', (platform, key, value) => {
    if (key === 'userAgent') vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(String(value));
    else if (key) vi.stubGlobal(String(key), value);
    const states: string[] = [];
    renderHook(() => { const state = usePlatform(); states.push(state.platform); return state; });
    expect(states).toEqual([platform]);
  });

  it('owns sensor subscriptions for the device view and releases them on stop and close', async () => {
    const watchPosition = vi.fn().mockReturnValue(71), clearWatch = vi.fn();
    vi.stubGlobal('navigator', { geolocation: { watchPosition, clearWatch }, userAgent: 'synthetic-browser', platform: 'web' });
    vi.stubGlobal('DeviceMotionEvent', Event);
    const subscribe = vi.spyOn(window, 'addEventListener'), unsubscribe = vi.spyOn(window, 'removeEventListener');
    mocks.fetch.mockImplementation(async (url: string) => reply({ devices: url.endsWith('/remote-devices') ? {} : [], pairedDeviceIds: [] }));
    const view = render(<DeviceSyncCenter t={{}} />); await screen.findByText('No remote devices configured');
    expect(watchPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE' })); expect(watchPosition).toHaveBeenCalledOnce();
    act(() => watchPosition.mock.calls[0][0]({ coords: { latitude: 32.1234, longitude: 119.1234, speed: 0 } }));
    expect(screen.getByText('32.1234° N')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'STOP' })); expect(clearWatch).toHaveBeenCalledWith(71);
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE' })); expect(watchPosition).toHaveBeenCalledTimes(2);
    view.unmount(); expect(clearWatch).toHaveBeenCalledTimes(2);
    expect(unsubscribe.mock.calls.filter(([name]) => name === 'devicemotion')).toEqual(subscribe.mock.calls.filter(([name]) => name === 'devicemotion'));
  });

  it.each([403, 'invalid'])('retries failed device reads (%s) through the authenticated API without claiming an empty list', async failure => {
    localStorage.setItem('lumi_auth_token', 'synthetic-device-token');
    mocks.fetch.mockImplementation(async (url: string) => reply(url.endsWith('/remote-devices') ? { devices: {} } : failure === 403 ? { error: 'Denied device read' } : {}, url.endsWith('/devices') && failure === 403 ? 403 : 200));
    render(<DeviceSyncCenter t={{}} />); await screen.findByRole('alert');
    expect(screen.queryByText('No devices connected. Open the app on another device to see it here.')).toBeNull();
    const request = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/devices'))!;
    expect(new URL(request[0]).pathname).toBe('/api/devices'); expect(new Headers(request[1].headers).get('Authorization')).toBe('Bearer synthetic-device-token');
    mocks.fetch.mockResolvedValue(reply({ devices: [], pairedDeviceIds: [], sensoryContext: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('No devices connected. Open the app on another device to see it here.'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads devices once when the socket hook initializes and does not reload for a new translation object', async () => {
    socketState.enabled = false;
    mocks.fetch.mockImplementation(async (url: string) => reply({ devices: url.endsWith('/remote-devices') ? {} : [], pairedDeviceIds: [] }));
    const view = render(<DeviceSyncCenter t={{}} />); const reads = () => mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/devices')).length;
    expect(reads()).toBe(0); socketState.enabled = true; view.rerender(<DeviceSyncCenter t={{}} />);
    await screen.findByText('No devices connected. Open the app on another device to see it here.'); expect(reads()).toBe(1);
    view.rerender(<DeviceSyncCenter t={{ refreshBtn: 'Reload' }} />); expect(reads()).toBe(1);
  });

  it.each([{ success: false, error: 'Pair rejected' }, { success: true }, { success: true, pairedDeviceIds: [] }])('does not invent a paired device from an unconfirmed response %j', async result => {
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => reply(init.method ? result : url.endsWith('/remote-devices') ? { devices: {} } : { devices: [{ id: 'phone', name: 'Synthetic phone', status: 'online' }], pairedDeviceIds: [] }));
    render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: 'PAIR' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce()); expect(mocks.success).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: 'PAIR' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'PAIRED' })).toBeNull();
  });

  it('serializes device pairing and refreshes the confirmed snapshot after pairing and unpairing', async () => {
    const write = deferred<any>(); let pairedDeviceIds: string[] = [];
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') return write.promise;
      if (init.method === 'DELETE') { pairedDeviceIds = []; return reply({ success: true, pairedDeviceIds }); }
      return reply(url.endsWith('/remote-devices') ? { devices: {} } : { devices: ['phone', 'tablet'].map(id => ({ id, name: id, status: 'online' })), pairedDeviceIds });
    });
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('phone');
    const buttons = screen.getAllByRole('button', { name: 'PAIR' }); fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
    expect(mocks.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    act(() => mocks.on.mock.calls.find(([name]) => name === 'devices:update')![1]({}));
    pairedDeviceIds = ['phone']; await act(async () => write.resolve(reply({ success: true, pairedDeviceIds })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'PAIRED' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'PAIRED' })); await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'PAIR' })).toHaveLength(2));
    const deletion = mocks.fetch.mock.calls.find(([, init]) => init.method === 'DELETE')!;
    expect(new URL(deletion[0]).pathname).toBe('/api/devices/pair/phone');
  });

  it('coalesces device events into one complete snapshot and releases subscriptions and sync timers', async () => {
    let next = false;
    mocks.fetch.mockImplementation(async (url: string) => reply(url.endsWith('/remote-devices') ? { devices: {} } : {
      devices: [{ id: next ? 'new-device' : 'old-device', name: next ? 'New device' : 'Old device', status: 'online' }], pairedDeviceIds: next ? ['new-device'] : [],
      sensoryContext: { deviceCount: next ? 2 : 1, hasAudio: true, hasVideo: next },
    }));
    const view = render(<DeviceSyncCenter t={{}} />); await screen.findByText('Old device');
    const reads = () => mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/devices')).length;
    next = true; act(() => { for (const event of ['device:registered', 'devices:update', 'device:removed', 'connect']) mocks.on.mock.calls.find(([name]) => name === event)![1]({ name: 'Untrusted event device' }); });
    await screen.findByText('New device'); expect(reads()).toBe(2); await waitFor(() => expect(screen.queryByText('Old device')).toBeNull());
    expect(screen.getByText('2 online · Audio: yes · Video: yes')).toBeTruthy(); expect(screen.getByRole('button', { name: 'PAIRED' })).toBeTruthy();
    const timers = vi.spyOn(globalThis, 'setTimeout'), cancel = vi.spyOn(globalThis, 'clearTimeout');
    const onSync = mocks.on.mock.calls.find(([name]) => name === 'memories:changed')![1];
    act(() => { onSync({ timestamp: '2026-10-03T00:00:00Z' }); onSync({ timestamp: '2026-10-03T00:00:01Z' }); });
    const syncHandles = timers.mock.calls.flatMap(([, delay], i) => delay === 5000 ? [timers.mock.results[i].value] : []);
    expect(syncHandles).toHaveLength(2); expect(cancel).toHaveBeenCalledWith(syncHandles[0]);
    view.unmount(); expect(cancel).toHaveBeenCalledWith(syncHandles[1]);
    expect(mocks.off.mock.calls).toEqual(mocks.on.mock.calls); const count = reads();
    act(() => mocks.on.mock.calls.find(([name]) => name === 'connect')![1]()); expect(reads()).toBe(count);
  });

  it.each([true, false])('ignores a late device pairing result (success=%s) after logout', async success => {
    const pending = deferred<any>();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method ? pending.promise : reply(url.endsWith('/remote-devices') ? { devices: {} } : { devices: [{ id: 'phone', name: 'Phone', status: 'online' }], pairedDeviceIds: [] }));
    const view = render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: 'PAIR' }));
    account.user = null; view.rerender(<DeviceSyncCenter t={{}} />); const calls = mocks.fetch.mock.calls.length;
    await act(async () => pending.resolve(reply({ success, pairedDeviceIds: ['phone'], error: success ? undefined : 'Synthetic rejection' })));
    expect(mocks.error).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledTimes(calls);
    expect(mocks.fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });

  it.each(['account', 'domain', 'logout'])('clears device state and ignores delayed reads on %s change', async change => {
    const held = deferred<any>(); let previous = true;
    mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/remote-devices') ? reply({ devices: {} }) : previous ? held.promise : reply({ devices: [{ id: 'new', name: 'New scope device', status: 'online' }], pairedDeviceIds: [] }));
    const view = render(<DeviceSyncCenter t={{}} />); previous = false;
    if (change === 'domain') {
      account.workDomain = 'work'; account.orgConnection = { orgId: 'new-org' }; view.rerender(<DeviceSyncCenter t={{}} />);
      expect(view.container.textContent).toBe(''); account.user!.orgId = 'new-org';
    } else account.user = change === 'logout' ? null : { uid: 'new-user', role: 'admin' };
    view.rerender(<DeviceSyncCenter t={{}} />);
    if (change !== 'logout') await screen.findByText('New scope device');
    await act(async () => held.resolve(reply({ devices: [{ id: 'old', name: 'Old scope device', status: 'online' }], pairedDeviceIds: [] })));
    expect(screen.queryByText('Old scope device')).toBeNull(); if (change === 'logout') expect(view.container.textContent).toBe('');
  });

  it.each([403, 'invalid'])('shows an MCP read error (%s), retries without substituting skills, and unsubscribes on close', async failure => {
    let failed = true;
    mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/api/mcp') && failed
      ? reply(failure === 403 ? { error: 'Not authorized' } : {}, failure === 403 ? 403 : 200)
      : reply({ servers: url.endsWith('/health') ? {} : [{ name: 'synthetic-runtime', enabled: true, connected: true }] }));
    const view = render(<MCPSettings />);
    expect((await screen.findByRole('alert')).textContent).toContain(failure === 403 ? 'Not authorized' : 'Invalid MCP server list');
    expect(screen.queryByText('No MCP servers configured')).toBeNull();
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/api/skills'))).toBe(false);
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('synthetic-runtime')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
    view.unmount(); expect(mocks.off).toHaveBeenCalledWith('mcp:health_update', mocks.on.mock.calls[0][1]);
  });

  it.each(['Restart', 'Disable', 'Enable', 'Remove MCP server'])('waits for confirmed %s, keeps authentication, and refreshes runtime and health once', async action => {
    const writes: Array<{ url: string; init: RequestInit }> = []; let accepted = false;
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method) { writes.push({ url, init }); return reply(accepted ? { ok: true, tools: ['one'] } : { ok: false, error: 'Synthetic rejection' }); }
      return reply({ servers: url.endsWith('/health') ? {} : [{ name: 'synthetic-runtime', enabled: action !== 'Enable', connected: true }] });
    });
    render(<MCPSettings />); await screen.findByText('synthetic-runtime');
    const button = action === 'Remove MCP server' ? screen.getByTitle(action) : screen.getByRole('button', { name: action });
    const reads = mocks.fetch.mock.calls.length;
    fireEvent.click(button); await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledTimes(reads + 1); expect(screen.getByText('synthetic-runtime')).toBeTruthy();
    accepted = true; fireEvent.click(button); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(reads + 4)); expect(writes).toHaveLength(2);
    const { url, init } = writes[1];
    expect(new URL(url).pathname).toBe(action === 'Restart' ? '/api/mcp/restart/synthetic-runtime' : `/api/mcp/synthetic-runtime${action === 'Remove MCP server' ? '' : '/state'}`);
    expect(init.method).toBe(action === 'Remove MCP server' ? 'DELETE' : 'POST');
    if (action === 'Enable' || action === 'Disable') expect(JSON.parse(String(init.body))).toEqual({ enabled: action === 'Enable' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof');
  });

  it.each(['stdio', 'http', 'ws'])('preserves %s configuration and review when adding an MCP server', async transport => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => reply(init.method ? { ok: true } : { servers: url.endsWith('/health') ? {} : [] }));
    render(<MCPSettings />); fireEvent.click(await screen.findByRole('button', { name: 'Add MCP Server' }));
    fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'new-runtime' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: transport } });
    if (transport === 'stdio') fireEvent.change(screen.getByPlaceholderText('Absolute local executable or pinned runtime'), { target: { value: 'synthetic.exe' } });
    else fireEvent.change(screen.getByPlaceholderText(transport === 'http' ? 'https://mcp.example.com/mcp' : 'wss://mcp.example.com'), { target: { value: `${transport === 'http' ? 'https' : 'wss'}://synthetic.invalid/mcp` } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Server' })); expect(confirm).toHaveBeenCalled(); expect(mocks.fetch.mock.calls.some(([, init]) => init.method)).toBe(false);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Add Server' }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    const write = mocks.fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(new URL(write[0]).pathname).toBe('/api/mcp'); expect(JSON.parse(write[1].body).servers['new-runtime']).toEqual({ enabled: true, source: 'external', transport, ...(transport === 'stdio' ? { command: 'synthetic.exe', args: [] } : { url: `${transport === 'http' ? 'https' : 'wss'}://synthetic.invalid/mcp` }) });
  });

  it('can save removal of the final remote device', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'PUT' ? reply({ success: true, devices: {} }) : reply({ devices: { speaker: 'wss://example.invalid/mcp' } }));
    const view = render(<RemoteMCPSettings />);
    await screen.findByText('speaker');
    fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    const write = mocks.fetch.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(JSON.parse(write![1].body)).toEqual({ devices: {} });
  });
  it('retains remote device edits when the backend denies saving', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'PUT' ? reply({ error: 'denied' }, 403) : reply({ devices: {} }));
    render(<RemoteMCPSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Device/i }));
    const fields = screen.getAllByRole('textbox');
    fireEvent.change(fields[0], { target: { value: 'speaker' } });
    fireEvent.change(fields[1], { target: { value: 'wss://example.invalid/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('speaker');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it.each([403, 'invalid'])('blocks remote-device editing after a failed read (%s) and retries', async failure => {
    mocks.fetch.mockResolvedValue(reply(failure === 403 ? { error: 'Read denied' } : {}, failure === 403 ? 403 : 200));
    render(<RemoteMCPSettings />); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Add Device' })).toBeNull();
    mocks.fetch.mockResolvedValue(reply({ devices: { restored: 'wss://restored.invalid/mcp' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); expect(await screen.findByText('restored')).toBeTruthy();
  });

  it('uses the confirmed remote configuration after saving instead of keeping raw credentials in the view', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => reply({ devices: init.method ? { speaker: 'wss://device.invalid/mcp?token=%5Bconfigured%5D' } : {} }));
    render(<RemoteMCPSettings />); fireEvent.click(await screen.findByRole('button', { name: 'Add Device' }));
    const fields = screen.getAllByRole('textbox');
    fireEvent.change(fields[0], { target: { value: ' speaker ' } });
    fireEvent.change(fields[1], { target: { value: 'wss://device.invalid/mcp?token=synthetic-private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(screen.getByText('speaker')).toBeTruthy(); expect(document.body.textContent).not.toContain('synthetic-private');
  });

  it.each([MCPSettings, RemoteMCPSettings])('discards the previous account read and clears its draft on account switch', async Component => {
    const old = deferred<any>(); let previous = true;
    mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/health') ? reply({ servers: {} }) : previous ? old.promise : reply({ servers: [], devices: {} }));
    const view = render(<Component />); previous = false; account.user = { uid: 'new-account', role: 'admin' }; view.rerender(<Component />);
    await screen.findByRole('button', { name: Component === MCPSettings ? 'Add MCP Server' : 'Add Device' });
    await act(async () => old.resolve(reply({ servers: [{ name: 'old-account', enabled: true }], devices: { 'old-account': 'wss://old.invalid/mcp' } })));
    expect(screen.queryByText('old-account')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: Component === MCPSettings ? 'Add MCP Server' : 'Add Device' }));
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'old-draft' } });
    account.user = { uid: 'third-account', role: 'admin' }; view.rerender(<Component />);
    await screen.findByRole('button', { name: Component === MCPSettings ? 'Add MCP Server' : 'Add Device' });
    expect(screen.queryByDisplayValue('old-draft')).toBeNull();
    account.user = null; view.rerender(<Component />); expect(view.container.textContent).toBe('');
  });

  it.each([MCPSettings, RemoteMCPSettings])('does not toast or refresh a completed write after the account leaves', async Component => {
    const pending = deferred<any>(); vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method ? pending.promise : reply({ servers: url.endsWith('/health') ? {} : [{ name: 'runtime', enabled: true }], devices: { speaker: 'wss://device.invalid/mcp' } }));
    const view = render(<Component />);
    if (Component === MCPSettings) fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    else { await screen.findByText('speaker'); fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!); fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); }
    account.user = null; view.rerender(<Component />); const calls = mocks.fetch.mock.calls.length;
    await act(async () => pending.resolve(reply({ ok: true, devices: {}, tools: ['one'] })));
    expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledTimes(calls);
  });

  it('keeps the latest MCP list and pushed health when older reads arrive last', async () => {
    const oldList = deferred<any>(), oldHealth = deferred<any>(); let listReads = 0;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method) return reply({ ok: true });
      if (url.endsWith('/health')) return oldHealth.promise;
      return ++listReads === 2 ? oldList.promise : reply({ servers: [{ name: listReads > 2 ? 'latest-runtime' : 'runtime', enabled: true }] });
    });
    const view = render(<MCPSettings t={{ langCode: 'en', mcpConnected: 'Live connection' }} />);
    const restart = await screen.findByRole('button', { name: 'Restart' });
    fireEvent.click(restart); await waitFor(() => expect(listReads).toBe(2));
    fireEvent.click(restart); expect(await screen.findByText('latest-runtime')).toBeTruthy();
    const healthUpdate = mocks.on.mock.calls.find(([name]) => name === 'mcp:health_update')![1];
    act(() => healthUpdate({ servers: { 'latest-runtime': { status: 'connected' } } }));
    await act(async () => { oldList.resolve(reply({ servers: [{ name: 'stale-runtime', enabled: true }] })); oldHealth.resolve(reply({ servers: {} })); });
    expect(screen.queryByText('stale-runtime')).toBeNull(); expect(screen.getByText('Live connection')).toBeTruthy();
    view.unmount(); act(() => healthUpdate({ servers: {} }));
    expect(mocks.fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });

  it.each([MCPSettings, RemoteMCPSettings])('reloads cleanly during StrictMode effect replay', async Component => {
    mocks.fetch.mockImplementation(async (url: string) => reply({ servers: url.endsWith('/health') ? {} : [], devices: {} }));
    const view = render(<React.StrictMode><Component /></React.StrictMode>);
    await screen.findByRole('button', { name: Component === MCPSettings ? 'Add MCP Server' : 'Add Device' });
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    view.unmount(); expect(mocks.fetch.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });

  it('keeps a contact visible if deletion fails', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'DELETE' ? reply({ error: 'delete denied' }, 500) : reply({ contacts: [{ id: 'contact', name: 'Synthetic contact' }] }));
    const view = render(<ContactsPanel />);
    await screen.findByText('Synthetic contact');
    fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('delete denied'));
    expect(screen.getByText('Synthetic contact')).toBeTruthy();
  });

  it.each([ContactsPanel, ReminderPanel])('retries malformed collection reads and isolates pending writes by account', async Component => {
    const contacts = Component === ContactsPanel, record = { id: 'same-id', name: 'Old owner', content: 'Old owner', status: 'pending' };
    const list = (item: typeof record) => reply(contacts ? { contacts: [item] } : [item]);
    mocks.fetch.mockResolvedValue(reply({})); const view = render(<React.StrictMode><Component /></React.StrictMode>);
    await screen.findByRole('alert'); expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    mocks.fetch.mockResolvedValue(list(record)); fireEvent.click(screen.getByRole('button', { name: uiMessage('knowledge-base.retry.9db2a8180b') })); await screen.findByText('Old owner');
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    fireEvent.click(view.container.querySelector('svg.lucide-trash2')!.closest('button')!); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
    mocks.fetch.mockResolvedValue(list({ ...record, name: 'New owner', content: 'New owner' })); account.user = { uid: 'next-owner', role: 'admin' };
    view.rerender(<React.StrictMode><Component /></React.StrictMode>); await screen.findByText('New owner'); expect(signal.aborted).toBe(true);
    const calls = mocks.fetch.mock.calls.length, errors = mocks.error.mock.calls.length;
    await act(async () => pending.resolve(reply({ success: true })));
    expect(screen.getByText('New owner')).toBeTruthy(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledTimes(errors); expect(mocks.fetch).toHaveBeenCalledTimes(calls);
    account.user = null; view.rerender(<React.StrictMode><Component /></React.StrictMode>); expect(screen.queryByText('New owner')).toBeNull();
  });

  it('shares the contact form, keeps failed drafts and records notes only for the selected contact', async () => {
    const entries = [{ id: 'first', name: 'First contact', notes: 'Keep this', tags: [] }, { id: 'second', name: 'Second contact', notes: '', tags: [] }];
    mocks.fetch.mockImplementation(async () => reply({ contacts: entries })); const view = render(<ContactsPanel />); await screen.findByText('First contact');
    fireEvent.click(screen.getAllByTitle(uiMessage('knowledge-base-browser.edit.e9740dbb21'))[0]);
    const company = screen.getByPlaceholderText(uiMessage('contacts-panel.company.861038ccb3'));
    fireEvent.change(company, { target: { value: 'Saved company' } }); mocks.fetch.mockResolvedValueOnce(reply({ error: 'Save denied' }, 403));
    fireEvent.click(screen.getByRole('button', { name: uiMessage('contacts-panel.save.ec8e6d5819') })); await screen.findByText('Save denied'); expect(company).toHaveProperty('value', 'Saved company');
    mocks.fetch.mockImplementation(async (_url, init) => reply({ ...entries[0], ...JSON.parse(init.body) }));
    fireEvent.click(screen.getByRole('button', { name: uiMessage('contacts-panel.save.ec8e6d5819') })); await screen.findByText('Saved company');
    const body = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body); expect(body).not.toHaveProperty('notes'); expect(body).not.toHaveProperty('tags');
    const notes = screen.getAllByPlaceholderText(uiMessage('contacts-panel.add-interaction-note.9422abeeab')); fireEvent.change(notes[0], { target: { value: 'Only first' } }); expect(notes[1]).toHaveProperty('value', '');
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); const before = mocks.fetch.mock.calls.length;
    act(() => { fireEvent.keyDown(notes[0], { key: 'Enter' }); fireEvent.keyDown(notes[0], { key: 'Enter' }); }); expect(mocks.fetch).toHaveBeenCalledTimes(before + 1);
    expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('/contacts/first/interact');
    await act(async () => pending.resolve(reply({ ...entries[0], company: 'Saved company', lastContacted: '2026-10-03T10:00:00Z' })));
    expect(notes[0]).toHaveProperty('value', ''); expect(view.container.textContent).toContain(uiMessage('contacts-panel.last-interaction.54940c42fc'));
    fireEvent.change(screen.getByPlaceholderText(uiMessage('contacts-panel.search-contacts.fcf6775e68')), { target: { value: 'saved company' } });
    expect(screen.queryByText('Second contact')).toBeNull(); expect(screen.getByText('First contact')).toBeTruthy(); expect(mocks.fetch).toHaveBeenCalledTimes(before + 1);
    fireEvent.click(screen.getByRole('button', { name: uiMessage('contacts-panel.add.cd6f2f52ff') })); fireEvent.change(screen.getByPlaceholderText(uiMessage('contacts-panel.name.f5479c3217')), { target: { value: 'Third contact' } });
    mocks.fetch.mockResolvedValueOnce(reply({ id: 'third', name: 'Third contact' })); fireEvent.click(screen.getByRole('button', { name: uiMessage('contacts-panel.save.ec8e6d5819') }));
    await waitFor(() => expect(screen.queryByPlaceholderText(uiMessage('contacts-panel.name.f5479c3217'))).toBeNull()); expect(mocks.fetch.mock.calls.at(-1)![1].method).toBe('POST');
  });

  it('uses authenticated confirmed reminder responses without refresh reads or duplicate creates', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    mocks.fetch.mockResolvedValueOnce(reply([])); const view = render(<ReminderPanel t={{ langCode: 'en' }} />);
    const input = await screen.findByPlaceholderText(uiMessage('reminder-panel.reminder-content.6535ac6e1b')); fireEvent.change(input, { target: { value: 'Synthetic reminder' } });
    const pending = deferred<any>(), record = { id: 'reminder', content: 'Synthetic reminder', status: 'pending' }; mocks.fetch.mockReturnValueOnce(pending.promise);
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }); }); expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const headers = new Headers(mocks.fetch.mock.calls.at(-1)![1].headers); expect(headers.get('Authorization')).toBe('Bearer synthetic-token'); expect(headers.get('x-lumi-desktop-session')).toBe('synthetic-proof');
    await act(async () => pending.resolve(reply(record))); await screen.findByText(record.content); expect(input).toHaveProperty('value', ''); expect(mocks.fetch).toHaveBeenCalledTimes(2);
    mocks.fetch.mockResolvedValueOnce(reply({ ...record, status: 'fired' })); fireEvent.click(screen.getByTitle(uiMessage('reminder-panel.mark-complete.0115f22552', 'en')));
    await waitFor(() => expect(screen.queryByTitle(uiMessage('reminder-panel.mark-complete.0115f22552', 'en'))).toBeNull()); expect(mocks.fetch).toHaveBeenCalledTimes(3);
    mocks.fetch.mockResolvedValueOnce(reply({})); fireEvent.click(screen.getByTitle(uiMessage('reminder-panel.delete.5b875326d1', 'en'))); await screen.findByRole('alert'); expect(screen.getByText(record.content)).toBeTruthy();
    mocks.fetch.mockResolvedValueOnce(reply({ success: true })); fireEvent.click(screen.getByTitle(uiMessage('reminder-panel.delete.5b875326d1', 'en'))); await waitFor(() => expect(screen.queryByText(record.content)).toBeNull());
    expect(view.container.textContent).toContain(uiMessage('reminder-panel.no-pending-reminders.b06a20dfd7')); expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });

  it('discards a pending personal reminder read when the same user enters work scope', async () => {
    const pending = deferred<any>(); mocks.fetch.mockReturnValueOnce(pending.promise); const view = render(<ReminderPanel />);
    const signal = mocks.fetch.mock.calls[0][1].signal; account.workDomain = 'work'; account.orgConnection = { orgId: 'org-b' };
    mocks.fetch.mockResolvedValue(reply([{ id: 'work', content: 'Work reminder', status: 'pending' }])); view.rerender(<ReminderPanel />); await screen.findByText('Work reminder');
    await act(async () => pending.resolve(reply([{ id: 'private', content: 'Private reminder', status: 'pending' }])));
    expect(signal.aborted).toBe(true); expect(screen.queryByText('Private reminder')).toBeNull();
  });

  it('cannot show an old personal file after entering another knowledge scope', async () => {
    const old = deferred<any>();
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/files/list') && url.includes('domain=personal')) return old.promise;
      if (url.includes('/files/list')) return reply({ files: [{ id: 'new', name: 'work-file.txt', status: 'pending' }] });
      return reply({ tree: [], vaults: [] });
    });
    const view = render(<KnowledgeBase t={{}} isOpen onClose={() => {}} domain="personal" scopeKey="user:personal" />);
    view.rerender(<KnowledgeBase t={{}} isOpen onClose={() => {}} domain="work" scopeKey="user:work:org" />);
    await waitFor(() => expect(screen.getByTestId('knowledge-tree').textContent).toBe('work-file.txt'));
    await act(async () => { old.resolve(reply({ files: [{ id: 'old', name: 'private-file.txt' }] })); });
    expect(screen.getByTestId('knowledge-tree').textContent).toBe('work-file.txt');
    expect(screen.queryByText('private-file.txt')).toBeNull();
  });
});
