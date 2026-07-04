/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from "../llm/providers";
import { LLMUsage, ToolExecutionRecord } from "../tools/types";
import { toolRegistry } from "../tools/registry";
import { runWithTools } from "../llm/adapter";
import { getOperationModeConfig, parseStoredOperationMode } from "../cognition/operation_modes";
import { formatToolRouteForPrompt, mergeToolPolicyWithRoute, routeToolsForTurn } from "../cognition/tool_router";
import { buildInteractionModeOverlay, buildLumiTurnFlow, resolveTurnSurface } from "../cognition/turn_flow";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiLearningTurn } from "../cognition/learning_interface";
import { formatClientSelfPrompt } from "../client/self_model";
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, generateContextualGreeting, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { lightweightEvolve } from "../personality/evolution";
import { getOrCreateActiveConversation, addMessage, getMessages, getMessagesByTokenBudget, checkAutoSummary, setConversationSummary, getConversationSummary, setConversationMode, getUnclosedConversation, extractTopics, trackTopic, getTopicContext } from "../conversation/manager";
import { ensureBranch } from "../memory/tree";
import { retrieveChunks } from "../agents/rag";
import { getSensory } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
import { matchQuickCommand } from "../cognition/quick_commands";
import { checkLLMAccess, recordUsage, estimateTokens } from "../subscription/proxy";
import { recordTokenUsage } from "../llm/token_tracker";
import { runOrchestratedTask, shouldDistillSkill, buildSkillDescription, classifyComplexity } from "../agents/orchestrator";
import { buildDelegationAck, shouldDelegateWorkInBackground } from "../agents/background_delegation";
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
import { runNLChainer, shouldChainTask } from "../agents/nl_chainer";
import { autoInstallForTask } from "../agents/auto_installer";
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { searchKnowledgeBase } from "../org/kb";
import { getMember } from "../org/db";
import { getWorkflow, recordWorkflowRun, listWorkflows } from "../agents/workflows";
import { buildProfessionOverlay } from "../autonomy/professions";
import { analyzeLikedMusicProfile, formatMusicProfileReport, isMusicProfileAnalysisRequest } from "../music/library_profile";
import { buildResponseLanguageInstruction } from "../utils/language";
import { guardCompletionClaims } from "../work_product/completion_guard";
import { buildModelSelfAwareness, buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { DEFAULT_MODELS, getScopedPreferredLLM } from "../llm/user_preferences";
import { estimateSkillWorkflowChatSpeechMs } from "../skills/workflow_registry";

const JWT_SECRET = process.env.JWT_SECRET || 'lumiOS_default_jwt_secret_2026_local';

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
  const message = typeof m?.message === 'string' ? m.message.trim() : '';
  const content = typeof m?.content === 'string' ? m.content.trim() : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const primaryText = message || content;
  const isUiErrorText = /^(Request failed|请求失败|出错了|Failed to route)/i.test(primaryText);

  if (primaryText && !isUiErrorText) {
    entries.push({ role, content: primaryText });
  }
  if (response && role === 'user') {
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
      mimeType,
      size: typeof item?.size === 'number' ? item.size : undefined,
      kind,
    };
  }).filter(item => item.fileName || item.path || item.content);
}

