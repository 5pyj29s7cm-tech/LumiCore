import { readDB, writeDB } from '../../db_layer';
import type { WechatIntakeResult, WechatUrgency, WechatWorkCategory } from './wechat_intake';

export type WorkTakeoverStatus =
  | 'queued'
  | 'in_progress'
  | 'waiting_confirmation'
  | 'delivered'
  | 'blocked'
  | 'cancelled';

export type WorkTakeoverSource =
  | 'wechat'
  | 'clipboard'
  | 'manual'
  | 'voice'
  | 'chat'
  | 'demo'
  | string;

export interface WorkTakeoverDraft {
  id: string;
  channel: 'wechat' | 'feishu' | 'email' | 'document' | 'general';
  text: string;
  status: 'draft' | 'copied' | 'confirmed' | 'sent' | 'discarded';
  createdAt: string;
  updatedAt: string;
}

export interface WorkTakeoverArtifact {
  id: string;
  type: 'draft' | 'document' | 'file' | 'panel' | 'checklist' | 'quote' | 'contract' | 'cad' | 'video' | 'other';
  label: string;
  path?: string;
  content?: string;
  status: 'planned' | 'prepared' | 'needs_review' | 'delivered';
  createdAt: string;
  updatedAt: string;
}

export interface WorkTakeoverEvent {
  id: string;
  type: 'created' | 'updated' | 'continued' | 'status_changed' | 'artifact_added' | 'draft_added' | 'note';
  text: string;
  createdAt: string;
}

export interface WorkTakeoverTask {
  id: string;
  userId: string;
  domain: string;
  orgId: string;
  title: string;
  category: WechatWorkCategory;
  source: WorkTakeoverSource;
  status: WorkTakeoverStatus;
  urgency: WechatUrgency;
  priority: number;
  contact?: string;
  sourceMessage?: string;
  summary: string;
  recommendedWorkflow: string;
  nextActions: string[];
  currentActionIndex: number;
  drafts: WorkTakeoverDraft[];
  artifacts: WorkTakeoverArtifact[];
  allowedNow: string[];
  confirmationRequired: string[];
  blockedBy: string[];
  risks: string[];
  result?: string;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  events: WorkTakeoverEvent[];
}

export interface WorkTakeoverCreateInput {
  userId: string;
  domain?: string;
  orgId?: string;
  title?: string;
  category: WechatWorkCategory;
  source?: WorkTakeoverSource;
  status?: WorkTakeoverStatus;
  urgency?: WechatUrgency;
  priority?: number;
  contact?: string;
  sourceMessage?: string;
  summary?: string;
  recommendedWorkflow?: string;
  nextActions?: string[];
  draftReply?: string;
  artifactsToPrepare?: string[];
  allowedNow?: string[];
  confirmationRequired?: string[];
  blockedBy?: string[];
  risks?: string[];
  metadata?: Record<string, any>;
}

export interface WorkTakeoverUpdateInput {
  status?: WorkTakeoverStatus;
  title?: string;
  summary?: string;
  urgency?: WechatUrgency;
  priority?: number;
  nextActions?: string[];
  appendNextAction?: string;
  currentActionIndex?: number;
  draftReply?: string;
  artifact?: Partial<WorkTakeoverArtifact> & { label: string };
  allowedNow?: string[];
  confirmationRequired?: string[];
  blockedBy?: string[];
  risks?: string[];
  result?: string;
  note?: string;
  metadata?: Record<string, any>;
}

const SETTINGS_KEY = 'work_takeover_tasks_v1';
const MAX_TASKS = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function readStoredTasks(): WorkTakeoverTask[] {
  const db = readDB();
  const setting = (db.settings || []).find((item: any) => item.key === SETTINGS_KEY);
  if (!setting?.value) return [];
  try {
    const parsed = JSON.parse(setting.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredTasks(tasks: WorkTakeoverTask[]) {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const trimmed = tasks
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_TASKS);
  const value = JSON.stringify(trimmed);
  const index = db.settings.findIndex((item: any) => item.key === SETTINGS_KEY);
  if (index >= 0) db.settings[index].value = value;
  else db.settings.push({ key: SETTINGS_KEY, value });
  writeDB(db);
}

function event(type: WorkTakeoverEvent['type'], text: string): WorkTakeoverEvent {
  return { id: id('wt_event'), type, text, createdAt: nowIso() };
}

function normalizeList(value: unknown, limit = 20): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\n;；]+/);
  return items
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function priorityFromUrgency(urgency: WechatUrgency): number {
  if (urgency === 'urgent') return 90;
  if (urgency === 'high') return 75;
  if (urgency === 'low') return 35;
  return 55;
}

