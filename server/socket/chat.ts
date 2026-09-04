/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Server, Socket } from "socket.io";
import { flushDBOrThrow, readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from "../llm/providers";
import { resolveModelRequestInputBudget } from "../llm/request_context_budget";
import { LLMUsage, ToolExecutionRecord, type ToolContext } from "../tools/types";
import { buildMediaArtifactReceipt, type MediaArtifactReceipt } from './media_artifact_receipt';
import {
  normalizeStructuredMediaRequest,
  structuredMediaRoutingEnvelope,
} from '../../shared/media_generation';
import { toolRegistry } from "../tools/registry";
import { executeToolCall } from "../tools/execution_engine";
import { buildConfirmedStepContinuationMessages, runWithTools } from "../llm/adapter";
import {
  normalizeOperationMode,
} from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildOperationModeMetaResponse } from "../cognition/capability_meta";
import { LUMI_CLIENT_MODE_IDS, type LumiClientMode } from "../../shared/operation_modes";
import {
  buildLumiCapabilitySelection,
  buildModelCapabilityPolicy,
  buildModelToolProjection,
} from "../cognition/capability_selection";
import { trustedContinuationEvidenceTools } from "../cognition/tool_router";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildForegroundTaskCompletionFeedback } from "../cognition/acceptance_evidence";
import { normalizeCompletionFeedbackForPersistence } from "../conversation/completion_feedback";
import {
  recoverBlockedExecutionOnce,
  sanitizeExecutionResponseForDelivery,
  sanitizeExecutionNotificationForDelivery,
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
import { shouldBlockForDesktopControlPause } from '../cognition/desktop_control_pause';
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
import { buildTextReplyStyleOverlay } from '../cognition/reply_style';
import { CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION } from "../i18n/response_recovery_messages";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import {
  persistLumiPostTurnLearning,
  shouldPersistPostTurnLearningSource,
} from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { formatClientSelfPromptForTurn } from "../client/self_model";
import { canAutoApproveAction } from "../tools/action_constitution";
import {
  buildTransportNeutralConfirmationScope,
  clearPendingConfirmationDurably,
  confirmationArgumentsMatch,
  consumePendingConfirmationDurably,
  formatPendingConfirmationRequest,
  getPendingConfirmationDurably,
  isExplicitConfirmationReply,
  isConfirmationCancellation,
  pendingConfirmationMatchesExactProposal,
  recordPendingConfirmationDurably,
} from "../tools/pending_confirmation";
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';
import {
  buildPendingAssistantOfferContextFromTranscript,
  resolvePendingRuntimeCleanupOffer,
} from '../cognition/pending_assistant_offer';
import { formatRuntimeCleanupReceipt } from '../i18n/runtime_cleanup_messages';
import {
  admitAcceptedUserTurnDurably,
  resolveAcceptedTurnConfirmation,
  runAfterAcceptedUserTurnAdmission,
} from './action_turn_durability';
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories, CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, generateContextualGreeting, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay, generateSystemPrompt } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { getMemoryAvatar } from '../memory_avatar/store';
import { lightweightEvolve } from "../personality/evolution";
import {
  getOrCreateConversationForTurn,
  addMessage,
  addMessageIdempotent as addMessageIdempotentUnbound,
  updateAssistantMessageTerminalPresentation,
  getMessageByRequestId,
  getMessages,
  getMessagesByTokenBudget,
  getConversationSummary,
  setConversationMode,
  extractTopics,
  trackTopic,
  getTopicContext,
  getConversationForScope,
  getOrCreateActiveConversation,
  getConversationActionStatus,
  bindConversationActionExecutionTurn,
  cancelConversationActionExecution,
  createDurableForegroundReleaseGate,
  convergeConversationActionRequestLease,
  convergeConversationActionRequestLeaseDurably,
  finalizeForegroundRequestDurably,
  prepareConversationActionExecution,
  setConversationActionExecutionStatus,
  startConversationActionExecutionHeartbeat,
  type ConvergeConversationActionRequestLeaseResult,
  type FinalizeForegroundRequestResult,
  type ForegroundRequestDurabilityDependencies,
} from "../conversation/manager";
import {
  getConversationActionStateByTaskId,
  getConversationActionStateFromLedger,
  getLatestConversationActionState,
} from "../conversation/action_ledger";
import { findAdjacentVerifiedConfirmedAction } from '../conversation/duplicate_confirmation';
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import {
  formatConversationExecutionFactAnswer,
  getConversationExecutionFacts,
  isConversationExecutionFactQuestion,
} from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
import { findLatestRepeatableAssistantReply } from '../conversation/assistant_restatement';
import { ensureBranch } from "../memory/tree";
import { retrieveChunks } from "../agents/rag";
import { getSensory } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  conversationActionRequiresFreshConfirmationReview,
  formatConversationActionTaskStatus,
  pendingRuntimeCancellationRecheck,
  RECONFIRMATION_REQUIRED_BLOCKER,
} from "../cognition/action_continuation";
import {
  buildDurableTaskDeterministicToolRecoveryCall,
  buildStructuredMediaDeterministicToolRecoveryCall,
} from '../cognition/deterministic_tool_recovery';
import {
  isPriorTurnToolReceiptQuestion,
  normalizeActionIntent,
} from "../cognition/normalized_action_intent";
import {
  coalesceToolExecutionRecords,
  confirmedStepNeedsContinuation,
  taskReceiptsToRecords,
  toolRecordSucceeded,
} from "../cognition/task_execution_ledger";
import { isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { summarizeToolRecordForPersistence } from "../cognition/tool_record_status";
import {
  buildDeterministicWorkTaskStatusCommand,
} from "../cognition/quick_commands";
import { classifyRuntimeWorkIntent } from '../cognition/runtime_work_intent';
import { recordTokenUsage } from "../llm/token_tracker";
import { searchKnowledgeBase } from "../org/kb";
import { buildProfessionOverlay } from "../autonomy/professions";
import { buildResponseLanguageInstruction } from "../utils/language";
import { CN_MESSAGING_MESSAGES } from "../regions/packs/cn/messaging_messages";
import { formatDesktopControlPausePresentation } from '../regions/packs/cn/desktop_control_messages';
import {
  CN_TASK_EXECUTION_MESSAGES,
  CN_VOICE_FAST_PATH_MESSAGES,
  CN_VOICE_WORK_MESSAGES,
} from "../regions/packs/cn/voice_fast_path_messages";
import { buildModelSelfAwareness, buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { buildSocketNativeRequestBinding } from './native_request_binding';
export { buildSocketNativeRequestBinding } from './native_request_binding';
export type { SocketNativeRequestBinding } from './native_request_binding';
import { createDesktopRelay } from "./desktop_relay";
import { normalizeVoiceHistoryRecord } from "./voice_history";
import {
  buildSocketToolSecurityContext,
  resolveSocketScope,
  scopedEmotionalStateKey,
} from "./scope";
import {
  beginChatExecutionDurably,
  beginQueuedChatExecution,
  beginChatSidecarExecution,
  getDurableChatCancellationForCurrentExecution,
  getChatExecution,
  getChatSidecarCancellationTarget,
  markChatExecutionCancelling,
  persistChatSidecarCancellationIntent,
  recordChatExecutionEvent,
  recordChatExecutionPersistenceUnknownDurably,
  recordChatExecutionTerminalEventDurably,
  waitForChatSidecarCancellationIntent,
  type ChatExecutionScope,
} from "./chat_execution_registry";
import { commitChatTerminalBoundary } from "./chat_terminal_boundary";
import {
  chatPublicErrorCodeForException,
  sanitizeChatAgentErrorPayload,
} from "./chat_public_error";
import {
  formatActiveTaskRelationContext,
  resolveActiveTaskMessageRelation,
  type ActiveTaskMessageResolution,
} from "../cognition/task_concurrency";
import { SerialExecutionQueue } from "../cognition/serial_execution_queue";
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from "../conversation/guard_history";

// Foreground executions outlive an individual Socket.IO connection. Keeping the
// queue at module scope lets a reconnected client query or cancel the same
// execution instead of creating an orphan tied to the old socket instance.
const chatExecutionQueue = new SerialExecutionQueue();

export interface ChatForegroundRequestIdentity {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expectedTaskId?: string;
}

export interface ChatForegroundRequestReleaseResult {
  convergence: ConvergeConversationActionRequestLeaseResult;
  finalization: FinalizeForegroundRequestResult | null;
  converged: boolean;
}

/** Converge durable foreground ownership before desktop/queue resources leave. */
export async function convergeChatForegroundRequestBeforeRelease(input: {
  readonly identity: ChatForegroundRequestIdentity;
  readonly aborted: boolean;
  readonly reason?: string;
  readonly assistantState?: string;
}, dependencies: ForegroundRequestDurabilityDependencies = {}): Promise<ChatForegroundRequestReleaseResult> {
  let convergence = convergeConversationActionRequestLease({
    ...input.identity,
    deferLocalOwnerClear: true,
  });
  if (convergence.converged) {
    convergence = await convergeConversationActionRequestLeaseDurably(input.identity, dependencies);
    return { convergence, finalization: null, converged: true };
  }
  const finalization = await finalizeForegroundRequestDurably({
    ...input.identity,
    outcome: input.aborted ? 'cancelled' : 'blocked',
    assistantMessageId: convergence.assistantMessageId || undefined,
    reason: input.reason || (input.aborted
      ? 'Chat foreground request was aborted before release.'
      : 'Chat foreground executor exited without a fully converged terminal.'),
    assistantState: input.assistantState,
  }, dependencies);
  return {
    convergence,
    finalization,
    converged: finalization.converged,
  };
}

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

function chatDurabilityUnknownText(userText: string): string {
  return /[\u3400-\u9fff]/u.test(userText)
    ? CN_TASK_EXECUTION_MESSAGES.persistenceUnknown
    : 'The final state of this turn could not be saved reliably, so I did not mark it complete. If an external action may have run, verify its actual result before retrying.';
}

function isNoisyAssistantHistory(value: string): boolean {
  return isGuardGeneratedAssistantText(value) || ASSISTANT_HISTORY_NOISE_RE.test(String(value || ''));
}

export function normalizeChatHistoryRecord(
  m: any,
  options: { serverOwned?: boolean } = {},
): NormalizedMessage[] {
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : m?.role === 'user' ? 'user' : '';
  const source = typeof m?.source === 'string' ? m.source : '';
  const uiOnlySources = new Set(['error', 'proactive']);
  if (
    !role ||
    m?.role === 'tool' ||
    m?.type === 'tool' ||
    m?.mode === 'proactive' ||
    uiOnlySources.has(source) ||
    m?.tool_call_id
  ) return [];

  const message = typeof m?.message === 'string' ? stripHistoricalAttachmentBlocks(m.message) : '';
  const content = typeof m?.content === 'string' ? stripHistoricalAttachmentBlocks(m.content) : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const primaryText = message || content;
  const isUiErrorText = /^(Request failed|请求失败|出错了|Failed to route)/i.test(primaryText);
  if (role === 'system') {
    return primaryText && !isUiErrorText ? [{ role, content: primaryText }] : [];
  }

  // Only records loaded by the server from conversation persistence may carry
  // provider tool calls or the server-owned compaction ledger. Client-supplied
  // history cannot mint either evidence channel.
  const trustedRecord = {
    ...m,
    role,
    message: isUiErrorText ? '' : primaryText,
    content: undefined,
    response,
    toolCalls: options.serverOwned ? m?.toolCalls : undefined,
    toolReceiptLedger: options.serverOwned ? m?.toolReceiptLedger : undefined,
  };
  return normalizeVoiceHistoryRecord(trustedRecord).filter(entry => !(
    entry.role === 'assistant'
    && (
      (role === 'assistant' && entry.content === primaryText && isNoisyAssistantHistory(primaryText))
      || (role === 'user' && entry.content === response && isNoisyAssistantHistory(response))
    )
  ));
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

function getVerifiedClientModeChange(records: ToolExecutionRecord[]): LumiClientMode | null {
  const validModes = new Set<string>(LUMI_CLIENT_MODE_IDS);
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
        return mode as LumiClientMode;
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
    'The user is continuing a Lumi client/UI operation or self-inspection request. Treat this as foreground client work, not deferred automation.',
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
  return buildTextReplyStyleOverlay(source === 'voice' ? 'voice' : 'chat');
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
  const addMessageIdempotent = (
    message: Parameters<typeof addMessageIdempotentUnbound>[0],
  ) => addMessageIdempotentUnbound({
    ...message,
    ...(buildSocketNativeRequestBinding(socket) || {}),
  });
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

  // Abort is request-scoped and acknowledged. This handler only records that
  // the server accepted the cancellation signal; the foreground owner remains
  // the sole writer of the request's terminal transcript/task/receipt. Writing
  // a second terminal here used to race the foreground catch and could claim
  // "cancelled" while a provider that ignored AbortSignal was still running.
  socket.on("agent:abort_chat", async (
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
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelling' }); } catch {}
  });

  socket.on("agent:chat", async (
    data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown },
    ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void,
  ) => {
    console.log('[ChatHandler] agent:chat RECEIVED:', JSON.stringify({
      requestId: String(data?.requestId || '').slice(0, 120),
      source: String(data?.source || '').slice(0, 80),
      textLength: String(data?.text || '').length,
      attachmentCount: Array.isArray(data?.attachments) ? data.attachments.length : 0,
      mediaOperation: data?.mediaRequest && typeof data.mediaRequest === 'object'
        ? String((data.mediaRequest as Record<string, unknown>).operation || '').slice(0, 40)
        : '',
    }));
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
    const structuredMediaRequest = normalizeStructuredMediaRequest(data.mediaRequest);
    if (data.mediaRequest !== undefined && !structuredMediaRequest) {
      try { ack?.({ ok: false, requestId, error: 'Invalid media workbench request' }); } catch {}
      return;
    }
    const mediaRoutingEnvelope = structuredMediaRequest
      ? structuredMediaRoutingEnvelope(structuredMediaRequest)
      : '';
    const requestReceivedAt = new Date().toISOString();
    const eventSource = source || 'chat';
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    let latestMediaArtifactReceipt: MediaArtifactReceipt | undefined;
    const formatMediaArtifactReceiptForUi = (
      name: string,
      args?: Record<string, any>,
      result?: string,
      error?: string,
    ) => {
      const receipt = buildMediaArtifactReceipt(name, args, result, error);
      if (receipt) latestMediaArtifactReceipt = receipt;
      return receipt;
    };
    const requestedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    const uid = userIdFn(socket);
    const nativeRequestBinding = buildSocketNativeRequestBinding(socket);
    let pendingConfirmation: Awaited<ReturnType<typeof getPendingConfirmationDurably>> = null;
    let pendingConfirmationPrompt = '';
    console.log('[ChatHandler] uid:', uid, 'agentId:', requestedAgentId || 'lumi', 'source:', source);

    // Work context comes from the authenticated socket token. Personal mode can be
    // explicitly requested by the desktop UI to avoid a stale org token leaking into
    // local personal conversations.
    const socketScope = resolveSocketScope(socket, uid, {
      domain: data.domain === 'work' ? 'work' : data.domain === 'personal' ? 'personal' : undefined,
      orgId: data.orgId,
    });
    // Only a user-owned Memory Avatar may opt into the private persona lane.
    // Ordinary chat always remains the single LumiCore identity; arbitrary
    // client-supplied Agent IDs cannot create another conversation owner or
    // grant a different execution policy.  This is the server-side single-core
    // boundary; LAP and the private Memory Avatar surface remain explicit lanes.
    const requestedMemoryAvatar = requestedAgentId.startsWith('memory_avatar_')
      ? getMemoryAvatar(uid, requestedAgentId)
      : null;
    if (
      requestedAgentId.startsWith('memory_avatar_')
      && (!requestedMemoryAvatar || requestedMemoryAvatar.status !== 'active')
    ) {
      try { ack?.({ ok: false, requestId, error: 'Memory Avatar is unavailable for this user' }); } catch {}
      return;
    }
    const memoryAvatar = requestedMemoryAvatar;
    const conversationAgentId = memoryAvatar?.id || 'lumi';
    const isMemoryAvatar = Boolean(memoryAvatar && memoryAvatar.status === 'active');
    // A Memory Avatar is a personal, private reflection even when the shell
    // is currently connected to an organization workspace. Never let the
    // transport's work scope pull company KB/RAG or org-scoped memories into
    // that conversation.
    const requestScope = isMemoryAvatar
      ? { domain: 'personal' as const, orgId: '' }
      : socketScope;
    const resolvedDomain = requestScope.domain;
    const resolvedOrgId = requestScope.orgId;
    const allowAdaptiveLearning = !isMemoryAvatar && shouldPersistPostTurnLearningSource(eventSource);
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
    const explicitlyBoundConversation = Boolean(
      requestedConversationId
      && selectedConversation?.id === requestedConversationId,
    );
    if (
      !selectedConversation
      || selectedConversation.agentId !== conversationAgentId
      || (
        selectedConversation.status !== 'active'
        && !persistedRequestTurn
        && !explicitlyBoundConversation
      )
    ) {
      try { ack?.({ ok: false, requestId, error: 'Conversation is unavailable for this user, agent, or workspace' }); } catch {}
      return;
    }
    let selectedConversationId = selectedConversation.id;
    try {
      await ensurePendingConfirmationPersistenceInitialized();
    } catch (error) {
      console.error('[ChatHandler] Encrypted confirmation store is unavailable:', error);
      try { ack?.({ ok: false, requestId, error: 'Secure confirmation storage is unavailable' }); } catch {}
      return;
    }
    const pendingAssistantOfferTranscript = getMessages(selectedConversationId, 4);
    let pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
      messages: pendingAssistantOfferTranscript,
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
      taskId: selectedConversation.actionContinuationState?.taskId,
    });
    let acceptedRuntimeCleanupOffer = resolvePendingRuntimeCleanupOffer(
      visibleUserText,
      pendingAssistantOfferContext,
    );
    const explicitRuntimeWorkStatusRequest = classifyRuntimeWorkIntent(
      visibleUserText,
      pendingAssistantOfferContext,
    ) === 'status';
    let confirmationChannelScope = buildTransportNeutralConfirmationScope({
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
    });
    let confirmationScope = buildTransportNeutralConfirmationScope({
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      conversationId: selectedConversationId,
      taskId: selectedConversation.actionContinuationState?.taskId,
    });
    const confirmationCancellationRequested = isConfirmationCancellation(visibleUserText);
    let pendingConfirmationCleared = false;
    let correctionRequiresFreshConfirmation = false;
    let executionScope: ChatExecutionScope = {
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      source: eventSource,
      conversationId: selectedConversationId,
    };
    let executionRoom = chatExecutionRoom(executionScope);
    let sessionKey = `${uid}:${resolvedDomain}:${resolvedOrgId || ''}:${eventSource}:${selectedConversationId}`;
    let resolvedTaskRelation: ActiveTaskMessageResolution | null = null;
    const refreshResolvedTaskRelationFromLedger = (
      exactConversationId: string,
      exactTaskId = resolvedTaskRelation?.taskId || '',
      exactRequestId = requestId,
    ): ActiveTaskMessageResolution | null => {
      if (!exactConversationId || !resolvedTaskRelation) return null;
      const db = readDB();
      const requestTurns = (db.conversationActionTurns || []).filter((turn: any) => (
        turn.conversationId === exactConversationId
        && turn.userId === uid
        && turn.requestId === exactRequestId
        && String(turn.taskId || '').trim()
      ));
      // A deterministic tool turn may acquire its durable task only when the
      // assistant/tool receipt is persisted. The immutable request binding is
      // safer than selecting whichever task happens to be newest.
      const requestBoundTaskId = requestTurns.length === 1
        ? String(requestTurns[0].taskId || '').trim()
        : '';
      const normalizedTaskId = String(exactTaskId || requestBoundTaskId || '').trim();
      const durableConversation = (db.conversations || []).find((candidate: any) => (
        candidate.id === exactConversationId && candidate.userId === uid
      ));
      const durableState = normalizedTaskId
        ? getConversationActionStateByTaskId(db, {
            conversationId: exactConversationId,
            userId: uid,
            taskId: normalizedTaskId,
          })
        : durableConversation?.actionContinuationState;
      if (!durableState?.taskId) return null;
      resolvedTaskRelation = {
        ...resolvedTaskRelation,
        binding: durableState.unfinished ? 'active_task' : 'previous_task',
        taskId: durableState.taskId,
        revision: durableState.revision,
        // An idle/terminal durable task no longer owns this request lease.
        targetRequestId: durableState.activeRequestId || undefined,
      };
      return resolvedTaskRelation;
    };
    const normalizeAgentPayload = (
      event: string,
      payload: Record<string, any> = {},
      outputProtection: { trustedConfirmationRequestText?: string } = {},
    ): Record<string, any> => {
      const publicPayload: Record<string, any> = event === 'agent:response'
        ? sanitizeExecutionResponseForDelivery(payload, {
            task: visibleUserText,
            ...outputProtection,
          })
        : event === 'agent:notification'
          ? sanitizeExecutionNotificationForDelivery(payload, { task: visibleUserText })
        : event === 'agent:error'
          ? sanitizeChatAgentErrorPayload(payload)
          : payload;
      const completionFeedback = normalizeCompletionFeedbackForPersistence(publicPayload.completionFeedback);
      const boundedPublicPayload = { ...publicPayload };
      delete boundedPublicPayload.completionFeedback;
      return {
        ...boundedPublicPayload,
        ...(event === 'agent:response' && latestMediaArtifactReceipt
          ? { artifactReceipt: latestMediaArtifactReceipt }
          : {}),
        // Every client-visible event carries the conversation owner.  The
        // desktop shell shares one user-level socket across Lumi, LAP, and
        // Memory Avatar surfaces; consumers must be able to reject a late
        // event from another surface instead of treating it as their own.
        agentId: conversationAgentId,
        ...(completionFeedback ? { completionFeedback } : {}),
        source: boundedPublicPayload.source || eventSource,
        requestId,
        conversationId: selectedConversationId,
        ...(resolvedTaskRelation ? { taskRelation: resolvedTaskRelation } : {}),
      };
    };
    const publishRecordedAgent = (event: string, normalizedPayload: Record<string, any>) => {
      if (event === 'agent:response') {
        // The originating native client must receive the terminal frame even
        // if its room membership changed during reconnect or conversation
        // rollover. Other signed-in clients still receive the same terminal
        // event through the user/workspace room without duplicating it here.
        socket.emit(event, normalizedPayload);
        socket.to(executionRoom).emit(event, normalizedPayload);
        return;
      }
      if (isMemoryAvatar) {
        // Memory Avatar requests are forced into the personal data scope. An
        // organization-authenticated socket may not be a member of that room,
        // so deliver its private stream/status frames directly to the socket
        // that initiated the request instead of silently dropping them.
        socket.emit(event, normalizedPayload);
        return;
      }
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = normalizeAgentPayload(event, payload);
      // A late duplicate from the same handler is not a reconnect replay. The
      // explicit request/recovery entry points above own replay delivery; doing
      // it here turns one committed terminal into a second UI terminal frame.
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
      publishRecordedAgent(event, normalizedPayload);
      return true;
    };
    const commitDeterministicTerminal = async (input: {
      event?: 'agent:response' | 'agent:error';
      payload: Record<string, any>;
      persistAssistantMessage?: () => void;
      publishAfter?: () => void;
      errorContext?: string;
    }): Promise<boolean> => {
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        return false;
      }
      const terminalEvent = input.event || 'agent:response';
      const terminalPayload = normalizeAgentPayload(terminalEvent, input.payload);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: String(input.payload.agentName || 'Lumi'),
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      const committed = await commitChatTerminalBoundary({
        persistTerminalState: () => undefined,
        persistAssistantMessage: () => {
          input.persistAssistantMessage?.();
          const relation = refreshResolvedTaskRelationFromLedger(
            selectedConversationId,
            resolvedTaskRelation?.taskId,
          );
          if (relation) {
            terminalPayload.taskRelation = relation;
            unknownPayload.taskRelation = relation;
          }
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
          executionScope,
          requestId,
          terminalEvent,
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            requestId,
            unknownPayload,
          ),
        publishCommitted: () => {
          publishRecordedAgent(terminalEvent, terminalPayload);
          input.publishAfter?.();
        },
        publishUnknown: () => {
          // The success receipt failed its strict barrier. Publish only the
          // sanitized unknown frame already installed in the in-memory
          // quarantine; do not route it through the registry a second time.
          publishRecordedAgent('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          completionFeedback: unknownPayload.completionFeedback,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => {
          console.error(`[ChatHandler] ${input.errorContext || 'Deterministic terminal'} persistence failed:`, error);
        },
      });
      if (committed) actionLeaseHeartbeat?.stop();
      return committed;
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
          const publicCode = error?.code === 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE'
            ? 'CHAT_EXECUTION_FAILED'
            : 'CHAT_CONTROL_RECEIPT_WRITE_FAILED';
          try {
            ack?.({
              ok: false,
              requestId,
              error: sanitizeChatAgentErrorPayload({ code: publicCode }).message,
            });
          } catch {}
          return;
        }
        existingExecution = getChatExecution(executionScope, requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(executionScope, requestId);
        if (durableTarget && !chatExecutionQueue.getByRequestId(sessionKey, durableTarget)) {
          // The process can restart after the durable fence but before the
          // side effect/terminal write. With no matching lease, converge the
          // tombstone to a terminal no-op; never replay cancellation onto a
          // later task.
          const staleControlPayload = normalizeAgentPayload('agent:response', {
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
          const unknownPayload = normalizeAgentPayload('agent:response', {
            text: chatDurabilityUnknownText(visibleUserText),
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'persistence_unknown',
          });
          try {
            await flushDBOrThrow();
            await recordChatExecutionTerminalEventDurably(
              executionScope,
              requestId,
              'agent:response',
              staleControlPayload,
              unknownPayload,
            );
          } catch (error: any) {
            console.error('[ChatHandler] Recovered control terminal persistence failed:', error);
            try {
              await recordChatExecutionPersistenceUnknownDurably(
                executionScope,
                requestId,
                unknownPayload,
              );
            } catch (unknownError) {
              console.error('[ChatHandler] Recovered control unknown receipt persistence failed:', unknownError);
            }
            publishRecordedAgent('agent:response', unknownPayload);
            try { ack?.({ ok: false, requestId, error: 'Terminal persistence outcome is unknown' }); } catch {}
            return;
          }
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
    const observedExistingSession = chatExecutionQueue.getCurrent(sessionKey);
    // Socket delivery happens immediately after the terminal durability fence,
    // while queue-resource release finishes a few microtasks later. A fast
    // follow-up can therefore observe the old queue slot even though its
    // request already has a durable terminal. Do not answer that follow-up as
    // "still executing"; let it queue briefly and resolve against the ledger.
    const existingSession = observedExistingSession
      && getChatExecution(executionScope, observedExistingSession.requestId)?.terminal !== true
      ? observedExistingSession
      : null;
    const controlTargetRequestId = String(data.controlTargetRequestId || '').trim().slice(0, 120);
    const controlTargetTaskId = String(data.controlTargetTaskId || '').trim().slice(0, 180);
    const controlTargetRevision = typeof data.controlTargetRevision === 'number'
      && Number.isFinite(data.controlTargetRevision)
      ? Math.max(0, Math.trunc(data.controlTargetRevision))
      : undefined;
    // The serial queue key already includes the explicitly selected
    // conversation id. Resolve status against that exact conversation; using
    // the user's globally active chat here leaks isolated/native E2E sidecars
    // into an unrelated personal transcript.
    const activeConversationForStatus = existingSession ? getConversationForScope(
      selectedConversationId,
      uid,
      resolvedDomain,
      resolvedOrgId,
    ) : null;
    resolvedTaskRelation = resolveActiveTaskMessageRelation(
      visibleUserText,
      activeConversationForStatus?.actionContinuationState || selectedConversation.actionContinuationState,
      {
        activeRequestId: existingSession?.requestId,
        controlTargetRequestId,
        controlTargetTaskId,
        controlTargetRevision,
        pendingAssistantOfferContext,
      },
    );
    const durableStatusTaskState = activeConversationForStatus?.actionContinuationState
      || selectedConversation.actionContinuationState;
    const durablePostCancelBinding = !existingSession && resolvedTaskRelation.feedback === 'status'
      ? getDurableChatCancellationForCurrentExecution(executionScope, {
          ...(durableStatusTaskState?.taskId
            ? {
                currentTask: {
                  taskId: durableStatusTaskState.taskId,
                  revision: Number.isFinite(Number(durableStatusTaskState.revision))
                    ? Math.max(0, Math.trunc(Number(durableStatusTaskState.revision)))
                    : -1,
                  activeRequestId: durableStatusTaskState.activeRequestId,
                  unfinished: durableStatusTaskState.unfinished === true,
                },
              }
            : {}),
          relation: {
            binding: resolvedTaskRelation.binding,
            taskId: resolvedTaskRelation.taskId,
            revision: resolvedTaskRelation.revision,
            targetRequestId: resolvedTaskRelation.targetRequestId,
          },
          requestedTarget: {
            requestId: controlTargetRequestId,
            taskId: controlTargetTaskId,
            revision: controlTargetRevision,
          },
        })
      : null;
    const exactPostCancelStatusTarget = durablePostCancelBinding?.targetRequestId
      && (!controlTargetRequestId || controlTargetRequestId === durablePostCancelBinding.targetRequestId)
      ? durablePostCancelBinding.targetRequestId
      : '';
    const exactPostCancelTargetTerminal = exactPostCancelStatusTarget
      ? durablePostCancelBinding?.targetTerminal || null
      : null;
    if (
      !existingSession
      && resolvedTaskRelation.feedback === 'status'
      && exactPostCancelTargetTerminal?.terminal === true
      && exactPostCancelTargetTerminal.terminalEvent
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
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
        cognitiveIntent: 'task_status',
        requestId,
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      const statusText = String(
        exactPostCancelTargetTerminal.terminalEvent.payload?.text
        || CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt,
      ).trim();
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'target_execution_status',
          controlIntent: 'status',
          targetRequestId: exactPostCancelStatusTarget,
        },
        persistAssistantMessage: () => addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId: selectedConversationId,
          role: 'assistant',
          content: statusText,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          cognitiveIntent: 'task_status',
          llmWasCalled: false,
          requestId,
          skipActionContinuation: true,
        }),
        errorContext: 'Exact post-cancellation status terminal',
      });
      return;
    }
    if (
      resolvedTaskRelation.binding === 'stale'
      && resolvedTaskRelation.relation !== 'queue'
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
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
        cognitiveIntent: 'stale_task_control',
        requestId,
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        skipActionContinuation: true,
      });
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: resolvedTaskRelation.reason,
        },
        persistAssistantMessage: () => addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId: selectedConversationId,
          role: 'assistant',
          content: CN_TASK_EXECUTION_MESSAGES.staleControl,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          cognitiveIntent: 'stale_task_control',
          llmWasCalled: false,
          requestId,
          skipActionContinuation: true,
        }),
        errorContext: 'Stale task control terminal',
      });
      return;
    }
    if (
      !existingSession
      && resolvedTaskRelation.feedback === 'cancel'
      && resolvedTaskRelation.taskId
      && selectedConversation.actionContinuationState?.unfinished
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
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
      const cancelled = cancelConversationActionExecution(
        selectedConversationId,
        uid,
        'Cancelled by the user.',
        selectedConversation.actionContinuationState?.activeRequestId
          ? controlTargetRequestId || undefined
          : undefined,
      );
      const clearedTaskConfirmation = await clearPendingConfirmationDurably(uid, confirmationScope);
      const clearedTasklessConfirmation = await clearPendingConfirmationDurably(uid, confirmationChannelScope);
      pendingConfirmationCleared = clearedTaskConfirmation || clearedTasklessConfirmation;
      const cancelledCurrentTask = cancelled?.taskId === resolvedTaskRelation.taskId
        && cancelled.status === 'cancelled';
      const responseText = cancelledCurrentTask
        ? CN_TASK_EXECUTION_MESSAGES.cancelled
        : CN_TASK_EXECUTION_MESSAGES.staleControl;
      if (cancelledCurrentTask) {
        resolvedTaskRelation = { ...resolvedTaskRelation, revision: cancelled?.revision };
      }
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: responseText,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: cancelledCurrentTask ? 'cancelled_by_user' : 'stale_control',
        },
        persistAssistantMessage: () => addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId: selectedConversationId,
          role: 'assistant',
          content: responseText,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          cognitiveIntent: 'task_cancel',
          requestId,
          skipActionContinuation: true,
        }),
        errorContext: 'Task cancellation terminal',
      });
      return;
    }
    if (
      existingSession
      && !buildDeterministicWorkTaskStatusCommand(visibleUserText)
      && resolvedTaskRelation.feedback === 'status'
    ) {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      // Natural-language status controls do not carry UI fence metadata. The
      // server-observed foreground lease is authoritative in that case; an
      // explicitly supplied stale target was already rejected above.
      if (controlTargetRequestId && controlTargetRequestId !== existingSession.requestId) {
        try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
        await commitDeterministicTerminal({ payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        }, errorContext: 'Stale status control terminal' });
        return;
      }
      const activeConversation = activeConversationForStatus || selectedConversation;
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
      const statusText = activeConversation && resolvedTaskRelation.taskId
        ? getConversationActionStatus(activeConversation.id, uid, visibleUserText, activeConversation.actionContinuationState)
        : CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
      await commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: activeConversation
          ? () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: activeConversation.id, role: 'assistant', content: statusText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_status', requestId, skipActionContinuation: true })
          : undefined,
        errorContext: 'Active task status terminal',
      });
      return;
    }

    // A new utterance does not destroy an active task. Continuations and
    // independent work wait behind the current foreground lease; only an
    // explicit replacement aborts it.
    const previousSession = chatExecutionQueue.getTail(sessionKey);
    if (previousSession && previousSession.requestId !== existingSession?.requestId) {
      resolvedTaskRelation = resolveActiveTaskMessageRelation(
        visibleUserText,
        activeConversationForStatus?.actionContinuationState || selectedConversation.actionContinuationState,
        {
          activeRequestId: previousSession.requestId,
          controlTargetRequestId,
          controlTargetTaskId,
          controlTargetRevision,
          pendingAssistantOfferContext,
        },
      );
    }
    const activeMessageRelation = previousSession ? resolvedTaskRelation.relation : null;
    let acknowledged = false;
    if (previousSession && activeMessageRelation === 'cancel') {
      if (!beginChatSidecarExecution(executionScope, requestId)) return;
      // A typed/spoken "停止" has no client request id. Bind it to the exact
      // server-owned lease selected by the resolver. UI controls may still
      // supply an immutable fence, and stale explicit fences are rejected
      // before this branch.
      const cancellationTargetRequestId = controlTargetRequestId
        || resolvedTaskRelation.targetRequestId
        || previousSession.requestId;
      try {
        // A buffered cancellation must be durably fenced before it can touch
        // the foreground queue. On restart, this tombstone makes replay a
        // status lookup instead of a second cancellation of newer work.
        await persistChatSidecarCancellationIntent(executionScope, requestId, cancellationTargetRequestId);
      } catch (error: any) {
        const publicError = sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED' });
        await commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: publicError.message,
            code: 'CHAT_CONTROL_RECEIPT_WRITE_FAILED',
            sidecar: true,
          },
          errorContext: 'Cancellation reservation failure terminal',
        });
        try { ack?.({ ok: false, requestId, error: publicError.message }); } catch {}
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
      const currentTarget = chatExecutionQueue.getByRequestId(sessionKey, cancellationTargetRequestId);
      if (!currentTarget) {
        await commitDeterministicTerminal({
          payload: {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          },
          persistAssistantMessage: () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.staleControl, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true }),
          errorContext: 'Stale cancellation terminal',
        });
        return;
      }
      try {
        await chatExecutionQueue.cancelRequest(sessionKey, cancellationTargetRequestId);
      } catch (error: any) {
        const settlementTimedOut = error?.code === 'serial_execution_cancellation_timeout';
        const failureText = settlementTimedOut
          ? CN_TASK_EXECUTION_MESSAGES.cancellationSettlementTimedOut
          : sanitizeChatAgentErrorPayload({ code: 'CHAT_CONTROL_CANCEL_FAILED' }).message;
        await commitDeterministicTerminal({
          ...(settlementTimedOut ? {} : { event: 'agent:error' as const }),
          payload: settlementTimedOut ? {
            text: failureText,
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'cancellation_settlement_timeout',
          } : {
            message: failureText,
            code: 'CHAT_CONTROL_CANCEL_FAILED',
            sidecar: true,
          },
          persistAssistantMessage: settlementTimedOut ? () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: failureText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'cancellation_settlement_timeout', requestId, skipActionContinuation: true }) : undefined,
          errorContext: settlementTimedOut
            ? 'Cancellation settlement timeout terminal'
            : 'Cancellation failure terminal',
        });
        return;
      }
      await commitDeterministicTerminal({
        payload: {
          text: CN_TASK_EXECUTION_MESSAGES.cancelled,
          agentName: 'Lumi',
          source: eventSource,
          requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'cancelled_by_user',
        },
        persistAssistantMessage: () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: CN_TASK_EXECUTION_MESSAGES.cancelled, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true }),
        errorContext: 'Cancellation completion terminal',
      });
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
    let conversation = conversationTurn.conversation;
    if (conversation.id !== selectedConversationId) {
      selectedConversationId = conversation.id;
      pendingAssistantOfferContext = undefined;
      acceptedRuntimeCleanupOffer = null;
      confirmationChannelScope = buildTransportNeutralConfirmationScope({
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        conversationId: selectedConversationId,
      });
      confirmationScope = buildTransportNeutralConfirmationScope({
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
    const chatAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => addMessageIdempotent({
        userId: uid,
        agentId: conversationAgentId,
        conversationId: conversation.id,
        role: 'user',
        content: storedUserContent,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: eventSource,
        channel: 'chat',
        cognitiveIntent: confirmationCancellationRequested
          ? 'task_cancel'
          : resolvedTaskRelation.binding === 'active_task' || resolvedTaskRelation.binding === 'previous_task'
            ? `task_${resolvedTaskRelation.feedback}`
            : undefined,
        requestId,
        receivedAt: requestReceivedAt,
        timestamp: requestReceivedAt,
        deferActionPreparation: !confirmationCancellationRequested,
        skipActionContinuation: confirmationCancellationRequested,
      }),
      flush: flushDBOrThrow,
      onPersistenceUnknown: error => {
        console.error('[ChatHandler] Accepted user turn could not be flushed:', error);
        const unknownPayload = normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
        });
        publishRecordedAgent('agent:response', unknownPayload);
        try { ack?.({ ok: false, requestId, error: 'Accepted user turn persistence is unknown' }); } catch {}
      },
    });
    if (!chatAdmission) {
      return;
    }
    const acceptedUserMessageId = chatAdmission.persisted;
    if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
      await runAfterAcceptedUserTurnAdmission(chatAdmission, () => (
        clearPendingConfirmationDurably(uid, buildTransportNeutralConfirmationScope({
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          conversationId: conversationTurn.previousConversationId!,
        }))
      ));
    }
    const confirmationResolution = await resolveAcceptedTurnConfirmation({
      admission: chatAdmission,
      userId: uid,
      userText: visibleUserText,
      actionState: conversation.actionContinuationState,
      taskScope: confirmationScope,
      channelScope: confirmationChannelScope,
    });
    pendingConfirmation = confirmationResolution.pending;
    pendingConfirmationPrompt = confirmationResolution.prompt;
    confirmationScope = confirmationResolution.scope;
    pendingConfirmationCleared = confirmationResolution.cleared;
    correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

    // Install the lease before waiting. Otherwise two messages arriving while
    // the same task is active both wait for that task and wake concurrently,
    // allowing the later request to supersede the earlier queued request.
    const sessionLease = runAfterAcceptedUserTurnAdmission(chatAdmission, () => {
      if (previousSession && activeMessageRelation === 'replace') {
        void chatExecutionQueue.cancelAll(sessionKey);
      }
      beginQueuedChatExecution(executionScope, requestId);
      return chatExecutionQueue.reserve(sessionKey, requestId);
    });
    const abortController = sessionLease.controller;
    let releaseDesktopControlLease: (() => void) | null = null;
    let foregroundRequestIdentity: ChatForegroundRequestIdentity | null = null;
    const releaseChatTransportResources = (): void => {
      actionLeaseHeartbeat?.stop();
      releaseDesktopControlLease?.();
      releaseDesktopControlLease = null;
      sessionLease.release();
    };
    const chatReleaseGate = createDurableForegroundReleaseGate({
      converge: async reason => {
        // Pre-binding exits own no durable action-turn lease.
        if (!foregroundRequestIdentity) return true;
        const releaseResult = await convergeChatForegroundRequestBeforeRelease({
          identity: foregroundRequestIdentity,
          aborted: abortController.signal.aborted,
          reason,
        });
        if (!releaseResult.converged) {
          console.error('[ChatHandler] foreground_request_finalization_incomplete', {
            code: 'CHAT_FOREGROUND_FINALIZATION_INCOMPLETE',
            identity: foregroundRequestIdentity,
            convergence: {
              finalStatus: releaseResult.convergence.finalStatus,
              reason: releaseResult.convergence.reason,
              evidence: releaseResult.convergence.evidence,
            },
            finalization: releaseResult.finalization ? {
              effectiveOutcome: releaseResult.finalization.effectiveOutcome,
              taskStatus: releaseResult.finalization.taskStatus,
              actionTurnStatus: releaseResult.finalization.actionTurnStatus,
              reason: releaseResult.finalization.reason,
              evidence: releaseResult.finalization.evidence,
            } : null,
          });
        }
        return releaseResult.converged;
      },
      releaseResources: releaseChatTransportResources,
      onFailure: ({ error }) => {
        if (error instanceof Error && error.message === 'foreground_request_not_durably_converged') return;
        const convergenceError = error as any;
        console.error('[ChatHandler] foreground_request_finalization_failed', {
          code: 'CHAT_FOREGROUND_FINALIZATION_FAILED',
          identity: foregroundRequestIdentity,
          errorName: String(convergenceError?.name || 'Error'),
          errorMessage: String(convergenceError?.message || 'Unknown convergence error'),
        });
      },
      onRecoveryTakeover: ({ attempts }) => console.error('[ChatHandler] foreground_release_recovery_takeover', {
        code: 'CHAT_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
        identity: foregroundRequestIdentity,
        attempts,
      }),
    });
    const releaseChatSession = (
      reason = 'Chat foreground request reached its release boundary.',
    ): Promise<boolean> => chatReleaseGate.release(reason);

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
        taskRelation: resolvedTaskRelation,
      });
    }
    if (!await sessionLease.waitForTurn()) {
      const waitTimedOut = sessionLease.state === 'timed_out';
      const terminalText = waitTimedOut
        ? CN_TASK_EXECUTION_MESSAGES.queueWaitTimedOut
        : CN_TASK_EXECUTION_MESSAGES.cancelled;
      await commitDeterministicTerminal({
        payload: {
          text: terminalText,
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: waitTimedOut ? 'queue_wait_timeout' : 'cancelled',
        },
        persistAssistantMessage: () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId: selectedConversationId, role: 'assistant', content: terminalText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: waitTimedOut ? 'queue_wait_timeout' : 'task_cancel', requestId }),
        errorContext: waitTimedOut ? 'Queued wait timeout terminal' : 'Queued cancellation terminal',
      });
      await releaseChatSession();
      return;
    }
    let superseded = null as Awaited<ReturnType<typeof beginChatExecutionDurably>>;
    try {
      superseded = await runAfterAcceptedUserTurnAdmission(
        chatAdmission,
        () => beginChatExecutionDurably(executionScope, requestId, {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: 'Lumi',
        }),
      );
    } catch (error) {
      console.error('[ChatHandler] Superseded terminal persistence failed:', error);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          executionScope,
          requestId,
          unknownPayload,
        );
      } catch (unknownError) {
        console.error('[ChatHandler] Replacement unknown receipt persistence failed:', unknownError);
      }
      publishRecordedAgent('agent:response', unknownPayload);
      await releaseChatSession();
      return;
    }
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    if (!acknowledged) {
      try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    }

    try {
      // The turn may have waited behind one or more executions. Re-read the
      // durable conversation and resolve the user's feedback against that
      // exact revision. Never merge a receive-time task id/revision over a
      // newer state: explicit controls are optimistic-concurrency fences.
      const refreshedConversation = getConversationForScope(
        conversation.id,
        uid,
        resolvedDomain,
        resolvedOrgId,
      );
      if (!refreshedConversation) {
        await commitDeterministicTerminal({
          event: 'agent:error',
          payload: {
            message: 'Conversation is unavailable for this user or workspace',
            code: 'CHAT_CONVERSATION_REFRESH_FAILED',
          },
          errorContext: 'Conversation refresh failure terminal',
        });
        await releaseChatSession();
        return;
      }
      conversation = refreshedConversation;
      resolvedTaskRelation = resolveActiveTaskMessageRelation(
        visibleUserText,
        conversation.actionContinuationState,
        {
          activeRequestId: conversation.actionContinuationState?.activeRequestId,
          controlTargetRequestId,
          controlTargetTaskId,
          controlTargetRevision,
          pendingAssistantOfferContext,
        },
      );
      emitAgent('agent:task_relation', { relation: resolvedTaskRelation });
      if (resolvedTaskRelation.binding === 'stale') {
        await commitDeterministicTerminal({
          payload: {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: resolvedTaskRelation.reason || 'stale_control',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: conversation.id,
            role: 'assistant',
            content: CN_TASK_EXECUTION_MESSAGES.staleControl,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: eventSource,
            channel: 'chat',
            cognitiveIntent: 'stale_task_control',
            llmWasCalled: false,
            requestId,
            skipActionContinuation: true,
          }),
          errorContext: 'Stale foreground task terminal',
        });
        await releaseChatSession();
        return;
      }

      if (resolvedTaskRelation.feedback === 'repeat') {
        // Restatement is an exact adjacent-turn read, not a planning request.
        // Resolve it from the persisted transcript so it cannot fall back to
        // an older task, consume model capacity, or inherit tool permissions.
        const repeatTranscript = getMessages(conversation.id);
        let acceptedRepeatIndex = -1;
        for (let index = repeatTranscript.length - 1; index >= 0; index -= 1) {
          const item = repeatTranscript[index];
          if (
            item.role === 'user'
            && String(item.requestId || item.externalMessageId || '') === requestId
          ) {
            acceptedRepeatIndex = index;
            break;
          }
        }
        const responseText = findLatestRepeatableAssistantReply(
          acceptedRepeatIndex >= 0 ? repeatTranscript.slice(0, acceptedRepeatIndex) : [],
        ) || CN_TASK_EXECUTION_MESSAGES.noRepeatableReply;
        await commitDeterministicTerminal({
          payload: {
            text: responseText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'repeat_previous_reply',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: conversation.id,
            role: 'assistant',
            content: responseText,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: eventSource,
            channel: 'chat',
            cognitiveIntent: 'task_repeat',
            llmWasCalled: false,
            requestId,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: eventSource,
          }),
          errorContext: 'Adjacent reply repeat terminal',
        });
        await releaseChatSession();
        return;
      }

      const adjacentConfirmedAction = !pendingConfirmation
        && !conversation.actionContinuationState?.unfinished
        && isExplicitConfirmationReply(visibleUserText)
        ? findAdjacentVerifiedConfirmedAction({
            messages: getMessages(conversation.id, 32),
            currentRequestId: requestId,
          })
        : null;
      const repeatedConfirmationWithoutPending = Boolean(adjacentConfirmedAction);
      if (repeatedConfirmationWithoutPending) {
        const responseText = CN_TASK_EXECUTION_MESSAGES.noPendingConfirmation;
        await commitDeterministicTerminal({
          payload: {
            text: responseText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'no_pending_confirmation',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: conversation.id,
            role: 'assistant',
            content: responseText,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: eventSource,
            channel: 'chat',
            cognitiveIntent: 'duplicate_confirmation_noop',
            llmWasCalled: false,
            requestId,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: eventSource,
          }),
          errorContext: 'Duplicate confirmation no-op terminal',
        });
        await releaseChatSession();
        return;
      }

      // Prior-turn receipt questions are deterministic ledger reads. Resolve
      // them before memory embeddings, RAG, personality assembly, or any model
      // client so a slow provider cannot block a local execution-status answer.
      const runtimeStatusOwnsThisTurn = explicitRuntimeWorkStatusRequest
        && !(
          resolvedTaskRelation.feedback === 'status'
          && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
          && Boolean(resolvedTaskRelation.taskId)
        );
      const acceptedFollowupIntent = runtimeStatusOwnsThisTurn
        ? 'none' as const
        : resolvedTaskRelation.binding === 'active_task'
          || resolvedTaskRelation.binding === 'previous_task'
          ? resolvedTaskRelation.feedback === 'status'
            ? 'status' as const
            : ['continue', 'correction', 'accept', 'retry'].includes(resolvedTaskRelation.feedback)
              ? 'execute' as const
              : classifyConversationActionFollowupIntent(
                  visibleUserText,
                  conversation.actionContinuationState,
                )
          : classifyConversationActionFollowupIntent(
              visibleUserText,
              conversation.actionContinuationState,
            );
      const acceptedNormalizedIntent = normalizeActionIntent(visibleUserText);
      const confirmationNeedsFreshReview = Boolean(
        acceptedFollowupIntent === 'status'
        && isExplicitConfirmationReply(visibleUserText)
        && conversationActionRequiresFreshConfirmationReview(
          conversation.actionContinuationState,
        ),
      );
      const asksToRecheckPreviousAction = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'previous_action';
      const asksAboutBoundConversationTask = acceptedFollowupIntent === 'status'
        && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
        && Boolean(resolvedTaskRelation.taskId)
        && (
          acceptedNormalizedIntent.kind === 'none'
          || (
            acceptedNormalizedIntent.kind === 'status_query'
            && ['previous_action', 'recent_task'].includes(acceptedNormalizedIntent.target)
          )
        );
      const asksAboutRecentConversationTask = acceptedFollowupIntent === 'status'
        && acceptedNormalizedIntent.kind === 'status_query'
        && acceptedNormalizedIntent.target === 'recent_task';
      const serverBoundRecheckTaskId = asksToRecheckPreviousAction
        ? String(resolvedTaskRelation.taskId || '').trim()
        : '';
      const mayUseUnboundRecheckFallback = asksToRecheckPreviousAction
        && !serverBoundRecheckTaskId
        && resolvedTaskRelation.binding === 'conversation'
        && !controlTargetRequestId
        && !controlTargetTaskId
        && controlTargetRevision === undefined;
      const previousActionState = asksToRecheckPreviousAction
        ? serverBoundRecheckTaskId
          ? getConversationActionStateByTaskId(readDB(), {
              conversationId: conversation.id,
              userId: uid,
              taskId: serverBoundRecheckTaskId,
            })
          : mayUseUnboundRecheckFallback
            ? getConversationActionStateFromLedger(readDB(), {
                conversationId: conversation.id,
                userId: uid,
                query: visibleUserText,
              })
            : null
        : null;
      const runtimeCancellationRecheck = pendingRuntimeCancellationRecheck(previousActionState);
      if (runtimeCancellationRecheck) {
        const recheckPolicy = {
          allowedTools: ['runtime_work_cancel'],
          requireConfirmation: [],
          forbiddenTools: [],
          maxIterations: 1,
        };
        const recheckPreparation = prepareConversationActionExecution({
          conversationId: conversation.id,
          userId: uid,
          userText: visibleUserText,
          requestId,
          userMessageId: acceptedUserMessageId,
          toolPolicy: recheckPolicy,
          forceResume: true,
          forceNewTask: false,
          forceTask: true,
          preserveExistingTask: true,
        });
        if (recheckPreparation.state?.taskId === runtimeCancellationRecheck.taskId) {
          const recheckState = recheckPreparation.state;
          foregroundRequestIdentity = Object.freeze({
            conversationId: conversation.id,
            userId: uid,
            requestId,
            expectedTaskId: runtimeCancellationRecheck.taskId,
          });
          resolvedTaskRelation = {
            ...resolvedTaskRelation,
            binding: 'active_task',
            taskId: recheckState.taskId,
            revision: recheckState.revision,
            targetRequestId: recheckState.activeRequestId || requestId,
          };
          emitAgent('agent:task_relation', {
            relation: resolvedTaskRelation,
            phase: 'runtime_cleanup_recheck_prepared',
          });
          const recheckRecord = await executeToolCall({
            registry: toolRegistry,
            id: `runtime_cleanup_recheck_${requestId}`,
            name: 'runtime_work_cancel',
            arguments: { taskIds: [...runtimeCancellationRecheck.taskIds] },
            executionOrigin: 'deterministic_route',
            context: {
              ...toolSecurityContext,
              userId: uid,
              taskId: runtimeCancellationRecheck.taskId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              source: 'chat_runtime_cleanup_recheck',
              toolPolicy: recheckPolicy,
              actionIntent: previousActionState?.goal || visibleUserText,
              routedTaskText: previousActionState?.goal || visibleUserText,
              // This is an idempotent verification of the exact immutable IDs
              // accepted in the immediately preceding cancellation receipt,
              // not fresh mutation authority and never a cancel-all request.
              userConfirmed: true,
              executionSignal: abortController.signal,
              isCancelled: () => abortController.signal.aborted,
            },
          });
          const recheckLifecycle = {
            correlationId: recheckRecord.id || `runtime_cleanup_recheck_${requestId}`,
            name: recheckRecord.name,
            arguments: recheckRecord.arguments,
            args: recheckRecord.arguments,
            result: recheckRecord.error ? undefined : formatToolResultForUi(recheckRecord.result),
            error: recheckRecord.error,
          };
          emitAgent('agent:tool_call', recheckLifecycle);
          emitAgent('agent:tool', recheckLifecycle);
          let recheckReceipt: Record<string, any> = {
            ok: false,
            status: 'failed',
            requestedTaskIds: runtimeCancellationRecheck.taskIds,
            cancelledTaskIds: [],
            cancellingTaskIds: [],
            notCancelledTaskIds: runtimeCancellationRecheck.taskIds,
            targetResults: runtimeCancellationRecheck.taskIds.map(taskId => ({ taskId, status: 'failed' })),
          };
          try {
            const parsed = JSON.parse(String(recheckRecord.result || '{}'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              recheckReceipt = parsed;
            }
          } catch {}
          const recheckSettled = !recheckRecord.error
            && recheckRecord.terminalVerification?.status === 'verified'
            && ['idle', 'cancelled'].includes(String(recheckReceipt.status || ''));
          const recheckPending = !recheckRecord.error
            && String(recheckReceipt.status || '') === 'cancelling';
          const recheckReason = recheckSettled
            ? 'runtime_cleanup_recheck_completed'
            : recheckPending
              ? 'runtime_cleanup_recheck_pending'
              : 'runtime_cleanup_recheck_failed';
          const recheckText = formatRuntimeCleanupReceipt(visibleUserText, recheckReceipt);
          const recheckCompletionFeedback = buildForegroundTaskCompletionFeedback({
            taskId: runtimeCancellationRecheck.taskId,
            taskLabel: previousActionState?.goal || visibleUserText,
            toolRecords: [recheckRecord],
            blocked: !recheckSettled,
            reason: recheckSettled
              ? ''
              : recheckPending
                ? 'Cancellation is still in progress.'
                : recheckRecord.error
                  || recheckRecord.terminalVerification?.reason
                  || 'The exact runtime cancellation could not be verified.',
          });
          await commitDeterministicTerminal({
            payload: {
              text: recheckText,
              agentName: 'Lumi',
              finalized: true,
              blocked: !recheckSettled,
              reason: recheckReason,
              completionFeedback: recheckCompletionFeedback,
            },
            persistAssistantMessage: () => {
              const summary = summarizeToolRecordForPersistence(recheckRecord);
              if (summary) {
                addMessage({
                  userId: uid,
                  agentId: conversationAgentId,
                  conversationId: conversation.id,
                  role: 'tool',
                  content: summary,
                  domain: resolvedDomain,
                  orgId: resolvedOrgId,
                });
              }
              addMessageIdempotent({
                userId: uid,
                agentId: conversationAgentId,
                conversationId: conversation.id,
                role: 'assistant',
                content: recheckText,
                personality: personalityRegistry.get('lumi')?.id || 'lumi',
                domain: resolvedDomain,
                orgId: resolvedOrgId,
                source: 'chat_runtime_cleanup_recheck',
                channel: 'chat',
                toolCalls: [recheckRecord],
                cognitiveIntent: recheckReason,
                llmWasCalled: false,
                requestId,
                completionFeedback: recheckCompletionFeedback,
              });
            },
            publishAfter: () => emitConversationUpdated({
              conversationId: conversation.id,
              agentId: conversationAgentId,
              source: 'chat_runtime_cleanup_recheck',
              rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            }),
            errorContext: 'Runtime cleanup recheck terminal',
          });
          await releaseChatSession();
          return;
        }
      }
      if (
        acceptedFollowupIntent === 'status'
        && (
          confirmationNeedsFreshReview
          || asksAboutBoundConversationTask
          || asksAboutRecentConversationTask
          || (
            acceptedNormalizedIntent.kind === 'status_query'
            && acceptedNormalizedIntent.target === 'previous_action'
          )
        )
      ) {
        const executionFactQuestion = isConversationExecutionFactQuestion(visibleUserText);
        const statusText = executionFactQuestion
          ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
              conversationId: conversation.id,
              userId: uid,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              currentRequestId: requestId,
              taskId: serverBoundRecheckTaskId || previousActionState?.taskId || '',
            }), visibleUserText)
          : getConversationActionStatus(
              conversation.id,
              uid,
              visibleUserText,
              conversation.actionContinuationState,
              resolvedTaskRelation.taskId || '',
            );
        const responseIntent = executionFactQuestion
          ? 'execution_facts'
          : confirmationNeedsFreshReview
            ? 'reconfirmation_required'
            : 'task_status';
        await commitDeterministicTerminal({
          payload: {
            text: statusText,
            agentName: 'Lumi',
            finalized: true,
            blocked: confirmationNeedsFreshReview,
            reason: responseIntent,
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: conversation.id,
            role: 'assistant',
            content: statusText,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: executionFactQuestion ? 'chat_conversation_execution_facts' : 'chat_task_status',
            channel: 'chat',
            cognitiveIntent: responseIntent,
            llmWasCalled: false,
            requestId,
            skipActionContinuation: true,
          }),
          publishAfter: () => {
            emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: executionFactQuestion ? 'chat_conversation_execution_facts' : 'chat_task_status',
            rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            });
          },
          errorContext: 'Deterministic task status terminal',
        });
        await releaseChatSession();
        return;
      }

      // `deferActionPreparation` persisted only the transcript while this
      // request waited. Now that this request owns the serial lease, bind its
      // exact user row. A different pending request is an integrity failure,
      // not permission to overwrite the pointer and mis-attribute receipts.
      if (resolvedTaskRelation.feedback !== 'status') {
        const preserveExistingTask = (
          ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
          && ['continue', 'correction', 'accept', 'retry', 'repeat'].includes(
            resolvedTaskRelation.feedback,
          )
        );
        const boundTurn = bindConversationActionExecutionTurn({
          conversationId: conversation.id,
          userId: uid,
          userText: visibleUserText,
          requestId,
          userMessageId: acceptedUserMessageId,
          preserveExistingTask,
        });
        if (!boundTurn) {
          await commitDeterministicTerminal({
            event: 'agent:error',
            payload: {
              message: 'Unable to bind this queued message to the action pipeline',
              code: 'CHAT_ACTION_TURN_BIND_FAILED',
            },
            errorContext: 'Action turn binding failure terminal',
          });
          await releaseChatSession();
          return;
        }
        conversation = getConversationForScope(
          conversation.id,
          uid,
          resolvedDomain,
          resolvedOrgId,
        ) || conversation;
      }

      // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
      const personalityConfig = isMemoryAvatar && memoryAvatar?.personalityConfig
        ? memoryAvatar.personalityConfig
        : personalityRegistry.getForUser(
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
        userId: uid,
        query: text,
        limit: isMemoryAvatar ? Math.min(20, Number(memoryAvatar?.personalityConfig?.memoryPolicy?.retrieveLimit) || 10) : 5,
        minConfidence: isMemoryAvatar ? (Number(memoryAvatar?.personalityConfig?.memoryPolicy?.minConfidence) || 0.3) : 0.4,
        agentId: isMemoryAvatar ? conversationAgentId : undefined,
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
      const ragAgentIds = isMemoryAvatar
        ? [conversationAgentId]
        : Array.from(new Set([conversationAgentId, 'lumi'].filter(Boolean)));
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

      const emotionKey = scopedEmotionalStateKey(uid, requestScope, isMemoryAvatar ? conversationAgentId : undefined);
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
        await clearPendingConfirmationDurably(uid, confirmationScope);
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
        const cancelledCurrentTask = cancelled?.status === 'cancelled';
        if (cancelledCurrentTask || pendingConfirmationCleared) {
          const responseText = pendingConfirmationCleared
            ? '已取消刚才等待确认的操作；它没有执行，也不会继续发送。'
            : CN_TASK_EXECUTION_MESSAGES.cancelled;
          await commitDeterministicTerminal({
            payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
            persistAssistantMessage: () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true }),
            publishAfter: () => emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId }),
            errorContext: 'Pending confirmation cancellation terminal',
          });
          await releaseChatSession();
          return;
        }
        const boundTerminalTask = resolvedTaskRelation.taskId
          ? getConversationActionStateByTaskId(readDB(), {
              conversationId,
              userId: uid,
              taskId: resolvedTaskRelation.taskId,
            })
          : getLatestConversationActionState(readDB(), { conversationId, userId: uid });
        if (boundTerminalTask && !boundTerminalTask.unfinished) {
          const english = !/[\u3400-\u9fff]/u.test(visibleUserText);
          const responseText = english
            ? boundTerminalTask.status === 'completed'
              ? `The task "${boundTerminalTask.goal || 'the previous task'}" is already completed. Cancellation cannot undo its recorded result, and I did not execute anything again.`
              : `The task "${boundTerminalTask.goal || 'the previous task'}" is already ${boundTerminalTask.status || 'terminal'}. There is nothing left to stop, and I did not execute anything again.`
            : CN_TASK_EXECUTION_MESSAGES.terminalCannotCancel(
                boundTerminalTask.goal,
                boundTerminalTask.status || 'terminal',
              );
          await commitDeterministicTerminal({
            payload: {
              text: responseText,
              agentName: 'Lumi',
              finalized: true,
              blocked: false,
              reason: 'task_already_terminal',
            },
            persistAssistantMessage: () => addMessageIdempotent({
              userId: uid,
              agentId: conversationAgentId,
              conversationId,
              role: 'assistant',
              content: responseText,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              source: eventSource,
              channel: 'chat',
              cognitiveIntent: 'task_already_terminal',
              llmWasCalled: false,
              requestId,
              skipActionContinuation: true,
            }),
            publishAfter: () => emitConversationUpdated({
              conversationId,
              agentId: conversationAgentId,
              source: 'chat',
              rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            }),
            errorContext: 'Terminal task cancellation no-op',
          });
          await releaseChatSession();
          return;
        }
        const responseText = '当前没有等待确认或正在执行的操作。';
        await commitDeterministicTerminal({
          payload: { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' },
          persistAssistantMessage: () => addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'task_cancel', requestId, skipActionContinuation: true }),
          publishAfter: () => emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId }),
          errorContext: 'No pending confirmation terminal',
        });
        await releaseChatSession();
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
      actionContinuationBridge = explicitRuntimeWorkStatusRequest
        ? ''
        : buildRecentActionContinuationBridge(
            visibleUserText,
            conversationTurn.rolledOver
              ? persistedConversationHistory
              : [...historyItems, ...persistedConversationHistory],
            conversation?.actionContinuationState,
          );
      const taskRelationContext = formatActiveTaskRelationContext(
        resolvedTaskRelation,
        conversation?.actionContinuationState,
      );
      if (taskRelationContext) {
        actionContinuationBridge = [actionContinuationBridge, taskRelationContext]
          .filter(Boolean)
          .join('\n\n');
      }
      const operationMode = (() => {
        if (typeof data.operationMode === 'string') return normalizeOperationMode(data.operationMode);
        try {
          return getStoredOperationMode(uid);
        } catch {}
        return 'assistant';
      })();

      const sensory = sensoryFn(uid);
      console.log('[ChatHandler] sensory loaded');
      const personalityContext = {
        mode: 'chat' as const,
        sensory,
      };
      const personalityOptions = {
        memories: relevantMemories.length > 0 ? relevantMemories : undefined,
        ragKnowledge: ragChunks.length > 0 ? ragChunks : undefined,
        emotionalState,
        userId: uid,
        userText: text,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
      };
      const { config: personality, systemPrompt: systemInstruction } = isMemoryAvatar
        ? {
            config: personalityConfig,
            systemPrompt: generateSystemPrompt(
              personalityConfig as any,
              personalityContext,
              personalityOptions,
            ),
          }
        : personalityRegistry.buildSystemPrompt(
            personalityId,
            personalityContext,
            personalityOptions,
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
      const currentTurnDecisionText = [
        visibleUserText || text,
        ...(attachments.length > 0 ? [attachmentContext] : []),
        mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');
      const continuationContext = [chatContextBridge, actionContinuationBridge, pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n');
      const executionTaskText = [
        text,
        actionContinuationBridge,
        mediaRoutingEnvelope,
      ].filter(Boolean).join('\n\n');

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
        pendingAssistantOfferContext,
        isSanctuary: isMemoryAvatar,
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
        artifactReceipt?: MediaArtifactReceipt;
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
            getToolNames: () => toolRegistry.getToolDeclarations({
              context: { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource },
            }).map(declaration => declaration.function.name),
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            defaultSourceInteractionId: interactionId,
            agentId: conversationAgentId,
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
        return executionWriteback;
      };
      const refreshDurableTaskRelation = (
        exactTaskId = resolvedTaskRelation?.taskId || '',
      ): ActiveTaskMessageResolution | null => {
        return refreshResolvedTaskRelationFromLedger(conversationId, exactTaskId);
      };
      const refreshTerminalPayloadTaskRelation = (
        payload: Record<string, any>,
        exactTaskId = resolvedTaskRelation?.taskId || '',
      ) => {
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (relation) payload.taskRelation = relation;
        return relation;
      };
      const publishDurableTaskRelation = (exactTaskId = resolvedTaskRelation?.taskId || '') => {
        const relation = refreshDurableTaskRelation(exactTaskId);
        if (!relation) return;
        io.to(executionRoom).emit('agent:task_relation', {
          relation,
          taskRelation: relation,
          source: eventSource,
          requestId,
          conversationId,
          phase: 'terminal_persisted',
        });
      };

      const actionFollowupIntent = acceptedFollowupIntent;
      const operationModeMetaText = buildOperationModeMetaResponse({
        text: visibleUserText,
        operationMode: turnFlow.operationMode,
        source: eventSource,
      });
      const executionFactText = conversationId && isConversationExecutionFactQuestion(visibleUserText)
        ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId,
          userId: uid,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          currentRequestId: requestId,
        }), visibleUserText)
        : '';
      const exactCorrectionText = conversationId
        ? resolveExactConversationCorrection(visibleUserText, persistedConversationHistory)
        : null;
      const deterministicConversationResponse = operationModeMetaText
        ? {
            text: operationModeMetaText,
            intent: 'operation_mode_facts',
            source: 'chat_operation_mode_facts',
          }
        : executionFactText
        ? {
            text: executionFactText,
            intent: 'execution_facts',
            source: 'chat_conversation_execution_facts',
          }
        : exactCorrectionText
          ? {
              text: exactCorrectionText,
              intent: 'exact_correction',
              source: 'chat_exact_correction',
            }
          : null;
      if (deterministicConversationResponse) {
        await commitDeterministicTerminal({
          payload: {
            text: deterministicConversationResponse.text,
            agentName: personality.name,
            finalized: true,
            blocked: false,
            reason: deterministicConversationResponse.intent,
          },
          persistAssistantMessage: conversationId
            ? () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId,
            role: 'assistant',
            content: deterministicConversationResponse.text,
            personality: personality.id,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: deterministicConversationResponse.source,
            channel: 'chat',
            cognitiveIntent: deterministicConversationResponse.intent,
            llmWasCalled: false,
            requestId,
          })
            : undefined,
          publishAfter: conversationId
            ? () => {
            emitConversationUpdated({
            conversationId,
            agentId: conversationAgentId,
            source: deterministicConversationResponse.source,
            rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            });
          }
            : undefined,
          errorContext: 'Deterministic conversation terminal',
        });
        await releaseChatSession();
        return;
      }

      const groundedTurnEvidence: string[] = [];
      if (conversationId && actionFollowupIntent === 'status') {
        groundedTurnEvidence.push(`Current action status evidence:\n${getConversationActionStatus(
          conversationId,
          uid,
          visibleUserText,
          conversation?.actionContinuationState,
          resolvedTaskRelation.taskId || '',
        )}`);
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

      let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
      let runtimeOwnedDeterministicRecoveryCall: ToolContext['runtimeOwnedDeterministicRecoveryCall'] | null = null;
      let pendingConfirmationAssistantState = '';
      const requestToolConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
        if (pendingConfirmationCreatedThisTurn) return false;
        if (
          pendingConfirmation
          && await consumePendingConfirmationDurably(
            uid,
            pendingConfirmation.id,
            toolName,
            args,
            confirmationScope,
          )
        ) {
          console.log(`[ChatHandler] Consumed one-time confirmation for "${toolName}".`);
          return true;
        }
        if (
          !correctionRequiresFreshConfirmation
          && canAutoApproveAction(toolName, args, { actionIntent: visibleUserText })
        ) return true;
        // Tool-capable turns prepare their durable task before entering the
        // relay, so confirmation and confirmation-resume keep the same task.
        const confirmationTaskId = actionTaskExecution.state?.taskId;
        confirmationScope = buildTransportNeutralConfirmationScope({
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          conversationId: conversationId || selectedConversationId,
          taskId: confirmationTaskId,
          originRequestId: requestId,
        });
        confirmationChannelScope = buildTransportNeutralConfirmationScope({
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          conversationId: conversationId || selectedConversationId,
        });
        const exactWriteCorrection = correctionRequiresFreshConfirmation
          && confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file';
        if (
          exactWriteCorrection
          && (
            !runtimeOwnedDeterministicRecoveryCall
            || toolName !== runtimeOwnedDeterministicRecoveryCall.name
            || !confirmationArgumentsMatch(args, runtimeOwnedDeterministicRecoveryCall.arguments)
          )
        ) {
          throw new Error('Corrected write confirmation did not match the runtime-owned exact proposal');
        }
        const pending = await recordPendingConfirmationDurably(uid, toolName, args, eventSource, {
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          channelId: confirmationScope.channelId,
          taskId: confirmationTaskId,
          originRequestId: requestId,
          actionIntent: visibleUserText,
        });
        if (
          correctionRequiresFreshConfirmation
          && !pendingConfirmationMatchesExactProposal(
            pending,
            toolName,
            args,
            { taskId: confirmationTaskId, originRequestId: requestId },
          )
        ) {
          throw new Error('Corrected action confirmation was not bound to the current task request');
        }
        pendingConfirmationCreatedThisTurn = pending;
        const confirmationRequestText = formatPendingConfirmationRequest(pending);
        pendingConfirmationAssistantState = confirmationRequestText;
        if (conversationId) {
          setConversationActionExecutionStatus(conversationId, uid, 'waiting_confirmation', {
            assistantState: confirmationRequestText,
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
      // Keep the executor ceiling and the schema projection on the same
      // boundary-filtered policy. Otherwise a remote entrance can advertise
      // a locally authorized tool that the execution engine will later deny.
      executionDecision.baseToolPolicy = modelCapabilityPolicy;
      executionDecision.toolPolicy = modelCapabilityPolicy;
      executionDecision.maxIterations = modelCapabilityPolicy.maxIterations;
      const existingActionState = conversation?.actionContinuationState;
      const pinnedContinuationTools = trustedContinuationEvidenceTools({
        actionTaskState: existingActionState,
        trustedActionContinuation: executionDecision.resumesPinnedTask === true,
      }, new Set(toolRegistry.getToolDeclarations({
        context: { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource },
      }).map(declaration => declaration.function.name)));
      const modelToolProjection = buildModelToolProjection(executionDecision, {
        lane: capabilitySelection.lane,
        preferredTools: capabilitySelection.preferredTools,
        pinnedTools: pinnedContinuationTools,
      });
      const toolSessionActive = !isMemoryAvatar && executionPipeline.executionRequested
        && modelToolProjection.toolNames.length > 0;
      // The semantic execution plan owns durable task creation. Main Chat may
      // expose a tool manifest to the model for open-ended reasoning, but that
      // alone does not make a greeting or ordinary conversation an executable
      // task. Only turns whose flow requires completion evidence/tool work (or
      // a pending confirmation) receive a durable task identity before relay.
      const bindsExistingAction = Boolean(
        existingActionState?.taskId
        && ['active_task', 'previous_task'].includes(resolvedTaskRelation.binding)
        && ['continue', 'correction', 'accept', 'retry'].includes(resolvedTaskRelation.feedback),
      );
      const preparesExistingAction = Boolean(bindsExistingAction && conversationId);
      const preparesConfirmedAction = Boolean(
        !preparesExistingAction
        && existingActionState?.taskId
        && pendingConfirmation,
      );
      const preparesFreshAction = Boolean(
        !preparesExistingAction
        && !preparesConfirmedAction
        && conversationId
        && (executionPipeline.capabilityPlan.taskLedgerRequired || Boolean(pendingConfirmation) || structuredMediaRequest),
      );
      // Reading the runtime ledger and accepting its cleanup proposal are
      // separate operations. The latter owns a new mutate task; resuming the
      // adjacent status task would leave its durable goal/intent/audit policy
      // as an observe action even though it now contains cancellation receipts.
      const actionTaskExecution = acceptedRuntimeCleanupOffer && conversationId
        ? prepareConversationActionExecution({
            conversationId,
            userId: uid,
            userText: visibleUserText,
            requestId,
            userMessageId: acceptedUserMessageId,
            toolPolicy: {
              allowedTools: ['runtime_work_cancel'],
              requireConfirmation: [],
              forbiddenTools: [],
              maxIterations: 1,
            },
            forceTask: true,
            forceNewTask: true,
            preserveExistingTask: false,
          })
        : bindsExistingAction && conversationId
        ? prepareConversationActionExecution({
            conversationId,
            userId: uid,
            userText: visibleUserText,
            requestId,
            userMessageId: acceptedUserMessageId,
            toolPolicy: modelCapabilityPolicy,
            forceResume: true,
            preserveExistingTask: true,
          })
        : existingActionState?.taskId && pendingConfirmation
          ? prepareConversationActionExecution({
              conversationId: conversationId || selectedConversationId,
              userId: uid,
              userText: visibleUserText,
              requestId,
              userMessageId: acceptedUserMessageId,
              toolPolicy: modelCapabilityPolicy,
              forceResume: true,
              preserveExistingTask: true,
            })
          : preparesFreshAction && conversationId
            ? prepareConversationActionExecution({
                conversationId,
                userId: uid,
                userText: visibleUserText,
                requestId,
                userMessageId: acceptedUserMessageId,
                toolPolicy: modelCapabilityPolicy,
                forceTask: true,
              })
            : { state: null, kind: 'conversation' as const };
      if ('bindingFailure' in actionTaskExecution) {
        const staleText = actionTaskExecution.bindingFailure === 'busy'
          ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
          : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
        await commitDeterministicTerminal({
          payload: {
            text: staleText,
            agentName: personality.name,
            source: 'chat_turn_binding',
            finalized: true,
            blocked: true,
            reason: actionTaskExecution.diagnosticCode,
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: conversation.id,
            role: 'assistant',
            content: staleText,
            personality: personality.id,
            source: 'chat_turn_binding',
            channel: 'chat',
            cognitiveIntent: actionTaskExecution.diagnosticCode,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            requestId,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: conversation.id,
            agentId: conversationAgentId,
            source: 'chat_turn_binding',
          }),
          errorContext: 'Action turn binding terminal',
        });
        await releaseChatSession();
        return;
      }
      const durableTaskId = actionTaskExecution.state?.taskId;
      if (structuredMediaRequest && actionTaskExecution.state?.taskId) {
        const structuredMediaRecoveryCall = buildStructuredMediaDeterministicToolRecoveryCall(
          structuredMediaRequest,
          {
            taskId: actionTaskExecution.state.taskId,
            taskRevision: Math.max(0, Math.trunc(Number(actionTaskExecution.state.revision) || 0)),
            requestId,
          },
        );
        if (!structuredMediaRecoveryCall) {
          throw new Error('Unable to bind the structured media request to its durable task');
        }
        runtimeOwnedDeterministicRecoveryCall = structuredMediaRecoveryCall;
      } else {
        runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
          actionTaskExecution.state,
          requestId,
          confirmationResolution.revokedCorrectionBasis,
        );
      }
      foregroundRequestIdentity = Object.freeze({
        conversationId: conversation.id,
        userId: uid,
        requestId,
        ...(durableTaskId ? { expectedTaskId: durableTaskId } : {}),
      });
      const leaseUnknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
        conversationId: conversation.id,
        userId: uid,
        requestId,
        abortController,
        onPersistenceUnknown: async () => {
          const recorded = await recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            requestId,
            leaseUnknownPayload,
          );
          if (recorded) publishRecordedAgent('agent:response', leaseUnknownPayload);
        },
      });
      if (durableTaskId) {
        resolvedTaskRelation = {
          ...resolvedTaskRelation,
          binding: 'active_task',
          taskId: durableTaskId,
          revision: actionTaskExecution.state.revision,
          targetRequestId: actionTaskExecution.state.activeRequestId || requestId,
        };
        emitAgent('agent:task_relation', { relation: resolvedTaskRelation, phase: 'prepared' });
      }
      // ── Desktop relay: route tools to the user's registered desktop client, not only this chat socket ──
      const desktopRelay = createDesktopRelay({
        io,
        userId: uid,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: 'chat',
        taskId: durableTaskId,
        requestId,
        requestSocket: socket,
        emitToolLifecycle,
        formatResultForLifecycle: formatToolResultForUi,
        // The foreground execution belongs to the durable task, not to this
        // transport connection. The relay still has its own bounded timeout.
        cancelOnRequestSocketDisconnect: false,
        signal: abortController.signal,
      });
      releaseDesktopControlLease = () => desktopRelay.releaseControlLease('chat_turn_complete');
      const priorTaskRecords = actionTaskExecution.kind === 'resume'
        ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
        : [];
      const taskAwareRecords = (records: ToolExecutionRecord[]) => (
        coalesceToolExecutionRecords([...priorTaskRecords, ...records])
      );
      if (toolSecurityContext.executionBoundary !== 'remote_restricted') {
        effectiveSystemPrompt += '\n\n' + formatClientSelfPromptForTurn(uid, visibleUserText, { domain: resolvedDomain, orgId: resolvedOrgId });
      }
      console.log('[ChatHandler] tool gate:', executionDecision.allowToolUse ? 'authorized' : 'off', 'session:', toolSessionActive ? 'active' : 'conversation', 'operationMode:', operationMode, 'effective:', effectiveOperationMode, 'surface:', turnFlow.surface, 'clientActionOnly:', clientActionOnlyTurn, 'selfRepair:', selfRepairTurn, 'capabilityLane:', capabilitySelection.lane, 'trace:', intentTrace.summary, 'route:', toolRoute ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable} ${toolRoute.categories.join(',') || 'fallback'}` : 'none');
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

      const executesAcceptedRuntimeCleanupOffer = Boolean(
        acceptedRuntimeCleanupOffer
        && resolvedTaskRelation.feedback === 'accept'
        && resolvedTaskRelation.taskRelation === 'confirm'
      );
      if (executesAcceptedRuntimeCleanupOffer) {
        const offeredToolCall = acceptedRuntimeCleanupOffer!.toolCall;
        const exactArguments = {
          taskIds: [...offeredToolCall.arguments.taskIds],
        };
        const cleanupRecord = await executeToolCall({
          registry: toolRegistry,
          id: `runtime_cleanup_offer_${requestId}`,
          name: offeredToolCall.name,
          arguments: exactArguments,
          executionOrigin: 'deterministic_route',
          context: {
            ...toolSecurityContext,
            userId: uid,
            taskId: durableTaskId,
            conversationId: conversation.id,
            turnId: requestId,
            requestId,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            toolPolicy: modelCapabilityPolicy,
            actionIntent: visibleUserText,
            currentTurnExecutionRequested: executionPipeline.executionRequested,
            trustedActionContinuation: executionPipeline.trustedActionContinuation,
            routedTaskText: visibleUserText,
            requestConfirmation: requestToolConfirmation,
            executionSignal: abortController.signal,
            isCancelled: () => abortController.signal.aborted,
          },
        });
        emitToolLifecycle({
          correlationId: cleanupRecord.id || `runtime_cleanup_offer_${requestId}`,
          name: cleanupRecord.name,
          arguments: cleanupRecord.arguments,
          result: cleanupRecord.result,
          error: cleanupRecord.error,
        });
        let cleanupReceipt: Record<string, any> = {
          ok: false,
          status: 'failed',
          requestedTaskIds: exactArguments.taskIds,
          cancelledTaskIds: [],
          cancellingTaskIds: [],
          notCancelledTaskIds: exactArguments.taskIds,
          targetResults: exactArguments.taskIds.map(taskId => ({ taskId, status: 'failed' })),
        };
        try {
          const parsed = JSON.parse(String(cleanupRecord.result || '{}'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            cleanupReceipt = parsed;
          }
        } catch {}
        const cleanupVerified = !cleanupRecord.error
          && cleanupRecord.terminalVerification?.status === 'verified';
        const cleanupText = formatRuntimeCleanupReceipt(visibleUserText, cleanupReceipt);
        const cleanupReason = cleanupVerified
          ? 'runtime_cleanup_offer_completed'
          : 'runtime_cleanup_offer_incomplete';
        const cleanupCompletionFeedback = durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: durableTaskId,
              taskLabel: visibleUserText,
              toolRecords: taskAwareRecords([cleanupRecord]),
              blocked: !cleanupVerified,
              reason: cleanupVerified ? '' : cleanupRecord.error
                || cleanupRecord.terminalVerification?.reason
                || cleanupReason,
            })
          : undefined;
        const cleanupTerminalPayload = normalizeAgentPayload('agent:response', {
          text: cleanupText,
          agentName: personality.name,
          finalized: true,
          blocked: !cleanupVerified,
          reason: cleanupReason,
          completionFeedback: cleanupCompletionFeedback,
        });
        const cleanupUnknownPayload = normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: personality.name,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
          completionFeedback: durableTaskId
            ? buildForegroundTaskCompletionFeedback({
                taskId: durableTaskId,
                taskLabel: visibleUserText,
                toolRecords: taskAwareRecords([cleanupRecord]),
                status: 'persistence_unknown',
                reason: 'Terminal persistence outcome is unknown.',
              })
            : undefined,
        });
        const cleanupCommitted = await commitChatTerminalBoundary({
          persistTerminalState: () => persistChatTakeoverExecution(cleanupText, {
            toolRecords: [cleanupRecord],
            source: 'chat_runtime_cleanup_offer',
            sourceInteractionId: interactionId,
            capabilitySelection,
            finalizationBlocked: !cleanupVerified,
            assistantTextTrusted: cleanupVerified,
            finalizationReason: cleanupReason,
          }),
          persistAssistantMessage: () => {
            const summary = summarizeToolRecordForPersistence(cleanupRecord);
            if (summary) {
              addMessage({
                userId: uid,
                agentId: conversationAgentId,
                conversationId: conversation.id,
                role: 'tool',
                content: summary,
                domain: resolvedDomain,
                orgId: resolvedOrgId,
              });
            }
            addMessageIdempotent({
              userId: uid,
              agentId: conversationAgentId,
              conversationId: conversation.id,
              role: 'assistant',
              content: cleanupText,
              personality: personality.id,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              source: 'chat_runtime_cleanup_offer',
              channel: 'chat',
              toolCalls: [cleanupRecord],
              cognitiveIntent: cleanupReason,
              llmWasCalled: false,
              requestId,
              completionFeedback: cleanupCompletionFeedback,
            });
            // `addMessageIdempotent` finalizes the foreground action and may
            // remove the live conversation pointer. Rebuild from the durable
            // task row now, before the recovery receipt captures this payload.
            refreshTerminalPayloadTaskRelation(cleanupTerminalPayload, durableTaskId);
          },
          flush: flushDBOrThrow,
          persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
            executionScope,
            requestId,
            'agent:response',
            cleanupTerminalPayload,
            cleanupUnknownPayload,
          ),
          persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            requestId,
            cleanupUnknownPayload,
          ),
          publishCommitted: executionWriteback => {
            if (executionWriteback?.recorded) {
              publishRecordedAgent(
                'agent:task_execution_writeback',
                normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
              );
            }
            publishRecordedAgent('agent:response', cleanupTerminalPayload);
            publishDurableTaskRelation();
            emitConversationUpdated({
              conversationId: conversation.id,
              agentId: conversationAgentId,
              source: 'chat_runtime_cleanup_offer',
              rolledOver: conversationTurn.rolledOver,
              previousConversationId: conversationTurn.previousConversationId,
            });
          },
          publishUnknown: () => publishRecordedAgent('agent:response', cleanupUnknownPayload),
          persistenceUnknownProjection: {
            text: cleanupUnknownPayload.text,
            completionFeedback: cleanupUnknownPayload.completionFeedback,
            reason: 'Terminal persistence outcome is unknown.',
          },
          onPersistenceError: error => {
            console.error('[ChatHandler] Runtime cleanup offer terminal persistence failed:', error);
          },
        });
        if (cleanupCommitted) {
          actionLeaseHeartbeat?.stop();
        }
        await releaseChatSession();
        return;
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
        ...(nativeRequestBinding || {}),
        interactionId,
        source: 'chat',
        inputTokenBudget: resolveModelRequestInputBudget(),
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
        const consumed = await consumePendingConfirmationDurably(
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
            taskId: durableTaskId,
            conversationId: conversation.id,
            turnId: requestId,
            requestId,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            desktopRelay,
            llmGetters,
            source: 'chat_confirmation',
            supervisedExternalCommits: true,
            allowLocalFileWrites,
            localWriteIntentReason,
            executionSignal: abortController.signal,
            isCancelled: () => abortController.signal.aborted,
            userConfirmed: true,
            actionIntent: confirmedTask,
            currentTurnExecutionRequested: executionPipeline.executionRequested,
            trustedActionContinuation: executionPipeline.trustedActionContinuation,
            routedTaskText: confirmedTask,
            toolPolicy: modelCapabilityPolicy,
            modelToolProjection,
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
              : {
                  result: formatToolResultForUi(confirmedRecord.result),
                  artifactReceipt: formatMediaArtifactReceiptForUi(confirmedRecord.name, confirmedArgs, confirmedRecord.result),
                }),
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
              ...buildConfirmedStepContinuationMessages(confirmedTask, confirmedRecord, {
                messageId: acceptedUserMessageId,
                text: visibleUserText,
              }),
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
                artifactReceipt: formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
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
              taskId: durableTaskId,
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
              executionSignal: abortController.signal,
              isCancelled: () => abortController.signal.aborted,
              requestConfirmation: requestToolConfirmation,
              actionIntent: confirmedTask,
              currentTurnExecutionRequested: executionPipeline.executionRequested,
              trustedActionContinuation: executionPipeline.trustedActionContinuation,
              routedTaskText: confirmedTask,
              toolPolicy: modelCapabilityPolicy,
              modelToolProjection,
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
        const trustedConfirmationRequestText = pendingConfirmationCreatedThisTurn
          ? formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn)
          : undefined;
        const finalized = pendingConfirmationCreatedThisTurn
          ? {
              text: trustedConfirmationRequestText!,
              blocked: false,
              reason: 'waiting_confirmation',
              notification: undefined,
            }
          : finalizeLumiResponse({
              taskText: confirmedTask,
              responseText: candidate,
              toolRecords: taskAwareRecords(confirmationRecords),
              source: 'chat_confirmation',
              flow: { ...turnFlow, routeText: confirmedTask },
              taskId: durableTaskId,
              requestId,
            });
        confirmedRecord.executionOrigin = 'confirmed_action_resume';
        const confirmationCompletionFeedback = buildForegroundTaskCompletionFeedback({
          taskId: durableTaskId!,
          taskLabel: confirmedTask,
          toolRecords: taskAwareRecords(confirmationRecords),
          blocked: finalized.blocked,
          reason: finalized.reason,
          status: pendingConfirmationCreatedThisTurn ? 'waiting_confirmation' : undefined,
        });
        const confirmationTerminalPayload = normalizeAgentPayload('agent:response', {
          text: finalized.text,
          agentName: personality.name,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason || '',
          completionFeedback: confirmationCompletionFeedback,
        }, trustedConfirmationRequestText ? { trustedConfirmationRequestText } : undefined);
        const confirmationResponseText = String(confirmationTerminalPayload.text || '');
        if (
          pendingConfirmationCreatedThisTurn
          && conversationId
          && pendingConfirmationAssistantState !== confirmationResponseText
        ) {
          setConversationActionExecutionStatus(conversationId, uid, 'waiting_confirmation', {
            assistantState: confirmationResponseText,
            requestId,
          });
          pendingConfirmationAssistantState = confirmationResponseText;
        }
        const confirmationUnknownPayload = normalizeAgentPayload('agent:response', {
          text: chatDurabilityUnknownText(visibleUserText),
          agentName: personality.name,
          finalized: true,
          blocked: true,
          reason: 'persistence_unknown',
          completionFeedback: buildForegroundTaskCompletionFeedback({
            taskId: durableTaskId!,
            taskLabel: confirmedTask,
            toolRecords: taskAwareRecords(confirmationRecords),
            status: 'persistence_unknown',
            reason: 'Terminal persistence outcome is unknown.',
          }),
        });
        if (actionLeaseHeartbeat?.isLeaseLost()) {
          await actionLeaseHeartbeat.leaseLoss;
          await releaseChatSession();
          return;
        }
        const terminalCommitted = await commitChatTerminalBoundary({
          persistTerminalState: () => persistChatTakeoverExecution(confirmationResponseText, {
            toolRecords: confirmationRecords,
            source: 'chat_confirmation',
            sourceInteractionId: `${interactionId}_confirmation`,
            capabilitySelection,
            finalizationBlocked: finalized.blocked,
            assistantTextTrusted: !finalized.blocked,
            finalizationReason: finalized.reason,
          }),
          persistAssistantMessage: () => {
            if (!conversationId) return;
            addMessageIdempotent({
              userId: uid,
              agentId: conversationAgentId,
              conversationId,
              role: 'assistant',
              content: confirmationResponseText,
              personality: personality.id,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              source: eventSource,
              channel: 'chat',
              toolCalls: confirmationRecords,
              cognitiveIntent: finalized.blocked ? 'work_product_guard' : 'confirmation',
              llmWasCalled: confirmationLlmWasCalled,
              requestId,
              completionFeedback: confirmationCompletionFeedback,
              ...(finalized.blocked && durableTaskId ? {
                terminalTaskDisposition: {
                  outcome: 'blocked' as const,
                  taskId: durableTaskId,
                  requestId,
                  reason: finalized.reason
                    || 'The confirmed foreground request ended without verified goal-level completion evidence.',
                },
              } : {}),
            });
            refreshTerminalPayloadTaskRelation(confirmationTerminalPayload, durableTaskId);
          },
          flush: flushDBOrThrow,
          persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
            executionScope,
            requestId,
            'agent:response',
            confirmationTerminalPayload,
            confirmationUnknownPayload,
          ),
          persistUnknownReceipt: async () => {
            if (conversationId) {
              const updated = updateAssistantMessageTerminalPresentation({
                userId: uid,
                conversationId,
                requestId,
                content: confirmationUnknownPayload.text,
                completionFeedback: confirmationUnknownPayload.completionFeedback,
                source: eventSource,
                channel: 'chat',
              });
              if (!updated) {
                addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: confirmationUnknownPayload.text, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'persistence_unknown', llmWasCalled: confirmationLlmWasCalled, requestId, completionFeedback: confirmationUnknownPayload.completionFeedback });
              }
              try { await flushDBOrThrow(); } catch {}
            }
            return recordChatExecutionPersistenceUnknownDurably(
              executionScope,
              requestId,
              confirmationUnknownPayload,
            );
          },
          publishCommitted: executionWriteback => {
            if (finalized.notification) {
              publishRecordedAgent(
                'agent:notification',
                normalizeAgentPayload('agent:notification', finalized.notification),
              );
            }
            if (executionWriteback?.recorded) {
              publishRecordedAgent(
                'agent:task_execution_writeback',
                normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
              );
            }
            publishRecordedAgent('agent:response', confirmationTerminalPayload);
            publishDurableTaskRelation();
            if (conversationId) {
              emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
            }
          },
          publishUnknown: () => {
            publishRecordedAgent('agent:response', confirmationUnknownPayload);
          },
          persistenceUnknownProjection: {
            text: confirmationUnknownPayload.text,
            completionFeedback: confirmationUnknownPayload.completionFeedback,
            reason: 'Terminal persistence outcome is unknown.',
          },
          onPersistenceError: error => {
            console.error('[ChatHandler] Confirmation terminal persistence failed:', error);
          },
        });
        if (!terminalCommitted) {
          await releaseChatSession();
          return;
        }
        actionLeaseHeartbeat?.stop();
        if (conversationId) scheduleChatSummary(conversationId);
        if (!finalized.blocked) {
          persistChatLearning(confirmationResponseText, {
            toolRecords: confirmationRecords,
            sourceInteractionId: `${interactionId}_confirmation`,
            logLabel: 'chat confirmation',
          });
        }
        await releaseChatSession();
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
        { role: 'user', content: text, sourceMessageId: acceptedUserMessageId },
      ];
      // ── Model-owned natural-language dispatch ──
      // Natural-language chat has no deterministic quick-command path. Surface
      // recognition and legacy quick matches are advisory inputs to the shared
      // model/tool loop; structured UI events use their dedicated handlers.
      // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        agentId: conversationAgentId,
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
          { role: 'user', content: userText, sourceMessageId: acceptedUserMessageId },
        ];
        const result = await makeLLMCall(
          messages,
          [],
          {
            provider: activeProvider,
            model: activeModel,
            userId: uid,
            maxTokens: 60,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            signal: abortController.signal,
            ...reasoningRoutePolicy,
            // Keep classifier routing receipts distinguishable from the
            // provider request that owns the user-visible answer. Both share
            // the same request/user nonce, so source is the fail-closed stage
            // discriminator used by request-only acceptance evidence.
            source: 'chat_intent_classifier',
          },
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
        allowToolUse: toolSessionActive,
        flow: turnFlow,
      });
      const chatTextGate = createPreFinalizationTextGate();
      if (!responseText) {
        // LumiCore owns every normal and complex task through this single model/tool path.

        // Load conversation history from persistence (survives page reload / reconnect)
        let persistedHistory: NormalizedMessage[] = [];
        if (conversationId) {
          // Keep seven persisted rows because the current user row is removed
          // below, leaving three complete historical user/assistant turns.
          const msgs = getMessagesByTokenBudget(conversationId, 6_000, 7).filter((m: any) => !(
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
            .flatMap((m: any) => normalizeChatHistoryRecord(m, { serverOwned: true }));
        }

        // Once a server conversation exists, persistence is authoritative even
        // when the new segment is intentionally empty. Falling back to the
        // client's pre-rollover transcript would immediately restore the very
        // stale context this boundary is meant to remove.
        const conversationHistory = conversationId
          ? persistedHistory
          : (history ? history.flatMap((m: any) => normalizeChatHistoryRecord(m)) : []);

        // Tell Lumi which model is currently active without hiding routed vision capacity.
        const selfAwareness = buildModelSelfAwareness(activeProvider, activeModel, uid, { visionAware: visionIntent && effectiveOperationMode !== 'meeting' });
        const messages: NormalizedMessage[] = [
          { role: 'system', content: effectiveSystemPrompt + selfAwareness },
          ...conversationHistory,
          { role: 'user', content: text, sourceMessageId: acceptedUserMessageId },
        ];
        normalTurnMessages = messages;

        try {
          console.log('[ChatHandler] Calling Path C with provider:', activeProvider, 'model:', activeModel, 'tools:', toolSessionActive ? 'active' : 'conversation');
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
          if (!toolSessionActive) {
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
            {
              provider: activeProvider,
              model: activeModel,
              userId: uid,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              signal: abortController.signal,
              ...reasoningRoutePolicy,
            },
            (record) => {
              allToolRecords.push(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: formatToolResultForUi(record.result),
                error: record.error,
                artifactReceipt: formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
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
              taskId: durableTaskId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              taskRevision: actionTaskExecution.state?.revision,
              source: 'chat',
              supervisedExternalCommits: true,
              allowLocalFileWrites,
              localWriteIntentReason,
              executionSignal: abortController.signal,
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
              modelToolProjection,
              actionIntent: visibleUserText,
              currentTurnExecutionRequested: executionPipeline.executionRequested,
              trustedActionContinuation: executionPipeline.trustedActionContinuation,
              routedTaskText: turnFlow.routeText,
              ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}),
              desktopExecutionTracker,
              ...(toolSessionActive ? { requestConfirmation: requestToolConfirmation } : {}),
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
          llmWasCalled = result.usageRecords.length > 0;
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
          if (abortController.signal.aborted || llmErr?.name === 'AbortError') {
            throw llmErr?.name === 'AbortError'
              ? llmErr
              : new DOMException('Chat execution cancelled', 'AbortError');
          }
          console.error(`[Cognition] LLM '${activeProvider}/${activeModel}' failed: ${llmErr.message}`);
          // Automatic fallback exists only behind the explicit `auto` provider,
          // where the fallback provider and model are persisted user choices.
          const cf = handleLLMFailure(cognition.intent, llmErr);
          responseText = cf.responseText;
        }
        // The tool loop may cooperatively return a cancellation summary rather
        // than throw. Do not feed that through ordinary completion guards: the
        // outer cancellation boundary owns the only durable terminal outcome.
        if (abortController.signal.aborted) {
          throw new DOMException('Chat execution cancelled', 'AbortError');
        }
      }

      chatTextGate.finish();
      const finalizedDesktopRecords = withDesktopExecutionReceipt(allToolRecords, desktopExecutionTracker);
      if (finalizedDesktopRecords.length > allToolRecords.length) {
        allToolRecords.push(...finalizedDesktopRecords.slice(allToolRecords.length));
      }
      const verifiedClientMode = getVerifiedClientModeChange(allToolRecords);
      if (verifiedClientMode) saveStoredOperationMode(uid, verifiedClientMode);
      const finalTaskRecords = taskAwareRecords(allToolRecords);
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
            toolRecords: finalTaskRecords,
            source: 'chat',
            flow: turnFlow,
            taskId: durableTaskId,
            requestId,
          });
      const desktopPauseBlocksCurrentTask = () => {
        return shouldBlockForDesktopControlPause({
          pauseReason: desktopRelay.getControlPauseReason(),
          waitingForConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
          taskText: executionTaskText,
          toolRecords: taskAwareRecords(allToolRecords),
        });
      };
      if (desktopPauseBlocksCurrentTask()) {
        const pausePresentation = formatDesktopControlPausePresentation(executionTaskText);
        finalResponse = {
          ...finalResponse,
          text: pausePresentation.text,
          blocked: true,
          reason: pausePresentation.reason,
        };
      }
      const guardRecovery = await recoverBlockedExecutionOnce({
        task: executionTaskText,
        responseText,
        finalization: finalResponse,
        allowToolUse: toolSessionActive,
        pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
        requiresFreshConfirmation: correctionRequiresFreshConfirmation,
        aborted: abortController.signal.aborted || desktopPauseBlocksCurrentTask(),
        isAborted: () => abortController.signal.aborted || desktopPauseBlocksCurrentTask(),
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
                artifactReceipt: formatMediaArtifactReceiptForUi(record.name, record.arguments, record.result, record.error),
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
              taskId: durableTaskId,
              conversationId: conversation.id,
              turnId: requestId,
              requestId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              taskRevision: actionTaskExecution.state?.revision,
              source: 'chat_guard_recovery',
              supervisedExternalCommits: true,
              allowLocalFileWrites,
              localWriteIntentReason,
              executionSignal: abortController.signal,
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
              modelToolProjection,
              actionIntent: visibleUserText,
              currentTurnExecutionRequested: executionPipeline.executionRequested,
              trustedActionContinuation: executionPipeline.trustedActionContinuation,
              routedTaskText: turnFlow.routeText,
              ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}),
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
              taskId: durableTaskId,
              requestId,
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
        // Keep the live action lease until the terminal assistant persistence
        // boundary when this turn already has tool evidence.  Finalizing the
        // task here clears its active request before `addMessageIdempotent`
        // can bind the evidence, causing verified observations (notably the
        // WPS active-window anchor) to be archived as stale and dropping the
        // target from the durable capsule.  A blocked turn with no evidence
        // still needs the early request finalization below.
        if (conversationId && actionTaskExecution.state?.taskId && toolSessionActive && allToolRecords.length === 0) {
          const blocker = correctionRequiresFreshConfirmation
            && !pendingConfirmationCreatedThisTurn
            ? RECONFIRMATION_REQUIRED_BLOCKER
            : finalResponse.reason || 'The current work product did not pass final verification.';
          setConversationActionExecutionStatus(conversationId, uid, 'blocked', {
            blocker,
            assistantState: responseText,
            requestId: '',
          });
        }
      }

      // Completion is a durability claim. Keep the native terminal frame
      // behind the task/message write and strict database flush.
      const responseCompletionFeedback = durableTaskId
        ? buildForegroundTaskCompletionFeedback({
            taskId: durableTaskId,
            taskLabel: executionTaskText,
            toolRecords: taskAwareRecords(allToolRecords),
            blocked: finalResponse.blocked,
            reason: finalResponse.reason,
            status: pendingConfirmationCreatedThisTurn ? 'waiting_confirmation' : undefined,
          })
        : undefined;
      const trustedConfirmationRequestText = pendingConfirmationCreatedThisTurn
        ? formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn)
        : undefined;
      const responseTerminalPayload = normalizeAgentPayload('agent:response', {
        text: responseText,
        agentName: personality.name,
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        completionFeedback: responseCompletionFeedback,
      }, trustedConfirmationRequestText ? { trustedConfirmationRequestText } : undefined);
      responseText = String(responseTerminalPayload.text || '');
      finalResponse = { ...finalResponse, text: responseText };
      if (
        pendingConfirmationCreatedThisTurn
        && conversationId
        && pendingConfirmationAssistantState !== responseText
      ) {
        setConversationActionExecutionStatus(conversationId, uid, 'waiting_confirmation', {
          assistantState: responseText,
          requestId,
        });
        pendingConfirmationAssistantState = responseText;
      }
      const responseUnknownPayload = normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(visibleUserText),
        agentName: personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
        completionFeedback: durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: durableTaskId,
              taskLabel: executionTaskText,
              toolRecords: taskAwareRecords(allToolRecords),
              status: 'persistence_unknown',
              reason: 'Terminal persistence outcome is unknown.',
            })
          : undefined,
      });
      if (actionLeaseHeartbeat?.isLeaseLost()) {
        await actionLeaseHeartbeat.leaseLoss;
        await releaseChatSession();
        return;
      }
      const terminalCommitted = await commitChatTerminalBoundary({
        persistTerminalState: () => persistChatTakeoverExecution(responseText, {
          toolRecords: allToolRecords,
          source: 'chat',
          sourceInteractionId: interactionId,
          capabilitySelection,
          finalizationBlocked: finalResponse.blocked,
          assistantTextTrusted: !finalResponse.blocked,
          finalizationReason: finalResponse.reason,
        }),
        persistAssistantMessage: () => {
          if (!conversationId) return;
          // Keep terminal tool evidence immediately before the assistant row in
          // the same strict durability boundary.
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
            completionFeedback: responseCompletionFeedback,
            ...(finalResponse.blocked && durableTaskId ? {
              terminalTaskDisposition: {
                outcome: 'blocked' as const,
                taskId: durableTaskId,
                requestId,
                reason: finalResponse.reason
                  || 'The foreground request ended without verified goal-level completion evidence.',
              },
            } : {}),
          });
          refreshTerminalPayloadTaskRelation(responseTerminalPayload, durableTaskId);
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
          executionScope,
          requestId,
          'agent:response',
          responseTerminalPayload,
          responseUnknownPayload,
        ),
        persistUnknownReceipt: async () => {
          if (conversationId) {
            const updated = updateAssistantMessageTerminalPresentation({
              userId: uid,
              conversationId,
              requestId,
              content: responseUnknownPayload.text,
              completionFeedback: responseUnknownPayload.completionFeedback,
              source: eventSource,
              channel: 'chat',
            });
            if (!updated) {
              addMessageIdempotent({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseUnknownPayload.text, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, source: eventSource, channel: 'chat', cognitiveIntent: 'persistence_unknown', llmWasCalled, requestId, completionFeedback: responseUnknownPayload.completionFeedback });
            }
            try { await flushDBOrThrow(); } catch {}
          }
          return recordChatExecutionPersistenceUnknownDurably(
            executionScope,
            requestId,
            responseUnknownPayload,
          );
        },
        publishCommitted: executionWriteback => {
          if (finalResponse.notification) {
            publishRecordedAgent(
              'agent:notification',
              normalizeAgentPayload('agent:notification', finalResponse.notification),
            );
          }
          if (executionWriteback?.recorded) {
            publishRecordedAgent(
              'agent:task_execution_writeback',
              normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
            );
          }
          publishRecordedAgent('agent:response', responseTerminalPayload);
          publishDurableTaskRelation();
          if (conversationId) {
            emitConversationUpdated({ conversationId, agentId: conversationAgentId, source: 'chat', rolledOver: conversationTurn.rolledOver, previousConversationId: conversationTurn.previousConversationId });
          }
        },
        publishUnknown: () => {
          publishRecordedAgent('agent:response', responseUnknownPayload);
        },
        persistenceUnknownProjection: {
          text: responseUnknownPayload.text,
          completionFeedback: responseUnknownPayload.completionFeedback,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => {
          console.error('[ChatHandler] Terminal persistence failed:', error);
        },
      });
      if (!terminalCommitted) {
        await releaseChatSession();
        return;
      }
      actionLeaseHeartbeat?.stop();

      // Post-commit enrichment must never delay or precede the durable terminal.

      if (conversationId) {
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

      if (!isMemoryAvatar && !finalResponse.blocked) {
        persistChatLearning(responseText, { toolRecords: allToolRecords, logLabel: 'chat' });
      }

      // Clean up abort session
      await releaseChatSession();

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
              sourceInteractionId: interactionId, agentId: conversationAgentId,
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
      if (allowAdaptiveLearning && resolvedDomain === 'personal' && responseText && !finalResponse.blocked && cognition.intent.category !== 'command' && !personalityRegistry.isEvolutionFrozen(personalityId, uid)) {
        try {
          const evolutionConfig = personalityRegistry.getEvolutionConfig(personalityId, uid);
          const step = await lightweightEvolve(
            personalityConfig as any,
            uid,
            evolutionConfig,
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            undefined,
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
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
            const branch = ensureBranch(uid, (mem as any).branchHint, conversationAgentId, null, { domain: resolvedDomain, orgId: resolvedOrgId });
            parentId = branch.id;
          }
          addMemory({
            userId: uid, type: mem.type, content: mem.content,
            keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: interactionId,
            agentId: conversationAgentId,
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

      // Emit a contextual greeting on reconnect.
      if (!isMemoryAvatar && isReconnect && updatedState.intimacy > 0.2) {
        const greeting = generateContextualGreeting(updatedState, uid);
        if (greeting) {
          const greetingTs = new Date().toISOString();
          // Save to chat log
          const greetingDb = readDB();
          greetingDb.interactions.push({
            id: `greeting-${uid}-${Date.now()}`,
            userId: uid,
            agentId: conversationAgentId,
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
      if (abortController.signal.aborted || error?.name === 'AbortError') {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        cancelConversationActionExecution(
          selectedConversationId,
          uid,
          'Cancelled by the user.',
          requestId,
        );
        await commitDeterministicTerminal({
          payload: {
            text: cancelledText,
            agentName: 'Lumi',
            finalized: true,
            blocked: false,
            reason: 'cancelled',
          },
          persistAssistantMessage: () => addMessageIdempotent({
            userId: uid,
            agentId: conversationAgentId,
            conversationId: selectedConversationId,
            role: 'assistant',
            content: cancelledText,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            source: eventSource,
            channel: 'chat',
            cognitiveIntent: 'task_cancelled',
            llmWasCalled: true,
            requestId,
            skipActionContinuation: true,
          }),
          publishAfter: () => emitConversationUpdated({
            conversationId: selectedConversationId,
            agentId: conversationAgentId,
            source: eventSource,
          }),
          errorContext: 'Caught chat cancellation terminal',
        });
        return;
      }
      console.error("[Socket Agent Error]:", error);
      const publicError = sanitizeChatAgentErrorPayload({
        code: chatPublicErrorCodeForException(error),
      });
      const failureText = publicError.code === 'CHAT_MODEL_ROUTES_UNAVAILABLE'
        ? CN_VOICE_WORK_MESSAGES.modelRoutesUnavailable
        : CN_VOICE_WORK_MESSAGES.processingFailed;
      await commitDeterministicTerminal({
        payload: {
          text: failureText,
          agentName: 'Lumi',
          finalized: true,
          blocked: true,
          reason: String(publicError.reason || 'chat_execution_failed'),
        },
        persistAssistantMessage: () => addMessageIdempotent({
          userId: uid,
          agentId: conversationAgentId,
          conversationId: selectedConversationId,
          role: 'assistant',
          content: failureText,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          source: eventSource,
          channel: 'chat',
          cognitiveIntent: String(publicError.code || 'CHAT_EXECUTION_FAILED').toLowerCase(),
          llmWasCalled: false,
          requestId,
        }),
        publishAfter: () => emitConversationUpdated({
          conversationId: selectedConversationId,
          agentId: conversationAgentId,
          source: eventSource,
        }),
        errorContext: 'Unhandled chat failure terminal',
      });
    } finally {
      await releaseChatSession();
    }
  });
}
