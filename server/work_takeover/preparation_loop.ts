import { executeWorkTakeoverPlanStep, getWorkTakeoverExecutionProgress, planWorkTakeoverExecution, type WorkTakeoverExecutionMode, type WorkTakeoverStepExecutionResult } from './execution_planner';
import { recordWorkTakeoverStepExecution, type WorkTakeoverTask } from './tasks';

export function boundedWorkTakeoverSteps(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  const requested = Number(value);
  return Math.max(minimum, Math.min(Number.isFinite(requested) ? Math.floor(requested) : fallback, maximum));
}

/** One local preparation loop. A preview cannot advance history or claim persisted progress. */
export function runWorkTakeoverPreparation(task: WorkTakeoverTask, options: {
  mode: WorkTakeoverExecutionMode;
  maxSteps: number;
  record: boolean;
  stopOnConfirmation: boolean;
}) {
  let currentTask = task;
  const executions: WorkTakeoverStepExecutionResult[] = [];
  const stopReasons: string[] = [];
  for (let i = 0; i < options.maxSteps; i++) {
    if (currentTask.status === 'cancelled' || currentTask.status === 'delivered') throw new Error('A terminal work takeover task cannot run preparation steps.');
    const plan = planWorkTakeoverExecution(currentTask, { mode: options.mode });
    const progress = getWorkTakeoverExecutionProgress(currentTask, plan);
    if (progress.complete) break;
    const execution = executeWorkTakeoverPlanStep(currentTask, plan, { stepId: progress.nextStep?.id });
    executions.push(execution);
    if (options.record) currentTask = recordWorkTakeoverStepExecution(task.userId, currentTask, plan, execution);
    if (execution.status === 'blocked') { stopReasons.push('blocked'); break; }
    if (options.stopOnConfirmation && execution.status === 'waiting_confirmation') { stopReasons.push('waiting_confirmation'); break; }
    if (!options.record) { stopReasons.push('step_not_recorded'); break; }
  }
  const plan = planWorkTakeoverExecution(currentTask, { mode: options.mode });
  const progress = getWorkTakeoverExecutionProgress(currentTask, plan);
  if (!stopReasons.length) stopReasons.push(progress.complete ? 'safe_steps_complete' : options.maxSteps > 0 ? 'max_steps_reached' : 'safe_loop_disabled');
  return { task: currentTask, plan, progress, executions, stopReasons };
}
