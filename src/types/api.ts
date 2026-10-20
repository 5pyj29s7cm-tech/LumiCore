// ── API contract types — request/response shapes for all key routes ──
// Used by both frontend services and server route handlers via `import type`

import type { NotificationItem } from './models';

// ── Notifications ──

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}
