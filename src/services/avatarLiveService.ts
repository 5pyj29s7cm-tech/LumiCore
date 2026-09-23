import { apiFetch } from './apiClient';
import { liveAudioEncoding, parseVisibleLiveComments, type AvatarLiveReply, type AvatarLiveTurn, type AvatarLiveHistoryTurn, type VisibleLiveComment } from '../../shared/avatar_live';

async function post(avatarId: string, action: string, body: unknown, signal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, action === 'live/scan' ? 50_000 : 140_000);
  try {
  const response = await apiFetch(`/api/memory-avatars/${encodeURIComponent(avatarId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
  });
  const data = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) throw new Error(data?.code || (response.status === 401 ? 'live_unauthorized' : response.status === 403 ? 'live_forbidden' : 'live_service_unavailable'));
  return data;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export const avatarLiveService = {
  async history(avatarId: string, signal: AbortSignal): Promise<AvatarLiveHistoryTurn[]> {
    const response = await apiFetch(`/api/memory-avatars/${encodeURIComponent(avatarId)}/live/history`, { signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data?.history)) throw new Error('live_history_unavailable');
    return data.history;
  },
  async acknowledge(avatarId: string, replyRequestId: string, signal: AbortSignal) {
    const data = await post(avatarId, 'live/played', { requestId: crypto.randomUUID(), replyRequestId, publicConsent: true }, signal);
    if (data?.saved !== true) throw new Error('live_history_unavailable');
  },
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