function buildChatAttachmentContext(attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines: string[] = [
    '## Current Turn Attachments',
    'The user attached these files to the current message. Treat them as part of the user request.',
  ];
  attachments.forEach((item, index) => {
    const content = item.content || item.preview || '';
    lines.push(`### ${index + 1}. ${item.fileName}`);
    lines.push(`Type: ${item.kind}${item.mimeType ? ` (${item.mimeType})` : ''}`);
    if (item.path) lines.push(`Local path: ${item.path}`);
    if (item.kind === 'image') {
      lines.push('For visual details, use the ocr_image_file tool with the local path before answering.');
    }
    if (item.kind === 'audio') {
      lines.push('This is an audio recording. If the user asks for transcription, speech-to-text, a written transcript, or a text file, use transcribe_audio_to_text_file with the local path.');
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
) {
  const chatSessionMap = new Map<string, AbortController>();

  // Handle abort requests
  socket.on("agent:abort_chat", () => {
    const uid = userIdFn(socket);
    let aborted = false;
    for (const [key, controller] of chatSessionMap.entries()) {
      if (!key.startsWith(`${uid}:`)) continue;
      controller.abort();
      chatSessionMap.delete(key);
      aborted = true;
    }
    if (aborted) {
      socket.emit("agent:status", { status: "idle", source: "chat" });
      socket.emit("agent:response", { text: "[Cancelled]", agentName: "Lumi", source: "chat" });
    }
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

  socket.on("agent:chat", async (data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; source?: string; requestId?: string }) => {
    console.log('[ChatHandler] agent:chat RECEIVED:', JSON.stringify(data).slice(0, 300));
    const { history, personalityId = "lumi", category, agentId, mode: payloadMode, source } = data;
    const attachments = normalizeIncomingAttachments(data.attachments);
    const rawUserText = typeof data.text === 'string' ? data.text.trim() : '';
    const visibleUserText = rawUserText || (attachments.length > 0 ? 'Please review the attached file(s).' : '');
    const attachmentContext = buildChatAttachmentContext(attachments);
    const text = [visibleUserText, attachmentContext].filter(Boolean).join('\n\n');
    const storedUserContent = buildStoredAttachmentSummary(visibleUserText, attachments);
    const requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 120) : undefined;
    const eventSource = source || 'chat';
    const turnSurface = resolveTurnSurface({
      channel: 'chat',
      source: eventSource,
      category,
      domain: typeof data.domain === 'string' ? data.domain : undefined,
    });
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      socket.emit(event, {
        ...payload,
        source: payload.source || eventSource,
        ...(requestId ? { requestId } : {}),
      });
    };
    const conversationAgentId = agentId || 'lumi';
    const uid = userIdFn(socket);
    const sessionKey = `${uid}:${eventSource}`;
    console.log('[ChatHandler] uid:', uid, 'agentId:', agentId, 'source:', source);

    // Work context comes from the authenticated socket token. Personal mode can be
    // explicitly requested by the desktop UI to avoid a stale org token leaking into
    // local personal conversations.
    let resolvedDomain = 'personal';
    let resolvedOrgId = '';
    try {
      const authToken = socket.handshake?.auth?.token;
      let decoded: any = null;
      if (authToken) {
        decoded = jwt.verify(authToken, JWT_SECRET);
        if (data.domain === 'personal') {
          resolvedDomain = 'personal';
          resolvedOrgId = '';
        } else if (decoded.orgId) {
          resolvedDomain = 'work';
          resolvedOrgId = decoded.orgId;
        }
      }
      if (resolvedDomain !== 'work' && data.domain === 'work') {
        const requestedOrgId = typeof data.orgId === 'string' ? data.orgId.trim() : '';
        if (requestedOrgId) {
          const membership = getMember(requestedOrgId, uid);
          if (membership && membership.status !== 'left' && membership.status !== 'suspended') {
            resolvedDomain = 'work';
            resolvedOrgId = requestedOrgId;
          }
        }
      }
    } catch {}
    console.log('[ChatHandler] domain:', resolvedDomain, 'orgId:', resolvedOrgId);

    // Abort any previous chat session for this user
    const prevController = chatSessionMap.get(sessionKey);
    if (prevController) prevController.abort();
    const abortController = new AbortController();
    chatSessionMap.set(sessionKey, abortController);

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
      const personalityConfig = personalityRegistry.get(personalityId);
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
        const chunks = retrieveChunks(uid, ragAgentId, text, 3, {
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
          const kbResults = await searchKnowledgeBase(resolvedOrgId, text, 3);
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

      const emotionKey = agentMemoryFilter ? `${uid}_agent_${agentId}` : uid;
      const emotionalState = loadEmotionalState(emotionKey);
      const himState = loadHIMState(emotionKey);
      console.log('[ChatHandler] emotionalState loaded');
      const isNovel = relevantMemories.length < 2;

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversation = getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId);
      const conversationId = conversation?.id;
      // Cross-session continuity: inject previous conversation context if starting fresh
      let previousSessionContext: string | null = null;
      if (!conversationId) {
        const prevConv = getUnclosedConversation(uid);
        if (prevConv && prevConv.id !== conversationId) {
          const prevSummary = getConversationSummary(prevConv.id);
          if (prevSummary) {
            previousSessionContext = `## Previous Session (${prevConv.lastActiveAt?.slice(0, 10) || 'recent'})\nYou and the user were discussing: ${prevSummary}\n\nContinue naturally. The user may want to pick up where you left off.`;
          }
        }
      }
      const conversationMode = payloadMode || conversation?.mode || undefined;
      if (conversation && payloadMode && payloadMode !== conversation.mode) {
        setConversationMode(conversation.id, payloadMode);
      }
      console.log('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      const operationMode = (() => {
        try {
          const db = readDB();
          const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${uid}`);
          if (setting) return parseStoredOperationMode(setting.value);
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
      // Cross-session: inject previous conversation context when starting fresh
      if (previousSessionContext) {
        effectiveSystemPrompt += `\n\n${previousSessionContext}`;
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

      const turnFlow = buildLumiTurnFlow({
        userId: uid,
        text: visibleUserText || text,
        channel: 'chat',
        source: eventSource,
        category,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        surface: turnSurface,
        operationMode,
        targetIsLumi:
          personality.id === 'lumi' ||
          conversationAgentId === 'lumi' ||
          /lumi/i.test(visibleUserText || text),
      });
      effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
      effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
        userId: uid,
        text: visibleUserText || text,
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
        const professionOverlay = buildProfessionOverlay();
        if (professionOverlay) {
          effectiveSystemPrompt += professionOverlay;
        }
      } catch {}

      // Inject contact context when user mentions people they know
      try {
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

      const isDirectDesktopTool = (toolName: string) => toolName.startsWith('desktop_');
      const persistChatLearning = (
        assistantText: string,
        options: {
          channel?: 'chat' | 'workflow';
          toolRecords?: ToolExecutionRecord[];
          sourceInteractionId?: string;
          logLabel?: string;
        } = {},
      ) => {
        try {
          const learning = persistLumiLearningTurn({
            userId: uid,
            userText: text,
            assistantText,
            channel: options.channel || 'chat',
            flow: turnFlow,
            toolNames: toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
            toolRecords: options.toolRecords || [],
            domain: resolvedDomain,
            orgId: resolvedOrgId,
            sourceInteractionId: options.sourceInteractionId || interactionId,
            agentId: agentId || '',
          });
          if (learning.shouldPersist) {
            console.log(`[LumiLearningInterface] ${options.logLabel || options.channel || 'chat'} persisted memories=${learning.storedMemories} capability=${learning.capabilityRecord?.id || 'none'} reasons=${learning.reasons.join(',')}`);
          }
        } catch (learnErr: any) {
          console.warn(`[LumiLearningInterface] ${options.logLabel || options.channel || 'chat'} persistence failed:`, learnErr?.message || learnErr);
        }
      };

      // ── Desktop relay: enables 15 tools (mouse/keyboard/clipboard/screenshot/etc) in chat ──
      const desktopRelay = ((toolName: string, args: Record<string, any>): Promise<string> => {
        return new Promise((resolve, reject) => {
          const cid = crypto.randomUUID();
          const uiCid = `desktop-${cid}`;
          const eventName = `tool:desktop_result:${cid}`;
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;

          emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args });

          const finishWithError = (message: string) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            socket.off(eventName, onResult);
            emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, error: message });
            reject(new Error(message));
          };

          const onResult = (data: { output?: string; error?: string }) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (data.error) {
              emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, error: data.error });
              reject(new Error(data.error));
              return;
            }
            const output = data.output || '';
            emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, result: formatToolResultForUi(output) });
            resolve(output);
          };

          timeout = setTimeout(() => finishWithError(`Desktop tool "${toolName}" timed out (30s)`), 30000);
          socket.once(eventName, onResult);
          socket.emit('tool:desktop_exec', { correlationId: cid, name: toolName, arguments: args });
        });
      });

      const specialWorkflowText = visibleUserText || text;
      const specialWorkflow = turnFlow.specialWorkflow;
      if (specialWorkflow) {
        emitAgent("agent:status", {
          status: "thinking",
          agentName: personality.name,
          phase: specialWorkflow.phase,
          detail: specialWorkflow.statusDetail,
        });

        let workflowResponseText = '';
        let workflowToolCalls: ToolExecutionRecord[] = [];
        try {
          const workflowResult = await specialWorkflow.run({
            socket,
            userText: specialWorkflowText,
            userId: uid,
            desktopRelay,
            speak: async (line) => {
              emitAgent("agent:chunk", {
                text: `${line}\n`,
                agentName: personality.name,
                source: specialWorkflow.source,
              });
              return estimateSkillWorkflowChatSpeechMs(specialWorkflow, line);
            },
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

        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          for (const tc of workflowToolCalls) {
            const tcSummary = tc.error
              ? `[Tool: ${tc.name}] Error: ${tc.error}`
              : `[Tool: ${tc.name}] Done`;
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
          }
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: workflowResponseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: workflowToolCalls.length ? workflowToolCalls : undefined });
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
            cognitiveIntent: specialWorkflow.id,
            llmWasCalled: false,
            domain: resolvedDomain,
            orgId: resolvedOrgId,
          });
          writeDB(db);
        } catch (persistErr: any) {
          console.warn(`[ChatHandler] ${specialWorkflow.logLabel} interaction persistence failed:`, persistErr?.message || persistErr);
        }

        emitAgent("agent:response", { text: workflowResponseText, agentName: personality.name, source: specialWorkflow.source });
        if (conversationId) {
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: specialWorkflow.source });
        }
        persistChatLearning(workflowResponseText, {
          channel: 'workflow',
          toolRecords: workflowToolCalls,
          sourceInteractionId: `${interactionId}_workflow`,
          logLabel: specialWorkflow.source,
        });
        emitAgent("agent:status", { status: "idle", agentName: personality.name });
        chatSessionMap.delete(sessionKey);
        return;
      }

      emitAgent("agent:status", { status: "thinking", agentName: personality.name });
      console.log('[ChatHandler] emitted agent:status thinking');

      // Inject operation mode prompt overlay
      const effectiveOperationMode = turnFlow.effectiveOperationMode;
      const allowToolUseForTurn = turnFlow.allowToolUseForTurn;
      const selfRepairTurn = turnFlow.selfRepairTurn;
      const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
      const workSurfaceRoute = turnFlow.workSurfaceRoute;
      const visionIntent = turnFlow.visionIntent;
      const opModeConfig = getOperationModeConfig(effectiveOperationMode);
      const clientActionToolPolicy = clientActionOnlyTurn
        ? { allowedTools: ['client_get_state', 'client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 }
        : null;
      const selfRepairToolPolicy = selfRepairTurn
        ? {
            allowedTools: ['*'],
            requireConfirmation: [
              'desktop_run_command',
              'run_command',
              'write_file',
              'file_delete',
              'delete_file',
              'rm',
              'unlink',
              'format',
              'rmdir',
              'uninstall',
              'computer_use',
            ],
            forbiddenTools: [],
            maxIterations: 8,
          }
        : null;
      const baseRoutedToolPolicy = isSanctuary
        ? { allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 }
        : selfRepairToolPolicy
            ? selfRepairToolPolicy
          : clientActionToolPolicy
            ? clientActionToolPolicy
            : (workSurfaceRoute.toolPolicy || opModeConfig?.toolPolicy || personality.toolPolicy);
      const toolRoute = allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && !isSanctuary
        ? routeToolsForTurn(turnFlow.routeText || text, toolRegistry.getToolDeclarations())
        : null;
      const routedToolPolicy = toolRoute && baseRoutedToolPolicy
        ? mergeToolPolicyWithRoute(baseRoutedToolPolicy, toolRoute)
        : baseRoutedToolPolicy;
      const exposeAgentWork = turnFlow.exposeAgentWork;
      effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid);
      console.log('[ChatHandler] tool gate:', allowToolUseForTurn ? 'enabled' : 'chat-only', 'operationMode:', operationMode, 'effective:', effectiveOperationMode, 'surface:', turnFlow.surface, 'clientActionOnly:', clientActionOnlyTurn, 'selfRepair:', selfRepairTurn, 'route:', toolRoute ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable} ${toolRoute.categories.join(',') || 'fallback'}` : 'none');
      if (toolRoute) {
        socket.emit('agent:tool_route', {
          categories: toolRoute.categories,
          reasons: toolRoute.reasons,
          toolNames: toolRoute.toolNames,
          totalAvailable: toolRoute.totalAvailable,
          truncated: toolRoute.truncated,
        });
      }
      effectiveSystemPrompt += '\n\n' + buildInteractionModeOverlay(turnFlow);
      if (workSurfaceRoute.promptOverlay) {
        effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
      }
      if (toolRoute) {
        effectiveSystemPrompt += '\n\n' + formatToolRouteForPrompt(toolRoute);
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
      let activeModel = (userLLMPrefs.models || {})[activeProvider] || DEFAULT_MODELS[activeProvider] || 'deepseek-chat';

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        activeProvider = 'auto';
        activeModel = 'qwen2.5:7b';
        console.log('[Chat] Hybrid mode enabled — local Ollama → cloud DeepSeek');
      }

      // ── Subscription enforcement: never switch the user's selected brain silently ──
      const access = checkLLMAccess({ userId: uid, provider: activeProvider, model: activeModel });
      if (!access.allowed) {
        emitAgent("agent:error", {
          message: access.reason,
          code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED',
        });
        emitAgent("agent:status", { status: "error" });
        return;
      }

      // ── Named Workflow Quick-Path: "run my X" / "跑XX流程" ──
      const runWorkflowMatch = text.match(/(?:run|执行|跑|运行)\s+(?:my\s+)?(.+?)(?:\s*(?:routine|workflow|流程|工作流))?\s*$/i);
      let workflowQuickResult: string | null = null;
      if (runWorkflowMatch) {
        const wfName = runWorkflowMatch[1].trim().toLowerCase();
        const allWfs = listWorkflows(uid);
        const matched = allWfs.find(w => w.name.toLowerCase().includes(wfName));
        if (matched) {
          console.log('[ChatHandler] Workflow quick-path matched:', matched.name);
          const steps: string[] = [];
          for (let i = 0; i < matched.steps.length; i++) {
            const step = matched.steps[i];
            if (step.tool) {
              try {
                const result = await toolRegistry.execute(step.tool, step.args || {}, { userId: uid });
                steps.push(`Step ${i + 1} (${step.tool}): ${(result || 'OK').slice(0, 200)}`);
              } catch (e: any) {
                steps.push(`Step ${i + 1} (${step.tool}): Error - ${e.message}`);
                break;
              }
            } else {
              steps.push(`Step ${i + 1}: ${step.description} (no tool bound — use this as a guide)`);
            }
          }
          recordWorkflowRun(uid, matched.name);
          workflowQuickResult = `Ran workflow "${matched.name}" (${matched.steps.length} steps):\n${steps.join('\n')}`;
        }
      }

      if (workflowQuickResult) {
        emitAgent("agent:status", { status: "responding" });
        emitAgent("agent:response", { text: workflowQuickResult, agentName: personality.name });
        persistChatLearning(workflowQuickResult, {
          channel: 'workflow',
          sourceInteractionId: `${interactionId}_workflow_quick`,
          logLabel: 'workflow quick path',
        });
        emitAgent("agent:status", { status: "idle" });
        return;
      }

      // ── Quick Command Fast-Path: deterministic commands skip LLM entirely ──
      try {
        const quickResult = await matchQuickCommand(text, uid, {
          domain: resolvedDomain,
          orgId: resolvedOrgId,
          surface: turnSurface,
        });
        if (quickResult?.matched) {
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
              const tcResult = await toolRegistry.execute(quickResult.toolCall.name, quickResult.toolCall.arguments, { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, desktopRelay, llmGetters });
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
            }
            quickToolRecords.push({
              id: toolCid,
              name: quickResult.toolCall.name,
              arguments: quickResult.toolCall.arguments,
              result: quickToolResult,
              error: quickToolError,
            });
          }
          emitAgent("agent:response", { text: quickResponseText, agentName: personality.name });
          if (conversationId) {
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            if (quickResult.toolCall) {
              addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: `[Tool: ${quickResult.toolCall.name}] Called`, domain: resolvedDomain, orgId: resolvedOrgId });
            }
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: quickResponseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
          }
          persistChatLearning(quickResponseText, {
            toolRecords: quickToolRecords,
            sourceInteractionId: `${interactionId}_quick`,
            logLabel: 'chat quick command',
          });
          emitAgent("agent:status", { status: "idle" });
          // Track topics for quick commands too
          if (conversationId) {
            try {
              const topics = extractTopics(text);
              for (const topic of topics) trackTopic(conversationId, topic);
            } catch {}
          }
          chatSessionMap.delete(sessionKey);
          return;
        }
      } catch (qcErr: any) {
        console.warn('[ChatHandler] Quick command check failed, falling through:', qcErr.message);
      }

      if (isMusicProfileAnalysisRequest(text)) {
        emitAgent("agent:status", { status: "thinking", agentName: personality.name, detail: "Analyzing music profile" });
        let profileResponse = '';
        try {
          const profile = await analyzeLikedMusicProfile(uid, { maxSongs: 3000 });
          profileResponse = formatMusicProfileReport(profile);
        } catch (profileErr: any) {
          profileResponse = `我现在还没能完成网易云喜欢歌单分析。\n\n${profileErr?.message || '请确认网易云已经登录，再试一次。'}`;
          socket.emit('music:error', { message: profileResponse });
        }

        emitAgent("agent:response", { text: profileResponse, agentName: personality.name });
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: profileResponse, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
        }
        persistChatLearning(profileResponse, {
          sourceInteractionId: `${interactionId}_music_profile`,
          logLabel: 'music profile',
        });
        emitAgent("agent:status", { status: "idle" });
        chatSessionMap.delete(sessionKey);
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

      const cognition = await processInput(text, cognitiveCtx, llmClassifier);
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
        activeModel = isComplex ? 'deepseek-v4-pro' : 'deepseek-chat';
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
      const deferCompletionStream = turnFlow.completionEvidenceNeeded;
      const prefersSequentialWorkflow =
        shouldChainTask(text) &&
        workSurfaceRoute.artifactFirst &&
        !workSurfaceRoute.directDesktop;
      const availableWorkerAgents = (() => {
        try {
          return (readDB().agents || []).filter((agent: any) => (
            agent
            && agent.id
            && agent.id !== conversationAgentId
            && agent.status !== 'offline'
            && agent.status !== 'terminated'
          ));
        } catch {
          return [];
        }
      })();
      const backgroundComplexity = classifyComplexity(text, {
        userId: uid,
        personalityId,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        desktopRelay,
      });

      if (cognition.directToolExecuted && cognition.responseText) {
        // Path A: Lumi handled this directly — no LLM needed
        responseText = cognition.responseText;
        console.log(`[Cognition] Direct tool '${cognition.intent.directToolCall?.name}' handled without LLM`);
      }

      // Path A2: music intent. Handle before the generic tool loop so Lumi
      // does not wander into unrelated tools or report raw provider errors.
      const isMusicAdjustment = isMusicAdjustmentRequest(text);
      if (!responseText && (isMusicPlaybackRequest(text) || isMusicAdjustment)) {
        try {
          const result = isMusicAdjustment
            ? await adjustMusicPlayback(uid, socket, text)
            : await searchAndPlay(uid, socket, text);
          if (result.success && result.text) {
            responseText = result.text;
            llmWasCalled = true;
          } else {
            responseText = getMusicFailureMessage(result.reason);
            socket.emit('music:error', { message: responseText });
          }
        } catch (musicErr: any) {
          console.warn('[Music Intent] Failed:', musicErr.message);
          responseText = getMusicFailureMessage(musicErr?.message);
          socket.emit('music:error', { message: responseText });
        }
      }

      if (!responseText) {
        const delegationDecision = shouldDelegateWorkInBackground({
          text,
          source: eventSource,
          category: cognition.intent.category,
          complexity: backgroundComplexity,
          allowToolUse: allowToolUseForTurn,
          clientActionOnly: clientActionOnlyTurn,
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
            prompt: text,
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
            const persistBackgroundResult = (content: string, toolCalls?: ToolExecutionRecord[]) => {
              try {
                if (conversationId) {
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
                  });
                  socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'background_delegation' });
                }
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
                  cognitiveIntent: cognition.intent.category,
                  llmWasCalled: true,
                  domain: resolvedDomain,
                  orgId: resolvedOrgId,
                } as any);
                writeDB(db);
                persistChatLearning(content, {
                  toolRecords: toolCalls || [],
                  sourceInteractionId: `bg-${interactionId}`,
                  logLabel: 'background delegation',
                });
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
                  text,
                  {
                    userId: uid,
                    personalityId,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                    desktopRelay,
                    isCancelled: () => isBackgroundTaskCancellationRequested(backgroundTaskId),
                  },
                  { provider: activeProvider as any, model: activeModel },
                  llmGetters,
                  (message) => emitBackground("agent:chunk", { text: message, agentName: "Lumi Orchestrator" }),
                  (record, meta) => {
                    backgroundToolRecords.push({
                      id: record.id,
                      name: record.name,
                      arguments: record.arguments || {},
                      result: record.result || '',
                      error: record.error,
                    });
                    if (record.result !== undefined || record.error !== undefined) {
                      const updatedTask = incrementBackgroundTaskToolCalls(backgroundTaskId);
                      if (updatedTask) emitTaskUpdate(updatedTask);
                    }
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

                let finalText = orchResult.responseText || '后台子 agent 已完成任务，但没有返回详细文本。';
                const guarded = guardCompletionClaims({
                  task: text,
                  response: finalText,
                  toolCalls: backgroundToolRecords,
                  source: 'background_delegation',
                });
                if (guarded.blocked) finalText = guarded.text;

                const completionText = `后台子 agent 完成了：${text.slice(0, 80)}\n\n${finalText}`;
                const completedTask = completeBackgroundTask(backgroundTaskId, completionText);
                if (completedTask) emitTaskUpdate(completedTask);
                if (completedTask?.status === 'cancelled') {
                  const cancelText = `Background task cancelled: ${text.slice(0, 80)}`;
                  persistBackgroundResult(cancelText, backgroundToolRecords);
                  emitBackground("agent:response", { text: cancelText, agentName: personality.name });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  return;
                }
                persistBackgroundResult(completionText, backgroundToolRecords);
                emitBackground("agent:response", { text: completionText, agentName: personality.name });
                emitBackground("agent:proactive", {
                  type: 'background_result',
                  message: completionText.slice(0, 1200),
                  agentName: personality.name,
                  timestamp: new Date().toISOString(),
                });
                emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                pushNotification(uid, {
                  type: 'background_result',
                  title: '后台子 agent 完成',
                  message: completionText.slice(0, 180),
                });

                if (shouldDistillSkill(text) && orchResult.workflowResult.totalAgentsUsed >= 2) {
                  const skillDesc = buildSkillDescription(text, orchResult.workflowResult);
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
                  persistBackgroundResult(cancelText, backgroundToolRecords);
                  emitBackground("agent:response", { text: cancelText, agentName: personality.name });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  pushNotification(uid, {
                    type: 'background_cancelled',
                    title: 'Background task cancelled',
                    message: cancelText.slice(0, 180),
                  });
                  return;
                }
                const failedTask = failBackgroundTask(backgroundTaskId, bgMessage);
                if (failedTask) emitTaskUpdate(failedTask);
                const errorText = `后台子 agent 处理受阻：${bgErr?.message || String(bgErr)}`;
                persistBackgroundResult(errorText, backgroundToolRecords);
                emitBackground("agent:response", { text: errorText, agentName: personality.name });
                emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                pushNotification(uid, {
                  type: 'background_error',
                  title: '后台子 agent 受阻',
                  message: errorText.slice(0, 180),
                });
              }
            })().catch((err) => {
              console.error('[BackgroundDelegation] Unhandled error:', err);
            });
          }, 30);
        }
      }

      if (!responseText && !prefersSequentialWorkflow && allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && !isSanctuary && (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question')) {
        // Path B: Orchestrator — decompose tasks into sub-tasks for worker agents
        // (Skipped for sanctuary agents — they stay in their territory)
        try {
          emitAgent("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Lumi Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
          const orchResult = await runOrchestratedTask(
            text,
            { userId: uid, personalityId, domain: resolvedDomain, orgId: resolvedOrgId, desktopRelay },
            { provider: activeProvider, model: activeModel },
            llmGetters,
            exposeAgentWork ? (msg) => emitAgent("agent:chunk", { text: msg, agentName: "Lumi" }) : undefined,
            (record, meta) => {
              allToolRecords.push({
                id: record.id,
                name: record.name,
                arguments: record.arguments || {},
                result: record.result || '',
                error: record.error,
              });
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
            llmWasCalled = true;

            // Check if this pattern should be auto-distilled into a skill
            if (shouldDistillSkill(text) && orchResult.workflowResult.totalAgentsUsed >= 2) {
              const skillDesc = buildSkillDescription(text, orchResult.workflowResult);
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
      if (!responseText && allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && shouldChainTask(text)) {
        // Pre-flight: auto-install any matching uninstalled/outdated skills
        await autoInstallForTask(text, { emit: (event, data) => socket.emit(event, data) });

        try {
          emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background' });
          const chainerResult = await runNLChainer(
            text,
            {
              userId: uid,
              provider: activeProvider,
              model: activeModel,
              desktopRelay,
              context: { isCancelled: () => abortController.signal.aborted, toolPolicy: routedToolPolicy || personality.toolPolicy },
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
              emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background', detail: `Step ${step}/${total}: ${desc}` });
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
        if (conversationAgentId) {
          const conv = getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId);
          const msgs = getMessagesByTokenBudget(conv.id);
          persistedHistory = msgs
            .filter((m: any) => m.message || m.content || m.response)
            .flatMap(normalizeChatHistoryRecord);
        }

        const conversationHistory = persistedHistory.length > 0
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
          console.log('[ChatHandler] Calling Path C with provider:', activeProvider, 'model:', activeModel, 'tools:', allowToolUseForTurn && !isSanctuary ? 'enabled' : 'off');
          const streamChunks: string[] = [];
          const onChunk: StreamCallback = (chunk) => {
            streamChunks.push(chunk);
            if (!deferCompletionStream) {
              emitAgent("agent:chunk", { text: chunk, agentName: personality.name });
            }
          };

          // Sanctuary agents get zero tool access — they can only talk
          if (!allowToolUseForTurn || isSanctuary) {
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
            const tokens = estimateTokens(text + ' ' + responseText);
            const subStatus = recordUsage(uid, tokens);
            const totalUsage = response.usage?.totalTokens || 0;
            socket.emit('token:usage_update', {
              userId: uid,
              provider: activeProvider,
              totalTokens: totalUsage,
              mode: 'chat',
              timestamp: new Date().toISOString(),
            });
            if (subStatus) {
              socket.emit('token:quota_update', { used: subStatus.used, cap: subStatus.cap, remaining: subStatus.remaining });
              const pct = subStatus.used / subStatus.cap;
              if (pct >= 0.9) {
                socket.emit('agent:notification', { type: 'token_warning', level: 'critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
                pushNotification(uid, { type: 'token_warning', title: 'Token Quota Critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
              } else if (pct >= 0.8) {
                socket.emit('agent:notification', { type: 'token_warning', level: 'warning', message: `Token usage at ${Math.round(pct * 100)}%` });
                pushNotification(uid, { type: 'token_warning', title: 'Token Quota Warning', message: `Token usage at ${Math.round(pct * 100)}%` });
              }
            }
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
                emitAgent("agent:chunk", { text: `[${step}]\n`, agentName: "Lumi" });
              },
              ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
              ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? {
                requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                  return new Promise((resolve) => {
                    const cid = crypto.randomUUID();
                    const timeout = setTimeout(() => resolve(false), 30000);
                    socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
                      clearTimeout(timeout);
                      resolve(data.allowed === true);
                    });
                    socket.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });
                  });
                }
              } : {}),
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
          // Record analytics + subscription
          for (const u of result.usageRecords) {
            recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
          }
          const tokens = estimateTokens(text + ' ' + responseText);
          const subStatus = recordUsage(uid, tokens);

          // Real-time token push + threshold alerts
          const totalUsage = result.usageRecords.reduce((s: number, r: any) => s + (r.totalTokens || 0), 0);
          socket.emit('token:usage_update', {
            userId: uid,
            provider: activeProvider,
            totalTokens: totalUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
          if (subStatus) {
            socket.emit('token:quota_update', { used: subStatus.used, cap: subStatus.cap, remaining: subStatus.remaining });
            const pct = subStatus.used / subStatus.cap;
            if (pct >= 0.9) {
              socket.emit('agent:notification', { type: 'token_warning', level: 'critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
              pushNotification(uid, { type: 'token_warning', title: 'Token Quota Critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
            } else if (pct >= 0.8) {
              socket.emit('agent:notification', { type: 'token_warning', level: 'warning', message: `Token usage at ${Math.round(pct * 100)}%` });
              pushNotification(uid, { type: 'token_warning', title: 'Token Quota Warning', message: `Token usage at ${Math.round(pct * 100)}%` });
            }
          }
          }
        } catch (llmErr: any) {
          console.error(`[Cognition] LLM '${activeProvider}/${activeModel}' failed: ${llmErr.message}`);
          // Do not silently switch to another paid provider. The selected model should run or fail visibly.
          if (false && llmErr.message?.includes('not configured') && activeProvider !== 'gemini') {
            try {
              const fallbackMessage = `主推理服务 ${activeProvider}/${activeModel} 不可用，Lumi 将临时降级到 Gemini。`;
              socket.emit('agent:notification', { type: 'llm_fallback', level: 'warning', message: fallbackMessage });
              pushNotification(uid, { type: 'llm_fallback', title: 'LLM 降级提醒', message: fallbackMessage });
              if (!allowToolUseForTurn || isSanctuary) {
                const fallbackChunks: string[] = [];
                const fallback = await makeLLMCallStreaming(
                  messages,
                  [],
                  { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal },
                  (chunk) => {
                    fallbackChunks.push(chunk);
                    emitAgent("agent:chunk", { text: chunk, agentName: personality.name });
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
                  ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? {
                    requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                      return new Promise((resolve) => {
                        const cid = crypto.randomUUID();
                        const timeout = setTimeout(() => resolve(false), 30000);
                        socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
                          clearTimeout(timeout);
                          resolve(data.allowed === true);
                        });
                        socket.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });
                      });
                    }
                  } : {}),
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

      const completionGuard = guardCompletionClaims({
        task: text,
        response: responseText,
        toolCalls: allToolRecords,
        source: 'chat',
      });
      if (completionGuard.blocked) {
        console.warn('[ChatHandler] Completion claim blocked:', completionGuard.reason);
        responseText = completionGuard.text;
        emitAgent("agent:notification", { type: 'work_product_guard', level: 'warning', message: completionGuard.reason });
      }

      // Save to conversation via conversation manager (reuse conversationId from setup)

      if (conversationId) {
        addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
        // Persist tool calls interleaved before the assistant response
        for (const tc of allToolRecords) {
          const tcSummary = tc.error
            ? `[Tool: ${tc.name}] Error: ${tc.error}`
            : `[Tool: ${tc.name}] Done`;
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: allToolRecords.length ? allToolRecords : undefined });
        // (conversation_updated NOW emitted AFTER agent:response — see below)

        // Topic tracking — extract and record topics for cross-session continuity
        try {
          const topics = extractTopics(text + ' ' + responseText);
          for (const topic of topics) trackTopic(conversationId, topic);
        } catch {}

        // Auto-summarize long conversations (anti-entropy: prevents context overflow)
        const { needed, recentMessages } = checkAutoSummary(conversationId);
        if (needed && recentMessages.length > 0) {
          summarizeConversationAsync(conversationId, recentMessages, llmGetters, activeProvider, activeModel, uid, resolvedDomain, resolvedOrgId).catch(
            () => {} // Non-critical
          );
        }
      }

      // Log interaction
      const db = readDB();
      db.interactions.push({
        id: interactionId, userId: uid, agentId: agentId || '',
        conversationId: conversationId || '', content: storedUserContent, response: responseText,
        role: "user", personality: personality.id, timestamp: new Date().toISOString(),
        cognitiveIntent: cognition.intent.category,
        llmWasCalled,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
      });
      writeDB(db);

      // Emit response BEFORE conversation_updated so the client finalizes streaming first
      emitAgent("agent:response", { text: responseText, agentName: personality.name });
      // Re-emit conversation_updated AFTER response so the client syncs from API with complete data
      if (conversationId) {
        socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
      }
      emitAgent("agent:status", { status: "idle" });

      persistChatLearning(responseText, { toolRecords: allToolRecords, logLabel: 'chat' });

      // Clean up abort session
      chatSessionMap.delete(sessionKey);

      // Auto-learn from corrections: when user corrects Lumi, extract high-confidence memories
      const correctionPatterns = [/不是/, /不对/, /错了/, /wrong/i, /incorrect/i, /actually/i, /no,?\s/i, /你弄错了/, /不是这样的/];
      const isCorrection = correctionPatterns.some(p => p.test(text));
      if (isCorrection && responseText) {
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
              });
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
      if (!isSanctuary && responseText && cognition.intent.category !== 'command' && !personalityRegistry.isEvolutionFrozen(personalityId)) {
        try {
          const evolutionConfig = personalityRegistry.getEvolutionConfig(personalityId);
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
            personalityRegistry.applyEvolution(personalityId, step);
            console.log(`[ChatHandler] Lightweight evolution: v${step.version}, ${step.mutations.length} mutation(s)`);
          }
        } catch (evErr: any) {
          console.warn('[ChatHandler] Lightweight evolution failed:', evErr.message);
        }
      }

      // Async memory extraction — skip trivial/command messages to reduce noise
      const skipExtractionCategories = ['command', 'file', 'unknown'];
      if (text.length >= 10 && !skipExtractionCategories.includes(cognition.intent.category)) {
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
          addReminder({ userId: uid, content: rem.content, dueAt: rem.dueAt, sourceInteractionId: interactionId });
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
      chatSessionMap.delete(sessionKey);
    }
  });
}

async function summarizeConversationAsync(
  conversationId: string,
  recentMessages: any[],
  llmGetters: any,
  provider: string,
  model: string,
  userId: string,
  domain: string,
  orgId?: string,
) {
  try {
    const transcript = recentMessages.slice(-30)
      .map((m: any) => `${m.role || 'user'}: ${(m.message || m.content || '').slice(0, 200)}`)
      .join('\n');
    const summaryPrompt = `Summarize this conversation in 2-3 concise sentences. Focus on key decisions, topics discussed, and user preferences revealed. Output only the summary — no preamble.\n\n${transcript}`;
    const result = await makeLLMCall(
      [{ role: 'user', content: summaryPrompt }],
      [],
      { provider: provider as any, model, maxTokens: 300, userId, domain, orgId },
      llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
    );
    const summary = result.text.trim();
    if (summary) {
      setConversationSummary(conversationId, summary);
      console.log(`[Conversation] Auto-summary generated for ${conversationId}`);
    }
  } catch (err) {
    // Non-critical — conversation continues without summary
  }
}



