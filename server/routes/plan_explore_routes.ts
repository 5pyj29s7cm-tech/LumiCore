import { Router } from "express";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";
import {
  createPlan, updatePlan, updatePlanStep, listPlans, getPlan, deletePlan, getTodayPlanSummary,
} from "../autonomy/planner";
import {
  getLatestExploration,
  getExplorationHistory,
  isFirstBootComplete,
  getSystemExplorationConsent,
  setSystemExplorationConsent,
  isSystemExplorationAllowed,
  getSystemInspectionPolicy,
  persistDailyExploration,
  persistFirstBootExploration,
} from "../autonomy/system_explorer";
import {
  collectSystemSnapshotInWorker,
  resolveSystemExplorationRuntimeDir,
  SystemExplorationAlreadyRunningError,
} from "../runtime/system_exploration_worker";
import { getProfessionProfile, buildProfessionOverlay, detectProfession, saveProfessionProfile } from "../autonomy/professions";
import { readDB } from "../../db_layer";
import { getMember } from "../org/db";
import type { PlanScope } from "../autonomy/planner";

function resolvePlanScope(req: any, res: any): PlanScope | null {
  const userId = req.user?.uid;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const orgId = String(req.user?.orgId || '').trim();
  if (!orgId) return { userId, domain: 'personal', orgId: '' };
  const membership = getMember(orgId, userId);
  if (!membership || membership.status !== 'active') {
    res.status(403).json({ error: 'Active organization membership required' });
    return null;
  }
  return { userId, domain: 'work', orgId };
}

export function mountExploreRoutes(router: Router) {
  const guard = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res)).catch(next);
  const requirePersonalSystemAdmin = (req: any, res: any, next: any) => {
    if (req.user?.orgId) {
      return res.status(403).json({ error: 'Computer exploration belongs to the personal local-admin surface, not the organization workspace.' });
    }
    next();
  };
  const systemAdmin = [requireAuth, requireAdmin, requirePersonalSystemAdmin, requireLocalRequest] as const;

  router.get("/explore/status", ...systemAdmin, (_req, res) => {
    const explored = isFirstBootComplete();
    const latest = getLatestExploration();
    res.json({
      explored,
      authorized: isSystemExplorationAllowed(),
      consent: getSystemExplorationConsent(),
      computerScope: 'lumi_server_host',
      inspectionPolicy: getSystemInspectionPolicy(),
      latest,
    });
  });

  router.post("/explore/consent", ...systemAdmin, (req, res) => {
    if (typeof req.body?.granted !== 'boolean') {
      return res.status(400).json({ error: 'granted must be a boolean' });
    }
    const consent = setSystemExplorationConsent(req.body.granted, req.user!.uid);
    res.json({
      authorized: isSystemExplorationAllowed(),
      consent,
      inspectionPolicy: getSystemInspectionPolicy(),
    });
  });

  router.post("/explore/scan", ...systemAdmin, guard(async (_req, res) => {
    if (!isSystemExplorationAllowed()) {
      return res.status(403).json({ error: 'Local computer exploration has not been authorized.' });
    }
    const firstBoot = !isFirstBootComplete();
    let collected;
    try {
      collected = await collectSystemSnapshotInWorker(resolveSystemExplorationRuntimeDir());
    } catch (error) {
      if (error instanceof SystemExplorationAlreadyRunningError) {
        return res.status(409).json({
          error: error.message,
          code: error.code,
        });
      }
      throw error;
    }
    // A local admin may revoke consent while the isolated worker is running.
    // In that case discard the temporary result instead of persisting it.
    if (!isSystemExplorationAllowed()) {
      return res.status(403).json({ error: 'Local computer exploration authorization was revoked before persistence.' });
    }
    const result = firstBoot && !isFirstBootComplete()
      ? persistFirstBootExploration(collected)
      : persistDailyExploration(collected);
    res.json({ scanned: !!result, snapshot: result });
  }));

  router.get("/explore/history", ...systemAdmin, (_req, res) => {
    const history = getExplorationHistory(30);
    res.json({ snapshots: history });
  });

  router.get("/explore/profession", ...systemAdmin, (_req, res) => {
    const profiles = getProfessionProfile();
    const overlay = buildProfessionOverlay();
    res.json({ profiles, overlay });
  });

  router.post("/explore/profession/rescan", ...systemAdmin, (_req, res) => {
    const db = readDB();
    const snapshots = (db as any).systemSnapshots || [];
    const latest = snapshots[snapshots.length - 1];
    const installedApps = latest?.software?.installedApps || [];
    const profiles = detectProfession(installedApps);
    if (profiles.length > 0) saveProfessionProfile(profiles);
    res.json({ profiles });
  });

}

export function mountPlanRoutes(router: Router) {
  const guard = (fn: (req: any, res: any) => Promise<any>) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res)).catch(next);

  router.get("/plans", requireAuth, (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const { status, source, limit } = req.query as any;
    res.json({ plans: listPlans(scope, { status, source, limit: limit ? parseInt(limit) : undefined }) });
  });

  router.get("/plans/today", requireAuth, (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    res.json({ summary: getTodayPlanSummary(scope) });
  });

  router.get("/plans/:id", requireAuth, (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const plan = getPlan(req.params.id, scope);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json({ plan });
  });

  router.post("/plans", requireAuth, guard(async (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const { title, description, priority, steps, tags, source } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });
    const plan = createPlan(title, description || "", scope, source || "user", priority || "medium", steps || [], tags || []);
    res.json({ plan });
  }));

  router.put("/plans/:id", requireAuth, guard(async (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const plan = updatePlan(req.params.id, req.body, scope);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json({ plan });
  }));

  router.put("/plans/:planId/steps/:stepId", requireAuth, guard(async (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const plan = updatePlanStep(req.params.planId, req.params.stepId, req.body, scope);
    if (!plan) return res.status(404).json({ error: "Plan or step not found" });
    res.json({ plan });
  }));

  router.delete("/plans/:id", requireAuth, (req, res) => {
    const scope = resolvePlanScope(req, res);
    if (!scope) return;
    const ok = deletePlan(req.params.id, scope);
    if (!ok) return res.status(404).json({ error: "Plan not found" });
    res.json({ deleted: true });
  });
}
