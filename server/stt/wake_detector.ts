/**
 * Server-side wake word detection — multi-provider.
 * Auto-selects: Ark > Qwen. Both streaming; falls back to Qwen if no Ark key.
 */
import { logger } from '../../logger';
import { getKey } from '../config/keys';
import { getVoicePreference } from '../config/voice_preference';

const WAKE_WORDS = [
  'Jarvis', 'jarvis', '贾维斯',
  '计算机', '电脑',
  'lumi', 'Lumi', 'LUMI',
  '卢米', '路米', '鲁米', '露米',
  // "嘿 Lumi" + common ASR misrecognition variants
  '嘿 Lumi', '嘿 lumi', '嘿lumi', 'hey lumi', 'Hey Lumi', 'Hey lumi',
  '黑卢米', '嘿路米', '黑鲁米', '嘿卢米', '黑路米', '嗨卢米', '嗨路米',
  'hi lumi', 'Hi Lumi', 'hi Lumi', '黑 lumi', '嗨 lumi',
  'hi 卢米', 'hi 路米', 'hey 卢米', 'hey 路米',
  '嘿 卢米', '嘿 路米', '嗨 卢米', '嗨 路米',
  // 豆包 + common ASR variants
  '豆包', '斗包', '都包', '豆瓣', '逗包',
  '嘿 豆包', '嗨 豆包', 'hey 豆包', 'hi 豆包',
];

export function isWakeWord(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  for (const w of WAKE_WORDS) {
    if (normalized.includes(w.toLowerCase())) return w;
  }
  return null;
}

export interface WakeDetectorSession {
  sendAudio(chunk: Buffer): void;
  stop(): void;
  onWake: (callback: (keyword: string) => void) => void;
  onError: (callback: (err: Error) => void) => void;
}

// ── Provider: Qwen (DashScope) streaming WebSocket ──

function createQwenWakeDetector(
  apiKey: string,
  echoFilter?: (text: string) => boolean,
): WakeDetectorSession {
  const model = 'qwen3-asr-flash-realtime';
  const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`;

  const WebSocketImpl = (globalThis as any).WebSocket;
  if (!WebSocketImpl) throw new Error('WebSocket not available');

  const ws = new WebSocketImpl(url, {
    headers: { Authorization: `bearer ${apiKey}` },
  });

  const wakeCallbacks: Array<(keyword: string) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const audioQueue: Buffer[] = [];
  let sessionReady = false;
  let eventCounter = 0;

  function nextId(): string {
    return `wk_${++eventCounter}_${Date.now()}`;
  }

  ws.onopen = () => {
    logger.info('[Wake:Qwen] Connected');
    ws.send(JSON.stringify({
      event_id: nextId(),
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: { enabled: true, language: 'zh' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.0,
          silence_duration_ms: 1500,
          prefix_padding_ms: 200,
        },
      },
    }));
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      switch (msg.type) {
        case 'session.created':
          sessionReady = true;
          logger.info('[Wake:Qwen] Session ready');
          for (const chunk of audioQueue) {
            ws.send(JSON.stringify({
              event_id: nextId(),
              type: 'input_audio_buffer.append',
              audio: Buffer.from(chunk).toString('base64'),
            }));
          }
          audioQueue.length = 0;
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = msg.transcript || '';
          if (transcript) {
            if (echoFilter?.call(null, transcript)) break;
            const matched = isWakeWord(transcript);
            if (matched) {
              logger.info(`[Wake:Qwen] WAKE "${matched}" in: "${transcript}"`);
              wakeCallbacks.forEach(cb => cb(matched));
            }
          }
          break;
        }
        case 'error':
          logger.error('[Wake:Qwen] Error:', msg.message || msg);
          errorCallbacks.forEach(cb => cb(new Error(msg.message || 'ASR error')));
          break;
      }
    } catch { /* binary frame */ }
  };

  ws.onerror = () => {
    errorCallbacks.forEach(cb => cb(new Error('Wake detector WebSocket error')));
  };

  ws.onclose = (event: CloseEvent) => {
    const reason = event.reason ? `, reason=${event.reason}` : '';
    logger.info(`[Wake:Qwen] Closed (code=${event.code}${reason})`);
    if (event.code !== 1000 && event.code !== 1005) {
      errorCallbacks.forEach(cb => cb(new Error(event.reason || `Wake detector closed unexpectedly (${event.code})`)));
    }
  };

  return {
    sendAudio(chunk: Buffer) {
      if (ws.readyState !== WebSocketImpl.OPEN) return;
      if (!sessionReady) { audioQueue.push(chunk); return; }
      ws.send(JSON.stringify({
        event_id: nextId(),
        type: 'input_audio_buffer.append',
        audio: Buffer.from(chunk).toString('base64'),
      }));
    },
    stop() {
      if (ws.readyState === WebSocketImpl.OPEN) {
        ws.send(JSON.stringify({ event_id: nextId(), type: 'session.finish' }));
        setTimeout(() => { try { ws.close(); } catch {} }, 500);
      }
    },
    onWake(cb) { wakeCallbacks.push(cb); },
    onError(cb) { errorCallbacks.push(cb); },
  };
}

// ── Provider: Ark (Doubao) polling batch transcription ──

function createArkWakeDetector(
  apiKey: string,
  echoFilter?: (text: string) => boolean,
): WakeDetectorSession {
  const POLL_MS = 2000;
  const MODEL = 'doubao-stt-1.0';

  const wakeCallbacks: Array<(keyword: string) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const audioChunks: Buffer[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function pollTranscription(): Promise<void> {
    if (stopped || audioChunks.length === 0) return;
    const combined = Buffer.concat(audioChunks);
    audioChunks.length = 0;

    try {
      const form = new FormData();
      form.append('file', new Blob([combined], { type: 'audio/webm' }), 'audio.webm');
      form.append('model', MODEL);
      form.append('language', 'zh');

      const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
        method: 'POST',
        headers: { Authorization: `Bearer;${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        logger.warn(`[Wake:Ark] HTTP ${res.status}`);
        return;
      }

      const data = await res.json() as any;
      const transcript = data.text || '';
      if (!transcript) return;

      logger.info(`[Wake:Ark] Transcript: "${transcript}"`);
      if (echoFilter?.call(null, transcript)) {
        logger.info(`[Wake:Ark] Echo filtered`);
        return;
      }
      const matched = isWakeWord(transcript);
      if (matched) {
        logger.info(`[Wake:Ark] WAKE "${matched}" in: "${transcript}"`);
        wakeCallbacks.forEach(cb => cb(matched));
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        logger.warn(`[Wake:Ark] Poll error: ${err.message}`);
      }
    }
  }

  logger.info('[Wake:Ark] Started (polling mode)');

  return {
    sendAudio(chunk: Buffer) {
      if (stopped) return;
      audioChunks.push(chunk);
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    onWake(cb) {
      wakeCallbacks.push(cb);
      // Start polling once we have a listener
      if (!timer) timer = setInterval(pollTranscription, POLL_MS);
    },
    onError(cb) { errorCallbacks.push(cb); },
  };
}

