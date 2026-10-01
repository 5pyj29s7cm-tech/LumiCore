import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => ({ handler: null as null | ((args: { city: string }) => Promise<any>) }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(_name: string, _schema: unknown, handler: typeof registered.handler) { registered.handler = handler; }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

beforeAll(async () => { await import('../server/skills/bundled/weather'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the single bundled weather lookup', () => {
  it('does not invent a city or fetch when none was supplied', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await registered.handler!({ city: ' ' })).toMatchObject({ isError: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps simultaneous cities separate and sends a bounded request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ current_condition: [{ temp_C: url.includes('Tokyo') ? '20' : '10' }] }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await Promise.all(['Tokyo', 'London'].map(city => registered.handler!({ city })));
    expect(result.map(item => JSON.parse(item.content[0].text))).toMatchObject([
      { city: 'Tokyo', temperature: '20°C' }, { city: 'London', temperature: '10°C' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[5000], [5000]]);
  });

  it('reports HTTP failures instead of returning weather', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    expect(await registered.handler!({ city: 'Tokyo' })).toMatchObject({ isError: true });
  });

  it('ends a hanging lookup at the requested deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('timed out')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const pending = registered.handler!({ city: 'Tokyo' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'Weather lookup failed: timed out' }] });
  });
});
