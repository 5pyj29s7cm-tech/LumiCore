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
import { uiMessage } from '../i18n/uiMessages';
import { formatMessagingBindingCommand } from '../i18n/locales/messaging';

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
  const locale = isZh ? 'zh' : 'en';
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
    if (!res.ok) throw new Error(data.error || uiMessage('we-com-settings.failed-to-load-configuration.7ef35e8101'));
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
      .catch(error => toast.error(error?.message || uiMessage('we-com-settings.failed-to-load-wecom-configuration.b014a0bd18')))
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => void loadStatus(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const save = async () => {
    if (mode === 'aibot_long_connection') {
      if (!form.botId.trim()) {
        toast.error(uiMessage('we-com-settings.bot-id-is-required.efd9d5b119'));
        return;
      }
      if (!form.botSecret.trim() && !config?.hasBotSecret) {
        toast.error(uiMessage('we-com-settings.bot-secret-is-required.0c6b88fa5f'));
        return;
      }
    } else if (!form.corpId.trim() || !form.agentId.trim()) {
      toast.error(uiMessage('we-com-settings.corp-id-and-agent-id.cad2adc369'));
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
      if (!res.ok || !data.success) throw new Error(data.error || uiMessage('we-com-settings.save-failed.5b5ea27d01'));
      await loadConfig(true);
      toast.success(uiMessage('we-com-settings.wecom-configuration-saved.f22d319d7b'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('we-com-settings.save-failed.5b5ea27d01'));
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
      if (!res.ok) throw new Error(data.error || uiMessage('we-com-settings.failed-to-generate-binding-code.5db5228dfd'));
      setBindingCode(data.code || '');
      setBindingExpiresAt(data.expiresAt || '');
      toast.success(uiMessage('we-com-settings.wecom-binding-code-generated.9d85410deb'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('we-com-settings.switch-to-the-organization-work.32f809cbce'));
    } finally {
      setBindingLoading(false);
    }
  };

  const copyBindingCommand = async () => {
    if (!bindingCode) return;
    const command = formatMessagingBindingCommand(bindingCode, locale);
    try {
      await navigator.clipboard.writeText(command);
      toast.success(uiMessage('we-com-settings.binding-command-copied.932649e202'));
    } catch {
      toast.info(command);
    }
  };

  const removeBinding = async (binding: WeComBinding) => {
    const confirmed = await appConfirm({
      title: uiMessage('we-com-settings.remove-wecom-binding.8b29e9dc48'),
      message: uiMessage('we-com-settings.this-wecom-conversation-will-no.94f7e96e71'),
      confirmText: uiMessage('we-com-settings.remove.22ca1b73bd'),
      cancelText: uiMessage('we-com-settings.cancel.998b9c48fb'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/wecom/bindings/${binding.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('we-com-settings.failed-to-remove-binding.01934a75af'));
      setBindings(previous => previous.filter(item => item.id !== binding.id));
      toast.success(uiMessage('we-com-settings.wecom-binding-removed.c964dea89e'));
    } catch (error: any) {
      toast.error(error?.message || uiMessage('we-com-settings.failed-to-remove-binding.01934a75af'));
    }
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 size={18} className="animate-spin text-white/45" /></div>;
  }

  const state = connection?.state || 'disabled';
  const configured = Boolean(config?.enabled);
  const online = mode === 'app_webhook' ? configured : state === 'connected';
  const statusLabel = !configured
    ? uiMessage('we-com-settings.wecom-is-not-fully-configured.74552f4d8f')
    : mode === 'app_webhook'
      ? uiMessage('we-com-settings.app-webhook-configured.dd5ed03206')
      : state === 'connected'
        ? uiMessage('we-com-settings.wecom-long-connection-online.6e7cf5cb6a')
        : state === 'reconnecting'
          ? uiMessage('we-com-settings.wecom-reconnecting.e652f88861')
          : state === 'connecting'
            ? uiMessage('we-com-settings.wecom-connecting.7a230b775f')
            : state === 'error'
              ? uiMessage('we-com-settings.wecom-connection-failed.0d0a758725')
              : uiMessage('we-com-settings.configured-waiting-for-connection.b4a0caf1b0');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <span className={`h-3 w-3 rounded-full ${online ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : state === 'error' ? 'bg-red-400' : configured ? 'bg-amber-400' : 'bg-white/20'}`} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">{statusLabel}</div>
          <div className="truncate text-xs text-white/40">
            {mode === 'aibot_long_connection'
              ? (config?.botIdMasked || uiMessage('we-com-settings.enter-bot-id-and-bot.a5090f8eed'))
              : (config?.corpIdMasked || uiMessage('we-com-settings.enter-custom-app-credentials.45e18d313e'))}
          </div>
          {connection?.lastError && mode === 'aibot_long_connection' && (
            <div className="mt-1 line-clamp-2 text-[11px] text-red-300/75">{connection.lastError}</div>
          )}
        </div>
        {online ? <CheckCircle size={16} className="ml-auto text-green-500" /> : <AlertCircle size={16} className="ml-auto text-white/45" />}
      </div>

      <div className="space-y-2">
        <div className="text-xs font-black uppercase tracking-widest text-white/50">{uiMessage('we-com-settings.connection-mode.b923a6156c')}</div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={uiMessage('we-com-settings.wecom-connection-mode.6107249740')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'aibot_long_connection'}
            onClick={() => setMode('aibot_long_connection')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${mode === 'aibot_long_connection' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Radio size={14} /> {uiMessage('we-com-settings.ai-bot-long-connection.e52d12010c')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'app_webhook'}
            onClick={() => setMode('app_webhook')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${mode === 'app_webhook' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Webhook size={14} /> {uiMessage('we-com-settings.legacy-app-webhook.84777c9e1d')}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {mode === 'aibot_long_connection'
            ? uiMessage('we-com-settings.recommended-for-local-deployment-it.014a598097')
            : uiMessage('we-com-settings.for-existing-custom-apps-with.b4fa92b335')}
        </p>
      </div>

      <div className="space-y-4">
        {mode === 'aibot_long_connection' ? (
          <>
            <Field label="Bot ID" icon={<Key size={12} />}>
              <Input value={form.botId} onChange={event => setForm(previous => ({ ...previous, botId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="bot_..." />
            </Field>
            <Field label="Bot Secret" icon={<Key size={12} />}>
              <Input type="password" value={form.botSecret} onChange={event => setForm(previous => ({ ...previous, botSecret: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasBotSecret ? uiMessage('we-com-settings.leave-blank-to-keep-the.4d0d0cdd5d') : uiMessage('we-com-settings.enter-bot-secret.754f6b325f')} />
            </Field>
          </>
        ) : (
          <>
            <Field label={uiMessage('we-com-settings.corp-id.07ead2f288')}><Input value={form.corpId} onChange={event => setForm(previous => ({ ...previous, corpId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="ww..." /></Field>
            <Field label={uiMessage('we-com-settings.agent-id.d41b42283a')}><Input value={form.agentId} onChange={event => setForm(previous => ({ ...previous, agentId: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white" placeholder="1000001" /></Field>
            <Field label="App Secret"><Input type="password" value={form.appSecret} onChange={event => setForm(previous => ({ ...previous, appSecret: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasSecret ? uiMessage('we-com-settings.leave-blank-to-keep-the.4d0d0cdd5d') : 'App Secret'} /></Field>
            <Field label="Callback Token"><Input type="password" value={form.token} onChange={event => setForm(previous => ({ ...previous, token: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasToken ? uiMessage('we-com-settings.leave-blank-to-keep-the.c312eede26') : 'Callback Token'} /></Field>
            <Field label="Encoding AES Key"><Input type="password" value={form.encodingAESKey} onChange={event => setForm(previous => ({ ...previous, encodingAESKey: event.target.value }))} className="h-10 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/45" placeholder={config?.hasAesKey ? uiMessage('we-com-settings.leave-blank-to-keep-the.76e0fa4bb0') : uiMessage('we-com-settings.43-character-encodingaeskey.e08311ab4e')} /></Field>
          </>
        )}
        <Button onClick={save} disabled={saving} className="h-10 w-full border border-white/10 bg-white/10 text-xs font-black uppercase tracking-widest hover:bg-white/15">
          {saving ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Save size={14} className="mr-2" />}
          {saving ? uiMessage('we-com-settings.saving-and-connecting.305712a223') : uiMessage('we-com-settings.save-configuration.1ace864ca8')}
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60"><Link2 size={14} />{uiMessage('we-com-settings.wecom-organization-binding.80abf9a22c')}</div>
        <p className="text-xs leading-relaxed text-white/40">{uiMessage('we-com-settings.generate-a-one-time-code.097db830ab')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={generateBindingCode} disabled={bindingLoading} className="h-9 border border-white/10 bg-white/10 text-xs font-bold hover:bg-white/15">
            {bindingLoading ? <Loader2 size={13} className="mr-2 animate-spin" /> : <Link2 size={13} className="mr-2" />}
            {uiMessage('we-com-settings.generate-code.099ef173d3')}
          </Button>
          {bindingCode && (
            <button type="button" onClick={copyBindingCommand} className="inline-flex h-9 items-center gap-2 rounded-md border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-bold text-cyan-200 hover:bg-cyan-400/15">
              <Copy size={13} />{formatMessagingBindingCommand(bindingCode, locale)}
            </button>
          )}
        </div>
        {bindingExpiresAt && <div className="text-[11px] text-white/32">{uiMessage('we-com-settings.expires.4094fda731')}{new Date(bindingExpiresAt).toLocaleString()}</div>}
        <div className="border-t border-white/8 pt-3">
          {bindings.length === 0 ? (
            <div className="text-xs text-white/32">{uiMessage('we-com-settings.no-bound-identities-yet.9e261ae027')}</div>
          ) : bindings.map(binding => (
            <div key={binding.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-white/70">{binding.platformUserId}</div>
                <div className="truncate text-[11px] text-white/32">{binding.chatType === 'group' ? uiMessage('we-com-settings.group-route.be66ad213e') : uiMessage('we-com-settings.private-route.c9c1cf8c68')}{binding.chatId ? ` · ${binding.chatId}` : ''}</div>
              </div>
              <button type="button" onClick={() => removeBinding(binding)} className="shrink-0 rounded-md p-1.5 text-white/35 hover:bg-red-500/10 hover:text-red-300" title={uiMessage('we-com-settings.remove-binding.d68e6d4dac')}><Unlink size={13} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60"><Radio size={14} />{uiMessage('we-com-settings.wecom-setup.409e25c692')}</div>
        <div className="space-y-2 text-xs leading-relaxed text-white/40">
          <p>{uiMessage('we-com-settings.1-open.50a072fb3b')} <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-celestial-saturn underline">{uiMessage('we-com-settings.wecom-admin-console.cbacd9db7c')}<ExternalLink size={10} /></a></p>
          {mode === 'aibot_long_connection' ? (
            <>
              <p>{uiMessage('we-com-settings.2-create-an-ai-bot.6d18bab932')}</p>
              <p>{uiMessage('we-com-settings.3-copy-the-bot-id.bdbdbc1bc5')}</p>
              <p>{uiMessage('we-com-settings.4-after-the-status-is.ab7af3cdde')}</p>
            </>
          ) : (
            <>
              <p>{uiMessage('we-com-settings.2-create-a-custom-app.13c8a4857e')}</p>
              <p>{uiMessage('we-com-settings.3-in-receive-messages-enter.79794ae243')}<code className="ml-1 rounded bg-white/5 px-1 text-celestial-jupiter">https://example.com/api/wecom/events</code></p>
              <p>{uiMessage('we-com-settings.4-enter-the-same-token.4294764508')}</p>
            </>
          )}
          <p>{uiMessage('we-com-settings.5-generate-a-binding-code.30c9b5eebb')}</p>
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
