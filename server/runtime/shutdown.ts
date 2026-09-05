import type { Express, RequestHandler, Router } from 'express';
import type { Server, Socket } from 'socket.io';
import { requireAdmin, requireLocalRequest, requireUserSession } from '../middleware/auth';
import { DESKTOP_SESSION_HEADER, resolveDesktopSession } from '../config/desktop_bootstrap';
import { ShutdownWorkTracker } from './shutdown_work';

export function withShutdownDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shutdown is still waiting for active work; data has not been discarded. Retry after it settles.')), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class RuntimeShutdownCoordinator {
  private pending: Promise<void> | null = null;
  private saved = false;
  private exitRequested = false;
  private exited = false;
  private replies = 0;

  constructor(private readonly options: {
    stopAdmission: () => void;
    drain: () => Promise<void>;
    saveAndClose: () => Promise<void>;
    exit: () => void;
    timeoutMs?: number;
  }) {}

  request(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.saved) return Promise.resolve();
    this.pending = (async () => {
      this.options.stopAdmission();
      // The deadline wraps draining only. A timed out drain may still settle,
      // but cannot continue into save/close behind the failed caller's back.
      await withShutdownDeadline(this.options.drain(), this.options.timeoutMs ?? 30_000);
      await this.options.saveAndClose();
      this.saved = true;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  beginReply(): () => void {
    this.replies += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.replies -= 1;
      this.maybeExit();
    };
  }

  requestExit(): void {
    this.exitRequested = true;
    this.maybeExit();
  }

  private maybeExit(): void {
    if (!this.saved || !this.exitRequested || this.exited || this.replies > 0) return;
    this.exited = true;
    this.options.exit();
  }
}

export function registerShutdownSignals(
  coordinator: RuntimeShutdownCoordinator,
  target: Pick<NodeJS.Process, 'on' | 'off'> = process,
  onFailure: (error: unknown) => void = error => console.error('[Shutdown] Save failed; process and unsaved data retained:', error),
): () => void {
  const handler = () => { void coordinator.request().then(() => coordinator.requestExit(), onFailure); };
  target.on('SIGINT', handler);
  target.on('SIGTERM', handler);
  return () => { target.off('SIGINT', handler); target.off('SIGTERM', handler); };
}

