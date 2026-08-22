import { Router } from "express";
import { personalityRegistry } from "../personality";
import { evolvePersonality } from "../personality/evolution";
import { loadEmotionalState } from "../personality/state";
import { readDB } from "../../db_layer";
import { requireAuth } from "../middleware/auth";
import { getMember } from "../org/db";
import { scopedEmotionalStateKey } from "../socket/scope";

function resolvePersonalityScope(req: any, res: any): { userId: string; orgId?: string; orgRole?: string } | null {
  const userId = req.user?.uid;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const orgId = String(req.user?.orgId || '').trim();
  if (!orgId) return { userId };
  const membership = getMember(orgId, userId);
  if (!membership || membership.status !== 'active') {
    res.status(403).json({ error: 'Active organization membership required' });
    return null;
  }
  return { userId, orgId, orgRole: membership.role };
}

function canMutateScopedPersonality(scope: { orgId?: string; orgRole?: string }): boolean {
  return !scope.orgId || scope.orgRole === 'owner' || scope.orgRole === 'admin';
}

export function mountPersonalityRoutes(router: Router, _jwtSecret: string, llm: {
  getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
}) {
  const asyncHandler = (fn: (req: any, res: any, next?: any) => Promise<any>) =>
    (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get("/personalities", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    const lumi = personalityRegistry.getForUser('lumi', scope.userId, scope.orgId);
    res.json([lumi]);
  });

  router.get("/personalities/:id", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    const config = personalityRegistry.getForUser(req.params.id, scope.userId, scope.orgId);
    if (!config) return res.status(404).json({ error: "Personality not found" });
    res.json(config);
  });

  router.get("/personality/:id/evolution", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    const config = personalityRegistry.getForUser(req.params.id, scope.userId, scope.orgId);
    if (!config) return res.status(404).json({ error: "Personality not found" });
    const history = personalityRegistry.getEvolutionHistory(req.params.id, scope.userId, scope.orgId);
    const evolutionConfig = personalityRegistry.getEvolutionConfig(req.params.id, scope.userId, scope.orgId);
    res.json({
      personalityId: req.params.id,
      currentVector: config.personalityVector || null,
      version: config.version,
      growthState: config.growthState || null,
      evolutionFrozenAt: config.evolutionFrozenAt || null,
      evolutionConfig,
      history,
      scope: scope.orgId ? 'organization' : 'personal',
      orgId: scope.orgId || '',
      audit: personalityRegistry.getEvolutionAudit(req.params.id, scope.userId, scope.orgId),
    });
  });

  router.get("/personality/:id/evolution/audit", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    const config = personalityRegistry.getForUser(req.params.id, scope.userId, scope.orgId);
    if (!config) return res.status(404).json({ error: "Personality not found" });
    res.json({
      personalityId: req.params.id,
      growthState: config.growthState || null,
      frozenAt: config.evolutionFrozenAt || null,
      scope: scope.orgId ? 'organization' : 'personal',
      orgId: scope.orgId || '',
      audit: personalityRegistry.getEvolutionAudit(req.params.id, scope.userId, scope.orgId),
    });
  });

  router.get("/personality/:id/growth-journal", requireAuth, (req, res) => {
    try {
      const scope = resolvePersonalityScope(req, res);
      if (!scope) return;
      const uid = scope.userId;
      const db = readDB();
      const limit = parseInt(req.query.limit as string) || 14;

      const journalEntries = (db.memories || [])
        .filter((m: any) =>
          m.userId === uid &&
          (scope.orgId ? m.domain === 'work' && m.orgId === scope.orgId : (m.domain || 'personal') === 'personal' && !m.orgId) &&
          m.keywords?.includes('growth_journal') &&
          m.type === 'knowledge'
        )
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, limit)
        .map((m: any) => ({
          id: m.id,
          content: m.content,
          date: m.createdAt?.slice(0, 10) || '',
          tier: m.tier,
        }));

      const dataEntries = (db.memories || [])
        .filter((m: any) =>
          m.userId === uid &&
          (scope.orgId ? m.domain === 'work' && m.orgId === scope.orgId : (m.domain || 'personal') === 'personal' && !m.orgId) &&
          m.keywords?.includes('growth_journal_data')
        )
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, limit)
        .map((m: any) => {
          try {
            return { id: m.id, date: m.createdAt?.slice(0, 10) || '', data: JSON.parse(m.content) };
          } catch {
            return { id: m.id, date: m.createdAt?.slice(0, 10) || '', data: null };
          }
        });

      res.json({
        personalityId: req.params.id,
        journalEntries,
        statsEntries: dataEntries,
        count: journalEntries.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/personality/:id/evolve", requireAuth, asyncHandler(async (req, res) => {
    try {
      const scope = resolvePersonalityScope(req, res);
      if (!scope) return;
      if (!canMutateScopedPersonality(scope)) {
        return res.status(403).json({ error: 'Only organization owners and admins can evolve their member-scoped work-space adaptation.' });
      }
      const uid = scope.userId;
      const config = personalityRegistry.getForUser(req.params.id, uid, scope.orgId);
      if (!config) return res.status(404).json({ error: "Personality not found" });
      if (personalityRegistry.isEvolutionFrozen(req.params.id, uid, scope.orgId)) {
        return res.status(409).json({ error: "Personality evolution is frozen. Unfreeze it before evolving." });
      }

      const emotionalState = loadEmotionalState(scopedEmotionalStateKey(uid, {
        domain: scope.orgId ? 'work' : 'personal',
        orgId: scope.orgId || '',
      }));
      const evolutionConfig = personalityRegistry.getEvolutionConfig(req.params.id, uid, scope.orgId);

      const step = await evolvePersonality(
        config, uid, emotionalState.connection,
        llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
        evolutionConfig,
        { domain: scope.orgId ? 'work' : 'personal', orgId: scope.orgId || '' },
        { forceSynthesis: true },
      );

      if (!step) {
        return res.json({ evolved: false, reason: 'Evolution not needed or not ready. Check evolution config cooldown, connection score, and memory count.' });
      }

      const updated = personalityRegistry.applyEvolution(req.params.id, step, { userId: uid, orgId: scope.orgId });
      res.json({ evolved: true, version: step.version, narrative: step.narrative, mutations: step.mutations.length, config: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  router.post("/personality/:id/evolution/freeze", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    if (!canMutateScopedPersonality(scope)) {
      return res.status(403).json({ error: 'Only organization owners and admins can change organization evolution settings.' });
    }
    const frozen = req.body?.frozen !== false;
    const updated = personalityRegistry.setEvolutionFrozen(req.params.id, frozen, scope.userId, scope.orgId);
    if (!updated) return res.status(404).json({ error: "Personality not found" });
    res.json({
      personalityId: req.params.id,
      frozen: Boolean(updated.evolutionFrozenAt),
      frozenAt: updated.evolutionFrozenAt || null,
    });
  });

  router.post("/personality/:id/evolution/revert", requireAuth, (req, res) => {
    const scope = resolvePersonalityScope(req, res);
    if (!scope) return;
    if (!canMutateScopedPersonality(scope)) {
      return res.status(403).json({ error: 'Only organization owners and admins can revert organization evolution.' });
    }
    const auditId = String(req.body?.auditId || '');
    if (!auditId) return res.status(400).json({ error: "auditId is required" });
    const uid = scope.userId;
    const updated = personalityRegistry.revertEvolution(req.params.id, auditId, uid, scope.orgId);
    if (!updated) return res.status(404).json({ error: "Evolution audit entry not found or not reversible" });
    res.json({
      personalityId: req.params.id,
      reverted: true,
      auditId,
      version: updated.version,
      growthState: updated.growthState || null,
      audit: personalityRegistry.getEvolutionAudit(req.params.id, uid, scope.orgId),
    });
  });
}
