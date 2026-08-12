import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Building2,
  CircleAlert,
  Command,
  Cpu,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useLumiScene } from '@/hooks/useLumiScene';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import type { StructuredRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import { uiMessage } from '@/i18n/uiMessages';
import { LumiScenePanel } from './LumiScenePanel';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel';
import { AgentOfficeScene, type OfficeWorker } from './AgentOfficeScene';
import type { CommandCenterView } from './commandCenterTypes';

type CommandAgent = {
  id: string;
  name: string;
  category?: string;
  runtime?: 'internal' | 'external';
  status?: string;
  isFrozen?: boolean;
  healthStatus?: string;
  lastRunStatus?: string;
};

type BackgroundTask = {
  id: string;
  title?: string;
  status?: string;
  workerNames?: string[];
};

type DeskState = 'ready' | 'working' | 'paused' | 'attention';

const ACTIVE_BACKGROUND_STATES = new Set(['queued', 'running', 'cancelling']);

function deskState(agent: CommandAgent, tasks: BackgroundTask[]): DeskState {
  if (agent.isFrozen || agent.status === 'terminated') return 'paused';
  if (agent.runtime === 'external' && agent.healthStatus !== 'online') return 'attention';
  if (agent.lastRunStatus === 'failed') return 'attention';
  const normalizedName = String(agent.name || '').trim().toLowerCase();
  const isWorking = tasks.some(task => (
    ACTIVE_BACKGROUND_STATES.has(String(task.status || '').toLowerCase())
    && (task.workerNames || []).some(name => String(name || '').trim().toLowerCase() === normalizedName)
  ));
  return isWorking ? 'working' : 'ready';
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
  const scopeKey = `${isWork ? 'work' : 'personal'}:${isWork ? orgConnection?.orgId || '' : ''}`;
  const [agents, setAgents] = useState<CommandAgent[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    const [agentResult, taskResult] = await Promise.allSettled([
      apiFetch('/api/agents').then(async response => response.ok ? response.json() : []),
      apiFetch('/api/autonomy/background-tasks').then(async response => response.ok ? response.json() : {}),
    ]);
    if (agentResult.status === 'fulfilled') {
      const payload = agentResult.value;
      setAgents(Array.isArray(payload) ? payload : Array.isArray(payload?.agents) ? payload.agents : []);
    }
    if (taskResult.status === 'fulfilled') {
      setBackgroundTasks(Array.isArray(taskResult.value?.tasks) ? taskResult.value.tasks : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const socket = socketService.connect();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 160);
    };
    socket.on('agent:created', schedule);
    socket.on('agent:updated', schedule);
    socket.on('agent:removed', schedule);
    socket.on('agent:delegation', schedule);
    socket.on('agent:background_task_update', schedule);
    const interval = window.setInterval(() => void refresh(), 15_000);
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

  const agentDesks = useMemo(() => agents.filter(agent => !['lumi', 'lumi_default'].includes(agent.id)), [agents]);
  const officeWorkers = useMemo<OfficeWorker[]>(() => agentDesks.map(agent => {
    const state = deskState(agent, backgroundTasks);
    const normalizedName = String(agent.name || '').trim().toLowerCase();
    const task = backgroundTasks.find(item => (
      ACTIVE_BACKGROUND_STATES.has(String(item.status || '').toLowerCase())
      && (item.workerNames || []).some(name => String(name || '').trim().toLowerCase() === normalizedName)
    ));
    return {
      id: agent.id,
      name: agent.name,
      category: agent.category || 'general',
      runtime: agent.runtime === 'external' ? 'external' : 'internal',
      state,
      taskTitle: task?.title,
    };
  }), [agentDesks, backgroundTasks]);
  const activeBackgroundCount = backgroundTasks.filter(task => ACTIVE_BACKGROUND_STATES.has(String(task.status || '').toLowerCase())).length;
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
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[#050b13]"><Loader2 size={22} className="animate-spin text-cyan-200/50" /></div>
            ) : (
              <AgentOfficeScene
                workers={officeWorkers}
                lumiState={lumiAttention ? 'attention' : lumiWorking ? 'working' : 'ready'}
                activeTasks={(status?.counts.activeTasks || 0) + activeBackgroundCount}
                labels={{
                  aria: uiMessage('command-center.office-scene-aria.657e86c3da'),
                  liveState: uiMessage('command-center.real-state.33d73ad8c9'),
                  currentFloor: uiMessage('command-center.office-floor.a59513a4eb'),
                  previousFloor: uiMessage('command-center.previous-floor.d0a3f3e6d8'),
                  nextFloor: uiMessage('command-center.next-floor.1caedfc76e'),
                  noWorkers: uiMessage('command-center.no-workers.f27019b97a'),
                  lumi: uiMessage('command-center.lumi-commander.32f6b27c0a'),
                  active: uiMessage('command-center.active-tasks.e3c67ca0fe'),
                  dispatching: uiMessage('command-center.dispatching.270bc5f426'),
                  ready: uiMessage('command-center.ready.4a09f2582b'),
                  working: uiMessage('command-center.working.90f16b23a5'),
                  paused: uiMessage('command-center.paused.7848cd9af5'),
                  attention: uiMessage('command-center.attention.c47451e86a'),
                }}
              />
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
          </div>
        )}
      </div>
    </section>
  );
}
