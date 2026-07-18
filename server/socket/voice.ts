/**
 * Voice / Audio Pipeline — STT → LLM → TTS real-time handlers
 * v2.1 — Multi-turn tool iteration, hands/mouth separation, input queue
 */
import { Server, Socket } from "socket.io";
import fs from "fs";
import path from "path";
import { readDB, writeDB } from "../../db_layer";
import { logger } from "../../logger";
import { NormalizedMessage, makeLLMCallStreaming, makeLLMCall } from "../llm/providers";
import { compactToolResultForModel } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { ToolExecutionRecord } from "../tools/types";
import { personalityRegistry } from "../personality";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { himTick } from "../personality/him";
import { createStreamingSession, getActiveStreamingSTTProvider } from "../stt/adapter";
import { transcribeAudioFile } from "../stt/file_transcription";
import { getMeetingAudioDir } from "../stt/artifact_paths";
import { isVoiceProfileAccessible, voiceProfileScope } from '../tts/profile_store';
import { synthesizeSpeech, getActiveProvider as getTTSProvider, resolveEmotionVoice } from "../tts/adapter";
import { recordLatency } from "../monitor/latency_store";
import { getOrCreateActiveConversation, addMessage, getMessages, getMessagesByTokenBudget, extractTopics, trackTopic, getTopicContext, getConversationSummary } from "../conversation/manager";
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import { processInput, CognitiveContext, extractSentiment } from "../cognition";
import {
  runOrchestratedTask,
  classifyComplexity,
  isTerminalOrchestrationToolEvent,
  shouldAttemptOrchestration,
  type LlmGetters,
} from "../agents/orchestrator";
import { retrieveChunks } from "../agents/rag";
import { queryMemories, addMemory } from "../memory/store";
import { searchKnowledgeBase } from "../org/kb";
import { buildQuickCommandToolPolicy, matchQuickCommand } from "../cognition/quick_commands";
import { recordTokenUsage } from "../llm/token_tracker";
import { DEFAULT_MODELS, getScopedPreferredLLM, getUserPreferredLLMConfig } from "../llm/user_preferences";
import {
  detectRequestedOperationMode,
  isPureOperationModeSwitchRequest,
  type OperationMode,
} from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { formatOperationModeSwitchResponse } from "../i18n/operation_mode_messages";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildLumiTurnDispatch } from "../cognition/turn_dispatch";
import { buildLumiExecutionDecision } from "../cognition/execution_decision";
import { buildLumiIntentTrace } from "../cognition/intent_trace";
import { buildLumiCapabilitySelection } from "../cognition/capability_selection";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { canAutoApproveAction } from "../tools/action_constitution";
import {
  clearPendingConfirmation,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  getPendingConfirmation,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from "../tools/pending_confirmation";
import { updatePresence } from "../biometrics/presence";
import { getVoiceprints } from "../biometrics/store";
import { formatClientSelfPrompt } from "../client/self_model";
import { getIdleState } from "../context/activity_stream";
import { formatProactiveSuggestionForPrompt, getRecentProactiveSuggestion } from "../context/proactive_triggers";
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { analyzeLikedMusicProfile, formatMusicProfileReport, isMusicProfileAnalysisRequest } from "../music/library_profile";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { createDesktopRelay } from "./desktop_relay";
import { resolveSocketScope, scopedEmotionalStateKey } from "./scope";
import { hasClientActionOnlyIntent, isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { setRealtimeVoiceSessionActive } from "../autonomy/foreground_activity";
import { buildForegroundWeChatSendArgs } from "../agents/nl_chainer";
import {
  isSpeechClearlyDirectedAwayFromLumi,
  isVoiceCorrectionContinuation,
  isVoiceCurrentActivityQuestion,
  isVoiceFiller,
  isVoiceReferentialFollowup,
  mergeInterruptedVoiceTurn,
  type PendingInterruptedVoiceTurn,
} from "./voice_turn_state";
import { formatCnVoiceWeChatSendError, formatCnVoiceWeChatSendResult } from "../regions/packs/cn/messaging_messages";
import { CN_VOICE_FAST_PATH_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { resolveWeChatRecipientFromHistory } from "./voice_messaging_context";
import {
  collectRecentActionToolRecords,
  describeRecentActionsFromHistory,
} from "./voice_action_history";
import { buildRecentActionContinuationBridge } from "../cognition/action_continuation";
import { guardCurrentAppToolCall } from "../cognition/current_app_execution";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
  shouldForwardPreFinalizationProgress,
} from "../cognition/response_delivery";
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from "../conversation/guard_history";

interface AudioSession {
  sttSession: ReturnType<typeof createStreamingSession> | null;
  isActive: boolean;
  ttsAbortController: AbortController | null;
  currentVoiceId: string | null;
  personalityId: string;
  userId: string;
  agentId: string;
  domain: 'personal' | 'work';
  orgId: string;
  accumulatedText: string;
  /** TTS is actively playing audio — user can barge-in */
  isSpeaking: boolean;
  /** Tool iteration loop is running — new input is queued, not dropped */
  isProcessing: boolean;
  /** True during orchestrator multi-agent execution — status checks get quick ack */
  isOrchestrating: boolean;
  /** AbortController for the full LLM+tool pipeline — aborted on barge-in */
  pipelineAbortController: AbortController | null;
  /** User-visible text for the pipeline that currently owns the session. */
  activeTurnText: string;
  /** Action text used for routing, including a just-in-time correction when applicable. */
  activeRoutingText: string;
  /** Last action interrupted by real user speech; consumed only by an explicit correction. */
  pendingInterruptedTurn: PendingInterruptedVoiceTurn | null;
  /** Queue of pending utterances while isProcessing=true */
  inputQueue: string[];
  /** True when background agent is executing tools (barge-in requires wake word) */
  isBackgroundWork: boolean;
  /** Incremented on each new command — only latest generation gets TTS output */
  bgGeneration: number;
  /** Timestamp of last audio chunk for STT latency measurement */
  lastChunkTime: number;
  /** Timer to auto-close STT session after prolonged silence (5min) */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Tracked TTS decay timers — cleared on stop/disconnect to prevent post-session mutations */
  ttsDecayTimers: ReturnType<typeof setTimeout>[];
  /** Barge-in confirmation delay timer — cleared on stop/disconnect */
  bargeinTimer: ReturnType<typeof setTimeout> | null;
  /** Voiceprint verification: true when owner's voice is recognized */
  voiceprintMatched: boolean;
  voiceprintConfidence: number;
  voiceprintSpeakerLabel: string | null;
  voiceprintSource: string;
  voiceprintRequired: boolean;
  voiceprintLastAt: number;
  /** Meeting mode: STT only, no LLM/TTS/tool processing. */
  transcriptionOnly: boolean;
  /** Meeting mode raw PCM recording for high-accuracy final transcription. */
  meetingPcmPath: string | null;
  meetingPcmBytes: number;
  meetingStartedAt: number;
  sessionId: string;
}

// Module-level ambient noise tracking — used by both processVoiceInput and registerVoiceHandlers
let ambientRms = 0;
let ambientRmsLastUpdate = 0;

// TTS playback flag — shared with wake detector to suppress echo during speech
let ttsSpeakingCount = 0;
export function isTtsPlaying(): boolean { return ttsSpeakingCount > 0; }

// ── Module-level TTS echo tracker (shared with wake detector) ──

/** Simple character-overlap ratio for echo detection. > 0.5 = likely echo. */
function charOverlap(a: string, b: string): number {
  const an = a.replace(/\s/g, '').toLowerCase();
  const bn = b.replace(/\s/g, '').toLowerCase();
  if (!an || !bn) return 0;
  const setA = new Set(an);
  const setB = new Set(bn);
  let overlap = 0;
  for (const c of setA) { if (setB.has(c)) overlap++; }
  return overlap / Math.max(setA.size, setB.size);
}

const MAX_ECHO_ENTRIES = 50;
const recentTtsTexts: { text: string; until: number }[] = [];

/** Record a TTS sentence for echo cancellation (shared with wake detector). */
export function addEchoText(text: string): void {
  recentTtsTexts.push({ text, until: Date.now() + 10000 });
  if (recentTtsTexts.length > MAX_ECHO_ENTRIES) recentTtsTexts.shift();
}

/** Check if a transcript matches recent TTS output (speaker → mic echo). */
export function isEchoText(transcript: string): boolean {
  const now = Date.now();
  // Purge stale entries
  for (let i = recentTtsTexts.length - 1; i >= 0; i--) {
    if (recentTtsTexts[i].until <= now) recentTtsTexts.splice(i, 1);
  }
  if (recentTtsTexts.length === 0) return false;
  const tNorm = transcript.replace(/\s/g, '').toLowerCase();
  if (tNorm.length < 2) return true;
  for (const r of recentTtsTexts) {
    if (r.text.includes(transcript) || transcript.includes(r.text)) return true;
    if (charOverlap(transcript, r.text) > 0.5) return true;
  }
  return false;
}

function normalizeSpeechText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[。！？.!?，,、；;：:“”"'‘’（）()\[\]【】~～]/g, '')
    .toLowerCase();
}

function isExplicitInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(停|停下|停止|停止任务|终止任务|取消任务|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|stop|stoptask|canceltask|wait|pause|interrupt|holdon|shutup)$/.test(normalized)
    || /^(停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样)$/.test(normalized)
    || /(停一下|先停|别说了|不要说了|打断一下|等我一下|暂停一下|不用说了|别讲了|stop|hold on|wait a second|pause)/i.test(text);
}

function isPureInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(停|停下|停止|停止任务|终止任务|取消任务|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样|stop|stoptask|canceltask|wait|pause|interrupt|holdon|shutup)$/.test(normalized);
}

function cancelActiveVoiceTurn(session: AudioSession, preserveInterruptedTurn = false): void {
  if (preserveInterruptedTurn && session.activeRoutingText.trim()) {
    session.pendingInterruptedTurn = {
      text: session.activeRoutingText.trim(),
      interruptedAt: Date.now(),
    };
  } else if (!preserveInterruptedTurn) {
    session.pendingInterruptedTurn = null;
  }
  session.bgGeneration++;
  session.isSpeaking = false;
  session.isProcessing = false;
  session.isOrchestrating = false;
  session.inputQueue = [];
  session.accumulatedText = '';
  if (session.bargeinTimer) {
    clearTimeout(session.bargeinTimer);
    session.bargeinTimer = null;
  }
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
    session.ttsAbortController = null;
  }
  if (session.pipelineAbortController) {
    session.pipelineAbortController.abort();
    session.pipelineAbortController = null;
  }
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const t of session.ttsDecayTimers) clearTimeout(t);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    ttsSpeakingCount = Math.max(0, ttsSpeakingCount - pendingDecayCount);
  }
}

export function normalizeVoiceHistoryRecord(m: any): NormalizedMessage[] {
  if (m?.role === 'tool' || m?.mode === 'proactive') return [];
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : '';
  if (!role) return [];
  if (role === 'assistant' && isGuardGeneratedConversationRecord(m)) return [];
  const message = typeof m?.message === 'string' ? m.message.trim() : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const responseIsGuard = String(m?.cognitiveIntent || '').toLowerCase() === 'work_product_guard'
    || isGuardGeneratedAssistantText(response);
  const origin = String(m?.channel || m?.source || m?.mode || '').trim().toLowerCase();
  const originPrefix = origin ? `[historical source=${origin}] ` : '';
  const entries: NormalizedMessage[] = [];
  if (message) entries.push({ role, content: `${originPrefix}${message}` });
  if (response && role === 'user' && !responseIsGuard) {
    entries.push({ role: 'assistant', content: `${originPrefix}${response}` });
  }
  return entries;
}

