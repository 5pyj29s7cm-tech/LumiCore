import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WeChatClawBotAdapter } from '../server/messaging/wechat-clawbot';

const originalFetch = globalThis.fetch;
const activeAdapters: WeChatClawBotAdapter[] = [];
const cursorPaths: string[] = [];

function testCursorPath(): string {
  const value = path.join(os.tmpdir(), `lumi-wechat-test-${Date.now()}-${Math.random()}.json`);
  cursorPaths.push(value);
  return value;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function adapter(): WeChatClawBotAdapter {
  const instance = new WeChatClawBotAdapter({
    botToken: `token-${Date.now()}-${Math.random()}`,
    botId: `bot-${Date.now()}-${Math.random()}@im.bot`,
    baseUrl: 'https://example.test',
    enabled: true,
  }, { cursorPath: testCursorPath() });
  activeAdapters.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of activeAdapters.splice(0)) instance.stopPolling();
  for (const cursorPath of cursorPaths.splice(0)) {
    try { fs.rmSync(cursorPath, { force: true }); } catch {}
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('WeChat ClawBot connection stability', () => {
  it('deduplicates concurrent polling starts and aborts an active long-poll on stop', async () => {
    let notifyStartCalls = 0;
    let getUpdatesCalls = 0;
    let aborted = false;
    let initialPollBody: any = null;
    let decodedUin = '';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/msg/notifystart')) {
        notifyStartCalls += 1;
        return response({ ret: 0 });
      }
      if (url.includes('/getupdates')) {
        getUpdatesCalls += 1;
        initialPollBody = JSON.parse(String(init?.body || '{}'));
        decodedUin = Buffer.from(String((init?.headers as any)?.['X-WECHAT-UIN'] || ''), 'base64').toString('utf8');
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return response({ ret: 0 });
    }) as any;

    const instance = adapter();
    await Promise.all([
      instance.startPolling(async () => null),
      instance.startPolling(async () => null),
    ]);

    expect(instance.isPolling()).toBe(true);
    await vi.waitFor(() => expect(notifyStartCalls).toBe(1));
    await vi.waitFor(() => expect(getUpdatesCalls).toBe(1));
    expect(initialPollBody).toMatchObject({
      get_updates_buf: '',
      base_info: { channel_version: '3.0.0', bot_agent: 'Lumi/3.0.0' },
    });
    expect(decodedUin).toMatch(/^\d+$/);

    instance.stopPolling();
    expect(instance.isPolling()).toBe(false);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('consumes official msgs/ret responses and wraps replies in the iLink msg envelope', async () => {
    let pollCalls = 0;
    let received: any = null;
    let sendBody: any = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/msg/notifystart')) return response({ ret: 0 });
      if (url.includes('/getupdates')) {
        pollCalls += 1;
        if (pollCalls === 1) {
          return response({
            ret: 0,
            msgs: [{
              message_id: 24680,
              client_id: 'client-inbound',
              create_time_ms: 1_783_900_000_000,
              from_user_id: 'wx-user-1',
              to_user_id: 'bot@im.bot',
              message_type: 1,
              message_state: 2,
              context_token: 'context-token-1',
              item_list: [{ type: 1, text_item: { text: '你好 Lumi' } }],
            }],
            get_updates_buf: 'cursor-next',
            longpolling_timeout_ms: 35_000,
          });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      if (url.includes('/sendmessage')) {
        sendBody = JSON.parse(String(init?.body || '{}'));
        return response({ ret: 0 });
      }
      return response({ ret: 0 });
    }) as any;

    const instance = adapter();
    await instance.startPolling(async message => {
      received = message;
      return { platform: 'wechat', text: '你好，我在。' };
    });

    await vi.waitFor(() => expect(sendBody).not.toBeNull());
    expect(received).toMatchObject({
      platform: 'wechat',
      userId: 'wx-user-1',
      chatId: 'wx-user-1',
      messageId: '24680',
      text: '你好 Lumi',
    });
    expect(sendBody).toMatchObject({
      msg: {
        to_user_id: 'wx-user-1',
        context_token: 'context-token-1',
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: '你好，我在。' } }],
      },
      base_info: { channel_version: '3.0.0', bot_agent: 'Lumi/3.0.0' },
    });
    expect(instance.getStatus().lastMessageAt).toBeTruthy();
    expect(instance.getStatus().lastReplyAt).toBeTruthy();
  });

  it('stops polling and exposes a reauthorization state when iLink reports session expiry', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/msg/notifystart')) return response({ ret: 0 });
      if (url.includes('/getupdates')) {
        return response({ ret: -14, errcode: -14, errmsg: 'session timeout', msgs: [] });
      }
      return response({ ret: 0 });
    }) as any;

    const instance = adapter();
    await instance.startPolling(async () => null);

    await vi.waitFor(() => expect(instance.isPolling()).toBe(false));
    expect(instance.getStatus()).toMatchObject({
      listening: false,
      sessionExpired: true,
      lastError: 'session timeout',
    });
  });

  it('does not reply twice to completed messages when a later message in the batch retries', async () => {
    const config = {
      botToken: `batch-token-${Date.now()}-${Math.random()}`,
      botId: `batch-bot-${Date.now()}-${Math.random()}@im.bot`,
      baseUrl: 'https://example.test',
      enabled: true,
    };
    const batchCursorPath = testCursorPath();
    const batch = {
      ret: 0,
      msgs: [
        {
          message_id: 101,
          from_user_id: 'wx-batch-user',
          to_user_id: config.botId,
          message_type: 1,
          message_state: 2,
          context_token: 'ctx-101',
          item_list: [{ type: 1, text_item: { text: 'first' } }],
        },
        {
          message_id: 102,
          from_user_id: 'wx-batch-user',
          to_user_id: config.botId,
          message_type: 1,
          message_state: 2,
          context_token: 'ctx-102',
          item_list: [{ type: 1, text_item: { text: 'second' } }],
        },
      ],
      get_updates_buf: 'batch-cursor-next',
    };
    let pollCalls = 0;
    const sentTexts: string[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/msg/notifystart')) return response({ ret: 0 });
      if (url.includes('/getupdates')) {
        pollCalls += 1;
        if (pollCalls <= 2) return response(batch);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      if (url.includes('/sendmessage')) {
        sentTexts.push(JSON.parse(String(init?.body || '{}'))?.msg?.item_list?.[0]?.text_item?.text || '');
        return response({ ret: 0 });
      }
      return response({ ret: 0 });
    }) as any;

    const firstRun = new WeChatClawBotAdapter(config, { cursorPath: batchCursorPath });
    activeAdapters.push(firstRun);
    await firstRun.startPolling(async message => {
      if (message.messageId === '102') {
        firstRun.stopPolling();
        throw new Error('simulated second-message failure');
      }
      return { platform: 'wechat', text: `reply-${message.messageId}` };
    });
    await vi.waitFor(() => expect(firstRun.isPolling()).toBe(false));
    expect(sentTexts).toEqual(['reply-101']);

    const retriedIds: string[] = [];
    const secondRun = new WeChatClawBotAdapter(config, { cursorPath: batchCursorPath });
    activeAdapters.push(secondRun);
    await secondRun.startPolling(async message => {
      retriedIds.push(message.messageId);
      return { platform: 'wechat', text: `reply-${message.messageId}` };
    });

    await vi.waitFor(() => expect(sentTexts).toEqual(['reply-101', 'reply-102']));
    expect(retriedIds).toEqual(['102']);
  });
});
