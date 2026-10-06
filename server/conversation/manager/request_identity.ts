import { readDatabaseTables } from '../../../db_layer';
import type { MessageRecord } from './contracts';

export function getMessageByRequestId(input: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  requestId: string;
  role: string;
  source?: string;
  channel?: string;
  domain?: string;
  orgId?: string;
}): MessageRecord | null {
  const requestId = String(input.requestId || '').trim();
  if (!requestId) return null;
  const source = String(input.source || '');
  const channel = String(input.channel || '');
  const row = (readDatabaseTables(["interactions"]).interactions || []).find((item: any) => (
    item.userId === input.userId
    && (!input.agentId || item.agentId === input.agentId)
    && (!input.conversationId || item.conversationId === input.conversationId)
    && item.role === input.role
    && (input.domain === undefined || (item.domain || 'personal') === input.domain)
    && (input.orgId === undefined || (item.orgId || '') === input.orgId)
    && (!source || item.source === source)
    && (!channel || item.channel === channel)
    && (
      String(item.requestId || '') === requestId
      || String(item.externalMessageId || '') === requestId
    )
  ));
  return row || null;
}
