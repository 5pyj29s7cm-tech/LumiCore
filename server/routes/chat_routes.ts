import { Router } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { checkLLMAccess, recordUsage, estimateTokens } from "../subscription/proxy";
import { runWithTools } from "../llm/adapter";
import { makeLLMCall } from "../llm/providers";
import { toolRegistry } from "../tools/registry";
import { recordLatency } from "../monitor/latency_store";
import { optionalAuth } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { buildUnifiedLegalEntryPrompt } from "../cognition/legal_entry";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import type { ToolExecutionRecord } from "../tools/types";

const REST_CHAT_BASE_SYSTEM_INSTRUCTION = "你是一个名为 Lumi 的本地核心智能体。你致力于全息空间计算和独立 AI 人格生成进化。你的目标是打造全息 AI 世界和文明。你应当表现得专业、深邃且具有前瞻性。你的回复应当简洁且富有启发性。";

function buildRestChatRouteText(messages: unknown, prompt: unknown): string {
  if (Array.isArray(messages)) {
    return messages
      .map((item: any) => String(item?.content || item?.message || item?.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(-12000);
  }
  return String(prompt || '').trim().slice(-12000);
}

function buildRestProviderMessages(messages: unknown, prompt: unknown, systemInstruction: string): any[] {
  const rawMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: 'user', content: String(prompt || '') }];
  const existingSystem = rawMessages
    .filter((item: any) => item?.role === 'system')
    .map((item: any) => String(item?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const systemContent = [systemInstruction, existingSystem].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: systemContent },
    ...rawMessages
      .filter((item: any) => item?.role !== 'system')
      .map((item: any) => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: String(item?.content || item?.message || item?.text || ''),
      })),
  ];
}

function buildRestAnthropicMessages(messages: unknown, prompt: unknown): any[] {
  const rawMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [{ role: 'user', content: String(prompt || '') }];
  return rawMessages
    .filter((item: any) => item?.role !== 'system')
    .map((item: any) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || item?.message || item?.text || ''),
    }));
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

function finalizeRestChatResponse(input: {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: string;
}) {
  return finalizeLumiResponse({
    taskText: input.taskText,
    responseText: input.responseText,
    toolRecords: input.toolRecords || [],
    source: input.source,
  });
}

function dateLikeToIso(value: unknown, fallback = Date.now()): string {
  const date = value ? new Date(value as any) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function shouldArchiveLegalMeeting(purpose: unknown, legalCase: unknown, domain: string, orgId: string): boolean {
  const isLegalMeeting = purpose === 'legal_consultation' || Boolean(legalCase && typeof legalCase === 'object');
  return isLegalMeeting && domain === 'work' && Boolean(orgId);
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
  'legal_verify_citation',
  'legal_import_judgment',
]);

