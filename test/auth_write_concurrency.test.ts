import './helpers';
import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
const probe = vi.hoisted(() => ({ hashWait: null as null | (() => Promise<void>) }));
vi.mock('bcryptjs', async original => {
  const actual = await original<typeof import('bcryptjs')>();
  return { ...actual, default: { ...actual.default, hash: async (value: string, rounds: number) => {
    const result = await actual.default.hash(value, rounds);
    await probe.hashWait?.();
    return result;
  } } };
});
vi.mock('../server/config/supabase', () => ({ syncUserToSupabase: async () => null }));
import bcrypt from 'bcryptjs';
import { makeApp, COOKIE_OPTS, JWT_SECRET } from './helpers';
import { mountAuthRoutes } from '../server/routes/auth';
import { readDB, writeDB, flushDBOrThrow, querySQL } from '../db_layer';
import { upsertUserPreferredLLM, getUserPreferredLLM } from '../server/llm/user_preferences';
import { initializeDesktopBootstrapProof, getDesktopBootstrapProofPath, resetDesktopBootstrapStateForTests } from '../server/config/desktop_bootstrap';
let app: Awaited<ReturnType<typeof makeApp>>;
let userId: string;
let token: string;
const password = 'Synthetic-current-password-42';
const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${app.url}/api${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
});
beforeAll(async () => {
  app = await makeApp(); mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
  userId = `audit10-${randomUUID()}`;
  const db = readDB(); db.users.push({ uid: userId, username: userId, password: await bcrypt.hash(password, 10), role: 'user', phone: 'synthetic', balance: 0, createdAt: new Date().toISOString() }); writeDB(db);
  await flushDBOrThrow();
  token = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
});
afterEach(() => { probe.hashWait = null; });
afterAll(() => app.cleanup());

