import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { sanitizeExecutionResponseForDelivery } from "../cognition/execution_guard_recovery";
import type { ScheduledDelivery, ScheduledDeliveryFinalization } from './contracts';

export function finalizeScheduledDelivery(
  taskId: string,
  delivery: ScheduledDelivery,
): ScheduledDeliveryFinalization {
  if (!delivery.modelGenerated) {
    return {
      delivery,
      finalized: false,
      blocked: false,
      reason: '',
    };
  }

  const taskText = `Scheduled proactive message (${taskId}): ${delivery.message}`;
  const finalized = sanitizeExecutionResponseForDelivery(finalizeLumiResponse({
    taskText,
    responseText: delivery.message,
    toolRecords: [],
    source: `scheduler_${taskId}`,
  }), { task: taskText, toolRecords: [] });
  if (finalized.blocked) {
    return {
      delivery: null,
      finalized: true,
      blocked: true,
      reason: finalized.reason || 'Scheduled model output failed final verification.',
    };
  }
  return {
    delivery: {
      ...delivery,
      message: finalized.text,
    },
    finalized: true,
    blocked: false,
    reason: finalized.reason || '',
  };
}
