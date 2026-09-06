import { normalizePersistedPendingChatExecutions } from './chatEventReceipts';

export interface ChatRecoveryOwner {
  userId: string;
  agentId: string;
  domain: 'personal' | 'work';
  orgId?: string | null;
  source: string;
}

export function chatExecutionStorageKey(owner: ChatRecoveryOwner): string {
  if (!owner.userId.trim()) return '';
  return `lumi_active_chat_execution:v3:${JSON.stringify([
    owner.userId, owner.agentId, owner.domain, owner.domain === 'work' ? owner.orgId || '' : '', owner.source,
  ])}`;
}

/** Unowned legacy entries cannot be safely assigned to the next signed-in user. */
export function ownedPendingChatExecutions(value: unknown, owner: ChatRecoveryOwner) {
  if (!owner.userId.trim()) return [];
  return normalizePersistedPendingChatExecutions(value).filter(execution => (
    execution.userId === owner.userId
    && execution.domain === owner.domain
    && (execution.orgId || '') === (owner.domain === 'work' ? owner.orgId || '' : '')
    && execution.source === owner.source
  ));
}
