import { CN_VOICE_CONNECTION_COPY } from '../../../regions/messages/voice_connection_copy';
import { type AudioSession, getVoiceStateKey, normalizeVoiceSessionId, getAudioSession } from "../session";
import { logger } from "../../../../logger";
import { resolveSingleVoiceTtsRoute, normalizeVoiceSwitchId } from "../selection";
import { resolveAuthorizedSocketScope } from "../../scope";
import { captureChatAuthorization } from "../../chat_authorization";
import { personalityRegistry } from "../../../personality";
import { synthesizeSpeech, getActiveProvider as getTTSProvider } from "../../../tts/adapter";
import { addEchoText, voiceEchoScope } from "../echo";
import { loadEmotionalState } from "../../../personality/state";
import { getGateConfig } from "../../../autonomy/safety_gate";
import { getIdleState } from "../../../context/activity_stream";
import { claimReminderVoiceDelivery } from "../../proactive_reminder_delivery";
import { finalizeLumiResponse } from "../../../cognition/result_finalizer";
import { queryMemories, addMemory } from "../../../memory/store";
import { getUserPreferredLLMConfig } from "../../../llm/user_preferences";
import { VOICE_CHAT_INPUT_BUDGET_TOKENS } from "../../voice_runtime_policy";
import { makeLLMCall } from "../../../llm/providers";
import { providerGetterArguments } from "../../../llm/provider_getters";
import { recordTokenUsage } from "../../../llm/token_tracker";
import { voiceTransportState, getAmbientNoise, computeVolumeGain } from "../../voice_transport_runtime";
import type { VoiceConnectionRuntime, ProactiveContext } from './connection';

