import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Socket } from 'socket.io';
import { flushDBOrThrow } from '../../db_layer';
import { getMemoryAvatar } from '../memory_avatar/store';
import { captureMemoryAvatarAuthorization } from '../memory_avatar/lifecycle';
import { buildMemoryAvatarVoiceMessages } from '../memory_avatar/conversation';
import { addMessageIdempotent, getOrCreateActiveConversation, updateAssistantMessageTerminalPresentation } from '../conversation/manager';
import { commitChatTerminalBoundary } from './chat_terminal_boundary';
import { createResilientStreamingSession, getActiveStreamingSTTProvider } from '../stt/adapter';
import { getActiveProvider, listVoices, synthesizeSpeech } from '../tts/adapter';
import { isVoiceProfileAccessible, voiceProfileScope, listScopedVoiceProfiles } from '../tts/profile_store';
import { personalityRegistry } from '../personality';
import { getConfiguredVoiceModel } from '../config/voice_preference';
import { isStrictPrivacy } from '../config/privacy';
import { makeLLMCall } from '../llm/providers';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { getUserPreferredVisionConfig } from '../llm/vision_preferences';
import type { LLMGetters } from '../llm/dispatch';
import { setRealtimeVoiceSessionActive } from '../autonomy/foreground_activity';
import type { VoiceCallAdmission } from './voice_call_admission';
import { isMemoryAvatarPortraitReady, speakMemoryAvatarPortrait, stopMemoryAvatarPortrait } from '../memory_avatar/portrait_sessions';

const CANCELLED = 'This voice reply was cancelled.';
const UNKNOWN = 'The reply could not be saved. Please try again.';
const MAX_PCM_CHUNK = 64 * 1024;
const FRAME_TTL_MS = 6000;
interface CameraFrame { data: string; receivedAt: number; sequence: number; generation: number }

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Voice call cancelled.', 'AbortError'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

interface PrivateCall {
  avatarId: string; userId: string; sessionId: string; active: boolean;
  portrait: boolean;
  authorization: ReturnType<typeof captureMemoryAvatarAuthorization>;
  controller: AbortController; unwatch: () => void;
  stt: ReturnType<typeof createResilientStreamingSession> | null;
  admission?: Awaited<ReturnType<VoiceCallAdmission['claim']>>;
  handover?: Promise<Awaited<ReturnType<VoiceCallAdmission['claim']>>>;
  turn?: { requestId: string; controller: AbortController; pending: Promise<void> };
  frame?: CameraFrame;
  videoGeneration: number;
  frameSequence: number; lastFrameAt: number; inputTail: Promise<void>; inputGeneration: number;
  lastTranscript: string; lastTranscriptAt: number;
  lastReply: string; playbackUntil: number;
}

