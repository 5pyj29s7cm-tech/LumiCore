// ── API contract types — request/response shapes for all key routes ──
// Used by both frontend services and server route handlers via `import type`

import type { User, UserProfile, Conversation, NotificationItem, Memory, Reminder, VoicePreference, LLMPreference } from './models';
import type { MarketplaceSkill as RegistrySkill } from '../../server/marketplace/registry';
export type { User, UserProfile, Conversation, NotificationItem, Memory, Reminder, VoicePreference, LLMPreference };

// ── Voice ──

export interface VoiceItem {
  voiceId: string;
  name: string;
  provider: string;
  language: string;
  category: 'premade' | 'cloned';
}

// ── Notifications ──

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

// ── Marketplace ──

export type MarketplaceSkill = Pick<RegistrySkill,
  'id' | 'name' | 'description' | 'author' | 'downloads' | 'rating' | 'category' | 'icon' | 'installed'
  | 'version' | 'toolCount' | 'requiresApiKey' | 'apiKeyEnv' | 'apiKeyUrl' | 'requiresSetup' | 'setupNote'>;
