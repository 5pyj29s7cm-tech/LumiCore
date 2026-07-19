export type ChatConversationDomain = 'personal' | 'work';

export function buildChatConversationScopeKey(
  agentId: string,
  domain: ChatConversationDomain,
  orgId?: string | null,
): string {
  const scopedOrgId = domain === 'work' ? String(orgId || '').trim() : '';
  return `${agentId}:${domain}:${scopedOrgId}`;
}
