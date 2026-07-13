import { useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, Link, RefreshCw, Server, Shield, Unlink, XCircle } from 'lucide-react';
import { useT } from '../lib/useT';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';

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

const emptyState: BranchState = {
  orgId: null,
  companyUrl: null,
  status: 'disconnected',
  currentDomain: 'personal',
  lastSyncAt: null,
  lastHeartbeatAt: null,
  connected: false,
  tokenConfigured: false,
};

function normalizeState(payload: any): BranchState {
  const raw = payload?.state || payload || {};
  const status = (raw.status || (raw.connected ? 'connected' : 'disconnected')) as BranchStatus;
  return {
    orgId: raw.orgId || null,
    companyUrl: raw.companyUrl || null,
    status,
    currentDomain: raw.currentDomain || 'personal',
    lastSyncAt: raw.lastSyncAt || raw.lastSync || null,
    lastHeartbeatAt: raw.lastHeartbeatAt || null,
    connected: raw.connected ?? status === 'connected',
    tokenConfigured: raw.tokenConfigured ?? false,
  };
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
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [state, setState] = useState<BranchState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(() => ({
    orgId: '',
    companyUrl: 'http://127.0.0.1:3000',
    token: (() => {
      try { return localStorage.getItem('lumi_auth_token') || ''; } catch { return ''; }
    })(),
  }));
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const connected = state.connected || state.status === 'connected';

  const loadState = async () => {
    try {
      const res = await fetch('/api/branch/state', { credentials: 'include' });
      if (!res.ok) throw new Error(`${uiMessage('org-branch-panel.failed-to-read-status.23ccb2e167')} (${res.status})`);
      const next = normalizeState(await res.json());
      setState(next);
      setForm(prev => ({
        ...prev,
        orgId: prev.orgId || next.orgId || '',
        companyUrl: prev.companyUrl || next.companyUrl || 'http://127.0.0.1:3000',
      }));
    } catch (err: any) {
      setError(err.message || uiMessage('org-branch-panel.failed-to-read-status.23ccb2e167'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadState(); }, []);

  const connect = async () => {
    setError('');
    setMessage('');
    if (!form.orgId.trim() || !form.companyUrl.trim() || !form.token.trim()) {
      setError(uiMessage('org-branch-panel.enter-organization-id-company-server.e7d51f4eef'));
      return;
    }

    setConnecting(true);
    try {
      const res = await fetch('/api/branch/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: form.orgId.trim(),
          companyUrl: form.companyUrl.trim(),
          token: form.token.trim(),
        }),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || `${uiMessage('org-branch-panel.connection-failed.96c47f8e92')} (${res.status})`);
      setState(normalizeState(data));
      setForm(prev => ({ ...prev, token: '' }));
      setMessage(uiMessage('org-branch-panel.branch-terminal-connected-to-the.32318a415e'));
    } catch (err: any) {
      setError(err.message || uiMessage('org-branch-panel.connection-failed.96c47f8e92'));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/branch/disconnect', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${uiMessage('org-branch-panel.disconnect-failed.17c673b887')} (${res.status})`);
      setState(normalizeState(data));
      setMessage(uiMessage('org-branch-panel.organization-branch-disconnected.eef77df121'));
    } catch (err: any) {
      setError(err.message || uiMessage('org-branch-panel.disconnect-failed.17c673b887'));
    }
  };

  const sync = async () => {
    setError('');
    setMessage('');
    setSyncing(true);
    try {
      const res = await fetch('/api/branch/sync', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${uiMessage('org-branch-panel.sync-failed.58879d004c')} (${res.status})`);
      if (data.state) setState(normalizeState(data));
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setError(data.errors.join('；'));
      } else {
        setMessage(formatUiMessage('org-branch-panel.sync-complete-value0-work-domain.ed45bed8ac', { value0: data.synced || 0 }, (isZh) ? 'zh' : 'en'));
      }
    } catch (err: any) {
      setError(err.message || uiMessage('org-branch-panel.sync-failed.58879d004c'));
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div className="p-6 text-white/40">Loading...</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
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
            <button onClick={sync} disabled={syncing} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? uiMessage('org-branch-panel.syncing.379d137ae4') : uiMessage('org-branch-panel.sync-work-data.a3fed024c8')}
            </button>
            <button onClick={disconnect} className="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg text-sm flex items-center gap-1">
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
              <button onClick={connect} disabled={connecting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1 whitespace-nowrap">
                <Link size={14} /> {connecting ? uiMessage('org-branch-panel.connecting.3fb50c43cd') : uiMessage('org-branch-panel.connect.b3b35de2b3')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
