import crypto from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import {
  enqueue,
  getTaskHistory,
  getTaskQueue,
  type AutonomousTask,
} from '../autonomy/task_queue';

export type CommandCenterPlanKind = 'daily_task' | 'long_term_goal' | 'periodic_report';
export type CommandCenterPlanCadence = 'none' | 'daily' | 'weekly' | 'monthly';
export type CommandCenterPlanStatus = 'active' | 'paused' | 'completed';

export interface CommandCenterPlan {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  conversationId: string;
  kind: CommandCenterPlanKind;
  title: string;
  instruction: string;
  cadence: CommandCenterPlanCadence;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  status: CommandCenterPlanStatus;
  nextRunAt: string;
  lastRunAt: string;
  lastRuntimeTaskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterPlanInput {
  kind?: unknown;
  title?: unknown;
  instruction?: unknown;
  cadence?: unknown;
  timeOfDay?: unknown;
  dayOfWeek?: unknown;
  dayOfMonth?: unknown;
  conversationId?: unknown;
}

const KINDS = new Set<CommandCenterPlanKind>(['daily_task', 'long_term_goal', 'periodic_report']);
const CADENCES = new Set<CommandCenterPlanCadence>(['none', 'daily', 'weekly', 'monthly']);
const ACTIVE_RUNTIME_STATUSES = new Set(['pending', 'running', 'pausing', 'paused']);

function plans(db: any): CommandCenterPlan[] {
  if (!Array.isArray(db.commandCenterPlans)) db.commandCenterPlans = [];
  return db.commandCenterPlans;
}

function boundedText(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeTimeOfDay(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return '09:00';
  return text;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function defaultCadence(kind: CommandCenterPlanKind): CommandCenterPlanCadence {
  if (kind === 'daily_task') return 'daily';
  if (kind === 'periodic_report') return 'weekly';
  return 'weekly';
}

export function nextCommandCenterPlanRun(
  plan: Pick<CommandCenterPlan, 'cadence' | 'timeOfDay' | 'dayOfWeek' | 'dayOfMonth'>,
  from = new Date(),
): string {
  if (plan.cadence === 'none') return '';
  const [hour, minute] = normalizeTimeOfDay(plan.timeOfDay).split(':').map(Number);
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);

  if (plan.cadence === 'daily') {
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  } else if (plan.cadence === 'weekly') {
    const day = clampInt(plan.dayOfWeek, 0, 6, 1);
    let distance = (day - candidate.getDay() + 7) % 7;
    if (distance === 0 && candidate.getTime() <= from.getTime()) distance = 7;
    candidate.setDate(candidate.getDate() + distance);
  } else {
    const desired = clampInt(plan.dayOfMonth, 1, 28, 1);
    candidate.setDate(desired);
    if (candidate.getTime() <= from.getTime()) {
      candidate.setMonth(candidate.getMonth() + 1, desired);
    }
  }
  return candidate.toISOString();
}

function normalizedInput(input: CommandCenterPlanInput, existing?: CommandCenterPlan) {
  const kind = KINDS.has(input.kind as CommandCenterPlanKind)
    ? input.kind as CommandCenterPlanKind
    : existing?.kind || 'daily_task';
  const title = boundedText(input.title ?? existing?.title, 120);
  const instruction = boundedText(input.instruction ?? existing?.instruction ?? title, 2_000);
  if (!title) throw new Error('Plan title is required.');
  if (!instruction) throw new Error('Plan instruction is required.');
  const requestedCadence = input.cadence ?? existing?.cadence ?? defaultCadence(kind);
  const cadence = CADENCES.has(requestedCadence as CommandCenterPlanCadence)
    ? requestedCadence as CommandCenterPlanCadence
    : defaultCadence(kind);
  return {
    kind,
    title,
    instruction,
    cadence,
    timeOfDay: normalizeTimeOfDay(input.timeOfDay ?? existing?.timeOfDay),
    dayOfWeek: clampInt(input.dayOfWeek ?? existing?.dayOfWeek, 0, 6, 1),
    dayOfMonth: clampInt(input.dayOfMonth ?? existing?.dayOfMonth, 1, 28, 1),
    conversationId: boundedText(input.conversationId ?? existing?.conversationId, 180),
  };
}

export function listCommandCenterPlans(input: {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}): CommandCenterPlan[] {
  return plans(readDB())
    .filter(plan => plan.userId === input.userId && plan.domain === input.domain && plan.orgId === input.orgId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(plan => ({ ...plan }));
}

export function createCommandCenterPlan(scope: {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}, input: CommandCenterPlanInput, now = new Date()): CommandCenterPlan {
  const db = readDB();
  const value = normalizedInput(input);
  const timestamp = now.toISOString();
  const plan: CommandCenterPlan = {
    id: `ccp_${crypto.randomUUID()}`,
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
    ...value,
    status: 'active',
    nextRunAt: '',
    lastRunAt: '',
    lastRuntimeTaskId: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  plan.nextRunAt = nextCommandCenterPlanRun(plan, now);
  plans(db).push(plan);
  writeDB(db);
  return { ...plan };
}

export function updateCommandCenterPlan(input: {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  patch: CommandCenterPlanInput & { status?: unknown };
}, now = new Date()): CommandCenterPlan | null {
  const db = readDB();
  const plan = plans(db).find(candidate => candidate.id === input.id
    && candidate.userId === input.userId
    && candidate.domain === input.domain
    && candidate.orgId === input.orgId);
  if (!plan) return null;
  Object.assign(plan, normalizedInput(input.patch, plan));
  const status = String(input.patch.status || '');
  if (status === 'active' || status === 'paused' || status === 'completed') plan.status = status;
  plan.updatedAt = now.toISOString();
  plan.nextRunAt = plan.status === 'active' ? nextCommandCenterPlanRun(plan, now) : '';
  writeDB(db);
  return { ...plan };
}

export function deleteCommandCenterPlan(input: {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}): boolean {
  const db = readDB();
  const index = plans(db).findIndex(candidate => candidate.id === input.id
    && candidate.userId === input.userId
    && candidate.domain === input.domain
    && candidate.orgId === input.orgId);
  if (index < 0) return false;
  db.commandCenterPlans.splice(index, 1);
  writeDB(db);
  return true;
}

function planPrompt(plan: CommandCenterPlan): string {
  if (plan.kind === 'periodic_report') {
    return `Generate the scheduled report: ${plan.title}. Requirements: ${plan.instruction}. Use only real task state and verified receipts. Clearly distinguish completed, in progress, blocked, and unknown results. Never invent completion evidence.`;
  }
  if (plan.kind === 'long_term_goal') {
    return `Advance and review this long-term pursuit: ${plan.title}. Goal: ${plan.instruction}. Inspect durable task state and verified receipts, take the next safe in-scope step, then report concrete progress and blockers. Do not claim completion without verified evidence.`;
  }
  return `Execute this scheduled task: ${plan.title}. Instruction: ${plan.instruction}. Use Lumi's normal intent, risk, tool, verification, and receipt pipeline. Stop for confirmation before any external commit and never claim completion without verified evidence.`;
}

function runSlot(plan: CommandCenterPlan, at: Date): string {
  return crypto.createHash('sha256')
    .update(`${plan.id}:${plan.nextRunAt || at.toISOString().slice(0, 16)}`)
    .digest('hex')
    .slice(0, 24);
}

function activeManualRun(plan: CommandCenterPlan): AutonomousTask | null {
  const prefix = `command-center-plan:${plan.id}:`;
  const byId = new Map<string, AutonomousTask>();
  for (const task of [...getTaskQueue(plan.userId), ...getTaskHistory(100, 0, plan.userId)]) {
    if (!byId.has(task.id)) byId.set(task.id, task);
  }
  const candidates = Array.from(byId.values()).filter(task => {
    if (!ACTIVE_RUNTIME_STATUSES.has(task.status) || !String(task.idempotencyKey || '').startsWith(prefix)) {
      return false;
    }
    const domain = task.domain === 'work' ? 'work' : 'personal';
    const orgId = domain === 'work' ? String(task.orgId || '') : '';
    return domain === plan.domain && orgId === plan.orgId;
  });
  return candidates.find(task => task.id === plan.lastRuntimeTaskId) || candidates[0] || null;
}
export function runCommandCenterPlan(input: {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  manual?: boolean;
}, at = new Date()): { plan: CommandCenterPlan; task: AutonomousTask; reused: boolean } | null {
  const db = readDB();
  const plan = plans(db).find(candidate => candidate.id === input.id
    && candidate.userId === input.userId
    && candidate.domain === input.domain
    && candidate.orgId === input.orgId);
  if (!plan) return null;
  if (input.manual) {
    const active = activeManualRun(plan);
    if (active) {
      if (plan.lastRuntimeTaskId !== active.id) {
        plan.lastRuntimeTaskId = active.id;
        plan.lastRunAt = active.createdAt;
        plan.updatedAt = at.toISOString();
        writeDB(db);
      }
      return { plan: { ...plan }, task: active, reused: true };
    }
  }

  const slot = input.manual ? crypto.randomUUID() : runSlot(plan, at);
  const task = enqueue({
    userId: plan.userId,
    title: plan.title,
    description: planPrompt(plan),
    source: input.manual ? 'user_request' : 'scheduler',
    domain: plan.domain,
    orgId: plan.orgId,
    conversationId: plan.conversationId || `command-center-plan:${plan.id}`,
    planId: plan.id,
    priority: plan.kind === 'daily_task' ? 7 : 6,
    mode: 'analysis',
    idempotencyKey: `command-center-plan:${plan.id}:${slot}`,
  });
  if (!task) return null;

  const timestamp = at.toISOString();
  plan.lastRunAt = timestamp;
  plan.lastRuntimeTaskId = task.id;
  plan.updatedAt = timestamp;
  plan.nextRunAt = plan.status === 'active' ? nextCommandCenterPlanRun(plan, at) : '';
  writeDB(db);
  return { plan: { ...plan }, task, reused: false };
}
export function dispatchDueCommandCenterPlans(at = new Date()): number {
  const db = readDB();
  const due = plans(db)
    .filter(plan => plan.status === 'active' && plan.nextRunAt && new Date(plan.nextRunAt).getTime() <= at.getTime())
    .map(plan => ({ id: plan.id, userId: plan.userId, domain: plan.domain, orgId: plan.orgId }));
  let dispatched = 0;
  for (const plan of due) {
    if (runCommandCenterPlan(plan, at)) dispatched += 1;
  }
  return dispatched;
}
