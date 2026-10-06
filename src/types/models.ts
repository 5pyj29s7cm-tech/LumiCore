// ── Shared data models — reusable across frontend and server ──
// Field names match the in-memory representation in db_layer.ts (after column mapping)

export interface User {
  uid: string;
  username: string;
  password?: string; // only server-side, never exposed to frontend
  role: string;
  balance: number;
  phone: string;
  createdAt: string;
}

export interface UserProfile {
  uid: string;
  username: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  balance: number;
  role: string;
  phone?: string;
  provider: 'custom' | 'google';
}

export interface Memory {
  id: string;
  userId: string;
  type: string;
  content: string;
  keywords: string[];
  confidence: number;
  sourceInteractionId: string;
  createdAt: string;
  updatedAt: string;
  lastRetrievedAt?: string;
  retrieveCount: number;
  tier: 'episodic' | 'semantic' | 'procedural';
  perspective: string;
  importance: number;
  parentId?: string;
  agentId?: string;
  nodeType: string;
  location?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
}

export interface Conversation {
  id: string;
  userId: string;
  agentId?: string;
  title: string;
  status: 'active' | 'closed';
  summary?: string;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
}

export interface Reminder {
  id: string;
  userId: string;
  content: string;
  dueAt?: string;
  status: 'pending' | 'fired' | 'cancelled';
  sourceInteractionId: string;
  createdAt: string;
  firedAt?: string;
}

export interface NotificationItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  action?: string;
  proactiveContext?: Record<string, any>;
  timestamp: number;
  read: boolean;
}

export interface VoicePreference {
  stt: 'auto' | 'qwen' | 'ark' | 'whisper' | 'local-whisper' | 'relay';
  tts: 'auto' | 'local-cosyvoice' | 'cosyvoice' | 'ark' | 'gptsovits' | 'relay';
}

export interface LLMPreference {
  provider: string;
  models: Record<string, string>;
}
