import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Copy,
  ExternalLink,
  Key,
  Link2,
  Loader2,
  Radio,
  Save,
  Unlink,
  Webhook,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { appConfirm } from '../lib/appConfirm';

type WeComMode = 'aibot_long_connection' | 'app_webhook';

interface WeComBinding {
  id: string;
  platformUserId: string;
  chatId?: string;
  chatType?: 'private' | 'group';
  orgId: string;
  createdAt: string;
}

interface ConnectionStatus {
  state?: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  reconnectAttempts?: number;
}

interface WeComConfigResponse {
  mode?: WeComMode;
  botId?: string;
  botIdMasked?: string;
  hasBotSecret?: boolean;
  corpId?: string;
  corpIdMasked?: string;
  agentId?: string;
  hasSecret?: boolean;
  hasToken?: boolean;
  hasAesKey?: boolean;
  enabled?: boolean;
  connection?: ConnectionStatus | null;
}

const EMPTY_FORM = {
  botId: '',
  botSecret: '',
  corpId: '',
  agentId: '',
  appSecret: '',
  token: '',
  encodingAESKey: '',
};

export function WeComSettings({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [config, setConfig] = useState<WeComConfigResponse | null>(null);
  const [mode, setMode] = useState<WeComMode>('aibot_long_connection');
  const [form, setForm] = useState(EMPTY_FORM);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bindingCode, setBindingCode] = useState('');
  const [bindingExpiresAt, setBindingExpiresAt] = useState('');
  const [bindingLoading, setBindingLoading] = useState(false);
  const [bindings, setBindings] = useState<WeComBinding[]>([]);

  const loadConfig = async (resetForm = false) => {
    const res = await fetch('/api/wecom/config', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ui('配置加载失败', 'Failed to load configuration'));
    const nextMode: WeComMode = data.mode === 'app_webhook' ? 'app_webhook' : 'aibot_long_connection';
    setConfig(data);
    setMode(nextMode);
    setConnection(data.connection || null);
    if (resetForm) {
      setForm({
        ...EMPTY_FORM,
        botId: data.botId || '',
        corpId: data.corpId || '',
        agentId: data.agentId || '',
      });
    }
  };

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/wecom/status', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setConfig(previous => ({ ...(previous || {}), enabled: Boolean(data.configured) }));
        setConnection(data.connection || null);
      }
    } catch {}
  };

  const loadBindings = async () => {
    try {
      const res = await fetch('/api/wecom/bindings', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setBindings(Array.isArray(data.bindings) ? data.bindings : []);
    } catch {}
  };

  useEffect(() => {
    void Promise.all([loadConfig(true), loadBindings()])
      .catch(error => toast.error(error?.message || ui('企微配置加载失败', 'Failed to load WeCom configuration')))
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => void loadStatus(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const save = async () => {
    if (mode === 'aibot_long_connection') {
      if (!form.botId.trim()) {
        toast.error(ui('Bot ID 不能为空', 'Bot ID is required'));
        return;
      }
      if (!form.botSecret.trim() && !config?.hasBotSecret) {
        toast.error(ui('Bot Secret 不能为空', 'Bot Secret is required'));
        return;
      }
    } else if (!form.corpId.trim() || !form.agentId.trim()) {
      toast.error(ui('Corp ID 和 Agent ID 不能为空', 'Corp ID and Agent ID are required'));
      return;
    }

    setSaving(true);
    try {
      const body: Record<string, string | undefined> = {
        mode,
        botId: form.botId.trim(),
        botSecret: form.botSecret.trim() || undefined,
        corpId: form.corpId.trim(),
        agentId: form.agentId.trim(),
        appSecret: form.appSecret.trim() || undefined,
        token: form.token.trim() || undefined,
        encodingAESKey: form.encodingAESKey.trim() || undefined,
      };
      const res = await fetch('/api/wecom/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || ui('保存失败', 'Save failed'));
      await loadConfig(true);
      toast.success(ui('企业微信配置已保存', 'WeCom configuration saved'));
    } catch (error: any) {
      toast.error(error?.message || ui('保存失败', 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const generateBindingCode = async () => {
    setBindingLoading(true);
    try {
      const res = await fetch('/api/wecom/bindings/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('绑定码生成失败', 'Failed to generate binding code'));
      setBindingCode(data.code || '');
      setBindingExpiresAt(data.expiresAt || '');
      toast.success(ui('企微绑定码已生成', 'WeCom binding code generated'));
    } catch (error: any) {
      toast.error(error?.message || ui('请先切换到要绑定的组织工作域', 'Switch to the organization work domain first'));
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

  const removeBinding = async (binding: WeComBinding) => {
    const confirmed = await appConfirm({
      title: ui('解除企微绑定', 'Remove WeCom Binding'),
      message: ui('解除后，这个企微会话将不能再访问当前组织的数据。', 'This WeCom conversation will no longer access the current organization data.'),
      confirmText: ui('解除绑定', 'Remove'),
      cancelText: ui('取消', 'Cancel'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/wecom/bindings/${binding.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ui('解除绑定失败', 'Failed to remove binding'));
      setBindings(previous => previous.filter(item => item.id !== binding.id));
      toast.success(ui('企微绑定已解除', 'WeCom binding removed'));
    } catch (error: any) {
      toast.error(error?.message || ui('解除绑定失败', 'Failed to remove binding'));
    }
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 size={18} className="animate-spin text-white/45" /></div>;
  }

  const state = connection?.state || 'disabled';
  const configured = Boolean(config?.enabled);
  const online = mode === 'app_webhook' ? configured : state === 'connected';
  const statusLabel = !configured
    ? ui('企业微信未配置完整', 'WeCom is not fully configured')
    : mode === 'app_webhook'
      ? ui('应用回调已配置', 'App webhook configured')
      : state === 'connected'
        ? ui('企微长连接在线', 'WeCom long connection online')
        : state === 'reconnecting'
          ? ui('企微正在重连', 'WeCom reconnecting')
          : state === 'connecting'
            ? ui('企微正在连接', 'WeCom connecting')
            : state === 'error'
              ? ui('企微连接失败', 'WeCom connection failed')
              : ui('已配置，等待连接', 'Configured, waiting for connection');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <span className={`h-3 w-3 rounded-full ${online ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : state === 'error' ? 'bg-red-400' : configured ? 'bg-amber-400' : 'bg-white/20'}`} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">{statusLabel}</div>
          <div className="truncate text-xs text-white/40">
            {mode === 'aibot_long_connection'
              ? (config?.botIdMasked || ui('填写 Bot ID 和 Bot Secret', 'Enter Bot ID and Bot Secret'))
              : (config?.corpIdMasked || ui('填写自建应用配置', 'Enter custom app credentials'))}
          </div>
          {connection?.lastError && mode === 'aibot_long_connection' && (
            <div className="mt-1 line-clamp-2 text-[11px] text-red-300/75">{connection.lastError}</div>
          )}
        </div>
        {online ? <CheckCircle size={16} className="ml-auto text-green-500" /> : <AlertCircle size={16} className="ml-auto text-white/45" />}
      </div>

      <div className="space-y-2">
        <div className="text-xs font-black uppercase tracking-widest text-white/50">{ui('接入方式', 'Connection Mode')}</div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={ui('企业微信接入方式', 'WeCom connection mode')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'aibot_long_connection'}
            onClick={() => setMode('aibot_long_connection')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${mode === 'aibot_long_connection' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Radio size={14} /> {ui('AI 机器人长连接', 'AI Bot Long Connection')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'app_webhook'}
            onClick={() => setMode('app_webhook')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${mode === 'app_webhook' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Webhook size={14} /> {ui('旧版应用回调', 'Legacy App Webhook')}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {mode === 'aibot_long_connection'
            ? ui('推荐本地部署使用，不需要公网地址，支持私聊、群聊和流式回复。', 'Recommended for local deployment. It needs no public URL and supports direct chats, groups, and streaming replies.')
            : ui('保留给已有企微自建应用和公网 HTTPS 回调地址的部署。', 'For existing custom apps with a public HTTPS callback endpoint.')}
        </p>
      </div>

      <div className="space-y-4">
        {mode === 'aibot_long_connection' ? (
          <>
            <Field label="Bot ID" icon={<Key size={12} />}>
              <Input value={form.botId} onChange={event => setForm(previous => ({ ...previous, botId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="bot_..." />
            </Field>
            <Field label="Bot Secret" icon={<Key size={12} />}>
              <Input type="password" value={form.botSecret} onChange={event => setForm(previous => ({ ...previous, botSecret: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasBotSecret ? ui('留空则保持现有密钥不变', 'Leave blank to keep the current secret') : ui('输入 Bot Secret', 'Enter Bot Secret')} />
            </Field>
          </>
        ) : (
          <>
            <Field label={ui('Corp ID（企业 ID）', 'Corp ID')}><Input value={form.corpId} onChange={event => setForm(previous => ({ ...previous, corpId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="ww..." /></Field>
            <Field label={ui('Agent ID（应用 ID）', 'Agent ID')}><Input value={form.agentId} onChange={event => setForm(previous => ({ ...previous, agentId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="1000001" /></Field>
            <Field label="App Secret"><Input type="password" value={form.appSecret} onChange={event => setForm(previous => ({ ...previous, appSecret: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasSecret ? ui('留空则保持现有密钥不变', 'Leave blank to keep the current secret') : 'App Secret'} /></Field>
            <Field label="Callback Token"><Input type="password" value={form.token} onChange={event => setForm(previous => ({ ...previous, token: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasToken ? ui('留空则保持现有 Token 不变', 'Leave blank to keep the current token') : 'Callback Token'} /></Field>
            <Field label="Encoding AES Key"><Input type="password" value={form.encodingAESKey} onChange={event => setForm(previous => ({ ...previous, encodingAESKey: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasAesKey ? ui('留空则保持现有密钥不变', 'Leave blank to keep the current key') : ui('43 位 EncodingAESKey', '43-character EncodingAESKey')} /></Field>
          </>
        )}
        <Button onClick={save} disabled={saving} className="h-10 w-full border border-white/10 bg-white/10 text-xs font-black uppercase tracking-widest hover:bg-white/15">
          {saving ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Save size={14} className="mr-2" />}
          {saving ? ui('保存并连接中...', 'Saving and connecting...') : ui('保存配置', 'Save Configuration')}
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60"><Link2 size={14} />{ui('企微组织身份绑定', 'WeCom Organization Binding')}</div>
        <p className="text-xs leading-relaxed text-white/40">{ui('在当前组织生成一次性绑定码，再到企微私聊或群聊发送绑定命令。每个群可以独立路由到不同组织，离开组织后权限立即失效。', 'Generate a one-time code in the active organization, then send the binding command in a direct chat or group. Each group can route to a different organization, and access ends when membership is revoked.')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={generateBindingCode} disabled={bindingLoading} className="h-9 border border-white/10 bg-white/10 text-xs font-bold hover:bg-white/15">
            {bindingLoading ? <Loader2 size={13} className="mr-2 animate-spin" /> : <Link2 size={13} className="mr-2" />}
            {ui('生成绑定码', 'Generate Code')}
          </Button>
          {bindingCode && (
            <button type="button" onClick={copyBindingCommand} className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-bold text-cyan-200 hover:bg-cyan-400/15">
              <Copy size={13} />{`绑定 Lumi ${bindingCode}`}
            </button>
          )}
        </div>
        {bindingExpiresAt && <div className="text-[11px] text-white/32">{ui('过期时间：', 'Expires: ')}{new Date(bindingExpiresAt).toLocaleString()}</div>}
        <div className="border-t border-white/8 pt-3">
          {bindings.length === 0 ? (
            <div className="text-xs text-white/32">{ui('暂无绑定身份', 'No bound identities yet')}</div>
          ) : bindings.map(binding => (
            <div key={binding.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-white/70">{binding.platformUserId}</div>
                <div className="truncate text-[11px] text-white/32">{binding.chatType === 'group' ? ui('群聊路由', 'Group route') : ui('私聊路由', 'Private route')}{binding.chatId ? ` · ${binding.chatId}` : ''}</div>
              </div>
              <button type="button" onClick={() => removeBinding(binding)} className="shrink-0 rounded-md p-1.5 text-white/35 hover:bg-red-500/10 hover:text-red-300" title={ui('解除绑定', 'Remove binding')}><Unlink size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60"><Radio size={14} />{ui('企业微信接入步骤', 'WeCom Setup')}</div>
        <div className="space-y-2 text-xs leading-relaxed text-white/40">
          <p>{ui('1. 前往', '1. Open')} <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-celestial-saturn underline">{ui('企业微信管理后台', 'WeCom Admin Console')}<ExternalLink size={10} /></a></p>
          {mode === 'aibot_long_connection' ? (
            <>
              <p>{ui('2. 创建智能机器人，在 API 模式中选择长连接。', '2. Create an AI Bot and choose long connection for its API mode.')}</p>
              <p>{ui('3. 复制 Bot ID 和 Bot Secret，填入上方并保存。', '3. Copy the Bot ID and Bot Secret, then save them above.')}</p>
              <p>{ui('4. 状态显示“长连接在线”后，把机器人加入需要使用的私聊或群聊。', '4. After the status is online, add the bot to the required direct chats or groups.')}</p>
            </>
          ) : (
            <>
              <p>{ui('2. 创建自建应用，复制 Corp ID、Agent ID 和 App Secret。', '2. Create a custom app and copy its Corp ID, Agent ID, and App Secret.')}</p>
              <p>{ui('3. 在“接收消息”中填写你自己的公网 HTTPS 地址：', '3. In Receive Messages, enter your own public HTTPS endpoint:')}<code className="ml-1 rounded bg-white/5 px-1 text-celestial-jupiter">https://你的域名/api/wecom/events</code></p>
              <p>{ui('4. 将同一组 Token 和 EncodingAESKey 填入企微后台和上方表单。', '4. Enter the same Token and EncodingAESKey in WeCom and the form above.')}</p>
            </>
          )}
          <p>{ui('5. 在当前组织生成绑定码，并在对应会话发送“绑定 Lumi 绑定码”。', '5. Generate a binding code in the active organization and send “绑定 Lumi CODE” in the target conversation.')}</p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="mb-2 flex items-center gap-1 text-xs font-black uppercase tracking-widest text-white/50">{icon}{label}</label>
      {children}
    </div>
  );
}
