import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { encodePrinterAttributesRequest, decodePrinterAttributesResponse, readNetworkPrinterStatus } from '../server/devices/ipp_printer';

const id = 42;
const target = { address: '10.42.0.20', port: 631, resourcePath: '/ipp/print' };
const interfaces = async () => [{ name: 'Ethernet', address: '10.42.0.10', netmask: '255.255.255.0' }];
function field(tag: number, name: string, value: string | number | boolean | Buffer): Buffer {
  const n = Buffer.from(name);
  let v: Buffer;
  if (typeof value === 'number') { v = Buffer.alloc(4); v.writeInt32BE(value); }
  else if (typeof value === 'boolean') v = Buffer.from([Number(value)]);
  else v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const b = Buffer.alloc(5 + n.length + v.length);
  b[0] = tag; b.writeUInt16BE(n.length, 1); n.copy(b, 3);
  b.writeUInt16BE(v.length, 3 + n.length); v.copy(b, 5 + n.length); return b;
}
function response(fields: Buffer[] = [], code = 0, requestId = id): Buffer {
  const header = Buffer.alloc(8); header[0] = 1; header[1] = 1;
  header.writeUInt16BE(code, 2); header.writeInt32BE(requestId, 4);
  return Buffer.concat([header, Buffer.from([4]), ...fields, Buffer.from([3])]);
}
function mockFetch(body: Buffer, status = 200, contentType = 'application/ipp') {
  return vi.fn(async () => new Response(new Uint8Array(body), { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch;
}

describe('read-only IPP printer status', () => {
  it('encodes only Get-Printer-Attributes with no document or job fields', () => {
    const bytes = encodePrinterAttributesRequest('ipp://10.42.0.20:631/ipp/print', id);
    expect(bytes.readUInt16BE(2)).toBe(0x000b);
    expect(bytes.readInt32BE(4)).toBe(id);
    expect(bytes.at(-1)).toBe(3);
    const wire = bytes.toString();
    expect(wire).toContain('attributes-charset');
    expect(wire).toContain('requested-attributes');
    expect(wire).not.toMatch(/job-name|document-name|requesting-user-name/);
  });
  it('reads raw idle state, false accepting-jobs, zero queued jobs and repeated formats', () => {
    const parsed = decodePrinterAttributesResponse(response([
      field(0x23, 'printer-state', 3), field(0x22, 'printer-is-accepting-jobs', false),
      field(0x21, 'queued-job-count', 0), field(0x49, 'document-format-supported', 'image/jpeg'),
      field(0x49, '', 'image/pwg-raster'), field(0x44, 'printer-state-reasons', 'media-empty-warning'),
    ]), id);
    expect(parsed.attributes).toEqual({
      'printer-state': [3], 'printer-is-accepting-jobs': [false], 'queued-job-count': [0],
      'document-format-supported': ['image/jpeg', 'image/pwg-raster'], 'printer-state-reasons': ['media-empty-warning'],
    });
  });
  it('does not promote operation, unsupported, collection or unknown values into printer attributes', () => {
    const bytes = response([field(0x23, 'printer-state', 4),
      Buffer.from([1]), field(0x23, 'printer-state', 3),
      Buffer.from([4]), field(0x34, 'media-col-ready', Buffer.alloc(0)), field(0x4a, '', 'printer-state'),
      field(0x23, '', 3), field(0x37, '', Buffer.alloc(0)), field(0x22, 'color-supported', true),
      field(0x41, 'job-name', 'private document'),
    ]);
    expect(decodePrinterAttributesResponse(bytes, id).attributes).toEqual({ 'printer-state': [4], 'color-supported': [true] });
  });
  it('decodes language-tagged printer text', () => {
    const bytes = Buffer.from([0, 2, 101, 110, 0, 4, 84, 101, 115, 116]);
    expect(decodePrinterAttributesResponse(response([field(0x35, 'printer-info', bytes)]), id).attributes['printer-info']).toEqual(['Test']);
  });
  it.each([
    ['truncated header', Buffer.alloc(8)],
    ['wrong id', response([], 0, 43)],
    ['no end tag', response([]).subarray(0, 9)],
    ['truncated value', Buffer.concat([response([]).subarray(0, 9), Buffer.from([0x23, 0, 1, 97, 0, 9, 1, 3])])],
    ['orphan value', response([field(0x23, '', 3)])],
    ['unclosed collection', response([field(0x34, 'media-col', Buffer.alloc(0))])],
    ['invalid boolean', response([field(0x22, 'color-supported', Buffer.from([2]))])],
    ['trailing data', Buffer.concat([response([]), Buffer.from('document data')])],
  ])('rejects %s', (_label, bytes) => {
    expect(() => decodePrinterAttributesResponse(bytes as Buffer, id)).toThrow();
  });
  it('uses exact LAN endpoint, prohibits redirects and reports observation separately from printing', async () => {
    const fetcher = mockFetch(response([field(0x23, 'printer-state', 5)]));
    const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
    expect(result).toMatchObject({ ok: true, status: 'observed', state: 'stopped', target });
    const call = vi.mocked(fetcher).mock.calls[0];
    expect(String(call[0])).toBe('http://10.42.0.20:631/ipp/print');
    expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Buffer.from(call[1]!.body as Uint8Array).readUInt16BE(2)).toBe(11);
  });
  it.each(['8.8.8.8', '127.0.0.1', '10.43.0.20', '10.42.0.10', '10.42.0.255', 'printer.local', '::1', '010.42.0.20'])('never fetches non-peer address %s', async address => {
    const fetcher = mockFetch(response([]));
    expect(await readNetworkPrinterStatus({ ...target, address }, { interfaces, fetch: fetcher })).toMatchObject({ ok: false, status: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['/ipp/print?x=1', '//evil.example', '/ipp\\print', '/ipp/print#x', '/ipp/print\n'])('rejects ambiguous resource %s', async resourcePath => {
    const fetcher = mockFetch(response([]));
    expect(await readNetworkPrinterStatus({ ...target, resourcePath }, { interfaces, fetch: fetcher })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains protocol errors, bad HTTP and timeout as failures instead of idle', async () => {
    for (const fetcher of [mockFetch(response([], 0x0401)), mockFetch(Buffer.from('login'), 401, 'text/html'),
      vi.fn(async () => { throw new DOMException('Timed out', 'AbortError'); }) as unknown as typeof fetch]) {
      const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty('state');
    }
  });
  it('bounds response and treats missing state as unknown', async () => {
    const big = await readNetworkPrinterStatus(target, { interfaces, fetch: mockFetch(Buffer.alloc(128 * 1024 + 1)), requestId: () => id });
    expect(big).toMatchObject({ ok: false, status: 'unavailable' });
    const empty = await readNetworkPrinterStatus(target, { interfaces, fetch: mockFetch(response([])), requestId: () => id });
    expect(empty).toMatchObject({ ok: true, state: 'unknown' });
  });
});


describe('IPP response compatibility and timeout phases', () => {
  it('reads a complete chunked HTTP response with no MIME header through the real fetch client', async () => {
    const sockets = new Set<Socket>();
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks);
      expect(request.readUInt16BE(2)).toBe(0x000b);
      expect(Number(req.headers['content-length'])).toBe(request.length);
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write(response([field(0x23, 'printer-state', 3), field(0x21, 'queued-job-count', 0)], 0, request.readInt32BE(4)));
      res.end();
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const fetcher = vi.fn((_url, init) => fetch('http://127.0.0.1:' + port + '/ipp/print', init)) as unknown as typeof fetch;
      const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
      expect(result).toMatchObject({ ok: true, state: 'idle', attributes: { 'queued-job-count': [0] },
        warnings: [{ code: 'missing_content_type' }] });
      expect(requests).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    ['non-IPP body', Buffer.from('<html>not a printer response</html>')],
    ['different request id', response([], 0, id + 1)],
    ['incomplete IPP', response([]).subarray(0, 9)],
    ['trailing body bytes', Buffer.concat([response([]), Buffer.from('extra')])],
  ])('does not accept a missing MIME header with %s', async (_label, body) => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;
    const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
    expect(result).toMatchObject({ ok: false, phase: 'decode', errorCode: 'response_invalid' });
    expect(result).not.toHaveProperty('state');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still rejects an explicit non-IPP MIME type and non-200 HTTP without retrying', async () => {
    for (const fetcher of [mockFetch(response([]), 200, 'text/html'), mockFetch(response([]), 401)]) {
      const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
      expect(result).toMatchObject({ ok: false, phase: 'body', errorCode: 'response_invalid' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('reports an actual request error separately from the response deadline', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('Connection refused'); }) as unknown as typeof fetch;
    const result = await readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
    expect(result).toMatchObject({ ok: false, phase: 'headers', errorCode: 'request_failed', error: 'Connection refused' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a headers deadline at the existing 5000ms total limit', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      })) as unknown as typeof fetch;
      const pending = readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ ok: false, phase: 'headers', errorCode: 'headers_timeout' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('requires HTTP body completion and gives it only the remainder of the same 5000ms deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async (_url, init) => {
        await new Promise(resolve => setTimeout(resolve, 4000));
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array(response([field(0x23, 'printer-state', 3)])));
          init!.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
          // A complete IPP message is not a completed HTTP response body.
        } }));
      }) as unknown as typeof fetch;
      let settled = false;
      const pending = readNetworkPrinterStatus(target, { interfaces, fetch: fetcher, requestId: () => id }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: false, phase: 'body', errorCode: 'body_timeout' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
