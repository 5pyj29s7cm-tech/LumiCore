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
import { uiMessage } from '@/i18n/uiMessages';
import type { Locale } from '@/i18n/runtime';
import { taskCompletionFeedbackCopy } from '@/i18n/locales/taskCompletionFeedback';
import { LumiScenePanel } from './LumiScenePanel';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel';
import {
  LocalAgentSphere,
  type LocalAgentCosmosAgent,
  type LocalAgentCosmosTask,
} from './LocalAgentSphere';
import { TaskCompletionFeedbackDetails } from './TaskCompletionFeedbackDetails';
import {
  normalizeTaskCompletionFeedback,
  type TaskCompletionFeedback,
} from './workflowTypes';
import type { CommandCenterView } from './commandCenterTypes';
import { isCurrentScopeRequest } from './scopeRequestGuard';

export type CommandAgent = {
  id: string;
  name: string;
  category?: string;
  runtime?: 'internal' | 'external';
  status?: string;
  isFrozen?: boolean;
  healthStatus?: string;
  lastRunStatus?: string;
};

export type BackgroundTask = {
  id: string;
  kind?: 'delegation' | 'autonomy' | 'takeover';
  title?: string;
  status?: string;
  phase?: string;
  workerNames?: string[];
  toolCallsCount?: number;
  resultPreview?: string;
  error?: string;
  blocker?: string;
  nextAction?: string;
  cancelRequested?: boolean;
  pauseRequested?: boolean;
  controls?: {
    canPause: boolean;
    canResume: boolean;
    canCancel: boolean;
  };
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
    workerCount: number;
    reasonCode: string;
  };
  updatedAt?: string;
  completedAt?: string;
  completionFeedback?: TaskCompletionFeedback;
};

type DeskState = 'ready' | 'working' | 'paused' | 'attention';

const ACTIVE_BACKGROUND_STATES = new Set(['pending', 'queued', 'running', 'working', 'pausing', 'cancelling', 'waiting_confirmation']);

function numeric(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function normalizeCommandCenterTask(value: unknown): BackgroundTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const id = String(task.id || '').trim();
  if (!id) return null;
  const normalized: BackgroundTask = { id };
  if (hasOwn(task, 'kind')) normalized.kind = task.kind === 'autonomy' || task.kind === 'takeover' ? task.kind : 'delegation';
  if (hasOwn(task, 'title')) normalized.title = String(task.title || id);
  if (hasOwn(task, 'status')) normalized.status = String(task.status || 'queued');
  if (typeof task.phase === 'string') normalized.phase = task.phase;
  if (Array.isArray(task.workerNames)) normalized.workerNames = task.workerNames.map(String).filter(Boolean);
  if (hasOwn(task, 'toolCallsCount')) normalized.toolCallsCount = numeric(task.toolCallsCount);
  if (typeof task.resultPreview === 'string') normalized.resultPreview = task.resultPreview;
  if (typeof task.error === 'string') normalized.error = task.error;
  if (typeof task.blocker === 'string') normalized.blocker = task.blocker;
  if (typeof task.nextAction === 'string') normalized.nextAction = task.nextAction;
  if (hasOwn(task, 'cancellationRequested') || hasOwn(task, 'cancelRequested')) {
    normalized.cancelRequested = task.cancellationRequested === true || task.cancelRequested === true;
  }
  if (hasOwn(task, 'pauseRequested')) normalized.pauseRequested = task.pauseRequested === true;
  if (task.controls && typeof task.controls === 'object' && !Array.isArray(task.controls)) {
    normalized.controls = {
      canPause: (task.controls as Record<string, unknown>).canPause === true,
      canResume: (task.controls as Record<string, unknown>).canResume === true,
      canCancel: (task.controls as Record<string, unknown>).canCancel === true,
    };
  }
  if (task.progress && typeof task.progress === 'object' && !Array.isArray(task.progress)) {
    const progress = task.progress as Record<string, unknown>;
    normalized.progress = {
      checkpoint: String(progress.checkpoint || ''),
      completedUnits: numeric(progress.completedUnits),
      totalUnits: numeric(progress.totalUnits),
      receiptCount: numeric(progress.receiptCount),
      toolCallCount: numeric(progress.toolCallCount),
    };
    if (!hasOwn(task, 'toolCallsCount')) normalized.toolCallsCount = normalized.progress.toolCallCount;
  }
  if (task.evidence && typeof task.evidence === 'object' && !Array.isArray(task.evidence)) {
    const evidence = task.evidence as Record<string, unknown>;
    normalized.evidence = {
      terminal: evidence.terminal === true,
      verification: String(evidence.verification || 'pending'),
      evidenceCount: numeric(evidence.evidenceCount),
      toolCount: numeric(evidence.toolCount),
      workerCount: numeric(evidence.workerCount),
      reasonCode: String(evidence.reasonCode || ''),
    };
  }
  if (typeof task.updatedAt === 'string') normalized.updatedAt = task.updatedAt;
  if (typeof task.completedAt === 'string') normalized.completedAt = task.completedAt;
  const completionFeedback = normalizeTaskCompletionFeedback(task.completionFeedback);
  if (completionFeedback) normalized.completionFeedback = completionFeedback;
  return normalized;
}

