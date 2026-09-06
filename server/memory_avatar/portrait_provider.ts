import { isStrictPrivacy } from '../config/privacy';

/** D-ID Agents Streams is a renderer here: Lumi never calls its chat/LLM API. */
export class PortraitError extends Error {
  constructor(public code: string, message: string, public status = 503, public outcomeUnknown = false) { super(message); }
}

export function normalizePortraitApiKey(input: unknown): string {
  if (typeof input !== 'string') throw new PortraitError('portrait_key_invalid', 'Enter the D-ID API key.', 400);
  const key = input.trim().replace(/^Basic\s+/i, '');
  if (!key || key.length > 4096 || /\s/.test(key) || key.includes('://')) throw new PortraitError('portrait_key_invalid', 'Invalid D-ID API key.', 400);
  if (key.includes(':')) {
    if (key.startsWith(':') || key.endsWith(':')) throw new PortraitError('portrait_key_invalid', 'The D-ID key requires a username and password.', 400);
    return Buffer.from(key, 'utf8').toString('base64');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || !Buffer.from(key, 'base64').toString('utf8').includes(':')) {
    throw new PortraitError('portrait_key_invalid', 'Enter the D-ID username:password API key or its Basic base64 value.', 400);
  }
  return key;
}

export function requirePortraitCloud(): void {
  if (isStrictPrivacy()) throw new PortraitError('portrait_privacy_blocked', 'Live portrait rendering is unavailable in strict privacy mode.', 403);
}

function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_@.:-]{1,250}$/.test(value)) {
    throw new PortraitError('portrait_provider_response', 'D-ID returned an invalid resource identifier.', 502, true);
  }
  return encodeURIComponent(value);
}

function uploadResult(value: any): { url: string; id?: string } {
  let url: URL;
  try { url = new URL(value?.url); } catch { throw new PortraitError('portrait_provider_response', 'D-ID did not return an uploaded resource.', 502, true); }
  // Only provider-returned URLs enter this path; the client cannot supply one.
  // They are handed back to D-ID, never fetched by Lumi or exposed publicly.
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(^|\.)(d-id\.com|amazonaws\.com)$/.test(url.hostname)) {
    throw new PortraitError('portrait_provider_response', 'D-ID returned an unsupported resource location.', 502, true);
  }
  if (value.id !== undefined) resourceId(value.id);
  return { url: url.href, ...(value.id ? { id: value.id } : {}) };
}

export interface PortraitOffer {
  offer: { type: 'offer'; sdp: string };
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}
export interface ProviderPortraitStream extends PortraitOffer { id: string; sessionId?: string }

