import { bindConversationActionTurnTask } from "../action_turn_ledger";
import { type readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { buildConversationActionContinuationState, classifyToolRecordTaskDurability, classifyRecentActionFollowupIntent, isUserObservedTaskCompletion, needsRecentActionContinuationContext, prepareConversationActionTaskState } from "../../cognition/action_continuation";
import { archiveBoundConversationActionReceipts } from "../ledger/receipt_archive";
import { finalizeConversationActionTask, syncConversationActionTaskLedger } from "../ledger/task_lifecycle";
import { conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";
import { partitionConversationReceiptsByOwnership } from "../receipt_ownership";
import { buildActionContract } from "../../cognition/action_contract";
import { normalizeActionIntent } from "../../cognition/normalized_action_intent";
import { sanitizeToolRecordsForPersistence } from "../../cognition/user_output_protection";
import { finalizeConversationActionRequestInDb } from "../action_execution_runtime";
import { detachUnrelatedConversationActionState, hydrateConversationActionState, compactRolloverText } from "../action_state_hydration";
import type { addMessage } from '../manager';
import { resolveConversationActionTerminalDisposition } from './terminal_disposition';
import { finalizePersistedAssistantActionTurnInDb } from './turn_binding';

export function normalizeToolCalls(value: unknown): any[] | undefined {
  return sanitizeToolRecordsForPersistence(value);
}

export function updateConversationForMessage(
  db: Pick<ReturnType<typeof readDatabaseTables>, "conversationActionReceipts" | "conversationActionTasks" | "conversationActionTurns" | "conversations" | "interactions" | "modelRoutingReceipts">,
  msg: Parameters<typeof addMessage>[0],
  id: string,
  now: string,
  normalizedToolCalls: ReturnType<typeof normalizeToolCalls>,
): string | undefined {
  let currentUserMessageIdForLedger = "";


  // Update conversation messageCount and lastActiveAt
  if (msg.conversationId && db.conversations) {
    const conv = db.conversations.find((c: Conversation) => c.id === msg.conversationId);
    if (conv) {
      hydrateConversationActionState(db, conv);
      conv.messageCount = (conv.messageCount || 0) + 1;
      conv.lastActiveAt = now;
      // Auto-title from first user message
      if (!conv.title && msg.role === 'user' && msg.content?.trim()) {
        conv.title = msg.content.trim().slice(0, 80);
      }

      const records = normalizedToolCalls || [];
      const receiptOwnership = !msg.skipActionContinuation
        && msg.role === 'assistant'
        && msg.mode !== 'proactive'
        ? partitionConversationReceiptsByOwnership(records, {
          taskId: conv.actionContinuationState?.taskId,
          requestId: conv.actionContinuationState?.activeRequestId
            || conv.pendingActionContinuation?.requestId,
        })
        : { currentRecords: records, staleRecords: [] };
      // A transport's semantic terminal result is fenced by the exact live
      // task/request/turn in resolveConversationActionTerminalDisposition.
      // Late receipts have their own immutable ownership fence below; their
      // presence in the same persistence batch must not suppress the current
      // request's otherwise-valid terminal disposition.
      const terminalTaskDisposition = resolveConversationActionTerminalDisposition({
        db,
        conversation: conv,
        role: msg.role,
        requestId: msg.requestId,
        skipActionContinuation: msg.skipActionContinuation,
        terminalDisposition: msg.terminalTaskDisposition,
      });
      if (receiptOwnership.staleRecords.length > 0) {
        // Receipt ownership is independent from the transient user/assistant
        // pairing pointer. A late terminal may arrive after that pointer was
        // cleared, but it must still be archived against its immutable task.
        archiveBoundConversationActionReceipts(db, {
          conversationId: conv.id,
          userId: conv.userId,
          records: receiptOwnership.staleRecords,
          turnId: msg.requestId,
          now,
        });
      }
      if (
        msg.role === 'assistant'
        && !conv.pendingActionContinuation
        && receiptOwnership.staleRecords.length > 0
        && receiptOwnership.currentRecords.length === 0
      ) {
        // The foreground pairing slot has already closed. Persist the delayed
        // transcript/archive, fence its historical turn, and return without a
        // generic task sync that would rewrite audit fields on the newer owner.
        if (msg.requestId) {
          finalizePersistedAssistantActionTurnInDb(db, {
            conversationId: conv.id,
            userId: conv.userId,
            requestId: msg.requestId,
            assistantMessageId: id,
            assistantText: msg.content,
            now,
          });
        }
        commitDatabaseTables(db);
        return id;
      }

      if (!msg.skipActionContinuation && msg.role === 'user' && !msg.deferActionPreparation) {
        const userText = String(msg.content || '').trim();
        if (userText) {
          currentUserMessageIdForLedger = id;
          const userObservedCompletion = isUserObservedTaskCompletion(
            userText,
            conv.actionContinuationState,
          );
          const continuationTurn = needsRecentActionContinuationContext(userText);
          const contract = buildActionContract(userText);
          const actionTurn = contract.applies && contract.kind !== 'none';
          if (!userObservedCompletion) {
            detachUnrelatedConversationActionState(db, conv, userText, now);
          }
          const preparedSameTurn = Boolean(
            conv.actionContinuationState
            && conv.actionContinuationState.latestInstruction === userText
            && (
              conversationTaskStatusOwnsExecutionLease(conv.actionContinuationState.status)
              || conv.actionContinuationState.status === 'waiting_confirmation'
            ),
          );
          if (userObservedCompletion && conv.actionContinuationState) {
            finalizeConversationActionTask(db, {
              conversation: conv,
              state: conv.actionContinuationState,
              outcome: 'completed',
              requestId: msg.requestId,
              assistantState: userText,
              completionSource: 'user_observation',
              userText,
              now,
            });
          } else {
            // A user-message wording heuristic may stage pending turn context,
            // but it never creates a durable task. The canonical capability
            // selection path, an explicit model taskIntent, or a durable tool
            // receipt owns task creation.
            if (!actionTurn && !continuationTurn && !preparedSameTurn) {
              // A finished pointer is useful for an immediate “打开它/结果呢”,
              // but must not survive an unrelated topic indefinitely. Unfinished
              // work remains resumable while ordinary conversation continues.
              if (conv.actionContinuationState && !conv.actionContinuationState.unfinished) {
                delete conv.actionContinuationState;
              }
            }
            // This protects the integrity of every user/assistant turn at the
            // rollover boundary. Action-state advancement below is still gated
            // by the actual action contract and terminal receipts.
            conv.pendingActionContinuation = {
              userText,
              messageId: id,
              requestId: msg.requestId,
              updatedAt: now,
            };
          }
        }
      } else if (
        !msg.skipActionContinuation
        &&
        msg.role === 'assistant'
        && msg.mode !== 'proactive'
        && conv.pendingActionContinuation
      ) {
        const pending = conv.pendingActionContinuation;
        currentUserMessageIdForLedger = pending.messageId;
        const activeTaskId = String(conv.actionContinuationState?.taskId || '');
        const currentToolRecords = receiptOwnership.currentRecords;
        const requestMismatch = Boolean(
          pending.requestId
          && msg.requestId
          && pending.requestId !== msg.requestId,
        );
        // A superseded pipeline may still finish and persist its terminal
        // reply. Archive its bound receipts above, but leave the newer turn's
        // pending pointer and state untouched.
        if (requestMismatch) {
          if (conv.actionContinuationState) {
            syncConversationActionTaskLedger(db, {
              conversation: conv,
              state: conv.actionContinuationState,
              now,
            });
          }
          if (msg.requestId) {
            finalizePersistedAssistantActionTurnInDb(db, {
              conversationId: conv.id,
              userId: conv.userId,
              requestId: msg.requestId,
              assistantMessageId: id,
              assistantText: msg.content,
              now,
            });
          }
          commitDatabaseTables(db);
          return id;
        }
        if (records.length > 0 && currentToolRecords.length === 0) {
          // The assistant terminal is already durable and visible. Stale
          // receipts remain quarantined above, but they must never keep this
          // request's transcript pointer or execution lease alive forever.
          finalizeConversationActionRequestInDb(
            db,
            conv,
            msg.requestId || pending.requestId || '',
            {
              assistantState: msg.content,
              fallbackBlocker: 'The terminal tool receipts could not be bound to the active task identity.',
              now,
            },
          );
          if (msg.requestId) {
            finalizePersistedAssistantActionTurnInDb(db, {
              conversationId: conv.id,
              userId: conv.userId,
              requestId: msg.requestId,
              assistantMessageId: id,
              assistantText: msg.content,
              now,
            });
          }
          commitDatabaseTables(db);
          return id;
        }
        const pendingFollowupIntent = classifyRecentActionFollowupIntent(pending.userText);
        const pendingContract = buildActionContract(pending.userText);
        const pendingNormalizedIntent = normalizeActionIntent(pending.userText);
        const toolRecordsBelongToActiveTask = Boolean(
          conv.actionContinuationState?.taskId
          && currentToolRecords.some((record: any) => (
            record?.taskId === conv.actionContinuationState?.taskId
            || (
              conv.actionContinuationState?.activeRequestId
              && record?.requestId === conv.actionContinuationState.activeRequestId
            )
          )),
        );
        const taskDurability = currentToolRecords.map(record => (
          classifyToolRecordTaskDurability(record)
        ));
        const hasDurableCapabilityReceipt = taskDurability.includes('durable');
        const hasLegacyUnknownReceipt = taskDurability.includes('unknown');
        // Legacy persisted rows predate capability snapshots. Preserve their
        // old action migration path, while never using that wording heuristic
        // to turn a canonical observe/read receipt into a durable task.
        const legacyUnknownExecutionIntent = hasLegacyUnknownReceipt && (
          (pendingContract.applies && pendingContract.kind !== 'none')
          || ['client_navigation', 'external_ai_history'].includes(pendingNormalizedIntent.kind)
        );
        const pendingExpectsExecution = msg.taskIntent === 'task'
          || pendingFollowupIntent === 'execute'
          || toolRecordsBelongToActiveTask
          || hasDurableCapabilityReceipt
          || legacyUnknownExecutionIntent;
        const pendingAgeMs = Date.now() - new Date(pending.updatedAt).getTime();
        if (
          pendingExpectsExecution
          && currentToolRecords.length
          && Number.isFinite(pendingAgeMs)
          && pendingAgeMs >= 0
          && pendingAgeMs <= 30 * 60 * 1000
        ) {
          // The task state intentionally coalesces a failed attempt followed by
          // a successful retry into one authoritative logical step. The
          // append-only receipt table must still retain both attempts so later
          // diagnosis can explain latency and recovery instead of presenting a
          // falsely clean history.
          const nextState = buildConversationActionContinuationState({
            previous: conv.actionContinuationState,
            userText: pending.userText,
            assistantText: msg.content,
            toolCalls: currentToolRecords,
            updatedAt: now,
            evidenceMessageId: id,
            userMessageId: pending.messageId,
            requestId: conv.actionContinuationState?.activeRequestId || pending.requestId || msg.requestId,
            toolPolicy: conv.actionContinuationState?.policySnapshot,
          });
          if (nextState) {
            const receiptTaskId = activeTaskId || nextState.taskId;
            const receiptRequestId = String(msg.requestId || pending.requestId || '').trim();
            const attemptRecords = currentToolRecords.map((record: any) => ({
              ...record,
              taskId: receiptTaskId,
              turnId: record.turnId || currentUserMessageIdForLedger || msg.requestId || pending.requestId,
              requestId: record.requestId || msg.requestId || pending.requestId,
            }));
            if (!activeTaskId) {
              // A durable tool receipt may be the first canonical signal that
              // this turn owns a task. Create the row without its coalesced
              // receipts first, so the raw failed attempt can be archived
              // before the successful retry and remains chronologically true.
              syncConversationActionTaskLedger(db, {
                conversation: conv,
                state: {
                  ...nextState,
                  status: 'executing',
                  receipts: [],
                  unfinished: true,
                  latestBlocker: '',
                  completionSource: undefined,
                  activeRequestId: receiptRequestId || undefined,
                },
                userText: pending.userText,
                rootUserMessageId: currentUserMessageIdForLedger || undefined,
                currentUserMessageId: currentUserMessageIdForLedger || undefined,
                now,
              });
            }
            if (receiptRequestId && receiptTaskId) {
              bindConversationActionTurnTask({
                conversationId: conv.id,
                userId: conv.userId,
                requestId: receiptRequestId,
                taskId: receiptTaskId,
                now,
              });
            }
            const receiptArchive = archiveBoundConversationActionReceipts(db, {
              conversationId: conv.id,
              userId: conv.userId,
              records: attemptRecords,
              turnId: currentUserMessageIdForLedger || msg.requestId || pending.requestId,
              now,
              terminalDisposition: terminalTaskDisposition || undefined,
              assistantState: msg.content,
              currentPairingAuthority: {
                userMessageId: pending.messageId,
                assistantMessageId: id,
              },
            });
            const receiptAdjudicated = receiptArchive.adjudicatedTaskIds.includes(receiptTaskId);
            if (!receiptAdjudicated) {
              // Historical/unbound records remain append-only evidence. They
              // cannot update the current live projection in this fallback.
            } else if (receiptArchive.terminalDispositionApplied) {
              // The append-only receipts and authoritative request outcome were
              // committed together. Never recompute completion from a successful
              // earlier step later in this assistant persistence boundary.
            } else if (isTerminalConversationTaskStatus(nextState.status)) {
              finalizeConversationActionTask(db, {
                conversation: conv,
                state: nextState,
                outcome: nextState.status as 'completed' | 'failed' | 'cancelled',
                requestId: receiptRequestId,
                blocker: nextState.latestBlocker,
                assistantState: nextState.assistantState,
                completionSource: nextState.completionSource,
                userText: pending.userText,
                now,
                retainPendingAction: true,
              });
            } else if (nextState.status === 'blocked') {
              finalizeConversationActionTask(db, {
                conversation: conv,
                state: nextState,
                outcome: 'blocked',
                requestId: msg.requestId || pending.requestId,
                blocker: nextState.latestBlocker,
                assistantState: nextState.assistantState,
                userText: pending.userText,
                now,
                retainPendingAction: true,
              });
            } else {
              conv.actionContinuationState = nextState;
            }
          }
        } else if (
          msg.taskIntent === 'task'
          && !conv.actionContinuationState?.unfinished
        ) {
          // A model may explicitly classify a turn as durable work before it
          // has a terminal receipt. Preserve that task as blocked/resumable,
          // rather than silently losing it or inferring durability from prose.
          const prepared = prepareConversationActionTaskState(undefined, {
            userText: pending.userText,
            requestId: pending.requestId || msg.requestId || id,
            toolPolicy: {
              allowedTools: [],
              requireConfirmation: [],
              forbiddenTools: [],
              maxIterations: 5,
            },
            forceTask: true,
            now,
          });
          if (prepared.state) {
            finalizeConversationActionTask(db, {
              conversation: conv,
              state: prepared.state,
              outcome: terminalTaskDisposition?.outcome || 'blocked',
              requestId: pending.requestId || msg.requestId || id,
              blocker: terminalTaskDisposition?.reason
                || 'No terminal tool receipt was recorded for the requested step.',
              assistantState: compactRolloverText(msg.content, 700),
              userText: pending.userText,
              now,
              retainPendingAction: true,
            });
          }
        } else if (
          conv.actionContinuationState?.unfinished
          && pendingExpectsExecution
        ) {
          finalizeConversationActionTask(db, {
            conversation: conv,
            state: conv.actionContinuationState,
            outcome: terminalTaskDisposition?.outcome || 'blocked',
            requestId: msg.requestId || pending.requestId,
            blocker: terminalTaskDisposition?.reason
              || 'No terminal tool receipt was recorded for the requested step.',
            assistantState: msg.content,
            userText: pending.userText,
            now,
            retainPendingAction: true,
          });
        }
        const terminalRequestId = String(msg.requestId || pending.requestId || '').trim();
        if (terminalRequestId && conv.actionContinuationState?.taskId) {
          bindConversationActionTurnTask({
            conversationId: conv.id,
            userId: conv.userId,
            requestId: terminalRequestId,
            taskId: conv.actionContinuationState.taskId,
            now,
          });
        }
        finalizeConversationActionRequestInDb(
          db,
          conv,
          terminalRequestId,
          {
            assistantState: msg.content,
            fallbackBlocker: 'The execution request ended without a terminal tool receipt.',
            now,
            terminalDisposition: terminalTaskDisposition || undefined,
          },
        );
      }

      if (conv.actionContinuationState && !msg.skipActionContinuation) {
        syncConversationActionTaskLedger(db, {
          conversation: conv,
          state: conv.actionContinuationState,
          userText: msg.role === 'user'
            ? String(msg.content || '')
            : conv.actionContinuationState.latestInstruction,
          ...(msg.role === 'assistant' && currentUserMessageIdForLedger
            ? { rootUserMessageId: currentUserMessageIdForLedger }
            : {}),
          ...(currentUserMessageIdForLedger
            ? { currentUserMessageId: currentUserMessageIdForLedger }
            : {}),
          now,
        });
      }
    }
  }
}
