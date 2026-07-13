import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle,
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
import { appConfirm } from '../../lib/appConfirm';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

interface Member {
  id: string;
  userId: string;
  role: string;
  status: string;
  departmentId: string | null;
  joinedAt: string | null;
}

type Feedback = { type: 'success' | 'error'; text: string };

export function OrgMembers() {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const { orgConnection } = useApp();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState('');
  const [inviteUserId, setInviteUserId] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const loadOrgAndMembers = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      let orgIdVal = orgConnection?.orgId || '';
      if (!orgIdVal) {
        const orgsRes = await fetch('/api/org/org', { credentials: 'include' });
        const orgs = await orgsRes.json().catch(() => []);
        if (!orgsRes.ok) throw new Error((orgs as any).error || formatUiMessage('org-members.failed-to-load-organizations-value0.0c01e9694d', { value0: orgsRes.status }));
        if (!Array.isArray(orgs) || orgs.length === 0) throw new Error(uiMessage('org-members.no-organization-found.90a2ad4211'));
        orgIdVal = orgs[0].id || orgs[0].orgId;
      }
      setOrgId(orgIdVal);

      const membersRes = await fetch(`/api/org/org/${orgIdVal}/members`, { credentials: 'include' });
      const data = await membersRes.json().catch(() => []);
      if (!membersRes.ok) throw new Error(data.error || formatUiMessage('org-members.failed-to-load-members-value0.b0a921d6d9', { value0: membersRes.status }));
      setMembers(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [orgConnection?.orgId, ui]);

  useEffect(() => {
    void loadOrgAndMembers();
  }, [loadOrgAndMembers]);

  const handleInvite = async () => {
    if (!inviteUserId.trim() || !orgId) return;
    setInviting(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: inviteUserId.trim(), role: inviteRole }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('org-members.invite-failed-value0.12879bcdc7', { value0: res.status }));
      setInviteUserId('');
      setFeedback({ type: 'success', text: uiMessage('org-members.member-added-to-the-organization.ccd3f9eeaa') });
      void loadOrgAndMembers();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (userId: string) => {
    const ok = await appConfirm({
      title: uiMessage('org-members.remove-member.5f05c07737'),
      message: uiMessage('org-members.remove-this-member-from-the.b3b187baff'),
      confirmText: uiMessage('org-members.remove.78190c6054'),
      cancelText: uiMessage('org-members.cancel.998b9c48fb'),
      tone: 'danger',
    });
    if (!ok) return;

    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${orgId}/members/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('org-members.remove-failed-value0.04090c47d2', { value0: res.status }));
      setFeedback({ type: 'success', text: uiMessage('org-members.member-removed.a9f8d73d52') });
      void loadOrgAndMembers();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    }
  };

  const activeCount = useMemo(() => members.filter(member => member.status === 'active').length, [members]);

  const roleMeta = (role: string) => {
    const labels: Record<string, string> = {
      owner: t.orgRoleOwner || uiMessage('org-members.owner.6fa387e604'),
      admin: t.orgRoleAdmin || uiMessage('org-members.admin.c54e557ee8'),
      member: t.orgRoleMember || uiMessage('org-members.member.9b8c32d899'),
      viewer: t.orgRoleViewer || uiMessage('org-members.viewer.8a8ac26d10'),
    };
    const styles: Record<string, string> = {
      owner: 'border-amber-400/20 bg-amber-500/10 text-amber-200',
      admin: 'border-red-400/20 bg-red-500/10 text-red-200',
      member: 'border-blue-400/20 bg-blue-500/10 text-blue-200',
      viewer: 'border-white/10 bg-white/5 text-white/55',
    };
    const icons: Record<string, React.ReactNode> = {
      owner: <Crown size={11} />,
      admin: <Shield size={11} />,
      member: <User size={11} />,
      viewer: <User size={11} />,
    };
    return { label: labels[role] || role, style: styles[role] || styles.member, icon: icons[role] || icons.member };
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
              onClick={loadOrgAndMembers}
              disabled={loading}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 disabled:opacity-50"
            >
              {uiMessage('org-members.refresh.cba212b169')}
            </button>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} />}

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
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
                <option value="member">{t.orgRoleMember || uiMessage('org-members.member.9b8c32d899')}</option>
                <option value="admin">{t.orgRoleAdmin || uiMessage('org-members.admin.c54e557ee8')}</option>
                <option value="viewer">{t.orgRoleViewer || uiMessage('org-members.viewer.8a8ac26d10')}</option>
              </select>
            </label>
            <button
              onClick={handleInvite}
              disabled={inviting || !inviteUserId.trim() || !orgId}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {inviting ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
              {uiMessage('org-members.add.cd6f2f52ff')}
            </button>
          </div>
        </section>

        <section className="min-h-[260px] rounded-lg border border-white/10 bg-white/[0.04]">
          {loading ? (
            <div className="flex h-64 items-center justify-center text-white/55">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : members.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-white/45">
              <Users size={32} className="text-white/20" />
              <span>{uiMessage('org-members.no-members-yet-add-members.e1e3de9dd0')}</span>
            </div>
          ) : (
            <div className="divide-y divide-white/8">
              {members.map(member => {
                const meta = roleMeta(member.role);
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
                        {meta.icon}
                        {meta.label}
                      </span>
                      {member.role !== 'owner' && (
                        <button
                          onClick={() => handleRemove(member.userId)}
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

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
      feedback.type === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
        : 'border-red-500/20 bg-red-500/10 text-red-200'
    }`}>
      {feedback.type === 'success' ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
      <span>{feedback.text}</span>
    </div>
  );
}
