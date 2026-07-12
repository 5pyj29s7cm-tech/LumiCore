import { useEffect, useRef, useState } from 'react';
import { Copy, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react';
import QRCode from 'qrcode';
import { Button } from './ui/button';
import { toast } from 'sonner';

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
}

type SetupStep = 'idle' | 'scanning' | 'awaiting_binding' | 'connected';

export function WeChatSettings({ t }: { t?: any }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [bindingCode, setBindingCode] = useState('');
  const [bindingExpiresAt, setBindingExpiresAt] = useState('');
  const [step, setStep] = useState<SetupStep>('idle');
  const [loading, setLoading] = useState(false);
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
        toast.error(ui('绑定码已过期，请重新生成', 'Binding code expired. Generate a new one.'));
        return;
      }
      const next = await loadStatus();
      if (next?.personalBound) {
        setBindingCode('');
        setBindingExpiresAt('');
        setStep('connected');
        toast.success(ui('微信已绑定到个人 Lumi', 'WeChat is linked to your personal Lumi'));
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
      if (!res.ok) throw new Error(data.error || ui('生成绑定码失败', 'Failed to create binding code'));
      setBindingCode(data.code || '');
      setBindingExpiresAt(data.expiresAt || '');
      setStep('awaiting_binding');
      startBindingPolling(data.expiresAt);
    } catch (err: any) {
      toast.error(err?.message || ui('生成绑定码失败', 'Failed to create binding code'));
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
        if (!res.ok) throw new Error(data.error || ui('微信授权检查失败', 'WeChat authorization check failed'));
        if (data.status === 'confirmed') {
          setQrCode(null);
          toast.success(ui('微信 Bot 已授权，请完成个人绑定', 'WeChat Bot authorized. Complete personal linking.'));
          await createPersonalBinding();
          return;
        }
        if (data.status === 'expired') {
          setStep('idle');
          setQrCode(null);
          toast.error(ui('二维码已过期', 'QR code expired'));
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
      if (!res.ok || !data.qrcode) throw new Error(data.error || ui('获取二维码失败', 'Failed to get QR code'));
      const qrId = data.qrcode_id || data.qrcode;
      const qrContent = data.qrcode_img_content || data.qrcode;
      setQrCode(await QRCode.toDataURL(qrContent, { width: 220, margin: 1, errorCorrectionLevel: 'M' }));
      startQrPolling(qrId);
    } catch (err: any) {
      toast.error(err?.message || ui('网络错误', 'Network error'));
    } finally {
      setLoading(false);
    }
  };

  const copyBindingCommand = async () => {
    const command = `绑定 Lumi ${bindingCode}`;
    try {
      await navigator.clipboard.writeText(command);
      toast.success(ui('绑定命令已复制', 'Binding command copied'));
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
      if (!res.ok || !data.success) throw new Error(data.error || ui('解除绑定失败', 'Failed to unlink WeChat'));
      setStep('idle');
      await loadStatus();
      toast.success(ui('已解除当前个人 Lumi 的微信绑定', 'WeChat was unlinked from this personal Lumi'));
    } catch (err: any) {
      toast.error(err?.message || ui('解除绑定失败', 'Failed to unlink WeChat'));
    } finally {
      setLoading(false);
    }
  };

  const ready = Boolean(status?.configured && status?.listening && status?.personalBound && !status?.sessionExpired);

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${ready ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-amber-300/15 bg-amber-300/[0.06]'}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-300'}`} />
          <span className={`text-xs font-bold ${ready ? 'text-emerald-300' : 'text-amber-200'}`}>
            {ready
              ? ui('微信收发已就绪', 'WeChat messaging ready')
              : status?.sessionExpired
                ? ui('微信授权已失效', 'WeChat authorization expired')
                : status?.configured
                  ? ui('还需绑定当前个人 Lumi', 'Link this personal Lumi')
                  : ui('微信尚未授权', 'WeChat is not authorized')}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-white/45">
          {ready
            ? ui('微信消息会由个人 Lumi 回复，并同步显示在主聊天中。', 'WeChat messages are answered by your personal Lumi and synchronized to the main chat.')
            : ui('扫码授权 Bot 后，在微信中发送一次绑定命令即可完成连接。', 'Authorize the Bot by QR, then send the one-time binding command in WeChat.')}
        </p>
        {status?.lastError && (
          <p className="mt-2 line-clamp-2 text-[11px] text-red-300/75">{status.lastError}</p>
        )}
      </div>

      {qrCode && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
          <img src={qrCode} alt="WeChat QR" className="h-52 w-52 rounded-lg bg-white p-2" />
          <span className="text-xs text-white/55">{ui('用微信扫码并确认授权', 'Scan with WeChat and confirm authorization')}</span>
        </div>
      )}

      {bindingCode && !status?.personalBound && (
        <div className="space-y-3 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-cyan-200">
            <Link2 size={14} />
            {ui('在微信 Lumi Bot 中发送', 'Send this to Lumi Bot in WeChat')}
          </div>
          <button
            type="button"
            onClick={copyBindingCommand}
            className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-left font-mono text-xs text-white/80 hover:bg-white/[0.06]"
          >
            <span>{`绑定 Lumi ${bindingCode}`}</span>
            <Copy size={13} className="text-white/45" />
          </button>
          {bindingExpiresAt && (
            <p className="text-[11px] text-white/35">{ui('有效期至：', 'Expires: ')}{new Date(bindingExpiresAt).toLocaleString()}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!status?.configured || status?.sessionExpired ? (
          <Button onClick={handleGetQR} disabled={loading || status?.canConfigure === false} className="h-9 rounded-lg bg-white/10 text-xs font-bold hover:bg-white/15">
            {loading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RefreshCw size={14} className="mr-2" />}
            {ui('扫码授权微信', 'Authorize WeChat')}
          </Button>
        ) : !status.personalBound && !bindingCode ? (
          <Button onClick={createPersonalBinding} disabled={loading} className="h-9 rounded-lg bg-white/10 text-xs font-bold hover:bg-white/15">
            {loading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Link2 size={14} className="mr-2" />}
            {ui('绑定当前个人 Lumi', 'Link Personal Lumi')}
          </Button>
        ) : null}

        {status?.personalBound && (
          <Button onClick={removePersonalBinding} disabled={loading} className="h-9 rounded-lg border border-red-300/15 bg-red-400/[0.06] text-xs font-bold text-red-200 hover:bg-red-400/10">
            <Unlink size={14} className="mr-2" />
            {ui('解除个人绑定', 'Unlink Personal Lumi')}
          </Button>
        )}

        {status?.configured && status?.canConfigure && !status?.sessionExpired && (
          <button type="button" onClick={handleGetQR} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-white/40 hover:bg-white/5 hover:text-white/65">
            <RefreshCw size={13} />
            {ui('重新授权 Bot', 'Re-authorize Bot')}
          </button>
        )}
      </div>

      {status?.canConfigure === false && !status?.configured && (
        <p className="text-xs text-white/40">{ui('需要本机管理员先授权微信 Bot。', 'A local administrator must authorize the WeChat Bot first.')}</p>
      )}
      {step === 'awaiting_binding' && (
        <p className="text-[11px] text-white/35">{ui('正在等待微信绑定消息...', 'Waiting for the WeChat binding message...')}</p>
      )}
    </div>
  );
}
