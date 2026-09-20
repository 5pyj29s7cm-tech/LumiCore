import type { MutableRefObject } from 'react';
import type { AvatarLiveReply, AvatarLiveStageConfig } from '../../shared/avatar_live';
import { createMemoryAvatarPortraitConnection } from './memoryAvatarPortraitConnection';
import { avatarLiveService } from '../services/avatarLiveService';

/** One utterance at a time, with no retries of unknown playback outcomes. */
export class AvatarLivePlayback {
  private audio: AudioContext | null = null;
  private current: AbortController | null = null;
  private portrait: ReturnType<typeof createMemoryAvatarPortraitConnection> | null = null;
  private sessionId = '';
  private connectedAt = 0;
  private playbackEvent: ((speaking: boolean) => void) | null = null;
  private closing = Promise.resolve();
  constructor(private config: AvatarLiveStageConfig, private callbacks: {
    level: MutableRefObject<number>; stream: (stream: MediaStream | null) => void; surface?: (surface: HTMLDivElement | null) => void; speaking: (value: boolean) => void;
  }) {}
  async enable() {
    this.audio ||= new AudioContext();
    await this.audio.resume();
    if (this.audio.state !== 'running') throw new Error('live_audio_blocked');
  }
  stop() {
    this.current?.abort(); this.current = null;
    this.closePortrait(); this.sessionId = ''; this.connectedAt = 0;
    this.callbacks.level.current = 0; this.callbacks.speaking(false);
  }
  dispose() { this.stop(); void this.audio?.close(); this.audio = null; }
  closeAndWait() { this.dispose(); return this.closing; }
  private closePortrait() {
    if (this.portrait) {
      this.closing = this.portrait.closeAndWait(); void this.closing.catch(() => {}); this.portrait = null;
    }
  }
  async play(reply: AvatarLiveReply, requestId: string) {
    if (this.current) throw new Error('live_playback_busy');
    if (this.audio?.state !== 'running') throw new Error('live_audio_blocked');
    const operation = new AbortController(); this.current = operation;
    const timer = setTimeout(() => operation.abort(), 90_000);
    try {
      if (this.config.portraitMediaId || this.config.portraitProvider === 'aliyun') await this.playPortrait(reply, requestId, operation.signal);
      else await this.playAudio(reply, operation.signal);
      operation.signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      if (this.current === operation) { this.current = null; this.callbacks.speaking(false); this.callbacks.level.current = 0; }
    }
  }
  private async playAudio(reply: AvatarLiveReply, signal: AbortSignal) {
    const bytes = Uint8Array.from(atob(reply.audioBase64), char => char.charCodeAt(0));
    const decoded = await this.audio!.decodeAudioData(bytes.buffer);
    signal.throwIfAborted();
    const source = this.audio!.createBufferSource(), analyser = this.audio!.createAnalyser();
    analyser.fftSize = 256; source.buffer = decoded; source.connect(analyser); analyser.connect(this.audio!.destination);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const level = setInterval(() => { analyser.getByteFrequencyData(samples); this.callbacks.level.current = Math.min(1, samples.reduce((sum, value) => sum + value, 0) / samples.length / 75); }, 50);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { source.stop(); reject(new DOMException('Stopped', 'AbortError')); };
        source.onended = () => { signal.removeEventListener('abort', abort); resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        this.callbacks.speaking(true); source.start();
      });
    } finally { clearInterval(level); source.disconnect(); analyser.disconnect(); }
  }
  private async playPortrait(reply: AvatarLiveReply, requestId: string, signal: AbortSignal) {
    // Renew only between utterances, before the existing five-minute lease expires.
    if (!this.portrait || (!this.portrait.usesBrowserAudio && Date.now() - this.connectedAt > 180_000)) {
      this.closePortrait(); await this.closing; signal.throwIfAborted();
      this.sessionId = `live-${crypto.randomUUID()}`;
      this.portrait = createMemoryAvatarPortraitConnection({ avatarId: this.config.avatarId, provider: this.config.portraitProvider,
        onSurface: this.callbacks.surface,
        onStream: this.callbacks.stream,
        onPlayback: value => { this.callbacks.speaking(value); this.playbackEvent?.(value); },
        onFailure: () => { this.current?.abort(); },
      });
      await this.portrait.connect(this.sessionId, signal); this.connectedAt = Date.now();
    }
    signal.throwIfAborted();
    let cleanup = () => {};
    const ended = new Promise<void>((resolve, reject) => {
      let started = false;
      const abort = () => reject(new DOMException('Stopped', 'AbortError'));
      this.playbackEvent = speaking => { if (speaking) started = true; else if (started) resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      cleanup = () => { signal.removeEventListener('abort', abort); this.playbackEvent = null; };
    });
    void ended.catch(() => {});
    try {
      await avatarLiveService.speakPortrait(this.config.avatarId, this.sessionId, requestId, reply, signal);
      if (this.portrait.usesBrowserAudio) await this.portrait.playAudio(reply, requestId, signal);
      await ended;
    }
    catch (error) { this.closePortrait(); throw error; }
    finally { cleanup(); }
  }
}
