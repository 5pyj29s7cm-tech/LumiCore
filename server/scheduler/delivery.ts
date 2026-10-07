import type { Server as SocketIOServer } from 'socket.io';
import { readDatabaseTables } from '../../db_layer';
import type { Reminder } from '../memory';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { ScheduledTask, ScheduledDelivery, ScheduledTaskResult } from './contracts';
import { awaitExecutionPhase, ScheduledTaskExecutionError, type ScheduledInFlightHandler } from './execution_phase';
import { buildScheduledProactiveInteractionId } from './execution_identity';
import { finalizeScheduledDelivery } from './delivery_finalization';
import { redactSchedulerDiagnostic } from './diagnostics';

/** Atomic message and reminder claims share a projection before any client emission. */
export class ScheduledDeliveryService {
  constructor(
    private writeDatabase: (data: any) => void,
    private getIO: () => SocketIOServer | null,
    private flush: (execution?: ScheduledInFlightHandler) => Promise<void>,
    private track: <T>(operation: Promise<T>, execution: ScheduledInFlightHandler) => Promise<T>,
  ) {}

  /**
     * Stage the complete candidate batch and swap it into the in-memory database
     * with one write. No delivery row becomes visible before every row has been
     * materialized, so a later item cannot strand an earlier silent message.
     */
    persistProactiveMessageBatch(
      taskId: string,
      executionId: string,
      deliveries: Array<{ deliveryIndex: number; delivery: ScheduledDelivery }>,
      timestamp: string,
    ): { createdInteractionIds: string[]; createdDeliveryIndexes: Set<number>; reminderChanges: Array<{ before: Reminder; after: Reminder }> } {
      const currentDb = readDatabaseTables(["interactions", "reminders"]);
      const originalInteractions = Array.isArray(currentDb.interactions)
        ? currentDb.interactions
        : [];
      const candidateDb = {
        ...currentDb,
        interactions: [...originalInteractions],
        reminders: [...(currentDb.reminders || [])],
      };
      const existingIds = new Set(originalInteractions.map((candidate: any) => candidate.id));
      const createdInteractionIds: string[] = [];
      const createdDeliveryIndexes = new Set<number>();
      const reminderChanges: Array<{ before: Reminder; after: Reminder }> = [];
      const claimedReminderIds = new Set<string>();
      for (const { deliveryIndex, delivery } of deliveries) {
        const id = buildScheduledProactiveInteractionId(executionId, deliveryIndex, delivery);
        if (existingIds.has(id)) continue;
        if (taskId === 'reminder_check' || delivery.reminderIds) {
          if (taskId !== 'reminder_check' || !delivery.reminderIds?.length) {
            throw new ScheduledTaskExecutionError('Reminder delivery is missing its server-owned claims.', 'scheduler_delivery_invalid');
          }
          const reminders = delivery.reminderIds.map(reminderId => {
            const reminder = candidateDb.reminders.find((item: Reminder) => item.id === reminderId);
            if (claimedReminderIds.has(reminderId) || !reminder || reminder.status !== 'pending'
              || !reminder.dueAt || reminder.dueAt > timestamp
              || reminder.userId !== delivery.userId
              || (reminder.domain || 'personal') !== (delivery.domain || 'personal')
              || (reminder.orgId || '') !== (delivery.orgId || '')) {
              throw new ScheduledTaskExecutionError('Reminder delivery claims are no longer current or do not match the recipient.', 'scheduler_delivery_invalid');
            }
            claimedReminderIds.add(reminderId);
            const before = { ...reminder };
            const after = { ...reminder, status: 'fired' as const, firedAt: timestamp };
            candidateDb.reminders[candidateDb.reminders.indexOf(reminder)] = after;
            reminderChanges.push({ before, after });
            return reminder;
          });
          // A reminder can be edited between handler selection and delivery.
          // Construct the message from the same authoritative candidate we commit.
          delivery.message = `Reminder: ${reminders.map((reminder: Reminder) => reminder.content).join(' | ')}`;
        }
        existingIds.add(id);
        candidateDb.interactions.push({
          id,
          userId: delivery.userId,
          agentId: 'lumi',
          conversationId: '',
          module: 'lumi',
          message: `[${taskId}] ${delivery.message}`,
          response: '',
          role: 'assistant',
          personality: 'lumi',
          mode: 'proactive',
          toolCalls: JSON.stringify({ executionId, scheduledTaskId: taskId, ...(delivery.reminderIds ? { reminderIds: delivery.reminderIds } : {}) }),
          domain: delivery.domain || 'personal',
          orgId: delivery.domain === 'work' ? delivery.orgId || '' : '',
          timestamp,
        });
        createdInteractionIds.push(id);
        createdDeliveryIndexes.add(deliveryIndex);
      }
      if (createdInteractionIds.length === 0) {
        return { createdInteractionIds, createdDeliveryIndexes, reminderChanges };
      }
      try {
        this.writeDatabase(candidateDb);
      } catch (error) {
        try {
          this.rollbackProactiveMessageBatch(createdInteractionIds, reminderChanges);
        } catch (rollbackError) {
          throw new Error(
            'Atomic proactive delivery persistence failed and its in-memory rollback could not be confirmed.',
            { cause: rollbackError },
          );
        }
        throw error;
      }
      return { createdInteractionIds, createdDeliveryIndexes, reminderChanges };
    }

