import { runToolSession } from "../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters } from "../llm/provider_getters";
import { createConversationReceiptObserver } from '../conversation/execution_receipt_archive';
import { mergeToolExecutionRecords } from '../cognition/task_execution_ledger';
import { randomUUID } from 'node:crypto';
import { flushDBOrThrow } from '../../db_layer';
import { buildLumiExecutionPipeline } from '../cognition/execution_pipeline';
import { createModelTurnState } from '../llm/model_turn_state';
import { getConversationForScope, startIsolatedConversation, getMessages, addMessageIdempotent, prepareConversationActionExecution, startConversationActionExecutionHeartbeat } from '../conversation/manager';
import { captureConversationAuthorization, combineRequestAuthorizations, runAuthorizedEnrichment } from '../conversation/lifecycle';
import { captureChatAuthorization } from '../socket/chat_authorization';
import { isExplicitMemoryRequest, persistTurnMemory } from '../memory/turn_memory';
import { reserveConversationExecution } from '../cognition/conversation_execution';
import { resolveUserTurn } from '../cognition/turn_resolution';
import { finalizeLumiResponseForDelivery } from '../cognition/response_delivery';
/**
 * Lumi as an MCP Server — exposes Lumi's capabilities as MCP tools
 * so remote devices can connect and invoke Lumi via the MCP protocol.
 *
 * Transport: SSE (HTTP) — devices connect via POST to /mcp/message
 * and receive responses via SSE at /mcp/sse
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { queryMemories, addMemory, getDueReminders, buildNarrativeChain } from '../memory';

import { toolRegistry, ToolRegistry } from '../tools/registry';
import { personalityRegistry } from '../personality';
import { deviceRegistry } from '../devices';
import { canOutputHolographic, textToHolographicOutput } from '../output/holographic';
import { synthesizeSpeech, getActiveProvider } from '../tts/adapter';
import { logger } from '../../logger';
import type { Request, Response } from 'express';
import type { ToolExecutionRecord } from '../tools/types';
import { getScopedPreferredLLM } from '../llm/user_preferences';
import {
  mcpScopeFromAuthUser,
  sameMcpScope,
  type McpCallerScope,
} from './auth';
import {
  restrictSystemPromptForExecutionBoundary,
  restrictToolPolicyForExecutionBoundary,
} from '../tools/remote_policy';
import {
  publicMcpToolFailure,
  sanitizeMcpLogValue,
} from './public_security';
import { CN_MCP_MESSAGES } from '../regions/packs/cn/mcp_messages';
import { attachMcpCallLifecycle, type McpCallLifecycle } from './lifecycle';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// Track active transports per session
const transports: Map<string, { transport: SSEServerTransport; scope: McpCallerScope }> = new Map();

type ToolRecordEvent = Omit<ToolExecutionRecord, 'result'> & { result?: string };

function mcpToolFailure(operation: string, error: unknown) {
  logger.error(`[MCP Tool] ${operation} failed: ${sanitizeMcpLogValue((error as any)?.message || error)}`);
  return {
    content: [{ type: 'text' as const, text: publicMcpToolFailure() }],
    isError: true,
  };
}

function createMcpToolRuntime(llmGetters?: Partial<SharedProviderGetters>, toolReg?: ToolRegistry, broadcast?: (event: string, data: any) => void, callerScope?: McpCallerScope, lifecycle?: McpCallLifecycle) {

  const g = llmGetters || {};
  const tr = toolReg || toolRegistry;
  const bc = broadcast || (() => {});
  const scope: McpCallerScope = callerScope || {
    userId: 'mcp_remote',
    username: 'mcp_remote',
    role: 'user',
    authenticated: false,
    trustedServiceExecution: false,
    domain: 'personal',
    orgId: '',
  };
  const mcpToolSecurityContext = {
    authenticated: scope.authenticated === true,
    authRole: scope.role,
    orgRole: scope.orgRole,
    localExecution: false,
    executionBoundary: 'remote_restricted' as const,
    trustedServiceExecution: scope.trustedServiceExecution === true,
  };
  const memoryScope = {
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  const isWorkViewer = scope.domain === 'work' && scope.orgRole === 'viewer';
  const viewerMutationDenied = () => ({
    content: [{ type: 'text' as const, text: 'This organization role has read-only MCP access.' }],
    isError: true,
  });
  const resolveMcpLLM = () => {
    const preferred = getScopedPreferredLLM(scope.userId, {
      domain: scope.domain,
      orgId: scope.orgId,
    });
    const providerOverride = String(process.env.LUMI_MCP_LLM_PROVIDER || '').trim();
    const modelOverride = String(process.env.LUMI_MCP_LLM_MODEL || '').trim();
    const overridden = Boolean(providerOverride || modelOverride);
    return {
      provider: (providerOverride || preferred.provider) as any,
      model: modelOverride || preferred.model,
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId,
      selectionMode: overridden ? 'pinned' as const : preferred.selectionMode,
      fallbackCandidates: overridden ? [] : preferred.fallbackCandidates,
      allowCloudFallback: overridden ? false : preferred.allowCloudFallback,
      source: 'mcp_remote',
    };
  };
  const mcp = new McpServer({
    name: 'lumi-mcp',
    version: '2.0.0',
  }, {
    capabilities: { tools: {} },
  });
  if (lifecycle) attachMcpCallLifecycle(mcp, lifecycle);

  const chatConversations = new Map<string, string>();
  return { g, tr, bc, scope, mcpToolSecurityContext, memoryScope, isWorkViewer, viewerMutationDenied, resolveMcpLLM, mcp, chatConversations, lifecycle };
}

type McpToolRuntime = ReturnType<typeof createMcpToolRuntime>;

function registerLumiChatTool({ mcp, bc, chatConversations, scope, isWorkViewer, resolveMcpLLM, tr, mcpToolSecurityContext, g, lifecycle, memoryScope }: Pick<McpToolRuntime, "mcp" | "bc" | "chatConversations" | "scope" | "isWorkViewer" | "resolveMcpLLM" | "tr" | "mcpToolSecurityContext" | "g" | "lifecycle" | "memoryScope">) {


  // Tool: send a chat message to Lumi
  mcp.registerTool(
    'lumi_chat',
    {
      description: 'Send a message to Lumi and get an AI-powered response. Lumi will use its personality, memory, and tool capabilities.',
      inputSchema: {
        message: z.string().describe('The message to send to Lumi'),
        personalityId: z.string().optional().describe('Personality to use (default: "lumi")'),
        conversationId: z.string().optional().describe('Resume an owned conversation returned by lumi_chat.'),
      },
    },
    async ({ message, personalityId, conversationId: requestedConversationId }) => {
      const requestId = randomUUID();
      const pid = personalityId || 'lumi';
      let conversationId = '';
      const emit = (event: string, data: any) => bc(event, { ...data, requestId, conversationId, source: 'mcp_chat' });
      try {
        const priorId = requestedConversationId || chatConversations.get(pid);
        const candidate = priorId ? getConversationForScope(priorId, scope.userId, scope.domain, scope.orgId) : null;
        const prior = candidate?.agentId === pid ? candidate : null;
        if (requestedConversationId && !prior) throw new Error('Conversation is unavailable in this scope');
        conversationId = prior?.id || startIsolatedConversation(scope.userId, pid, scope.domain, scope.orgId).id;
        chatConversations.set(pid, conversationId);
        const authorization = combineRequestAuthorizations(captureChatAuthorization(scope.userId, scope),
          captureConversationAuthorization({ ...scope, agentId: pid }, () => conversationId));
        authorization.assertCurrent();
        const identity = { userId: scope.userId, agentId: pid, conversationId, requestId, domain: scope.domain, orgId: scope.orgId, source: 'mcp_chat', channel: 'chat' };
        const modelTurnState = createModelTurnState();
        const explicitMemory = !isWorkViewer && isExplicitMemoryRequest(message);
        let taskId: string | undefined;
        let turnRowId: string | undefined;
        let receiptObserver: ReturnType<typeof createConversationReceiptObserver> | undefined;
        const controller = new AbortController();
        let pipeline: ReturnType<typeof buildLumiExecutionPipeline>;
        const chatLLM = resolveMcpLLM();
        emit('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'received' });
        emit('agent:status', { status: 'thinking', agentName: 'Lumi' });
        const personality = personalityRegistry.getForUser(pid, scope.userId, scope.orgId) || personalityRegistry.getDefault();
        const acceptedResolution = resolveUserTurn({ requestId, userText: message, state: prior?.actionContinuationState });
        const ds = deviceRegistry.getSensoryContext(scope.userId, {
          domain: scope.domain,
          orgId: scope.orgId,
        });
        const sensory = {
          audio: ds.hasAudio,
          visual: ds.hasVideo,
          spatial: ds.hasSpatial,
          haptic: ds.hasHaptic,
          holographic: ds.hasHolographic,
          activeDeviceTypes: ds.activeDeviceTypes,
          deviceCount: ds.deviceCount,
        };

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

        const MCP_TIMEOUT_MS = 25000;
        const mcpToolRecords: ToolExecutionRecord[] = [];
        const bufferedChunks: string[] = [];

        const recordMcpChatTool = (record: ToolRecordEvent) => {
            if (record.result === undefined && record.error === undefined) return;
            mcpToolRecords.splice(0, mcpToolRecords.length, ...mergeToolExecutionRecords(mcpToolRecords, [{ ...record, result: record.result || '' }]));
            const cid = record.id || randomUUID();
            emit('agent:tool_call', { correlationId: cid, name: record.name, status: 'started' });
            if (record.error) {
              logger.warn(`[MCP Tool] ${record.name} returned an error: ${sanitizeMcpLogValue(record.error)}`);
              emit('agent:tool_call', { correlationId: cid, name: record.name, status: 'failed', error: 'Tool execution failed.' });
            } else {
              emit('agent:tool_call', { correlationId: cid, name: record.name, status: 'completed', result: 'completed' });
            }
        };
        const runMcpChatTurn = (
          turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
          onToolRecord?: (record: ToolRecordEvent) => void,
          onChunk?: (chunk: string) => void,
          source = 'mcp_chat',
        ) => runToolSession({
          messages: turnMessages,
          registry: tr,
          config: {
            ...chatLLM,
            maxTokens: 2048,
            modelTurnState,
            requestId, conversationId,
            signal: controller.signal,
          },
          onToolCall: onToolRecord,
          maxIterations: Math.min(4, pipeline.authorizationPolicy.maxIterations),
          onStreamChunk: onChunk,
          context: {
            userId: scope.userId,
            domain: scope.domain,
            orgId: scope.orgId,
            toolPolicy: pipeline.authorizationPolicy,
            requestId, conversationId, taskId, turnRowId, turnId: requestId,
             resolutionId: pipeline.resolution.id,
            currentTurnExecutionRequested: pipeline.executionRequested,
            modelToolProjection: pipeline.modelToolProjection,
            onToolRecord: record => receiptObserver?.onToolRecord(record),
            isCancelled: () => controller.signal.aborted || !authorization.isCurrent(),
            executionSignal: controller.signal,
            source,
            ...mcpToolSecurityContext,
          } as any,
          getters: { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null), getOpenAI: g.getOpenAI || (() => null), getAnthropic: g.getAnthropic || (() => null), getQwen: g.getQwen || (() => null) },
        });
        const deliverFinalizedChatResponse = async (
          response: Awaited<ReturnType<typeof runToolSession>>,
          background: boolean,
        ) => {
          const toolRecords = mergeToolExecutionRecords(mcpToolRecords, response.toolCalls || []);
          const candidateText = String(response.text || bufferedChunks.join('') || 'No response.').trim();
          const outbound = await finalizeLumiResponseForDelivery({
            taskText: message,
            responseText: candidateText,
            toolRecords,
            source: background ? 'mcp_chat_background' : 'mcp_chat',
            allowToolUse: pipeline.executionRequested && !explicitMemory,
            attempt: async ({ instruction, recordTool }) => {
              const recovery = await runMcpChatTurn(
                [
                  ...messages,
                  ...(candidateText
                    ? [{ role: 'assistant' as const, content: candidateText }]
                    : []),
                  { role: 'user', content: instruction },
                ],
                record => {
                  recordMcpChatTool(record);
                  if (record.result !== undefined || record.error !== undefined) {
                    recordTool({
                      id: record.id,
                      name: record.name,
                      arguments: record.arguments || {},
                      result: record.result || '',
                      error: record.error,
                    });
                  }
                },
                undefined,
                'mcp_chat_guard_recovery',
              );
              return {
                text: recovery.text,
                toolRecords: recovery.toolCalls,
              };
            },
          });
          let finalized = outbound.finalization;
          toolRecords.splice(0, toolRecords.length, ...outbound.toolRecords);
          authorization.assertCurrent();
          if ((explicitMemory || personality.memoryPolicy.autoExtract) && !isWorkViewer) {
            const extraction = runAuthorizedEnrichment(authorization, signal => persistTurnMemory({ ...identity, channel: 'chat', userText: message, authorization, signal,
              llmGetters: { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null) } }));
            if (explicitMemory) {
              const receipt = await extraction;
              finalized = { ...finalized, text: receipt.text || publicMcpToolFailure(), blocked: receipt.status === 'failed' || receipt.status === 'skipped', reason: `memory_${receipt.status}` };
            } else lifecycle?.track(extraction);
          }
          authorization.assertCurrent();
          addMessageIdempotent({ ...identity, role: 'assistant', content: finalized.text, toolCalls: toolRecords, cognitiveIntent: finalized.reason || 'mcp_chat' });
          await flushDBOrThrow();
          authorization.assertCurrent();

          const metadata = {
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          };
          const holo = canOutputHolographic(sensory)
            ? textToHolographicOutput(finalized.text)
            : undefined;
          emit('mcp:activity', {
            device: 'xiaozhi',
            action: 'chat',
            status: finalized.blocked ? 'blocked' : 'responded',
            toolCalls: toolRecords.length,
            background,
            ...metadata,
          });
          // Raw model chunks stay buffered. Only grounded final text can reach
          // either the MCP chunk stream or the shared response channel.
          emit('mcp:chunk', {
            device: 'xiaozhi',
            text: finalized.text,
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          });
          emit('agent:response', {
            text: finalized.text,
            agentName: 'Lumi',
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          });
          emit('agent:status', { status: 'idle', agentName: 'Lumi' });
          console.log('[MCP lumi_chat] Finalized response length:', finalized.text.length, 'chars, toolCalls:', toolRecords.length, 'blocked:', finalized.blocked);

          let audioBase64: string | undefined;
          let audioFormat: string | undefined;
          try {
            const provider = getActiveProvider();
            const voiceId = personality.ttsVoiceId || 'longxiaochun_v3';
            const ttsResult = await synthesizeSpeech(finalized.text, { provider, voiceId });
            audioBase64 = ttsResult.audioBuffer.toString('base64');
            audioFormat = ttsResult.format;
            authorization.assertCurrent();
            emit('mcp:activity', { device: 'xiaozhi', action: 'tts', status: 'synthesized', bytes: ttsResult.audioBuffer.length, ...metadata });
          } catch (ttsErr: any) {
            console.error('[MCP TTS] Synthesis failed:', ttsErr.message);
          }

          authorization.assertCurrent();
          if (background) {
            emit('mcp:proactive', {
              device: 'xiaozhi',
              text: finalized.text,
              ...(audioBase64 && { audio: audioBase64, format: audioFormat }),
              ...metadata,
            });
          }

          return { finalized, holo, audioBase64, audioFormat };
        };

        let background = false;
        const admission = reserveConversationExecution({ ...scope, conversationId }, requestId, controller.signal);
        const stopWatch = authorization.watch(controller);
        const responsePromise = (async () => {
          try {
          await admission.waitForTurn();
          authorization.assertCurrent();
          // Read memory after prior queued turns have durably completed.
          const memories = queryMemories({
            ...memoryScope,
            limit: personality.memoryPolicy.retrieveLimit,
            minConfidence: personality.memoryPolicy.minConfidence,
          });
          const memoryContext = memories.length > 0
            ? memories.map(m => `[${m.type}] ${m.content}`).join('\n')
            : '';

          pipeline = buildLumiExecutionPipeline({ requestId, acceptedResolution, dispatch: { userId: scope.userId, text: message, channel: 'chat', source: 'mcp_chat', domain: scope.domain, orgId: scope.orgId },
            registry: tr, personalityToolPolicy: personality.toolPolicy, executionBoundary: 'remote_restricted',
            actionTaskState: getConversationForScope(conversationId, scope.userId, scope.domain, scope.orgId)?.actionContinuationState });
          const { systemPrompt } = personalityRegistry.buildSystemPrompt(pid, { mode: pipeline.executionRequested ? 'task' : 'chat', sensory }, { ...memoryScope, userText: message });
          messages.push({ role: 'system', content: restrictSystemPromptForExecutionBoundary(systemPrompt, 'remote_restricted') + (memoryContext ? `\n\n## User context (memories):${memoryContext}` : '') });
          messages.push(...getMessages(conversationId, 30).filter(row => row.role === 'user' || row.role === 'assistant')
            .map(row => ({ role: row.role as 'user' | 'assistant', content: row.message })));
          messages.push({ role: 'user', content: message });

          const userMessageId = addMessageIdempotent({ ...identity, role: 'user', content: message, deferActionPreparation: true });
          const prepared = prepareConversationActionExecution({ ...identity, userText: message, userMessageId,
            toolPolicy: pipeline.authorizationPolicy, forceTask: pipeline.executionRequested, followupIntent: pipeline.actionFollowupIntent, forceResume: pipeline.trustedActionContinuation, preserveExistingTask: pipeline.taskRelation.binding === 'active_task' });
          if ('bindingFailure' in prepared) throw new Error('Conversation turn cannot be admitted');
          taskId = prepared.state?.taskId;
          turnRowId = prepared.turnRowId;
          receiptObserver = createConversationReceiptObserver({ ...identity, taskId, turnRowId }, authorization.isCurrent);
          await flushDBOrThrow();
          const heartbeat = startConversationActionExecutionHeartbeat({ ...identity, abortController: controller });
          try {
            const response = explicitMemory ? { text: '', toolCalls: [], usageRecords: [] }
              : await runMcpChatTurn(messages, recordMcpChatTool, chunk => bufferedChunks.push(chunk));
            return await deliverFinalizedChatResponse(response, background);
          } catch (error) {
            if (authorization.isCurrent()) {
              addMessageIdempotent({ ...identity, role: 'assistant', content: publicMcpToolFailure(), toolCalls: mcpToolRecords, cognitiveIntent: 'mcp_operation_failed' });
              await flushDBOrThrow();
            }
            throw error;
          } finally { heartbeat.stop(); }
          } finally { admission.release(); stopWatch(); }
        })();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('MCP_TIMEOUT')), MCP_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });

        let delivered: Awaited<typeof responsePromise>;
        try {
          delivered = await Promise.race([responsePromise, timeoutPromise]);
          if (timeoutHandle) clearTimeout(timeoutHandle);
        } catch (e: any) {
          if (e.message === 'MCP_TIMEOUT') {
            background = true;
            console.log('[MCP lumi_chat] Timeout — continuing in background');
            emit('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'timeout' });
            emit('agent:status', { status: 'idle', agentName: 'Lumi' });
            const backgroundWork = responsePromise
              .catch((backgroundErr: any) => {
                logger.error(`[MCP Tool] background chat failed: ${sanitizeMcpLogValue(backgroundErr?.message || backgroundErr)}`);
                const publicFailure = publicMcpToolFailure();
                emit('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'failed', reason: 'mcp_operation_failed' });
                emit('agent:response', {
                  text: publicFailure,
                  agentName: 'Lumi',
                  finalized: true,
                  blocked: true,
                  reason: 'mcp_operation_failed',
                });
                emit('agent:status', { status: 'error', agentName: 'Lumi' });
              });
            lifecycle?.track(backgroundWork);
            return {
              content: [{ type: 'text' as const, text: '正在处理中，稍等片刻...' }],
              finalized: false,
              blocked: false,
              reason: 'background_processing',
              requestId, conversationId,
            };
          }
          if (timeoutHandle) clearTimeout(timeoutHandle);
          throw e;
        }


        return {
          content: [{ type: 'text' as const, text: delivered.finalized.text }],
          ...(delivered.holo && { holographic: delivered.holo }),
          ...(delivered.audioBase64 && { audio: delivered.audioBase64, audioFormat: delivered.audioFormat }),
          requestId, conversationId,
          finalized: true,
          blocked: delivered.finalized.blocked,
          reason: delivered.finalized.reason || '',
        };
      } catch (err: any) {
        logger.error(`[MCP Tool] chat failed: ${sanitizeMcpLogValue(err?.message || err)}`);
        const publicFailure = publicMcpToolFailure();
        emit('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'failed', reason: 'mcp_operation_failed' });
        emit('agent:error', { message: publicFailure, reason: 'mcp_operation_failed' });
        emit('agent:status', { status: 'error', agentName: 'Lumi' });
        return {
          content: [{ type: 'text' as const, text: publicFailure }],
          isError: true,
          finalized: true,
          blocked: true,
          reason: 'mcp_operation_failed',
        };
      }
    },
  );
}

function registerLumiMemorySearchTool({ mcp, memoryScope }: Pick<McpToolRuntime, "mcp" | "memoryScope">) {


  // Tool: search memories
  mcp.registerTool(
    'lumi_memory_search',
    {
      description: 'Search Lumi\'s memory for facts, preferences, habits, and knowledge about the user.',
      inputSchema: {
        query: z.string().optional().describe('Search query (keyword match in content and keywords)'),
        type: z.enum(['preference', 'fact', 'habit', 'knowledge']).optional().describe('Filter by memory type'),
        limit: z.number().optional().default(10).describe('Max number of results (default 10)'),
      },
    },
    async ({ query, type, limit }) => {
      try {
        const memories = queryMemories({ ...memoryScope, query, type, limit });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(memories.map(m => ({
              id: m.id,
              type: m.type,
              content: m.content,
              keywords: m.keywords,
              confidence: Math.round(m.confidence * 100) + '%',
              retrieved: m.retrieveCount + 'x',
            })), null, 2),
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('memory search', err);
      }
    },
  );
}

function registerLumiMemoryAddTool({ mcp, isWorkViewer, viewerMutationDenied, scope }: Pick<McpToolRuntime, "mcp" | "isWorkViewer" | "viewerMutationDenied" | "scope">) {


  // Tool: add a memory
  mcp.registerTool(
    'lumi_memory_add',
    {
      description: 'Teach Lumi something new — add a memory entry about a user preference, fact, habit, or knowledge.',
      inputSchema: {
        type: z.enum(['preference', 'fact', 'habit', 'knowledge']).describe('Type of memory'),
        content: z.string().describe('What Lumi should remember'),
        keywords: z.array(z.string()).optional().describe('Search keywords for this memory'),
      },
    },
    async ({ type, content, keywords }) => {
      try {
        if (isWorkViewer) return viewerMutationDenied();
        const kw = keywords || content.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const entry = addMemory({
          userId: scope.userId,
          type,
          content,
          keywords: kw,
          confidence: 0.7,
          sourceInteractionId: 'mcp_manual',
        }, {
          domain: scope.domain,
          orgId: scope.orgId,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Memory added: [${entry.type}] ${entry.content} (${kw.length} keywords)`,
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('memory add', err);
      }
    },
  );
}

function registerLumiReminderListTool({ mcp, memoryScope }: Pick<McpToolRuntime, "mcp" | "memoryScope">) {


  // Tool: list reminders
  mcp.registerTool(
    'lumi_reminder_list',
    {
      description: 'Get all pending reminders that Lumi is tracking.',
      inputSchema: {},
    },
    async () => {
      try {
        const reminders = getDueReminders(memoryScope);
        return {
          content: [{
            type: 'text' as const,
            text: reminders.length === 0
              ? 'No pending reminders.'
              : JSON.stringify(reminders.map(r => ({
                  id: r.id,
                  content: r.content,
                  dueAt: r.dueAt,
                  status: r.status,
                })), null, 2),
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('reminder list', err);
      }
    },
  );
}

function registerLumiSpeakTool({ mcp, bc }: Pick<McpToolRuntime, "mcp" | "bc">) {



  // Tool: proactive speak — Lumi pushes TTS audio to xiaozhi
  mcp.registerTool(
    'lumi_speak',
    {
      description: 'Synthesize speech from text and return audio. Used for Lumi to proactively speak through the xiaozhi device — notifications, reminders, or unprompted comments.',
      inputSchema: {
        text: z.string().describe('The text Lumi should speak'),
        voiceId: z.string().optional().describe('TTS voice ID (default uses Lumi personality voice)'),
      },
    },
    async ({ text, voiceId }) => {
      try {
        const outbound = await finalizeLumiResponseForDelivery({
          taskText: `Proactive speech request: ${text}`,
          responseText: text,
          toolRecords: [],
          source: 'mcp_speak',
        });
        const finalized = outbound.finalization;
        if (finalized.blocked) {
          bc('mcp:activity', {
            device: 'xiaozhi',
            action: 'speak',
            status: 'blocked',
            finalized: true,
            blocked: true,
            reason: finalized.reason || '',
          });
          return {
            content: [{ type: 'text' as const, text: finalized.text }],
            isError: true,
            finalized: true,
            blocked: true,
            reason: finalized.reason || '',
          };
        }

        const provider = getActiveProvider();
        const vid = voiceId || 'longxiaochun_v3';
        const ttsResult = await synthesizeSpeech(finalized.text, { provider, voiceId: vid });
        const audioBase64 = ttsResult.audioBuffer.toString('base64');
        bc('mcp:activity', {
          device: 'xiaozhi',
          action: 'speak',
          bytes: ttsResult.audioBuffer.length,
          finalized: true,
          blocked: false,
          reason: '',
        });
        bc('mcp:proactive', {
          text: finalized.text,
          audio: audioBase64,
          format: ttsResult.format,
          finalized: true,
          blocked: false,
          reason: '',
        });
        return {
          content: [{ type: 'text' as const, text: `Speech synthesized (${ttsResult.audioBuffer.length} bytes, ${ttsResult.format})` }],
          audio: audioBase64,
          audioFormat: ttsResult.format,
          finalized: true,
          blocked: false,
          reason: '',
        };
      } catch (err: any) {
        logger.error(`[MCP Tool] speech synthesis failed: ${sanitizeMcpLogValue(err?.message || err)}`);
        return {
          content: [{ type: 'text' as const, text: publicMcpToolFailure() }],
          isError: true,
          finalized: true,
          blocked: true,
          reason: 'mcp_operation_failed',
        };
      }
    },
  );
}

function registerLumiNarrativeTool({ mcp, scope, g }: Pick<McpToolRuntime, "mcp" | "scope" | "g">) {


  // Tool: memory narrative chain — weave related memories into a chronological story
  mcp.registerTool(
    'lumi_narrative',
    {
      description: '将分散的记忆片段按时间顺序编织成连贯的第一人称中文叙事。输入一个主题，Lumi 会搜索相关记忆并生成叙事故事。',
      inputSchema: {
        topic: z.string().describe('叙事主题，用于搜索相关记忆'),
        limit: z.number().optional().default(10).describe('最大记忆数量'),
      },
    },
    async ({ topic, limit }) => {
      try {
        const result = await buildNarrativeChain({
          userId: scope.userId,
          domain: scope.domain,
          orgId: scope.orgId,
          topic,
          limit,
          getDeepSeek: g.getDeepSeek || (() => null),
          getGemini: g.getGemini || (() => null),
          getOpenAI: g.getOpenAI,
          getAnthropic: g.getAnthropic,
          getQwen: g.getQwen || (() => null),
          getOllama: g.getOllama,
          getLmStudio: g.getLmStudio,
          getArk: g.getArk,
          getXiaomi: g.getXiaomi,
          getKimi: g.getKimi,
          getGlm: g.getGlm,
          getRelay: g.getRelay,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              narrative: result.narrative,
              sourceMemoryIds: result.sourceMemoryIds,
              chainLength: result.memoryChain.length,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('memory narrative', err);
      }
    },
  );
}

function registerLumiRouteTaskTool({ mcp, isWorkViewer, viewerMutationDenied, resolveMcpLLM, scope, bc, tr, mcpToolSecurityContext, g }: Pick<McpToolRuntime, "mcp" | "isWorkViewer" | "viewerMutationDenied" | "resolveMcpLLM" | "scope" | "bc" | "tr" | "mcpToolSecurityContext" | "g">) {


  // Execute a task through the same single LumiCore model/tool loop.
  mcp.registerTool(
    'lumi_route_task',
    {
      description: CN_MCP_MESSAGES.routeTaskDescription,
      inputSchema: {
        task: z.string().describe(CN_MCP_MESSAGES.routeTaskInputDescription),
      },
    },
    async ({ task }) => {
      try {
        if (isWorkViewer) return viewerMutationDenied();
        const routeLLM = resolveMcpLLM();
        const personality = personalityRegistry.getForUser('lumi', scope.userId, scope.orgId) || personalityRegistry.getDefault();
        const { systemPrompt } = personalityRegistry.buildSystemPrompt('lumi', {
          mode: 'task',
          sensory: {
            audio: false,
            visual: false,
            spatial: false,
            haptic: false,
            holographic: false,
            activeDeviceTypes: [],
            deviceCount: 0,
          },
        }, { userId: scope.userId, domain: scope.domain, orgId: scope.orgId, userText: task });
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          {
            role: 'system',
            content: restrictSystemPromptForExecutionBoundary(systemPrompt, 'remote_restricted'),
          },
          { role: 'user', content: task },
        ];
        bc('mcp:activity', { device: 'xiaozhi', action: 'route_task', status: 'received' });

        const runMcpTaskTurn = (
          turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
          onToolRecord?: (record: ToolRecordEvent) => void,
          source = 'mcp_route_task',
        ) => runToolSession({
          messages: turnMessages,
          registry: tr,
          config: { ...routeLLM, maxTokens: 4096 },
          onToolCall: onToolRecord,
          maxIterations: Math.min(8, personality.toolPolicy.maxIterations),
          context: {
            ...mcpToolSecurityContext,
            userId: scope.userId,
            domain: scope.domain,
            orgId: scope.orgId,
            source,
            toolPolicy: restrictToolPolicyForExecutionBoundary(
              personality.toolPolicy,
              'remote_restricted',
            ),
          } as any,
          getters: { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null), getOpenAI: g.getOpenAI || (() => null), getAnthropic: g.getAnthropic || (() => null), getQwen: g.getQwen || (() => null) },
        });

        const result = await runMcpTaskTurn(messages);
        const outbound = await finalizeLumiResponseForDelivery({
          taskText: task,
          responseText: result.text,
          toolRecords: result.toolCalls,
          source: 'mcp_route_task',
          allowToolUse: true,
          attempt: async ({ instruction, recordTool }) => {
            const recovery = await runMcpTaskTurn(
              [
                ...messages,
                ...(String(result.text || '').trim()
                  ? [{ role: 'assistant' as const, content: result.text }]
                  : []),
                { role: 'user', content: instruction },
              ],
              record => {
                if (record.result !== undefined || record.error !== undefined) {
                  recordTool({
                    id: record.id,
                    name: record.name,
                    arguments: record.arguments || {},
                    result: record.result || '',
                    error: record.error,
                  });
                }
              },
              'mcp_route_task_guard_recovery',
            );
            return { text: recovery.text, toolRecords: recovery.toolCalls };
          },
        });
        const finalized = outbound.finalization;
        bc('mcp:activity', {
          device: 'xiaozhi',
          action: 'route_task',
          status: finalized.blocked ? 'blocked' : 'responded',
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason || '',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              handledBy: 'LumiCore',
              result: finalized.text,
              toolCalls: outbound.toolRecords.length,
              finalized: true,
              blocked: finalized.blocked,
              reason: finalized.reason || '',
            }, null, 2),
          }],
        };
      } catch (err: any) {
        bc('mcp:activity', {
          device: 'xiaozhi',
          action: 'route_task',
          status: 'failed',
          reason: 'mcp_operation_failed',
        });
        return mcpToolFailure('task execution', err);
      }
    },
  );
}

export function createLumiMcpServer(llmGetters?: Partial<SharedProviderGetters>, toolReg?: ToolRegistry, broadcast?: (event: string, data: any) => void, callerScope?: McpCallerScope, lifecycle?: McpCallLifecycle): McpServer {
  const runtime = createMcpToolRuntime(llmGetters, toolReg, broadcast, callerScope, lifecycle);
  registerLumiChatTool(runtime);
  registerLumiMemorySearchTool(runtime);
  registerLumiMemoryAddTool(runtime);
  registerLumiReminderListTool(runtime);
  registerLumiSpeakTool(runtime);
  registerLumiNarrativeTool(runtime);
  registerLumiRouteTaskTool(runtime);
  return runtime.mcp;
}



/**
 * Handle SSE connection — create transport and add to the Lumi MCP server.
 */
