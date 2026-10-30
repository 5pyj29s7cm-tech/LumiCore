import { unifiedCoreCopy } from "../../i18n/locales/unifiedCore";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/services/apiClient";
import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { useApp } from "@/contexts/AppContext";
import { settingsRecoveryCopy } from '@/i18n/locales/settingsRecovery';

async function boundedNativeResult<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native runtime did not respond')), 10_000); })]);
  } finally { clearTimeout(timer); }
}

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
  const recovery = settingsRecoveryCopy(t?.langCode);
  const nativeWrite = useRef(false);
  const [nativeSaving, setNativeSaving] = useState(false);
  const [nativeSaveError, setNativeSaveError] = useState(false);
  const { user, workDomain, orgConnection } = useApp();
  const scope = JSON.stringify([user?.uid, user?.role, workDomain, orgConnection?.orgId, orgConnection?.orgRole]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  type BackgroundPolicy = Pick<AutonomyGateConfig, 'autoProcessEnabled' | 'requireIdle'>;
  type ScheduledTask = { id: string; enabled: boolean; cron?: string; lastRun?: string };
  const policy = (value: any): BackgroundPolicy => {
    if (typeof value?.autoProcessEnabled !== 'boolean' || typeof value?.requireIdle !== 'boolean') throw new Error('invalid_background_policy');
    return { autoProcessEnabled: value.autoProcessEnabled, requireIdle: value.requireIdle };
  };
  const [gateSaving, setGateSaving] = useState(false);
  const [gateState, setGateState] = useState<{ scope: string; value: BackgroundPolicy | null; error: boolean }>({ scope, value: null, error: false });
  const [gateRetry, setGateRetry] = useState(0);
  const [gateSaveState, setGateSaveState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const gateMutation = useRef<AbortController | null>(null);
  const gateConfig = gateState.scope === scope ? gateState.value : null;
  const gateError = gateState.scope === scope && gateState.error;
  const [nativeRuntime, setNativeRuntime] = useState<NativeRuntimeStatus | null>(null);
  const [nativeRuntimeError, setNativeRuntimeError] = useState('');
  const [taskState, setTaskState] = useState<{ scope: string; value: ScheduledTask[] | null; error: boolean }>({ scope, value: null, error: false });
  const [taskRetry, setTaskRetry] = useState(0);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskSaveState, setTaskSaveState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const taskMutation = useRef<AbortController | null>(null);
  const taskList = taskState.scope === scope ? taskState.value : null;
  const taskError = taskState.scope === scope && taskState.error;
  const [tasksExpanded, setTasksExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setGateState({ scope, value: null, error: false });
    setGateSaveState('idle');
    setGateSaving(false);
    void (async () => {
      try {
        if (!user?.uid) throw new Error('authentication_required');
        const response = await fetch('/api/autonomy/gate_config', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error('load_failed');
        const value = policy(await response.json());
        if (!controller.signal.aborted && currentScope.current === scope) setGateState({ scope, value, error: false });
      } catch {
        if (!controller.signal.aborted && currentScope.current === scope) setGateState({ scope, value: null, error: true });
      }
    })();
    return () => { controller.abort(); gateMutation.current?.abort(); gateMutation.current = null; };
  }, [scope, gateRetry]);

  useEffect(() => {
    const controller = new AbortController();
    setTaskState({ scope, value: null, error: false });
    setTaskSaveState('idle');
    setTaskSaving(false);
    void (async () => {
      try {
        if (!user?.uid) throw new Error('authentication_required');
        const response = await fetch('/api/scheduler/tasks', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error('load_failed');
        const body = await response.json();
        if (!Array.isArray(body?.tasks) || !body.tasks.every((task: any) => typeof task?.id === 'string' && typeof task.enabled === 'boolean')) throw new Error('invalid_tasks');
        if (!controller.signal.aborted && currentScope.current === scope) setTaskState({ scope, value: body.tasks, error: false });
      } catch {
        if (!controller.signal.aborted && currentScope.current === scope) setTaskState({ scope, value: null, error: true });
      }
    })();
    return () => { controller.abort(); taskMutation.current?.abort(); taskMutation.current = null; };
  }, [scope, taskRetry]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadNativeRuntime = async () => {
      if (nativeWrite.current) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await boundedNativeResult(invoke<NativeRuntimeStatus>('get_runtime_resilience_status'));
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
    if (!gateConfig || gateMutation.current) return;
    const controller = new AbortController();
    gateMutation.current = controller;
    setGateSaving(true);
    setGateSaveState('idle');
    try {
      const response = await apiFetch('/api/autonomy/gate_config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error('save_failed');
      const value = policy(await response.json());
      if (!Object.entries(patch).every(([key, expected]) => value[key as keyof BackgroundPolicy] === expected)) throw new Error('unconfirmed_save');
      if (!controller.signal.aborted && currentScope.current === scope) {
        setGateState({ scope, value, error: false }); setGateSaveState('saved');
      }
    } catch {
      if (!controller.signal.aborted && currentScope.current === scope) { setGateSaveState('failed'); toast.error(coreCopy.failed); }
    } finally {
      if (gateMutation.current === controller) { gateMutation.current = null; setGateSaving(false); }
    }
  };

  const refreshNativeRuntime = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await boundedNativeResult(invoke<NativeRuntimeStatus>('get_runtime_resilience_status'));
    setNativeRuntime(status);
    setNativeRuntimeError('');
    return status;
  };

  const updateNativeRuntime = async (kind: 'autostart' | 'closeToBackground', enabled: boolean) => {
    if (nativeWrite.current) return;
    nativeWrite.current = true; setNativeSaving(true); setNativeSaveError(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const confirmed = await boundedNativeResult(invoke(kind === 'autostart' ? 'set_autostart_enabled' : 'set_close_to_background', { enabled }));
      if (confirmed !== enabled) throw new Error(recovery.nativeFailed);
      if (kind === 'closeToBackground') {
        localStorage.setItem('lumi_close_to_background', String(enabled));
      }
      setNativeRuntime(previous => previous ? { ...previous, [kind === 'autostart' ? 'autostart_enabled' : 'close_to_background']: enabled } : previous);
      await refreshNativeRuntime();
      toast.success(enabled ? uiMessage('settings.enabled.4508d98328') : uiMessage('settings.disabled.68b069bc6a'));
    } catch (err: any) {
      setNativeSaveError(true);
      toast.error(err?.message || uiMessage('settings.failed-to-update-native-runtime.6cdad0027d'));
    } finally {
      nativeWrite.current = false; setNativeSaving(false);
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
    if (!taskList || taskMutation.current || taskSaveState === 'failed') return;
    const controller = new AbortController();
    taskMutation.current = controller;
    setTaskSaving(true); setTaskSaveState('idle');
    try {
      const r = await apiFetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/toggle`, { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!r.ok) throw new Error('save_failed');
      const data = await r.json();
      if (data?.id !== taskId || typeof data.enabled !== 'boolean') throw new Error('invalid_task_receipt');
      if (!controller.signal.aborted && currentScope.current === scope) {
        setTaskState(prev => prev.scope === scope ? { ...prev, value: prev.value?.map(task => task.id === taskId ? { ...task, enabled: data.enabled } : task) || null } : prev);
        setTaskSaveState('saved');
      }
    } catch {
      if (!controller.signal.aborted && currentScope.current === scope) { setTaskSaveState('failed'); toast.error(coreCopy.taskFailed); }
    } finally {
      if (taskMutation.current === controller) { taskMutation.current = null; setTaskSaving(false); }
    }
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
        type="button" aria-label={label} aria-pressed={checked}
        onClick={onClick}
        className={`h-5 w-10 shrink-0 rounded-full transition-all ${checked ? (danger ? 'bg-amber-400' : 'bg-cyan-500') : 'bg-white/10'}`}
      >
        <div className={`h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {gateError ? <div role="alert" className="text-xs text-amber-200">{coreCopy.loadFailed} <button type="button" onClick={() => setGateRetry(value => value + 1)} className="underline">{coreCopy.retry}</button></div>
        : !gateConfig && <p role="status" className="text-xs text-white/50">{coreCopy.loading}</p>}
      <fieldset disabled={!gateConfig || gateSaving} className="space-y-3 rounded-2xl border border-white/5 bg-white/5 p-4 disabled:opacity-60">
        <div className="text-xs font-bold text-white/70">{coreCopy.backgroundTitle}</div>
        <p className="text-xs leading-relaxed text-white/40">{coreCopy.backgroundDetail}</p>
        <ToggleRow label={coreCopy.enabled} desc={coreCopy.enabledDetail}
          checked={gateConfig?.autoProcessEnabled ?? false}
          onClick={() => void updateBackgroundPolicy({ autoProcessEnabled: !gateConfig?.autoProcessEnabled })} />
        <ToggleRow label={coreCopy.idle} desc={coreCopy.idleDetail}
          checked={gateConfig?.requireIdle ?? false}
          onClick={() => void updateBackgroundPolicy({ requireIdle: !gateConfig?.requireIdle })} />
      </fieldset>
      {gateSaving && <p role="status" className="text-xs text-white/50">{coreCopy.saving}</p>}
      {gateSaveState === 'failed' && <p role="alert" className="text-xs text-amber-200">{coreCopy.failed}</p>}
      {gateSaveState === 'saved' && <p role="status" className="text-xs text-white/60">{coreCopy.saved}</p>}

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
          {nativeSaveError && <p role="alert">{recovery.nativeFailed}</p>}
          {nativeRuntime ? (
            <fieldset disabled={nativeSaving} className="space-y-2">
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
            </fieldset>
          ) : (
            <div className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-white/38">
              {nativeRuntimeError || uiMessage('settings.native-runtime-status-is-loading.4a6aed02cd')}
            </div>
          )}
        </div>
      </div>

      {/* Scheduler Tasks */}
      <div className="p-4 bg-white/5 rounded-2xl border border-white/5 space-y-3">
        <button type="button" aria-expanded={tasksExpanded} onClick={() => setTasksExpanded(!tasksExpanded)} className="w-full flex items-center justify-between">
          <div className="text-xs font-black uppercase tracking-widest text-white/60">{uiMessage('settings.scheduled-routines.5f06751a14', t?.langCode === 'en' ? 'en' : 'zh')}</div>
          <ChevronDown size={14} className={`text-white/40 transition-transform ${tasksExpanded ? 'rotate-180' : ''}`} />
        </button>
        {taskError ? <div role="alert" className="text-xs text-amber-200">{coreCopy.tasksFailed} <button type="button" onClick={() => setTaskRetry(value => value + 1)} className="underline">{coreCopy.retry}</button></div>
          : !taskList && <p role="status" className="text-xs text-white/50">{coreCopy.tasksLoading}</p>}
        {taskSaveState === 'failed' && <div role="alert" className="text-xs text-amber-200">{coreCopy.taskFailed} <button type="button" onClick={() => setTaskRetry(value => value + 1)} className="underline">{coreCopy.retry}</button></div>}
        {taskSaveState === 'saved' && <p role="status" className="text-xs text-white/60">{coreCopy.taskSaved}</p>}

        {tasksExpanded && (
          <div className="max-h-60 overflow-y-auto custom-scrollbar space-y-1">
            {taskList?.length === 0 && <p className="text-xs text-white/50">{coreCopy.tasksEmpty}</p>}
            {taskList?.map(task => (
              <div key={task.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02]">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white/60 truncate">{task.id}</div>
                  <div className="text-[11px] text-white/30">{task.cron} {task.lastRun ? formatUiMessage('settings.last-value0.ad05dbfaea', { value0: new Date(task.lastRun).toLocaleTimeString() }) : ''}</div>
                </div>
                <button
                  type="button" aria-label={task.id} aria-pressed={task.enabled} disabled={taskSaving || taskSaveState === 'failed'}
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
