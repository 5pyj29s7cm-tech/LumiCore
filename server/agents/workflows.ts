/**
 * Named Workflow Persistence — user-named, recallable multi-step workflow definitions.
 *
 * Unlike the worklog (which auto-records tool traces for pattern detection),
 * named workflows are explicitly saved by the user or the system when a useful
 * pattern is discovered. They can be run by name: "run my morning routine".
 */
import { readDB, writeDB } from '../../db_layer';
import { SubTask } from './orchestrator';

export interface WorkflowDefinition {
  id: string;
  userId: string;
  name: string;
  description: string;
  steps: Array<{
    description: string;
    tool?: string;
    args?: Record<string, any>;
    requiredSkill?: string;
    executionMode?: string;
  }>;
  agentAssignments?: Record<string, string>; // subTaskId -> agentId
  category?: string;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
  domain?: string;
  orgId?: string;
}

export type WorkflowScope = { domain?: string; orgId?: string };

function normalizedWorkflowScope(scope: WorkflowScope = {}): { domain: string; orgId: string } {
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  return { domain, orgId: domain === 'work' ? (scope.orgId || '') : '' };
}

function workflowMatchesScope(workflow: WorkflowDefinition, scope: WorkflowScope = {}): boolean {
  const normalized = normalizedWorkflowScope(scope);
  return (workflow.domain || 'personal') === normalized.domain && (workflow.orgId || '') === normalized.orgId;
}

