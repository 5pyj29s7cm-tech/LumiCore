import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerWebOpsTools } from '../server/tools/definitions/web_tools';

describe('web response lifetime includes the body', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const registry = new ToolRegistry();
  registerWebOpsTools(registry);
  const handler = registry.get('url_fetch')!.handler;
  it('times out a body that stalls after successful headers and releases its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/plain' } })));
    const pending = handler({ url: 'https://example.invalid/' }, {});
    await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toContain('timed out');
    expect(cancel).toHaveBeenCalled();
  });
  it('propagates user cancellation to a stalled body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/plain' } })));
    const controller = new AbortController();
    const pending = handler({ url: 'https://example.invalid/' }, { executionSignal: controller.signal });
    const settled = expect(pending).rejects.toThrow();
    await Promise.resolve();
    controller.abort(new DOMException('User stopped', 'AbortError'));
    await settled;
    expect(cancel).toHaveBeenCalled();
  });
  it('stops reading at the byte budget instead of downloading an unbounded body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel }), { headers: { 'content-type': 'text/plain' } })));
    expect(await handler({ url: 'https://example.invalid/' }, {})).toContain('2 MiB');
    expect(cancel).toHaveBeenCalled();
  });
});