function buildVoiceReplyStyleOverlay(): string {
  // i18n-allow: Chinese examples constrain model output; not direct user-visible copy.
  return [
    '\n\n## Spoken Reply Style',
    '- Never speak hidden reasoning, chain-of-thought, private deliberation, or phrases like “我得想想 / 我需要分析 / 好的，毛先生这是在…”.',
    '- Say the final answer only.',
    '- Default to one short sentence. For simple confirmations, use 2-6 Chinese characters.',
    '- If the user interrupts or says you are verbose, stop immediately and do not explain.',
    '- Never invent a self-check, scan, background action, or tool run to explain latency. Only describe execution that has a real receipt in the current context.',
    '- The current turn is always coming from the Lumi desktop client voice interface. Historical messages may come from other sources; never infer that the current user is speaking through WeChat or another channel.',
    '- If a messaging tool such as wechat_send_message is present in the current tool set, never claim that Lumi lacks that capability. Execute it for an explicit ordinary send, or report the exact tool error.',
    '- Describe a capability as currently available only when it is present in the current tool set or supported by a current receipt. Distinguish “configured”, “available”, and “completed”.',
    '- Do not use body/home/owner metaphors, exaggerated loyalty, honorific filler, or apologies for waiting. Answer the product question directly.',
    // i18n-allow: Chinese examples constrain model output; not direct user-visible copy.
    '- Do not address the user by name or title in routine replies. Never pad feedback acknowledgements with “记住了”, “你说得对”, promises, or a follow-up question; acknowledge the concrete correction in one plain sentence.',
    '- Never print or speak XML/JSON tool-call protocol such as <function_calls>, <invoke>, tool_calls, or hidden client actions.',
  ].join('\n');
}

function shouldAllowVoiceLocalFileWriteForTurn(userText: string): boolean {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  return /\b(?:create|generate|write|save|export|make|draft|draw|build)\b.{0,80}\b(?:file|document|docx|word|pdf|txt|markdown|transcript|notes|minutes|report|pptx?|xlsx?|cad|dxf|dwg|drawing|floor\s*plan|blueprint)\b/i.test(clean)
    || /(?:生成|创建|新建|制作|写成|做成|整理成|汇总成|保存|导出|输出|画|绘制).{0,60}(?:文件|文档|材料|报告|笔记|纪要|记录|文本|文字|清单|方案|表格|图纸|平面图|CAD|DXF|DWG|PPT|PDF|Word|Excel|TXT|MD)/u.test(clean);
}

function isVoiceProactiveFollowup(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // Proactive context is only for short, referential acknowledgements. A full
  // correction or explicit command must route from the user's own words.
  if (raw.length > 24) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/(?:打开|启动|运行|发送|发给|问一下|询问|搜索|查找|不是|错了|搞错|弄错|我说的是|我让你)/u.test(raw)) return false;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  if (/^(?:刚才|刚刚|弹窗|提示|通知|上面|那个|这个|继续|接着|顺着)/u.test(raw)) return true;
  const compact = raw.replace(/[\s，。！？,.!?、…~～"“”'‘’]/g, '').toLowerCase();
  if (!compact) return false;
  if (compact.length > 18) return false;
  return /^(嗯+|哦+|好+|好的|可以|行|来吧|开始|继续|帮我看|看一下|处理|弄一下|搞一下|就这个|对|yes|ok|okay|go|continue|doit)$/.test(compact);
}

function getAmbientNoise(): number | null {
  if (Date.now() - ambientRmsLastUpdate > 15000) return null; // stale
  return ambientRms;
}

function computeVolumeGain(): number {
  let gain = 1.0;
  const noise = getAmbientNoise();
  if (noise !== null) {
    if (noise > 0.15) gain = 1.2;
    else if (noise > 0.08) gain = 1.1;
    else if (noise < 0.02) gain = 0.85;
  }
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) gain = Math.min(gain, 0.8);
  else if (hour >= 7 && hour < 9) gain = Math.min(gain, 0.9);
  return Math.max(0.5, Math.min(1.3, gain));
}

function getAudioSession(socket: Socket): AudioSession {
  if (!socket.data.audioSession) {
    socket.data.audioSession = {
      sttSession: null,
      isActive: false,
      ttsAbortController: null,
      currentVoiceId: null,
      personalityId: 'lumi',
      accumulatedText: '',
      isSpeaking: false,
      isProcessing: false,
      isBackgroundWork: false,
      bgGeneration: 0,
      pipelineAbortController: null,
      activeTurnText: '',
      activeRoutingText: '',
      pendingInterruptedTurn: null,
      inputQueue: [],
      lastChunkTime: 0,
      silenceTimer: null,
      ttsDecayTimers: [],
      bargeinTimer: null,
      userId: '',
      agentId: 'lumi',
      domain: 'personal',
      orgId: '',
      voiceprintMatched: true,  // default: allow (no voiceprints enrolled yet)
      voiceprintConfidence: 0,
      voiceprintSpeakerLabel: null,
      voiceprintSource: '',
      voiceprintRequired: false,
      voiceprintLastAt: 0,
      transcriptionOnly: false,
      meetingPcmPath: null,
      meetingPcmBytes: 0,
      meetingStartedAt: 0,
      sessionId: '',
    };
  }
  return socket.data.audioSession as AudioSession;
}

function getVoiceStateKey(session: AudioSession): string {
  return scopedEmotionalStateKey(session.userId, { domain: session.domain, orgId: session.orgId });
}

function writePcm16Wav(rawPath: string, wavPath: string, sampleRate = 16000): void {
  const pcm = fs.readFileSync(rawPath);
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}

function normalizeVoiceSessionId(value: unknown): string {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return normalized || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function startMeetingPcmRecording(session: AudioSession): void {
  const stableId = normalizeVoiceSessionId(session.sessionId);
  const rawPath = path.join(getMeetingAudioDir({
    userId: session.userId,
    domain: session.domain,
    orgId: session.orgId,
  }), `meeting_${stableId}.pcm`);
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, Buffer.alloc(0));
  const stat = fs.statSync(rawPath);
  session.meetingPcmPath = rawPath;
  session.meetingPcmBytes = stat.size;
  session.meetingStartedAt = stat.birthtimeMs || stat.ctimeMs || Date.now();
}

async function refineMeetingTranscript(io: Server, socket: Socket, session: AudioSession, rawPath: string, bytes: number): Promise<void> {
  const emit = (event: string, payload: any) => {
    if (socket.connected) socket.emit(event, payload);
    else {
      const room = session.domain === 'work' && session.orgId
        ? `user:${session.userId}:org:${session.orgId}`
        : `user:${session.userId}:personal`;
      io.to(room).emit(event, payload);
    }
  };
  if (bytes < 16000 || !fs.existsSync(rawPath)) {
    try { fs.rmSync(rawPath, { force: true }); } catch {}
    emit('meeting:refine_error', { message: 'Meeting recording is too short for high-accuracy transcription.' });
    return;
  }
  const wavPath = rawPath.replace(/\.pcm$/i, '.wav');
  try {
    emit('meeting:refine_status', { status: 'transcribing', bytes });
    writePcm16Wav(rawPath, wavPath);
    try { fs.rmSync(rawPath, { force: true }); } catch {}
    const result = await transcribeAudioFile(fs.readFileSync(wavPath), {
      fileName: path.basename(wavPath),
      language: 'zh',
      preferredProvider: 'qwen',
      allowLocal: true,
      allowQwenFileStt: true,
      onProgress: (message) => emit('meeting:refine_status', { status: 'transcribing', bytes, message }),
    });
    emit('meeting:refined_transcript', {
      text: result.text,
      provider: result.provider,
      model: result.model,
      segments: result.segments,
      speakerCount: result.speakerCount,
      taskId: result.taskId,
      durationMs: result.durationMs,
      audioPath: wavPath,
      startedAt: session.meetingStartedAt || Date.now(),
    });
  } catch (err: any) {
    logger.error('[Meeting Refine Error]:', err);
    emit('meeting:refine_error', { message: err?.message || String(err) });
  }
}

function isVoiceprintGateOpen(session: AudioSession): boolean {
  if (!session.voiceprintRequired) return true;
  const fresh = Date.now() - session.voiceprintLastAt < 3500;
  return fresh && session.voiceprintMatched && session.voiceprintConfidence >= 0.68;
}

function getVoiceprintSpeakerMeta(session: AudioSession): {
  speakerLabel: string | null;
  speakerConfidence: number;
  speakerSource: string;
  speakerMatched: boolean;
} {
  const fresh = Date.now() - session.voiceprintLastAt < 3500;
  const speakerMatched = Boolean(
    fresh &&
    session.voiceprintMatched &&
    session.voiceprintConfidence >= 0.68 &&
    session.voiceprintSpeakerLabel
  );
  return {
    speakerLabel: speakerMatched ? session.voiceprintSpeakerLabel : null,
    speakerConfidence: fresh ? session.voiceprintConfidence : 0,
    speakerSource: fresh ? session.voiceprintSource : '',
    speakerMatched,
  };
}

function blockUnverifiedVoice(socket: Socket, session: AudioSession, reason: string): void {
  logger.info(`[Voiceprint] ${reason} (required=${session.voiceprintRequired}, matched=${session.voiceprintMatched}, conf=${session.voiceprintConfidence.toFixed(2)})`);
  session.isSpeaking = false;
  session.isProcessing = false;
  session.accumulatedText = '';
  socket.emit('audio:status', { status: 'listening' });
}

