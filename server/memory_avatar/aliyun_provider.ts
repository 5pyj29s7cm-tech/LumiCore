import Client, { CreateChatSessionRequest, CloseChatInstanceSessionsRequest, QueryChatInstanceSessionsRequest } from '@alicloud/lingmou20250527';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { PortraitError } from './portrait_provider';
import { validAliyunRtc, type AliyunAvatarRtc } from '../../shared/aliyun_avatar';

export interface AliyunCredential { accessKeyId: string; accessKeySecret: string }
export class AliyunCreateError extends PortraitError { remoteId?: string }
// Alibaba's package is CommonJS; native ESM and the bundled desktop server expose
// its default export differently. Support both without changing the signed client.
const AliyunClient = (Client as unknown as { default?: typeof Client }).default || Client;
export class AliyunPortraitProvider {
  private client(key: AliyunCredential) {
    return new AliyunClient(new $OpenApiUtil.Config({ ...key, endpoint: 'lingmou.cn-beijing.aliyuncs.com',
      regionId: 'cn-beijing', protocol: 'https', readTimeout: 20_000, connectTimeout: 10_000, retryOptions: { retryable: false, maxAttempts: 1 } }));
  }
  async create(key: AliyunCredential, projectId: string, instanceId: string): Promise<{ sessionId: string; rtc: AliyunAvatarRtc }> {
    try {
      // The generated SDK uses no automatic retry by default. Never retry a paid create.
      const { body } = await this.client(key).createChatSession(projectId, new CreateChatSessionRequest({ instanceId, platform: 'Web' }));
      if (!body?.success || !body.data?.sessionId || !validAliyunRtc(body.data.rtcParams)) {
        const error = new AliyunCreateError('aliyun_create_unknown', 'Aliyun did not confirm a usable session. Check the instance before retrying.', 503, true);
        if (typeof body?.data?.sessionId === 'string' && body.data.sessionId.length <= 200) error.remoteId = body.data.sessionId;
        throw error;
      }
      const p = body.data.rtcParams;
      return { sessionId: body.data.sessionId, rtc: { appId: p.appId, channel: p.channel, timestamp: p.timestamp, token: p.token,
        clientUserId: p.clientUserId, serverUserId: p.serverUserId, avatarUserId: p.avatarUserId, ...(p.nonce ? { nonce: p.nonce } : {}) } };
    } catch (error) {
      if (error instanceof PortraitError) throw error;
      const status = Number((error as any)?.statusCode);
      throw new PortraitError(status === 401 || status === 403 ? 'aliyun_access_denied' : 'aliyun_create_unknown',
        status === 401 || status === 403 ? 'Aliyun credentials or service permissions were rejected.' : 'Aliyun session creation was not confirmed. Check the instance before retrying.', 503, !(status >= 400 && status < 500));
    }
  }
  async close(key: AliyunCredential, instanceId: string, sessionId: string): Promise<void> {
    if (!sessionId || !instanceId) throw new PortraitError('aliyun_cleanup_pending', 'No exact Aliyun session identifier is available.', 503, true);
    try {
      // Always pass exactly our session ID. Omitting it would close unrelated sessions.
      const { body } = await this.client(key).closeChatInstanceSessions(instanceId, new CloseChatInstanceSessionsRequest({ sessionIds: [sessionId] }));
      if (!body?.success || !body.data?.some(item => item.sessionId === sessionId)) {
        const check = await this.client(key).queryChatInstanceSessions(instanceId, new QueryChatInstanceSessionsRequest({ sessionIds: [sessionId] }));
        if (!check.body?.success || !Array.isArray(check.body.data) || check.body.data.some(item => item.sessionId === sessionId)) throw new Error('Close was not confirmed');
      }
    } catch { throw new PortraitError('aliyun_cleanup_pending', 'Aliyun has not confirmed that this session is closed.', 503, true); }
  }
}
