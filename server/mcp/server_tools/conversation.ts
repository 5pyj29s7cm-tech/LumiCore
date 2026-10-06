import { runResolvedLumiTurn } from "../../cognition/turn_model";
import { bindCapabilityExecutionPlanTask } from "../../cognition/capability_execution_plan";
import { TASK_TARGET_HISTORY_LIMIT } from "../../conversation/task_target_anchor";
import { resolveConversationForEntry } from "../../conversation/entry_conversation";

import { createConversationReceiptObserver } from "../../conversation/execution_receipt_archive";
import { mergeToolExecutionRecords } from "../../cognition/task_execution_ledger";
import { randomUUID } from "node:crypto";
import { flushDBOrThrow } from "../../../db_layer";
import { buildLumiExecutionPipeline } from "../../cognition/execution_pipeline";
import { createModelTurnState } from "../../llm/model_turn_state";
import { getConversationForScope, getMessages, addMessageIdempotent, prepareConversationActionExecution, persistConversationExecutionPlan, startConversationActionExecutionHeartbeat } from "../../conversation/manager";
import { captureConversationAuthorization, combineRequestAuthorizations, runAuthorizedEnrichment } from "../../conversation/lifecycle";
import { captureChatAuthorization } from "../../socket/chat_authorization";
import { isExplicitMemoryRequest, persistTurnMemory } from "../../memory/turn_memory";
import { reserveConversationExecution } from "../../cognition/conversation_execution";
import { resolveUserTurn } from "../../cognition/turn_resolution";
import { finalizeLumiResponseForDelivery } from "../../cognition/response_delivery";
import { queryMemories } from "../../memory";
import { personalityRegistry } from "../../personality";
import { deviceRegistry } from "../../devices";
import { canOutputHolographic, textToHolographicOutput } from "../../output/holographic";
import { synthesizeSpeech, getActiveProvider } from "../../tts/adapter";
import { logger } from "../../../logger";
import type { ToolExecutionRecord } from "../../tools/types";
import { restrictSystemPromptForExecutionBoundary } from "../../tools/remote_policy";
import { publicMcpToolFailure, sanitizeMcpLogValue } from "../public_security";
import { CN_MCP_MESSAGES } from "../../regions/messages/mcp_messages";
import type { McpToolRuntime, McpConversationInput, McpConversationEntry, ToolRecordEvent } from './contracts';

