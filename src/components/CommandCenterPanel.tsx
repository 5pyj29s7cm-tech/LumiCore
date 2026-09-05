import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Building2,
  ChevronDown,
  CircleAlert,
  Command,
  Cpu,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useLumiScene } from '@/hooks/useLumiScene';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import type { StructuredRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import { getCommandCenterCopy } from '@/i18n/locales/commandCenter';
import { isCurrentScopeRequest } from './scopeRequestGuard';
import { LumiScenePanel } from './LumiScenePanel';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel';
import { LumiCoreSphere, type LumiCoreOrbitTask, type LumiCoreTaskState } from './LumiCoreSphere';
import { TaskCompletionFeedbackDetails } from './TaskCompletionFeedbackDetails';
import {
  customerVisibleTaskBlocker,
  customerVisibleTaskDetail,
  customerVisibleTaskNextAction,
  customerVisibleTaskStatus,
  normalizeTaskCompletionFeedback,
  type TaskCompletionFeedback,
} from './workflowTypes';
import type { CommandCenterView } from './commandCenterTypes';

export type CommandCenterTask = {
  id: string;
  kind?: 'autonomy' | 'takeover';
  title: string;
  status: string;
  phase: string;
  updatedAt?: string;
  blocker?: string;
  nextAction?: string;
  cancellationRequested?: boolean;
  pauseRequested?: boolean;
  controls?: { canPause: boolean; canResume: boolean; canCancel: boolean };
  progress?: {
    checkpoint: string;
    completedUnits: number;
    totalUnits: number;
    receiptCount: number;
    toolCallCount: number;
  };
  evidence?: {
    terminal: boolean;
    verification: string;
    evidenceCount: number;
    toolCount: number;
    reasonCode: string;
  };
  completionFeedback?: TaskCompletionFeedback;
};

const ACTIVE_PHASES = new Set(['pending', 'queued', 'running', 'working', 'pausing', 'cancelling', 'waiting_confirmation']);

function numeric(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function normalizeCommandCenterTask(value: unknown, locale?: 'zh' | 'en'): CommandCenterTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, any>;
  const id = String(task.id || task.taskId || '').trim();
  if (!id) return null;
  const status = String(task.status || 'pending').trim().toLowerCase();
  const phase = String(task.phase || status).trim().toLowerCase();
  const controls = task.controls && typeof task.controls === 'object'
    ? {
        canPause: task.controls.canPause === true,
        canResume: task.controls.canResume === true,
        canCancel: task.controls.canCancel === true,
      }
    : undefined;
  const progress = task.progress && typeof task.progress === 'object'
    ? {
        checkpoint: String(task.progress.checkpoint || ''),
        completedUnits: numeric(task.progress.completedUnits),
        totalUnits: numeric(task.progress.totalUnits),
        receiptCount: numeric(task.progress.receiptCount),
        toolCallCount: numeric(task.progress.toolCallCount),
      }
    : undefined;
  const evidence = task.evidence && typeof task.evidence === 'object'
    ? {
        terminal: task.evidence.terminal === true,
        verification: String(task.evidence.verification || 'pending'),
        evidenceCount: numeric(task.evidence.evidenceCount),
        toolCount: numeric(task.evidence.toolCount),
        reasonCode: String(task.evidence.reasonCode || ''),
      }
    : undefined;
  return {
    id,
    kind: task.kind === 'takeover' ? 'takeover' : 'autonomy',
    title: locale
      ? customerVisibleTaskDetail(task.title, locale, '')
      : String(task.title || '').trim(),
    status,
    phase,
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : undefined,
    blocker: typeof task.blocker === 'string'
      ? locale ? customerVisibleTaskBlocker(task.blocker, locale) : task.blocker
      : undefined,
    nextAction: typeof task.nextAction === 'string'
      ? locale ? customerVisibleTaskNextAction(task.nextAction, locale) : task.nextAction
      : undefined,
    cancellationRequested: task.cancellationRequested === true || task.cancelRequested === true,
    pauseRequested: task.pauseRequested === true,
    controls,
    progress,
    evidence,
    // Keep the evidence rows until the details renderer summarizes them. A
    // second projection would count the summary itself as a single result.
    completionFeedback: normalizeTaskCompletionFeedback(task.completionFeedback),
  };
}

export function commandCenterTaskIsActive(task: CommandCenterTask): boolean {
  return ACTIVE_PHASES.has(task.phase) || ACTIVE_PHASES.has(task.status);
}

function taskOrbitState(task: CommandCenterTask): LumiCoreTaskState {
  if (task.phase === 'paused') return 'paused';
  if (task.phase === 'failed' || task.phase === 'blocked') return 'attention';
  if (task.phase === 'completed') return 'completed';
  if (commandCenterTaskIsActive(task)) return 'working';
  return 'queued';
}

export function buildLumiCoreOrbitTasks(tasks: CommandCenterTask[]): LumiCoreOrbitTask[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    state: taskOrbitState(task),
    active: commandCenterTaskIsActive(task),
  }));
}

