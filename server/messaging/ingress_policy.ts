import { getBinding } from './bindings';
import type { IncomingMessage } from './types';

export interface MessagingIngressDecision {
  allowed: boolean;
  reason: 'allowed' | 'group_not_mentioned' | 'group_not_authorized' | 'rate_limited';
  retryAfterMs?: number;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

const RATE_WINDOW_MS = 60_000;
const PRIVATE_RATE_LIMIT = 20;
const GROUP_RATE_LIMIT = 10;
const rateBuckets = new Map<string, RateBucket>();

function rateKey(message: IncomingMessage): string {
  return [message.platform, message.chatType, message.chatId, message.userId].join(':');
}

function applyRateLimit(message: IncomingMessage, now: number): MessagingIngressDecision {
  const key = rateKey(message);
  const limit = message.chatType === 'group' ? GROUP_RATE_LIMIT : PRIVATE_RATE_LIMIT;
  const current = rateBuckets.get(key);
  if (!current || now - current.windowStartedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { windowStartedAt: now, count: 1 });
    return { allowed: true, reason: 'allowed' };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      reason: 'rate_limited',
      retryAfterMs: Math.max(1, RATE_WINDOW_MS - (now - current.windowStartedAt)),
    };
  }
  current.count += 1;
  return { allowed: true, reason: 'allowed' };
}

export function evaluateMessagingIngress(
  message: IncomingMessage,
  now = Date.now(),
): MessagingIngressDecision {
  if (message.platform === 'feishu' && message.chatType === 'group') {
    if (message.botMentioned !== true) {
      return { allowed: false, reason: 'group_not_mentioned' };
    }
    if (!getBinding('feishu', message.userId, message.chatId, 'group')) {
      return { allowed: false, reason: 'group_not_authorized' };
    }
  }
  return applyRateLimit(message, now);
}

export function resetMessagingIngressPolicyForTest(): void {
  rateBuckets.clear();
}
