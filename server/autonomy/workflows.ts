import { readDB, writeDB } from '../../db_layer';

export interface AutonomousWorkflow {
  id: string;
  userId: string;
  title: string;
  description: string;
  trigger: string;
  allowedModes: Array<'analysis' | 'desktop' | 'terminal'>;
  allowedActions: string[];
  externalAppsAllowed: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type WorkflowInput = Partial<Omit<AutonomousWorkflow, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;

export const DEFAULT_LEARNING_WORKFLOW_ID = 'workflow_lumi_continuous_learning';

function allWorkflows(): AutonomousWorkflow[] {
  try {
    const db = readDB();
    return Array.isArray(db.autonomousWorkflows) ? db.autonomousWorkflows : [];
  } catch {
    return [];
  }
}

function saveWorkflows(workflows: AutonomousWorkflow[]) {
  const db = readDB();
  db.autonomousWorkflows = workflows;
  writeDB(db);
}

function normalizeModes(value: unknown): Array<'analysis' | 'desktop' | 'terminal'> {
  const modes = Array.isArray(value) ? value : ['analysis'];
  const allowed = new Set(['analysis', 'desktop', 'terminal']);
  const normalized = modes.filter(mode => allowed.has(String(mode))) as Array<'analysis' | 'desktop' | 'terminal'>;
  return normalized.length > 0 ? normalized : ['analysis'];
}

function normalizeActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function buildLearningWorkflow(userId: string, existing?: AutonomousWorkflow): AutonomousWorkflow {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_LEARNING_WORKFLOW_ID,
    userId,
    title: 'Lumi 持续学习与知识吸收',
    description: [
      'Lumi 根据最近上下文、长期记忆、知识库变化和未解决问题，主动创建小型学习计划。',
      '她会整理可复用知识、发现知识缺口、必要时检索公开网页和权威来源，沉淀带来源的摘要、候选知识和下一步建议。',
      '公开搜索、读取公开网页和权威来源研究属于网络观察，不等同于外部应用自动化；登录墙、付费、验证码、账号授权和高后果提交必须停止并记录阻塞。',
      '她不对外发送消息，不删除或修改用户文件；长期知识写入必须保留来源、检索时间和不确定性。',
    ].join(' '),
    trigger: 'autonomous_cycle: recent activity, memory gaps, uploaded knowledge, public-source updates, reusable insights',
    allowedModes: ['analysis'],
    allowedActions: [
      'recent_activity_review',
      'memory_consolidation',
      'knowledge_gap_scan',
      'knowledge_absorption',
      'public_web_search',
      'web_search',
      'url_fetch',
      'authority_research',
      'source_grounded_digest',
      'knowledge_update_candidate',
      'learning_plan_creation',
      'summary',
    ],
    externalAppsAllowed: false,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: existing?.updatedAt || now,
  };
}

export function ensureLearningWorkflow(userId: string): AutonomousWorkflow {
  const workflows = allWorkflows();
  const index = workflows.findIndex(workflow => workflow.userId === userId && workflow.id === DEFAULT_LEARNING_WORKFLOW_ID);

  if (index >= 0) {
    const next = buildLearningWorkflow(userId, workflows[index]);
    const prev = workflows[index];
    const changed = JSON.stringify({ ...prev, updatedAt: next.updatedAt }) !== JSON.stringify(next);
    if (changed) {
      workflows[index] = { ...next, updatedAt: new Date().toISOString() };
      saveWorkflows(workflows);
      return workflows[index];
    }
    return prev;
  }

  const workflow = buildLearningWorkflow(userId);
  workflows.push(workflow);
  saveWorkflows(workflows);
  return workflow;
}

export function listAutonomousWorkflows(userId: string): AutonomousWorkflow[] {
  ensureLearningWorkflow(userId);
  return allWorkflows().filter(workflow => workflow.userId === userId);
}

export function listEnabledAutonomousWorkflows(userId: string): AutonomousWorkflow[] {
  return listAutonomousWorkflows(userId).filter(workflow => workflow.enabled);
}

export function upsertAutonomousWorkflow(userId: string, input: WorkflowInput & { id?: string }): AutonomousWorkflow {
  const workflows = allWorkflows();
  const now = new Date().toISOString();
  const existingIndex = input.id
    ? workflows.findIndex(workflow => workflow.userId === userId && workflow.id === input.id)
    : -1;
  const existing = existingIndex >= 0 ? workflows[existingIndex] : null;

  const workflow: AutonomousWorkflow = {
    id: existing?.id || `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    title: String(input.title || existing?.title || 'Untitled workflow').slice(0, 120),
    description: String(input.description || existing?.description || '').slice(0, 1000),
    trigger: String(input.trigger || existing?.trigger || '').slice(0, 500),
    allowedModes: normalizeModes(input.allowedModes || existing?.allowedModes),
    allowedActions: normalizeActions(input.allowedActions || existing?.allowedActions),
    externalAppsAllowed: Boolean(input.externalAppsAllowed ?? existing?.externalAppsAllowed ?? false),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    workflows[existingIndex] = workflow;
  } else {
    workflows.push(workflow);
  }
  saveWorkflows(workflows);
  return workflow;
}

export function setAutonomousWorkflowEnabled(userId: string, id: string, enabled: boolean): AutonomousWorkflow | null {
  const workflows = allWorkflows();
  const index = workflows.findIndex(workflow => workflow.userId === userId && workflow.id === id);
  if (index < 0) return null;
  workflows[index] = {
    ...workflows[index],
    enabled,
    updatedAt: new Date().toISOString(),
  };
  saveWorkflows(workflows);
  return workflows[index];
}
