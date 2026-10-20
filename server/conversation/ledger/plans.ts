import type { CapabilityExecutionPlan } from "../../cognition/capability_execution_plan";
import type { PersistedCapabilityExecutionPlan, ConversationActionTaskRow } from './contracts';
import { digest, ensureTables, parseObject, contextWithExecutionPlan } from './serialization';

export function sanitizeCapabilityExecutionPlan(
  plan: CapabilityExecutionPlan,
  persistedAt: string,
): PersistedCapabilityExecutionPlan {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    intent: {
      ...plan.intent,
      payload: '',
      payloadDigest: digest(plan.intent.payload),
    },
    nodes: plan.nodes.map(node => ({
      nodeId: node.nodeId,
      type: node.type,
      ...(node.terminalStatus ? { terminalStatus: node.terminalStatus } : {}),
      capabilityId: node.capabilityId,
      ...(node.toolName ? { toolName: node.toolName } : {}),
      lane: node.lane,
      operation: node.operation,
      risk: node.risk,
      requiresConfirmation: node.requiresConfirmation,
      verificationStrategy: node.verification.strategy,
      executionRole: node.executionRole,
      ...(node.selectionGroup ? { selectionGroup: node.selectionGroup } : {}),
      ...(node.selectionRank !== undefined ? { selectionRank: node.selectionRank } : {}),
    })),
    edges: plan.edges.map(edge => ({ ...edge })),
    expectedEvidence: plan.expectedEvidence.map(requirement => ({
      ...requirement,
      requiredFields: [...requirement.requiredFields],
      ...(requirement.requiredValues ? { requiredValues: { ...requirement.requiredValues } } : {}),
      requiredArtifacts: [...requirement.requiredArtifacts],
      successStatuses: [...requirement.successStatuses],
    })),
    risk: {
      ...plan.risk,
      reasons: [...plan.risk.reasons],
      ...(plan.risk.confirmationBinding
        ? { confirmationBinding: { ...plan.risk.confirmationBinding } }
        : {}),
    },
    fallbackPolicy: { ...plan.fallbackPolicy },
    contextRefs: plan.contextRefs.map(ref => ({ ...ref })),
    decisionAuthority: plan.decisionAuthority,
    scriptAuthority: plan.scriptAuthority,
    persistedAt,
  };
}

/**
 * Persists the semantic plan in the existing append-compatible task context.
 * Raw message payloads are never stored; confirmation uses the digest already
 * bound to the durable task identity.
 */
export function attachConversationExecutionPlan(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    plan: CapabilityExecutionPlan;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persisted = sanitizeCapabilityExecutionPlan(input.plan, now);
  task.context = JSON.stringify(contextWithExecutionPlan(context, persisted));
  task.updatedAt = now;
  return task;
}
