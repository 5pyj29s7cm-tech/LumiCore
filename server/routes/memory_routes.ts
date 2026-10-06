import { type ProviderGetters as SharedProviderGetters, providerGetterArguments } from "../llm/provider_getters";
import { Router } from "express";
import { serializedScopeRoute, sendDurableMutation } from "./durable_mutation";
import { readScopedDeletionReceipt, recordScopedDeletionReceipt } from "../persistence/durable_scope_mutation";
import { getMemoryRow, listReminderRows, updateReminderRow, removeReminderRow } from "../memory/repository";
import { organizeMemories, MemoryOrganizationPlanError } from "../memory/auto_organize";
import {
  queryMemories,
  addMemory,
  removeMemory,
  updateMemoryLifecycle,
  resolveMemoryConflict,
  addReminder,
  runBehavioralAnalysis,
  broadcastMemoryChange,
  getUnconsolidatedEpisodic,
} from "../memory";
import { buildTree, moveNode } from "../memory/tree";
import { consolidateEpisodic, selfReflect, ConsolidationContext } from "../memory/consolidator";
import { buildNarrativeChain } from "../memory/narrative";
import { makeLLMCall } from "../llm/providers";
import { getMemoryFirewallPolicy } from "../memory/firewall";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { requireAuth, resolveDomain } from "../middleware/auth";
import { updateScopedMemory, backfillEmbeddings } from '../memory/store';
import { requireAdmin, requireLocalRequest } from '../middleware/auth';

type MemoryScope = { domain: 'personal' | 'work'; orgId: string };

function getMemoryScope(req: Express.Request): MemoryScope {
  return resolveDomain(req.user!);
}

export function mountMemoryRoutes(
  router: Router,
  _jwtSecret: string,
  llmGetters: SharedProviderGetters,
) {
  mountMemoryRecordRoutes(router);
  mountReminderRoutes(router);
  mountMemoryLearningRoutes(router, llmGetters);
  mountMemoryOrganizationRoutes(router, llmGetters);
  mountMemoryProtectionRoutes(router, llmGetters);
}

function mountMemoryRecordRoutes(router: Router) {
  router.get("/memory/firewall/policy", (_req, res) => {
    res.json(getMemoryFirewallPolicy());
  });

  // Memory CRUD
  router.post('/memory/reindex', requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      const limit = Math.max(1, Math.min(100, Math.floor(Number(req.body?.limit) || 40)));
      const scope = getMemoryScope(req);
      const progress = { attempted: 0, indexed: 0, failed: 0, stale: 0, remaining: 0, errors: {} };
      const count = await backfillEmbeddings(req.user!.uid, { limit, ...scope, signal: controller.signal, progress });
      if (!controller.signal.aborted) await sendDurableMutation(req, res, { ...progress, indexed: count, limit, complete: progress.remaining === 0 });
    } catch {
      if (!controller.signal.aborted) res.status(500).json({ error: 'Memory indexing could not complete.' });
    } finally { res.off('close', onClose); }
  });

  router.get("/memories", requireAuth, (req, res) => {
    try {
      const decoded = req.user!;
      const type = req.query.type as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const includeOperationalTraces = req.query.includeOperationalTraces === 'true';
      const scope = getMemoryScope(req);

      const memories = queryMemories({
        userId: decoded.uid,
        type: type as any,
        query: search,
        limit,
        minConfidence: 0,
        includeOperationalTraces,
        domain: scope.domain,
        orgId: scope.orgId,
      });
      res.json(memories);
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
    }
  });

  router.post("/memories", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const decoded = req.user!;
      const { type, content, keywords, confidence } = req.body;
      const scope = getMemoryScope(req);

      if (!type || !content) {
        return res.status(400).json({ error: "type and content are required" });
      }

      const memory = addMemory({
        userId: decoded.uid,
        type,
        content,
        keywords: keywords || [],
        confidence: confidence || 0.5,
        sourceInteractionId: 'manual',
      }, { domain: scope.domain, orgId: scope.orgId, source: 'manual', userApproved: true });
      return sendDurableMutation(req, res, memory, () => broadcastMemoryChange({ userId: decoded.uid, ...scope }, 'added', memory.id));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }));

  router.put("/memories/:id", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const decoded = req.user!;
      const { id } = req.params;
      const { content, keywords, confidence, type, parentId, nodeType } = req.body;
      const scope = getMemoryScope(req);

      const existing = updateScopedMemory({ userId: decoded.uid, ...scope }, id,
        { content, keywords, confidence, type, parentId, nodeType });
      if (!existing) return res.status(404).json({ error: "Memory not found" });
      return sendDurableMutation(req, res, existing, () => broadcastMemoryChange({ userId: decoded.uid, ...scope }, 'updated', existing.id));
    } catch (e: any) {
      res.status(e instanceof RangeError ? 400 : 500).json({ error: e.message });
    }
  }));

  router.delete("/memories/:id", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const decoded = req.user!;
      const { id } = req.params;
      const scope = getMemoryScope(req);
      const ownerScope = { userId: decoded.uid, ...scope };
      const previousDeletion = readScopedDeletionReceipt(ownerScope, 'memory', id);
      if (previousDeletion) {
        return sendDurableMutation(req, res, previousDeletion, () => broadcastMemoryChange(ownerScope, 'deleted', id));
      }

      const memory = getMemoryRow(ownerScope, id);
      if (!memory) return res.status(404).json({ error: "Memory not found" });
      const memoryId = memory.id;
      removeMemory(memoryId);
      recordScopedDeletionReceipt(ownerScope, 'memory', memoryId, { success: true });
      return sendDurableMutation(req, res, { success: true }, () => broadcastMemoryChange({ userId: decoded.uid, ...scope }, 'deleted', memoryId));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }));

  // Behavioral analysis
  router.post("/memory/analyze-behavior", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const scope = getMemoryScope(req);
      const count = runBehavioralAnalysis(req.user!.uid, scope.domain, scope.orgId);
      return sendDurableMutation(req, res, { success: true, patternsFound: count }, () => broadcastMemoryChange({ userId: req.user!.uid, ...scope }, 'updated', 'behavioral-analysis'));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));
}

