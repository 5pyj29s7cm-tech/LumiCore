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
import { getOrCreateActiveConversation, addMessage, getMessagesByTokenBudget, extractTopics, trackTopic, getTopicContext, getConversationSummary } from "../conversation/manager";
import { processInput, CognitiveContext, extractSentiment } from "../cognition";
import { runOrchestratedTask, classifyComplexity, type LlmGetters } from "../agents/orchestrator";
import { retrieveChunks } from "../agents/rag";
import { queryMemories, addMemory } from "../memory/store";
import { searchKnowledgeBase } from "../org/kb";
import { matchQuickCommand } from "../cognition/quick_commands";
import { recordTokenUsage } from "../llm/token_tracker";
import { DEFAULT_MODELS, getScopedPreferredLLM, getUserPreferredLLMConfig } from "../llm/user_preferences";
import { parseStoredOperationMode, OperationMode } from "../cognition/operation_modes";
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
  return /^(停|停下|停止|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|stop|wait|pause|interrupt|holdon|shutup)$/.test(normalized)
    || /^(停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样)$/.test(normalized)
    || /(停一下|先停|别说了|不要说了|打断一下|等我一下|暂停一下|不用说了|别讲了|stop|hold on|wait a second|pause)/i.test(text);
}

function isPureInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  return /^(停|停下|停止|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样|stop|wait|pause|interrupt|holdon|shutup)$/.test(normalized);
}

function detectVoiceClientModeSwitch(text: string): OperationMode | null {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  const hasSwitchVerb = /(切换|切到|切成|换到|进入|打开|开启|启动|设为|设置为|切回|回到|switch|change|enter|start|open)/i.test(normalized);
  if (!hasSwitchVerb) return null;
  if (/(会议模式|会议|meetingmode|meeting)/i.test(normalized)) return 'meeting';
  if (/(聊天模式|聊天|chatmode|chat)/i.test(normalized)) return 'chat';
  if (/(助手模式|助手|assistantmode|assistant)/i.test(normalized)) return 'assistant';
  if (/(自主模式|自主|自主执行|自动执行|autonomymode|autonomousmode|autonomy|autonomous|autoexecute)/i.test(normalized)) return 'autonomous';
  return null;
}

function isPureModeSwitchRequest(text: string, mode: OperationMode | null): boolean {
  if (!mode) return false;
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  return /^(lumi|露米)?(请|帮我|给我|麻烦)?(切换|切到|切成|换到|进入|打开|开启|启动|设为|设置为|切回|回到|switch|change|enter|start|open)(到|成)?(会议|聊天|助手|自主|自主执行|自动执行|meeting|chat|assistant|autonomy|autonomous|autoexecute)(模式|mode)?[。.!！?？]*$/i.test(normalized);
}
function saveOperationModePreference(userId: string, mode: OperationMode): void {
  try {
    const db = readDB();
    if (!db.settings) db.settings = [];
    const key = `op_mode_${userId}`;
    const value = JSON.stringify({ mode });
    const existing = db.settings.findIndex((s: any) => s.key === key);
    if (existing >= 0) db.settings[existing].value = value;
    else db.settings.push({ key, value });
    writeDB(db);
  } catch (err: any) {
    logger.warn(`[Audio] Failed to persist operation mode: ${err?.message || err}`);
  }
}

