// Notification service — fetch/clear persisted notifications via REST API

import type { NotificationListResponse } from '@/types/api';
import { apiJson } from './apiClient';

export async function fetchNotifications(owner?: AbortSignal): Promise<NotificationListResponse> {
  const signal = owner ? AbortSignal.any([owner, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const data = await apiJson<NotificationListResponse>('/api/notifications', { signal });
  signal.throwIfAborted();
  if (!Array.isArray(data?.notifications) || !data.notifications.every(item => item && typeof item.id === 'string' && Number.isFinite(item.timestamp)
    && typeof item.read === 'boolean' && ['type', 'title', 'message'].every(key => typeof item[key as keyof typeof item] === 'string'))) throw new Error('Invalid notification list');
  return data;
}

export async function updateNotifications(clear: boolean, signal: AbortSignal): Promise<string[]> {
  const data = await apiJson('/api/notifications' + (clear ? '' : '/read-all'), { method: clear ? 'DELETE' : 'POST', signal });
  if (data?.success !== true || !Array.isArray(data.ids) || data.ids.some((id: unknown) => typeof id !== 'string')) throw new Error('Notification update was not confirmed');
  return data.ids;
}
