import { afterEach, expect, it, vi } from 'vitest';
import Client from '@alicloud/lingmou20250527';
import { AliyunPortraitProvider } from '../server/memory_avatar/aliyun_provider';
const Constructor = (Client as unknown as { default?: typeof Client }).default || Client;
const key = { accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' };
afterEach(() => vi.restoreAllMocks());
it('uses the official signed SDK against the fixed endpoint without paid-create retries', async () => {
  let client: any, request: any;
  vi.spyOn(Constructor.prototype, 'createChatSession').mockImplementation(async function (project, input) {
    client = this; request = input; expect(project).toBe('project');
    return { body: { success: true, data: { sessionId: 'remote', rtcParams: {
      appId: 'app', channel: 'channel', timestamp: 1234567, token: 'token', clientUserId: 'client', serverUserId: 'server', avatarUserId: 'avatar', nonce: 'nonce', unwanted: 'private' } } } } as any;
  });
  const result = await new AliyunPortraitProvider().create(key, 'project', 'instance');
  expect(client._endpoint).toBe('lingmou.cn-beijing.aliyuncs.com');
  expect(client._retryOptions).toMatchObject({ retryable: false, maxAttempts: 1 });
  expect(request.instanceId).toBe('instance'); expect(request.platform).toBe('Web');
  expect(JSON.stringify(result)).not.toMatch(/fixture|unwanted|private/);
});
it('retains a known remote ID when malformed RTC data requires cleanup', async () => {
  vi.spyOn(Constructor.prototype, 'createChatSession').mockResolvedValue({ body: { success: true, data: { sessionId: 'known-id', rtcParams: {} } } } as any);
  await expect(new AliyunPortraitProvider().create(key, 'project', 'instance')).rejects.toMatchObject({ remoteId: 'known-id', outcomeUnknown: true });
});
it('closes only the recorded session and verifies absence if it was already closed', async () => {
  const close = vi.spyOn(Constructor.prototype, 'closeChatInstanceSessions').mockResolvedValue({ body: { success: true, data: [] } } as any);
  const query = vi.spyOn(Constructor.prototype, 'queryChatInstanceSessions').mockResolvedValue({ body: { success: true, data: [] } } as any);
  await new AliyunPortraitProvider().close(key, 'instance', 'only-ours');
  expect(close).toHaveBeenCalledWith('instance', expect.objectContaining({ sessionIds: ['only-ours'] }));
  expect(query).toHaveBeenCalledWith('instance', expect.objectContaining({ sessionIds: ['only-ours'] }));
});
it('redacts upstream secrets and never expands an empty close to all sessions', async () => {
  const create = vi.spyOn(Constructor.prototype, 'createChatSession').mockRejectedValue({ statusCode: 403, message: 'fixture-secret should never escape' });
  const close = vi.spyOn(Constructor.prototype, 'closeChatInstanceSessions');
  await expect(new AliyunPortraitProvider().create(key, 'p', 'i')).rejects.toMatchObject({ code: 'aliyun_access_denied', outcomeUnknown: false });
  await expect(new AliyunPortraitProvider().close(key, 'i', '')).rejects.toThrow('No exact Aliyun session');
  expect(create).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
});
