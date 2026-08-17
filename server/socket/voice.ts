/**
 * Voice / Audio Pipeline — STT → LLM → TTS real-time handlers
 * v2.1 — Multi-turn tool iteration, hands/mouth separation, input queue
 */
import { Server, Socket } from "socket.io";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { readDB, writeDB } from "../../db_layer";
import { logger } from "../../logger";
import { NormalizedMessage, makeLLMCallStreaming, makeLLMCall } from "../llm/providers";
import { compactToolResultForModel, runWithTools } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { ToolExecutionRecord } from "../tools/types";
import { executeToolCall } from "../tools/execution_engine";
import {
  GENERIC_TOOL_PLANNING_PROMPT,
  GENERIC_TOOL_REPLAN_PROMPT,
  hasRelevantEvidenceTool,
  normalizePlannedToolScope,
} from "../cognition/tool_planning";
import { personalityRegistry } from "../personality";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { himTick } from "../personality/him";
import { createResilientStreamingSession, getActiveStreamingSTTProvider } from "../stt/adapter";
import { transcribeAudioFile } from "../stt/file_transcription";
import { computeAdaptiveEndpointSilenceMs } from "../stt/adaptive_endpointing";
import { getMeetingAudioDir } from "../stt/artifact_paths";
import { isVoiceProfileAccessible, voiceProfileScope } from '../tts/profile_store';
import { synthesizeSpeech, getActiveProvider as getTTSProvider, resolveEmotionVoice } from "../tts/adapter";
import { extractFirstCompleteSpeechSentence } from "../tts/speculative_sentence";
import { recordLatency } from "../monitor/latency_store";
import { markVoiceLatencyMilestone, startVoiceLatencyTrace } from "../monitor/voice_latency_store";
import {
  getOrCreateActiveConversation,
  getOrCreateConversationForTurn,
  addMessage,
  getMessages,
  getMessagesByTokenBudget,
  extractTopics,
  trackTopic,
  getTopicContext,
  getConversationSummary,
  getConversationActionStatus,
  prepareConversationActionExecution,
  persistConversationExecutionPlan,
  persistConversationModelExecutionResult,
  getConversationModelExecutionRecovery,
  cancelConversationActionExecution,
  settleConversationActionExecutionRequest,
  setConversationActionExecutionStatus,
  updateConversationActionFocus,
} from "../conversation/manager";
import {
  formatConversationExecutionFactAnswer,
  getConversationExecutionFacts,
  isConversationExecutionFactQuestion,
} from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
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
import { markLatestUserTurn } from "../agents/background_delivery";
import { executeSkillWorkflowAdapter } from "../skills/workflow_registry";
import { queryMemories, addMemory } from "../memory/store";
import { CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory/types";
import { searchKnowledgeBase } from "../org/kb";
import {
  buildDeterministicClientNavigationCommand,
  buildDeterministicExternalCommitConfirmationCommand,
  buildDeterministicKnowledgeInspectionCommand,
  buildDeterministicLocalDesktopNavigationCommand,
  buildDeterministicWorkTaskCreateCommand,
  buildDeterministicWpsDocumentCommand,
  buildQuickCommandToolPolicy,
  matchQuickCommand,
} from "../cognition/quick_commands";
import { recordTokenUsage } from "../llm/token_tracker";
import { getScopedPreferredLLM, getUserPreferredLLMConfig } from "../llm/user_preferences";
import {
  detectRequestedOperationMode,
  isPureOperationModeSwitchRequest,
  type OperationMode,
} from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { formatOperationModeSwitchResponse } from "../i18n/operation_mode_messages";
import { buildInternalOpenCommand } from "../i18n/naturalness_messages";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { shouldRunLegacyDirectExecution } from "../cognition/legacy_route_policy";
import { bindCapabilityExecutionPlanTask } from "../cognition/capability_execution_plan";
import { buildForegroundMessagingArguments, executeForegroundMessagingAction } from "../cognition/foreground_messaging_execution";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildCapabilityMetaResponse, isCapabilityMetaQuestion } from "../cognition/capability_meta";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { canAutoApproveAction } from "../tools/action_constitution";
import { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
import {
  buildVoiceConfirmationChannelScope,
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
import { collectAnticipatoryContext } from "../context/anticipatory_context";
import {
  createReadOnlyCacheKey,
  createReadOnlyCacheScope,
} from "../context/read_only_cache";
import { getIdleState } from "../context/activity_stream";
import { formatProactiveSuggestionForPrompt, getRecentProactiveSuggestion } from "../context/proactive_triggers";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { createDesktopRelay } from "./desktop_relay";
import { resolveSocketScope, scopedEmotionalStateKey } from "./scope";
import { hasClientActionOnlyIntent, hasExplicitToolIntent, isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { setRealtimeVoiceSessionActive } from "../autonomy/foreground_activity";
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs } from "../agents/nl_chainer";
import {
  isSpeechClearlyDirectedAwayFromLumi,
  isVoiceCorrectionContinuation,
  isVoiceCurrentActivityQuestion,
  isVoiceFiller,
  isVoiceReferentialFollowup,
  classifyActiveVoiceWorkInput,
  classifyVoiceWorkInterruption,
  mergeInterruptedVoiceTurn,
  type PendingInterruptedVoiceTurn,
} from "./voice_turn_state";
import { formatCnVoiceWeChatSendError, formatCnVoiceWeChatSendResult } from "../regions/packs/cn/messaging_messages";
import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_FAST_PATH_MESSAGES, CN_VOICE_WORK_MESSAGES, formatCnToolFailureDetail } from "../regions/packs/cn/voice_fast_path_messages";
import { resolveWeChatRecipientFromHistory } from "./voice_messaging_context";
import {
  collectRecentActionToolRecords,
  describeRecentActionsFromHistory,
} from "./voice_action_history";
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  formatConversationActionTaskStatus,
  getRecoveredApplicationContinuationTarget,
  isUserObservedTaskCompletion,
  resolveRecentActionOpenTarget,
} from "../cognition/action_continuation";
import {
  coalesceToolExecutionRecords,
  recordsToTaskReceipts,
  taskReceiptsToRecords,
  taskCompletionFromReceipts,
  toolRecordSucceeded,
} from "../cognition/task_execution_ledger";
import { guardCurrentAppToolCall } from "../cognition/current_app_execution";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
  shouldForwardPreFinalizationProgress,
} from "../cognition/response_delivery";
import { normalizeSpeechCommand, speechCommandKey } from '../cognition/speech_normalization';
import { isCurrentVoiceInputSource, isRepeatedVoiceFinal } from '../cognition/voice_input_guard';
import { normalizeVoiceHistory } from './voice_history';
export { normalizeVoiceHistory, normalizeVoiceHistoryRecord } from './voice_history';

interface AudioSession {
  sttSession: ReturnType<typeof createResilientStreamingSession> | null;
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
  /** Independent conversational response while the work pipeline keeps running. */
  sidecarAbortController: AbortController | null;
  sidecarGeneration: number;
  sidecarHistory: Array<{
    userText: string;
    responseText: string;
    userReceivedAt: string;
    responseAt: string;
    cognitiveIntent: string;
    llmWasCalled: boolean;
    persist: boolean;
  }>;
  /** User-visible text for the pipeline that currently owns the session. */
  activeTurnText: string;
  /** Stable identity for the voice turn that currently owns agent events. */
  activeTurnRequestId: string | null;
  /** Durable conversation task lease owned by the active execution request. */
  activeTaskConversationId: string | null;
  activeTaskRequestId: string | null;
  activeTaskId: string | null;
  /** Action text used for routing, including a just-in-time correction when applicable. */
  activeRoutingText: string;
  /** Last action interrupted by real user speech; consumed only by an explicit correction. */
  pendingInterruptedTurn: PendingInterruptedVoiceTurn | null;
  /** Independent action requests accepted while another voice work lane is active. */
  inputQueue: Array<{ text: string; queuedAt: string; voiceAuthorized: boolean }>;
  /** True when background agent is executing tools (barge-in requires wake word) */
  isBackgroundWork: boolean;
  activeWorkStatus: 'idle' | 'planning' | 'executing' | 'orchestrating' | 'waiting_confirmation' | 'completed';
  activeWorkStep: string;
  activeWorkToolCalls: number;
  /** Server-owned liveness for a real work lease; UI timers may observe but never cancel it. */
  workHeartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Incremented on each new command — only latest generation gets TTS output */
  bgGeneration: number;
  /** Timestamp of last audio chunk for STT latency measurement */
  lastChunkTime: number;
  /** Provider endpoint timestamp for the current utterance. */
  lastSpeechEndedAt: number;
  lastSpeechStartedAt: number;
  endpointSilenceMs: number;
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
  /** Owner match accumulated for the current STT utterance. */
  voiceprintUtteranceEpoch: number;
  utteranceVoiceprintDecided: boolean;
  utteranceVoiceprintMatched: boolean;
  utteranceVoiceprintConfidence: number;
  utteranceVoiceprintQuality: number;
  utteranceVoiceprintFrameCount: number;
  utteranceVoiceprintSpeakerLabel: string | null;
  utteranceVoiceprintSource: string;
  utteranceVoiceprintLastAt: number;
  /** Meeting mode: STT only, no LLM/TTS/tool processing. */
  transcriptionOnly: boolean;
  /** Meeting mode raw PCM recording for high-accuracy final transcription. */
  meetingPcmPath: string | null;
  meetingPcmBytes: number;
  meetingStartedAt: number;
  sessionId: string;
  /** Last command admitted to the execution lane; deduplicates repeated STT finals. */
  lastAcceptedCommandKey: string;
  lastAcceptedCommandAt: number;
  /** Audio-chunk watermark for the accepted final; repeated provider finals
   * without new microphone input must not start another turn. */
  lastAcceptedCommandChunkAt: number;
  /** Requests whose remaining speech was stopped while their work kept running. */
  suppressedSpeechRequestIds: Set<string>;
}

interface VoiceInputTiming {
  speechEndedAt?: number;
  asrFinalAt?: number;
  sttProvider?: string;
}

// Module-level ambient noise tracking — used by both processVoiceInput and registerVoiceHandlers
let ambientRms = 0;
let ambientRmsLastUpdate = 0;

// TTS playback flag — shared with wake detector to suppress echo during speech
let ttsSpeakingCount = 0;
export function isTtsPlaying(): boolean { return ttsSpeakingCount > 0; }

// ── Module-level TTS echo tracker (shared with wake detector) ──

function normalizeEchoText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Sequence-aware overlap avoids the false positives caused by shared character sets. */
function bigramDiceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = counts.get(gram) || 0;
    if (count <= 0) continue;
    intersection += 1;
    counts.set(gram, count - 1);
  }
  return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

const MAX_ECHO_ENTRIES = 50;
const recentTtsTexts: { text: string; until: number; scope: string }[] = [];

function voiceEchoScope(session: Pick<AudioSession, 'userId' | 'sessionId'>): string {
  return `${session.userId || 'anonymous'}:${session.sessionId || 'no-session'}`;
}

/** Record a TTS sentence for echo cancellation (shared with wake detector). */
export function addEchoText(text: string, scope = ''): void {
  const normalizedLength = normalizeEchoText(text).length;
  const retentionMs = Math.min(45_000, Math.max(12_000, 8_000 + normalizedLength * 180));
  recentTtsTexts.push({ text, scope, until: Date.now() + retentionMs });
  if (recentTtsTexts.length > MAX_ECHO_ENTRIES) recentTtsTexts.shift();
}

/** Check if a transcript matches recent TTS output (speaker → mic echo). */
export function isEchoText(transcript: string, includeShortFragments = false, scope = ''): boolean {
  const now = Date.now();
  // Purge stale entries
  for (let i = recentTtsTexts.length - 1; i >= 0; i--) {
    if (recentTtsTexts[i].until <= now) recentTtsTexts.splice(i, 1);
  }
  if (recentTtsTexts.length === 0) return false;
  const tNorm = normalizeEchoText(transcript);
  if (tNorm.length < 2) return false;
  if (tNorm.length < 4 && !includeShortFragments) return false;
  for (const r of recentTtsTexts) {
    if (scope && r.scope !== scope) continue;
    const recent = normalizeEchoText(r.text);
    if (!recent) continue;
    if (recent.includes(tNorm) || tNorm.includes(recent)) return true;
    const lengthRatio = Math.min(tNorm.length, recent.length) / Math.max(tNorm.length, recent.length);
    if (lengthRatio >= 0.45 && bigramDiceSimilarity(tNorm, recent) >= 0.72) return true;
  }
  return false;
}

function normalizeSpeechText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[。！？.!?，,、；;：:“”"'‘’（）()\[\]【】~～]/g, '')
    .toLowerCase();
}

export function isPureInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  return /^(停|停下|停止|停止任务|终止任务|取消任务|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样|stop|stoptask|canceltask|wait|pause|interrupt|holdon|shutup)$/.test(normalized);
}

function cancelActiveVoiceTurn(
  session: AudioSession,
  preserveInterruptedTurn = false,
  preserveDurableTask = false,
  preserveInputQueue = false,
): void {
  if (preserveInterruptedTurn && session.activeRoutingText.trim()) {
    session.pendingInterruptedTurn = {
      text: session.activeRoutingText.trim(),
      interruptedAt: Date.now(),
    };
  } else if (!preserveInterruptedTurn) {
    session.pendingInterruptedTurn = null;
  }
  if (!preserveDurableTask && session.activeTaskConversationId && session.activeTaskRequestId) {
    try {
      cancelConversationActionExecution(
        session.activeTaskConversationId,
        session.userId,
        preserveInterruptedTurn
          ? 'The active request was replaced by the user correction.'
          : 'The active voice request was cancelled.',
        session.activeTaskRequestId,
      );
    } catch {}
  }
  if (!preserveDurableTask) {
    session.activeTaskConversationId = null;
    session.activeTaskRequestId = null;
    session.activeTaskId = null;
  }
  session.bgGeneration++;
  session.isSpeaking = false;
  session.isProcessing = false;
  session.isOrchestrating = false;
  if (!preserveInputQueue) session.inputQueue = [];
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
  if (session.sidecarAbortController) {
    session.sidecarAbortController.abort();
    session.sidecarAbortController = null;
  }
  session.sidecarGeneration++;
  if (!preserveInterruptedTurn) session.sidecarHistory = [];
  session.isBackgroundWork = false;
  session.activeWorkStatus = 'idle';
  session.activeWorkStep = '';
  session.activeWorkToolCalls = 0;
  if (session.workHeartbeatTimer) {
    clearInterval(session.workHeartbeatTimer);
    session.workHeartbeatTimer = null;
  }
  session.activeTurnRequestId = null;
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const t of session.ttsDecayTimers) clearTimeout(t);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    ttsSpeakingCount = Math.max(0, ttsSpeakingCount - pendingDecayCount);
  }
}

/**
 * Confirmation and correction are priority continuations of the active durable
 * task. Keep unrelated queued work, but reserve the transport lane immediately
 * so the aborted pipeline's finalizer cannot dequeue and overtake the priority
 * continuation during the 160 ms transcript handoff window.
 */
