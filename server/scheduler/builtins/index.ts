import { createCoordinationTasks } from "./coordination";
import { createPersonalMemoryTasks } from "./personal_memory";
import { createGrowthTasks } from "./growth";
import { createProactiveContextTasks } from "./proactive_context";
import { createBackgroundRuntimeTasks } from "./background_runtime";
import type { ScheduledBuiltinContext } from "./context";

export function createScheduledBuiltinTasks(context: ScheduledBuiltinContext) {
  return [
    ...createCoordinationTasks(context),
    ...createPersonalMemoryTasks(context),
    ...createGrowthTasks(context),
    ...createProactiveContextTasks(context),
    ...createBackgroundRuntimeTasks(context),
  ];
}
