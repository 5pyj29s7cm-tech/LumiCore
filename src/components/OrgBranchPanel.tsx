import { useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, Link, RefreshCw, Server, Shield, Unlink, XCircle } from 'lucide-react';
import { useT } from '../lib/useT';

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
    case 'connected': return isZh ? '已连接' : 'Connected';
    case 'connecting': return isZh ? '连接中' : 'Connecting';
    case 'reconnecting': return isZh ? '重连中' : 'Reconnecting';
    case 'error': return isZh ? '连接异常' : 'Connection error';
    default: return isZh ? '未连接' : 'Disconnected';
  }
}

function formatTime(value: string | null, isZh: boolean) {
  return value ? new Date(value).toLocaleString(isZh ? 'zh-CN' : undefined) : (isZh ? '暂无' : 'None');
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
      if (!res.ok) throw new Error(`${ui('状态读取失败', 'Failed to read status')} (${res.status})`);
      const next = normalizeState(await res.json());
      setState(next);
      setForm(prev => ({
        ...prev,
        orgId: prev.orgId || next.orgId || '',
        companyUrl: prev.companyUrl || next.companyUrl || 'http://127.0.0.1:3000',
      }));
    } catch (err: any) {
      setError(err.message || ui('状态读取失败', 'Failed to read status'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadState(); }, []);

  const connect = async () => {
    setError('');
    setMessage('');
    if (!form.orgId.trim() || !form.companyUrl.trim() || !form.token.trim()) {
      setError(ui('请填写组织 ID、公司服务地址和连接令牌', 'Enter organization ID, company server URL, and connection token'));
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
      if (!res.ok || data.success === false) throw new Error(data.error || `${ui('连接失败', 'Connection failed')} (${res.status})`);
      setState(normalizeState(data));
      setForm(prev => ({ ...prev, token: '' }));
      setMessage(ui('分支终端已连接到组织服务器', 'Branch terminal connected to the organization server'));
    } catch (err: any) {
      setError(err.message || ui('连接失败', 'Connection failed'));
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
      if (!res.ok) throw new Error(data.error || `${ui('断开失败', 'Disconnect failed')} (${res.status})`);
      setState(normalizeState(data));
      setMessage(ui('已断开组织分支连接', 'Organization branch disconnected'));
    } catch (err: any) {
      setError(err.message || ui('断开失败', 'Disconnect failed'));
    }
  };

  const sync = async () => {
    setError('');
    setMessage('');
    setSyncing(true);
    try {
      const res = await fetch('/api/branch/sync', { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${ui('同步失败', 'Sync failed')} (${res.status})`);
      if (data.state) setState(normalizeState(data));
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setError(data.errors.join('；'));
      } else {
        setMessage(isZh ? `同步完成：${data.synced || 0} 条工作域数据` : `Sync complete: ${data.synced || 0} work-domain records`);
      }
    } catch (err: any) {
      setError(err.message || ui('同步失败', 'Sync failed'));
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
          {ui('分支连接', 'Branch Connection')}
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
                {ui('已连接到', 'Connected to')} <span className="text-purple-400">{state.orgId}</span>
              </span>
            </>
          ) : (
            <>
              <XCircle size={16} className="text-white/30" />
              <span className="text-white/45 text-sm">{ui('未连接到公司组织服务器', 'Not connected to the company organization server')}</span>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-white/45">
          <div className="bg-black/20 rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-white/60 mb-1"><Server size={12} /> {ui('公司服务地址', 'Company Server URL')}</div>
            <div className="font-mono truncate">{state.companyUrl || ui('未配置', 'Not configured')}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-white/60 mb-1"><Shield size={12} /> {ui('当前域', 'Current Domain')}</div>
            <div>{state.currentDomain === 'work' ? ui('工作域', 'Work') : ui('个人域', 'Personal')}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="text-white/60 mb-1">{ui('上次心跳', 'Last Heartbeat')}</div>
            <div>{formatTime(state.lastHeartbeatAt, isZh)}</div>
          </div>
          <div className="bg-black/20 rounded-lg p-3">
            <div className="text-white/60 mb-1">{ui('上次同步', 'Last Sync')}</div>
            <div>{formatTime(state.lastSyncAt, isZh)}</div>
          </div>
        </div>

        {message && <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">{message}</div>}
        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}

        {connected ? (
          <div className="flex gap-2 pt-1">
            <button onClick={sync} disabled={syncing} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? ui('同步中...', 'Syncing...') : ui('同步工作数据', 'Sync Work Data')}
            </button>
            <button onClick={disconnect} className="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg text-sm flex items-center gap-1">
              <Unlink size={14} /> {ui('断开', 'Disconnect')}
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                value={form.companyUrl}
                onChange={e => setForm(prev => ({ ...prev, companyUrl: e.target.value }))}
                placeholder={ui('公司服务地址，例如 http://192.168.1.10:3000', 'Company server URL, e.g. http://192.168.1.10:3000')}
                className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
              />
              <input
                value={form.orgId}
                onChange={e => setForm(prev => ({ ...prev, orgId: e.target.value }))}
                placeholder={ui('组织 ID', 'Organization ID')}
                className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
              />
            </div>
            <input
              type="password"
              value={form.token}
              onChange={e => setForm(prev => ({ ...prev, token: e.target.value }))}
              placeholder={ui('连接令牌 / 公司服务器登录 token', 'Connection token / company server login token')}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-white/35">
                {ui('分支连接只同步工作域数据到公司服务器，个人域数据仍保留在本机。', 'Branch connection syncs only work-domain data to the company server. Personal-domain data remains local.')}
              </p>
              <button onClick={connect} disabled={connecting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm flex items-center gap-1 whitespace-nowrap">
                <Link size={14} /> {connecting ? ui('连接中...', 'Connecting...') : ui('连接', 'Connect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