/** Install before application routes and before any Socket.IO connection listeners. */
export function installShutdownIngress(app: Express, apiRouter: Router, io: Server) {
  const work = new ShutdownWorkTracker();
  let accepting = true;
  let coordinator: RuntimeShutdownCoordinator | undefined;
  const seen = new WeakSet<object>();

  // This authenticated control route must precede the gate and must never be
  // counted among the business requests it waits for. Repeated calls can retry
  // a failed flush without reopening ordinary work admission.
  apiRouter.post('/runtime/shutdown', requireUserSession, requireAdmin, requireLocalRequest, async (req, res) => {
    if (!resolveDesktopSession(req.get(DESKTOP_SESSION_HEADER), req.user!.uid)) {
      res.status(403).json({ error: 'A verified native desktop session is required.' });
      return;
    }
    if (req.body?.expectedPid !== process.pid) {
      res.status(409).json({ error: 'Backend process identity changed; shutdown was not started.' });
      return;
    }
    if (!coordinator) {
      res.status(503).json({ error: 'Backend startup has not completed.' });
      return;
    }
    const current = coordinator;
    const finishReply = current.beginReply();
    res.once('finish', finishReply);
    res.once('close', finishReply);
    res.setHeader('Connection', 'close');
    try {
      await current.request();
      res.status(200).json({ ok: true, status: 'saved', pid: process.pid });
      current.requestExit();
    } catch (error) {
      console.error('[Shutdown] Native close failed; pending data retained:', error);
      res.status(503).json({ error: 'Shutdown could not finish saving. The backend retained pending data; retry closing after the error is resolved.' });
    }
  });

  const gate: RequestHandler = (req, res, next) => {
    // Retain the existing proof-protected native bootstrap for a fresh retry
    // session after a failed close. Its own loopback/one-time-proof checks are
    // unchanged; it is not a business operation and must not enter this drain.
    if (!accepting && req.method === 'POST' && req.path === '/auth/bootstrap') {
      next();
      return;
    }
    if (!accepting) {
      res.setHeader('Connection', 'close');
      res.status(503).json({ error: 'Backend is shutting down; no new work is accepted.' });
      return;
    }
    if (!seen.has(req)) {
      seen.add(req);
      const finish = work.begin();
      // HTTP lifetime is only one lease. The actual handler Promise below is
      // tracked separately, including after a client aborts the transport.
      res.once('finish', finish);
      res.once('close', finish);
    }
    next();
  };
  apiRouter.use(gate);
  app.use(gate);

  io.use((_socket, next) => next(accepting ? undefined : new Error('Backend is shutting down.')));
  io.on('connection', (socket: Socket) => {
    // All production handlers are registered after this listener. Wrap their
    // returned promises, including disconnect cleanup; transport ACK callbacks
    // remain managed by Socket.IO. Preserve removal by the original listener.
    const originalOn = socket.on.bind(socket);
    const originalRemove = socket.removeListener.bind(socket);
    const wrappers = new Map<string, WeakMap<Function, Array<(...args: any[]) => any>>>();
    socket.on = ((event: string, listener: (...args: any[]) => any) => {
      const wrapped = function (this: Socket, ...args: any[]) {
        if (!accepting && event !== 'disconnect' && event !== 'disconnecting') return;
        const finish = work.begin();
        try {
          const result = listener.apply(this, args);
          if (result && typeof result.then === 'function') {
            return Promise.resolve(result).finally(finish);
          }
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      };
      let byListener = wrappers.get(event);
      if (!byListener) { byListener = new WeakMap(); wrappers.set(event, byListener); }
      const registrations = byListener.get(listener) || [];
      registrations.push(wrapped);
      byListener.set(listener, registrations);
      return originalOn(event, wrapped);
    }) as Socket['on'];
    socket.removeListener = ((event: string, listener: (...args: any[]) => any) => {
      const registrations = wrappers.get(event)?.get(listener);
      const wrapped = registrations?.pop();
      return originalRemove(event, wrapped || listener);
    }) as Socket['removeListener'];
    socket.off = socket.removeListener;
  });

  return {
    trackRegisteredHttpHandlers() {
      const visited = new WeakSet<object>();
      const wrapStack = (stack: any[]) => {
        for (const layer of stack || []) {
          if (!layer || visited.has(layer)) continue;
          visited.add(layer);
          // The control request cannot wait for its own handler Promise.
          if (layer.route?.path === '/runtime/shutdown' || layer.route?.path === '/auth/bootstrap') continue;
          if (layer.route?.stack) { wrapStack(layer.route.stack); continue; }
          if (layer.handle?.stack) { wrapStack(layer.handle.stack); continue; }
          const handler = layer.handle;
          if (typeof handler !== 'function') continue;
          const invoke = (receiver: unknown, args: any[]) => {
            const finish = work.begin();
            try {
              const result = handler.apply(receiver, args);
              if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
              finish();
              return result;
            } catch (error) { finish(); throw error; }
          };
          // Express distinguishes error handlers by their declared arity.
          layer.handle = handler.length === 4
            ? function (this: unknown, error: unknown, req: unknown, res: unknown, next: unknown) {
                return invoke(this, [error, req, res, next]);
              }
            : function (this: unknown, req: unknown, res: unknown, next: unknown) {
                return invoke(this, [req, res, next]);
              };
        }
      };
      // Express 4 exposes its registered Layer stack here. Walk only after all
      // routes are mounted, preserving router order, params and error arity.
      wrapStack((app as any)._router?.stack || []);
      wrapStack((apiRouter as any).stack || []);
    },
    configure(value: RuntimeShutdownCoordinator) { coordinator = value; },
    stopAdmission() {
      if (!accepting) return;
      accepting = false;
      io.disconnectSockets(true);
    },
    waitForIdle: () => work.waitForIdle(),
    isAccepting: () => accepting,
  };
}

export type ShutdownIngress = ReturnType<typeof installShutdownIngress>;
