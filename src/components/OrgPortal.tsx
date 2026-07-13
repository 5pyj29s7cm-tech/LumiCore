// Organization portal inside the unified Lumi client.
// Users can join or create an organization, then switch between personal and work domains.
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Briefcase, Building2, Plus, Users, ArrowRight, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { JoinOrgPage } from './org/JoinOrgPage';
import { OrgHub } from './org/OrgHub';
import { useApp } from '../contexts/AppContext';
import { useT } from '../lib/useT';
import { apiFetch } from '../services/apiClient';
import { uiMessage } from '../i18n/uiMessages';

interface OrgStatus {
  connected: boolean;
  orgId: string | null;
  orgRole: string | null;
  orgName?: string;
  sessionConnected?: boolean;
}

type OrgPortalMode = 'select' | 'join' | 'create';

export function OrgPortal({
  onBack,
  initialMode = 'select',
}: {
  onBack?: () => void;
  initialMode?: OrgPortalMode;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const { user, refreshUser, orgConnection, workDomain, switchDomain } = useApp();
  const [status, setStatus] = useState<OrgStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [switchingWork, setSwitchingWork] = useState(false);
  const [switchMsg, setSwitchMsg] = useState('');
  const [mode, setMode] = useState<OrgPortalMode>(initialMode);
  const [orgForm, setOrgForm] = useState({ name: '', slug: '' });
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<'idle' | 'success' | 'error'>('idle');
  const [createMsg, setCreateMsg] = useState('');
  const hasServerStatus = status !== null;
  const isConnected = Boolean(status?.connected || (!hasServerStatus && orgConnection?.orgId));
  const hasActiveOrgSession = Boolean(status?.sessionConnected || (!hasServerStatus && orgConnection?.orgId && workDomain === 'work'));

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let cancelled = false;
    const discoverExistingOrg = async (): Promise<boolean> => {
      try {
        const orgsRes = await apiFetch('/api/auth/orgs');
        if (!orgsRes.ok) return false;
        const data = await orgsRes.json().catch(() => ({}));
        const orgs = Array.isArray(data?.orgs) ? data.orgs : (Array.isArray(data) ? data : []);
        const org = orgs[0];
        const orgId = org?.id || org?.orgId;
        if (!orgId) return false;

        const orgRole = org?.role || org?.orgRole || (org?.ownerUid === (user as any)?.uid ? 'owner' : 'member');
        const orgName = org?.name || org?.orgName || '';
        localStorage.setItem('lumi_org_connection', JSON.stringify({
          orgId,
          orgRole,
          orgName,
          connected: true,
        }));
        if (!cancelled) {
          setStatus({ connected: true, orgId, orgRole, orgName, sessionConnected: false });
        }
        return true;
      } catch {
        return false;
      }
    };
    const checkStatus = async (retries = 2) => {
      for (let i = 0; i <= retries; i++) {
        try {
          const s = await apiFetch('/api/org/status').then(r => r.json());
          if (!cancelled) {
            if (s.orgId) {
              setStatus({
                connected: true,
                orgId: s.orgId,
                orgRole: s.orgRole,
                orgName: orgConnection?.orgName || '',
                sessionConnected: true,
              });
              setLoading(false);
              return;
            }

            const discovered = await discoverExistingOrg();
            if (!discovered) {
              setStatus({ connected: false, orgId: null, orgRole: null, sessionConnected: false });
              localStorage.removeItem('lumi_org_connection');
              if (localStorage.getItem('lumi_work_domain') === 'work') {
                localStorage.setItem('lumi_work_domain', 'personal');
              }
            }
            setLoading(false);
            return;
          }
        } catch {}
        if (i < retries) await new Promise(r => setTimeout(r, 800));
      }
      if (!cancelled) setLoading(false);
    };
    checkStatus();
    return () => { cancelled = true; };
  }, [user]);

  const handleCreateOrg = async () => {
    if (!orgForm.name.trim() || !orgForm.slug.trim()) return;
    setCreating(true);
    setCreateResult('idle');
    try {
      const res = await apiFetch('/api/org/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgForm.name.trim(), slug: orgForm.slug.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.token) localStorage.setItem('lumi_auth_token', data.token);
        const createdConnection = {
          orgId: data.id,
          orgRole: data.orgRole || 'owner',
          orgName: data.name || orgForm.name.trim(),
          connected: true,
        };
        localStorage.setItem('lumi_org_connection', JSON.stringify(createdConnection));
        setCreateResult('success');
        setCreateMsg(uiMessage('org-portal.organization-created-opening-the-work.4cd95ce1ee'));
        try { await refreshUser(); } catch {}
        const switched = await switchDomain('work');
        setStatus({
          connected: true,
          orgId: switched.connection?.orgId || createdConnection.orgId,
          orgRole: switched.connection?.orgRole || createdConnection.orgRole,
          orgName: switched.connection?.orgName || createdConnection.orgName,
          sessionConnected: switched.success,
        });
        if (!switched.success) {
          setSwitchMsg(switched.message || uiMessage('org-portal.organization-created-retry-entering-the.b0f5625489'));
        }
      } else {
        setCreateResult('error');
        setCreateMsg(data.error || uiMessage('org-portal.failed-to-create-organization.0ae7b0d044'));
      }
    } catch (err: any) {
      setCreateResult('error');
      setCreateMsg(err.message || uiMessage('org-portal.connection-failed.96c47f8e92'));
    } finally {
      setCreating(false);
    }
  };

  if (!user) {
    return (
      <div className="lumi-work-surface flex items-center justify-center p-20">
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center">
          <Building2 size={48} className="mx-auto text-white/45 mb-4" />
          <p className="text-white/40 text-sm">{t.loginRequired || 'Sign in to access org features'}</p>
        </motion.div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="lumi-work-surface flex items-center justify-center p-20">
        <Loader2 size={32} className="animate-spin text-white/55" />
      </div>
    );
  }

  // Already connected to an org — show full org workbench inline
  if (isConnected && (workDomain !== 'work' || !hasActiveOrgSession)) {
    return (
      <div className="lumi-work-surface flex items-center justify-center p-8 h-full">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-md w-full bg-white/5 border border-white/10 rounded-2xl p-6 text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto">
            <Briefcase size={26} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{t.orgWorkSpace || 'Organization Workspace'}</h2>
            <p className="text-white/45 text-sm mt-2">
              {uiMessage('org-portal.you-have-joined-an-organization.ea1042968a')}
            </p>
          </div>
          {switchMsg && <p className="text-red-400 text-sm">{switchMsg}</p>}
          <button
            onClick={async () => {
              setSwitchMsg('');
              setSwitchingWork(true);
              const result = await switchDomain('work');
              if (result.success) {
                setStatus({
                  connected: true,
                  orgId: result.connection?.orgId || orgConnection?.orgId || null,
                  orgRole: result.connection?.orgRole || orgConnection?.orgRole || null,
                  orgName: result.connection?.orgName || orgConnection?.orgName || '',
                  sessionConnected: true,
                });
              } else {
                setSwitchMsg(result.message || uiMessage('org-portal.failed-to-switch-to-work.2aa0470780'));
              }
              setSwitchingWork(false);
            }}
            disabled={switchingWork}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl font-medium transition-colors"
          >
            {switchingWork ? <Loader2 size={18} className="animate-spin" /> : <Briefcase size={18} />}
            {switchingWork ? uiMessage('org-portal.switching.c197a0b742') : uiMessage('org-portal.switch-to-work-domain.ac0a56b956')}
          </button>
          {onBack && (
            <button onClick={onBack} className="text-white/50 text-sm hover:text-white/70">
              {t.back || 'Back'}
            </button>
          )}
        </motion.div>
      </div>
    );
  }

  if (isConnected) {
    return <OrgHub />;
  }

  // Not connected — choose join or create
  return (
    <div className="lumi-work-surface p-8">
      <AnimatePresence mode="wait">
        {mode === 'select' && (
          <motion.div key="select" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="max-w-lg mx-auto space-y-6">
            <div className="text-center mb-8">
              <Building2 size={48} className="mx-auto text-blue-400 mb-4" />
              <h1 className="text-2xl font-bold text-white mb-2">{t.orgHub || 'Org Hub'}</h1>
              <p className="text-white/40 text-sm max-w-sm mx-auto">
                {t.orgHubDesc || 'Join your company\'s organization or create your own.'}
              </p>
            </div>

            <div className="grid gap-4">
              {/* Join existing org */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('join')}
                className="flex items-center gap-4 p-5 bg-white/5 border border-white/10 rounded-2xl hover:border-blue-500/30 transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <Users size={24} className="text-blue-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-semibold">{t.joinOrganization || 'Join Organization'}</h3>
                  <p className="text-white/40 text-sm">{t.joinOrganizationDesc || 'Enter an invitation code from your admin'}</p>
                </div>
                <ArrowRight size={20} className="text-white/45" />
              </motion.button>

              {/* Create new org */}
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setMode('create')}
                className="flex items-center gap-4 p-5 bg-white/5 border border-white/10 rounded-2xl hover:border-purple-500/30 transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Plus size={24} className="text-purple-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-semibold">{t.createOrganization || 'Create Organization'}</h3>
                  <p className="text-white/40 text-sm">{t.createOrganizationDesc || 'Create a shared workspace and become its owner.'}</p>
                </div>
                <ArrowRight size={20} className="text-white/45" />
              </motion.button>
            </div>

            {onBack && (
              <button onClick={onBack} className="w-full text-center text-white/55 text-sm hover:text-white/50 py-2">
                ← {t.back || uiMessage('org-portal.back.5db5cac55e')}
              </button>
            )}
          </motion.div>
        )}

        {mode === 'join' && (
          <motion.div key="join" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <JoinOrgPage />
            <div className="text-center mt-4">
              <button onClick={() => setMode('select')} className="text-white/55 text-sm hover:text-white/50">
                ← {t.back || 'Back'}
              </button>
            </div>
          </motion.div>
        )}

        {mode === 'create' && (
          <motion.div key="create" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="max-w-md mx-auto">
            {createResult === 'success' ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-12">
                <CheckCircle size={48} className="mx-auto text-green-400 mb-4" />
                <p className="text-white font-semibold">{t.orgCreated || 'Organization Created'}</p>
                <p className="text-white/40 text-sm mt-2">{createMsg}</p>
              </motion.div>
            ) : (
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                <h2 className="text-xl font-bold text-white">{t.createOrganization || 'Create Organization'}</h2>
                <p className="text-white/40 text-sm">
                  {t.createOrganizationNote || 'The workspace, roles, knowledge, and team tools stay inside this Lumi client.'}
                </p>

                <div>
                  <label className="text-white/60 text-sm block mb-1">{t.orgName || 'Organization Name'}</label>
                  <input
                    type="text"
                    value={orgForm.name}
                    onChange={e => setOrgForm(p => ({ ...p, name: e.target.value }))}
                    placeholder={t.orgNamePlaceholder || 'e.g. Acme Studio'}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-purple-500/50"
                  />
                </div>
                <div>
                  <label className="text-white/60 text-sm block mb-1">{t.orgSlug || 'Short ID'}</label>
                  <input
                    type="text"
                    value={orgForm.slug}
                    onChange={e => setOrgForm(p => ({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                    placeholder="acme-studio"
                    maxLength={30}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder:text-white/45 focus:outline-none focus:border-purple-500/50 font-mono"
                  />
                </div>

                {createResult === 'error' && (
                  <p className="text-red-400 text-sm flex items-center gap-1">
                    <AlertCircle size={14} /> {createMsg}
                  </p>
                )}

                <button
                  onClick={handleCreateOrg}
                  disabled={creating || !orgForm.name.trim() || !orgForm.slug.trim()}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-colors"
                >
                  {creating ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  {t.createOrganization || 'Create Organization'}
                </button>

                <p className="text-white/45 text-xs text-center">
                  {t.createOrganizationHint || 'After creation, Lumi enters the organization work domain in this client.'}
                </p>
              </div>
            )}
            <div className="text-center mt-4">
              <button onClick={() => { setMode('select'); setCreateResult('idle'); }} className="text-white/55 text-sm hover:text-white/50">
                ← {t.back || 'Back'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
