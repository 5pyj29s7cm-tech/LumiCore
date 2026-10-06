import { runLumiEntryTurn, type ExecutedLumiTurn } from '../../cognition/turn_execution';
import { resolveConversationForEntry } from '../../conversation/entry_conversation';
import { mergeToolExecutionRecords } from '../../cognition/task_execution_ledger';
import { randomUUID } from 'node:crypto';
import { createModelTurnState } from '../../llm/model_turn_state';
import { captureConversationAuthorization, combineRequestAuthorizations, runAuthorizedEnrichment } from '../../conversation/lifecycle';
import { captureChatAuthorization } from '../../socket/chat_authorization';
import { isExplicitMemoryRequest, persistTurnMemory } from '../../memory/turn_memory';
import { resolveUserTurn } from '../../cognition/turn_resolution';
import { queryMemories } from '../../memory';
import { personalityRegistry } from '../../personality';
import { deviceRegistry } from '../../devices';
import { canOutputHolographic, textToHolographicOutput } from '../../output/holographic';
import { synthesizeSpeech, getActiveProvider } from '../../tts/adapter';
import { logger } from '../../../logger';
import type { ToolExecutionRecord } from '../../tools/types';
import { restrictSystemPromptForExecutionBoundary } from '../../tools/remote_policy';
import { publicMcpToolFailure, sanitizeMcpLogValue } from '../public_security';
import { CN_MCP_MESSAGES } from '../../regions/messages/mcp_messages';
import type { McpToolRuntime, McpConversationInput, McpConversationEntry, ToolRecordEvent } from './contracts';