function cancelActiveVoiceTurn(session: AudioSession): void {
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

function normalizeVoiceHistoryRecord(m: any): NormalizedMessage[] {
  if (m?.role === 'tool' || m?.mode === 'proactive') return [];
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : '';
  if (!role) return [];
  const message = typeof m?.message === 'string' ? m.message.trim() : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const entries: NormalizedMessage[] = [];
  if (message) entries.push({ role, content: message });
  if (response && role === 'user') entries.push({ role: 'assistant', content: response });
  return entries;
}

function buildVoiceReplyStyleOverlay(): string {
  return [
    '\n\n## Spoken Reply Style',
    '- Never speak hidden reasoning, chain-of-thought, private deliberation, or phrases like “我得想想 / 我需要分析 / 好的，毛先生这是在…”.',
    '- Say the final answer only.',
    '- Default to one short sentence. For simple confirmations, use 2-6 Chinese characters.',
    '- If the user interrupts or says you are verbose, stop immediately and do not explain.',
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
  if (/(刚才|刚刚|弹窗|提示|通知|上面|那个|这个|继续|接着|顺着)/u.test(raw)) return true;
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
    socket.emit('agent:response', { text: '' });
    return;
  }

  session.isSpeaking = false;
  session.isProcessing = true;
  session.pipelineAbortController = new AbortController();
  socket.emit("agent:status", { status: "thinking", agentName: "Lumi" });
  session.ttsAbortController = new AbortController();
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
  const shouldUseProactiveContext = Boolean(recentProactiveSuggestion && isVoiceProactiveFollowup(userText));
  const proactiveContextPrompt = shouldUseProactiveContext && recentProactiveSuggestion
    ? formatProactiveSuggestionForPrompt(recentProactiveSuggestion)
    : '';
  const routedUserText = [userText, proactiveContextPrompt, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
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

  // Voice and text share the same current-workspace knowledge retrieval path.
  const voiceRagKnowledge: string[] = [];
  try {
    const ragAgentIds = Array.from(new Set([session.agentId, 'lumi'].filter(Boolean)));
    for (const ragAgentId of ragAgentIds) {
      const chunks = retrieveChunks(session.userId, ragAgentId, routedUserText, 3, {
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

  let voiceOrganizationKnowledge = '';
  if (voiceScope.domain === 'work' && voiceScope.orgId) {
    try {
      const results = await searchKnowledgeBase(voiceScope.orgId, routedUserText, 3);
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
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${session.userId}`);
      if (setting) return parseStoredOperationMode(setting.value);
    } catch {}
    return 'assistant';
  })();
  const requestedMode = detectVoiceClientModeSwitch(userText);
  const turnDispatch = buildLumiTurnDispatch({
    userId: session.userId,
    text: routedUserText,
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
    text: routedUserText,
    toolDeclarations: toolRegistry.getToolDeclarations(),
    personalityToolPolicy: personality.toolPolicy,
  });
  const intentTrace = buildLumiIntentTrace({
    dispatch: turnDispatch,
    execution: executionDecision,
    text: routedUserText,
    source: 'voice',
  });
  const capabilitySelection = buildLumiCapabilitySelection({
    dispatch: turnDispatch,
    execution: executionDecision,
    text: routedUserText,
  });
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'voice',
    text: routedUserText,
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
    text: routedUserText,
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
  const organizationKnowledgeOverlay = voiceOrganizationKnowledge
    ? `\n\n## Company Knowledge Base\n${voiceOrganizationKnowledge}\n\nUse this authorized organization knowledge when relevant and cite article titles when referencing it.`
    : '';
  const voiceSystemPrompt = fullPersonalityPrompt + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + proactiveContextOverlay + clientSelfPrompt + topicContext + organizationKnowledgeOverlay + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay;

  const userLLMPrefs = getScopedPreferredLLM(session.userId, voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = (userLLMPrefs.models || {})[provider]
    || (provider === 'deepseek' ? 'deepseek-v4-pro' : DEFAULT_MODELS[provider])
    || userLLMPrefs.model
    || 'deepseek-v4-flash';

  const maxIterations = executionDecision.maxIterations || personality.toolPolicy.maxIterations || 5;
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

  // ── Capture abort controller refs BEFORE anything that checks them ──
  // Must NOT look up session.pipelineAbortController / session.ttsAbortController
  // in the loop or flushSentence because a new processVoiceInput will overwrite them.
  const pipelineAbort = session.pipelineAbortController;
  const ttsAbort = session.ttsAbortController;

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
    actionIntent: routedUserText,
    ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? { requestConfirmation } : {}),
    isCancelled: () => pipelineAbort?.signal.aborted ?? false,
    onProgress: (step: string) => {
      socket.emit("agent:progress", { text: step, agentName: "Lumi", source: "voice" });
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
  let sentenceBuffer = '';
  let sentenceIdx = 0;
  const ttsPromises: Promise<void>[] = [];
  let previousToolSig: string | null = null;
  const deferCompletionSpeech = turnFlow.completionEvidenceNeeded;

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

  const specialWorkflow = turnFlow.specialWorkflow;
  if (specialWorkflow) {
    try {
      const workflowResult = await specialWorkflow.run({
        socket,
        userText,
        userId: session.userId,
        desktopRelay,
        speak: flushSentence,
        voiceScope,
        isCancelled: () => Boolean(pipelineAbort?.signal.aborted) || !session.isActive,
      });
      responseText = workflowResult.responseText;
      toolResults = workflowResult.toolCalls;
    } catch (err: any) {
      logger.warn(`[Audio] ${specialWorkflow.logLabel} failed: ${err?.message || err}`);
      responseText = specialWorkflow.fallbackText;
      flushSentence(responseText);
    }

    await Promise.allSettled(ttsPromises);
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: toolResults.length > 0 ? toolResults : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: specialWorkflow.source });
    persistVoiceLearning(responseText, {
      channel: 'workflow',
      toolRecords: toolResults,
      sourceInteractionId: `voice_workflow_${Date.now()}`,
      logLabel: specialWorkflow.source,
    });
    return;
  }

  // ── Quick Command Fast-Path: deterministic commands skip LLM entirely ──
  const directlyAppliedMode: OperationMode | null =
    turnFlow.autoPromoteToAssistant ? 'assistant'
    : requestedMode && ['meeting', 'chat', 'assistant', 'autonomous'].includes(requestedMode) ? requestedMode
    : null;
  if (directlyAppliedMode) {
    let modeSynced = true;
    try {
      await desktopRelay('client_action', {
        action: 'set_client_mode',
        mode: directlyAppliedMode,
        confirmed: directlyAppliedMode === 'meeting' || directlyAppliedMode === 'autonomous',
      });
    } catch (err: any) {
      modeSynced = false;
      socket.emit('agent:notification', {
        type: 'client_action',
        level: 'warning',
        message: `Mode switch did not reach the client: ${err?.message || err}`,
      });
    }
    if (modeSynced) {
      saveOperationModePreference(session.userId, directlyAppliedMode);
    }

    if (isPureModeSwitchRequest(userText, requestedMode)) {
      const modeLabel = directlyAppliedMode === 'meeting' ? '会议模式'
        : directlyAppliedMode === 'chat' ? '聊天模式'
        : directlyAppliedMode === 'assistant' ? '助手模式'
        : '自主模式';
      responseText = modeSynced ? `已切到${modeLabel}。` : `我收到切换到${modeLabel}的请求了，但前端没有完成切换。`;
      flushSentence(responseText);
      await Promise.allSettled(ttsPromises);
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: "voice_mode" });
      persistVoiceLearning(responseText, {
        sourceInteractionId: `voice_mode_${Date.now()}`,
        logLabel: 'voice mode switch',
      });
      return;
    }
  }

  try {
    const quickResult = await matchQuickCommand(userText, session.userId, {
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      surface: 'voice',
    });
    if (quickResult?.matched && (!quickResult.toolCall || executionDecision.allowToolUse)) {
      logger.info(`[Audio] Quick command: "${userText}" → "${quickResult.responseText.slice(0, 50)}"`);
      let quickResponseText = quickResult.responseText;
      let quickToolResult = '';
      let quickToolError: string | undefined;
      let quickToolRecord: ToolExecutionRecord | null = null;
      if (quickResult.toolCall && session.isActive) {
        const correlationId = `qc-${Date.now()}`;
        try {
          const tcResult = await toolRegistry.execute(quickResult.toolCall.name, quickResult.toolCall.arguments, toolContext);
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
        taskText: routedUserText,
        responseText: quickResponseText,
        toolRecords: quickToolRecord ? [quickToolRecord] : [],
        source: 'voice',
        flow: turnFlow,
      });
      quickResponseText = quickFinalized.text;
      if (quickFinalized.notification) socket.emit('agent:notification', quickFinalized.notification);
      flushSentence(quickResponseText);
      await Promise.allSettled(ttsPromises);
      responseText = quickResponseText;
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: quickToolRecord ? [quickToolRecord] : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: "quick_command" });
      persistVoiceLearning(responseText, {
        toolRecords: quickToolRecord ? [quickToolRecord] : [],
        sourceInteractionId: `voice_quick_${Date.now()}`,
        logLabel: 'voice quick command',
      });
      return;
    }
  } catch (qcErr: any) {
    logger.warn(`[Audio] Quick command check failed, falling through to LLM: ${qcErr.message}`);
  }

  if (isMusicProfileAnalysisRequest(userText)) {
    try {
      const profile = await analyzeLikedMusicProfile(session.userId, { maxSongs: 3000 });
      responseText = formatMusicProfileReport(profile);
      flushSentence(profile.summaryCn);
    } catch (profileErr: any) {
      responseText = `我现在还没能完成网易云喜欢歌单分析。${profileErr?.message || '请确认网易云已经登录，再试一次。'}`;
      socket.emit('music:error', { message: responseText });
      flushSentence(responseText);
    }
    await Promise.allSettled(ttsPromises);
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: "music_profile" });
    persistVoiceLearning(responseText, {
      sourceInteractionId: `voice_music_profile_${Date.now()}`,
      logLabel: 'voice music profile',
    });
    return;
  }

  const immediateMusicAdjustment = isMusicAdjustmentRequest(userText);
  if (isMusicPlaybackRequest(userText) || immediateMusicAdjustment) {
    logger.info('[Audio] Music intent matched, acknowledging before playback...');
    responseText = immediateMusicAdjustment
      ? '\u597d\uff0c\u6211\u7ed9\u4f60\u6362\u4e00\u4e0b\u3002'
      : '\u597d\uff0c\u6211\u6765\u653e\u3002';
    flushSentence(responseText);
    await Promise.allSettled(ttsPromises);

    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    session.isProcessing = false;
    session.isSpeaking = false;
    session.pipelineAbortController = null;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening" });
    socket.emit("agent:status", { status: "idle" });
    socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: "music_voice_ack" });
    persistVoiceLearning(responseText, {
      sourceInteractionId: `voice_music_ack_${Date.now()}`,
      logLabel: 'voice music ack',
    });

    const musicUserId = session.userId;
    void (async () => {

      try {
        const result = immediateMusicAdjustment
          ? await adjustMusicPlayback(musicUserId, socket, userText)
          : await searchAndPlay(musicUserId, socket, userText);
        if (!result.success) {
          const message = getMusicFailureMessage(result.reason);
          socket.emit('music:error', { message });
          socket.emit('agent:notification', { type: 'music', level: 'warning', message });
        }
      } catch (musicErr: any) {
        logger.warn('[Audio] Music background playback failed:', musicErr.message);
        const message = getMusicFailureMessage(musicErr?.message);
        socket.emit('music:error', { message });
        socket.emit('agent:notification', { type: 'music', level: 'warning', message });
      }
    })();
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

    const cognition = await processInput(routedUserText, cognitiveCtx, llmClassifier);

    if (cognition.directToolExecuted && cognition.responseText) {
      // Path A: Cognitive engine handled this directly — no LLM needed
      responseText = cognition.responseText;
      flushSentence(responseText);
      await Promise.allSettled(ttsPromises);
      // Persist
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      persistVoiceLearning(responseText, {
        sourceInteractionId: `voice_cognition_direct_${Date.now()}`,
        logLabel: 'voice cognition direct',
      });
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

    // ── Music intent shortcut — intercept before LLM tool-call loop ──
    const isMusicAdjustment = isMusicAdjustmentRequest(userText);
    if (isMusicPlaybackRequest(userText) || isMusicAdjustment) {
      logger.info('[Audio] Music intent matched, attempting shortcut...');
      try {
        const result = isMusicAdjustment
          ? await adjustMusicPlayback(session.userId, socket, userText)
          : await searchAndPlay(session.userId, socket, userText);
        responseText = result.success && result.text ? result.text : getMusicFailureMessage(result.reason);
        if (!result.success) socket.emit('music:error', { message: responseText });
        flushSentence(responseText);
        await Promise.allSettled(ttsPromises);
        const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        session.isProcessing = false;
        session.isSpeaking = false;
        session.pipelineAbortController = null;
        socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
        socket.emit("audio:status", { status: "listening" });
        socket.emit("agent:status", { status: "idle" });
        persistVoiceLearning(responseText, {
          sourceInteractionId: `voice_music_shortcut_${Date.now()}`,
          logLabel: 'voice music shortcut',
        });
        return;
      } catch (musicErr: any) {
        logger.warn('[Audio] Music intent shortcut failed:', musicErr.message);
        responseText = getMusicFailureMessage(musicErr?.message);
        socket.emit('music:error', { message: responseText });
        flushSentence(responseText);
        await Promise.allSettled(ttsPromises);
        const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        session.isProcessing = false;
        session.isSpeaking = false;
        session.pipelineAbortController = null;
        socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
        socket.emit("audio:status", { status: "listening" });
        socket.emit("agent:status", { status: "idle" });
        persistVoiceLearning(responseText, {
          sourceInteractionId: `voice_music_shortcut_error_${Date.now()}`,
          logLabel: 'voice music shortcut error',
        });
        return;
      }
    }

    // ── Orchestrator: complex/moderate tasks → multi-agent decomposition ──
    let usedOrchestrator = false;
    const complexity = classifyComplexity(routedUserText, { userId: session.userId, personalityId: session.personalityId });
    if (executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn && !(workSurfaceRoute.artifactFirst && !workSurfaceRoute.directDesktop) && (complexity === 'complex' || complexity === 'moderate')) {
      try {
        socket.emit("agent:status", { status: "thinking", agentName: "Lumi", phase: exposeAgentWork ? 'orchestrator' : 'background' });
        const voiceLeadIn = exposeAgentWork
          ? "\u6536\u5230\uff0c\u6b63\u5728\u8ba9\u56e2\u961f\u534f\u4f5c\u5904\u7406\u8fd9\u4e2a\u4efb\u52a1\u3002"
          : "\u6536\u5230\uff0c\u6211\u6765\u5904\u7406\u3002";
        flushSentence(voiceLeadIn);
        session.isOrchestrating = true;

        const orchResult = await runOrchestratedTask(
          routedUserText,
          { userId: session.userId, personalityId: session.personalityId, domain: voiceScope.domain, orgId: voiceScope.orgId, desktopRelay },
          { provider, model: effectiveModel },
          llmGetters,
          exposeAgentWork ? (msg) => socket.emit("agent:chunk", { text: msg, agentName: "Lumi" }) : undefined,
          (record, meta) => {
            toolResults.push({
              id: record.id,
              name: record.name,
              arguments: record.arguments || {},
              result: record.result || '',
              error: record.error,
            });
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
        if (orchResult) {
          usedOrchestrator = true;
          responseText = orchResult.responseText;
          const rawSentences = responseText.split(/(?<=[。！？.!?\n])/);
          if (!deferCompletionSpeech) {
            // Flush orchestrator result to TTS sentence by sentence
            for (const s of rawSentences) {
              if (pipelineAbort?.signal.aborted) break;
              flushSentence(s);
            }
          }
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
            sentenceBuffer += chunk;
            socket.emit("agent:chunk", { text: chunk, agentName: "Lumi" });
            const match = sentenceBuffer.match(/^([\s\S]*?[。！？.!?\n])/);
            if (match) {
              sentenceBuffer = sentenceBuffer.slice(match[1].length);
              flushSentence(match[1]);
            }
          }
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );

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
        if (!isDirectDesktopTool(tc.name)) {
          emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: tc.arguments });
        }

        let execResult: string;
        let execError: string | undefined;
        try {
          execResult = await toolRegistry.execute(tc.name, tc.arguments, toolContext);
        } catch (execErr: any) {
          execResult = '';
          execError = execErr.message?.slice(0, 200) || 'Tool execution failed';
        }

        toolResults.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments || {},
          result: execResult,
          error: execError,
        });

        if (!isDirectDesktopTool(tc.name)) {
          if (execError) {
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: tc.arguments, error: execError });
          } else {
            const short = typeof execResult === 'string' ? execResult.slice(0, toolResultPreviewLimit) : JSON.stringify(execResult).slice(0, toolResultPreviewLimit);
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: tc.arguments, result: short });
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

    const finalResponse = finalizeLumiResponse({
      taskText: routedUserText,
      responseText,
      toolRecords: toolResults,
      source: 'voice',
      flow: turnFlow,
    });
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
      responseText = finalResponse.text;
      sentenceBuffer = '';
      if (finalResponse.notification) socket.emit("agent:notification", finalResponse.notification);
    }

    const executionWriteback = persistWorkTakeoverTurnExecution({
      userId: session.userId,
      userText: routedUserText,
      assistantText: responseText,
      source: 'voice',
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      flow: turnFlow,
      capabilitySelection,
      toolRecords: toolResults,
    });
    if (executionWriteback.recorded) {
      socket.emit('agent:task_execution_writeback', {
        ...executionWriteback,
        source: 'voice',
      });
    }

    // Flush remaining text
    if (sentenceBuffer.trim() && !deferCompletionSpeech) flushSentence(sentenceBuffer);
    if (deferCompletionSpeech && responseText) {
      const finalSentences = responseText.split(/(?<=[。！？.!?\n])/);
      for (const s of finalSentences) {
        if (pipelineAbort?.signal.aborted) break;
        flushSentence(s);
      }
    }
    await Promise.allSettled(ttsPromises);

    if (responseText) {
      logger.info(`[Audio] Response: "${responseText.slice(0, 80)}" (${sentenceIdx} sentences, ${toolResults.length} tool calls)`);
      socket.emit("agent:response", { text: responseText, agentName: "Lumi", source: "voice" });
    }

    // Persist
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (!conv.title) {
      conv.title = userText.slice(0, 50);
      writeDB(readDB());
    }
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    if (responseText) {
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: toolResults.length ? toolResults : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    }
    // Topic tracking — extract and record topics for cross-session continuity
    try {
      const topics = extractTopics(userText + ' ' + responseText);
      for (const topic of topics) {
        trackTopic(conv.id, topic);
      }
    } catch {}
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

    persistVoiceLearning(responseText, { toolRecords: toolResults, logLabel: 'voice' });

  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      socket.emit("agent:error", { message: "Voice processing failed" });
    }
  } finally {
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.ttsAbortController = null;
    session.pipelineAbortController = null;

    if (session.isActive) {
      resetSilenceTimer(session, socket);
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
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
    session.isActive = true;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.userId = getUserId(socket);
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
            if (isFiller) {
              logger.info(`[Audio] Ignored filler (${text.length} chars)`);
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
                cancelActiveVoiceTurn(session);
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
                cancelActiveVoiceTurn(session);
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
      addEchoText(data.message);
      const result = await synthesizeSpeech(data.message, {
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
        text: data.message,
        timestamp: new Date().toISOString(),
        volumeGain: proactiveGain,
      });
      logger.info(`[ProactiveVoice] Spoke to ${userId}: "${data.message.slice(0, 60)}"`);
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

      const ttsProvider = getTTSProvider();
      if (!ttsProvider) return;

      const result = await synthesizeSpeech(greeting, { provider: ttsProvider, voiceId });
      socket.emit("audio:proactive_speak", {
        audioBuffer: result.audioBuffer,
        text: greeting,
        timestamp: new Date().toISOString(),
        volumeGain: computeVolumeGain(),
      });
      // Store greeting in memory for dedup
      addMemory({
        userId,
        type: 'fact',
        content: `[Greeting] ${greeting}`,
        keywords: ['greeting', scene, new Date().toISOString().slice(0, 10)],
        confidence: 1.0,
        sourceInteractionId: `greeting_${Date.now()}`,
        agentId: undefined,
      } as any, { tier: 'episodic', perspective: 'shared_memory', importance: 0.2, domain: session.domain, orgId: session.orgId, source: 'voice' });
      logger.info(`[Greeting] LLM-generated for ${userId} (${greeting.length} chars)`);
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
