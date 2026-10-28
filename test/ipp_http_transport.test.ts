import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestIppHttp } from '../server/devices/ipp_http';

const body = Buffer.from([9, 9, 1, 1, 0, 11, 0, 255, 128, 13, 10, 0, 3, 9]).subarray(2, 13);
const responseBytes = Buffer.from([1, 1, 0, 0, 0, 0, 0, 42, 4, 3]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

type Fixture = {
  url: URL;
  controller: AbortController;
  connections: Socket[];
  requests: IncomingMessage[];
  assertConnectionsClosed: () => Promise<void>;
};

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (fixture: Fixture) => Promise<void>,
) {
  const connections: Socket[] = [], closures: Promise<void>[] = [], requests: IncomingMessage[] = [];
  const handlerErrors: unknown[] = [];
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    requests.push(req);
    void Promise.resolve().then(() => handler(req, res)).catch(error => { handlerErrors.push(error); res.destroy(); });
  });
  server.on('connection', socket => {
    connections.push(socket);
    closures.push(new Promise<void>(resolve => socket.once('close', () => resolve())));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await run({
      url: new URL(`http://127.0.0.1:${port}/ipp/print`), controller, connections, requests,
      assertConnectionsClosed: async () => {
        expect(connections.length).toBeGreaterThan(0);
        await bounded(Promise.all(closures), 'Transport left a requested TCP connection open');
        expect(connections.every(socket => socket.destroyed)).toBe(true);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      },
    });
    expect(handlerErrors).toEqual([]);
  } finally {
    controller.abort();
    for (const socket of connections) socket.destroy();
    await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'HTTP test server did not close');
    expect(server.listening).toBe(false);
  }
}