export async function runMcpConversationTurn({ bc, chatConversations, scope, isWorkViewer, resolveMcpLLM, tr, mcpToolSecurityContext, g, lifecycle, memoryScope }: Pick<McpToolRuntime, 'mcp' | 'bc' | 'chatConversations' | 'scope' | 'isWorkViewer' | 'resolveMcpLLM' | 'tr' | 'mcpToolSecurityContext' | 'g' | 'lifecycle' | 'memoryScope'>, { message, personalityId, conversationId: requestedConversationId }: McpConversationInput, entry: McpConversationEntry) {
  const requestId = randomUUID();
  const pid = personalityId || 'lumi';
  let conversationId = '';
  const emit = (event: string, data: any) => bc(event, { ...data, requestId, conversationId, source: entry.source });
  try {
    const prior = resolveConversationForEntry(scope.userId, scope, { kind: 'mcp', agentId: pid, resumeConversationId: chatConversations.get(pid) }, requestedConversationId);
    if (!prior) throw new Error('Conversation is unavailable in this scope');
    conversationId = prior.id; chatConversations.set(pid, conversationId);
    const authorization = combineRequestAuthorizations(captureChatAuthorization(scope.userId, scope), captureConversationAuthorization({ ...scope, agentId: pid }, () => conversationId));
    authorization.assertCurrent();
    const identity = { userId: scope.userId, agentId: pid, conversationId, requestId, domain: scope.domain, orgId: scope.orgId };
    const controller = new AbortController();
    const modelTurnState = createModelTurnState();
    const explicitMemory = entry.turnMemory && !isWorkViewer && isExplicitMemoryRequest(message);
    const chatLLM = resolveMcpLLM();
    const personality = personalityRegistry.getForUser(pid, scope.userId, scope.orgId) || personalityRegistry.getDefault();
    const acceptedResolution = resolveUserTurn({ requestId, userText: message, state: prior.actionContinuationState });
    const ds = deviceRegistry.getSensoryContext(scope.userId, { domain: scope.domain, orgId: scope.orgId });
    const sensory = { audio: ds.hasAudio, visual: ds.hasVideo, spatial: ds.hasSpatial, haptic: ds.hasHaptic, holographic: ds.hasHolographic,
      activeDeviceTypes: ds.activeDeviceTypes, deviceCount: ds.deviceCount };
    emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'received' });
    emit('agent:status', { status: 'thinking', agentName: 'Lumi' });
    const getters = { ...g, getDeepSeek: g.getDeepSeek || (() => null), getGemini: g.getGemini || (() => null), getOpenAI: g.getOpenAI || (() => null),
      getAnthropic: g.getAnthropic || (() => null), getQwen: g.getQwen || (() => null) };
    const extractMemory = () => runAuthorizedEnrichment(authorization, signal => persistTurnMemory({ ...identity, source: entry.source, channel: 'chat',
      userText: message, authorization, signal, llmGetters: getters }));
    let mcpToolRecords: ToolExecutionRecord[] = [];
    const recordMcpChatTool = (record: ToolRecordEvent) => {
      if (record.result === undefined && record.error === undefined) return;
      mcpToolRecords = mergeToolExecutionRecords(mcpToolRecords, [{ ...record, result: record.result || '' }]);
      const correlationId = record.id || randomUUID();
      emit('agent:tool_call', { correlationId, name: record.name, status: 'started' });
      if (record.error) {
        logger.warn('[MCP Tool] ' + record.name + ' returned an error: ' + sanitizeMcpLogValue(record.error));
        emit('agent:tool_call', { correlationId, name: record.name, status: 'failed', error: 'Tool execution failed.' });
      } else emit('agent:tool_call', { correlationId, name: record.name, status: 'completed', result: 'completed' });
    };
    let background = false;
    const deliver = async ({ finalized, toolRecords }: ExecutedLumiTurn) => {
      const metadata = { finalized: true, blocked: finalized.blocked, reason: finalized.reason || '' };
      const holo = entry.responseMedia && canOutputHolographic(sensory) ? textToHolographicOutput(finalized.text) : undefined;
      emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: finalized.blocked ? 'blocked' : 'responded', toolCalls: toolRecords.length, background, ...metadata });
      emit('mcp:chunk', { device: 'xiaozhi', text: finalized.text, ...metadata });
      emit('agent:response', { text: finalized.text, agentName: 'Lumi', ...metadata });
      emit('agent:status', { status: 'idle', agentName: 'Lumi' });
      let audioBase64: string | undefined; let audioFormat: string | undefined;
      if (entry.responseMedia) {
        try {
          const ttsResult = await synthesizeSpeech(finalized.text, { provider: getActiveProvider(), voiceId: personality.ttsVoiceId || 'longxiaochun_v3' });
          audioBase64 = ttsResult.audioBuffer.toString('base64'); audioFormat = ttsResult.format;
          authorization.assertCurrent();
          emit('mcp:activity', { device: 'xiaozhi', action: 'tts', status: 'synthesized', bytes: ttsResult.audioBuffer.length, ...metadata });
        } catch (error: any) { console.error('[MCP TTS] Synthesis failed:', error.message); }
      }
      authorization.assertCurrent();
      if (background) emit('mcp:proactive', { device: 'xiaozhi', text: finalized.text, ...(audioBase64 && { audio: audioBase64, format: audioFormat }), ...metadata });
      return { finalized, holo, audioBase64, audioFormat, toolCalls: toolRecords.length };
    };
    const responsePromise = runLumiEntryTurn({
      entry: { source: entry.source, channel: 'chat', historyLimit: 30, failureText: publicMcpToolFailure(), failureReason: 'mcp_operation_failed' },
      identity, userText: message, authorization, controller,
      planning: { acceptedResolution, dispatch: { userId: scope.userId, text: message, channel: 'chat', source: entry.source,
        category: entry.action === 'route_task' ? 'command' : undefined, domain: scope.domain, orgId: scope.orgId },
        registry: tr, personalityToolPolicy: personality.toolPolicy, executionBoundary: 'remote_restricted' },
      assemble: pipeline => {
        const memories = entry.turnMemory ? queryMemories({ ...memoryScope, limit: personality.memoryPolicy.retrieveLimit, minConfidence: personality.memoryPolicy.minConfidence }) : [];
        const memoryContext = memories.map(memory => '[' + memory.type + '] ' + memory.content).join('\n');
        const { systemPrompt } = personalityRegistry.buildSystemPrompt(pid, { mode: pipeline.executionRequested ? 'task' : 'chat', sensory }, { ...memoryScope, userText: message });
        return { systemPrompt: restrictSystemPromptForExecutionBoundary(systemPrompt, 'remote_restricted') + (memoryContext ? '\n\n## User context (memories):' + memoryContext : ''),
          model: { registry: tr, config: { ...chatLLM, maxTokens: entry.maxTokens, modelTurnState }, streaming: false,
            maxIterations: entry.maxIterations, onToolCall: recordMcpChatTool, context: { ...mcpToolSecurityContext, actionIntent: message }, getters } };
      },
      ...(explicitMemory ? { explicitMemory: extractMemory } : {}),
      beforeCommit: ({ finalized }) => {
        if (entry.turnMemory && !explicitMemory && personality.memoryPolicy.autoExtract && !finalized.blocked && !isWorkViewer) {
          const extraction = extractMemory(); lifecycle?.track(extraction);
        }
      },
      deliverySource: () => background ? entry.source + '_background' : entry.source,
      deliver,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('MCP_TIMEOUT')), 25_000); timeoutHandle.unref?.(); });
    let delivered: Awaited<typeof responsePromise>;
    try {
      delivered = await Promise.race([responsePromise, timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    } catch (error: any) {
      if (error.message === 'MCP_TIMEOUT') {
        background = true;
        emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'timeout' });
        emit('agent:status', { status: 'idle', agentName: 'Lumi' });
        const backgroundWork = responsePromise.catch((backgroundError: any) => {
          logger.error('[MCP Tool] background chat failed: ' + sanitizeMcpLogValue(backgroundError?.message || backgroundError));
          emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'failed', reason: 'mcp_operation_failed' });
          emit('agent:response', { text: publicMcpToolFailure(), agentName: 'Lumi', finalized: true, blocked: true, reason: 'mcp_operation_failed' });
          emit('agent:status', { status: 'error', agentName: 'Lumi' });
        });
        lifecycle?.track(backgroundWork);
        return { content: [{ type: 'text' as const, text: CN_MCP_MESSAGES.processing }], finalized: false, blocked: false,
          reason: 'background_processing', requestId, conversationId, toolCalls: mcpToolRecords.length };
      }
      if (timeoutHandle) clearTimeout(timeoutHandle); throw error;
    }
    return { content: [{ type: 'text' as const, text: delivered.finalized.text }],
      ...(delivered.holo && { holographic: delivered.holo }), ...(delivered.audioBase64 && { audio: delivered.audioBase64, audioFormat: delivered.audioFormat }),
      requestId, conversationId, toolCalls: delivered.toolCalls, finalized: true, blocked: delivered.finalized.blocked, reason: delivered.finalized.reason || '' };
  } catch (error: any) {
    logger.error('[MCP Tool] chat failed: ' + sanitizeMcpLogValue(error?.message || error));
    const publicFailure = publicMcpToolFailure();
    emit('mcp:activity', { device: 'xiaozhi', action: entry.action, status: 'failed', reason: 'mcp_operation_failed' });
    emit('agent:error', { message: publicFailure, reason: 'mcp_operation_failed' });
    emit('agent:status', { status: 'error', agentName: 'Lumi' });
    return { content: [{ type: 'text' as const, text: publicFailure }], isError: true, finalized: true, blocked: true, reason: 'mcp_operation_failed' };
  }
}