export class DidPortraitProvider {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), private readonly timeoutMs = 20_000) {}

  private async request(key: string, route: string, method: 'POST' | 'DELETE', body?: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<any> {
    requirePortraitCloud(); signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('D-ID request deadline exceeded.')), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetcher(`https://api.d-id.com${route}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Basic ${key}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
      if (method === 'DELETE' && response.status === 404) return {};
      if (!response.ok) {
        // Provider error bodies may contain source URLs/credentials. Do not relay them.
        await response.body?.cancel();
        throw new PortraitError(response.status === 402 ? 'portrait_credits_required' : 'portrait_provider_rejected',
          response.status === 402 ? 'D-ID credits are required for live portraits.' : `D-ID rejected the request (HTTP ${response.status}).`,
          response.status === 401 || response.status === 403 ? 503 : 502, response.status >= 500);
      }
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) return {};
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024) throw new Error('Oversized D-ID response.');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof PortraitError) throw error;
      throw new PortraitError('portrait_outcome_unknown', 'The D-ID request result could not be confirmed. It will not be sent again automatically.', 503, true);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }

  async uploadImage(key: string, data: Buffer, mime: string, signal?: AbortSignal) {
    if (!['image/jpeg', 'image/png'].includes(mime) || !data.length || data.length > 10 * 1024 * 1024) {
      throw new PortraitError('portrait_image_invalid', 'Use a supported portrait thumbnail or video poster.', 400);
    }
    const form = new FormData(); form.set('image', new Blob([new Uint8Array(data)], { type: mime }), mime === 'image/png' ? 'portrait.png' : 'portrait.jpg');
    return uploadResult(await this.request(key, '/images', 'POST', form, signal));
  }

  async uploadAudio(key: string, data: Buffer, format: string, signal?: AbortSignal) {
    const formats: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
    const mime = formats[format.toLowerCase()];
    if (!mime || !data.length || data.length > 6 * 1024 * 1024) throw new PortraitError('portrait_audio_invalid', 'Live portraits require a supported encoded audio reply up to 6 MB.', 400);
    const form = new FormData(); form.set('audio', new Blob([new Uint8Array(data)], { type: mime }), `reply.${format.toLowerCase()}`);
    return uploadResult(await this.request(key, '/audios', 'POST', form, signal));
  }

  async createAgent(key: string, imageUrl: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request(key, '/agents', 'POST', { presenter: { type: 'talk', source_url: imageUrl, thumbnail: imageUrl } }, signal);
    resourceId(result.id); return result.id;
  }

  async createStream(key: string, agentId: string, signal?: AbortSignal): Promise<ProviderPortraitStream> {
    // session_timeout requires an extra D-ID entitlement. Keep its default;
    // Lumi separately bounds its own call lifetime and explicitly deletes it.
    const result = await this.request(key, `/agents/${resourceId(agentId)}/streams`, 'POST', { stream_warmup: true }, signal);
    resourceId(result.id);
    const offer = result.jsep || result.offer;
    if (!offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || !offer.sdp.startsWith('v=0') || offer.sdp.length > 256_000
        || !Array.isArray(result.ice_servers) || result.ice_servers.length > 20
        || (result.session_id !== undefined && (typeof result.session_id !== 'string' || result.session_id.length > 4096))) {
      throw new PortraitError('portrait_provider_response', 'D-ID did not return a valid WebRTC offer.', 502, true);
    }
    const iceServers = result.ice_servers.map((entry: any) => {
      const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      if (!urls.length || urls.length > 10 || urls.some((url: any) => typeof url !== 'string' || url.length > 1024 || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))
          || [entry.username, entry.credential].some(value => value !== undefined && (typeof value !== 'string' || value.length > 4096))) {
        throw new PortraitError('portrait_provider_response', 'D-ID returned invalid ICE servers.', 502, true);
      }
      return { urls: entry.urls, ...(entry.username ? { username: entry.username } : {}), ...(entry.credential ? { credential: entry.credential } : {}) };
    });
    return { id: result.id, sessionId: result.session_id, offer: { type: 'offer', sdp: offer.sdp }, iceServers };
  }

  answer(key: string, agentId: string, stream: ProviderPortraitStream, answer: { type: 'answer'; sdp: string }, signal?: AbortSignal) {
    return this.request(key, `/agents/${resourceId(agentId)}/streams/${resourceId(stream.id)}/sdp`, 'POST', { session_id: stream.sessionId, answer }, signal);
  }
  ice(key: string, agentId: string, stream: ProviderPortraitStream, candidate: Record<string, unknown> | null, signal?: AbortSignal) {
    return this.request(key, `/agents/${resourceId(agentId)}/streams/${resourceId(stream.id)}/ice`, 'POST', { session_id: stream.sessionId, ...(candidate || {}) }, signal);
  }
  speak(key: string, agentId: string, stream: ProviderPortraitStream, audioUrl: string, signal?: AbortSignal) {
    return this.request(key, `/agents/${resourceId(agentId)}/streams/${resourceId(stream.id)}`, 'POST', { session_id: stream.sessionId, script: { type: 'audio', audio_url: audioUrl } }, signal);
  }
  deleteStream(key: string, agentId: string, stream: ProviderPortraitStream, signal?: AbortSignal) {
    return this.request(key, `/agents/${resourceId(agentId)}/streams/${resourceId(stream.id)}`, 'DELETE', { session_id: stream.sessionId }, signal);
  }
  deleteAgent(key: string, id: string, signal?: AbortSignal) { return this.request(key, `/agents/${resourceId(id)}`, 'DELETE', undefined, signal); }
  deleteUpload(key: string, kind: 'images' | 'audios', id: string, signal?: AbortSignal) { return this.request(key, `/${kind}/${resourceId(id)}`, 'DELETE', undefined, signal); }
}
