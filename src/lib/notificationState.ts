export interface NotificationStateItem {
  id: string;
  type: string;
  timestamp: number;
  read: boolean;
}

export function mergeNotificationState<T extends NotificationStateItem>(
  current: T[],
  incoming: T[],
  options: {
    clearedAt?: number;
    allowGreeting?: boolean;
    limit?: number;
  } = {},
): T[] {
  const clearedAt = Number(options.clearedAt || 0);
  const allowGreeting = options.allowGreeting !== false;
  const byId = new Map<string, T>();

  for (const item of incoming) {
    if (Number(item.timestamp || 0) <= clearedAt) continue;
    if (!allowGreeting && item.type === 'greeting') continue;
    byId.set(item.id, item);
  }
  // Optimistic local mutations (read/clear state and new socket items) win over
  // an older fetch that may have started before the mutation.
  for (const item of current) {
    if (Number(item.timestamp || 0) <= clearedAt) continue;
    byId.set(item.id, item);
  }

  return [...byId.values()]
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, options.limit || 50);
}

export function notificationClearStorageKey(userId: string): string {
  return `lumi_notifications_cleared_at_${userId}`;
}
