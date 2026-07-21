/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Server, Socket } from "socket.io";
import os from "os";
import path from "path";
import { readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from "../llm/providers";
import { LLMUsage, ToolContext, ToolExecutionRecord } from "../tools/types";
import { toolRegistry } from "../tools/registry";
import { runWithTools } from "../llm/adapter";
import {
  isPureOperationModeSwitchRequest,
  normalizeOperationMode,
  type OperationMode,
} from "../cognition/operation_modes";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildLumiTurnDispatch } from "../cognition/turn_dispatch";
import { buildLumiExecutionDecision } from "../cognition/execution_decision";
import { buildLumiIntentTrace } from "../cognition/intent_trace";
import { buildLumiCapabilitySelection } from "../cognition/capability_selection";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { buildDesktopObservationPlan, formatDesktopObservationResult } from "../cognition/desktop_observation";
import { buildClientDiagnosticPlan, formatClientDiagnosticResult } from "../cognition/client_diagnostic_result";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildActionContract, summarizeActionContractBlocker } from "../cognition/action_contract";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
  shouldForwardPreFinalizationProgress,
} from "../cognition/response_delivery";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import { formatClientSelfPrompt } from "../client/self_model";
import { canAutoApproveAction, classifyActionRisk, evaluateActionConstitution } from "../tools/action_constitution";
import {
  clearPendingConfirmation,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  getPendingConfirmation,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from "../tools/pending_confirmation";
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, generateContextualGreeting, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { lightweightEvolve } from "../personality/evolution";
import { getOrCreateConversationForTurn, addMessage, getMessages, getMessagesByTokenBudget, getConversationSummary, setConversationMode, extractTopics, trackTopic, getTopicContext } from "../conversation/manager";
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import { ensureBranch } from "../memory/tree";
import { retrieveChunks } from "../agents/rag";
import { getSensory } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
import { buildRecentActionContinuationBridge } from "../cognition/action_continuation";
import { hasExplicitTeamExecutionRequest } from "../cognition/tool_intent";
import { summarizeToolRecordForPersistence } from "../cognition/tool_record_status";
import { buildQuickCommandToolPolicy, matchQuickCommand } from "../cognition/quick_commands";
import { recordTokenUsage } from "../llm/token_tracker";
import {
  runOrchestratedTask,
  shouldDistillSkill,
  buildSkillDescription,
  classifyComplexity,
  isTerminalOrchestrationToolEvent,
  listAvailableOrchestrationAgents,
  shouldAttemptOrchestration,
} from "../agents/orchestrator";
import { buildDelegationAck, formatBackgroundDelegationFailure, shouldDelegateWorkInBackground } from "../agents/background_delegation";
import { isLatestUserTurn, markLatestUserTurn } from "../agents/background_delivery";
import {
  cancelBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  getBackgroundTask,
  incrementBackgroundTaskToolCalls,
  isBackgroundTaskCancellationRequested,
  markBackgroundTaskRunning,
  registerBackgroundTask,
  requestCancelBackgroundTask,
} from "../agents/background_tasks";
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs, runNLChainer, shouldChainTask } from "../agents/nl_chainer";
import { autoInstallForTask } from "../agents/auto_installer";
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { searchKnowledgeBase } from "../org/kb";
import { getWorkflow, recordWorkflowRun, listWorkflows } from "../agents/workflows";
import { buildProfessionOverlay } from "../autonomy/professions";
import { analyzeLikedMusicProfile, formatMusicProfileReport, isMusicProfileAnalysisRequest } from "../music/library_profile";
import { buildResponseLanguageInstruction } from "../utils/language";
import { formatOperationModeSwitchResponse } from "../i18n/operation_mode_messages";
import { CN_MESSAGING_MESSAGES } from "../regions/packs/cn/messaging_messages";
import { CN_CLIENT_DIAGNOSTIC_MESSAGES } from "../regions/packs/cn/client_diagnostic_messages";
import { CN_BACKGROUND_DELEGATION_MESSAGES } from "../regions/packs/cn/background_delegation_messages";
import { buildModelSelfAwareness, buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { DEFAULT_MODELS, getScopedPreferredLLM } from "../llm/user_preferences";
import { createDesktopRelay } from "./desktop_relay";
import { resolveSocketScope, scopedEmotionalStateKey } from "./scope";
import {
  beginChatExecution,
  getChatExecution,
  markChatExecutionCancelling,
  recordChatExecutionEvent,
  type ChatExecutionScope,
} from "./chat_execution_registry";
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from "../conversation/guard_history";

// Foreground executions outlive an individual Socket.IO connection. Keeping the
// controllers at module scope lets a reconnected client query or cancel the same
// execution instead of creating an orphan tied to the old socket instance.
const chatSessionMap = new Map<string, AbortController>();

function chatExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function stripHistoricalAttachmentBlocks(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '\n\n[Previous attachments omitted. Ask for a current attachment or exact local path before using file tools.]')
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

  if (role === 'assistant' && isNoisyAssistantHistory(primaryText)) {
    return [];
  }

  if (primaryText && !isUiErrorText) {
    entries.push({ role, content: primaryText });
  }
  if (response && role === 'user' && !isNoisyAssistantHistory(response)) {
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

function buildChatAttachmentContext(attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines: string[] = [
    '## Current Turn Attachments',
    'The user attached these files to the current message. Treat them as part of the user request.',
  ];
  attachments.forEach((item, index) => {
    const content = item.transcript || item.content || item.preview || '';
    lines.push(`### ${index + 1}. ${item.fileName}`);
    lines.push(`Type: ${item.kind}${item.mimeType ? ` (${item.mimeType})` : ''}`);
    if (item.path) lines.push(`Local path: ${item.path}`);
    if (item.kind === 'image') {
      lines.push('For visual details, use the ocr_image_file tool with the local path before answering.');
    }
    if (item.kind === 'audio') {
      const transcript = getAudioAttachmentTranscript(item);
      if (transcript) {
        lines.push('This is an audio recording with an attached transcript from the current upload. Reuse the transcript below for summaries, notes, or text-file creation. If the user asks for a text file, write the attached transcript to a file instead of re-transcribing. Do not call transcribe_audio_to_text_file again unless the user explicitly asks to re-transcribe.');
        if (item.transcriptionProvider || item.transcriptionModel || item.transcriptionStatus) {
          lines.push(`Transcript metadata: provider=${item.transcriptionProvider || 'unknown'} model=${item.transcriptionModel || 'unknown'} status=${item.transcriptionStatus || 'ready'}`);
        }
      } else {
        lines.push('This is an audio recording. If the user asks for transcription, speech-to-text, a written transcript, or a text file, use transcribe_audio_to_text_file with the local path.');
      }
    }
    if (content) {
      lines.push(`Extracted text:\n${content}`);
    } else if (item.path) {
      lines.push('No extracted text is attached; use the local path with an appropriate tool if needed.');
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

function shouldBlockDetachedAttachmentFollowup(
  userText: string,
  attachments: ChatIncomingAttachment[],
  history: any,
): boolean {
  const clean = String(userText || '').trim();
  if (attachments.length > 0 || !clean || clean.length > 160) return false;
  if (extractExplicitLocalPaths(clean).length > 0) return false;

  const historyItems = Array.isArray(history) ? history : [];
  const historyText = historyItems
    .slice(-12)
    .map((item: any) => String(item?.content || item?.message || item?.text || ''))
    .join('\n');
  const historyHasDetachedAttachment =
    /\[Previous attachments omitted\]|\[Attachments\]|Current Turn Attachments/i.test(historyText);
  const hasReference =
    /刚才|刚刚|上面|前面|这个|这份|它|附件|文件|录音|音频|语音|转写|文本|笔录|记录|纪要|材料|文稿|\b(?:this|that|attachment|file|audio|recording|transcript|notes?)\b/iu.test(clean);
  const hasAction =
    /整理|做成|生成|转成|保存|导出|写成|形成|归纳|总结|提炼|分析|笔录|材料|\b(?:summari[sz]e|make|create|generate|save|export|write|format|turn)\b/iu.test(clean);
  const shortArtifactRequest =
    clean.length <= 40 &&
    /^(?:帮我|给我|把它|把这个|这个|这份|刚才的|刚刚的|上面的|前面的)?\s*(?:整理|做成|生成|转成|保存成|导出成|写成|形成|归纳|总结|提炼).{0,16}(?:文本|文字|txt|md|笔录|记录|纪要|材料|文稿|文件)\s*$/iu.test(clean);

  return shortArtifactRequest || (historyHasDetachedAttachment && hasReference && hasAction);
}

function buildDetachedAttachmentFollowupResponse(userText: string): string {
  const isZh = /[\u3400-\u9fff]/.test(userText);
  if (!isZh) {
    return [
      'I do not have the current attachment or transcript context in this turn, so I will not pretend that the file work has started.',
      'Please attach/select the file again, or send the transcript text in the message. Then I will show the real read/write progress before reporting the result.',
    ].join('\n');
  }
  return [
    '我这轮没有收到要整理的附件或刚才的转写上下文，所以不能假装已经开始处理。',
    '请重新上传、从右侧文件里选择那份音频/转写结果，或把转写文本发在这一条里。收到后我会先显示读取/沿用转写进度，再生成文本结果。',
  ].join('\n');
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

type NativeFileEntry = {
  name?: string;
  path?: string;
  type?: string;
  isDirectory?: boolean;
  is_directory?: boolean;
  size?: number;
  modifiedMs?: number | null;
  modified_ms?: number | null;
};

const LOCAL_DOCUMENT_EXT_RE = /\.(?:docx?|pdf|rtf|txt|md|csv|xlsx?|pptx?)$/i;
const LOCAL_AUDIO_EXT_RE = /\.(?:mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i;
const LOCAL_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i;
const LOCAL_READABLE_EXT_RE = /\.(?:docx?|pdf|rtf|txt|md|csv|xlsx?|pptx?|mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm|png|jpe?g|webp|bmp|gif|tiff?)$/i;
const LOCAL_READABLE_EXT_PATTERN = '(?:docx?|pdf|rtf|txt|md|csv|xlsx?|pptx?|mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm|png|jpe?g|webp|bmp|gif|tiff?)';
const EXPLICIT_LOCAL_PATH_RE = new RegExp(`[A-Za-z]:[\\\\/][^\\n\\r"'<>|]+?\\.${LOCAL_READABLE_EXT_PATTERN}`, 'gi');
const DESKTOP_RELATIVE_PATH_RE = new RegExp(`(?:Desktop|\\u684c\\u9762)[\\\\/][^\\n\\r"'<>|]+?\\.${LOCAL_READABLE_EXT_PATTERN}`, 'gi');
const DESKTOP_RELATIVE_FOLDER_RE = /(?:Desktop|\u684c\u9762)[\\/][^\n\r"'<>|.,;\]\u3002\uff0c\uff1b]+/gi;
const LOCAL_ACTION_VERB_RE =
  /\b(?:open|read|review|inspect|analy[sz]e|summari[sz]e|compare|transcribe|extract|ocr|check|look\s+at|look\s+over)\b|(?:\u6253\u5f00|\u8bfb\u53d6|\u8bfb\u4e00\u4e0b|\u8bfb\u4e0b|\u770b\u4e00\u4e0b|\u770b\u770b|\u67e5\u770b|\u5ba1\u67e5|\u5ba1\u9605|\u5206\u6790|\u68c0\u67e5|\u6574\u7406|\u603b\u7ed3|\u8f6c\u6587\u5b57|\u8f6c\u5199|\u8bc6\u522b|\u63d0\u53d6|\u5bf9\u6bd4|\u505a\u6210|\u751f\u6210)/iu;
const LOCAL_ACTION_OBJECT_RE =
  /\b(?:file|folder|directory|document|docx|pdf|word|attachment|contract|agreement|audio|recording|voice|screenshot|image|picture)\b|(?:\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|\u6587\u6863|\u8d44\u6599|\u9644\u4ef6|\u5408\u540c|\u534f\u8bae|\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3|\u622a\u56fe|\u56fe\u7247|\u7167\u7247|\u8fd9\u4efd)/iu;
const TRANSCRIPTION_REQUEST_RE =
  /\b(?:transcribe|transcript|speech\s*to\s*text|voice\s*to\s*text)\b|(?:\u8f6c\u6587\u5b57|\u8f6c\u5199|\u7b14\u5f55|\u8bed\u97f3\u8bc6\u522b|\u5f55\u97f3)/iu;
const DOCUMENT_REVIEW_REQUEST_RE =
  /\b(?:contract|agreement|review|inspect|analy[sz]e|document|docx|pdf)\b|(?:\u5408\u540c|\u534f\u8bae|\u5ba1\u67e5|\u5ba1\u9605|\u4e59\u65b9|\u7532\u65b9|\u4fee\u6539\u610f\u89c1|\u6587\u4ef6|\u6587\u6863|\u8d44\u6599)/iu;
const OCR_REQUEST_RE =
  /\b(?:ocr|image|picture|screenshot|photo)\b|(?:\u8bc6\u522b|\u63d0\u53d6|\u622a\u56fe|\u56fe\u7247|\u7167\u7247)/iu;
const LOCAL_CAD_IMAGE_REQUEST_RE =
  /\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|draft|drawing|renovation)\b|(?:\u56fe\u7eb8|\u6237\u578b|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe|\u8349\u7a3f\u56fe|\u753b\u56fe|\u753b\u51fa\u6765|\u7ed8\u5236|\u88c5\u4fee|\u5b9e\u64cd|\u5b9e\u9645\u753b)/iu;

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

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
  if (attachments.some(item => item.path && !shouldSkipPreflightForAttachment(item))) return true;
  const text = userText || '';
  if (extractExplicitLocalPaths(text).length > 0) return true;
  const mentionsFileLocation = /\b(?:desktop|downloads?|documents?)\b|(?:\u684c\u9762|\u4e0b\u8f7d|\u6587\u6863)/iu.test(text);
  const namesSpecificFile = LOCAL_READABLE_EXT_RE.test(text) || /["“][^"”]{2,}["”]/u.test(text);
  return LOCAL_ACTION_VERB_RE.test(text) && LOCAL_ACTION_OBJECT_RE.test(text) && (mentionsFileLocation || namesSpecificFile);
}

function cleanLocalPathSegment(input: string): string {
  return String(input || '')
    .trim()
    .replace(/^[\s"'`“”‘’「」『』《》]+|[\s"'`“”‘’「」『』《》]+$/g, '')
    .replace(/^(?:\u6709(?:\u4e2a|\u4e00\u4e2a)?|\u53eb|\u540d\u4e3a|\u7684)\s*/u, '')
    .replace(/[\s),.;\]\u3002\uff0c\uff1b\uff1a:!?]+$/g, '')
    .trim();
}

function extractNamedDesktopFolders(input: string): string[] {
  const text = String(input || '');
  const homeDesktop = path.join(os.homedir(), 'Desktop');
  const out: string[] = [];
  const patterns = [
    /(?:\u684c\u9762(?:\u4e0a|\u91cc|\u4e0b)?(?:\u6709(?:\u4e2a|\u4e00\u4e2a)?|\u7684|\u53eb|\u540d\u4e3a)?\s*)["'`“”‘’「」『』《》]([^"'`“”‘’「」『』《》\n\r]{1,80})["'`“”‘’「」『』《》]\s*(?:\u6587\u4ef6\u5939|\u76ee\u5f55)/giu,
    /(?:\u684c\u9762(?:\u4e0a|\u91cc|\u4e0b)?(?:\u6709(?:\u4e2a|\u4e00\u4e2a)?|\u7684|\u53eb|\u540d\u4e3a)?\s*)([^\s"'`“”‘’「」『』《》,，。！？!?:：;；、\n\r]{1,80})\s*(?:\u6587\u4ef6\u5939|\u76ee\u5f55)/giu,
    /\b(?:desktop\s+)?(?:folder|directory)\s+(?:named|called)?\s*["'`]?([^"'`,.;\n\r]{1,80})["'`]?/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = cleanLocalPathSegment(match[1] || '');
      if (!name || /^(?:desktop|folder|directory)$/i.test(name)) continue;
      if (/^(?:\u684c\u9762|\u6587\u4ef6\u5939|\u76ee\u5f55|\u91cc\u9762|\u5185\u5bb9|\u8fd9\u4e2a|\u90a3\u4e2a)$/u.test(name)) continue;
      out.push(path.join(homeDesktop, name));
    }
  }
  return uniqueStrings(out).slice(0, 4);
}

function extractExplicitLocalPaths(input: string): string[] {
  const out: string[] = [];
  const text = String(input || '');
  for (const match of text.match(EXPLICIT_LOCAL_PATH_RE) || []) {
    out.push(match.trim().replace(/[),.;\]\u3002\uff0c\uff1b]+$/g, ''));
  }
  const homeDesktop = path.join(os.homedir(), 'Desktop');
  for (const match of text.match(DESKTOP_RELATIVE_PATH_RE) || []) {
    const cleaned = match.trim().replace(/[),.;\]\u3002\uff0c\uff1b]+$/g, '');
    const relative = cleaned.replace(/^(?:Desktop|\u684c\u9762)[\\/]/i, '');
    out.push(path.join(homeDesktop, relative));
  }
  for (const match of text.match(DESKTOP_RELATIVE_FOLDER_RE) || []) {
    const cleaned = cleanLocalPathSegment(match);
    if (!cleaned || LOCAL_READABLE_EXT_RE.test(cleaned)) continue;
    const relative = cleaned.replace(/^(?:Desktop|\u684c\u9762)[\\/]/i, '');
    if (relative && relative !== cleaned) out.push(path.join(homeDesktop, relative));
  }
  out.push(...extractNamedDesktopFolders(text));
  return uniqueStrings(out).slice(0, 6);
}

function parseNativeFiles(raw: string): NativeFileEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return parseNativeFiles(parsed);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, any>;
      for (const key of ['entries', 'files', 'items', 'data', 'result', 'output']) {
        const value = obj[key];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
          const nested = parseNativeFiles(value);
          if (nested.length) return nested;
        }
      }
    }
    return [];
  } catch {
    return [];
  }
}

function isNativeDirectory(entry: NativeFileEntry): boolean {
  return entry.type === 'directory' || entry.isDirectory === true || entry.is_directory === true;
}

function getNativeModifiedMs(entry: NativeFileEntry): number {
  const value = entry.modifiedMs ?? entry.modified_ms;
  return typeof value === 'number' ? value : 0;
}

function getLikelyLocalDirs(searchText: string): string[] {
  const home = os.homedir();
  const oneDrive = process.env.OneDrive || process.env.ONEDRIVE || process.env.OneDriveConsumer || process.env.ONEDRIVECONSUMER || '';
  const dirs = new Set<string>();
  dirs.add(path.join(home, 'Desktop'));
  dirs.add(path.join(home, 'OneDrive', 'Desktop'));
  if (oneDrive) dirs.add(path.join(oneDrive, 'Desktop'));
  if (process.env.PUBLIC) dirs.add(path.join(process.env.PUBLIC, 'Desktop'));
  dirs.add('C:\\Users\\Public\\Desktop');

  const text = String(searchText || '');
  if (/\bdownloads?\b|\u4e0b\u8f7d/i.test(text)) {
    dirs.add(path.join(home, 'Downloads'));
  }
  if (/\bdocuments?\b|\u6587\u6863/i.test(text)) {
    dirs.add(path.join(home, 'Documents'));
    dirs.add(path.join(home, 'OneDrive', 'Documents'));
    if (oneDrive) dirs.add(path.join(oneDrive, 'Documents'));
  }
  return uniqueStrings(Array.from(dirs)).slice(0, 6);
}

function normalizeComparableText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[\s"'“”‘’`.,，。；;:：()[\]{}<>《》【】_-]+/g, '');
}

function scoreLocalFileCandidate(entry: NativeFileEntry, searchText: string): number {
  if (isNativeDirectory(entry)) return -Infinity;
  const filePath = entry.path || entry.name || '';
  if (!LOCAL_READABLE_EXT_RE.test(filePath)) return -Infinity;

  const name = entry.name || path.basename(filePath);
  const nameLower = name.toLowerCase();
  const query = String(searchText || '');
  const queryComparable = normalizeComparableText(query);
  const baseComparable = normalizeComparableText(path.basename(name, path.extname(name)));
  const isDoc = LOCAL_DOCUMENT_EXT_RE.test(name);
  const isAudio = LOCAL_AUDIO_EXT_RE.test(name);
  const isImage = LOCAL_IMAGE_EXT_RE.test(name);
  let score = 0;

  if (isDoc) score += 6;
  if (isAudio) score += 6;
  if (isImage) score += 4;
  if (TRANSCRIPTION_REQUEST_RE.test(query) && isAudio) score += 34;
  if (DOCUMENT_REVIEW_REQUEST_RE.test(query) && isDoc) score += 18;
  if (OCR_REQUEST_RE.test(query) && isImage) score += 20;
  if (LOCAL_CAD_IMAGE_REQUEST_RE.test(query) && isImage) score += 30;
  if (/\b(?:contract|agreement)\b|(?:\u5408\u540c|\u534f\u8bae)/iu.test(query) && /\b(?:contract|agreement)\b|(?:\u5408\u540c|\u534f\u8bae)/iu.test(nameLower)) score += 30;
  if (/\b(?:transcript|recording|audio|voice)\b|(?:\u7b14\u5f55|\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)/iu.test(query) && /\b(?:recording|audio|voice)\b|(?:\u7b14\u5f55|\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)/iu.test(nameLower)) score += 24;
  if (baseComparable.length >= 4 && queryComparable.includes(baseComparable.slice(0, Math.min(18, baseComparable.length)))) score += 45;
  if (getNativeModifiedMs(entry) > 0) {
    const ageHours = Math.max(0, (Date.now() - getNativeModifiedMs(entry)) / 3_600_000);
    score += Math.max(0, 8 - Math.min(8, ageHours / 12));
  }
  return score;
}

function selectBestLocalFileCandidate(entries: NativeFileEntry[], searchText: string): NativeFileEntry | null {
  const scored = entries
    .map(entry => ({ entry, score: scoreLocalFileCandidate(entry, searchText) }))
    .filter(item => Number.isFinite(item.score) && item.score > 0)
    .sort((a, b) => b.score - a.score || getNativeModifiedMs(b.entry) - getNativeModifiedMs(a.entry));
  if (scored.length === 0) return null;
  const best = scored[0];
  const second = scored[1];
  if (best.score >= 30) return best.entry;
  if (scored.length === 1 && best.score >= 14) return best.entry;
  if (best.score >= 22 && (!second || best.score - second.score >= 8)) return best.entry;
  return null;
}

function selectLocalCadImageCandidates(entries: NativeFileEntry[], searchText: string, limit = 2): NativeFileEntry[] {
  if (!LOCAL_CAD_IMAGE_REQUEST_RE.test(searchText)) return [];
  return entries
    .map(entry => ({ entry, score: scoreLocalFileCandidate(entry, searchText) }))
    .filter(item => (
      Number.isFinite(item.score) &&
      item.score > 0 &&
      !isNativeDirectory(item.entry) &&
      LOCAL_IMAGE_EXT_RE.test(item.entry.path || item.entry.name || '')
    ))
    .sort((a, b) => b.score - a.score || getNativeModifiedMs(b.entry) - getNativeModifiedMs(a.entry))
    .map(item => item.entry)
    .slice(0, Math.max(1, limit));
}

function toolForLocalFile(filePath: string, searchText: string, kind?: ChatIncomingAttachment['kind']): { name: string; arguments: Record<string, any> } {
  const fileName = path.basename(filePath);
  if (kind === 'audio' || LOCAL_AUDIO_EXT_RE.test(filePath)) {
    return {
      name: 'transcribe_audio_to_text_file',
      arguments: {
        filePath,
        title: fileName,
        outputFormat: 'txt',
        language: /[\u3400-\u9fff]/.test(searchText) ? 'zh' : 'auto',
      },
    };
  }
  if (kind === 'image' || LOCAL_IMAGE_EXT_RE.test(filePath)) {
    if (LOCAL_CAD_IMAGE_REQUEST_RE.test(searchText)) {
      return {
        name: 'floorplan_extract_geometry',
        arguments: {
          imagePath: filePath,
          projectName: path.basename(path.dirname(filePath)) || fileName,
        },
      };
    }
    return {
      name: 'ocr_image_file',
      arguments: {
        imagePath: filePath,
        query: 'Extract the visible text and details relevant to the user request.',
      },
    };
  }
  if (LOCAL_DOCUMENT_EXT_RE.test(filePath)) {
    return { name: 'extract_document_text', arguments: { filePath } };
  }
  return { name: 'read_file', arguments: { path: filePath } };
}

function toolForLocalPath(localPath: string, searchText: string, kind?: ChatIncomingAttachment['kind']): { name: string; arguments: Record<string, any> } {
  if (kind || LOCAL_READABLE_EXT_RE.test(localPath)) return toolForLocalFile(localPath, searchText, kind);
  return { name: 'desktop_list_files', arguments: { path: localPath, limit: 120 } };
}

function shouldSkipPreflightForAttachment(item: ChatIncomingAttachment): boolean {
  return item.kind === 'audio' && Boolean(getAudioAttachmentTranscript(item));
}

function compactPreflightResult(record: ToolExecutionRecord): string {
  const result = String(record.result || '');
  const limit = /^(extract_document_text|read_docx|read_file|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file)$/i.test(record.name)
    ? 18000
    : 4000;
  if (result.length <= limit) return result;
  return `${result.slice(0, limit)}\n[...preflight result truncated: ${result.length - limit} more chars]`;
}

function formatPreflightContext(records: ToolExecutionRecord[]): string {
  const useful = records.filter(record => record.result || record.error);
  if (useful.length === 0) return '';
  const extractedContent = useful.some(record =>
    !record.error && /^(extract_document_text|read_docx|read_file|read_pdf|pdf_to_text|ocr_image_file|transcribe_audio_to_text_file)$/i.test(record.name)
  );
  const lines = [
    '## Visible Action Preflight',
    'Before answering, Lumi already performed these safe tool steps. Treat them as visible evidence from this turn.',
    extractedContent
      ? 'Readable content was extracted below. Use it directly, and do not promise to read it again unless something is missing.'
      : 'Only discovery/checking evidence is available below. Do not claim the document/audio/image content was read; say what was checked and ask for the exact file if needed.',
  ];
  useful.slice(-6).forEach((record, index) => {
    lines.push(`### Step ${index + 1}: ${record.name}`);
    lines.push(`Arguments: ${JSON.stringify(record.arguments || {})}`);
    if (record.error) {
      lines.push(`Error: ${record.error}`);
    } else {
      lines.push(`Result:\n${compactPreflightResult(record)}`);
    }
  });
  return lines.join('\n');
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
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null } = {},
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
    data: { requestId?: string; source?: string; domain?: string; orgId?: string | null } = {},
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

    const sessionKey = `${uid}:${scope.domain}:${scope.orgId || ''}:${scope.source}`;
    const controller = chatSessionMap.get(sessionKey);
    if (!controller) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Execution controller is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(scope, snapshot.requestId);
    const room = chatExecutionRoom(scope);
    const cancellingPayload = {
      status: 'cancelling',
      source: scope.source,
      requestId: snapshot.requestId,
    };
    io.to(room).emit('agent:status', cancellingPayload);
    controller.abort();
    chatSessionMap.delete(sessionKey);

    const responsePayload = {
      text: '[Cancelled]',
      agentName: 'Lumi',
      source: scope.source,
      requestId: snapshot.requestId,
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

  socket.on("agent:chat", async (
    data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string },
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
    const eventSource = source || 'chat';
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    const conversationAgentId = agentId || 'lumi';
    const uid = userIdFn(socket);
    if (isConfirmationCancellation(visibleUserText)) clearPendingConfirmation(uid);
    let pendingConfirmation = isExplicitConfirmationReply(visibleUserText)
      ? getPendingConfirmation(uid)
      : null;
    let pendingConfirmationPrompt = pendingConfirmation
      ? formatPendingConfirmationPrompt(pendingConfirmation)
      : '';
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
    const executionScope: ChatExecutionScope = {
      userId: uid,
      domain: resolvedDomain,
      orgId: resolvedOrgId,
      source: eventSource,
    };
    const executionRoom = chatExecutionRoom(executionScope);
    const sessionKey = `${uid}:${resolvedDomain}:${resolvedOrgId || ''}:${eventSource}`;
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = {
        ...payload,
        source: payload.source || eventSource,
        requestId,
      };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return;
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    console.log('[ChatHandler] domain:', resolvedDomain, 'orgId:', resolvedOrgId);

    // Request ids are idempotency keys. Socket.IO may deliver a buffered emit
    // after reconnect; acknowledging the existing execution avoids running the
    // same user action twice.
    const existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      try { ack?.({ ok: true, requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        socket.emit(existingExecution.terminalEvent.event, {
          ...existingExecution.terminalEvent.payload,
          replayed: true,
        });
      } else {
        const resumableStatus = existingExecution.status === 'planning' || existingExecution.status === 'acknowledged'
          ? 'thinking'
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

    // Abort any previous chat session for this user
    const prevController = chatSessionMap.get(sessionKey);
    if (prevController) prevController.abort();
    const superseded = beginChatExecution(executionScope, requestId);
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    const abortController = new AbortController();
    chatSessionMap.set(sessionKey, abortController);
    markLatestUserTurn(executionScope, requestId);
    const releaseChatSession = () => {
      if (chatSessionMap.get(sessionKey) === abortController) chatSessionMap.delete(sessionKey);
    };
    try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}

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
      const conversationTurn = getOrCreateConversationForTurn(
        uid,
        conversationAgentId,
        resolvedDomain,
        resolvedOrgId,
        { userText: visibleUserText },
      );
      const conversation = conversationTurn.conversation;
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
        clearPendingConfirmation(uid);
        pendingConfirmation = null;
        pendingConfirmationPrompt = '';
      }
      const conversationMode = payloadMode || conversation?.mode || undefined;
      if (conversation && payloadMode && payloadMode !== conversation.mode) {
        setConversationMode(conversation.id, payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      const persistedConversationHistory = conversationId ? getMessages(conversationId, 18) : [];
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

      if (shouldBlockDetachedAttachmentFollowup(visibleUserText, attachments, history)) {
        const responseText = buildDetachedAttachmentFollowupResponse(visibleUserText);
        emitAgent("agent:status", { status: "responding", agentName: "Lumi" });
        emitAgent("agent:response", { text: responseText, agentName: "Lumi", finalized: true, blocked: false, reason: '' });
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, domain: resolvedDomain, orgId: resolvedOrgId });
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
        }
        emitAgent("agent:status", { status: "idle" });
        releaseChatSession();
        return;
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
      let effectiveSystemPrompt = systemInstruction;
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
      effectiveSystemPrompt += '\n\nFile handling rule: historical attachments or previous file names are not current files. Use file tools only with files attached in the current user turn, exact local paths stated in the current user message, or exact local paths preserved by the Recent action continuation context for the same unresolved task. If the user says "this file", "the attachment", or similar without a current attachment/path or a verified continuation path, ask them to reattach the file or provide the exact path before calling file tools.';
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

      const turnDispatch = buildLumiTurnDispatch({
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
      });
      const turnFlow = turnDispatch.flow;
      const turnSurface = turnDispatch.surface;
      effectiveSystemPrompt += '\n\n' + turnDispatch.promptOverlay;
      effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
      effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
        userId: uid,
        text: turnFlow.routeText,
        flow: turnFlow,
        toolRegistry,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
      });

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
      let cachedExecutionDecision: ReturnType<typeof buildLumiExecutionDecision> | null = null;
      let cachedCapabilitySelection: ReturnType<typeof buildLumiCapabilitySelection> | null = null;
      const getTurnExecutionDecision = () => {
        if (!cachedExecutionDecision) {
          cachedExecutionDecision = buildLumiExecutionDecision({
            flow: turnFlow,
            text: turnFlow.routeText,
            toolDeclarations: toolRegistry.getToolDeclarations(),
            toolRegistry,
            personalityToolPolicy: personality.toolPolicy,
            isSanctuary,
          });
        }
        return cachedExecutionDecision;
      };
      const getTurnCapabilitySelection = () => {
        if (!cachedCapabilitySelection) {
          cachedCapabilitySelection = buildLumiCapabilitySelection({
            dispatch: turnDispatch,
            execution: getTurnExecutionDecision(),
            text: turnFlow.routeText,
          });
        }
        return cachedCapabilitySelection;
      };
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

      const recentFailureExplanation = conversationId && !pendingConfirmation
        ? buildRecentFailureExplanation(visibleUserText, getMessages(conversationId, 24))
        : '';
      if (recentFailureExplanation) {
        emitAgent("agent:status", { status: "responding", agentName: personality.name });
        emitAgent("agent:response", { text: recentFailureExplanation, agentName: personality.name, finalized: true, blocked: false, reason: '' });
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: recentFailureExplanation, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
        }
        persistChatLearning(recentFailureExplanation, {
          sourceInteractionId: `${interactionId}_recent_failure_explanation`,
          logLabel: 'recent failure explanation',
        });
        emitAgent("agent:status", { status: "idle" });
        releaseChatSession();
        return;
      }

      // ── Desktop relay: route tools to the user's registered desktop client, not only this chat socket ──
      const desktopRelay = createDesktopRelay({
        io,
        userId: uid,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        source: 'chat',
        requestSocket: socket,
        emitToolLifecycle,
        formatResultForLifecycle: formatToolResultForUi,
        // The foreground execution belongs to the user task, not to this
        // transport connection. The relay still has its own bounded timeout.
        cancelOnRequestSocketDisconnect: false,
      });

      const requestToolConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
        if (
          pendingConfirmation
          && consumePendingConfirmation(uid, pendingConfirmation.id, toolName, args)
        ) {
          console.log(`[ChatHandler] Consumed one-time confirmation for "${toolName}".`);
          return true;
        }
        if (canAutoApproveAction(toolName, args, { actionIntent: visibleUserText })) return true;
        const pending = recordPendingConfirmation(uid, toolName, args, eventSource);
        console.warn(`[ChatHandler] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
        return false;
      };

      const directlyAppliedMode: OperationMode | null = turnFlow.autoPromoteToAssistant
        ? 'assistant'
        : turnFlow.requestedMode;
      if (directlyAppliedMode) {
        let modeSynced = true;
        const modeToolRecord: ToolExecutionRecord = {
          id: `chat-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
        if (modeSynced) saveStoredOperationMode(uid, directlyAppliedMode);

        if (isPureOperationModeSwitchRequest(visibleUserText || text, turnFlow.requestedMode)) {
          let responseText = formatOperationModeSwitchResponse(
            directlyAppliedMode,
            modeSynced,
            visibleUserText || text,
          );
          const finalizedMode = finalizeLumiResponse({
            taskText: executionTaskText,
            responseText,
            toolRecords: [modeToolRecord],
            source: 'chat',
            flow: turnFlow,
          });
          responseText = finalizedMode.text;
          if (finalizedMode.notification) {
            emitAgent('agent:notification', finalizedMode.notification);
          }
          persistChatTakeoverExecution(responseText, {
            toolRecords: [modeToolRecord],
            source: 'chat_mode',
            sourceInteractionId: `${interactionId}_mode`,
            finalizationBlocked: finalizedMode.blocked,
            assistantTextTrusted: !finalizedMode.blocked,
            finalizationReason: finalizedMode.reason,
          });

          emitAgent('agent:status', { status: 'responding', agentName: personality.name });
          emitAgent('agent:response', {
            text: responseText,
            agentName: personality.name,
            source: 'chat_mode',
            finalized: true,
            blocked: finalizedMode.blocked,
            reason: finalizedMode.reason || '',
          });
          if (conversationId) {
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, mode: directlyAppliedMode, domain: resolvedDomain, orgId: resolvedOrgId });
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, personality: personality.id, mode: directlyAppliedMode, cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : undefined, domain: resolvedDomain, orgId: resolvedOrgId });
            socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat_mode' });
          }
          if (!finalizedMode.blocked) {
            persistChatLearning(responseText, {
              sourceInteractionId: `${interactionId}_mode`,
              logLabel: 'chat mode switch',
            });
          }
          emitAgent('agent:status', { status: 'idle', agentName: personality.name });
          releaseChatSession();
          return;
        }
      }

      const specialWorkflowText = [visibleUserText || text, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
      const specialWorkflow = turnFlow.specialWorkflow;
      if (specialWorkflow) {
        const workflowHighRiskApprovals = new Set<string>();
        const workflowDesktopRelay = async (toolName: string, args: Record<string, any> = {}): Promise<string> => {
          const decision = evaluateActionConstitution(toolName, args, 'safe', {
            source: specialWorkflow.source,
            actionIntent: specialWorkflowText,
          });
          if (decision.level === 'forbidden') {
            throw new Error(`Desktop action blocked: ${decision.reason}`);
          }
          if (classifyActionRisk(toolName, args, { actionIntent: specialWorkflowText }) === 'high') {
            const approvalKey = `${toolName}:${JSON.stringify(args || {}).slice(0, 240)}`;
            if (!workflowHighRiskApprovals.has(approvalKey)) {
              const allowed = await requestToolConfirmation(toolName, args);
              if (!allowed) throw new Error(`Desktop action declined by user: ${toolName}`);
              workflowHighRiskApprovals.add(approvalKey);
            }
          }
          return desktopRelay(toolName, args);
        };
        const workflowExecutionDecision = buildLumiExecutionDecision({
          flow: turnFlow,
          text: specialWorkflowText,
        toolDeclarations: toolRegistry.getToolDeclarations(),
        toolRegistry,
        personalityToolPolicy: personality.toolPolicy,
          isSanctuary,
        });
        const workflowIntentTrace = buildLumiIntentTrace({
          dispatch: turnDispatch,
          execution: workflowExecutionDecision,
          text: specialWorkflowText,
          source: eventSource,
        });
        socket.emit('agent:intent_trace', workflowIntentTrace);
        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: specialWorkflow.phase,
          ...(shouldForwardPreFinalizationProgress(specialWorkflow.statusDetail)
            ? { detail: specialWorkflow.statusDetail }
            : {}),
        });

        let workflowResponseText = '';
        let workflowToolCalls: ToolExecutionRecord[] = [];
        try {
          const workflowResult = await specialWorkflow.run({
            socket,
            userText: specialWorkflowText,
            userId: uid,
            desktopRelay: workflowDesktopRelay,
            // Narration is returned as responseText. Do not expose it before
            // the shared result finalizer has inspected the tool ledger.
            speak: async () => 0,
            voiceScope: {
              domain: resolvedDomain === 'work' ? 'work' : 'personal',
              orgId: resolvedOrgId,
            },
            isCancelled: () => abortController.signal.aborted,
          });
          workflowResponseText = workflowResult.responseText;
          workflowToolCalls = workflowResult.toolCalls;
        } catch (err: any) {
          console.warn(`[ChatHandler] ${specialWorkflow.logLabel} failed:`, err?.message || err);
          workflowResponseText = specialWorkflow.fallbackText;
        }

        const finalizedWorkflow = finalizeLumiResponse({
          taskText: specialWorkflowText,
          responseText: workflowResponseText,
          toolRecords: workflowToolCalls,
          source: specialWorkflow.source,
          flow: turnFlow,
        });
        workflowResponseText = finalizedWorkflow.text;
        if (finalizedWorkflow.notification) {
          emitAgent('agent:notification', finalizedWorkflow.notification);
        }
        persistChatTakeoverExecution(workflowResponseText, {
          toolRecords: workflowToolCalls,
          source: specialWorkflow.source,
          sourceInteractionId: `${interactionId}_workflow`,
          capabilitySelection: buildLumiCapabilitySelection({
            dispatch: turnDispatch,
            execution: workflowExecutionDecision,
            text: specialWorkflowText,
          }),
          finalizationBlocked: finalizedWorkflow.blocked,
          assistantTextTrusted: !finalizedWorkflow.blocked,
          finalizationReason: finalizedWorkflow.reason,
        });

        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          for (const tc of workflowToolCalls) {
            const tcSummary = summarizeToolRecordForPersistence(tc);
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
          }
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: workflowResponseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: workflowToolCalls.length ? workflowToolCalls : undefined, cognitiveIntent: finalizedWorkflow.blocked ? 'work_product_guard' : undefined });
        }

        try {
          const db = readDB();
          db.interactions.push({
            id: interactionId,
            userId: uid,
            agentId: agentId || '',
            conversationId: conversationId || '',
            content: storedUserContent,
            response: workflowResponseText,
            role: "user",
            personality: personality.id,
            timestamp: new Date().toISOString(),
            cognitiveIntent: finalizedWorkflow.blocked ? 'work_product_guard' : specialWorkflow.id,
            llmWasCalled: false,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          });
          writeDB(db);
        } catch (persistErr: any) {
          console.warn(`[ChatHandler] ${specialWorkflow.logLabel} interaction persistence failed:`, persistErr?.message || persistErr);
        }

        emitAgent("agent:response", {
          text: workflowResponseText,
          agentName: personality.name,
          source: specialWorkflow.source,
          finalized: true,
          blocked: finalizedWorkflow.blocked,
          reason: finalizedWorkflow.reason || '',
        });
        if (conversationId) {
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: specialWorkflow.source });
        }
        if (!finalizedWorkflow.blocked) {
          persistChatLearning(workflowResponseText, {
            channel: 'workflow',
            toolRecords: workflowToolCalls,
            sourceInteractionId: `${interactionId}_workflow`,
            logLabel: specialWorkflow.source,
          });
        }
        emitAgent("agent:status", { status: "idle", agentName: personality.name });
        releaseChatSession();
        return;
      }

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
      const intentTrace = buildLumiIntentTrace({
        dispatch: turnDispatch,
        execution: executionDecision,
        text: currentTurnDecisionText,
        source: eventSource,
      });
      const capabilitySelection = getTurnCapabilitySelection();
      const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
        channel: 'chat',
        text: turnFlow.routeText,
        flow: turnFlow,
        capabilitySelection,
      });
      const toolRoute = executionDecision.toolRoute;
      const routedToolPolicy = executionDecision.toolPolicy;
      const exposeAgentWork = turnFlow.exposeAgentWork;
      effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
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
      emitAgent('agent:capability_selection', {
        lane: capabilitySelection.lane,
        primary: capabilitySelection.primary,
        reasons: capabilitySelection.reasons,
        preferredTools: capabilitySelection.preferredTools,
        source: eventSource,
      });
      if (desktopExecutionPolicy.applies) {
        emitAgent('agent:desktop_execution_policy', {
          reason: desktopExecutionPolicy.reason,
          evidenceTools: desktopExecutionPolicy.evidenceTools,
          actuationTools: desktopExecutionPolicy.actuationTools,
          verificationTools: desktopExecutionPolicy.verificationTools,
          source: eventSource,
        });
      }
      effectiveSystemPrompt += '\n\n' + buildInteractionModeOverlay(turnFlow);
      if (workSurfaceRoute.promptOverlay) {
        effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
      }
      effectiveSystemPrompt += '\n\n' + executionDecision.promptOverlay;
      effectiveSystemPrompt += '\n\n' + capabilitySelection.promptOverlay;
      if (desktopExecutionPolicy.promptOverlay) {
        effectiveSystemPrompt += '\n\n' + desktopExecutionPolicy.promptOverlay;
      }
      const visionRoutingOverlay = effectiveOperationMode !== 'meeting' ? buildVisionRoutingOverlay(uid, text) : '';
      if (visionRoutingOverlay) {
        effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
      }
      effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
        channel: 'chat',
        flow: turnFlow,
      });

      // Keep this late so English system/tool context cannot pull the reply language.
      effectiveSystemPrompt += '\n\n' + buildResponseLanguageInstruction(text);

      // Work-domain chats use organization LLM prefs when configured. If the org
      // has no explicit policy, they visibly inherit the user's personal prefs.
      const userLLMPrefs = getScopedPreferredLLM(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
      const resolveProvider = (model: string) =>
        model.startsWith('deepseek') ? 'deepseek' as const
        : model.startsWith('qwen') ? 'qwen' as const
        : model.startsWith('gpt') || model.startsWith('o1') ? 'openai' as const
        : model.startsWith('claude') ? 'anthropic' as const
        : 'gemini' as const;

      let activeProvider = userLLMPrefs.provider || 'deepseek';
      let activeModel = (userLLMPrefs.models || {})[activeProvider] || DEFAULT_MODELS[activeProvider] || 'deepseek-v4-flash';

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        activeProvider = 'auto';
        activeModel = 'qwen2.5:7b';
        console.log('[Chat] Hybrid mode enabled — local Ollama → cloud DeepSeek');
      }

      const scheduleChatSummary = (targetConversationId: string) => {
        scheduleConversationSummary({
          conversationId: targetConversationId,
          userId: uid,
          provider: activeProvider,
          model: activeModel,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          llmGetters,
          log: { info: console.log, warn: console.warn },
        });
      };

      // ── Named Workflow Quick-Path: "run my X" / "跑XX流程" ──
      const runWorkflowMatch = text.match(/(?:run|执行|跑|运行)\s+(?:my\s+)?(.+?)(?:\s*(?:routine|workflow|流程|工作流))?\s*$/i);
      let workflowQuickResult: string | null = null;
      const workflowQuickToolRecords: ToolExecutionRecord[] = [];
      if (runWorkflowMatch && executionDecision.allowToolUse) {
        const wfName = runWorkflowMatch[1].trim().toLowerCase();
        const workflowScope = { domain: resolvedDomain, orgId: resolvedOrgId };
        const allWfs = listWorkflows(uid, undefined, workflowScope);
        const matched = allWfs.find(w => w.name.toLowerCase().includes(wfName));
        if (matched) {
          console.log('[ChatHandler] Workflow quick-path matched:', matched.name);
          const steps: string[] = [];
          for (let i = 0; i < matched.steps.length; i++) {
            const step = matched.steps[i];
            if (step.tool) {
              const toolRecord: ToolExecutionRecord = {
                id: `workflow-quick-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
                name: step.tool,
                arguments: step.args || {},
                result: '',
              };
              try {
                const result = await toolRegistry.execute(step.tool, step.args || {}, {
                  userId: uid,
                  domain: resolvedDomain,
                  orgId: resolvedOrgId,
                  desktopRelay,
                  llmGetters,
                  source: eventSource || 'chat',
                  supervisedExternalCommits: true,
                  allowLocalFileWrites,
                  localWriteIntentReason,
                  requestConfirmation: requestToolConfirmation,
                  actionIntent: visibleUserText,
                  ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
                });
                toolRecord.result = result || '';
                workflowQuickToolRecords.push(toolRecord);
                steps.push(`Step ${i + 1} (${step.tool}): ${(result || 'OK').slice(0, 200)}`);
              } catch (e: any) {
                toolRecord.error = e.message || String(e);
                workflowQuickToolRecords.push(toolRecord);
                steps.push(`Step ${i + 1} (${step.tool}): Error - ${e.message}`);
                break;
              }
            } else {
              steps.push(`Step ${i + 1}: ${step.description} (no tool bound — use this as a guide)`);
            }
          }
          recordWorkflowRun(uid, matched.name, workflowScope);
          workflowQuickResult = `Ran workflow "${matched.name}" (${matched.steps.length} steps):\n${steps.join('\n')}`;
        }
      }

      if (workflowQuickResult) {
        const finalizedWorkflowQuick = finalizeLumiResponse({
          taskText: executionTaskText,
          responseText: workflowQuickResult,
          toolRecords: workflowQuickToolRecords,
          source: 'workflow',
          flow: turnFlow,
        });
        workflowQuickResult = finalizedWorkflowQuick.text;
        if (finalizedWorkflowQuick.notification) {
          emitAgent('agent:notification', finalizedWorkflowQuick.notification);
        }
        persistChatTakeoverExecution(workflowQuickResult, {
          toolRecords: workflowQuickToolRecords,
          source: 'workflow',
          sourceInteractionId: `${interactionId}_workflow_quick`,
          capabilitySelection,
          finalizationBlocked: finalizedWorkflowQuick.blocked,
          assistantTextTrusted: !finalizedWorkflowQuick.blocked,
          finalizationReason: finalizedWorkflowQuick.reason,
        });
        emitAgent("agent:status", { status: "responding" });
        if (conversationId) {
          addMessage({
            userId: uid,
            agentId: conversationAgentId,
            conversationId,
            role: 'user',
            content: storedUserContent,
            personality: personality.id,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          });
          for (const record of workflowQuickToolRecords) {
            addMessage({
              userId: uid,
              agentId: conversationAgentId,
              conversationId,
              role: 'tool',
              content: summarizeToolRecordForPersistence(record),
              domain: resolvedDomain,
              orgId: resolvedOrgId,
            });
          }
          addMessage({
            userId: uid,
            agentId: conversationAgentId,
            conversationId,
            role: 'assistant',
            content: workflowQuickResult,
            personality: personality.id,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            toolCalls: workflowQuickToolRecords.length ? workflowQuickToolRecords : undefined,
            cognitiveIntent: finalizedWorkflowQuick.blocked ? 'work_product_guard' : undefined,
          });
          scheduleChatSummary(conversationId);
        }
        emitAgent("agent:response", {
          text: workflowQuickResult,
          agentName: personality.name,
          finalized: true,
          blocked: finalizedWorkflowQuick.blocked,
          reason: finalizedWorkflowQuick.reason || '',
        });
        if (conversationId) {
          socket.emit('chat:conversation_updated', {
            conversationId,
            agentId: conversationAgentId,
            source: 'workflow',
          });
        }
        if (!finalizedWorkflowQuick.blocked) {
          persistChatLearning(workflowQuickResult, {
            channel: 'workflow',
            toolRecords: workflowQuickToolRecords,
            sourceInteractionId: `${interactionId}_workflow_quick`,
            logLabel: 'workflow quick path',
          });
          if (conversationId) {
            try {
              const topics = extractTopics(text);
              for (const topic of topics) trackTopic(conversationId, topic);
            } catch {}
          }
        }
        emitAgent("agent:status", { status: "idle" });
        releaseChatSession();
        return;
      }

      // ── Quick Command Fast-Path: deterministic commands skip LLM entirely ──
      try {
        const quickResult = await matchQuickCommand(text, uid, {
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          surface: turnSurface,
        });
        if (quickResult?.matched && (!quickResult.toolCall || executionDecision.allowToolUse)) {
          console.log('[ChatHandler] Quick command:', text.slice(0, 60));
          let quickResponseText = quickResult.responseText;
          let quickToolResult = '';
          let quickToolError: string | undefined;
          const quickToolRecords: ToolExecutionRecord[] = [];
          if (quickResult.toolCall) {
            const toolCid = `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const shouldEmitQuickTool = !isDirectDesktopTool(quickResult.toolCall.name);
            if (shouldEmitQuickTool) {
              emitToolLifecycle({
                correlationId: toolCid,
                name: quickResult.toolCall.name,
                arguments: quickResult.toolCall.arguments,
              });
            }
            try {
              const tcResult = await toolRegistry.execute(quickResult.toolCall.name, quickResult.toolCall.arguments, {
                userId: uid,
                domain: resolvedDomain,
                orgId: resolvedOrgId,
                desktopRelay,
                llmGetters,
                source: 'quick_command',
                supervisedExternalCommits: true,
                allowLocalFileWrites,
                localWriteIntentReason,
                requestConfirmation: requestToolConfirmation,
                actionIntent: visibleUserText,
                ...(routedToolPolicy ? {
                  toolPolicy: buildQuickCommandToolPolicy(routedToolPolicy, quickResult.toolCall.name),
                } : {}),
              });
              quickToolResult = tcResult || '';
              if (shouldEmitQuickTool) {
                emitToolLifecycle({
                  correlationId: toolCid,
                  name: quickResult.toolCall.name,
                  arguments: quickResult.toolCall.arguments,
                  result: formatToolResultForUi(tcResult),
                });
              }
            } catch (toolErr: any) {
              quickToolError = toolErr.message || String(toolErr);
              if (shouldEmitQuickTool) {
                emitToolLifecycle({
                  correlationId: toolCid,
                  name: quickResult.toolCall.name,
                  arguments: quickResult.toolCall.arguments,
                  error: toolErr.message,
                });
              }
            }
            if (quickResult.formatToolResult) {
              quickResponseText = quickResult.formatToolResult(quickToolResult, quickToolError);
            } else if (quickToolError) {
              quickResponseText = `\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\uff1a${quickToolError}`;
            }
            quickToolRecords.push({
              id: toolCid,
              name: quickResult.toolCall.name,
              arguments: quickResult.toolCall.arguments,
              result: quickToolResult,
              error: quickToolError,
            });
          }
          const quickFinalized = finalizeLumiResponse({
            taskText: executionTaskText,
            responseText: quickResponseText,
            toolRecords: quickToolRecords,
            source: 'chat',
            flow: turnFlow,
          });
          quickResponseText = quickFinalized.text;
          if (quickFinalized.notification) emitAgent('agent:notification', quickFinalized.notification);
          persistChatTakeoverExecution(quickResponseText, {
            toolRecords: quickToolRecords,
            source: 'chat_quick_command',
            sourceInteractionId: `${interactionId}_quick`,
            capabilitySelection,
            finalizationBlocked: quickFinalized.blocked,
            assistantTextTrusted: !quickFinalized.blocked,
            finalizationReason: quickFinalized.reason,
          });
          emitAgent("agent:response", {
            text: quickResponseText,
            agentName: personality.name,
            finalized: true,
            blocked: quickFinalized.blocked,
            reason: quickFinalized.reason || '',
          });
          if (conversationId) {
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            if (quickResult.toolCall) {
              addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: `[Tool: ${quickResult.toolCall.name}] Called`, domain: resolvedDomain, orgId: resolvedOrgId });
            }
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: quickResponseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: quickToolRecords.length ? quickToolRecords : undefined, cognitiveIntent: quickFinalized.blocked ? 'work_product_guard' : undefined });
            scheduleChatSummary(conversationId);
            socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
          }
          if (!quickFinalized.blocked) {
            persistChatLearning(quickResponseText, {
              toolRecords: quickToolRecords,
              sourceInteractionId: `${interactionId}_quick`,
              logLabel: 'chat quick command',
            });
          }
          emitAgent("agent:status", { status: "idle" });
          // Track topics for quick commands too
          if (conversationId && !quickFinalized.blocked) {
            try {
              const topics = extractTopics(text);
              for (const topic of topics) trackTopic(conversationId, topic);
            } catch {}
          }
          releaseChatSession();
          return;
        }
      } catch (qcErr: any) {
        console.warn('[ChatHandler] Quick command check failed, falling through:', qcErr.message);
      }

      if (isMusicProfileAnalysisRequest(text)) {
        emitAgent("agent:status", { status: "thinking", agentName: personality.name, detail: "Analyzing music profile" });
        let profileResponse = '';
        const profileRecord: ToolExecutionRecord = {
          id: `chat-music-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: 'music_profile_analysis',
          arguments: { maxSongs: 3000 },
          result: '',
        };
        try {
          const profile = await analyzeLikedMusicProfile(uid, { maxSongs: 3000 });
          profileResponse = formatMusicProfileReport(profile);
          profileRecord.result = JSON.stringify({
            ok: true,
            source: profile.source,
            playlistName: profile.playlistName,
            analyzedTracks: profile.analyzedTracks,
            summary: profile.summaryCn,
          });
        } catch (profileErr: any) {
          profileRecord.error = profileErr?.message || String(profileErr);
          profileResponse = `我现在还没能完成网易云喜欢歌单分析。\n\n${profileErr?.message || '请确认网易云已经登录，再试一次。'}`;
          socket.emit('music:error', { message: profileResponse });
        }

        const profileFinalized = finalizeLumiResponse({
          taskText: executionTaskText,
          responseText: profileResponse,
          toolRecords: [profileRecord],
          source: 'chat',
          flow: turnFlow,
        });
        profileResponse = profileFinalized.text;
        if (profileFinalized.notification) {
          emitAgent('agent:notification', profileFinalized.notification);
        }
        persistChatTakeoverExecution(profileResponse, {
          toolRecords: [profileRecord],
          source: 'chat_music_profile',
          sourceInteractionId: `${interactionId}_music_profile`,
          capabilitySelection,
          finalizationBlocked: profileFinalized.blocked,
          assistantTextTrusted: !profileFinalized.blocked,
          finalizationReason: profileFinalized.reason,
        });
        emitAgent("agent:response", {
          text: profileResponse,
          agentName: personality.name,
          finalized: true,
          blocked: profileFinalized.blocked,
          reason: profileFinalized.reason || '',
        });
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: profileResponse, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: [profileRecord], cognitiveIntent: profileFinalized.blocked ? 'work_product_guard' : undefined });
          scheduleChatSummary(conversationId);
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
        }
        if (!profileFinalized.blocked) {
          persistChatLearning(profileResponse, {
            toolRecords: [profileRecord],
            sourceInteractionId: `${interactionId}_music_profile`,
            logLabel: 'music profile',
          });
        }
        emitAgent("agent:status", { status: "idle" });
        releaseChatSession();
        return;
      }

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
          { provider: activeProvider, model: activeProvider === 'deepseek' ? 'deepseek-v4-flash' : activeModel, userId: uid, maxTokens: 60, domain: resolvedDomain, orgId: resolvedOrgId },
          llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
          llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
        );
        return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
      };

      const cognitionToolContext: ToolContext = {
        userId: uid,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        desktopRelay,
        llmGetters,
        source: 'chat_cognition_direct',
        supervisedExternalCommits: true,
        allowLocalFileWrites,
        localWriteIntentReason,
        requestConfirmation: requestToolConfirmation,
        actionIntent: visibleUserText,
        toolPolicy: routedToolPolicy || personality.toolPolicy,
        isCancelled: () => abortController.signal.aborted,
      };
      const cognition = await processInput(text, cognitiveCtx, llmClassifier, cognitionToolContext);
      console.log('[ChatHandler] cognition result:', cognition.intent.category, 'directToolExecuted:', cognition.directToolExecuted, 'responseText:', cognition.responseText?.slice(0, 100));

      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        console.log('[ChatHandler] sentiment:', sentiment);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      const complexCategories = ['command', 'code', 'question', 'analysis'];
      const isComplex = complexCategories.includes(cognition.intent.category);
      if (activeProvider === 'deepseek') {
        activeModel = isComplex ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
      } else if (activeProvider === 'qwen') {
        activeModel = isComplex ? 'qwen-max' : 'qwen-plus';
      } else if (activeProvider === 'gemini') {
        activeModel = isComplex ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
      } else if (activeProvider === 'openai') {
        activeModel = isComplex ? 'gpt-4o' : 'gpt-4o-mini';
      }
      console.log('[ChatHandler] Model auto-selected:', activeProvider, '/', activeModel, 'for category:', cognition.intent.category);

      let responseText = '';
      let llmWasCalled = false;
      const allToolRecords: ToolExecutionRecord[] = [];
      let actionPreflightContext = '';
      const runPreflightTool = async (name: string, args: Record<string, any>): Promise<ToolExecutionRecord> => {
        const correlationId = `preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record: ToolExecutionRecord = {
          id: correlationId,
          name,
          arguments: args || {},
          result: '',
        };
        const shouldEmitLifecycle = !isDirectDesktopTool(name);
        if (shouldEmitLifecycle) {
          emitToolLifecycle({ correlationId, name, arguments: args || {} });
        }
        try {
          const result = await toolRegistry.execute(name, args || {}, {
            userId: uid,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            desktopRelay,
            llmGetters,
            source: 'chat_preflight',
            supervisedExternalCommits: true,
            allowLocalFileWrites,
            localWriteIntentReason,
            isCancelled: () => abortController.signal.aborted,
            requestConfirmation: requestToolConfirmation,
            actionIntent: visibleUserText,
            ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
          });
          record.result = result || '';
          if (shouldEmitLifecycle) {
            emitToolLifecycle({ correlationId, name, arguments: args || {}, result: formatToolResultForUi(record.result) });
          }
        } catch (err: any) {
          record.error = err?.message || String(err);
          if (shouldEmitLifecycle) {
            emitToolLifecycle({ correlationId, name, arguments: args || {}, error: record.error });
          }
        }
        allToolRecords.push(record);
        return record;
      };

      const historyContextText = getRecentHistoryText(history);
      const preflightSearchText = [visibleUserText, attachmentContext].filter(Boolean).join('\n');
      const shouldPreflightLocalAction =
        !cognition.directToolExecuted &&
        !explicitTeamOrchestration &&
        executionDecision.allowToolUse &&
        !clientActionOnlyTurn &&
        !selfRepairTurn &&
        !isSanctuary &&
        shouldRunVisibleActionPreflight(visibleUserText, attachments);

      if (shouldPreflightLocalAction) {
        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: 'preflight',
          detail: "Checking available local evidence before answering",
        });
        const preflightStartIndex = allToolRecords.length;
        const pathKinds = new Map<string, ChatIncomingAttachment['kind'] | undefined>();
        for (const item of attachments) {
          if (shouldSkipPreflightForAttachment(item)) continue;
          if (item.path) pathKinds.set(path.normalize(item.path), item.kind);
        }
        for (const localPath of extractExplicitLocalPaths(visibleUserText)) {
          pathKinds.set(path.normalize(localPath), pathKinds.get(path.normalize(localPath)));
        }

        if (pathKinds.size > 0) {
          for (const [localPath, kind] of Array.from(pathKinds.entries()).slice(0, 4)) {
            const toolCall = toolForLocalPath(localPath, preflightSearchText, kind);
            const record = await runPreflightTool(toolCall.name, toolCall.arguments);
            if (toolCall.name === 'desktop_list_files' && !record.error) {
              const entries = parseNativeFiles(record.result || '');
              const cadImageCandidates = selectLocalCadImageCandidates(entries, preflightSearchText);
              if (cadImageCandidates.length > 0) {
                for (const candidate of cadImageCandidates) {
                  if (!candidate.path) continue;
                  const candidateTool = toolForLocalFile(candidate.path, preflightSearchText);
                  await runPreflightTool(candidateTool.name, candidateTool.arguments);
                }
              } else {
                const candidate = selectBestLocalFileCandidate(entries, preflightSearchText);
                if (candidate?.path) {
                  const candidateTool = toolForLocalFile(candidate.path, preflightSearchText);
                  await runPreflightTool(candidateTool.name, candidateTool.arguments);
                }
              }
            }
          }
        } else {
          const discovered: NativeFileEntry[] = [];
          const probeDirs = getLikelyLocalDirs(visibleUserText);
          for (const dir of probeDirs.slice(0, 4)) {
            const record = await runPreflightTool('desktop_list_files', { path: dir, limit: 80 });
            if (!record.error) {
              const entries = parseNativeFiles(record.result || '');
              discovered.push(...entries);
            }
          }
          const hadDesktopListingSuccess = allToolRecords
            .slice(preflightStartIndex)
            .some(record => record.name === 'desktop_list_files' && !record.error);
          if (!hadDesktopListingSuccess) {
            for (const dir of probeDirs.slice(0, 2)) {
              const record = await runPreflightTool('list_directory', { path: dir });
              if (!record.error) {
                discovered.push(...parseNativeFiles(record.result || ''));
                if (discovered.length > 0) break;
              }
            }
          }

          const cadImageCandidates = selectLocalCadImageCandidates(discovered, preflightSearchText);
          if (cadImageCandidates.length > 0) {
            for (const candidate of cadImageCandidates) {
              if (!candidate.path) continue;
              const toolCall = toolForLocalFile(candidate.path, preflightSearchText);
              await runPreflightTool(toolCall.name, toolCall.arguments);
            }
          } else {
            const candidate = selectBestLocalFileCandidate(discovered, visibleUserText);
            if (candidate?.path) {
              const toolCall = toolForLocalFile(candidate.path, preflightSearchText);
              await runPreflightTool(toolCall.name, toolCall.arguments);
            }
          }
        }

        actionPreflightContext = formatPreflightContext(allToolRecords.slice(preflightStartIndex));
        if (actionPreflightContext) {
          effectiveSystemPrompt += '\n\n' + actionPreflightContext;
        }
      }

      const clientDiagnosticPlan = selfRepairTurn
        ? buildClientDiagnosticPlan(visibleUserText)
        : [];
      if (
        !responseText
        && !actionPreflightContext
        && clientDiagnosticPlan.length > 0
        && executionDecision.allowToolUse
        && !clientActionOnlyTurn
        && !isSanctuary
      ) {
        const zh = /[\u3400-\u9fff]/u.test(visibleUserText);
        const progressText = zh
          ? CN_CLIENT_DIAGNOSTIC_MESSAGES.checking
          : 'I am checking the client and runtime path now.';
        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: 'client_diagnostic',
          detail: progressText,
        });
        emitAgent("agent:progress", {
          text: progressText,
          tone: 'tool',
          agentName: personality.name,
        });
        const diagnosticStartIndex = allToolRecords.length;
        for (const call of clientDiagnosticPlan) {
          await runPreflightTool(call.name, call.arguments);
        }
        responseText = formatClientDiagnosticResult(
          allToolRecords.slice(diagnosticStartIndex),
          visibleUserText,
        ) || '';
        llmWasCalled = false;
      }

      const desktopObservationPlan = buildDesktopObservationPlan(visibleUserText);
      if (
        !responseText &&
        !explicitTeamOrchestration &&
        desktopObservationPlan.length > 0 &&
        executionDecision.allowToolUse &&
        !clientActionOnlyTurn &&
        !selfRepairTurn &&
        !isSanctuary
      ) {
        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: 'desktop_observation',
          detail: 'Reading current desktop state',
        });
        const observationStartIndex = allToolRecords.length;
        for (const call of desktopObservationPlan) {
          await runPreflightTool(call.name, call.arguments);
        }
        responseText = formatDesktopObservationResult(
          allToolRecords.slice(observationStartIndex),
          visibleUserText,
        ) || '';
        llmWasCalled = false;
      }

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

      if (cognition.directToolExecuted && cognition.responseText) {
        // Path A: Lumi handled this directly — no LLM needed
        responseText = cognition.responseText;
        if (cognition.toolRecord) allToolRecords.push(cognition.toolRecord);
        console.log(`[Cognition] Direct tool '${cognition.intent.directToolCall?.name}' handled without LLM`);
      }

      // Path A2: music intent. Handle before the generic tool loop so Lumi
      // does not wander into unrelated tools or report raw provider errors.
      const isMusicAdjustment = isMusicAdjustmentRequest(text);
      if (!responseText && (isMusicPlaybackRequest(text) || isMusicAdjustment)) {
        const musicRecord: ToolExecutionRecord = {
          id: `chat-music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: isMusicAdjustment ? 'music_runtime_adjust' : 'music_runtime_playback',
          arguments: { text },
          result: '',
        };
        try {
          const result = isMusicAdjustment
            ? await adjustMusicPlayback(uid, socket, text)
            : await searchAndPlay(uid, socket, text);
          musicRecord.result = JSON.stringify(result);
          if (result.success && result.text) {
            responseText = result.text;
            llmWasCalled = true;
          } else {
            responseText = getMusicFailureMessage(result.reason);
            socket.emit('music:error', { message: responseText });
          }
        } catch (musicErr: any) {
          musicRecord.error = musicErr?.message || String(musicErr);
          console.warn('[Music Intent] Failed:', musicErr.message);
          responseText = getMusicFailureMessage(musicErr?.message);
          socket.emit('music:error', { message: responseText });
        }
        allToolRecords.push(musicRecord);
      }

      const foregroundWeChatReadArgs = buildForegroundWeChatReadArgs(text);
      if (!responseText && !actionPreflightContext && executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn && foregroundWeChatReadArgs) {
        const toolName = 'wechat_read_recent_chat';
        const correlationId = `wechat-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toolRecord: ToolExecutionRecord = {
          id: correlationId,
          name: toolName,
          arguments: foregroundWeChatReadArgs,
          result: '',
        };

        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: 'foreground_messaging_read',
          detail: '\u6b63\u5728\u524d\u53f0\u5fae\u4fe1\u91cc\u8bfb\u53d6\u804a\u5929\u5185\u5bb9',
        });
        emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatReadArgs });

        try {
          const toolResult = await toolRegistry.execute(toolName, foregroundWeChatReadArgs, {
            userId: uid,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            desktopRelay,
            llmGetters,
            source: 'chat_foreground_messaging_read',
            supervisedExternalCommits: true,
            allowLocalFileWrites,
            localWriteIntentReason,
            isCancelled: () => abortController.signal.aborted,
            requestConfirmation: requestToolConfirmation,
            actionIntent: visibleUserText,
            toolPolicy: routedToolPolicy || personality.toolPolicy,
            onProgress: (step: string) => {
              if (shouldForwardPreFinalizationProgress(step)) {
                emitAgent("agent:progress", { text: step, tone: 'tool', agentName: personality.name });
              }
            },
          });
          toolRecord.result = toolResult || '';
          emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatReadArgs, result: formatToolResultForUi(toolRecord.result) });
          let parsed: any = {};
          try { parsed = JSON.parse(toolRecord.result || '{}'); } catch {}
          const contact = String(foregroundWeChatReadArgs.contact || '').trim();
          const summary = String(parsed.contentSummary || '').trim();
          if (parsed.read && summary) {
            responseText = contact
              ? `\u6211\u5df2\u7ecf\u5b9a\u4f4d\u5230\u4f60\u548c${contact}\u7684\u5fae\u4fe1\u804a\u5929\u3002\u53ef\u89c1\u6700\u8fd1\u5185\u5bb9\u5982\u4e0b\uff1a\n\n${summary}`
              : `\u6211\u5df2\u7ecf\u8bfb\u5230\u5f53\u524d\u5fae\u4fe1\u804a\u5929\u7684\u53ef\u89c1\u6700\u8fd1\u5185\u5bb9\uff1a\n\n${summary}`;
          } else if (parsed.read) {
            const evidence = String(parsed.uiSnapshotPreview || '').slice(0, 1200);
            responseText = contact
              ? `\u6211\u5df2\u7ecf\u5b9a\u4f4d\u5230\u4f60\u548c${contact}\u7684\u5fae\u4fe1\u804a\u5929\uff0c\u4f46\u89c6\u89c9\u6458\u8981\u4e0d\u53ef\u7528\u3002\u5f53\u524d\u53ef\u9a8c\u8bc1\u7684\u7a97\u53e3\u8bc1\u636e\uff1a\n\n${evidence}`
              : `\u6211\u5df2\u7ecf\u5b9a\u4f4d\u5230\u5f53\u524d\u5fae\u4fe1\u804a\u5929\uff0c\u4f46\u89c6\u89c9\u6458\u8981\u4e0d\u53ef\u7528\u3002\u5f53\u524d\u53ef\u9a8c\u8bc1\u7684\u7a97\u53e3\u8bc1\u636e\uff1a\n\n${evidence}`;
          } else {
            responseText = [
              '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
              '\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a\u5fae\u4fe1\u524d\u53f0\u804a\u5929\u8bfb\u53d6\u3002',
              String(parsed.visionError || parsed.note || '\u5df2\u5c1d\u8bd5\u805a\u7126\u5fae\u4fe1\uff0c\u4f46\u6ca1\u6709\u62ff\u5230\u53ef\u8bfb\u7684\u804a\u5929\u5185\u5bb9\u8bc1\u636e\u3002'),
            ].join('\n');
          }
          llmWasCalled = false;
        } catch (readErr: any) {
          toolRecord.error = readErr?.message || String(readErr);
          emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatReadArgs, error: toolRecord.error });
          responseText = [
            '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
            `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a\u5fae\u4fe1\u524d\u53f0\u804a\u5929\u8bfb\u53d6: ${toolRecord.error}\u3002`,
            '\u6211\u4e0d\u4f1a\u628a\u53ea\u6253\u5f00\u6216\u805a\u7126\u5fae\u4fe1\u8bf4\u6210\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9\u3002',
          ].join('\n');
          llmWasCalled = false;
        }
        allToolRecords.push(toolRecord);
      }

      const foregroundWeChatSendArgs = buildForegroundWeChatSendArgs(text);
      if (!responseText && !actionPreflightContext && executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn && foregroundWeChatSendArgs) {
        const toolName = 'wechat_send_message';
        const correlationId = `wechat-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toolRecord: ToolExecutionRecord = {
          id: correlationId,
          name: toolName,
          arguments: foregroundWeChatSendArgs,
          result: '',
        };

        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: 'foreground_messaging',
          detail: '\u6b63\u5728\u524d\u53f0\u5fae\u4fe1\u91cc\u53d1\u9001\u6d88\u606f',
        });
        emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatSendArgs });

        try {
          const toolResult = await toolRegistry.execute(toolName, foregroundWeChatSendArgs, {
            userId: uid,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            desktopRelay,
            llmGetters,
            source: 'chat_foreground_messaging',
            supervisedExternalCommits: true,
            allowLocalFileWrites,
            localWriteIntentReason,
            isCancelled: () => abortController.signal.aborted,
            requestConfirmation: requestToolConfirmation,
            actionIntent: visibleUserText,
            toolPolicy: routedToolPolicy || personality.toolPolicy,
            onProgress: (step: string) => {
              if (shouldForwardPreFinalizationProgress(step)) {
                emitAgent("agent:progress", { text: step, tone: 'tool', agentName: personality.name });
              }
            },
          });
          toolRecord.result = toolResult || '';
          emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatSendArgs, result: formatToolResultForUi(toolRecord.result) });
          const contact = String(foregroundWeChatSendArgs.contact || '').trim();
          const message = String(foregroundWeChatSendArgs.message || foregroundWeChatSendArgs.draft || '').trim();
          let sendResult: any = {};
          try { sendResult = JSON.parse(toolRecord.result || '{}'); } catch {}
          if (sendResult.sent === true && sendResult.verificationStatus === 'verified') {
            responseText = contact
              ? `\u5df2\u5728\u524d\u53f0\u5fae\u4fe1\u91cc\u53d1\u9001\u7ed9${contact}\uff1a${message}`
              : `\u5df2\u5728\u524d\u53f0\u5fae\u4fe1\u5f53\u524d\u804a\u5929\u91cc\u53d1\u9001\uff1a${message}`;
          } else {
            responseText = contact
              ? `\u6211\u5df2\u5728\u5fae\u4fe1\u91cc\u5b9a\u4f4d${contact}\u5e76\u6267\u884c\u53d1\u9001\uff0c\u4f46\u8fd8\u6ca1\u770b\u5230\u53ef\u786e\u8ba4\u7684\u6d88\u606f\u6c14\u6ce1\uff0c\u56e0\u6b64\u4e0d\u6807\u8bb0\u4e3a\u5df2\u53d1\u9001\u3002`
              : '\u6211\u5df2\u5728\u5fae\u4fe1\u5f53\u524d\u804a\u5929\u6267\u884c\u53d1\u9001\uff0c\u4f46\u8fd8\u6ca1\u770b\u5230\u53ef\u786e\u8ba4\u7684\u6d88\u606f\u6c14\u6ce1\uff0c\u56e0\u6b64\u4e0d\u6807\u8bb0\u4e3a\u5df2\u53d1\u9001\u3002';
          }
          llmWasCalled = false;
        } catch (sendErr: any) {
          toolRecord.error = sendErr?.message || String(sendErr);
          emitToolLifecycle({ correlationId, name: toolName, arguments: foregroundWeChatSendArgs, error: toolRecord.error });
          responseText = [
            '\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210\u3002',
            `\u5361\u4f4f\u7684\u4f4d\u7f6e\uff1a\u5fae\u4fe1\u524d\u53f0\u53d1\u9001: ${toolRecord.error}\u3002`,
            '\u6211\u4e0d\u4f1a\u628a\u672a\u786e\u8ba4\u7684\u53d1\u9001\u8bf4\u6210\u5df2\u53d1\u9001\uff1b\u9700\u8981\u7ee7\u7eed\u5b9a\u4f4d\u5fae\u4fe1\u7a97\u53e3\u5e76\u9a8c\u8bc1\u8f93\u5165\u6846\u3002',
          ].join('\n');
          llmWasCalled = false;
        }
        allToolRecords.push(toolRecord);
      }

      if (!responseText && !actionPreflightContext) {
        const delegationDecision = shouldDelegateWorkInBackground({
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
          prefersSequentialWorkflow,
          availableAgentCount: availableWorkerAgents.length,
        });

        if (delegationDecision.shouldDelegate) {
          const backgroundTask = registerBackgroundTask({
            userId: uid,
            title: visibleUserText.slice(0, 140) || storedUserContent.slice(0, 140) || 'Background task',
            prompt: executionTaskText,
            reason: delegationDecision.reason,
            complexity: backgroundComplexity,
            workers: availableWorkerAgents.slice(0, 6).map((agent: any) => ({
              id: agent.id,
              name: agent.name,
              category: agent.category,
            })),
          });
          const backgroundTaskId = backgroundTask.id;
          const workerNames = backgroundTask.workerNames.slice(0, 3);
          responseText = buildDelegationAck(workerNames, backgroundTaskId);
          llmWasCalled = false;

          emitAgent("agent:delegation", {
            taskId: backgroundTaskId,
            task: backgroundTask,
            reason: delegationDecision.reason,
            complexity: backgroundComplexity,
            workers: backgroundTask.workers,
          });
          emitAgent("agent:background_task_update", {
            taskId: backgroundTaskId,
            task: backgroundTask,
          });
          pushNotification(uid, {
            type: 'background_delegation',
            title: 'Lumi 后台子 agent',
            message: `已将任务交给后台子 agent：${text.slice(0, 60)}`,
          });

          setTimeout(() => {
            const backgroundToolRecords: ToolExecutionRecord[] = [];
            const emitBackground = (event: string, payload: Record<string, any> = {}) => {
              if (
                event !== 'agent:background_task_update'
                && !isLatestUserTurn(executionScope, requestId)
              ) return;
              socket.emit(event, {
                ...payload,
                source: 'background_delegation',
                requestId: backgroundTaskId,
                taskId: backgroundTaskId,
                conversationId,
                agentId: conversationAgentId,
              });
            };
            const emitTaskUpdate = (task = getBackgroundTask(backgroundTaskId, uid)) => {
              if (!task) return;
              emitBackground("agent:background_task_update", {
                taskId: task.id,
                task,
              });
            };
            const persistBackgroundResult = (
              content: string,
              toolCalls?: ToolExecutionRecord[],
              guarded = false,
              deliverToConversation = true,
            ) => {
              try {
                if (conversationId && deliverToConversation) {
                  addMessage({
                    userId: uid,
                    agentId: conversationAgentId,
                    conversationId,
                    role: 'assistant',
                    content,
                    personality: personality.id,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                    toolCalls: toolCalls?.length ? toolCalls : undefined,
                    cognitiveIntent: guarded ? 'work_product_guard' : undefined,
                  });
                  socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'background_delegation' });
                }
                if (deliverToConversation) {
                  const db = readDB();
                  db.interactions.push({
                    id: `bg-${interactionId}`,
                    userId: uid,
                    agentId: agentId || '',
                    conversationId: conversationId || '',
                    content: `Background delegated task: ${storedUserContent}`,
                    response: content,
                    role: 'agent',
                    personality: personality.id,
                    timestamp: new Date().toISOString(),
                    mode: 'background_delegation',
                    cognitiveIntent: guarded ? 'work_product_guard' : cognition.intent.category,
                    llmWasCalled: true,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                  } as any);
                  writeDB(db);
                }
                if (!guarded && deliverToConversation) {
                  persistChatLearning(content, {
                    toolRecords: toolCalls || [],
                    sourceInteractionId: `bg-${interactionId}`,
                    logLabel: 'background delegation',
                  });
                }
              } catch (persistErr: any) {
                console.warn('[BackgroundDelegation] Persist failed:', persistErr?.message || persistErr);
              }
            };

            (async () => {
              try {
                const runningTask = markBackgroundTaskRunning(backgroundTaskId);
                if (runningTask) emitTaskUpdate(runningTask);
                emitBackground("agent:status", {
                  status: "thinking",
                  agentName: "Lumi Orchestrator",
                  phase: 'background',
                  detail: `后台子 agent 正在处理 ${backgroundTaskId}`,
                });
                const orchResult = await runOrchestratedTask(
                  executionTaskText,
                  {
                    userId: uid,
                    personalityId,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                    desktopRelay,
                    toolPolicy: routedToolPolicy,
                    availableAgentIds: backgroundTask.workers.map(worker => worker.id),
                    forceOrchestration: delegationDecision.reason === 'explicit_background_preference',
                    isCancelled: () => isBackgroundTaskCancellationRequested(backgroundTaskId),
                  },
                  { provider: activeProvider as any, model: activeModel },
                  llmGetters,
                  undefined,
                  (record, meta) => {
                    if (isTerminalOrchestrationToolEvent(record)) {
                      backgroundToolRecords.push({
                        id: record.id,
                        name: record.name,
                        arguments: record.arguments || {},
                        result: record.result || '',
                        error: record.error,
                      });
                    }
                    if (record.result !== undefined || record.error !== undefined) {
                      const updatedTask = incrementBackgroundTaskToolCalls(backgroundTaskId);
                      if (updatedTask) emitTaskUpdate(updatedTask);
                    }
                    // Direct desktop relays already emit their own start/result lifecycle.
                    if (isDirectDesktopTool(record.name)) return;
                    const payload: Record<string, any> = {
                      correlationId: record.id,
                      toolCallId: record.id,
                      name: record.name,
                      arguments: record.arguments,
                      args: record.arguments,
                      subTaskId: meta.subTaskId,
                      workerAgentId: meta.agentId,
                      workerAgentName: meta.agentName,
                    };
                    if (record.result !== undefined) payload.result = formatToolResultForUi(record.result);
                    if (record.error !== undefined) payload.error = record.error;
                    emitBackground("agent:tool_call", payload);
                    emitBackground("agent:tool", payload);
                  },
                );

                if (!orchResult) {
                  throw new Error('No worker agent accepted the delegated task.');
                }
                if (isBackgroundTaskCancellationRequested(backgroundTaskId)) {
                  throw new Error('Workflow cancelled');
                }

                const taskPreview = text.slice(0, 80);
                // i18n-allow: reviewed Chinese background-result fallback; this is finalized before delivery.
                const workerText = orchResult.responseText || '\u540e\u53f0\u5b50 agent \u6ca1\u6709\u8fd4\u56de\u8be6\u7ec6\u7ed3\u679c\u3002';
                const completionCandidate = `\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210\uff1a${taskPreview}\n\n${workerText}`;
                const finalizedBackground = finalizeLumiResponse({
                  taskText: executionTaskText,
                  responseText: completionCandidate,
                  toolRecords: backgroundToolRecords,
                  source: 'background_delegation',
                  flow: turnFlow,
                });
                const backgroundBlocked = finalizedBackground.blocked;
                const completionText = finalizedBackground.text;
                const terminalTask = backgroundBlocked
                  ? failBackgroundTask(
                      backgroundTaskId,
                      finalizedBackground.reason || 'Missing verified background-task completion evidence.',
                    )
                  : completeBackgroundTask(backgroundTaskId, completionText);
                if (terminalTask) emitTaskUpdate(terminalTask);
                if (terminalTask?.status === 'cancelled') {
                  const cancelText = `Background task cancelled: ${text.slice(0, 80)}`;
                  const deliver = isLatestUserTurn(executionScope, requestId);
                  persistBackgroundResult(cancelText, backgroundToolRecords, true, deliver);
                  if (deliver) {
                    emitBackground("agent:response", {
                      text: cancelText,
                      agentName: personality.name,
                      finalized: true,
                      blocked: true,
                      reason: 'cancelled',
                    });
                    emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  }
                  return;
                }
                const deliver = isLatestUserTurn(executionScope, requestId);
                if (deliver) {
                  persistChatTakeoverExecution(completionText, {
                    toolRecords: backgroundToolRecords,
                    source: 'background_delegation',
                    sourceInteractionId: `bg-${interactionId}`,
                    capabilitySelection,
                    finalizationBlocked: finalizedBackground.blocked,
                    assistantTextTrusted: !finalizedBackground.blocked,
                    finalizationReason: finalizedBackground.reason,
                  });
                }
                persistBackgroundResult(completionText, backgroundToolRecords, finalizedBackground.blocked, deliver);
                if (deliver) {
                  emitBackground("agent:response", {
                    text: completionText,
                    agentName: personality.name,
                    finalized: true,
                    blocked: finalizedBackground.blocked,
                    reason: finalizedBackground.reason || '',
                  });
                  emitBackground("agent:proactive", {
                    type: 'background_result',
                    message: completionText.slice(0, 1200),
                    agentName: personality.name,
                    timestamp: new Date().toISOString(),
                    finalized: true,
                    blocked: finalizedBackground.blocked,
                    reason: finalizedBackground.reason || '',
                  });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  pushNotification(uid, {
                    type: 'background_result',
                    title: backgroundBlocked ? '\u540e\u53f0\u4efb\u52a1\u672a\u5b8c\u6210' : '\u540e\u53f0\u4efb\u52a1\u5df2\u5b8c\u6210',
                    message: completionText.slice(0, 180),
                  });
                } else {
                  pushNotification(uid, {
                    type: backgroundBlocked ? 'background_error' : 'background_result',
                    title: backgroundBlocked
                      ? CN_BACKGROUND_DELEGATION_MESSAGES.failedTitle
                      : CN_BACKGROUND_DELEGATION_MESSAGES.completedTitle,
                    message: backgroundBlocked
                      ? CN_BACKGROUND_DELEGATION_MESSAGES.failedInTaskCenter
                      : CN_BACKGROUND_DELEGATION_MESSAGES.completedInTaskCenter,
                  });
                }

                if (deliver && !backgroundBlocked && shouldDistillSkill(executionTaskText) && orchResult.workflowResult.totalAgentsUsed >= 2) {
                  const skillDesc = buildSkillDescription(executionTaskText, orchResult.workflowResult);
                  emitBackground("agent:proactive", {
                    type: 'distill_hint',
                    message: '这类后台多 agent 工作可以沉淀成自动技能，需要我继续做技能化吗？',
                    skillDescription: skillDesc,
                    timestamp: new Date().toISOString(),
                  });
                }
              } catch (bgErr: any) {
                const bgMessage = bgErr?.message || String(bgErr);
                if (isBackgroundTaskCancellationRequested(backgroundTaskId) || /cancelled|canceled/i.test(bgMessage)) {
                  const cancelledTask = cancelBackgroundTask(backgroundTaskId);
                  if (cancelledTask) emitTaskUpdate(cancelledTask);
                  const cancelText = `Background task cancelled: ${text.slice(0, 80)}`;
                  const deliver = isLatestUserTurn(executionScope, requestId);
                  persistBackgroundResult(cancelText, backgroundToolRecords, true, deliver);
                  if (deliver) {
                    emitBackground("agent:response", {
                      text: cancelText,
                      agentName: personality.name,
                      finalized: true,
                      blocked: true,
                      reason: 'cancelled',
                    });
                    emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                    pushNotification(uid, {
                      type: 'background_cancelled',
                      title: 'Background task cancelled',
                      message: cancelText.slice(0, 180),
                    });
                  }
                  return;
                }
                const errorText = formatBackgroundDelegationFailure(bgErr, /[\u3400-\u9fff]/u.test(visibleUserText));
                const failedTask = failBackgroundTask(backgroundTaskId, errorText);
                if (failedTask) emitTaskUpdate(failedTask);
                const terminalBackgroundRecords: ToolExecutionRecord[] = backgroundToolRecords.length > 0
                  ? backgroundToolRecords
                  : [{
                      id: `background-terminal-${backgroundTaskId}`,
                      name: 'background_delegation',
                      arguments: { backgroundTaskId },
                      result: '',
                      error: bgMessage,
                    }];
                const deliver = isLatestUserTurn(executionScope, requestId);
                if (deliver) {
                  persistChatTakeoverExecution(errorText, {
                    toolRecords: terminalBackgroundRecords,
                    source: 'background_delegation',
                    sourceInteractionId: `bg-${interactionId}`,
                    capabilitySelection,
                    finalizationBlocked: true,
                    assistantTextTrusted: false,
                    finalizationReason: bgMessage,
                  });
                }
                persistBackgroundResult(errorText, backgroundToolRecords, true, deliver);
                if (deliver) {
                  emitBackground("agent:response", {
                    text: errorText,
                    agentName: personality.name,
                    finalized: true,
                    blocked: true,
                    reason: bgMessage,
                  });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  pushNotification(uid, {
                    type: 'background_error',
                    title: '后台子 agent 受阻',
                    message: errorText.slice(0, 180),
                  });
                } else {
                  pushNotification(uid, {
                    type: 'background_error',
                    title: CN_BACKGROUND_DELEGATION_MESSAGES.failedTitle,
                    message: CN_BACKGROUND_DELEGATION_MESSAGES.failedInTaskCenter,
                  });
                }
              }
            })().catch((err) => {
              console.error('[BackgroundDelegation] Unhandled error:', err);
            });
          }, 30);
        }
      }

      const shouldOrchestrateForeground = shouldAttemptOrchestration({
        channel: 'chat',
        text: turnFlow.routeText,
        complexity: backgroundComplexity,
        allowToolUse: executionDecision.allowToolUse,
        clientActionOnly: clientActionOnlyTurn,
        selfRepair: selfRepairTurn,
        responseReady: Boolean(responseText),
        hasPreflightContext: Boolean(actionPreflightContext),
        prefersSequentialWorkflow,
        capabilityLane: capabilitySelection.lane,
        cognitionCategory: cognition.intent.category,
      });
      if (shouldOrchestrateForeground) {
        // Path B: Orchestrator — decompose tasks into sub-tasks for worker agents
        // (Skipped for sanctuary agents — they stay in their territory)
        try {
          emitAgent("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Lumi Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
          const orchResult = await runOrchestratedTask(
            executionTaskText,
            {
              userId: uid,
              personalityId,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              toolPolicy: routedToolPolicy,
            },
            { provider: activeProvider, model: activeModel },
            llmGetters,
            exposeAgentWork && !deferCompletionStream
              ? (msg) => emitAgent("agent:chunk", { text: msg, agentName: "Lumi" })
              : undefined,
            (record, meta) => {
              if (isTerminalOrchestrationToolEvent(record)) {
                allToolRecords.push({
                  id: record.id,
                  name: record.name,
                  arguments: record.arguments || {},
                  result: record.result || '',
                  error: record.error,
                });
              }
              // Direct desktop relays already emit their own start/result lifecycle.
              if (isDirectDesktopTool(record.name)) return;
              const payload: Record<string, any> = {
                correlationId: record.id,
                toolCallId: record.id,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                subTaskId: meta.subTaskId,
                workerAgentId: meta.agentId,
                workerAgentName: meta.agentName,
              };
              if (record.result !== undefined) payload.result = formatToolResultForUi(record.result);
              if (record.error !== undefined) payload.error = record.error;
              emitAgent("agent:tool_call", payload);
              emitAgent("agent:tool", payload);
            },
          );
          if (orchResult) {
            responseText = orchResult.responseText;
            llmWasCalled = orchResult.llmWasCalled;

            // Check if this pattern should be auto-distilled into a skill
            if (shouldDistillSkill(executionTaskText) && orchResult.workflowResult.totalAgentsUsed >= 2) {
              const skillDesc = buildSkillDescription(executionTaskText, orchResult.workflowResult);
              console.log('[Orchestrator] Pattern detected — candidate for skill distillation:', skillDesc.slice(0, 100));
              emitAgent("agent:proactive", {
                type: 'distill_hint',
                message: 'I notice this type of task is recurring. I can create an automated skill for this — would you like me to?',
                skillDescription: skillDesc,
                timestamp: new Date().toISOString(),
              });
              pushNotification(uid, { type: 'distill_hint', title: 'Skill Distillation', message: 'I notice this type of task is recurring. I can create an automated skill for this.' });
            }
          }
        } catch (orchErr: any) {
          console.error('[Orchestrator] Workflow failed, falling back to normal chat:', orchErr.message);
        }
      }

      // Path B2: NL Task Chainer — for office workflows that chain tools (search→read→create etc.)
      if (!responseText && !actionPreflightContext && executionDecision.allowToolUse && !clientActionOnlyTurn && !selfRepairTurn && shouldChainTask(executionTaskText)) {
        // Pre-flight: auto-install any matching uninstalled/outdated skills
        await autoInstallForTask(
          executionTaskText,
          { emit: (event, data) => socket.emit(event, data) },
          {
            ownerUid: uid,
            userId: uid,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          },
        );

        try {
          emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background' });
          const chainerResult = await runNLChainer(
            executionTaskText,
            {
              userId: uid,
              provider: activeProvider,
              model: activeModel,
              desktopRelay,
              context: {
                userId: uid,
                domain: resolvedDomain,
                orgId: resolvedOrgId,
                desktopRelay,
                llmGetters,
                source: 'chat_chainer',
                supervisedExternalCommits: true,
                allowLocalFileWrites,
                localWriteIntentReason,
                isCancelled: () => abortController.signal.aborted,
                requestConfirmation: requestToolConfirmation,
                actionIntent: visibleUserText,
                toolPolicy: routedToolPolicy || personality.toolPolicy,
                onProgress: (step: string) => {
                  if (shouldForwardPreFinalizationProgress(step)) {
                    emitAgent("agent:progress", { text: step, tone: 'tool', agentName: personality.name });
                  }
                },
              },
              onTool: (record) => {
                allToolRecords.push(record);
                const payload: Record<string, any> = {
                  correlationId: record.id,
                  toolCallId: record.id,
                  name: record.name,
                  arguments: record.arguments,
                  args: record.arguments,
                };
                if (record.result !== '') payload.result = formatToolResultForUi(record.result);
                if (record.error !== undefined) payload.error = record.error;
                emitAgent("agent:tool_call", payload);
                emitAgent("agent:tool", payload);
              },
            },
            llmGetters,
            (step, total, desc) => {
              const progressText = `Step ${step}/${total}: ${desc}`;
              if (shouldForwardPreFinalizationProgress(progressText)) {
                emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background', detail: progressText });
                emitAgent("agent:progress", {
                  text: progressText,
                  tone: 'tool',
                  agentName: personality.name,
                });
              }
            },
          );
          if (chainerResult.finalResponse) {
            responseText = chainerResult.finalResponse;
            llmWasCalled = true;
            console.log('[NLChainer] Completed with', chainerResult.stepResults.length, 'steps. Goal:', chainerResult.plan.goal);
          }
        } catch (chainErr: any) {
          console.error('[NLChainer] Failed, falling back to normal chat:', chainErr.message);
        }
      }

      if (!responseText) {
        // Path C: Normal LLM path (simple queries, or orchestrator fallback)

        // Load conversation history from persistence (survives page reload / reconnect)
        let persistedHistory: NormalizedMessage[] = [];
        if (conversationId) {
          const msgs = getMessagesByTokenBudget(conversationId);
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
              { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal },
              onChunk,
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );

            responseText = response.text || streamChunks.join('') || '';
            llmWasCalled = true;
            if (response.usage) {
              recordTokenUsage(uid, activeProvider, activeModel, {
                promptTokens: response.usage.promptTokens,
                completionTokens: response.usage.completionTokens,
                totalTokens: response.usage.totalTokens,
              }, interactionId);
            }
            const totalUsage = response.usage?.totalTokens || 0;
            socket.emit('token:usage_update', {
              userId: uid,
              provider: activeProvider,
              totalTokens: totalUsage,
              mode: 'chat',
              timestamp: new Date().toISOString(),
            });
          } else {
            const maxIterations = routedToolPolicy?.maxIterations || personality.toolPolicy.maxIterations || 25;

          // Collect tool calls for persistence

          const result = await runWithTools(
            messages,
            toolRegistry,
            { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId },
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
              userId: uid,
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
              ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
              actionIntent: visibleUserText,
              routedTaskText: turnFlow.routeText,
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
          // Do not silently switch to another paid provider. The selected model should run or fail visibly.
          if (false && llmErr.message?.includes('not configured') && activeProvider !== 'gemini') {
            try {
              const fallbackMessage = `主推理服务 ${activeProvider}/${activeModel} 不可用，Lumi 将临时降级到 Gemini。`;
              socket.emit('agent:notification', { type: 'llm_fallback', level: 'warning', message: fallbackMessage });
              pushNotification(uid, { type: 'llm_fallback', title: 'LLM 降级提醒', message: fallbackMessage });
              if (!executionDecision.allowToolUse) {
                const fallbackChunks: string[] = [];
                const fallback = await makeLLMCallStreaming(
                  messages,
                  [],
                  { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal },
                  (chunk) => {
                    fallbackChunks.push(chunk);
                    if (!deferCompletionStream) {
                      const safeText = chatTextGate.push(chunk);
                      if (safeText) {
                        emitAgent("agent:chunk", { text: safeText, agentName: personality.name });
                      }
                    }
                  },
                  llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
                  llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
                );
                responseText = fallback.text || fallbackChunks.join('') || '';
                llmWasCalled = true;
                if (fallback.usage) {
                  recordTokenUsage(uid, 'gemini', DEFAULT_MODELS.gemini, {
                    promptTokens: fallback.usage.promptTokens,
                    completionTokens: fallback.usage.completionTokens,
                    totalTokens: fallback.usage.totalTokens,
                  }, interactionId);
                }
              } else {
              const fallback = await runWithTools(
                messages, toolRegistry,
                { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId },
                (record) => {
                  allToolRecords.push(record);
                  if (isDirectDesktopTool(record.name)) return;
                  emitToolLifecycle({
                    correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    name: record.name,
                    arguments: record.arguments,
                    result: formatToolResultForUi(record.result),
                    error: record.error,
                  });
                },
                1,
                llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
                undefined,
                {
                  userId: uid,
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
                  ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
                  actionIntent: visibleUserText,
                  routedTaskText: turnFlow.routeText,
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
              responseText = fallback.text || '';
              llmWasCalled = true;
              for (const u of fallback.usageRecords) {
                recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
              }
              }
            } catch (fallbackErr: any) {
              // Both primary and fallback LLMs failed — use cognitive fallback
              const cf = handleLLMFailure(cognition.intent, fallbackErr);
              responseText = cf.responseText;
            }
          } else {
            // LLM failed for other reasons — use cognitive fallback
            const cf = handleLLMFailure(cognition.intent, llmErr);
            responseText = cf.responseText;
          }
        }
      }

      chatTextGate.finish();
      const finalResponse = finalizeLumiResponse({
        taskText: executionTaskText,
        responseText,
        toolRecords: allToolRecords,
        source: 'chat',
        flow: turnFlow,
      });
      responseText = finalResponse.text;
      if (finalResponse.blocked) {
        console.warn('[ChatHandler] Completion claim blocked:', finalResponse.reason);
        if (finalResponse.notification) emitAgent("agent:notification", finalResponse.notification);
      }

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
        addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
        // Persist tool calls interleaved before the assistant response
        for (const tc of allToolRecords) {
          if (!tc.error && !String(tc.result || '').trim()) continue;
          const tcSummary = summarizeToolRecordForPersistence(tc);
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        addMessage({
          userId: uid,
          agentId: conversationAgentId,
          conversationId,
          role: 'assistant',
          content: responseText,
          personality: personality.id,
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          toolCalls: allToolRecords.length ? allToolRecords : undefined,
          cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : cognition.intent.category,
          llmWasCalled,
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

      // Emit response BEFORE conversation_updated so the client finalizes streaming first
      emitAgent("agent:response", {
        text: responseText,
        agentName: personality.name,
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
      });
      // Re-emit conversation_updated AFTER response so the client syncs from API with complete data
      if (conversationId) {
        socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
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
      if (resolvedDomain === 'personal' && isCorrection && responseText && !finalResponse.blocked) {
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
              { provider: 'deepseek', model: 'deepseek-v4-flash', userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, maxTokens: 300 },
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
      if (resolvedDomain === 'personal' && !isSanctuary && responseText && !finalResponse.blocked && cognition.intent.category !== 'command' && !personalityRegistry.isEvolutionFrozen(personalityId, uid)) {
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
      if (text.length >= 10 && !finalResponse.blocked && !skipExtractionCategories.includes(cognition.intent.category)) {
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

