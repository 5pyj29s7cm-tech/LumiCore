import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, Link, RefreshCw, Server, Shield, Unlink, XCircle } from 'lucide-react';
import { useT } from '../lib/useT';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { useApp } from '../contexts/AppContext';
import { useAsyncOperation } from '../hooks/useAsyncOperation';
import { apiJson } from '../services/apiClient';

type BranchStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface BranchState {
  orgId: string | null;
  companyUrl: string | null;
  status: BranchStatus;
  currentDomain: 'personal' | 'work';
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  connected?: boolean;
  tokenConfigured?: boolean;
}

function normalizeState(payload: any): BranchState {
  const raw = payload?.state || payload;
  if (!raw || !['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(raw.status)
    || !['personal', 'work'].includes(raw.currentDomain)
    || ['orgId', 'companyUrl', 'lastSyncAt', 'lastHeartbeatAt'].some(field => raw[field] != null && typeof raw[field] !== 'string')
    || typeof raw.connected !== 'boolean' || typeof raw.tokenConfigured !== 'boolean') throw new Error('Invalid branch connection receipt');
  return raw;
}

function statusLabel(status: BranchStatus, isZh: boolean) {
  switch (status) {
    case 'connected': return uiMessage('org-branch-panel.connected.77956f6a16', (isZh) ? 'zh' : 'en');
    case 'connecting': return uiMessage('org-branch-panel.connecting.6b02d567d9', (isZh) ? 'zh' : 'en');
    case 'reconnecting': return uiMessage('org-branch-panel.reconnecting.be8512ed6f', (isZh) ? 'zh' : 'en');
    case 'error': return uiMessage('org-branch-panel.connection-error.bf0da63329', (isZh) ? 'zh' : 'en');
    default: return uiMessage('org-branch-panel.disconnected.0065488a05', (isZh) ? 'zh' : 'en');
  }
}

function formatTime(value: string | null, isZh: boolean) {
  return value ? new Date(value).toLocaleString(isZh ? 'zh-CN' : undefined) : (uiMessage('org-branch-panel.none.de9f0e5fd2', (isZh) ? 'zh' : 'en'));
}

export function OrgBranchPanel() {
  const { user, workDomain, orgConnection } = useApp();
  return user ? <BranchConnection key={JSON.stringify([user.uid, user.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole])} /> : null;
}

function BranchConnection() {
  const t = useT(), isZh = t.langCode !== 'en';
  const [state, setState] = useState<BranchState | null>(null);
  const [form, setForm] = useState({ orgId: '', companyUrl: '', token: '' });
  const [feedback, setFeedback] = useState({ message: '', error: '' });
  const { busy, error: requestError, run } = useAsyncOperation();
  const error = requestError || feedback.error, message = feedback.message;
  const connected = state?.connected === true, connecting = busy === 'connect', syncing = busy === 'sync';
  const loadState = useCallback(() => run('load', async signal => {
    const data = normalizeState(await apiJson('/api/branch/state', { signal }));
    return () => { setState(data); setForm(previous => ({ ...previous, orgId: previous.orgId || data.orgId || '', companyUrl: previous.companyUrl || data.companyUrl || '' })); };
  }), [run]);
  useEffect(() => { void loadState(); }, [loadState]);
  const act = (action: 'connect' | 'disconnect' | 'sync') => {
    setFeedback({ message: '', error: '' });
    if (action === 'connect' && (!form.orgId.trim() || !form.companyUrl.trim() || !form.token.trim())) {
      setFeedback({ message: '', error: uiMessage('org-branch-panel.enter-organization-id-company-server.e7d51f4eef') }); return;
    }
    return run(action, async signal => {
      const data = await apiJson('/api/branch/' + action, { method: 'POST', signal, ...(action === 'connect' ? {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: form.orgId.trim(), companyUrl: form.companyUrl.trim(), token: form.token.trim() }),
      } : {}) });
      const next = normalizeState(data);
      if (action !== 'sync' && data.success !== true) throw new Error('Branch operation was not confirmed');
      if (action === 'connect' && (!next.connected || next.orgId !== form.orgId.trim() || next.companyUrl?.replace(/\/+$/, '') !== form.companyUrl.trim().replace(/\/+$/, ''))) throw new Error('Branch connection identity changed');
      if (action === 'disconnect' && (next.connected || next.orgId !== null || next.status !== 'disconnected')) throw new Error('Branch disconnection was not confirmed');
      if (action === 'sync' && (!Array.isArray(data.errors) || data.errors.some((item: unknown) => typeof item !== 'string') || !Number.isFinite(data.synced) || next.orgId !== state?.orgId)) throw new Error('Branch synchronization was not confirmed');
      return () => {
        setState(next);
        if (action === 'connect') setForm(previous => ({ ...previous, token: '' }));
        setFeedback({ error: action === 'sync' ? data.errors.join('; ') : '', message: action === 'sync'
          ? (data.errors.length ? '' : formatUiMessage('org-branch-panel.sync-complete-value0-work-domain.ed45bed8ac', { value0: data.synced }, isZh ? 'zh' : 'en'))
          : uiMessage(action === 'connect' ? 'org-branch-panel.branch-terminal-connected-to-the.32318a415e' : 'org-branch-panel.organization-branch-disconnected.eef77df121') });
      };
    }, 60_000);
  };

  if (busy === 'load' || (!state && !error)) return <div className="p-6 text-white/40">Loading...</div>;
  if (!state) return <div className="p-6"><p role="alert">{error}</p><button onClick={() => void loadState()}>{uiMessage('knowledge-base.retry.9db2a8180b')}</button></div>;

  return (
    <fieldset disabled={Boolean(busy)} className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <GitBranch size={20} className="text-purple-400" />
          {uiMessage('org-branch-panel.branch-connection.9cecc72547')}
        </h2>
        <span className={`text-xs px-3 py-1 rounded-full border ${
          connected
            ? 'text-green-400 bg-green-500/10 border-green-500/20'
            : state.status === 'error'
              ? 'text-red-400 bg-red-500/10 border-red-500/20'
              : 'text-white/45 bg-white/5 border-white/10'
        }`}>
          {statusLabel(state.status, isZh)}
        </span>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <CheckCircle2 size={16} className="text-green-400" />
              <span className="text-white text-sm">
                {uiMessage('org-branch-panel.connected-to.4bca7a47d6')} <span className="text-purple-400">{state.orgId}</span>
              </span>
            </>
          ) : (
            <>
              <XCircle size={16} className="text-white/30" />
              <span className="text-white/45 text-sm">{uiMessage('org-branch-panel.not-connected-to-the-company.73b8a37c2f')}</span>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-white/45">
          <div className="bg-black/20 rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-white/60 mb-1"><Server size={12} /> {uiMessage('org-branch-panel.company-server-url.c4bb26ddbb')}</div>
            <div className="font-mono truncate">{state.companyUrl || uiMessage('org-branch-panel.not-configured.8b6c7ecc15')}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-white/60 mb-1"><Shield size={12} /> {uiMessage('org-branch-panel.current-domain.d0e0b49f21')}</div>
            <div>{state.currentDomain === 'work' ? uiMessage('org-branch-panel.work.ff841818be') : uiMessage('org-branch-panel.personal.995ae22dba')}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="text-white/60 mb-1">{uiMessage('org-branch-panel.last-heartbeat.b6be053fea')}</div>
            <div>{formatTime(state.lastHeartbeatAt, isZh)}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="text-white/60 mb-1">{uiMessage('org-branch-panel.last-sync.b767479cd4')}</div>
            <div>{formatTime(state.lastSyncAt, isZh)}</div>
          </div>
        </div>

        {message && <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{message}</div>}
        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}

        {connected ? (
          <div className="flex gap-2 pt-1">
            <button onClick={() => void act('sync')} disabled={syncing} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? uiMessage('org-branch-panel.syncing.379d137ae4') : uiMessage('org-branch-panel.sync-work-data.a3fed024c8')}
            </button>
            <button onClick={() => void act('disconnect')} className="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg text-sm flex items-center gap-1">
              <Unlink size={14} /> {uiMessage('org-branch-panel.disconnect.4fdb1669e6')}
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                value={form.companyUrl}
                onChange={e => setForm(prev => ({ ...prev, companyUrl: e.target.value }))}
                placeholder={uiMessage('org-branch-panel.company-server-url-e-g.0a783e6a54')}
                className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
              />
              <input
                value={form.orgId}
                onChange={e => setForm(prev => ({ ...prev, orgId: e.target.value }))}
                placeholder={uiMessage('org-branch-panel.organization-id.625ab90327')}
                className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
              />
            </div>
            <input
              type="password"
              value={form.token}
              onChange={e => setForm(prev => ({ ...prev, token: e.target.value }))}
              placeholder={uiMessage('org-branch-panel.connection-token-company-server-login.47c4a41442')}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-white/35">
                {uiMessage('org-branch-panel.branch-connection-syncs-only-work.9bd97339a4')}
              </p>
              <button onClick={() => void act('connect')} disabled={connecting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1 whitespace-nowrap">
                <Link size={14} /> {connecting ? uiMessage('org-branch-panel.connecting.3fb50c43cd') : uiMessage('org-branch-panel.connect.b3b35de2b3')}
              </button>
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
}
