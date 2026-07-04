/**
 * agent:task socket handler — multi-turn tool-augmented AI pipeline
 */
import { Socket } from "socket.io";
import { readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { recordTokenUsage } from "../llm/token_tracker";
import { NormalizedMessage } from "../llm/providers";
import { runWithTools, LLMUsageRecord } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { queryMemories, addMemory, addReminder, extractMemories } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, vectorMemoryBias } from "../personality/state";
import { personalityRegistry } from "../personality";
import { canOutputHolographic, textToHolographicOutput } from "../output/holographic";
import { getOrCreateActiveConversation } from "../conversation/manager";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext, CognitiveResult } from "../cognition";
import { classifyComplexity, decomposeTask, matchWorkers, executeWorkflow, aggregateWithLLM, recordWorkflowPattern, shouldDistillSkill, buildSkillDescription } from "../agents/orchestrator";
import { getMessagesByTokenBudget, addMessage, extractTopics, trackTopic, getTopicContext, getConversationSummary } from "../conversation/manager";
import { loadHIMState, saveHIMState, updateEmotionalStateWithHIM } from "../personality/state";
import { shouldExposeAgentWork } from "../cognition/tool_intent";
import { resolveWorkSurfaceRoute } from "../cognition/work_surface";
import { formatClientSelfPrompt } from "../client/self_model";
import { buildVisionRoutingOverlay, hasVisionIntent } from "../cognition/vision_routing";
import { buildLumiTurnFlow } from "../cognition/turn_flow";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { persistLumiLearningTurn } from "../cognition/learning_interface";

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
) {
  socket.on("agent:task", async (data: { text: string; history?: any[]; personalityId?: string; conversationId?: string }) => {
    const uid = userIdFn(socket);
    const interactionId = crypto.randomUUID();
    const exposeAgentWork = shouldExposeAgentWork(data.text);

    // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
    const personalityPreConfig = personalityRegistry.get(data.personalityId || 'lumi');
    const retrievalBiases = personalityPreConfig?.personalityVector
      ? vectorMemoryBias(personalityPreConfig.personalityVector)
      : { typeWeights: {}, perspectiveWeights: {} };

    const relevantMemories = queryMemories({
      userId: uid, query: data.text, limit: 5, minConfidence: 0.4,
      retrievalTypeWeights: retrievalBiases.typeWeights,
      retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
    });

    const emotionalState = loadEmotionalState(uid);
    const isNovelTask = relevantMemories.length < 2;

    const sensory = sensoryFn(uid);
    const { config: personality, systemPrompt: systemInstruction } = personalityRegistry.buildSystemPrompt(
      data.personalityId || 'lumi',
      { mode: 'task', sensory },
      {
        memories: relevantMemories.length > 0 ? relevantMemories : undefined,
        emotionalState,
        userId: uid,
      },
    );

    // Read user's LLM prefs from settings (synced from API Matrix)
    const userLLMPrefs = (() => {
      try {
        const db = readDB();
        const setting = (db.settings || []).find((s: any) => s.key === `llm_prefs_${uid}`);
        if (setting) return JSON.parse(setting.value);
      } catch {}
      return { provider: '', models: {} };
    })();
    const DEFAULT_MODELS: Record<string, string> = {
      deepseek: 'deepseek-chat', qwen: 'qwen-plus', openai: 'gpt-4o',
      gemini: 'gemini-2.0-flash', anthropic: 'claude-sonnet-4-6',
      ark: 'doubao-1-5-pro-32k', xiaomi: 'xiaomi-chat', kimi: 'moonshot-v1-8k',
      glm: 'glm-4-plus', relay: 'gpt-4o', ollama: 'qwen2.5:7b', lmstudio: 'local-model',
    };
    let activeProvider = userLLMPrefs.provider || 'deepseek';
    let activeModel = (userLLMPrefs.models || {})[activeProvider] || DEFAULT_MODELS[activeProvider] || 'deepseek-chat';

    // ── Load persisted conversation history (survives page reload) ──
    const turnFlow = buildLumiTurnFlow({
      userId: uid,
      text: data.text,
      channel: 'chat',
      source: 'task',
      category: 'command',
      surface: 'work',
      operationMode: 'assistant',
      targetIsLumi: personality.id === 'lumi',
    });
    const workSurfaceRoute = resolveWorkSurfaceRoute(data.text);
    const visionIntent = hasVisionIntent(data.text);
    let effectiveSystemPrompt = systemInstruction + '\n\n' + formatClientSelfPrompt(uid);
    effectiveSystemPrompt += '\n\n' + turnFlow.promptOverlay;
    effectiveSystemPrompt += '\n\n' + buildLumiRuntimeCapabilityContext({
      userId: uid,
      text: data.text,
      flow: turnFlow,
      toolRegistry,
    });
    if (workSurfaceRoute.promptOverlay) {
      effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
    }
    const visionRoutingOverlay = visionIntent ? buildVisionRoutingOverlay(uid, data.text) : '';
    if (visionRoutingOverlay) {
      effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
    }
    const convForHistory = getOrCreateActiveConversation(uid);
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
      { role: 'user', content: data.text },
    ];

    let cognition: CognitiveResult | undefined;
    let cancelled = false;

    // Support interrupting a running task via agent:task_cancel
    const onCancel = () => {
      cancelled = true;
      console.log(`[Task] Cancelled by user for ${uid}`);
    };
    socket.once('agent:task_cancel', onCancel);

    try {
      socket.emit("agent:status", { status: "thinking", agentName: personality.name });

      // ── Lumi Cognitive Engine: classify intent BEFORE calling any LLM ──
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        personalityId: personality.id,
        personalityName: personality.name,
        llmProvider: activeProvider,
        llmModel: activeModel,
        isLLMAvailable: true,
      };
      cognition = await processInput(data.text, cognitiveCtx);

      // If cognitive engine handled directly (simple command), skip LLM entirely
      // ── Auto-select model: flash for simple chat, pro for complex tasks ──
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
      console.log(`[Task] Model auto-selected: ${activeProvider}/${activeModel} for category: ${cognition.intent.category}`);

      if (cognition.directToolExecuted && cognition.responseText) {
        console.log(`[Cognition] Task handled directly: ${cognition.intent.category}/${cognition.intent.subIntent}`);
        socket.emit("agent:response", { text: cognition.responseText, agentName: personality.name });
        socket.emit("agent:status", { status: "idle" });

        // Still log the interaction
        const db = readDB();
        db.interactions.push({
          id: interactionId,
          content: data.text,
          response: cognition.responseText,
          role: "user",
          personality: personality.id,
          timestamp: new Date().toISOString(),
          mode: 'task',
          cognitiveIntent: cognition.intent.category,
          llmWasCalled: false,
        } as any);
        writeDB(db);
        socket.off('agent:task_cancel', onCancel);
        return;
      }

      // ── Desktop relay: must be defined before orchestrator path so OCR tools work ──
      const desktopRelay = async (toolName: string, args: Record<string, any>): Promise<string> => {
        return new Promise((resolve, reject) => {
          const cid = crypto.randomUUID();
          const timeout = setTimeout(() => {
            reject(new Error(`Desktop tool "${toolName}" timed out (30s)`));
          }, 30000);
          socket.once(`tool:desktop_result:${cid}`, (data: { output?: string; error?: string }) => {
            clearTimeout(timeout);
            if (data.error) reject(new Error(data.error));
            else resolve(data.output || '');
          });
          socket.emit('tool:desktop_exec', { correlationId: cid, name: toolName, arguments: args });
        });
      };

      // ── Orchestrator: decompose complex tasks into sub-tasks for worker agents ──
      let orchestratedText = '';
      if (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question') {
        const complexity = classifyComplexity(data.text, { userId: uid, personalityId: data.personalityId || 'lumi' });
        if (!workSurfaceRoute.forbidComputerUse && (complexity === 'complex' || complexity === 'moderate')) {
          const db = readDB();
          const availableAgents = (db.agents || []).filter((a: any) => a.status !== 'offline');
          if (availableAgents.length >= 1) {
            try {
              socket.emit("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Lumi Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
              const subTasks = await decomposeTask(data.text, { provider: activeProvider, model: activeModel }, { userId: uid, personalityId: data.personalityId || 'lumi' }, llmGetters);
              if (exposeAgentWork) socket.emit("task:chunk", { text: `[Orchestrator] Decomposed into ${subTasks.length} sub-tasks\n`, agentName: "Lumi" });

              const assignments = matchWorkers(subTasks, availableAgents);
              if (exposeAgentWork) socket.emit("task:chunk", { text: `[Orchestrator] Assigned to ${assignments.length} worker(s)\n`, agentName: "Lumi" });

              const workflowResult = await executeWorkflow(assignments, { userId: uid, personalityId: data.personalityId || 'lumi', desktopRelay }, { provider: activeProvider, model: activeModel }, llmGetters);
              const aggregated = await aggregateWithLLM(workflowResult, data.text, { provider: activeProvider, model: activeModel }, llmGetters);
              orchestratedText = aggregated;

              const skillTags = subTasks.map(s => s.requiredSkill);
              recordWorkflowPattern(data.text, subTasks.length, skillTags, uid);

              if (shouldDistillSkill(data.text)) {
                const skillDesc = buildSkillDescription(data.text, workflowResult);
                socket.emit("agent:proactive", {
                  type: 'distill_hint',
                  message: 'I notice this type of task is recurring. I can create an automated skill for this — would you like me to?',
                  skillDescription: skillDesc,
                  timestamp: new Date().toISOString(),
                });
              }
              if (exposeAgentWork) {
              socket.emit("task:chunk", { text: `\n[Orchestrator] Workflow complete — ${workflowResult.totalAgentsUsed} agent(s) used\n`, agentName: "Lumi" });
              }
            } catch (orchErr: any) {
              console.error('[Orchestrator] Task workflow failed, falling back to normal execution:', orchErr.message);
            }
          }
        }
      }

      if (orchestratedText) {
        // Orchestrator handled the task — emit result and skip normal LLM path
        socket.emit("agent:response", { text: orchestratedText, agentName: personality.name });
        socket.emit("agent:status", { status: "idle" });
        socket.off('agent:task_cancel', onCancel);

        const db = readDB();
        const conv = data.conversationId
          ? (db.conversations || []).find((c: any) => c.id === data.conversationId) || getOrCreateActiveConversation(uid)
          : getOrCreateActiveConversation(uid);
        db.interactions.push({
          id: interactionId, content: data.text, response: orchestratedText,
          role: "user", personality: personality.id, timestamp: new Date().toISOString(),
          mode: 'task', cognitiveIntent: cognition.intent.category, llmWasCalled: true,
        } as any);
        writeDB(db);

        // Update emotional state
        let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
        if (isNovelTask) {
          updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: uid, timestamp: new Date().toISOString() });
        }
        saveEmotionalState(uid, updatedState);
        try {
          const learning = persistLumiLearningTurn({
            userId: uid,
            userText: data.text,
            assistantText: orchestratedText,
            channel: 'task',
            flow: turnFlow,
            toolNames: toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
            domain: 'personal',
            sourceInteractionId: interactionId,
            agentId: '',
          });
          if (learning.shouldPersist) {
            console.log(`[LumiLearningInterface] task-orchestrated persisted memories=${learning.storedMemories} capability=${learning.capabilityRecord?.id || 'none'} reasons=${learning.reasons.join(',')}`);
          }
        } catch (learnErr: any) {
          console.warn('[LumiLearningInterface] task-orchestrated persistence failed:', learnErr?.message || learnErr);
        }
        return;
      }

      const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
        // Tool trust: if user has approved this tool ≥ 5 times, auto-approve
        const { getTrustedTools, recordToolApprove, recordToolDeny } = await import("../personality/tool_trust");
        if (getTrustedTools(uid).includes(toolName)) {
          socket.emit("agent:tool_call", { name: toolName, arguments: args, result: 'Auto-approved (trusted)', error: undefined });
          return true;
        }
        return new Promise((resolve) => {
          const cid = crypto.randomUUID();
          const timeout = setTimeout(() => {
            socket.emit("agent:tool_call", { name: toolName, arguments: args, result: 'Auto-denied (30s timeout)', error: 'User did not respond' });
            resolve(false);
          }, 30000);
          socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
            clearTimeout(timeout);
            if (data.allowed) {
              const promoted = recordToolApprove(uid, toolName);
              if (promoted) {
                socket.emit("agent:notification", { type: 'trust', level: 'info', message: `Tool "${toolName}" is now trusted — future uses will be auto-approved.` });
                pushNotification(uid, { type: 'trust', title: 'Tool Trusted', message: `Tool "${toolName}" is now trusted — auto-approved for future use.` });
              }
            } else {
              recordToolDeny(uid, toolName);
            }
            resolve(data.allowed === true);
          });
          socket.emit('agent:confirm_tool', {
            correlationId: cid,
            name: toolName,
            arguments: args,
          });
        });
      };

      const result = await runWithTools(
        messages,
        toolRegistry,
        { provider: activeProvider, model: activeModel, userId: uid },
        (record) => {
          socket.emit("agent:tool_call", {
            name: record.name,
            arguments: record.arguments,
            result: record.result?.slice(0, 500),
            error: record.error,
          });
        },
        25,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        (chunk) => {
          if (!cancelled) {
            socket.emit("task:chunk", { text: chunk, agentName: personality.name });
            socket.emit("agent:chunk", { text: chunk, agentName: personality.name });
          }
        },
        { userId: uid, desktopRelay, requestConfirmation, toolPolicy: workSurfaceRoute.toolPolicy || personality.toolPolicy, isCancelled: () => cancelled, llmGetters },
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

      if (cancelled) {
        socket.emit("agent:response", { text: result.text || '任务已取消。', agentName: personality.name });
        socket.emit("agent:status", { status: "idle" });
        return;
      }

      const holoTask = canOutputHolographic(sensory)
        ? textToHolographicOutput(result.text)
        : undefined;
      socket.emit("agent:response", { text: result.text, agentName: personality.name, holographic: holoTask });
      socket.emit("agent:status", { status: "idle" });

      // Log with conversation linkage
      const db = readDB();
      const conv = data.conversationId
        ? (db.conversations || []).find((c: any) => c.id === data.conversationId) || getOrCreateActiveConversation(uid)
        : getOrCreateActiveConversation(uid);
      if (!conv.title) {
        conv.title = data.text.slice(0, 50);
        writeDB(db);
      }
      db.interactions.push({
        id: interactionId,
        content: data.text,
        response: result.text,
        role: "user",
        personality: personality.id,
        timestamp: new Date().toISOString(),
        mode: 'task',
        toolCalls: result.toolCalls.map((tc: any) => ({ name: tc.name, args: tc.arguments })),
        conversationId: conv.id,
      } as any);
      writeDB(db);

      try {
        const learning = persistLumiLearningTurn({
          userId: uid,
          userText: data.text,
          assistantText: result.text,
          channel: 'task',
          flow: turnFlow,
          toolNames: toolRegistry.getToolDeclarations().map(declaration => declaration.function.name),
          toolRecords: result.toolCalls,
          domain: 'personal',
          sourceInteractionId: interactionId,
          agentId: '',
        });
        if (learning.shouldPersist) {
          console.log(`[LumiLearningInterface] task persisted memories=${learning.storedMemories} capability=${learning.capabilityRecord?.id || 'none'} reasons=${learning.reasons.join(',')}`);
        }
      } catch (learnErr: any) {
        console.warn('[LumiLearningInterface] task persistence failed:', learnErr?.message || learnErr);
      }

      // Async memory extraction
      const locationTag = sensory.locationTag || undefined;
      extractMemories(
        {
          userMessage: data.text,
          assistantResponse: result.text,
          existingMemories: relevantMemories.map(m => m.content),
          provider: activeProvider,
          model: activeModel,
          userId: uid,
          locationTag,
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
          } as any, { location: locationTag, source: 'chat' });
        }
        for (const rem of extracted.reminders) {
          addReminder({
            userId: uid,
            content: rem.content,
            dueAt: rem.dueAt,
            sourceInteractionId: db.interactions[db.interactions.length - 1]?.id || '',
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
      const himState = loadHIMState(uid);
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: uid }, himState, data.text.slice(0, 40));
      saveEmotionalState(uid, himUpdated);
      saveHIMState(uid, newHim);

      // ── Persist messages via conversation manager for cross-session continuity ──
      if (convForHistory) {
        addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'user', content: data.text, personality: personality.id });
        if (result.text) {
          addMessage({ userId: uid, agentId: '', conversationId: convForHistory.id, role: 'assistant', content: result.text, personality: personality.id });
        }
        try {
          const topics = extractTopics(data.text + ' ' + result.text);
          for (const topic of topics) trackTopic(convForHistory.id, topic);
        } catch {}
        socket.emit('chat:conversation_updated', { conversationId: convForHistory.id, agentId: '', source: 'task' });
      }

    } catch (err: any) {
      console.error("[Agent Task Error]:", err);
      const cf = handleLLMFailure(cognition?.intent || { category: 'unknown', confidence: 0, entities: {}, needsLLM: true }, err);
      socket.emit("agent:response", { text: cf.responseText, agentName: personality.name });
      socket.emit("agent:status", { status: "error" });
    } finally {
      socket.off('agent:task_cancel', onCancel);
    }
  });
}



