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
import { runWithTools } from '../llm/adapter';
import { toolRegistry, ToolRegistry } from '../tools/registry';
import { personalityRegistry } from '../personality';
import { deviceRegistry } from '../devices';
import { canOutputHolographic, textToHolographicOutput } from '../output/holographic';
import { setOfficeBroadcast } from '../tools/definitions/office_tools';
import { synthesizeSpeech, getActiveProvider } from '../tts/adapter';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger';
import type { Request, Response } from 'express';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import {
  finalizeExecutionForOutboundDelivery,
  type ExecutionGuardRecoveryRunInput,
} from '../cognition/execution_guard_recovery';
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

// Track active transports per session
const transports: Map<string, { transport: SSEServerTransport; scope: McpCallerScope }> = new Map();

type ToolRecordEvent = Omit<ToolExecutionRecord, 'result'> & { result?: string };

function upsertCompletedToolRecord(records: ToolExecutionRecord[], record: ToolRecordEvent): void {
  if (record.result === undefined && record.error === undefined) return;
  const completed: ToolExecutionRecord = {
    id: record.id,
    name: record.name,
    arguments: record.arguments || {},
    result: record.result || '',
    error: record.error,
  };
  const existingIndex = record.id
    ? records.findIndex(item => item.id === record.id)
    : -1;
  if (existingIndex >= 0) {
    records[existingIndex] = completed;
  } else {
    records.push(completed);
  }
}

function mcpToolFailure(operation: string, error: unknown) {
  logger.error(`[MCP Tool] ${operation} failed: ${sanitizeMcpLogValue((error as any)?.message || error)}`);
  return {
    content: [{ type: 'text' as const, text: publicMcpToolFailure() }],
    isError: true,
  };
}

type McpFinalization = ReturnType<typeof finalizeLumiResponse>;

async function finalizeMcpResponseForDelivery(input: {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: string;
  allowToolUse?: boolean;
  attempt?: ExecutionGuardRecoveryRunInput<McpFinalization>['attempt'];
}) {
  const toolRecords = input.toolRecords || [];
  const finalization = finalizeLumiResponse({
    taskText: input.taskText,
    responseText: input.responseText,
    toolRecords,
    source: input.source,
  });
  return finalizeExecutionForOutboundDelivery({
    task: input.taskText,
    responseText: input.responseText,
    finalization,
    allowToolUse: input.allowToolUse === true,
    toolRecords,
    attempt: input.attempt,
    finalize: (candidateText, records) => finalizeLumiResponse({
      taskText: input.taskText,
      responseText: candidateText,
      toolRecords: records,
      source: `${input.source}_guard_recovery`,
    }),
  });
}

