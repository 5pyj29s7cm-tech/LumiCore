import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  Building2,
  CheckCircle,
  Copy,
  KeyRound,
  Link,
  Loader2,
  Save,
  Settings,
  Trash2,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { appConfirm } from '../../lib/appConfirm';
import { formatUiMessage, uiMessage } from '../../i18n/uiMessages';

type Feedback = { type: 'success' | 'error'; text: string };

export function OrgSettings() {
  const t = useT();
  const { orgConnection, switchDomain } = useApp();
  const [org, setOrg] = useState<any>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [invitationCode, setInvitationCode] = useState('');
  const [invitationRole, setInvitationRole] = useState('member');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const loadOrg = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      let orgId = orgConnection?.orgId || '';
      if (!orgId) {
        const orgsRes = await fetch('/api/org/org', { credentials: 'include' });
        const orgs = await orgsRes.json().catch(() => []);
        if (!orgsRes.ok) throw new Error((orgs as any).error || formatUiMessage('org-settings.failed-to-load-organizations-value0.0c01e9694d', { value0: orgsRes.status }));
        if (!Array.isArray(orgs) || orgs.length === 0) throw new Error(uiMessage('org-settings.no-organization-found.90a2ad4211'));
        orgId = orgs[0].id || orgs[0].orgId;
      }

      const orgDetailRes = await fetch(`/api/org/org/${orgId}`, { credentials: 'include' });
      const orgData = await orgDetailRes.json().catch(() => ({}));
      if (!orgDetailRes.ok) throw new Error(orgData.error || formatUiMessage('org-settings.failed-to-load-organization-value0.29c105c15a', { value0: orgDetailRes.status }));
      setOrg(orgData);
      setName(orgData.name || '');
    } catch (err: any) {
      setOrg(null);
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setLoading(false);
    }
  }, [orgConnection?.orgId]);

  useEffect(() => {
    void loadOrg();
  }, [loadOrg]);

  const handleSave = async () => {
    if (!org || !name.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('org-settings.save-failed-value0.5559bb34d3', { value0: res.status }));
      setOrg(data);
      setName(data.name || name.trim());
      setFeedback({ type: 'success', text: t.orgSettingsSaved || uiMessage('org-settings.organization-settings-saved.ba1832e337') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateInvitation = async () => {
    if (!org) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: invitationRole, maxUses: 0 }),
        credentials: 'include',
      });
      const inv = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(inv.error || formatUiMessage('org-settings.invitation-creation-failed-value0.dd3265d5f7', { value0: res.status }));
      setInvitationCode(inv.code || '');
      setFeedback({ type: 'success', text: t.invitationCreated || uiMessage('org-settings.invitation-code-created.b835c22578') });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = async () => {
    if (!invitationCode) return;
    await navigator.clipboard.writeText(invitationCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDelete = async () => {
    if (!org) return;
    const ok = await appConfirm({
      title: uiMessage('org-settings.delete-organization.4de5283414'),
      message: uiMessage('org-settings.this-cannot-be-undone-organization.1d1562fe80'),
      confirmText: uiMessage('org-settings.delete.5b875326d1'),
      cancelText: uiMessage('org-settings.cancel.998b9c48fb'),
      tone: 'danger',
    });
    if (!ok) return;

    setFeedback(null);
    try {
      const res = await fetch(`/api/org/org/${org.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('org-settings.delete-failed-value0.98201beb15', { value0: res.status }));
      setFeedback({ type: 'success', text: t.organizationDeleted || uiMessage('org-settings.organization-deleted.7ecab76b97') });
      setOrg(null);
      void switchDomain('personal').finally(() => {
        window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }));
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message || String(err) });
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-white/55">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-white/55">
        {feedback && <FeedbackBanner feedback={feedback} />}
        <Building2 size={34} className="text-white/25" />
        <div>{uiMessage('org-settings.no-organization-found-create-one.f354c5cd6b')}</div>
        <button onClick={loadOrg} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 hover:bg-white/10">
          {uiMessage('org-settings.reload.27d9a83a34')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/65">
              <Settings size={21} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.orgSettings || uiMessage('org-settings.organization-settings.bae66fc14f')}</h2>
              <p className="mt-1 text-sm text-white/50">
                {uiMessage('org-settings.manage-organization-profile-invitation-flow.2cdc91f614')}
              </p>
            </div>
          </div>
        </section>

        {feedback && <FeedbackBanner feedback={feedback} />}

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Building2 size={17} className="text-blue-300" />
            <h3 className="text-sm font-medium text-white">{uiMessage('org-settings.general.0292983753')}</h3>
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs text-white/50">{uiMessage('org-settings.organization-name.9e0fe3a749')}</span>
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-blue-400/40"
              />
            </label>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/15 px-4 py-2 text-sm font-medium text-blue-100 transition hover:bg-blue-500/25 disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {uiMessage('org-settings.save-changes.9a5659da70')}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/45">
            <span className="rounded-md bg-white/5 px-2 py-1">Slug: {org.slug}</span>
            <span className="rounded-md bg-white/5 px-2 py-1">ID: {org.id}</span>
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound size={17} className="text-emerald-300" />
            <h3 className="text-sm font-medium text-white">{uiMessage('org-settings.invitation-codes.7c3628d9d0')}</h3>
          </div>
          <p className="hidden">
            {uiMessage('org-settings.generate-a-join-code-for.ea01d67103')}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label>
              <span className="mb-1 block text-xs text-white/50">{uiMessage('org-settings.default-role.e66bc2de91')}</span>
              <select
                value={invitationRole}
                onChange={event => setInvitationRole(event.target.value)}
                className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/75 outline-none"
              >
                <option value="member">{t.orgRoleMember || uiMessage('org-settings.member.9b8c32d899')}</option>
                <option value="admin">{t.orgRoleAdmin || uiMessage('org-settings.admin.c54e557ee8')}</option>
                <option value="viewer">{t.orgRoleViewer || uiMessage('org-settings.viewer.8a8ac26d10')}</option>
              </select>
            </label>
            <button
              onClick={handleCreateInvitation}
              disabled={generating}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {generating ? <Loader2 size={15} className="animate-spin" /> : <Link size={15} />}
              {uiMessage('org-settings.generate-code.4e158587b0')}
            </button>
          </div>

          {invitationCode && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-4"
            >
              <div>
                <p className="text-xs text-white/50">{uiMessage('org-settings.invitation-code.3eee31f5dd')}</p>
                <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.18em] text-emerald-200">{invitationCode}</p>
              </div>
              <button
                onClick={copyCode}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 transition hover:bg-white/10"
              >
                {copied ? <CheckCircle size={15} className="text-emerald-300" /> : <Copy size={15} />}
                {copied ? uiMessage('org-settings.copied.b515fa181c') : uiMessage('org-settings.copy.d6e96519c4')}
              </button>
            </motion.div>
          )}
        </section>

        <section className="rounded-lg border border-red-400/15 bg-red-500/5 p-5">
          <div className="mb-3 flex items-center gap-2 text-red-300">
            <Trash2 size={17} />
            <h3 className="text-sm font-medium">{uiMessage('org-settings.danger-zone.c15803c9ea')}</h3>
          </div>
          <p className="mb-4 text-sm leading-6 text-white/50">
            {uiMessage('org-settings.deleting-an-organization-is-irreversible.b55e4a55c4')}
          </p>
          <button
            onClick={handleDelete}
            className="rounded-lg border border-red-400/25 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20"
          >
            {uiMessage('org-settings.delete-organization.4de5283414')}
          </button>
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
