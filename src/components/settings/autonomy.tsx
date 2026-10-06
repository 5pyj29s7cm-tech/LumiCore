import { unifiedCoreCopy } from "../../i18n/locales/unifiedCore";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/services/apiClient";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";

export type AutonomyGateConfig = {
  autonomyLevel: 'reactive' | 'semi' | 'full';
  alwaysOnline: boolean;
  autoProcessEnabled: boolean;
  messagingSendRequiresConfirmation: boolean;
  maxConsecutiveTasks: number;
  allowedHours: { start: number; end: number }[];
  requireIdle: boolean;
  minIdleSeconds: number;
  maxTokensPerHour: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
};

export type NativeRuntimeStatus = {
  platform: string;
  autostart_supported: boolean;
  autostart_enabled: boolean;
  autostart_entry: string;
  close_to_background: boolean;
  started_in_background: boolean;
  backend_node_running: boolean;
  backend_python_running: boolean;
  node_restarts: number;
  python_restarts: number;
  global_shortcut: string;
  notes: string[];
};

export const DEFAULT_AUTONOMY_GATE: AutonomyGateConfig = {
  autonomyLevel: 'semi',
  alwaysOnline: true,
  autoProcessEnabled: true,
  messagingSendRequiresConfirmation: false,
  maxConsecutiveTasks: 6,
  allowedHours: [{ start: 0, end: 24 }],
  requireIdle: false,
  minIdleSeconds: 0,
  maxTokensPerHour: 30000,
};