export function reservePriorityVoiceHandoff(
  session: AudioSession,
  preserveInterruptedTurn: boolean,
): void {
  cancelActiveVoiceTurn(session, preserveInterruptedTurn, true, true);
  session.isProcessing = true;
}

export function isVoiceCallEndCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  // Ending the call is a transport command. It must not enter the LLM/tool
  // pipeline or wait for speaker verification after the user has asked out.
  // i18n-allow: Chinese voice transport-command recognition; not user-visible copy.
  return /^(?:(?:关闭|结束|挂断|退出|停止)(?:语音)?(?:通话|电话|聊天|会话)|(?:语音)?(?:通话|电话|聊天|会话)(?:关闭|结束|挂断|退出)|endcall|hangup|closevoicecall|stopvoicecall)$/u.test(normalized);
}

function interruptVoiceSpeech(session: AudioSession): void {
  session.bgGeneration++;
  session.isSpeaking = false;
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
    session.ttsAbortController = null;
  }
  if (session.sidecarAbortController) {
    session.sidecarAbortController.abort();
    session.sidecarAbortController = null;
  }
  session.sidecarGeneration++;
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const timer of session.ttsDecayTimers) clearTimeout(timer);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    ttsSpeakingCount = Math.max(0, ttsSpeakingCount - pendingDecayCount);
  }
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
    '- Answer the current utterance first. Never append an earlier process snapshot, task result, or failure unless the user explicitly asks about that earlier work.',
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
      activeWorkStatus: 'idle',
      activeWorkStep: '',
      activeWorkToolCalls: 0,
      workHeartbeatTimer: null,
      bgGeneration: 0,
      pipelineAbortController: null,
      sidecarAbortController: null,
      sidecarGeneration: 0,
      sidecarHistory: [],
      activeTurnText: '',
      activeTurnRequestId: null,
      activeTaskConversationId: null,
      activeTaskRequestId: null,
      activeTaskId: null,
      activeRoutingText: '',
      pendingInterruptedTurn: null,
      inputQueue: [],
      lastChunkTime: 0,
      lastSpeechEndedAt: 0,
      lastSpeechStartedAt: 0,
      endpointSilenceMs: 850,
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
      voiceprintUtteranceEpoch: 0,
      utteranceVoiceprintDecided: false,
      utteranceVoiceprintMatched: false,
      utteranceVoiceprintConfidence: 0,
      utteranceVoiceprintQuality: 0,
      utteranceVoiceprintFrameCount: 0,
      utteranceVoiceprintSpeakerLabel: null,
      utteranceVoiceprintSource: '',
      utteranceVoiceprintLastAt: 0,
      transcriptionOnly: false,
      meetingPcmPath: null,
      meetingPcmBytes: 0,
      meetingStartedAt: 0,
      sessionId: '',
      lastAcceptedCommandKey: '',
      lastAcceptedCommandAt: 0,
      lastAcceptedCommandChunkAt: 0,
      suppressedSpeechRequestIds: new Set<string>(),
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

const VOICEPRINT_LOCAL_COMMAND_THRESHOLD = 0.82;
const VOICEPRINT_EMBEDDING_COMMAND_THRESHOLD = 0.66;
const VOICEPRINT_MIN_UTTERANCE_FRAMES = 3;
const VOICEPRINT_MIN_LOCAL_QUALITY = 0.55;

export interface VoiceprintUtteranceDecision {
  required: boolean;
  decided: boolean;
  matched: boolean;
  confidence: number;
  quality: number;
  frameCount: number;
  source: string;
}

export function isVoiceprintUtteranceAccepted(decision: VoiceprintUtteranceDecision): boolean {
  if (!decision.required) return true;
  if (!decision.decided || !decision.matched) return false;
  if (decision.frameCount < VOICEPRINT_MIN_UTTERANCE_FRAMES) return false;
  if (decision.source === 'speechbrain') {
    return decision.confidence >= VOICEPRINT_EMBEDDING_COMMAND_THRESHOLD;
  }
  if (decision.confidence < VOICEPRINT_LOCAL_COMMAND_THRESHOLD) return false;
  if (decision.quality < VOICEPRINT_MIN_LOCAL_QUALITY) return false;
  return true;
}

function isVoiceprintGateOpen(session: AudioSession): boolean {
  return isVoiceprintUtteranceAccepted({
    required: session.voiceprintRequired,
    decided: session.utteranceVoiceprintDecided,
    matched: session.utteranceVoiceprintMatched,
    confidence: session.utteranceVoiceprintConfidence,
    quality: session.utteranceVoiceprintQuality,
    frameCount: session.utteranceVoiceprintFrameCount,
    source: session.utteranceVoiceprintSource,
  });
}

function resetUtteranceVoiceprint(session: AudioSession): void {
  session.utteranceVoiceprintDecided = false;
  session.utteranceVoiceprintMatched = false;
  session.utteranceVoiceprintConfidence = 0;
  session.utteranceVoiceprintQuality = 0;
  session.utteranceVoiceprintFrameCount = 0;
  session.utteranceVoiceprintSpeakerLabel = null;
  session.utteranceVoiceprintSource = '';
  session.utteranceVoiceprintLastAt = 0;
}

function advanceVoiceprintUtterance(socket: Socket, session: AudioSession): void {
  session.voiceprintUtteranceEpoch += 1;
  resetUtteranceVoiceprint(session);
  socket.emit('voiceprint:utterance_reset', { epoch: session.voiceprintUtteranceEpoch });
}

async function waitForVoiceprintGate(session: AudioSession, timeoutMs = 1_100): Promise<boolean> {
  if (isVoiceprintGateOpen(session)) return true;
  const startedAt = Date.now();
  while (session.isActive && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 70));
    if (isVoiceprintGateOpen(session)) return true;
    // A short early sample can be negative and become reliable as the same
    // utterance accumulates. Keep the bounded synchronization window open for
    // a later result, but never borrow identity from another utterance.
  }
  return isVoiceprintGateOpen(session);
}

function getVoiceprintSpeakerMeta(session: AudioSession): {
  speakerLabel: string | null;
  speakerConfidence: number;
  speakerSource: string;
  speakerMatched: boolean;
} {
  const utteranceMatched = isVoiceprintGateOpen(session) && session.voiceprintRequired;
  const speakerMatched = Boolean(utteranceMatched && session.utteranceVoiceprintSpeakerLabel);
  return {
    speakerLabel: speakerMatched ? session.utteranceVoiceprintSpeakerLabel : null,
    speakerConfidence: utteranceMatched ? session.utteranceVoiceprintConfidence : 0,
    speakerSource: utteranceMatched ? session.utteranceVoiceprintSource : '',
    speakerMatched,
  };
}

function blockUnverifiedVoice(socket: Socket, session: AudioSession, reason: string): void {
  logger.info(`[Voiceprint] ${reason} (required=${session.voiceprintRequired}, epoch=${session.voiceprintUtteranceEpoch}, decided=${session.utteranceVoiceprintDecided}, matched=${session.utteranceVoiceprintMatched}, conf=${session.utteranceVoiceprintConfidence.toFixed(2)}, quality=${session.utteranceVoiceprintQuality.toFixed(2)}, frames=${session.utteranceVoiceprintFrameCount})`);
  session.accumulatedText = '';
  socket.emit('audio:voice_rejected', { reason: 'voiceprint_unverified' });
}

function handlePriorityVoiceStop(socket: Socket, session: AudioSession): void {
  const workContinues = session.isBackgroundWork && session.activeWorkStatus !== 'completed';
  const requestId = session.activeTurnRequestId;
  if (workContinues && requestId) session.suppressedSpeechRequestIds.add(requestId);
  if (workContinues) {
    interruptVoiceSpeech(session);
  } else {
    cancelActiveVoiceTurn(session);
  }
  socket.emit('audio:status', { status: 'interrupted', requestId });
  socket.emit('audio:interrupt-ack', { workContinues, requestId });
  socket.emit('audio:status', {
    status: 'listening',
    requestId,
    ...(workContinues ? { lane: 'work' } : {}),
  });
  resetSilenceTimer(session, socket);
}

function buildActiveVoiceWorkProgressReply(session: AudioSession, userText: string): string {
  const task = session.activeRoutingText.replace(/\s+/g, ' ').trim().slice(0, 32);
  const isEnglish = /[a-z]/i.test(userText) && !/[\u3400-\u9fff]/u.test(userText);
  const rawStep = session.activeWorkStep.replace(/\s+/g, ' ').trim().slice(0, 80);
  const toolStep = rawStep.match(/^(?:Running\s+)?([a-z][\w-]+?)(?:\s+(completed|failed))?$/i);
  const step = (() => {
    if (!toolStep) {
      if (/^Coordinating worker agents$/i.test(rawStep)) {
        return isEnglish ? 'coordinating the parallel work' : CN_VOICE_WORK_MESSAGES.coordinatingParallelWork;
      }
      if (!rawStep) return '';
      if (!isEnglish && !/[\u3400-\u9fff]/u.test(rawStep)) return CN_VOICE_WORK_MESSAGES.executingCurrentStep;
      return rawStep.slice(0, 36);
    }
    const toolName = toolStep[1].toLowerCase();
    const phase = toolStep[2]?.toLowerCase();
    const category = /cad|autocad|drawing/.test(toolName)
      ? ['the drawing', CN_VOICE_WORK_MESSAGES.drawingStep]
      : /browser|web/.test(toolName)
        ? ['the web step', CN_VOICE_WORK_MESSAGES.webStep]
        : /wechat|message|mail/.test(toolName)
          ? ['the message', CN_VOICE_WORK_MESSAGES.messageStep]
          : /knowledge|search|retrieve/.test(toolName)
            ? ['the research step', CN_VOICE_WORK_MESSAGES.researchStep]
            : /file|document|pdf|ppt|presentation|spreadsheet|excel/.test(toolName)
              ? ['the document step', CN_VOICE_WORK_MESSAGES.documentStep]
              : /desktop/.test(toolName)
                ? ['the desktop step', CN_VOICE_WORK_MESSAGES.desktopStep]
                : /client/.test(toolName)
                  ? ['the client check', CN_VOICE_WORK_MESSAGES.clientStep]
                  : ['the current step', CN_VOICE_WORK_MESSAGES.currentStep];
    if (isEnglish) {
      if (phase === 'completed') return `finishing ${category[0]}`;
      if (phase === 'failed') return `recovering from an issue in ${category[0]}`;
      return `working on ${category[0]}`;
    }
    if (phase === 'completed') return CN_VOICE_WORK_MESSAGES.completedStep(category[1]);
    if (phase === 'failed') return CN_VOICE_WORK_MESSAGES.failedStep(category[1]);
    return CN_VOICE_WORK_MESSAGES.runningStep(category[1]);
  })();
  if (isEnglish) {
    if (step) return `Still working on ${task || 'it'}; I'm ${step}.`;
    return `Still working on ${task || 'it'}; it hasn't stopped.`;
  }
  return step
    ? CN_VOICE_WORK_MESSAGES.progressWithStep(step)
    : session.isOrchestrating
      ? CN_VOICE_WORK_MESSAGES.coordinatingTask(task)
      : CN_VOICE_WORK_MESSAGES.continuingTask(task);
}

function stopVoiceWorkHeartbeat(session: AudioSession): void {
  if (!session.workHeartbeatTimer) return;
  clearInterval(session.workHeartbeatTimer);
  session.workHeartbeatTimer = null;
}

function emitVoiceWorkProgress(
  socket: Socket,
  session: AudioSession,
  requestId: string,
  phase: string,
  text?: string,
  heartbeat = false,
): void {
  if (session.activeTurnRequestId !== requestId) return;
  if (!heartbeat && session.activeTaskId) {
    try {
      updateConversationActionFocus({
        taskId: session.activeTaskId,
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        nextAction: session.activeWorkStep || text || phase,
        waitingFor: phase === 'waiting_confirmation' ? 'user_confirmation' : '',
      });
    } catch {}
  }
  socket.emit('audio:work_progress', {
    requestId,
    text: text || buildActiveVoiceWorkProgressReply(session, session.activeTurnText),
    phase,
    heartbeat,
    active: session.isProcessing && session.isBackgroundWork,
    at: new Date().toISOString(),
  });
}

function startVoiceWorkHeartbeat(socket: Socket, session: AudioSession, requestId: string): void {
  stopVoiceWorkHeartbeat(session);
  session.workHeartbeatTimer = setInterval(() => {
    if (
      !session.isActive
      || !session.isProcessing
      || !session.isBackgroundWork
      || session.activeTurnRequestId !== requestId
      || session.activeWorkStatus === 'completed'
    ) {
      stopVoiceWorkHeartbeat(session);
      return;
    }
    emitVoiceWorkProgress(
      socket,
      session,
      requestId,
      session.activeWorkStatus,
      undefined,
      true,
    );
  }, 8_000);
}

async function respondAlongsideActiveVoiceWork(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  kind: ReturnType<typeof classifyVoiceWorkInterruption>,
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
    if (kind === 'progress_query') {
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
      const preferred = getUserPreferredLLMConfig(session.userId, {
        maxTokens: 120,
        domain: session.domain,
        orgId: session.orgId,
      });
      const response = await makeLLMCall(
        [
          { role: 'system', content: sidecarPrompt },
          ...recentSideChat,
          { role: 'user', content: userText },
        ],
        [],
        preferred,
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
      !responseText
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
      cognitiveIntent: kind === 'new_work' ? 'queued_work' : kind,
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
          cognitiveIntent: kind,
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
          cognitiveIntent: kind,
          llmWasCalled,
          receivedAt: responseAt,
          timestamp: responseAt,
          domain: session.domain,
          orgId: session.orgId,
          skipActionContinuation: true,
        });
        socket.emit('chat:conversation_updated', {
          conversationId: conversation.id,
          agentId: session.agentId,
          source: 'voice_sidecar',
        });
      } catch (persistError: any) {
        logger.warn(`[Audio] Failed to persist active-work sidecar: ${persistError?.message || String(persistError)}`);
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
    if (!ttsProvider || !session.currentVoiceId || !session.isActive) return;
    const emotionVoice = (() => {
      try {
        return resolveEmotionVoice(session.currentVoiceId || 'longxiaochun_v3', loadEmotionalState(getVoiceStateKey(session)));
      } catch {
        return { voiceId: session.currentVoiceId || 'longxiaochun_v3' };
      }
    })();
    const speechGeneration = ++session.bgGeneration;
    session.ttsAbortController?.abort();
    session.ttsAbortController = controller;
    session.isSpeaking = true;
    ttsSpeakingCount++;
    ttsCountIncremented = true;
    const ttsResult = await synthesizeSpeech(responseText, {
      provider: ttsProvider,
      voiceId: emotionVoice.voiceId,
      speechRate: emotionVoice.speechRate,
      pitch: emotionVoice.pitch,
      volume: emotionVoice.volume,
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
      volumeGain: computeVolumeGain(),
      lane: 'conversation',
      requestId: workRequestId,
    });
  } catch (err: any) {
    if (err?.name !== 'AbortError') logger.warn(`[Audio Sidecar] ${err?.message || String(err)}`);
  } finally {
    if (session.sidecarAbortController === controller) session.sidecarAbortController = null;
    if (session.ttsAbortController === controller) session.ttsAbortController = null;
    if (session.sidecarGeneration === generation) session.isSpeaking = false;
    if (ttsCountIncremented) {
      const decay = () => { ttsSpeakingCount = Math.max(0, ttsSpeakingCount - 1); };
      const timer = setTimeout(decay, 3000);
      session.ttsDecayTimers.push(timer);
    }
  }
}

