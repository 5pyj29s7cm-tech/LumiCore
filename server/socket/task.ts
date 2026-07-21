/**
 * agent:task socket handler — multi-turn tool-augmented AI pipeline
 */
import { Server, Socket } from "socket.io";
import { readDB, writeDB } from "../../db_layer";
import { recordTokenUsage } from "../llm/token_tracker";
import { NormalizedMessage } from "../llm/providers";
import { runWithTools, LLMUsageRecord } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { queryMemories, addMemory, addReminder, extractMemories, CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, vectorMemoryBias } from "../personality/state";
import { personalityRegistry } from "../personality";
import { canOutputHolographic, textToHolographicOutput } from "../output/holographic";
import { getConversationForScope, getOrCreateActiveConversation } from "../conversation/manager";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext, CognitiveResult } from "../cognition";
import { classifyComplexity, decomposeTask, matchWorkers, executeWorkflow, aggregateWithLLM, recordWorkflowPattern, shouldDistillSkill, buildSkillDescription } from "../agents/orchestrator";
import { markLatestUserTurn } from "../agents/background_delivery";
import { getMessagesByTokenBudget, addMessage, extractTopics, trackTopic, getTopicContext, getConversationSummary } from "../conversation/manager";
import { loadHIMState, saveHIMState, updateEmotionalStateWithHIM } from "../personality/state";
import { shouldExposeAgentWork } from "../cognition/tool_intent";
import { formatClientSelfPrompt } from "../client/self_model";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { buildLumiTurnDispatch } from "../cognition/turn_dispatch";
import { buildLumiExecutionDecision } from "../cognition/execution_decision";
import { buildLumiIntentTrace } from "../cognition/intent_trace";
import { buildLumiCapabilitySelection } from "../cognition/capability_selection";
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
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
import type { ToolExecutionRecord } from "../tools/types";
import { createDesktopRelay } from "./desktop_relay";
import { DEFAULT_MODELS, getScopedPreferredLLM } from "../llm/user_preferences";
import { resolveSocketScope, scopedEmotionalStateKey } from "./scope";
import {
  beginChatExecution,
  getChatExecution,
  markChatExecutionCancelling,
  recordChatExecutionEvent,
  type ChatExecutionScope,
} from "./chat_execution_registry";

type ActiveTaskCancellation = {
  requestId: string;
  cancel: () => void;
};

const activeTaskCancellations = new Map<string, ActiveTaskCancellation>();

function taskExecutionRoom(scope: ChatExecutionScope): string {
  return scope.domain === 'work' && scope.orgId
    ? `user:${scope.userId}:org:${scope.orgId}`
    : `user:${scope.userId}:personal`;
}

function taskExecutionKey(scope: ChatExecutionScope): string {
  return `${scope.userId}:${scope.domain}:${scope.orgId || ''}:${scope.source}`;
}

