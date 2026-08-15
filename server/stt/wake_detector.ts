/**
 * Server-side wake word detection — multi-provider.
 * Auto-selects: Ark > Qwen. Both streaming; falls back to Qwen if no Ark key.
 */
import { logger } from '../../logger';
import { getKey } from '../config/keys';
import { getVoicePreference } from '../config/voice_preference';
import { classifyCloudError } from '../cloud/core';
import { isCircuitClosed, recordFailure, recordSuccess } from '../cloud/circuit_breaker';
import * as doubaoAsr from './providers/ark';

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

// DashScope currently terminates realtime response streams after 600 seconds.
// Warm the replacement up one minute before that hard boundary so microphone
// audio can move to an already-ready session instead of waiting for the client
// retry loop to rebuild the detector and microphone pipeline.
export const QWEN_WAKE_ROLLOVER_MS = 9 * 60 * 1000;
export const QWEN_WAKE_CONNECT_TIMEOUT_MS = 10_000;
export const QWEN_WAKE_HANDOFF_AUDIO_MS = 2_000;
export const QWEN_WAKE_ERROR_CLOSE_GRACE_MS = 1_500;

const QWEN_WAKE_ROLLOVER_RETRY_MS = 5_000;
const QWEN_WAKE_RETIRE_GRACE_MS = 500;
const QWEN_WAKE_DUPLICATE_WINDOW_MS = 3_000;
const QWEN_WAKE_PCM_BYTES_PER_SECOND = 16_000 * 2;

interface ManagedQwenWakeConnection {
  id: number;
  ws: any;
  ready: boolean;
  closed: boolean;
  retiring: boolean;
  failureHandled: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  errorCloseTimer: ReturnType<typeof setTimeout> | null;
}

function isQwenResponseStreamExpiry(message: string): boolean {
  return /response stream timeout|timeout_seconds\s*=\s*600/i.test(message || '');
}

