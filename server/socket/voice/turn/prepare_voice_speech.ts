import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { logger } from "../../../../logger";
import { synthesizeSpeech, getFallbackProvider as getTTSFallbackProvider, isTtsCancellationError, resolveEmotionVoice } from "../../../tts/adapter";
import { markVoiceLatencyMilestone } from "../../../monitor/voice_latency_store";
import { type LockedVoiceTurnTtsRoute, resolveVoiceForProvider, lockVoiceTurnTtsRoute, canFallbackVoiceTurnTtsRoute } from "../selection";
import { emitVoiceTtsFailure, voiceTransportState, computeVolumeGain } from "../../voice_transport_runtime";
import { addEchoText, voiceEchoScope } from "../echo";
import type { TTSProvider } from "../../../tts/types";
import { voiceProfileScope } from "../../../tts/profile_store";
import { extractFirstCompleteSpeechSentence } from "../../../tts/speculative_sentence";
import type { prepareVoiceReceiptsAndTools } from './prepare_voice_receipts_and_tools';

export async function prepareVoiceSpeech(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceReceiptsAndTools>>["context"]>) {


  // ── Generation gating: only latest command gets TTS output ──
  context.session.bgGeneration++;
  let turnSpeechGeneration = -1;
  let turnSpeechAbort: AbortController | null = null;
  let ttsQueue: Promise<void> = Promise.resolve();
  type SynthesizedSpeech = Awaited<ReturnType<typeof synthesizeSpeech>> & { ttsRequestedAt: number; ttsReadyAt: number };
  let lockedTurnTtsRoute: LockedVoiceTurnTtsRoute | null | undefined;
  let lockedTurnTtsRoutePromise: Promise<LockedVoiceTurnTtsRoute | null> | null = null;
  let turnTtsEmittedSegments = 0;
  let turnTtsFallbackAttempted = false;
  let turnTtsUnavailable = false;

  const resolveLockedRoute = async (
    provider: TTSProvider,
    requestedVoiceId: string | null,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    const voiceResolution = await resolveVoiceForProvider(
      voiceProfileScope(context.session.userId, context.session.domain, context.session.orgId),
      provider,
      requestedVoiceId,
    );
    if (!voiceResolution.voiceId) return null;
    const emotionVoice = resolveEmotionVoice(voiceResolution.voiceId, context.turnEmotionState);
    return lockVoiceTurnTtsRoute({
      provider,
      voiceId: emotionVoice.voiceId,
      ...(provider === 'relay' && context.turnTtsSelection.model ? { model: context.turnTtsSelection.model } : {}),
      ...(emotionVoice.speechRate !== undefined ? { speechRate: emotionVoice.speechRate } : {}),
      ...(emotionVoice.pitch !== undefined ? { pitch: emotionVoice.pitch } : {}),
      ...(emotionVoice.volume !== undefined ? { volume: emotionVoice.volume } : {}),
    });
  };

  const getLockedTurnTtsRoute = (): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (lockedTurnTtsRoute !== undefined) return Promise.resolve(lockedTurnTtsRoute);
    if (lockedTurnTtsRoutePromise) return lockedTurnTtsRoutePromise;
    lockedTurnTtsRoutePromise = (async () => {
      if (!context.turnTtsSelection.provider || !context.turnTtsSelection.requestedVoiceId) return null;
      const route = await resolveLockedRoute(
        context.turnTtsSelection.provider,
        context.turnTtsSelection.requestedVoiceId,
      );
      // Reconcile the server selection for future turns, but never overwrite a
      // newer explicit switch that arrived while this route was resolving.
      if (
        route
        && route.voiceId !== context.turnTtsSelection.requestedVoiceId
        && context.session.voiceSwitchGeneration === context.turnTtsSelection.switchGeneration
        && context.session.currentVoiceId === context.turnTtsSelection.requestedVoiceId
      ) {
        const previousVoiceId = context.session.currentVoiceId;
        context.session.currentVoiceId = route.voiceId;
        context.session.voiceSwitchGeneration += 1;
        context.socket.emit('audio:voice_changed', {
          voiceId: route.voiceId,
          previousVoiceId,
          sessionId: context.session.sessionId,
          provider: route.provider,
          fallback: true,
          reason: 'provider_compatibility',
        });
      }
      return route;
    })().then(route => {
      lockedTurnTtsRoute = route;
      lockedTurnTtsRoutePromise = null;
      return route;
    }, error => {
      lockedTurnTtsRoutePromise = null;
      throw error;
    });
    return lockedTurnTtsRoutePromise;
  };

  const tryLockTurnTtsFallback = async (
    failedRoute: LockedVoiceTurnTtsRoute,
    error: unknown,
    signal: AbortSignal,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (!canFallbackVoiceTurnTtsRoute({
      emittedSegments: turnTtsEmittedSegments,
      fallbackAttempted: turnTtsFallbackAttempted,
      error,
      signal,
    })) return null;
    turnTtsFallbackAttempted = true;
    const fallbackProvider = getTTSFallbackProvider(failedRoute.provider, { requireWarmLocal: true });
    if (!fallbackProvider || fallbackProvider === failedRoute.provider) return null;
    const fallbackRoute = await resolveLockedRoute(
      fallbackProvider,
      context.turnTtsSelection.requestedVoiceId,
    );
    if (!fallbackRoute) return null;
    lockedTurnTtsRoute = fallbackRoute;
    logger.warn(
      `[Audio TTS] Primary route failed before playback; locked request=${context.requestId} fallback=${fallbackRoute.provider} voice=${fallbackRoute.voiceId}`,
    );
    return fallbackRoute;
  };

  const synthesizeOnRoute = async (
    text: string,
    route: LockedVoiceTurnTtsRoute,
    signal: AbortSignal,
  ) => {
    context.turnAuthorization.assertCurrent();
    const ttsRequestedAt = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: route.provider,
      voiceId: route.voiceId,
      model: route.model,
      speechRate: route.speechRate,
      pitch: route.pitch,
      volume: route.volume,
      signal,
      allowFallback: false,
    });
    return { ...result, ttsRequestedAt, ttsReadyAt: Date.now() };
  };

  let speculativeSpeech: {
    text: string;
    requestedAt: number;
    controller: AbortController;
    promise: Promise<{ result?: SynthesizedSpeech; route?: LockedVoiceTurnTtsRoute; error?: unknown }>;
  } | null = null;

  const ensureTurnSpeechController = () => {
    if (
      !turnSpeechAbort
      || turnSpeechAbort.signal.aborted
      || turnSpeechGeneration !== context.session.bgGeneration
    ) {
      if (context.session.ttsAbortController && context.session.ttsAbortController !== turnSpeechAbort) {
        context.session.ttsAbortController.abort();
      }
      turnSpeechAbort = new AbortController();
      turnSpeechGeneration = context.session.bgGeneration;
      context.session.ttsAbortController = turnSpeechAbort;
    }
    return { controller: turnSpeechAbort, generation: turnSpeechGeneration };
  };

  const estimatePlaybackMs = (audioBuffer: Buffer, text: string): number => {
    const fallback = Math.min(18000, Math.max(2200, text.length * 185 + 700));
    try {
      if (
        Buffer.isBuffer(audioBuffer) &&
        audioBuffer.length > 44 &&
        audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
        audioBuffer.toString('ascii', 8, 12) === 'WAVE'
      ) {
        const byteRate = audioBuffer.readUInt32LE(28);
        let offset = 12;
        while (offset + 8 <= audioBuffer.length) {
          const chunkId = audioBuffer.toString('ascii', offset, offset + 4);
          const chunkSize = audioBuffer.readUInt32LE(offset + 4);
          if (chunkId === 'data' && byteRate > 0) {
            return Math.min(30000, Math.max(1000, Math.round(chunkSize / byteRate * 1000) + 450));
          }
          offset += 8 + chunkSize + (chunkSize % 2);
        }
      }
    } catch {}
    return fallback;
  };

  const maybeStartSpeculativeSpeech = () => {
    if (
      speculativeSpeech
      || context.toolSessionActive
      || context.deferCompletionSpeech
      || !context.turnTtsSelection.provider
      || !context.turnTtsSelection.requestedVoiceId
      || context.pipelineAbort?.signal.aborted
    ) return;
    const firstSentence = extractFirstCompleteSpeechSentence(context.responseText);
    if (!firstSentence) return;
    const controller = new AbortController();
    context.pipelineAbort?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = getLockedTurnTtsRoute()
      .then(async route => {
        if (!route) return { error: new Error('No compatible TTS route is available') };
        const result = await synthesizeOnRoute(firstSentence, route, controller.signal);
        return { result, route };
      })
      .catch(error => ({ error }));
    speculativeSpeech = {
      text: firstSentence,
      requestedAt: Date.now(),
      controller,
      promise,
    };
  };

  const synthesizeWithLockedTurnRoute = async (
    text: string,
    signal: AbortSignal,
    preparedFailure?: { route?: LockedVoiceTurnTtsRoute; error: unknown; requestedAt?: number },
  ): Promise<{ result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute }> => {
    const ttsRequestedAt = preparedFailure?.requestedAt ?? Date.now();
    let route = preparedFailure?.route || await getLockedTurnTtsRoute();
    if (!route) throw preparedFailure?.error || new Error('No compatible TTS route is available');

    if (preparedFailure) {
      const fallback = await tryLockTurnTtsFallback(route, preparedFailure.error, signal);
      if (!fallback) throw preparedFailure.error;
      route = fallback;
    }

    try {
      return { result: { ...await synthesizeOnRoute(text, route, signal), ttsRequestedAt }, route };
    } catch (error) {
      const fallback = await tryLockTurnTtsFallback(route, error, signal);
      if (!fallback) throw error;
      return { result: { ...await synthesizeOnRoute(text, fallback, signal), ttsRequestedAt }, route: fallback };
    }
  };

  const flushSentence = (sentence: string): Promise<number> => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || turnTtsUnavailable || !context.session.isActive || context.session.suppressedSpeechRequestIds.has(context.requestId)) return Promise.resolve(0);
    if (!/[a-zA-Z\u4e00-\u9fff\u3400-\u4dbf\d]/.test(txt)) return Promise.resolve(0);
    const speech = ensureTurnSpeechController();
    if (!context.isCurrentTurn() || speech.controller.signal.aborted) return Promise.resolve(0);
    let resolvePlayback: (value: number) => void = () => {};
    const playbackDone = new Promise<number>(resolve => { resolvePlayback = resolve; });
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (!context.isCurrentTurn() || speech.controller.signal.aborted) {
        resolvePlayback(0);
        return;
      }
      if (context.session.bgGeneration !== speech.generation) {
        resolvePlayback(0);
        return;
      }
      if (turnTtsUnavailable) {
        resolvePlayback(0);
        return;
      }
      context.session.isSpeaking = true;
      voiceTransportState.ttsSpeakingCount++;
      try {
        const initialRoute = await getLockedTurnTtsRoute();
        if (!initialRoute) {
          turnTtsUnavailable = true;
          logger.warn('[Audio TTS] No configured healthy provider; delivering text and reporting the unavailable audio lane');
          emitVoiceTtsFailure(context.socket, context.requestId, 'conversation');
          resolvePlayback(0);
          return;
        }
        let synthesized: { result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute };
        if (speculativeSpeech?.text === txt) {
          const prepared = await speculativeSpeech.promise;
          if (prepared.result && prepared.route === initialRoute) {
            synthesized = { result: prepared.result, route: prepared.route };
          } else {
            synthesized = await synthesizeWithLockedTurnRoute(
              txt,
              speech.controller.signal,
              { route: prepared.route || initialRoute, error: prepared.error || new Error('Speculative TTS route changed'), requestedAt: speculativeSpeech.requestedAt },
            );
          }
          speculativeSpeech = null;
        } else {
          if (speculativeSpeech) {
            speculativeSpeech.controller.abort();
            speculativeSpeech = null;
          }
          synthesized = await synthesizeWithLockedTurnRoute(txt, speech.controller.signal);
        }
        if (context.isCurrentTurn() && !speech.controller.signal.aborted && context.session.bgGeneration === speech.generation) {
          // Only the audio segment actually accepted for playback owns these
          // timestamps. Discarded speculative speech is not a delivery metric.
          markVoiceLatencyMilestone(context.requestId, 'firstTtsRequestedAt', synthesized.result.ttsRequestedAt);
          markVoiceLatencyMilestone(context.requestId, 'firstTtsReadyAt', synthesized.result.ttsReadyAt);
          context.socket.emit("audio:status", { status: "speaking", requestId: context.requestId });
          addEchoText(txt, voiceEchoScope(context.session));
          const volumeGain = computeVolumeGain();
          context.socket.emit("audio:response", {
            buffer: synthesized.result.audioBuffer,
            format: synthesized.result.format,
            volumeGain,
            requestId: context.requestId,
            lane: 'conversation',
          });
          turnTtsEmittedSegments += 1;
          logger.info(
            `[Audio TTS] Emitted request=${context.requestId} provider=${synthesized.route.provider} voice=${synthesized.route.voiceId} bytes=${synthesized.result.audioBuffer.length}`,
          );
          const playbackMs = estimatePlaybackMs(synthesized.result.audioBuffer, txt);
          setTimeout(() => resolvePlayback(0), playbackMs);
        } else {
          resolvePlayback(0);
        }
      } catch (e: any) {
        if (isTtsCancellationError(e, speech.controller.signal)) {
          resolvePlayback(0);
          return;
        }
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
        turnTtsUnavailable = true;
        emitVoiceTtsFailure(context.socket, context.requestId, 'conversation');
        resolvePlayback(0);
      } finally {
        if (context.session.bgGeneration === speech.generation) context.session.isSpeaking = false;
        // Keep voiceTransportState.ttsSpeakingCount elevated for 3s after synthesis — client playback continues
        const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
        const t = setTimeout(decay, 3000);
        context.session.ttsDecayTimers.push(t);
      }
    });
    context.ttsPromises.push(ttsQueue);
    return playbackDone;
  };

  const queueFinalizedSpeech = (text: string) => {
    if (!context.isCurrentTurn()) return;
    if (context.session.isBackgroundWork) {
      context.session.activeWorkStatus = context.pendingConfirmationCreatedThisTurn
        ? 'waiting_confirmation'
        : 'completed';
    }
    if (context.session.suppressedSpeechRequestIds.has(context.requestId)) return;
    context.session.bgGeneration++;
    const sentences = String(text || '').split(/(?<=[。！？.!?\n])/u);
    const firstFinalSentence = String(sentences[0] || '').trim();
    if (speculativeSpeech && speculativeSpeech.text !== firstFinalSentence) {
      speculativeSpeech.controller.abort();
      speculativeSpeech = null;
    }
    for (const sentence of sentences) {
      if (context.pipelineAbort?.signal.aborted) break;
      flushSentence(sentence);
    }
  };
  return { terminal: false as const, context: extendTurnBindings(context, {
    queueFinalizedSpeech: queueFinalizedSpeech as typeof queueFinalizedSpeech,
    get speculativeSpeech(): typeof speculativeSpeech { return speculativeSpeech; },
    set speculativeSpeech(value: typeof speculativeSpeech) { speculativeSpeech = value; },
    get turnSpeechAbort(): typeof turnSpeechAbort { return turnSpeechAbort; },
    set turnSpeechAbort(value: typeof turnSpeechAbort) { turnSpeechAbort = value; },
    maybeStartSpeculativeSpeech: maybeStartSpeculativeSpeech as typeof maybeStartSpeculativeSpeech,
  }) };
}