function categoryLabel(category: WechatWorkCategory): string {
  const labels: Record<WechatWorkCategory, string> = {
    customer: '客户推进',
    store: '店铺运营',
    account: '账号运营',
    legal_case: '自动立案',
    video_publish: '视频发布',
    design_delivery: '设计交付',
    general_work: '通用工作',
    personal: '个人事务',
    unknown: '待分类',
  };
  return labels[category] || category;
}

function buildDefaultTitle(input: WorkTakeoverCreateInput): string {
  const prefix = categoryLabel(input.category);
  if (input.contact) return `${prefix}：${input.contact}`;
  if (input.summary) return `${prefix}：${input.summary.slice(0, 32)}`;
  return `${prefix}接管任务`;
}

function draftFromText(text: string): WorkTakeoverDraft {
  const timestamp = nowIso();
  return {
    id: id('wt_draft'),
    channel: 'wechat',
    text,
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function artifactFromLabel(label: string): WorkTakeoverArtifact {
  const timestamp = nowIso();
  return {
    id: id('wt_artifact'),
    type: 'checklist',
    label,
    status: 'planned',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createWorkTakeoverTask(input: WorkTakeoverCreateInput): WorkTakeoverTask {
  const timestamp = nowIso();
  const urgency = input.urgency || 'normal';
  const task: WorkTakeoverTask = {
    id: id('wt_task'),
    userId: input.userId || 'anonymous',
    domain: input.domain || 'personal',
    orgId: input.orgId || '',
    title: String(input.title || buildDefaultTitle(input)).slice(0, 140),
    category: input.category,
    source: input.source || 'manual',
    status: input.status || 'queued',
    urgency,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : priorityFromUrgency(urgency),
    contact: input.contact,
    sourceMessage: input.sourceMessage,
    summary: input.summary || '',
    recommendedWorkflow: input.recommendedWorkflow || '',
    nextActions: normalizeList(input.nextActions, 30),
    currentActionIndex: 0,
    drafts: input.draftReply ? [draftFromText(input.draftReply)] : [],
    artifacts: normalizeList(input.artifactsToPrepare, 30).map(artifactFromLabel),
    allowedNow: normalizeList(input.allowedNow, 30),
    confirmationRequired: normalizeList(input.confirmationRequired, 30),
    blockedBy: normalizeList(input.blockedBy, 20),
    risks: normalizeList(input.risks, 20),
    metadata: input.metadata || {},
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [event('created', 'Work takeover task created.')],
  };

  const tasks = readStoredTasks();
  tasks.push(task);
  writeStoredTasks(tasks);
  return task;
}

export function createWorkTakeoverTaskFromWechatIntake(
  userId: string,
  intake: WechatIntakeResult,
  options: { domain?: string; orgId?: string; sourceMessage?: string; title?: string } = {},
): WorkTakeoverTask {
  return createWorkTakeoverTask({
    userId,
    domain: options.domain,
    orgId: options.orgId,
    title: options.title,
    category: intake.category,
    source: intake.source || 'wechat',
    urgency: intake.urgency,
    contact: intake.contact,
    sourceMessage: options.sourceMessage,
    summary: intake.summary,
    recommendedWorkflow: intake.recommendedWorkflow,
    nextActions: intake.nextActions,
    draftReply: intake.draftReply,
    artifactsToPrepare: intake.artifactsToPrepare,
    allowedNow: intake.allowedNow,
    confirmationRequired: intake.confirmationRequired,
    blockedBy: intake.blockedBy,
    metadata: {
      intakeId: intake.intakeId,
      confidence: intake.confidence,
      extracted: intake.extracted,
      industryParameters: intake.parameters,
      safety: intake.safety,
    },
  });
}

export function listWorkTakeoverTasks(filter: {
  userId?: string;
  domain?: string;
  orgId?: string;
  status?: WorkTakeoverStatus | 'active';
  category?: WechatWorkCategory;
  limit?: number;
} = {}): WorkTakeoverTask[] {
  let tasks = readStoredTasks();
  if (filter.userId) tasks = tasks.filter(task => task.userId === filter.userId);
  if (filter.domain) tasks = tasks.filter(task => task.domain === filter.domain);
  if (filter.orgId) tasks = tasks.filter(task => task.orgId === filter.orgId);
  if (filter.category) tasks = tasks.filter(task => task.category === filter.category);
  if (filter.status === 'active') {
    tasks = tasks.filter(task => ['queued', 'in_progress', 'waiting_confirmation', 'blocked'].includes(task.status));
  } else if (filter.status) {
    tasks = tasks.filter(task => task.status === filter.status);
  }
  tasks.sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
  return tasks.slice(0, Math.max(1, Math.min(Number(filter.limit) || 50, 200)));
}

export function getWorkTakeoverTask(userId: string, taskId: string): WorkTakeoverTask | null {
  return readStoredTasks().find(task => task.id === taskId && task.userId === userId) || null;
}

export function updateWorkTakeoverTask(userId: string, taskId: string, input: WorkTakeoverUpdateInput): WorkTakeoverTask | null {
  const tasks = readStoredTasks();
  const index = tasks.findIndex(task => task.id === taskId && task.userId === userId);
  if (index < 0) return null;
  const task = tasks[index];
  const timestamp = nowIso();

  if (input.title !== undefined) task.title = String(input.title).slice(0, 140);
  if (input.summary !== undefined) task.summary = String(input.summary).slice(0, 2000);
  if (input.urgency !== undefined) task.urgency = input.urgency;
  if (input.priority !== undefined && Number.isFinite(Number(input.priority))) task.priority = Number(input.priority);
  if (input.nextActions !== undefined) task.nextActions = normalizeList(input.nextActions, 30);
  if (input.appendNextAction) task.nextActions.push(String(input.appendNextAction).trim());
  if (input.currentActionIndex !== undefined && Number.isFinite(Number(input.currentActionIndex))) {
    task.currentActionIndex = Math.max(0, Math.min(Number(input.currentActionIndex), Math.max(0, task.nextActions.length - 1)));
  }
  if (input.allowedNow !== undefined) task.allowedNow = normalizeList(input.allowedNow, 30);
  if (input.confirmationRequired !== undefined) task.confirmationRequired = normalizeList(input.confirmationRequired, 30);
  if (input.blockedBy !== undefined) task.blockedBy = normalizeList(input.blockedBy, 20);
  if (input.risks !== undefined) task.risks = normalizeList(input.risks, 20);
  if (input.result !== undefined) task.result = String(input.result).slice(0, 5000);
  if (input.metadata) task.metadata = { ...task.metadata, ...input.metadata };

  if (input.draftReply) {
    task.drafts.push(draftFromText(String(input.draftReply)));
    task.events.push(event('draft_added', 'Draft reply added.'));
  }

  if (input.artifact?.label) {
    const artifactTimestamp = nowIso();
    task.artifacts.push({
      id: input.artifact.id || id('wt_artifact'),
      type: input.artifact.type || 'other',
      label: String(input.artifact.label).slice(0, 160),
      path: input.artifact.path,
      content: input.artifact.content,
      status: input.artifact.status || 'planned',
      createdAt: input.artifact.createdAt || artifactTimestamp,
      updatedAt: artifactTimestamp,
    });
    task.events.push(event('artifact_added', `Artifact added: ${input.artifact.label}`));
  }

  if (input.status && input.status !== task.status) {
    task.status = input.status;
    if (input.status === 'delivered' || input.status === 'cancelled') task.completedAt = timestamp;
    task.events.push(event('status_changed', `Status changed to ${input.status}.`));
  }

  if (input.note) task.events.push(event('note', String(input.note).slice(0, 1000)));
  task.events.push(event('updated', 'Work takeover task updated.'));
  task.updatedAt = timestamp;
  tasks[index] = task;
  writeStoredTasks(tasks);
  return task;
}

export function continueWorkTakeoverTask(userId: string, taskId?: string): {
  task: WorkTakeoverTask;
  currentAction?: string;
  nextAction?: string;
  draft?: WorkTakeoverDraft;
  confirmationRequired: string[];
} | null {
  const task = taskId
    ? getWorkTakeoverTask(userId, taskId)
    : listWorkTakeoverTasks({ userId, status: 'active', limit: 1 })[0] || null;
  if (!task) return null;

  const currentAction = task.nextActions[task.currentActionIndex];
  const nextAction = task.nextActions[task.currentActionIndex + 1];
  const updated = updateWorkTakeoverTask(userId, task.id, {
    status: task.status === 'queued' ? 'in_progress' : task.status,
    currentActionIndex: currentAction ? task.currentActionIndex : 0,
    note: currentAction ? `Continue with: ${currentAction}` : 'Continue requested.',
  }) || task;
  return {
    task: updated,
    currentAction,
    nextAction,
    draft: updated.drafts[updated.drafts.length - 1],
    confirmationRequired: updated.confirmationRequired,
  };
}
