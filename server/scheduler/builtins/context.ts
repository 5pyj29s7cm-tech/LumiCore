import type { Scheduler, ScheduledTask } from "../../scheduler";
import type { ProviderGetters } from "../../llm/provider_getters";

export interface ScheduledBuiltinContext {
  scheduler: Pick<Scheduler, "io">;
  getters: ProviderGetters;
  getAllUserIds: () => string[];
  getSystemAdminUserIds: () => string[];
  createReminderCheckTask: () => ScheduledTask;
  redactSchedulerDiagnostic: (value: unknown) => string;
}