export function registerTaskHandler(
  socket: Socket,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI: () => any;
    getAnthropic: () => any;
    getQwen: () => any;
    getOllama?: () => any;
    getLmStudio?: () => any;
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
  socket.on('agent:task_cancel', (
    data: { requestId?: string; domain?: 'personal' | 'work'; orgId?: string | null } = {},
    ack?: (payload: { ok: boolean; requestId?: string; status?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const resolvedScope = resolveSocketScope(socket, uid, data);
    const executionScope: ChatExecutionScope = {
      userId: uid,
      domain: resolvedScope.domain,
      orgId: resolvedScope.orgId,
      source: 'task',
    };
    const snapshot = getChatExecution(executionScope, data.requestId);
    if (!snapshot || snapshot.terminal) {
      try {
        ack?.({
          ok: Boolean(snapshot?.terminal),
          requestId: snapshot?.requestId || data.requestId,
          status: snapshot?.status,
          error: snapshot ? undefined : 'Active task not found',
        });
      } catch {}
      if (snapshot?.terminalEvent) {
        socket.emit(snapshot.terminalEvent.event, {
          ...snapshot.terminalEvent.payload,
          replayed: true,
        });
      }
      return;
    }
    const active = activeTaskCancellations.get(taskExecutionKey(executionScope));
    if (!active || active.requestId !== snapshot.requestId) {
      try { ack?.({ ok: false, requestId: snapshot.requestId, error: 'Task cancellation handle is unavailable' }); } catch {}
      return;
    }
    markChatExecutionCancelling(executionScope, snapshot.requestId);
    io.to(taskExecutionRoom(executionScope)).emit('agent:status', {
      status: 'cancelling',
      source: 'task',
      requestId: snapshot.requestId,
    });
    active.cancel();
    try { ack?.({ ok: true, requestId: snapshot.requestId, status: 'cancelling' }); } catch {}
  });

  socket.on("agent:task", async (
    data: { text: string; history?: any[]; personalityId?: string; conversationId?: string; domain?: 'personal' | 'work'; orgId?: string; requestId?: string },
    ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void,
  ) => {
    const uid = userIdFn(socket);
    const taskScope = resolveSocketScope(socket, uid, data);
    const requestId = typeof data.requestId === 'string' && data.requestId.trim()
      ? data.requestId.trim().slice(0, 120)
      : `task_${crypto.randomUUID()}`;
    const executionScope: ChatExecutionScope = {
      userId: uid,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      source: 'task',
    };
    const executionRoom = taskExecutionRoom(executionScope);
    const executionKey = taskExecutionKey(executionScope);
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = { ...payload, source: payload.source || 'task', requestId };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return;
      io.to(executionRoom).emit(event, normalizedPayload);
    };
    const emitTask = (event: string, payload: Record<string, any> = {}) => {
      const normalizedPayload = { ...payload, source: payload.source || 'task', requestId };
      if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return;
      io.to(executionRoom).emit(event, normalizedPayload);
    };

    const existingExecution = getChatExecution(executionScope, requestId);
    if (existingExecution) {
      try { ack?.({ ok: true, requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        socket.emit(existingExecution.terminalEvent.event, { ...existingExecution.terminalEvent.payload, replayed: true });
      }
      return;
    }

    const previous = activeTaskCancellations.get(executionKey);
    if (previous) previous.cancel();
    const superseded = beginChatExecution(executionScope, requestId);
    if (superseded?.terminalEvent) {
      io.to(executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    markLatestUserTurn(executionScope, requestId);
    let cancelled = false;
    const taskAbortController = new AbortController();
    const cancelTask = () => {
      cancelled = true;
      taskAbortController.abort();
      console.log(`[Task] Cancelled by user for ${uid} (${requestId})`);
    };
    activeTaskCancellations.set(executionKey, { requestId, cancel: cancelTask });
    const releaseTask = () => {
      if (activeTaskCancellations.get(executionKey)?.requestId === requestId) {
        activeTaskCancellations.delete(executionKey);
      }
    };
    try { ack?.({ ok: true, requestId, receivedAt: new Date().toISOString() }); } catch {}
    const taskStateKey = scopedEmotionalStateKey(uid, taskScope);
    if (isConfirmationCancellation(data.text)) clearPendingConfirmation(uid);
    const pendingConfirmation = isExplicitConfirmationReply(data.text)
      ? getPendingConfirmation(uid)
      : null;
    const pendingConfirmationPrompt = pendingConfirmation
      ? formatPendingConfirmationPrompt(pendingConfirmation)
      : '';
    const routedTaskText = [data.text, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
    const interactionId = crypto.randomUUID();
    const exposeAgentWork = shouldExposeAgentWork(routedTaskText);

    // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
    const personalityPreConfig = personalityRegistry.getForUser(
      data.personalityId || 'lumi',
      uid,
      taskScope.domain === 'work' ? taskScope.orgId : undefined,
    );
    const retrievalBiases = personalityPreConfig?.personalityVector
      ? vectorMemoryBias(personalityPreConfig.personalityVector)
      : { typeWeights: {}, perspectiveWeights: {} };

    const relevantMemories = queryMemories({
      userId: uid, query: routedTaskText, limit: 5, minConfidence: 0.4,
      retrievalTypeWeights: retrievalBiases.typeWeights,
      retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
    });

    const emotionalState = loadEmotionalState(taskStateKey);
    const isNovelTask = relevantMemories.length < 2;

    const sensory = sensoryFn(uid);
    const { config: personality, systemPrompt: systemInstruction } = personalityRegistry.buildSystemPrompt(
      data.personalityId || 'lumi',
      { mode: 'task', sensory },
      {
        memories: relevantMemories.length > 0 ? relevantMemories : undefined,
        emotionalState,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
      },
    );

    const userLLMPrefs = getScopedPreferredLLM(uid, taskScope);
    let activeProvider = userLLMPrefs.provider || 'deepseek';
    let activeModel = (userLLMPrefs.models || {})[activeProvider] || DEFAULT_MODELS[activeProvider] || 'deepseek-v4-flash';

    // ── Load persisted conversation history (survives page reload) ──
    const turnDispatch = buildLumiTurnDispatch({
      userId: uid,
      text: routedTaskText,
      channel: 'task',
      source: 'task',
      category: 'command',
      operationMode: 'assistant',
      domain: taskScope.domain,
      orgId: taskScope.orgId,
      targetIsLumi: personality.id === 'lumi',
    });
    const turnFlow = turnDispatch.flow;
    const workSurfaceRoute = turnFlow.workSurfaceRoute;
    const visionIntent = turnFlow.visionIntent;
    const executionDecision = buildLumiExecutionDecision({
      flow: turnFlow,
      text: routedTaskText,
      toolDeclarations: toolRegistry.getToolDeclarations(),
      toolRegistry,
      personalityToolPolicy: personality.toolPolicy,
    });
    const deferTaskModelOutput =
      executionDecision.allowToolUse
      || shouldDeferModelOutputUntilFinalized({
        taskText: routedTaskText,
        flow: turnFlow,
      });
    const taskTextGate = createPreFinalizationTextGate();
    const intentTrace = buildLumiIntentTrace({
      dispatch: turnDispatch,
      execution: executionDecision,
      text: routedTaskText,
      source: 'task',
    });
    const capabilitySelection = buildLumiCapabilitySelection({
      dispatch: turnDispatch,
      execution: executionDecision,
      text: routedTaskText,
    });
    const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
      channel: 'task',
      text: routedTaskText,
      flow: turnFlow,
      capabilitySelection,
    });
    if (executionDecision.toolRoute) {
      emitAgent('agent:tool_route', {
        categories: executionDecision.toolRoute.categories,
        reasons: executionDecision.toolRoute.reasons,
        toolNames: executionDecision.toolRoute.toolNames,
        totalAvailable: executionDecision.toolRoute.totalAvailable,
        truncated: executionDecision.toolRoute.truncated,
        source: 'task',
        trace: intentTrace,
      });
    }
    emitAgent('agent:intent_trace', intentTrace);
    emitAgent('agent:capability_selection', {
      lane: capabilitySelection.lane,
      primary: capabilitySelection.primary,
      reasons: capabilitySelection.reasons,
      preferredTools: capabilitySelection.preferredTools,
      source: 'task',
    });
    if (desktopExecutionPolicy.applies) {
      emitAgent('agent:desktop_execution_policy', {
        reason: desktopExecutionPolicy.reason,
        evidenceTools: desktopExecutionPolicy.evidenceTools,
        actuationTools: desktopExecutionPolicy.actuationTools,
        verificationTools: desktopExecutionPolicy.verificationTools,
        source: 'task',
      });
    }
    let effectiveSystemPrompt = systemInstruction + '\n\n' + formatClientSelfPrompt(uid, taskScope);
    effectiveSystemPrompt += '\n\n' + turnDispatch.promptOverlay;
    effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
    effectiveSystemPrompt += '\n\n' + executionDecision.promptOverlay;
    effectiveSystemPrompt += '\n\n' + capabilitySelection.promptOverlay;
    if (desktopExecutionPolicy.promptOverlay) {
      effectiveSystemPrompt += '\n\n' + desktopExecutionPolicy.promptOverlay;
    }
    effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
      userId: uid,
      text: routedTaskText,
      flow: turnFlow,
      toolRegistry,
    });
    if (workSurfaceRoute.promptOverlay) {
      effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
    }
    const visionRoutingOverlay = visionIntent ? buildVisionRoutingOverlay(uid, routedTaskText) : '';
    if (visionRoutingOverlay) {
      effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
    }
    const selectedConversation = data.conversationId
      ? getConversationForScope(data.conversationId, uid, taskScope.domain, taskScope.orgId)
      : null;
    const convForHistory = selectedConversation || getOrCreateActiveConversation(uid, '', taskScope.domain, taskScope.orgId);
    const voiceHistory: NormalizedMessage[] = [];
    if (convForHistory) {
      const summaryContext = getConversationSummary(convForHistory.id);
      if (summaryContext) {
        effectiveSystemPrompt += `\n\n## Conversation Context\n${summaryContext}`;
      }
      const recentMsgs = getMessagesByTokenBudget(convForHistory.id);
      for (const m of recentMsgs) {
        if (m.message) voiceHistory.push({ role: 'user', content: m.message });
        if (m.response) voiceHistory.push({ role: 'assistant', content: m.response });
      }
      // Inject topic context for continuity
      const topicCtx = getTopicContext(convForHistory.id);
      if (topicCtx) effectiveSystemPrompt += topicCtx;
    }
    effectiveSystemPrompt += '\n\n' + buildLumiOperatingKernelPrompt({
      channel: 'task',
      flow: turnFlow,
    });

    const messages: NormalizedMessage[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...voiceHistory,
      { role: 'user', content: routedTaskText },
    ];
    const persistTaskLearning = (
      assistantText: string,
      options: {
        toolRecords?: ToolExecutionRecord[];
        sourceInteractionId?: string;
        logLabel?: string;
      } = {},
    ) => {
      persistLumiPostTurnLearning(
        {
          userId: uid,
          userText: data.text,
          defaultChannel: 'task',
          flow: turnFlow,
          getToolNames: () => toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
          domain: taskScope.domain,
          orgId: taskScope.orgId,
          defaultSourceInteractionId: interactionId,
          agentId: '',
          log: { info: console.log, warn: console.warn },
        },
        assistantText,
        options,
      );
    };
    const persistTaskExecutionWriteback = (
      assistantText: string,
      toolRecords: ToolExecutionRecord[] = [],
      sourceInteractionId: string = interactionId,
    ) => {
      const executionWriteback = persistWorkTakeoverTurnExecution({
        userId: uid,
        userText: data.text,
        assistantText,
        source: 'task',
        interactionId: sourceInteractionId,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        flow: turnFlow,
        capabilitySelection,
        toolRecords,
      });
      if (executionWriteback.recorded) {
        emitAgent('agent:task_execution_writeback', {
          ...executionWriteback,
          source: 'task',
        });
      }
      return executionWriteback;
    };

    let cognition: CognitiveResult | undefined;

    try {
      emitAgent("agent:status", { status: "thinking", agentName: personality.name });

      // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        personalityId: personality.id,
        personalityName: personality.name,
        llmProvider: activeProvider,
        llmModel: activeModel,
        isLLMAvailable: true,
      };
      cognition = await processInput(routedTaskText, cognitiveCtx);
      if (cancelled) {
        const cancellationError = new Error('Task cancelled');
        cancellationError.name = 'AbortError';
        throw cancellationError;
      }

      // If cognitive engine handled directly (simple command), skip LLM entirely
      // ── Auto-select model: flash for simple chat, pro for complex tasks ──
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
      console.log(`[Task] Model auto-selected: ${activeProvider}/${activeModel} for category: ${cognition.intent.category}`);

      if (cognition.directToolExecuted && cognition.responseText) {
        console.log(`[Cognition] Task handled directly: ${cognition.intent.category}/${cognition.intent.subIntent}`);
        const directToolRecords = cognition.toolRecords
          || (cognition.toolRecord ? [cognition.toolRecord] : []);
        const finalDirect = finalizeLumiResponse({
          taskText: data.text,
          responseText: cognition.responseText,
          toolRecords: directToolRecords,
          source: 'task',
          flow: turnFlow,
        });
        const directResponseText = finalDirect.text;
        if (finalDirect.blocked && finalDirect.notification) emitAgent("agent:notification", finalDirect.notification);
        emitAgent("agent:response", {
          text: directResponseText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: finalDirect.blocked,
          reason: finalDirect.reason,
        });
        emitAgent("agent:status", { status: "idle" });

        // Still log the interaction
        const db = readDB();
        db.interactions.push({
          id: interactionId,
          content: data.text,
          response: directResponseText,
          role: "user",
          personality: personality.id,
          timestamp: new Date().toISOString(),
          mode: 'task',
          cognitiveIntent: cognition.intent.category,
          llmWasCalled: false,
          userId: uid,
          conversationId: convForHistory.id,
          domain: taskScope.domain,
          orgId: taskScope.orgId,
        } as any);
        writeDB(db);
        persistTaskExecutionWriteback(directResponseText, directToolRecords, `${interactionId}_direct`);
        persistTaskLearning(directResponseText, {
          toolRecords: directToolRecords,
          logLabel: 'task direct cognition',
        });
        releaseTask();
        return;
      }

      // ── Desktop relay: must be defined before orchestrator path so OCR tools work ──
      const desktopRelay = createDesktopRelay({
        io,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
        source: 'task',
        requestSocket: socket,
        cancelOnRequestSocketDisconnect: false,
      });

      // ── Orchestrator: decompose complex tasks into sub-tasks for worker agents ──
      let orchestratedText = '';
      const orchestratedToolRecords: ToolExecutionRecord[] = [];
      if (!pendingConfirmation && (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question')) {
        const orchestrationContext = {
          userId: uid,
          personalityId: data.personalityId || 'lumi',
          domain: taskScope.domain,
          orgId: taskScope.orgId,
          toolPolicy: executionDecision.toolPolicy,
          rootTaskText: routedTaskText,
        };
        const complexity = classifyComplexity(routedTaskText, orchestrationContext);
        if (!workSurfaceRoute.forbidComputerUse && (complexity === 'complex' || complexity === 'moderate')) {
          const db = readDB();
          const availableAgents = (db.agents || []).filter((a: any) => {
            if (a.status === 'offline' || a.status === 'terminated') return false;
            if (taskScope.domain === 'work') {
              return a.domain === 'work' && a.orgId === taskScope.orgId;
            }
            return a.domain !== 'work' && !a.orgId && (!a.ownerUid || a.ownerUid === uid);
          });
          if (availableAgents.length >= 1) {
            try {
              emitAgent("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Lumi Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
              const scopedLlmConfig = { provider: activeProvider, model: activeModel, userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, signal: taskAbortController.signal };
              const subTasks = await decomposeTask(data.text, scopedLlmConfig, orchestrationContext, llmGetters);
              if (exposeAgentWork && !deferTaskModelOutput) emitTask("task:chunk", { text: `[Orchestrator] Decomposed into ${subTasks.length} sub-tasks\n`, agentName: "Lumi" });

              const assignments = matchWorkers(subTasks, availableAgents);
              if (exposeAgentWork && !deferTaskModelOutput) emitTask("task:chunk", { text: `[Orchestrator] Assigned to ${assignments.length} worker(s)\n`, agentName: "Lumi" });

              const workflowResult = await executeWorkflow(
                assignments,
                { ...orchestrationContext, desktopRelay },
                scopedLlmConfig,
                llmGetters,
                availableAgents,
                (record, meta) => {
                  emitAgent("agent:tool_call", {
                    correlationId: record.id,
                    name: record.name,
                    arguments: record.arguments,
                    result: record.result?.slice(0, 500),
                    error: record.error,
                    source: 'task',
                    worker: meta,
                  });
                  if (record.result !== undefined || record.error !== undefined) {
                    orchestratedToolRecords.push({
                      id: record.id,
                      name: record.name,
                      arguments: record.arguments,
                      result: record.result || '',
                      error: record.error,
                    });
                  }
                },
              );
              const aggregated = await aggregateWithLLM(workflowResult, data.text, scopedLlmConfig, llmGetters, uid, taskScope);
              orchestratedText = aggregated;

              const skillTags = subTasks.map(s => s.requiredSkill);
              recordWorkflowPattern(data.text, subTasks.length, skillTags, uid, taskScope.domain, taskScope.orgId);

              if (shouldDistillSkill(data.text)) {
                const skillDesc = buildSkillDescription(data.text, workflowResult);
                emitAgent("agent:proactive", {
                  type: 'distill_hint',
                  message: 'I notice this type of task is recurring. I can create an automated skill for this — would you like me to?',
                  skillDescription: skillDesc,
                  timestamp: new Date().toISOString(),
                });
              }
              if (exposeAgentWork && !deferTaskModelOutput) {
              emitTask("task:chunk", { text: `\n[Orchestrator] Workflow result ready for final validation — ${workflowResult.totalAgentsUsed} agent(s) used\n`, agentName: "Lumi" });
              }
            } catch (orchErr: any) {
              console.error('[Orchestrator] Task workflow failed, falling back to normal execution:', orchErr.message);
            }
          }
        }
      }

      if (orchestratedText) {
        const finalOrchestrated = finalizeLumiResponse({
          taskText: data.text,
          responseText: orchestratedText,
          toolRecords: orchestratedToolRecords,
          source: 'task',
          flow: turnFlow,
        });
        orchestratedText = finalOrchestrated.text;
        if (finalOrchestrated.blocked) {
          if (finalOrchestrated.notification) emitAgent("agent:notification", finalOrchestrated.notification);
        }
        // Orchestrator handled the task — emit result and skip normal LLM path
        emitAgent("agent:response", {
          text: orchestratedText,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: finalOrchestrated.blocked,
          reason: finalOrchestrated.reason,
        });
        emitAgent("agent:status", { status: "idle" });
        releaseTask();

        const db = readDB();
        const conv = convForHistory;
        db.interactions.push({
          id: interactionId, content: data.text, response: orchestratedText,
          role: "user", personality: personality.id, timestamp: new Date().toISOString(),
          mode: 'task', cognitiveIntent: cognition.intent.category, llmWasCalled: true,
          userId: uid, conversationId: conv.id, domain: taskScope.domain, orgId: taskScope.orgId,
        } as any);
        writeDB(db);

        // Update emotional state
        let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
        if (isNovelTask) {
          updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: uid, timestamp: new Date().toISOString() });
        }
        saveEmotionalState(taskStateKey, updatedState);
        persistTaskExecutionWriteback(orchestratedText, orchestratedToolRecords, `${interactionId}_orchestrated`);
        persistTaskLearning(orchestratedText, {
          toolRecords: orchestratedToolRecords,
          logLabel: 'task orchestrated',
        });
        return;
      }

      const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
        if (
          pendingConfirmation
          && consumePendingConfirmation(uid, pendingConfirmation.id, toolName, args)
        ) {
          console.log(`[TaskHandler] Consumed one-time confirmation for "${toolName}".`);
          return true;
        }
        if (canAutoApproveAction(toolName, args, { actionIntent: routedTaskText })) return true;
        const pending = recordPendingConfirmation(uid, toolName, args, 'task');
        console.warn(`[TaskHandler] Tool "${toolName}" is waiting for one-time confirmation ${pending.id}.`);
        return false;
      };

      const result = await runWithTools(
        messages,
        toolRegistry,
        { provider: activeProvider, model: activeModel, userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, signal: taskAbortController.signal },
        (record) => {
          emitAgent("agent:tool_call", {
            name: record.name,
            arguments: record.arguments,
            result: record.result?.slice(0, 500),
            error: record.error,
          });
        },
        executionDecision.maxIterations || 25,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        (chunk) => {
          if (!cancelled && !deferTaskModelOutput) {
            const safeText = taskTextGate.push(chunk);
            if (safeText) {
              emitTask("task:chunk", { text: safeText, agentName: personality.name });
              emitAgent("agent:chunk", { text: safeText, agentName: personality.name });
            }
          }
        },
        { userId: uid, domain: taskScope.domain, orgId: taskScope.orgId, desktopRelay, requestConfirmation, actionIntent: routedTaskText, routedTaskText, toolPolicy: executionDecision.toolPolicy, isCancelled: () => cancelled, llmGetters, source: 'task', supervisedExternalCommits: true },
        llmGetters.getOllama,
        llmGetters.getLmStudio,
        llmGetters.getArk,
        llmGetters.getXiaomi,
        llmGetters.getKimi,
        llmGetters.getGlm,
        llmGetters.getRelay,
      );

      // Persist token usage
      for (const u of result.usageRecords) {
        recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId, 'task');
      }
      taskTextGate.finish();

      if (cancelled) {
        const cancelledResponse = finalizeLumiResponse({
          taskText: data.text,
          responseText: '任务已取消。',
          toolRecords: result.toolCalls,
          source: 'task',
          flow: turnFlow,
        });
        emitAgent("agent:response", {
          text: cancelledResponse.text,
          agentName: personality.name,
          source: 'task',
          finalized: true,
          blocked: true,
          reason: 'cancelled',
        });
        emitAgent("agent:status", { status: "idle" });
        persistTaskExecutionWriteback(cancelledResponse.text, result.toolCalls, `${interactionId}_cancelled`);
        persistTaskLearning(cancelledResponse.text, {
          toolRecords: result.toolCalls,
          sourceInteractionId: `${interactionId}_cancelled`,
          logLabel: 'task cancelled',
        });
        return;
      }

      let finalTaskText = result.text;
      const finalTaskResponse = finalizeLumiResponse({
        taskText: data.text,
        responseText: finalTaskText,
        toolRecords: result.toolCalls,
        source: 'task',
        flow: turnFlow,
      });
      finalTaskText = finalTaskResponse.text;
      if (finalTaskResponse.blocked) {
        if (finalTaskResponse.notification) emitAgent("agent:notification", finalTaskResponse.notification);
      }
      const holoTask = canOutputHolographic(sensory)
        ? textToHolographicOutput(finalTaskText)
        : undefined;
      emitAgent("agent:response", {
        text: finalTaskText,
        agentName: personality.name,
        holographic: holoTask,
        source: 'task',
        finalized: true,
        blocked: finalTaskResponse.blocked,
        reason: finalTaskResponse.reason,
      });
      emitAgent("agent:status", { status: "idle" });

      // Log with conversation linkage
      const db = readDB();
      const conv = convForHistory;
      if (!conv.title) {
        conv.title = data.text.slice(0, 50);
        writeDB(db);
      }
      db.interactions.push({
        id: interactionId,
        content: data.text,
        response: finalTaskText,
        role: "user",
        personality: personality.id,
        timestamp: new Date().toISOString(),
        mode: 'task',
        toolCalls: result.toolCalls.map((tc: any) => ({ name: tc.name, args: tc.arguments })),
        conversationId: conv.id,
        userId: uid,
        domain: taskScope.domain,
        orgId: taskScope.orgId,
      } as any);
      writeDB(db);

      persistTaskExecutionWriteback(finalTaskText, result.toolCalls);
      persistTaskLearning(finalTaskText, { toolRecords: result.toolCalls, logLabel: 'task' });

      // Async memory extraction
      const locationTag = sensory.locationTag || undefined;
      extractMemories(
        {
          userMessage: data.text,
          assistantResponse: finalTaskText,
          existingMemories: relevantMemories.map(m => m.content),
          provider: activeProvider,
          model: activeModel,
          userId: uid,
          locationTag,
          domain: taskScope.domain,
          orgId: taskScope.orgId,
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      ).then(extracted => {
        for (const mem of extracted.memories) {
          addMemory({
            userId: uid,
            type: mem.type,
            content: mem.content,
            keywords: mem.keywords,
            confidence: mem.confidence,
            sourceInteractionId: db.interactions[db.interactions.length - 1]?.id || '',
          } as any, { location: locationTag, domain: taskScope.domain, orgId: taskScope.orgId, source: 'system' });
        }
        for (const rem of extracted.reminders) {
          addReminder({
            userId: uid,
            content: rem.content,
            dueAt: rem.dueAt,
            sourceInteractionId: db.interactions[db.interactions.length - 1]?.id || '',
            domain: taskScope.domain,
            orgId: taskScope.orgId,
          });
        }
        const totalExtracted = extracted.memories.length + extracted.reminders.length;
        if (totalExtracted > 0) {
          console.log(`[Memory] Extracted ${extracted.memories.length} memories + ${extracted.reminders.length} reminders for user ${uid}`);
        }
      }).catch(err => console.error('[Memory] Extraction failed:', err));

      // Update emotional state with sentiment analysis + HIM
      const sentiment = extractSentiment(data.text);
      let updatedState = updateEmotionalState(emotionalState, {
        type: 'interaction',
        userId: uid,
        timestamp: new Date().toISOString(),
      });
      if (sentiment.valence !== 0 || sentiment.frustration > 0 || sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, {
          type: 'sentiment_analysis',
          sentiment,
          userId: uid,
          timestamp: new Date().toISOString(),
        });
      }
      if (isNovelTask) {
        updatedState = updateEmotionalState(updatedState, {
          type: 'novel_topic',
          userId: uid,
          timestamp: new Date().toISOString(),
        });
      }
      const himState = loadHIMState(taskStateKey);
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: uid }, himState, data.text.slice(0, 40));
      saveEmotionalState(taskStateKey, himUpdated);
      saveHIMState(taskStateKey, newHim);

      // ── Persist messages via conversation manager for cross-session continuity ──
      if (convForHistory) {
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId });
        if (finalTaskText) {
          addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: finalTaskText, personality: personality.id, domain: taskScope.domain, orgId: taskScope.orgId });
        }
        try {
          const topics = extractTopics(data.text + ' ' + finalTaskText);
          for (const topic of topics) trackTopic(convForHistory.id, topic);
        } catch {}
        io.to(executionRoom).emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task', requestId });
      }

    } catch (err: any) {
      if (cancelled || err?.name === 'AbortError') {
        emitAgent('agent:response', {
          text: 'Task cancelled.',
          agentName: personality.name,
          finalized: true,
          blocked: true,
          reason: 'cancelled',
        });
        return;
      }
      console.error("[Agent Task Error]:", err);
      const cf = handleLLMFailure(cognition?.intent || { category: 'unknown', confidence: 0, entities: {}, needsLLM: true }, err);
      const finalFailure = finalizeLumiResponse({
        taskText: data.text,
        responseText: cf.responseText,
        toolRecords: cognition?.toolRecords
          || (cognition?.toolRecord ? [cognition.toolRecord] : []),
        source: 'task',
        flow: turnFlow,
      });
      emitAgent("agent:response", {
        text: finalFailure.text,
        agentName: personality.name,
        source: 'task',
        finalized: true,
        blocked: finalFailure.blocked,
        reason: finalFailure.reason,
      });
      emitAgent("agent:status", { status: "error" });
    } finally {
      releaseTask();
    }
  });
}



