import { readDatabaseTables, commitDatabaseTables } from '../../../db_layer';

export interface Reminder {
  id: string;
  userId: string;
  content: string;
  dueAt: string | null;
  status: 'pending' | 'fired';
  sourceInteractionId: string;
  createdAt: string;
  firedAt: string | null;
  domain?: string;
  orgId?: string;
}

const reminderSessions = new WeakMap<Reminder[], ReturnType<typeof readDatabaseTables<'reminders'>>>();

function getReminderStore(): Reminder[] {
  const db = readDatabaseTables(["reminders"]);
  if (!db.reminders) db.reminders = [];
  reminderSessions.set(db.reminders, db);
  return db.reminders;
}

function saveReminderStore(reminders: Reminder[]): void {
  const db = reminderSessions.get(reminders) || readDatabaseTables(["reminders"]);
  db.reminders = reminders;
  commitDatabaseTables(db);
}

export function addReminder(reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>): Reminder {
  return upsertReminder(reminder, false).reminder;
}

export function upsertPendingReminder(
  reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>,
): { reminder: Reminder; created: boolean } {
  return upsertReminder(reminder, true);
}

function upsertReminder(
  reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>, mergePending: boolean,
): { reminder: Reminder; created: boolean } {
  const all = getReminderStore();
  const existing = mergePending ? all.find(item =>
    item.userId === reminder.userId
    && item.status === 'pending'
    && item.sourceInteractionId === reminder.sourceInteractionId
    && (item.domain || 'personal') === (reminder.domain || 'personal')
    && (item.orgId || '') === (reminder.orgId || ''),
  ) : undefined;
  if (existing) {
    existing.content = reminder.content;
    existing.dueAt = reminder.dueAt;
    saveReminderStore(all);
    return { reminder: existing, created: false };
  }
  const created: Reminder = {
    id: `rem_${crypto.randomUUID()}`, ...reminder,
    status: 'pending', createdAt: new Date().toISOString(), firedAt: null,
  };
  all.push(created); saveReminderStore(all);
  return { reminder: created, created: true };
}

export function getDueReminders(filters: { userId?: string; domain?: string; orgId?: string } = {}): Reminder[] {
  const all = getReminderStore();
  const now = new Date().toISOString();
  return all
    .filter(r =>
      r.status === 'pending' &&
      r.dueAt &&
      r.dueAt <= now &&
      (!filters.userId || r.userId === filters.userId) &&
      (filters.domain === undefined || (r.domain || 'personal') === filters.domain) &&
      (filters.orgId === undefined || (r.orgId || '') === filters.orgId)
    )
    .slice(0, 10);
}

export function fireReminder(id: string): void {
  const all = getReminderStore();
  const r = all.find(r => r.id === id);
  if (r) {
    r.status = 'fired';
    r.firedAt = new Date().toISOString();
    saveReminderStore(all);
  }
}