export function mergeCommandCenterTasks(previous: BackgroundTask | undefined, incoming: BackgroundTask): BackgroundTask {
  return { ...(previous || {}), ...incoming };
}

function deskState(agent: CommandAgent, tasks: BackgroundTask[]): DeskState {
  if (agent.isFrozen || agent.status === 'terminated') return 'paused';
  if (agent.runtime === 'external' && agent.healthStatus !== 'online') return 'attention';
  if (agent.lastRunStatus === 'failed') return 'attention';
  const normalizedName = String(agent.name || '').trim().toLowerCase();
  const isWorking = tasks.some(task => commandCenterTaskIsActive(task) && (
    (task.workerNames || []).some(name => {
      const identity = String(name || '').trim().toLowerCase();
      return identity === normalizedName || identity === String(agent.id || '').trim().toLowerCase();
    })
  ));
  return isWorking ? 'working' : 'ready';
}

function taskClaimsAgent(task: BackgroundTask, agent: CommandAgent): boolean {
  const identities = new Set([agent.id, agent.name].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
  return (task.workerNames || []).some(name => identities.has(String(name || '').trim().toLowerCase()));
}

export function commandCenterTaskIsActive(task: BackgroundTask): boolean {
  return ACTIVE_BACKGROUND_STATES.has(String(task.status || '').toLowerCase())
    || ACTIVE_BACKGROUND_STATES.has(String(task.phase || '').toLowerCase());
}

export function buildCommandCenterCosmosAgents(agents: CommandAgent[], tasks: BackgroundTask[]): LocalAgentCosmosAgent[] {
  return agents
    .filter(agent => !['lumi', 'lumi_default'].includes(agent.id))
    .map(agent => {
      const state = deskState(agent, tasks);
      const task = tasks.find(item => commandCenterTaskIsActive(item) && taskClaimsAgent(item, agent));
      return {
        id: agent.id,
        name: agent.name,
        category: agent.category || 'general',
        runtime: agent.runtime === 'external' ? 'external' : 'internal',
        state,
        taskId: task?.id,
        taskTitle: task?.title,
      };
    });
}

export function buildCommandCenterCosmosTasks(tasks: BackgroundTask[], agents: LocalAgentCosmosAgent[]): LocalAgentCosmosTask[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title || task.id,
    status: task.status || 'unknown',
    phase: task.phase,
    active: commandCenterTaskIsActive(task),
    workerIds: agents
      .filter(agent => {
        const identities = new Set([agent.id, agent.name].map(value => String(value || '').trim().toLowerCase()));
        return (task.workerNames || []).some(worker => identities.has(String(worker || '').trim().toLowerCase()));
      })
      .map(agent => agent.id),
  }));
}