async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
): Promise<void> {
  if (!isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    return;
  }

  // ── Voiceprint gate: ignore speech from unrecognized speakers ──
  // Only active when voiceprints are enrolled for this user AND at least one
  // recent voiceprint:result has been received with confidence data.
  if (session.voiceprintRequired && session.voiceprintMatched === false && session.voiceprintConfidence > 0) {
    logger.info(`[Voiceprint] Stranger voice detected (conf=${session.voiceprintConfidence.toFixed(2)}) — ignoring`);
    session.isSpeaking = false;
    session.isProcessing = false;
    session.accumulatedText = '';
    socket.emit('audio:status', { status: 'idle' });
    // Send a silent response so the UI doesn't hang in "thinking" state
    socket.emit('agent:response', {
      text: '',
      finalized: true,
      blocked: false,
      reason: 'voiceprint_rejected',
    });
    return;
  }

  const pendingInterruptedTurn = session.pendingInterruptedTurn;
  const interruptedTurnAge = pendingInterruptedTurn
    ? Date.now() - pendingInterruptedTurn.interruptedAt
    : Number.POSITIVE_INFINITY;
  const interruptedActivityResponse = pendingInterruptedTurn
    && interruptedTurnAge >= 0
    && interruptedTurnAge <= 30_000
    && isVoiceCurrentActivityQuestion(userText)
    ? CN_VOICE_FAST_PATH_MESSAGES.interruptedActivity(
        pendingInterruptedTurn.text.replace(/\s+/g, ' ').trim().slice(0, 60),
      )
    : null;
  let interruptedMerge = mergeInterruptedVoiceTurn(pendingInterruptedTurn, userText);
  if (!interruptedMerge.usedInterruptedTurn && isVoiceCorrectionContinuation(userText)) {
    try {
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, session.domain, session.orgId);
      const priorAction = getMessagesByTokenBudget(conv.id)
        .slice(-16)
        .reverse()
        .find((record: any) => {
          if (record?.role !== 'user') return false;
          const priorText = String(record?.message || '').trim();
          return Boolean(priorText && buildForegroundWeChatSendArgs(priorText));
        });
      if (priorAction) {
        interruptedMerge = mergeInterruptedVoiceTurn({
          text: String((priorAction as any).message || ''),
          interruptedAt: new Date((priorAction as any).timestamp || 0).getTime(),
        }, userText, Date.now(), 120_000);
      }
    } catch {}
  }
  session.pendingInterruptedTurn = null;
  const actionIntentText = interruptedMerge.routingText || userText;
  if (interruptedMerge.usedInterruptedTurn) {
    logger.info(`[Audio] Applied correction to interrupted voice request: "${userText.slice(0, 80)}"`);
  }

  session.isSpeaking = false;
  session.isProcessing = true;
  const pipelineAbort = new AbortController();
  const ttsAbort = new AbortController();
  session.pipelineAbortController = pipelineAbort;
  session.ttsAbortController = ttsAbort;
  session.activeTurnText = userText;
  session.activeRoutingText = actionIntentText;
  const isCurrentTurn = () => session.pipelineAbortController === pipelineAbort && !pipelineAbort.signal.aborted;
  socket.emit("agent:status", { status: "thinking", agentName: "Lumi" });
  socket.emit("audio:status", { status: "thinking" });
  const voiceScope = { domain: session.domain, orgId: session.orgId };
  const voiceStateKey = getVoiceStateKey(session);
  if (isConfirmationCancellation(userText)) clearPendingConfirmation(session.userId);
  const pendingConfirmation = isExplicitConfirmationReply(userText)
    ? getPendingConfirmation(session.userId)
    : null;
  const pendingConfirmationPrompt = pendingConfirmation
    ? formatPendingConfirmationPrompt(pendingConfirmation)
    : '';
  const recentProactiveSuggestion = getRecentProactiveSuggestion(session.userId);
  const shouldUseProactiveContext = Boolean(
    !interruptedMerge.usedInterruptedTurn
    && recentProactiveSuggestion
    && isVoiceReferentialFollowup(userText),
  );
  const proactiveContextPrompt = shouldUseProactiveContext && recentProactiveSuggestion
    ? formatProactiveSuggestionForPrompt(recentProactiveSuggestion)
    : '';
  let recentVoiceHistory: any[] = [];
  let actionContinuationBridge = '';
  try {
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    recentVoiceHistory = getMessages(conversation.id, 30);
    actionContinuationBridge = buildRecentActionContinuationBridge(
      actionIntentText,
      recentVoiceHistory,
      conversation.actionContinuationState,
    );
  } catch {}
  const routedUserText = [actionIntentText, actionContinuationBridge, proactiveContextPrompt, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
  session.activeRoutingText = actionIntentText;
  let preMatchedQuickResult: Awaited<ReturnType<typeof matchQuickCommand>> = null;
  try {
    preMatchedQuickResult = await matchQuickCommand(userText, session.userId, {
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      surface: 'voice',
    });
  } catch {}
  const requestedModeHint = detectRequestedOperationMode(userText);
  const skipKnowledgeRetrieval = Boolean(preMatchedQuickResult)
    || Boolean(requestedModeHint)
    || hasClientActionOnlyIntent(userText)
    || isUserCorrectionOrExplanationQuestion(userText);
  const allowLocalFileWrites = shouldAllowVoiceLocalFileWriteForTurn(routedUserText);
  const localWriteIntentReason = allowLocalFileWrites
    ? `Current voice request explicitly asked Lumi to generate/export a local deliverable: "${userText.slice(0, 120)}"`
    : undefined;
  if (proactiveContextPrompt) {
    logger.info(`[Audio] Using recent proactive context for voice follow-up: type=${recentProactiveSuggestion?.type} action=${recentProactiveSuggestion?.action || 'none'}`);
    socket.emit('agent:proactive_context', {
      source: 'voice',
      type: recentProactiveSuggestion?.type,
      action: recentProactiveSuggestion?.action,
      context: recentProactiveSuggestion?.context || {},
    });
  }

  // Cross-session memory retrieval — voice now has access to what was discussed before
  let voiceMemories: any[] = [];
  if (!skipKnowledgeRetrieval) {
    try {
      voiceMemories = queryMemories({
        userId: session.userId,
        query: routedUserText,
        limit: 5,
        minConfidence: 0.4,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
      });
    } catch {}
  }

  // Voice and text share the same current-workspace knowledge retrieval path.
  const voiceRagKnowledge: string[] = [];
  if (!skipKnowledgeRetrieval) {
    try {
      const ragAgentIds = Array.from(new Set([session.agentId, 'lumi'].filter(Boolean)));
      for (const ragAgentId of ragAgentIds) {
        const chunks = await retrieveChunks(session.userId, ragAgentId, routedUserText, 3, {
          domain: voiceScope.domain,
          orgId: voiceScope.domain === 'work' ? voiceScope.orgId : '',
        });
        for (const chunk of chunks) {
          const content = String((chunk as any)?.content || '').trim();
          if (content && !voiceRagKnowledge.includes(content)) voiceRagKnowledge.push(content);
          if (voiceRagKnowledge.length >= 5) break;
        }
        if (voiceRagKnowledge.length >= 5) break;
      }
    } catch (err: any) {
      logger.warn(`[Audio] Scoped RAG retrieval failed: ${err?.message || String(err)}`);
    }
  } else {
    logger.info('[Audio] Skipped memory/RAG retrieval for deterministic or corrective voice turn');
  }

  let voiceOrganizationKnowledge = '';
  if (!skipKnowledgeRetrieval && voiceScope.domain === 'work' && voiceScope.orgId) {
    try {
      const results = await searchKnowledgeBase(voiceScope.orgId, routedUserText, { limit: 3, userId: session.userId });
      voiceOrganizationKnowledge = results
        .map(result => `[${result.title}] ${result.chunk}`)
        .join('\n');
    } catch (err: any) {
      logger.warn(`[Audio] Organization knowledge retrieval failed: ${err?.message || String(err)}`);
    }
  }

  const sensoryAudio = sensoryFn(session.userId);
  const { config: personality, systemPrompt: fullPersonalityPrompt } = personalityRegistry.buildSystemPrompt(
    session.personalityId || 'lumi',
    { mode: 'task', sensory: sensoryAudio, uiContext: 'voice' },
    {
      userId: session.userId,
      memories: voiceMemories.length > 0 ? voiceMemories : undefined,
      ragKnowledge: voiceRagKnowledge.length > 0 ? voiceRagKnowledge : undefined,
      userText: routedUserText,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
    },
  );

  // ── Unified personality prompt + voice-specific overlay ──
  // Same core prompt as text chat — one Lumi, one framework.
  const toolVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise — the user is listening, not reading.',
    '',
    '## Your Tools — Use Them, Don\'t Just Talk About Them',
    '- **web_search** — Search the internet for real-time information, facts, and data.',
    '- **url_fetch** — Read and extract content from any URL/webpage.',
    '- **desktop_open** — Open apps, files, folders, URLs on the user\'s computer.',
    '- **desktop_run_command** — Execute shell commands (cmd /C on Windows) for system operations.',
    '- **desktop_list_files** — Browse files and folders on the desktop.',
    '- **read_file / write_file** — Read existing files or create new ones.',
    '- **create_ppt** — Generate professional PowerPoint presentations. Provide images array for visuals.',
    '- **generate_image** — Create AI-generated images (provide local file paths as slide images).',
    '- **run_workflow** — Execute previously saved multi-step workflows.',
    '',
    '## CRITICAL: You MUST Call Tools to Do Real Work',
    '- When the user asks you to CREATE, SEARCH, OPEN, or DO anything: CALL THE TOOL.',
    '- Saying "好的" or "我帮你做" without calling the tool = the user gets NOTHING. This is a FAILURE.',
    '- **Narrate WHILE acting.** Say "正在搜索..." as you call web_search. Say "正在生成PPT..." as you call create_ppt.',
    '- Only when all tool actions are complete should you summarize the results.',
  ].join('\n');

  const baseVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise; the user is listening, not reading.',
  ].join('\n');

  // Inject compact conversation continuity if available
  let topicContext = '';
  try {
    const convForTopic = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    const summary = getConversationSummary(convForTopic.id);
    if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
    const tc = getTopicContext(convForTopic.id);
    if (tc) topicContext += tc;
  } catch {}

  const operationMode = (() => {
    try {
      return getStoredOperationMode(session.userId);
    } catch {}
    return 'assistant';
  })();
  const requestedMode = requestedModeHint;
  const turnDispatch = buildLumiTurnDispatch({
    userId: session.userId,
    text: actionIntentText,
    continuationContext: [actionContinuationBridge, proactiveContextPrompt, pendingConfirmationPrompt]
      .filter(Boolean)
      .join('\n\n'),
    channel: 'voice',
    source: 'voice',
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    surface: 'voice',
    operationMode,
    requestedMode,
    targetIsLumi: true,
  });
  const turnFlow = turnDispatch.flow;
  const effectiveOperationMode = turnFlow.effectiveOperationMode;
  const selfRepairTurn = turnFlow.selfRepairTurn;
  const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
  const workSurfaceRoute = turnFlow.workSurfaceRoute;
  const visionIntent = turnFlow.visionIntent;
  const exposeAgentWork = turnFlow.exposeAgentWork;
  const executionDecision = buildLumiExecutionDecision({
    flow: turnFlow,
    text: turnFlow.routeText,
    toolDeclarations: toolRegistry.getToolDeclarations(),
    personalityToolPolicy: personality.toolPolicy,
  });
  const intentTrace = buildLumiIntentTrace({
    dispatch: turnDispatch,
    execution: executionDecision,
    text: actionIntentText,
    source: 'voice',
  });
  const capabilitySelection = buildLumiCapabilitySelection({
    dispatch: turnDispatch,
    execution: executionDecision,
    text: turnFlow.routeText,
  });
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'voice',
    text: turnFlow.routeText,
    flow: turnFlow,
    capabilitySelection,
  });
  const routedToolPolicy = executionDecision.toolPolicy;
  logger.info(`[Audio] tool gate: ${executionDecision.allowToolUse ? 'enabled' : 'chat-only'} mode=${operationMode} effective=${effectiveOperationMode} surface=${turnFlow.surface} clientActionOnly=${clientActionOnlyTurn} selfRepair=${selfRepairTurn} capabilityLane=${capabilitySelection.lane} trace=${intentTrace.summary} route=${executionDecision.toolRoute ? `${executionDecision.toolRoute.toolNames.length}/${executionDecision.toolRoute.totalAvailable}` : 'none'}`);
  socket.emit('agent:intent_trace', intentTrace);
  if (executionDecision.toolRoute) {
    socket.emit('agent:tool_route', {
      categories: executionDecision.toolRoute.categories,
      reasons: executionDecision.toolRoute.reasons,
      toolNames: executionDecision.toolRoute.toolNames,
      totalAvailable: executionDecision.toolRoute.totalAvailable,
      truncated: executionDecision.toolRoute.truncated,
      source: 'voice',
      trace: intentTrace,
    });
  }
  socket.emit('agent:capability_selection', {
    lane: capabilitySelection.lane,
    primary: capabilitySelection.primary,
    reasons: capabilitySelection.reasons,
    preferredTools: capabilitySelection.preferredTools,
    source: 'voice',
  });
  if (desktopExecutionPolicy.applies) {
    socket.emit('agent:desktop_execution_policy', {
      reason: desktopExecutionPolicy.reason,
      evidenceTools: desktopExecutionPolicy.evidenceTools,
      actuationTools: desktopExecutionPolicy.actuationTools,
      verificationTools: desktopExecutionPolicy.verificationTools,
      source: 'voice',
    });
  }
  const opModeOverlay = '\n\n' + buildInteractionModeOverlay(turnFlow);
  const workSurfaceOverlay = workSurfaceRoute.promptOverlay ? '\n\n' + workSurfaceRoute.promptOverlay : '';
  const visionRoutingOverlay = visionIntent && effectiveOperationMode !== 'meeting' ? '\n\n' + buildVisionRoutingOverlay(session.userId, routedUserText) : '';
  const interactionOverlay = executionDecision.allowToolUse
    ? toolVoiceOverlay
    : baseVoiceOverlay + '\n\n## Interaction Mode\nThis turn is chat-only. Do not call tools, operate the desktop, assemble a team, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.';

  const clientSelfPrompt = '\n\n' + formatClientSelfPrompt(session.userId, voiceScope);
  const dispatchOverlay = '\n\n' + turnDispatch.promptOverlay;
  const executionOverlay = '\n\n' + executionDecision.promptOverlay;
  const capabilitySelectionOverlay = '\n\n' + capabilitySelection.promptOverlay;
  const desktopExecutionOverlay = desktopExecutionPolicy.promptOverlay ? '\n\n' + desktopExecutionPolicy.promptOverlay : '';
  const turnFlowOverlay = '\n\n' + turnFlow.promptOverlay;
  const runtimeCapabilityOverlay = '\n\n' + buildLumiRuntimeCapabilityContext({
    userId: session.userId,
    text: turnFlow.routeText,
    flow: turnFlow,
    toolRegistry,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
  });
  const operatingKernelOverlay = '\n\n' + buildLumiOperatingKernelPrompt({
    channel: 'voice',
    flow: turnFlow,
  });
  const proactiveContextOverlay = proactiveContextPrompt ? `\n\n${proactiveContextPrompt}` : '';
  const actionContinuationOverlay = actionContinuationBridge ? `\n\n${actionContinuationBridge}` : '';
  const organizationKnowledgeOverlay = voiceOrganizationKnowledge
    ? `\n\n## Company Knowledge Base\n${voiceOrganizationKnowledge}\n\nUse this authorized organization knowledge when relevant and cite article titles when referencing it.`
    : '';
  const voiceSystemPrompt = fullPersonalityPrompt + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + proactiveContextOverlay + actionContinuationOverlay + clientSelfPrompt + topicContext + organizationKnowledgeOverlay + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay;

  const userLLMPrefs = getScopedPreferredLLM(session.userId, voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = (userLLMPrefs.models || {})[provider]
    || (provider === 'deepseek' ? 'deepseek-v4-pro' : DEFAULT_MODELS[provider])
    || userLLMPrefs.model
    || 'deepseek-v4-flash';
  const scheduleVoiceSummary = (conversationId: string) => {
    scheduleConversationSummary({
      conversationId,
      userId: session.userId,
      provider,
      model: voiceModel,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      llmGetters,
      log: {
        info: message => logger.info(message),
        warn: (message, error) => logger.warn(message, error),
      },
    });
  };

  const maxIterations = executionDecision.allowToolUse
    ? Math.max(1, executionDecision.maxIterations || 1)
    : 1;
  const toolResultPreviewLimit = 500;
  const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
  const emitToolLifecycle = (payload: {
    correlationId: string;
    name: string;
    arguments: Record<string, any>;
    result?: string;
    error?: string;
  }) => {
    const normalized = { ...payload, args: payload.arguments, source: 'voice' };
    socket.emit("agent:tool_call", normalized);
    socket.emit("agent:tool", normalized);
  };
  const directDesktopRelayTools = new Set([
    'client_action',
    'desktop_system_info',
    'desktop_list_files',
    'desktop_list_apps',
    'desktop_path_info',
    'desktop_open',
    'desktop_show_lumi_window',
    'desktop_run_command',
    'desktop_active_window',
    'desktop_running_processes',
    'desktop_capture_screen',
    'desktop_clipboard_read',
    'desktop_clipboard_write',
    'desktop_idle_time',
    'desktop_poll_activity',
    'desktop_mouse_move',
    'desktop_mouse_click',
    'desktop_mouse_drag',
    'desktop_mouse_click_at',
    'desktop_mouse_double_click_at',
    'desktop_mouse_right_click_at',
    'desktop_keyboard_type',
    'desktop_keyboard_press',
    'desktop_set_wallpaper_mode',
    'desktop_cursor_glow_show',
    'desktop_cursor_glow_update',
    'desktop_cursor_glow_click',
    'desktop_cursor_glow_hide',
  ]);
  const isDirectDesktopTool = (toolName: string) => directDesktopRelayTools.has(toolName);

  const desktopRelay = createDesktopRelay({
    io,
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    source: 'voice',
    requestSocket: socket,
    emitToolLifecycle,
    formatResultForLifecycle: formatToolResultForUi,
    cancelOnRequestSocketDisconnect: true,
  });

  const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
    if (
      pendingConfirmation
      && consumePendingConfirmation(session.userId, pendingConfirmation.id, toolName, args)
    ) {
      logger.info(`[Audio] Consumed one-time confirmation for "${toolName}".`);
      return true;
    }
    if (canAutoApproveAction(toolName, args, { actionIntent: routedUserText })) return true;
    const pending = recordPendingConfirmation(session.userId, toolName, args, 'voice');
    logger.warn(`[Audio] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
    return false;
  };

  const toolContext = {
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    desktopRelay,
    llmGetters,
    source: 'voice',
    supervisedExternalCommits: true,
    allowLocalFileWrites,
    localWriteIntentReason,
    actionIntent: actionIntentText,
    routedTaskText: turnFlow.routeText,
    ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? { requestConfirmation } : {}),
    isCancelled: () => pipelineAbort?.signal.aborted ?? false,
    onProgress: (step: string) => {
      if (shouldForwardPreFinalizationProgress(step)) {
        socket.emit("agent:progress", { text: step, agentName: "Lumi", source: "voice" });
      }
    },
    toolPolicy: routedToolPolicy,
  };
  const ttsProvider = getTTSProvider();
  // Emotion-adaptive voice: map mood to speech parameters, preserve user's chosen voiceId
  const emotionVoice = ((): { voiceId: string; speechRate?: number; pitch?: number; volume?: number } => {
    try {
      const es = loadEmotionalState(voiceStateKey);
      if (es) return resolveEmotionVoice(session.currentVoiceId || 'longxiaochun_v3', es);
    } catch {}
    return { voiceId: session.currentVoiceId || 'longxiaochun_v3' };
  })();
  let responseText = '';
  let toolResults: ToolExecutionRecord[] = [];
  const persistVoiceLearning = (
    assistantText: string,
    options: {
      channel?: 'voice' | 'workflow';
      toolRecords?: ToolExecutionRecord[];
      sourceInteractionId?: string;
      logLabel?: string;
    } = {},
  ) => {
    persistLumiPostTurnLearning(
      {
        userId: session.userId,
        userText,
        defaultChannel: 'voice',
        flow: turnFlow,
        getToolNames: () => toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
        defaultSourceInteractionId: `voice_${Date.now()}`,
        agentId: session.agentId,
        log: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
      },
      assistantText,
      options,
    );
  };
  const persistVoiceTakeoverExecution = (
    assistantText: string,
    options: {
      toolRecords?: ToolExecutionRecord[];
      source?: string;
      sourceInteractionId?: string;
      finalizationBlocked?: boolean;
      assistantTextTrusted?: boolean;
      finalizationReason?: string;
    } = {},
  ) => {
    const currentToolRecords = options.toolRecords || [];
    // History explanations may carry old tool receipts for finalization, but
    // only a ledger produced by this turn is eligible for task writeback.
    if (currentToolRecords.length === 0) return null;
    const executionWriteback = persistWorkTakeoverTurnExecution({
      userId: session.userId,
      userText: actionIntentText,
      assistantText,
      source: options.source || 'voice',
      interactionId: options.sourceInteractionId || `voice_${Date.now()}`,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      flow: turnFlow,
      capabilitySelection,
      toolRecords: currentToolRecords,
      finalizationBlocked: options.finalizationBlocked === true,
      assistantTextTrusted: options.assistantTextTrusted
        ?? options.finalizationBlocked !== true,
      finalizationReason: options.finalizationReason,
    });
    if (executionWriteback.recorded) {
      socket.emit('agent:task_execution_writeback', {
        ...executionWriteback,
        source: options.source || 'voice',
      });
    }
    return executionWriteback;
  };
  let sentenceIdx = 0;
  const ttsPromises: Promise<void>[] = [];
  let previousToolSig: string | null = null;
  const deferCompletionSpeech = shouldDeferModelOutputUntilFinalized({
    taskText: actionIntentText,
    allowToolUse: executionDecision.allowToolUse,
    flow: turnFlow,
  });
  const modelTextGate = createPreFinalizationTextGate();

  // ── Generation gating: only latest command gets TTS output ──
  session.bgGeneration++;
  const myGeneration = session.bgGeneration;
  let ttsQueue: Promise<void> = Promise.resolve();

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

  const flushSentence = (sentence: string): Promise<number> => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || !ttsProvider || !session.currentVoiceId || !session.isActive) return Promise.resolve(0);
    if (!/[a-zA-Z一-鿿㐀-䶿\d]/.test(txt)) return Promise.resolve(0);
    if (ttsAbort?.signal.aborted) return Promise.resolve(0);
    if (session.bgGeneration !== myGeneration) return Promise.resolve(0);
    sentenceIdx++;
    let resolvePlayback: (value: number) => void = () => {};
    const playbackDone = new Promise<number>(resolve => { resolvePlayback = resolve; });
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (ttsAbort?.signal.aborted) {
        resolvePlayback(0);
        return;
      }
      if (session.bgGeneration !== myGeneration) {
        resolvePlayback(0);
        return;
      }
      session.isSpeaking = true;
      ttsSpeakingCount++;
      try {
        const ttsResult = await synthesizeSpeech(txt, {
          provider: ttsProvider,
          voiceId: emotionVoice.voiceId,
          speechRate: emotionVoice.speechRate,
          pitch: emotionVoice.pitch,
          volume: emotionVoice.volume,
          signal: ttsAbort?.signal,
        });
        if (!ttsAbort?.signal.aborted && session.bgGeneration === myGeneration) {
          socket.emit("audio:status", { status: "speaking" });
          addEchoText(txt);
          const volumeGain = computeVolumeGain();
          socket.emit("audio:response", { buffer: ttsResult.audioBuffer, volumeGain });
          const playbackMs = estimatePlaybackMs(ttsResult.audioBuffer, txt);
          setTimeout(() => resolvePlayback(0), playbackMs);
        } else {
          resolvePlayback(0);
        }
      } catch (e: any) {
        resolvePlayback(0);
        if (e?.name === 'AbortError') return;
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
      } finally {
        if (session.bgGeneration === myGeneration) session.isSpeaking = false;
        // Keep ttsSpeakingCount elevated for 3s after synthesis — client playback continues
        const decay = () => { ttsSpeakingCount = Math.max(0, ttsSpeakingCount - 1); };
        const t = setTimeout(decay, 3000);
        session.ttsDecayTimers.push(t);
      }
    });
    ttsPromises.push(ttsQueue);
    return playbackDone;
  };

  const queueFinalizedSpeech = (text: string) => {
    for (const sentence of String(text || '').split(/(?<=[。！？.!?\n])/u)) {
      if (pipelineAbort?.signal.aborted) break;
      flushSentence(sentence);
    }
  };

  let recentActionExplanation: string | null = interruptedActivityResponse;
  let recentActionEvidence: ToolExecutionRecord[] = [];
  try {
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    const recentActionHistory = recentVoiceHistory.length > 0
      ? recentVoiceHistory
      : getMessages(conversation.id, 30);
    recentActionEvidence = collectRecentActionToolRecords(recentActionHistory);
    if (!recentActionExplanation) {
      recentActionExplanation = describeRecentActionsFromHistory(userText, recentActionHistory);
    }
  } catch {}
  if (recentActionExplanation) {
    const finalizedRecentAction = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText: recentActionExplanation,
      toolRecords: recentActionEvidence,
      source: 'voice_action_history',
      flow: turnFlow,
    });
    responseText = finalizedRecentAction.text;
    if (finalizedRecentAction.notification) {
      socket.emit('agent:notification', finalizedRecentAction.notification);
    }
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conversation.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conversation.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', cognitiveIntent: finalizedRecentAction.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    scheduleVoiceSummary(conversation.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    session.ttsAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';
    socket.emit('chat:conversation_updated', { conversationId: conversation.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening' });
    socket.emit('agent:status', { status: 'idle' });
    socket.emit('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_action_history',
      finalized: true,
      blocked: finalizedRecentAction.blocked,
      reason: finalizedRecentAction.reason || '',
    });
    if (!finalizedRecentAction.blocked) {
      persistVoiceLearning(responseText, {
        sourceInteractionId: `voice_action_history_${Date.now()}`,
        logLabel: 'voice action history explanation',
      });
    }
    return;
  }

  const specialWorkflow = turnFlow.specialWorkflow;
  if (specialWorkflow) {
    let workflowSpeechSummary = '';
    try {
      const workflowResult = await specialWorkflow.run({
        socket,
        userText,
        userId: session.userId,
        desktopRelay,
        // The workflow returns its narration as responseText. TTS is queued
        // only after the shared finalizer has inspected all tool receipts.
        speak: async () => 0,
        voiceScope,
        isCancelled: () => Boolean(pipelineAbort?.signal.aborted) || !session.isActive,
      });
      responseText = workflowResult.responseText;
      toolResults = workflowResult.toolCalls;
      workflowSpeechSummary = String(
        (workflowResult as typeof workflowResult & { speechSummary?: string }).speechSummary || '',
      );
    } catch (err: any) {
      logger.warn(`[Audio] ${specialWorkflow.logLabel} failed: ${err?.message || err}`);
      responseText = specialWorkflow.fallbackText;
    }

    const finalizedWorkflow = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: toolResults,
      source: specialWorkflow.source,
      flow: turnFlow,
    });
    responseText = finalizedWorkflow.text;
    if (finalizedWorkflow.notification) {
      socket.emit('agent:notification', finalizedWorkflow.notification);
    }
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: toolResults,
      source: specialWorkflow.source,
      sourceInteractionId: `voice_workflow_${Date.now()}`,
      finalizationBlocked: finalizedWorkflow.blocked,
      assistantTextTrusted: !finalizedWorkflow.blocked,
      finalizationReason: finalizedWorkflow.reason,
    });
    const finalizedWorkflowSpeech = finalizedWorkflow.blocked || !workflowSpeechSummary
      ? finalizedWorkflow
      : finalizeLumiResponse({
          taskText: actionIntentText,
          responseText: workflowSpeechSummary,
          toolRecords: toolResults,
          source: specialWorkflow.source,
          flow: turnFlow,
        });
    // A blocked independent speech summary must never replace the already
    // finalized primary response. If the primary was blocked, speak its guard.
    const workflowSpeechText = finalizedWorkflowSpeech.blocked
      ? responseText
      : finalizedWorkflowSpeech.text;
    queueFinalizedSpeech(workflowSpeechText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: toolResults.length > 0 ? toolResults : undefined, cognitiveIntent: finalizedWorkflow.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    scheduleVoiceSummary(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", {
      text: responseText,
      agentName: "Lumi",
      source: specialWorkflow.source,
      finalized: true,
      blocked: finalizedWorkflow.blocked,
      reason: finalizedWorkflow.reason || '',
    });
    if (!finalizedWorkflow.blocked) {
      persistVoiceLearning(responseText, {
        channel: 'workflow',
        toolRecords: toolResults,
        sourceInteractionId: `voice_workflow_${Date.now()}`,
        logLabel: specialWorkflow.source,
      });
    }
    return;
  }

  // ── Quick Command Fast-Path: deterministic commands skip LLM entirely ──
  const directlyAppliedMode: OperationMode | null =
    turnFlow.autoPromoteToAssistant ? 'assistant'
    : requestedMode && ['meeting', 'chat', 'assistant', 'autonomous'].includes(requestedMode) ? requestedMode
    : null;
  if (directlyAppliedMode) {
    let modeSynced = true;
    const modeToolRecord: ToolExecutionRecord = {
      id: `voice-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'client_action',
      arguments: {
        action: 'set_client_mode',
        mode: directlyAppliedMode,
        confirmed: directlyAppliedMode === 'meeting' || directlyAppliedMode === 'autonomous',
      },
      result: '',
    };
    try {
      modeToolRecord.result = await desktopRelay('client_action', modeToolRecord.arguments)
        || JSON.stringify({ ok: true, mode: directlyAppliedMode });
    } catch (err: any) {
      modeSynced = false;
      modeToolRecord.error = err?.message || String(err);
      socket.emit('agent:notification', {
        type: 'client_action',
        level: 'warning',
        message: `Mode switch did not reach the client: ${err?.message || err}`,
      });
    }
    if (!isCurrentTurn()) return;
    if (modeSynced) {
      saveStoredOperationMode(session.userId, directlyAppliedMode);
    }

    if (isPureOperationModeSwitchRequest(userText, requestedMode)) {
      responseText = formatOperationModeSwitchResponse(directlyAppliedMode, modeSynced, userText);
      const finalizedMode = finalizeLumiResponse({
        taskText: actionIntentText,
        responseText,
        toolRecords: [modeToolRecord],
        source: 'voice',
        flow: turnFlow,
      });
      responseText = finalizedMode.text;
      if (finalizedMode.notification) {
        socket.emit('agent:notification', finalizedMode.notification);
      }
      persistVoiceTakeoverExecution(responseText, {
        toolRecords: [modeToolRecord],
        source: 'voice_mode',
        sourceInteractionId: `voice_mode_${Date.now()}`,
        finalizationBlocked: finalizedMode.blocked,
        assistantTextTrusted: !finalizedMode.blocked,
        finalizationReason: finalizedMode.reason,
      });
      queueFinalizedSpeech(responseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: [modeToolRecord], cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
      scheduleVoiceSummary(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      socket.emit("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice_mode",
        finalized: true,
        blocked: finalizedMode.blocked,
        reason: finalizedMode.reason || '',
      });
      if (!finalizedMode.blocked) {
        persistVoiceLearning(responseText, {
          toolRecords: [modeToolRecord],
          sourceInteractionId: `voice_mode_${Date.now()}`,
          logLabel: 'voice mode switch',
        });
      }
      return;
    }
  }

  let foregroundWeChatSendArgs = buildForegroundWeChatSendArgs(actionIntentText);
  if (foregroundWeChatSendArgs) {
    try {
      const currentConversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      foregroundWeChatSendArgs = resolveWeChatRecipientFromHistory(
        foregroundWeChatSendArgs,
        getMessagesByTokenBudget(currentConversation.id).slice(-24),
      );
    } catch {}
  }

  try {
    const quickResult = preMatchedQuickResult;
    if (!foregroundWeChatSendArgs && quickResult?.matched && (!quickResult.toolCall || executionDecision.allowToolUse)) {
      logger.info(`[Audio] Quick command: "${userText}" → "${quickResult.responseText.slice(0, 50)}"`);
      let quickResponseText = quickResult.responseText;
      let quickToolResult = '';
      let quickToolError: string | undefined;
      let quickToolRecord: ToolExecutionRecord | null = null;
      if (quickResult.toolCall && session.isActive) {
        const correlationId = `qc-${Date.now()}`;
        try {
          const tcResult = await toolRegistry.execute(quickResult.toolCall.name, quickResult.toolCall.arguments, {
            ...toolContext,
            toolPolicy: buildQuickCommandToolPolicy(routedToolPolicy, quickResult.toolCall.name),
          });
          quickToolResult = tcResult || '';
          socket.emit("agent:tool_call", {
            correlationId,
            name: quickResult.toolCall.name,
            arguments: quickResult.toolCall.arguments,
            result: tcResult?.slice(0, 500) || '',
          });
        } catch (toolErr: any) {
          socket.emit("agent:tool_call", {
            correlationId,
            name: quickResult.toolCall.name,
            arguments: quickResult.toolCall.arguments,
            error: toolErr.message,
          });
          quickToolError = toolErr.message || String(toolErr);
        }
        if (quickResult.formatToolResult) {
          quickResponseText = quickResult.formatToolResult(quickToolResult, quickToolError);
        } else if (quickToolError) {
          quickResponseText = `\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\uff1a${quickToolError}`;
        }
        quickToolRecord = {
          id: correlationId,
          name: quickResult.toolCall.name,
          arguments: quickResult.toolCall.arguments,
          result: quickToolResult,
          error: quickToolError,
        };
      }
      const quickFinalized = finalizeLumiResponse({
        taskText: actionIntentText,
        responseText: quickResponseText,
        toolRecords: quickToolRecord ? [quickToolRecord] : [],
        source: 'voice',
        flow: turnFlow,
      });
      quickResponseText = quickFinalized.text;
      if (quickFinalized.notification) socket.emit('agent:notification', quickFinalized.notification);
      persistVoiceTakeoverExecution(quickResponseText, {
        toolRecords: quickToolRecord ? [quickToolRecord] : [],
        source: 'voice_quick_command',
        sourceInteractionId: `voice_quick_${Date.now()}`,
        finalizationBlocked: quickFinalized.blocked,
        assistantTextTrusted: !quickFinalized.blocked,
        finalizationReason: quickFinalized.reason,
      });
      flushSentence(quickResponseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      responseText = quickResponseText;
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', toolCalls: quickToolRecord ? [quickToolRecord] : undefined, cognitiveIntent: quickFinalized.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
      scheduleVoiceSummary(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      socket.emit("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "quick_command",
        finalized: true,
        blocked: quickFinalized.blocked,
        reason: quickFinalized.reason || '',
      });
      if (!quickFinalized.blocked) {
        persistVoiceLearning(responseText, {
          toolRecords: quickToolRecord ? [quickToolRecord] : [],
          sourceInteractionId: `voice_quick_${Date.now()}`,
          logLabel: 'voice quick command',
        });
      }
      return;
    }
  } catch (qcErr: any) {
    logger.warn(`[Audio] Quick command check failed, falling through to LLM: ${qcErr.message}`);
  }

  // Explicit ordinary foreground WeChat sends use the same deterministic path
  // as text chat. Do not ask the model to rediscover a registered capability.
  if (foregroundWeChatSendArgs && executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn) {
    const toolName = 'wechat_send_message';
    const correlationId = `voice-wechat-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toolRecord: ToolExecutionRecord = {
      id: correlationId,
      name: toolName,
      arguments: foregroundWeChatSendArgs,
      result: '',
    };
    emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatSendArgs });
    let directSendVerified = false;
    try {
      toolRecord.result = await toolRegistry.execute(toolName, foregroundWeChatSendArgs, toolContext) || '';
      if (!isCurrentTurn()) return;
      emitToolLifecycle({
        correlationId,
        name: toolName,
        arguments: foregroundWeChatSendArgs,
        result: formatToolResultForUi(toolRecord.result),
      });
      let parsed: any = {};
      try { parsed = JSON.parse(toolRecord.result || '{}'); } catch {}
      const contact = String(foregroundWeChatSendArgs.contact || '').trim();
      const message = String(foregroundWeChatSendArgs.message || '').trim();
      directSendVerified = parsed.sent === true && parsed.verificationStatus === 'verified';
      responseText = formatCnVoiceWeChatSendResult(
        contact,
        message,
        directSendVerified,
      );
    } catch (sendErr: any) {
      toolRecord.error = sendErr?.message || String(sendErr);
      if (!isCurrentTurn()) return;
      emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatSendArgs, error: toolRecord.error });
      responseText = formatCnVoiceWeChatSendError(toolRecord.error);
    }

    const directFinal = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: [toolRecord],
      source: 'voice',
      flow: turnFlow,
    });
    responseText = directFinal.text;
    if (directFinal.notification) {
      socket.emit('agent:notification', directFinal.notification);
    }
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: [toolRecord],
      source: 'voice_foreground_messaging',
      sourceInteractionId: `voice_wechat_send_${Date.now()}`,
      finalizationBlocked: directFinal.blocked,
      assistantTextTrusted: !directFinal.blocked,
      finalizationReason: directFinal.reason,
    });
    flushSentence(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', toolCalls: [toolRecord], cognitiveIntent: directFinal.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    scheduleVoiceSummary(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    session.ttsAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening' });
    socket.emit('agent:status', { status: 'idle' });
    socket.emit('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_foreground_messaging',
      finalized: true,
      blocked: directFinal.blocked,
      reason: directFinal.reason || '',
    });
    if (!directFinal.blocked) {
      persistVoiceLearning(responseText, {
        toolRecords: [toolRecord],
        sourceInteractionId: `voice_wechat_send_${Date.now()}`,
        logLabel: 'voice foreground messaging',
      });
    }
    return;
  }

  if (isMusicProfileAnalysisRequest(userText)) {
    const profileRecord: ToolExecutionRecord = {
      id: `voice-music-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'music_profile_analysis',
      arguments: { maxSongs: 3000 },
      result: '',
    };
    try {
      const profile = await analyzeLikedMusicProfile(session.userId, { maxSongs: 3000 });
      responseText = formatMusicProfileReport(profile);
      profileRecord.result = JSON.stringify({
        ok: true,
        source: profile.source,
        playlistName: profile.playlistName,
        analyzedTracks: profile.analyzedTracks,
        summary: profile.summaryCn,
      });
    } catch (profileErr: any) {
      profileRecord.error = profileErr?.message || String(profileErr);
      responseText = `我现在还没能完成网易云喜欢歌单分析。${profileErr?.message || '请确认网易云已经登录，再试一次。'}`;
      socket.emit('music:error', { message: responseText });
    }
    const profileFinalized = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: [profileRecord],
      source: 'voice',
      flow: turnFlow,
    });
    responseText = profileFinalized.text;
    if (profileFinalized.notification) {
      socket.emit('agent:notification', profileFinalized.notification);
    }
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: [profileRecord],
      source: 'voice_music_profile',
      sourceInteractionId: `voice_music_profile_${Date.now()}`,
      finalizationBlocked: profileFinalized.blocked,
      assistantTextTrusted: !profileFinalized.blocked,
      finalizationReason: profileFinalized.reason,
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: [profileRecord], cognitiveIntent: profileFinalized.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    scheduleVoiceSummary(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", {
      text: responseText,
      agentName: "Lumi",
      source: "music_profile",
      finalized: true,
      blocked: profileFinalized.blocked,
      reason: profileFinalized.reason || '',
    });
    if (!profileFinalized.blocked) {
      persistVoiceLearning(responseText, {
        toolRecords: [profileRecord],
        sourceInteractionId: `voice_music_profile_${Date.now()}`,
        logLabel: 'voice music profile',
      });
    }
    return;
  }

  const immediateMusicAdjustment = isMusicAdjustmentRequest(userText);
  if (isMusicPlaybackRequest(userText) || immediateMusicAdjustment) {
    logger.info('[Audio] Music intent matched, executing before speaking...');
    const musicRecord: ToolExecutionRecord = {
      id: `voice-music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: immediateMusicAdjustment ? 'music_runtime_adjust' : 'music_runtime_playback',
      arguments: { text: userText },
      result: '',
    };
    try {
      const result = immediateMusicAdjustment
        ? await adjustMusicPlayback(session.userId, socket, userText)
        : await searchAndPlay(session.userId, socket, userText);
      musicRecord.result = JSON.stringify(result);
      responseText = result.success && result.text
        ? result.text
        : getMusicFailureMessage(result.reason);
      if (!result.success) socket.emit('music:error', { message: responseText });
    } catch (musicErr: any) {
      musicRecord.error = musicErr?.message || String(musicErr);
      responseText = getMusicFailureMessage(musicRecord.error);
      socket.emit('music:error', { message: responseText });
    }
    const musicFinalized = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: [musicRecord],
      source: 'voice',
      flow: turnFlow,
    });
    responseText = musicFinalized.text;
    if (musicFinalized.notification) {
      socket.emit('agent:notification', musicFinalized.notification);
    }
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: [musicRecord],
      source: 'voice_music_execution',
      sourceInteractionId: `voice_music_ack_${Date.now()}`,
      finalizationBlocked: musicFinalized.blocked,
      assistantTextTrusted: !musicFinalized.blocked,
      finalizationReason: musicFinalized.reason,
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;

    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: [musicRecord], cognitiveIntent: musicFinalized.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    scheduleVoiceSummary(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", {
      text: responseText,
      agentName: "Lumi",
      source: "music_voice_ack",
      finalized: true,
      blocked: musicFinalized.blocked,
      reason: musicFinalized.reason || '',
    });
    if (!musicFinalized.blocked) {
      persistVoiceLearning(responseText, {
        toolRecords: [musicRecord],
        sourceInteractionId: `voice_music_ack_${Date.now()}`,
        logLabel: 'voice music execution',
      });
    }
    return;
  }

  try {
    // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
    // Same cognitive layer as text chat — one Lumi, one framework.
    const cognitiveCtx: CognitiveContext = {
      userId: session.userId,
      agentId: session.agentId,
      personalityId: session.personalityId || 'lumi',
      personalityName: personality.name,
      llmProvider: provider,
      llmModel: voiceModel,
      isLLMAvailable: true,
    };
    const llmClassifier = async (prompt: string, userText: string): Promise<string> => {
      const classifierModel = provider === 'deepseek' ? 'deepseek-v4-flash' : voiceModel;
      const result = await makeLLMCall(
        [{ role: 'system', content: prompt }, { role: 'user', content: userText }],
        [],
        { provider, model: classifierModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, maxTokens: 60 },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );
      recordTokenUsage(session.userId, provider, classifierModel, result.usage, `voice_cls_${Date.now()}`, 'voice');
      return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
    };

    const cognition = await processInput(routedUserText, cognitiveCtx, llmClassifier, toolContext);
    if (!isCurrentTurn()) return;

    if (cognition.directToolExecuted && cognition.responseText) {
      // Path A: Cognitive engine handled this directly — no LLM needed
      const directRecords = cognition.toolRecord ? [cognition.toolRecord] : [];
      const directFinal = finalizeLumiResponse({
        taskText: actionIntentText,
        responseText: cognition.responseText,
        toolRecords: directRecords,
        source: 'voice',
        flow: turnFlow,
      });
      responseText = directFinal.text;
      persistVoiceTakeoverExecution(responseText, {
        toolRecords: directRecords,
        source: 'voice_cognition_direct',
        sourceInteractionId: `voice_cognition_direct_${Date.now()}`,
        finalizationBlocked: directFinal.blocked,
        assistantTextTrusted: !directFinal.blocked,
        finalizationReason: directFinal.reason,
      });
      flushSentence(responseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      // Persist
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: directRecords.length ? directRecords : undefined, cognitiveIntent: directFinal.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
      scheduleVoiceSummary(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      socket.emit("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice_cognition_direct",
        finalized: true,
        blocked: directFinal.blocked,
        reason: directFinal.reason || '',
      });
      if (!directFinal.blocked) {
        persistVoiceLearning(responseText, {
          toolRecords: directRecords,
          sourceInteractionId: `voice_cognition_direct_${Date.now()}`,
          logLabel: 'voice cognition direct',
        });
      }
      return;
    }

    // Auto-select model based on cognitive intent
    const complexCategories = ['command', 'code', 'question', 'analysis'];
    const isComplex = complexCategories.includes(cognition.intent.category);
    let effectiveModel = voiceModel;
    if (provider === 'deepseek') {
      effectiveModel = isComplex ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
    }
    logger.info(`[Audio] Cognition: ${cognition.intent.category} (confidence: ${cognition.intent.confidence}), model: ${effectiveModel}`);

    // ── Orchestrator: complex/moderate tasks → multi-agent decomposition ──
    let usedOrchestrator = false;
    const complexity = classifyComplexity(routedUserText, { userId: session.userId, personalityId: session.personalityId });
    const shouldOrchestrate = shouldAttemptOrchestration({
      channel: 'voice',
      text: turnFlow.routeText,
      complexity,
      allowToolUse: executionDecision.allowToolUse,
      clientActionOnly: clientActionOnlyTurn,
      selfRepair: selfRepairTurn,
      artifactFirst: workSurfaceRoute.artifactFirst,
      directDesktop: workSurfaceRoute.directDesktop,
    });
    if (shouldOrchestrate) {
      try {
        socket.emit("agent:status", { status: "thinking", agentName: "Lumi", phase: exposeAgentWork ? 'orchestrator' : 'background' });
        // This is a fixed acknowledgement, not model-generated result text.
        // Keep it explicitly non-terminal if low-latency spoken feedback is allowed.
        const voiceLeadIn = "\u6536\u5230\u3002"; // i18n-allow: reviewed neutral pre-finalization voice acknowledgement.
        if (!deferCompletionSpeech && shouldForwardPreFinalizationProgress(voiceLeadIn)) {
          flushSentence(voiceLeadIn);
        }
        session.isOrchestrating = true;

        const orchResult = await runOrchestratedTask(
          routedUserText,
          {
            userId: session.userId,
            personalityId: session.personalityId,
            domain: voiceScope.domain,
            orgId: voiceScope.orgId,
            desktopRelay,
            toolPolicy: routedToolPolicy,
            isCancelled: () => pipelineAbort?.signal.aborted ?? false,
          },
          { provider, model: effectiveModel },
          llmGetters,
          exposeAgentWork && !deferCompletionSpeech
            ? (msg) => {
                if (shouldForwardPreFinalizationProgress(msg)) {
                  socket.emit("agent:chunk", { text: msg, agentName: "Lumi" });
                }
              }
            : undefined,
          (record, meta) => {
            if (isTerminalOrchestrationToolEvent(record)) {
              toolResults.push({
                id: record.id,
                name: record.name,
                arguments: record.arguments || {},
                result: record.result || '',
                error: record.error,
              });
            }
            // Direct desktop relays already emit their own start/result lifecycle.
            // Re-emitting here would duplicate every visible tool event.
            if (isDirectDesktopTool(record.name)) return;
            socket.emit("agent:tool_call", {
              correlationId: record.id,
              toolCallId: record.id,
              name: record.name,
              arguments: record.arguments,
              args: record.arguments,
              subTaskId: meta.subTaskId,
              workerAgentId: meta.agentId,
              workerAgentName: meta.agentName,
              result: record.result?.slice(0, 500),
              error: record.error,
            });
          },
        );
        if (!isCurrentTurn()) return;
        if (orchResult) {
          usedOrchestrator = true;
          responseText = orchResult.responseText;
          const rawSentences = responseText.split(/(?<=[。！？.!?\n])/);
          // Orchestrator result text remains buffered until the shared finalizer
          // has compared it with the complete tool ledger.
          logger.info(`[Audio] Orchestrator response: "${responseText.slice(0, 80)}" (${rawSentences.length} sentences)`);
        }
        session.isOrchestrating = false;
      } catch (e) {
        session.isOrchestrating = false;
        logger.warn('[Audio] Orchestrator failed, falling back to LLM:', (e as Error).message);
      }
    }

    if (!usedOrchestrator) {
      // ── Single-phase: stream LLM → TTS with tool iteration, all inline ──
      // Load recent conversation history for context continuity
      // Include both user & assistant messages with correct roles
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      const recentMsgs = getMessagesByTokenBudget(conv.id);
      const voiceHistory: NormalizedMessage[] = recentMsgs.flatMap(normalizeVoiceHistoryRecord);

      const messages: any[] = [
        { role: 'system', content: voiceSystemPrompt },
        ...voiceHistory,
        { role: 'user', content: userText },
      ];

      for (let iter = 0; iter < maxIterations; iter++) {
      if (pipelineAbort?.signal.aborted) break;

      logger.info(`[Audio] LLM iter ${iter + 1}/${maxIterations}: provider=${provider} model=${effectiveModel}`);
      const toolDeclarations = executionDecision.allowToolUse
        ? toolRegistry.getToolDeclarations().filter((declaration) => {
            const name = declaration.function.name;
            const forbidden = new Set(routedToolPolicy?.forbiddenTools || []);
            if (forbidden.has('*') || forbidden.has(name)) return false;
            const allowed = routedToolPolicy?.allowedTools || [];
            if (allowed.includes('*')) return true;
            return allowed.includes(name);
          })
        : [];

      const streamResult = await makeLLMCallStreaming(
        messages as NormalizedMessage[],
        toolDeclarations,
        { provider, model: effectiveModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, signal: pipelineAbort?.signal },
        (chunk: string) => {
          responseText += chunk;
          if (!deferCompletionSpeech) {
            const safeText = modelTextGate.push(chunk);
            if (safeText) {
              socket.emit("agent:chunk", { text: safeText, agentName: "Lumi" });
            }
          }
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );
      if (!isCurrentTurn()) return;

      messages.push({
        role: 'assistant',
        content: streamResult.text || null,
        ...(streamResult.toolCalls?.length ? { toolCalls: streamResult.toolCalls } : {}),
        reasoningContent: streamResult.reasoningContent,
      });

      // Record token usage for this streaming call
      recordTokenUsage(session.userId, provider, effectiveModel, streamResult.usage, `voice_stream_${Date.now()}`, 'voice');

      if (!streamResult.toolCalls || streamResult.toolCalls.length === 0) break;

      const toolSig = JSON.stringify(streamResult.toolCalls.map(tc => ({ n: tc.name, a: tc.arguments })));
      if (toolSig === previousToolSig) { logger.info('[Audio] Duplicate tools, breaking'); break; }
      previousToolSig = toolSig;

      for (const tc of streamResult.toolCalls) {
        if (pipelineAbort?.signal.aborted) break;
        const cid = `${tc.name}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const currentAppGuard = guardCurrentAppToolCall({
          taskText: turnFlow.routeText,
          toolName: tc.name,
          arguments: tc.arguments || {},
          toolRecords: toolResults,
        });
        const executionArguments = currentAppGuard.normalizedArguments
          || tc.arguments
          || {};
        if (!isDirectDesktopTool(tc.name)) {
          emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: executionArguments });
        }

        let execResult: string;
        let execError: string | undefined;
        if (!currentAppGuard.allowed) {
          execResult = '';
          execError = currentAppGuard.reason;
        } else {
          try {
            execResult = await toolRegistry.execute(tc.name, executionArguments, toolContext);
          } catch (execErr: any) {
            execResult = '';
            execError = execErr.message?.slice(0, 200) || 'Tool execution failed';
          }
        }
        if (!isCurrentTurn()) return;

        toolResults.push({
          id: tc.id,
          name: tc.name,
          arguments: executionArguments,
          result: execResult,
          error: execError,
        });

        if (!isDirectDesktopTool(tc.name)) {
          if (execError) {
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: executionArguments, error: execError });
          } else {
            const short = typeof execResult === 'string' ? execResult.slice(0, toolResultPreviewLimit) : JSON.stringify(execResult).slice(0, toolResultPreviewLimit);
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: executionArguments, result: short });
          }
        }

        messages.push({
          role: 'tool',
          content: execError ? `Error: ${execError}` : compactToolResultForModel(tc.name, execResult),
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }
    } // end if (!usedOrchestrator)

    if (!isCurrentTurn()) return;

    modelTextGate.finish();
    const finalResponse = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: toolResults,
      source: 'voice',
      flow: turnFlow,
    });
    responseText = finalResponse.text;
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
      if (finalResponse.notification) socket.emit("agent:notification", finalResponse.notification);
    }

    persistVoiceTakeoverExecution(responseText, {
      toolRecords: toolResults,
      source: 'voice',
      sourceInteractionId: `voice_main_${Date.now()}`,
      finalizationBlocked: finalResponse.blocked,
      assistantTextTrusted: !finalResponse.blocked,
      finalizationReason: finalResponse.reason,
    });

    // Candidate model/orchestrator text is never spoken before this point, so
    // TTS always receives the complete shared-finalizer result exactly once.
    if (responseText) queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;

    if (responseText) {
      logger.info(`[Audio] Response: "${responseText.slice(0, 80)}" (${sentenceIdx} sentences, ${toolResults.length} tool calls)`);
      socket.emit("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice",
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
      });
    }

    // Persist
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (!conv.title) {
      conv.title = userText.slice(0, 50);
      writeDB(readDB());
    }
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    if (responseText) {
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', source: 'voice', channel: 'voice', toolCalls: toolResults.length ? toolResults : undefined, cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    }
    scheduleVoiceSummary(conv.id);
    // Topic tracking — extract and record topics for cross-session continuity
    if (!finalResponse.blocked) {
      try {
        const topics = extractTopics(userText + ' ' + responseText);
        for (const topic of topics) {
          trackTopic(conv.id, topic);
        }
      } catch {}
    }
    // Text sentiment analysis on user input (matching chat.ts behavior)
    const textSentiment = extractSentiment(userText);
    if (textSentiment.valence !== 0 || textSentiment.urgency > 0 || textSentiment.frustration > 0) {
      try {
        const es = loadEmotionalState(voiceStateKey);
        const updated = updateEmotionalState(es, {
          type: 'sentiment_analysis',
          timestamp: new Date().toISOString(),
          userId: session.userId,
          sentiment: {
            valence: textSentiment.valence,
            frustration: textSentiment.frustration,
            urgency: textSentiment.urgency,
          },
        });
        saveEmotionalState(voiceStateKey, updated);
        try { const hm = loadHIMState(voiceStateKey); const { him: nh } = himTick(updated, hm); saveHIMState(voiceStateKey, nh); } catch {}
      } catch { /* best-effort */ }
    }
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });

    if (!finalResponse.blocked) {
      persistVoiceLearning(responseText, { toolRecords: toolResults, logLabel: 'voice' });
    }

  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      socket.emit("agent:error", { message: "Voice processing failed" });
    }
  } finally {
    // An older aborted pipeline must never clear the state/controllers that
    // already belong to a newer barge-in turn.
    if (session.pipelineAbortController === pipelineAbort) {
      session.isSpeaking = false;
      session.isProcessing = false;
      session.isBackgroundWork = false;
      session.ttsAbortController = null;
      session.pipelineAbortController = null;
      session.activeTurnText = '';
      session.activeRoutingText = '';

      if (session.isActive) {
        resetSilenceTimer(session, socket);
        socket.emit("audio:status", { status: "listening" });
        socket.emit("agent:status", { status: "idle" });
      }
    }
  }
}

