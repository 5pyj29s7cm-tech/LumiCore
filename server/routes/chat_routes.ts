import { runToolSession } from "../llm/tool_session";
import { type ProviderGetters as SharedProviderGetters, providerGetterArguments } from "../llm/provider_getters";
import { randomUUID } from 'node:crypto';
import { reserveConversationExecution } from '../cognition/conversation_execution';
import { getConversationActionTurn } from '../conversation/action_turn_ledger';
import { getIndustryWorkflowTask, interruptIndustryWorkflow, observeIndustryWorkflowTool, recordIndustryWorkflowExecution, validateIndustryWorkflowSourceInput } from '../industry/workflow_service';
import { Router } from "express";
import { requireNotStrict } from '../config/privacy';
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { createRequestAbortController } from '../http/request_abort';
import { makeLLMCall } from "../llm/providers";
import { toolRegistry } from "../tools/registry";
import { executeToolCallOrThrow } from "../tools/execution_engine";
import { createToolReceiptObserver } from '../tools/receipt_observer';
import { flushDBOrThrow } from '../../db_layer';
import { captureOrganizationMembershipAuthorization, watchOrganizationMembershipAuthorization } from '../org/membership_authorization';
import { recordLatency } from "../monitor/latency_store";
import { optionalAuth, requireAuth, resolveDomain } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { buildUnifiedLegalEntryPrompt } from "../cognition/legal_entry";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import {
  finalizeLumiResponseForDelivery as finalizeRestChatResponse,
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
import type { ToolExecutionRecord } from "../tools/types";
import { isLoopbackAddress } from "../config/local_identity";
import {
  DESKTOP_SESSION_HEADER,
  verifyDesktopSessionProof,
} from "../config/desktop_bootstrap";
import { redactDiagnosticSecrets } from "../client/diagnostic_sanitizer";
import {
  chatPublicErrorCodeForException,
  sanitizeChatAgentErrorPayload,
} from "../socket/chat_public_error";

const REST_CHAT_BASE_SYSTEM_INSTRUCTION =
  'You are Lumi, the local core intelligence. Be professional, thoughtful, forward-looking, concise, and useful. Follow the user-facing response-language instruction while keeping internal protocols, tool names, state fields, and execution policy in canonical English.';

function buildRestConversationMessages(messages: unknown, prompt: unknown) {
  const history = Array.isArray(messages) ? messages.filter(item => item
    && (item.role === 'user' || item.role === 'assistant' || item.role == null)) : [];
  return (history.length ? history : [{ role: 'user', content: prompt }]).map(item => ({
    role: item.role === 'assistant' ? 'assistant' as const : 'user' as const,
    content: String(item.content ?? item.message ?? item.text ?? ''),
  }));
}

function buildRestProviderMessages(messages: unknown, prompt: unknown, systemInstruction: string): any[] {
  const existingSystem = (Array.isArray(messages) ? messages : [])
    .filter((item: any) => item?.role === 'system')
    .map((item: any) => String(item?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const systemContent = [systemInstruction, existingSystem].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: systemContent },
    ...buildRestConversationMessages(messages, prompt),
  ];
}

function buildRestChatSystemInstruction(input: {
  routeText: string;
  domain: 'personal' | 'work';
  orgId: string;
  source: string;
}): string {
  const legalOverlay = buildUnifiedLegalEntryPrompt({
    text: input.routeText,
    domain: input.domain,
    orgId: input.orgId,
    channel: 'chat',
    source: input.source,
  });
  return [REST_CHAT_BASE_SYSTEM_INSTRUCTION, legalOverlay].filter(Boolean).join('\n\n');
}

function dateLikeToIso(value: unknown, fallback = Date.now()): string {
  const date = value ? new Date(value as any) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function shouldArchiveLegalMeeting(purpose: unknown, legalCase: unknown, domain: string, orgId: string): boolean {
  const isLegalMeeting = purpose === 'legal_consultation' || Boolean(legalCase && typeof legalCase === 'object');
  return isLegalMeeting && domain === 'work' && Boolean(orgId);
}

function safeLegalScopeSegment(value: unknown, fallback = 'anonymous'): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function resolveLegalCaseworkOrgId(input: {
  domain: 'personal' | 'work';
  explicitOrgId?: unknown;
  userOrgId?: unknown;
  userId: string;
}): string {
  if (input.domain === 'work') {
    return String(input.explicitOrgId || input.userOrgId || 'default').trim() || 'default';
  }
  return `personal:${safeLegalScopeSegment(input.userId)}`;
}

function buildLegalMeetingMinutesArgs(input: {
  transcript: string;
  startedAt?: unknown;
  endedAt?: unknown;
  legalCase?: any;
  orgId: string;
  userId: string;
}) {
  const legalCase = input.legalCase && typeof input.legalCase === 'object' ? input.legalCase : {};
  const caseName = String(
    legalCase.title ||
    legalCase.caseName ||
    legalCase.caseNumber ||
    `法律会议 ${dateLikeToIso(input.startedAt).slice(0, 10)}`,
  ).trim();
  return {
    transcript: input.transcript,
    meetingTime: dateLikeToIso(input.startedAt || input.endedAt),
    orgId: input.orgId || 'default',
    userId: input.userId,
    caseId: String(legalCase.id || '').trim(),
    caseName,
    participants: String(legalCase.party || legalCase.participants || '').trim(),
    caseType: String(legalCase.cause || legalCase.caseType || '').trim(),
    court: String(legalCase.court || '').trim(),
    stage: String(legalCase.stage || 'consultation').trim(),
    persistCase: true,
  };
}

const DIRECT_LEGAL_TOOL_ALLOWLIST = new Set([
  'legal_search_case',
  'legal_search_statute',
  'legal_case_workspace',
  'legal_case_workflow_status',
  'legal_message_intake_to_case',
  'legal_meeting_minutes_to_case',
  'legal_case_reasoning_matrix',
  'legal_generate_litigation_packet',
  'legal_prepare_filing_handoff',
  'legal_extract_dispute_focus',
  'legal_generate_argument_or_opinion',
  'legal_generate_bid',
  'legal_review_contract',
  'legal_draft_contract',
  'legal_process_notice_link',
  'legal_download_and_extract_document',
  'legal_trace_assets',
  'legal_equity_penetration',
  'legal_external_research_plan',
  'legal_search_external_authorities',
  'legal_company_database_lookup',
  'legal_generate_citation_verification_report',
  'legal_finalize_delivery_package',
  'legal_refresh_authoritative_sources',
  'legal_authority_source_status',
  'legal_verify_citation',
  'legal_import_judgment',
]);

/**
 * Organization viewers are limited to tools whose contract is read-only.
 * Tools that can archive a case, write an artifact, import knowledge,
 * download material, or refresh shared state remain denied. Contract review
 * is the sole conditional exception when persistence is explicitly disabled
 * and no case identity is supplied.
 */
const ORGANIZATION_VIEWER_LEGAL_READ_TOOL_ALLOWLIST = new Set([
  'legal_search_case',
  'legal_search_statute',
  'legal_case_workflow_status',
  'legal_authority_source_status',
  'legal_verify_citation',
]);

function isOrganizationViewerLegalRead(
  toolName: string,
  args: Record<string, any>,
): boolean {
  if (ORGANIZATION_VIEWER_LEGAL_READ_TOOL_ALLOWLIST.has(toolName)) return true;
  if (toolName !== 'legal_review_contract') return false;
  return args.persistCase === false
    && !String(args.caseId || '').trim()
    && !String(args.caseName || args.title || '').trim();
}

export function formatMeetingTranscriptForAnalysis(notes: unknown[]): string {
  const noteItems = Array.isArray(notes) ? notes : [];
  return noteItems
    .map((note: any) => {
      const time = note?.time ? new Date(note.time).toLocaleTimeString() : '';
      const text = String(note?.text || '').trim();
      const speakerLabel = String(note?.speakerLabel || '').trim();
      const speaker = speakerLabel
        ? `${speakerLabel}: `
        : (note?.speakerMatched === false ? 'Unknown speaker: ' : '');
      return text ? `[${time}] ${speaker}${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mountChatRoutes(router: Router, _jwtSecret: string, llm: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen'>>) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  const handleChat = asyncHandler(async (req, res) => {
    const { provider: reqProvider = "gemini", model: reqModel, messages, prompt: rawPrompt, message } = req.body;
    const prompt = rawPrompt ?? message;
    const userKey = req.headers["x-api-key"] as string;
    const isBYOK = typeof userKey === 'string' && userKey.length > 5;
    // Anonymous callers may use only their own provider key. Shared Lumi model
    // credentials are never an unauthenticated public inference endpoint.
    if (!req.user && !isBYOK) {
      return res.status(401).json({ error: 'Authentication or a caller-provided API key is required' });
    }
    const userId = req.user?.uid || 'anonymous';
    const presentedDesktopSession = req.headers[DESKTOP_SESSION_HEADER];
    const desktopSessionPresented = Object.prototype.hasOwnProperty.call(req.headers, DESKTOP_SESSION_HEADER);
    const trustedLocalExecution = Boolean(
      req.user
      && isLoopbackAddress(req.socket?.remoteAddress)
      && verifyDesktopSessionProof(presentedDesktopSession, userId),
    );
    if (desktopSessionPresented && !trustedLocalExecution) {
      return res.status(403).json({
        error: 'Native desktop session proof expired or is invalid',
        code: 'DESKTOP_SESSION_PROOF_REQUIRED',
      });
    }
    const executionBoundary = trustedLocalExecution ? 'trusted_local' as const : 'remote_restricted' as const;
    const requestScope = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const businessTaskId = String(req.body?.industryWorkflowTaskId || '').trim();
    const businessTask = businessTaskId ? getIndustryWorkflowTask({ userId, domain, orgId }, businessTaskId) : null;
    if (businessTaskId && (!businessTask || !trustedLocalExecution || isBYOK)) return res.status(403).json({ error: 'A scoped native business task is required' });
    let businessAuthority: ReturnType<typeof captureOrganizationMembershipAuthorization> | undefined;
    if (businessTask && domain === 'work') {
      try { businessAuthority = captureOrganizationMembershipAuthorization(orgId, userId); }
      catch { return res.status(403).json({ error: 'Active organization authority is required for business execution' }); }
    }
    let businessSource = '';
    if (businessTask) {
      try { businessSource = validateIndustryWorkflowSourceInput(businessTask, req.body.industryWorkflowSourceInput); }
      catch (error) { return res.status(409).json({ error: (error as Error).message }); }
      if (!businessSource) return res.status(400).json({ error: 'The original business source is required' });
    }
    const businessMetadata = businessTask?.metadata?.industryWorkflow;
    const requestId = businessMetadata?.requestId || randomUUID();
    const persistedTurn = businessMetadata?.conversationId ? getConversationActionTurn({
      conversationId: businessMetadata.conversationId, userId, requestId,
    }) : null;
    const conversationMessages = buildRestConversationMessages(messages, prompt);
    // History informs interpretation; only the latest user message authorizes work.
    const routeText = businessSource || (conversationMessages.slice().reverse().find(item => item.role === 'user')?.content || '').trim().slice(-12000);
    const restExecutionPipeline = buildLumiExecutionPipeline({
      requestId,
      dispatch: {
        userId,
        text: routeText,
        channel: 'chat',
        source: 'rest_chat',
        category: 'command',
        domain,
        orgId,
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry: toolRegistry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 80 },
      executionBoundary,
      isSanctuary: !req.user,
    });
    const restTurnDispatch = restExecutionPipeline.turnIntent;
    const restModelToolPolicy = restExecutionPipeline.authorizationPolicy;
    const restModelToolProjection = restExecutionPipeline.modelToolProjection;
    const restToolSessionActive = restExecutionPipeline.executionRequested;
    const deferRestStream =
      restToolSessionActive
      || shouldDeferModelOutputUntilFinalized({
        taskText: routeText,
        flow: restTurnDispatch.flow,
      });
    const toolContext = {
      requestId, resolutionId: restExecutionPipeline.resolution.id,
      ...(persistedTurn && persistedTurn.domain === domain && persistedTurn.orgId === orgId
        && persistedTurn.taskId === businessMetadata?.conversationTaskId ? { turnRowId: persistedTurn.id } : {}),
      ...(businessTask ? { taskId: businessMetadata.conversationTaskId, conversationId: businessMetadata.conversationId, requestId: businessMetadata.requestId, industryWorkflowTaskId: businessTask.id, industryWorkflowEntryId: businessMetadata.entryId, industryWorkflowProductLine: businessMetadata.productLine, industryWorkflowSourceInput: businessSource } : {}),
      currentTurnExecutionRequested: restExecutionPipeline.executionRequested,
      trustedActionContinuation: restExecutionPipeline.trustedActionContinuation,
      userId,
      authenticated: Boolean(req.user),
      authRole: req.user?.role,
      orgRole: req.user?.orgRole,
      localExecution: trustedLocalExecution,
      executionBoundary,
      domain,
      orgId,
      llmGetters: llm,
      source: trustedLocalExecution ? 'rest_chat_local' : 'rest_chat',
      actionIntent: routeText,
      routedTaskText: restTurnDispatch.flow.routeText,
      toolPolicy: restModelToolPolicy,
      modelToolProjection: restModelToolProjection,
    };
    const systemInstruction = buildRestChatSystemInstruction({
      routeText,
      domain,
      orgId,
      source: 'rest_chat',
    });

    const preferred = getUserPreferredLLMConfig(userId, { domain, orgId });
    const provider = isBYOK ? reqProvider : preferred.provider;
    const model = isBYOK ? reqModel : preferred.model;
    if (!isBYOK && reqProvider && reqProvider !== provider) {
      console.warn(`[Chat] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }

    const request = createRequestAbortController(req, res);
    const membershipWatcher = businessAuthority
      ? watchOrganizationMembershipAuthorization(businessAuthority, orgId, userId, request.abort)
      : undefined;
    const isBusinessAuthorized = () => !membershipWatcher || membershipWatcher.isAuthorized();
    const assertRequestActive = () => {
      request.signal.throwIfAborted();
      if (!isBusinessAuthorized()) throw new Error('Business execution authorization was revoked');
    };
    const receiptObserver = businessTask ? createToolReceiptObserver(async record => {
      if (isBusinessAuthorized()) await observeIndustryWorkflowTool({ userId, domain, orgId }, businessTask.id, record);
    }) : undefined;
    let admission: ReturnType<typeof reserveConversationExecution> | undefined;
    try {
      if (businessMetadata?.conversationId) {
        admission = reserveConversationExecution({ userId, domain, orgId, conversationId: businessMetadata.conversationId }, requestId, request.signal);
        await admission.waitForTurn();
      }
      assertRequestActive();
      let responseText = '';

      if (isBYOK) {
        requireNotStrict('Chat with a supplied cloud API key');
        const llmStart = Date.now();
        if (provider === "gemini") {
          const client = new GoogleGenerativeAI(userKey);
          const modelInstance = client.getGenerativeModel({ model: model || "gemini-2.0-flash", systemInstruction });
          const contents = conversationMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
          responseText = (await modelInstance.generateContent({ contents }, { signal: request.signal })).response.text();
        } else if (provider === "anthropic") {
          const client = new Anthropic({ apiKey: userKey });
          const response = await client.messages.create({
            model: model || "claude-sonnet-4-6",
            max_tokens: 1024,
            system: systemInstruction,
            messages: conversationMessages,
          }, { signal: request.signal });
          responseText = response.content[0].type === 'text' ? response.content[0].text : '';
        } else {
          const client = new OpenAI({ apiKey: userKey, baseURL: provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined });
          const response = await client.chat.completions.create({
            model: model || (provider === "deepseek" ? "deepseek-v4-flash" : provider === "qwen" ? "qwen-plus" : "gpt-4o"),
            messages: buildRestProviderMessages(messages, prompt, systemInstruction),
          }, { signal: request.signal });
          responseText = response.choices[0].message.content || '';
        }
        request.signal.throwIfAborted();
        const outbound = await finalizeRestChatResponse({
          taskText: routeText,
          responseText,
          source: 'rest_chat',
          flow: restTurnDispatch.flow,
        });
        request.signal.throwIfAborted();
        const finalized = outbound.finalization;
        responseText = finalized.text;
        recordLatency('llm', Date.now() - llmStart);
        return res.json({
          text: responseText,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
        });
      } else {
        const normalizedMessages: any[] = [
          { role: 'system', content: systemInstruction },
          ...conversationMessages,
        ];

        const runRestToolTurn = (
          turnMessages: any[],
          onToolRecord?: (record: ToolExecutionRecord) => void,
          onChunk?: (chunk: string) => void,
          source = toolContext.source,
        ) => runToolSession({
          messages: turnMessages,
          registry: toolRegistry,
          config: { provider, model, userId, domain, orgId, signal: request.signal, source, workflowSource: businessTask?.source || source, conversationId: toolContext.conversationId, requestId: toolContext.requestId },
          onToolCall: async record => {
            assertRequestActive();
            await receiptObserver?.persist(record);
            await onToolRecord?.(record);
          },
          maxIterations: restModelToolPolicy.maxIterations || 3,
          onStreamChunk: onChunk,
          context: { ...toolContext, source, executionSignal: request.signal,
            isCancelled: () => request.signal.aborted || !isBusinessAuthorized(), onToolRecord: receiptObserver?.onToolRecord },
          getters: llm,
        });

        const finalizeRestToolResult = async (
          candidateText: string,
          result: Awaited<ReturnType<typeof runRestToolTurn>>,
          source: string,
        ) => {
          assertRequestActive();
          const usageRecords = [...(result.usageRecords || [])];
          const outbound = await finalizeRestChatResponse({
            taskText: routeText,
            responseText: candidateText,
            toolRecords: result.toolCalls,
            source,
            flow: restTurnDispatch.flow,
            taskId: toolContext.taskId,
            requestId: toolContext.requestId,
            allowToolUse: restToolSessionActive,
            attempt: async ({ instruction, recordTool }) => {
              const recovery = await runRestToolTurn(
                [
                  ...normalizedMessages,
                  ...(candidateText.trim()
                    ? [{ role: 'assistant', content: candidateText }]
                    : []),
                  { role: 'user', content: instruction },
                ],
                recordTool,
                undefined,
                'rest_chat_guard_recovery',
              );
              usageRecords.push(...(recovery.usageRecords || []));
              return {
                text: recovery.text,
                toolRecords: recovery.toolCalls,
              };
            },
          });
          assertRequestActive();
          const industryWorkflow = businessTask ? recordIndustryWorkflowExecution({
            userId, domain, orgId, taskId: businessTask.id, resultText: outbound.finalization.text, toolRecords: outbound.toolRecords, source,
          }) : undefined;
          if (industryWorkflow) await flushDBOrThrow();
          assertRequestActive();
          return { outbound, usageRecords, industryWorkflow };
        };

        const stream = req.query.stream === 'true';

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
        }
        const restTextGate = createPreFinalizationTextGate();
        const result = await runRestToolTurn(normalizedMessages, undefined, stream ? chunk => {
          if (request.signal.aborted || deferRestStream) return;
          const safeText = restTextGate.push(chunk);
          if (safeText) res.write(`data: ${JSON.stringify({ chunk: safeText })}\n\n`);
        } : undefined);
        restTextGate.finish();
        const delivery = await finalizeRestToolResult(result.text || '', result, stream ? 'rest_chat_stream' : 'rest_chat');
        const finalized = delivery.outbound.finalization;
        responseText = finalized.text;
        for (const u of delivery.usageRecords) {
          recordTokenUsage(userId, u.provider, u.model, {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
          }, `rest_chat_${Date.now()}`, 'chat');
        }
        const usage = {
          totalTokens: delivery.usageRecords.reduce((sum, item) => sum + item.totalTokens, 0),
          records: delivery.usageRecords.length,
        };
        const payload = {
          text: responseText,
          usage,
          toolCalls: delivery.outbound.toolRecords.length,
          industryWorkflow: delivery.industryWorkflow ? { taskId: businessTask!.id, status: delivery.industryWorkflow.task.status, verification: delivery.industryWorkflow.verification } : undefined,
          finalized: true,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
        };
        if (stream) {
          res.write(`data: ${JSON.stringify({ ...payload, done: true })}\n\n`);
          return res.end();
        }
        return res.json(payload);
      }
    } catch (error: any) {
      if (businessTask) {
        interruptIndustryWorkflow({ userId, domain, orgId }, businessTask.id, request.signal.aborted, request.signal.aborted ? 'Business execution was cancelled; previous receipts retained.' : 'Business execution stopped before verified delivery.');
        try { await flushDBOrThrow(); }
        catch (persistenceError) { error = persistenceError; }
      }
      const authorizationRevoked = !isBusinessAuthorized();
      if (request.signal.aborted && (!authorizationRevoked || res.destroyed)) return;
      console.error("AI Proxy Error:", error);
      const publicError = sanitizeChatAgentErrorPayload({
        code: authorizationRevoked ? 'CHAT_CONVERSATION_REFRESH_FAILED' : chatPublicErrorCodeForException(error),
      });
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: publicError.message, code: publicError.code, done: true, failed: true })}\n\n`);
          res.end();
        }
        return;
      }
      res.status(authorizationRevoked || publicError.code === 'CHAT_PRIVACY_RESTRICTED' ? 403 : publicError.code === 'CHAT_MODEL_ROUTES_UNAVAILABLE' ? 503 : 500).json({
        error: publicError.message,
        code: publicError.code,
      });
    } finally {
      admission?.release();
      membershipWatcher?.dispose();
      request.dispose();
    }
  });

  router.post("/ai/chat", optionalAuth, handleChat);
  router.post("/chat", optionalAuth, handleChat);

  router.post("/legal/tool/:toolName", requireAuth, asyncHandler(async (req, res) => {
    const toolName = String(req.params?.toolName || '').trim();
    if (!DIRECT_LEGAL_TOOL_ALLOWLIST.has(toolName)) {
      return res.status(404).json({ error: 'Unknown or unavailable legal tool' });
    }
    const rawArgs = req.body?.args && typeof req.body.args === 'object'
      ? req.body.args
      : (req.body || {});
    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId });
    const args = {
      ...rawArgs,
      orgId: legalOrgId,
      userId,
      domain,
    };

    if (args.persistCase === undefined && (args.caseId || args.caseName || args.title)) {
      args.persistCase = true;
    }

    if (
      domain === 'work'
      && req.user!.orgRole === 'viewer'
      && !isOrganizationViewerLegalRead(toolName, args)
    ) {
      return res.status(403).json({
        error: 'Organization viewers may only use read-only legal tools.',
      });
    }

    if (!toolRegistry.get(toolName)) {
      return res.status(404).json({ error: `Legal tool "${toolName}" is not registered` });
    }

    try {
      const text = await executeToolCallOrThrow({
        registry: toolRegistry,
        name: toolName,
        arguments: args,
        context: {
          userId,
          domain,
          orgId,
          llmGetters: llm,
          source: 'legal-direct-tool',
          authenticated: true,
          authRole: req.user!.role,
          orgRole: req.user!.orgRole,
          localExecution: false,
        } as any,
      });
      return res.json({ text, toolName });
    } catch (err: any) {
      console.warn('[LegalDirectTool] Execution failed:', redactDiagnosticSecrets(err?.message || err).slice(0, 500));
      return res.status(500).json({
        error: 'Legal tool execution failed',
        code: 'LEGAL_TOOL_EXECUTION_FAILED',
      });
    }
  }));

  router.post("/legal/contract-review", requireAuth, asyncHandler(async (req, res) => {
    const contract = String(req.body?.contract || '').trim();
    if (!contract) {
      return res.status(400).json({ error: '请提供合同文本' });
    }

    const userId = req.user!.uid;
    const requestScope = resolveDomain(req.user!);
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId });
    const args = {
      contract,
      orgId: legalOrgId,
      userId,
      caseId: String(req.body?.caseId || '').trim(),
      caseName: String(req.body?.caseName || '').trim(),
      caseType: String(req.body?.caseType || req.body?.cause || '').trim(),
      court: String(req.body?.court || '').trim(),
      persistCase: req.body?.persistCase === true || Boolean(req.body?.caseId || req.body?.caseName),
    };
    if (
      domain === 'work'
      && req.user!.orgRole === 'viewer'
      && !isOrganizationViewerLegalRead('legal_review_contract', args)
    ) {
      return res.status(403).json({
        error: 'Organization viewers may only run contract review without case persistence.',
      });
    }
    const request = createRequestAbortController(req, res);
    const deepSignal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    const llmReview = executeToolCallOrThrow({
      registry: toolRegistry,
      name: 'legal_review_contract',
      arguments: args,
      context: {
        userId,
        domain,
        orgId,
        llmGetters: llm,
        source: 'legal-contract-review',
        executionSignal: deepSignal,
        isCancelled: () => deepSignal.aborted,
        authenticated: true,
        authRole: req.user!.role,
        orgRole: req.user!.orgRole,
        localExecution: false,
      } as any,
    });
    llmReview.catch(() => undefined);

    try {
      const text = await llmReview;
      request.signal.throwIfAborted();

      return res.json({ text, degraded: false });
    } catch (err: any) {
      if (request.signal.aborted || res.destroyed) return;
      console.warn('[LegalContractReview] Deep review unavailable:', redactDiagnosticSecrets(err?.message || err).slice(0, 500));
      try {
        const fallback = await executeToolCallOrThrow({
          registry: toolRegistry,
          name: 'legal_review_contract',
          arguments: args,
          context: {
            userId,
            domain,
            orgId,
            source: 'legal-contract-review-fallback',
            executionSignal: request.signal,
            isCancelled: () => request.signal.aborted,
            authenticated: true,
            authRole: req.user!.role,
            orgRole: req.user!.orgRole,
            localExecution: false,
          } as any,
        });
        request.signal.throwIfAborted();
        return res.json({
          text: `${fallback}\n\n*提示：深度 LLM 审查暂未及时完成，已先返回本地规则审查结果。*`,
          degraded: true,
          warning: 'Deep contract review unavailable; local rules fallback used.',
          warningCode: 'LEGAL_REVIEW_FALLBACK_USED',
        });
      } catch (fallbackErr: any) {
        if (request.signal.aborted || res.destroyed) return;
        console.warn('[LegalContractReview] Fallback failed:', redactDiagnosticSecrets(fallbackErr?.message || fallbackErr).slice(0, 500));
        return res.status(500).json({
          error: 'Contract review failed',
          code: 'LEGAL_CONTRACT_REVIEW_FAILED',
        });
      }
    } finally {
      request.dispose();
    }
  }));

  router.post("/meeting/analyze", requireAuth, asyncHandler(async (req, res) => {
    const { provider: reqProvider, notes, startedAt, endedAt, language = "zh", purpose = "meeting", legalCase } = req.body || {};
    const userId = req.user?.uid || 'anonymous';
    const requestScope = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const preferred = getUserPreferredLLMConfig(userId, { maxTokens: 1800, domain, orgId });
    const provider = preferred.provider;
    const model = preferred.model;
    if (reqProvider && reqProvider !== provider) {
      console.warn(`[Meeting] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }
    const transcript = formatMeetingTranscriptForAnalysis(notes);

    if (!transcript.trim()) {
      return res.status(400).json({ error: 'No meeting transcript to analyze' });
    }

    const started = startedAt ? new Date(startedAt).toLocaleString() : 'unknown';
    const ended = endedAt ? new Date(endedAt).toLocaleString() : new Date().toLocaleString();
    const outputLanguage = language === 'zh' ? 'Chinese' : 'English';
    const isLegalConsultation = purpose === 'legal_consultation';
    const caseContext = legalCase && typeof legalCase === 'object'
      ? [
          `Case title: ${legalCase.title || ''}`,
          `Case number: ${legalCase.caseNumber || ''}`,
          `Party: ${legalCase.party || ''}`,
          `Cause: ${legalCase.cause || ''}`,
          `Court: ${legalCase.court || ''}`,
          `Judge: ${legalCase.judge || ''}`,
          `Stage: ${legalCase.stage || ''}`,
          `Existing notes: ${legalCase.notes || ''}`,
        ].filter(line => !line.endsWith(': '))
      : [];
    const prompt = isLegalConsultation
      ? [
          `You are Lumi assisting a law firm with a client consultation memo. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the case context and transcript below.',
          'Create a practical legal-work memo for lawyer review with these sections:',
          '1. Consultation summary',
          '2. Fact summary',
          '3. Disputed issues / legal questions',
          '4. Missing materials / evidence to request',
          '5. Next steps with owners/deadlines if mentioned',
          '6. Risks and open questions',
          '7. Raw transcript highlights',
          'Add a short safety boundary: this assists lawyers and does not replace licensed legal judgment.',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Case context:',
          ...(caseContext.length > 0 ? caseContext : ['No case context provided.']),
          '',
          'Transcript:',
          transcript,
        ].join('\n')
      : [
          `You are Lumi acting as a meeting analyst. Output in ${outputLanguage}.`,
          'Do not call tools. Analyze only the transcript below.',
          'Create a practical meeting report with these sections:',
          '1. Meeting summary',
          '2. Key decisions',
          '3. Action items with owner if mentioned, otherwise mark owner as unassigned',
          '4. Risks / open questions',
          '5. Follow-up suggestions',
          '6. Raw transcript highlights',
          '',
          `Started: ${started}`,
          `Ended: ${ended}`,
          '',
          'Transcript:',
          transcript,
        ].join('\n');

    const result = await makeLLMCall(
      [{ role: 'user', content: prompt }],
      [],
      { provider, model, maxTokens: 1800, userId },
      ...providerGetterArguments(llm),
    );

    const report = result.text || '';
    recordTokenUsage(userId, provider, model, result.usage, `meeting_analyze_${Date.now()}`, 'meeting');
    const usage = result.usage || null;
    let legalCasework = '';
    let legalCaseworkError = '';
    if (shouldArchiveLegalMeeting(purpose, legalCase, domain, orgId)) {
      try {
        legalCasework = await executeToolCallOrThrow({
          registry: toolRegistry,
          name: 'legal_meeting_minutes_to_case',
          arguments: buildLegalMeetingMinutesArgs({
            transcript,
            startedAt,
            endedAt,
            legalCase,
            orgId,
            userId,
          }),
          context: {
            userId,
            authenticated: true,
            authRole: req.user!.role,
            orgRole: req.user!.orgRole,
            localExecution: false,
            domain,
            orgId,
            llmGetters: llm,
            source: 'meeting-analyze',
          },
        });
      } catch (err: any) {
        legalCaseworkError = err?.message || String(err);
        console.warn('[Meeting] Legal meeting archive failed:', legalCaseworkError);
      }
    }
    res.json({
      report,
      usage,
      legalCasework,
      legalCaseArchived: Boolean(legalCasework),
      legalCaseworkError: legalCaseworkError || undefined,
    });
  }));
}
