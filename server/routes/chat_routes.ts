import * as LegalCases from '../org/legal_cases';
import { meetingMinutesToCaseHandler } from '../regions/packs/cn/legal_tools/meetings';
import { withLegalExecution } from '../legal/execution';
import { decodeToolResult } from '../tools/result_envelope';
import { assertOrganizationResourceAccess, OrganizationResourceAuthorizationError } from '../org/resource_acl';
import { legalToolDefinitions } from '../regions/packs/cn/legal_tools';
import { bindIndustryWorkspaceContext, getActiveIndustryWorkspaceContext, listIndustryWorkspaceContexts } from '../industry/workspace_context';
import { legalToolCaseIdentity, legalToolEntryId } from '../../shared/legal_tool_entry';
import { CN_PUBLIC_AGENT_EVENT_MESSAGES } from '../regions/messages/public_agent_event_messages';
import { runLumiEntryTurn } from "../cognition/turn_execution";
import { captureRequestAuthorization, captureConversationAuthorization, combineRequestAuthorizations } from "../conversation/lifecycle";
import { resolveConversationForEntry } from "../conversation/entry_conversation";

import { type ProviderGetters as SharedProviderGetters, providerGetterArguments } from "../llm/provider_getters";
import { randomUUID } from 'node:crypto';
import { getConversationActionTurn } from '../conversation/action_turn_ledger';
import { getIndustryWorkflowTask, interruptIndustryWorkflow, observeIndustryWorkflowTool, recordIndustryWorkflowExecution, validateIndustryWorkflowSourceInput } from '../industry/workflow_service';
import { Router } from "express";
import { requireNotStrict } from '../config/privacy';
import { createCallerKeyProvider } from '../llm/caller_key_provider';

import { createRequestAbortController } from '../http/request_abort';
import { runtimeShutdownCancellation } from '../runtime/shutdown_work';
import { makeLLMCall } from "../llm/providers";
import { ToolRegistry, toolRegistry } from "../tools/registry";
import { executeToolCall, executeToolCallOrThrow } from "../tools/execution_engine";
import { createToolReceiptObserver } from '../tools/receipt_observer';
import { flushDBOrThrow } from '../../db_layer';
import { captureOrganizationMembershipAuthorization, watchOrganizationMembershipAuthorization } from '../org/membership_authorization';
import { recordLatency } from "../monitor/latency_store";
import { optionalAuth, requireAuth, requireLocalRequest, resolveDomain } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { buildUnifiedLegalEntryPrompt } from "../cognition/legal_entry";
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
} from "../cognition/response_delivery";
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
  return LegalCases.legalWorkspaceNamespace(input.userId);
}