it('lets a bearer-authenticated native user change its password', async () => {
  expect((await fetch(`${app.url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  const result = await post('/auth/change-password', { currentPassword: password, newPassword: password }, { Authorization: `Bearer ${token}` });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ success: true });
});

it('control: the same account and password work with cookie authentication', async () => {
  const result = await post('/auth/change-password', { currentPassword: password, newPassword: password }, { Cookie: `token=${token}` });
  expect(result.status).toBe(200); expect(await result.json()).toEqual({ success: true });
});

it('preserves a later durable model choice when a slower registration completes', async () => {
  upsertUserPreferredLLM(userId, { provider: 'openai', model: 'synthetic-original-model' });
  await flushDBOrThrow();
  let entered!: () => void; const atHash = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  probe.hashWait = async () => { entered(); await held; };
  const pending = post('/auth/register', { username: `audit10-new-${randomUUID()}`, password, phone: 'synthetic' });
  await atHash;
  try {
    upsertUserPreferredLLM(userId, { provider: 'openai', model: 'synthetic-later-model' });
    await flushDBOrThrow();
    const saved = await querySQL<any>('SELECT value FROM settings WHERE key = ?', [`llm_prefs_${userId}`]);
    expect(saved[0].value).toContain('synthetic-later-model');
    release();
    expect((await pending).status).toBe(200);
    await flushDBOrThrow();
    expect(getUserPreferredLLM(userId).model).toBe('synthetic-later-model');
    const overwritten = await querySQL<any>('SELECT value FROM settings WHERE key = ?', [`llm_prefs_${userId}`]);
    expect(overwritten[0].value).toContain('synthetic-later-model');
  } finally { release(); }
});

it('preserves later settings and rejects an older password change after another password change wins', async () => {
  let entered!: () => void; const atHash = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  probe.hashWait = async () => { entered(); await held; };
  const pending = post('/auth/change-password', { currentPassword: password, newPassword: 'Synthetic-stale-password' }, { Authorization: `Bearer ${token}` });
  await atHash;
  probe.hashWait = null;
  try {
    upsertUserPreferredLLM(userId, { provider: 'openai', model: 'synthetic-concurrent-setting' });
    const winner = await post('/auth/change-password', { currentPassword: password, newPassword: 'Synthetic-winning-password' }, { Authorization: `Bearer ${token}` });
    expect(winner.status).toBe(200);
    release();
    expect((await pending).status).toBe(409);
    await flushDBOrThrow();
    expect(getUserPreferredLLM(userId).model).toBe('synthetic-concurrent-setting');
    const saved = readDB().users.find(user => user.uid === userId)!;
    expect(await bcrypt.compare('Synthetic-winning-password', saved.password)).toBe(true);
    expect(await bcrypt.compare('Synthetic-stale-password', saved.password)).toBe(false);
  } finally { release(); }
});

it('rechecks username uniqueness after two registrations finish hashing concurrently', async () => {
  let entered!: () => void; const bothAtHash = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = 0;
  probe.hashWait = async () => { if (++waiting === 2) entered(); await held; };
  const username = `audit10-race-${randomUUID()}`;
  const pending = [post('/auth/register', { username, password, phone: 'synthetic' }), post('/auth/register', { username, password, phone: 'synthetic' })];
  await bothAtHash;
  release();
  expect((await Promise.all(pending)).map(response => response.status).sort()).toEqual([200, 400]);
  expect(readDB().users.filter(user => user.username === username)).toHaveLength(1);
});

it('control: sequential registration and a later model save preserve the new choice', async () => {
  expect((await post('/auth/register', { username: `audit10-serial-${randomUUID()}`, password, phone: 'synthetic' })).status).toBe(200);
  upsertUserPreferredLLM(userId, { provider: 'openai', model: 'synthetic-sequential-model' });
  await flushDBOrThrow();
  expect(getUserPreferredLLM(userId).model).toBe('synthetic-sequential-model');
});

it('two first-run bootstraps share one durable admin and preserve settings saved during hashing', async () => {
  const db = readDB();
  writeDB({ ...db, users: db.users.filter(user => user.username !== 'admin') });
  await flushDBOrThrow();
  initializeDesktopBootstrapProof();
  const nativeClientIdentity = {
    schemaVersion: 1, clientKind: 'tauri', pid: process.pid,
    startedAtUnixMs: Math.floor((Date.now() - 10000) / 1000) * 1000,
    executablePath: process.execPath, executableSha256: 'd'.repeat(64), binaryHashUnavailable: false,
    buildId: 'a'.repeat(40), buildIdSemantics: 'baseline_commit', sourceFingerprint: 'e'.repeat(64),
    sourceDirty: false, appVersion: '3.1.0',
  };
  let enteredFirst!: () => void; const firstHashed = new Promise<void>(resolve => { enteredFirst = resolve; });
  let enteredBoth!: () => void; const bothHashed = new Promise<void>(resolve => { enteredBoth = resolve; });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  probe.hashWait = async () => { count += 1; if (count === 1) enteredFirst(); if (count === 2) enteredBoth(); await held; };
  const bootstrap = () => post('/auth/bootstrap', { nativeClientIdentity }, {
    'X-Lumi-Desktop-Bootstrap': JSON.parse(fs.readFileSync(getDesktopBootstrapProofPath(), 'utf8')).proof,
  });
  const first = bootstrap();
  await firstHashed;
  const second = bootstrap();
  await bothHashed;
  try {
    upsertUserPreferredLLM(userId, { provider: 'openai', model: 'synthetic-bootstrap-concurrent-model' });
    await flushDBOrThrow();
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(bodies[0].user.uid).toBe(bodies[1].user.uid);
    expect(readDB().users.filter(user => user.username === 'admin')).toHaveLength(1);
    expect((await querySQL<any>('SELECT uid FROM users WHERE username = ?', ['admin']))).toHaveLength(1);
    expect(getUserPreferredLLM(userId).model).toBe('synthetic-bootstrap-concurrent-model');
  } finally { release(); probe.hashWait = null; resetDesktopBootstrapStateForTests({ removeFile: true }); }
});