export function CommandCenterPanel({
  t,
  view,
  onViewChange,
  onOpenNexus,
  runtimeStatusOverride,
  /**
   * Render only the animated core field.  The command-center chat uses this
   * mode as a non-interactive background layer so conversation remains the
   * primary surface instead of competing with a second panel.
   */
  backgroundOnly = false,
}: {
  t?: any;
  view: CommandCenterView;
  onViewChange: (view: CommandCenterView) => void;
  onOpenNexus?: () => void;
  runtimeStatusOverride?: {
    status: StructuredRuntimeStatus | null;
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
  };
  backgroundOnly?: boolean;
}) {
  const { workDomain, orgConnection } = useApp();
  const isWork = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const isZh = t?.langCode !== 'en';
  const scopeKey = `${isWork ? 'work' : 'personal'}:${isWork ? orgConnection?.orgId || '' : ''}`;
  const [tasks, setTasks] = useState<CommandCenterTask[]>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [controlInFlightIds, setControlInFlightIds] = useState<string[]>([]);
  const [taskError, setTaskError] = useState('');
  const [loading, setLoading] = useState(true);
  const scopeGenerationRef = useRef(0);
  const activeScopeKeyRef = useRef(scopeKey);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const localRuntimeStatus = useRuntimeStatus({ enabled: runtimeStatusOverride === undefined, scopeKey });
  const {
    status,
    loading: runtimeLoading,
    error: runtimeError,
    refresh: refreshRuntime,
  } = runtimeStatusOverride || localRuntimeStatus;
  const { scene, loading: sceneLoading, error: sceneError, refresh: refreshScene } = useLumiScene({
    enabled: view === 'core',
    scopeKey,
  });

  const copy = useMemo(() => getCommandCenterCopy(isZh ? 'zh' : 'en', isWork), [isWork, isZh]);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    scopeGenerationRef.current += 1;
    setTasks([]);
    setExpandedTaskId(null);
    setTaskError('');
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const request = { scopeKey, generation: scopeGenerationRef.current };
    setLoading(true);
    const promise = (async () => {
      try {
        const response = await apiFetch('/api/autonomy/work');
        if (!response.ok) throw new Error(`Task status request failed (${response.status})`);
        const payload = await response.json();
        if (!isCurrentScopeRequest(request, activeScopeKeyRef.current, scopeGenerationRef.current)) return;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        setTasks(items
          .map(item => normalizeCommandCenterTask(item, isZh ? 'zh' : 'en'))
          .filter((task): task is CommandCenterTask => Boolean(task)));
        setTaskError(payload?.degraded ? copy.degradedTaskState : '');
      } catch (error: any) {
        if (isCurrentScopeRequest(request, activeScopeKeyRef.current, scopeGenerationRef.current)) {
          setTaskError(copy.degradedTaskState);
        }
      } finally {
        if (isCurrentScopeRequest(request, activeScopeKeyRef.current, scopeGenerationRef.current)) setLoading(false);
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = promise;
    return promise;
  }, [copy.degradedTaskState, isZh, scopeKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const socket = socketService.getSocket();
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); void refreshRuntime(); }, 100);
    };
    const events = [
      'autonomous:task_started',
      'autonomous:task_paused',
      'autonomous:task_retry_scheduled',
      'autonomous:task_completed',
      'autonomous:task_failed',
      'autonomous:task_cancelled',
    ];
    events.forEach(event => socket.on(event, schedule));
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach(event => socket.off(event, schedule));
    };
  }, [refresh, refreshRuntime]);

  const controlTask = useCallback(async (task: CommandCenterTask, action: 'pause' | 'resume' | 'cancel') => {
    if (controlInFlightIds.includes(task.id)) return;
    setControlInFlightIds(previous => [...previous, task.id]);
    setTaskError('');
    try {
      const response = await apiFetch(`/api/autonomy/work/${encodeURIComponent(task.id)}/${action}`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${action} failed`);
      await refresh();
      await refreshRuntime();
    } catch (error: any) {
      setTaskError(copy.degradedTaskState);
    } finally {
      setControlInFlightIds(previous => previous.filter(id => id !== task.id));
    }
  }, [controlInFlightIds, copy.degradedTaskState, refresh, refreshRuntime]);

  const orbitTasks = useMemo(() => buildLumiCoreOrbitTasks(tasks), [tasks]);
  const activeTasks = useMemo(() => tasks.filter(commandCenterTaskIsActive), [tasks]);
  const recentTasks = useMemo(() => tasks.slice(0, 8), [tasks]);
  const hasAttention = tasks.some(task => task.phase === 'failed' || task.phase === 'blocked');
  const coreState = hasAttention ? 'attention' : activeTasks.length > 0 ? 'working' : 'ready';

  return (
    <section
      data-command-center-background={backgroundOnly ? 'true' : undefined}
      aria-hidden={backgroundOnly || undefined}
      className={`lumi-command-center-panel flex h-full min-h-0 flex-col overflow-hidden ${backgroundOnly ? 'pointer-events-none bg-transparent' : 'bg-[#02040b]'}`}
    >
      {!backgroundOnly && <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] bg-black/20 px-3.5">
        <div className="flex min-w-0 items-center gap-3">
          {view === 'core' && (
            <button type="button" onClick={() => onViewChange('office')} className="flex h-8 items-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-400/[0.06] px-3 text-[10px] font-bold text-cyan-100/60 hover:bg-cyan-400/[0.12] hover:text-cyan-50">
              <Building2 size={14} />{copy.office}
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-black text-white/90"><Command size={16} className="text-cyan-200" />{view === 'core' ? copy.core : copy.office}</div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-white/38"><span className={`h-1.5 w-1.5 rounded-full ${isWork ? 'bg-blue-300' : 'bg-emerald-300'}`} />{copy.scope}</div>
          </div>
        </div>
        <button type="button" onClick={() => { void refresh(); void refreshRuntime(); refreshScene(true); }} className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-white/40 hover:bg-white/[0.07] hover:text-white/70" title={copy.refresh}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>}

      <div className={`relative min-h-0 flex-1 ${view === 'office' ? 'overflow-hidden' : 'custom-scrollbar overflow-y-auto p-4'}`}>
        {view === 'office' && (
          <div className="relative h-full min-h-0 overflow-hidden">
            <LumiCoreSphere
              tasks={orbitTasks}
              state={coreState}
              loading={loading}
              labels={{
                aria: copy.taskViewAria,
                lumiCore: copy.core,
                ready: copy.ready,
                working: copy.working,
                attention: copy.attention,
                noTasks: copy.noTasks,
              }}
            />
            {!backgroundOnly && <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2">
              <button type="button" onClick={() => onOpenNexus ? onOpenNexus() : onViewChange('core')} className="flex h-10 items-center gap-2 rounded-2xl border border-violet-300/15 bg-[#080d17]/78 px-3.5 text-[10px] font-bold text-violet-100/70 shadow-2xl backdrop-blur-2xl hover:bg-violet-400/[0.12] hover:text-violet-50"><Cpu size={13} />{copy.core}</button>
              <button type="button" onClick={() => { void refresh(); void refreshRuntime(); }} className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-[#080d17]/78 text-white/35 shadow-2xl backdrop-blur-2xl hover:bg-white/[0.07] hover:text-white/70" title={copy.refresh}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            </div>}
          </div>
        )}

        {view === 'core' && (
          <div className="space-y-4">
            {onOpenNexus && (
              <button type="button" onClick={onOpenNexus} className="flex w-full items-center justify-between rounded-2xl border border-violet-300/18 bg-gradient-to-r from-violet-400/[0.10] to-cyan-400/[0.08] px-4 py-3 text-left hover:border-violet-200/30">
                <span><span className="block text-sm font-bold text-white/85">{copy.openCore}</span><span className="mt-1 block text-[10px] text-white/35">LumiCore · local runtime</span></span><ArrowUpRight size={16} className="text-violet-200" />
              </button>
            )}
            <RuntimeEvidencePanel status={status} loading={runtimeLoading} error={runtimeError} />
            <LumiScenePanel scene={scene} loading={sceneLoading} error={sceneError} />
            {!runtimeLoading && !status && <div className="flex items-center gap-2 rounded-2xl border border-amber-300/15 bg-amber-400/[0.05] p-4 text-xs text-amber-100/65"><CircleAlert size={14} />{copy.runtimeUnavailable}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><div className="flex items-center gap-2 text-xs text-white/45"><Activity size={13} />{copy.tasks}</div><div className="mt-2 text-xl font-black text-white/80">{status?.counts.activeTasks || activeTasks.length}</div></div>
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><div className="flex items-center gap-2 text-xs text-white/45"><Cpu size={13} />{copy.receipts}</div><div className="mt-2 text-xl font-black text-white/80">{status?.counts.verifiedReceipts || 0}</div></div>
            </div>

            <section data-command-center-tasks className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3" aria-label={copy.tasks}>
              <div className="flex items-center justify-between px-1 pb-2"><div className="text-xs font-black text-white/78">{copy.tasks}</div><span className="rounded-full border border-white/[0.08] bg-black/15 px-2 py-1 font-mono text-[9px] text-white/35">{recentTasks.length}</span></div>
              {taskError && <div role="alert" className="mb-2 rounded-xl border border-rose-300/15 bg-rose-300/[0.05] px-3 py-2 text-[9px] leading-4 text-rose-100/70">{taskError}</div>}
              {recentTasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.07] px-3 py-5 text-center text-[10px] text-white/28">{copy.noTasks}</div>
              ) : (
                <div className="space-y-1.5">
                  {recentTasks.map((task, taskIndex) => {
                    const expanded = expandedTaskId === task.id;
                    const inFlight = controlInFlightIds.includes(task.id);
                    const taskPanelId = `command-center-task-${taskIndex}`;
                    return (
                      <article key={task.id} data-task-cancel-requested={task.cancellationRequested ? 'true' : undefined} className="overflow-hidden rounded-xl border border-white/[0.065] bg-black/15">
                        <button type="button" aria-expanded={expanded} aria-controls={taskPanelId} onClick={() => setExpandedTaskId(expanded ? null : task.id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.035]">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${commandCenterTaskIsActive(task) ? 'animate-pulse bg-cyan-300' : task.phase === 'completed' ? 'bg-emerald-300' : task.phase === 'failed' || task.phase === 'blocked' ? 'bg-rose-300' : 'bg-white/25'}`} />
                          <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-white/68">{task.title || copy.tasks}</span><span className="shrink-0 text-[8px] font-black uppercase text-white/32">{customerVisibleTaskStatus(task.phase || task.status, isZh ? 'zh' : 'en')}</span><ChevronDown size={12} className={`shrink-0 text-white/28 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                        {expanded && (
                          <div id={taskPanelId} className="space-y-2 border-t border-white/[0.06] p-2.5">
                            <div className="grid grid-cols-2 gap-2 text-[9px] text-white/38">
                              <div className="rounded-lg border border-white/[0.055] bg-black/15 px-2.5 py-2"><span className="block text-[8px] font-black uppercase text-white/24">{copy.phase}</span><span className="mt-1 block text-white/55">{customerVisibleTaskStatus(task.phase || task.status, isZh ? 'zh' : 'en')}</span></div>
                              <div className="rounded-lg border border-white/[0.055] bg-black/15 px-2.5 py-2"><span className="block text-[8px] font-black uppercase text-white/24">{copy.progress}</span><span className="mt-1 block text-white/55">{task.progress?.completedUnits || 0}/{task.progress?.totalUnits || 0} · {copy.verification} {task.progress?.receiptCount || 0}</span></div>
                            </div>
                            {task.evidence && <div className="rounded-lg border border-cyan-300/10 bg-cyan-300/[0.025] px-2.5 py-2 text-[9px] leading-4 text-white/42"><span className="font-black text-cyan-100/55">{copy.verification}: </span>{customerVisibleTaskStatus(task.evidence.verification, isZh ? 'zh' : 'en')} · {task.evidence.evidenceCount}</div>}
                            {task.blocker && !task.completionFeedback && <div className="rounded-lg border border-rose-300/10 bg-rose-300/[0.035] px-2.5 py-2 text-[10px] leading-4 text-rose-100/65"><span className="font-black">{copy.blocker}: </span>{task.blocker}</div>}
                            {task.nextAction && <div className="rounded-lg border border-amber-300/10 bg-amber-300/[0.025] px-2.5 py-2 text-[10px] leading-4 text-white/52"><span className="font-black text-amber-100/55">{copy.next}: </span>{task.nextAction}</div>}
                            <TaskCompletionFeedbackDetails feedback={task.completionFeedback} locale={isZh ? 'zh' : 'en'} compact />
                            {task.controls && (task.controls.canPause || task.controls.canResume || task.controls.canCancel) && (
                              <div data-command-center-task-controls className="flex items-center justify-end gap-1.5 border-t border-white/[0.05] pt-2">
                                {task.controls.canPause && <button type="button" disabled={inFlight} onClick={() => void controlTask(task, 'pause')} className="flex h-7 items-center gap-1 rounded-lg border border-white/[0.07] px-2 text-[9px] text-white/42 hover:bg-white/[0.05] disabled:opacity-35">{inFlight ? <Loader2 size={11} className="animate-spin" /> : <Pause size={11} />}{copy.pause}</button>}
                                {task.controls.canResume && <button type="button" disabled={inFlight} onClick={() => void controlTask(task, 'resume')} className="flex h-7 items-center gap-1 rounded-lg border border-cyan-300/12 px-2 text-[9px] text-cyan-100/58 hover:bg-cyan-300/[0.06] disabled:opacity-35">{inFlight ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}{copy.resume}</button>}
                                {task.controls.canCancel && <button type="button" disabled={inFlight} onClick={() => void controlTask(task, 'cancel')} className="flex h-7 items-center gap-1 rounded-lg border border-rose-300/10 px-2 text-[9px] text-rose-100/48 hover:bg-rose-300/[0.06] disabled:opacity-35">{inFlight ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}{copy.cancel}</button>}
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
