import { Socket } from "socket.io";
import { type AudioSession } from "./voice/session";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { classifyVoiceWorkInterruption } from "./voice_turn_state";
import { buildActiveVoiceWorkProgressReply } from "./voice/work_progress";
import { CN_VOICE_WORK_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { personalityRegistry } from "../personality";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { VOICE_CHAT_INPUT_BUDGET_TOKENS } from './voice_runtime_policy';
import { makeLLMCall } from "../llm/providers";
import { providerGetterArguments } from "../llm/provider_getters";
import { recordTokenUsage } from "../llm/token_tracker";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { getOrCreateActiveConversation, addMessage } from "../conversation/manager";
import { flushDBOrThrow } from "../../db_layer";
import { logger } from "../../logger";
import { voiceDurabilityUnknownText } from './voice_durability';
import { synthesizeSpeech, getActiveProvider as getTTSProvider, isTtsCancellationError } from "../tts/adapter";
import { emitVoiceTtsFailure, voiceTransportState, computeVolumeGain } from "./voice_transport_runtime";
import { resolveSingleVoiceTtsRoute } from "./voice/selection";
import { addEchoText, voiceEchoScope } from "./voice/echo";

export async function respondAlongsideActiveVoiceWork(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  kind: ReturnType<typeof classifyVoiceWorkInterruption>,
  deterministicResponse?: { text: string; cognitiveIntent: string },
): Promise<void> {
  const workRequestId = session.activeTurnRequestId;
  if (!workRequestId) return;
  const userReceivedAt = new Date().toISOString();
  session.sidecarAbortController?.abort();
  const controller = new AbortController();
  const generation = ++session.sidecarGeneration;
  session.sidecarAbortController = controller;
  let ttsCountIncremented = false;

  let responseText = '';
  let llmWasCalled = false;
  try {
    if (deterministicResponse) {
      responseText = deterministicResponse.text;
    } else if (kind === 'progress_query') {
      responseText = buildActiveVoiceWorkProgressReply(session, userText);
    } else if (kind === 'new_work') {
      const isEnglish = /[a-z]/i.test(userText) && !/[\u3400-\u9fff]/u.test(userText);
      responseText = isEnglish
        ? 'Got it. I queued that action and will run it automatically as soon as the current task finishes.'
        : CN_VOICE_WORK_MESSAGES.queuedWork;
    } else {
      const recentSideChat = session.sidecarHistory.slice(-4)
        .flatMap(item => [
          { role: 'user' as const, content: item.userText },
          { role: 'assistant' as const, content: item.responseText },
        ]);
      const activeTask = session.activeRoutingText.replace(/\s+/g, ' ').trim().slice(0, 160);
      const activeStep = session.activeWorkStep.replace(/\s+/g, ' ').trim().slice(0, 100);
      const personalityPrompt = personalityRegistry.buildSystemPrompt(
        session.personalityId || 'lumi',
        { mode: 'chat', uiContext: 'voice' },
        {
          userId: session.userId,
          userText,
          domain: session.domain,
          orgId: session.orgId,
        },
      ).systemPrompt;
      const sidecarPrompt = [
        personalityPrompt,
        'You are Lumi speaking naturally during a live voice call.',
        `A separate work lane is still running: ${activeTask || 'the user task'}.`,
        activeStep ? `Current verified progress: ${activeStep}.` : '',
        'Answer the user\'s conversational aside now without stopping, replacing, or expanding that work lane.',
        'This conversational lane cannot execute or schedule actions. Never say that a newly requested action is running, queued, or awaiting confirmation unless the runtime explicitly says so.',
        'Use one short spoken sentence in the user\'s language. Do not call tools, claim completion, expose hidden reasoning, or ask the user to wait.',
      ].filter(Boolean).join('\n');
      const preferred = {
        ...getUserPreferredLLMConfig(session.userId, {
          maxTokens: 120,
          domain: session.domain,
          orgId: session.orgId,
        }),
        inputTokenBudget: VOICE_CHAT_INPUT_BUDGET_TOKENS,
        signal: controller.signal,
      };
      session.authorization?.assertCurrent();
      const response = await makeLLMCall(
        [
          { role: 'system', content: sidecarPrompt },
          ...recentSideChat,
          { role: 'user', content: userText },
        ],
        [],
        preferred,
        ...providerGetterArguments(llmGetters),
      );
      llmWasCalled = true;
      if (
        controller.signal.aborted
        || session.sidecarGeneration !== generation
        || session.activeTurnRequestId !== workRequestId
      ) return;
      recordTokenUsage(session.userId, preferred.provider, preferred.model, response.usage, `voice_sidecar_${Date.now()}`, 'voice');
      const finalized = finalizeLumiResponse({
        taskText: userText,
        responseText: response.text?.trim() || '',
        toolRecords: [],
        source: 'voice_sidecar',
      });
      responseText = finalized.blocked
        ? buildActiveVoiceWorkProgressReply(session, userText)
        : finalized.text.trim();
    }

    if (
      session.authorization?.isCurrent() === false
      || !responseText
      || controller.signal.aborted
      || session.sidecarGeneration !== generation
      || session.activeTurnRequestId !== workRequestId
    ) return;
    const responseAt = new Date().toISOString();
    session.sidecarHistory.push({
      userText,
      responseText,
      userReceivedAt,
      responseAt,
      cognitiveIntent: deterministicResponse?.cognitiveIntent
        || (kind === 'new_work' ? 'queued_work' : kind),
      llmWasCalled,
      // A queued command is persisted by its own execution turn so it is not
      // duplicated as an ordinary conversational aside.
      // Progress and conversational asides are written immediately below.
      // A queued action is persisted by its own execution turn.
      persist: false,
    });
    session.sidecarHistory = session.sidecarHistory.slice(-8);

    if (kind !== 'new_work') {
      try {
        const conversation = session.activeTaskConversationId
          ? { id: session.activeTaskConversationId }
          : getOrCreateActiveConversation(
              session.userId,
              session.agentId,
              session.domain,
              session.orgId,
            );
        addMessage({
          userId: session.userId,
          agentId: session.agentId,
          conversationId: conversation.id,
          role: 'user',
          content: userText,
          personality: session.personalityId,
          mode: 'voice',
          source: 'voice_sidecar',
          channel: 'voice',
          cognitiveIntent: deterministicResponse?.cognitiveIntent || kind,
          llmWasCalled: false,
          receivedAt: userReceivedAt,
          timestamp: userReceivedAt,
          domain: session.domain,
          orgId: session.orgId,
          skipActionContinuation: true,
        });
        addMessage({
          userId: session.userId,
          agentId: session.agentId,
          conversationId: conversation.id,
          role: 'assistant',
          content: responseText,
          personality: session.personalityId,
          mode: 'voice',
          source: 'voice_sidecar',
          channel: 'voice',
          cognitiveIntent: deterministicResponse?.cognitiveIntent || kind,
          llmWasCalled,
          receivedAt: responseAt,
          timestamp: responseAt,
          domain: session.domain,
          orgId: session.orgId,
          skipActionContinuation: true,
        });
        await flushDBOrThrow();
        socket.emit('chat:conversation_updated', {
          conversationId: conversation.id,
          agentId: session.agentId,
          source: 'voice_sidecar',
        });
      } catch (persistError: any) {
        logger.warn(`[Audio] Failed to persist active-work sidecar: ${persistError?.message || String(persistError)}`);
        socket.emit('audio:sidecar_response', {
          text: voiceDurabilityUnknownText(),
          source: 'voice',
          channel: 'voice',
          requestId: workRequestId,
          workRequestId,
          blocked: true,
          reason: 'persistence_unknown',
        });
        return;
      }
    }
    socket.emit('audio:sidecar_response', {
      text: responseText,
      source: 'voice',
      channel: 'voice',
      requestId: workRequestId,
      workRequestId,
    });

    const ttsProvider = getTTSProvider();
    if (!ttsProvider || !session.currentVoiceId || !session.isActive) {
      if (session.isActive) emitVoiceTtsFailure(socket, workRequestId, 'conversation');
      return;
    }
    const ttsRoute = await resolveSingleVoiceTtsRoute(session, ttsProvider, session.currentVoiceId);
    if (!ttsRoute) {
      emitVoiceTtsFailure(socket, workRequestId, 'conversation');
      return;
    }
    const speechGeneration = ++session.bgGeneration;
    session.ttsAbortController?.abort();
    session.ttsAbortController = controller;
    session.isSpeaking = true;
    voiceTransportState.ttsSpeakingCount++;
    ttsCountIncremented = true;
    const ttsResult = await synthesizeSpeech(responseText, {
      provider: ttsRoute.provider,
      voiceId: ttsRoute.voiceId,
      model: ttsRoute.model,
      speechRate: ttsRoute.speechRate,
      pitch: ttsRoute.pitch,
      volume: ttsRoute.volume,
      signal: controller.signal,
      allowFallback: false,
    });
    if (
      controller.signal.aborted
      || session.sidecarGeneration !== generation
      || session.bgGeneration !== speechGeneration
      || !session.isActive
      || session.activeTurnRequestId !== workRequestId
    ) return;
    socket.emit('audio:status', { status: 'speaking', lane: 'conversation', requestId: workRequestId });
    addEchoText(responseText, voiceEchoScope(session));
    socket.emit('audio:response', {
      buffer: ttsResult.audioBuffer,
      format: ttsResult.format,
      volumeGain: computeVolumeGain(),
      lane: 'conversation',
      requestId: workRequestId,
    });
  } catch (err: any) {
    if (!isTtsCancellationError(err, controller.signal)) {
      logger.warn(`[Audio Sidecar] ${err?.message || String(err)}`);
      emitVoiceTtsFailure(socket, workRequestId, 'conversation');
    }
  } finally {
    if (session.sidecarAbortController === controller) session.sidecarAbortController = null;
    if (session.ttsAbortController === controller) session.ttsAbortController = null;
    if (session.sidecarGeneration === generation) session.isSpeaking = false;
    if (ttsCountIncremented) {
      const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
      const timer = setTimeout(decay, 3000);
      session.ttsDecayTimers.push(timer);
    }
  }
}