async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
): Promise<void> {
  if (!voiceAuthorized && !isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    return;
  }

  const pendingInterruptedTurn = session.pendingInterruptedTurn;
  const interruptedTurnAge = pendingInterruptedTurn
    ? Date.now() - pendingInterruptedTurn.interruptedAt
    : Number.POSITIVE_INFINITY;
  const interruptedActivityResponse = isVoiceCurrentActivityQuestion(userText)
    ? pendingInterruptedTurn
      && interruptedTurnAge >= 0
      && interruptedTurnAge <= 30_000
      ? CN_VOICE_FAST_PATH_MESSAGES.interruptedActivity(
          pendingInterruptedTurn.text.replace(/\s+/g, ' ').trim().slice(0, 60),
        )
      : CN_VOICE_FAST_PATH_MESSAGES.idleActivity
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

  const conversationTurn = getOrCreateConversationForTurn(
    session.userId,
    session.agentId,
    session.domain,
    session.orgId,
    { userText: actionIntentText },
  );
  const userObservedCompletion = isUserObservedTaskCompletion(
    actionIntentText,
    conversationTurn.conversation.actionContinuationState,
  );
  if (conversationTurn.rolledOver) {
    logger.info(
      `[Audio] Rolled over oversized conversation ${conversationTurn.previousConversationId} -> ${conversationTurn.conversation.id}`,
    );
    clearPendingConfirmation(session.userId);
  }

  session.isSpeaking = false;
  session.isProcessing = true;
  session.isBackgroundWork = !isCapabilityMetaQuestion(actionIntentText) && hasExplicitToolIntent(actionIntentText);
  session.activeWorkStatus = session.isBackgroundWork ? 'planning' : 'idle';
  session.activeWorkStep = '';
  session.activeWorkToolCalls = 0;
  const requestId = `voice_${randomUUID()}`;
  startVoiceLatencyTrace({
    requestId,
    provider: inputTiming.sttProvider,
    domain: session.domain,
    speechEndedAt: inputTiming.speechEndedAt,
    asrFinalAt: inputTiming.asrFinalAt,
    pipelineStartedAt: Date.now(),
  });
  markLatestUserTurn({
    userId: session.userId,
    domain: session.domain,
    orgId: session.orgId,
  }, requestId);
  const pipelineAbort = new AbortController();
  session.pipelineAbortController = pipelineAbort;
  session.activeTurnText = userText;
  session.activeTurnRequestId = requestId;
  session.activeRoutingText = actionIntentText;
  const isCurrentTurn = () => session.pipelineAbortController === pipelineAbort && !pipelineAbort.signal.aborted;
  let finalAgentResponseDelivered = false;
  const emitAgent = (event: string, payload: any = {}) => {
    if (session.activeTurnRequestId !== requestId) return;
    socket.emit(event, {
      ...payload,
      source: payload.source || 'voice',
      channel: payload.channel || 'voice',
      requestId,
    });
    if (event === 'agent:response' && payload.finalized === true) {
      finalAgentResponseDelivered = true;
    }
    if (
      session.pipelineAbortController !== pipelineAbort
      && (event === 'agent:error' || (event === 'agent:response' && payload.finalized === true))
    ) {
      session.activeTurnRequestId = null;
    }
  };
  emitAgent("agent:status", { status: "thinking", agentName: "Lumi" });
  socket.emit("audio:status", { status: "thinking", requestId });
  if (session.isBackgroundWork) {
    emitVoiceWorkProgress(socket, session, requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(socket, session, requestId);
  }
  const voiceScope = { domain: session.domain, orgId: session.orgId };
  const confirmationScope = buildVoiceConfirmationChannelScope({
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    channelId: socket.id,
    taskId: conversationTurn.conversation.actionContinuationState?.taskId,
  });
  const voiceStateKey = getVoiceStateKey(session);
  if (isConfirmationCancellation(userText)) clearPendingConfirmation(session.userId, confirmationScope);
  const pendingConfirmation = isExplicitConfirmationReply(userText)
    ? getPendingConfirmation(session.userId, confirmationScope)
    : null;
  const pendingConfirmationPrompt = pendingConfirmation
    ? formatPendingConfirmationPrompt(pendingConfirmation)
    : '';
  const recentProactiveSuggestion = getRecentProactiveSuggestion(session.userId);
  const shouldUseProactiveContext = Boolean(
    !conversationTurn.rolledOver
    && !interruptedMerge.usedInterruptedTurn
    && recentProactiveSuggestion
    && isVoiceReferentialFollowup(userText),
  );
  const proactiveContextPrompt = shouldUseProactiveContext && recentProactiveSuggestion
    ? formatProactiveSuggestionForPrompt(recentProactiveSuggestion)
    : '';
  let recentVoiceHistory: any[] = [];
  let actionContinuationBridge = '';
  let continuationOpenTarget: string | null = null;
  try {
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    recentVoiceHistory = getMessages(conversation.id, 30);
    actionContinuationBridge = buildRecentActionContinuationBridge(
      actionIntentText,
      recentVoiceHistory,
      conversation.actionContinuationState,
    );
    continuationOpenTarget = resolveRecentActionOpenTarget(
      actionIntentText,
      conversation.actionContinuationState,
    );
  } catch {}
  let voiceUserMessagePersisted = false;
  const persistVoiceUserMessage = (cognitiveIntent = 'voice_received') => {
    if (voiceUserMessagePersisted) return;
    addMessage({
      userId: session.userId,
      agentId: session.agentId,
      conversationId: conversationTurn.conversation.id,
      role: 'user',
      content: userText,
      personality: session.personalityId,
      mode: 'voice',
      source: 'voice',
      channel: 'voice',
      cognitiveIntent,
      llmWasCalled: false,
      receivedAt: userReceivedAt,
      timestamp: userReceivedAt,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      requestId,
      deferActionPreparation: true,
    });
    voiceUserMessagePersisted = true;
    socket.emit('chat:conversation_updated', {
      conversationId: conversationTurn.conversation.id,
      agentId: session.agentId,
      source: 'voice_received',
      requestId,
    });
  };
  // Once a verified final transcript is admitted to the execution lane it is
  // durable. Routing, model, tool, TTS, cancellation, or disconnect failures
  // may affect its result, but can no longer erase the user's instruction.
  persistVoiceUserMessage();
  const routedUserText = [actionIntentText, actionContinuationBridge, proactiveContextPrompt, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
  session.activeRoutingText = actionIntentText;
  let preMatchedQuickResult: Awaited<ReturnType<typeof matchQuickCommand>> = null;
  try {
    preMatchedQuickResult = shouldRunLegacyDirectExecution() ? await matchQuickCommand(
      continuationOpenTarget ? buildInternalOpenCommand(userText, continuationOpenTarget) : userText,
      session.userId,
      {
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      surface: 'voice',
      currentAppTarget: getRecoveredApplicationContinuationTarget(actionContinuationBridge),
      },
    ) : null;
  } catch {}
  const requestedModeHint = detectRequestedOperationMode(userText);
  const skipKnowledgeRetrieval = Boolean(preMatchedQuickResult)
    || Boolean(requestedModeHint)
    || isCapabilityMetaQuestion(userText)
    || hasClientActionOnlyIntent(userText)
    || isUserCorrectionOrExplanationQuestion(userText);
  const allowLocalFileWrites = shouldAllowVoiceLocalFileWriteForTurn(routedUserText);
  const localWriteIntentReason = allowLocalFileWrites
    ? `Current voice request explicitly asked Lumi to generate/export a local deliverable: "${userText.slice(0, 120)}"`
    : undefined;
  if (proactiveContextPrompt) {
    logger.info(`[Audio] Using recent proactive context for voice follow-up: type=${recentProactiveSuggestion?.type} action=${recentProactiveSuggestion?.action || 'none'}`);
    emitAgent('agent:proactive_context', {
      source: 'voice',
      type: recentProactiveSuggestion?.type,
      action: recentProactiveSuggestion?.action,
      context: recentProactiveSuggestion?.context || {},
    });
  }

  // Cross-session context is read-only and prefetched in parallel. A slow
  // knowledge source must not hold the spoken turn open indefinitely.
  let voiceMemories: any[] = [];
  const voiceRagKnowledge: string[] = [];
  let voiceOrganizationKnowledge = '';
  if (!skipKnowledgeRetrieval) {
    const ragAgentIds = Array.from(new Set([session.agentId, 'lumi'].filter(Boolean)));
    const readCacheScope = createReadOnlyCacheScope(session.userId, voiceScope.domain, voiceScope.orgId || '');
    const prefetch = await collectAnticipatoryContext([
      {
        key: 'memory',
        operation: 'read',
        sideEffectClass: 'none',
        cache: {
          scopeKey: readCacheScope,
          key: createReadOnlyCacheKey('memory', routedUserText),
          ttlMs: 30_000,
          prewarm: true,
        },
        run: () => queryMemories({
          userId: session.userId,
          query: routedUserText,
          limit: 5,
          minConfidence: 0.4,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
          evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
        }),
      },
      ...ragAgentIds.map(ragAgentId => ({
        key: `rag:${ragAgentId}`,
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        cache: {
          scopeKey: readCacheScope,
          key: createReadOnlyCacheKey('rag', ragAgentId, routedUserText),
          ttlMs: 60_000,
          prewarm: true,
        },
        run: () => retrieveChunks(session.userId, ragAgentId, routedUserText, 3, {
          domain: voiceScope.domain,
          orgId: voiceScope.domain === 'work' ? voiceScope.orgId : '',
        }),
      })),
      ...(voiceScope.domain === 'work' && voiceScope.orgId ? [{
        key: 'organization',
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        cache: {
          scopeKey: readCacheScope,
          key: createReadOnlyCacheKey('organization', voiceScope.orgId, routedUserText),
          ttlMs: 60_000,
          prewarm: true,
        },
        run: () => searchKnowledgeBase(voiceScope.orgId, routedUserText, { limit: 3, userId: session.userId }),
      }] : []),
    ], { deadlineMs: 1_300 });

    voiceMemories = Array.isArray(prefetch.values.memory) ? prefetch.values.memory : [];
    for (const ragAgentId of ragAgentIds) {
      const chunks = prefetch.values[`rag:${ragAgentId}`];
      if (!Array.isArray(chunks)) continue;
      for (const chunk of chunks) {
        const content = String((chunk as any)?.content || '').trim();
        if (content && !voiceRagKnowledge.includes(content)) voiceRagKnowledge.push(content);
        if (voiceRagKnowledge.length >= 5) break;
      }
      if (voiceRagKnowledge.length >= 5) break;
    }
    const organizationResults = prefetch.values.organization;
    if (Array.isArray(organizationResults)) {
      voiceOrganizationKnowledge = organizationResults
        .map((result: any) => `[${result.title}] ${result.chunk}`)
        .join('\n');
    }
    if (prefetch.failed.length > 0 || prefetch.timedOut.length > 0) {
      logger.warn(`[Audio] Read-only context prefetch partial: failed=${prefetch.failed.map(item => item.key).join(',') || 'none'} timedOut=${prefetch.timedOut.join(',') || 'none'} elapsedMs=${prefetch.elapsedMs}`);
    }
  } else {
    logger.info('[Audio] Skipped memory/RAG retrieval for deterministic or corrective voice turn');
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

  // Inject older summary/topic continuity only for a genuinely referential
  // utterance. Feeding a long task summary into every ordinary voice question
  // made completed app commands compete with the current sentence.
  let topicContext = '';
  const wantsHistoricalVoiceContext = Boolean(
    actionContinuationBridge
    || isVoiceReferentialFollowup(userText)
    // i18n-allow: history-recall recognition; not user-visible copy.
    || /(?:刚才|刚刚|之前|上次|以前|我们聊过|还记得)|\b(?:earlier|before|previously|last time|we discussed|remember)\b/iu.test(userText),
  );
  try {
    const convForTopic = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (wantsHistoricalVoiceContext) {
      const summary = getConversationSummary(convForTopic.id);
      if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
      const tc = getTopicContext(convForTopic.id);
      if (tc) topicContext += tc;
    }
  } catch {}

  const operationMode = (() => {
    try {
      return getStoredOperationMode(session.userId);
    } catch {}
    return 'assistant';
  })();
  const requestedMode = requestedModeHint;
  const executionPipeline = buildLumiExecutionPipeline({
    dispatch: {
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
    },
    registry: toolRegistry,
    personalityToolPolicy: personality.toolPolicy,
    actionTaskState: conversationTurn.conversation.actionContinuationState,
    traceText: actionIntentText,
    source: 'voice',
  });
  const turnDispatch = executionPipeline.turnIntent;
  const turnFlow = turnDispatch.flow;
  const effectiveOperationMode = turnFlow.effectiveOperationMode;
  const selfRepairTurn = turnFlow.selfRepairTurn;
  const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
  const workSurfaceRoute = turnFlow.workSurfaceRoute;
  const visionIntent = turnFlow.visionIntent;
  const exposeAgentWork = turnFlow.exposeAgentWork;
  const executionDecision = executionPipeline.execution;
  const capabilityMetaResponse = buildCapabilityMetaResponse({
    text: actionIntentText,
    operationMode: turnFlow.effectiveOperationMode,
    source: 'voice',
  });
  if (capabilityMetaResponse) {
    preMatchedQuickResult = { matched: true, responseText: capabilityMetaResponse };
  }
  if (!preMatchedQuickResult && clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicClientNavigationCommand(
      executionPipeline.normalizedIntent,
    );
  }
  if (!preMatchedQuickResult && !clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicExternalCommitConfirmationCommand(
      executionPipeline.normalizedIntent,
      userText,
    );
  }
  if (!preMatchedQuickResult && !clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicKnowledgeInspectionCommand(userText);
  }
  if (!preMatchedQuickResult && !clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicWorkTaskCreateCommand(userText);
  }
  if (!preMatchedQuickResult && !clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicWpsDocumentCommand(userText);
  }
  if (!preMatchedQuickResult && !clientActionOnlyTurn) {
    preMatchedQuickResult = buildDeterministicLocalDesktopNavigationCommand(
      executionPipeline.normalizedIntent,
      userText,
    );
  }
  session.isBackgroundWork = executionDecision.allowToolUse;
  session.activeWorkStatus = executionDecision.allowToolUse ? 'planning' : 'idle';
  if (executionDecision.allowToolUse && !session.workHeartbeatTimer) {
    emitVoiceWorkProgress(socket, session, requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(socket, session, requestId);
  } else if (!executionDecision.allowToolUse) {
    stopVoiceWorkHeartbeat(session);
  }
  const intentTrace = executionPipeline.intentTrace;
  const capabilitySelection = executionPipeline.capabilityPlan;
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'voice',
    text: turnFlow.routeText,
    flow: turnFlow,
    capabilitySelection,
    capabilityExecutionPlan: executionPipeline.executionPlan,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
  const routedToolPolicy = executionDecision.toolPolicy;
  const actionFollowupIntent = classifyConversationActionFollowupIntent(
    actionIntentText,
    conversationTurn.conversation.actionContinuationState,
  );
  const actionTaskExecution = turnFlow.conceptualCapabilityQuestion
    ? { state: null, kind: 'conversation' as const }
    : userObservedCompletion
    ? {
        state: conversationTurn.conversation.actionContinuationState || null,
        kind: 'conversation' as const,
      }
    : prepareConversationActionExecution({
        conversationId: conversationTurn.conversation.id,
        userId: session.userId,
        userText: actionIntentText,
        requestId,
        toolPolicy: routedToolPolicy,
        forceResume: Boolean(pendingConfirmation || actionFollowupIntent === 'execute'),
      });
  if (actionTaskExecution.state?.taskId) {
    executionPipeline.executionPlan = bindCapabilityExecutionPlanTask(
      executionPipeline.executionPlan,
      actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: conversationTurn.conversation.id,
      userId: session.userId,
      plan: executionPipeline.executionPlan,
    });
  }
  if (actionTaskExecution.kind === 'new') {
    // A concrete replacement task invalidates an older confirmation boundary
    // on this exact voice channel.
    clearPendingConfirmation(session.userId, confirmationScope);
  }
  if (
    actionTaskExecution.state?.taskId
    && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
  ) {
    session.activeTaskConversationId = conversationTurn.conversation.id;
    session.activeTaskRequestId = requestId;
    session.activeTaskId = actionTaskExecution.state.taskId;
    try {
      updateConversationActionFocus({
        taskId: actionTaskExecution.state.taskId,
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        commitment: actionTaskExecution.state.goal,
        nextAction: actionIntentText,
        resumePoint: actionTaskExecution.kind === 'resume'
          ? actionTaskExecution.state.assistantState || actionTaskExecution.state.latestBlocker || ''
          : '',
      });
    } catch {}
  }
  const priorTaskRecords = actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  if (
    executionDecision.allowToolUse
    && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(
      conversationTurn.conversation.id,
      session.userId,
      'executing',
      { requestId },
    );
  }
  logger.info(`[Audio] tool gate: ${executionDecision.allowToolUse ? 'enabled' : 'chat-only'} mode=${operationMode} effective=${effectiveOperationMode} surface=${turnFlow.surface} clientActionOnly=${clientActionOnlyTurn} selfRepair=${selfRepairTurn} capabilityLane=${capabilitySelection.lane} trace=${intentTrace.summary} route=${executionDecision.toolRoute ? `${executionDecision.toolRoute.toolNames.length}/${executionDecision.toolRoute.totalAvailable}` : 'none'}`);
  emitAgent('agent:intent_trace', intentTrace);
  if (executionDecision.toolRoute) {
    emitAgent('agent:tool_route', {
      categories: executionDecision.toolRoute.categories,
      reasons: executionDecision.toolRoute.reasons,
      toolNames: executionDecision.toolRoute.toolNames,
      totalAvailable: executionDecision.toolRoute.totalAvailable,
      truncated: executionDecision.toolRoute.truncated,
      source: 'voice',
      trace: intentTrace,
    });
  }
  emitAgent('agent:capability_selection', {
    lane: capabilitySelection.lane,
    primary: capabilitySelection.primary,
    reasons: capabilitySelection.reasons,
    preferredTools: capabilitySelection.preferredTools,
    source: 'voice',
  });
  if (desktopExecutionPolicy.applies) {
    emitAgent('agent:desktop_execution_policy', {
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
  const voiceSystemPrompt = fullPersonalityPrompt + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + proactiveContextOverlay + actionContinuationOverlay + clientSelfPrompt + topicContext + organizationKnowledgeOverlay + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay + (executionDecision.allowToolUse ? `\n${GENERIC_TOOL_PLANNING_PROMPT}` : '');

  const userLLMPrefs = getScopedPreferredLLM(session.userId, voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = userLLMPrefs.model;
  const reasoningRoutePolicy = {
    selectionMode: userLLMPrefs.selectionMode,
    fallbackCandidates: userLLMPrefs.fallbackCandidates,
    allowCloudFallback: userLLMPrefs.allowCloudFallback,
    conversationId: conversationTurn.conversation.id,
    requestId,
    interactionId: requestId,
    source: 'voice',
  };
  const scheduleVoiceSummary = (conversationId: string) => {
    scheduleConversationSummary({
      userId: session.userId,
      provider,
      model: voiceModel,
      ...reasoningRoutePolicy,
      conversationId,
      source: 'voice_summary',
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      llmGetters,
      log: {
        info: message => logger.info(message),
        warn: (message, error) => logger.warn(message, error),
      },
    });
  };
  let voiceAssistantMessagePersisted = false;
  const persistVoiceAssistantMessage = (
    conversationId: string,
    text: string,
    options: {
      toolCalls?: ToolExecutionRecord[];
      cognitiveIntent?: string;
      llmWasCalled?: boolean;
      source?: string;
    } = {},
  ) => {
    if (voiceAssistantMessagePersisted || !String(text || '').trim()) return;
    addMessage({
      userId: session.userId,
      agentId: session.agentId,
      conversationId,
      role: 'assistant',
      content: text,
      personality: session.personalityId,
      mode: 'voice',
      source: options.source || 'voice',
      channel: 'voice',
      toolCalls: options.toolCalls?.length ? options.toolCalls : undefined,
      cognitiveIntent: options.cognitiveIntent || 'voice_response',
      llmWasCalled: options.llmWasCalled === true,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      requestId,
    });
    voiceAssistantMessagePersisted = true;
    scheduleVoiceSummary(conversationId);
    socket.emit('chat:conversation_updated', {
      conversationId,
      agentId: session.agentId,
      source: options.source || 'voice',
      requestId,
    });
  };
  const persistSidecarConversation = (conversationId: string) => {
    const history = session.sidecarHistory.splice(0);
    for (const item of history) {
      if (!item.persist) continue;
      addMessage({
        userId: session.userId,
        agentId: session.agentId,
        conversationId,
        role: 'user',
        content: item.userText,
        personality: session.personalityId,
        mode: 'voice',
        source: 'voice_sidecar',
        channel: 'voice',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: false,
        receivedAt: item.userReceivedAt,
        timestamp: item.userReceivedAt,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
      });
      addMessage({
        userId: session.userId,
        agentId: session.agentId,
        conversationId,
        role: 'assistant',
        content: item.responseText,
        personality: session.personalityId,
        mode: 'voice',
        source: 'voice_sidecar',
        channel: 'voice',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: item.llmWasCalled,
        receivedAt: item.responseAt,
        timestamp: item.responseAt,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
      });
    }
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
    if (session.isBackgroundWork) {
      session.activeWorkStatus = 'executing';
      session.activeWorkStep = payload.error !== undefined
        ? `${payload.name} failed`
        : payload.result !== undefined
          ? `${payload.name} completed`
          : `Running ${payload.name}`;
      if (payload.result !== undefined || payload.error !== undefined) session.activeWorkToolCalls++;
      emitVoiceWorkProgress(
        socket,
        session,
        requestId,
        payload.error !== undefined
          ? 'blocked'
          : payload.result !== undefined
            ? 'step_completed'
            : 'executing',
      );
    }
    const normalized = { ...payload, args: payload.arguments, source: 'voice' };
    emitAgent("agent:tool_call", normalized);
    emitAgent("agent:tool", normalized);
  };
  const directDesktopRelayTools = new Set([
    'client_action',
    'desktop_capability_status',
    'desktop_system_info',
    'desktop_list_files',
    'desktop_list_apps',
    'desktop_path_info',
    'desktop_open',
    'desktop_show_lumi_window',
    'desktop_run_command',
    'desktop_active_window',
    'desktop_window_control',
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
    taskId: requestId,
    requestSocket: socket,
    emitToolLifecycle,
    formatResultForLifecycle: formatToolResultForUi,
    cancelOnRequestSocketDisconnect: true,
    signal: pipelineAbort.signal,
  });

  let pendingConfirmationCreatedThisTurn: ReturnType<typeof recordPendingConfirmation> | null = null;
  const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
    if (
      pendingConfirmation
      && consumePendingConfirmation(
        session.userId,
        pendingConfirmation.id,
        toolName,
        args,
        confirmationScope,
      )
    ) {
      logger.info(`[Audio] Consumed one-time confirmation for "${toolName}".`);
      return true;
    }
    if (canAutoApproveAction(toolName, args, { actionIntent: routedUserText })) return true;
    // One task turn owns one immutable confirmation boundary. The model may
    // re-plan after a denial, but it cannot silently replace the action the
    // user is being asked to approve.
    if (pendingConfirmationCreatedThisTurn) return false;
    const pending = recordPendingConfirmation(session.userId, toolName, args, 'voice', {
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      channelId: socket.id,
      taskId: actionTaskExecution.state?.taskId,
      actionIntent: actionIntentText,
    });
    pendingConfirmationCreatedThisTurn = pending;
    const confirmationMessage = CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(
      actionTaskExecution.state?.goal || actionIntentText,
    );
    setConversationActionExecutionStatus(
      conversationTurn.conversation.id,
      session.userId,
      'waiting_confirmation',
      {
        assistantState: confirmationMessage,
        requestId,
      },
    );
    logger.warn(`[Audio] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
    return false;
  };

  const toolContext = {
    userId: session.userId,
    taskId: actionTaskExecution.state?.taskId || requestId,
    conversationId: conversationTurn.conversation.id,
    turnId: requestId,
    requestId,
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
      if (session.isBackgroundWork && step.trim()) {
        session.activeWorkStatus = 'executing';
        session.activeWorkStep = step.trim().slice(0, 160);
        emitVoiceWorkProgress(socket, session, requestId, 'executing');
      }
      if (shouldForwardPreFinalizationProgress(step)) {
        emitAgent("agent:progress", { text: step, agentName: "Lumi" });
      }
    },
    toolPolicy: routedToolPolicy,
    desktopExecutionTracker,
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
      emitAgent('agent:task_execution_writeback', {
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
  let turnSpeechGeneration = -1;
  let turnSpeechAbort: AbortController | null = null;
  let ttsQueue: Promise<void> = Promise.resolve();
  type SynthesizedSpeech = Awaited<ReturnType<typeof synthesizeSpeech>>;
  let speculativeSpeech: {
    text: string;
    controller: AbortController;
    promise: Promise<{ result?: SynthesizedSpeech; error?: unknown }>;
  } | null = null;

  const ensureTurnSpeechController = () => {
    if (
      !turnSpeechAbort
      || turnSpeechAbort.signal.aborted
      || turnSpeechGeneration !== session.bgGeneration
    ) {
      if (session.ttsAbortController && session.ttsAbortController !== turnSpeechAbort) {
        session.ttsAbortController.abort();
      }
      turnSpeechAbort = new AbortController();
      turnSpeechGeneration = session.bgGeneration;
      session.ttsAbortController = turnSpeechAbort;
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
      || executionDecision.allowToolUse
      || deferCompletionSpeech
      || !ttsProvider
      || !session.currentVoiceId
      || pipelineAbort?.signal.aborted
    ) return;
    const firstSentence = extractFirstCompleteSpeechSentence(responseText);
    if (!firstSentence) return;
    const controller = new AbortController();
    pipelineAbort?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = synthesizeSpeech(firstSentence, {
      provider: ttsProvider,
      voiceId: emotionVoice.voiceId,
      speechRate: emotionVoice.speechRate,
      pitch: emotionVoice.pitch,
      volume: emotionVoice.volume,
      signal: controller.signal,
      allowFallback: false,
    }).then(result => {
      markVoiceLatencyMilestone(requestId, 'firstTtsReadyAt');
      return { result };
    }).catch(error => ({ error }));
    speculativeSpeech = { text: firstSentence, controller, promise };
  };

  const flushSentence = (sentence: string): Promise<number> => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || !session.isActive || session.suppressedSpeechRequestIds.has(requestId)) return Promise.resolve(0);
    if (!/[a-zA-Z一-鿿㐀-䶿\d]/.test(txt)) return Promise.resolve(0);
    if (!ttsProvider || !session.currentVoiceId) {
      logger.warn('[Audio TTS] No configured provider or voice; delivering text without synthetic fallback speech');
      return Promise.resolve(0);
    }
    const speech = ensureTurnSpeechController();
    if (speech.controller.signal.aborted) return Promise.resolve(0);
    sentenceIdx++;
    let resolvePlayback: (value: number) => void = () => {};
    const playbackDone = new Promise<number>(resolve => { resolvePlayback = resolve; });
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (speech.controller.signal.aborted) {
        resolvePlayback(0);
        return;
      }
      if (session.bgGeneration !== speech.generation) {
        resolvePlayback(0);
        return;
      }
      session.isSpeaking = true;
      ttsSpeakingCount++;
      try {
        let ttsResult: SynthesizedSpeech;
        if (speculativeSpeech?.text === txt) {
          const prepared = await speculativeSpeech.promise;
          if (!prepared.result) throw prepared.error || new Error('Speculative TTS failed');
          ttsResult = prepared.result;
          speculativeSpeech = null;
        } else {
          ttsResult = await synthesizeSpeech(txt, {
            provider: ttsProvider,
            voiceId: emotionVoice.voiceId,
            speechRate: emotionVoice.speechRate,
            pitch: emotionVoice.pitch,
            volume: emotionVoice.volume,
            signal: speech.controller.signal,
            allowFallback: false,
          });
        }
        if (!speech.controller.signal.aborted && session.bgGeneration === speech.generation) {
          markVoiceLatencyMilestone(requestId, 'firstTtsReadyAt');
          socket.emit("audio:status", { status: "speaking", requestId });
          addEchoText(txt, voiceEchoScope(session));
          const volumeGain = computeVolumeGain();
          socket.emit("audio:response", { buffer: ttsResult.audioBuffer, volumeGain, requestId });
          const playbackMs = estimatePlaybackMs(ttsResult.audioBuffer, txt);
          setTimeout(() => resolvePlayback(0), playbackMs);
        } else {
          resolvePlayback(0);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          resolvePlayback(0);
          return;
        }
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
        resolvePlayback(0);
      } finally {
        if (session.bgGeneration === speech.generation) session.isSpeaking = false;
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
    if (session.isBackgroundWork) {
      stopVoiceWorkHeartbeat(session);
      session.activeWorkStatus = pendingConfirmationCreatedThisTurn
        ? 'waiting_confirmation'
        : 'completed';
      session.sidecarAbortController?.abort();
      session.sidecarAbortController = null;
      session.sidecarGeneration++;
    }
    if (session.suppressedSpeechRequestIds.has(requestId)) return;
    session.bgGeneration++;
    const sentences = String(text || '').split(/(?<=[。！？.!?\n])/u);
    const firstFinalSentence = String(sentences[0] || '').trim();
    if (speculativeSpeech && speculativeSpeech.text !== firstFinalSentence) {
      speculativeSpeech.controller.abort();
      speculativeSpeech = null;
    }
    for (const sentence of sentences) {
      if (pipelineAbort?.signal.aborted) break;
      flushSentence(sentence);
    }
  };

  const deterministicConversationResponse = (() => {
    if (isConversationExecutionFactQuestion(actionIntentText)) {
      return {
        text: formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId: conversationTurn.conversation.id,
          userId: session.userId,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
        }), actionIntentText),
        intent: 'execution_facts',
        source: 'voice_conversation_execution_facts',
      };
    }
    const corrected = resolveExactConversationCorrection(actionIntentText, recentVoiceHistory);
    return corrected
      ? { text: corrected, intent: 'exact_correction', source: 'voice_exact_correction' }
      : null;
  })();
  if (deterministicConversationResponse) {
    responseText = deterministicConversationResponse.text;
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: deterministicConversationResponse.source,
      finalized: true,
      blocked: false,
      reason: deterministicConversationResponse.intent,
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      cognitiveIntent: deterministicConversationResponse.intent,
      llmWasCalled: false,
      source: deterministicConversationResponse.source,
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    persistSidecarConversation(conversationTurn.conversation.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.activeWorkStatus = 'idle';
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
    return;
  }

  if (userObservedCompletion) {
    const conversation = conversationTurn.conversation;
    persistVoiceUserMessage('task_user_observation');
    const updatedConversation = getOrCreateActiveConversation(
      session.userId,
      session.agentId,
      voiceScope.domain,
      voiceScope.orgId,
    );
    responseText = getConversationActionStatus(
      updatedConversation.id,
      session.userId,
      actionIntentText,
      updatedConversation.actionContinuationState,
    );
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_task_user_observation',
      finalized: true,
      blocked: false,
      reason: '',
    });
    persistVoiceAssistantMessage(conversation.id, responseText, {
      cognitiveIntent: 'task_user_observation',
      llmWasCalled: false,
      source: 'voice_task_user_observation',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    session.activeWorkStatus = pendingConfirmationCreatedThisTurn
      ? 'waiting_confirmation'
      : 'completed';
    socket.emit('chat:conversation_updated', { conversationId: conversation.id, agentId: session.agentId, source: 'voice' });
    return;
  }

  if (actionFollowupIntent === 'status') {
    responseText = getConversationActionStatus(
      conversationTurn.conversation.id,
      session.userId,
      actionIntentText,
      conversationTurn.conversation.actionContinuationState,
    );
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_task_status',
      finalized: true,
      blocked: false,
      reason: '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      cognitiveIntent: 'task_status',
      llmWasCalled: false,
      source: 'voice_task_status',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conversation = conversationTurn.conversation;
    persistVoiceUserMessage('task_status');
    persistSidecarConversation(conversation.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.activeWorkStatus = 'idle';
    socket.emit('chat:conversation_updated', { conversationId: conversation.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
    return;
  }

  // A short confirmation utterance is a continuation of the exact pending
  // action, not a fresh chat turn. Execute the stored tool/arguments directly
  // so the model cannot forget, rewrite, or merely print the tool protocol.
  if (pendingConfirmation) {
    const confirmedTask = pendingConfirmation.actionIntent || actionIntentText;
    const confirmedArgs = pendingConfirmation.exactArgs || {};
    const confirmationConsumed = consumePendingConfirmation(
      session.userId,
      pendingConfirmation.id,
      pendingConfirmation.toolName,
      confirmedArgs,
      confirmationScope,
    );
    const confirmationRecordId =
      `voice-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.isBackgroundWork = true;
    session.activeWorkStatus = 'executing';
    session.activeWorkStep = `Running ${pendingConfirmation.toolName}`;
    if (!isDirectDesktopTool(pendingConfirmation.toolName)) {
      emitToolLifecycle({
        correlationId: confirmationRecordId,
        name: pendingConfirmation.toolName,
        arguments: confirmedArgs,
      });
    }
    const confirmationRecord = await executeToolCall({
      registry: toolRegistry,
      id: confirmationRecordId,
      name: pendingConfirmation.toolName,
      arguments: confirmedArgs,
      context: {
        ...toolContext,
        toolPolicy: routedToolPolicy,
        userConfirmed: true,
        requestConfirmation: undefined,
        actionIntent: confirmedTask,
        routedTaskText: confirmedTask,
      },
      preflight: () => confirmationConsumed
        ? { allowed: true, arguments: confirmedArgs }
        : {
            allowed: false,
            arguments: confirmedArgs,
            reason: 'The one-time confirmation expired before execution.',
          },
    });
    if (!isCurrentTurn()) return;
    if (!isDirectDesktopTool(confirmationRecord.name)) {
      if (confirmationRecord.error) {
        emitToolLifecycle({
          correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
          name: confirmationRecord.name,
          arguments: confirmedArgs,
          error: confirmationRecord.error,
        });
      } else {
        emitToolLifecycle({
          correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
          name: confirmationRecord.name,
          arguments: confirmedArgs,
          result: formatToolResultForUi(confirmationRecord.result),
        });
      }
    }
    const confirmationSucceeded = toolRecordSucceeded(confirmationRecord);
    let confirmationRecords: ToolExecutionRecord[] = [confirmationRecord];
    let confirmationCandidate = confirmationSucceeded
      ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
      : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
          recordsToTaskReceipts([confirmationRecord])[0]?.error
            || confirmationRecord.error
            || confirmationRecord.result,
        );

    const completionAfterConfirmedStep = taskCompletionFromReceipts(
      confirmedTask,
      recordsToTaskReceipts(taskAwareRecords([confirmationRecord])),
    );
    if (confirmationSucceeded && !completionAfterConfirmedStep.complete && isCurrentTurn()) {
      // Confirmation is a boundary inside the same task, not the end of the
      // task. Continue the remaining plan immediately with the exact confirmed
      // receipt in context; a later hard boundary will stop once again.
      const receiptNote = [
        'The user-confirmed step below has already executed successfully in this turn.',
        `Tool: ${confirmationRecord.name}`,
        `Arguments: ${JSON.stringify(confirmationRecord.arguments || {})}`,
        `Result: ${compactToolResultForModel(confirmationRecord.name, confirmationRecord.result)}`,
        'Do not repeat that step. Continue the original task until it is complete, blocked, or reaches another confirmation boundary.',
      ].join('\n');
      const continuation = await runWithTools(
        [
          { role: 'system', content: voiceSystemPrompt },
          { role: 'system', content: receiptNote },
          { role: 'user', content: confirmedTask },
        ],
        toolRegistry,
        {
          provider,
          model: voiceModel,
          userId: session.userId,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
          signal: pipelineAbort.signal,
          ...reasoningRoutePolicy,
        },
        record => {
          if (!record?.name) return;
          if (!isDirectDesktopTool(record.name)) {
            emitToolLifecycle({
              correlationId: record.id || `voice-confirmation-resume-${Date.now()}`,
              name: record.name,
              arguments: record.arguments || {},
              result: record.error ? undefined : formatToolResultForUi(record.result),
              error: record.error,
            });
          }
        },
        Math.max(1, routedToolPolicy.maxIterations || 5),
        llmGetters.getDeepSeek,
        llmGetters.getGemini,
        llmGetters.getOpenAI,
        llmGetters.getAnthropic,
        llmGetters.getQwen,
        undefined,
        {
          ...toolContext,
          actionIntent: confirmedTask,
          routedTaskText: confirmedTask,
          toolPolicy: routedToolPolicy,
        },
        llmGetters.getOllama,
        llmGetters.getLmStudio,
        llmGetters.getArk,
        llmGetters.getXiaomi,
        llmGetters.getKimi,
        llmGetters.getGlm,
        llmGetters.getRelay,
      );
      if (!isCurrentTurn()) return;
      confirmationRecords = [confirmationRecord, ...(continuation.toolCalls || [])];
      confirmationCandidate = pendingConfirmationCreatedThisTurn
        ? CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(confirmedTask)
        : continuation.text || confirmationCandidate;
    }
    confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, desktopExecutionTracker);
    const confirmedFinal = finalizeLumiResponse({
      taskText: confirmedTask,
      responseText: confirmationCandidate,
      toolRecords: taskAwareRecords(confirmationRecords),
      source: 'voice_confirmation',
      flow: { ...turnFlow, routeText: confirmedTask },
    });
    responseText = confirmedFinal.text;
    if (confirmedFinal.notification) emitAgent('agent:notification', confirmedFinal.notification);
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_confirmation',
      finalized: true,
      blocked: confirmedFinal.blocked,
      reason: confirmedFinal.reason || '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      toolCalls: confirmationRecords,
      cognitiveIntent: confirmedFinal.blocked ? 'work_product_guard' : 'confirmation',
      llmWasCalled: confirmationRecords.length > 1,
      source: 'voice_confirmation',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;

    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    persistVoiceUserMessage('confirmation');
    persistSidecarConversation(conversation.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    session.activeWorkStatus = pendingConfirmationCreatedThisTurn
      ? 'waiting_confirmation'
      : 'completed';
    socket.emit('chat:conversation_updated', { conversationId: conversation.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
    if (!confirmedFinal.blocked) {
      persistVoiceLearning(responseText, {
          toolRecords: confirmationRecords,
        sourceInteractionId: `voice_confirmation_${Date.now()}`,
        logLabel: 'voice confirmation',
      });
    }
    return;
  }

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
      emitAgent('agent:notification', finalizedRecentAction.notification);
    }
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_action_history',
      finalized: true,
      blocked: finalizedRecentAction.blocked,
      reason: finalizedRecentAction.reason || '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      cognitiveIntent: finalizedRecentAction.blocked ? 'work_product_guard' : 'action_history',
      llmWasCalled: false,
      source: 'voice_action_history',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    persistVoiceUserMessage(turnDispatch.boundary);
    persistSidecarConversation(conversation.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    if (session.ttsAbortController === turnSpeechAbort) session.ttsAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';
    socket.emit('chat:conversation_updated', { conversationId: conversation.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
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
      const workflowResult = await executeSkillWorkflowAdapter({
        workflow: specialWorkflow,
        plan: executionPipeline.executionPlan,
        registry: toolRegistry,
        context: toolContext,
        options: {
          socket,
          userText,
          userId: session.userId,
          desktopRelay,
          // The workflow returns its narration as responseText. TTS is queued
          // only after the shared finalizer has inspected all tool receipts.
          speak: async () => 0,
          voiceScope,
          isCancelled: () => Boolean(pipelineAbort?.signal.aborted) || !session.isActive,
        },
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
      toolRecords: taskAwareRecords(toolResults),
      source: specialWorkflow.source,
      flow: turnFlow,
    });
    responseText = finalizedWorkflow.text;
    if (finalizedWorkflow.notification) {
      emitAgent('agent:notification', finalizedWorkflow.notification);
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
    emitAgent("agent:response", {
      text: responseText,
      agentName: "Lumi",
      source: specialWorkflow.source,
      finalized: true,
      blocked: finalizedWorkflow.blocked,
      reason: finalizedWorkflow.reason || '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      toolCalls: toolResults,
      cognitiveIntent: finalizedWorkflow.blocked ? 'work_product_guard' : (specialWorkflow.id || 'skill_workflow'),
      llmWasCalled: false,
      source: specialWorkflow.source,
    });
    queueFinalizedSpeech(workflowSpeechText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    persistVoiceUserMessage(turnDispatch.boundary);
    persistSidecarConversation(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit("audio:status", { status: "listening", requestId });
    emitAgent("agent:status", { status: "idle" });
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
      emitAgent('agent:notification', {
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
        emitAgent('agent:notification', finalizedMode.notification);
      }
      persistVoiceTakeoverExecution(responseText, {
        toolRecords: [modeToolRecord],
        source: 'voice_mode',
        sourceInteractionId: `voice_mode_${Date.now()}`,
        finalizationBlocked: finalizedMode.blocked,
        assistantTextTrusted: !finalizedMode.blocked,
        finalizationReason: finalizedMode.reason,
      });
      emitAgent("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice_mode",
        finalized: true,
        blocked: finalizedMode.blocked,
        reason: finalizedMode.reason || '',
      });
      persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
        toolCalls: [modeToolRecord],
        cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : 'operation_mode',
        llmWasCalled: false,
        source: 'voice_mode',
      });
      queueFinalizedSpeech(responseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      persistVoiceUserMessage(turnDispatch.boundary);
      persistSidecarConversation(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening", requestId });
      emitAgent("agent:status", { status: "idle" });
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

  const foregroundWeChatReadArgs = buildForegroundMessagingArguments('read', executionPipeline.normalizedIntent);
  const foregroundWeChatSendArgs = buildForegroundMessagingArguments('send', executionPipeline.normalizedIntent);

  try {
    const quickResult = preMatchedQuickResult;
    if (!foregroundWeChatReadArgs && !foregroundWeChatSendArgs && quickResult?.matched && (!quickResult.toolCall || executionDecision.allowToolUse)) {
      logger.info(`[Audio] Quick command: "${userText}" → "${quickResult.responseText.slice(0, 50)}"`);
      let quickResponseText = quickResult.responseText;
      let quickToolResult = '';
      let quickToolError: string | undefined;
      let quickToolRecord: ToolExecutionRecord | null = null;
      const quickToolRecords: ToolExecutionRecord[] = [];
      if (quickResult.toolCall && session.isActive) {
        const correlationId = `qc-${Date.now()}`;
        const shouldEmitQuickTool = !isDirectDesktopTool(quickResult.toolCall.name);
        quickToolRecord = await executeToolCall({
          registry: toolRegistry,
          id: correlationId,
          name: quickResult.toolCall.name,
          arguments: quickResult.toolCall.arguments,
          context: {
            ...toolContext,
            toolPolicy: buildQuickCommandToolPolicy(routedToolPolicy, quickResult.toolCall.name),
          },
        });
        quickToolRecords.push(quickToolRecord);
        quickToolResult = quickToolRecord.result || '';
        quickToolError = quickToolRecord.error;
        if (quickToolRecord.error && shouldEmitQuickTool) {
          emitAgent("agent:tool_call", {
            correlationId,
            name: quickResult.toolCall.name,
            arguments: quickResult.toolCall.arguments,
            error: quickToolRecord.error,
          });
        } else if (shouldEmitQuickTool) {
          emitAgent("agent:tool_call", {
            correlationId,
            name: quickResult.toolCall.name,
            arguments: quickResult.toolCall.arguments,
            result: quickToolRecord.result?.slice(0, 500) || '',
          });
        }
        if (quickResult.formatToolResult) {
          quickResponseText = quickResult.formatToolResult(quickToolResult, quickToolError);
        } else if (quickToolError) {
          quickResponseText = `\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\uff1a${quickToolError}`;
        }
        if (!quickToolRecord.error && quickResult.followUpToolCalls?.length) {
          for (const followUp of quickResult.followUpToolCalls) {
            const followUpCorrelationId = `qc-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const followUpRecord = await executeToolCall({
              registry: toolRegistry,
              id: followUpCorrelationId,
              name: followUp.name,
              arguments: followUp.arguments,
              context: {
                ...toolContext,
                source: 'voice_quick_command_verification',
                toolPolicy: buildQuickCommandToolPolicy(routedToolPolicy, followUp.name),
              },
            });
            quickToolRecords.push(followUpRecord);
            if (!isDirectDesktopTool(followUp.name)) {
              emitAgent("agent:tool_call", {
                correlationId: followUpCorrelationId,
                name: followUp.name,
                arguments: followUp.arguments,
                ...(followUpRecord.error
                  ? { error: followUpRecord.error }
                  : { result: formatToolResultForUi(followUpRecord.result) }),
              });
            }
          }
        }
      }
      const quickFinalized = finalizeLumiResponse({
        taskText: actionIntentText,
        responseText: quickResponseText,
        toolRecords: quickToolRecords,
        source: 'voice',
        flow: turnFlow,
      });
      quickResponseText = quickFinalized.text;
      if (quickFinalized.notification) emitAgent('agent:notification', quickFinalized.notification);
      persistVoiceTakeoverExecution(quickResponseText, {
        toolRecords: quickToolRecords,
        source: 'voice_quick_command',
        sourceInteractionId: `voice_quick_${Date.now()}`,
        finalizationBlocked: quickFinalized.blocked,
        assistantTextTrusted: !quickFinalized.blocked,
        finalizationReason: quickFinalized.reason,
      });
      emitAgent("agent:response", {
        text: quickResponseText,
        agentName: "Lumi",
        source: "quick_command",
        finalized: true,
        blocked: quickFinalized.blocked,
        reason: quickFinalized.reason || '',
      });
      persistVoiceAssistantMessage(conversationTurn.conversation.id, quickResponseText, {
        toolCalls: quickToolRecords.length ? quickToolRecords : undefined,
        cognitiveIntent: quickFinalized.blocked ? 'work_product_guard' : 'quick_command',
        llmWasCalled: false,
        source: 'quick_command',
      });
      queueFinalizedSpeech(quickResponseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      responseText = quickResponseText;
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      persistVoiceUserMessage(turnDispatch.boundary);
      persistSidecarConversation(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening", requestId });
      emitAgent("agent:status", { status: "idle" });
      if (!quickFinalized.blocked) {
        persistVoiceLearning(responseText, {
          toolRecords: quickToolRecords,
          sourceInteractionId: `voice_quick_${Date.now()}`,
          logLabel: 'voice quick command',
        });
      }
      return;
    }
  } catch (qcErr: any) {
    logger.warn(`[Audio] Quick command check failed, falling through to LLM: ${qcErr.message}`);
  }

  // Voice and chat share the same deterministic read route. Inbound language
  // such as “张勇给我发了什么” can never fall through to the send capability.
  if (foregroundWeChatReadArgs && executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn) {
    const toolName = 'wechat_read_recent_chat';
    const correlationId = `voice-wechat-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let toolRecord: ToolExecutionRecord = {
      id: correlationId,
      name: toolName,
      arguments: foregroundWeChatReadArgs,
      result: '',
    };
    try {
      const foregroundExecution = await executeForegroundMessagingAction({
        action: 'read',
        normalizedIntent: executionPipeline.normalizedIntent,
        executionPlan: executionPipeline.executionPlan,
        registry: toolRegistry,
        correlationId,
        arguments: foregroundWeChatReadArgs,
        context: toolContext,
        onLifecycle: event => emitToolLifecycle({
          correlationId: event.correlationId,
          name: event.name,
          arguments: event.arguments,
          ...(event.phase === 'finish' && event.result ? { result: formatToolResultForUi(event.result) } : {}),
          ...(event.error ? { error: event.error } : {}),
        }),
      });
      toolRecord = foregroundExecution.record;
      if (toolRecord.error) throw new Error(toolRecord.error);
      const parsed = foregroundExecution.parsed;
      const contact = String(foregroundWeChatReadArgs.contact || '').trim();
      const summary = String(parsed.contentSummary || '').trim();
      const evidence = String(parsed.uiSnapshotPreview || '').slice(0, 1200);
      responseText = parsed.read && summary
        ? contact
          ? `我已经定位到你和${contact}的微信聊天。可见最近内容如下：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
          : `我已经读到当前微信聊天的可见最近内容：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
        : parsed.read
          ? contact
            ? `我已经定位到你和${contact}的微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
            : `我已经定位到当前微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
          : `这次还没完成。卡住的位置：微信前台聊天读取。${String(parsed.visionError || parsed.note || '没有拿到可读的聊天内容证据。')}`; // i18n-allow: reviewed Chinese messaging-read blocker.
    } catch (readErr: any) {
      toolRecord.error = readErr?.message || String(readErr);
      responseText = `这次还没完成。卡住的位置：微信前台聊天读取：${toolRecord.error}。我不会把只打开或聚焦微信说成已读到聊天内容。`; // i18n-allow: reviewed Chinese messaging-read failure receipt.
    }

    const directFinal = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: [toolRecord],
      source: 'voice',
      flow: turnFlow,
    });
    responseText = directFinal.text;
    if (directFinal.notification) emitAgent('agent:notification', directFinal.notification);
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: [toolRecord],
      source: 'voice_foreground_messaging_read',
      sourceInteractionId: `voice_wechat_read_${Date.now()}`,
      finalizationBlocked: directFinal.blocked,
      assistantTextTrusted: !directFinal.blocked,
      finalizationReason: directFinal.reason,
    });
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_foreground_messaging_read',
      finalized: true,
      blocked: directFinal.blocked,
      reason: directFinal.reason || '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      toolCalls: [toolRecord],
      cognitiveIntent: directFinal.blocked ? 'work_product_guard' : 'messaging_read',
      llmWasCalled: false,
      source: 'voice_foreground_messaging_read',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    persistVoiceUserMessage(turnDispatch.boundary);
    persistSidecarConversation(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    if (session.ttsAbortController === turnSpeechAbort) session.ttsAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
    if (!directFinal.blocked) {
      persistVoiceLearning(responseText, {
        toolRecords: [toolRecord],
        sourceInteractionId: `voice_wechat_read_${Date.now()}`,
        logLabel: 'voice foreground messaging read',
      });
    }
    return;
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
    let directSendVerified = false;
    try {
      const foregroundExecution = await executeForegroundMessagingAction({
        action: 'send',
        normalizedIntent: executionPipeline.normalizedIntent,
        executionPlan: executionPipeline.executionPlan,
        registry: toolRegistry,
        correlationId,
        arguments: foregroundWeChatSendArgs,
        context: toolContext,
        onLifecycle: event => emitToolLifecycle({
          correlationId: event.correlationId,
          name: event.name,
          arguments: event.arguments,
          ...(event.phase === 'finish' && event.result ? { result: formatToolResultForUi(event.result) } : {}),
          ...(event.error ? { error: event.error } : {}),
        }),
      });
      Object.assign(toolRecord, foregroundExecution.record);
      if (toolRecord.error) throw new Error(toolRecord.error);
      if (!isCurrentTurn()) return;
      const parsed = foregroundExecution.parsed;
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
      emitAgent('agent:notification', directFinal.notification);
    }
    persistVoiceTakeoverExecution(responseText, {
      toolRecords: [toolRecord],
      source: 'voice_foreground_messaging',
      sourceInteractionId: `voice_wechat_send_${Date.now()}`,
      finalizationBlocked: directFinal.blocked,
      assistantTextTrusted: !directFinal.blocked,
      finalizationReason: directFinal.reason,
    });
    emitAgent('agent:response', {
      text: responseText,
      agentName: 'Lumi',
      source: 'voice_foreground_messaging',
      finalized: true,
      blocked: directFinal.blocked,
      reason: directFinal.reason || '',
    });
    persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
      toolCalls: [toolRecord],
      cognitiveIntent: directFinal.blocked ? 'work_product_guard' : 'messaging',
      llmWasCalled: false,
      source: 'voice_foreground_messaging',
    });
    queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    persistVoiceUserMessage(turnDispatch.boundary);
    persistSidecarConversation(conv.id);
    session.isProcessing = false;
    session.isSpeaking = false;
    if (session.ttsAbortController === turnSpeechAbort) session.ttsAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
    socket.emit('audio:status', { status: 'listening', requestId });
    emitAgent('agent:status', { status: 'idle' });
    if (!directFinal.blocked) {
      persistVoiceLearning(responseText, {
        toolRecords: [toolRecord],
        sourceInteractionId: `voice_wechat_send_${Date.now()}`,
        logLabel: 'voice foreground messaging',
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
      const classifierModel = voiceModel;
      const result = await makeLLMCall(
        [{ role: 'system', content: prompt }, { role: 'user', content: userText }],
        [],
        { provider, model: classifierModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, maxTokens: 60, ...reasoningRoutePolicy },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );
      recordTokenUsage(session.userId, result.routing?.selectedProvider || provider, result.routing?.selectedModel || classifierModel, result.usage, `voice_cls_${Date.now()}`, 'voice');
      return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
    };

    const cognition = await processInput(routedUserText, cognitiveCtx, llmClassifier, toolContext);
    if (!isCurrentTurn()) return;

    if (cognition.directToolExecuted && cognition.responseText) {
      // Path A: Cognitive engine handled this directly — no LLM needed
      const directRecords = cognition.toolRecords
        || (cognition.toolRecord ? [cognition.toolRecord] : []);
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
      emitAgent("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice_cognition_direct",
        finalized: true,
        blocked: directFinal.blocked,
        reason: directFinal.reason || '',
      });
      persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
        toolCalls: directRecords,
        cognitiveIntent: directFinal.blocked ? 'work_product_guard' : cognition.intent.category,
        llmWasCalled: cognition.llmWasCalled,
        source: 'voice_cognition_direct',
      });
      queueFinalizedSpeech(responseText);
      await Promise.allSettled(ttsPromises);
      if (!isCurrentTurn()) return;
      // Persist
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      persistVoiceUserMessage(cognition.intent.category);
      persistSidecarConversation(conv.id);
      session.isProcessing = false;
      session.isSpeaking = false;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening", requestId });
      emitAgent("agent:status", { status: "idle" });
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
    const effectiveModel = voiceModel;
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
        emitAgent("agent:status", { status: "thinking", agentName: "Lumi", phase: exposeAgentWork ? 'orchestrator' : 'background' });
        // This is a fixed acknowledgement, not model-generated result text.
        // Keep it explicitly non-terminal if low-latency spoken feedback is allowed.
        const voiceLeadIn = "\u6536\u5230\u3002"; // i18n-allow: reviewed neutral pre-finalization voice acknowledgement.
        if (!deferCompletionSpeech && shouldForwardPreFinalizationProgress(voiceLeadIn)) {
          flushSentence(voiceLeadIn);
        }
        session.isOrchestrating = true;
        session.activeWorkStatus = 'orchestrating';
        session.activeWorkStep = 'Coordinating worker agents';

        const voiceModelRecovery = actionTaskExecution.state?.taskId
          ? getConversationModelExecutionRecovery({
              conversationId: conversationTurn.conversation.id,
              userId: session.userId,
              taskId: actionTaskExecution.state.taskId,
            })
          : null;
        const orchResult = await runOrchestratedTask(
          routedUserText,
          {
            userId: session.userId,
            personalityId: session.personalityId,
            domain: voiceScope.domain,
            orgId: voiceScope.orgId,
            desktopRelay,
            toolPolicy: routedToolPolicy,
            taskId: actionTaskExecution.state?.taskId,
            desktopExecutionTracker,
            resumeNodeReceipts: voiceModelRecovery?.receipts,
            isCancelled: () => pipelineAbort?.signal.aborted ?? false,
          },
          { provider, model: effectiveModel, ...reasoningRoutePolicy },
          llmGetters,
          exposeAgentWork && !deferCompletionSpeech
            ? (msg) => {
                if (shouldForwardPreFinalizationProgress(msg)) {
                  emitAgent("agent:chunk", { text: msg, agentName: "Lumi" });
                }
              }
            : undefined,
          (record, meta) => {
            session.activeWorkStatus = 'executing';
            session.activeWorkStep = record.error
              ? `${record.name} failed`
              : record.result !== undefined
                ? `${record.name} completed`
                : `Running ${record.name}`;
            if (isTerminalOrchestrationToolEvent(record)) {
              session.activeWorkToolCalls++;
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
            emitAgent("agent:tool_call", {
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
          if (actionTaskExecution.state?.taskId) {
            persistConversationModelExecutionResult({
              conversationId: conversationTurn.conversation.id,
              userId: session.userId,
              taskId: actionTaskExecution.state.taskId,
              workflowResult: orchResult.workflowResult,
            });
          }
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
      const voiceHistory: NormalizedMessage[] = normalizeVoiceHistory(recentMsgs);

      const messages: any[] = [
        { role: 'system', content: voiceSystemPrompt },
        ...voiceHistory,
        { role: 'user', content: routedUserText },
      ];

      voiceToolLoop: for (let iter = 0; iter < maxIterations; iter++) {
      if (pipelineAbort?.signal.aborted) break;

      logger.info(`[Audio] LLM iter ${iter + 1}/${maxIterations}: provider=${provider} model=${effectiveModel}`);
      const toolDeclarations = executionDecision.allowToolUse
        ? toolRegistry.getToolDeclarationsForPolicy(routedToolPolicy)
        : [];

      const streamResult = await makeLLMCallStreaming(
        messages as NormalizedMessage[],
        toolDeclarations,
        { provider, model: effectiveModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, signal: pipelineAbort?.signal, ...reasoningRoutePolicy },
        (chunk: string) => {
          if (chunk) markVoiceLatencyMilestone(requestId, 'firstModelTokenAt');
          responseText += chunk;
          maybeStartSpeculativeSpeech();
          if (!deferCompletionSpeech) {
            const safeText = modelTextGate.push(chunk);
            if (safeText) {
              emitAgent("agent:chunk", { text: safeText, agentName: "Lumi" });
            }
          }
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );
      if (!isCurrentTurn()) return;

      const plannedToolCalls = streamResult.toolCalls?.length
        ? normalizePlannedToolScope(
            streamResult.toolCalls.map((call, index) => ({
              ...call,
              id: call.id || `voice_call_${iter}_${index}_${Date.now().toString(36)}`,
            })),
            toolRegistry,
            turnFlow.routeText,
          )
        : [];

      messages.push({
        role: 'assistant',
        content: streamResult.text || null,
        ...(plannedToolCalls.length ? { toolCalls: plannedToolCalls } : {}),
        reasoningContent: streamResult.reasoningContent,
      });

      // Record token usage for this streaming call
      recordTokenUsage(session.userId, streamResult.routing?.selectedProvider || provider, streamResult.routing?.selectedModel || effectiveModel, streamResult.usage, `voice_stream_${Date.now()}`, 'voice');

      if (plannedToolCalls.length === 0) {
        if (
          iter === 0
          && toolResults.length === 0
          && hasRelevantEvidenceTool(
            toolRegistry,
            turnFlow.routeText,
            toolDeclarations.map(declaration => declaration.function.name),
          )
        ) {
          messages.push({ role: 'system', content: GENERIC_TOOL_REPLAN_PROMPT });
          responseText = '';
          continue;
        }
        break;
      }

      const toolSig = JSON.stringify(plannedToolCalls.map(tc => ({ n: tc.name, a: tc.arguments })));
      if (toolSig === previousToolSig) { logger.info('[Audio] Duplicate tools, breaking'); break; }
      previousToolSig = toolSig;

      for (const tc of plannedToolCalls) {
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

        const executionRecord = await executeToolCall({
          registry: toolRegistry,
          id: tc.id,
          name: tc.name,
          arguments: executionArguments,
          context: toolContext,
          preflight: () => currentAppGuard.allowed
            ? { allowed: true, arguments: executionArguments }
            : {
                allowed: false,
                arguments: executionArguments,
                reason: currentAppGuard.reason,
              },
        });
        if (!isCurrentTurn()) return;
        toolResults.push(executionRecord);

        if (!isDirectDesktopTool(tc.name)) {
          if (executionRecord.error) {
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: executionArguments, error: executionRecord.error });
          } else {
            const short = typeof executionRecord.result === 'string'
              ? executionRecord.result.slice(0, toolResultPreviewLimit)
              : JSON.stringify(executionRecord.result).slice(0, toolResultPreviewLimit);
            emitToolLifecycle({ correlationId: cid, name: tc.name, arguments: executionArguments, result: short });
          }
        }

        messages.push({
          role: 'tool',
          content: executionRecord.error
            ? `Error: ${executionRecord.error}`
            : compactToolResultForModel(tc.name, executionRecord.result),
          toolCallId: tc.id,
          name: tc.name,
        });

        // A confirmation denial is a hard task boundary. Do not let the model
        // re-plan, replace the pending action, or run later calls from the same
        // batch before the user has confirmed the exact stored arguments.
        if (pendingConfirmationCreatedThisTurn || isConfirmationBlockedToolRecord(executionRecord)) {
          break voiceToolLoop;
        }
      }
    }
    } // end if (!usedOrchestrator)

    if (!isCurrentTurn()) return;

    if (pendingConfirmationCreatedThisTurn) {
      responseText = CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(
        actionTaskExecution.state?.goal || actionIntentText,
      );
    }

    modelTextGate.finish();
    const finalizedDesktopRecords = withDesktopExecutionReceipt(toolResults, desktopExecutionTracker);
    if (finalizedDesktopRecords.length > toolResults.length) {
      toolResults.push(...finalizedDesktopRecords.slice(toolResults.length));
    }
    const finalResponse = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText,
      toolRecords: taskAwareRecords(toolResults),
      source: 'voice',
      flow: turnFlow,
    });
    responseText = finalResponse.text;
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
      if (finalResponse.notification) emitAgent("agent:notification", finalResponse.notification);
      if (actionTaskExecution.state?.taskId && turnFlow.allowToolUseForTurn) {
        setConversationActionExecutionStatus(conversationTurn.conversation.id, session.userId, 'blocked', {
          blocker: finalResponse.reason || 'The current work product did not pass final verification.',
          assistantState: responseText,
          requestId: '',
        });
      }
    }

    persistVoiceTakeoverExecution(responseText, {
      toolRecords: toolResults,
      source: 'voice',
      sourceInteractionId: `voice_main_${Date.now()}`,
      finalizationBlocked: finalResponse.blocked,
      assistantTextTrusted: !finalResponse.blocked,
      finalizationReason: finalResponse.reason,
    });

    if (responseText) {
      logger.info(`[Audio] Response: "${responseText.slice(0, 80)}" (${toolResults.length} tool calls)`);
      emitAgent("agent:response", {
        text: responseText,
        agentName: "Lumi",
        source: "voice",
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
      });
      persistVoiceAssistantMessage(conversationTurn.conversation.id, responseText, {
        toolCalls: toolResults,
        cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : cognition.intent.category,
        llmWasCalled: true,
      });
    }

    // Candidate model/orchestrator text is never spoken before this point, so
    // TTS always receives the complete shared-finalizer result exactly once.
    if (responseText) queueFinalizedSpeech(responseText);
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;

    // Persist
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (!conv.title) {
      conv.title = userText.slice(0, 50);
      writeDB(readDB());
    }
    persistVoiceUserMessage(cognition.intent.category);
    persistSidecarConversation(conv.id);
    // The assistant terminal record was committed before TTS. Playback or
    // disconnect failures must never make a completed/blocked task disappear.
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
      if (finalAgentResponseDelivered) {
        logger.warn('[Audio] Post-response persistence failed; suppressing a contradictory UI error');
      } else {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        const failureDetail = formatCnToolFailureDetail(err?.message || String(err));
        try {
          setConversationActionExecutionStatus(
            conversationTurn.conversation.id,
            session.userId,
            'blocked',
            {
              blocker: failureDetail,
              assistantState: failureText,
              requestId,
            },
          );
        } catch {}
        emitAgent("agent:response", {
          text: failureText,
          agentName: 'Lumi',
          source: 'voice_error',
          finalized: true,
          blocked: true,
          reason: 'voice_processing_failed',
        });
        persistVoiceAssistantMessage(conversationTurn.conversation.id, failureText, {
          toolCalls: toolResults,
          cognitiveIntent: 'voice_processing_failed',
          llmWasCalled: false,
          source: 'voice_error',
        });
        queueFinalizedSpeech(failureText);
        await Promise.allSettled(ttsPromises);
      }
    }
  } finally {
    speculativeSpeech?.controller.abort();
    speculativeSpeech = null;
    desktopRelay.releaseControlLease('voice_turn_complete');
    // An older aborted pipeline must never clear the state/controllers that
    // already belong to a newer barge-in turn.
    if (session.pipelineAbortController === pipelineAbort) {
      if (
        session.activeTaskConversationId
        && session.activeTaskRequestId === requestId
      ) {
        try {
          settleConversationActionExecutionRequest(
            session.activeTaskConversationId,
            session.userId,
            requestId,
          );
        } catch (settleError: any) {
          logger.warn(`[Audio] Failed to settle task request ${requestId}: ${settleError?.message || String(settleError)}`);
        }
        session.activeTaskConversationId = null;
        session.activeTaskRequestId = null;
        session.activeTaskId = null;
      }
      session.sidecarAbortController?.abort();
      session.sidecarAbortController = null;
      session.sidecarGeneration++;
      session.sidecarHistory = [];
      session.isSpeaking = false;
      session.isProcessing = false;
      session.isBackgroundWork = false;
      session.activeWorkStatus = 'idle';
      session.activeWorkStep = '';
      session.activeWorkToolCalls = 0;
      stopVoiceWorkHeartbeat(session);
      if (session.ttsAbortController === turnSpeechAbort) session.ttsAbortController = null;
      session.pipelineAbortController = null;
      session.activeTurnText = '';
      session.activeRoutingText = '';

      if (session.isActive) {
        resetSilenceTimer(session, socket);
        socket.emit("audio:status", { status: "listening", requestId });
        emitAgent("agent:status", { status: "idle" });
      }
      session.activeTurnRequestId = null;
      session.suppressedSpeechRequestIds.delete(requestId);
    }
  }
}

async function runVoiceInputPipeline(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
): Promise<void> {
  try {
    await processVoiceInput(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming);
  } catch (err: any) {
    logger.error('[Voice Error]:', err);
    const failedRequestId = session.activeTurnRequestId;
    const queuedWork = session.inputQueue.slice();
    let conversationId = session.activeTaskConversationId || '';
    let terminalResponseAlreadyPersisted = false;
    try {
      if (!conversationId) {
        conversationId = getOrCreateActiveConversation(
          session.userId,
          session.agentId,
          session.domain,
          session.orgId,
        ).id;
      }
      const receivedAtMs = new Date(userReceivedAt).getTime();
      terminalResponseAlreadyPersisted = getMessages(conversationId, 4).some((message: any) => (
        message?.role === 'assistant'
        && Number.isFinite(receivedAtMs)
        && new Date(message?.timestamp || 0).getTime() >= receivedAtMs
      ));
      if (!terminalResponseAlreadyPersisted) {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        addMessage({
          userId: session.userId,
          agentId: session.agentId,
          conversationId,
          role: 'assistant',
          content: failureText,
          personality: session.personalityId,
          mode: 'voice',
          source: 'voice_error',
          channel: 'voice',
          cognitiveIntent: 'voice_processing_failed',
          llmWasCalled: false,
          domain: session.domain,
          orgId: session.orgId,
        });
        setConversationActionExecutionStatus(
          conversationId,
          session.userId,
          'blocked',
          {
            blocker: formatCnToolFailureDetail(err?.message || String(err)),
            assistantState: failureText,
            requestId: failedRequestId || undefined,
          },
        );
        socket.emit('agent:response', {
          text: failureText,
          source: 'voice_error',
          channel: 'voice',
          requestId: failedRequestId,
          finalized: true,
          blocked: true,
          reason: 'voice_processing_failed',
        });
        socket.emit('audio:work_progress', {
          requestId: failedRequestId,
          text: failureText,
          phase: 'blocked',
        });
        socket.emit('chat:conversation_updated', {
          conversationId,
          agentId: session.agentId,
          source: 'voice_error',
        });
      }
    } catch (persistError: any) {
      logger.warn(`[Audio] Failed to persist outer pipeline error: ${persistError?.message || String(persistError)}`);
    }
    cancelActiveVoiceTurn(session, false, true);
    session.activeTaskConversationId = null;
    session.activeTaskRequestId = null;
    session.activeTaskId = null;
    session.inputQueue = queuedWork;
    socket.emit('audio:status', { status: 'listening', requestId: failedRequestId || undefined });
  } finally {
    if (!session.isActive || session.isProcessing || session.inputQueue.length === 0) return;
    const next = session.inputQueue.shift();
    if (!next) return;

    // Reserve the lane before yielding so a new transcript cannot replace the
    // queued action in the small handoff window between two work turns.
    session.isProcessing = true;
    socket.emit('audio:work_started', {
      text: next.text,
      queuedAt: next.queuedAt,
      remaining: session.inputQueue.length,
    });
    setImmediate(() => {
      void runVoiceInputPipeline(
        socket,
        session,
        next.text,
        llmGetters,
        sensoryFn,
        io,
        next.queuedAt,
        next.voiceAuthorized,
      );
    });
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
      cancelActiveVoiceTurn(session);
    }
    session.isActive = true;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.activeWorkStatus = 'idle';
    session.activeWorkStep = '';
    session.activeWorkToolCalls = 0;
    session.sidecarAbortController?.abort();
    session.sidecarAbortController = null;
    session.sidecarGeneration++;
    session.sidecarHistory = [];
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.lastSpeechEndedAt = 0;
    session.lastSpeechStartedAt = 0;
    session.endpointSilenceMs = 850;
    session.lastAcceptedCommandKey = '';
    session.lastAcceptedCommandAt = 0;
    session.lastAcceptedCommandChunkAt = 0;
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
    session.voiceprintUtteranceEpoch += 1;
    resetUtteranceVoiceprint(session);
    socket.emit('voiceprint:utterance_reset', { epoch: session.voiceprintUtteranceEpoch });
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
        session.sttSession = createResilientStreamingSession(
          { provider: sttProvider, language, interimResults: true },
          {
            onRecovering: ({ attempt, delayMs, error }) => {
              if (!session.isActive) return;
              logger.warn(`[Audio] STT connection recovering (attempt=${attempt}, delayMs=${delayMs}): ${error.message}`);
              socket.emit('audio:status', {
                status: 'connecting',
                reason: 'stt_recovering',
                attempt,
                delayMs,
              });
            },
            onRecovered: ({ attempt }) => {
              if (!session.isActive) return;
              logger.info(`[Audio] STT connection recovered after attempt ${attempt}`);
              if (!session.isProcessing && !session.isSpeaking) {
                socket.emit('audio:status', { status: 'listening', reason: 'stt_recovered' });
              }
            },
          },
        );
        const callbackSttSession = session.sttSession;
        const callbackSessionId = session.sessionId;
        resetSilenceTimer(session, socket);

        session.sttSession.onResult(async (result) => {
          if (!isCurrentVoiceInputSource({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            callbackSessionId,
            currentSttSession: session.sttSession,
            callbackSttSession,
          })) {
            logger.info(`[Audio] Ignored stale STT callback for session ${callbackSessionId}`);
            return;
          }
          if (result.speechStarted) {
            session.lastSpeechStartedAt = Date.now();
            session.lastSpeechEndedAt = 0;
          }
          if (result.speechFinal) session.lastSpeechEndedAt = Date.now();
          const immediateText = String(result.text || '').trim();
          if (
            immediateText
            && !session.transcriptionOnly
            && isVoiceCallEndCommand(immediateText)
          ) {
            logger.info(`[Audio] Voice-call end command recognized (${result.isFinal ? 'final' : 'interim'})`);
            session.accumulatedText = '';
            cancelActiveVoiceTurn(session);
            resetUtteranceVoiceprint(session);
            socket.emit('audio:end-call-request');
            return;
          }
          if (
            immediateText
            && !session.transcriptionOnly
            && isPureInterruptCommand(immediateText)
          ) {
            logger.info(`[Audio] Priority stop recognized (${result.isFinal ? 'final' : 'interim'})`);
            session.accumulatedText = '';
            handlePriorityVoiceStop(socket, session);
            return;
          }
          if (result.text && result.isFinal) {
            const asrFinalAt = Date.now();
            const speechEndedAt = session.lastSpeechEndedAt > 0
              ? Math.min(session.lastSpeechEndedAt, asrFinalAt)
              : asrFinalAt;
            const speechDurationMs = session.lastSpeechStartedAt > 0
              ? Math.max(0, speechEndedAt - session.lastSpeechStartedAt)
              : undefined;
            session.endpointSilenceMs = computeAdaptiveEndpointSilenceMs({
              transcript: result.text,
              speechDurationMs,
              previousSilenceMs: session.endpointSilenceMs,
            });
            session.sttSession?.updateEndpointing?.(session.endpointSilenceMs);
            if (speechEndedAt > 0) {
              recordLatency('stt', asrFinalAt - speechEndedAt);
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
            const text = normalizeSpeechCommand(session.accumulatedText);
            session.accumulatedText = '';
            if (!text) return;

            // ── Filter filler words: single-char interjections ──
            const isFiller = /^[嗯啊哦呃哼唉呀哈呵嗨喂诶唔嘶啧哎哦哟嘿嘛哇啦嘞][。！？.!?，,～~]*$/.test(text);
            if (isFiller || isVoiceFiller(text)) {
              logger.info(`[Audio] Ignored filler (${text.length} chars)`);
              advanceVoiceprintUtterance(socket, session);
              return;
            }
            if (isSpeechClearlyDirectedAwayFromLumi(text)) {
              logger.info(`[Audio] Ignored speech explicitly directed to another person (${text.length} chars)`);
              advanceVoiceprintUtterance(socket, session);
              return;
            }
            // ── Filter pure noise (no CJK, no letters, no digits) ──
            const hasContent = /[a-zA-Z一-鿿㐀-䶿\d]/.test(text);
            if (!hasContent) {
              logger.info(`[Audio] Ignored pure noise (${text.length} chars)`);
              advanceVoiceprintUtterance(socket, session);
              return;
            }

            // TTS echo is not an authorization failure. Remove it before the
            // voiceprint gate so self speech cannot mutate the call state.
            if (isEchoText(text, session.isSpeaking, voiceEchoScope(session))) {
              logger.info(`[Audio] Echo cancelled during speech (${text.length} chars)`);
              advanceVoiceprintUtterance(socket, session);
              return;
            }

            let voiceAuthorized = session.transcriptionOnly || isVoiceprintGateOpen(session);
            if (!session.transcriptionOnly && !isVoiceprintGateOpen(session)) {
              const verifiedAfterSync = await waitForVoiceprintGate(session);
              if (!verifiedAfterSync) {
                blockUnverifiedVoice(socket, session, 'Ignored transcript before command/barge-in');
                advanceVoiceprintUtterance(socket, session);
                resetSilenceTimer(session, socket);
                return;
              }
              voiceAuthorized = true;
            }
            const transcriptSpeakerMeta = getVoiceprintSpeakerMeta(session);
            advanceVoiceprintUtterance(socket, session);
            const commandKey = speechCommandKey(text);
            const duplicateActiveFinal = isRepeatedVoiceFinal({
              commandKey,
              lastCommandKey: session.lastAcceptedCommandKey,
              currentChunkAt: session.lastChunkTime,
              lastAcceptedChunkAt: session.lastAcceptedCommandChunkAt,
              lastAcceptedAt: session.lastAcceptedCommandAt,
              laneActive: session.isProcessing || session.isSpeaking || Boolean(session.bargeinTimer),
            });
            if (duplicateActiveFinal) {
              logger.info(`[Audio] Ignored duplicate final transcript (${text.length} chars)`);
              socket.emit('audio:confirm', { text });
              resetSilenceTimer(session, socket);
              return;
            }
            session.lastAcceptedCommandKey = commandKey;
            session.lastAcceptedCommandAt = Date.now();
            session.lastAcceptedCommandChunkAt = session.lastChunkTime;
            if (session.isProcessing || session.isSpeaking) {
              const activeWorkRunning = session.isBackgroundWork && session.activeWorkStatus !== 'completed';
              if (activeWorkRunning) {
                const confirmsPendingAction = isExplicitConfirmationReply(text)
                  && Boolean(getPendingConfirmation(session.userId, {
                    source: 'voice',
                    domain: session.domain,
                    orgId: session.orgId,
                    channelId: socket.id,
                  }));
                if (confirmsPendingAction) {
                  logger.info('[Audio] Confirmation continues the pending action instead of entering the side-chat lane');
                  // Replace only the transport owner. The durable task and its
                  // exact pending action remain intact for the confirmation
                  // turn that starts immediately below.
                  reservePriorityVoiceHandoff(session, false);
                  socket.emit('audio:status', { status: 'interrupted' });
                  socket.emit('audio:interrupt-ack', { workContinues: false });
                  // Fall through to the normal pipeline, which executes the
                  // exact one-time pending action deterministically.
                } else {
                const activeWorkDecision = classifyActiveVoiceWorkInput(
                  session.activeRoutingText,
                  text,
                  { hasExplicitToolIntent: hasExplicitToolIntent(text) },
                );
                const interruptionKind = activeWorkDecision.kind;
                logger.info(`[Audio] Work-lane interruption=${interruptionKind} (${text.length} chars)`);
                if (interruptionKind === 'cancel_work') {
                  try {
                    const activeConversation = getOrCreateActiveConversation(
                      session.userId,
                      session.agentId,
                      session.domain,
                      session.orgId,
                    );
                    cancelConversationActionExecution(activeConversation.id, session.userId);
                  } catch {}
                  cancelActiveVoiceTurn(session);
                  socket.emit("audio:status", { status: "interrupted" });
                  socket.emit("audio:interrupt-ack", { workContinues: false });
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
                if (interruptionKind === 'modify_work') {
                  // Replace the transport turn so the running model cannot
                  // keep acting on stale instructions, but preserve the
                  // durable task id, receipts, permission snapshot, and
                  // pending confirmation for the corrected continuation.
                  reservePriorityVoiceHandoff(session, true);
                  socket.emit("audio:status", { status: "interrupted" });
                  socket.emit("audio:interrupt-ack", { workContinues: false });
                  // Fall through: the correction is merged into a replacement work turn.
                } else {
                  const workRequestId = session.activeTurnRequestId;
                  interruptVoiceSpeech(session);
                  socket.emit("audio:status", { status: "interrupted" });
                  socket.emit("audio:interrupt-ack", { workContinues: true, requestId: workRequestId });
                  if (interruptionKind === 'stop_speaking') {
                    socket.emit("audio:status", { status: "listening", requestId: workRequestId, lane: 'work' });
                    resetSilenceTimer(session, socket);
                    return;
                  }
                  if (activeWorkDecision.queueIncomingWork) {
                    // An unrelated command arriving during work is queued by
                    // default. Silent replacement made multi-step tasks stop at
                    // step one whenever the user spoke again. Explicit
                    // correction/cancellation phrases still take their own
                    // branches above.
                    const duplicate = session.inputQueue.some(item => speechCommandKey(item.text) === commandKey);
                    if (!duplicate) session.inputQueue.push({ text, queuedAt: new Date().toISOString(), voiceAuthorized });
                    socket.emit('audio:work_queued', {
                      text,
                      queuePosition: session.inputQueue.findIndex(item => speechCommandKey(item.text) === commandKey) + 1,
                      activeRequestId: workRequestId,
                    });
                    socket.emit("audio:confirm", { text });
                    void respondAlongsideActiveVoiceWork(socket, session, text, llmGetters, interruptionKind);
                    resetSilenceTimer(session, socket);
                    return;
                  } else {
                    socket.emit("audio:confirm", { text });
                    void respondAlongsideActiveVoiceWork(socket, session, text, llmGetters, interruptionKind);
                    resetSilenceTimer(session, socket);
                    return;
                  }
                }
                }
              } else if (session.isSpeaking) {
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
                logger.info(`[Audio] Barge-in during processing (${text.length} chars)`);
                cancelActiveVoiceTurn(session, !isPureInterruptCommand(text));
                socket.emit("audio:status", { status: "interrupted" });
                socket.emit("audio:interrupt-ack", {});
                if (isPureInterruptCommand(text)) {
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
              }
            }

            // Echo confirmation — brief window for user to see what was heard and interrupt if wrong
            socket.emit("audio:confirm", { text });
            logger.info(`[Audio] Accepted transcript (${text.length} chars)`);

            if (session.transcriptionOnly) {
              socket.emit("audio:transcript", { text, isFinal: true, ...transcriptSpeakerMeta });
              socket.emit("audio:status", { status: "listening" });
              resetSilenceTimer(session, socket);
              return;
            }

            // Yield just long enough for the confirmation event to render. The
            // streaming microphone lane remains open, so a fixed 600 ms grace
            // period only made every accepted command feel sluggish without
            // adding meaningful interruption safety.
            session.bargeinTimer = setTimeout(() => {
              session.bargeinTimer = null;
              if (!session.isActive) return;
              void runVoiceInputPipeline(
                socket,
                session,
                text,
                llmGetters,
                sensoryFn,
                io,
                new Date(asrFinalAt).toISOString(),
                voiceAuthorized,
                { speechEndedAt, asrFinalAt, sttProvider },
              );
            }, 160);
          } else if (
            result.text
            && !result.isFinal
            // Meeting transcription intentionally shows every participant.
            // Personal voice commands remain private until the current
            // utterance has passed its own speaker-verification gate.
            && (session.transcriptionOnly || !session.voiceprintRequired || isVoiceprintGateOpen(session))
          ) {
            socket.emit("audio:transcript", { text: result.text, isFinal: false });
          }
        });

        session.sttSession.onError((err: Error) => {
          if (!isCurrentVoiceInputSource({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            callbackSessionId,
            currentSttSession: session.sttSession,
            callbackSttSession,
          })) return;
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
        message: "Realtime speech recognition is not configured. Set DOUBAO_SPEECH_KEY to a new-console API Key value, or configure DASHSCOPE_API_KEY/QWEN_API_KEY. Local/OpenAI Whisper can still transcribe uploaded audio files.",
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
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let sumSquares = 0;
        let peak = 0;
        const sampleCount = Math.floor(pcm.length / 2);
        for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
          const normalized = pcm.readInt16LE(offset) / 32768;
          sumSquares += normalized * normalized;
          peak = Math.max(peak, Math.abs(normalized));
        }
        const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
        logger.info(
          `[Audio] Sent ${chunkCount} chunks (${data.length} bytes each, rms=${rms.toFixed(4)}, peak=${peak.toFixed(4)})`,
        );
      }
    }
  });

  // ── Voiceprint: receive MFCC match results from frontend hook ──
  socket.on("voiceprint:result", (data: { isOwnerSpeaking: boolean; confidence: number; speakerLabel?: string | null; source?: string; quality?: number; frameCount?: number; reason?: string; utteranceEpoch?: number }) => {
    const session = getAudioSession(socket);
    if (session.domain === 'work') return;
    session.voiceprintMatched = data.isOwnerSpeaking === true;
    session.voiceprintConfidence = Number(data.confidence) || 0;
    session.voiceprintSpeakerLabel = data.speakerLabel || null;
    session.voiceprintSource = data.source || '';
    session.voiceprintLastAt = Date.now();

    const resultEpoch = Number(data.utteranceEpoch);
    if (
      session.voiceprintRequired
      && (!Number.isInteger(resultEpoch) || resultEpoch !== session.voiceprintUtteranceEpoch)
    ) {
      logger.info(`[Voiceprint] Ignored stale/untagged result epoch=${Number.isFinite(resultEpoch) ? resultEpoch : '-'} current=${session.voiceprintUtteranceEpoch}`);
      return;
    }

    session.utteranceVoiceprintDecided = true;
    session.utteranceVoiceprintMatched = data.isOwnerSpeaking === true;
    session.utteranceVoiceprintConfidence = Number(data.confidence) || 0;
    session.utteranceVoiceprintQuality = Number(data.quality) || 0;
    session.utteranceVoiceprintFrameCount = Math.max(0, Math.floor(Number(data.frameCount) || 0));
    session.utteranceVoiceprintSpeakerLabel = data.speakerLabel || null;
    session.utteranceVoiceprintSource = data.source || '';
    session.utteranceVoiceprintLastAt = Date.now();
    logger.info(`[Voiceprint] result epoch=${resultEpoch} source=${data.source || 'unknown'} matched=${data.isOwnerSpeaking} conf=${session.utteranceVoiceprintConfidence.toFixed(2)} quality=${session.utteranceVoiceprintQuality.toFixed(2)} frames=${session.utteranceVoiceprintFrameCount} reason=${data.reason || '-'}`);
  });

  socket.on('audio:playback_started', (data: { requestId?: string; lane?: string }) => {
    if (data?.lane === 'conversation') return;
    const requestId = String(data?.requestId || '').trim();
    if (!requestId.startsWith('voice_')) return;
    markVoiceLatencyMilestone(requestId, 'firstPlaybackAt');
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
    if (session.isBackgroundWork && session.isProcessing && session.pipelineAbortController) {
      const workRequestId = session.activeTurnRequestId;
      if (workRequestId) session.suppressedSpeechRequestIds.add(workRequestId);
      interruptVoiceSpeech(session);
      socket.emit("audio:status", { status: "interrupted" });
      socket.emit("audio:interrupt-ack", { workContinues: true, requestId: workRequestId });
      return;
    }
    cancelActiveVoiceTurn(session);
    socket.emit("audio:status", { status: "interrupted" });
    socket.emit("audio:interrupt-ack", { workContinues: false });
  });

  socket.on('audio:cancel_turn', (data?: { requestId?: string; reason?: string }) => {
    const session = getAudioSession(socket);
    const requestId = session.activeTurnRequestId;
    if (!requestId || (data?.requestId && data.requestId !== requestId)) return;
    if (data?.reason === 'thinking_watchdog') {
      logger.warn(`[Audio] Ignored legacy UI watchdog cancellation for live request ${requestId}`);
      if (session.isBackgroundWork && session.isProcessing) {
        emitVoiceWorkProgress(
          socket,
          session,
          requestId,
          session.activeWorkStatus,
          undefined,
          true,
        );
      } else {
        socket.emit('audio:status', { status: 'thinking', requestId });
      }
      return;
    }
    logger.warn(`[Audio] Cancelling stuck voice turn ${requestId} (${data?.reason || 'client_request'})`);
    cancelActiveVoiceTurn(session);
    socket.emit('agent:response', {
      text: CN_VOICE_WORK_MESSAGES.processingTimedOut,
      source: 'voice',
      channel: 'voice',
      requestId,
      finalized: true,
      blocked: true,
      reason: 'voice_turn_timeout',
    });
    socket.emit('audio:interrupt-ack', { workContinues: false, requestId });
    socket.emit('audio:status', { status: 'listening', requestId });
    resetSilenceTimer(session, socket);
  });

  socket.on('audio:work_status_probe', (data?: { requestId?: string; lane?: string }) => {
    const session = getAudioSession(socket);
    const requestId = session.activeTurnRequestId;
    if (!requestId || (data?.requestId && data.requestId !== requestId)) {
      socket.emit('audio:status', { status: 'listening', requestId: data?.requestId });
      return;
    }
    if (session.isBackgroundWork && session.isProcessing) {
      emitVoiceWorkProgress(
        socket,
        session,
        requestId,
        session.activeWorkStatus,
        undefined,
        true,
      );
      return;
    }
    socket.emit('audio:status', {
      status: session.isProcessing ? 'thinking' : 'listening',
      requestId,
      lane: data?.lane || 'conversation',
    });
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
      addEchoText(proactiveText, voiceEchoScope(session));
      const result = await synthesizeSpeech(proactiveText, {
        provider: ttsProvider,
        voiceId: proactiveVoice.voiceId,
        speechRate: proactiveVoice.speechRate,
        pitch: proactiveVoice.pitch,
        volume: proactiveVoice.volume,
        allowFallback: false,
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

      const result = await synthesizeSpeech(spokenGreeting, { provider: ttsProvider, voiceId, allowFallback: false });
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
          const result = await synthesizeSpeech(fallback, { provider: ttsProvider, voiceId, allowFallback: false });
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
