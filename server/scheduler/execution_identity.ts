import crypto from "node:crypto";
import { parseSchedule } from './schedule';
import type { ScheduledDelivery } from './contracts';

/** Stable within one cron/interval slot, so restarts cannot replay that slot. */
export function buildScheduledExecutionId(
  taskId: string,
  cron: string,
  at: Date = new Date(),
): string {
  const parsed = parseSchedule(cron);
  const slot = parsed.type === 'interval'
    ? Math.floor(at.getTime() / parsed.intervalMs)
    : at.toISOString().slice(0, 16);
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ taskId, cron, slot }))
    .digest('hex')
    .slice(0, 24);
  return `scheduler_${digest}`;
}

export function buildScheduledProactiveInteractionId(
  executionId: string,
  deliveryIndex: number,
  delivery: Pick<ScheduledDelivery, 'userId' | 'domain' | 'orgId'>,
): string {
  return `proactive_${crypto.createHash('sha256')
    .update(JSON.stringify({
      executionId,
      deliveryIndex,
      userId: delivery.userId,
      domain: delivery.domain,
      orgId: delivery.orgId,
    }))
    .digest('hex')
    .slice(0, 24)}`;
}
