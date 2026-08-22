// Misc routes that didn't fit into other modules: founder vision, feedback, admin config, Org chat
import { Router } from "express";
import { flushDBOrThrow, readDB, writeDB, querySQL } from "../../db_layer";
import { runWithTools } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { makeLLMCall, NormalizedMessage } from "../llm/providers";
import { optionalAuth, requireAuth } from "../middleware/auth";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { recordTokenUsage } from "../llm/token_tracker";
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { buildModelCapabilityPolicy } from "../cognition/capability_selection";

export function mountMiscRoutes(router: Router, _jwtSecret: string, llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  // ── Founder Vision ──
  router.get("/founder/vision", (_req, res) => {
    try {
      const db = readDB();
      res.json({ vision: db.founderVision || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/founder/vision", requireAuth, async (req, res) => {
    try {
      const { vision } = req.body || {};
      if (typeof vision !== 'string') return res.status(400).json({ error: 'vision is required' });
      const updatedAt = new Date().toISOString();
      const db = readDB();
      db.founderVision = vision;
      db.founderVisionUpdatedAt = updatedAt;
      writeDB(db);
      await flushDBOrThrow();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Feedback ──
  router.post("/feedback", (req, res) => {
    try {
      const { email, message, type, contact, position } = req.body || {};
      const db = readDB();
      if (!db.feedback) db.feedback = [];
      db.feedback.push({
        id: Math.random().toString(36).substring(2, 15),
        email: email || '',
        message: message || '',
        type: type || 'general',
        contact: contact || '',
        position: position || '',
        createdAt: new Date().toISOString(),
      });
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin Config ──
  router.get("/admin/config", (_req, res) => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'admin_config');
      const config = setting ? JSON.parse(setting.value) : {};
      res.json({ adminEmail: config.adminEmail || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/admin/config", requireAuth, (req, res) => {
    try {
      const { adminEmail } = req.body || {};
      const db = readDB();
      if (!db.settings) db.settings = [];
      const key = 'admin_config';
      const value = JSON.stringify({ adminEmail: adminEmail || '' });
      const existing = db.settings.findIndex((s: any) => s.key === key);
      if (existing >= 0) {
        db.settings[existing].value = value;
      } else {
        db.settings.push({ key, value });
      }
      writeDB(db);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Org Chat (simpler version of /ai/chat, used by CentralLumiChat) ──
  router.post("/chat", optionalAuth, asyncHandler(async (req, res) => {
    const { messages, provider: reqProvider } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userId = req.user?.uid || 'anonymous';
    const domain = req.body?.domain === 'work' ? 'work' : 'personal';
    const orgId = domain === 'work'
      ? String(req.body?.orgId || req.user?.orgId || '').trim()
      : '';
    const preferred = getUserPreferredLLMConfig(userId);
    const provider = preferred.provider;
    const model = preferred.model;
    if (reqProvider && reqProvider !== provider) {
      console.warn(`[MiscChat] Ignoring request provider ${reqProvider}; using primary brain ${provider}/${model} for user ${userId}`);
    }

    try {
      const taskText = messages
        .filter((item: any) => item?.role !== 'assistant')
        .map((item: any) => String(item?.content || item?.message || item?.text || '').trim())
        .filter(Boolean)
        .join('\n')
        .slice(-12000);
      const executionPlan = buildLumiExecutionPipeline({
        dispatch: {
          userId,
          text: taskText,
          channel: 'chat',
          source: 'misc_chat',
          domain,
          orgId,
          operationMode: 'assistant',
          targetIsLumi: true,
        },
        registry: toolRegistry,
        isSanctuary: !req.user,
        source: 'misc_chat',
      });
      const modelToolPolicy = buildModelCapabilityPolicy(executionPlan.execution);
      const result = await runWithTools(
        messages,
        toolRegistry,
        { provider, model, userId, domain, orgId },
        undefined, modelToolPolicy.maxIterations || 3,
        llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
        undefined,
        {
          userId,
          domain,
          orgId,
          llmGetters: llm,
          source: 'misc_chat',
          actionIntent: taskText,
          routedTaskText: executionPlan.turnIntent.flow.routeText,
          toolPolicy: modelToolPolicy,
        },
      );

      const finalized = finalizeLumiResponse({
        taskText,
        responseText: result.text || '',
        toolRecords: result.toolCalls,
        source: 'misc_chat',
      });
      const responseText = finalized.text;
      for (const u of result.usageRecords || []) {
        recordTokenUsage(userId, u.provider, u.model, {
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
        }, `misc_chat_${Date.now()}`, 'chat');
      }
      res.json({
        text: responseText,
        toolCalls: result.toolCalls.length,
        finalized: true,
        blocked: finalized.blocked,
        reason: finalized.reason || '',
      });
    } catch (error: any) {
      console.error("Chat Error:", error);
      res.status(500).json({ error: error.message });
    }
  }));
}
