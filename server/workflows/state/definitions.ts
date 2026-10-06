import { randomUUID } from "crypto";
import type { WorkflowScope, WorkflowDefinition, WorkflowStepDefinition } from './contracts';
import { loadStore, WORKFLOW_RUNTIME_SCHEMA_VERSION, saveStore } from './store';
import { WorkflowStateError } from './contracts';
import { clone, normalizeScope, redactWorkflowValue, definitionHash, nowIso } from './values';
import { validateWorkflowSteps } from './plan_validation';

export function createWorkflowDefinitionDraft(input: {
  workflowId?: string;
  userId: string;
  scope?: Partial<WorkflowScope>;
  title: string;
  description?: string;
  triggerPolicy?: WorkflowDefinition['triggerPolicy'];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  provenance: WorkflowDefinition['provenance'];
}): WorkflowDefinition {
  const store = loadStore();
  const workflowId = String(input.workflowId || `workflow_${randomUUID()}`);
  const prior = store.definitions.filter(item => item.workflowId === workflowId);
  if (prior.some(item => item.userId !== input.userId)) throw new WorkflowStateError('Workflow ownership cannot change between versions.');
  const version = prior.reduce((max, item) => Math.max(max, item.version), 0) + 1;
  const triggerPolicy: WorkflowDefinition['triggerPolicy'] = input.triggerPolicy
    ? clone(input.triggerPolicy)
    : { mode: 'explicit_only' };
  const semantic: Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'> = {
    schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION,
    workflowId,
    version,
    userId: String(input.userId),
    scope: normalizeScope(input.scope),
    title: String(input.title || 'Untitled workflow').slice(0, 160),
    description: String(input.description || '').slice(0, 2_000),
    triggerPolicy,
    inputSchema: redactWorkflowValue(input.inputSchema || {}, 'definition.inputSchema') as Record<string, unknown>,
    outputSchema: redactWorkflowValue(input.outputSchema || {}, 'definition.outputSchema') as Record<string, unknown>,
    steps: validateWorkflowSteps(input.steps),
    provenance: {
      ...clone(input.provenance),
      sourceRefs: [...new Set((input.provenance.sourceRefs || []).map(String))].slice(0, 40),
      reviewedByUser: Boolean(input.provenance.reviewedByUser),
    },
  };
  const definition: WorkflowDefinition = {
    ...semantic,
    hash: definitionHash(semantic),
    status: 'draft',
    createdAt: nowIso(),
  };
  store.definitions.push(definition);
  saveStore(store);
  return clone(definition);
}

export function publishWorkflowDefinition(input: {
  workflowId: string;
  version: number;
  expectedHash: string;
  userId: string;
}): WorkflowDefinition {
  const store = loadStore();
  const definition = store.definitions.find(item => item.workflowId === input.workflowId && item.version === input.version);
  if (!definition || definition.userId !== input.userId) throw new WorkflowStateError('Workflow draft was not found.');
  if (definition.hash !== input.expectedHash) throw new WorkflowStateError('Workflow draft changed before publication. Review the latest version.');
  if (definition.status !== 'draft') throw new WorkflowStateError(`Only draft workflows can be published; current status is '${definition.status}'.`);
  definition.status = 'published';
  definition.publishedAt = nowIso();
  definition.provenance.reviewedByUser = true;
  const semantic = clone(definition) as Partial<WorkflowDefinition>;
  delete semantic.hash;
  delete semantic.status;
  delete semantic.createdAt;
  delete semantic.publishedAt;
  delete semantic.retiredAt;
  definition.hash = definitionHash(semantic as Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>);
  saveStore(store);
  return clone(definition);
}

export function retireWorkflowDefinition(input: {
  workflowId: string;
  version: number;
  expectedHash: string;
  userId: string;
}): WorkflowDefinition {
  const store = loadStore();
  const definition = store.definitions.find(item => item.workflowId === input.workflowId && item.version === input.version);
  if (!definition || definition.userId !== input.userId) throw new WorkflowStateError('Published workflow was not found.');
  if (definition.hash !== input.expectedHash) throw new WorkflowStateError('Workflow definition hash mismatch.');
  if (definition.status !== 'published') throw new WorkflowStateError('Only a published workflow can be retired.');
  definition.status = 'retired';
  definition.retiredAt = nowIso();
  saveStore(store);
  return clone(definition);
}

export function listWorkflowDefinitions(userId: string, workflowId?: string): WorkflowDefinition[] {
  return loadStore().definitions
    .filter(item => item.userId === userId && (!workflowId || item.workflowId === workflowId))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId) || left.version - right.version)
    .map(clone);
}

export function getWorkflowDefinition(workflowId: string, version: number, userId: string): WorkflowDefinition | null {
  const definition = loadStore().definitions.find(item => (
    item.workflowId === workflowId && item.version === version && item.userId === userId
  ));
  return definition ? clone(definition) : null;
}
