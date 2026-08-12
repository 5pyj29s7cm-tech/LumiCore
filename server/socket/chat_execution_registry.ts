export type ChatExecutionStatus =
  | 'acknowledged'
  | 'planning'
  | 'executing'
  | 'waiting_confirmation'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ChatExecutionScope = {
  userId: string;
  domain: 'personal' | 'work';
  orgId?: string;
  source: string;
  conversationId?: string;
};

export type ChatExecutionEvent = {
  event: string;
  payload: Record<string, any>;
};

export type ChatExecutionSnapshot = {
  requestId: string;
  source: string;
  status: ChatExecutionStatus;
  createdAt: string;
  updatedAt: string;
  terminal: boolean;
  lastEvent?: ChatExecutionEvent;
  terminalEvent?: ChatExecutionEvent;
};

type StoredExecution = ChatExecutionSnapshot & {
  scopeKey: string;
};

const TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const executions = new Map<string, StoredExecution>();
const activeByScope = new Map<string, string>();

function normalizedScopeKey(scope: ChatExecutionScope): string {
  const orgId = scope.domain === 'work' ? String(scope.orgId || '') : '';
  return `${scope.userId}:${scope.domain}:${orgId}:${scope.source || 'chat'}:${String(scope.conversationId || '')}`;
}

function executionKey(scope: ChatExecutionScope, requestId: string): string {
  return `${normalizedScopeKey(scope)}:${requestId}`;
}

function copySnapshot(record?: StoredExecution): ChatExecutionSnapshot | null {
  if (!record) return null;
  const { scopeKey: _scopeKey, ...snapshot } = record;
  return {
    ...snapshot,
    lastEvent: snapshot.lastEvent
      ? { event: snapshot.lastEvent.event, payload: { ...snapshot.lastEvent.payload } }
      : undefined,
    terminalEvent: snapshot.terminalEvent
      ? { event: snapshot.terminalEvent.event, payload: { ...snapshot.terminalEvent.payload } }
      : undefined,
  };
}

function purgeExpiredExecutions(now = Date.now()): void {
  for (const [key, record] of executions.entries()) {
    if (!record.terminal) continue;
    if (now - Date.parse(record.updatedAt) <= TERMINAL_RETENTION_MS) continue;
    executions.delete(key);
    if (activeByScope.get(record.scopeKey) === key) activeByScope.delete(record.scopeKey);
  }
}

function terminalStatusForEvent(event: string, payload: Record<string, any>): ChatExecutionStatus | null {
  if (event === 'agent:error') return 'failed';
  if (event !== 'agent:response') return null;
  const reason = String(payload.reason || '').trim().toLowerCase();
  if (reason === 'cancelled' || reason === 'canceled') return 'cancelled';
  if (payload.blocked === true || payload.finalized !== true) return 'failed';
  return 'completed';
}

function statusForEvent(
  current: ChatExecutionStatus,
  event: string,
  payload: Record<string, any>,
): ChatExecutionStatus {
  const terminalStatus = terminalStatusForEvent(event, payload);
  if (terminalStatus) return terminalStatus;
  if (event === 'agent:confirm_tool') return 'waiting_confirmation';
  if (event === 'agent:tool' || event === 'agent:tool_call') return 'executing';
  if (event === 'agent:status') {
    const status = String(payload.status || '').trim().toLowerCase();
    if (status === 'thinking') return 'planning';
    if (status === 'responding' || status === 'executing') return 'executing';
    if (status === 'waiting_confirmation') return 'waiting_confirmation';
    if (status === 'cancelling') return 'cancelling';
    if (status === 'error') return 'failed';
  }
  return current;
}

export function beginChatExecution(
  scope: ChatExecutionScope,
  requestId: string,
): ChatExecutionSnapshot | null {
  purgeExpiredExecutions();
  const scopeKey = normalizedScopeKey(scope);
  const previousKey = activeByScope.get(scopeKey);
  const previous = previousKey ? executions.get(previousKey) : undefined;
  let superseded: ChatExecutionSnapshot | null = null;
  if (previous && !previous.terminal && previous.requestId !== requestId) {
    const now = new Date().toISOString();
    const payload = {
      text: '[Cancelled]',
      agentName: 'Lumi',
      source: previous.source,
      requestId: previous.requestId,
      conversationId: scope.conversationId,
      finalized: true,
      blocked: true,
      reason: 'cancelled',
    };
    previous.status = 'cancelled';
    previous.terminal = true;
    previous.updatedAt = now;
    previous.lastEvent = { event: 'agent:response', payload };
    previous.terminalEvent = previous.lastEvent;
    superseded = copySnapshot(previous);
  }

  const now = new Date().toISOString();
  const key = executionKey(scope, requestId);
  executions.set(key, {
    scopeKey,
    requestId,
    source: scope.source || 'chat',
    status: 'acknowledged',
    createdAt: now,
    updatedAt: now,
    terminal: false,
  });
  activeByScope.set(scopeKey, key);
  return superseded;
}

export function recordChatExecutionEvent(
  scope: ChatExecutionScope,
  requestId: string,
  event: string,
  payload: Record<string, any>,
): boolean {
  const key = executionKey(scope, requestId);
  const record = executions.get(key);
  if (!record) return false;

  // Once a terminal event has been committed, late errors from an aborted async
  // branch must not overwrite or duplicate the user-visible result.
  if (record.terminal) return false;

  const normalizedPayload = {
    ...payload,
    source: payload.source || record.source,
    requestId,
  };
  const status = statusForEvent(record.status, event, normalizedPayload);
  const terminal = ['completed', 'cancelled', 'failed'].includes(status);
  const nextEvent = { event, payload: normalizedPayload };
  record.status = status;
  record.updatedAt = new Date().toISOString();
  record.terminal = terminal;
  record.lastEvent = nextEvent;
  if (terminal) record.terminalEvent = nextEvent;
  return true;
}

export function markChatExecutionCancelling(
  scope: ChatExecutionScope,
  requestId?: string,
): ChatExecutionSnapshot | null {
  const record = resolveExecution(scope, requestId);
  if (!record || record.terminal) return copySnapshot(record);
  record.status = 'cancelling';
  record.updatedAt = new Date().toISOString();
  record.lastEvent = {
    event: 'agent:status',
    payload: {
      status: 'cancelling',
      source: record.source,
      requestId: record.requestId,
      conversationId: scope.conversationId,
    },
  };
  return copySnapshot(record);
}

export function getChatExecution(
  scope: ChatExecutionScope,
  requestId?: string,
): ChatExecutionSnapshot | null {
  purgeExpiredExecutions();
  return copySnapshot(resolveExecution(scope, requestId));
}

function resolveExecution(scope: ChatExecutionScope, requestId?: string): StoredExecution | undefined {
  if (requestId) return executions.get(executionKey(scope, requestId));
  const key = activeByScope.get(normalizedScopeKey(scope));
  return key ? executions.get(key) : undefined;
}

export function resetChatExecutionRegistryForTests(): void {
  executions.clear();
  activeByScope.clear();
}
