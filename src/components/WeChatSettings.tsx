import { useEffect, useRef, useState } from 'react';
import { BellRing, Copy, Eye, Link2, Loader2, Monitor, RefreshCw, Send, ShieldAlert, Unlink, X } from 'lucide-react';
import QRCode from 'qrcode';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { uiMessage } from '../i18n/uiMessages';
import { formatMessagingBindingCommand } from '../i18n/locales/messaging';

interface WeChatStatus {
  configured: boolean;
  listening: boolean;
  sessionExpired?: boolean;
  lastMessageAt?: string | null;
  lastReplyAt?: string | null;
  lastError?: string | null;
  canConfigure?: boolean;
  personalBound?: boolean;
  personalBinding?: {
    id: string;
    platformUserId: string;
    updatedAt: string;
  } | null;
  pendingPersonalBinding?: {
    code: string;
    expiresAt: string;
  } | null;
  desktopWatch?: DesktopWechatWatchStatus;
}

interface DesktopWechatWatchEvent {
  id: string;
  contact: string;
  unreadCount: number | null;
  status: 'detected' | 'processing' | 'draft_ready' | 'review_required' | 'attention_required' | 'sending' | 'sent' | 'dismissed' | 'failed';
  detectedAt: string;
  messageSummary: string;
  draft: string;
  risk: 'unknown' | 'low' | 'high';
  riskReason: string;
  error: string;
}

interface DesktopWechatWatchStatus {
  config: {
    enabled: boolean;
    pollIntervalSeconds: number;
    autoInspectWhenIdle: boolean;
    idleBeforeInspectSeconds: number;
    contactAllowlist: string[];
  };
  runtime: {
    state: 'disabled' | 'starting' | 'monitoring' | 'waiting_desktop' | 'attention_required' | 'error';
    lastScanAt: string | null;
    lastCandidateAt: string | null;
    lastReadAt: string | null;
    lastError: string | null;
  };
  events: DesktopWechatWatchEvent[];
  pendingCount: number;
  sendPolicy: 'confirmation_required';
}

type SetupStep = 'idle' | 'scanning' | 'awaiting_binding' | 'connected';

