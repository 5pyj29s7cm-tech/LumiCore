import { getDueReminders } from "../memory";
import type { ScheduledTask, ScheduledDelivery } from './contracts';

/** Select due reminders only; the scheduler owns their atomic delivery commit. */
export function createReminderCheckTask(): ScheduledTask {
  return {
    id: 'reminder_check',
    cron: 'every_1m',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const due = getDueReminders();
      const grouped = new Map<string, ScheduledDelivery>();
      for (const reminder of due) {
        const domain = reminder.domain || 'personal';
        // Malformed work scope must never be downgraded to personal delivery.
        if (!['personal', 'work'].includes(domain) || (domain === 'work' && !reminder.orgId)) continue;
        const orgId = domain === 'work' ? reminder.orgId || '' : '';
        const key = JSON.stringify([reminder.userId, domain, orgId]);
        const existing = grouped.get(key);
        if (existing) {
          existing.message += ` | ${reminder.content}`;
          existing.reminderIds!.push(reminder.id);
        } else grouped.set(key, {
          userId: reminder.userId,
          message: `Reminder: ${reminder.content}`,
          domain: domain as 'personal' | 'work',
          orgId,
          reminderIds: [reminder.id],
        });
      }
      return grouped.size > 0 ? [...grouped.values()] : null;
    },
  };
}
