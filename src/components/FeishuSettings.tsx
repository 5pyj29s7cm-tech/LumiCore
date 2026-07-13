import React, { useState, useEffect } from 'react';
import { MessagesSquare, Save, Key, ExternalLink, CheckCircle, AlertCircle, Copy, Unlink, Loader2, Radio, Webhook } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';
import { appConfirm } from '../lib/appConfirm';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import { formatMessagingBindingCommand } from '../i18n/locales/messaging';

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
  const locale = isZh ? 'zh' : 'en';
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
      toast.error(uiMessage('feishu-settings.app-id-is-required.cb6e433919'));
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
        toast.success(uiMessage('feishu-settings.feishu-configuration-saved.1e3f2a86b1'));
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
      toast.success(uiMessage('feishu-settings.feishu-binding-code-generated.d9594b70f2'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('feishu-settings.failed-to-generate-binding-code.0792c78b45'));
    } finally {
      setBindingLoading(false);
    }
  };

  const copyBindingCommand = async () => {
    if (!bindingCode) return;
    const command = formatMessagingBindingCommand(bindingCode, locale);
    try {
      await navigator.clipboard.writeText(command);
      toast.success(uiMessage('feishu-settings.binding-command-copied.932649e202'));
    } catch {
      toast.info(command);
    }
  };

  const removeBinding = async (binding: FeishuBinding) => {
    const ok = await appConfirm({
      title: uiMessage('feishu-settings.remove-feishu-binding.305599e119'),
      message: uiMessage('feishu-settings.this-feishu-identity-will-no.c603452aeb'),
      confirmText: uiMessage('feishu-settings.remove.22ca1b73bd'),
      cancelText: uiMessage('feishu-settings.cancel.998b9c48fb'),
      tone: 'danger',
    });
    if (!ok) return;

    try {
      const res = await fetch(`/api/feishu/bindings/${binding.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || formatUiMessage('feishu-settings.failed-to-remove-binding-value0.6c1df5c705', { value0: res.status }));
      setBindings(prev => prev.filter(item => item.id !== binding.id));
      toast.success(uiMessage('feishu-settings.feishu-binding-removed.6cc30eda79'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('feishu-settings.failed-to-remove-binding.01934a75af'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-xs font-black uppercase tracking-widest text-white/45">{uiMessage('feishu-settings.loading.586f5af819')}</div>
      </div>
    );
  }

  const connectionState = connection?.state || 'disabled';
  const online = transport === 'webhook' ? configured : connectionState === 'connected';
  const statusLabel = !configured
    ? uiMessage('feishu-settings.feishu-not-configured.783a463eac')
    : transport === 'webhook'
      ? uiMessage('feishu-settings.webhook-configured.b513832994')
      : connectionState === 'connected'
        ? uiMessage('feishu-settings.feishu-long-connection-online.c0250f13b5')
        : connectionState === 'reconnecting'
          ? uiMessage('feishu-settings.feishu-reconnecting.cf463bf20b')
          : connectionState === 'connecting'
            ? uiMessage('feishu-settings.feishu-connecting.7494650863')
            : connectionState === 'error'
              ? uiMessage('feishu-settings.feishu-connection-failed.f52a1cca90')
              : uiMessage('feishu-settings.configured-waiting-for-connection.b4a0caf1b0');

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
            {configured ? `App ID: ${appIdMasked}` : uiMessage('feishu-settings.enter-app-id-and-app.30fddfa0a6')}
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
        <div className="text-xs font-black uppercase tracking-widest text-white/50">{uiMessage('feishu-settings.connection-mode.2c89f8db53')}</div>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={uiMessage('feishu-settings.feishu-connection-mode.0b2e94ccbe')}>
          <button
            type="button"
            role="tab"
            aria-selected={transport === 'long_connection'}
            onClick={() => setTransport('long_connection')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${transport === 'long_connection' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Radio size={14} />
            {uiMessage('feishu-settings.long-connection.bee4cc1896')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={transport === 'webhook'}
            onClick={() => setTransport('webhook')}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-xs font-bold transition-colors ${transport === 'webhook' ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'}`}
          >
            <Webhook size={14} />
            {uiMessage('feishu-settings.webhook.bad1b22a82')}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {transport === 'long_connection'
            ? uiMessage('feishu-settings.best-for-local-deployments-no.0164d7d873')
            : uiMessage('feishu-settings.use-only-when-you-already.a78c47baa1')}
        </p>
      </div>

      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60">
          <MessagesSquare size={14} />
          {uiMessage('feishu-settings.feishu-remote-identity-binding.dc05107de4')}
        </div>
        <p className="text-xs leading-relaxed text-white/40">
          {uiMessage('feishu-settings.generate-a-one-time-code.a348fb36d4')}
        </p>
        <p className="text-xs leading-relaxed text-white/40">
          {uiMessage('feishu-settings.each-organization-member-must-bind.2937f38191')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={generateBindingCode}
            disabled={bindingLoading}
            className="h-9 bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-black uppercase tracking-widest"
          >
            {bindingLoading ? uiMessage('feishu-settings.generating.634308f29b') : uiMessage('feishu-settings.generate-code.099ef173d3')}
          </Button>
          {bindingCode && (
            <button
              onClick={copyBindingCommand}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 text-xs font-bold text-cyan-200 hover:bg-cyan-400/15"
            >
              <Copy size={13} />
              {formatMessagingBindingCommand(bindingCode, locale)}
            </button>
          )}
        </div>
        {bindingExpiresAt && (
          <div className="text-[11px] text-white/32">
            {uiMessage('feishu-settings.expires.4094fda731')}{new Date(bindingExpiresAt).toLocaleString()}
          </div>
        )}
        <div className="rounded-lg border border-white/8 bg-black/20 p-3">
          <div className="mb-2 text-[11px] font-black uppercase tracking-widest text-white/45">
            {uiMessage('feishu-settings.bound-feishu-identities.9bcf38e7e2')}
          </div>
          {bindings.length === 0 ? (
            <div className="text-xs text-white/32">{uiMessage('feishu-settings.no-bound-identities-yet.9e261ae027')}</div>
          ) : (
            <div className="space-y-2">
              {bindings.map(binding => (
                <div key={binding.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-mono text-white/70">{binding.platformUserId}</div>
                    <div className="text-[11px] text-white/32">
                      {binding.chatType === 'group' ? uiMessage('feishu-settings.group-route.be66ad213e') : uiMessage('feishu-settings.private-route.c9c1cf8c68')}
                      {binding.chatId ? ` · ${binding.chatId}` : ''}
                    </div>
                    <div className="text-[11px] text-white/32">
                      {uiMessage('feishu-settings.bound-at.ffced93a5e')} {new Date(binding.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={() => removeBinding(binding)}
                    className="shrink-0 rounded-md p-1.5 text-white/35 hover:bg-red-500/10 hover:text-red-300"
                    title={uiMessage('feishu-settings.remove-binding.d68e6d4dac')}
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
              placeholder={configured ? uiMessage('feishu-settings.leave-blank-to-keep-the.4d0d0cdd5d') : uiMessage('feishu-settings.enter-app-secret.d8aba5f168')}
              className="bg-white/5 border-white/10 text-white text-xs h-10 font-mono placeholder:text-white/45 pr-12"
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-black uppercase tracking-widest text-white/55 hover:text-white/60"
            >
              {showSecret ? uiMessage('feishu-settings.hide.d2e660d104') : uiMessage('feishu-settings.show.520bd3e959')}
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
              placeholder={hasVerificationToken ? uiMessage('feishu-settings.leave-blank-to-keep-the.c312eede26') : uiMessage('feishu-settings.enter-the-event-verification-token.4b6dbbf3fb')}
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
          {saving ? uiMessage('feishu-settings.saving.5a02b802aa') : uiMessage('feishu-settings.save-configuration.1ace864ca8')}
        </Button>
      </div>

      {/* Setup Guide */}
      <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-white/60">
          <MessagesSquare size={14} />
          {uiMessage('feishu-settings.feishu-bot-setup-guide.f3171848ca')}
        </div>
        <div className="space-y-2 text-xs text-white/40 leading-relaxed">
          <p>{uiMessage('feishu-settings.1-go-to.9e1436280f')} <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-celestial-saturn underline inline-flex items-center gap-0.5">{uiMessage('feishu-settings.feishu-open-platform.6a073feb82')}<ExternalLink size={10} /></a> {uiMessage('feishu-settings.and-create-an-app.6e30d2e8be')}</p>
          <p>{uiMessage('feishu-settings.2-in-app-capabilities-enable.1fe4d35d81')}</p>
          <p>{uiMessage('feishu-settings.3-in-credentials-basic-info.723d264831')}</p>
          {transport === 'long_connection' ? (
            <p>{uiMessage('feishu-settings.4-in-event-subscriptions-select.a2526278a4')}</p>
          ) : (
            <p>{uiMessage('feishu-settings.4-in-event-subscriptions-enter.ab4866edf7')}<code className="ml-1 rounded bg-white/5 px-1 text-celestial-jupiter">https://example.com/api/feishu/events</code></p>
          )}
          <p>{uiMessage('feishu-settings.5-subscribe-to-event-im.8263a5232d')}</p>
          <p>{uiMessage('feishu-settings.6-in-permissions-enable-reading.ba4d8850c0')}</p>
          <p>{uiMessage('feishu-settings.7-in-app-release-create.3277ee6333')}</p>
        </div>
        <a
          href="https://open.feishu.cn/app"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-widest text-celestial-saturn hover:underline mt-2"
        >
          {uiMessage('feishu-settings.open-feishu-open-platform.14a544ce39')} <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
