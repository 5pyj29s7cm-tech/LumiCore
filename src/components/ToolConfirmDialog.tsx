import { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldAlert, Check, X, AlertTriangle, Infinity } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { motion, AnimatePresence } from 'motion/react';
import { systemService } from '@/services/systemService';
import { useT } from '../lib/useT';

interface PendingConfirm {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
}

type ToolRisk = 'low' | 'medium' | 'high';

function getSensitiveClientAction(args: Record<string, any> = {}): string {
  const action = String(args.action || '').trim();
  const mode = String(args.mode || '').trim();
  if (!action) return '';
  if (action === 'start_meeting_mode' || action === 'end_meeting_mode' || action === 'set_wallpaper_mode') return action;
  if ((action === 'set_mode' || action === 'set_client_mode') && (mode === 'meeting' || mode === 'autonomous')) return `${action}:${mode}`;
  return '';
}

function getToolRisk(name: string, args: Record<string, any> = {}): ToolRisk {
  const normalized = name.toLowerCase();
  const argText = JSON.stringify(args || {}).toLowerCase();
  if (normalized === 'client_action' && getSensitiveClientAction(args)) return 'high';
  if (normalized.includes('delete') || normalized.includes('remove') || normalized.includes('rm') || normalized.includes('install') || normalized.includes('uninstall')) return 'high';
  if (/\b(rm\s+-rf|format\b|shutdown\b|reboot\b|reg\s+delete|drop\s+table|delete\s+from)\b/i.test(argText)) return 'high';
  if (/\b(?:npm|pnpm|yarn|bun|pip|pip3|uv|cargo|go|gem|winget|choco|scoop|brew)\s+(?:i|install|add|update|upgrade|remove|uninstall|audit\s+fix)\b/i.test(argText)) return 'high';
  if (/\bgit\s+(?:commit|push|tag|merge|rebase|reset|checkout|clean|branch\s+-d|branch\s+-D)\b/i.test(argText) || /^git_(?:commit|push|tag|merge|rebase|reset)/i.test(normalized)) return 'high';
  if (normalized.includes('run_command') || normalized.includes('terminal') || normalized.includes('shell')) return 'high';
  if (/(send|post|submit|publish|purchase|buy|transfer|pay|checkout)/i.test(normalized) || /(send|post|submit|publish|purchase|buy|transfer|pay|checkout|付款|支付|转账|购买|下单|提交|发布|发送)/i.test(argText)) return 'high';
  if (normalized.includes('wechat') || normalized.includes('message') || normalized.includes('desktop_') || normalized.includes('mouse') || normalized.includes('keyboard')) return 'medium';
  if (normalized === 'computer_use' || normalized.startsWith('desktop_ui_') || normalized.includes('playwright') || normalized.includes('browser_')) return 'medium';
  if (normalized.includes('write') || normalized.includes('save') || normalized.includes('publish') || normalized.includes('install')) return 'medium';
  return 'low';
}

function getRiskCopy(risk: ToolRisk, t: any) {
  if (risk === 'high') {
    return {
      label: t.highRiskAction || 'High-risk action',
      note: t.highRiskActionNote || 'Auto-approve and Always Allow are disabled for this request.',
      className: 'border-red-500/30 bg-red-500/10 text-red-300',
    };
  }
  if (risk === 'medium') {
    return {
      label: t.confirmAction || 'Confirm action',
      note: t.confirmActionNote || 'This may change app state, files, clipboard, or the desktop.',
      className: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
    };
  }
  return {
    label: t.lowRiskAction || 'Permission required',
    note: t.lowRiskActionNote || 'Review the request before allowing Lumi to continue.',
    className: 'border-white/10 bg-white/5 text-white/55',
  };
}

/**
 * Tool confirmation dialog with session-level auto-approve and global allow-all toggle.
 * When allowAll is enabled, all confirm tools auto-pass without showing the dialog.
 * "Always Allow" adds the tool name to a session whitelist.
 */
