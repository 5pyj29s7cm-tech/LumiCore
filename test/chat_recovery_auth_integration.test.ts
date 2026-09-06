import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readDB, writeDB } from '../db_layer';
import { mountAuthRoutes } from '../server/routes/auth';
import { chatExecutionStorageKey, ownedPendingChatExecutions } from '../src/lib/chatExecutionRecovery';
import { ChatRequestLedger, upsertPersistedPendingChatExecution } from '../src/lib/chatEventReceipts';
import { ChatViewWorkRegistry } from '../src/lib/chatViewWork';
import { mergeNotificationState, notificationClearStorageKey } from '../src/lib/notificationState';

// Exercise the real auth response, context refresh and page recovery callbacks.
function extract(file: string, name: string, dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      const init = node.initializer;
      expression = ts.isCallExpression(init) && ['useCallback', 'useMemo'].includes(init.expression.getText(ast))
        ? init.arguments[0].getText(ast) : init.getText(ast);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = node.getText(ast).replace(/^export\s+/, '');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!expression) throw new Error(`Missing production expression ${file}:${name}`);
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, dependencies);
}
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
    authService: { getMe }, setUser: (value: any) => { user = value; },
    notificationService: { fetchNotifications: async () => ({ notifications: [] }) },
    notificationClearStorageKey, mergeNotificationState,
    localStorage: { getItem: () => null, setItem: noop },
    setNotifications: (update: any) => update([]),
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
    setToolOverrides: noop, setOrgConnection: noop, console,
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
    activeChatRequestIdRef: { current: null }, textChatActiveRef: { current: false },
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
  const shell = fs.readFileSync('src/entries/useAppShell.ts', 'utf8');
  const entry = fs.readFileSync('src/entries/desktop.tsx', 'utf8');
  const desktop = fs.readFileSync('src/components/DesktopUI.tsx', 'utf8');
  expect(shell).toContain('const { user, loading, logout, refreshUser } = useApp()');
  expect(shell).toMatch(/return\s*\{\s*user, loading/);
  expect(entry).toMatch(/<DesktopUI[^>]*user=\{shell.user\}/);
  expect(desktop).toMatch(/<AgentChatPage\s+t=\{t\}\s+user=\{user\}/);
});
