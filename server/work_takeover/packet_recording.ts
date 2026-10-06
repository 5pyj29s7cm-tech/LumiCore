import { cnWorkTakeoverMessages } from "../regions/messages/work_takeover_messages";
import { updateWorkTakeoverTask, type WorkTakeoverTask } from './tasks';
import type { WorkTakeoverExecutionPlan } from './execution_planner';
import type { WorkTakeoverPacket } from './task_packet';

export function recordWorkTakeoverPacket(userId: string, task: WorkTakeoverTask, plan: WorkTakeoverExecutionPlan, packet: WorkTakeoverPacket, extraMetadata: Record<string, any> = {}): WorkTakeoverTask {
  const existingExecution = task?.metadata?.workTakeoverExecution && typeof task.metadata.workTakeoverExecution === 'object'
    ? task.metadata.workTakeoverExecution
    : {};
  const extraExecution = extraMetadata.workTakeoverExecution && typeof extraMetadata.workTakeoverExecution === 'object'
    ? extraMetadata.workTakeoverExecution
    : {};
  const { workTakeoverExecution: _unused, ...restExtraMetadata } = extraMetadata;
  return updateWorkTakeoverTask(userId, task.id, {
    status: task.status === 'queued' ? 'in_progress' : task.status,
    artifact: {
      type: 'file',
      label: cnWorkTakeoverMessages.packetLabel,
      path: packet.folderPath,
      content: packet.summary,
      status: 'prepared',
    },
    metadata: {
      ...restExtraMetadata,
      workTakeoverExecution: {
        ...existingExecution,
        lastPlan: plan,
        updatedAt: packet.createdAt,
        ...extraExecution,
      },
      workTakeoverPacket: packet,
    },
    note: packet.summary,
  } as any) || task;
}
