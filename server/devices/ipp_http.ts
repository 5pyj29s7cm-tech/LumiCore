import http from 'node:http';
import { Readable } from 'node:stream';

export type IppHttpTransport = (url: URL, body: Buffer, signal: AbortSignal) => Promise<Response>;
const aborted = () => new DOMException('The IPP request was aborted', 'AbortError');

/** A single unpooled IPP request; no redirects, compression negotiation, or retries. */
export const requestIppHttp: IppHttpTransport = async (url, body, signal) => {
  if (url.protocol !== 'http:' || url.username || url.password) throw new Error('IPP HTTP transport requires an HTTP endpoint without URL credentials');
  if (signal.aborted) throw aborted();
  return new Promise<Response>((resolve, reject) => {
    let incoming: http.IncomingMessage | undefined;
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const fail = (error: Error) => {
      if (!settled) { settled = true; reject(error); }
      if (!incoming) cleanup();
    };
    const onAbort = () => {
      const error = aborted();
      incoming?.destroy(error);
      request.destroy(error);
      fail(error);
    };
    const request = http.request(url, {
      method: 'POST', agent: false,
      headers: {
        'Content-Type': 'application/ipp',
        Accept: 'application/ipp',
        'Content-Length': body.length,
        Connection: 'close',
      },
    }, message => {
      incoming = message;
      message.once('end', cleanup);
      message.once('close', cleanup);
      // Keep errors handled even when HTTP status requires a bodyless Response.
      message.once('error', cleanup);
      if (signal.aborted) { onAbort(); return; }
      try {
        const status = message.statusCode ?? 0;
        const headers = new Headers();
        for (let index = 0; index < message.rawHeaders.length; index += 2) {
          headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
        }
        const noBody = status === 204 || status === 205 || status === 304;
        const stream = noBody ? null : Readable.toWeb(message, {
          strategy: { highWaterMark: message.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>;
        const response = new Response(stream, { status, headers });
        if (noBody) { message.destroy(); request.destroy(); cleanup(); }
        settled = true;
        resolve(response);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        message.destroy(failure);
        request.destroy(failure);
        cleanup();
        fail(failure);
      }
    });
    request.once('error', error => {
      if (incoming) incoming.destroy(error);
      fail(error);
    });
    request.once('upgrade', (_response, socket) => {
      const error = new Error('IPP HTTP transport does not accept protocol upgrades');
      socket.destroy(); request.destroy(error); cleanup(); fail(error);
    });
    request.once('close', () => {
      if (!incoming && !settled) { cleanup(); fail(new Error('IPP connection closed before response headers')); }
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    request.end(body);
  });
};
