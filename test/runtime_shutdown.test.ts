import { JWT_SECRET, makeApp } from './helpers';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdownIngress, registerShutdownSignals, RuntimeShutdownCoordinator } from '../server/runtime/shutdown';
import { ShutdownWorkTracker } from '../server/runtime/shutdown_work';
import { issueDesktopSessionProof } from '../server/config/desktop_bootstrap';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('shutdown coordinator', () => {
  it('a second signal waits for the original drain and save and exits only once', async () => {
    const drain = deferred();
    const save = deferred();
    const events: string[] = [];
    const coordinator = new RuntimeShutdownCoordinator({
      stopAdmission: () => events.push('stop'),
      drain: () => drain.promise,
      saveAndClose: async () => { events.push('save-start'); await save.promise; events.push('saved'); },
      exit: () => events.push('exit'),
    });
    const signals = new EventEmitter();
    const uninstall = registerShutdownSignals(coordinator, signals as any);
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    expect(events).toEqual(['stop']);
    drain.resolve();
    await vi.waitFor(() => expect(events).toContain('save-start'));
    expect(events).not.toContain('exit');
    save.resolve();
    await vi.waitFor(() => expect(events).toEqual(['stop', 'save-start', 'saved', 'exit']));
    uninstall();
  });

  it('save failure never exits and a subsequent request can retry the same pending data', async () => {
    const exit = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const coordinator = new RuntimeShutdownCoordinator({ stopAdmission() {}, drain: async () => {}, saveAndClose: save, exit });
    const first = coordinator.request();
    expect(coordinator.request()).toBe(first);
    await expect(first).rejects.toThrow('disk full');
    coordinator.requestExit();
    expect(exit).not.toHaveBeenCalled();
    await coordinator.request();
    coordinator.requestExit();
    expect(save).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a timed out active operation cannot silently save or exit after the failed request', async () => {
    const work = deferred();
    const save = vi.fn(async () => {});
    const exit = vi.fn();
    const coordinator = new RuntimeShutdownCoordinator({ stopAdmission() {}, drain: () => work.promise, saveAndClose: save, exit, timeoutMs: 20 });
    await expect(coordinator.request()).rejects.toThrow(/still waiting/);
    work.resolve();
    await work.promise;
    expect(save).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await coordinator.request();
    coordinator.requestExit();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('tracks detached work created by another admitted operation until its real completion', async () => {
    const tracker = new ShutdownWorkTracker();
    const outer = deferred();
    const inner = deferred();
    const first = tracker.track(outer.promise.then(() => { void tracker.track(inner.promise); }));
    const done = vi.fn();
    const drained = tracker.waitForIdle().then(done);
    outer.resolve();
    await first;
    expect(done).not.toHaveBeenCalled();
    inner.resolve();
    await drained;
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe.sequential('authenticated shutdown ingress', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function setup(saveAndClose = vi.fn(async () => {})) {
    const context = await makeApp();
    const io = new Server(context.server, { serveClient: false });
    servers.push(io);
    const ingress = installShutdownIngress(context.app, context.apiRouter, io);
    const exit = vi.fn();
    const coordinator = new RuntimeShutdownCoordinator({
      stopAdmission: ingress.stopAdmission,
      drain: ingress.waitForIdle,
      saveAndClose,
      exit,
      timeoutMs: 2_000,
    });
    ingress.configure(coordinator);
    const token = jwt.sign({ uid: 'shutdown-admin', username: 'admin', role: 'admin', tokenType: 'user' }, JWT_SECRET);
    const proof = issueDesktopSessionProof('shutdown-admin', {
      schemaVersion: 1, clientKind: 'tauri', pid: process.pid,
      startedAtUnixMs: Date.now() - 10_000, executablePath: process.execPath,
      executableSha256: 'd'.repeat(64), binaryHashUnavailable: false,
      buildId: 'a'.repeat(40), buildIdSemantics: 'baseline_commit',
      sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.0',
    }).proof;
    const headers = { authorization: `Bearer ${token}`, 'x-lumi-desktop-session': proof, 'content-type': 'application/json' };
    const request = (overrideHeaders = headers, expectedPid = process.pid) => fetch(`${context.url}/api/runtime/shutdown`, {
      method: 'POST', headers: overrideHeaders, body: JSON.stringify({ expectedPid }), signal: AbortSignal.timeout(5_000),
    });
    return { ...context, io, ingress, coordinator, exit, saveAndClose, headers, request };
  }

  it('requires local native proof plus an ordinary admin session and binds the exact process', async () => {
    const app = await setup();
    app.ingress.trackRegisteredHttpHandlers();
    expect((await app.request({ 'content-type': 'application/json' } as any)).status).toBe(401);
    expect((await app.request({ ...app.headers, 'x-lumi-desktop-session': '' })).status).toBe(403);
    const branch = jwt.sign({ uid: 'shutdown-admin', role: 'admin', tokenType: 'organization_branch' }, JWT_SECRET);
    expect((await app.request({ ...app.headers, authorization: `Bearer ${branch}` })).status).toBe(403);
    const other = jwt.sign({ uid: 'other-admin', role: 'admin', tokenType: 'user' }, JWT_SECRET);
    expect((await app.request({ ...app.headers, authorization: `Bearer ${other}` })).status).toBe(403);
    expect((await app.request(app.headers, process.pid + 1)).status).toBe(409);
    expect(app.ingress.isAccepting()).toBe(true);
    expect(app.saveAndClose).not.toHaveBeenCalled();
    const response = await app.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'saved', pid: process.pid });
    expect(app.exit).toHaveBeenCalledTimes(1);
  });

  it('waits for HTTP handlers, rejects new work, and keeps the close request outside its own drain', async () => {
    const app = await setup();
    const started = deferred();
    const release = deferred();
    app.apiRouter.post('/write', async (_req, res) => { started.resolve(); await release.promise; res.json({ written: true }); });
    app.ingress.trackRegisteredHttpHandlers();
    const write = fetch(`${app.url}/api/write`, { method: 'POST' });
    await started.promise;
    const closing = app.request();
    await vi.waitFor(() => expect(app.ingress.isAccepting()).toBe(false));
    expect((await fetch(`${app.url}/api/write`, { method: 'POST' })).status).toBe(503);
    expect(app.saveAndClose).not.toHaveBeenCalled();
    release.resolve();
    await write;
    expect((await closing).status).toBe(200);
    expect(app.saveAndClose).toHaveBeenCalledTimes(1);
  });

  it('a disconnected HTTP client still waits for its handler, then allows shutdown to complete', async () => {
    const app = await setup();
    const started = deferred();
    const release = deferred();
    const committed = vi.fn();
    app.apiRouter.post('/write', async (_req, res) => { started.resolve(); await release.promise; committed(); res.end(); });
    app.ingress.trackRegisteredHttpHandlers();
    const client = http.request(`${app.url}/api/write`, { method: 'POST' });
    client.on('error', () => {});
    client.end();
    await started.promise;
    client.destroy();
    const closing = app.request();
    await vi.waitFor(() => expect(app.ingress.isAccepting()).toBe(false));
    expect(app.saveAndClose).not.toHaveBeenCalled();
    release.resolve();
    expect((await closing).status).toBe(200);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(app.saveAndClose).toHaveBeenCalledTimes(1);
  });

  it('failed persistence returns failure and the authenticated endpoint remains retryable', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const app = await setup(save);
    app.ingress.trackRegisteredHttpHandlers();
    expect((await app.request()).status).toBe(503);
    expect(app.exit).not.toHaveBeenCalled();
    expect((await app.request()).status).toBe(200);
    expect(app.exit).toHaveBeenCalledTimes(1);
  });

  it('awaits socket handlers and their asynchronous disconnect cleanup before saving', async () => {
    const app = await setup();
    const started = deferred();
    const release = deferred();
    const disconnectRelease = deferred();
    const disconnected = deferred();
    app.io.on('connection', socket => {
      socket.on('write', async () => { started.resolve(); await release.promise; });
      socket.on('disconnect', async () => { disconnected.resolve(); await disconnectRelease.promise; });
    });
    app.ingress.trackRegisteredHttpHandlers();
    const client = connectSocket(app.url, { transports: ['websocket'], reconnection: false });
    await new Promise<void>(resolve => client.once('connect', resolve));
    client.emit('write');
    await started.promise;
    const closing = app.request();
    await disconnected.promise;
    release.resolve();
    await release.promise;
    expect(app.saveAndClose).not.toHaveBeenCalled();
    disconnectRelease.resolve();
    expect((await closing).status).toBe(200);
    client.close();
  });

  it('preserves socket listener removal for the same function on different events and duplicate registrations', async () => {
    const app = await setup();
    const installed = deferred();
    app.io.on('connection', socket => {
      const listener = vi.fn();
      socket.on('first', listener);
      socket.on('second', listener);
      socket.on('first', listener);
      socket.off('first', listener);
      expect(socket.listenerCount('first')).toBe(1);
      expect(socket.listenerCount('second')).toBe(1);
      socket.off('first', listener);
      expect(socket.listenerCount('first')).toBe(0);
      expect(socket.listenerCount('second')).toBe(1);
      socket.off('second', listener);
      expect(socket.listenerCount('second')).toBe(0);
      installed.resolve();
    });
    const client = connectSocket(app.url, { transports: ['websocket'], reconnection: false });
    await installed.promise;
    client.close();
  });
});
