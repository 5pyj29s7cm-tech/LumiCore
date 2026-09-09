import { randomUUID } from 'node:crypto';
import { flushDBOrThrow, readDB, withDatabaseSqlWriteLock, writeDB } from '../../db_layer';
import { runSerializedMutation, type MutationScope } from '../persistence/durable_scope_mutation';

const inFlight = new Set<string>();
const MAX_REMINDER_AGE_MS = 24 * 60 * 60_000;

/** Resolve a scheduler receipt, never a client-supplied task label or message. */
function readReminderDelivery(interactionId: string, scope: MutationScope, reservation?: string) {
  const db = readDB();
  const row = (db.interactions || []).find((item: any) => item.id === interactionId);
  if (!row || row.userId !== scope.userId || row.role !== 'assistant' || row.mode !== 'proactive'
    || (row.domain || 'personal') !== scope.domain || (row.orgId || '') !== scope.orgId
    || !String(row.message || '').startsWith('[reminder_check] ')) return null;
  const age = Date.now() - Date.parse(row.timestamp);
  if (!Number.isFinite(age) || age < -60_000 || age > MAX_REMINDER_AGE_MS) return null;
  let metadata: any;
  try { metadata = JSON.parse(row.toolCalls || '{}'); } catch { return null; }
  if (metadata?.scheduledTaskId !== 'reminder_check' || typeof metadata.executionId !== 'string' || !metadata.executionId
    || !Array.isArray(metadata.reminderIds) || !metadata.reminderIds.length
    || metadata.reminderIds.length > 10 || new Set(metadata.reminderIds).size !== metadata.reminderIds.length) return null;
  if (metadata.proactiveVoiceDispatch && (!reservation || metadata.proactiveVoiceDispatch.reservation !== reservation)) return null;
  const reminders = metadata.reminderIds.map((id: unknown) => typeof id === 'string'
    ? (db.reminders || []).find((item: any) => item.id === id) : null);
  if (reminders.some((item: any) => !item || item.userId !== scope.userId || item.status !== 'fired'
    || (item.domain || 'personal') !== scope.domain || (item.orgId || '') !== scope.orgId
    || item.firedAt !== row.timestamp || !Number.isFinite(Date.parse(item.dueAt))
    || Date.parse(item.dueAt) > Date.parse(row.timestamp))) return null;
  const text = `Reminder: ${reminders.map((item: any) => item.content).join(' | ')}`;
  if (!text.trim() || text.length > 4_000 || row.message !== `[reminder_check] ${text}`) return null;
  return { row, metadata, text };
}

/** One optional voice dispatch for an existing durable scheduler message.
 * The reservation says "dispatch reserved", never "the user heard it".
 * It remains after dispatch (including a crash before a playback receipt).
 */
export function claimReminderVoiceDelivery(interactionId: unknown, scope: MutationScope) {
  if (typeof interactionId !== 'string' || !/^proactive_[a-f0-9]{24}$/.test(interactionId)
    || inFlight.has(interactionId)) return null;
  const initial = readReminderDelivery(interactionId, scope);
  if (!initial) return null;
  inFlight.add(interactionId);
  const reservation = randomUUID();
  const originalTimestamp = initial.row.timestamp;
  let released = false;
  const assertCurrent = () => {
    const current = readReminderDelivery(interactionId, scope, reservation);
    if (released || !current || current.text !== initial.text || current.row.timestamp !== originalTimestamp
      || current.metadata.executionId !== initial.metadata.executionId
      || JSON.stringify(current.metadata.reminderIds) !== JSON.stringify(initial.metadata.reminderIds)) {
      throw new DOMException('Reminder delivery is no longer current', 'AbortError');
    }
  };
  const confirmPersisted = async () => {
    assertCurrent();
    // Read behind the snapshot transaction lock, before our own reservation
    // flush. A candidate merely visible in readDB is not delivery authority.
    const durable = await withDatabaseSqlWriteLock(async ({ query }) => {
      const [row] = await query<any>('SELECT userId,domain,orgId,role,mode,message,timestamp,toolCalls FROM interactions WHERE id = ?', [interactionId]);
      return row;
    });
    let metadata: any;
    try { metadata = JSON.parse(durable?.toolCalls || '{}'); } catch { metadata = null; }
    if (!durable || durable.userId !== scope.userId || (durable.domain || 'personal') !== scope.domain
      || (durable.orgId || '') !== scope.orgId || durable.role !== 'assistant' || durable.mode !== 'proactive'
      || durable.message !== `[reminder_check] ${initial.text}` || durable.timestamp !== originalTimestamp
      || metadata?.scheduledTaskId !== 'reminder_check' || metadata.executionId !== initial.metadata.executionId
      || JSON.stringify(metadata.reminderIds) !== JSON.stringify(initial.metadata.reminderIds)
      || metadata.proactiveVoiceDispatch) {
      throw new DOMException('Reminder delivery has no current durable receipt', 'AbortError');
    }
    assertCurrent();
  };
  return {
    interactionId, text: initial.text, assertCurrent, confirmPersisted,
    async dispatch(assertAllowed: () => void, emit: () => void) {
      await runSerializedMutation(`reminder-voice:${interactionId}`, async () => {
        await confirmPersisted();
        assertAllowed(); assertCurrent();
        const current = readReminderDelivery(interactionId, scope)!;
        current.row.toolCalls = JSON.stringify({ ...current.metadata,
          proactiveVoiceDispatch: { reservation, reservedAt: new Date().toISOString() },
        });
        let emitted = false;
        try {
          writeDB(readDB());
          await flushDBOrThrow();
          assertAllowed(); assertCurrent();
          emit();
          emitted = true;
        } finally {
          if (!emitted) {
            // No audio was dispatched. Remove only our reservation so a later
            // permitted delivery can retry; do not restore stale reminder data.
            const currentRow = (readDB().interactions || []).find((item: any) => item.id === interactionId);
            let latest: any;
            try { latest = JSON.parse(currentRow?.toolCalls || '{}'); } catch { latest = null; }
            if (currentRow && latest?.proactiveVoiceDispatch?.reservation === reservation) {
              delete latest.proactiveVoiceDispatch;
              currentRow.toolCalls = JSON.stringify(latest);
              writeDB(readDB());
              await flushDBOrThrow();
            }
          }
        }
      });
    },
    release() { released = true; inFlight.delete(interactionId); },
  };
}
