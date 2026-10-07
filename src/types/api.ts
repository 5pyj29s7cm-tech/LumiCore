// ── API contract types — request/response shapes for all key routes ──
// Used by both frontend services and server route handlers via `import type`

import type { User, UserProfile, Conversation, NotificationItem, Memory, Reminder, VoicePreference, LLMPreference } from './models';

export type { User, UserProfile, Conversation, NotificationItem, Memory, Reminder, VoicePreference, LLMPreference };

// ── Notifications ──

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}
