import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuAdapter } from '../server/messaging/feishu';
import { WeComAdapter } from '../server/messaging/wecom';

describe('messaging adapter boundaries', () => {
  afterEach(() => vi.restoreAllMocks());
  it('requires the configured Feishu verification token for events', () => {
    const adapter = new FeishuAdapter({
      appId: 'app-test',
      appSecret: 'secret-test',
      verificationToken: 'verify-me',
    });

    expect(adapter.verifyWebhook({ header: { token: 'verify-me' } })).toBe(true);
    expect(adapter.verifyWebhook({ header: { token: 'wrong' } })).toBe(false);
    expect(adapter.verifyWebhook({})).toBe(false);
  });

  it('allows only Feishu setup challenges when no verification token exists', () => {
    const adapter = new FeishuAdapter({ appId: 'app-test', appSecret: 'secret-test' });

    expect(adapter.verifyWebhook({ type: 'url_verification' })).toBe(true);
    expect(adapter.verifyWebhook({ header: { event_type: 'im.message.receive_v1' } })).toBe(false);
  });

  it('parses direct Feishu long-connection payloads without treating every chat ID as a group', () => {
    const adapter = new FeishuAdapter({ appId: 'app-test', appSecret: 'secret-test' });
    const privateMessage = adapter.parseEvent({
      sender: { sender_id: { open_id: 'ou-user' } },
      message: {
        message_id: 'om-private',
        chat_id: 'oc-private',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '你好' }),
        create_time: String(Date.now()),
      },
    });
    const groupMessage = adapter.parseEvent({
      sender: { sender_id: { open_id: 'ou-user' } },
      message: {
        message_id: 'om-group',
        chat_id: 'oc-group',
        chat_type: 'group',
        root_id: 'om-thread-root',
        message_type: 'text',
        content: JSON.stringify({ text: '大家好' }),
        create_time: String(Date.now()),
      },
    });

    expect(privateMessage).toMatchObject({ chatType: 'private', text: '你好', userId: 'ou-user' });
    expect(groupMessage).toMatchObject({ chatType: 'group', threadId: 'om-thread-root', text: '大家好', userId: 'ou-user' });
  });

  it('uploads and sends a real Feishu file message through the official file key flow', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { file_key: 'file-key-123' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { message_id: 'message-file-123' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const adapter = new FeishuAdapter({ appId: 'app-test', appSecret: 'secret-test' });

    await expect(adapter.sendFile('oc-file-target', Buffer.from('evidence'), 'evidence.txt'))
      .resolves.toBe('message-file-123');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/open-apis/im/v1/files');
    const uploadBody = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(uploadBody.get('file_type')).toBe('stream');
    expect(uploadBody.get('file_name')).toBe('evidence.txt');
    expect(String(fetchMock.mock.calls[2][0])).toContain('receive_id_type=chat_id');
    const sendBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body || '{}'));
    expect(sendBody).toMatchObject({ receive_id: 'oc-file-target', msg_type: 'file' });
    expect(JSON.parse(sendBody.content)).toEqual({ file_key: 'file-key-123' });
  });

  it('parses WeCom file callbacks into downloadable attachments', () => {
    const adapter = new WeComAdapter({
      corpId: 'corp-test',
      agentId: '100001',
      appSecret: 'secret-test',
      token: 'token-test',
      encodingAESKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    });
    const xml = [
      '<xml>',
      '<ToUserName><![CDATA[corp-test]]></ToUserName>',
      '<FromUserName><![CDATA[user-a]]></FromUserName>',
      '<CreateTime>1783828800</CreateTime>',
      '<MsgType><![CDATA[file]]></MsgType>',
      '<MediaId><![CDATA[media-123]]></MediaId>',
      '<FileName><![CDATA[evidence.pdf]]></FileName>',
      '<FileSize>2048</FileSize>',
      '<MsgId>msg-123</MsgId>',
      '</xml>',
    ].join('');

    const message = adapter.parseEvent({ rawBody: xml });
    expect(message?.platform).toBe('wecom');
    expect(message?.userId).toBe('user-a');
    expect(message?.attachments?.[0]).toMatchObject({
      type: 'file',
      fileName: 'evidence.pdf',
      resourceKey: 'media-123',
      fileSize: 2048,
    });
  });
});