function buildLegalMeetingMinutesArgs(input: {
  transcript: string;
  report: string;
  startedAt?: unknown;
  endedAt?: unknown;
  meetingId: string;
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
    report: input.report,
    meetingTime: input.startedAt || input.endedAt ? dateLikeToIso(input.startedAt || input.endedAt) : '',
    meetingId: input.meetingId,
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

const DIRECT_LEGAL_TOOL_ALLOWLIST = new Set(legalToolDefinitions().map(tool => tool.name));

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
  const asyncHandler = chatRouteAsyncHandler;
  mountConversationCompletionRoutes(router, llm, asyncHandler);
  mountLegalCompletionRoutes(router, llm, asyncHandler);
  mountMeetingCompletionRoutes(router, llm, asyncHandler);
}

function mountConversationCompletionRoutes(router: Router, llm: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen'>>, asyncHandler: typeof chatRouteAsyncHandler) {
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
    const businessAuthorization = captureRequestAuthorization(() => !membershipWatcher || membershipWatcher.isAuthorized(), 'Business execution authorization was revoked');
    const conversationAuthorization = businessMetadata?.conversationId ? captureConversationAuthorization({ userId, domain, orgId }, () => businessMetadata.conversationId) : undefined;
    const authorization = conversationAuthorization ? combineRequestAuthorizations(businessAuthorization, conversationAuthorization) : businessAuthorization;
    const isBusinessAuthorized = authorization.isCurrent;
    const receiptObserver = businessTask ? createToolReceiptObserver(async record => {
      if (isBusinessAuthorized()) await observeIndustryWorkflowTool({ userId, domain, orgId }, businessTask.id, record);
    }) : undefined;
    const unregisterShutdownCancellation = runtimeShutdownCancellation.register(request.controller);
    try {
      const anchored = businessMetadata?.conversationId ? resolveConversationForEntry(userId, { domain, orgId }, { kind: 'rest' }, businessMetadata.conversationId) : null;
      if (businessMetadata?.conversationId && !anchored) throw Object.assign(new Error('The bound business conversation is unavailable'), { code: 'CONVERSATION_ENTRY_UNAVAILABLE' });
      if (isBYOK) requireNotStrict('Chat with a supplied cloud API key');
      const caller = isBYOK ? createCallerKeyProvider(provider, model, userKey) : undefined;
      const llmStart = Date.now();
      const stream = !isBYOK && req.query.stream === 'true';
      const restTextGate = createPreFinalizationTextGate();
      let industryWorkflow: ReturnType<typeof recordIndustryWorkflowExecution> | undefined;
      const executionSource = trustedLocalExecution ? 'rest_chat_local' : 'rest_chat';
      return await runLumiEntryTurn({
        entry: { source: executionSource, queueSource: 'rest', channel: 'chat', historyLimit: 0,
          failureText: 'The request could not finish.', failureReason: 'rest_chat_failed' },
        identity: { userId, domain, orgId, agentId: anchored?.agentId || 'lumi', conversationId: anchored?.id || '', requestId },
        userText: routeText, persistence: 'external', authorization, controller: request.controller,
        externalTask: { taskId: businessMetadata?.conversationTaskId,
          turnRowId: persistedTurn && persistedTurn.domain === domain && persistedTurn.orgId === orgId && persistedTurn.taskId === businessMetadata?.conversationTaskId ? persistedTurn.id : undefined },
        planning: { dispatch: { userId, text: routeText, channel: 'chat', source: 'rest_chat', category: 'command', domain, orgId, operationMode: 'assistant', targetIsLumi: true },
          registry: caller ? new ToolRegistry() : toolRegistry,
          personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 80 },
          executionBoundary, isSanctuary: !req.user, taskId: businessMetadata?.conversationTaskId },
        assemble: execution => {
          const systemInstruction = buildRestChatSystemInstruction({ routeText, domain, orgId, source: 'rest_chat' });
          if (caller) return { systemPrompt: systemInstruction,
            messages: caller.provider === 'gemini' || caller.provider === 'anthropic'
              ? [{ role: 'system', content: systemInstruction }, ...conversationMessages]
              : buildRestProviderMessages(messages, prompt, systemInstruction),
            model: { config: { provider: caller.provider, model: caller.model, selectionMode: 'pinned', noImplicitFailover: true, allowCloudFallback: false,
              fallbackCandidates: [], source: 'rest_chat', requestId, ...(caller.provider === 'anthropic' ? { maxTokens: 1024 } : {}) },
              getters: caller.getters, streaming: false, taskText: routeText } };
          const deferRestStream = execution.executionRequested || shouldDeferModelOutputUntilFinalized({ taskText: routeText, flow: execution.turnIntent.flow });
          if (stream) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          return { systemPrompt: systemInstruction, messages: [{ role: 'system', content: systemInstruction }, ...conversationMessages],
            model: { registry: toolRegistry, config: { provider, model, userId, domain, orgId, source: executionSource, workflowSource: businessTask?.source || executionSource }, streaming: stream,
              maxIterations: execution.authorizationPolicy.maxIterations || 3,
              onToolCall: async record => { authorization.assertCurrent(); await receiptObserver?.persist(record); },
              onStreamChunk: stream ? chunk => {
                if (request.signal.aborted || deferRestStream) return;
                const safeText = restTextGate.push(chunk);
                if (safeText) res.write('data: ' + JSON.stringify({ chunk: safeText }) + '\n\n');
              } : undefined,
              context: { userId, authenticated: Boolean(req.user), authRole: req.user?.role, orgRole: req.user?.orgRole, localExecution: trustedLocalExecution,
                executionBoundary, domain, orgId, llmGetters: llm, actionIntent: routeText, routedTaskText: execution.turnIntent.flow.routeText,
                ...(businessTask ? { industryWorkflowTaskId: businessTask.id, industryWorkflowEntryId: businessMetadata.entryId,
                  industryWorkflowProductLine: businessMetadata.productLine, industryWorkflowSourceInput: businessSource } : {}),
                onToolRecord: receiptObserver?.onToolRecord }, getters: llm } };
        },
        beforeCommit: ({ finalized, toolRecords }) => {
          restTextGate.finish();
          if (businessTask) industryWorkflow = recordIndustryWorkflowExecution({ userId, domain, orgId, taskId: businessTask.id,
            resultText: finalized.text, toolRecords, source: stream ? 'rest_chat_stream' : 'rest_chat' });
        },
        deliverySource: () => stream ? 'rest_chat_stream' : 'rest_chat',
        deliver: ({ finalized, toolRecords, usageRecords }) => {
          if (caller) {
            recordLatency('llm', Date.now() - llmStart);
            return res.json({ text: finalized.text, finalized: true, blocked: finalized.blocked, reason: finalized.reason, notification: finalized.notification });
          }
          for (const usage of usageRecords) recordTokenUsage(userId, usage.provider, usage.model, {
            promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
          }, 'rest_chat_' + Date.now(), 'chat');
          const payload = { text: finalized.text, usage: { totalTokens: usageRecords.reduce((sum, item) => sum + item.totalTokens, 0), records: usageRecords.length },
            toolCalls: toolRecords.length, industryWorkflow: industryWorkflow ? { taskId: businessTask!.id, status: industryWorkflow.task.status, verification: industryWorkflow.verification } : undefined,
            finalized: true, blocked: finalized.blocked, reason: finalized.reason, notification: finalized.notification };
          if (stream) { res.write('data: ' + JSON.stringify({ ...payload, done: true }) + '\n\n'); return res.end(); }
          return res.json(payload);
        },
      });
    } catch (error: any) {
      if (businessTask) {
        interruptIndustryWorkflow({ userId, domain, orgId }, businessTask.id, request.signal.aborted, request.signal.aborted ? 'Business execution was cancelled; previous receipts retained.' : 'Business execution stopped before verified delivery.');
        try { await flushDBOrThrow(); }
        catch (persistenceError) { error = persistenceError; }
      }
      const authorizationRevoked = error?.code === 'CONVERSATION_ENTRY_UNAVAILABLE' || !isBusinessAuthorized();
      if (request.signal.aborted && (!authorizationRevoked || res.destroyed)) {
        if (!res.destroyed && !res.writableEnded) {
          const payload = { error: 'The chat request was cancelled before completion.', code: 'CHAT_REQUEST_CANCELLED', done: true, failed: true };
          if (res.headersSent) { res.write(`data: ${JSON.stringify(payload)}\n\n`); res.end(); }
          else res.status(503).json(payload);
        }
        return;
      }
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
      unregisterShutdownCancellation();
      membershipWatcher?.dispose();
      request.dispose();
    }
  });

  router.post("/ai/chat", optionalAuth, handleChat);
  router.post("/chat", optionalAuth, handleChat);
}