export function AutonomousSettingsPanel({ t }: { t: any }) {
  const coreCopy = unifiedCoreCopy(t?.langCode === 'en' ? 'en' : 'zh');
  const [gateSaving, setGateSaving] = useState(false);
  const [gateConfig, setGateConfig] = useState<AutonomyGateConfig>(DEFAULT_AUTONOMY_GATE);
  const [nativeRuntime, setNativeRuntime] = useState<NativeRuntimeStatus | null>(null);
  const [nativeRuntimeError, setNativeRuntimeError] = useState('');
  const [taskList, setTaskList] = useState<any[]>([]);
  const [tasksExpanded, setTasksExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/autonomy/gate_config')
      .then(r => r.json())
      .then(d => setGateConfig({ ...DEFAULT_AUTONOMY_GATE, ...(d || {}) }))
      .catch(() => {});
    fetch('/api/scheduler/tasks')
      .then(r => r.json())
      .then(d => setTaskList(d.tasks || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadNativeRuntime = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke<NativeRuntimeStatus>('get_runtime_resilience_status');
        if (!cancelled) {
          setNativeRuntime(status);
          setNativeRuntimeError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setNativeRuntime(null);
          setNativeRuntimeError(err?.message || uiMessage('settings.native-runtime-controls-are-only.242e691b46'));
        }
      }
    };
    void loadNativeRuntime();
    timer = window.setInterval(loadNativeRuntime, 30000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  const updateBackgroundPolicy = async (patch: Partial<AutonomyGateConfig>) => {
    if (gateSaving) return;
    setGateSaving(true);
    try {
      const response = await apiFetch('/api/autonomy/gate_config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('save_failed');
      setGateConfig(await response.json());
    } catch { toast.error(coreCopy.failed); }
    finally { setGateSaving(false); }
  };

  const refreshNativeRuntime = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await invoke<NativeRuntimeStatus>('get_runtime_resilience_status');
    setNativeRuntime(status);
    setNativeRuntimeError('');
    return status;
  };

  const updateNativeRuntime = async (kind: 'autostart' | 'closeToBackground', enabled: boolean) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (kind === 'autostart') {
        await invoke('set_autostart_enabled', { enabled });
      } else {
        localStorage.setItem('lumi_close_to_background', String(enabled));
        await invoke('set_close_to_background', { enabled });
      }
      await refreshNativeRuntime();
      toast.success(enabled ? uiMessage('settings.enabled.4508d98328') : uiMessage('settings.disabled.68b069bc6a'));
    } catch (err: any) {
      toast.error(err?.message || uiMessage('settings.failed-to-update-native-runtime.6cdad0027d'));
    }
  };

  const invokeRuntimeAction = async (action: 'hide' | 'quit') => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(action === 'hide' ? 'hide_to_background' : 'quit_app');
    } catch (err: any) {
      toast.error(err?.message || uiMessage('settings.runtime-action-failed.2d63d1e37a'));
    }
  };

  const toggleTask = async (taskId: string) => {
    try {
      const r = await fetch(`/api/scheduler/tasks/${taskId}/toggle`, { method: 'POST', credentials: 'include' });
      const data = await r.json();
      setTaskList(prev => prev.map(t => t.id === taskId ? { ...t, enabled: data.enabled } : t));
    } catch {}
  };

  const ToggleRow = ({
    label,
    desc,
    checked,
    onClick,
    danger,
  }: {
    label: string;
    desc: string;
    checked: boolean;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-black/18 px-3 py-3">
      <div>
        <div className="text-xs font-bold text-white/72">{label}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-white/36">{desc}</div>
      </div>
      <button
        onClick={onClick}
        className={`h-5 w-10 shrink-0 rounded-full transition-all ${checked ? (danger ? 'bg-amber-400' : 'bg-cyan-500') : 'bg-white/10'}`}
      >
        <div className={`h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <fieldset disabled={gateSaving} className="space-y-3 rounded-2xl border border-white/5 bg-white/5 p-4 disabled:opacity-60">
        <div className="text-xs font-bold text-white/70">{coreCopy.backgroundTitle}</div>
        <p className="text-xs leading-relaxed text-white/40">{coreCopy.backgroundDetail}</p>
        <ToggleRow label={coreCopy.enabled} desc={coreCopy.enabledDetail}
          checked={gateConfig.autoProcessEnabled}
          onClick={() => void updateBackgroundPolicy({ autoProcessEnabled: !gateConfig.autoProcessEnabled })} />
        <ToggleRow label={coreCopy.idle} desc={coreCopy.idleDetail}
          checked={gateConfig.requireIdle}
          onClick={() => void updateBackgroundPolicy({ requireIdle: !gateConfig.requireIdle })} />
      </fieldset>

      {/* Resident Runtime */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <div>
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.native-resident-runtime.a56bca847b')}</div>
          <p className="text-xs text-white/40 mt-1">{uiMessage('settings.controls-whether-the-desktop-client.0b21f43460')}</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-black/18 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-white/72">{uiMessage('settings.native-resident-runtime.f3f4af60e9')}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-white/36">
                {uiMessage('settings.controls-whether-the-installed-desktop.aa6963a96d')}
              </div>
            </div>
            <button
              onClick={() => refreshNativeRuntime().catch((err: any) => toast.error(err?.message || uiMessage('settings.runtime-refresh-failed.c51da4aaaa')))}
              className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-white/45 hover:bg-white/[0.08] hover:text-white"
            >
              {uiMessage('settings.refresh.cba212b169')}
            </button>
          </div>
          {nativeRuntime ? (
            <div className="space-y-2">
              <ToggleRow
                label={uiMessage('settings.launch-at-login.2485b7c036')}
                desc={nativeRuntime.autostart_supported ? uiMessage('settings.starts-lumi-with-background-for.a33dc15a9d') : uiMessage('settings.launch-at-login-is-not.1796e70780')}
                checked={nativeRuntime.autostart_enabled}
                onClick={() => nativeRuntime.autostart_supported && updateNativeRuntime('autostart', !nativeRuntime.autostart_enabled)}
              />
              <ToggleRow
                label={uiMessage('settings.close-button-hides-to-background.788eb15250')}
                desc={uiMessage('settings.the-top-close-button-and.2777d97f38')}
                checked={nativeRuntime.close_to_background}
                onClick={() => updateNativeRuntime('closeToBackground', !nativeRuntime.close_to_background)}
              />
              <div className="grid grid-cols-2 gap-2 text-[11px] text-white/42">
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.platform.3ffff3f363')}: {nativeRuntime.platform}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.shortcut.51a35f7d60')}: {nativeRuntime.global_shortcut}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.backend.9c17db77f8')}: {nativeRuntime.backend_node_running ? uiMessage('settings.running.4ac4390de9') : uiMessage('settings.dev-not-spawned.42b82413a9')}</div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">{uiMessage('settings.restarts.04fb20829b')}: {nativeRuntime.node_restarts}</div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => invokeRuntimeAction('hide')}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white/50 hover:bg-white/[0.08] hover:text-white"
                >
                  {uiMessage('settings.hide-now.f08e6a7f7b')}
                </button>
                <button
                  onClick={() => invokeRuntimeAction('quit')}
                  className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-200/70 hover:bg-red-400/15 hover:text-red-100"
                >
                  {uiMessage('settings.quit-lumi.df32c5974e')}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/38">
              {nativeRuntimeError || uiMessage('settings.native-runtime-status-is-loading.4a6aed02cd')}
            </div>
          )}
        </div>
      </div>

      {/* Scheduler Tasks */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <button onClick={() => setTasksExpanded(!tasksExpanded)} className="w-full flex items-center justify-between">
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.scheduled-routines.5f06751a14', t?.langCode === 'en' ? 'en' : 'zh')}</div>
          <ChevronDown size={14} className={`text-white/40 transition-transform ${tasksExpanded ? 'rotate-180' : ''}`} />
        </button>

        {tasksExpanded && (
          <div className="max-h-60 overflow-y-auto custom-scrollbar space-y-1">
            {taskList.map((task: any) => (
              <div key={task.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02]">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white/60 truncate">{task.id}</div>
                  <div className="text-[11px] text-white/30">{task.cron} {task.lastRun ? formatUiMessage('settings.last-value0.ad05dbfaea', { value0: new Date(task.lastRun).toLocaleTimeString() }) : ''}</div>
                </div>
                <button
                  onClick={() => toggleTask(task.id)}
                  className={`w-8 h-4 rounded-full transition-all ${task.enabled !== false ? 'bg-cyan-500/50' : 'bg-white/10'}`}
                >
                  <div className={`w-3 h-3 rounded-full bg-white transition-transform ${task.enabled !== false ? 'translate-x-[18px]' : 'translate-x-[1px]'}`} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