function createQwenWakeDetector(
  apiKey: string,
  echoFilter?: (text: string) => boolean,
): WakeDetectorSession {
  const circuitProvider = 'qwen-stt';
  if (!isCircuitClosed(circuitProvider)) {
    throw new Error('Qwen wake-word detection is temporarily unavailable because its provider health circuit is open.');
  }
  const model = 'qwen3-asr-flash-realtime';
  const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`;

  const WebSocketImpl = (globalThis as any).WebSocket;
  if (!WebSocketImpl) throw new Error('WebSocket not available');

  const wakeCallbacks: Array<(keyword: string) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const connections = new Set<ManagedQwenWakeConnection>();
  const handoffAudio: Buffer[] = [];
  const maxHandoffBytes = Math.ceil(
    QWEN_WAKE_PCM_BYTES_PER_SECOND * QWEN_WAKE_HANDOFF_AUDIO_MS / 1000,
  );

  let handoffBytes = 0;
  let activeConnection: ManagedQwenWakeConnection | null = null;
  let warmingConnection: ManagedQwenWakeConnection | null = null;
  let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  let rolloverRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connectionCounter = 0;
  let eventCounter = 0;
  let lastWakeAt = 0;
  let handoffDuplicateProtectionUntil = 0;

  function nextId(): string {
    return `wk_${++eventCounter}_${Date.now()}`;
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer);
  }

  function sendEvent(connection: ManagedQwenWakeConnection, payload: Record<string, unknown>): boolean {
    if (connection.closed || connection.ws.readyState !== WebSocketImpl.OPEN) return false;
    try {
      connection.ws.send(JSON.stringify({ event_id: nextId(), ...payload }));
      return true;
    } catch {
      return false;
    }
  }

  function sendAudioTo(connection: ManagedQwenWakeConnection, chunk: Buffer): boolean {
    return connection.ready && sendEvent(connection, {
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  }

  function rememberHandoffAudio(chunk: Buffer): void {
    const copy = Buffer.from(chunk);
    handoffAudio.push(copy);
    handoffBytes += copy.byteLength;
    while (handoffBytes > maxHandoffBytes && handoffAudio.length > 1) {
      const removed = handoffAudio.shift();
      handoffBytes -= removed?.byteLength || 0;
    }
  }

  function clearConnectionTimers(connection: ManagedQwenWakeConnection): void {
    clearTimer(connection.readyTimer);
    clearTimer(connection.closeTimer);
    clearTimer(connection.errorCloseTimer);
    connection.readyTimer = null;
    connection.closeTimer = null;
    connection.errorCloseTimer = null;
  }

  function closeConnection(connection: ManagedQwenWakeConnection, finish: boolean): void {
    if (connection.closed) return;
    connection.retiring = true;
    clearTimer(connection.readyTimer);
    clearTimer(connection.errorCloseTimer);
    connection.readyTimer = null;
    connection.errorCloseTimer = null;

    if (finish && connection.ready) {
      sendEvent(connection, { type: 'session.finish' });
    }

    const closeNow = () => {
      if (connection.closed) return;
      try { connection.ws.close(); } catch {}
    };

    if (finish && connection.ws.readyState === WebSocketImpl.OPEN) {
      connection.closeTimer = setTimeout(closeNow, QWEN_WAKE_RETIRE_GRACE_MS);
    } else {
      closeNow();
    }
  }

  function scheduleRollover(delayMs = QWEN_WAKE_ROLLOVER_MS): void {
    clearTimer(rolloverTimer);
    rolloverTimer = null;
    if (stopped || !activeConnection?.ready) return;
    rolloverTimer = setTimeout(() => {
      rolloverTimer = null;
      startWarmingConnection('scheduled rollover');
    }, delayMs);
  }

  function scheduleRolloverRetry(): void {
    if (stopped || !activeConnection?.ready || warmingConnection || rolloverRetryTimer) return;
    rolloverRetryTimer = setTimeout(() => {
      rolloverRetryTimer = null;
      startWarmingConnection('rollover retry');
    }, QWEN_WAKE_ROLLOVER_RETRY_MS);
  }

  function emitWake(matched: string, transcript: string): void {
    const now = Date.now();
    if (
      now <= handoffDuplicateProtectionUntil
      && lastWakeAt > 0
      && now - lastWakeAt < QWEN_WAKE_DUPLICATE_WINDOW_MS
    ) {
      logger.info(`[Wake:Qwen] Duplicate handoff wake suppressed: "${transcript}"`);
      return;
    }
    lastWakeAt = now;
    logger.info(`[Wake:Qwen] WAKE "${matched}" in: "${transcript}"`);
    wakeCallbacks.forEach(cb => cb(matched));
  }

  function replayHandoffAudio(connection: ManagedQwenWakeConnection): void {
    for (const chunk of handoffAudio) {
      if (!sendAudioTo(connection, chunk)) break;
    }
  }

  function promoteConnection(connection: ManagedQwenWakeConnection): void {
    if (stopped || connection.closed || !connection.ready) return;
    const previous = activeConnection;

    // Replay a short bounded tail before the atomic switch. It covers a wake
    // phrase that straddles the boundary; duplicate detections are suppressed.
    replayHandoffAudio(connection);
    activeConnection = connection;
    if (warmingConnection === connection) warmingConnection = null;
    clearTimer(rolloverRetryTimer);
    rolloverRetryTimer = null;
    scheduleRollover();

    if (previous && previous !== connection) {
      handoffDuplicateProtectionUntil = Date.now() + QWEN_WAKE_DUPLICATE_WINDOW_MS;
      logger.info('[Wake:Qwen] Replacement ready; audio switched without reconnect gap');
      closeConnection(previous, true);
    } else {
      logger.info('[Wake:Qwen] Session ready');
    }
  }

  function notifyTerminalFailure(connection: ManagedQwenWakeConnection, err: Error): void {
    if (stopped || connection.failureHandled) return;
    connection.failureHandled = true;
    errorCallbacks.forEach(cb => cb(err));
  }

  function recoverConnectionInternally(connection: ManagedQwenWakeConnection, reason: string): void {
    if (stopped || connection.failureHandled) return;
    connection.failureHandled = true;
    logger.warn(`[Wake:Qwen] Upstream session ended; replacing internally (${reason})`);
    if (activeConnection === connection) activeConnection = null;
    if (warmingConnection === connection) warmingConnection = null;
    closeConnection(connection, false);
    startWarmingConnection('upstream expiry recovery');
  }

  function handleConnectionFailure(connection: ManagedQwenWakeConnection, err: Error): void {
    if (stopped || connection.retiring || connection.failureHandled) return;

    // A standby failure must not tear down the still-healthy active stream.
    if (warmingConnection === connection && activeConnection?.ready) {
      connection.failureHandled = true;
      warmingConnection = null;
      logger.warn(`[Wake:Qwen] Replacement failed while active session remains healthy: ${err.message}`);
      closeConnection(connection, false);
      scheduleRolloverRetry();
      return;
    }

    if (isQwenResponseStreamExpiry(err.message)) {
      recoverConnectionInternally(connection, err.message);
      return;
    }

    const classified = classifyCloudError(err, circuitProvider);
    recordFailure(circuitProvider, undefined, err, {
      openImmediately: classified.category === 'auth' || classified.category === 'quota',
    });

    notifyTerminalFailure(connection, err);
  }

  function startWarmingConnection(reason: string): void {
    if (stopped || warmingConnection) return;

    let ws: any;
    try {
      ws = new WebSocketImpl(url, {
        headers: { Authorization: `bearer ${apiKey}` },
      });
    } catch (err: any) {
      if (activeConnection?.ready) {
        logger.warn(`[Wake:Qwen] Could not create replacement (${reason}): ${err?.message || err}`);
        scheduleRolloverRetry();
        return;
      }
      const synthetic = {
        failureHandled: false,
      } as ManagedQwenWakeConnection;
      notifyTerminalFailure(synthetic, new Error(err?.message || 'Failed to create wake detector WebSocket'));
      return;
    }

    const connection: ManagedQwenWakeConnection = {
      id: ++connectionCounter,
      ws,
      ready: false,
      closed: false,
      retiring: false,
      failureHandled: false,
      readyTimer: null,
      closeTimer: null,
      errorCloseTimer: null,
    };
    warmingConnection = connection;
    connections.add(connection);

    connection.readyTimer = setTimeout(() => {
      connection.readyTimer = null;
      handleConnectionFailure(connection, new Error('Wake detector replacement connection timed out'));
    }, QWEN_WAKE_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (stopped || connection.closed || connection.retiring) return;
      logger.info(`[Wake:Qwen] Connected (${reason})`);
      sendEvent(connection, {
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
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (stopped || connection.closed) return;
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case 'session.created':
            if (connection.ready || connection.retiring) break;
            connection.ready = true;
            clearTimer(connection.readyTimer);
            connection.readyTimer = null;
            recordSuccess(circuitProvider);
            promoteConnection(connection);
            break;
          case 'conversation.item.input_audio_transcription.completed': {
            // Retiring sessions may still return the final transcript for audio
            // sent before the switch. Accept it and dedupe against the new flow.
            if (connection !== activeConnection && !connection.retiring) break;
            const transcript = msg.transcript || '';
            if (!transcript || echoFilter?.call(null, transcript)) break;
            const matched = isWakeWord(transcript);
            if (matched) emitWake(matched, transcript);
            break;
          }
          case 'error': {
            if (connection.retiring) break;
            const message = typeof msg.message === 'string' ? msg.message : 'ASR error';
            if (isQwenResponseStreamExpiry(message)) {
              logger.warn(`[Wake:Qwen] Realtime stream reached provider limit: ${message}`);
            } else {
              logger.error('[Wake:Qwen] Error:', msg.message || msg);
            }
            handleConnectionFailure(connection, new Error(message));
            break;
          }
        }
      } catch { /* binary frame */ }
    };

    ws.onerror = () => {
      if (stopped || connection.closed || connection.retiring || connection.errorCloseTimer) return;
      // WebSocket implementations emit `error` before `close`, while only the
      // close frame contains DashScope's useful 600-second expiry reason. Wait
      // briefly for that frame, then recover if this implementation never emits
      // one. This keeps an active microphone stream from becoming silently dead.
      logger.warn('[Wake:Qwen] WebSocket error; waiting for close reason');
      connection.errorCloseTimer = setTimeout(() => {
        connection.errorCloseTimer = null;
        if (stopped || connection.closed || connection.retiring) return;
        const err = new Error('Wake detector WebSocket error without close frame');
        if (activeConnection === connection) {
          recoverConnectionInternally(connection, err.message);
        } else {
          handleConnectionFailure(connection, err);
        }
      }, QWEN_WAKE_ERROR_CLOSE_GRACE_MS);
    };

    ws.onclose = (event: CloseEvent) => {
      const wasActive = activeConnection === connection;
      const wasWarming = warmingConnection === connection;
      connection.closed = true;
      clearConnectionTimers(connection);
      connections.delete(connection);
      if (activeConnection === connection) activeConnection = null;
      if (warmingConnection === connection) warmingConnection = null;

      const reason = event.reason ? `, reason=${event.reason}` : '';
      logger.info(`[Wake:Qwen] Closed (code=${event.code}${reason})`);
      if (stopped || connection.retiring || connection.failureHandled) return;

      const closeMessage = event.reason || `Wake detector closed unexpectedly (${event.code})`;
      if (wasWarming && activeConnection?.ready) {
        connection.failureHandled = true;
        logger.warn(`[Wake:Qwen] Replacement closed while active session remains healthy: ${closeMessage}`);
        scheduleRolloverRetry();
        return;
      }
      if (isQwenResponseStreamExpiry(closeMessage)) {
        handleConnectionFailure(connection, new Error(closeMessage));
      } else if ((event.code === 1000 || event.code === 1005) && (wasActive || wasWarming)) {
        // A remote normal close is not the same as a local stop. Recover it
        // internally so the client microphone and Socket.IO session stay live.
        recoverConnectionInternally(connection, closeMessage);
      } else if (event.code !== 1000 && event.code !== 1005) {
        handleConnectionFailure(connection, new Error(closeMessage));
      }
    };
  }

  startWarmingConnection('initial');

  return {
    sendAudio(chunk: Buffer) {
      if (stopped) return;
      rememberHandoffAudio(chunk);
      const active = activeConnection;
      if (active?.ready) sendAudioTo(active, chunk);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(rolloverTimer);
      clearTimer(rolloverRetryTimer);
      rolloverTimer = null;
      rolloverRetryTimer = null;
      activeConnection = null;
      warmingConnection = null;
      for (const connection of connections) {
        clearConnectionTimers(connection);
        if (connection.ready && !connection.retiring) {
          sendEvent(connection, { type: 'session.finish' });
        }
        connection.retiring = true;
        try { connection.ws.close(); } catch {}
        connection.closed = true;
      }
      connections.clear();
      handoffAudio.length = 0;
      handoffBytes = 0;
      wakeCallbacks.length = 0;
      errorCallbacks.length = 0;
    },
    onWake(cb) { wakeCallbacks.push(cb); },
    onError(cb) { errorCallbacks.push(cb); },
  };
}

// ── Provider: Ark (Doubao) polling batch transcription ──

function pcm16MonoToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function containsAudiblePcm(pcm: Buffer): boolean {
  if (pcm.length < 2) return false;
  let peak = 0;
  let squareSum = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    const absolute = Math.abs(value);
    if (absolute > peak) peak = absolute;
    squareSum += value * value;
    samples += 1;
  }
  const rms = samples > 0 ? Math.sqrt(squareSum / samples) : 0;
  return peak >= 800 || rms >= 180;
}

function createArkWakeDetector(
  echoFilter?: (text: string) => boolean,
): WakeDetectorSession {
  const POLL_MS = 2000;

  const wakeCallbacks: Array<(keyword: string) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const audioChunks: Buffer[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function pollTranscription(): Promise<void> {
    if (stopped || audioChunks.length === 0) return;
    const combined = Buffer.concat(audioChunks);
    audioChunks.length = 0;
    if (!containsAudiblePcm(combined)) return;

    try {
      const result = await doubaoAsr.transcribe(pcm16MonoToWav(combined), 'zh', {
        fileName: 'audio.wav',
        mimeType: 'audio/wav',
        signal: AbortSignal.timeout(5000),
      });
      const transcript = result.text || '';
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
      const message = String(err?.message || err || '');
      const expectedSilence = message.includes('(20000003)') || /no valid speech|normal silence audio/i.test(message);
      if (err.name !== 'AbortError' && !expectedSilence) {
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

  const hasDoubao = doubaoAsr.hasDoubaoSpeech();
  const qwenKey = accessKey
    || process.env.DASHSCOPE_API_KEY
    || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY')
    || getKey('QWEN_API_KEY');

  // Explicit user choice takes priority
  if (userPref === 'ark') {
    if (hasDoubao) {
      logger.info('[WakeDetector] Using Doubao Speech (user preference)');
      return createArkWakeDetector(echoFilter);
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
    logger.info('[WakeDetector] Using Doubao Speech (auto)');
    return createArkWakeDetector(echoFilter);
  }
  if (qwenKey) {
    logger.info('[WakeDetector] Using Qwen (auto)');
    return createQwenWakeDetector(qwenKey, echoFilter);
  }

  throw new Error('Doubao Speech API Key or DASHSCOPE_API_KEY required for wake word detection');
}
