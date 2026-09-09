import './helpers';
import fs from 'node:fs';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { createMessagingRoutes } from '../server/regions/packs/cn/messaging_routes';
import { FeishuAdapter } from '../server/messaging/feishu';
import { listQueuedMessagingInputs, recordMessagingIngress, resetMessagingJournalForTest, getMessagingJournalEntry } from '../server/messaging/message_journal';
import { acceptMessageOnce, resetDeliveryLedgerForTest } from '../server/messaging/delivery_ledger';
import type { IncomingMessage } from '../server/messaging/types';

beforeAll(async () => { await initDatabase(); });
beforeEach(() => { resetMessagingJournalForTest(); resetDeliveryLedgerForTest(); });
afterEach(() => { vi.restoreAllMocks(); });
const message = (id: string): IncomingMessage => ({ platform: 'feishu', messageId: id, userId: 'synthetic-user', userName: 'Synthetic', chatId: 'synthetic-chat', chatType: 'private', text: 'x'.repeat(9000), attachments: [{ id: 'file-1', type: 'file', fileName: 'report.txt', resourceKey: 'synthetic-resource' }], raw: { token: 'transport-secret-not-needed' }, timestamp: new Date().toISOString() });

describe('durable webhook admission', () => {
  it('does not cache a journal or delivery success when its atomic publication fails', () => {
    const input = message('disk-failure');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic disk failure'); });
    expect(() => recordMessagingIngress(input)).toThrow(/disk failure/);
    expect(getMessagingJournalEntry(input)).toBeNull();
    expect(() => acceptMessageOnce(input.platform, input.messageId)).toThrow(/disk failure/);
    rename.mockRestore();
    recordMessagingIngress(input);
    expect(acceptMessageOnce(input.platform, input.messageId)).toBe(true);
    const queued = listQueuedMessagingInputs('feishu');
    expect(queued[0].text).toHaveLength(9000);
    expect(queued[0].attachments?.[0].resourceKey).toBe('synthetic-resource');
    expect(queued[0].raw).toEqual({});
  });

  it('returns a retryable HTTP failure before sending any platform success acknowledgement', async () => {
    const input = message('webhook-disk-failure');
    vi.spyOn(FeishuAdapter.prototype, 'verifyWebhook').mockReturnValue(true);
    vi.spyOn(FeishuAdapter.prototype, 'parseEvent').mockReturnValue(input);
    vi.spyOn(FeishuAdapter.prototype, 'replyMessage').mockResolvedValue('synthetic-reply');
    const router = createMessagingRoutes({ enabled: true } as any);
    const handler = (router as any).stack.find((entry: any) => entry.route?.path === '/feishu/events').route.stack[0].handle;
    const res: any = { headersSent: false, statusCode: 200, status: vi.fn(function(this: any, code) { this.statusCode = code; return this; }), json: vi.fn(function(this: any, body) { this.body = body; this.headersSent = true; return this; }) };
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic inbox unavailable'); });
    await handler({ body: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe(-1);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(getMessagingJournalEntry(input)).toBeNull();
    rename.mockRestore();
    await new Promise(resolve => setImmediate(resolve));
  });
});
