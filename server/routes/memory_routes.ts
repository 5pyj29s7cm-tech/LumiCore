import { Router } from "express";
import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../../db_layer";
import {
  queryMemories, addMemory, removeMemory,
  addReminder, fireReminder,
  runBehavioralAnalysis, broadcastMemoryChange,
  getDueReminders, getUnconsolidatedEpisodic,
} from "../memory";
import { buildTree, moveNode, flattenTree, ensureBranch } from "../memory/tree";
import { consolidateEpisodic, selfReflect, ConsolidationContext } from "../memory/consolidator";
import { buildNarrativeChain } from "../memory/narrative";
import { makeLLMCall } from "../llm/providers";
import { getMemoryFirewallPolicy } from "../memory/firewall";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";

function getAuthToken(req: any): string | undefined {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  return token;
}

type MemoryScope = { domain: 'personal' | 'work'; orgId: string };

function getMemoryScope(req: any, decoded: any): MemoryScope {
  return decoded.orgId
    ? { domain: 'work', orgId: String(decoded.orgId) }
    : { domain: 'personal', orgId: '' };
}

export function mountMemoryRoutes(
  router: Router,
  jwtSecret: string,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
  },
) {
  router.get("/memory/firewall/policy", (_req, res) => {
    res.json(getMemoryFirewallPolicy());
  });

  // Memory CRUD
  router.get("/memories", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const type = req.query.type as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const includeOperationalTraces = req.query.includeOperationalTraces === 'true';
      const scope = getMemoryScope(req, decoded);

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

  router.post("/memories", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { type, content, keywords, confidence } = req.body;
      const scope = getMemoryScope(req, decoded);

      if (!type || !content) {
        return res.status(400).json({ error: "type and content are required" });
      }

      const memory = addMemory({
        userId: decoded.uid.replace(/[^a-zA-Z0-9_-]/g, '_'),
        type,
        content,
        keywords: keywords || [],
        confidence: confidence || 0.5,
        sourceInteractionId: 'manual',
      }, { domain: scope.domain, orgId: scope.orgId, source: 'manual', userApproved: true });
      broadcastMemoryChange(decoded.uid, 'added', memory.id);
      res.json(memory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/memories/:id", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { id } = req.params;
      const { content, keywords, confidence, type, parentId, nodeType } = req.body;

      const all = readDB().memories || [];
      const idx = all.findIndex((m: any) => m.id === id && m.userId === decoded.uid);
      if (idx === -1) return res.status(404).json({ error: "Memory not found" });

      const existing = all[idx];
      if (content !== undefined) existing.content = content;
      if (keywords !== undefined) existing.keywords = keywords;
      if (confidence !== undefined) existing.confidence = confidence;
      if (type !== undefined) existing.type = type;
      if (parentId !== undefined) existing.parentId = parentId;
      if (nodeType !== undefined) existing.nodeType = nodeType;
      existing.updatedAt = new Date().toISOString();

      const db = readDB();
      db.memories = all;
      writeDB(db);
      broadcastMemoryChange(decoded.uid, 'updated', existing.id);
      res.json(existing);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/memories/:id", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { id } = req.params;

      const all = readDB().memories || [];
      const idx = all.findIndex((m: any) => m.id === id && m.userId === decoded.uid);
      if (idx === -1) return res.status(404).json({ error: "Memory not found" });

      const memoryId = all[idx].id;
      all.splice(idx, 1);
      const db = readDB();
      db.memories = all;
      writeDB(db);
      broadcastMemoryChange(decoded.uid, 'deleted', memoryId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Behavioral analysis
  router.post("/memory/analyze-behavior", (req, res) => {
    try {
      const token = getAuthToken(req);
      let uid = 'anonymous';
      if (token) {
        try { const decoded: any = jwt.verify(token, jwtSecret); uid = decoded.uid; } catch {}
      }
      const count = runBehavioralAnalysis(uid);
      res.json({ success: true, patternsFound: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reminders CRUD
  router.get("/reminders", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const scope = getMemoryScope(req, decoded);
      const db = readDB();
      const reminders = (db.reminders || []).filter((r: any) =>
        r.userId === decoded.uid &&
        (r.domain || 'personal') === scope.domain &&
        (r.orgId || '') === scope.orgId
      );
      res.json(reminders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/reminders", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const scope = getMemoryScope(req, decoded);
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
      res.json(reminder);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put("/reminders/:id", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const scope = getMemoryScope(req, decoded);
      const db = readDB();
      const reminders = db.reminders || [];
      const reminder = reminders.find((r: any) =>
        r.id === req.params.id &&
        r.userId === decoded.uid &&
        (r.domain || 'personal') === scope.domain &&
        (r.orgId || '') === scope.orgId
      );
      if (!reminder) return res.status(404).json({ error: "Reminder not found" });

      const { content, dueAt, status } = req.body || {};
      if (content !== undefined) reminder.content = String(content).trim();
      if (dueAt !== undefined) reminder.dueAt = dueAt || null;
      if (status === "fired" && reminder.status !== "fired") {
        fireReminder(reminder.id);
        return res.json({ ...reminder, status: "fired", firedAt: new Date().toISOString() });
      }
      if (status === "pending") {
        reminder.status = "pending";
        reminder.firedAt = null;
      }
      db.reminders = reminders;
      writeDB(db);
      res.json(reminder);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/reminders/:id", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const scope = getMemoryScope(req, decoded);
      const db = readDB();
      const reminders = db.reminders || [];
      const idx = reminders.findIndex((r: any) =>
        r.id === req.params.id &&
        r.userId === decoded.uid &&
        (r.domain || 'personal') === scope.domain &&
        (r.orgId || '') === scope.orgId
      );
      if (idx === -1) return res.status(404).json({ error: "Reminder not found" });
      reminders.splice(idx, 1);
      db.reminders = reminders;
      writeDB(db);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Memory consolidation
  router.post("/memory/consolidate", async (req, res) => {
    try {
      const token = getAuthToken(req);
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      let decoded: any;
      try { decoded = jwt.verify(token, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
      const userId = decoded.uid || 'anonymous';
      const scope = getMemoryScope(req, decoded);
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || 'deepseek',
        model: (req.body.model as any) || 'deepseek-v4-flash',
        domain: scope.domain,
        orgId: scope.orgId,
      };
      const minCount = Number(req.body.minCount) || 10;
      const result = await consolidateEpisodic(
        ctx, minCount,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );
      if (result) {
        broadcastMemoryChange(userId, 'updated', result.id);
        res.json({ success: true, memory: result });
      } else {
        const unconsolidated = getUnconsolidatedEpisodic(userId, scope.domain, scope.orgId);
        res.json({ success: false, reason: 'Not enough unconsolidated episodic memories', unconsolidatedCount: unconsolidated.length, threshold: minCount });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Self-reflection
  router.post("/memory/self-reflect", async (req, res) => {
    try {
      const token = getAuthToken(req);
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      let decoded: any;
      try { decoded = jwt.verify(token, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
      const userId = decoded.uid || 'anonymous';
      const scope = getMemoryScope(req, decoded);
      const ctx: ConsolidationContext = {
        userId,
        provider: (req.body.provider as any) || 'deepseek',
        model: (req.body.model as any) || 'deepseek-v4-flash',
        domain: scope.domain,
        orgId: scope.orgId,
      };
      const result = await selfReflect(
        ctx,
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );
      if (result) {
        broadcastMemoryChange(userId, 'updated', result.id);
        res.json({ success: true, memory: result });
      } else {
        res.json({ success: false, reason: 'No growth memories to reflect on' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Growth timeline
  router.get("/memory/growth", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let decoded: any;
    try { decoded = jwt.verify(token, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
    const userId = decoded.uid || 'anonymous';
    const scope = getMemoryScope(req, decoded);
    const growth = queryMemories({ userId, tier: 'growth', limit: Number(req.query.limit) || 50, minConfidence: 0.4, domain: scope.domain, orgId: scope.orgId });
    const core = queryMemories({ userId, tier: 'core_identity', limit: 10, domain: scope.domain, orgId: scope.orgId });
    res.json({ growth, coreIdentity: core });
  });

  // Memory tiers
  router.get("/memory/tiers", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let decoded: any;
    try { decoded = jwt.verify(token, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
    const userId = decoded.uid || 'anonymous';
    const scope = getMemoryScope(req, decoded);
    const tiers: Record<string, any[]> = {};
    for (const tier of ['core_identity', 'growth', 'internalized', 'episodic']) {
      tiers[tier] = queryMemories({ userId, tier: tier as any, limit: Number(req.query.limit) || 100, domain: scope.domain, orgId: scope.orgId });
    }
    res.json({ tiers });
  });

  // Change memory tier
  router.put("/memory/:id/tier", (req, res) => {
    const token2 = getAuthToken(req);
    if (!token2) return res.status(401).json({ error: 'Authentication required' });
    let decoded: any;
    try { decoded = jwt.verify(token2, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
    const { tier } = req.body;
    const validTiers = ['episodic', 'internalized', 'growth', 'core_identity'];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
    }
    const scope = getMemoryScope(req, decoded);
    const all = queryMemories({ userId: decoded.uid, limit: 9999, domain: scope.domain, orgId: scope.orgId });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (tier === 'core_identity' && !req.body.confirmed) {
      return res.status(400).json({ error: 'Promoting to core_identity requires confirmed:true', currentTier: mem.tier, currentImportance: mem.importance });
    }

    removeMemory(mem.id);
    const updated = addMemory(
      {
        userId: mem.userId,
        type: mem.type,
        content: mem.content,
        keywords: mem.keywords,
        confidence: tier === 'core_identity' ? 1.0 : mem.confidence,
        sourceInteractionId: mem.sourceInteractionId,
      },
      { tier, perspective: mem.perspective, importance: tier === 'core_identity' ? Math.max(0.9, mem.importance) : mem.importance, parentId: mem.parentId, agentId: mem.agentId, nodeType: mem.nodeType, domain: mem.domain || scope.domain, orgId: mem.orgId || scope.orgId, source: mem.source || 'manual', privacyClass: mem.privacyClass, retention: tier === 'core_identity' ? 'permanent' : mem.retention, userApproved: tier === 'core_identity' ? true : mem.userApproved },
    );
    broadcastMemoryChange(mem.userId, 'updated', updated.id);
    res.json({ success: true, memory: updated });
  });

  // Memory tree — returns full nested tree structure
  router.get("/memory/tree", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const agentId = (req.query.agentId as string) || '';
      const before = (req.query.before as string) || undefined;
      const scope = getMemoryScope(req, decoded);
      const all = queryMemories({ userId: decoded.uid, agentId, limit: 9999, minConfidence: 0, before, domain: scope.domain, orgId: scope.orgId });
      const tree = buildTree(all);
      res.json({ tree });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Move a memory node to a new parent
  router.put("/memory/:id/move", (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const { parentId } = req.body;
      const scope = getMemoryScope(req, decoded);
      const db = readDB();
      const mem = (db.memories || []).find((m: any) =>
        m.id === req.params.id &&
        m.userId === decoded.uid &&
        (m.domain || 'personal') === scope.domain &&
        (m.orgId || '') === scope.orgId
      );
      if (!mem) return res.status(404).json({ error: "Memory not found" });
      const ok = moveNode(req.params.id, parentId ?? null, { userId: decoded.uid, domain: scope.domain, orgId: scope.orgId });
      if (!ok) return res.status(400).json({ error: "Cannot move: circular reference or parent not found" });
      broadcastMemoryChange(decoded.uid, 'updated', mem.id);
      res.json({ success: true, memory: mem });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // LLM auto-organize — group unorganized leaf memories into topic branches
  router.post("/memory/auto-organize", async (req, res) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, jwtSecret);
      const userId = decoded.uid;
      const scope = getMemoryScope(req, decoded);
      const db = readDB();
      const allMemories: any[] = db.memories || [];

      // Find unorganized leaf memories (no parent, not branches)
      const orphans = allMemories.filter(
        (m: any) =>
          m.userId === userId &&
          m.nodeType !== 'branch' &&
          !m.parentId &&
          (m.domain || 'personal') === scope.domain &&
          (m.orgId || '') === scope.orgId,
      );

      if (orphans.length < 3) {
        return res.json({ success: false, reason: 'Need at least 3 unorganized memories', count: orphans.length });
      }

      const tree = buildTree(allMemories.filter((m: any) =>
        m.userId === userId &&
        (m.domain || 'personal') === scope.domain &&
        (m.orgId || '') === scope.orgId,
      ));
      const treeSummary = tree.map(t => `- ${t.node.content} [${t.node.nodeType}] (${t.children.length} children)`).join('\n');

      const prompt = `You are organizing a memory tree. Below is the current tree structure and a list of unorganized memories.

CURRENT TREE:
${treeSummary || '(empty)'}

UNORGANIZED MEMORIES:
${orphans.map((m: any) => `- [${m.id}] ${m.content}`).join('\n')}

Group these unorganized memories into 3-8 topic branches. For each memory, decide which topic it belongs to.
Return JSON:
{
  "branches": [
    {
      "title": "Topic name (short, 2-4 words)",
      "memoryIds": ["mem_xxx", "mem_yyy"]
    }
  ]
}

Rules:
- Every unorganized memory MUST be assigned to exactly one branch
- Branch titles should be meaningful topic names
- Create as few branches as necessary (merge similar topics)
- Return ONLY valid JSON, no markdown`;

      const llmResult = await makeLLMCall(
        [{ role: 'user', content: prompt }],
        [],
        getUserPreferredLLMConfig(userId, { domain: scope.domain, orgId: scope.orgId }),
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      );

      let plan: { branches: { title: string; memoryIds: string[] }[] };
      try {
        const json = (llmResult.text || '').replace(/```json|```/g, '').trim();
        plan = JSON.parse(json);
      } catch {
        return res.json({ success: false, reason: 'LLM returned invalid JSON' });
      }

      let branchCount = 0;
      let assignedCount = 0;
      for (const branch of plan.branches) {
        if (!branch.title || !Array.isArray(branch.memoryIds)) continue;
        const branchNode = ensureBranch(userId, branch.title, '', null, { domain: scope.domain, orgId: scope.orgId });
        branchCount++;
        for (const memId of branch.memoryIds) {
          const ok = moveNode(memId, branchNode.id, { userId, domain: scope.domain, orgId: scope.orgId });
          if (ok) assignedCount++;
        }
      }

      broadcastMemoryChange(userId, 'updated', 'auto-organize');
      res.json({ success: true, branchesCreated: branchCount, memoriesAssigned: assignedCount });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Toggle core identity protection
  router.put("/memory/:id/protect", (req, res) => {
    const token3 = getAuthToken(req);
    if (!token3) return res.status(401).json({ error: 'Authentication required' });
    let decoded3: any;
    try { decoded3 = jwt.verify(token3, jwtSecret); } catch { return res.status(401).json({ error: 'Invalid token' }); }
    const scope = getMemoryScope(req, decoded3);
    const all = queryMemories({ userId: decoded3.uid, limit: 9999, domain: scope.domain, orgId: scope.orgId });
    const mem = all.find(m => m.id === req.params.id);
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    if (mem.tier === 'core_identity') {
      removeMemory(mem.id);
      const updated = addMemory(
        { userId: mem.userId, type: mem.type, content: mem.content, keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: mem.sourceInteractionId },
        { tier: 'growth', perspective: mem.perspective, importance: Math.min(0.8, mem.importance), parentId: mem.parentId, agentId: mem.agentId, nodeType: mem.nodeType, domain: mem.domain || scope.domain, orgId: mem.orgId || scope.orgId, source: mem.source || 'manual', privacyClass: mem.privacyClass, retention: mem.retention, userApproved: mem.userApproved },
      );
      broadcastMemoryChange(mem.userId, 'updated', updated.id);
      res.json({ success: true, protected: false, memory: updated });
    } else {
      removeMemory(mem.id);
      const updated = addMemory(
        { userId: mem.userId, type: mem.type, content: mem.content, keywords: mem.keywords, confidence: 1.0, sourceInteractionId: mem.sourceInteractionId },
        { tier: 'core_identity', perspective: mem.perspective, importance: Math.max(0.9, mem.importance), parentId: mem.parentId, agentId: mem.agentId, nodeType: mem.nodeType, domain: mem.domain || scope.domain, orgId: mem.orgId || scope.orgId, source: mem.source || 'manual', privacyClass: mem.privacyClass, retention: 'permanent', userApproved: true },
      );
      broadcastMemoryChange(mem.userId, 'updated', updated.id);
      res.json({ success: true, protected: true, memory: updated });
    }
  });

  // Memory narrative chain — weave related memories into a chronological story
  router.get("/memory/narrative", async (req, res) => {
    try {
      const token = getAuthToken(req);
      if (!token) return res.status(401).json({ error: "Unauthorized" });
      const decoded: any = jwt.verify(token, jwtSecret);
      const userId = decoded.uid;
      const scope = getMemoryScope(req, decoded);
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
        getQwen: llmGetters.getQwen,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Memory timeline — returns chronological memory timeline view grouped by date
  router.get("/memory/timeline", (req, res) => {
    try {
      const token = getAuthToken(req);
      if (!token) return res.status(401).json({ error: "Unauthorized" });
      const decoded: any = jwt.verify(token, jwtSecret);
      const userId = decoded.uid;
      const scope = getMemoryScope(req, decoded);

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
