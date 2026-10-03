import { FeedbackBanner } from './FeedbackBanner';
import { useCallback, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Crown,
  Loader2,
  Shield,
  User,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { useAppConfirm } from '../../lib/appConfirm';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

import { useApiCollection } from '../../hooks/useApiCollection';
import type { OrgMembership } from '../../../server/org/db';

type Member = Pick<OrgMembership, 'id' | 'orgId' | 'userId' | 'role' | 'status' | 'joinedAt'>;
const isOrganization = (value: any): value is { id: string } => Boolean(value && typeof value.id === 'string' && value.id);

export function OrgMembers() {
  const { user, workDomain, orgConnection } = useApp();
  const scope = JSON.stringify([user?.uid, user?.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole]);
  return !user ? null : orgConnection?.orgId
    ? <MemberList key={scope} orgId={orgConnection.orgId} />
    : <DiscoverMembers key={scope} />;
}

function DiscoverMembers() {
  const { items, busy, error, sync } = useApiCollection('/api/org/org', isOrganization);
  return items?.[0] ? <MemberList key={items[0].id} orgId={items[0].id} /> : (
    <div className="p-6 space-y-3">
      {busy ? <Loader2 className="animate-spin" /> : <>
        <FeedbackBanner feedback={{ type: 'error', text: error || uiMessage('org-members.no-organization-found.90a2ad4211') }} />
        <button onClick={() => sync()}>{uiMessage('knowledge-base.retry.9db2a8180b')}</button>
      </>}
    </div>
  );
}

function MemberList({ orgId }: { orgId: string }) {
  const appConfirm = useAppConfirm(orgId);
  const t = useT();
  const isMember = useCallback((value: any): value is Member => Boolean(value && value.orgId === orgId
    && ['id', 'userId', 'role', 'status'].every(field => typeof value[field] === 'string' && value[field])
    && (value.joinedAt == null || typeof value.joinedAt === 'string')), [orgId]);
  const { items, busy, error, sync } = useApiCollection('/api/org/org/' + encodeURIComponent(orgId) + '/members', isMember, undefined, 'userId');
  const members = items ?? [];
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [success, setSuccess] = useState('');
  const confirming = useRef(false);
  const handleInvite = async () => {
    if (!inviteUserId.trim() || !items || busy) return;
    setSuccess('');
    if (await sync('POST', '', { userId: inviteUserId.trim(), role: inviteRole })) {
      setInviteUserId('');
      setSuccess(uiMessage('org-members.member-added-to-the-organization.ccd3f9eeaa'));
    }
  };
  const handleRemove = async (userId: string) => {
    if (busy || confirming.current) return;
    confirming.current = true;
    try {
      if (await appConfirm({
        title: uiMessage('org-members.remove-member.5f05c07737'),
        message: uiMessage('org-members.remove-this-member-from-the.b3b187baff'),
        confirmText: uiMessage('org-members.remove.78190c6054'),
        cancelText: uiMessage('org-members.cancel.998b9c48fb'),
        tone: 'danger',
      })) {
        setSuccess('');
        if (await sync('DELETE', userId)) setSuccess(uiMessage('org-members.member-removed.a9f8d73d52'));
      }
    } finally { confirming.current = false; }
  };
  const activeCount = members.filter(member => member.status === 'active').length;
  const roles = {
    owner: { label: t.orgRoleOwner, style: 'border-amber-400/20 bg-amber-500/10 text-amber-200', Icon: Crown },
    admin: { label: t.orgRoleAdmin, style: 'border-red-400/20 bg-red-500/10 text-red-200', Icon: Shield },
    member: { label: t.orgRoleMember, style: 'border-blue-400/20 bg-blue-500/10 text-blue-200', Icon: User },
    viewer: { label: t.orgRoleViewer, style: 'border-white/10 bg-white/5 text-white/55', Icon: User },
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
                <Users size={22} />
              </span>
              <div>
                <h2 className="text-xl font-semibold text-white">{t.orgMembers || uiMessage('org-members.organization-members.b6aff59b6a')}</h2>
                <p className="mt-1 text-sm text-white/50">
                  {formatUiMessage('org-members.value0-active-value1-total.b0f70dba9b', { value0: activeCount, value1: members.length })}
                </p>
              </div>
            </div>
            <button
              onClick={() => { setSuccess(''); void sync(); }}
              disabled={busy}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 disabled:opacity-50"
            >
              {uiMessage('org-members.refresh.cba212b169')}
            </button>
          </div>
        </section>

        {(error || success) && <FeedbackBanner feedback={{ type: error ? 'error' : 'success', text: error || success }} />}

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <fieldset disabled={busy || !items} className="grid min-w-0 gap-3 md:grid-cols-[1fr_160px_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">{uiMessage('org-members.add-member-by-user-id.4aa55086eb')}</span>
              <input
                value={inviteUserId}
                onChange={event => setInviteUserId(event.target.value)}
                placeholder={uiMessage('org-members.enter-user-id.2b54a142a9')}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-emerald-400/35"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">{uiMessage('org-members.role.b9e0249a04')}</span>
              <select
                value={inviteRole}
                onChange={event => setInviteRole(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/75 outline-none"
              >
                {(['member', 'admin', 'viewer'] as const).map(role => <option key={role} value={role}>{roles[role].label}</option>)}
              </select>
            </label>
            <button
              onClick={handleInvite}
              disabled={!inviteUserId.trim()}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
              {uiMessage('org-members.add.cd6f2f52ff')}
            </button>
          </fieldset>
        </section>

        <section className="min-h-[260px] rounded-lg border border-white/10 bg-white/[0.04]">
          {busy && !items ? (
            <div className="flex h-64 items-center justify-center text-white/55">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : !items ? null : members.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-white/45">
              <Users size={32} className="text-white/20" />
              <span>{uiMessage('org-members.no-members-yet-add-members.e1e3de9dd0')}</span>
            </div>
          ) : (
            <div className="divide-y divide-white/8">
              {members.map(member => {
                const meta = roles[member.role] || { ...roles.member, label: member.role };
                return (
                  <motion.div
                    key={member.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 transition hover:bg-white/[0.04]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60">
                        <User size={17} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{member.userId}</p>
                        <p className="mt-1 text-xs text-white/45">
                          {member.joinedAt
                            ? formatUiMessage('org-members.joined-value0.b3ec28ea5a', { value0: { en: new Date(member.joinedAt).toLocaleDateString(), zh: new Date(member.joinedAt).toLocaleDateString('zh-CN') } })
                            : uiMessage('org-members.pending.c88e40b7d2')}
                          {member.status !== 'active' && <span className="ml-2 text-amber-300">{member.status}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${meta.style}`}>
                        <meta.Icon size={11} />
                        {meta.label}
                      </span>
                      {member.role !== 'owner' && (
                        <button
                          onClick={() => handleRemove(member.userId)}
                          disabled={busy}
                          className="rounded-lg border border-red-400/15 bg-red-500/5 p-2 text-red-200/70 transition hover:bg-red-500/15 hover:text-red-200"
                          title={uiMessage('org-members.remove-member.9443c64435')}
                        >
                          <UserMinus size={14} />
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
