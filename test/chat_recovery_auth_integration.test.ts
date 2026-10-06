import { readImplementationSource } from './implementation_source';
import fs from 'node:fs';
import { extractSourceExpression as extract } from './source_expression';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readDB, writeDB } from '../db_layer';
import { mountAuthRoutes } from '../server/routes/auth';
import { chatExecutionStorageKey, ownedPendingChatExecutions } from '../src/lib/chatExecutionRecovery';
import { ChatRequestLedger, upsertPersistedPendingChatExecution } from '../src/lib/chatEventReceipts';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { mergeNotificationState, notificationClearStorageKey } from '../src/lib/notificationState';

// Exercise the real auth response, context refresh and page recovery callbacks.

const page = 'src/components/AgentChatPage.tsx';
const noop = () => {};
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  app = await makeApp();
  mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
  const db = readDB();
  db.users.push(...['user', 'admin'].map(role => ({
    uid: `round6-${role}`, username: `round6-${role}`, password: 'synthetic-unusable', role, balance: 0,
    createdAt: new Date().toISOString(),
  })));
  writeDB(db);
});
afterAll(() => app?.cleanup());

async function authenticatedPageUser(role: string) {
  const token = jwt.sign({ uid: `round6-${role}`, username: `round6-${role}`, role }, JWT_SECRET);
  const getMe = extract('src/services/authService.ts', 'getMe', {
    apiFetch: (route: string) => fetch(`${app.url}${route}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    }),
  });
  let user: any;
  const refresh = extract('src/contexts/AppContext.tsx', 'refreshUser', {
    authService: { getMe }, setSessionUser: (value: any) => { user = value; },
    notificationService: { fetchNotifications: async () => ({ notifications: [] }) },
    notificationClearStorageKey, mergeNotificationState,
    notificationRevisionRef: { current: 0 }, notificationWriteRef: { current: null },
    localStorage: { getItem: () => null, setItem: noop },
    setNotifications: (update: any) => update([]),
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
    setToolOverrides: noop, setOrgConnection: noop, console,
    authGenerationRef: { current: 0 }, toolRequestRef: { current: 0 }, toolOverridesRef: { current: {} },
  });
  await refresh();
  expect(user).toMatchObject({ uid: `round6-${role}`, role, provider: 'custom' });
  expect(user).not.toHaveProperty('id');
  return user;
}

function recoveryHarness(user: any, data = new Map<string, string>()) {
  const chatRecoveryUserId = extract(page, 'chatRecoveryUserId', { user });
  const recoveryOwner = extract(page, 'recoveryOwner', {
    chatRecoveryUserId, agentId: 'lumi', activeDomain: 'personal', activeOrgId: undefined,
    chatExecutionSource: 'command-center-chat',
  })();
  const key = chatExecutionStorageKey(recoveryOwner);
  const localStorage = {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => { data.set(name, value); },
    removeItem: (name: string) => { data.delete(name); },
  };
  const socket = { emit: vi.fn() };
  const dependencies = {
    activeExecutionStorageKey: key, chatRecoveryUserId, recoveryOwner,
    activeDomain: 'personal', activeOrgId: undefined, chatExecutionSource: 'command-center-chat', agentId: 'lumi',
    localStorage, ownedPendingChatExecutions, upsertPersistedPendingChatExecution,
    attachmentConversationIdRef: { current: 'synthetic-conversation' },
    activeMediaGenerationRef: { current: null },
    recoveryAttempt: 0, disposed: false, chatViewWorkRef: { current: new ChatViewWorkRegistry() },
    ACTIVE_CHAT_EXECUTION_TTL_MS: 86400000, clearPersistedExecution: noop,
    isOfficeCommandCenter: true, chatRequestLedgerRef: { current: new ChatRequestLedger() },

    chatTurnTimerGuardRef: { current: { begin: noop } }, setIsTyping: noop,
    lastResumedRequestIdsRef: { current: new Set() }, pushChatProgress: noop,
    uiMessage: (key: string) => key, isZh: true, socket,
  };
  return {
    key, data, socket,
    persist: extract(page, 'persistActiveExecution', dependencies),
    resume: extract(page, 'resumeActiveExecution', dependencies),
  };
}

it.each(['user', 'admin'])('recovers a remounted chat with the actual authenticated %s identity', async role => {
  const user = await authenticatedPageUser(role);
  const h = recoveryHarness(user);
  h.persist('synthetic-request');
  expect(JSON.parse(h.data.get(h.key)!).pending[0].userId).toBe(user.uid);
  const remounted = recoveryHarness(await authenticatedPageUser(role), h.data);
  await remounted.resume();
  expect(remounted.socket.emit).toHaveBeenCalledWith('agent:execution_resume', expect.objectContaining({
    requestId: 'synthetic-request', conversationId: 'synthetic-conversation',
  }), expect.any(Function));
});

it('uses the stable uid even when display identity fields change, and isolates another login', async () => {
  const user = await authenticatedPageUser('admin');
  const h = recoveryHarness(user);
  h.persist('synthetic-request');
  const renamed = recoveryHarness({ ...user, username: 'new-display-name', id: 'unrelated-id' }, h.data);
  expect(renamed.key).toBe(h.key);
  await renamed.resume();
  expect(renamed.socket.emit).toHaveBeenCalledTimes(1);
  const other = recoveryHarness({ ...await authenticatedPageUser('user'), username: user.username }, h.data);
  expect(other.key).not.toBe(h.key);
  await other.resume();
  expect(other.socket.emit).not.toHaveBeenCalled();
  expect(h.data.has(h.key)).toBe(true);
});

it('does not assign an unverified legacy display identity to a recovery owner', async () => {
  const h = recoveryHarness({ id: 'legacy-id', username: 'display-name' });
  h.persist('synthetic-request');
  await h.resume();
  expect(h.key).toBe('');
  expect(h.data.size).toBe(0);
  expect(h.socket.emit).not.toHaveBeenCalled();
});

it('passes the context user through the shell and desktop to AgentChatPage', () => {
  const shell = readImplementationSource('src/entries/useAppShell.ts', 'utf8');
  const entry = readImplementationSource('src/entries/desktop.tsx', 'utf8');
  const desktop = readImplementationSource('src/components/DesktopUI.tsx', 'utf8');
  expect(shell).toContain('const { user, loading, logout, refreshUser } = useApp()');
  expect(shell).toMatch(/return\s*\{\s*user, loading/);
  expect(entry).toMatch(/<DesktopUI[^>]*user=\{shell.user\}/);
  expect(desktop).toMatch(/<AgentChatPage\s+t=\{t\}\s+user=\{user\}/);
});

it.each([
  ['personal', 'known', true, { success: true, token: 'personal-token', orgId: null, orgRole: null }, true],
  ['work', 'known', true, { success: true, token: 'work-token', orgId: 'known-org', orgRole: 'admin' }, true],
  ['work', 'discover', true, { success: true, token: 'work-token', orgId: 'discovered-org', orgRole: 'member' }, true],
  ['work', 'empty', true, {}, false],
  ['work', 'known', true, {}, false],
  ['work', 'known', false, { error: 'denied' }, false],
  ['personal', 'known', false, { error: 'denied' }, false],
] as const)('switches %s/%s only after the server accepts the scope (%s)', async (domain, initial, ok, response, success) => {
  const orgConnection = initial === 'known' ? { orgId: 'known-org', orgRole: 'member', orgName: 'Known', connected: true } : null;
  const stored = new Map<string, string>();
  const apiFetch = vi.fn(async (route: string) => ({ ok, status: ok ? 200 : 403, json: async () => route.endsWith('/orgs')
    ? { orgs: initial === 'discover' ? [{ id: 'discovered-org', name: 'Discovered' }] : [] } : response }));
  const setWorkDomain = vi.fn(), setOrgConnection = vi.fn(), dispatchEvent = vi.fn(), refreshAuth = vi.fn();
  const switchDomain = extract('src/contexts/AppContext.tsx', 'switchDomain', {
    orgConnection, apiJson: extract('src/services/apiClient.ts', 'apiJson', { apiFetch }), setWorkDomain, setOrgConnection, CustomEvent,
    authGenerationRef: { current: 0 }, domainSwitchRequest: { current: null }, AbortController, AbortSignal,
    translate: (key: string) => key, localStorage: { setItem: (key: string, value: string) => stored.set(key, value) },
    socketService: { refreshAuth }, window: { dispatchEvent },
  });
  expect(await switchDomain(domain)).toMatchObject({ success, domain });
  if (!success) {
    expect(stored.size).toBe(0);
    for (const callback of [setWorkDomain, setOrgConnection, dispatchEvent, refreshAuth]) expect(callback).not.toHaveBeenCalled();
    return;
  }
  expect(setWorkDomain).toHaveBeenCalledExactlyOnceWith(domain);
  expect(stored.get('lumi_work_domain')).toBe(domain);
  expect(dispatchEvent).toHaveBeenCalledTimes(1);
  expect(dispatchEvent.mock.calls[0][0].detail).toMatchObject({ domain, orgId: domain === 'work' ? (response as any).orgId : null });
  expect(refreshAuth).toHaveBeenCalledTimes('token' in response ? 1 : 0);
  const request = (apiFetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(request.body))).toEqual({ orgId: domain === 'personal' ? null : initial === 'known' ? 'known-org' : 'discovered-org' });
  if (domain === 'personal') expect(setOrgConnection).not.toHaveBeenCalled();
});