function mountLegalCompletionRoutes(router: Router, llm: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen'>>, asyncHandler: typeof chatRouteAsyncHandler) {
  router.get('/legal/client-case-sync', requireAuth, asyncHandler(async (req, res) => {
    if (resolveDomain(req.user!).domain !== 'personal') return res.status(403).json({ error: 'Use the organization case workspace for work cases.' });
    const userId = req.user!.uid;
    return res.json({ cases: LegalCases.listCases(LegalCases.legalWorkspaceNamespace(userId), '', null, userId).filter(item => item.createdBy === userId),
      removedCaseIds: LegalCases.listPersonalDeletedCaseIds(userId) });
  }));

  router.post('/legal/client-case-sync', requireAuth, asyncHandler(async (req, res) => {
    const scope = resolveDomain(req.user!);
    if (scope.domain !== 'personal') return res.status(403).json({ error: 'Use the organization case workspace for work cases.' });
    const input = req.body?.case;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.id !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,200}$/.test(input.id)) {
      return res.status(400).json({ error: 'A valid case snapshot is required.' });
    }
    const orgId = resolveLegalCaseworkOrgId({ domain: 'personal', userOrgId: '', userId: req.user!.uid });
    if (LegalCases.listPersonalDeletedCaseIds(req.user!.uid).includes(input.id)) return res.status(409).json({ error: 'This personal case was deleted.', code: 'LEGAL_CASE_DELETED', caseId: input.id });
    const existing = LegalCases.getCase(orgId, input.id, req.user!.uid);
    if (existing && existing.createdBy !== req.user!.uid) return res.status(403).json({ error: 'Case belongs to another account.' });
    const caseFile = LegalCases.upsertCaseSnapshot(orgId, req.user!.uid, input);
    if (req.body.activate === true) {
      const selectionScope = { userId: req.user!.uid, domain: 'personal' as const, orgId: '', productLine: 'legal' };
      const active = getActiveIndustryWorkspaceContext(selectionScope);
      if (active?.attributes.caseId !== caseFile.id || active.name !== caseFile.title) {
        const existing = listIndustryWorkspaceContexts(selectionScope).find(item => item.attributes.caseId === caseFile.id);
        bindIndustryWorkspaceContext(selectionScope, { id: existing?.id, productLine: 'legal', name: caseFile.title,
          attributes: { caseId: caseFile.id, caseName: caseFile.title, caseNumber: caseFile.caseNumber, clientName: caseFile.party, court: caseFile.court, stage: caseFile.stage } });
      }
    }
    return res.json({ case: caseFile });
  }));

  router.delete('/legal/client-case-sync/:caseId', requireAuth, asyncHandler(async (req, res) => {
    const scope = resolveDomain(req.user!);
    if (scope.domain !== 'personal') return res.status(403).json({ error: 'Use the organization case workspace for work cases.' });
    const orgId = resolveLegalCaseworkOrgId({ domain: 'personal', userOrgId: '', userId: req.user!.uid });
    const caseId = String(req.params.caseId);
    if (!/^[a-zA-Z0-9_.:@-]{1,200}$/.test(caseId)) return res.status(400).json({ error: 'A valid case id is required.' });
    const existing = LegalCases.getCase(orgId, caseId, req.user!.uid);
    if (existing && existing.createdBy !== req.user!.uid) return res.status(403).json({ error: 'Case belongs to another account.' });
    const removed = LegalCases.deleteCase(orgId, req.user!.uid, caseId);
    if (!removed) LegalCases.recordPersonalCaseDeletion(req.user!.uid, caseId);
    await flushDBOrThrow();
    return res.json({ deleted: Boolean(removed), tombstoned: true, caseId });
  }));

  // Native review/removal records a user's decision, never a model/tool claim.
  const materialReview = asyncHandler(async (req, res) => {
    const user = req.user!;
    if (!verifyDesktopSessionProof(req.headers[DESKTOP_SESSION_HEADER], user.uid)) {
      return res.status(403).json({ error: 'A current native desktop session is required.' });
    }
    const scope = resolveDomain(user);
    const orgId = resolveLegalCaseworkOrgId({ ...scope, userOrgId: scope.orgId, userId: user.uid });
    const caseId = String(req.params.caseId);
    const materialId = String(req.params.materialId);
    const caseFile = LegalCases.getCase(orgId, caseId, user.uid);
    const material = caseFile?.materials.find(item => item.id === materialId);
    if (!caseFile || !material) return res.status(404).json({ error: 'Case material not found.' });
    try {
      if (scope.domain === 'work') {
        if (req.method !== 'GET' && user.orgRole === 'viewer') return res.status(403).json({ error: 'Viewers cannot modify case materials.' });
        assertOrganizationResourceAccess({ orgId, actorUserId: user.uid, resourceType: 'legal_case',
          resourceId: caseId, ownerUserId: caseFile.createdBy, permission: req.method !== 'GET' ? 'write' : 'read' });
      }
      if (req.method === 'DELETE') {
        if (!/^[a-f0-9]{64}$/.test(String(req.body?.expectedRevision || ''))) return res.status(400).json({ error: 'A current material revision is required.' });
        const saved = LegalCases.removeMaterial(orgId, user.uid, caseId, materialId, req.body.expectedRevision);
        if (!saved) return res.status(404).json({ error: 'Case material not found.' });
        await flushDBOrThrow();
        return res.json({ success: true, caseId, materialId, case: saved });
      }
      if (req.method === 'POST') {
        const decision = req.body?.decision;
        if (!['confirmed', 'revoked'].includes(decision) || !/^[a-f0-9]{64}$/.test(String(req.body?.expectedRevision || ''))) {
          return res.status(400).json({ error: 'A valid review decision and material revision are required.' });
        }
        LegalCases.recordMaterialReview(orgId, user.uid, caseId, materialId, { decision, expectedRevision: req.body.expectedRevision });
        await flushDBOrThrow();
      }
      return res.json({ ...LegalCases.getMaterialReview(orgId, user.uid, caseId, materialId), content: material.content });
    } catch (error: any) {
      if (error instanceof OrganizationResourceAuthorizationError) return res.status(error.statusCode).json({ error: error.message });
      if (error?.code === 'LEGAL_MATERIAL_REVISION_CHANGED') return res.status(409).json({ error: 'The document or case materials changed. Read the current version before confirming.', code: error.code });
      throw error;
    }
  });
  router.get('/legal/cases/:caseId/materials/:materialId/review', requireAuth, requireLocalRequest, materialReview);
  router.post('/legal/cases/:caseId/materials/:materialId/review', requireAuth, requireLocalRequest, materialReview);
  router.delete('/legal/cases/:caseId/materials/:materialId', requireAuth, requireLocalRequest, materialReview);

  const executeLegalTool = asyncHandler(async (req, res) => {
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

    const industryTaskId = String(req.body?.industryWorkflowTaskId || '').trim();
    const workflowScope = { userId, domain, orgId };
    if (industryTaskId) {
      const task = getIndustryWorkflowTask(workflowScope, industryTaskId);
      const metadata = task?.metadata?.industryWorkflow;
      if (!task || metadata?.entryId !== legalToolEntryId(toolName)
        || metadata?.context?.caseIdentity !== legalToolCaseIdentity(args)
        || !['queued', 'in_progress', 'waiting_confirmation'].includes(task.status)) {
        return res.status(409).json({ error: 'The legal workflow no longer matches this case and entry. Reopen the requested workflow.' });
      }
    }

    const request = createRequestAbortController(req, res);
    let record: Awaited<ReturnType<typeof executeToolCall>> | undefined;
    try {
      record = await executeToolCall({
        registry: toolRegistry,
        name: toolName,
        arguments: args,
        context: {
          userId,
          domain,
          orgId,
          requestId: randomUUID(),
          llmGetters: llm,
          source: 'legal-direct-tool',
          executionSignal: request.signal,
          isCancelled: () => request.signal.aborted,
          authenticated: true,
          authRole: req.user!.role,
          orgRole: req.user!.orgRole,
          localExecution: false,
        } as any,
      });
      if (request.signal.aborted || res.destroyed) {
        if (industryTaskId) interruptIndustryWorkflow(workflowScope, industryTaskId, request.signal.aborted, request.signal.aborted ? 'Legal execution cancelled' : 'Legal execution failed');
        return;
      }
      if (record.error) throw new Error(record.error);
      const receipt: Record<string, any> = record.receipt && typeof record.receipt === 'object' ? record.receipt : {};
      const changedIds = Array.isArray(receipt.changedCaseIds) ? receipt.changedCaseIds : [];
      const caseUpdates = [...new Set([...changedIds, args.caseId])].filter((id): id is string => typeof id === 'string' && Boolean(id))
        .map(id => LegalCases.getCase(legalOrgId, id, userId, 'read')).filter(Boolean);
      const industryWorkflow = industryTaskId ? recordIndustryWorkflowExecution({ ...workflowScope, taskId: industryTaskId, resultText: record.result, toolRecords: [record], source: 'legal-direct-tool' }) : undefined;
      return res.json({ requestId: record.requestId, text: record.result, toolName, receipt, verification: record.terminalVerification,
        caseUpdates, artifacts: Array.isArray(receipt.artifacts) ? receipt.artifacts : [], industryWorkflow });
    } catch (err: any) {
      if (industryTaskId) interruptIndustryWorkflow(workflowScope, industryTaskId, request.signal.aborted, request.signal.aborted ? 'Legal execution cancelled' : 'Legal execution failed');
      if (request.signal.aborted || res.destroyed) return;
      console.warn('[LegalDirectTool] Execution failed:', redactDiagnosticSecrets(err?.message || err).slice(0, 500));
      return res.status(500).json({
        error: 'Legal tool execution failed',
        code: 'LEGAL_TOOL_EXECUTION_FAILED',
        requestId: record?.requestId,
      });
    } finally { request.dispose(); }
  });
  router.post("/legal/tool/:toolName", requireAuth, executeLegalTool);
  router.post("/legal/contract-review", requireAuth, (req, res, next) => {
    req.params.toolName = "legal_review_contract";
    req.body = { args: req.body };
    return executeLegalTool(req, res, next);
  });

}