  rollbackProactiveMessageBatch(createdInteractionIds: string[], reminderChanges: Array<{ before: Reminder; after: Reminder }> = []): void {
      if (createdInteractionIds.length === 0) return;
      const rollbackDb = readDatabaseTables(["interactions", "reminders"]);
      const created = new Set(createdInteractionIds);
      // Mutate the live projection before calling the writer as well: even a
      // writer that throws after swapping its candidate cannot leave these rows
      // available to a retry as created=false.
      rollbackDb.interactions = (rollbackDb.interactions || [])
        .filter((candidate: any) => !created.has(candidate.id));
      // Restore only our claim. Do not resurrect a deleted reminder or overwrite
      // another user's edit while the asynchronous flush was settling.
      rollbackDb.reminders = (rollbackDb.reminders || []).map((reminder: Reminder) => {
        const change = reminderChanges.find(item => item.after.id === reminder.id);
        return change && reminder.status === change.after.status && reminder.firedAt === change.after.firedAt
          ? { ...reminder, status: change.before.status, firedAt: change.before.firedAt }
          : reminder;
      });
      this.writeDatabase(rollbackDb);
    }

  async deliverTaskResult(
      task: ScheduledTask,
      plan: CapabilityExecutionPlan,
      result: ScheduledTaskResult,
      timestamp: string,
      execution: ScheduledInFlightHandler,
    ): Promise<{ deliveryCount: number; persistedCount: number; emittedCount: number; withheldCount: number }> {
      const summary = { deliveryCount: 0, persistedCount: 0, emittedCount: 0, withheldCount: 0 };
      if (execution.controller.signal.aborted) throw execution.controller.signal.reason;
      if (!result) return summary;
      if (!Array.isArray(result)) {
        if (!task.quiet) {
          console.warn(`[Scheduler] Dropped unscoped proactive result from "${redactSchedulerDiagnostic(task.id)}". Return ScheduledDelivery[] instead.`);
        }
        return summary;
      }

      // Validate the complete delivery envelope before creating any durable row
      // or emitting anything. In particular, a work-scoped delivery without an
      // organization must never silently fall back to a personal user room.
      const invalidDeliveryIndex = result.findIndex((delivery: any) => (
        !delivery
        || typeof delivery !== 'object'
        || typeof delivery.userId !== 'string'
        || !delivery.userId.trim()
        || typeof delivery.message !== 'string'
        || !delivery.message.trim()
        || (delivery.domain !== undefined && delivery.domain !== 'personal' && delivery.domain !== 'work')
        || (delivery.domain === 'work' && (
          typeof delivery.orgId !== 'string' || !delivery.orgId.trim()
        ))
      ));
      if (invalidDeliveryIndex >= 0) {
        throw new ScheduledTaskExecutionError(
          `Scheduled delivery ${invalidDeliveryIndex} was rejected because its recipient, message, or scope was invalid.`,
          'scheduler_delivery_invalid',
        );
      }

      const preparedDeliveries: Array<{
        deliveryIndex: number;
        normalized: ScheduledDelivery;
        finalized: boolean;
        reason: string;
      }> = [];
      result.forEach((delivery, deliveryIndex) => {
        summary.deliveryCount += 1;
        const deliveryFinalization = finalizeScheduledDelivery(task.id, delivery);
        if (!deliveryFinalization.delivery) {
          summary.withheldCount += 1;
          console.warn(
            `[Scheduler] Withheld unverified model-authored proactive message from "${redactSchedulerDiagnostic(task.id)}": `
            + redactSchedulerDiagnostic(deliveryFinalization.reason),
          );
          return;
        }
        const safeDelivery = deliveryFinalization.delivery;
        const normalized: ScheduledDelivery = {
          userId: safeDelivery.userId.trim(),
          message: safeDelivery.message.trim(),
          domain: safeDelivery.domain === 'work' ? 'work' : 'personal',
          orgId: safeDelivery.domain === 'work' ? safeDelivery.orgId!.trim() : '',
          ...(safeDelivery.reminderIds ? { reminderIds: [...safeDelivery.reminderIds] } : {}),
        };
        preparedDeliveries.push({
          deliveryIndex,
          normalized,
          finalized: deliveryFinalization.finalized,
          reason: deliveryFinalization.reason,
        });
      });
      let batch: ReturnType<ScheduledDeliveryService['persistProactiveMessageBatch']>;
      try {
        batch = this.persistProactiveMessageBatch(
          task.id,
          plan.taskId,
          preparedDeliveries.map(item => ({
            deliveryIndex: item.deliveryIndex,
            delivery: item.normalized,
          })),
          timestamp,
        );
      } catch (error) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = redactSchedulerDiagnostic(error);
        throw error;
      }
      summary.persistedCount = preparedDeliveries.length;
      const pendingEmissions = preparedDeliveries.filter(item => (
        batch.createdDeliveryIndexes.has(item.deliveryIndex) && !task.quiet && this.getIO()
      ));
      if (batch.createdInteractionIds.length > 0) {
        // Never tell the client about a proactive result that exists only in
        // process memory. The strict flush is the delivery evidence boundary.
        const deliveryFlush = this.flush(execution);
        try {
          await awaitExecutionPhase(deliveryFlush, execution, 'delivery');
          if (execution.controller.signal.aborted) throw execution.controller.signal.reason;
        } catch (error) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(error);
          try {
            this.rollbackProactiveMessageBatch(batch.createdInteractionIds, batch.reminderChanges);
          } catch (rollbackError: any) {
            task.lastPersistenceError = redactSchedulerDiagnostic(
              `${task.lastPersistenceError || 'Delivery persistence failed'}; rollback failed: ${rollbackError}`,
            );
          }
          // A timed-out flush may still commit its captured candidate. Chain a
          // strict rollback boundary behind its real settlement and keep both
          // promises inside the execution fence.
          const rollbackFlush = this.track(
            deliveryFlush.catch(() => undefined).then(() => this.flush()),
            execution,
          );
          if (!execution.controller.signal.aborted) {
            try {
              await awaitExecutionPhase(rollbackFlush, execution, 'delivery');
            } catch (rollbackError: any) {
              task.lastPersistenceError = redactSchedulerDiagnostic(
                `${task.lastPersistenceError || 'Delivery persistence failed'}; durable rollback failed: ${rollbackError}`,
              );
              if (execution.controller.signal.aborted) {
                throw execution.controller.signal.reason;
              }
            }
          }
          throw error;
        }
        for (const emission of pendingEmissions) {
          if (emission.normalized.reminderIds?.some(reminderId => {
            const expected = batch.reminderChanges.find(item => item.after.id === reminderId)?.after;
            const current = (readDatabaseTables(["reminders"]).reminders || []).find((item: Reminder) => item.id === reminderId);
            return !expected || !current || current.status !== 'fired' || current.firedAt !== expected.firedAt
              || current.userId !== expected.userId || current.content !== expected.content || current.dueAt !== expected.dueAt
              || (current.domain || 'personal') !== (expected.domain || 'personal') || (current.orgId || '') !== (expected.orgId || '');
          })) continue;
          const room = emission.normalized.domain === 'work' && emission.normalized.orgId
            ? `user:${emission.normalized.userId}:org:${emission.normalized.orgId}`
            : `user:${emission.normalized.userId}:personal`;
          this.getIO()!.to(room).emit('agent:proactive', {
            taskId: task.id,
            interactionId: buildScheduledProactiveInteractionId(plan.taskId, emission.deliveryIndex, emission.normalized),
            message: emission.normalized.message,
            domain: emission.normalized.domain,
            orgId: emission.normalized.orgId,
            timestamp,
            finalized: emission.finalized,
            blocked: false,
            reason: emission.reason,
          });
          summary.emittedCount += 1;
        }
      }
      return summary;
    }
}
