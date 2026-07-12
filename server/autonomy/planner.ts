import { readDB, writeDB } from "../../db_layer";

export interface LumiPlan {
  id: string;
  ownerUid: string;
  domain: 'personal' | 'work';
  orgId: string;
  title: string;
  description: string;
  status: "active" | "paused" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  source: "user" | "lumi" | "auto";
  steps: PlanStep[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  toolName?: string;
  toolArgs?: Record<string, any>;
  result?: string;
  order: number;
}

type PlanUpdate = Partial<Pick<LumiPlan, "title" | "description" | "priority" | "tags" | "result">> & {
  status?: LumiPlan["status"] | "done";
};

export interface PlanScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

type PlanFilter = { status?: string; source?: string; limit?: number };

function normalizeScope(scope: PlanScope): PlanScope {
  return scope.domain === 'work' && scope.orgId
    ? { userId: scope.userId, domain: 'work', orgId: scope.orgId }
    : { userId: scope.userId, domain: 'personal', orgId: '' };
}

function migrateLegacyPlans(db: any): LumiPlan[] {
  const plans = (db.plans || []) as LumiPlan[];
  const userIds = [...new Set<string>((db.users || []).map((user: any) => user?.uid).filter(Boolean))];
  let changed = false;
  for (const plan of plans) {
    if (!plan.domain) {
      plan.domain = plan.orgId ? 'work' : 'personal';
      changed = true;
    }
    if (plan.domain !== 'work' && plan.orgId) {
      plan.orgId = '';
      changed = true;
    }
    if (!plan.ownerUid && plan.domain === 'personal' && userIds.length === 1) {
      plan.ownerUid = userIds[0];
      changed = true;
    }
  }
  if (changed) writeDB(db);
  return plans;
}

function planMatchesScope(plan: LumiPlan, input: PlanScope): boolean {
  const scope = normalizeScope(input);
  if (scope.domain === 'work') {
    return plan.domain === 'work' && Boolean(scope.orgId) && plan.orgId === scope.orgId;
  }
  return plan.domain !== 'work' && !plan.orgId && plan.ownerUid === scope.userId;
}

export function createPlan(
  title: string,
  description: string,
  inputScope: PlanScope,
  source: "user" | "lumi" | "auto" = "lumi",
  priority: "low" | "medium" | "high" | "critical" = "medium",
  steps: { title: string; description?: string }[] = [],
  tags: string[] = [],
): LumiPlan {
  const scope = normalizeScope(inputScope);
  const plan: LumiPlan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    ownerUid: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
    title,
    description,
    status: "active",
    priority,
    source,
    steps: steps.map((s, i) => ({
      id: `step_${Date.now()}_${i}`,
      title: s.title,
      description: s.description,
      status: "pending",
      order: i,
    })),
    tags,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db = readDB();
  if (!(db as any).plans) (db as any).plans = [];
  (db as any).plans.push(plan);
  writeDB(db);

  return plan;
}

export function updatePlan(id: string, updates: PlanUpdate, scope: PlanScope): LumiPlan | null {
  const db = readDB();
  const plans = migrateLegacyPlans(db);
  const idx = plans.findIndex((p: LumiPlan) => p.id === id && planMatchesScope(p, scope));
  if (idx === -1) return null;

  const plan = (db as any).plans[idx];
  const normalizedUpdates = {
    ...updates,
    ...(updates.status === "done" ? { status: "completed" as const } : {}),
  };
  Object.assign(plan, normalizedUpdates, {
    updatedAt: new Date().toISOString(),
    ...(normalizedUpdates.status === "completed" ? { completedAt: new Date().toISOString() } : {}),
  });
  writeDB(db);
  return plan;
}

export function updatePlanStep(planId: string, stepId: string, updates: Partial<Pick<PlanStep, "status" | "title" | "description" | "result">>, scope: PlanScope): LumiPlan | null {
  const db = readDB();
  const plan = migrateLegacyPlans(db).find((p: LumiPlan) => p.id === planId && planMatchesScope(p, scope));
  if (!plan) return null;

  const step = plan.steps.find((s: PlanStep) => s.id === stepId);
  if (!step) return null;

  Object.assign(step, updates);
  plan.updatedAt = new Date().toISOString();

  // Auto-complete plan when all steps done
  if (plan.steps.length > 0 && plan.steps.every((s: PlanStep) => s.status === "done" || s.status === "skipped")) {
    plan.status = "completed";
    plan.completedAt = new Date().toISOString();
  }

  writeDB(db);
  return plan;
}

export function listPlans(scope: PlanScope, filter?: PlanFilter): LumiPlan[] {
  const db = readDB();
  let plans: LumiPlan[] = migrateLegacyPlans(db).filter(plan => planMatchesScope(plan, scope)).map(plan => (
    (plan as any).status === "done"
      ? { ...plan, status: "completed", completedAt: plan.completedAt || plan.updatedAt }
      : plan
  ));

  if (filter?.status) plans = plans.filter(p => p.status === filter.status);
  if (filter?.source) plans = plans.filter(p => p.source === filter.source);

  plans.sort((a, b) => {
    const pa = a.priority === "critical" ? 0 : a.priority === "high" ? 1 : a.priority === "medium" ? 2 : 3;
    const pb = b.priority === "critical" ? 0 : b.priority === "high" ? 1 : b.priority === "medium" ? 2 : 3;
    return pa - pb || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return filter?.limit ? plans.slice(0, filter.limit) : plans;
}

export function getPlan(id: string, scope: PlanScope): LumiPlan | null {
  const db = readDB();
  return migrateLegacyPlans(db).find((p: LumiPlan) => p.id === id && planMatchesScope(p, scope)) || null;
}

export function deletePlan(id: string, scope: PlanScope): boolean {
  const db = readDB();
  const plans = migrateLegacyPlans(db);
  const idx = plans.findIndex((p: LumiPlan) => p.id === id && planMatchesScope(p, scope));
  if (idx === -1) return false;
  (db as any).plans.splice(idx, 1);
  writeDB(db);
  return true;
}

export function getActivePlanCount(scope: PlanScope): number {
  return listPlans(scope, { status: "active" }).length;
}

export function getTodayPlanSummary(scope: PlanScope): string {
  const active = listPlans(scope, { status: "active" });
  const doneToday = listPlans(scope, { status: "completed" }).filter(p => {
    const today = new Date().toDateString();
    return p.completedAt && new Date(p.completedAt).toDateString() === today;
  });

  if (active.length === 0 && doneToday.length === 0) return "No plans today.";

  const lines: string[] = [];
  if (active.length > 0) {
    lines.push(`**${active.length} active plan(s):**`);
    for (const p of active) {
      const done = p.steps.filter(s => s.status === "done").length;
      lines.push(`- ${p.title} [${p.priority}] (${done}/${p.steps.length} steps)`);
    }
  }
  if (doneToday.length > 0) {
    lines.push(`**${doneToday.length} completed today:**`);
    for (const p of doneToday) {
      lines.push(`- ${p.title} ✓`);
    }
  }
  return lines.join("\n");
}