export function ToolConfirmDialog({ socket, isWallpaperMode = false }: { socket: any; isWallpaperMode?: boolean }) {
  const [pending, setPending] = useState<PendingConfirm[]>([]);
  const [autoApproved, setAutoApproved] = useState<Set<string>>(new Set());
  const [allowAll, setAllowAll] = useState(() => {
    try { return localStorage.getItem('lumi_auto_approve') === 'true'; } catch { return false; }
  });
  const wasWallpaperRef = useRef(false);
  const t = useT();

  const toggleAllowAll = () => {
    const next = !allowAll;
    setAllowAll(next);
    localStorage.setItem('lumi_auto_approve', String(next));
  };

  // Temporarily exit wallpaper mode while confirm dialog is showing
  useEffect(() => {
    if (pending.length > 0 && isWallpaperMode) {
      wasWallpaperRef.current = true;
      systemService.setWallpaperMode(false);
    } else if (pending.length === 0 && wasWallpaperRef.current) {
      wasWallpaperRef.current = false;
      systemService.setWallpaperMode(true);
    }
  }, [pending.length, isWallpaperMode]);

  useEffect(() => {
    if (!socket) return;

    const handleConfirm = (data: { correlationId: string; name: string; arguments: Record<string, any> }) => {
      // 1. Global allow-all — auto pass
      const risk = getToolRisk(data.name, data.arguments || {});
      const canAutoApprove = risk !== 'high';
      if (allowAll && canAutoApprove) {
        socket.emit(`tool:confirm_result:${data.correlationId}`, { correlationId: data.correlationId, allowed: true });
        return;
      }
      // 2. Session-level auto-approve for this tool
      if (autoApproved.has(data.name) && canAutoApprove) {
        socket.emit(`tool:confirm_result:${data.correlationId}`, { correlationId: data.correlationId, allowed: true });
        return;
      }
      // 3. Show dialog
      setPending(prev => [...prev, data]);
    };

    socket.on('agent:confirm_tool', handleConfirm);
    return () => { socket.off('agent:confirm_tool', handleConfirm); };
  }, [socket, allowAll, autoApproved]);

  const respond = useCallback((correlationId: string, allowed: boolean) => {
    socket?.emit(`tool:confirm_result:${correlationId}`, { correlationId, allowed });
    setPending(prev => prev.filter(p => p.correlationId !== correlationId));
  }, [socket]);

  const allowAlways = useCallback((correlationId: string, toolName: string) => {
    const request = pending.find(p => p.correlationId === correlationId);
    const risk = getToolRisk(toolName, request?.arguments || {});
    if (risk !== 'high') {
      setAutoApproved(prev => new Set(prev).add(toolName));
    }
    socket?.emit(`tool:confirm_result:${correlationId}`, { correlationId, allowed: true });
    setPending(prev => prev.filter(p => p.correlationId !== correlationId));
  }, [pending, socket]);

  // Sync allowAll from other tabs (storage event)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'lumi_auto_approve') {
        setAllowAll(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const current = pending[0];
  const currentRisk = current ? getToolRisk(current.name, current.arguments || {}) : 'low';
  const riskCopy = getRiskCopy(currentRisk, t);
  const canAlwaysAllow = currentRisk !== 'high';

  const dialog = (
    <AnimatePresence>
      {current && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => respond(current.correlationId, false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            onClick={e => e.stopPropagation()}
            className="bg-zinc-900 border border-yellow-500/30 rounded-[2rem] p-8 max-w-md w-full mx-4 shadow-2xl"
          >
            {/* Header with global toggle */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-yellow-500/10 rounded-2xl">
                  <ShieldAlert size={24} className="text-yellow-400" />
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest text-yellow-400">{t.toolAuthorization || 'Tool Authorization'}</h3>
                  <p className="text-xs text-white/55 mt-0.5">{t.toolExplicitPermission || 'This tool requires your explicit permission'}</p>
                </div>
              </div>
              {/* Global allow-all toggle */}
              <button
                onClick={toggleAllowAll}
                title={currentRisk === 'high' ? (t.highRiskAutoApproveDisabled || 'Auto-approve does not apply to high-risk actions') : undefined}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${allowAll ? 'bg-emerald-500' : 'bg-white/10'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${allowAll ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <p className="text-[12px] text-white/40 mb-4">
              {t.autoApproveDesc || 'Enable to auto-approve all tools. Disable to restore per-tool confirmations.'}
            </p>

            <div className={`mb-4 rounded-xl border px-3 py-2 text-xs leading-relaxed ${riskCopy.className}`}>
              <div className="font-black uppercase tracking-widest">{riskCopy.label}</div>
              <div className="mt-1 opacity-80">{riskCopy.note}</div>
            </div>

            {/* Tool info */}
            <div className="space-y-4">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={14} className="text-yellow-400" />
                  <span className="text-xs font-bold text-white/80 font-mono">{current.name}</span>
                </div>
                {Object.keys(current.arguments).length > 0 && (
                  <pre className="text-xs text-white/40 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto custom-scrollbar">
                    {JSON.stringify(current.arguments, null, 2)}
                  </pre>
                )}
              </div>

              {pending.length > 1 && (
                <p className="text-xs text-white/45 text-center">
                  {pending.length - 1} {t.moreToolsWaiting || 'more tool waiting'}
                </p>
              )}

              {/* Three action buttons */}
              <div className="flex items-center gap-2.5">
                <Button
                  onClick={() => respond(current.correlationId, false)}
                  className="flex-1 bg-white/5 text-white/60 hover:bg-white/10 font-bold text-xs px-3 py-3 rounded-xl border border-white/10 transition-all"
                >
                  <X size={14} className="mr-1" /> {t.deny || 'Deny'}
                </Button>
                <Button
                  onClick={() => respond(current.correlationId, true)}
                  className="flex-1 bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 font-bold text-xs px-3 py-3 rounded-xl border border-yellow-500/30 transition-all"
                >
                  <Check size={14} className="mr-1" /> {t.allow || 'Allow'}
                </Button>
                <Button
                  onClick={() => allowAlways(current.correlationId, current.name)}
                  disabled={!canAlwaysAllow}
                  title={!canAlwaysAllow ? (t.highRiskAlwaysDisabled || 'High-risk actions cannot be always allowed') : undefined}
                  className="flex-1 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 font-bold text-xs px-3 py-3 rounded-xl border border-emerald-500/30 transition-all disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/25 disabled:border-white/10"
                >
                  <Infinity size={14} className="mr-1" /> {t.alwaysAllow || 'Always'}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(dialog, document.body);
}
