export interface AliyunAvatarRtc {
  appId: string; channel: string; timestamp: number; token: string;
  clientUserId: string; serverUserId: string; avatarUserId: string; nonce?: string;
}
export interface AliyunAvatarConfig {
  provider: 'aliyun'; configured: boolean; enabled: boolean; available: boolean; cloudAllowed: boolean;
  projectId: string; instanceId: string; cleanupPending: boolean;
}
export interface AliyunAvatarOffer {
  provider: 'aliyun'; portraitSessionId: string; callSessionId: string; sessionId: string;
  rtc: AliyunAvatarRtc; expiresAt: number;
}
export function validAliyunRtc(value: any): value is AliyunAvatarRtc {
  return value && ['appId', 'channel', 'token', 'clientUserId', 'serverUserId', 'avatarUserId']
    .every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096)
    && Number.isSafeInteger(value.timestamp) && value.timestamp > 0;
}
