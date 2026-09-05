import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeChatClawBotAdapter } from '../server/messaging/wechat-clawbot';
import { DesktopWechatWatchService } from '../server/messaging/desktop_wechat_watch';
import { getDataPath } from '../server/config/data_path';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function adapter(name: string) {
  return new WeChatClawBotAdapter({ botId: name, botToken: 'synthetic-test-token', baseUrl: 'https://wechat.invalid', enabled: true },
    { cursorPath: getDataPath(`test-wechat-shutdown-${name}.json`) });
}
function pollResponse() {
  return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'next-cursor', msgs: [{
    message_id: 1, from_user_id: 'synthetic-user', to_user_id: 'synthetic-bot', message_type: 1,
    message_state: 2, context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: 'synthetic message' } }],
  }] }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('WeChat shutdown durability boundaries', () => {
  it('ignores a late long-poll response after shutdown and cannot restart polling', async () => {
    const poll = deferred<Response>();
    const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/getupdates')
      ? poll.promise : new Response(JSON.stringify({ ret: 0 })));
    vi.stubGlobal('fetch', fetch);
    const instance = adapter('late-poll');
    const receive = vi.fn(async () => null);
    await instance.startPolling(receive);
    let stopped = false;
    const stop = instance.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    poll.resolve(pollResponse());
    await stop;
    expect(receive).not.toHaveBeenCalled();
    expect(instance.isPolling()).toBe(false);
    const calls = fetch.mock.calls.length;
    await instance.startPolling(receive);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('waits for an accepted callback and prevents a reply after stop', async () => {
    const callback = deferred<any>();
    const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/getupdates')
      ? pollResponse() : new Response(JSON.stringify({ ret: 0 })));
    vi.stubGlobal('fetch', fetch);
    const instance = adapter('accepted-callback');
    const receive = vi.fn(() => callback.promise);
    await instance.startPolling(receive);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = instance.stopPolling().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    callback.resolve({ platform: 'wechat', text: 'must not send after stop' });
    await stop;
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/sendmessage'))).toBe(false);
    expect(instance.isPolling()).toBe(false);
  });

  it('waits for desktop scan completion and rejects new scans while stopped', async () => {
    const capture = deferred<string>();
    const relay = vi.fn(() => capture.promise);
    const service = new DesktopWechatWatchService();
    service.configure({ io: { to: () => ({ emit() {} }) } as any,
      llmGetters: { getDeepSeek: () => null, getGemini: () => null },
      createPersonalDesktopRelay: () => relay });
    service.updateConfig('synthetic-watch-user', { enabled: true, autoInspectWhenIdle: false });
    const scan = service.scanNow('synthetic-watch-user');
    await vi.waitFor(() => expect(relay).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(service.scanNow('synthetic-watch-user')).rejects.toThrow('stopping');
    capture.resolve(JSON.stringify({ status: 'ok', capturedNodes: 2, tree: {
      name: 'WeChat', controlType: 'Window', children: [{ name: 'ready', controlType: 'Text', children: [] }],
    } }));
    await Promise.all([scan, stop]);
    expect(service.getConfig('synthetic-watch-user').baselineInitialized).toBe(true);
    expect(relay).toHaveBeenCalledTimes(1);
  });
});
