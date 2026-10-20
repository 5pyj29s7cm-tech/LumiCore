import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireConversationActionTurnLease, finalizeConversationActionTurn, getConversationActionTurn, listConversationActionTurns, reconcileConversationActionTurnLease, reconcileConversationActionTurnLeases, releaseConversationActionTurnLease } from './action_turn_ledger';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { type Conversation } from "./manager/contracts";
import { normalizeConversationActionState, type ConversationActionContinuationState } from '../cognition/action_continuation';
import { finalizeConversationActionTask } from "./ledger/task_lifecycle";
import { conversationTaskStatusOwnsExecutionLease, taskCompletionFromReceipts } from '../cognition/task_execution_ledger';
import { hydrateConversationActionState, compactRolloverText } from "./action_state_hydration";
import { type FinalizeConversationActionRequestOptions, type ConvergeConversationActionRequestLeaseInput } from "./foreground_request_types";

export const CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS = 5 * 60 * 1_000;
export const CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS = Math.floor(
  CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS / 3,
);

interface ManagerActionTurnLease {
  ownerId: string;
  prepared: boolean;
  /** Executor fenced by this lease, aborted if an expired owner is recovered. */
  abortController?: AbortController;
}

export interface PreparedConversationTurnUpgrade {
  turnRowId: string;
  signal: AbortSignal;
  transcriptText: string;
}

export const managerActionTurnLeases = new Map<string, ManagerActionTurnLease>();
export const managerActionTurnHeartbeatStops = new Map<string, () => void>();

export interface ConversationTerminalPersistenceUnknownProjection {
  text: string;
  completionFeedback?: unknown;
  reason?: string;
}

interface StagedConversationTerminalTurn {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  desiredStatus: 'terminal' | 'cancelled';
  reason: string;
  now?: string;
}

export interface ConversationTerminalDurabilityStage {
  turns: Map<string, StagedConversationTerminalTurn>;
  settled: boolean;
}

const conversationTerminalDurabilityStorage = new AsyncLocalStorage<ConversationTerminalDurabilityStage>();

export function runWithConversationTerminalDurabilityStage<T>(
  operation: (stage: ConversationTerminalDurabilityStage) => Promise<T>,
): Promise<T> {
  const stage: ConversationTerminalDurabilityStage = {
    turns: new Map(),
    settled: false,
  };
  return conversationTerminalDurabilityStorage.run(stage, () => operation(stage));
}

function stageConversationTerminalTurn(input: StagedConversationTerminalTurn): boolean {
  const stage = conversationTerminalDurabilityStorage.getStore();
  if (!stage || stage.settled) return false;
  const key = managerActionTurnKey(input);
  const previous = stage.turns.get(key);
  stage.turns.set(key, {
    ...previous,
    ...input,
    assistantMessageId: input.assistantMessageId || previous?.assistantMessageId || '',
    desiredStatus: input.desiredStatus === 'cancelled' || previous?.desiredStatus === 'cancelled'
      ? 'cancelled'
      : 'terminal',
    reason: input.reason || previous?.reason || '',
    now: input.now || previous?.now,
  });
  return true;
}

export function stopManagerActionTurnHeartbeat(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): void {
  managerActionTurnHeartbeatStops.get(managerActionTurnKey(input))?.();
}

export function managerActionTurnKey(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): string {
  return JSON.stringify([input.conversationId, input.userId, input.requestId]);
}

/**
 * Drop a process-local owner only after the durable lease no longer proves
 * that it owns this request. Keeping an expired map entry made an idempotent
 * retry return `busy` forever even though the durable TTL had recovered.
 */
