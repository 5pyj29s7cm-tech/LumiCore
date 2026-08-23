/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Server, Socket } from "socket.io";
import { readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from "../llm/providers";
import { LLMUsage, ToolExecutionRecord } from "../tools/types";
import { toolRegistry } from "../tools/registry";
import { executeToolCall } from "../tools/execution_engine";
import { buildConfirmedStepContinuationMessages, runWithTools } from "../llm/adapter";
import {
  normalizeOperationMode,
} from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import {
  buildLumiCapabilitySelection,
  buildModelCapabilityPolicy,
} from "../cognition/capability_selection";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import {
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
} from "../cognition/execution_guard_recovery";
import {
  executionBoundaryPromptOverlay,
  restrictSystemPromptForExecutionBoundary,
  restrictToolPolicyForExecutionBoundary,
  restrictVisibleToolNamesForExecutionBoundary,
  restrictVisibleToolRouteForExecutionBoundary,
} from "../tools/remote_policy";
import {
  buildActionContract,
  summarizeActionContractBlocker,
} from "../cognition/action_contract";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
  shouldForwardPreFinalizationProgress,
} from "../cognition/response_delivery";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import {
  getExplicitSentenceCountConstraint,
  sentenceCountCorrectionInstruction,
} from "../cognition/response_constraints";
import { CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION } from "../i18n/response_recovery_messages";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import {
  persistLumiPostTurnLearning,
  shouldPersistPostTurnLearningSource,
} from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { formatClientSelfPrompt } from "../client/self_model";
import { canAutoApproveAction } from "../tools/action_constitution";
import {
  buildConversationConfirmationChannelScope,
  clearPendingConfirmation,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  formatPendingConfirmationRequest,
  getPendingConfirmation,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from "../tools/pending_confirmation";
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories, CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, generateContextualGreeting, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { lightweightEvolve } from "../personality/evolution";
import {
  getOrCreateConversationForTurn,
  addMessage,
  addMessageIdempotent,
  getMessageByRequestId,
  getMessages,
  getMessagesByTokenBudget,
  getConversationSummary,
  setConversationMode,
  extractTopics,
  trackTopic,
  getTopicContext,
  getActiveConversation,
  getConversationForScope,
  getOrCreateActiveConversation,
  getConversationActionStatus,
  persistConversationModelExecutionResult,
  getConversationModelExecutionRecovery,
  cancelConversationActionExecution,
  setConversationActionExecutionStatus,
} from "../conversation/manager";
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import {
  formatConversationExecutionFactAnswer,
  getConversationExecutionFacts,
  isConversationExecutionFactQuestion,
} from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
import { ensureBranch } from "../memory/tree";
import { retrieveChunks } from "../agents/rag";
import { getSensory } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  formatConversationActionTaskStatus,
} from "../cognition/action_continuation";
import {
  coalesceToolExecutionRecords,
  confirmedStepNeedsContinuation,
  taskReceiptsToRecords,
  toolRecordSucceeded,
} from "../cognition/task_execution_ledger";
import { hasExplicitTeamExecutionRequest, isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { summarizeToolRecordForPersistence } from "../cognition/tool_record_status";
import {
  buildDeterministicWorkTaskStatusCommand,
} from "../cognition/quick_commands";
import { recordTokenUsage } from "../llm/token_tracker";
import {
  classifyComplexity,
  listAvailableOrchestrationAgents,
  shouldAttemptOrchestration,
} from "../agents/orchestrator";
import { buildDelegationAck, shouldDelegateWorkInBackground } from "../agents/background_delegation";
import { markLatestUserTurn } from "../agents/background_delivery";
import {
  requestCancelBackgroundTask,
  requestPauseBackgroundTask,
  resumeBackgroundTask,
} from "../agents/background_tasks";
import { shouldChainTask } from "../agents/nl_chainer";
import { searchKnowledgeBase } from "../org/kb";
import { buildProfessionOverlay } from "../autonomy/professions";
import { buildResponseLanguageInstruction } from "../utils/language";
import { CN_MESSAGING_MESSAGES } from "../regions/packs/cn/messaging_messages";
import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_FAST_PATH_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { buildModelSelfAwareness, buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { createDesktopRelay } from "./desktop_relay";
import {
  buildSocketToolSecurityContext,
  resolveSocketScope,
  scopedEmotionalStateKey,
} from "./scope";
import {
  beginChatExecution,
  beginQueuedChatExecution,
  beginChatSidecarExecution,
  getChatExecution,
  getChatSidecarCancellationTarget,
  markChatExecutionCancelling,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  waitForChatSidecarCancellationIntent,
  type ChatExecutionScope,
} from "./chat_execution_registry";
import { classifyActiveTaskMessage } from "../cognition/task_concurrency";
import { SerialExecutionQueue } from "../cognition/serial_execution_queue";
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from "../conversation/guard_history";
import {
  isUnverifiedExecutionAssistantRecord,
  isUnverifiedExecutionAssistantText,
} from "../conversation/summary_grounding";

// Foreground executions outlive an individual Socket.IO connection. Keeping the
// queue at module scope lets a reconnected client query or cancel the same
// execution instead of creating an orphan tied to the old socket instance.
const chatExecutionQueue = new SerialExecutionQueue();

function chatExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function stripHistoricalAttachmentBlocks(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '')
    .trim();
}

const ASSISTANT_HISTORY_NOISE_RE =
  /我还没有真正开始读取或审查|我还没有真正操作客户端|我还不能说这件事已经完成|没有记录到成功的工具执行|真正读取时|I have not actually started|Completion claim|Maximum tool call iterations|Action Constitution|local_write action requires confirmation|已经落到(?:桌面|电脑|文件)|结果包已经|交付包已经|真实接管|WPS\s*表格|剪映已打开|微信已打开|文件生成也卡在权限确认|工具调用一直在跑/i;

function isNoisyAssistantHistory(value: string): boolean {
  return isGuardGeneratedAssistantText(value) || ASSISTANT_HISTORY_NOISE_RE.test(String(value || ''));
}

function normalizeChatHistoryRecord(m: any): NormalizedMessage[] {
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : m?.role === 'user' ? 'user' : '';
  const source = typeof m?.source === 'string' ? m.source : '';
  const uiOnlySources = new Set(['error', 'proactive']);
  if (
    !role ||
    m?.role === 'tool' ||
    m?.type === 'tool' ||
    m?.mode === 'proactive' ||
    uiOnlySources.has(source) ||
    m?.toolCalls ||
    m?.tool_call_id
  ) return [];

  const entries: NormalizedMessage[] = [];
  const message = typeof m?.message === 'string' ? stripHistoricalAttachmentBlocks(m.message) : '';
  const content = typeof m?.content === 'string' ? stripHistoricalAttachmentBlocks(m.content) : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const primaryText = message || content;
  const isUiErrorText = /^(Request failed|请求失败|出错了|Failed to route)/i.test(primaryText);

  if (
    role === 'assistant'
    && (isNoisyAssistantHistory(primaryText) || isUnverifiedExecutionAssistantRecord(m))
  ) {
    return [];
  }

  if (primaryText && !isUiErrorText) {
    entries.push({ role, content: primaryText });
  }
  if (
    response
    && role === 'user'
    && !isNoisyAssistantHistory(response)
    && !isUnverifiedExecutionAssistantText(response)
  ) {
    entries.push({ role: 'assistant', content: response });
  }
  return entries;
}

interface ChatIncomingAttachment {
  id?: string;
  fileName: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  transcript?: string | null;
  transcriptionStatus?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'audio' | 'file';
}

const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_ATTACHMENT_CONTENT = 30000;

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

function isImageAttachment(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name || '');
}

function isAudioAttachment(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('audio/')) || /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i.test(name || '');
}

function normalizeIncomingAttachments(input: unknown): ChatIncomingAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_CHAT_ATTACHMENTS).map((item: any) => {
    const fileName = boundedString(String(item?.fileName ?? item?.name ?? item?.id ?? 'attachment'), 240);
    const mimeType = boundedString(String(item?.mimeType ?? ''), 120);
    const kind: ChatIncomingAttachment['kind'] =
      item?.kind === 'image' || isImageAttachment(fileName, mimeType) ? 'image' :
      item?.kind === 'audio' || isAudioAttachment(fileName, mimeType) ? 'audio' :
      'file';
    return {
      id: boundedString(item?.id, 160) || undefined,
      fileName,
      path: boundedString(item?.path, 1200) || undefined,
      content: boundedString(item?.content, MAX_CHAT_ATTACHMENT_CONTENT) || null,
      preview: boundedString(item?.preview, 4000) || null,
      transcript: boundedString(item?.transcript, MAX_CHAT_ATTACHMENT_CONTENT) || null,
      transcriptionStatus: boundedString(item?.transcriptionStatus, 120) || undefined,
      transcriptionProvider: boundedString(item?.transcriptionProvider, 120) || undefined,
      transcriptionModel: boundedString(item?.transcriptionModel, 120) || undefined,
      mimeType,
      size: typeof item?.size === 'number' ? item.size : undefined,
      kind,
    };
  }).filter(item => item.fileName || item.path || item.content || item.transcript);
}

function getAudioAttachmentTranscript(item: ChatIncomingAttachment): string {
  if (item.kind !== 'audio') return '';
  const raw = String(item.transcript || item.content || item.preview || '').trim();
  if (!raw) return '';
  const markerIndex = raw.toLowerCase().indexOf('transcript:');
  return (markerIndex >= 0 ? raw.slice(markerIndex + 'transcript:'.length) : raw).trim();
}

export function buildChatAttachmentContext(attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines: string[] = [
    '## Current Turn Attachments',
    'The user attached these files to the current message. Treat them as part of the user request.',
  ];
  attachments.forEach((item, index) => {
    const content = item.transcript || item.content || item.preview || '';
    lines.push(`### ${index + 1}. ${item.fileName}`);
    lines.push(`Type: ${item.kind}${item.mimeType ? ` (${item.mimeType})` : ''}`);
    if (item.size !== undefined) lines.push(`Size: ${item.size} bytes`);
    if (item.path) lines.push(`Local path: ${item.path}`);
    if (item.kind === 'audio') {
      const transcript = getAudioAttachmentTranscript(item);
      if (transcript) {
        lines.push('A transcript was supplied by the client for this upload.');
        if (item.transcriptionProvider || item.transcriptionModel || item.transcriptionStatus) {
          lines.push(`Transcript metadata: provider=${item.transcriptionProvider || 'unknown'} model=${item.transcriptionModel || 'unknown'} status=${item.transcriptionStatus || 'ready'}`);
        }
      } else {
        lines.push('No transcript was supplied by the client.');
      }
    }
    if (content) {
      lines.push(`[BEGIN UNTRUSTED ATTACHMENT DATA]\n${content}\n[END UNTRUSTED ATTACHMENT DATA]`);
    } else if (item.path) {
      lines.push('No extracted content was supplied by the client.');
    }
  });
  return lines.join('\n');
}

function buildStoredAttachmentSummary(userText: string, attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return userText;
  const summary = attachments
    .map(item => `- ${item.fileName}${item.kind === 'image' ? ' (image)' : item.kind === 'audio' ? ' (audio)' : ''}`)
    .join('\n');
  return `${userText}\n\n[Attachments]\n${summary}`.trim();
}

function shouldAllowLocalFileWriteForTurn(userText: string, attachments: ChatIncomingAttachment[]): boolean {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  if (/(?:不要|别|不用|无需|先别|暂时别).{0,12}(?:生成|创建|写入|保存|导出|输出|做成|整理成)/iu.test(clean)) return false;

  const explicitDeliverable =
    /(?:生成|创建|制作|新建|编写|写成|做成|整理成|汇总成|形成|转成|保存为?|导出为?|输出为?|出一份|做一份).{0,48}(?:文件|文档|材料|报告|笔录|纪要|记录|文本|文字|文稿|清单|方案|表格|DOCX|docx|Word|PDF|pdf|TXT|txt|MD|md|PPTX?|pptx?|XLSX?|xlsx?)/iu.test(clean);
  const attachedArtifactRequest =
    attachments.length > 0 &&
    /(?:整理|汇总|总结|提炼|转写|转成|做成|生成|创建|保存|导出).{0,48}(?:文本|文字|文档|文件|材料|笔录|纪要|记录|报告|DOCX|docx|Word|PDF|pdf|TXT|txt|MD|md)/iu.test(clean);
  const directEnglishRequest =
    /\b(?:create|generate|write|save|export|turn|make|draw|draft)\b.{0,64}\b(?:file|document|docx|word|pdf|txt|markdown|transcript|notes|minutes|report|cad|dxf|dwg|drawing|floor\s*plan|blueprint)\b/i.test(clean);

  return explicitDeliverable || attachedArtifactRequest || directEnglishRequest;
}