export function formatMeetingTranscriptForAnalysis(notes: unknown[]): string {
  const noteItems = Array.isArray(notes) ? notes : [];
  return noteItems
    .map((note: any) => {
      const time = note?.time ? new Date(note.time).toLocaleTimeString() : '';
      const text = String(note?.text || '').trim();
      const speaker = note?.speakerMatched && note?.speakerLabel
        ? `${String(note.speakerLabel).trim()}: `
        : (note?.speakerMatched === false ? 'Unknown speaker: ' : '');
      return text ? `[${time}] ${speaker}${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mountChatRoutes(router: Router, _jwtSecret: string, llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  const handleChat = asyncHandler(async (req, res) => {
    const { provider: reqProvider = "gemini", model: reqModel, messages, prompt: rawPrompt, message } = req.body;
    const prompt = rawPrompt ?? message;
    const userKey = req.headers["x-api-key"] as string;
    const userId = req.user?.uid || 'anonymous';
    const domain = req.body?.domain === 'work' ? 'work' : 'personal';
    const orgId = domain === 'work'
      ? String(req.body?.orgId || req.user?.orgId || '').trim()
      : '';
    const toolContext = {
      userId,
      domain,
      orgId,
      llmGetters: llm,
      source: 'rest_chat',
    };
    const routeText = buildRestChatRouteText(messages, prompt);
    const systemInstruction = buildRestChatSystemInstruction({
      routeText,
      domain,
      orgId,
      source: 'rest_chat',
    });

    const isBYOK = userKey && userKey.length > 5;
    const preferred = getUserPreferredLLMConfig(userId);
    const provider = isBYOK ? reqProvider : preferred.provider;
    const model = isBYOK ? reqModel : preferred.model;
    if (!isBYOK && reqProvider && reqProvider !== provider) {
      console.warn(`[Chat] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }

    if (!isBYOK) {
      const access = checkLLMAccess({ userId, provider, model: model || '' });
      if (!access.allowed) {
        return res.status(402).json({ error: access.reason, code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED' });
      }
    }

    try {
      let responseText = '';

      if (isBYOK) {
        const llmStart = Date.now();
        if (provider === "gemini") {
          const client = new GoogleGenerativeAI(userKey);
          const modelInstance = client.getGenerativeModel({ model: model || "gemini-2.0-flash", systemInstruction });
          const contents = messages
            ? messages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
            : [{ role: 'user', parts: [{ text: prompt }] }];
          responseText = (await modelInstance.generateContent({ contents })).response.text();
        } else if (provider === "anthropic") {
          const client = new Anthropic({ apiKey: userKey });
          const response = await client.messages.create({
            model: model || "claude-sonnet-4-6",
            max_tokens: 1024,
            system: systemInstruction,
            messages: buildRestAnthropicMessages(messages, prompt),
          });
          responseText = response.content[0].type === 'text' ? response.content[0].text : '';
        } else {
          const client = new OpenAI({ apiKey: userKey, baseURL: provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined });
          const response = await client.chat.completions.create({
            model: model || (provider === "deepseek" ? "deepseek-chat" : provider === "qwen" ? "qwen-plus" : "gpt-4o"),
            messages: buildRestProviderMessages(messages, prompt, systemInstruction),
          });
          responseText = response.choices[0].message.content || '';
        }
        const finalized = finalizeRestChatResponse({
          taskText: routeText,
          responseText,
          source: 'rest_chat',
        });
        responseText = finalized.text;
        recordLatency('llm', Date.now() - llmStart);
        return res.json({
          text: responseText,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
        });
      } else {
        const normalizedMessages: any[] = [
          { role: 'system', content: systemInstruction },
          ...(messages || [{ role: 'user', content: prompt }]).map((m: any) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content || ''
          }))
        ];

        const stream = req.query.stream === 'true';

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const result = await runWithTools(
            normalizedMessages,
            toolRegistry,
            { provider, model, userId, domain, orgId },
            undefined, 3,
            llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
            (chunk) => {
              res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
            },
            toolContext,
          );

          responseText = result.text || '';
          const finalized = finalizeRestChatResponse({
            taskText: routeText,
            responseText,
            toolRecords: result.toolCalls,
            source: 'rest_chat_stream',
          });
          responseText = finalized.text;
          const tokens = estimateTokens(
            normalizedMessages.map((m: any) => m.content || '').join(' ') + ' ' + responseText
          );
          for (const u of result.usageRecords || []) {
            recordTokenUsage(userId, u.provider, u.model, {
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
            }, `rest_chat_${Date.now()}`, 'chat');
          }
          recordUsage(userId, tokens);
          res.write(`data: ${JSON.stringify({
            done: true,
            text: responseText,
            toolCalls: result.toolCalls.length,
            blocked: finalized.blocked,
            reason: finalized.reason,
            notification: finalized.notification,
          })}\n\n`);
          return res.end();
        }

        const result = await runWithTools(
          normalizedMessages,
          toolRegistry,
          { provider, model, userId, domain, orgId },
          undefined, 3,
          llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
          undefined,
          toolContext,
        );

        responseText = result.text || '';
        const finalized = finalizeRestChatResponse({
          taskText: routeText,
          responseText,
          toolRecords: result.toolCalls,
          source: 'rest_chat',
        });
        responseText = finalized.text;
        const tokens = estimateTokens(
          normalizedMessages.map((m: any) => m.content || '').join(' ') + ' ' + responseText
        );
        for (const u of result.usageRecords || []) {
          recordTokenUsage(userId, u.provider, u.model, {
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            totalTokens: u.totalTokens,
          }, `rest_chat_${Date.now()}`, 'chat');
        }
        const usage = recordUsage(userId, tokens);
        return res.json({
          text: responseText,
          usage,
          toolCalls: result.toolCalls.length,
          blocked: finalized.blocked,
          reason: finalized.reason,
          notification: finalized.notification,
        });
      }

      const finalized = finalizeRestChatResponse({
        taskText: routeText,
        responseText,
        source: 'rest_chat',
      });
      res.json({
        text: finalized.text,
        blocked: finalized.blocked,
        reason: finalized.reason,
        notification: finalized.notification,
      });
    } catch (error: any) {
      console.error("AI Proxy Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/ai/chat", optionalAuth, handleChat);
  router.post("/chat", optionalAuth, handleChat);

  router.post("/legal/tool/:toolName", optionalAuth, asyncHandler(async (req, res) => {
    const toolName = String(req.params?.toolName || '').trim();
    if (!DIRECT_LEGAL_TOOL_ALLOWLIST.has(toolName)) {
      return res.status(404).json({ error: 'Unknown or unavailable legal tool' });
    }
    if (!toolRegistry.get(toolName)) {
      return res.status(404).json({ error: `Legal tool "${toolName}" is not registered` });
    }

    const rawArgs = req.body?.args && typeof req.body.args === 'object'
      ? req.body.args
      : (req.body || {});
    const userId = req.user?.uid || String(rawArgs.userId || 'anonymous');
    const domain = rawArgs.domain === 'work' || req.body?.domain === 'work' ? 'work' : 'personal';
    const orgId = String(rawArgs.orgId || req.body?.orgId || req.user?.orgId || 'default').trim() || 'default';
    const args = {
      ...rawArgs,
      orgId,
      userId,
    };

    if (args.persistCase === undefined && (args.caseId || args.caseName || args.title)) {
      args.persistCase = true;
    }

    const text = await toolRegistry.execute(toolName, args, {
      userId,
      domain,
      orgId,
      llmGetters: llm,
      source: 'legal-direct-tool',
    });
    return res.json({ text, toolName });
  }));

  router.post("/legal/contract-review", optionalAuth, asyncHandler(async (req, res) => {
    const contract = String(req.body?.contract || '').trim();
    if (!contract) {
      return res.status(400).json({ error: '请提供合同文本' });
    }

    const userId = req.user?.uid || 'anonymous';
    const domain = req.body?.domain === 'work' ? 'work' : 'personal';
    const orgId = String(req.body?.orgId || req.user?.orgId || 'default').trim() || 'default';
    const args = {
      contract,
      orgId,
      userId,
      caseId: String(req.body?.caseId || '').trim(),
      caseName: String(req.body?.caseName || '').trim(),
      caseType: String(req.body?.caseType || req.body?.cause || '').trim(),
      court: String(req.body?.court || '').trim(),
      persistCase: req.body?.persistCase === true || Boolean(req.body?.caseId || req.body?.caseName),
    };
    const llmReview = toolRegistry.execute('legal_review_contract', args, {
      userId,
      domain,
      orgId,
      llmGetters: llm,
      source: 'legal-contract-review',
    });
    llmReview.catch(() => undefined);

    try {
      const text = await Promise.race([
        llmReview,
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('合同深度审查超时，已改用本地规则审查')), 15_000);
        }),
      ]);

      return res.json({ text, degraded: false });
    } catch (err: any) {
      console.warn('[LegalContractReview] Deep review unavailable:', err?.message || err);
      const fallback = await toolRegistry.execute('legal_review_contract', args, {
        userId,
        domain,
        orgId,
        source: 'legal-contract-review-fallback',
      });
      return res.json({
        text: `${fallback}\n\n*提示：深度 LLM 审查暂未及时完成，已先返回本地规则审查结果。*`,
        degraded: true,
        warning: err?.message || 'Contract review fallback used',
      });
    }
  }));

  router.post("/meeting/analyze", optionalAuth, asyncHandler(async (req, res) => {
    const { provider: reqProvider, notes, startedAt, endedAt, language = "zh", purpose = "meeting", legalCase } = req.body || {};
    const userId = req.user?.uid || 'anonymous';
    const domain = req.body?.domain === 'work' ? 'work' : 'personal';
    const orgId = domain === 'work'
      ? String(req.body?.orgId || req.user?.orgId || '').trim()
      : '';
    const preferred = getUserPreferredLLMConfig(userId, { maxTokens: 1800 });
    const provider = preferred.provider;
    const model = preferred.model;
    if (reqProvider && reqProvider !== provider) {
      console.warn(`[Meeting] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }
    const transcript = formatMeetingTranscriptForAnalysis(notes);

    if (!transcript.trim()) {
      return res.status(400).json({ error: 'No meeting transcript to analyze' });
    }

    const access = checkLLMAccess({ userId, provider, model: model || '' });
    if (!access.allowed) {
      return res.status(402).json({ error: access.reason, code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED' });
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
      llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
    );

    const report = result.text || '';
    const tokens = estimateTokens(prompt + ' ' + report);
    recordTokenUsage(userId, provider, model, result.usage, `meeting_analyze_${Date.now()}`, 'meeting');
    const usage = recordUsage(userId, tokens);
    let legalCasework = '';
    let legalCaseworkError = '';
    if (shouldArchiveLegalMeeting(purpose, legalCase, domain, orgId)) {
      try {
        legalCasework = await toolRegistry.execute('legal_meeting_minutes_to_case', buildLegalMeetingMinutesArgs({
          transcript,
          startedAt,
          endedAt,
          legalCase,
          orgId,
          userId,
        }), {
          userId,
          domain,
          orgId,
          llmGetters: llm,
          source: 'meeting-analyze',
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