async function readRequest(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('native read-only IPP HTTP transport', () => {
  it('sends fixed POST, canonical headers, exact byte length and original binary without fetch', async () => {
    const fetcher = vi.fn(() => { throw new Error('Native IPP transport must not call fetch'); });
    vi.stubGlobal('fetch', fetcher);
    await withHttpServer(async (req, res) => {
      const received = await readRequest(req);
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/ipp/print');
      expect(received).toEqual(body);
      expect(req.rawHeaders).toEqual([
        'Content-Type', 'application/ipp',
        'Accept', 'application/ipp',
        'Content-Length', String(body.length),
        'Connection', 'close',
        'Host', req.headers.host!,
      ]);
      expect(req.headers['transfer-encoding']).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/ipp' }); res.end(responseBytes);
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No native response headers');
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(responseBytes);
      await fixture.assertConnectionsClosed();
      expect(fixture.requests).toHaveLength(1);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves missing MIME and streams a complete chunked HTTP body as bytes', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req);
      res.writeHead(200);
      res.write(responseBytes.subarray(0, 4));
      setImmediate(() => res.end(responseBytes.subarray(4)));
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No chunked response headers');
      expect(response.headers.get('content-type')).toBeNull();
      expect(response.headers.get('transfer-encoding')).toBe('chunked');
      expect(Buffer.from(await bounded(response.arrayBuffer(), 'Chunked body did not complete'))).toEqual(responseBytes);
      await fixture.assertConnectionsClosed();
    });
  });

  it('aborts a request waiting for headers and closes the actual socket', async () => {
    const received = deferred<void>();
    await withHttpServer(async req => { await readRequest(req); received.resolve(); }, async fixture => {
      const pending = requestIppHttp(fixture.url, body, fixture.controller.signal);
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      await bounded(received.promise, 'Server did not receive the request');
      fixture.controller.abort();
      const result = await bounded(outcome, 'Header abort left the request pending');
      expect(result).toHaveProperty('error');
      await fixture.assertConnectionsClosed();
    });
  });

  it('aborts a hanging body after headers instead of treating complete IPP bytes as HTTP completion', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req); res.writeHead(200); res.write(responseBytes);
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'Headers were buffered until body completion');
      const reader = response.body!.getReader();
      expect((await bounded(reader.read(), 'Initial response bytes missing')).value).toEqual(new Uint8Array(responseBytes));
      const outcome = reader.read().then(value => ({ value }), error => ({ error }));
      fixture.controller.abort();
      expect(await bounded(outcome, 'Body abort left a read pending')).toHaveProperty('error');
      await reader.cancel().catch(() => {});
      await fixture.assertConnectionsClosed();
    });
  });

  it('cancels a partially consumed response and destroys its actual socket promptly', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req); res.writeHead(200); res.write(responseBytes);
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No response headers for cancellation');
      const reader = response.body!.getReader();
      expect((await bounded(reader.read(), 'No partial response bytes')).done).toBe(false);
      await bounded(reader.cancel(), 'Web response cancellation did not finish');
      await fixture.assertConnectionsClosed();
    });
  });

  it('cancels an unread rejected response while its body has not produced any bytes', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req); res.writeHead(401, { 'content-type': 'text/html' }); res.flushHeaders();
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No rejected response headers');
      expect(response.status).toBe(401);
      await bounded(response.body!.cancel(), 'Unread response cancellation did not finish');
      await fixture.assertConnectionsClosed();
    });
  });

  it('does not create a connection for an already aborted request', async () => {
    await withHttpServer((_req, res) => { res.end(); }, async fixture => {
      fixture.controller.abort();
      await expect(requestIppHttp(fixture.url, body, fixture.controller.signal)).rejects.toBeDefined();
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.connections).toHaveLength(0);
      expect(getEventListeners(fixture.controller.signal, 'abort')).toHaveLength(0);
    });
  });

  it('returns a redirect response without following its LOCATION or retrying', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req); res.writeHead(302, { location: '/must-not-follow' }); res.end('redirect');
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No redirect response');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/must-not-follow');
      expect(await response.text()).toBe('redirect');
      await fixture.assertConnectionsClosed();
      expect(fixture.requests.map(req => req.url)).toEqual(['/ipp/print']);
    });
  });

  it('closes an HTTP 205 response even when its advertised body never completes', async () => {
    await withHttpServer(async (req, res) => {
      await readRequest(req); res.writeHead(205); res.write(responseBytes);
    }, async fixture => {
      const response = await bounded(requestIppHttp(fixture.url, body, fixture.controller.signal), 'No bodyless response headers');
      expect(response.status).toBe(205);
      expect(response.body).toBeNull();
      await fixture.assertConnectionsClosed();
    });
  });

  it.each([
    ['truncated chunk', Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nA\r\nabc')],
    ['invalid chunk size', Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\nabc\r\n0\r\n\r\n')],
    ['ambiguous framing', Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\nConnection: close\r\n\r\n0\r\n\r\n')],
  ])('does not complete a response with %s', async (_label, wire) => {
    const connections: Socket[] = [], closures: Promise<void>[] = [];
    const controller = new AbortController();
    const server = net.createServer(socket => {
      connections.push(socket);
      closures.push(new Promise<void>(resolve => socket.once('close', () => resolve())));
      socket.once('data', () => socket.end(wire));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const consume = async () => {
        const response = await requestIppHttp(new URL(`http://127.0.0.1:${port}/ipp/print`), body, controller.signal);
        await response.arrayBuffer();
      };
      const outcome = consume().then(value => ({ value }), error => ({ error }));
      expect(await bounded(outcome, 'Malformed framing left a response pending')).toHaveProperty('error');
      expect(connections).toHaveLength(1);
      await bounded(Promise.all(closures), 'Malformed response left a TCP socket open');
      expect(connections[0].destroyed).toBe(true);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      controller.abort();
      for (const socket of connections) socket.destroy();
      await bounded(new Promise<void>(resolve => server.close(() => resolve())), 'Raw HTTP test server did not close');
      expect(server.listening).toBe(false);
    }
  });
});