export function createLumiMcpServer(llmGetters?: {
  getDeepSeek?: () => any;
  getGemini?: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}, toolReg?: ToolRegistry, broadcast?: (event: string, data: any) => void, callerScope?: McpCallerScope): McpServer {
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
  const matchesScopedRecord = (record: any, allowUnownedPersonal = false): boolean => {
    if (!record || typeof record !== 'object') return false;
    if (scope.domain === 'work') {
      if (record.domain !== 'work' || String(record.orgId || '') !== scope.orgId) return false;
      if (!isWorkViewer) return true;
      const ownerId = String(record.ownerUid || record.userId || '');
      return Boolean(ownerId) && ownerId === scope.userId;
    }
    if (record.domain === 'work' || String(record.orgId || '')) return false;
    const ownerId = String(record.ownerUid || record.userId || '');
    return ownerId === scope.userId || (allowUnownedPersonal && !ownerId);
  };
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
  setOfficeBroadcast(bc);
  const mcp = new McpServer({
    name: 'lumi-mcp',
    version: '2.0.0',
  }, {
    capabilities: { tools: {} },
  });

  // Tool: send a chat message to Lumi
  mcp.registerTool(
    'lumi_chat',
    {
      description: 'Send a message to Lumi and get an AI-powered response. Lumi will use its personality, memory, and tool capabilities.',
      inputSchema: {
        message: z.string().describe('The message to send to Lumi'),
        personalityId: z.string().optional().describe('Personality to use (default: "lumi")'),
      },
    },
    async ({ message, personalityId }) => {
      try {
        const chatLLM = resolveMcpLLM();
        bc('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'received' });
        bc('agent:status', { status: 'thinking', agentName: 'Lumi' });
        const pid = personalityId || 'lumi';
        const personality = personalityRegistry.get(pid) || personalityRegistry.get('lumi')!;
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
        const { systemPrompt } = personalityRegistry.buildSystemPrompt(pid, { mode: 'task', sensory });

        const memories = queryMemories({
          ...memoryScope,
          limit: personality.memoryPolicy.retrieveLimit,
          minConfidence: personality.memoryPolicy.minConfidence,
        });
        const memoryContext = memories.length > 0
          ? memories.map(m => `[${m.type}] ${m.content}`).join('\n')
          : '';

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          // Network MCP callers receive neither the native host capability
          // inventory nor active LAP peer/session projections.
          { role: 'system', content: restrictSystemPromptForExecutionBoundary(systemPrompt, 'remote_restricted') + (memoryContext ? `\n\n## User context (memories):\n${memoryContext}` : '') },
          { role: 'user', content: message },
        ];

        const MCP_TIMEOUT_MS = 25000;
        const mcpToolRecords: ToolExecutionRecord[] = [];
        const bufferedChunks: string[] = [];

        const recordMcpChatTool = (record: ToolRecordEvent) => {
            upsertCompletedToolRecord(mcpToolRecords, record);
            const cid = `${record.name}-${Date.now()}`;
            bc('agent:tool_call', { correlationId: cid, name: record.name, status: 'started' });
            if (record.error) {
              logger.warn(`[MCP Tool] ${record.name} returned an error: ${sanitizeMcpLogValue(record.error)}`);
              bc('agent:tool_call', { correlationId: cid, name: record.name, status: 'failed', error: 'Tool execution failed.' });
            } else {
              bc('agent:tool_call', { correlationId: cid, name: record.name, status: 'completed', result: 'completed' });
            }
        };
        const runMcpChatTurn = (
          turnMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
          onToolRecord?: (record: ToolRecordEvent) => void,
          onChunk?: (chunk: string) => void,
          source = 'mcp_chat',
        ) => runWithTools(
          turnMessages,
          tr,
          {
            ...chatLLM,
            maxTokens: 2048,
          },
          onToolRecord,
          Math.min(4, personality.toolPolicy.maxIterations),
          g.getDeepSeek || (() => null),
          g.getGemini || (() => null),
          g.getOpenAI || (() => null),
          g.getAnthropic || (() => null),
          g.getQwen || (() => null),
          onChunk,
          {
            userId: scope.userId,
            domain: scope.domain,
            orgId: scope.orgId,
            toolPolicy: restrictToolPolicyForExecutionBoundary(
              personality.toolPolicy,
              'remote_restricted',
            ),
            source,
            ...mcpToolSecurityContext,
          } as any,
          g.getOllama,
          g.getLmStudio,
          g.getArk,
          g.getXiaomi,
          g.getKimi,
          g.getGlm,
          g.getRelay,
        );
        const responsePromise = runMcpChatTurn(
          messages,
          recordMcpChatTool,
          chunk => bufferedChunks.push(chunk),
        );

        const queueMemoryExtraction = (assistantResponse: string) => {
          if (!personality.memoryPolicy.autoExtract) return;
          const existingContents = memories.map(m => m.content);
          const gDeep = g.getDeepSeek || (() => null);
          const gGem = g.getGemini || (() => null);
          const gOAI = g.getOpenAI || (() => null);
          const gAnt = g.getAnthropic || (() => null);
          const gQw = g.getQwen || (() => null);
          void (async () => {
            try {
              const { extractMemories } = await import('../memory/extractor');
              const result = await extractMemories(
                { userMessage: message, assistantResponse, existingMemories: existingContents, ...chatLLM },
                gDeep, gGem, gOAI, gAnt, gQw,
              );
              for (const mem of result.memories) {
                addMemory(
                  { userId: scope.userId, type: mem.type, content: mem.content, keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: 'mcp_lumi_chat' },
                  { domain: scope.domain, orgId: scope.orgId },
                );
              }
            } catch { /* best-effort */ }
          })();
        };

        const deliverFinalizedChatResponse = async (
          response: Awaited<typeof responsePromise>,
          background: boolean,
        ) => {
          const toolRecords = [...mcpToolRecords];
          for (const record of response.toolCalls || []) {
            upsertCompletedToolRecord(toolRecords, record);
          }
          const candidateText = String(response.text || bufferedChunks.join('') || 'No response.').trim();
          const outbound = await finalizeMcpResponseForDelivery({
            taskText: message,
            responseText: candidateText,
            toolRecords,
            source: background ? 'mcp_chat_background' : 'mcp_chat',
            allowToolUse: true,
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
          const finalized = outbound.finalization;
          toolRecords.splice(0, toolRecords.length, ...outbound.toolRecords);
          queueMemoryExtraction(finalized.text);

          const metadata = {
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          };
          const holo = canOutputHolographic(sensory)
            ? textToHolographicOutput(finalized.text)
            : undefined;
          bc('mcp:activity', {
            device: 'xiaozhi',
            action: 'chat',
            status: finalized.blocked ? 'blocked' : 'responded',
            toolCalls: toolRecords.length,
            background,
            ...metadata,
          });
          // Raw model chunks stay buffered. Only grounded final text can reach
          // either the MCP chunk stream or the shared response channel.
          bc('mcp:chunk', {
            device: 'xiaozhi',
            text: finalized.text,
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          });
          bc('agent:response', {
            text: finalized.text,
            agentName: 'Lumi',
            finalized: true,
            blocked: finalized.blocked,
            reason: finalized.reason || '',
          });
          bc('agent:status', { status: 'idle', agentName: 'Lumi' });
          console.log('[MCP lumi_chat] Finalized response length:', finalized.text.length, 'chars, toolCalls:', toolRecords.length, 'blocked:', finalized.blocked);

          let audioBase64: string | undefined;
          let audioFormat: string | undefined;
          try {
            const provider = getActiveProvider();
            const voiceId = personality.ttsVoiceId || 'longxiaochun_v3';
            const ttsResult = await synthesizeSpeech(finalized.text, { provider, voiceId });
            audioBase64 = ttsResult.audioBuffer.toString('base64');
            audioFormat = ttsResult.format;
            bc('mcp:activity', { device: 'xiaozhi', action: 'tts', status: 'synthesized', bytes: ttsResult.audioBuffer.length, ...metadata });
          } catch (ttsErr: any) {
            console.error('[MCP TTS] Synthesis failed:', ttsErr.message);
          }

          if (background) {
            bc('mcp:proactive', {
              device: 'xiaozhi',
              text: finalized.text,
              ...(audioBase64 && { audio: audioBase64, format: audioFormat }),
              ...metadata,
            });
          }

          return { finalized, holo, audioBase64, audioFormat };
        };

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('MCP_TIMEOUT')), MCP_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });

        let response: Awaited<typeof responsePromise>;
        try {
          response = await Promise.race([responsePromise, timeoutPromise]);
          if (timeoutHandle) clearTimeout(timeoutHandle);
        } catch (e: any) {
          if (e.message === 'MCP_TIMEOUT') {
            console.log('[MCP lumi_chat] Timeout — continuing in background');
            bc('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'timeout' });
            bc('agent:status', { status: 'idle', agentName: 'Lumi' });
            void responsePromise
              .then(backgroundResponse => deliverFinalizedChatResponse(backgroundResponse, true))
              .catch((backgroundErr: any) => {
                logger.error(`[MCP Tool] background chat failed: ${sanitizeMcpLogValue(backgroundErr?.message || backgroundErr)}`);
                const publicFailure = publicMcpToolFailure();
                bc('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'failed', reason: 'mcp_operation_failed' });
                bc('agent:response', {
                  text: publicFailure,
                  agentName: 'Lumi',
                  finalized: true,
                  blocked: true,
                  reason: 'mcp_operation_failed',
                });
                bc('agent:status', { status: 'error', agentName: 'Lumi' });
              });
            return {
              content: [{ type: 'text' as const, text: '正在处理中，稍等片刻...' }],
              finalized: false,
              blocked: false,
              reason: 'background_processing',
            };
          }
          if (timeoutHandle) clearTimeout(timeoutHandle);
          throw e;
        }

        const delivered = await deliverFinalizedChatResponse(response, false);

        return {
          content: [{ type: 'text' as const, text: delivered.finalized.text }],
          ...(delivered.holo && { holographic: delivered.holo }),
          ...(delivered.audioBase64 && { audio: delivered.audioBase64, audioFormat: delivered.audioFormat }),
          finalized: true,
          blocked: delivered.finalized.blocked,
          reason: delivered.finalized.reason || '',
        };
      } catch (err: any) {
        logger.error(`[MCP Tool] chat failed: ${sanitizeMcpLogValue(err?.message || err)}`);
        const publicFailure = publicMcpToolFailure();
        bc('mcp:activity', { device: 'xiaozhi', action: 'chat', status: 'failed', reason: 'mcp_operation_failed' });
        bc('agent:error', { message: publicFailure, reason: 'mcp_operation_failed' });
        bc('agent:status', { status: 'error', agentName: 'Lumi' });
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
        const outbound = await finalizeMcpResponseForDelivery({
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
        const personality = personalityRegistry.get('lumi') || personalityRegistry.getDefault();
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
        });
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
        ) => runWithTools(
          turnMessages,
          tr,
          { ...routeLLM, maxTokens: 4096 },
          onToolRecord,
          Math.min(8, personality.toolPolicy.maxIterations),
          g.getDeepSeek || (() => null),
          g.getGemini || (() => null),
          g.getOpenAI || (() => null),
          g.getAnthropic || (() => null),
          g.getQwen || (() => null),
          undefined,
          {
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
          g.getOllama,
          g.getLmStudio,
          g.getArk,
          g.getXiaomi,
          g.getKimi,
          g.getGlm,
          g.getRelay,
        );

        const result = await runMcpTaskTurn(messages);
        const outbound = await finalizeMcpResponseForDelivery({
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

  return mcp;
}

/**
 * Handle SSE connection — create transport and add to the Lumi MCP server.
 */
export async function handleMcpSSE(
  mcpServer: McpServer,
  req: Request,
  res: Response,
  callerScope?: McpCallerScope,
) {
  try {
    const scope = callerScope || mcpScopeFromAuthUser(req.user);
    if (!scope) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const transport = new SSEServerTransport('/mcp/message', res);
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