// ── Factory: respects user's STT preference, auto-select Ark > Qwen ──

export function createWakeDetector(
  accessKey?: string,
  echoFilter?: (text: string) => boolean,
): WakeDetectorSession {
  // Read user STT preference — if explicitly set, honor it
  let userPref: string = 'auto';
  try {
    userPref = getVoicePreference().stt || 'auto';
  } catch {}

  const speechKey = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY');
  const hasDoubao = !!(speechKey && speechKey.includes(':'));
  const qwenKey = accessKey
    || process.env.DASHSCOPE_API_KEY
    || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY')
    || getKey('QWEN_API_KEY');

  // Explicit user choice takes priority
  if (userPref === 'ark') {
    if (hasDoubao) {
      const token = speechKey!.slice(speechKey!.indexOf(':') + 1).trim();
      logger.info('[WakeDetector] Using Doubao Speech (user preference)');
      return createArkWakeDetector(token, echoFilter);
    }
    logger.warn('[WakeDetector] User prefers Ark but no Doubao Speech key configured');
  }
  if (userPref === 'qwen') {
    if (qwenKey) {
      logger.info('[WakeDetector] Using Qwen (user preference)');
      return createQwenWakeDetector(qwenKey, echoFilter);
    }
    logger.warn('[WakeDetector] User prefers Qwen but no DashScope key configured');
  }

  // Auto mode — prefer Doubao, fall back to Qwen
  if (hasDoubao) {
    const token = speechKey!.slice(speechKey!.indexOf(':') + 1).trim();
    logger.info('[WakeDetector] Using Doubao Speech (auto)');
    return createArkWakeDetector(token, echoFilter);
  }
  if (qwenKey) {
    logger.info('[WakeDetector] Using Qwen (auto)');
    return createQwenWakeDetector(qwenKey, echoFilter);
  }

  throw new Error('Doubao Speech (AppID:AccessToken) or DASHSCOPE_API_KEY required for wake word detection');
}