/** The main voice gate stays closed: this lane has no task, tool or learning adapter. */
export function registerMemoryAvatarVoiceHandlers(socket: Socket, getters: LLMGetters, getUserId: (socket: Socket) => string, admission: VoiceCallAdmission) {
  let current: PrivateCall | undefined;
  const matches = (call: PrivateCall, data: any) => data?.sessionId === call.sessionId && data?.avatarId === call.avatarId;
  const personalSocket = () => !String(socket.data?.authenticatedOrgId || '').trim();
  const authorized = (call: PrivateCall) => personalSocket() && call.authorization.isCurrent() && getUserId(socket) === call.userId;
  const live = (call: PrivateCall) => {
    if (current !== call || !call.active || !socket.connected) return false;
    if (!authorized(call)) {
      void stop(call, { code: 'AVATAR_UNAVAILABLE', message: 'The private call no longer has an active personal session.' });
      return false;
    }
    return true;
  };
  const emit = (call: PrivateCall, event: string, data: object) => {
    if (socket.connected) socket.emit(`avatar:${event}`, { ...data, avatarId: call.avatarId, agentId: call.avatarId, sessionId: call.sessionId });
  };
  const stop = async (call: PrivateCall, error?: { code: string; message: string }) => {
    call.active = false;
    const portraitCleanup = call.portrait ? stopMemoryAvatarPortrait({ userId: call.userId, avatarId: call.avatarId, callSessionId: call.sessionId }).catch(() => {}) : Promise.resolve();
    call.frame = undefined;
    call.controller.abort();
    call.turn?.controller.abort();
    try { call.stt?.end(); } catch {}
    call.stt = null;
    call.unwatch();
    // A replacement owns its own unique priority key, never the old socket slot.
    setRealtimeVoiceSessionActive(call.userId, `avatar:${socket.id}:${call.sessionId}`, false);
    if (error) emit(call, 'audio:error', error);
    // SDK STT failures can initiate cleanup outside a socket event. Keep the
    // admission/drain link until that call's final save really converges.
    await call.handover?.catch(() => undefined);
    await call.inputTail;
    await portraitCleanup;
    call.admission?.release();
    if (current === call) {
      current = undefined;
      emit(call, 'audio:status', { status: 'idle' });
    }
  };

  async function runTurn(call: PrivateCall, text: string, frame?: CameraFrame) {
    const requestId = `avatar_voice_${randomUUID()}`;
    const controller = new AbortController();
    const release = call.authorization.watch(controller);
    const cancel = () => controller.abort();
    call.controller.signal.addEventListener('abort', cancel, { once: true });
    const turn = { requestId, controller, pending: Promise.resolve() };
    call.turn = turn;
    const isCurrent = () => live(call) && call.turn === turn && !controller.signal.aborted;
    const assertCurrent = () => { if (!isCurrent()) throw new DOMException('Voice call cancelled.', 'AbortError'); };
    const timer = setTimeout(() => {
      if (live(call) && call.turn === turn) void stop(call, { code: 'VOICE_REPLY_TIMEOUT', message: 'The voice reply timed out. Start a new call.' });
      else controller.abort();
    }, 90_000);
    timer.unref?.();
    turn.pending = (async () => {
      const conversation = getOrCreateActiveConversation(call.userId, call.avatarId, 'personal', '');
      const common = { userId: call.userId, agentId: call.avatarId, conversationId: conversation.id, requestId, externalMessageId: requestId,
        domain: 'personal', orgId: '', source: 'memory_avatar_voice', channel: 'voice', skipActionContinuation: true, taskIntent: 'conversation' as const };
      let accepted = false;
      let terminalCommitted = false;
      let modelCalled = false;
      let usedVision = false;
      const persistTerminal = async (proposed: string, failed = false) => {
        let cancelled = !isCurrent();
        let output = cancelled ? CANCELLED : proposed;
        const feedback = () => ({ status: cancelled ? 'cancelled' : failed ? 'blocked' : 'completed', incomplete: cancelled || failed ? [output] : [], nextSteps: [] });
        const payload = () => ({ text: output, agentName: getMemoryAvatar(call.userId, call.avatarId)?.name || 'Memory', requestId,
          conversationId: conversation.id, channel: 'voice', source: 'memory_avatar_voice', finalized: true,
          blocked: cancelled || failed, reason: cancelled ? 'cancelled' : failed ? 'response_unavailable' : undefined });
        const committed = await commitChatTerminalBoundary({
          persistTerminalState: () => undefined,
          persistAssistantMessage: () => { addMessageIdempotent({ ...common, role: 'assistant', content: output, llmWasCalled: modelCalled, completionFeedback: feedback() }); },
          flush: flushDBOrThrow,
          persistTerminalReceipt: async () => {
            // Archive/account switch during the flush must never publish or retain a stale success.
            if (!isCurrent() && !cancelled) {
              cancelled = true; output = CANCELLED;
              updateAssistantMessageTerminalPresentation({ ...common, content: output, completionFeedback: feedback() });
              await flushDBOrThrow();
            }
            return true;
          },
          persistUnknownReceipt: async () => true,
          publishCommitted: () => {
            terminalCommitted = true;
            if (isCurrent()) emit(call, 'agent:response', payload());
          },
          publishUnknown: () => { if (live(call)) void stop(call, { code: 'PERSISTENCE_UNKNOWN', message: UNKNOWN }); },
          persistenceUnknownProjection: { text: UNKNOWN, reason: 'Private voice terminal persistence failed.' },
        });
        return committed && !cancelled && !failed;
      };
      try {
        assertCurrent();
        addMessageIdempotent({ ...common, role: 'user', content: text, deferActionPreparation: true });
        accepted = true;
        await flushDBOrThrow();
        assertCurrent();
        emit(call, 'audio:status', { status: 'thinking', requestId, lane: 'conversation' });
        emit(call, 'audio:transcript', { text, isFinal: true, requestId });
        const messages = await abortable(buildMemoryAvatarVoiceMessages({ ...common, avatarId: call.avatarId, text, signal: controller.signal, assertCurrent }), controller.signal);
        assertCurrent();
        // Capture belongs to this utterance, but consent/freshness are checked at
        // the actual upload boundary after every storage/retrieval wait.
        const frameAge = frame ? Date.now() - frame.receivedAt : Number.POSITIVE_INFINITY;
        const currentFrame = frame && frame.generation === call.videoGeneration && call.frame
          && frameAge >= 0 && frameAge <= FRAME_TTL_MS ? frame.data : undefined;
        if (currentFrame) messages[messages.length - 1].content = [{ type: 'text', text }, { type: 'image_url', image_url: { url: currentFrame, detail: 'low' } }];
        usedVision = Boolean(currentFrame);
        const config = currentFrame
          ? { ...getUserPreferredVisionConfig(call.userId, { maxTokens: 900 }), role: 'vision' as const, noImplicitFailover: true }
          : getUserPreferredLLMConfig(call.userId, { maxTokens: 900, domain: 'personal', conversationId: conversation.id, requestId, source: 'memory_avatar_voice' });
        modelCalled = true;
        const response = await abortable(makeLLMCall(messages, [], { ...config, signal: controller.signal },
          getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama,
          getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay), controller.signal);
        assertCurrent();
        const reply = String(response.text || '').trim().slice(0, 8000);
        if (!reply) throw new Error('Empty avatar response');
        const speak = await persistTerminal(reply);
        if (!speak || !isCurrent()) return;
        call.lastReply = reply;
        const provider = getActiveProvider();
        const avatar = getMemoryAvatar(call.userId, call.avatarId);
        const selected = avatar?.voice?.voiceId || personalityRegistry.getForUser('lumi', call.userId)?.ttsVoiceId || '';
        const scope = voiceProfileScope(call.userId, 'personal', '');
        if (!provider || (selected && !isVoiceProfileAccessible(scope, selected))) {
          emit(call, 'audio:tts_error', { requestId, lane: 'conversation', code: 'TTS_OUTPUT_UNAVAILABLE' });
          return;
        }
        try {
          const voices = await abortable(listVoices(provider), controller.signal);
          assertCurrent();
          const scoped = listScopedVoiceProfiles(scope).filter(profile => profile.provider === provider && profile.status !== 'failed' && profile.status !== 'training');
          const voiceId = selected || scoped[0]?.voiceId || voices[0]?.voiceId;
          if (!voiceId || (selected && !scoped.some(profile => profile.voiceId === selected) && !voices.some(voice => voice.voiceId === selected))) throw new Error('Voice profile unavailable');
          const audio = await abortable(synthesizeSpeech(reply, { provider, voiceId, model: getConfiguredVoiceModel('tts'), signal: controller.signal, allowFallback: false }), controller.signal);
          assertCurrent();
          call.playbackUntil = Date.now() + Math.min(120_000, Math.max(3000, reply.length * 170));
          emit(call, 'audio:status', { status: 'speaking', requestId, lane: 'conversation' });
          if (call.portrait) {
            await speakMemoryAvatarPortrait({ userId: call.userId, avatarId: call.avatarId, callSessionId: call.sessionId,
              requestId, audioBuffer: audio.audioBuffer, format: audio.format, signal: controller.signal });
            assertCurrent();
          } else emit(call, 'audio:response', { buffer: audio.audioBuffer, format: audio.format, requestId, lane: 'conversation' });
        } catch {
          if (isCurrent()) {
            emit(call, 'audio:tts_error', { requestId, lane: 'conversation', code: call.portrait ? 'PORTRAIT_UNAVAILABLE' : 'TTS_OUTPUT_UNAVAILABLE' });
            if (call.portrait) void stop(call);
          }
        }
      } catch (error) {
        if (accepted && !terminalCommitted) {
          await persistTerminal(usedVision ? 'Camera understanding is unavailable. Please try again or switch to voice only.' : 'The voice reply is unavailable. Please try again.', true);
        } else if (live(call) && !terminalCommitted) {
          emit(call, 'audio:error', { code: 'PERSISTENCE_UNKNOWN', message: UNKNOWN });
        }
      } finally {
        clearTimeout(timer); release();
        call.controller.signal.removeEventListener('abort', cancel);
        if (call.turn === turn) {
          call.turn = undefined;
          if (live(call)) emit(call, 'audio:status', { status: 'listening', requestId, lane: 'conversation' });
        }
      }
    })();
    await turn.pending;
  }

  socket.on('avatar:audio:start', async (data: any) => {
    const userId = getUserId(socket);
    const avatarId = String(data?.avatarId || '');
    const sessionId = String(data?.sessionId || '');
    const avatar = getMemoryAvatar(userId, avatarId);
    if (!personalSocket() || !userId || !avatar || avatar.status !== 'active' || !/^[\w-]{1,128}$/.test(sessionId)) {
      socket.emit('avatar:audio:error', { avatarId, sessionId, code: 'AVATAR_UNAVAILABLE', message: 'This memory person is unavailable.' });
      return;
    }
    const call: PrivateCall = {
      avatarId, userId, sessionId, active: true, portrait: data.portrait === true, authorization: captureMemoryAvatarAuthorization(userId, avatarId),
      controller: new AbortController(), unwatch: () => {}, stt: null,
      frameSequence: 0, videoGeneration: 0, lastFrameAt: 0, inputTail: Promise.resolve(), inputGeneration: 0, lastTranscript: '', lastTranscriptAt: 0, lastReply: '', playbackUntil: 0,
    };
    call.unwatch = call.authorization.watch(call.controller);
    call.controller.signal.addEventListener('abort', () => {
      if (call.active && !authorized(call)) void stop(call, { code: 'AVATAR_UNAVAILABLE', message: 'This memory person or its source material changed. Start a new call.' });
    }, { once: true });
    current = call;
    try {
      call.handover = Promise.resolve(admission.claim(() => stop(call, { code: 'CALL_REPLACED', message: 'Another voice call started.' })));
      call.admission = await call.handover;
      if (!call.admission.isCurrent() || !call.active || !authorized(call) || !socket.connected) { await stop(call); return; }
      current = call;
      if (call.portrait && !isMemoryAvatarPortraitReady({ userId, avatarId, callSessionId: sessionId })) {
        await stop(call, { code: 'PORTRAIT_UNAVAILABLE', message: 'The talking portrait is not ready. Start a new call.' });
        return;
      }
      setRealtimeVoiceSessionActive(userId, `avatar:${socket.id}:${sessionId}`, true);
      const provider = getActiveStreamingSTTProvider();
      if (!provider) {
        await stop(call, { code: isStrictPrivacy() ? 'STRICT_VOICE_UNAVAILABLE' : 'STT_UNAVAILABLE', message: isStrictPrivacy() ? 'Realtime speech recognition is unavailable in strict privacy mode. Text conversation remains available.' : 'Realtime speech recognition is not configured or is unavailable.' });
        return;
      }
      call.stt = createResilientStreamingSession({ provider, language: provider === 'qwen' ? 'zh' : 'zh-CN', interimResults: true }, {
        onRecovering: () => { if (live(call)) emit(call, 'audio:status', { status: 'connecting' }); },
        onRecovered: () => { if (live(call) && !call.turn) emit(call, 'audio:status', { status: 'listening' }); },
      });
      call.stt.onError(() => { if (live(call)) void stop(call, { code: 'STT_FAILED', message: 'Speech recognition failed. Start a new call.' }); });
      call.stt.onResult(async result => {
        if (!live(call)) return;
        const text = String(result.text || '').trim().slice(0, 6000);
        if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
        if (!result.isFinal) { emit(call, 'audio:transcript', { text, isFinal: false }); return; }
        const compact = (value: string) => value.replace(/[\s\p{P}]/gu, '').toLowerCase();
        if (Date.now() < call.playbackUntil && compact(call.lastReply).includes(compact(text))) return;
        if (text === call.lastTranscript && Date.now() - call.lastTranscriptAt < 2000) return;
        call.lastTranscript = text; call.lastTranscriptAt = Date.now();
        const frame = call.frame && Date.now() - call.frame.receivedAt <= FRAME_TTL_MS ? { ...call.frame } : undefined;
        const oldTurn = call.turn;
        if (oldTurn || call.playbackUntil > Date.now()) {
          if (call.portrait) void stopMemoryAvatarPortrait({ userId, avatarId, callSessionId: sessionId }).catch(() => {});
          emit(call, 'audio:interrupt-ack', { requestId: oldTurn?.requestId, workContinues: false });
          call.playbackUntil = 0;
        }
        if (oldTurn) {
          oldTurn.controller.abort();
        }
        const inputGeneration = call.inputGeneration;
        const pending = call.inputTail.then(async () => {
          // A manual interruption also withdraws utterances waiting for an older
          // turn's durable cancellation. Only later input may start a new turn.
          if (inputGeneration === call.inputGeneration && live(call)) await runTurn(call, text, frame);
        });
        call.inputTail = pending.catch(() => {});
        await pending;
      });
      emit(call, 'audio:status', { status: 'listening' });
    } catch {
      await stop(call, { code: 'VOICE_START_FAILED', message: 'The voice call could not be started.' });
    }
  });

  socket.on('avatar:audio:chunk', (data: any) => {
    const call = current;
    if (!call || !matches(call, data) || !live(call)) return;
    const chunk = data?.chunk;
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array || chunk instanceof ArrayBuffer)) return;
    const bytes = Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
    if (!bytes.length || bytes.length > MAX_PCM_CHUNK || bytes.length % 2) return;
    try { call.stt?.sendAudio(bytes); } catch { void stop(call, { code: 'STT_FAILED', message: 'Speech recognition failed. Start a new call.' }); }
  });
  socket.on('avatar:audio:video', async (data: any) => {
    const call = current;
    if (!call || !matches(call, data) || !live(call)) return;
    if (data.enabled === false) { call.frame = undefined; call.frameSequence++; call.videoGeneration++; return; }
    if (typeof data.frame !== 'string' || data.frame.length > 350_000 || !data.frame.startsWith('data:image/jpeg;base64,')) return;
    const sequence = Number(data.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= call.frameSequence || Date.now() - call.lastFrameAt < 400) return;
    call.frameSequence = sequence;
    call.lastFrameAt = Date.now();
    try {
      const buffer = Buffer.from(data.frame.slice(23), 'base64');
      const meta = await sharp(buffer).metadata();
      if (meta.format !== 'jpeg' || !meta.width || !meta.height || meta.width > 1024 || meta.height > 1024) return;
      if (live(call) && sequence === call.frameSequence) call.frame = { data: data.frame, receivedAt: Date.now(), sequence, generation: call.videoGeneration };
    } catch { /* Invalid frames never reach a model or persistence. */ }
  });
  socket.on('avatar:audio:interrupt', async (data: any) => {
    const call = current;
    if (!call || !matches(call, data) || !live(call)) return;
    const turn = call.turn;
    if (data.requestId && turn && data.requestId !== turn.requestId) return;
    call.inputGeneration++;
    // A freshly repeated question is new input after this cancellation, not a
    // duplicate of the queued utterance which will never be accepted.
    call.lastTranscript = ''; call.lastTranscriptAt = 0;
    turn?.controller.abort();
    if (call.portrait) void stopMemoryAvatarPortrait({ userId: call.userId, avatarId: call.avatarId, callSessionId: call.sessionId }).catch(() => {});
    call.playbackUntil = 0;
    emit(call, 'audio:interrupt-ack', { requestId: turn?.requestId, workContinues: false });
    await turn?.pending;
  });
  socket.on('avatar:audio:stop', async (data: any) => { const call = current; if (call && matches(call, data)) await stop(call); });
  socket.on('avatar:audio:work_status_probe', (data: any) => {
    const call = current; if (call && matches(call, data) && live(call)) emit(call, 'audio:status', { status: call.turn ? 'thinking' : 'listening', requestId: call.turn?.requestId });
  });
  socket.on('disconnect', async () => { const call = current; if (call) await stop(call); });
}