function reconcileManagerActionTurnLeaseOwner(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): ManagerActionTurnLease | undefined {
  const key = managerActionTurnKey(input);
  const managerLease = managerActionTurnLeases.get(key);
  if (!managerLease) return undefined;
  const durableTurn = getConversationActionTurn(input);
  if (
    durableTurn?.status === 'leased'
    && durableTurn.leaseOwnerId === managerLease.ownerId
  ) return managerLease;

  if (managerLease.abortController && !managerLease.abortController.signal.aborted) {
    managerLease.abortController.abort(new Error(
      'Conversation action execution lease expired or lost ownership',
    ));
  }
  stopManagerActionTurnHeartbeat(input);
  managerActionTurnLeases.delete(key);
  return undefined;
}

export function acquireManagerActionTurnLease(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reuseExistingLease: boolean;
  preparedTurnUpgrade?: PreparedConversationTurnUpgrade;
}): { acquired: true; ownerId: string } | { acquired: false; reason: 'busy' | 'stale' } {
  const key = managerActionTurnKey(input);
  // Recover the durable TTL first, then discard only a map owner that no
  // longer matches it. The inverse order lets an expired in-memory entry act
  // as an unbounded busy lock.
  const recoveredDurableLeases = reconcileConversationActionTurnLeases();
  for (const recovered of recoveredDurableLeases.turns) {
    reconcileManagerActionTurnLeaseOwner(recovered);
  }
  const existingManagerLease = reconcileManagerActionTurnLeaseOwner(input);
  if (!input.reuseExistingLease && existingManagerLease) {
    return { acquired: false, reason: 'busy' };
  }
  if (input.preparedTurnUpgrade) {
    const turn = getConversationActionTurn(input);
    if (!input.reuseExistingLease || !existingManagerLease?.prepared
      || existingManagerLease.abortController?.signal !== input.preparedTurnUpgrade.signal
      || input.preparedTurnUpgrade.signal.aborted || turn?.status !== 'leased'
      || turn.id !== input.preparedTurnUpgrade.turnRowId || turn.taskId
      || turn.leaseOwnerId !== existingManagerLease.ownerId
      || listConversationActionTurns({ conversationId: input.conversationId, userId: input.userId, statuses: ['leased'] })
        .some(other => other.requestId !== input.requestId)) return { acquired: false, reason: 'stale' };
    return { acquired: true, ownerId: existingManagerLease.ownerId };
  }
  if (input.reuseExistingLease && existingManagerLease?.prepared) {
    return { acquired: false, reason: 'busy' };
  }

  // The database is process-exclusive. Durable recovery above runs
  // synchronously before enforcing one live request per thread.
  const competing = listConversationActionTurns({
    conversationId: input.conversationId,
    userId: input.userId,
    statuses: ['leased'],
  }).find(turn => turn.requestId !== input.requestId);
  if (competing) return { acquired: false, reason: 'busy' };

  const turn = getConversationActionTurn(input);
  if (!turn) return { acquired: false, reason: 'stale' };
  if (!input.reuseExistingLease && turn.status === 'leased') {
    return { acquired: false, reason: 'busy' };
  }

  const ownerId = existingManagerLease?.ownerId || `manager:${crypto.randomUUID()}`;
  const acquired = acquireConversationActionTurnLease({
    ...input,
    leaseOwnerId: ownerId,
    ttlMs: CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS,
  });
  if (acquired.acquired === false) {
    return {
      acquired: false,
      reason: acquired.reason === 'not_found' || acquired.reason === 'terminal' ? 'stale' : 'busy',
    };
  }
  managerActionTurnLeases.set(key, {
    ownerId,
    prepared: input.reuseExistingLease,
  });
  return { acquired: true, ownerId };
}

export function releaseManagerActionTurnLease(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reason: string;
}): void {
  const key = managerActionTurnKey(input);
  stopManagerActionTurnHeartbeat(input);
  const managerLease = managerActionTurnLeases.get(key);
  const turn = getConversationActionTurn(input);
  if (managerLease && turn?.status === 'leased') {
    releaseConversationActionTurnLease({
      ...input,
      leaseOwnerId: managerLease.ownerId,
    });
  } else if (turn?.status === 'leased') {
    // The executor is exiting but its in-process owner token is unavailable.
    // Fence replay until durable transcript/task reconciliation proves safety.
    reconcileConversationActionTurnLease({
      ...input,
      observedStatus: 'persistence_unknown',
      reason: input.reason,
    });
  }
  managerActionTurnLeases.delete(key);
}

