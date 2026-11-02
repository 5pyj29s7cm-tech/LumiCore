import { getActiveInteriorProject, listInteriorProjects } from '../../design/projects';
import { captureOrganizationMembershipAuthorization } from '../../org/membership_authorization';
import { getCurrentIndustryCapabilityProfile } from '../../regions/routing/industry_profile';
import { formatDesignProjectWorkflowLedgerStatus } from '../../regions/messages/designer_ledger_messages';
export function formatMultiDesignWorkflowLedgerStatus(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): string | null {
  const query = String(input.query || '').trim();
  const profile = getCurrentIndustryCapabilityProfile();
  // i18n-allow: User query recognition for persisted ledger summaries.
  if (profile?.productLine !== 'design' || !/(?:状态|账本|回执|最近任务|关键结果|交付物|确认边界)/u.test(query)) {
    return null;
  }
  const requestedEntries = profile.entries.filter(entry => query.includes(entry.displayName));
  if (requestedEntries.length < 2) return null;
  const currentConversation = Array.isArray(db.conversations)
    ? db.conversations.find((conversation: any) => conversation.id === input.conversationId)
    : null;
  const expectedOrgId = String(currentConversation?.domain || 'personal') === 'work'
    ? String(currentConversation?.orgId || '')
    : `personal:${input.userId}`;
  if (!currentConversation || currentConversation.userId !== input.userId || !expectedOrgId) return null;
  if (currentConversation.domain === 'work') {
    try { captureOrganizationMembershipAuthorization(expectedOrgId, input.userId); } catch { return null; }
  }
  const project = getActiveInteriorProject(expectedOrgId, input.userId)
    || listInteriorProjects(expectedOrgId).find(candidate => candidate.ownerUserId === input.userId);
  if (!project) return null;

  return formatDesignProjectWorkflowLedgerStatus(project, requestedEntries, profile.displayName);
}
