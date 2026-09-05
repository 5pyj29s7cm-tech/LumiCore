import { getBinding, type MessagingBinding } from './bindings';
import { getMember } from '../org/db';
import type { IncomingMessage } from './types';

export class MessagingAuthorizationRevokedError extends Error {
  constructor() {
    super('The remote message authorization was revoked or replaced.');
    this.name = 'MessagingAuthorizationRevokedError';
  }
}

export function captureMessagingBinding(binding: MessagingBinding): NonNullable<IncomingMessage['bindingAuthorization']> {
  return {
    id: binding.id,
    revision: binding.revision || binding.updatedAt,
    userId: binding.lumiUserId,
    orgId: binding.orgId,
    domain: binding.domain,
  };
}

export function captureMessagingOrganization(message: IncomingMessage): IncomingMessage {
  if (!message.boundOrgId || !message.boundUserId || message.organizationAuthorization) return message;
  return { ...message, organizationAuthorization: {
    orgId: message.boundOrgId,
    userId: message.boundUserId,
    membershipId: getMember(message.boundOrgId, message.boundUserId)?.id || '',
  } };
}

/** Check the accepted identity; never route an old message through a replacement binding. */
export function isMessagingAuthorizationCurrent(message: IncomingMessage): boolean {
  const snapshot = message.bindingAuthorization;
  if (snapshot === null && message.boundUserId) return false;
  if (snapshot) {
    if (!['feishu', 'wechat', 'wecom'].includes(message.platform)) return false;
    const binding = getBinding(message.platform as 'feishu' | 'wechat' | 'wecom', message.userId, message.chatId, message.chatType);
    if (!binding || binding.id !== snapshot.id
      || (binding.revision || binding.updatedAt) !== snapshot.revision
      || binding.lumiUserId !== snapshot.userId || binding.orgId !== snapshot.orgId
      || binding.domain !== snapshot.domain || message.boundUserId !== snapshot.userId) return false;
    if (snapshot.domain === 'work' && message.boundOrgId !== snapshot.orgId) return false;
  }
  // A personal binding can select an organization for this turn. Its membership
  // must also still be active, independently of the original binding domain.
  if (message.boundOrgId) {
    const membership = message.boundUserId ? getMember(message.boundOrgId, message.boundUserId) : null;
    if (membership?.status !== 'active') return false;
    const acceptedMember = message.organizationAuthorization;
    if (acceptedMember && (acceptedMember.orgId !== message.boundOrgId || acceptedMember.userId !== message.boundUserId
      || acceptedMember.membershipId !== membership.id)) return false;
  }
  return true;
}

export function assertMessagingAuthorization(message: IncomingMessage): void {
  if (!isMessagingAuthorizationCurrent(message)) throw new MessagingAuthorizationRevokedError();
}