export async function handleMcpSSE(
  mcpServer: McpServer,
  req: Request,
  res: Response,
  callerScope?: McpCallerScope,
  onTransport?: (transport: Transport) => void,
) {
  try {
    const scope = callerScope || mcpScopeFromAuthUser(req.user);
    if (!scope) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const transport = new SSEServerTransport('/mcp/message', res);
    onTransport?.(transport);
    transports.set(transport.sessionId, { transport, scope });

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  } catch (err: any) {
    logger.error(`[MCP Server] SSE connection error: ${sanitizeMcpLogValue(err?.message || err)}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP SSE connection failed' });
    }
  }
}

/**
 * Handle incoming MCP messages (JSON-RPC via HTTP POST).
 */
export async function handleMcpMessage(req: Request, res: Response) {
  try {
    // The authenticated POST must name, and own, the SSE session explicitly.
    const requestScope = mcpScopeFromAuthUser(req.user);
    if (!requestScope) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const sessionId = String(req.query.sessionId || '').trim();
    let session: { transport: SSEServerTransport; scope: McpCallerScope } | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'MCP sessionId is required. Connect to /mcp/sse first.' });
      return;
    }
    session = transports.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'MCP session not found or expired.' });
      return;
    }

    if (!sameMcpScope(session.scope, requestScope)) {
      res.status(403).json({ error: 'MCP session does not belong to the authenticated user scope.' });
      return;
    }

    await session.transport.handlePostMessage(req, res);
  } catch (err: any) {
    logger.error(`[MCP Server] Message error: ${sanitizeMcpLogValue(err?.message || err)}`);
    res.status(500).json({ error: 'MCP message handling failed' });
  }
}