function resetSilenceTimer(session: AudioSession, socket: Socket) {
  if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
  session.silenceTimer = setTimeout(() => {
    if (session.isActive && !session.isProcessing) {
      logger.info('[Audio] Silence timeout (5min) — closing STT session');
      if (session.sttSession) {
        session.sttSession.end();
        session.sttSession = null;
      }
      socket.emit("audio:status", { status: "idle" });
    }
  }, 5 * 60 * 1000);
}

export function registerVoiceHandlers(
  socket: Socket,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  getUserId: (s: Socket) => string,
  io: Server,
) {
  socket.on("audio:start", async (data: { voiceId?: string; personalityId?: string; agentId?: string; transcriptionOnly?: boolean; domain?: 'personal' | 'work'; orgId?: string; sessionId?: string }) => {
    logger.info(`[Audio] Voice call started by ${socket.id}`);
    const session = getAudioSession(socket);
    if (session.isActive && session.userId) {
      setRealtimeVoiceSessionActive(session.userId, socket.id, false);
    }
    session.isActive = true;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.userId = getUserId(socket);
    setRealtimeVoiceSessionActive(session.userId, socket.id, true);
    session.agentId = data.agentId || 'lumi';
    session.sessionId = normalizeVoiceSessionId(data.sessionId);
    const sessionScope = resolveSocketScope(socket, session.userId, data);
    session.domain = sessionScope.domain;
    session.orgId = sessionScope.orgId;
    session.transcriptionOnly = data.transcriptionOnly === true;
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    session.meetingStartedAt = 0;
    if (session.transcriptionOnly) {
      try {
        startMeetingPcmRecording(session);
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to start PCM recording: ${err?.message || err}`);
      }
    }
    const enrolledVoiceprints = session.domain === 'personal' && session.userId ? getVoiceprints(session.userId) : [];
    session.voiceprintRequired = enrolledVoiceprints.length > 0;
    session.voiceprintMatched = !session.voiceprintRequired;
    session.voiceprintConfidence = 0;
    session.voiceprintSpeakerLabel = null;
    session.voiceprintSource = '';
    session.voiceprintLastAt = 0;
    const personalityCfg = personalityRegistry.getForUser(
      data.personalityId || 'lumi',
      session.userId,
      session.domain === 'work' ? session.orgId : undefined,
    );
    // Use explicit voiceId, then personality's TTS voice, then null (TTS provider default)
    const requestedVoiceId = data.voiceId || personalityCfg?.ttsVoiceId || null;
    const voiceScope = voiceProfileScope(session.userId, session.domain, session.orgId);
    if (requestedVoiceId && !isVoiceProfileAccessible(voiceScope, requestedVoiceId)) {
      logger.warn(`[Audio] Refused voice profile from another domain: ${requestedVoiceId}`);
      socket.emit('audio:voice_unavailable', { reason: 'voice_profile_scope_mismatch' });
      session.currentVoiceId = null;
    } else {
      session.currentVoiceId = requestedVoiceId;
    }
    session.personalityId = data.personalityId || 'lumi';

    // End previous STT session if re-starting without explicit stop
    if (session.sttSession) { try { session.sttSession.end(); } catch {} session.sttSession = null; }

    const sttProvider = getActiveStreamingSTTProvider();
    if (sttProvider) {
      try {
        const language = sttProvider === 'qwen' ? 'zh' : 'zh-CN';
        session.sttSession = createStreamingSession({ provider: sttProvider, language, interimResults: true });
        resetSilenceTimer(session, socket);

        session.sttSession.onResult(async (result) => {
          if (result.text && result.isFinal) {
            if (session.lastChunkTime > 0) {
              recordLatency('stt', Date.now() - session.lastChunkTime);
            }
            logger.info(`[Audio] Final transcript received (${result.text.length} chars)`);
            // Feed voice sentiment into emotional state when a provider includes it.
            if (result.sentiment && session.userId) {
              try {
                const stateKey = getVoiceStateKey(session);
                const es = loadEmotionalState(stateKey);
                const updated = updateEmotionalState(es, {
                  type: 'sentiment_analysis',
                  timestamp: new Date().toISOString(),
                  userId: session.userId,
                  sentiment: {
                    valence: result.sentiment.sentiment_score,
                    frustration: result.sentiment.sentiment === 'negative' ? 0.6 : 0,
                    urgency: 0,
                  },
                });
                saveEmotionalState(stateKey, updated);
                try { const hm2 = loadHIMState(stateKey); const { him: nh2 } = himTick(updated, hm2); saveHIMState(stateKey, nh2); } catch {}
              } catch { /* best-effort sentiment tracking */ }
            }
            session.accumulatedText += result.text;
            const text = session.accumulatedText.trim();
            session.accumulatedText = '';
            if (!text) return;

            // ── Filter filler words: single-char interjections ──
            const isFiller = /^[嗯啊哦呃哼唉呀哈呵嗨喂诶唔嘶啧哎哦哟嘿嘛哇啦嘞][。！？.!?，,～~]*$/.test(text);
            if (isFiller || isVoiceFiller(text)) {
              logger.info(`[Audio] Ignored filler (${text.length} chars)`);
              return;
            }
            if (isSpeechClearlyDirectedAwayFromLumi(text)) {
              logger.info(`[Audio] Ignored speech explicitly directed to another person (${text.length} chars)`);
              return;
            }
            // ── Filter pure noise (no CJK, no letters, no digits) ──
            const hasContent = /[a-zA-Z一-鿿㐀-䶿\d]/.test(text);
            if (!hasContent) {
              logger.info(`[Audio] Ignored pure noise (${text.length} chars)`);
              return;
            }

            if (!session.transcriptionOnly && !isVoiceprintGateOpen(session)) {
              blockUnverifiedVoice(socket, session, 'Ignored transcript before command/barge-in');
              resetSilenceTimer(session, socket);
              return;
            }

            if (session.isProcessing || session.isSpeaking) {
              const explicitInterrupt = isExplicitInterruptCommand(text);
              // Speaking (TTS playing): only long or explicit speech → barge-in
              // Short fragments (< 4 chars) are likely speaker echo, not user speech
              if (session.isSpeaking) {
                if (!explicitInterrupt && isEchoText(text)) {
                  logger.info(`[Audio] Echo cancelled during speech (${text.length} chars)`);
                  return;
                }
                logger.info(`[Audio] Barge-in during speech (${text.length} chars)`);
                cancelActiveVoiceTurn(session, !isPureInterruptCommand(text));
                socket.emit("audio:status", { status: "interrupted" });
                socket.emit("audio:interrupt-ack", {});
                if (isPureInterruptCommand(text)) {
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
              } else {
                // Processing but not speaking (LLM thinking / tool exec):
                // Any real speech → barge-in, abort current pipeline
                logger.info(`[Audio] Barge-in during processing (${text.length} chars)`);
                cancelActiveVoiceTurn(session, !isPureInterruptCommand(text));
                socket.emit("audio:status", { status: "interrupted" });
                socket.emit("audio:interrupt-ack", {});
                if (isPureInterruptCommand(text)) {
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
                // Fall through to processInput with new speech
              }
            }

            // Echo confirmation — brief window for user to see what was heard and interrupt if wrong
            socket.emit("audio:confirm", { text });
            logger.info(`[Audio] Accepted transcript (${text.length} chars)`);

            if (session.transcriptionOnly) {
              socket.emit("audio:transcript", { text, isFinal: true, ...getVoiceprintSpeakerMeta(session) });
              socket.emit("audio:status", { status: "listening" });
              resetSilenceTimer(session, socket);
              return;
            }

            // Brief delay before processing (user can barge-in during this window)
            session.bargeinTimer = setTimeout(() => {
              session.bargeinTimer = null;
              if (!session.isActive) return;
              processVoiceInput(socket, session, text, llmGetters, sensoryFn, io).catch(err => {
                logger.error("[Voice Error]:", err);
                session.isSpeaking = false;
                session.isProcessing = false;
                socket.emit("audio:status", { status: "listening" });
              });
            }, 600);
          } else if (result.text && !result.isFinal) {
            socket.emit("audio:transcript", { text: result.text, isFinal: false });
          }
        });

        session.sttSession.onError((err: Error) => {
          logger.error("[Audio STT Error]:", err);
          socket.emit("audio:error", { message: err.message });
        });

        socket.emit("audio:status", { status: "listening" });
      } catch (err: any) {
        logger.error("[Audio Start Error]:", err);
        socket.emit("audio:error", { message: err.message });
      }
    } else {
      socket.emit("audio:status", { status: "idle" });
      socket.emit("audio:error", {
        message: "Realtime speech recognition is not configured. Set DOUBAO_SPEECH_KEY (AppID:AccessToken) or DASHSCOPE_API_KEY/QWEN_API_KEY. Local/OpenAI Whisper can still transcribe uploaded audio files.",
      });
    }
  });

  let chunkCount = 0;
  socket.on("audio:chunk", (data: Buffer) => {
    const session = getAudioSession(socket);
    if (!session.isActive) return;
    session.lastChunkTime = Date.now();
    resetSilenceTimer(session, socket);
    if (session.transcriptionOnly && session.meetingPcmPath) {
      try {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        fs.appendFileSync(session.meetingPcmPath, chunk);
        session.meetingPcmBytes += chunk.length;
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to append PCM chunk: ${err?.message || err}`);
      }
    }
    if (session.sttSession) {
      session.sttSession.sendAudio(data);
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        logger.info(`[Audio] Sent ${chunkCount} chunks (${data.length} bytes each)`);
      }
    }
  });

  // ── Voiceprint: receive MFCC match results from frontend hook ──
  socket.on("voiceprint:result", (data: { isOwnerSpeaking: boolean; confidence: number; speakerLabel?: string | null; source?: string; quality?: number; reason?: string }) => {
    const session = getAudioSession(socket);
    if (session.domain === 'work') return;
    session.voiceprintMatched = data.isOwnerSpeaking;
    session.voiceprintConfidence = data.confidence;
    session.voiceprintSpeakerLabel = data.speakerLabel || null;
    session.voiceprintSource = data.source || '';
    session.voiceprintLastAt = Date.now();
    logger.info(`[Voiceprint] result source=${data.source || 'unknown'} matched=${data.isOwnerSpeaking} conf=${Number(data.confidence || 0).toFixed(2)} quality=${typeof data.quality === 'number' ? data.quality.toFixed(2) : '-'} reason=${data.reason || '-'}`);
  });

  // ── Presence: periodic heartbeat from usePresence hook ──
  socket.on("presence:heartbeat", (data: { facePresent: boolean; faceMatched?: boolean; faceConfidence: number; voiceprintMatched: boolean; voiceprintConfidence: number }) => {
    const userId = getUserId(socket);
    const presenceScope = resolveSocketScope(socket, userId);
    if (presenceScope.domain === 'work') {
      socket.emit('presence:state_change', { isAway: true, status: 'unavailable_in_organization' });
      return;
    }
    const state = updatePresence(userId, {
      facePresent: data.facePresent === true,
      faceMatched: data.faceMatched === true,
      faceConfidence: Number(data.faceConfidence) || 0,
      voiceprintMatched: data.voiceprintMatched === true,
      voiceprintConfidence: Number(data.voiceprintConfidence) || 0,
    });
    const status = state.isAway ? 'away' : (state.faceMatched || state.voiceprintMatched ? 'present' : 'uncertain');
    socket.emit('presence:state_change', { isAway: state.isAway, status });
  });

  socket.on("audio:interrupt", () => {
    logger.info(`[Audio] Interrupt from ${socket.id}`);
    const session = getAudioSession(socket);
    cancelActiveVoiceTurn(session);
    socket.emit("audio:status", { status: "interrupted" });
    socket.emit("audio:interrupt-ack", {});
  });

  socket.on("audio:stop", (data?: { refineTranscript?: boolean; sessionId?: string }) => {
    logger.info(`[Audio] Voice call ended by ${socket.id}`);
    const session = getAudioSession(socket);
    if (data?.sessionId && session.sessionId && data.sessionId !== session.sessionId) return;
    const shouldRefineMeeting = session.transcriptionOnly && data?.refineTranscript === true;
    const meetingPcmPath = session.meetingPcmPath;
    const meetingPcmBytes = session.meetingPcmBytes;
    session.isActive = false;
    setRealtimeVoiceSessionActive(session.userId, socket.id, false);
    session.transcriptionOnly = false;
    cancelActiveVoiceTurn(session);
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    if (session.sttSession) {
      session.sttSession.end();
      session.sttSession = null;
    }
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    // Clear tracked timers to prevent post-session mutations
    socket.emit("audio:status", { status: "idle" });
    if (shouldRefineMeeting && meetingPcmPath) {
      void refineMeetingTranscript(io, socket, session, meetingPcmPath, meetingPcmBytes);
    } else if (meetingPcmPath) {
      try { fs.rmSync(meetingPcmPath, { force: true }); } catch {}
    }
  });

  // Track ambient noise level for environment-gated proactive speech
  socket.on("ambient:noise_level", (data: { rms: number; isSpeaking: boolean; callState: string }) => {
    ambientRms = data.rms;
    ambientRmsLastUpdate = Date.now();
  });

  /**
   * Night / Focus quiet mode: determine whether Lumi should suppress proactive speech.
   */
  function shouldStayQuiet(userId: string): { quiet: boolean; reason: string } {
    const hour = new Date().getHours();
    const nightHours = hour >= 23 || hour < 7;

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

  socket.on("proactive:request_speak", async (data: { message: string }) => {
    const session = getAudioSession(socket);
    const userId = getUserId(socket);
    if (!userId || !data.message) return;

    session.isSpeaking = true;
    const resetSpeaking = () => { session.isSpeaking = false; };
    const finalizedProactive = finalizeLumiResponse({
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
    if (!voiceId) { resetSpeaking(); return; }

    // Gate: check initiative level — Lumi only speaks first when comfortable enough
    const es = loadEmotionalState(getVoiceStateKey(session));
    if (es.initiative < 0.4) { resetSpeaking(); return; }

    // Gate: don't interrupt when environment is noisy (user likely in a meeting)
    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.08) { resetSpeaking(); return; }

    const ttsProvider = getTTSProvider();
    if (!ttsProvider) { resetSpeaking(); return; }

    const proactiveVoice = resolveEmotionVoice(voiceId, es);

    try {
      ttsSpeakingCount++;
      addEchoText(proactiveText);
      const result = await synthesizeSpeech(proactiveText, {
        provider: ttsProvider,
        voiceId: proactiveVoice.voiceId,
        speechRate: proactiveVoice.speechRate,
        pitch: proactiveVoice.pitch,
        volume: proactiveVoice.volume,
      });
      ttsSpeakingCount = Math.max(0, ttsSpeakingCount - 1);
      const proactiveGain = computeVolumeGain();
      socket.emit("audio:proactive_speak", {
        audioBuffer: result.audioBuffer,
        text: proactiveText,
        timestamp: new Date().toISOString(),
        volumeGain: proactiveGain,
      });
      logger.info(`[ProactiveVoice] Spoke to ${userId}: "${proactiveText.slice(0, 60)}"`);
      resetSpeaking();
    } catch (err: any) {
      resetSpeaking();
      logger.warn(`[ProactiveVoice] TTS failed: ${err.message}`);
    }
  });

  // LLM-generated greeting — replaces hardcoded templates with personalized, scene-aware greetings
  socket.on("greeting:generate", async (data: { scene?: string }) => {
    const userId = getUserId(socket);
    if (!userId) return;

    const session = getAudioSession(socket);
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.getForUser(
        session.personalityId || 'lumi',
        userId,
        session.domain === 'work' ? session.orgId : undefined,
      );
      voiceId = personalityCfg?.ttsVoiceId || null;
    }
    if (!voiceId) return;

    const es = loadEmotionalState(getVoiceStateKey(session));
    if (es.initiative < 0.3) return; // Lower gate for greetings

    // Build temporal context for scene-aware generation
    let temporalBlock = '';
    try {
      const { generateTemporalContext } = await import('../time/temporal_context');
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

    try {
      const greetingLLM = getUserPreferredLLMConfig(session.userId, { maxTokens: 120, domain: session.domain, orgId: session.orgId });
      const response = await makeLLMCall(
        [{ role: 'user', content: greetingPrompt }],
        [],
        greetingLLM,
        llmGetters.getDeepSeek,
        llmGetters.getGemini,
        llmGetters.getOpenAI,
        llmGetters.getAnthropic,
        llmGetters.getQwen,
        llmGetters.getOllama,
        llmGetters.getLmStudio,
        llmGetters.getArk,
        llmGetters.getXiaomi,
        llmGetters.getKimi,
        llmGetters.getGlm,
        llmGetters.getRelay,
      );

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

      const ttsProvider = getTTSProvider();
      if (!ttsProvider) return;

      const result = await synthesizeSpeech(spokenGreeting, { provider: ttsProvider, voiceId });
      socket.emit("audio:proactive_speak", {
        audioBuffer: result.audioBuffer,
        text: spokenGreeting,
        timestamp: new Date().toISOString(),
        volumeGain: computeVolumeGain(),
      });
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
      logger.warn(`[Greeting] LLM generation failed, using fallback: ${err.message}`);
      const hour = new Date().getHours();
      const fallback = hour < 6 ? '夜深了，还在忙吗？' : hour < 12 ? '早上好，欢迎回来。' : hour < 18 ? '下午好，继续吧。' : '晚上好，欢迎回来。';
      try {
        const ttsProvider = getTTSProvider();
        if (ttsProvider) {
          const result = await synthesizeSpeech(fallback, { provider: ttsProvider, voiceId });
          socket.emit("audio:proactive_speak", { audioBuffer: result.audioBuffer, text: fallback, timestamp: new Date().toISOString(), volumeGain: computeVolumeGain() });
        }
      } catch {}
    }
  });

  socket.on("audio:switch-personality", (data: { personalityId: string }) => {
    const session = getAudioSession(socket);
    if (session.isActive) {
      session.personalityId = data.personalityId;
      logger.info(`[Audio] Personality switched to ${data.personalityId} mid-call`);
    }
  });

  socket.on("disconnect", () => {
    const session = socket.data.audioSession as AudioSession | undefined;
    if (session) {
      session.isActive = false;
      setRealtimeVoiceSessionActive(session.userId, socket.id, false);
      cancelActiveVoiceTurn(session);
      if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
      if (session.bargeinTimer) { clearTimeout(session.bargeinTimer); session.bargeinTimer = null; }
      for (const t of session.ttsDecayTimers) { clearTimeout(t); }
      session.ttsDecayTimers = [];
      if (session.sttSession) {
        session.sttSession.end();
        session.sttSession = null;
      }
    }
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
}
