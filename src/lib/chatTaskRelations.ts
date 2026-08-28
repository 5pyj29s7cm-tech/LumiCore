export type ServerTaskRelation = {
  relation: 'status' | 'continue' | 'cancel' | 'replace' | 'queue';
  feedback: 'status' | 'continue' | 'cancel' | 'replace' | 'correction' | 'accept' | 'retry' | 'repeat' | 'new_task';
  binding: 'active_task' | 'previous_task' | 'new_task' | 'conversation' | 'stale';
  operation: 'inspect' | 'resume' | 'cancel' | 'supersede' | 'replan' | 'verify' | 'retry' | 'repeat' | 'enqueue' | 'reject_stale';
  taskId?: string;
  revision?: number;
  targetRequestId?: string;
  preservesRootGoal?: boolean;
  requiresRootVerification?: boolean;
  reason?: string;
};

export type ServerTaskRelationEvent = {
  requestId?: string;
  conversationId?: string;
  source?: string;
  relation?: unknown;
  taskRelation?: unknown;
};

export type ChatTaskControlTarget = {
  controlTargetRequestId?: string;
  controlTargetTaskId?: string;
  controlTargetRevision?: number;
};

const RELATIONS = new Set(['status', 'continue', 'cancel', 'replace', 'queue']);
const FEEDBACK = new Set(['status', 'continue', 'cancel', 'replace', 'correction', 'accept', 'retry', 'repeat', 'new_task']);
const BINDINGS = new Set(['active_task', 'previous_task', 'new_task', 'conversation', 'stale']);
const OPERATIONS = new Set(['inspect', 'resume', 'cancel', 'supersede', 'replan', 'verify', 'retry', 'repeat', 'enqueue', 'reject_stale']);

function boundedString(value: unknown, limit: number): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  return normalized || undefined;
}

export function normalizeServerTaskRelation(event: ServerTaskRelationEvent): ServerTaskRelation | null {
  const raw = event?.taskRelation && typeof event.taskRelation === 'object'
    ? event.taskRelation as Record<string, unknown>
    : event?.relation && typeof event.relation === 'object'
      ? event.relation as Record<string, unknown>
      : null;
  if (
    !raw
    || !RELATIONS.has(String(raw.relation || ''))
    || !FEEDBACK.has(String(raw.feedback || ''))
    || !BINDINGS.has(String(raw.binding || ''))
    || !OPERATIONS.has(String(raw.operation || ''))
  ) return null;

  const revision = Number(raw.revision);
  const binding = raw.binding as ServerTaskRelation['binding'];
  return {
    relation: raw.relation as ServerTaskRelation['relation'],
    feedback: raw.feedback as ServerTaskRelation['feedback'],
    binding,
    operation: raw.operation as ServerTaskRelation['operation'],
    ...(boundedString(raw.taskId, 180) ? { taskId: boundedString(raw.taskId, 180) } : {}),
    ...(Number.isFinite(revision) && revision >= 0 ? { revision: Math.trunc(revision) } : {}),
    // A previous/terminal task no longer owns a request lease. Even a delayed
    // or legacy frame must not make the client resend that obsolete request id
    // as mutation authority on the next conversational turn.
    ...(binding === 'active_task' && boundedString(raw.targetRequestId, 120)
      ? { targetRequestId: boundedString(raw.targetRequestId, 120) }
      : {}),
    preservesRootGoal: raw.preservesRootGoal === true,
    requiresRootVerification: raw.requiresRootVerification === true,
    ...(boundedString(raw.reason, 180) ? { reason: boundedString(raw.reason, 180) } : {}),
  };
}

function relationKey(conversationId: string, requestId: string): string {
  return `${conversationId}\u0000${requestId}`;
}

/**
 * Client-side optimistic-concurrency ledger for server-owned task relations.
 * It never invents a task identity. Lower revisions for the same task are
 * ignored so delayed socket frames cannot roll the next control turn back.
 */
export class ChatTaskRelationLedger {
  private readonly byRequest = new Map<string, ServerTaskRelation>();
  private readonly latestByConversation = new Map<string, ServerTaskRelation>();

  record(event: ServerTaskRelationEvent): ServerTaskRelation | null {
    const relation = normalizeServerTaskRelation(event);
    if (!relation) return null;
    const conversationId = boundedString(event.conversationId, 180) || '';
    const requestId = boundedString(event.requestId, 120) || '';
    const current = this.latestByConversation.get(conversationId);
    if (
      relation.taskId
      && current?.taskId === relation.taskId
      && current.revision !== undefined
      && relation.revision !== undefined
      && relation.revision < current.revision
    ) return current;

    if (relation.taskId && relation.binding === 'previous_task') {
      for (const [key, candidate] of this.byRequest) {
        if (candidate.taskId === relation.taskId) this.byRequest.delete(key);
      }
      if (current?.taskId === relation.taskId) {
        this.latestByConversation.delete(conversationId);
      }
      // A terminal/previous relation is useful for rendering, but is not
      // future mutation authority. Let the next read-only follow-up resolve
      // from the server ledger instead of replaying a revision that may still
      // advance while the terminal request releases its final lease.
      return relation;
    }
    if (requestId) this.byRequest.set(relationKey(conversationId, requestId), relation);
    // Only a server-issued durable task identity can become a future mutation
    // target. A conversational/new-task classification must not erase it.
    if (relation.taskId) this.latestByConversation.set(conversationId, relation);
    return relation;
  }

  controlTarget(input: {
    conversationId?: string;
    foregroundRequestId?: string;
  }): ChatTaskControlTarget {
    const conversationId = boundedString(input.conversationId, 180) || '';
    const foregroundRequestId = boundedString(input.foregroundRequestId, 120) || '';
    const exact = foregroundRequestId
      ? this.byRequest.get(relationKey(conversationId, foregroundRequestId))
      : undefined;
    const relation = exact?.taskId ? exact : this.latestByConversation.get(conversationId);
    return {
      ...(foregroundRequestId || relation?.targetRequestId
        ? { controlTargetRequestId: foregroundRequestId || relation?.targetRequestId }
        : {}),
      ...(relation?.taskId ? { controlTargetTaskId: relation.taskId } : {}),
      ...(relation?.revision !== undefined ? { controlTargetRevision: relation.revision } : {}),
    };
  }

  clear(): void {
    this.byRequest.clear();
    this.latestByConversation.clear();
  }
}