const LOCAL_DOCUMENT_EXT_RE = /\.(?:docx?|pdf|rtf|txt|md|csv|xlsx?|pptx?)$/i;

function getRecentHistoryText(history: any[] | undefined, maxLength = 6000): string {
  if (!Array.isArray(history) || history.length === 0) return '';
  const lines = history
    .slice(-8)
    .map((item: any) => {
      const role = String(item?.role || item?.type || '').slice(0, 20);
      const content = stripHistoricalAttachmentBlocks(String(item?.message || item?.content || item?.text || item?.response || '').trim());
      let toolCalls: any = item?.toolCalls;
      for (let depth = 0; depth < 2 && typeof toolCalls === 'string' && toolCalls.trim(); depth += 1) {
        try { toolCalls = JSON.parse(toolCalls); } catch { toolCalls = []; }
      }
      const runtimeEvidence = Array.isArray(toolCalls)
        ? toolCalls.slice(-6).map((record: any) => {
            const name = String(record?.name || '').trim();
            const result = String(record?.result || '').slice(0, 500);
            return name ? `${name}: ${record?.error ? 'failed' : result || 'completed'}` : '';
          }).filter(Boolean).join('\n')
        : '';
      return [content ? `${role}: ${content}` : '', runtimeEvidence ? `runtime evidence:\n${runtimeEvidence}` : '']
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean);
  return lines.join('\n').slice(-maxLength);
}

const RECENT_FAILURE_EXPLANATION_RE =
  /(?:\u4e3a\u4ec0\u4e48|\u600e\u4e48\u56de\u4e8b|\u548b\u56de\u4e8b).*(?:\u6700\u540e\u4e00\u6b65|\u6ca1\u5b8c\u6210|\u6ca1\u53d1\u51fa\u53bb|\u6ca1\u53d1|\u5931\u8d25|\u5361\u4f4f)|(?:\u6700\u540e\u4e00\u6b65).*(?:\u4e3a\u4ec0\u4e48|\u6ca1\u5b8c\u6210|\u5361\u4f4f)/u;

function buildRecentFailureExplanation(userText: string, history: any[] | undefined): string {
  const clean = String(userText || '').trim();
  if (!RECENT_FAILURE_EXPLANATION_RE.test(clean)) return '';
  const recent = getRecentHistoryText(history, 9000);
  const incompleteContext = /\u4e0d\u80fd\u786e\u8ba4\u5b8c\u6210|\u8fd8\u6ca1\u5b8c\u6210|\u6ca1\u5b8c\u6210|\u672a\u5b8c\u6210|\u56de\u590d\u58f0\u79f0|desktop_open|computer_use|keyboard_type|keyboard_press|wechat_send_message|wechat_send_file|work_product_guard|timed out|failed/i.test(recent);
  const contract = buildActionContract(recent);
  if (!incompleteContext || !contract.applies) return '';

  const hasDedicatedSend = /wechat_send_message/i.test(recent);
  const hasDedicatedFileSend = /wechat_send_file/i.test(recent);
  const hasVerifiedFileSend = /wechat_send_file:[\s\S]{0,700}(?:"sent"\s*:\s*true|sent:\s*true)/i.test(recent);
  const hasKeyboardOnly = /keyboard_type|keyboard_press/i.test(recent);
  const hasCompletionNoise = /\u8bfb\u53d6|\u5ba1\u67e5|\u53ef\u8bfb\u53d6\u7684\u6587\u4ef6|\u56de\u590d\u58f0\u79f0/i.test(recent);
  if (contract.kind === 'messaging_send' && hasVerifiedFileSend) {
    return CN_MESSAGING_MESSAGES.priorFileDeliveryWasMisclassified;
  }
  const contractBlocker = summarizeActionContractBlocker(contract);
  return [
    `\u6700\u540e\u4e00\u6b65\u6ca1\u5b8c\u6210\uff0c\u662f\u56e0\u4e3a\u4e0a\u4e00\u8f6e\u6ca1\u6709\u62ff\u5230\u201c${contract.label}\u201d\u7684\u6838\u5fc3\u52a8\u4f5c\u8bc1\u636e\u3002`,
    contractBlocker,
    contract.kind === 'messaging_send' && !hasDedicatedSend && !hasDedicatedFileSend
      ? CN_MESSAGING_MESSAGES.noDeliveryToolEvidence
      : '',
    contract.kind === 'messaging_send' && hasDedicatedSend
      ? '\u8bb0\u5f55\u91cc\u51fa\u73b0\u4e86\u5fae\u4fe1\u53d1\u9001\u5de5\u5177\uff0c\u4f46\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684 sent=true \u7ed3\u679c\u3002'
      : '',
    contract.kind === 'messaging_send' && hasDedicatedFileSend && !hasVerifiedFileSend
      ? CN_MESSAGING_MESSAGES.unverifiedFileDelivery
      : '',
    contract.kind === 'messaging_send' && hasKeyboardOnly
      ? '\u6240\u4ee5\u5b83\u6700\u591a\u5230\u4e86\u201c\u5b9a\u4f4d\u6216\u641c\u7d22\u8054\u7cfb\u4eba\u201d\uff0c\u6ca1\u6709\u5b8c\u6210\u201c\u7c98\u8d34\u665a\u5b89\u5e76\u6309\u53d1\u9001\u201d\u3002'
      : '',
    hasCompletionNoise
      ? '\u521a\u624d\u90a3\u53e5\u201c\u8bfb\u53d6\u6216\u5ba1\u67e5\u201d\u662f\u9519\u8bef\u7684\u901a\u7528\u515c\u5e95\u6587\u6848\uff0c\u548c\u5fae\u4fe1\u4efb\u52a1\u4e0d\u5339\u914d\u3002'
      : '',
    contract.nextStep ? `\u6b63\u786e\u7684\u4e0b\u4e00\u6b65\uff1a${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}

const SHORT_CLIENT_CONTINUATION_RE =
  /^(?:查|查一下|看|看看|看一下|继续|接着|继续查|接着查|开始|处理|做|整|改|打开|试试|重试|嗯|嗯嗯|好|好的|可以|来|走|为什么|怎么回事|在哪|在哪里|为什么不执行)$/iu;

const CLIENT_SURFACE_CONTEXT_RE =
  /客户端|自己的客户端|中枢世界|中枢|世界视图|云端画布|界面|入口|主屏幕|主页|技能大厅|知识库|运行日志|文件小组件|client_get_state|client_action|\b(?:client|nexus|nexus\s+view|cloud\s+canvas|world\s+view)\b/iu;

const CLIENT_SURFACE_ACTION_RE =
  /打开|进入|切换|查看|看看|检查|查|摸索|操作|入口|界面|状态|没有打开|没打开|为什么|怎么回事|能不能|能打开|\b(?:open|show|enter|switch|inspect|check|operate)\b/iu;

function isShortClientContinuation(userText: string): boolean {
  const clean = String(userText || '').trim();
  return Boolean(clean) && clean.length <= 24 && SHORT_CLIENT_CONTINUATION_RE.test(clean);
}

function getVerifiedClientModeChange(records: ToolExecutionRecord[]): 'chat' | 'assistant' | 'autonomous' | 'meeting' | null {
  const validModes = new Set(['chat', 'assistant', 'autonomous', 'meeting']);
  for (const record of [...records].reverse()) {
    if (
      record.name !== 'client_action'
      || record.arguments?.action !== 'set_client_mode'
      || !toolRecordSucceeded(record)
    ) continue;
    const mode = String(record.arguments?.mode || '').trim().toLowerCase();
    if (!validModes.has(mode)) continue;
    try {
      const parsed = JSON.parse(String(record.result || '{}'));
      const status = String(parsed?.verification?.status || parsed?.status || '').toLowerCase();
      if (/^(?:verified|not_applicable)$/.test(status) && parsed?.ok !== false) {
        return mode as 'chat' | 'assistant' | 'autonomous' | 'meeting';
      }
    } catch {
      // A mode preference is never persisted from an unparseable receipt.
    }
  }
  return null;
}

function hasRecentClientSurfaceContext(history: any[] | undefined): boolean {
  const recent = getRecentHistoryText(
    Array.isArray(history)
      ? history.filter(item => !isGuardGeneratedConversationRecord(item))
      : history,
    5000,
  );
  return CLIENT_SURFACE_CONTEXT_RE.test(recent);
}

function isClientSurfaceRequestText(userText: string): boolean {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  return CLIENT_SURFACE_CONTEXT_RE.test(clean) && CLIENT_SURFACE_ACTION_RE.test(clean);
}

export function buildClientSurfaceContinuationBridge(userText: string, history: any[] | undefined): string {
  const clean = String(userText || '').trim();
  const directClientSurfaceRequest = isClientSurfaceRequestText(clean);
  const shortContinuation = isShortClientContinuation(clean) && hasRecentClientSurfaceContext(history);
  if (!directClientSurfaceRequest && !shortContinuation) return '';

  return [
    '## Internal client-surface continuation context',
    'The user is continuing a Lumi client/UI operation or self-inspection request. Treat this as foreground client work, not background delegation.',
    'Use client_get_state first unless a fresh client state is already available. For "中枢世界", "中枢", "Nexus", or "cloud canvas", use client_action with action=open_nexus.',
    'Do not claim that a client surface was opened, checked, or changed unless client_action verification is verified/not_applicable or fresh client state proves it. If verification is pending or failed, say the exact blocker and next retry.',
  ].join('\n');
}

export function shouldRunVisibleActionPreflight(userText: string, attachments: ChatIncomingAttachment[]): boolean {
  void userText;
  void attachments;
  // Retained as a compatibility probe for callers/tests. Attachments and
  // local-path prose are model inputs, not a pre-model domain router. Any
  // extraction now begins only after the model selects a manifest capability.
  return false;
}

function buildNaturalReplyStyleOverlay(source?: string): string {
  const voiceLine = source === 'voice'
    ? '- In voice, default to one short sentence. If the user asks a simple question, answer in under 20 Chinese characters when possible.'
    : '- Default to concise replies. Use detail only when the user asks for analysis, implementation, or a report.';
  return [
    '## Reply Style',
    '- Never reveal hidden reasoning, chain-of-thought, private deliberation, or “I need to think/analyze” narration.',
    '- Give the final answer directly. Do not describe how you are deciding unless the user explicitly asks for reasoning.',
    '- If corrected for being verbose, reply with only the correction or confirmation.',
    '- Make the answer easy to scan: use short paragraphs of 2-4 sentences and put a blank line between paragraphs.',
    '- When the answer has multiple topics, use brief descriptive headings and compact bullet lists. Do not produce a single dense wall of text.',
    '- Keep hierarchy restrained: lead with the outcome, then supporting details, then next actions when needed.',
    voiceLine,
  ].join('\n');
}

export function registerChatHandler(
  socket: Socket,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI: () => any;
    getAnthropic: () => any;
    getQwen: () => any;
    getOllama: () => any;
    isOllamaAvailable: () => boolean;
    getLmStudio: () => any;
    isLmStudioAvailable: () => boolean;
    getArk?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  },
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
  io: Server,
) {
  socket.on("agent:execution_resume", (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; snapshot?: ReturnType<typeof getChatExecution>; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const requestScope = resolveSocketScope(socket, uid, {
      domain: data.domain === 'work' ? 'work' : data.domain === 'personal' ? 'personal' : undefined,
      orgId: data.orgId,
    });
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    try {
      ack?.(snapshot
        ? { ok: true, snapshot }
        : { ok: false, error: 'Execution not found or no longer recoverable' });
    } catch {}
    if (snapshot?.terminalEvent) {
      socket.emit(snapshot.terminalEvent.event, {
        ...snapshot.terminalEvent.payload,
        replayed: true,
      });
    }
  });

  // Abort is request-scoped and acknowledged. The UI stays in "cancelling"
  // until this handler confirms that the server owns and cancelled the task.
  socket.on("agent:abort_chat", (
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null; conversationId?: string } = {},
    ack?: (payload: { ok: boolean; requestId?: string; status?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const requestScope = resolveSocketScope(socket, uid, {
      domain: data.domain === 'work' ? 'work' : data.domain === 'personal' ? 'personal' : undefined,
      orgId: data.orgId,
    });
    const scope: ChatExecutionScope = {
      userId: uid,
      domain: requestScope.domain,
      orgId: requestScope.orgId,
      source: data.source || 'chat',
      conversationId: data.conversationId,
    };
    const snapshot = getChatExecution(scope, data.requestId);
    if (!snapshot || snapshot.terminal) {
      try {
        ack?.({
          ok: Boolean(snapshot?.terminal),
          requestId: snapshot?.requestId || data.requestId,
          status: snapshot?.status,
          error: snapshot ? undefined : 'Active execution not found',
        });
      } catch {}
      return;
    }

    const sessionKey = `${uid}:${scope.domain}:${scope.orgId || ''}:${scope.source}:${scope.conversationId || ''}`;
    const session = chatExecutionQueue.getByRequestId(sessionKey, snapshot.requestId);
    if (!session || session.requestId !== snapshot.requestId) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Execution controller is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(scope, snapshot.requestId);
    const room = chatExecutionRoom(scope);
    const cancellingPayload = {
      status: 'cancelling',
      source: scope.source,
      requestId: snapshot.requestId,
      conversationId: scope.conversationId,
    };
    io.to(room).emit('agent:status', cancellingPayload);
    session.cancel();

    const responsePayload = {
      text: '[Cancelled]',
      agentName: 'Lumi',
      source: scope.source,
      requestId: snapshot.requestId,
      conversationId: scope.conversationId,
      finalized: true,
      blocked: true,
      reason: 'cancelled',
    };
    if (recordChatExecutionEvent(scope, snapshot.requestId, 'agent:response', responsePayload)) {
      io.to(room).emit('agent:response', responsePayload);
    }
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelled' }); } catch {}
  });

  socket.on("agent:background_cancel", (data: { taskId?: string }) => {
    const uid = userIdFn(socket);
    const taskId = typeof data?.taskId === 'string' ? data.taskId : '';
    if (!taskId) {
      socket.emit("agent:background_task_update", {
        taskId,
        error: 'Missing background task id',
        source: 'background_delegation',
      });
      return;
    }

    const task = requestCancelBackgroundTask(taskId, uid);
    if (!task) {
      socket.emit("agent:background_task_update", {
        taskId,
        error: 'Background task not found',
        source: 'background_delegation',
      });
      return;
    }

    socket.emit("agent:background_task_update", {
      taskId: task.id,
      task,
      source: 'background_delegation',
    });
  });

  const updateBackgroundTaskState = (
    data: { taskId?: string },
    operation: 'pause' | 'resume',
  ) => {
    const uid = userIdFn(socket);
    const taskId = typeof data?.taskId === 'string' ? data.taskId : '';
    const task = taskId
      ? operation === 'pause'
        ? requestPauseBackgroundTask(taskId, uid)
        : resumeBackgroundTask(taskId, uid)
      : null;
    socket.emit("agent:background_task_update", task
      ? { taskId: task.id, task, source: 'background_delegation' }
      : { taskId, error: `Background task not found or not ${operation === 'pause' ? 'pausable' : 'resumable'}`, source: 'background_delegation' });
  };
  socket.on("agent:background_pause", (data: { taskId?: string }) => updateBackgroundTaskState(data, 'pause'));
  socket.on("agent:background_resume", (data: { taskId?: string }) => updateBackgroundTaskState(data, 'resume'));

  socket.on("agent:chat", async (
    data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string },
    ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void,
  ) => {
    console.log('[ChatHandler] agent:chat RECEIVED:', JSON.stringify(data).slice(0, 300));
    const { history, personalityId = "lumi", category, agentId, mode: payloadMode, source } = data;
    const attachments = normalizeIncomingAttachments(data.attachments);
    const rawUserText = typeof data.text === 'string' ? data.text.trim() : '';
    const visibleUserText = rawUserText || (attachments.length > 0 ? 'Please review the attached file(s).' : '');
    const attachmentContext = buildChatAttachmentContext(attachments);
    const historyItems = Array.isArray(history) ? history : [];
    let chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, historyItems);
    let actionContinuationBridge = '';
    const text = [visibleUserText, attachmentContext].filter(Boolean).join('\n\n');
    const storedUserContent = buildStoredAttachmentSummary(visibleUserText, attachments);
    const allowLocalFileWrites = shouldAllowLocalFileWriteForTurn(visibleUserText, attachments);
    const localWriteIntentReason = allowLocalFileWrites
      ? `Current chat request explicitly asked Lumi to generate/export a local deliverable: "${visibleUserText.slice(0, 120)}"`
      : undefined;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim()
      ? data.requestId.trim().slice(0, 120)
      : `chat_${crypto.randomUUID()}`;
    const requestReceivedAt = new Date().toISOString();
    const eventSource = source || 'chat';
    const allowAdaptiveLearning = shouldPersistPostTurnLearningSource(eventSource);
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    const conversationAgentId = agentId || 'lumi';
    const uid = userIdFn(socket);
    let pendingConfirmation: ReturnType<typeof getPendingConfirmation> = null;
    let pendingConfirmationPrompt = '';
    console.log('[ChatHandler] uid:', uid, 'agentId:', agentId, 'source:', source);

    // Work context comes from the authenticated socket token. Personal mode can be
    // explicitly requested by the desktop UI to avoid a stale org token leaking into
    // local personal conversations.
    const requestScope = resolveSocketScope(socket, uid, {
      domain: data.domain === 'work' ? 'work' : data.domain === 'personal' ? 'personal' : undefined,
      orgId: data.orgId,
    });
    const resolvedDomain = requestScope.domain;
    const resolvedOrgId = requestScope.orgId;
    const toolSecurityContext = buildSocketToolSecurityContext(socket, requestScope);
    const requestedConversationId = String(data.conversationId || '').trim();
    const persistedRequestTurn = getMessageByRequestId({
      userId: uid,
      agentId: conversationAgentId,
      requestId,
      role: 'user',
      source: eventSource,
      channel: 'chat',
    });
    const persistedRequestConversation = persistedRequestTurn?.conversationId
      ? getConversationForScope(
          persistedRequestTurn.conversationId,
          uid,
          resolvedDomain,
          resolvedOrgId,
        )
      : null;
    const selectedConversation = persistedRequestConversation || (requestedConversationId
      ? getConversationForScope(requestedConversationId, uid, resolvedDomain, resolvedOrgId)
      : getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId));
    if (
      !selectedConversation
      || selectedConversation.agentId !== conversationAgentId
      || (selectedConversation.status !== 'active' && !persistedRequestTurn)
    ) {
      try { ack?.({ ok: false, requestId, error: 'Conversation is unavailable for this user, agent, or workspace' }); } catch {}
      return;
    }
    let selectedConversationId = selectedConversation.id;
    let confirmationScope = buildConversationConfirmationChannelScope({
      source: eventSource,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
    });
    const confirmationCancellationRequested = isConfirmationCancellation(visibleUserText);
    const pendingConfirmationCleared = confirmationCancellationRequested
      ? clearPendingConfirmation(uid, confirmationScope)
      : false;
    pendingConfirmation = isExplicitConfirmationReply(visibleUserText)
      ? getPendingConfirmation(uid, confirmationScope)
      : null;
    pendingConfirmationPrompt = pendingConfirmation
      ? formatPendingConfirmationPrompt(pendingConfirmation)
      : '';
    let executionScope: ChatExecutionScope = {
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      source: eventSource,
      conversationId: selectedConversationId,
    };
    let executionRoom = chatExecutionRoom(executionScope);
    let sessionKey = `${uid}:${resolvedDomain}:${resolvedOrgId || ''}:${eventSource}:${selectedConversationId}`;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const publicPayload = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, { task: visibleUserText })
        : payload;
      const normalizedPayload = {
        ...publicPayload,
        source: publicPayload.source || eventSource,
        requestId,
        conversationId: selectedConversationId,
      };
      // A late duplicate from the same handler is not a reconnect replay. The
      // explicit request/recovery entry points above own replay delivery; doing
      // it here turns one committed terminal into a second UI terminal frame.
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
      if (event === 'agent:response') {
        // The originating native client must receive the terminal frame even
        // if its room membership changed during reconnect or conversation
        // rollover. Other signed-in clients still receive the same terminal
        // event through the user/workspace room without duplicating it here.
        socket.emit(event, normalizedPayload);
        socket.to(executionRoom).emit(event, normalizedPayload);
        return true;
      }
      io.to(executionRoom).emit(event, normalizedPayload);
      return true;
    };
    const emitConversationUpdated = (payload: Record<string, any>) => {
      io.to(executionRoom).emit('chat:conversation_updated', {
        ...payload,
        requestId,
        originSocketId: socket.id,
      });
    };
    console.log('[ChatHandler] domain:', resolvedDomain, 'orgId:', resolvedOrgId);

    // Request ids are idempotency keys. Socket.IO may deliver a buffered emit
    // after reconnect; acknowledging the existing execution avoids running the
    // same user action twice.
    let existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(executionScope, requestId);
        } catch (error: any) {
          try { ack?.({ ok: false, requestId, error: String(error?.message || 'Control receipt is not durable') }); } catch {}
          return;
        }
        existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(executionScope, requestId);
        if (durableTarget && !chatExecutionQueue.getByRequestId(sessionKey, durableTarget)) {
          // The process can restart after the durable fence but before the
          // side effect/terminal write. With no matching lease, converge the
          // tombstone to a terminal no-op; never replay cancellation onto a
          // later task.
          recordChatExecutionEvent(executionScope, requestId, 'agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: eventSource,
            requestId,
            conversationId: selectedConversationId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          });
          existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        }
      }
      try { ack?.({ ok: true, requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        socket.emit(existingExecution.terminalEvent.event, {
          ...existingExecution.terminalEvent.payload,
          replayed: true,
        });
      } else {
        const resumableStatus = existingExecution.status === 'planning' || existingExecution.status === 'acknowledged'
          ? existingExecution.queued === true ? 'queued' : 'thinking'
          : existingExecution.status;
        socket.emit('agent:status', {
          status: resumableStatus,
          source: eventSource,
          requestId,
          resumed: true,
        });
      }
      return;
    }

    // Reconnect/retry may resend a request that is already reserved but has
    // not reached beginChatExecution yet. Acknowledge the existing lease;
    // never attach a second handler to the same queued request.
    const queuedDuplicate = chatExecutionQueue.getByRequestId(sessionKey, requestId);
    if (queuedDuplicate) {
      try {
        ack?.({
          ok: true,
          requestId,
          receivedAt: new Date().toISOString(),
        });
      } catch {}
      socket.emit('agent:status', {
        status: queuedDuplicate.state === 'active' ? 'thinking' : 'queued',
        source: eventSource,
        requestId,
        resumed: true,
      });
      return;
    }

    // A status question is a side conversation, not a replacement command.
    // Answer it without aborting/superseding the foreground executor.
    const existingSession = chatExecutionQueue.getCurrent(sessionKey);
    const controlTargetRequestId = String(data.controlTargetRequestId || '').trim().slice(0, 120);
    const activeConversationForStatus = existingSession ? getActiveConversation(
      uid,
      conversationAgentId,
      resolvedDomain,
      resolvedOrgId,
    ) : null;
    if (
      existingSession
      && !buildDeterministicWorkTaskStatusCommand(visibleUserText)
      && classifyConversationActionFollowupIntent(
        visibleUserText,
        activeConversationForStatus?.actionContinuationState,
      ) === 'status'
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      if (!controlTargetRequestId || controlTargetRequestId !== existingSession.requestId) {
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        });
        return;
      }
      const activeConversation = activeConversationForStatus || getActiveConversation(
        uid,
        conversationAgentId,
        resolvedDomain,
        resolvedOrgId,
      );
      if (activeConversation) {
        addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId: activeConversation.id,
          role: 'user',
          content: storedUserContent,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          cognitiveIntent: 'task_status',
          requestId,
          receivedAt: requestReceivedAt,
          timestamp: requestReceivedAt,
          skipActionContinuation: true,
        });
      }
      const statusText = activeConversation
        ? getConversationActionStatus(activeConversation.id, uid, visibleUserText, activeConversation.actionContinuationState)
        : CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      const statusCommitted = emitAgent('agent:response', {
        text: statusText,
        agentName: 'Lumi',
        source: eventSource,
        requestId,
        sidecar: true,
        finalized: true,
        blocked: false,
        reason: '',
      });
      if (statusCommitted && activeConversation) {
        addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: activeConversation.id, role: 'assistant', content: statusText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_status', requestId, skipActionContinuation: true });
      }
      return;
    }

    // A new utterance does not destroy an active task. Continuations and
    // independent work wait behind the current foreground lease; only an
    // explicit replacement aborts it.
    const previousSession = chatExecutionQueue.getTail(sessionKey);
    const activeMessageRelation = previousSession
      ? classifyActiveTaskMessage(
          visibleUserText,
          activeConversationForStatus?.actionContinuationState,
        )
      : null;
    let acknowledged = false;
    if (previousSession && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      if (!controlTargetRequestId) {
        emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'missing_control_target',
        });
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        return;
      }
      try {
        // A buffered cancellation must be durably fenced before it can touch
        // the foreground queue. On restart, this tombstone makes replay a
        // status lookup instead of a second cancellation of newer work.
        await persistChatSidecarCancellationIntent(executionScope, requestId, controlTargetRequestId);
      } catch (error: any) {
        const message = String(error?.message || 'Unable to reserve cancellation request');
        emitAgent('agent:error', {
          message,
          code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
          sidecar: true,
        });
        try { ack?.({ ok: false, requestId, error: message }); } catch {}
        return;
      }
      addMessageIdempotent({
        userId: uid,
        agentId: conversationAgentId,
        conversationId: selectedConversationId,
        role: 'user',
        content: storedUserContent,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: eventSource,
        channel: 'chat',
        cognitiveIntent: 'task_cancel',
        requestId,
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      emitAgent('agent:status', { status: 'cancelling', sidecar: true });
      const currentTarget = chatExecutionQueue.getByRequestId(sessionKey, controlTargetRequestId);
      if (!currentTarget) {
        const staleCommitted = emitAgent('agent:response', {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        });
        if (staleCommitted) {
          addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.staleControl, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true });
        }
        return;
      }
      try {
        await chatExecutionQueue.cancelRequest(sessionKey, controlTargetRequestId);
      } catch (error: any) {
        emitAgent('agent:error', {
          message: String(error?.message || 'Cancellation did not settle'),
          code: 'CHAT_CONTROL_CANCEL_FAILED',
          sidecar: true,
        });
        return;
      }
      const cancelCommitted = emitAgent('agent:response', {
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        agentName: 'Lumi',
        source: eventSource,
        requestId,
        sidecar: true,
        finalized: true,
        blocked: false,
        reason: 'cancelled_by_user',
      });
      if (cancelCommitted) {
        addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.cancelled, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true });
      }
      return;
    }

    // Bind and persist the foreground user turn before it waits behind any
    // older lease. This keeps receive order durable even when the model/tool
    // phase is long or the process exits before a terminal assistant result.
    const conversationTurn = getOrCreateConversationForTurn(
      uid,
      conversationAgentId,
      resolvedDomain,
      resolvedOrgId,
      { userText: visibleUserText, conversationId: selectedConversationId },
    );
    const conversation = conversationTurn.conversation;
    if (conversation.id !== selectedConversationId) {
      clearPendingConfirmation(uid, confirmationScope);
      selectedConversationId = conversation.id;
      confirmationScope = buildConversationConfirmationChannelScope({
        source: eventSource,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        conversationId: selectedConversationId,
      });
      executionScope = { ...executionScope, conversationId: selectedConversationId };
      executionRoom = chatExecutionRoom(executionScope);
      sessionKey = `${uid}:${resolvedDomain}:${resolvedOrgId || ''}:${eventSource}:${selectedConversationId}`;
      pendingConfirmation = null;
      pendingConfirmationPrompt = '';
    }
    addMessageIdempotent({
      userId: uid,
      agentId: conversationAgentId,
      conversationId: conversation.id,
      role: 'user',
      content: storedUserContent,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      source: eventSource,
      channel: 'chat',
      cognitiveIntent: confirmationCancellationRequested ? 'task_cancel' : undefined,
      requestId,
      receivedAt: requestReceivedAt,
      timestamp: requestReceivedAt,
      deferActionPreparation: !confirmationCancellationRequested,
      skipActionContinuation: confirmationCancellationRequested,
    });

    // Install the lease before waiting. Otherwise two messages arriving while
    // the same task is active both wait for that task and wake concurrently,
    // allowing the later request to supersede the earlier queued request.
    if (previousSession && activeMessageRelation === 'replace') {
      void chatExecutionQueue.cancelAll(sessionKey);
    }
    beginQueuedChatExecution(executionScope, requestId);
    const sessionLease = chatExecutionQueue.reserve(sessionKey, requestId);
    const abortController = sessionLease.controller;
    let releaseDesktopControlLease: (() => void) | null = null;
    const releaseChatSession = () => {
      releaseDesktopControlLease?.();
      releaseDesktopControlLease = null;
      sessionLease.release();
    };

    if (previousSession) {
      try {
        ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() });
        acknowledged = true;
      } catch {}
      io.to(executionRoom).emit('agent:status', {
        status: activeMessageRelation === 'replace' ? 'replacing' : 'queued',
        source: eventSource,
        requestId,
        waitingForRequestId: previousSession.requestId,
      });
    }
    if (!await sessionLease.waitForTurn()) {
      const cancelledCommitted = emitAgent('agent:response', {
        text: CN_TASK_EXECUTION_MESSAGES.cancelled,
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'cancelled',
      });
      if (cancelledCommitted) {
        addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.cancelled, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId });
      }
      releaseChatSession();
      return;
    }
    const superseded = beginChatExecution(executionScope, requestId);
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    markLatestUserTurn(executionScope, requestId);
    if (!acknowledged) {
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    }

    try {
      // Look up agent record for memory/emotion isolation
      const agentRecord = agentId
        ? readDB().agents.find((a: any) => a.id === agentId) || null
        : null;
      console.log('[ChatHandler] agentRecord found:', !!agentRecord);
      const memoryScope = agentRecord?.memoryScope || 'shared';
      const agentMemoryFilter = memoryScope === 'private' ? agentId : undefined;
      const isSanctuary = agentRecord?.territory === 'sanctuary';

      // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
      const personalityConfig = personalityRegistry.getForUser(
        personalityId,
        uid,
        resolvedDomain === 'work' ? resolvedOrgId : undefined,
      );
      console.log('[ChatHandler] personalityConfig:', !!personalityConfig);
      const retrievalBiases = personalityConfig?.personalityVector
        ? vectorMemoryBias(personalityConfig.personalityVector)
        : { typeWeights: {}, perspectiveWeights: {} };

      // Vector semantic search with keyword fallback
      const relevantMemories = await queryMemoriesVector({
        userId: uid, query: text, limit: 5, minConfidence: 0.4, agentId: agentMemoryFilter,
        retrievalTypeWeights: retrievalBiases.typeWeights,
        retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        useVector: true,
        evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
      });
      console.log('[ChatHandler] relevantMemories (vector):', relevantMemories.length);

      // RAG: retrieve relevant knowledge chunks from agent-scoped and Lumi knowledge.
      let ragChunks: string[] = [];
      const ragAgentIds = Array.from(new Set([conversationAgentId, 'lumi'].filter(Boolean)));
      for (const ragAgentId of ragAgentIds) {
        const chunks = await retrieveChunks(uid, ragAgentId, text, 3, {
          domain: resolvedDomain,
          orgId: resolvedDomain === 'work' ? resolvedOrgId : '',
        });
        for (const chunk of chunks) {
          const content = (chunk as any).content;
          if (content && !ragChunks.includes(content)) ragChunks.push(content);
          if (ragChunks.length >= 5) break;
        }
        if (ragChunks.length >= 5) break;
      }

      // Org: search company KB when in work domain
      let kbContext: string | undefined;
      if (resolvedDomain === 'work' && resolvedOrgId) {
        try {
          const kbResults = await searchKnowledgeBase(resolvedOrgId, text, { limit: 3, userId: uid });
          if (kbResults.length > 0) {
            kbContext = kbResults
              .map(r => `[${r.title}] ${r.chunk}`)
              .join('\n');
            console.log('[ChatHandler] KB search results:', kbResults.length, 'articles found');
          }
        } catch (err: any) {
          console.warn('[ChatHandler] KB search failed:', err.message);
        }
      }

      const emotionKey = scopedEmotionalStateKey(uid, requestScope, agentMemoryFilter ? agentId : undefined);
      const emotionalState = loadEmotionalState(emotionKey);
      const himState = loadHIMState(emotionKey);
      console.log('[ChatHandler] emotionalState loaded');
      const isNovel = relevantMemories.length < 2;

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversationId = conversation?.id;
      if (conversationTurn.rolledOver) {
        console.log(
          '[ChatHandler] rolled over oversized conversation:',
          conversationTurn.previousConversationId,
          '->',
          conversationId,
        );
        // The client may still send its old local transcript after a server-side
        // rollover. Re-evaluate direct client intent without letting that stale
        // transcript reactivate a prior UI task.
        chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, []);
        clearPendingConfirmation(uid, confirmationScope);
        pendingConfirmation = null;
        pendingConfirmationPrompt = '';
      }
      const conversationMode = payloadMode || conversation?.mode || undefined;
      if (conversation && payloadMode && payloadMode !== conversation.mode) {
        setConversationMode(conversation.id, payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      if (conversationId && confirmationCancellationRequested) {
        const cancelled = cancelConversationActionExecution(conversationId, uid);
        if (cancelled || pendingConfirmationCleared) {
          const responseText = pendingConfirmationCleared
            ? '已取消刚才等待确认的操作；它没有执行，也不会继续发送。'
            : CN_TASK_EXECUTION_MESSAGES.cancelled;
          emitAgent("agent:response", { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' });
          addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true });
          emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
          emitAgent("agent:status", { status: "idle" });
          releaseChatSession();
          return;
        }
        const responseText = '当前没有等待确认或正在执行的操作。';
        emitAgent("agent:response", { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' });
        addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true });
        emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
        emitAgent("agent:status", { status: "idle" });
        releaseChatSession();
        return;
      }

      const persistedConversationHistory = conversationId
        ? getMessages(conversationId, 18).filter(record => !(
            record.role === 'user'
            && (
              record.requestId === requestId
              || (
                record.externalMessageId === requestId
                && record.source === eventSource
                && record.channel === 'chat'
              )
            )
          ))
        : [];
      if (!chatContextBridge && conversationId && isShortClientContinuation(visibleUserText)) {
        const dbHistoryItems = persistedConversationHistory.slice(-12)
          .map(record => ({ role: record.role, message: record.message, response: record.response }));
        chatContextBridge = buildClientSurfaceContinuationBridge(visibleUserText, dbHistoryItems);
      }
      actionContinuationBridge = buildRecentActionContinuationBridge(
        visibleUserText,
        conversationTurn.rolledOver
          ? persistedConversationHistory
          : [...historyItems, ...persistedConversationHistory],
        conversation?.actionContinuationState,
      );
      const operationMode = (() => {
        if (typeof data.operationMode === 'string') return normalizeOperationMode(data.operationMode);
        try {
          return getStoredOperationMode(uid);
        } catch {}
        return 'assistant';
      })();

      const sensory = sensoryFn(uid);
      console.log('[ChatHandler] sensory loaded');
      const { config: personality, systemPrompt: systemInstruction } = personalityRegistry.buildSystemPrompt(
        personalityId,
        { mode: 'chat', sensory },
        {
          memories: relevantMemories.length > 0 ? relevantMemories : undefined,
          ragKnowledge: ragChunks.length > 0 ? ragChunks : undefined,
          emotionalState,
          userId: uid,
          userText: text,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
        },
      );
      console.log('[ChatHandler] systemPrompt built, personality name:', personality?.name);

      // Inject conversation summary chain for long-running conversations (anti-entropy)
      let effectiveSystemPrompt = restrictSystemPromptForExecutionBoundary(
        systemInstruction,
        toolSecurityContext.executionBoundary,
      );
      if (conversationId) {
        const summaryContext = getConversationSummary(conversationId);
        if (summaryContext) {
          effectiveSystemPrompt += `\n\n## Conversation Context\n${summaryContext}`;
        }
      }
      // Topic continuity: inject recent conversation topics
      if (conversationId) {
        const topicCtx = getTopicContext(conversationId);
        if (topicCtx) {
          effectiveSystemPrompt += topicCtx;
        }
      }

      // Inject conversation mode overlay (shapes interaction style without changing personality)
      if (conversationMode) {
        const modeOverlay = buildModeOverlay(conversationMode);
        if (modeOverlay) {
          effectiveSystemPrompt += '\n\n' + modeOverlay;
        }
      }
      effectiveSystemPrompt += '\n\n' + buildNaturalReplyStyleOverlay(eventSource);
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\nFile handling rule: attachments supplied in this request may be newly added files or verified material carried forward by the client within this same conversation. Treat their copied local paths, extracted text, and transcripts as available conversation material and keep using them for follow-up questions. Ask the user to reattach only when no usable attachment/path is supplied or a supplied path is unreadable; never ask merely because the material first appeared in an earlier turn.';
      }
      if (pendingConfirmationPrompt) {
        effectiveSystemPrompt += `\n\n${pendingConfirmationPrompt}`;
      }
      if (chatContextBridge) {
        effectiveSystemPrompt += '\n\n' + chatContextBridge;
      }
      if (actionContinuationBridge) {
        effectiveSystemPrompt += '\n\n' + actionContinuationBridge;
      }
      const effectiveRoutedVisibleUserText = [visibleUserText, chatContextBridge, actionContinuationBridge, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
      const routingText = attachments.length > 0
        ? [effectiveRoutedVisibleUserText, attachmentContext].filter(Boolean).join('\n\n')
        : (effectiveRoutedVisibleUserText || text);
      const currentTurnDecisionText = attachments.length > 0
        ? [visibleUserText || text, attachmentContext].filter(Boolean).join('\n\n')
        : (visibleUserText || text);
      const continuationContext = [chatContextBridge, actionContinuationBridge, pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n');
      const executionTaskText = actionContinuationBridge
        ? [text, actionContinuationBridge].filter(Boolean).join('\n\n')
        : text;

      const executionPipeline = buildLumiExecutionPipeline({
        dispatch: {
          userId: uid,
          text: currentTurnDecisionText,
          continuationContext,
          channel: 'chat',
          source: eventSource,
          category,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          operationMode,
          targetIsLumi:
            personality.id === 'lumi' ||
            conversationAgentId === 'lumi' ||
            /lumi/i.test(currentTurnDecisionText),
        },
        registry: toolRegistry,
        personalityToolPolicy: personality.toolPolicy,
        actionTaskState: conversation?.actionContinuationState,
        isSanctuary,
        traceText: currentTurnDecisionText,
        source: eventSource,
      });
      const turnDispatch = executionPipeline.turnIntent;
      const turnFlow = turnDispatch.flow;
      const turnSurface = turnDispatch.surface;
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + turnDispatch.promptOverlay;
        effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
      }
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
          userId: uid,
          text: turnFlow.routeText,
          flow: turnFlow,
          toolRegistry,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
        });
      }

      // Inject company knowledge base context when in work domain
      if (kbContext) {
        effectiveSystemPrompt += `\n\n## Company Knowledge Base\n${kbContext}\n\nUse the above company knowledge to inform your response. Cite article titles when referencing company policy.`;
      }

      // Inject profession context — adapt language and expertise to user's trade
      try {
        const professionOverlay = resolvedDomain === 'personal' ? buildProfessionOverlay() : null;
        if (professionOverlay) {
          effectiveSystemPrompt += professionOverlay;
        }
      } catch {}

      // Inject contact context when user mentions people they know
      if (resolvedDomain === 'personal') try {
        const { matchContactsFromText } = await import('../contacts/store');
        const { formatContactsForContext } = await import('../contacts/context');
        const mentioned = matchContactsFromText(uid, text);
        if (mentioned.length > 0) {
          effectiveSystemPrompt += '\n\n' + formatContactsForContext(mentioned);
          effectiveSystemPrompt += '\n\nYou know these people personally. Use this information to provide relevant, contextual responses when the user asks about them.';
        }
      } catch {}

      const interactionId = crypto.randomUUID();

      const emitToolLifecycle = (payload: {
        correlationId: string;
        name: string;
        arguments: Record<string, any>;
        args?: Record<string, any>;
        result?: string;
        error?: string;
      }) => {
        const normalized = { ...payload, args: payload.args ?? payload.arguments };
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
        'desktop_write_text_file',
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
      const getTurnExecutionDecision = () => executionPipeline.execution;
      const getTurnCapabilitySelection = () => executionPipeline.capabilityPlan;
      const persistChatLearning = (
        assistantText: string,
        options: {
          channel?: 'chat' | 'workflow';
          toolRecords?: ToolExecutionRecord[];
          sourceInteractionId?: string;
          logLabel?: string;
        } = {},
      ) => {
        persistLumiPostTurnLearning(
          {
            userId: uid,
            userText: text,
            defaultChannel: 'chat',
            flow: turnFlow,
            getToolNames: () => toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            defaultSourceInteractionId: interactionId,
            agentId: agentId || '',
            source: eventSource,
            log: { info: console.log, warn: console.warn },
          },
          assistantText,
          options,
        );
      };
      const persistChatTakeoverExecution = (
        assistantText: string,
        options: {
          toolRecords?: ToolExecutionRecord[];
          source?: string;
          sourceInteractionId?: string;
          capabilitySelection?: ReturnType<typeof buildLumiCapabilitySelection>;
          finalizationBlocked?: boolean;
          assistantTextTrusted?: boolean;
          finalizationReason?: string;
        } = {},
      ) => {
        const currentToolRecords = options.toolRecords || [];
        // Historical/status-only responses have no current-turn execution
        // ledger and must not replay old receipts into task state.
        if (currentToolRecords.length === 0) return null;
        const executionWriteback = persistWorkTakeoverTurnExecution({
          userId: uid,
          userText: text,
          assistantText,
          source: options.source || 'chat',
          interactionId: options.sourceInteractionId || interactionId,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          flow: turnFlow,
          capabilitySelection: options.capabilitySelection || getTurnCapabilitySelection(),
          toolRecords: currentToolRecords,
          finalizationBlocked: options.finalizationBlocked === true,
          assistantTextTrusted: options.assistantTextTrusted
            ?? options.finalizationBlocked !== true,
          finalizationReason: options.finalizationReason,
        });
        if (executionWriteback.recorded) {
          emitAgent('agent:task_execution_writeback', executionWriteback);
        }
        return executionWriteback;
      };

      const actionFollowupIntent = classifyConversationActionFollowupIntent(
        visibleUserText,
        conversation?.actionContinuationState,
      );
      const groundedTurnEvidence: string[] = [];
      if (conversationId && isConversationExecutionFactQuestion(visibleUserText)) {
        const factText = formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId,
          userId: uid,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
        }), visibleUserText);
        groundedTurnEvidence.push(`Conversation execution facts:\n${factText}`);
      }
      const exactCorrectionText = conversationId
        ? resolveExactConversationCorrection(visibleUserText, persistedConversationHistory)
        : null;
      if (conversationId && exactCorrectionText) {
        groundedTurnEvidence.push(`Exact prior-turn correction evidence:\n${exactCorrectionText}`);
      }
      if (
        conversationId
        && actionFollowupIntent === 'status'
      ) {
        const statusText = getConversationActionStatus(conversationId, uid, visibleUserText, conversation?.actionContinuationState);
        groundedTurnEvidence.push(`Current action status evidence:\n${statusText}`);
      }

      const recentFailureExplanation = conversationId && !pendingConfirmation
        ? buildRecentFailureExplanation(visibleUserText, getMessages(conversationId, 24))
        : '';
      if (recentFailureExplanation) {
        groundedTurnEvidence.push(`Recent failure evidence:\n${recentFailureExplanation}`);
      }
      if (groundedTurnEvidence.length) {
        effectiveSystemPrompt += [
          '',
          '## Grounded current-turn evidence',
          'Use these server-grounded facts to answer the newest user turn naturally. They are evidence, not a canned response: reason over them, preserve uncertainty, and do not invent execution beyond recorded receipts.',
          ...groundedTurnEvidence,
        ].join('\n\n');
      }

      // ── Desktop relay: route tools to the user's registered desktop client, not only this chat socket ──
      const desktopRelay = createDesktopRelay({
        io,
        userId: uid,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: 'chat',
        taskId: requestId,
        requestSocket: socket,
        emitToolLifecycle,
        formatResultForLifecycle: formatToolResultForUi,
        // The foreground execution belongs to the user task, not to this
        // transport connection. The relay still has its own bounded timeout.
        cancelOnRequestSocketDisconnect: false,
        signal: abortController.signal,
      });
      releaseDesktopControlLease = () => desktopRelay.releaseControlLease('chat_turn_complete');

      let pendingConfirmationCreatedThisTurn: ReturnType<typeof recordPendingConfirmation> | null = null;
      const requestToolConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
        if (
          pendingConfirmation
          && consumePendingConfirmation(uid, pendingConfirmation.id, toolName, args, confirmationScope)
        ) {
          console.log(`[ChatHandler] Consumed one-time confirmation for "${toolName}".`);
          return true;
        }
        if (canAutoApproveAction(toolName, args, { actionIntent: visibleUserText })) return true;
        const pending = recordPendingConfirmation(uid, toolName, args, eventSource, {
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          channelId: confirmationScope.channelId,
          taskId: conversation?.actionContinuationState?.taskId,
          actionIntent: visibleUserText,
        });
        pendingConfirmationCreatedThisTurn = pending;
        if (conversationId) {
          setConversationActionExecutionStatus(conversationId, uid, 'waiting_confirmation', {
            assistantState: formatPendingConfirmationPrompt(pending),
            requestId,
          });
        }
        console.warn(`[ChatHandler] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
        return false;
      };

      emitAgent("agent:status", { status: "thinking", agentName: personality.name });
      console.log('[ChatHandler] emitted agent:status thinking');

      // Inject operation mode prompt overlay
      const effectiveOperationMode = turnFlow.effectiveOperationMode;
      const selfRepairTurn = turnFlow.selfRepairTurn;
      const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
      const workSurfaceRoute = turnFlow.workSurfaceRoute;
      const visionIntent = turnFlow.visionIntent;
      const explicitTeamOrchestration = hasExplicitTeamExecutionRequest(turnFlow.routeText);
      const executionDecision = getTurnExecutionDecision();
      const intentTrace = executionPipeline.intentTrace;
      const capabilitySelection = getTurnCapabilitySelection();
      const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
        channel: 'chat',
        text: turnFlow.routeText,
        flow: turnFlow,
        capabilitySelection,
        capabilityExecutionPlan: executionPipeline.executionPlan,
      });
      const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
      executionDecision.toolRoute = restrictVisibleToolRouteForExecutionBoundary(
        executionDecision.toolRoute,
        toolSecurityContext.executionBoundary,
      );
      const toolRoute = executionDecision.toolRoute;
      const modelCapabilityPolicy = restrictToolPolicyForExecutionBoundary(
        buildModelCapabilityPolicy(executionDecision),
        toolSecurityContext.executionBoundary,
      );
      // A natural-language turn must not create or freeze a durable task before
      // the model has chosen to act. At this point we may only read an existing
      // task pointer for an explicit continuation. Fresh task state is derived
      // later from canonical tool receipts (or from a structured client event).
      const existingActionState = conversation?.actionContinuationState;
      const actionTaskExecution = existingActionState?.taskId
        && Boolean(pendingConfirmation || actionFollowupIntent === 'execute')
        ? { state: existingActionState, kind: 'resume' as const }
        : { state: null, kind: 'conversation' as const };
      const priorTaskRecords = actionTaskExecution.kind === 'resume'
        ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
        : [];
      const taskAwareRecords = (records: ToolExecutionRecord[]) => (
        coalesceToolExecutionRecords([...priorTaskRecords, ...records])
      );
      const exposeAgentWork = turnFlow.exposeAgentWork;
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
      }
      console.log('[ChatHandler] tool gate:', executionDecision.allowToolUse ? 'enabled' : 'chat-only', 'operationMode:', operationMode, 'effective:', effectiveOperationMode, 'surface:', turnFlow.surface, 'clientActionOnly:', clientActionOnlyTurn, 'selfRepair:', selfRepairTurn, 'capabilityLane:', capabilitySelection.lane, 'trace:', intentTrace.summary, 'route:', toolRoute ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable} ${toolRoute.categories.join(',') || 'fallback'}` : 'none');
      socket.emit('agent:intent_trace', intentTrace);
      if (toolRoute) {
        socket.emit('agent:tool_route', {
          categories: toolRoute.categories,
          reasons: toolRoute.reasons,
          toolNames: toolRoute.toolNames,
          totalAvailable: toolRoute.totalAvailable,
          truncated: toolRoute.truncated,
          trace: intentTrace,
        });
      }
      const visiblePreferredTools = restrictVisibleToolNamesForExecutionBoundary(
        capabilitySelection.preferredTools,
        toolSecurityContext.executionBoundary,
      );
      const remoteRestricted = toolSecurityContext.executionBoundary === 'remote_restricted';
      emitAgent('agent:capability_selection', {
        lane: remoteRestricted
          ? (visiblePreferredTools.length > 0 ? 'web_or_account' : 'conversation')
          : capabilitySelection.lane,
        primary: remoteRestricted
          ? (visiblePreferredTools[0] || 'conversation')
          : capabilitySelection.primary,
        reasons: remoteRestricted
          ? ['remote execution boundary applied']
          : capabilitySelection.reasons,
        preferredTools: visiblePreferredTools,
        source: eventSource,
      });
      if (desktopExecutionPolicy.applies && toolSecurityContext.executionBoundary !== 'remote_restricted') {
        emitAgent('agent:desktop_execution_policy', {
          reason: desktopExecutionPolicy.reason,
          evidenceTools: desktopExecutionPolicy.evidenceTools,
          actuationTools: desktopExecutionPolicy.actuationTools,
          verificationTools: desktopExecutionPolicy.verificationTools,
          source: eventSource,
        });
      }
      if (!remoteRestricted) {
        effectiveSystemPrompt += '\n\n' + buildInteractionModeOverlay(turnFlow);
      }
      if (workSurfaceRoute.promptOverlay && toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
      }
      effectiveSystemPrompt += '\n\n' + executionBoundaryPromptOverlay(
        executionDecision.promptOverlay,
        toolSecurityContext.executionBoundary,
      );
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + capabilitySelection.promptOverlay;
      }
      if (desktopExecutionPolicy.promptOverlay && toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + desktopExecutionPolicy.promptOverlay;
      }
      const visionRoutingOverlay = effectiveOperationMode !== 'meeting'
        && toolSecurityContext.executionBoundary !== 'remote_restricted'
        ? buildVisionRoutingOverlay(uid, text)
        : '';
      if (visionRoutingOverlay) {
        effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
      }
      if (!remoteRestricted) {
        effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
          channel: 'chat',
          flow: turnFlow,
        });
      }

      // Keep this late so English system/tool context cannot pull the reply language.
      effectiveSystemPrompt += '\n\n' + buildResponseLanguageInstruction(text);

      // Work-domain chats use organization LLM prefs when configured. If the org
      // has no explicit policy, they visibly inherit the user's personal prefs.
      const userLLMPrefs = getScopedPreferredLLM(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
      let activeProvider = userLLMPrefs.provider || 'deepseek';
      let activeModel = userLLMPrefs.model;
      const reasoningRoutePolicy = {
        selectionMode: userLLMPrefs.selectionMode,
        fallbackCandidates: userLLMPrefs.fallbackCandidates,
        allowCloudFallback: userLLMPrefs.allowCloudFallback,
        conversationId: conversationId || '',
        requestId,
        interactionId,
        source: 'chat',
      };

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        // Availability is observational only; automatic routing resolves the
        // user's exact local model and cloud fallback in the shared dispatcher.
        console.log('[Chat] Automatic model routing enabled with persisted local and fallback selections');
      }

      const scheduleChatSummary = (targetConversationId: string) => {
        scheduleConversationSummary({
          userId: uid,
          provider: activeProvider,
          model: activeModel,
          ...reasoningRoutePolicy,
          conversationId: targetConversationId,
          source: 'chat_summary',
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          llmGetters,
          log: { info: console.log, warn: console.warn },
        });
      };

      // Confirmation continues the exact pending action. Do not ask the model
      // to rediscover the tool name or reconstruct arguments from conversation
      // history after the user has already approved a concrete operation.
      if (pendingConfirmation) {
        const confirmedTask = pendingConfirmation.actionIntent || visibleUserText;
        const confirmedArgs = pendingConfirmation.exactArgs || {};
        const confirmedRecordId =
          `chat-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const consumed = consumePendingConfirmation(
          uid,
          pendingConfirmation.id,
          pendingConfirmation.toolName,
          confirmedArgs,
          confirmationScope,
        );
        emitAgent('agent:status', { status: 'thinking', agentName: personality.name, phase: 'tool' });
        if (!isDirectDesktopTool(pendingConfirmation.toolName)) {
          emitToolLifecycle({
            correlationId: confirmedRecordId,
            name: pendingConfirmation.toolName,
            arguments: confirmedArgs,
          });
        }
        const confirmedRecord = await executeToolCall({
          registry: toolRegistry,
          id: confirmedRecordId,
          name: pendingConfirmation.toolName,
          arguments: confirmedArgs,
          context: {
            ...toolSecurityContext,
            userId: uid,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            desktopRelay,
            llmGetters,
            source: 'chat_confirmation',
            supervisedExternalCommits: true,
            allowLocalFileWrites,
            localWriteIntentReason,
            isCancelled: () => abortController.signal.aborted,
            userConfirmed: true,
            actionIntent: confirmedTask,
            routedTaskText: confirmedTask,
            toolPolicy: modelCapabilityPolicy,
          },
          preflight: () => consumed
            ? { allowed: true, arguments: confirmedArgs }
            : {
                allowed: false,
                arguments: confirmedArgs,
                reason: 'The one-time confirmation expired before execution.',
              },
        });
        if (!isDirectDesktopTool(confirmedRecord.name)) {
          emitToolLifecycle({
            correlationId: confirmedRecord.id || `chat-confirmed-${Date.now()}`,
            name: confirmedRecord.name,
            arguments: confirmedArgs,
            ...(confirmedRecord.error
              ? { error: confirmedRecord.error }
              : { result: formatToolResultForUi(confirmedRecord.result) }),
          });
        }
        let confirmationRecords: ToolExecutionRecord[] = [confirmedRecord];
        let confirmationLlmWasCalled = false;
        let candidate = toolRecordSucceeded(confirmedRecord)
          ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
          : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
              confirmedRecord.error || confirmedRecord.result,
            );
        if (
          confirmedStepNeedsContinuation(
            confirmedTask,
            taskAwareRecords([confirmedRecord]),
          )
          && !abortController.signal.aborted
        ) {
          confirmationLlmWasCalled = true;
          const continuation = await runWithTools(
            [
              { role: 'system', content: effectiveSystemPrompt },
              ...buildConfirmedStepContinuationMessages(confirmedTask, confirmedRecord),
            ],
            toolRegistry,
            {
              provider: activeProvider,
              model: activeModel,
              userId: uid,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              signal: abortController.signal,
              ...reasoningRoutePolicy,
            },
            record => {
              if (!record?.name || isDirectDesktopTool(record.name)) return;
              emitToolLifecycle({
                correlationId: record.id || `chat-confirmation-resume-${Date.now()}`,
                name: record.name,
                arguments: record.arguments || {},
                result: record.error ? undefined : formatToolResultForUi(record.result),
                error: record.error,
              });
            },
            Math.max(1, modelCapabilityPolicy.maxIterations || 5),
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            undefined,
            {
              ...toolSecurityContext,
              userId: uid,
              taskId: actionTaskExecution.state?.taskId || requestId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              source: 'chat_confirmation_resume',
              supervisedExternalCommits: true,
              allowLocalFileWrites,
              localWriteIntentReason,
              isCancelled: () => abortController.signal.aborted,
              requestConfirmation: requestToolConfirmation,
              actionIntent: confirmedTask,
              routedTaskText: confirmedTask,
              toolPolicy: modelCapabilityPolicy,
              priorToolRecords: [confirmedRecord],
              desktopExecutionTracker,
            },
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
          );
          for (const usage of continuation.usageRecords) {
            recordTokenUsage(uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, interactionId);
          }
          const confirmationUsage = continuation.usageRecords.reduce(
            (sum, usage) => sum + (usage.totalTokens || 0),
            0,
          );
          socket.emit('token:usage_update', {
            userId: uid,
            provider: activeProvider,
            totalTokens: confirmationUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
          confirmationRecords = continuation.toolCalls?.length
            ? continuation.toolCalls
            : [confirmedRecord];
          candidate = pendingConfirmationCreatedThisTurn
            ? CN_TASK_EXECUTION_MESSAGES.waitingConfirmation(confirmedTask)
            : continuation.text || candidate;
        }
        confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, desktopExecutionTracker);
        const finalized = finalizeLumiResponse({
          taskText: confirmedTask,
          responseText: candidate,
          toolRecords: taskAwareRecords(confirmationRecords),
          source: 'chat_confirmation',
          flow: { ...turnFlow, routeText: confirmedTask },
        });
        if (finalized.notification) emitAgent('agent:notification', finalized.notification);
        emitAgent('agent:response', {
          text: finalized.text,
          agentName: personality.name,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason || '',
        });
        if (conversationId) {
          addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: finalized.text, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', toolCalls: confirmationRecords, cognitiveIntent: finalized.blocked ? 'work_product_guard' : 'confirmation', llmWasCalled: confirmationLlmWasCalled, requestId });
          scheduleChatSummary(conversationId);
          emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
        }
        persistChatTakeoverExecution(finalized.text, {
          toolRecords: confirmationRecords,
          source: 'chat_confirmation',
          sourceInteractionId: `${interactionId}_confirmation`,
          capabilitySelection,
          finalizationBlocked: finalized.blocked,
          assistantTextTrusted: !finalized.blocked,
          finalizationReason: finalized.reason,
        });
        if (!finalized.blocked) {
          persistChatLearning(finalized.text, {
            toolRecords: confirmationRecords,
            sourceInteractionId: `${interactionId}_confirmation`,
            logLabel: 'chat confirmation',
          });
        }
        emitAgent('agent:status', { status: 'idle', agentName: personality.name });
        releaseChatSession();
        return;
      }

      let responseText = '';
      let llmWasCalled = false;
      const allToolRecords: ToolExecutionRecord[] = [];
      // Keep the same token-budgeted conversation that drove the normal turn
      // available to the one-shot execution recovery. Falling back to only the
      // latest task makes the recovery model forget constraints and prior user
      // corrections precisely when it needs them most.
      let normalTurnMessages: NormalizedMessage[] = [
        { role: 'system', content: effectiveSystemPrompt },
        { role: 'user', content: text },
      ];
      // ── Model-owned natural-language dispatch ──
      // Natural-language chat has no deterministic quick-command path. Surface
      // recognition and legacy quick matches are advisory inputs to the shared
      // model/tool loop; structured UI events use their dedicated handlers.
      // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        agentId: agentId || undefined,
        personalityId: personality.id,
        personalityName: personality.name,
        llmProvider: activeProvider,
        llmModel: activeModel,
        isLLMAvailable: true,
      };
      // LLM classifier for ambiguous intents — fast tiny call (50 tokens max)
      const llmClassifier = async (prompt: string, userText: string): Promise<string> => {
        const messages: NormalizedMessage[] = [
          { role: 'system', content: prompt },
          { role: 'user', content: userText },
        ];
        const result = await makeLLMCall(
          messages,
          [],
          { provider: activeProvider, model: activeModel, userId: uid, maxTokens: 60, domain: resolvedDomain, orgId: resolvedOrgId, ...reasoningRoutePolicy },
          llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
          llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
        );
        return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
      };

      const cognition = await processInput(text, cognitiveCtx, llmClassifier);
      console.log('[ChatHandler] cognition result:', cognition.intent.category, 'directToolExecuted:', cognition.directToolExecuted, 'responseText:', cognition.responseText?.slice(0, 100));

      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        console.log('[ChatHandler] sentiment:', sentiment);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      console.log('[ChatHandler] Using exact configured reasoning model:', activeProvider, '/', activeModel);

      const deferCompletionStream = shouldDeferModelOutputUntilFinalized({
        taskText: executionTaskText,
        allowToolUse: executionDecision.allowToolUse,
        flow: turnFlow,
      });
      const chatTextGate = createPreFinalizationTextGate();
      const prefersSequentialWorkflow =
        shouldChainTask(executionTaskText) &&
        workSurfaceRoute.artifactFirst &&
        !workSurfaceRoute.directDesktop;
      const availableWorkerAgents = (() => {
        try {
          return listAvailableOrchestrationAgents({
            userId: uid,
            personalityId,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          }).filter((agent: any) => agent.id !== conversationAgentId);
        } catch {
          return [];
        }
      })();
      const backgroundComplexity = classifyComplexity(executionTaskText, {
        userId: uid,
        personalityId,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        desktopRelay,
      });
      const legacyDelegationHint = shouldDelegateWorkInBackground({
        text: visibleUserText || text,
        source: eventSource,
        category: cognition.intent.category,
        complexity: backgroundComplexity,
        allowToolUse: executionDecision.allowToolUse,
        clientActionOnly: clientActionOnlyTurn,
        clientSurfaceRequest: Boolean(chatContextBridge) || isClientSurfaceRequestText(routingText),
        continuationContext: Boolean(actionContinuationBridge),
        selfRepair: selfRepairTurn,
        sanctuary: isSanctuary,
        directDesktop: workSurfaceRoute.directDesktop,
        capabilityLane: capabilitySelection.lane,
        prefersSequentialWorkflow,
        availableAgentCount: availableWorkerAgents.length,
      });
      const legacyOrchestrationHint = shouldAttemptOrchestration({
        channel: 'chat',
        text: turnFlow.routeText,
        complexity: backgroundComplexity,
        allowToolUse: executionDecision.allowToolUse,
        clientActionOnly: clientActionOnlyTurn,
        selfRepair: selfRepairTurn,
        responseReady: false,
        hasPreflightContext: false,
        prefersSequentialWorkflow,
        capabilityLane: capabilitySelection.lane,
        cognitionCategory: cognition.intent.category,
      });
      const legacyExecutionHints = [
        legacyDelegationHint.shouldDelegate ? `background candidate: ${legacyDelegationHint.reason}` : '',
        legacyOrchestrationHint ? 'multi-agent orchestration candidate' : '',
        shouldChainTask(executionTaskText) ? 'multi-step execution candidate' : '',
      ].filter(Boolean);
      if (legacyExecutionHints.length) {
        effectiveSystemPrompt += [
          '',
          '## Advisory execution candidates',
          'Legacy routing observed the candidates below. They are hints only: decide whether to respond, use a registered capability, or execute a model-planned sequence from the current hard-policy manifest. Do not claim delegation, background work, or orchestration unless a current-turn tool receipt proves it.',
          ...legacyExecutionHints.map(item => `- ${item}`),
        ].join('\n');
      }

      if (!responseText && legacyDelegationHint.shouldDelegate) {
        const delegationRecord = await executeToolCall({
          registry: toolRegistry,
          id: `background-register-${requestId}`,
          name: 'agent_delegate_background',
          arguments: {
            task: executionTaskText,
            title: visibleUserText.slice(0, 140) || storedUserContent.slice(0, 140) || 'Background task',
            reason: legacyDelegationHint.reason,
            preferredAgentIds: availableWorkerAgents.slice(0, 8).map((agent: any) => agent.id),
            forceOrchestration: true,
          },
          context: {
            ...toolSecurityContext,
            userId: uid,
            taskId: actionTaskExecution.state?.taskId || requestId,
            conversationId: conversation.id,
            conversationAgentId,
            personalityId,
            turnId: requestId,
            requestId,
            idempotencyKey: `background:${conversation.id}:${requestId}`,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            actionIntent: visibleUserText,
            routedTaskText: turnFlow.routeText,
            source: 'chat_background_registration',
            modelRouting: {
              provider: activeProvider,
              model: activeModel,
              selectionMode: reasoningRoutePolicy.selectionMode,
              fallbackCandidates: reasoningRoutePolicy.fallbackCandidates,
              allowCloudFallback: reasoningRoutePolicy.allowCloudFallback,
            },
            toolPolicy: {
              allowedTools: ['agent_delegate_background'],
              requireConfirmation: [],
              forbiddenTools: [],
              maxIterations: 1,
            },
          },
        });
        allToolRecords.push(delegationRecord);
        let registeredTask: any = null;
        try {
          const payload = JSON.parse(delegationRecord.result || '{}');
          if (!delegationRecord.error && payload?.ok === true && payload?.status === 'registered') {
            registeredTask = payload.task;
          }
        } catch {}
        if (registeredTask?.id) {
          responseText = buildDelegationAck(registeredTask.workerNames || [], registeredTask.id);
          llmWasCalled = false;
          emitAgent('agent:delegation', {
            taskId: registeredTask.id,
            task: registeredTask,
            reason: legacyDelegationHint.reason,
            complexity: backgroundComplexity,
            workers: registeredTask.workerNames || [],
          });
          emitAgent('agent:background_task_update', {
            taskId: registeredTask.id,
            task: registeredTask,
            source: 'background_delegation',
          });
          pushNotification(uid, {
            type: 'background_delegation',
            title: 'Lumi background agents',
            message: `Task registered for ${Math.max(1, registeredTask.workerNames?.length || 0)} worker agent(s): ${visibleUserText.slice(0, 80)}`,
          });
        }
      }

      if (!responseText) {
        // Path C: Normal LLM path (simple queries, or orchestrator fallback)

        // Load conversation history from persistence (survives page reload / reconnect)
        let persistedHistory: NormalizedMessage[] = [];
        if (conversationId) {
          const msgs = getMessagesByTokenBudget(conversationId).filter((m: any) => !(
            m.role === 'user'
            && (
              m.requestId === requestId
              || (
                m.externalMessageId === requestId
                && m.source === eventSource
                && m.channel === 'chat'
              )
            )
          ));
          persistedHistory = msgs
            .filter((m: any) => m.message || m.content || m.response)
            .flatMap(normalizeChatHistoryRecord);
        }

        // Once a server conversation exists, persistence is authoritative even
        // when the new segment is intentionally empty. Falling back to the
        // client's pre-rollover transcript would immediately restore the very
        // stale context this boundary is meant to remove.
        const conversationHistory = conversationId
          ? persistedHistory
          : (history ? history.flatMap(normalizeChatHistoryRecord) : []);

        // Tell Lumi which model is currently active without hiding routed vision capacity.
        const selfAwareness = buildModelSelfAwareness(activeProvider, activeModel, uid, { visionAware: visionIntent && effectiveOperationMode !== 'meeting' });
        const messages: NormalizedMessage[] = [
          { role: 'system', content: effectiveSystemPrompt + selfAwareness },
          ...conversationHistory,
          { role: 'user', content: text },
        ];
        normalTurnMessages = messages;

        try {
          console.log('[ChatHandler] Calling Path C with provider:', activeProvider, 'model:', activeModel, 'tools:', executionDecision.allowToolUse ? 'enabled' : 'off');
          const streamChunks: string[] = [];
          const onChunk: StreamCallback = (chunk) => {
            streamChunks.push(chunk);
            if (!deferCompletionStream) {
              const safeText = chatTextGate.push(chunk);
              if (safeText) {
                emitAgent("agent:chunk", { text: safeText, agentName: personality.name });
              }
            }
          };

          // Sanctuary agents get zero tool access — they can only talk
          if (!executionDecision.allowToolUse) {
            const response = await makeLLMCallStreaming(
              messages,
              [],
              { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal, ...reasoningRoutePolicy },
              onChunk,
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );

            responseText = response.text || streamChunks.join('') || '';
            llmWasCalled = true;
            if (response.usage) {
              recordTokenUsage(uid, response.routing?.selectedProvider || activeProvider, response.routing?.selectedModel || activeModel, {
                promptTokens: response.usage.promptTokens,
                completionTokens: response.usage.completionTokens,
                totalTokens: response.usage.totalTokens,
              }, interactionId);
            }
            const sentenceConstraint = getExplicitSentenceCountConstraint(text, responseText);
            if (response.streamIncomplete || (sentenceConstraint && sentenceConstraint.actual !== sentenceConstraint.expected)) {
              const recoveryInstruction = sentenceConstraint
                ? sentenceCountCorrectionInstruction(sentenceConstraint.expected)
                : CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION;
              const corrected = await makeLLMCallStreaming(
                [
                  ...messages,
                  { role: 'assistant', content: responseText },
                  { role: 'user', content: recoveryInstruction },
                ],
                [],
                { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal, ...reasoningRoutePolicy },
                () => {},
                llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
                llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
              );
              const correctedText = String(corrected.text || '').trim();
              const correctedConstraint = getExplicitSentenceCountConstraint(text, correctedText);
              if (
                correctedText
                && (!sentenceConstraint || correctedConstraint?.actual === correctedConstraint.expected)
              ) {
                responseText = correctedText;
              }
              if (corrected.usage) {
                recordTokenUsage(uid, corrected.routing?.selectedProvider || activeProvider, corrected.routing?.selectedModel || activeModel, {
                  promptTokens: corrected.usage.promptTokens,
                  completionTokens: corrected.usage.completionTokens,
                  totalTokens: corrected.usage.totalTokens,
                }, interactionId);
              }
            }
            const totalUsage = response.usage?.totalTokens || 0;
            socket.emit('token:usage_update', {
              userId: uid,
              provider: response.routing?.selectedProvider || activeProvider,
              totalTokens: totalUsage,
              mode: 'chat',
              timestamp: new Date().toISOString(),
            });
          } else {
            const maxIterations = modelCapabilityPolicy.maxIterations || personality.toolPolicy.maxIterations || 25;

          // Collect tool calls for persistence

          const result = await runWithTools(
            messages,
            toolRegistry,
            { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, ...reasoningRoutePolicy },
            isSanctuary ? undefined : (record) => {
              allToolRecords.push(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: formatToolResultForUi(record.result),
                error: record.error,
              };
              emitAgent("agent:tool_call", toolPayload);
              emitAgent("agent:tool", toolPayload);
            },
            maxIterations,
            llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
            onChunk,
            {
              ...toolSecurityContext,
              userId: uid,
              taskId: actionTaskExecution.state?.taskId || requestId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              source: 'chat',
              supervisedExternalCommits: true,
              allowLocalFileWrites,
              localWriteIntentReason,
              isCancelled: () => abortController.signal.aborted,
              onToolStart: (call) => {
                if (isDirectDesktopTool(call.name)) return;
                emitToolLifecycle({
                  correlationId: call.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: call.name,
                  arguments: call.arguments,
                });
              },
              onProgress: (step: string) => {
                if (shouldForwardPreFinalizationProgress(step)) {
                  emitAgent("agent:progress", { text: step, agentName: "Lumi" });
                }
              },
              toolPolicy: modelCapabilityPolicy,
              actionIntent: visibleUserText,
              routedTaskText: turnFlow.routeText,
              desktopExecutionTracker,
              ...(executionDecision.allowToolUse || clientActionOnlyTurn || selfRepairTurn ? { requestConfirmation: requestToolConfirmation } : {}),
            },
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
          );

          responseText = result.text || '';
          llmWasCalled = true;
          // Record provider/model analytics. Product billing is not part of the local execution path.
          for (const u of result.usageRecords) {
            recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
          }
          // Real-time token telemetry for the local dashboard.
          const totalUsage = result.usageRecords.reduce((s: number, r: any) => s + (r.totalTokens || 0), 0);
          socket.emit('token:usage_update', {
            userId: uid,
            provider: activeProvider,
            totalTokens: totalUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
          }
        } catch (llmErr: any) {
          console.error(`[Cognition] LLM '${activeProvider}/${activeModel}' failed: ${llmErr.message}`);
          // Automatic fallback exists only behind the explicit `auto` provider,
          // where the fallback provider and model are persisted user choices.
          const cf = handleLLMFailure(cognition.intent, llmErr);
          responseText = cf.responseText;
        }
      }

      chatTextGate.finish();
      const finalizedDesktopRecords = withDesktopExecutionReceipt(allToolRecords, desktopExecutionTracker);
      if (finalizedDesktopRecords.length > allToolRecords.length) {
        allToolRecords.push(...finalizedDesktopRecords.slice(allToolRecords.length));
      }
      const verifiedClientMode = getVerifiedClientModeChange(allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(uid, verifiedClientMode);
      // Waiting for an immutable one-time confirmation is a valid terminal
      // state for this turn, not a failed completion attempt. The model/tool
      // path must render the same confirmation receipt as the deterministic
      // quick-command path and must not let the completion guard overwrite it
      // with a generic "missing core evidence" failure.
      let finalResponse: ReturnType<typeof finalizeLumiResponse> = pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
            notification: undefined,
          }
        : finalizeLumiResponse({
            taskText: executionTaskText,
            responseText,
            toolRecords: taskAwareRecords(allToolRecords),
            source: 'chat',
            flow: turnFlow,
          });
      const guardRecovery = await recoverBlockedExecutionOnce({
        task: executionTaskText,
        responseText,
        finalization: finalResponse,
        allowToolUse: executionDecision.allowToolUse && !isSanctuary,
        pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
        aborted: abortController.signal.aborted,
        isAborted: () => abortController.signal.aborted,
        isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn),
        toolRecords: taskAwareRecords(allToolRecords),
        attempt: async ({ instruction, priorToolRecords, recordTool }) => {
          console.warn('[ChatHandler] Recovering blocked execution internally.');
          llmWasCalled = true;
          const recovery = await runWithTools(
            [
              ...normalTurnMessages,
              ...(String(responseText || '').trim()
                ? [{ role: 'assistant' as const, content: responseText }]
                : []),
              { role: 'user', content: instruction },
            ],
            toolRegistry,
            {
              provider: activeProvider,
              model: activeModel,
              userId: uid,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              signal: abortController.signal,
              ...reasoningRoutePolicy,
            },
            record => {
              // Preserve terminal receipts independently from the provider
              // result; a late provider error must not erase tool evidence.
              recordTool(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: formatToolResultForUi(record.result),
                error: record.error,
              };
              emitAgent('agent:tool_call', toolPayload);
              emitAgent('agent:tool', toolPayload);
            },
            Math.max(2, Math.min(12, modelCapabilityPolicy.maxIterations || personality.toolPolicy.maxIterations || 8)),
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            undefined,
            {
              ...toolSecurityContext,
              userId: uid,
              taskId: actionTaskExecution.state?.taskId || requestId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              source: 'chat_guard_recovery',
              supervisedExternalCommits: true,
              allowLocalFileWrites,
              localWriteIntentReason,
              isCancelled: () => abortController.signal.aborted,
              onToolStart: call => {
                if (isDirectDesktopTool(call.name)) return;
                emitToolLifecycle({
                  correlationId: call.id || `guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: call.name,
                  arguments: call.arguments,
                });
              },
              toolPolicy: modelCapabilityPolicy,
              actionIntent: visibleUserText,
              routedTaskText: turnFlow.routeText,
              priorToolRecords,
              desktopExecutionTracker,
              requestConfirmation: requestToolConfirmation,
            },
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
          );
          for (const usage of recovery.usageRecords) {
            recordTokenUsage(uid, usage.provider, usage.model, {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }, interactionId);
          }
          return {
            text: recovery.text,
            toolRecords: withDesktopExecutionReceipt(
              recovery.toolCalls || [],
              desktopExecutionTracker,
            ),
          };
        },
        finalize: (candidateText, records) => pendingConfirmationCreatedThisTurn
          ? {
              text: formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn),
              blocked: false,
              reason: 'waiting_confirmation',
              notification: undefined,
            }
          : finalizeLumiResponse({
              taskText: executionTaskText,
              responseText: candidateText,
              toolRecords: withDesktopExecutionReceipt(records, desktopExecutionTracker),
              source: 'chat_guard_recovery',
              flow: turnFlow,
            }),
      });
      for (const record of guardRecovery.toolRecords) {
        const isPriorTaskReceipt = priorTaskRecords.some(item => (
          record.id
            ? item.id === record.id
            : item.name === record.name && item.result === record.result && item.error === record.error
        ));
        if (isPriorTaskReceipt) continue;
        const duplicate = record.id
          ? allToolRecords.some(item => item.id === record.id)
          : allToolRecords.some(item => (
              item.name === record.name
              && item.result === record.result
              && item.error === record.error
            ));
        if (!duplicate) allToolRecords.push(record);
      }
      const recoveredDesktopRecords = withDesktopExecutionReceipt(allToolRecords, desktopExecutionTracker);
      if (recoveredDesktopRecords.length > allToolRecords.length) {
        allToolRecords.push(...recoveredDesktopRecords.slice(allToolRecords.length));
      }
      finalResponse = guardRecovery.finalization;
      responseText = finalResponse.text;
      if (finalResponse.blocked) {
        console.warn('[ChatHandler] Completion claim blocked:', finalResponse.reason);
        if (finalResponse.notification) emitAgent("agent:notification", finalResponse.notification);
        if (conversationId && actionTaskExecution.state?.taskId && executionDecision.allowToolUse) {
          setConversationActionExecutionStatus(conversationId, uid, 'blocked', {
            blocker: finalResponse.reason || 'The current work product did not pass final verification.',
            assistantState: responseText,
            requestId: '',
          });
        }
      }

      // A completed model turn must unlock the native chat surface before
      // synchronous persistence, topic extraction, or summary scheduling.
      // Those durability steps can be slower than the final Socket.IO frame;
      // holding the terminal event behind them leaves the user staring at a
      // stale streaming fragment with the send button disabled.
      emitAgent("agent:response", {
        text: responseText,
        agentName: personality.name,
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
      });

      persistChatTakeoverExecution(responseText, {
        toolRecords: allToolRecords,
        source: 'chat',
        sourceInteractionId: interactionId,
        capabilitySelection,
        finalizationBlocked: finalResponse.blocked,
        assistantTextTrusted: !finalResponse.blocked,
        finalizationReason: finalResponse.reason,
      });

      // Save to conversation via conversation manager (reuse conversationId from setup)

      if (conversationId) {
        // Persist tool calls interleaved before the assistant response
        for (const tc of allToolRecords) {
          if (!tc.error && !String(tc.result || '').trim()) continue;
          const tcSummary = summarizeToolRecordForPersistence(tc);
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId,
          role: 'assistant',
          content: responseText,
          personality: personality.id,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          toolCalls: allToolRecords.length ? allToolRecords : undefined,
          cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : cognition.intent.category,
          llmWasCalled,
          requestId,
        });
        // (conversation_updated NOW emitted AFTER agent:response — see below)

        // Topic tracking — extract and record topics for cross-session continuity
        if (!finalResponse.blocked) {
          try {
            const topics = extractTopics(text + ' ' + responseText);
            for (const topic of topics) trackTopic(conversationId, topic);
          } catch {}
        }

        // Shared chat/voice scheduler owns cadence, reservation, guard
        // filtering, and captured-count persistence.
        scheduleChatSummary(conversationId);
      }

      // Re-emit conversation_updated AFTER response so the client syncs from API with complete data
      if (conversationId) {
        emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
      }
      emitAgent("agent:status", { status: "idle" });

      if (!finalResponse.blocked) {
        persistChatLearning(responseText, { toolRecords: allToolRecords, logLabel: 'chat' });
      }

      // Clean up abort session
      releaseChatSession();

      // Auto-learn from corrections: when user corrects Lumi, extract high-confidence memories
      const correctionPatterns = [/不是/, /不对/, /错了/, /wrong/i, /incorrect/i, /actually/i, /no,?\s/i, /你弄错了/, /不是这样的/];
      const isCorrection = correctionPatterns.some(p => p.test(text));
      if (allowAdaptiveLearning && resolvedDomain === 'personal' && isCorrection && responseText && !finalResponse.blocked) {
        try {
          const corrected = await extractMemories(
            { userMessage: text, assistantResponse: responseText, existingMemories: relevantMemories.map(m => m.content), provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, treeBranches: [] },
            llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
            llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
          );
          for (const mem of corrected.memories) {
            addMemory({
              userId: uid, type: mem.type, content: mem.content,
              keywords: mem.keywords, confidence: Math.min((mem.confidence || 0.5) + 0.2, 1.0),
              sourceInteractionId: interactionId, agentId: agentId || '',
            } as any, { domain: resolvedDomain, orgId: resolvedOrgId, source: 'chat' });
          }
          console.log(`[ChatHandler] Correction learned: ${corrected.memories.length} memories with boosted confidence`);

          // Real-time identity correction: when user contradicts a claim Lumi makes about the user
          // (e.g. "我不做自动驾驶" → remove from coreMotivation immediately, no 7-day wait)
          try {
            const identityCheck = await makeLLMCall(
              [
                {
                  role: 'system',
                  content: `Detect identity corrections. Lumi's stable coreMotivation:\n"${personalityConfig.coreMotivation}"\nLumi's owner-specific growthState: ${JSON.stringify((personalityConfig as any).growthState || {})}\n\nUser said: "${text}"\nLumi said: "${responseText.slice(0, 300)}"\n\nIs the user denying something Lumi believes about them (interest, trait, name, profession)? If YES, return JSON: {"correctsIdentity": true, "removeInterest": "exact contradicted growth/core phrase to remove", "rewriteMotivation": "rewrite coreMotivation only if the false claim is inside coreMotivation, otherwise null"}. If NO, return {"correctsIdentity": false}.\nReturn ONLY JSON.`,
                },
              ],
              [],
              { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, maxTokens: 300, ...reasoningRoutePolicy },
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );
            const identityResult = JSON.parse((identityCheck.text || '').replace(/```json|```/g, '').trim() || '{}');
            if (identityResult.correctsIdentity) {
              const removed = await personalityRegistry.correctIdentity(personalityId, {
                removeInterest: identityResult.removeInterest || undefined,
                removeFromMotivation: identityResult.removeInterest || undefined,
                newMotivation: identityResult.rewriteMotivation || undefined,
              }, uid);
              if (removed) {
                console.log(`[ChatHandler] Identity corrected in real-time: removed "${identityResult.removeInterest}"`);
              }
            }
          } catch (idErr: any) {
            console.warn('[ChatHandler] Identity correction check failed:', idErr.message);
          }
        } catch (err: any) { console.warn('[ChatHandler] Correction extraction failed:', err.message); }
      }

      // Lightweight per-conversation evolution — micro-shifts after meaningful chats
      // Fires if enough owner_trait memories have accumulated, no 7-day wait needed
      if (allowAdaptiveLearning && resolvedDomain === 'personal' && !isSanctuary && responseText && !finalResponse.blocked && cognition.intent.category !== 'command' && !personalityRegistry.isEvolutionFrozen(personalityId, uid)) {
        try {
          const evolutionConfig = personalityRegistry.getEvolutionConfig(personalityId, uid);
          const step = await lightweightEvolve(
            personalityConfig,
            uid,
            evolutionConfig,
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
          );
          if (step) {
            personalityRegistry.applyEvolution(personalityId, step, { userId: uid });
            console.log(`[ChatHandler] Lightweight evolution: v${step.version}, ${step.mutations.length} mutation(s)`);
          }
        } catch (evErr: any) {
          console.warn('[ChatHandler] Lightweight evolution failed:', evErr.message);
        }
      }

      // Async memory extraction — skip trivial/command messages to reduce noise
      const skipExtractionCategories = ['command', 'file', 'unknown'];
      if (allowAdaptiveLearning && text.length >= 10 && !finalResponse.blocked && !skipExtractionCategories.includes(cognition.intent.category)) {
      const branchNodes = queryMemories({ userId: uid, nodeType: 'branch', limit: 50, domain: resolvedDomain, orgId: resolvedOrgId });
      const treeBranches = branchNodes.map(b => b.content);
      const locationTag = sensory.locationTag || undefined;
      extractMemories(
        { userMessage: text, assistantResponse: responseText, existingMemories: relevantMemories.map(m => m.content), provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, treeBranches, locationTag },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      ).then(extracted => {
        for (const mem of extracted.memories) {
          let parentId: string | null = null;
          if ((mem as any).branchHint) {
            const branch = ensureBranch(uid, (mem as any).branchHint, agentId || '', null, { domain: resolvedDomain, orgId: resolvedOrgId });
            parentId = branch.id;
          }
          addMemory({
            userId: uid, type: mem.type, content: mem.content,
            keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: interactionId,
            agentId: agentId || '',
          } as any, { parentId, location: locationTag, domain: resolvedDomain, orgId: resolvedOrgId, source: 'chat' });
        }
        for (const rem of extracted.reminders) {
          addReminder({
            userId: uid,
            content: rem.content,
            dueAt: rem.dueAt,
            sourceInteractionId: interactionId,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          });
        }
      }).catch(err => console.error('[Memory] Extraction failed:', err));
      }

      // Update emotional state — reconnect if user was away for a while
      const hoursSinceLast = emotionalState.lastInteractionAt
        ? (Date.now() - new Date(emotionalState.lastInteractionAt).getTime()) / (1000 * 60 * 60)
        : 24;
      const isReconnect = hoursSinceLast > 1;
      let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
      // Apply sentiment analysis results to emotional state
      if (sentiment.valence !== 0 || sentiment.frustration > 0 || sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, { type: 'sentiment_analysis', sentiment, userId: uid, timestamp: new Date().toISOString() });
      }
      if (isReconnect) {
        updatedState = updateEmotionalState(updatedState, { type: 'reconnect', intensity: Math.min(1, hoursSinceLast / 72), userId: uid, timestamp: new Date().toISOString() });
      }
      if (isNovel) {
        updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: uid, timestamp: new Date().toISOString() });
      }
      // HIM: comfort-gradient drive → dynamic initiative + curiosity
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: uid }, himState, text.slice(0, 40));
      saveEmotionalState(emotionKey, himUpdated);
      saveHIMState(emotionKey, newHim);

      // Emit contextual greeting on reconnect (sanctuary agents don't initiate)
      if (!isSanctuary && isReconnect && updatedState.intimacy > 0.2) {
        const greeting = generateContextualGreeting(updatedState, uid);
        if (greeting) {
          const greetingTs = new Date().toISOString();
          // Save to chat log
          const greetingDb = readDB();
          greetingDb.interactions.push({
            id: `greeting-${uid}-${Date.now()}`,
            userId: uid,
            agentId: agentId || '',
            conversationId: conversationId || '',
            content: greeting,
            response: '',
            role: 'agent',
            personality: personality.id,
            timestamp: greetingTs,
            cognitiveIntent: 'greeting',
            llmWasCalled: false,
          });
          writeDB(greetingDb);

          // Emit to chat window and notification center
          socket.emit('agent:proactive', {
            type: 'greeting',
            message: greeting,
            agentName: personality.name,
            intimacy: updatedState.intimacy,
            timestamp: greetingTs,
          });
          pushNotification(uid, { type: 'greeting', title: `Welcome back`, message: greeting });
        }
      }

    } catch (error: any) {
      console.error("[Socket Agent Error]:", error);
      emitAgent("agent:error", { message: error.message });
      emitAgent("agent:status", { status: "error" });
    } finally {
      releaseChatSession();
    }
  });
}

