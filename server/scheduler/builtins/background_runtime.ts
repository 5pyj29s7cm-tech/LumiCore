import type { ScheduledTask } from "../../scheduler";
import type { ScheduledBuiltinContext } from "./context";
import { getGateConfig } from "../../autonomy/safety_gate";
import { isFirstBootComplete, isSystemExplorationAllowed, persistDailyExploration } from "../../autonomy/system_explorer";
import { collectSystemSnapshotInWorker, resolveSystemExplorationRuntimeDir, SystemExplorationAlreadyRunningError } from "../../runtime/system_exploration_worker";

export function createBackgroundRuntimeTasks(context: ScheduledBuiltinContext): ScheduledTask[] {
  const { scheduler, getAllUserIds, redactSchedulerDiagnostic, getSystemAdminUserIds, getters } = context;
  const tasks: ScheduledTask[] = [];


  // ── Ambient Awareness Tasks ──

  // Activity poll (every 10s) — requests ambient state from all connected Tauri clients
  tasks.push({
    id: 'ambient_activity_poll',
    cron: 'every_10s',
    lastRun: null,
    executionClass: 'client_probe',
    auditMode: 'compact',
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:poll_request', payload);
        }
      }
      return null; // Silent — frontend handles the actual work
    },
  });


  // Idle check (every 1min) — suppresses notifications during active use
  tasks.push({
    id: 'idle_check',
    cron: 'every_1m',
    lastRun: null,
    executionClass: 'client_probe',
    auditMode: 'compact',
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:idle_check', payload);
        }
      }
      return null;
    },
  });


  // ── Autonomous work cycle (every 10 min) — background task generation + execution ──
  tasks.push({
    id: 'autonomous_work_cycle',
    cron: 'every_10m',
    quiet: true,
    lastRun: null,
    executionClass: 'autonomous_orchestration',
    handler: async context => {
      if (!scheduler.io || context?.signal.aborted) return null;

      const userIds = getAllUserIds();
      let totalGenerated = 0;
      let totalExecuted = 0;



      for (const userId of userIds) {
        if (context?.signal.aborted) break;
        try {
          // Background work is governed by the user's workflow policy, not a UI mode.
          if (!getGateConfig(userId).autoProcessEnabled) continue;

          // Generate tasks
          const { generateAutonomousTasks } = await import("../../autonomy/task_generator");
          if (context?.signal.aborted) break;
          const generated = await generateAutonomousTasks(userId, getters, context?.signal);
          totalGenerated += generated;
          if (context?.signal.aborted) break;

          // Execute pending tasks, bounded by the current safety gate.
          const { executeNextAutonomousTask } = await import("../../autonomy/task_executor");
          const maxTasks = Math.max(1, Math.min(50, getGateConfig(userId).maxConsecutiveTasks || 1));
          for (let i = 0; i < maxTasks; i++) {
            if (context?.signal.aborted) break;
            const result = await executeNextAutonomousTask(scheduler.io!, getters, userId, { signal: context?.signal });
            if (!result.executed) break;
            totalExecuted++;
          }
        } catch (err: any) {
          console.warn(`[AutoWorkCycle] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      if (totalGenerated > 0 || totalExecuted > 0) {
        return `Generated ${totalGenerated} tasks, executed ${totalExecuted}`;
      }
      return null;
    },
  });


  // ── Daily System Scan — Lumi checks the PC's health ──
  tasks.push({
    id: 'daily_system_scan',
    cron: 'every_24h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      if (!isFirstBootComplete() || !isSystemExplorationAllowed()) return null;
      let collected;
      try {
        collected = await collectSystemSnapshotInWorker(resolveSystemExplorationRuntimeDir());
      } catch (error) {
        // Bootstrap, an explicit user refresh, and the daily refresh share one
        // isolated worker. A concurrent scan is already producing the same
        // bounded snapshot, so the maintenance tick can safely yield.
        if (error instanceof SystemExplorationAlreadyRunningError) return null;
        throw error;
      }
      // Consent can be withdrawn while the worker is inspecting the host.
      // Never persist or broadcast a result collected after that boundary.
      if (!isSystemExplorationAllowed()) return null;
      const snapshot = persistDailyExploration(collected);

      // Host diagnostics belong to the local/system administration surface,
      // never to organization members as organization knowledge.
      if (scheduler.io) {
        for (const userId of getSystemAdminUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('system:scan_result', {
            timestamp: snapshot.timestamp,
            computerScope: 'server_host',
            hostname: snapshot.hardware.hostname,
            summary: snapshot.changeSummary,
            diskFree: snapshot.hardware.disks.map(d => `${d.name}: ${d.freeGB.toFixed(1)}GB free`),
            appCount: snapshot.software.installedApps.length,
          });
        }
      }

      return null;
    },
  });
  return tasks;
}