export function WeChatSettings({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const locale = isZh ? 'zh' : 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [bindingCode, setBindingCode] = useState('');
  const [bindingExpiresAt, setBindingExpiresAt] = useState('');
  const [step, setStep] = useState<SetupStep>('idle');
  const [loading, setLoading] = useState(false);
  const [desktopWatchLoading, setDesktopWatchLoading] = useState(false);
  const [desktopWatchEventBusy, setDesktopWatchEventBusy] = useState('');
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const flowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRunRef = useRef(0);

  const clearFlowPolling = () => {
    flowRunRef.current += 1;
    if (flowTimerRef.current) {
      clearTimeout(flowTimerRef.current);
      flowTimerRef.current = null;
    }
  };

  const loadStatus = async (): Promise<WeChatStatus | null> => {
    try {
      const res = await fetch('/api/wechat/status', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      setStatus(data);
      if (data.personalBound) {
        setBindingCode('');
        setBindingExpiresAt('');
        setStep('connected');
      } else if (data.pendingPersonalBinding?.code) {
        setBindingCode(data.pendingPersonalBinding.code);
        setBindingExpiresAt(data.pendingPersonalBinding.expiresAt || '');
        setStep('awaiting_binding');
      }
      return data;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 5000);
    return () => {
      window.clearInterval(timer);
      clearFlowPolling();
    };
  }, []);

  const startBindingPolling = (expiresAt?: string) => {
    const runId = ++flowRunRef.current;
    const check = async () => {
      if (runId !== flowRunRef.current) return;
      if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
        setBindingCode('');
        setBindingExpiresAt('');
        setStep('idle');
        toast.error(uiMessage('we-chat-settings.binding-code-expired-generate-a.b64d47d418'));
        return;
      }
      const next = await loadStatus();
      if (next?.personalBound) {
        setBindingCode('');
        setBindingExpiresAt('');
        setStep('connected');
        toast.success(uiMessage('we-chat-settings.wechat-is-linked-to-your.403fc1d75f'));
        return;
      }
      flowTimerRef.current = setTimeout(check, 2000);
    };
    flowTimerRef.current = setTimeout(check, 1500);
  };

  const createPersonalBinding = async () => {
    clearFlowPolling();
    setLoading(true);
    try {
      const res = await fetch('/api/wechat/bindings/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scope: 'personal' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('we-chat-settings.failed-to-create-binding-code.ff74a73048'));
      setBindingCode(data.code || '');
      setBindingExpiresAt(data.expiresAt || '');
      setStep('awaiting_binding');
      startBindingPolling(data.expiresAt);
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.failed-to-create-binding-code.ff74a73048'));
    } finally {
      setLoading(false);
    }
  };

  const startQrPolling = (qrId: string) => {
    const runId = ++flowRunRef.current;
    setStep('scanning');
    const check = async () => {
      if (runId !== flowRunRef.current) return;
      try {
        const res = await fetch(`/api/wechat/qrcode/status?qrcode_id=${encodeURIComponent(qrId)}`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (runId !== flowRunRef.current) return;
        if (!res.ok) throw new Error(data.error || uiMessage('we-chat-settings.wechat-authorization-check-failed.8b30f749f1'));
        if (data.status === 'confirmed') {
          setQrCode(null);
          toast.success(uiMessage('we-chat-settings.wechat-bot-authorized-complete-personal.2b1580ab1d'));
          await createPersonalBinding();
          return;
        }
        if (data.status === 'expired') {
          setStep('idle');
          setQrCode(null);
          toast.error(uiMessage('we-chat-settings.qr-code-expired.306efb271c'));
          return;
        }
        flowTimerRef.current = setTimeout(check, 2000);
      } catch (err: any) {
        if (runId !== flowRunRef.current) return;
        if (err?.message) toast.error(err.message);
        flowTimerRef.current = setTimeout(check, 3000);
      }
    };
    flowTimerRef.current = setTimeout(check, 1500);
  };

  const handleGetQR = async () => {
    clearFlowPolling();
    setLoading(true);
    try {
      const res = await fetch('/api/wechat/qrcode', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.qrcode) throw new Error(data.error || uiMessage('we-chat-settings.failed-to-get-qr-code.c70f750df1'));
      const qrId = data.qrcode_id || data.qrcode;
      const qrContent = data.qrcode_img_content || data.qrcode;
      setQrCode(await QRCode.toDataURL(qrContent, { width: 220, margin: 1, errorCorrectionLevel: 'M' }));
      startQrPolling(qrId);
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.network-error.32ea15cb46'));
    } finally {
      setLoading(false);
    }
  };

  const copyBindingCommand = async () => {
    const command = formatMessagingBindingCommand(bindingCode, locale);
    try {
      await navigator.clipboard.writeText(command);
      toast.success(uiMessage('we-chat-settings.binding-command-copied.932649e202'));
    } catch {
      toast.info(command);
    }
  };

  const removePersonalBinding = async () => {
    const bindingId = status?.personalBinding?.id;
    if (!bindingId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/wechat/bindings/${encodeURIComponent(bindingId)}?scope=personal`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || uiMessage('we-chat-settings.failed-to-unlink-wechat.60e63e92b2'));
      setStep('idle');
      await loadStatus();
      toast.success(uiMessage('we-chat-settings.wechat-was-unlinked-from-this.4cfd80c67c'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.failed-to-unlink-wechat.60e63e92b2'));
    } finally {
      setLoading(false);
    }
  };

  const updateDesktopWatch = async (enabled: boolean) => {
    setDesktopWatchLoading(true);
    try {
      const res = await fetch('/api/wechat/desktop-watch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('we-chat-settings.desktop-watch-update-failed.4ae0c83828'));
      await loadStatus();
      toast.success(enabled
        ? uiMessage('we-chat-settings.desktop-watch-enabled.27aa612584')
        : uiMessage('we-chat-settings.desktop-watch-paused.8a90ff899c'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.desktop-watch-update-failed.4ae0c83828'));
    } finally {
      setDesktopWatchLoading(false);
    }
  };

  const scanDesktopWatch = async () => {
    setDesktopWatchLoading(true);
    try {
      const res = await fetch('/api/wechat/desktop-watch/scan', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('we-chat-settings.desktop-watch-scan-failed.4ac560b84c'));
      await loadStatus();
      toast.success(uiMessage('we-chat-settings.desktop-watch-scan-complete.e9d80bd065'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.desktop-watch-scan-failed.4ac560b84c'));
    } finally {
      setDesktopWatchLoading(false);
    }
  };

  const approveDesktopWatchReply = async (event: DesktopWechatWatchEvent) => {
    setDesktopWatchEventBusy(event.id);
    try {
      const res = await fetch(`/api/wechat/desktop-watch/events/${encodeURIComponent(event.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ draft: draftEdits[event.id] ?? event.draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.event?.status !== 'sent') {
        throw new Error(data.event?.error || data.error || uiMessage('we-chat-settings.desktop-watch-send-failed.095456f2e8'));
      }
      await loadStatus();
      toast.success(uiMessage('we-chat-settings.desktop-watch-reply-sent.6e8198661c'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.desktop-watch-send-failed.095456f2e8'));
    } finally {
      setDesktopWatchEventBusy('');
    }
  };

  const dismissDesktopWatchEvent = async (eventId: string) => {
    setDesktopWatchEventBusy(eventId);
    try {
      const res = await fetch(`/api/wechat/desktop-watch/events/${encodeURIComponent(eventId)}/dismiss`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('we-chat-settings.desktop-watch-dismiss-failed.2edee3698f'));
      await loadStatus();
    } catch (err: any) {
      toast.error(err?.message || uiMessage('we-chat-settings.desktop-watch-dismiss-failed.2edee3698f'));
    } finally {
      setDesktopWatchEventBusy('');
    }
  };

  const ready = Boolean(status?.configured && status?.listening && status?.personalBound && !status?.sessionExpired);
  const desktopWatch = status?.desktopWatch;
  const desktopWatchEnabled = Boolean(desktopWatch?.config.enabled);
  const activeDesktopWatchEvents = (desktopWatch?.events || []).filter(event => !['sent', 'dismissed'].includes(event.status));

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${ready ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-amber-300/15 bg-amber-300/[0.06]'}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-300'}`} />
          <span className={`text-xs font-bold ${ready ? 'text-emerald-300' : 'text-amber-200'}`}>
            {ready
              ? uiMessage('we-chat-settings.wechat-messaging-ready.6f4385c7b6')
              : status?.sessionExpired
                ? uiMessage('we-chat-settings.wechat-authorization-expired.206268ffb0')
                : status?.configured
                  ? uiMessage('we-chat-settings.link-this-personal-lumi.773d66e064')
                  : uiMessage('we-chat-settings.wechat-is-not-authorized.95250c0e21')}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-white/45">
          {ready
            ? uiMessage('we-chat-settings.wechat-messages-are-answered-by.24f986c88e')
            : uiMessage('we-chat-settings.authorize-the-bot-by-qr.6f2f6d7d27')}
        </p>
        {status?.lastError && (
          <p className="mt-2 line-clamp-2 text-[11px] text-red-300/75">{status.lastError}</p>
        )}
      </div>

      {qrCode && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
          <img src={qrCode} alt="WeChat QR" className="h-52 w-52 rounded-lg bg-white p-2" />
          <span className="text-xs text-white/55">{uiMessage('we-chat-settings.scan-with-wechat-and-confirm.45ffa162d0')}</span>
        </div>
      )}

      {bindingCode && !status?.personalBound && (
        <div className="space-y-3 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-cyan-200">
            <Link2 size={14} />
            {uiMessage('we-chat-settings.send-this-to-lumi-bot.09044149ed')}
          </div>
          <button
            type="button"
            onClick={copyBindingCommand}
            className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-left font-mono text-xs text-white/80 hover:bg-white/[0.06]"
          >
            <span>{formatMessagingBindingCommand(bindingCode, locale)}</span>
            <Copy size={13} className="text-white/45" />
          </button>
          {bindingExpiresAt && (
            <p className="text-[11px] text-white/35">{uiMessage('we-chat-settings.expires.99d6fe76a5')}{new Date(bindingExpiresAt).toLocaleString()}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!status?.configured || status?.sessionExpired ? (
          <Button onClick={handleGetQR} disabled={loading || status?.canConfigure === false} className="h-9 rounded-lg bg-white/10 text-xs font-bold hover:bg-white/15">
            {loading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
            {uiMessage('we-chat-settings.authorize-wechat.2e93993e92')}
          </Button>
        ) : !status.personalBound && !bindingCode ? (
          <Button onClick={createPersonalBinding} disabled={loading} className="h-9 rounded-lg bg-white/10 text-xs font-bold hover:bg-white/15">
            {loading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Link2 size={14} className="mr-2" />}
            {uiMessage('we-chat-settings.link-personal-lumi.a3b868089c')}
          </Button>
        ) : null}

        {status?.personalBound && (
          <Button onClick={removePersonalBinding} disabled={loading} className="h-9 rounded-lg border border-red-300/15 bg-red-400/[0.06] text-xs font-bold text-red-200 hover:bg-red-400/10">
            <Unlink size={14} className="mr-2" />
            {uiMessage('we-chat-settings.unlink-personal-lumi.f6a455b60a')}
          </Button>
        )}

        {status?.configured && status?.canConfigure && !status?.sessionExpired && (
          <button type="button" onClick={handleGetQR} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-white/40 hover:bg-white/5 hover:text-white/65">
            <RefreshCw size={13} />
            {uiMessage('we-chat-settings.re-authorize-bot.748a606e1a')}
          </button>
        )}
      </div>

      {status?.canConfigure === false && !status?.configured && (
        <p className="text-xs text-white/40">{uiMessage('we-chat-settings.a-local-administrator-must-authorize.f914ade1a6')}</p>
      )}
      {step === 'awaiting_binding' && (
        <p className="text-[11px] text-white/35">{uiMessage('we-chat-settings.waiting-for-the-wechat-binding.f296be8af9')}</p>
      )}

      <div className="border-t border-white/10 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`mt-0.5 rounded-lg p-2 ${desktopWatchEnabled ? 'bg-cyan-400/10 text-cyan-200' : 'bg-white/5 text-white/45'}`}>
              <Monitor size={16} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-xs font-bold text-white">{uiMessage('we-chat-settings.desktop-watch-title.86719d0f47')}</h4>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${desktopWatchEnabled ? 'bg-emerald-400/10 text-emerald-300' : 'bg-white/5 text-white/40'}`}>
                  {desktopWatchEnabled
                    ? uiMessage('we-chat-settings.desktop-watch-running.7c95612f89')
                    : uiMessage('we-chat-settings.desktop-watch-stopped.dbd30abebc')}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                {uiMessage('we-chat-settings.desktop-watch-description.178efc2b3b')}
              </p>
            </div>
          </div>
          <Button
            onClick={() => void updateDesktopWatch(!desktopWatchEnabled)}
            disabled={desktopWatchLoading}
            className={`h-8 shrink-0 rounded-lg px-3 text-[11px] font-bold ${desktopWatchEnabled ? 'border border-red-300/15 bg-red-400/[0.06] text-red-200 hover:bg-red-400/10' : 'bg-cyan-400/15 text-cyan-100 hover:bg-cyan-400/20'}`}
          >
            {desktopWatchLoading && <Loader2 size={12} className="mr-1.5 animate-spin" />}
            {desktopWatchEnabled
              ? uiMessage('we-chat-settings.desktop-watch-pause.7191c2d9bd')
              : uiMessage('we-chat-settings.desktop-watch-enable.83ef3913c3')}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void scanDesktopWatch()}
            disabled={desktopWatchLoading}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-[11px] font-semibold text-white/65 hover:bg-white/10 disabled:opacity-50"
          >
            <Eye size={12} />
            {uiMessage('we-chat-settings.desktop-watch-scan-now.4d9a29c34e')}
          </button>
          {desktopWatch?.runtime.lastScanAt && (
            <span className="text-[10px] text-white/30">
              {uiMessage('we-chat-settings.desktop-watch-last-scan.89e43c4289')}
              {new Date(desktopWatch.runtime.lastScanAt).toLocaleTimeString()}
            </span>
          )}
          {desktopWatch?.pendingCount ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-300/10 px-2 py-1 text-[10px] font-semibold text-amber-200">
              <BellRing size={10} />
              {desktopWatch.pendingCount} {uiMessage('we-chat-settings.desktop-watch-pending.9b39196186')}
            </span>
          ) : null}
        </div>

        {desktopWatch?.runtime.lastError && (
          <p className="mt-2 rounded-lg border border-amber-300/10 bg-amber-300/[0.05] px-3 py-2 text-[11px] leading-relaxed text-amber-100/70">
            {desktopWatch.runtime.lastError}
          </p>
        )}

        {activeDesktopWatchEvents.length > 0 ? (
          <div className="mt-3 space-y-3">
            {activeDesktopWatchEvents.slice(0, 6).map(event => {
              const canSend = Boolean(event.contact && event.draft && ['draft_ready', 'review_required', 'failed'].includes(event.status));
              const busy = desktopWatchEventBusy === event.id;
              return (
                <div key={event.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-xs font-bold text-white">{event.contact || uiMessage('we-chat-settings.desktop-watch-unknown-contact.6fb6d6349a')}</span>
                        {event.risk === 'high' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold text-red-200">
                            <ShieldAlert size={10} />
                            {uiMessage('we-chat-settings.desktop-watch-sensitive.274fe20e82')}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[10px] text-white/30">{new Date(event.detectedAt).toLocaleString()}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void dismissDesktopWatchEvent(event.id)}
                      disabled={busy}
                      className="rounded-md p-1 text-white/30 hover:bg-white/5 hover:text-white/60"
                      title={uiMessage('we-chat-settings.desktop-watch-dismiss.9ccf5d09f2')}
                    >
                      <X size={13} />
                    </button>
                  </div>

                  {event.messageSummary && (
                    <div className="mt-3 rounded-lg bg-white/[0.04] px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-white/30">{uiMessage('we-chat-settings.desktop-watch-summary.5cc2aad5fc')}</p>
                      <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-white/65">{event.messageSummary}</p>
                    </div>
                  )}

                  {event.draft && (
                    <div className="mt-2">
                      <label className="text-[10px] font-semibold uppercase tracking-wide text-white/30" htmlFor={`desktop-wechat-draft-${event.id}`}>
                        {uiMessage('we-chat-settings.desktop-watch-draft.44b27f1b2b')}
                      </label>
                      <textarea
                        id={`desktop-wechat-draft-${event.id}`}
                        value={draftEdits[event.id] ?? event.draft}
                        onChange={e => setDraftEdits(current => ({ ...current, [event.id]: e.target.value }))}
                        rows={3}
                        className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs leading-relaxed text-white/75 outline-none focus:border-cyan-300/30"
                      />
                    </div>
                  )}

                  {event.error && (
                    <p className="mt-2 text-[11px] leading-relaxed text-amber-200/65">{event.error}</p>
                  )}

                  {canSend && (
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className="text-[10px] leading-relaxed text-white/35">{uiMessage('we-chat-settings.desktop-watch-send-confirmation-note.090199b14d')}</p>
                      <Button
                        onClick={() => void approveDesktopWatchReply(event)}
                        disabled={busy || !(draftEdits[event.id] ?? event.draft).trim()}
                        className="h-8 shrink-0 rounded-lg bg-emerald-400/15 px-3 text-[11px] font-bold text-emerald-200 hover:bg-emerald-400/20"
                      >
                        {busy ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : <Send size={12} className="mr-1.5" />}
                        {uiMessage('we-chat-settings.desktop-watch-confirm-send.8998ae12ed')}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-white/30">{uiMessage('we-chat-settings.desktop-watch-no-pending.ef9e4a5da4')}</p>
        )}
      </div>
    </div>
  );
}