function mountReminderRoutes(router: Router) {
  // Reminders CRUD
  router.get("/reminders", requireAuth, (req, res) => {
    try {
      const decoded = req.user!;
      const scope = getMemoryScope(req);
      const reminders = listReminderRows({ userId: decoded.uid, ...scope });
      res.json(reminders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/reminders", requireAuth, async (req, res) => {
    try {
      const decoded = req.user!;
      const scope = getMemoryScope(req);
      const { content, dueAt } = req.body || {};
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }
      const reminder = addReminder({
        userId: decoded.uid,
        content: content.trim(),
        dueAt: dueAt || null,
        sourceInteractionId: "manual",
        domain: scope.domain,
        orgId: scope.orgId,
      });
      return await sendDurableMutation(req, res, reminder, undefined, { retryable: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/reminders/:id", requireAuth, async (req, res) => {
    try {
      const decoded = req.user!;
      const scope = getMemoryScope(req);
      const { content, dueAt, status } = req.body || {};
      const reminder = updateReminderRow({ userId: decoded.uid, ...scope }, req.params.id, draft => {
        if (content !== undefined) draft.content = String(content).trim();
        if (dueAt !== undefined) draft.dueAt = dueAt || null;
        if (status === "fired" && draft.status !== "fired") {
          draft.status = "fired";
          draft.firedAt = new Date().toISOString();
        } else if (status === "pending") { draft.status = "pending"; draft.firedAt = null; }
      });
      if (!reminder) return res.status(404).json({ error: "Reminder not found" });
      return await sendDurableMutation(req, res, reminder);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/reminders/:id", requireAuth, async (req, res) => {
    try {
      const decoded = req.user!;
      const scope = getMemoryScope(req);
      if (!removeReminderRow({ userId: decoded.uid, ...scope }, req.params.id)) {
        return res.status(404).json({ error: "Reminder not found" });
      }
      return await sendDurableMutation(req, res, { success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

function mountMemoryLearningRoutes(router: Router, llmGetters: SharedProviderGetters) {
  // Memory consolidation
  router.post("/memory/consolidate", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const userId = req.user!.uid;
      const scope = getMemoryScope(req);
      const preferred = getUserPreferredLLMConfig(userId, { domain: scope.domain, orgId: scope.orgId });
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || preferred.provider,
        model: (req.body.model as any) || preferred.model,
        domain: scope.domain,
        orgId: scope.orgId,
      };
      const minCount = Number(req.body.minCount) || 10;
      const result = await consolidateEpisodic(
        ctx, minCount,
        ...providerGetterArguments(llmGetters),
      );
      if (result) {
        return sendDurableMutation(req, res, { success: true, memory: result }, () => broadcastMemoryChange({ userId, ...scope }, 'updated', result.id));
      } else {
        const unconsolidated = getUnconsolidatedEpisodic(userId, scope.domain, scope.orgId);
        res.json({ success: false, reason: 'Not enough unconsolidated episodic memories', unconsolidatedCount: unconsolidated.length, threshold: minCount });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Self-reflection
  router.post("/memory/self-reflect", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const userId = req.user!.uid;
      const scope = getMemoryScope(req);
      const preferred = getUserPreferredLLMConfig(userId, { domain: scope.domain, orgId: scope.orgId });
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || preferred.provider,
        model: (req.body.model as any) || preferred.model,
        domain: scope.domain,
        orgId: scope.orgId,
      };
      const result = await selfReflect(
        ctx,
        ...providerGetterArguments(llmGetters),
      );
      if (result) {
        return sendDurableMutation(req, res, { success: true, memory: result }, () => broadcastMemoryChange({ userId, ...scope }, 'updated', result.id));
      } else {
        res.json({ success: false, reason: 'No growth memories to reflect on' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  // Growth timeline
  router.get("/memory/growth", requireAuth, (req, res) => {
    const userId = req.user!.uid;
    const scope = getMemoryScope(req);
    const growth = queryMemories({ userId, tier: 'growth', limit: Number(req.query.limit) || 50, minConfidence: 0.4, domain: scope.domain, orgId: scope.orgId });
    const core = queryMemories({ userId, tier: 'core_identity', limit: 10, domain: scope.domain, orgId: scope.orgId });
    res.json({ growth, coreIdentity: core });
  });

  router.post("/memory/:id/conflict/resolve", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const decoded = req.user!;
      const scope = getMemoryScope(req);
      const resolution = String(req.body?.resolution || '');
      if (resolution !== 'keep_both' && resolution !== 'prefer_one') {
        return res.status(400).json({ error: 'resolution must be keep_both or prefer_one' });
      }
      const memories = resolveMemoryConflict({
        userId: decoded.uid,
        memoryId: req.params.id,
        resolution,
        chosenMemoryId: req.body?.chosenMemoryId,
        domain: scope.domain,
        orgId: scope.orgId,
      });
      return sendDurableMutation(req, res, { success: true, memories }, () => {
        for (const memory of memories) broadcastMemoryChange({ userId: decoded.uid, ...scope }, 'updated', memory.id);
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      res.status(/not found|no related/i.test(message) ? 404 : 400).json({ error: message });
    }
  }));

  // Memory tiers
  router.get("/memory/tiers", requireAuth, (req, res) => {
    const userId = req.user!.uid;
    const scope = getMemoryScope(req);
    const tiers: Record<string, any[]> = {};
    for (const tier of ['core_identity', 'growth', 'internalized', 'episodic']) {
      tiers[tier] = queryMemories({ userId, tier: tier as any, limit: Number(req.query.limit) || 100, domain: scope.domain, orgId: scope.orgId });
    }
    res.json({ tiers });
  });

  // Change memory tier
  router.put("/memory/:id/tier", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    const decoded = req.user!;
    const { tier } = req.body;
    const validTiers = ['episodic', 'internalized', 'growth', 'core_identity'];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
    }
    const scope = getMemoryScope(req);
    const all = queryMemories({ userId: decoded.uid, limit: 9999, domain: scope.domain, orgId: scope.orgId });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (tier === 'core_identity' && !req.body.confirmed) {
      return res.status(400).json({ error: 'Promoting to core_identity requires confirmed:true', currentTier: mem.tier, currentImportance: mem.importance });
    }

    const updated = updateMemoryLifecycle({
      userId: mem.userId,
      memoryId: mem.id,
      domain: mem.domain || scope.domain,
      orgId: mem.orgId || scope.orgId,
      tier,
      confidence: tier === 'core_identity' ? 1.0 : mem.confidence,
      importance: tier === 'core_identity' ? Math.max(0.9, mem.importance) : mem.importance,
      retention: tier === 'core_identity' ? 'permanent' : mem.retention,
      userApproved: tier === 'core_identity' ? true : mem.userApproved,
    });
    if (!updated) return res.status(404).json({ error: 'Memory not found' });
    return sendDurableMutation(req, res, { success: true, memory: updated }, () => broadcastMemoryChange({ userId: mem.userId, ...scope }, 'updated', updated.id));
  }));
}

function mountMemoryOrganizationRoutes(router: Router, llmGetters: SharedProviderGetters) {
  // Memory tree — returns full nested tree structure
  router.get("/memory/tree", requireAuth, (req, res) => {
    try {
      const decoded = req.user!;
      const agentId = (req.query.agentId as string) || '';
      const before = (req.query.before as string) || undefined;
      const scope = getMemoryScope(req);
      const all = queryMemories({ userId: decoded.uid, agentId, limit: 9999, minConfidence: 0, before, domain: scope.domain, orgId: scope.orgId });
      const tree = buildTree(all);
      res.json({ tree });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Move a memory node to a new parent
  router.put("/memory/:id/move", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    try {
      const decoded = req.user!;
      const { parentId } = req.body;
      const scope = getMemoryScope(req);
      const owner = { userId: decoded.uid, ...scope };
      const mem = getMemoryRow(owner, req.params.id);
      if (!mem) return res.status(404).json({ error: "Memory not found" });
      const ok = moveNode(req.params.id, parentId ?? null, { userId: decoded.uid, domain: scope.domain, orgId: scope.orgId });
      if (!ok) return res.status(400).json({ error: "Cannot move: circular reference or parent not found" });
      return sendDurableMutation(req, res, { success: true, memory: getMemoryRow(owner, mem.id) }, () => broadcastMemoryChange({ userId: decoded.uid, ...scope }, 'updated', mem.id));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }));

  router.post("/memory/auto-organize", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      const scope = { userId: req.user!.uid, ...getMemoryScope(req) };
      const result = await organizeMemories(scope, async (prompt, signal) => {
        const reply = await makeLLMCall([{ role: 'user', content: prompt }], [],
          { ...getUserPreferredLLMConfig(scope.userId, scope), signal }, ...providerGetterArguments(llmGetters));
        let authorized = false;
        requireAuth(req, res, () => { authorized = true; });
        if (!authorized) controller.abort(new DOMException('Memory request authorization revoked', 'AbortError'));
        signal.throwIfAborted();
        return reply.text || '';
      }, controller.signal);
      if (result.considered < 3) return res.json({ success: false, reason: 'Need at least 3 unorganized memories', count: result.considered });
      return await sendDurableMutation(req, res, { success: true, branchesCreated: result.branches, memoriesAssigned: result.assigned },
        () => broadcastMemoryChange(scope, 'updated', 'auto-organize'));
    } catch (error: any) {
      if (!controller.signal.aborted && !res.headersSent) {
        if (error instanceof MemoryOrganizationPlanError) res.json({ success: false, reason: error.message });
        else res.status(500).json({ error: error.message });
      }
    } finally { res.off('close', onClose); }
  }));
}

function mountMemoryProtectionRoutes(router: Router, llmGetters: SharedProviderGetters) {
  // Toggle core identity protection
  router.put("/memory/:id/protect", requireAuth, serializedScopeRoute("memory", async (req, res) => {
    const decoded3 = req.user!;
    const scope = getMemoryScope(req);
    const all = queryMemories({ userId: decoded3.uid, limit: 9999, domain: scope.domain, orgId: scope.orgId });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (req.body?.protected !== undefined && typeof req.body.protected !== 'boolean') {
      return res.status(400).json({ error: 'protected must be a boolean' });
    }
    // New clients send a target state, making a failed-save retry idempotent.
    // Retain the old toggle for clients which have not yet migrated.
    const shouldProtect = req.body?.protected ?? (mem.tier !== 'core_identity');
    if (!shouldProtect && mem.tier !== 'core_identity') {
      return sendDurableMutation(req, res, { success: true, protected: false, memory: mem }, () => broadcastMemoryChange({ userId: mem.userId, ...scope }, 'updated', mem.id));
    }
    if (!shouldProtect) {
      const updated = updateMemoryLifecycle({
        userId: mem.userId,
        memoryId: mem.id,
        domain: mem.domain || scope.domain,
        orgId: mem.orgId || scope.orgId,
        tier: 'growth',
        confidence: mem.confidence,
        importance: Math.min(0.8, mem.importance),
        retention: mem.retention,
        userApproved: mem.userApproved,
      });
      if (!updated) return res.status(404).json({ error: 'Memory not found' });
      return sendDurableMutation(req, res, { success: true, protected: false, memory: updated }, () => broadcastMemoryChange({ userId: mem.userId, ...scope }, 'updated', updated.id), { retryable: typeof req.body?.protected === 'boolean' });
    } else {
      const updated = updateMemoryLifecycle({
        userId: mem.userId,
        memoryId: mem.id,
        domain: mem.domain || scope.domain,
        orgId: mem.orgId || scope.orgId,
        tier: 'core_identity',
        confidence: 1.0,
        importance: Math.max(0.9, mem.importance),
        retention: 'permanent',
        userApproved: true,
      });
      if (!updated) return res.status(404).json({ error: 'Memory not found' });
      return sendDurableMutation(req, res, { success: true, protected: true, memory: updated }, () => broadcastMemoryChange({ userId: mem.userId, ...scope }, 'updated', updated.id), { retryable: typeof req.body?.protected === 'boolean' });
    }
  }));

  // Memory narrative chain — weave related memories into a chronological story
  router.get("/memory/narrative", requireAuth, async (req, res) => {
    try {
      const decoded = req.user!;
      const userId = decoded.uid;
      const scope = getMemoryScope(req);
      const topic = req.query.topic as string;
      if (!topic) return res.status(400).json({ error: "topic query parameter is required" });

      const limit = parseInt(req.query.limit as string) || 10;
      const result = await buildNarrativeChain({
        userId,
        topic,
        limit,
        domain: scope.domain,
        orgId: scope.orgId,
        getDeepSeek: llmGetters.getDeepSeek,
        getGemini: llmGetters.getGemini,
        getOpenAI: llmGetters.getOpenAI,
        getAnthropic: llmGetters.getAnthropic,
        getQwen: llmGetters.getQwen,
        getOllama: llmGetters.getOllama,
        getLmStudio: llmGetters.getLmStudio,
        getArk: llmGetters.getArk,
        getXiaomi: llmGetters.getXiaomi,
        getKimi: llmGetters.getKimi,
        getGlm: llmGetters.getGlm,
        getRelay: llmGetters.getRelay,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Memory timeline — returns chronological memory timeline view grouped by date
  router.get("/memory/timeline", requireAuth, (req, res) => {
    try {
      const decoded = req.user!;
      const userId = decoded.uid;
      const scope = getMemoryScope(req);

      const start = (req.query.start as string) || undefined;
      const end = (req.query.end as string) || undefined;
      const limit = parseInt(req.query.limit as string) || 500;

      const memories = queryMemories({
        userId,
        after: start,
        before: end,
        limit,
        minConfidence: 0,
        domain: scope.domain,
        orgId: scope.orgId,
      });

      // Group by date
      const byDate = new Map<string, { count: number; topMemories: typeof memories }>();
      for (const m of memories) {
        const date = (m.createdAt || '').slice(0, 10);
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, { count: 0, topMemories: [] });
        const entry = byDate.get(date)!;
        entry.count++;
        if (entry.topMemories.length < 3) entry.topMemories.push(m);
      }

      const timeline = [...byDate.entries()]
        .map(([date, data]) => ({ date, count: data.count, topMemories: data.topMemories }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.json({ timeline });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
