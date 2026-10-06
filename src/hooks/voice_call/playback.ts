import { closeAudioContext } from "@/lib/audioContextLifecycle";
import type { useVoiceCaptureRuntime } from './useVoiceCaptureRuntime';
import type { VoiceAudioResponse } from './contracts';

export function releaseAudioBufferSource(source: AudioBufferSourceNode | null, stop = false): void {
  if (!source) return;
  source.onended = null;
  if (stop) {
    try { source.stop(); } catch {}
  }
  try { source.disconnect(); } catch {}
  try { source.buffer = null; } catch {}
}

export function createVoicePlaybackRuntime({ audioQueue, isCallActive, ensureTtsContext, isConversationTtsPlaying, playbackRequestIdRef, setHasConversationPlayback, isTtsPlaying, proactiveSource, setError, setCallState, playbackGenerationRef, ttsStartedAt, ttsBargeInCandidateSentRef, clearThinkingWatchdog, outputLevelRef, ttsEchoFloorRef, ttsBargeInFramesRef, ttsSourceRef, ttsContext, ttsGainNode, nextStartTime, socket }: Pick<ReturnType<typeof useVoiceCaptureRuntime>, "audioQueue" | "isCallActive" | "ensureTtsContext" | "isConversationTtsPlaying" | "playbackRequestIdRef" | "setHasConversationPlayback" | "isTtsPlaying" | "proactiveSource" | "setError" | "setCallState" | "playbackGenerationRef" | "ttsStartedAt" | "ttsBargeInCandidateSentRef" | "clearThinkingWatchdog" | "outputLevelRef" | "ttsEchoFloorRef" | "ttsBargeInFramesRef" | "ttsSourceRef" | "ttsContext" | "ttsGainNode" | "nextStartTime" | "socket">) {


    /**
     * Play a TTS audio chunk using Web Audio API with cross-fade scheduling.
     * Pre-buffers: starts decoding while the previous chunk is still playing.
     * Cross-fade: overlaps the last 50ms of previous audio with the first 50ms of next.
     * VolumeGain: applies server-computed volume adaptation.
     */
    const prepareAudio = (packet: VoiceAudioResponse, ctx: AudioContext) => {
      if (packet.preparedAudio?.context === ctx) return packet.preparedAudio;
      const prepared: NonNullable<VoiceAudioResponse['preparedAudio']> = {
        context: ctx, startedAt: performance.now(), promise: Promise.resolve({}),
      };
      // Decode at most the playing packet and one queued packet. A rejected
      // preparation is observed here even if interruption later drops the queue.
      prepared.promise = Promise.resolve().then(() => ctx.decodeAudioData(packet.buffer.slice(0))).then(decoded => {
        prepared.finishedAt = performance.now();
        return { decoded };
      }, error => {
        prepared.finishedAt = performance.now();
        return { error };
      });
      packet.preparedAudio = prepared;
      return prepared;
    };

    const prepareQueueHead = (ctx: AudioContext) => {
      const next = audioQueue.current[0];
      if (!next) return;
      const packet: VoiceAudioResponse = next instanceof ArrayBuffer ? { buffer: next, receivedAt: performance.now() } : next;
      audioQueue.current[0] = packet;
      prepareAudio(packet, ctx);
    };

    const playAudioChunk = (
      buffer: ArrayBuffer,
      volumeGain?: number,
      lane?: string,
      requestId?: string,
      format?: string,
      queuedPacket?: VoiceAudioResponse,
    ) => {
      if (!isCallActive.current) return;
      let ctx: AudioContext;
      try {
        ctx = ensureTtsContext();
      } catch (error) {
        console.error('[VoiceCall] Could not create the realtime audio output:', error, { format, lane, requestId });
        isConversationTtsPlaying.current = false;
        playbackRequestIdRef.current = null;
        setHasConversationPlayback(false);
        audioQueue.current = [];
        isTtsPlaying.current = Boolean(proactiveSource.current);
        setError('Voice audio could not be played. The text reply is still available.');
        setCallState(prev => prev === 'speaking' ? 'listening' : prev);
        return;
      }
      if (!isConversationTtsPlaying.current) playbackGenerationRef.current++;
      const playbackGeneration = playbackGenerationRef.current;
      const packet = queuedPacket || { buffer, receivedAt: performance.now() };
      const preparedAudio = prepareAudio(packet, ctx);
      prepareQueueHead(ctx);
      playbackRequestIdRef.current = requestId || null;
      isConversationTtsPlaying.current = true;
      setHasConversationPlayback(true);
      isTtsPlaying.current = true;
      if (ttsStartedAt.current === 0) {
        ttsStartedAt.current = Date.now();
        ttsBargeInCandidateSentRef.current = false;
      }
      if (lane !== 'conversation') clearThinkingWatchdog();
      setCallState(prev => (prev === 'thinking' || prev === 'queued') ? 'speaking' : prev);

      const playNextOrFinish = () => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        if (audioQueue.current.length > 0) {
          const next = audioQueue.current.shift()!;
          const queued: VoiceAudioResponse = next instanceof ArrayBuffer ? { buffer: next } : next;
          playAudioChunk(queued.buffer, queued.volumeGain, queued.lane, queued.requestId, queued.format, queued);
          return;
        }
        isConversationTtsPlaying.current = false;
        playbackRequestIdRef.current = null;
        setHasConversationPlayback(false);
        outputLevelRef.current = 0;
        isTtsPlaying.current = Boolean(proactiveSource.current);
        ttsStartedAt.current = 0;
        ttsEchoFloorRef.current = 0;
        ttsBargeInFramesRef.current = 0;
        ttsBargeInCandidateSentRef.current = false;
        setCallState(prev => prev === 'speaking' ? 'listening' : prev);
      };

      let failed = false;
      const failPlayback = (error: unknown) => {
        if (failed || playbackGeneration !== playbackGenerationRef.current) return;
        failed = true;
        console.error('[VoiceCall] Realtime audio playback failed:', error, { format, lane, requestId });
        if (ttsSourceRef.current) {
          releaseAudioBufferSource(ttsSourceRef.current, true);
          ttsSourceRef.current = null;
        }
        if (ttsContext.current === ctx) {
          const gain = ttsGainNode.current;
          ttsGainNode.current = null;
          try { gain?.disconnect(); } catch {}
          ttsContext.current = null;
          nextStartTime.current = 0;
          void closeAudioContext(ctx);
        }
        isConversationTtsPlaying.current = false;
        isTtsPlaying.current = Boolean(proactiveSource.current);
        setError('Voice audio could not be played. The text reply is still available.');
        playNextOrFinish();
      };

      const startDecodedAudio = (decoded: AudioBuffer) => {
        if (!isCallActive.current || playbackGeneration !== playbackGenerationRef.current) return;
        if (ctx.state === 'closed') {
          failPlayback(new Error('Audio output context closed before playback'));
          return;
        }
        try {
          const now = ctx.currentTime;
          const crossFadeSec = 0.05;
          const effectiveStart = nextStartTime.current > 0
            ? Math.max(now, nextStartTime.current - crossFadeSec)
            : now;
          nextStartTime.current = effectiveStart + decoded.duration;

          const source = ctx.createBufferSource();
          source.buffer = decoded;
          const gain = typeof volumeGain === 'number' ? Math.max(0.3, Math.min(1.5, volumeGain)) : 1.0;
          if (!ttsGainNode.current) throw new Error('Audio output gain node is unavailable');
          ttsGainNode.current.gain.setValueAtTime(gain, effectiveStart);
          source.connect(ttsGainNode.current);
          ttsSourceRef.current = source;
          source.onended = () => {
            releaseAudioBufferSource(source);
            if (ttsSourceRef.current === source) ttsSourceRef.current = null;
            playNextOrFinish();
          };
          source.start(effectiveStart);
          setError(prev => prev?.startsWith('Voice audio could not be played') ? null : prev);
          if (requestId) {
            const ackGeneration = playbackGeneration;
            const delayMs = Math.max(0, Math.round((effectiveStart - ctx.currentTime) * 1000));
            setTimeout(() => {
              if (!isCallActive.current || ackGeneration !== playbackGenerationRef.current) return;
              socket.emit('audio:playback_started', {
                requestId,
                lane,
                durationMs: Math.max(1, Math.round(decoded.duration * 1_000)),
                clientDecodeMs: Math.max(0, Math.round((preparedAudio.finishedAt ?? performance.now()) - preparedAudio.startedAt)),
                clientReceiptToPlaybackMs: Math.max(0, Math.round(performance.now() - (packet.receivedAt ?? preparedAudio.startedAt))),
              });
            }, delayMs);
          }
        } catch (error) {
          failPlayback(error);
        }
      };

      const decode = () => {
        try {
          void preparedAudio.promise.then(result => {
            if (result.decoded) startDecodedAudio(result.decoded);
            else failPlayback(result.error || new Error('Audio decoding returned no samples'));
          }).catch(failPlayback);
        } catch (error) {
          failPlayback(error);
        }
      };

      const prepareOutput = async () => {
        if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
          let resumeTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            await Promise.race([
              ctx.resume(),
              new Promise<never>((_resolve, reject) => {
                resumeTimer = setTimeout(() => reject(new Error('Audio output resume timed out')), 2500);
              }),
            ]);
          } finally {
            if (resumeTimer) clearTimeout(resumeTimer);
          }
        }
        if (ctx.state !== 'running') throw new Error(`Audio output is ${ctx.state}`);
        if (!isCallActive.current || playbackGeneration !== playbackGenerationRef.current) return;
        decode();
      };
      void prepareOutput().catch(failPlayback);
    };
  return { prepareAudio, prepareQueueHead, playAudioChunk };
}