export function finalizeManagerActionTurnFromAssistant(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  desiredStatus?: 'terminal' | 'cancelled';
  reason?: string;
  now?: string;
}): void {
  const desiredStatus = input.desiredStatus
    || (getConversationActionTurn(input)?.status === 'cancelled' ? 'cancelled' : 'terminal');
  if (stageConversationTerminalTurn({
    ...input,
    desiredStatus,
    reason: input.reason || 'assistant transcript staged behind strict durability fence',
  })) return;
  finalizeManagerActionTurnFromAssistantImmediately({ ...input, desiredStatus });
}

export function finalizeManagerActionTurnFromAssistantImmediately(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  desiredStatus?: 'terminal' | 'cancelled';
  reason?: string;
  now?: string;
}): void {
  stopManagerActionTurnHeartbeat(input);
  finalizeConversationActionTurn({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    status: input.desiredStatus
      || (getConversationActionTurn(input)?.status === 'cancelled' ? 'cancelled' : 'terminal'),
    terminalMessageId: input.assistantMessageId,
    reason: input.reason || 'assistant transcript persisted',
    force: true,
    now: input.now,
  });
  managerActionTurnLeases.delete(managerActionTurnKey(input));
}

export function cancelManagerActionTurns(input: {
  conversationId: string;
  userId: string;
  requestId?: string;
  reason: string;
  now?: string;
}): number {
  const candidates = listConversationActionTurns({
    conversationId: input.conversationId,
    userId: input.userId,
    statuses: ['accepted', 'leased', 'persistence_unknown'],
  }).filter(turn => !input.requestId || turn.requestId === input.requestId);
  let cancelled = 0;
  for (const turn of candidates) {
    if (stageConversationTerminalTurn({
      conversationId: turn.conversationId,
      userId: turn.userId,
      requestId: turn.requestId,
      assistantMessageId: '',
      desiredStatus: 'cancelled',
      reason: input.reason,
      now: input.now,
    })) {
      cancelled += 1;
      continue;
    }
    stopManagerActionTurnHeartbeat(turn);
    const result = finalizeConversationActionTurn({
      conversationId: turn.conversationId,
      userId: turn.userId,
      requestId: turn.requestId,
      status: 'cancelled',
      reason: input.reason,
      force: true,
      now: input.now,
    });
    managerActionTurnLeases.delete(managerActionTurnKey(turn));
    if (result.finalized && result.changed) cancelled += 1;
  }
  return cancelled;
}

/** Refresh the foreground fencing lease from any foreground channel heartbeat. */
export function renewConversationActionExecutionLease(
  conversationId: string,
  userId: string,
  requestId: string,
): boolean {
  const key = managerActionTurnKey({ conversationId, userId, requestId });
  const lease = managerActionTurnLeases.get(key);
  if (!lease) return false;
  const renewed = acquireConversationActionTurnLease({
    conversationId,
    userId,
    requestId,
    leaseOwnerId: lease.ownerId,
    ttlMs: CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS,
  });
  // Re-acquiring an already expired/released lease is not a renewal. There was
  // an ownership gap, so the executor must fail closed instead of continuing
  // side effects under a newly created lease that only happens to share its id.
  return renewed.acquired && renewed.renewed && !renewed.recovered;
}

export interface ConversationActionExecutionLeaseLoss {
  conversationId: string;
  userId: string;
  requestId: string;
  status: 'persistence_unknown';
  reason: string;
  persisted: boolean;
  occurredAt: string;
}

export interface ConversationActionExecutionHeartbeat {
  stop(): void;
  isRunning(): boolean;
  isLeaseLost(): boolean;
  /** Resolves after the durable quarantine and optional entrypoint receipt finish. */
  leaseLoss: Promise<ConversationActionExecutionLeaseLoss>;
}

