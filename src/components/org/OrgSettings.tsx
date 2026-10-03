import { FeedbackBanner } from './FeedbackBanner';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
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
import { useAppConfirm } from '../../lib/appConfirm';
import { apiJson } from '../../services/apiClient';
import { useAsyncOperation } from '../../hooks/useAsyncOperation';
import { uiMessage } from '../../i18n/uiMessages';

function readOrg(value: any, id: string) {
  if (value?.id !== id || typeof value.name !== 'string' || typeof value.slug !== 'string') throw new Error('Organization receipt was not confirmed');
  return value;
}

export function OrgSettings() {
  const { user, workDomain, orgConnection } = useApp();
  return user ? <OrganizationForm key={JSON.stringify([user.uid, user.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole])} initialOrgId={orgConnection?.orgId || ''} /> : null;
}

function OrganizationForm({ initialOrgId }: { initialOrgId: string }) {
  const t = useT(), { switchDomain } = useApp(), appConfirm = useAppConfirm();
  const [org, setOrg] = useState<any>();
  const [name, setName] = useState(''), [invitationCode, setInvitationCode] = useState('');
  const [invitationRole, setInvitationRole] = useState('member'), [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const resolvedOrgId = useRef(initialOrgId);
  const { busy, error, run } = useAsyncOperation();
  const loading = busy === 'load' || (org === undefined && !error), saving = busy === 'save', generating = busy === 'invite';
  const feedback = error ? { type: 'error' as const, text: error } : message ? { type: 'success' as const, text: message } : null;
  const loadOrg = useCallback(() => run('load', async signal => {
    let orgId = resolvedOrgId.current;
    if (!orgId) {
      const organizations = await apiJson('/api/org/org', { signal });
      if (!Array.isArray(organizations) || typeof organizations[0]?.id !== 'string' || !organizations[0].id) throw new Error(uiMessage('org-settings.no-organization-found.90a2ad4211'));
      orgId = organizations[0].id;
    }
    const data = readOrg(await apiJson('/api/org/org/' + encodeURIComponent(orgId), { signal }), orgId);
    return () => { resolvedOrgId.current = orgId; setOrg(data); setName(data.name); setMessage(''); };
  }), [run]);
  useEffect(() => { void loadOrg(); }, [loadOrg]);
  const handleSave = () => {
    if (!org || !name.trim()) return;
    setMessage('');
    return run('save', async signal => {
      const data = readOrg(await apiJson('/api/org/org/' + encodeURIComponent(org.id), { method: 'PUT', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }), org.id);
      return () => { setOrg(data); setName(data.name); setMessage(t.orgSettingsSaved || uiMessage('org-settings.organization-settings-saved.ba1832e337')); };
    });
  };
  const handleCreateInvitation = () => {
    if (!org) return;
    setMessage('');
    return run('invite', async signal => {
      const data = await apiJson('/api/org/org/' + encodeURIComponent(org.id) + '/invitations', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: invitationRole, maxUses: 0 }) });
      if (data?.orgId !== org.id || data.role !== invitationRole || typeof data.code !== 'string' || !data.code) throw new Error('Invitation receipt was not confirmed');
      return () => { setInvitationCode(data.code); setCopied(false); setMessage(t.invitationCreated || uiMessage('org-settings.invitation-code-created.b835c22578')); };
    });
  };
  const copyCode = () => invitationCode && run('copy', async () => {
    await navigator.clipboard.writeText(invitationCode); return () => setCopied(true);
  });
  const handleDelete = async () => {
    if (!org || busy || !await appConfirm({
      title: uiMessage('org-settings.delete-organization.4de5283414'),
      message: uiMessage('org-settings.this-cannot-be-undone-organization.1d1562fe80'),
      confirmText: uiMessage('org-settings.delete.5b875326d1'), cancelText: uiMessage('org-settings.cancel.998b9c48fb'), tone: 'danger',
    })) return;
    setMessage('');
    return run('delete', async signal => {
      const data = await apiJson('/api/org/org/' + encodeURIComponent(org.id), { method: 'DELETE', signal });
      signal.throwIfAborted();
      if (data?.success !== true) throw new Error('Organization deletion was not confirmed');
      setOrg(null); setMessage(t.organizationDeleted || uiMessage('org-settings.organization-deleted.7ecab76b97'));
      const result = await switchDomain('personal', { signal });
      if (!result.success) throw new Error(result.message || 'Personal workspace could not be opened');
      return () => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'home' } }));
    });
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
      <fieldset disabled={Boolean(busy)} className="mx-auto flex max-w-4xl flex-col gap-4">
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
                onClick={() => void copyCode()}
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
      </fieldset>
    </div>
  );
}