export function registerVoiceProactiveOutput(runtime: VoiceConnectionRuntime) {

  runtime.socket.on('proactive:configure', (data: Partial<ProactiveContext>) => {
    runtime.cancelProactive();
    runtime.proactiveContext = null;
    const userId = runtime.getUserId(runtime.socket);
    const scope = resolveAuthorizedSocketScope(runtime.socket, userId);
    const contextId = normalizeVoiceSessionId(data?.contextId);
    if (!scope || !contextId || data?.userId !== userId || data.domain !== scope.domain || String(data.orgId || '') !== scope.orgId) return;
    runtime.proactiveContext = { contextId, userId, ...scope, voiceId: normalizeVoiceSwitchId(data.voiceId) || null, enabled: data.enabled === true };
  });
  function beginProactive() {
    const context = runtime.proactiveContext;
    if (!context?.enabled || runtime.proactiveController || runtime.callAdmission.hasCall() || !runtime.socket.connected) return null;
    const scope = resolveAuthorizedSocketScope(runtime.socket, runtime.getUserId(runtime.socket));
    if (!scope || runtime.getUserId(runtime.socket) !== context.userId || scope.domain !== context.domain || scope.orgId !== context.orgId) return null;
    const authorization = captureChatAuthorization(context.userId, scope);
    if (!authorization.isCurrent() || shouldStayQuiet(context.userId).quiet) return null;
    // A notification must not need an earlier microphone call to initialize
    // identity, emotional state, model preferences or the selected speaker.
    const session: AudioSession = { ...getAudioSession(runtime.socket), userId: context.userId, ...scope, personalityId: 'lumi', currentVoiceId: context.voiceId };
    const controller = new AbortController();
    runtime.proactiveController = controller;
    const stopWatch = authorization.watch(controller);
    const assertCurrent = () => {
      authorization.assertCurrent();
      if (controller.signal.aborted || runtime.proactiveContext !== context || !runtime.socket.connected || runtime.getUserId(runtime.socket) !== context.userId || runtime.callAdmission.hasCall() || shouldStayQuiet(context.userId).quiet) {
        throw new DOMException('Proactive voice is no longer allowed', 'AbortError');
      }
    };
    return {
      session, authorization, controller, assertCurrent,
      envelope: { contextId: context.contextId, userId: context.userId, domain: context.domain, orgId: context.orgId },
      release: () => { stopWatch(); if (runtime.proactiveController === controller) runtime.proactiveController = null; },
    };
  }
  runtime.socket.on('disconnect', () => { runtime.proactiveContext = null; runtime.cancelProactive(); });
  runtime.socket.on("ambient:noise_level", (data: { rms: number; isSpeaking: boolean; callState: string }) => {
    voiceTransportState.ambientRms = data.rms;
    voiceTransportState.ambientRmsLastUpdate = Date.now();
  });

  /**
   * Night / Focus quiet mode: determine whether Lumi should suppress proactive speech.
   */
  function shouldStayQuiet(userId: string): { quiet: boolean; reason: string } {
    const hour = new Date().getHours();
    const nightHours = hour >= 23 || hour < 7;
    const gate = getGateConfig(userId);
    const withinQuietHours = gate.quietHoursStart === gate.quietHoursEnd
      || (gate.quietHoursStart < gate.quietHoursEnd
        ? hour >= gate.quietHoursStart && hour < gate.quietHoursEnd
        : hour >= gate.quietHoursStart || hour < gate.quietHoursEnd);
    if (gate.quietHoursEnabled && withinQuietHours) return { quiet: true, reason: 'user_quiet_hours' };

    if (nightHours) {
      return { quiet: true, reason: 'night_hours' };
    }

    try {
      const idleState = getIdleState(userId);
      if (idleState.isIdle && idleState.idleSince) {
        const idleMs = Date.now() - new Date(idleState.idleSince).getTime();
        const idleHours = idleMs / (1000 * 60 * 60);
        if (idleHours > 2) {
          return { quiet: true, reason: 'user_flow_state' };
        }
      }
    } catch {}

    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.15) {
      return { quiet: true, reason: 'meeting_detected' };
    }

    return { quiet: false, reason: '' };
  }

  const reportProactiveFailure = (operation: NonNullable<ReturnType<typeof beginProactive>>) => {
    try { operation.assertCurrent(); } catch { return; }
    runtime.socket.emit('audio:proactive_error', { ...operation.envelope, code: 'VOICE_OUTPUT_UNAVAILABLE' });
  };

  runtime.socket.on("proactive:request_speak", async (data: { message: string; interactionId?: string }) => {
    if (typeof data?.message !== 'string' || !data.message.trim() || data.message.length > 4000) return;
    const operation = beginProactive();
    if (!operation) return;
    const reminder = data.interactionId === undefined ? null : claimReminderVoiceDelivery(data.interactionId, {
      userId: operation.session.userId, domain: operation.session.domain, orgId: operation.session.orgId || '',
    });
    try {
    // Supplying an invalid receipt must never fall back to trusted reminder behavior.
    if (data.interactionId !== undefined && !reminder) return;
    const { session, authorization } = operation;
    const userId = session.userId;

    session.isSpeaking = true;
    const resetSpeaking = () => { session.isSpeaking = false; };
    const finalizedProactive = reminder ? { blocked: false, text: reminder.text, reason: '' } : finalizeLumiResponse({
      taskText: 'Proactive spoken notification',
      responseText: data.message,
      toolRecords: [],
      source: 'proactive_voice',
    });
    if (finalizedProactive.blocked) {
      resetSpeaking();
      logger.warn(`[ProactiveVoice] Suppressed unverified execution claim: ${finalizedProactive.reason}`);
      return;
    }
    const proactiveText = finalizedProactive.text;

    // Gate: night/focus/meeting quiet mode
    const quietCheck = shouldStayQuiet(userId);
    if (quietCheck.quiet) {
      resetSpeaking();
      logger.info(`[ProactiveVoice] Suppressed for ${userId}: ${quietCheck.reason}`);
      return;
    }

    // Resolve voiceId: session first, then personality config, then give up
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.getForUser(
        session.personalityId || 'lumi',
        userId,
        session.domain === 'work' ? session.orgId : undefined,
      );
      voiceId = personalityCfg?.ttsVoiceId || null;
    }

    // Gate: check initiative level — Lumi only speaks first when comfortable enough
    const es = loadEmotionalState(getVoiceStateKey(session));
    if (!reminder && es.initiative < 0.4) { resetSpeaking(); return; }

    // Gate: don't interrupt when environment is noisy (user likely in a meeting)
    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.08) { resetSpeaking(); return; }

    const ttsProvider = getTTSProvider();
    if (!ttsProvider) { resetSpeaking(); reportProactiveFailure(operation); return; }
    const proactiveRoute = await resolveSingleVoiceTtsRoute(session, ttsProvider, voiceId);
    if (!proactiveRoute) { resetSpeaking(); reportProactiveFailure(operation); return; }

    let proactiveTtsCounted = false;
    const controller = operation.controller;
    const stopWatch = authorization.watch(controller);
    try {
      operation.assertCurrent();
      reminder?.assertCurrent();
      if (reminder) await reminder.confirmPersisted();
      operation.assertCurrent();
      voiceTransportState.ttsSpeakingCount++;
      proactiveTtsCounted = true;
      addEchoText(proactiveText, voiceEchoScope(session));
      const result = await synthesizeSpeech(proactiveText, {
        provider: proactiveRoute.provider,
        voiceId: proactiveRoute.voiceId,
        model: proactiveRoute.model,
        speechRate: proactiveRoute.speechRate,
        pitch: proactiveRoute.pitch,
        volume: proactiveRoute.volume,
        signal: controller.signal,
        allowFallback: false,
      });
      operation.assertCurrent();
      const proactiveGain = computeVolumeGain();
      const emitSpeech = () => runtime.socket.emit("audio:proactive_speak", {
        ...operation.envelope,
        ...(reminder ? { interactionId: reminder.interactionId } : {}),
        audioBuffer: result.audioBuffer,
        text: proactiveText,
        timestamp: new Date().toISOString(),
        volumeGain: proactiveGain,
      });
      if (reminder) await reminder.dispatch(operation.assertCurrent, emitSpeech);
      else emitSpeech();
      logger.info(`[ProactiveVoice] Audio dispatched for user ${userId}`);
    } catch (err: any) {
      logger.warn(`[ProactiveVoice] TTS failed: ${err.message}`);
      if (err?.name !== 'AbortError') reportProactiveFailure(operation);
    } finally {
      stopWatch();
      if (proactiveTtsCounted) voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1);
      resetSpeaking();
    }
    } finally { reminder?.release(); operation.release(); }
  });

  // LLM-generated greeting — replaces hardcoded templates with personalized, scene-aware greetings
  runtime.socket.on("greeting:generate", async (data: { scene?: string }) => {
    const operation = beginProactive();
    if (!operation) return;
    try {
    const { session, authorization } = operation;
    const userId = session.userId;
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.getForUser(
        session.personalityId || 'lumi',
        userId,
        session.domain === 'work' ? session.orgId : undefined,
      );
      voiceId = personalityCfg?.ttsVoiceId || null;
    }

    const es = loadEmotionalState(getVoiceStateKey(session));
    // This greeting is explicitly enabled by the user. Personality shapes its
    // tone; the default initiative must not silently disable that preference.

    // Build temporal context for scene-aware generation
    let temporalBlock = '';
    try {
      const { generateTemporalContext } = await import("../../../time/temporal_context");
      temporalBlock = generateTemporalContext(userId);
    } catch {}

    // Fetch a few recent memories for personalization
    let memoryContext = '';
    try {
      const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.5, domain: session.domain, orgId: session.orgId });
      if (recentMemories.length > 0) {
        memoryContext = recentMemories.map(m => `- ${m.content.slice(0, 150)}`).join('\n');
      }
    } catch {}

    // Fetch recent greetings to avoid repetition (greeting dedup)
    let dedupContext = '';
    try {
      const recentGreetings = queryMemories({
        userId,
        query: 'greeting',
        limit: 8,
        minConfidence: 0.5,
        domain: session.domain,
        orgId: session.orgId,
      });
      const greetingTexts = recentGreetings
        .filter(m => m.content.includes('[Greeting]') || m.keywords.includes('greeting'))
        .map(m => m.content.replace(/^\[Greeting\]\s*/, '').slice(0, 80));
      if (greetingTexts.length > 0) {
        dedupContext = `\nRecently used greetings (DO NOT repeat these — be completely fresh):\n${greetingTexts.map(g => `- "${g}"`).join('\n')}`;
      }
    } catch {}

    const scene = data.scene || 'return';
    const intimacy = es.intimacy || 0.3;
    const tone = intimacy > 0.6 ? 'warm and intimate' : intimacy > 0.3 ? 'friendly and natural' : 'polite and gentle';

    const greetingPrompt = [
      `Generate a brief, natural spoken greeting in Chinese (under 60 characters).`,
      `Scene: user just ${scene === 'return' ? 'returned to their computer after being away' : scene === 'morning' ? 'started their day' : scene === 'evening' ? 'is winding down' : ' needs a check-in'}.`,
      `Tone: ${tone}.`,
      temporalBlock ? `\nCurrent context:\n${temporalBlock}` : '',
      memoryContext ? `\nRecent topics:\n${memoryContext}\nReference one naturally if relevant.` : '',
      dedupContext,
      `\nDo NOT sound like a report or template. Sound like a friend who noticed they're back. Vary your phrasing — never repeat the same greeting.`,
    ].filter(Boolean).join('\n');

    const greetingTtsProvider = getTTSProvider();
    const greetingTtsRoute = greetingTtsProvider
      ? await resolveSingleVoiceTtsRoute(session, greetingTtsProvider, voiceId, false)
      : null;
    if (!greetingTtsRoute) { reportProactiveFailure(operation); return; }

    const controller = operation.controller;
    const stopWatch = authorization.watch(controller);
    let greetingSpeechAttempted = false;
    let greetingAudioDispatched = false;
    try {
      operation.assertCurrent();
      const greetingLLM = {
        ...getUserPreferredLLMConfig(session.userId, {
          maxTokens: 120,
          domain: session.domain,
          orgId: session.orgId,
        }),
        inputTokenBudget: VOICE_CHAT_INPUT_BUDGET_TOKENS,
        signal: controller.signal,
      };
      const response = await makeLLMCall(
        [{ role: 'user', content: greetingPrompt }],
        [],
        greetingLLM,
        ...providerGetterArguments(runtime.llmGetters),
      );

      operation.assertCurrent();
      recordTokenUsage(session.userId, greetingLLM.provider, greetingLLM.model, response.usage, `voice_greet_${Date.now()}`, 'voice');

      const greeting = response.text?.trim() || '';
      if (!greeting) throw new Error('Empty LLM response');
      const finalizedGreeting = finalizeLumiResponse({
        taskText: 'Generate a friendly spoken greeting',
        responseText: greeting,
        toolRecords: [],
        source: 'voice_greeting',
      });
      if (finalizedGreeting.blocked) {
        throw new Error(`Unverified greeting execution claim: ${finalizedGreeting.reason}`);
      }
      const spokenGreeting = finalizedGreeting.text;

      greetingSpeechAttempted = true;
      const result = await synthesizeSpeech(spokenGreeting, {
        provider: greetingTtsRoute.provider,
        voiceId: greetingTtsRoute.voiceId,
        model: greetingTtsRoute.model,
        signal: controller.signal,
        allowFallback: false,
      });
      operation.assertCurrent();
      runtime.socket.emit("audio:proactive_speak", {
        ...operation.envelope,
        audioBuffer: result.audioBuffer,
        text: spokenGreeting,
        timestamp: new Date().toISOString(),
        volumeGain: computeVolumeGain(),
      });
      greetingAudioDispatched = true;
      // Store greeting in memory for dedup
      addMemory({
        userId,
        type: 'fact',
        content: `[Greeting] ${spokenGreeting}`,
        keywords: ['greeting', scene, new Date().toISOString().slice(0, 10)],
        confidence: 1.0,
        sourceInteractionId: `greeting_${Date.now()}`,
        agentId: undefined,
      } as any, { tier: 'episodic', perspective: 'shared_memory', importance: 0.2, domain: session.domain, orgId: session.orgId, source: 'voice' });
      logger.info(`[Greeting] LLM-generated for ${userId} (${spokenGreeting.length} chars)`);
    } catch (err: any) {
      if (!authorization.isCurrent() || controller.signal.aborted) return;
      try { operation.assertCurrent(); } catch { return; }
      if (greetingSpeechAttempted) {
        // A failed TTS request must not cause a second request to the same
        // unavailable voice service. A memory save after dispatch must never
        // cause the already-delivered greeting to be spoken a second time.
        logger.warn(`[Greeting] ${greetingAudioDispatched ? 'Memory save after audio dispatch' : 'Speech synthesis'} failed: ${err.message}`);
        if (!greetingAudioDispatched) reportProactiveFailure(operation);
        return;
      }
      logger.warn(`[Greeting] LLM generation failed, using fallback: ${err.message}`);
      const hour = new Date().getHours();
      const fallback = hour < 6 ? CN_VOICE_CONNECTION_COPY.lateNight : hour < 12 ? CN_VOICE_CONNECTION_COPY.morning : hour < 18 ? CN_VOICE_CONNECTION_COPY.afternoon : CN_VOICE_CONNECTION_COPY.evening;
      try {
        const result = await synthesizeSpeech(fallback, {
          provider: greetingTtsRoute.provider,
          voiceId: greetingTtsRoute.voiceId,
          model: greetingTtsRoute.model,
          signal: controller.signal,
        allowFallback: false,
        });
        operation.assertCurrent();
        runtime.socket.emit("audio:proactive_speak", { ...operation.envelope, audioBuffer: result.audioBuffer, text: fallback, timestamp: new Date().toISOString(), volumeGain: computeVolumeGain() });
      } catch (error: any) {
        logger.warn(`[Greeting] Fallback speech failed: ${error.message}`);
        if (error?.name !== 'AbortError') reportProactiveFailure(operation);
      }
    } finally { stopWatch(); }
    } finally { operation.release(); }
  });
}
