// ── Shared data models — reusable across frontend and server ──
// Field names match the in-memory representation in db_layer.ts (after column mapping)

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
