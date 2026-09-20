import { apiFetch } from './apiClient';
import { liveAudioEncoding, parseVisibleLiveComments, type AvatarLiveReply, type AvatarLiveTurn, type VisibleLiveComment } from '../../shared/avatar_live';

async function post(avatarId: string, action: string, body: unknown, signal: AbortSignal) {
  const response = await apiFetch(`/api/memory-avatars/${encodeURIComponent(avatarId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error',
  });
  const data = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) throw new Error(data?.code || 'live_service_unavailable');
  return data;
}
export const avatarLiveService = {
  async scan(avatarId: string, image: string, signal: AbortSignal): Promise<VisibleLiveComment[]> {
    const data = await post(avatarId, 'live/scan', { requestId: crypto.randomUUID(), publicConsent: true, image }, signal);
    return parseVisibleLiveComments(JSON.stringify(data));
  },
  async reply(avatarId: string, input: { brief: string; comment: VisibleLiveComment; history: AvatarLiveTurn[]; locale: 'zh' | 'en' }, signal: AbortSignal): Promise<AvatarLiveReply> {
    const data = await post(avatarId, 'live/reply', { ...input, requestId: crypto.randomUUID(), publicConsent: true }, signal);
    if (!data || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 600 || typeof data.audioBase64 !== 'string'
      || !data.audioBase64.length || data.audioBase64.length > 8_000_000 || !/^[A-Za-z0-9+/=]+$/.test(data.audioBase64)
      || !liveAudioEncoding(data.format)) throw new Error('live_audio_invalid');
    return data;
  },
  async speakPortrait(avatarId: string, callSessionId: string, requestId: string, reply: AvatarLiveReply, signal: AbortSignal) {
    const receipt = await post(avatarId, 'portrait/speak', { callSessionId, requestId, audioBase64: reply.audioBase64, format: reply.format }, signal);
    if (receipt?.status !== 'accepted' || receipt.requestId !== requestId) throw new Error('live_portrait_unconfirmed');
  },
};
