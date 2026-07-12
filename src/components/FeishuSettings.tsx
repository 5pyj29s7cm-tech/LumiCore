import React, { useState, useEffect } from 'react';
import { MessagesSquare, Save, Key, ExternalLink, CheckCircle, AlertCircle, Copy, Unlink, Loader2, Radio, Webhook } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { appConfirm } from '../lib/appConfirm';

interface FeishuBinding {
  id: string;
  platformUserId: string;
  chatId?: string;
  chatType?: 'private' | 'group';
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

type FeishuTransport = 'long_connection' | 'webhook';

interface ConnectionStatus {
  state?: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  reconnectAttempts?: number;
}

export function FeishuSettings({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [hasVerificationToken, setHasVerificationToken] = useState(false);
  const [transport, setTransport] = useState<FeishuTransport>('long_connection');
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [configured, setConfigured] = useState(false);
  const [appIdMasked, setAppIdMasked] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [bindingCode, setBindingCode] = useState('');
  const [bindingExpiresAt, setBindingExpiresAt] = useState('');
  const [bindingLoading, setBindingLoading] = useState(false);
  const [bindings, setBindings] = useState<FeishuBinding[]>([]);

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/feishu/status', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setConfigured(Boolean(data.configured));
        setConnection(data.connection || null);
      }
    } catch {}
  };

  useEffect(() => {
    fetch('/api/feishu/config', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setAppId(d.appId || '');
        setAppIdMasked(d.appIdMasked || '');
        setConfigured(Boolean(d.enabled));
        setTransport(d.transport === 'webhook' ? 'webhook' : 'long_connection');
        setHasVerificationToken(Boolean(d.verificationToken));
        setConnection(d.connection || null);
      })
      .catch(() => toast.error(t?.failedToLoadConfig || 'Failed to load config'))
      .finally(() => setLoading(false));
    void loadBindings();
    const timer = window.setInterval(() => void loadStatus(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadBindings() {
    try {
      const res = await fetch('/api/feishu/bindings', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setBindings(Array.isArray(data.bindings) ? data.bindings : []);
    } catch {}
  }

  const save = async () => {
    if (!appId.trim()) {
      toast.error(ui('App ID 不能为空', 'App ID is required'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/feishu/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: appId.trim(),
          appSecret: appSecret.trim() || undefined,
          verificationToken: verificationToken.trim() || undefined,
          transport,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setConfigured(data.configured);
        setConnection(data.connection || null);
        setAppIdMasked(data.appId || '');
        if (appSecret.trim()) setAppSecret('');
        if (verificationToken.trim()) {
          setVerificationToken('');
          setHasVerificationToken(true);
        }
        toast.success(ui('飞书配置已保存', 'Feishu configuration saved'));
      } else {
        toast.error(data.error || (t?.saveFailed || 'Save failed'));
      }
    } catch (err: any) {
      toast.error(`${t?.saveFailed || 'Save failed'}: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const generateBindingCode = async () => {
    setBindingLoading(true);
    try {
      const res = await fetch('/api/feishu/bindings/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to generate binding code');
      setBindingCode(data.code || '');
      setBindingExpiresAt(data.expiresAt || '');
      toast.success(ui('飞书绑定码已生成', 'Feishu binding code generated'));
    } catch (err: any) {
      toast.error(err?.message || ui('绑定码生成失败，请确认已切换到组织工作域', 'Failed to generate binding code. Switch to work domain first.'));
    } finally {
      setBindingLoading(false);
    }
  };

  const copyBindingCommand = async () => {
    if (!bindingCode) return;
    const command = `绑定 Lumi ${bindingCode}`;
    try {
      await navigator.clipboard.writeText(command);
      toast.success(ui('绑定命令已复制', 'Binding command copied'));
    } catch {
      toast.info(command);
    }
  };

  const removeBinding = async (binding: FeishuBinding) => {
    const ok = await appConfirm({
      title: ui('解除飞书绑定', 'Remove Feishu Binding'),
      message: ui('解除后，这个飞书身份将不能再访问当前 Lumi 的组织数据。', 'This Feishu identity will no longer access this Lumi organization data.'),
      confirmText: ui('解除绑定', 'Remove'),
      cancelText: ui('取消', 'Cancel'),
      tone: 'danger',
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/feishu/bindings/${binding.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui(`解除绑定失败（${res.status}）`, `Failed to remove binding (${res.status})`));
      setBindings(prev => prev.filter(item => item.id !== binding.id));
      toast.success(ui('飞书绑定已解除', 'Feishu binding removed'));
    } catch (err: any) {
      toast.error(err?.message || ui('解除绑定失败', 'Failed to remove binding'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-xs font-black uppercase tracking-widest text-white/45">{ui('加载中...', 'Loading...')}</div>
      </div>
    );
  }

  const connectionState = connection?.state || 'disabled';
  const online = transport === 'webhook' ? configured : connectionState === 'connected';
  const statusLabel = !configured
    ? ui('飞书未配置', 'Feishu not configured')
    : transport === 'webhook'
      ? ui('回调模式已配置', 'Webhook configured')
      : connectionState === 'connected'
        ? ui('飞书长连接在线', 'Feishu long connection online')
        : connectionState === 'reconnecting'
          ? ui('飞书正在重连', 'Feishu reconnecting')
          : connectionState === 'connecting'
            ? ui('飞书正在连接', 'Feishu connecting')
            : connectionState === 'error'
              ? ui('飞书连接失败', 'Feishu connection failed')
              : ui('已配置，等待连接', 'Configured, waiting for connection');

  return (
    <div className="space-y-6">
      {/* Status Bar */}
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className={`h-3 w-3 rounded-full ${online ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : connectionState === 'error' ? 'bg-red-400' : configured ? 'bg-amber-400' : 'bg-white/20'}`} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">
            {statusLabel}
          </div>
          <div className="truncate text-xs text-white/40">
            {configured ? `App ID: ${appIdMasked}` : ui('请输入 App ID 和 App Secret', 'Enter App ID and App Secret')}
          </div>
          {connection?.lastError && transport === 'long_connection' && (
            <div className="mt-1 line-clamp-2 text-[11px] text-red-300/75">{connection.lastError}</div>
          )}
        </div>
        {online ? (
          <CheckCircle size={16} className="text-green-500 ml-auto" />
        ) : (
          <AlertCircle size={16} className="text-white/45 ml-auto" />
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs font-black uppercase tracking-widest text-white/50">{ui('接收方式', 'Connection Mode')}</div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={ui('飞书接收方式', 'Feishu connection mode')}>
          <button
            type="button"
            role="tab"
            aria-selected={transport === 'long_connection'}
            onClick={() => setTransport('long_connection')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${transport === 'long_connection' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Radio size={14} />
            {ui('长连接（推荐）', 'Long Connection')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={transport === 'webhook'}
            onClick={() => setTransport('webhook')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${transport === 'webhook' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Webhook size={14} />
            {ui('公网回调', 'Webhook')}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {transport === 'long_connection'
            ? ui('适合本地部署，不需要公网地址；Lumi 启动后会主动连接飞书。', 'Best for local deployments. No public URL is required; Lumi connects to Feishu after startup.')
            : ui('仅在你已有稳定公网 HTTPS 地址时使用。', 'Use only when you already have a stable public HTTPS endpoint.')}
        </p>
      </div>

      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60">
          <MessagesSquare size={14} />
          {ui('飞书远程身份绑定', 'Feishu Remote Identity Binding')}
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {ui('生成一次性绑定码后，在飞书里发送“绑定 Lumi 绑定码”。绑定后，Lumi 才能通过飞书安全地查询组织知识库、查案件或归档案件文件。', 'Generate a one-time code, then send “绑定 Lumi CODE” in Feishu. After binding, Lumi can securely query org KB, search cases, and archive case files from Feishu.')}
        </p>
        <p className="text-xs leading-relaxed text-white/40">
          {ui('每位组织成员都必须使用自己的 Lumi 账号单独绑定。私聊、群成员和群话题分别隔离，未绑定成员不会继承他人的组织权限。', 'Each organization member must bind with their own Lumi account. Direct chats, group members, and group threads are isolated; unbound members never inherit another person’s organization access.')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={generateBindingCode}
            disabled={bindingLoading}
            className="h-9 bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-black uppercase tracking-widest"
          >
            {bindingLoading ? ui('生成中...', 'Generating...') : ui('生成绑定码', 'Generate Code')}
          </Button>
          {bindingCode && (
            <button
              onClick={copyBindingCommand}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-bold text-cyan-200 hover:bg-cyan-400/15"
            >
              <Copy size={13} />
              {`绑定 Lumi ${bindingCode}`}
            </button>
          )}
        </div>
        {bindingExpiresAt && (
          <div className="text-[11px] text-white/32">
            {ui('过期时间：', 'Expires: ')}{new Date(bindingExpiresAt).toLocaleString()}
          </div>
        )}
        <div className="rounded-lg border border-white/8 bg-black/20 p-3">
          <div className="mb-2 text-[11px] font-black uppercase tracking-widest text-white/45">
            {ui('已绑定飞书身份', 'Bound Feishu Identities')}
          </div>
          {bindings.length === 0 ? (
            <div className="text-xs text-white/32">{ui('暂无绑定身份', 'No bound identities yet')}</div>
          ) : (
            <div className="space-y-2">
              {bindings.map(binding => (
                <div key={binding.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-mono text-white/70">{binding.platformUserId}</div>
                    <div className="text-[11px] text-white/32">
                      {binding.chatType === 'group' ? ui('群聊路由', 'Group route') : ui('私聊路由', 'Private route')}
                      {binding.chatId ? ` · ${binding.chatId}` : ''}
                    </div>
                    <div className="text-[11px] text-white/32">
                      {ui('绑定于', 'Bound at')} {new Date(binding.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={() => removeBinding(binding)}
                    className="shrink-0 rounded-md p-1.5 text-white/35 hover:bg-red-500/10 hover:text-red-300"
                    title={ui('解除绑定', 'Remove binding')}
                  >
                    <Unlink size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Config Form */}
      <div className="space-y-4">
        <div>
          <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-2">
            <Key size={12} className="inline mr-1" /> App ID
          </label>
          <Input
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            className="bg-white/5 border-white/10 text-white text-xs h-10 font-mono placeholder:text-white/45"
          />
        </div>

        <div>
          <label className="text-xs font-black uppercase tracking-widest text-white/50 block mb-2">
            <Key size={12} className="inline mr-1" /> App Secret
          </label>
          <div className="relative">
            <Input
              type={showSecret ? 'text' : 'password'}
              value={appSecret}
              onChange={e => setAppSecret(e.target.value)}
              placeholder={configured ? ui('留空则保持现有密钥不变', 'Leave blank to keep the current secret') : ui('输入 App Secret', 'Enter App Secret')}
              className="bg-white/5 border-white/10 text-white text-xs h-10 font-mono placeholder:text-white/45 pr-12"
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-black uppercase tracking-widest text-white/55 hover:text-white/60"
            >
              {showSecret ? ui('隐藏', 'Hide') : ui('显示', 'Show')}
            </button>
          </div>
        </div>

        {transport === 'webhook' && (
          <div>
            <label className="mb-2 block text-xs font-black uppercase tracking-widest text-white/50">
              <Key size={12} className="mr-1 inline" /> Verification Token
            </label>
            <Input
              type="password"
              value={verificationToken}
              onChange={e => setVerificationToken(e.target.value)}
              placeholder={hasVerificationToken ? ui('留空则保持现有 Token 不变', 'Leave blank to keep the current token') : ui('输入事件订阅 Verification Token', 'Enter the event verification token')}
              className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45"
            />
          </div>
        )}

        <Button
          onClick={save}
          disabled={saving || !appId.trim()}
          className="w-full h-10 bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-black uppercase tracking-widest"
        >
          {saving ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Save size={14} className="mr-2" />}
          {saving ? ui('保存中...', 'Saving...') : ui('保存配置', 'Save Configuration')}
        </Button>
      </div>

      {/* Setup Guide */}
      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60">
          <MessagesSquare size={14} />
          {ui('飞书机器人接入指南', 'Feishu Bot Setup Guide')}
        </div>
        <div className="space-y-2 text-xs text-white/40 leading-relaxed">
          <p>{ui('1. 前往', '1. Go to')} <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-celestial-saturn underline inline-flex items-center gap-0.5">{ui('飞书开放平台', 'Feishu Open Platform')}<ExternalLink size={10} /></a> {ui('创建应用', 'and create an app')}</p>
          <p>{ui('2. 左侧菜单「应用能力」-> 启用「机器人」', '2. In App Capabilities, enable Bot')}</p>
          <p>{ui('3. 左侧菜单「凭证与基础信息」-> 复制 App ID 和 App Secret', '3. In Credentials & Basic Info, copy App ID and App Secret')}</p>
          {transport === 'long_connection' ? (
            <p>{ui('4. 左侧菜单「事件订阅」-> 选择「使用长连接接收事件」', '4. In Event Subscriptions, select “Use long connection to receive events”')}</p>
          ) : (
            <p>{ui('4. 左侧菜单「事件订阅」-> 填入你自己的公网 HTTPS 地址：', '4. In Event Subscriptions, enter your own public HTTPS endpoint:')}<code className="ml-1 rounded bg-white/5 px-1 text-celestial-jupiter">https://你的域名/api/feishu/events</code></p>
          )}
          <p>{ui('5. 订阅事件：添加「接收消息」im.message.receive_v1', '5. Subscribe to event: im.message.receive_v1')}</p>
          <p>{ui('6. 左侧菜单「权限管理」-> 开通「获取并发送单聊、群聊消息」', '6. In Permissions, enable reading and sending direct/group messages')}</p>
          <p>{ui('7. 左侧菜单「应用发布」-> 创建版本并发布', '7. In App Release, create a version and publish it')}</p>
        </div>
        <a
          href="https://open.feishu.cn/app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-widest text-celestial-saturn hover:underline mt-2"
        >
          {ui('打开飞书开放平台', 'Open Feishu Open Platform')} <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
