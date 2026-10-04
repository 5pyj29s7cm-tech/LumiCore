import type { ScheduledTask } from "../../scheduler";
import type { ScheduledBuiltinContext } from "./context";
import { dispatchDueCommandCenterPlans } from "../../command_center/plans";
import { refreshAuthoritativeStatuteSources } from "../../legal/statute_authority_refresh";

export function createCoordinationTasks(context: ScheduledBuiltinContext): ScheduledTask[] {
  const { scheduler, getSystemAdminUserIds, getAllUserIds, createReminderCheckTask, getters } = context;
  const tasks: ScheduledTask[] = [];

  tasks.push({
    id: 'command_center_plan_dispatch',
    cron: 'every_1m',
    quiet: true,
    auditMode: 'compact',
    lastRun: null,
    executionClass: 'autonomous_orchestration',
    handler: async context => {
      if (context?.signal.aborted) return null;
      dispatchDueCommandCenterPlans();
      if (scheduler.io && !context?.signal.aborted) {
        const { dispatchManualCommandCenterPlanTasks } = await import("../../command_center/runtime");
        await dispatchManualCommandCenterPlanTasks(scheduler.io, getters, { signal: context?.signal });
      }
      return null;
    },
  });


  // Public legal-source metadata is global. Notify personal system admins only
  // when an official record actually enters the review queue.
  tasks.push({
    id: 'legal_authority_source_refresh',
    cron: '23 4 * * *',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const result = await refreshAuthoritativeStatuteSources();
      if (result.newPendingReview === 0) return null;
      const admins = getSystemAdminUserIds();
      const recipients = admins.length > 0 ? admins : getAllUserIds();
      const reviewLines = result.pendingReview
        .map(check => `${check.title}：${check.reasons.join('；')}`)
        .join('\n');
      const message = [
        `现行法权威法源巡检发现 ${result.newPendingReview} 项新变化，相关正式文书交付已自动阻断。`,
        reviewLines,
        result.archivePath ? `巡检记录：${result.archivePath}` : '',
        '请由律师核对官方标准文本后更新法源快照。',
      ].filter(Boolean).join('\n');
      return recipients.map(userId => ({ userId, message, domain: 'personal' as const }));
    },
  });


  // One existing scheduler, with minute-level reminder checks and no model call.
  tasks.push(createReminderCheckTask());
  return tasks;
}