export function CommandCenterPanel({
  t,
  view,
  onViewChange,
  onOpenNexus,
  runtimeStatusOverride,
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
}) {
  const { workDomain, orgConnection } = useApp();
  const isWork = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const locale: Locale = t?.langCode === 'en' ? 'en' : 'zh';
  const feedbackCopy = taskCompletionFeedbackCopy(locale);
  const scopeKey = `${isWork ? 'work' : 'personal'}:${isWork ? orgConnection?.orgId || '' : ''}`;
  const [agents, setAgents] = useState<CommandAgent[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [expandedBackgroundTaskId, setExpandedBackgroundTaskId] = useState<string | null>(null);
  const [taskControlInFlightIds, setTaskControlInFlightIds] = useState<string[]>([]);
  const [taskControlError, setTaskControlError] = useState('');
  const [taskLoadError, setTaskLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const hasLoadedOfficeRef = useRef(false);
  const scopeGenerationRef = useRef(0);
  const activeScopeKeyRef = useRef(scopeKey);
  const refreshInFlightRef = useRef<{ scopeKey: string; generation: number; promise: Promise<void> } | null>(null);
  const taskControlInFlightRef = useRef(new Set<string>());
  const officeActive = view === 'office' || view === 'team';
  const localRuntimeStatus = useRuntimeStatus({
    enabled: runtimeStatusOverride === undefined && (officeActive || view === 'core'),
    scopeKey,
  });
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

  const refresh = useCallback(async () => {
    const requestScopeKey = scopeKey;
    const generation = scopeGenerationRef.current;
    const requestToken = { scopeKey: requestScopeKey, generation };
    if (!isCurrentScopeRequest(requestToken, activeScopeKeyRef.current, scopeGenerationRef.current)) return;
    const inFlight = refreshInFlightRef.current;
    if (inFlight && inFlight.scopeKey === requestScopeKey && inFlight.generation === generation) return inFlight.promise;
    const firstLoad = !hasLoadedOfficeRef.current;
    if (firstLoad) setLoading(true);
    let request: Promise<void>;
    request = (async () => {
      const [agentResult, taskResult, workResult] = await Promise.allSettled([
        apiFetch('/api/agents').then(async response => response.ok ? response.json() : []),
        apiFetch('/api/autonomy/background-tasks').then(async response => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
          return payload;
        }),
        apiFetch('/api/autonomy/work').then(async response => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
          return payload;
        }),
      ]);
      if (!isCurrentScopeRequest(requestToken, activeScopeKeyRef.current, scopeGenerationRef.current)) return;
      if (agentResult.status === 'fulfilled') {
        const payload = agentResult.value;
        setAgents(Array.isArray(payload) ? payload : Array.isArray(payload?.agents) ? payload.agents : []);
      }
      const recentTasks: BackgroundTask[] = taskResult.status === 'fulfilled' && Array.isArray(taskResult.value?.tasks)
        ? taskResult.value.tasks.map(normalizeCommandCenterTask).filter((task): task is BackgroundTask => Boolean(task))
        : [];
      const activeWork: BackgroundTask[] = workResult.status === 'fulfilled' && Array.isArray(workResult.value?.items)
        ? workResult.value.items.map(normalizeCommandCenterTask).filter((task): task is BackgroundTask => Boolean(task))
        : [];
      const merged = new Map<string, BackgroundTask>(recentTasks.map(task => [task.id, task]));
      for (const task of activeWork) merged.set(task.id, mergeCommandCenterTasks(merged.get(task.id), task));
      setBackgroundTasks([...merged.values()]);
      const taskLoadErrors = [taskResult, workResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
      if (workResult.status === 'fulfilled' && workResult.value?.ok === false) {
        const diagnostics = Array.isArray(workResult.value?.diagnostics)
          ? workResult.value.diagnostics.map((item: { source?: unknown; code?: unknown }) => `${String(item.source || 'runtime')}:${String(item.code || 'degraded')}`)
          : [];
        taskLoadErrors.push(diagnostics.join(', ') || String(workResult.value?.status || 'Runtime work snapshot is degraded.'));
      }
      setTaskLoadError(taskLoadErrors.join(' · '));
      hasLoadedOfficeRef.current = true;
      if (firstLoad) setLoading(false);
    })().finally(() => {
      if (refreshInFlightRef.current?.promise === request) refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = { scopeKey: requestScopeKey, generation, promise: request };
    return request;
  }, [scopeKey]);

  const controlTask = useCallback(async (task: BackgroundTask, action: 'pause' | 'resume' | 'cancel') => {
    if (taskControlInFlightRef.current.has(task.id)) return;
    const generation = scopeGenerationRef.current;
    const requestScopeKey = scopeKey;
    const requestToken = { scopeKey: requestScopeKey, generation };
    taskControlInFlightRef.current.add(task.id);
    setTaskControlInFlightIds([...taskControlInFlightRef.current]);
    setTaskControlError('');
    try {
      const response = await apiFetch(`/api/autonomy/work/${encodeURIComponent(task.id)}/${action}`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const diagnostic = Array.isArray(payload.diagnostics) ? payload.diagnostics.join('; ') : '';
        throw new Error(payload.error || diagnostic || `HTTP ${response.status}`);
      }
      if (!isCurrentScopeRequest(requestToken, activeScopeKeyRef.current, scopeGenerationRef.current)) return;
      const rawTask = Array.isArray(payload.items)
        ? payload.items.find((item: { id?: unknown }) => String(item?.id || '') === task.id)
        : payload.task;
      const updated = normalizeCommandCenterTask(rawTask);
      if (updated) {
        setBackgroundTasks(previous => previous.map(item => item.id === task.id ? mergeCommandCenterTasks(item, updated) : item));
      }
      await refresh();
    } catch (cause) {
      if (!isCurrentScopeRequest(requestToken, activeScopeKeyRef.current, scopeGenerationRef.current)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setTaskControlError(`${feedbackCopy.controlError}: ${message}`);
    } finally {
      taskControlInFlightRef.current.delete(task.id);
      if (isCurrentScopeRequest(requestToken, activeScopeKeyRef.current, scopeGenerationRef.current)) {
        setTaskControlInFlightIds([...taskControlInFlightRef.current]);
      }
    }
  }, [feedbackCopy.controlError, refresh, scopeKey]);

  useEffect(() => {
    activeScopeKeyRef.current = scopeKey;
    scopeGenerationRef.current += 1;
    refreshInFlightRef.current = null;
    hasLoadedOfficeRef.current = false;
    taskControlInFlightRef.current.clear();
    setAgents([]);
    setBackgroundTasks([]);
    setExpandedBackgroundTaskId(null);
    setTaskControlInFlightIds([]);
    setTaskControlError('');
    setTaskLoadError('');
    setLoading(true);
  }, [scopeKey]);

  useEffect(() => {
    void refresh();
    const socket = socketService.connect();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 600);
    };
    socket.on('agent:created', schedule);
    socket.on('agent:updated', schedule);
    socket.on('agent:removed', schedule);
    socket.on('agent:delegation', schedule);
    socket.on('agent:background_task_update', schedule);
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      if (timer) clearTimeout(timer);
      window.clearInterval(interval);
      socket.off('agent:created', schedule);
      socket.off('agent:updated', schedule);
      socket.off('agent:removed', schedule);
      socket.off('agent:delegation', schedule);
      socket.off('agent:background_task_update', schedule);
    };
  }, [refresh, scopeKey]);

  const cosmosAgents = useMemo(() => buildCommandCenterCosmosAgents(agents, backgroundTasks), [agents, backgroundTasks]);
  const cosmosTasks = useMemo(() => buildCommandCenterCosmosTasks(backgroundTasks, cosmosAgents), [backgroundTasks, cosmosAgents]);
  const activeBackgroundCount = backgroundTasks.filter(commandCenterTaskIsActive).length;
  const recentBackgroundTasks = useMemo(() => [...backgroundTasks]
    .sort((left, right) => {
      const rightTime = Date.parse(right.updatedAt || right.completedAt || '') || 0;
      const leftTime = Date.parse(left.updatedAt || left.completedAt || '') || 0;
      return rightTime - leftTime;
    })
    .slice(0, 6), [backgroundTasks]);
  const lumiWorking = status?.level === 'working' || activeBackgroundCount > 0;
  const lumiAttention = status?.level === 'attention';

  return (
    <section className={`lumi-command-center-panel flex h-full min-h-0 flex-col overflow-hidden ${
      officeActive
        ? 'bg-transparent'
        : 'rounded-[2rem] border border-cyan-300/12 bg-[#060b12]/92 shadow-2xl shadow-black/35 backdrop-blur-2xl'
    }`}>
      {!officeActive && <header className="shrink-0 border-b border-white/[0.07] px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={() => onViewChange('office')}
              className="flex h-8 shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-400/[0.06] px-3 text-cyan-100/60 transition-colors hover:bg-cyan-400/[0.12] hover:text-cyan-50"
              title={uiMessage('command-center.office.26fdbd3a4a')}
            >
              <Building2 size={14} />
              <span className="text-[10px] font-bold">{t?.back || 'Back'} · {uiMessage('command-center.office.26fdbd3a4a')}</span>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-black text-white/90">
                <Command size={16} className="text-cyan-200" />
                {uiMessage('command-center.core.1b1073a209')}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-white/38">
                <span className={`h-1.5 w-1.5 rounded-full ${isWork ? 'bg-blue-300' : 'bg-emerald-300'}`} />
                {isWork ? uiMessage('command-center.organization-scope.7e5a629a21') : uiMessage('command-center.personal-scope.c7bb921ff1')}
                <span className="truncate">{uiMessage('command-center.scope-boundary.09ef8aa52a')}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void refresh(); void refreshRuntime(); refreshScene(true); }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-white/40 hover:bg-white/[0.07] hover:text-white/70"
            title={uiMessage('command-center.refresh.7436ee304a')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>}

      <div className={`custom-scrollbar relative min-h-0 flex-1 ${officeActive ? 'overflow-hidden p-0' : 'overflow-y-auto p-4'}`}>
        {officeActive && (
          <div className="relative h-full min-h-0 overflow-hidden">
            <LocalAgentSphere
              t={t}
              variant="command-center"
              sentiment={lumiAttention ? 'focused' : lumiWorking ? 'excited' : 'zen'}
              callState={lumiWorking ? 'thinking' : 'idle'}
              highPerformance={false}
              cosmosAgents={cosmosAgents}
              cosmosTasks={cosmosTasks}
              cosmosState={lumiAttention ? 'attention' : lumiWorking ? 'working' : 'ready'}
              cosmosLoading={loading}
              cosmosLabels={{
                aria: uiMessage('command-center.office-scene-aria.657e86c3da', locale),
                liveState: uiMessage('command-center.receipt-driven.c10f9390d4', locale),
                lumi: uiMessage('command-center.lumi-commander.32f6b27c0a', locale),
                agents: uiMessage('system-explorer.agents.8039b1040e', locale),
                active: uiMessage('command-center.active-tasks.e3c67ca0fe', locale),
                ready: uiMessage('command-center.ready.4a09f2582b', locale),
                working: uiMessage('command-center.working.90f16b23a5', locale),
                paused: uiMessage('command-center.paused.7848cd9af5', locale),
                attention: uiMessage('command-center.attention.c47451e86a', locale),
                noWorkers: uiMessage('command-center.no-workers.f27019b97a', locale),
                noTasks: feedbackCopy.noBackgroundWork,
              }}
            />
            {loading && (
              <div className="lumi-command-cosmos__loading" role="status">
                <Loader2 size={14} className="animate-spin" />
                <span>{t?.loading || 'Loading'}</span>
              </div>
            )}

            <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2">
              <button type="button" onClick={() => onOpenNexus ? onOpenNexus() : onViewChange('core')} className="flex h-10 items-center gap-2 rounded-2xl border border-violet-300/15 bg-[#080d17]/78 px-3.5 text-[10px] font-bold text-violet-100/70 shadow-2xl shadow-black/35 backdrop-blur-2xl transition-colors hover:border-violet-200/25 hover:bg-violet-400/[0.12] hover:text-violet-50" title={uiMessage('command-center.core.1b1073a209')}>
                <Cpu size={13} />
                <span>{uiMessage('command-center.core.1b1073a209')}</span>
              </button>
              <button type="button" onClick={() => { void refresh(); void refreshRuntime(); refreshScene(true); }} className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-[#080d17]/78 text-white/35 shadow-2xl shadow-black/35 backdrop-blur-2xl transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-white/70" title={uiMessage('command-center.refresh.7436ee304a')}>
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        )}

        {view === 'core' && (
          <div className="space-y-4">
            {onOpenNexus && (
              <button
                type="button"
                onClick={onOpenNexus}
                className="flex w-full items-center justify-between rounded-2xl border border-violet-300/18 bg-gradient-to-r from-violet-400/[0.10] to-cyan-400/[0.08] px-4 py-3 text-left transition-colors hover:border-violet-200/30 hover:bg-violet-300/[0.12]"
              >
                <span>
                  <span className="block text-sm font-bold text-white/85">{uiMessage('command-center.open-core.66a1099fe1')}</span>
                  <span className="mt-1 block text-[10px] text-white/35">Nexus · Distributed OS Core</span>
                </span>
                <ArrowUpRight size={16} className="text-violet-200" />
              </button>
            )}
            <RuntimeEvidencePanel status={status} loading={runtimeLoading} error={runtimeError} />
            <LumiScenePanel scene={scene} loading={sceneLoading} error={sceneError} />
            {!runtimeLoading && !status && (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-300/15 bg-amber-400/[0.05] p-4 text-xs text-amber-100/65"><CircleAlert size={14} />{uiMessage('command-center.runtime-unavailable.52e4d243c4')}</div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><div className="flex items-center gap-2 text-xs text-white/45"><Activity size={13} />{uiMessage('command-center.tasks.1ddfd1ee9d')}</div><div className="mt-2 text-xl font-black text-white/80">{status?.counts.activeTasks || 0}</div></div>
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4"><div className="flex items-center gap-2 text-xs text-white/45"><Cpu size={13} />{uiMessage('command-center.receipts.291d3480e2')}</div><div className="mt-2 text-xl font-black text-white/80">{status?.counts.verifiedReceipts || 0}</div></div>
            </div>
            <section
              data-command-center-background-tasks
              className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3"
              aria-label={feedbackCopy.backgroundWork}
            >
              <div className="flex items-start justify-between gap-3 px-1 pb-2">
                <div>
                  <div className="text-xs font-black text-white/78">{feedbackCopy.backgroundWork}</div>
                  <div className="mt-1 text-[9px] leading-4 text-white/32">{feedbackCopy.backgroundWorkDetail}</div>
                </div>
                <span className="rounded-full border border-white/[0.08] bg-black/15 px-2 py-1 font-mono text-[9px] text-white/35">
                  {recentBackgroundTasks.length}
                </span>
              </div>
              {taskControlError && (
                <div role="alert" className="mb-2 rounded-xl border border-rose-300/15 bg-rose-300/[0.05] px-3 py-2 text-[9px] leading-4 text-rose-100/70">
                  {taskControlError}
                </div>
              )}
              {taskLoadError && (
                <div role="alert" className="mb-2 rounded-xl border border-amber-300/15 bg-amber-300/[0.045] px-3 py-2 text-[9px] leading-4 text-amber-100/70">
                  {taskLoadError}
                </div>
              )}
              {recentBackgroundTasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.07] px-3 py-5 text-center text-[10px] text-white/28">
                  {feedbackCopy.noBackgroundWork}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {recentBackgroundTasks.map(task => {
                    const expanded = expandedBackgroundTaskId === task.id;
                    const feedbackStatus = task.completionFeedback?.status;
                    const taskStatus = String(task.status || 'unknown').toLowerCase();
                    const taskPhase = String(task.phase || taskStatus).toLowerCase();
                    const taskActive = commandCenterTaskIsActive(task);
                    const controlInFlight = taskControlInFlightIds.includes(task.id);
                    const statusLabel = taskPhase === 'paused'
                      ? uiMessage('command-center.paused.7848cd9af5', locale)
                      : taskPhase === 'cancelling'
                        ? uiMessage('agent-chat-page.cancelling.7163e20e93', locale)
                        : feedbackStatus
                          ? feedbackCopy.status[feedbackStatus]
                          : taskActive
                            ? uiMessage('command-center.working.90f16b23a5', locale)
                            : taskPhase;
                    return (
                      <article key={task.id} className="overflow-hidden rounded-xl border border-white/[0.065] bg-black/15">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={`command-center-background-task-${task.id}`}
                          onClick={() => setExpandedBackgroundTaskId(expanded ? null : task.id)}
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.035]"
                        >
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            taskActive
                              ? 'bg-cyan-300 animate-pulse'
                              : feedbackStatus === 'completed'
                                ? 'bg-emerald-300'
                                : feedbackStatus === 'blocked' || feedbackStatus === 'failed'
                                  ? 'bg-rose-300'
                                  : 'bg-white/25'
                          }`} />
                          <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-white/68">{task.title || task.id}</span>
                          <span className="shrink-0 text-[8px] font-black uppercase text-white/32">{statusLabel}</span>
                          <ChevronDown size={12} className={`shrink-0 text-white/28 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                        {expanded && (
                          <div id={`command-center-background-task-${task.id}`} className="space-y-2 border-t border-white/[0.06] p-2.5">
                            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[10px] leading-4 text-white/55">
                              <span className="font-black text-white/38">{feedbackCopy.goal}: </span>{task.title || task.id}
                            </div>
                            {(task.workerNames?.length || task.updatedAt || task.completedAt) && (
                              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-white/28">
                                {task.workerNames?.length ? <span>{feedbackCopy.workers}: {task.workerNames.join(', ')}</span> : null}
                                {(task.updatedAt || task.completedAt) && (
                                  <span>{feedbackCopy.updated}: {new Date(task.updatedAt || task.completedAt || '').toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</span>
                                )}
                              </div>
                            )}
                            {(task.phase || task.progress) && (
                              <div className="grid grid-cols-2 gap-2 text-[9px] text-white/38">
                                <div className="rounded-lg border border-white/[0.055] bg-black/15 px-2.5 py-2">
                                  <span className="block text-[8px] font-black uppercase text-white/24">{feedbackCopy.phase}</span>
                                  <span className="mt-1 block text-white/55">
                                    {task.phase || task.status}{task.progress?.checkpoint ? ` · ${task.progress.checkpoint}` : ''}
                                  </span>
                                </div>
                                <div className="rounded-lg border border-white/[0.055] bg-black/15 px-2.5 py-2">
                                  <span className="block text-[8px] font-black uppercase text-white/24">{feedbackCopy.progress}</span>
                                  <span className="mt-1 block text-white/55">
                                    {task.progress?.completedUnits || 0}/{task.progress?.totalUnits || 0} · {feedbackCopy.receipts} {task.progress?.receiptCount || 0}
                                  </span>
                                </div>
                              </div>
                            )}
                            {task.evidence && (
                              <div className="rounded-lg border border-cyan-300/10 bg-cyan-300/[0.025] px-2.5 py-2 text-[9px] leading-4 text-white/42">
                                <span className="font-black text-cyan-100/55">{feedbackCopy.verification}: </span>
                                {task.evidence.verification} · {feedbackCopy.receipts} {task.evidence.evidenceCount}
                              </div>
                            )}
                            {task.blocker && (
                              <div className="rounded-lg border border-rose-300/10 bg-rose-300/[0.035] px-2.5 py-2 text-[10px] leading-4 text-rose-100/65">
                                <span className="font-black">{feedbackCopy.blocker}: </span>{task.blocker}
                              </div>
                            )}
                            {task.nextAction && (
                              <div className="rounded-lg border border-amber-300/10 bg-amber-300/[0.025] px-2.5 py-2 text-[10px] leading-4 text-white/52">
                                <span className="font-black text-amber-100/55">{feedbackCopy.nextAction}: </span>{task.nextAction}
                              </div>
                            )}
                            {task.resultPreview && (
                              <div className="rounded-lg border border-emerald-300/10 bg-emerald-300/[0.035] px-2.5 py-2 text-[10px] leading-4 text-white/55">
                                <span className="font-black text-emerald-100/60">{feedbackCopy.result}: </span>{task.resultPreview}
                              </div>
                            )}
                            {task.error && (
                              <div className="rounded-lg border border-rose-300/10 bg-rose-300/[0.035] px-2.5 py-2 text-[10px] leading-4 text-rose-100/65">
                                <span className="font-black">{feedbackCopy.error}: </span>{task.error}
                              </div>
                            )}
                            <TaskCompletionFeedbackDetails feedback={task.completionFeedback} locale={locale} compact />
                            {task.cancelRequested && taskStatus !== 'cancelled' && (
                              <div data-task-cancel-requested className="rounded-lg border border-amber-300/12 bg-amber-300/[0.035] px-2.5 py-2 text-[9px] leading-4 text-amber-100/65">
                                {feedbackCopy.cancelRequested}
                              </div>
                            )}
                            {task.controls && (task.controls.canPause || task.controls.canResume || task.controls.canCancel) && (
                              <div data-command-center-task-controls className="flex items-center justify-end gap-1.5 border-t border-white/[0.05] pt-2">
                                {task.controls.canPause && (
                                  <button type="button" disabled={controlInFlight} onClick={() => void controlTask(task, 'pause')} className="flex h-7 items-center gap-1 rounded-lg border border-white/[0.07] px-2 text-[9px] text-white/42 hover:bg-white/[0.05] hover:text-white/70 disabled:cursor-wait disabled:opacity-35" title={feedbackCopy.pause}>
                                    {controlInFlight ? <Loader2 size={11} className="animate-spin" /> : <Pause size={11} />}{feedbackCopy.pause}
                                  </button>
                                )}
                                {task.controls.canResume && (
                                  <button type="button" disabled={controlInFlight} onClick={() => void controlTask(task, 'resume')} className="flex h-7 items-center gap-1 rounded-lg border border-cyan-300/12 px-2 text-[9px] text-cyan-100/58 hover:bg-cyan-300/[0.06] hover:text-cyan-50 disabled:cursor-wait disabled:opacity-35" title={feedbackCopy.resume}>
                                    {controlInFlight ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}{feedbackCopy.resume}
                                  </button>
                                )}
                                {task.controls.canCancel && (
                                  <button type="button" disabled={controlInFlight} onClick={() => void controlTask(task, 'cancel')} className="flex h-7 items-center gap-1 rounded-lg border border-rose-300/10 px-2 text-[9px] text-rose-100/48 hover:bg-rose-300/[0.06] hover:text-rose-100 disabled:cursor-wait disabled:opacity-35" title={feedbackCopy.cancel}>
                                    {controlInFlight ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}{feedbackCopy.cancel}
                                  </button>
                                )}
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