function mountMeetingCompletionRoutes(router: Router, llm: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen'>>, asyncHandler: typeof chatRouteAsyncHandler) {
  router.post("/meeting/analyze", requireAuth, asyncHandler(async (req, res) => {
    const { provider: reqProvider, notes, startedAt, endedAt, language = "zh", purpose = "meeting", legalCase } = req.body || {};
    const userId = req.user?.uid || 'anonymous';
    const requestScope = req.user ? resolveDomain(req.user) : { domain: 'personal' as const, orgId: '' };
    const domain = requestScope.domain;
    const orgId = requestScope.orgId;
    const requestId = randomUUID();
    const preferred = getUserPreferredLLMConfig(userId, { maxTokens: 4096, domain, orgId, requestId, source: 'meeting-analyze' });
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
          `Session opened (wall clock, includes pauses): ${started}`,
          `Session closed (wall clock, not audio duration): ${ended}`,
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
          `Session opened (wall clock, includes pauses): ${started}`,
          `Session closed (wall clock, not audio duration): ${ended}`,
          '',
          'Transcript:',
          transcript,
        ].join('\n');

    const request = createRequestAbortController(req, res);
    try {
      const result = await makeLLMCall(
        [{ role: 'user', content: prompt }],
        [],
        { ...preferred, signal: request.signal },
        ...providerGetterArguments(llm),
      );
      if (request.signal.aborted || res.destroyed) return;
      const report = result.text || '';
      recordTokenUsage(userId, provider, model, result.usage, requestId, 'meeting');
      if (!report.trim() || ['length', 'max_tokens', 'MAX_TOKENS'].includes(result.finishReason || '')) {
        return res.status(502).json({ error: language === 'zh' ? CN_PUBLIC_AGENT_EVENT_MESSAGES.meetingIncomplete : 'No complete meeting report was generated. Preserve the transcript before continuing.' });
      }
      res.json({ requestId, report, usage: result.usage || null });
    } catch (error) {
      if (request.signal.aborted || res.destroyed) return;
      throw error;
    } finally { request.dispose(); }
  }));


  router.post('/meeting/archive', requireAuth, asyncHandler(async (req, res) => {
    const { notes, report = '', startedAt, endedAt, legalCase, meetingId } = req.body || {};
    const userId = req.user!.uid;
    const { domain, orgId } = resolveDomain(req.user!);
    const workspaceId = LegalCases.legalWorkspaceNamespace(userId, domain === 'work' ? orgId : undefined);
    const caseId = typeof legalCase?.id === 'string' ? legalCase.id.trim() : '';
    if (!caseId || typeof meetingId !== 'string' || !meetingId.trim() || meetingId.length > 200 || typeof report !== 'string') {
      return res.status(400).json({ error: 'An explicit case and meeting record are required.' });
    }
    if (domain === 'work' && req.user!.orgRole === 'viewer') {
      return res.status(403).json({ error: 'Organization viewers cannot archive meeting materials.' });
    }
    const current = LegalCases.getCase(workspaceId, caseId, userId, 'write');
    if (!current) return res.status(404).json({ error: 'The requested legal case is unavailable for writing.' });
    const transcript = formatMeetingTranscriptForAnalysis(notes);
    if (!transcript.trim()) return res.status(400).json({ error: 'No meeting transcript to archive.' });
    const request = createRequestAbortController(req, res);
    try {
      const context = { userId, domain, orgId, authenticated: true, authRole: req.user!.role,
        orgRole: req.user!.orgRole, localExecution: false, executionSignal: request.signal,
        isCancelled: () => request.signal.aborted, source: 'meeting-archive' };
      const encoded = await withLegalExecution(context, () => meetingMinutesToCaseHandler(buildLegalMeetingMinutesArgs({
        transcript, report, startedAt, endedAt, meetingId: meetingId.trim(),
        legalCase: { ...current, id: caseId }, orgId: workspaceId, userId,
      }), context));
      if (request.signal.aborted || res.destroyed) return;
      const receipt = decodeToolResult(encoded).receipt as Record<string, any> | undefined;
      const saved = LegalCases.getCase(workspaceId, caseId, userId, 'write');
      const materialIds = receipt?.materialIds;
      const original = saved?.materials.find(material => material.id === materialIds?.transcript && material.type === 'consultation' && material.source === 'import' && material.content === transcript);
      const minutes = saved?.materials.find(material => material.id === materialIds?.minutes && material.type === 'note' && material.source === 'tool');
      if (receipt?.archivedCaseId !== caseId || !saved || !original || !minutes) throw new Error('Meeting archive could not be verified.');
      return res.json({ ok: true, status: 'archived', meetingId: meetingId.trim(), caseId,
        caseFile: saved, materialIds: { transcript: original.id, minutes: minutes.id }, summaryPresent: Boolean(report.trim()) });
    } catch (error: any) {
      if (request.signal.aborted || res.destroyed) return;
      console.warn('[MeetingArchive] Archive failed:', redactDiagnosticSecrets(error?.message || error).slice(0, 500));
      return res.status(500).json({ error: 'Meeting materials were not completely archived.' });
    } finally { request.dispose(); }
  }));
}

const chatRouteAsyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
