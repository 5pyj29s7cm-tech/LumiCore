import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { makeApp, JWT_SECRET } from './helpers';
const mocks = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => mocks.model(...args),
  makeLLMCallStreaming: (...args: any[]) => mocks.model(...args),
}));
import { mountChatRoutes } from '../server/routes/chat_routes';
import { installShutdownIngress, RuntimeShutdownCoordinator } from '../server/runtime/shutdown';
import { runtimeShutdownCancellation } from '../server/runtime/shutdown_work';
import { RuntimeFaultState } from '../server/runtime/fault_state';
import { issueDesktopSessionProof, DESKTOP_SESSION_HEADER } from '../server/config/desktop_bootstrap';
import { flushDBOrThrow } from '../db_layer';
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
const userId = 'rest-shutdown-fixture-admin';
const token = jwt.sign({ uid: userId, username: 'rest-shutdown-fixture', role: 'admin', tokenType: 'user' }, JWT_SECRET);
const chatHeaders = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const controllers: AbortController[] = [];
const gates: ReturnType<typeof deferred>[] = [];
const pendingFetches: Promise<unknown>[] = [];
let app: Awaited<ReturnType<typeof makeApp>>;
let io: Server;
let ingress: ReturnType<typeof installShutdownIngress>;
const save = vi.fn(async () => { await flushDBOrThrow(); });
const exit = vi.fn();
let closeHeaders: Record<string, string>;
beforeAll(async () => {
  app = await makeApp(); io = new Server(app.server, { serveClient: false });
  ingress = installShutdownIngress(app.app, app.apiRouter, io, new RuntimeFaultState());
  const unavailable = () => null;
  mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: unavailable, getGemini: unavailable, getOpenAI: unavailable, getAnthropic: unavailable, getQwen: unavailable });
  ingress.trackRegisteredHttpHandlers();
  ingress.configure(new RuntimeShutdownCoordinator({
    stopAdmission() { runtimeShutdownCancellation.request(); ingress.stopAdmission(); },
    drain: ingress.waitForIdle, saveAndClose: save, exit, timeoutMs: 5_000,
  }));
  const proof = issueDesktopSessionProof(userId, {
    schemaVersion: 1, clientKind: 'local_acceptance_harness', pid: process.pid, startedAtUnixMs: Date.now() - 10_000,
    executablePath: process.execPath, executableSha256: 'a'.repeat(64), binaryHashUnavailable: false,
    buildId: 'b'.repeat(40), buildIdSemantics: 'baseline_commit', sourceFingerprint: 'c'.repeat(64), sourceDirty: false, appVersion: '3.1.1',
  }).proof;
  closeHeaders = { ...chatHeaders, [DESKTOP_SESSION_HEADER]: proof };
});
afterAll(async () => {
  for (const controller of controllers) controller.abort();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(pendingFetches);
  if (io) await new Promise<void>(resolve => io.close(() => resolve()));
  app?.cleanup();
});
function request(message: string, stream = false) {
  const controller = new AbortController(); controllers.push(controller);
  const response = fetch(app.url + '/api/chat' + (stream ? '?stream=true' : ''), {
    method: 'POST', headers: chatHeaders, body: JSON.stringify({ message }), signal: controller.signal,
  });
  pendingFetches.push(response.catch(() => undefined));
  return { controller, response };
}
describe.sequential('real REST and SSE chat runtime shutdown cancellation', () => {
  let completedSignal: AbortSignal | undefined;
  it('preserves a normally completed response and releases its shutdown registration', async () => {
    mocks.model.mockImplementationOnce(async (_messages: any, _declarations: any, config: any) => {
      completedSignal = config.signal; return { text: 'A synthetic cloud crosses the sky.', toolCalls: [], usageRecords: [] };
    });
    const { response } = request('Tell me a short synthetic story about a cloud.');
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ text: 'A synthetic cloud crosses the sky.', finalized: true, blocked: false });
    expect(completedSignal?.aborted).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('preserves user transport cancellation and waits for the real model to settle', async () => {
    let signal: AbortSignal | undefined; const finished = deferred();
    mocks.model.mockImplementationOnce(async (_messages: any, _declarations: any, config: any) => {
      signal = config.signal;
      try { await new Promise<void>(resolve => signal!.aborted ? resolve() : signal!.addEventListener('abort', () => resolve(), { once: true })); throw signal!.reason; }
      finally { finished.resolve(); }
    });
    const client = request('Tell me a short synthetic story about a lake.');
    const rejected = expect(client.response).rejects.toThrow();
    await vi.waitFor(() => expect(signal).toBeDefined());
    client.controller.abort(); await rejected; await finished.promise;
    expect(signal!.aborted).toBe(true); expect(save).not.toHaveBeenCalled();
  });
  it('aborts active buffered and SSE calls, sends truthful failure terminals, and saves only after both actual handlers settle', async () => {
    const signals = new Map<string, AbortSignal>();
    const started = { STREAM: deferred(), BUFFER: deferred() };
    const release = { STREAM: deferred(), BUFFER: deferred() }; gates.push(...Object.values(release));
    mocks.model.mockImplementation(async (messages: any[], _declarations: any, config: any, stream?: (chunk: string) => void) => {
      const key = messages.some(message => String(message.content).includes('STREAM_017')) ? 'STREAM' : 'BUFFER';
      const signal = config.signal as AbortSignal; signals.set(key, signal);
      if (key === 'STREAM') stream?.('A synthetic cloud drifts over a lake.');
      started[key].resolve();
      await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }));
      await release[key].promise;
      throw signal.reason;
    });
    const stream = request('Tell me a synthetic STREAM_017 story about clouds.', true);
    const buffer = request('Tell me a synthetic BUFFER_017 story about the moon.');
    await Promise.all([started.STREAM.promise, started.BUFFER.promise]);
    const closing = fetch(app.url + '/api/runtime/shutdown', { method: 'POST', headers: closeHeaders, body: JSON.stringify({ expectedPid: process.pid }) });
    pendingFetches.push(closing.catch(() => undefined));
    try {
      await vi.waitFor(() => { expect(signals.get('STREAM')?.aborted).toBe(true); expect(signals.get('BUFFER')?.aborted).toBe(true); }, { timeout: 700 });
      expect(completedSignal?.aborted).toBe(false);
      expect(save).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
      expect((await fetch(app.url + '/api/chat', { method: 'POST', headers: chatHeaders, body: JSON.stringify({ message: 'New work must be rejected.' }) })).status).toBe(503);
      release.BUFFER.resolve();
      const buffered = await buffer.response;
      expect(buffered.status).toBe(503);
      expect(await buffered.json()).toMatchObject({ code: 'CHAT_REQUEST_CANCELLED', failed: true, done: true });
      expect(save).not.toHaveBeenCalled();
      release.STREAM.resolve();
      const streamed = await stream.response;
      expect(streamed.headers.get('content-type')).toContain('text/event-stream');
      const frames = (await streamed.text()).trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')));
      expect(frames.at(-1)).toMatchObject({ code: 'CHAT_REQUEST_CANCELLED', failed: true, done: true });
      expect(frames.some(frame => frame.finalized === true && frame.blocked === false)).toBe(false);
      const closed = await closing;
      expect(closed.status).toBe(200); expect(await closed.json()).toEqual({ ok: true, status: 'saved', pid: process.pid });
      expect(save).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      stream.controller.abort(); buffer.controller.abort(); release.STREAM.resolve(); release.BUFFER.resolve();
      await Promise.allSettled([stream.response, buffer.response, closing]);
    }
  });
});
