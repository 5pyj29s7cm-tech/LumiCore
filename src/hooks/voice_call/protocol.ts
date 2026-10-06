import type { VoiceStartPayload, VoiceSwitchTransition } from './contracts';

export const THINKING_WATCHDOG_MS = 45000;

export const LUMI_VOICE_TRANSCRIPT_EVENT = 'lumi:voice-transcript';

export function normalizeSelectedVoiceId(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

/**
 * Keep the reconnect payload and live socket update on the same voice revision.
 * Returning no event for the existing voice prevents duplicate server updates.
 */
export function prepareVoiceSwitch(
  payload: VoiceStartPayload | null,
  nextVoiceId: unknown,
): VoiceSwitchTransition | null {
  const voiceId = normalizeSelectedVoiceId(nextVoiceId);
  if (!payload || !voiceId) return null;
  const nextPayload = { ...payload, voiceId };
  return {
    nextPayload,
    event: payload.voiceId === voiceId ? null : { voiceId, sessionId: payload.sessionId },
  };
}

/**
 * Socket.IO can materialize a server Buffer as an ArrayBuffer, a typed-array
 * view, or (when a proxy/parser has already JSON-serialized the attachment)
 * `{ type: 'Buffer', data: number[] }`.  Keep the playback boundary tolerant
 * of all three shapes and always hand Web Audio an independent ArrayBuffer.
 */
export function normalizeVoiceAudioBuffer(value: unknown): ArrayBuffer | null {
  if (value == null) return null;
  if (typeof ArrayBuffer !== 'undefined') {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
      try {
        return new Uint8Array(value as ArrayBufferLike).slice().buffer;
      } catch {}
    }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data) && (record.type === 'Buffer' || record.type === 'Uint8Array' || !('buffer' in record))) {
      const bytes = record.data.filter(item => Number.isFinite(Number(item))).map(item => Number(item) & 0xff);
      return Uint8Array.from(bytes).buffer;
    }
    if ('buffer' in record && record.buffer !== value) {
      return normalizeVoiceAudioBuffer(record.buffer);
    }
    if ('data' in record && record.data !== value) {
      return normalizeVoiceAudioBuffer(record.data);
    }
  }
  return null;
}

export function shouldAcceptVoiceStatus(
  data: { status: string; requestId?: string },
  activeRequestId: string | null,
): boolean {
  if (data.status === 'thinking') return true;
  if (data.requestId && activeRequestId && data.requestId !== activeRequestId) return false;
  if (!data.requestId && activeRequestId && (data.status === 'listening' || data.status === 'idle')) return false;
  return true;
}

export function waitForVoiceSocket(socket: any, timeoutMs = 8000): Promise<void> {
  if (socket?.connected) return Promise.resolve();
  if (!socket) return Promise.reject(new Error('Voice connection is unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off?.('connect', onConnect);
      socket.off?.('connect_error', onError);
      if (error) reject(error); else resolve();
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(new Error(error?.message || 'Voice connection failed'));
    const timer = setTimeout(() => finish(new Error('Voice connection timed out')), timeoutMs);
    socket.on?.('connect', onConnect);
    socket.on?.('connect_error', onError);
    socket.connect?.();
  });
}

export function createVoiceSessionId(): string {
  try { return crypto.randomUUID(); } catch { return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