function genId(): string {
  return 'wflow_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}

export function saveWorkflow(
  userId: string,
  name: string,
  description: string,
  steps: WorkflowDefinition['steps'],
  agentAssignments?: Record<string, string>,
  category?: string,
  scope: WorkflowScope = {},
): WorkflowDefinition {
  const db = readDB();
  if (!db.workflows) db.workflows = [];

  // Upsert: if a workflow with same name exists for this user, update it
  const normalized = normalizedWorkflowScope(scope);
  const existing = db.workflows.find((w: WorkflowDefinition) =>
    w.userId === userId && w.name === name && workflowMatchesScope(w, normalized)
  );
  if (existing) {
    existing.description = description;
    existing.steps = steps;
    existing.agentAssignments = agentAssignments || existing.agentAssignments;
    existing.category = category || existing.category;
    writeDB(db);
    return existing;
  }

  const wf: WorkflowDefinition = {
    id: genId(),
    userId,
    name,
    description,
    steps,
    agentAssignments,
    category,
    createdAt: new Date().toISOString(),
    runCount: 0,
    domain: normalized.domain,
    orgId: normalized.orgId,
  };
  db.workflows.push(wf);
  writeDB(db);
  return wf;
}

export function listWorkflows(userId: string, category?: string, scope: WorkflowScope = {}): WorkflowDefinition[] {
  const db = readDB();
  if (!db.workflows) return [];
  return db.workflows
    .filter((w: WorkflowDefinition) => w.userId === userId && workflowMatchesScope(w, scope) && (!category || w.category === category))
    .sort((a: WorkflowDefinition, b: WorkflowDefinition) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getWorkflow(userId: string, name: string, scope: WorkflowScope = {}): WorkflowDefinition | null {
  const db = readDB();
  if (!db.workflows) return null;
  return db.workflows.find((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope)) || null;
}

export function deleteWorkflow(userId: string, name: string, scope: WorkflowScope = {}): boolean {
  const db = readDB();
  if (!db.workflows) return false;
  const idx = db.workflows.findIndex((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope));
  if (idx < 0) return false;
  db.workflows.splice(idx, 1);
  writeDB(db);
  return true;
}

export function recordWorkflowRun(userId: string, name: string, scope: WorkflowScope = {}): void {
  const db = readDB();
  if (!db.workflows) return;
  const wf = db.workflows.find((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope));
  if (wf) {
    wf.lastRunAt = new Date().toISOString();
    wf.runCount++;
    writeDB(db);
  }
}

/**
 * Convert an orchestrator task decomposition into a named workflow.
 * Called when the user says "remember this" after a successful orchestration run.
 */
export function captureFromOrchestration(
  userId: string,
  name: string,
  taskDescription: string,
  subTasks: SubTask[],
  agentAssignments: Record<string, string>,
  scope: WorkflowScope = {},
): WorkflowDefinition {
  const steps = subTasks.map(st => ({
    description: st.description,
    requiredSkill: st.requiredSkill,
    executionMode: st.executionMode,
  }));
  return saveWorkflow(userId, name, taskDescription, steps, agentAssignments, undefined, scope);
}

/**
 * Auto-detect repeated behavior patterns from the worklog and create named workflows.
 * Called periodically by the scheduler. When Lumi notices the user doing the same
 * thing 3+ times, she auto-creates a workflow so the user can say "run my X routine".
 *
 * Returns the number of new workflows created.
 */
export async function autoGenerateWorkflows(userId: string, scope: WorkflowScope = {}): Promise<number> {
  try {
    const { findWorkflowClusters, getRecentWorkflows, removeWorkflows } = await import('../skills/worklog');

    const normalized = normalizedWorkflowScope(scope);
    const all = getRecentWorkflows(userId, normalized.domain, normalized.orgId);
    if (all.length < 3) return 0;

    const clusters = findWorkflowClusters(3, userId, normalized.domain, normalized.orgId);
    if (clusters.length === 0) return 0;

    let created = 0;

    for (const cluster of clusters) {
      // Only auto-create if similarity is high enough (confident pattern)
      if (cluster.avgSimilarity < 0.55) continue;

      const wf = cluster.workflows[0];
      const workflowUserId = wf.userId || userId;

      // Check if a workflow with a similar name already exists
      const existing = listWorkflows(workflowUserId, undefined, normalized);
      const nameBase = generateWorkflowName(cluster.representativeIntent);
      if (existing.some(e => e.name === nameBase)) continue;

      const steps = wf.toolSequence.map(s => ({
        description: s.name,
        tool: s.name,
        args: s.args,
      }));

      const autoDesc = `Auto-generated from ${cluster.workflows.length} similar sessions. Average similarity: ${(cluster.avgSimilarity * 100).toFixed(0)}%`;

      saveWorkflow(workflowUserId, nameBase, autoDesc, steps, undefined, 'auto', normalized);
      console.log(`[WorkflowGen] Auto-created workflow "${nameBase}" from ${cluster.workflows.length} sessions (similarity: ${cluster.avgSimilarity.toFixed(2)})`);
      created++;

      // Remove processed workflows so they don't re-trigger
      removeWorkflows(cluster.workflows.map(w => w.id));
    }

    return created;
  } catch (err) {
    console.error('[WorkflowGen] Auto-generation failed:', err);
    return 0;
  }
}

/** Generate a short, memorable name from the user's intent text */
function generateWorkflowName(intent: string): string {
  // Take first 4 meaningful words, max 40 chars
  const cleaned = intent
    .replace(/[，,。.！!？?、；;：:（）()【】\[\]「」『』""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length >= 2);
  if (words.length <= 3) return cleaned.slice(0, 40);

  // Use first 2 + last 2 words to form a descriptive name
  const first = words.slice(0, 2).join('');
  const last = words.slice(-2).join('');
  const name = (first + last).slice(0, 40);
  return name || cleaned.slice(0, 40);
}

/**
 * Capture the most recent tool execution trace as a named workflow.
 * Called when the user says "remember this" or "记下这个流程".
 */
export function captureRecentAsWorkflow(
  userId: string,
  name: string,
  toolTrace: Array<{ name: string; args: Record<string, any>; resultSummary: string }>,
  scope: WorkflowScope = {},
): WorkflowDefinition | null {
  if (toolTrace.length === 0) return null;

  const steps = toolTrace.map(t => ({
    description: t.name,
    tool: t.name,
    args: t.args,
  }));

  const description = `Captured workflow: ${name} (${steps.length} steps). Created from recent tool execution.`;
  return saveWorkflow(userId, name, description, steps, undefined, 'manual', scope);
}