function persistConversationActionLeaseLoss(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reason: string;
  occurredAt: string;
}): boolean {
  const reconciled = reconcileConversationActionTurnLease({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    observedStatus: 'persistence_unknown',
    reason: input.reason,
    now: input.occurredAt,
  });
  managerActionTurnLeases.delete(managerActionTurnKey(input));

  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (conversation) {
    hydrateConversationActionState(db, conversation);
    const previous = normalizeConversationActionState(conversation.actionContinuationState);
    if (previous) {
      finalizeConversationActionTask(db, {
        conversation,
        state: previous,
        outcome: 'persistence_unknown',
        requestId: input.requestId,
        blocker: `persistence_unknown: ${input.reason}`,
        assistantState: input.reason,
        now: input.occurredAt,
      });
    }
    commitDatabaseTables(db);
  }
  return reconciled.turn?.status === 'persistence_unknown';
}

/**
 * Keep one prepared foreground action turn fenced for the full executor
 * lifetime. A lost renewal is a hard execution boundary: quarantine the
 * durable turn first, abort the entrypoint controller, then persist its
 * channel-specific unknown receipt.
 */
export function startConversationActionExecutionHeartbeat(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  abortController: AbortController;
  onPersistenceUnknown?: (
    loss: ConversationActionExecutionLeaseLoss,
  ) => void | Promise<void>;
}): ConversationActionExecutionHeartbeat {
  const identity = {
    conversationId: String(input.conversationId || '').trim(),
    userId: String(input.userId || '').trim(),
    requestId: String(input.requestId || '').trim(),
  };
  if (!identity.conversationId || !identity.userId || !identity.requestId) {
    throw new TypeError('conversationId, userId, and requestId are required');
  }

  const key = managerActionTurnKey(identity);
  stopManagerActionTurnHeartbeat(identity);
  const managerLease = managerActionTurnLeases.get(key);
  if (managerLease) managerLease.abortController = input.abortController;
  let running = true;
  let leaseLost = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveLeaseLoss!: (loss: ConversationActionExecutionLeaseLoss) => void;
  const leaseLoss = new Promise<ConversationActionExecutionLeaseLoss>(resolve => {
    resolveLeaseLoss = resolve;
  });

  const stop = () => {
    if (!running && !timer) return;
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    input.abortController.signal.removeEventListener('abort', stop);
    if (managerActionTurnHeartbeatStops.get(key) === stop) {
      managerActionTurnHeartbeatStops.delete(key);
    }
  };

  const loseLease = () => {
    if (!running || leaseLost) return;
    leaseLost = true;
    const occurredAt = new Date().toISOString();
    const reason = 'The execution lease heartbeat could not be renewed; the outcome is unknown.';
    const persisted = persistConversationActionLeaseLoss({
      ...identity,
      reason,
      occurredAt,
    });
    stop();
    if (!input.abortController.signal.aborted) {
      input.abortController.abort(new Error('Conversation action execution lease was lost'));
    }
    const loss: ConversationActionExecutionLeaseLoss = {
      ...identity,
      status: 'persistence_unknown',
      reason,
      persisted,
      occurredAt,
    };
    Promise.resolve(input.onPersistenceUnknown?.(loss))
      .catch(error => {
        console.error('[ConversationActionHeartbeat] Failed to persist entrypoint receipt:', error);
      })
      .finally(() => resolveLeaseLoss(loss));
  };

  const tick = () => {
    if (!running) return;
    if (input.abortController.signal.aborted) {
      stop();
      return;
    }
    if (renewConversationActionExecutionLease(
      identity.conversationId,
      identity.userId,
      identity.requestId,
    )) return;

    const turn = getConversationActionTurn(identity);
    if (turn?.status === 'terminal') {
      stop();
      return;
    }
    if (turn?.status === 'cancelled') {
      stop();
      if (!input.abortController.signal.aborted) {
        input.abortController.abort(new Error('Conversation action execution was cancelled'));
      }
      return;
    }
    // An independently installed quarantine is also an execution stop, and its
    // channel callback still needs a chance to write the public-safe receipt.
    loseLease();
  };

  managerActionTurnHeartbeatStops.set(key, stop);
  input.abortController.signal.addEventListener('abort', stop, { once: true });
  timer = setInterval(tick, CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  if (input.abortController.signal.aborted) stop();

  return {
    stop,
    isRunning: () => running,
    isLeaseLost: () => leaseLost,
    leaseLoss,
  };
}

/**
 * End one foreground request without conflating that request lease with the
 * durable task. A blocked or confirmation-waiting task remains resumable, but
 * the process-local request that produced this terminal assistant record no
 * longer owns it.
 */
export function finalizeConversationActionRequestInDb(
  db: any,
  conversation: Conversation,
  requestId: string,
  options: FinalizeConversationActionRequestOptions = {},
): ConversationActionContinuationState | null {
  const normalizedRequestId = String(requestId || '').trim();
  const previous = normalizeConversationActionState(conversation.actionContinuationState);
  const pendingOwnsRequest = Boolean(
    conversation.pendingActionContinuation
    && (normalizedRequestId
      ? conversation.pendingActionContinuation.requestId === normalizedRequestId
      : !conversation.pendingActionContinuation.requestId),
  );
  const stateOwnsRequest = Boolean(
    previous
    && normalizedRequestId
    && previous.activeRequestId === normalizedRequestId,
  );
  const now = options.now || new Date().toISOString();

  if (previous && stateOwnsRequest) {
    const completion = taskCompletionFromReceipts(
      previous.goal,
      previous.receipts || [],
      previous.taskCapsule,
      { requestId: normalizedRequestId, taskId: previous.taskId },
    );
    const requestWasRunning = conversationTaskStatusOwnsExecutionLease(previous.status);
    const authoritativeDisposition = Boolean(
      (options.terminalDisposition?.outcome === 'blocked' || options.terminalDisposition?.outcome === 'cancelled')
      && options.terminalDisposition.requestId === normalizedRequestId
      && options.terminalDisposition.taskId === previous.taskId,
    );
    const status = authoritativeDisposition
      ? options.terminalDisposition!.outcome
      : completion.complete
      ? 'completed'
      : requestWasRunning
        ? 'blocked'
        : previous.status;
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: previous,
      outcome: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'blocked',
      requestId: normalizedRequestId,
      blocker: status === 'blocked' || status === 'cancelled'
        ? (authoritativeDisposition ? options.terminalDisposition?.reason : '')
          || previous.latestBlocker
          || completion.blocker
          || options.fallbackBlocker
          || 'The execution request ended without a verified terminal result.'
        : '',
      assistantState: options.assistantState !== undefined
        ? compactRolloverText(options.assistantState, 700)
        : previous.assistantState,
      completionSource: authoritativeDisposition
        ? undefined
        : completion.complete
          ? 'tool_receipt'
          : previous.completionSource,
      now,
    });
    if (finalized) return finalized.state;
  }

  if (pendingOwnsRequest) delete conversation.pendingActionContinuation;
  return normalizeConversationActionState(conversation.actionContinuationState);
}

export function clearManagerActionRequestLeaseOwner(
  identity: Pick<ConvergeConversationActionRequestLeaseInput, 'conversationId' | 'userId' | 'requestId'>,
  abortReason = '',
): boolean {
  const key = managerActionTurnKey(identity);
  const owner = managerActionTurnLeases.get(key);
  stopManagerActionTurnHeartbeat(identity);
  const cleared = managerActionTurnLeases.delete(key);
  if (abortReason && owner?.abortController && !owner.abortController.signal.aborted) {
    owner.abortController.abort(new Error(abortReason));
  }
  return cleared;
}