export async function runMcpConversationTurn({ mcp, bc, chatConversations, scope, isWorkViewer, resolveMcpLLM, tr, mcpToolSecurityContext, g, lifecycle, memoryScope }: Pick<McpToolRuntime, "mcp" | "bc" | "chatConversations" | "scope" | "isWorkViewer" | "resolveMcpLLM" | "tr" | "mcpToolSecurityContext" | "g" | "lifecycle" | "memoryScope">, { message, personalityId, conversationId: requestedConversationId }: McpConversationInput, entry: McpConversationEntry) {
      const requestId = randomUUID();
      const pid = personalityId || 'lumi';
      let conversationId = '';
      const emit = (event: string, data: any) => bc(event, { ...data, requestId, conversationId, source: entry.source });
      try {
        const prior = resolveConversationForEntry(scope.userId, scope, {
          kind: 'mcp', agentId: pid, resumeConversationId: chatConversations.get(pid),
        }, requestedConversationId);
        if (!prior) throw new Error('Conversation is unavailable in this scope');
        conversationId = prior.id;
        chatConversations.set(pid, conversationId);
        const authorization = combineRequestAuthorizations(captureChatAuthorization(scope.userId, scope),
          captureConversationAuthorization({ ...scope, agentId: pid }, () => conversationId));
        authorization.assertCurrent();
        const identity = { userId: scope.userId, agentId: pid, conversationId, requestId, domain: scope.domain, orgId: scope.orgId, source: entry.source, channel: 'chat' };
        const modelTurnState = createModelTurnState();
        const explicitMemory = entry.turnMemory && !isWorkViewer && isExplicitMemoryRequest(message);
        let taskId: string | undefined;
        let turnRowId: string | undefined;
        let receiptObserver: ReturnType<typeof createConversationReceiptObserver> | undefined;
        const controller = new AbortController();
        let pipeline: ReturnType<typeof buildLumiExecutionPipeline>;
        const chatLLM = resolveMcpLLM();
        emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'received' });
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
          source: string = entry.source,
        ) => runResolvedLumiTurn({
      execution: pipeline,
          assertCurrent: () => authorization.assertCurrent(),
          streaming: false,
          messages: turnMessages,
          registry: tr,
          config: {
            ...chatLLM,
            maxTokens: entry.maxTokens,
            modelTurnState,
            requestId, conversationId,
            signal: controller.signal,
          },
          onToolCall: onToolRecord,
          maxIterations: Math.min(entry.maxIterations, pipeline.authorizationPolicy.maxIterations),
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
            actionIntent: message, routedTaskText: pipeline.turnIntent.flow.routeText,
            trustedActionContinuation: pipeline.trustedActionContinuation,
            acceptedTaskTarget: pipeline.turnIntent.flow.acceptedTaskTarget,
            onToolRecord: record => receiptObserver?.onToolRecord(record),
            isCancelled: () => controller.signal.aborted || !authorization.isCurrent(),
            executionSignal: controller.signal,
            source,
            ...mcpToolSecurityContext,
          } as any,
          getters: { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null), getOpenAI: g.getOpenAI || (() => null), getAnthropic: g.getAnthropic || (() => null), getQwen: g.getQwen || (() => null) },
        });
        const deliverFinalizedChatResponse = async (
          response: Awaited<ReturnType<typeof runResolvedLumiTurn>>,
          background: boolean,
        ) => {
          const toolRecords = mergeToolExecutionRecords(mcpToolRecords, response.toolCalls || []);
          const candidateText = String(response.text || bufferedChunks.join('') || 'No response.').trim();
          const outbound = await finalizeLumiResponseForDelivery({
            taskText: message,
            responseText: candidateText,
            completionGuard: response.completionGuard,
            toolRecords,
            source: background ? entry.source + '_background' : entry.source,
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
                entry.source + '_guard_recovery',
              );
              return {
                text: recovery.text,
                completionGuard: recovery.completionGuard,
                toolRecords: recovery.toolCalls,
              };
            },
          });
          let finalized = outbound.finalization;
          toolRecords.splice(0, toolRecords.length, ...outbound.toolRecords);
          authorization.assertCurrent();
          if (entry.turnMemory && (explicitMemory || personality.memoryPolicy.autoExtract && !finalized.blocked) && !isWorkViewer) {
            const extraction = runAuthorizedEnrichment(authorization, signal => persistTurnMemory({ ...identity, channel: 'chat', userText: message, authorization, signal,
              llmGetters: { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null) } }));
            if (explicitMemory) {
              const receipt = await extraction;
              finalized = { ...finalized, text: receipt.text || publicMcpToolFailure(), blocked: receipt.status === 'failed' || receipt.status === 'skipped', reason: `memory_${receipt.status}` };
            } else lifecycle?.track(extraction);
          }
          authorization.assertCurrent();
          addMessageIdempotent({ ...identity, role: 'assistant', content: finalized.text, toolCalls: toolRecords, cognitiveIntent: finalized.reason || entry.source });
          await flushDBOrThrow();
          authorization.assertCurrent();

          const metadata = {
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          };
          const holo = entry.responseMedia && canOutputHolographic(sensory)
            ? textToHolographicOutput(finalized.text)
            : undefined;
          emit('mcp:activity', {
            device: 'xiaozhi',
            action: entry.action,
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
          if (entry.responseMedia) {
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

          return { finalized, holo, audioBase64, audioFormat, toolCalls: toolRecords.length };
        };

        let background = false;
        const admission = reserveConversationExecution({ ...scope, conversationId, source: entry.source }, requestId, controller.signal,
          { authorization, abort: reason => { if (!controller.signal.aborted) controller.abort(reason); } });
        const responsePromise = (async () => {
          try {
          await admission.waitForTurn();
          authorization.assertCurrent();
          // Read memory after prior queued turns have durably completed.
          const memories = entry.turnMemory ? queryMemories({
            ...memoryScope,
            limit: personality.memoryPolicy.retrieveLimit,
            minConfidence: personality.memoryPolicy.minConfidence,
          }) : [];
          const memoryContext = memories.length > 0
            ? memories.map(m => `[${m.type}] ${m.content}`).join('\n')
            : '';

          pipeline = buildLumiExecutionPipeline({ requestId, acceptedResolution, dispatch: { userId: scope.userId, text: message, channel: 'chat', source: entry.source, category: entry.action === 'route_task' ? 'command' : undefined, domain: scope.domain, orgId: scope.orgId },
            registry: tr, personalityToolPolicy: personality.toolPolicy, executionBoundary: 'remote_restricted',
            actionTaskState: getConversationForScope(conversationId, scope.userId, scope.domain, scope.orgId)?.actionContinuationState,
            persistedConversationHistory: getMessages(conversationId, TASK_TARGET_HISTORY_LIMIT) });
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
          if (taskId) {
            pipeline.executionPlan = bindCapabilityExecutionPlanTask(pipeline.executionPlan, taskId);
            persistConversationExecutionPlan({ conversationId, userId: scope.userId, plan: pipeline.executionPlan });
          }
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
          } finally { admission.release(); }
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
            emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'timeout' });
            emit('agent:status', { status: 'idle', agentName: 'Lumi' });
            const backgroundWork = responsePromise
              .catch((backgroundErr: any) => {
                logger.error(`[MCP Tool] background chat failed: ${sanitizeMcpLogValue(backgroundErr?.message || backgroundErr)}`);
                const publicFailure = publicMcpToolFailure();
                emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'failed', reason: 'mcp_operation_failed' });
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
              content: [{ type: 'text' as const, text: CN_MCP_MESSAGES.processing }],
              finalized: false,
              blocked: false,
              reason: 'background_processing',
              requestId, conversationId, toolCalls: mcpToolRecords.length,
            };
          }
          if (timeoutHandle) clearTimeout(timeoutHandle);
          throw e;
        }


        return {
          content: [{ type: 'text' as const, text: delivered.finalized.text }],
          ...(delivered.holo && { holographic: delivered.holo }),
          ...(delivered.audioBase64 && { audio: delivered.audioBase64, audioFormat: delivered.audioFormat }),
          requestId, conversationId, toolCalls: delivered.toolCalls,
          finalized: true,
          blocked: delivered.finalized.blocked,
          reason: delivered.finalized.reason || '',
        };
      } catch (err: any) {
        logger.error(`[MCP Tool] chat failed: ${sanitizeMcpLogValue(err?.message || err)}`);
        const publicFailure = publicMcpToolFailure();
        emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'failed', reason: 'mcp_operation_failed' });
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
    }
