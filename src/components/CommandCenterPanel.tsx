import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Boxes,
  Building2,
  CheckCircle2,
  CircleAlert,
  Command,
  Cpu,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  ArrowUpRight,
  Clock3,
  Crosshair,
  Link2,
  ShieldAlert,
  Unplug,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useLumiScene } from '@/hooks/useLumiScene';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import { uiMessage } from '@/i18n/uiMessages';
import { appConfirm } from '@/lib/appConfirm';
import { toast } from 'sonner';
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
  lastActiveAt?: string;
  skillTags?: string[];
};

type BackgroundTask = {
  id: string;
  title?: string;
  status?: string;
  workerNames?: string[];
};

type LAPPolicy = {
  protocol?: string;
  version?: string;
  localAgent?: { agentId?: string; name?: string; capabilities?: string[] };
  activeSessions?: Array<{
    sessionId: string;
    peer: { agentId: string; name: string };
    trustLevel: string;
    scope: string[];
    sharedContextCount: number;
    lastHeartbeat: string;
  }>;
  contextFirewall?: {
    defaultMemoryIngestion?: string;
    personalityMutationFromLAP?: string;
  };
};

type LAPSessionProjection = {
  sessionId: string;
  peerA: { agentId: string; userId: string; name: string };
  peerB: { agentId: string; userId: string; name: string };
  peer: { agentId: string; userId: string; name: string; capabilities?: string[]; publicProfile?: Record<string, unknown> };
  trustLevel: string;
  scope: string[];
  requestedScope: string[];
  establishedAt: string;
  lastHeartbeat: string;
  authorizationStatus: 'pending' | 'approved' | 'revoked';
  approved: boolean;
  publicKeyFingerprint?: string;
};

type LAPSandboxTaskProjection = {
  taskId: string;
  type: string;
  status: 'pending' | 'accepted' | 'rejected' | 'running' | 'completed' | 'failed' | 'unknown';
  result?: Record<string, unknown>;
  error?: string;
  receiptStatus?: 'pending' | 'failed' | 'unknown' | 'peer_reported' | 'peer_reported_late';
  updatedAt: string;
};

type LAPContextProjection = {
  id: string;
  sessionId: string;
  entry: {
    type: 'memory' | 'preference' | 'capability' | 'knowledge';
    payload: string;
    confidence: number;
    tags?: string[];
  };
  sharedAt: string;
  expiresAt?: string;
};

type ExternalAiSessionProjection = {
  session: {
    id: string;
    question: string;
    status: string;
    targetIds: string[];
    updatedAt: string;
  };
  counts?: { targets?: number; answered?: number; pending?: number; unknown?: number };
};

type CommunityLumiDirectory = {
  configured: boolean;
  status: 'not_configured' | 'online' | 'offline' | 'invalid_configuration';
  sourceOrigin: string;
  fetchedAt: string;
  error?: string;
  profiles: Array<{
    agentId: string;
    displayName: string;
    description: string;
    capabilities: string[];
    trustTags: string[];
    homeNode: string;
    publicKeyFingerprint: string;
    updatedAt: string;
  }>;
};

type DeskState = 'ready' | 'working' | 'paused' | 'attention';

const ACTIVE_BACKGROUND_STATES = new Set(['queued', 'running', 'cancelling']);

function deskState(agent: CommandAgent, tasks: BackgroundTask[]): DeskState {
  if (agent.isFrozen || agent.status === 'terminated') return 'paused';
  if (agent.runtime === 'external' && agent.healthStatus !== 'online') return 'attention';
  if (agent.lastRunStatus === 'failed') return 'attention';
  const normalizedName = String(agent.name || '').trim().toLowerCase();
  const isWorking = tasks.some(task => (
    ACTIVE_BACKGROUND_STATES.has(String(task.status || '').toLowerCase()) &&
    (task.workerNames || []).some(name => String(name || '').trim().toLowerCase() === normalizedName)
  ));
  return isWorking ? 'working' : 'ready';
}

export function CommandCenterPanel({
  t,
  view,
  onViewChange,
  onOpenNexus,
}: {
  t?: any;
  view: CommandCenterView;
  onViewChange: (view: CommandCenterView) => void;
  onOpenNexus?: () => void;
}) {
  const { workDomain, orgConnection } = useApp();
  const isWork = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId);
  const scopeKey = `${isWork ? 'work' : 'personal'}:${isWork ? orgConnection?.orgId || '' : ''}`;
  const [agents, setAgents] = useState<CommandAgent[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [lapPolicy, setLapPolicy] = useState<LAPPolicy | null>(null);
  const [lapSessions, setLapSessions] = useState<LAPSessionProjection[]>([]);
  const [externalCapabilityCount, setExternalCapabilityCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pairingSessionId, setPairingSessionId] = useState('');
  const [pairingToken, setPairingToken] = useState('');
  const [pairingExpiresAt, setPairingExpiresAt] = useState('');
  const [creatingPairing, setCreatingPairing] = useState(false);
  const [probingSessionId, setProbingSessionId] = useState('');
  const [probePrompt, setProbePrompt] = useState<Record<string, string>>({});
  const [probeResult, setProbeResult] = useState<Record<string, { tone: 'ready' | 'error'; text: string }>>({});
  const [contextsBySession, setContextsBySession] = useState<Record<string, LAPContextProjection[]>>({});
  const [contextLoadingSessionId, setContextLoadingSessionId] = useState('');
  const [absorbingContextId, setAbsorbingContextId] = useState('');
  const [externalAiSessions, setExternalAiSessions] = useState<ExternalAiSessionProjection[]>([]);
  const [communityDirectory, setCommunityDirectory] = useState<CommunityLumiDirectory | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(true);
  const officeActive = view === 'office' || view === 'team';
  const { status, loading: runtimeLoading, error: runtimeError, refresh: refreshRuntime } = useRuntimeStatus({
    enabled: officeActive || view === 'core',
    scopeKey,
  });
  const { scene, loading: sceneLoading, error: sceneError, refresh: refreshScene } = useLumiScene({
    enabled: view === 'core',
    scopeKey,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    const [agentResult, taskResult, lapResult, sessionResult, catalogResult, externalAiResult, communityResult] = await Promise.allSettled([
      apiFetch('/api/agents').then(async response => response.ok ? response.json() : []),
      apiFetch('/api/autonomy/background-tasks').then(async response => response.ok ? response.json() : {}),
      apiFetch('/api/lap/policy').then(async response => response.ok ? response.json() : null),
      apiFetch('/api/lap/sessions').then(async response => response.ok ? response.json() : { sessions: [] }),
      apiFetch('/api/marketplace/skills').then(async response => response.ok ? response.json() : []),
      apiFetch('/api/command-center/external-ai-sessions?limit=8').then(async response => response.ok ? response.json() : { sessions: [] }),
      apiFetch('/api/command-center/community-lumi?limit=12').then(async response => response.json()),
    ]);
    if (agentResult.status === 'fulfilled') {
      const payload = agentResult.value;
      setAgents(Array.isArray(payload) ? payload : Array.isArray(payload?.agents) ? payload.agents : []);
    }
    if (taskResult.status === 'fulfilled') {
      setBackgroundTasks(Array.isArray(taskResult.value?.tasks) ? taskResult.value.tasks : []);
    }
    if (lapResult.status === 'fulfilled') setLapPolicy(lapResult.value || null);
    if (sessionResult.status === 'fulfilled') {
      const sessions = Array.isArray(sessionResult.value?.sessions) ? sessionResult.value.sessions as LAPSessionProjection[] : [];
      setLapSessions(sessions);
      const approvedSessions = sessions.filter(session => session.approved);
      const taskResults = await Promise.allSettled(approvedSessions.map(async session => {
        const response = await apiFetch(`/api/lap/sessions/${encodeURIComponent(session.sessionId)}/tasks`);
        if (!response.ok) return null;
        const payload = await response.json();
        const tasks = (Array.isArray(payload?.tasks) ? payload.tasks : []) as LAPSandboxTaskProjection[];
        const latest = tasks
          .filter(task => task.type === 'sandbox_capability_probe')
          .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
        return latest ? { sessionId: session.sessionId, task: latest } : null;
      }));
      setProbeResult(previous => {
        const next = { ...previous };
        for (const result of taskResults) {
          if (result.status !== 'fulfilled' || !result.value) continue;
          const { sessionId, task } = result.value;
          if (task.status === 'completed') {
            const output = task.result ? JSON.stringify(task.result) : uiMessage('command-center.probe-empty-result.3305720766');
            next[sessionId] = {
              tone: 'ready',
              text: `${task.receiptStatus === 'peer_reported_late' ? uiMessage('command-center.probe-late-result.9258116370') : uiMessage('command-center.probe-peer-result.bdb7e14f0e')} · ${output}`,
            };
          } else if (task.status === 'failed' || task.status === 'rejected' || task.status === 'unknown') {
            next[sessionId] = {
              tone: 'error',
              text: task.status === 'unknown'
                ? uiMessage('command-center.probe-unknown.2a2fb722a9')
                : String(task.error || uiMessage('command-center.probe-failed.c49ff322d4')),
            };
          } else {
            next[sessionId] = { tone: 'ready', text: `${uiMessage('command-center.probe-in-progress.218ffae286')} · ${task.taskId}` };
          }
        }
        return next;
      });
    }
    if (catalogResult.status === 'fulfilled') {
      const catalog = Array.isArray(catalogResult.value) ? catalogResult.value : [];
      setExternalCapabilityCount(catalog.filter((item: any) => item?.runtime === 'external').length);
    }
    if (externalAiResult.status === 'fulfilled') {
      setExternalAiSessions(Array.isArray(externalAiResult.value?.sessions) ? externalAiResult.value.sessions : []);
    }
    if (communityResult.status === 'fulfilled') setCommunityDirectory(communityResult.value || null);
    setLoading(false);
  }, []);

  const approvePeer = useCallback(async (session: LAPSessionProjection) => {
    const accepted = await appConfirm({
      title: uiMessage('command-center.authorize-lumi-title.846a6924d8'),
      message: `${session.peer.name}\n${uiMessage('command-center.authorize-lumi-message.30ce57f561')}\n${(session.requestedScope || []).join(', ') || 'none'}`,
      confirmText: uiMessage('command-center.authorize.76b1820f2e'),
      cancelText: uiMessage('command-center.cancel.7cc65d915c'),
    });
    if (!accepted) return;
    setPairingSessionId(session.sessionId);
    try {
      const response = await apiFetch(`/api/lap/sessions/${encodeURIComponent(session.sessionId)}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerAgentId: session.peer.agentId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_claim_http_${response.status}`);
      toast.success(uiMessage('command-center.lumi-authorized.40cd471ea1'));
      await refresh();
    } catch (error: any) {
      toast.error(String(error?.message || uiMessage('command-center.lumi-authorization-failed.3a7a2f588e')));
    } finally {
      setPairingSessionId('');
    }
  }, [refresh]);

  const revokePeer = useCallback(async (session: LAPSessionProjection) => {
    const accepted = await appConfirm({
      title: uiMessage('command-center.revoke-lumi-title.78ce82ea42'),
      message: `${session.peer.name}\n${uiMessage('command-center.revoke-lumi-message.84e087b4b4')}`,
      confirmText: uiMessage('command-center.revoke.6fd9cdb478'),
      cancelText: uiMessage('command-center.cancel.7cc65d915c'),
      tone: 'danger',
    });
    if (!accepted) return;
    setPairingSessionId(session.sessionId);
    try {
      const response = await apiFetch(`/api/lap/sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_revoke_http_${response.status}`);
      toast.success(uiMessage('command-center.lumi-revoked.2aa9c7cb16'));
      await refresh();
    } catch (error: any) {
      toast.error(String(error?.message || uiMessage('command-center.lumi-revoke-failed.c5522c7067')));
    } finally {
      setPairingSessionId('');
    }
  }, [refresh]);

  const createPairing = useCallback(async () => {
    setCreatingPairing(true);
    try {
      const response = await apiFetch('/api/lap/pairing-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedScopes: ['share_context', 'delegate_task', 'notify'] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_pairing_http_${response.status}`);
      setPairingToken(String(payload.pairingToken || ''));
      setPairingExpiresAt(String(payload.expiresAt || ''));
    } catch (error: any) {
      toast.error(String(error?.message || uiMessage('command-center.pairing-ticket-failed.18a94503f7')));
    } finally {
      setCreatingPairing(false);
    }
  }, []);

  const copyPairingToken = useCallback(async () => {
    if (!pairingToken) return;
    try {
      await navigator.clipboard.writeText(pairingToken);
      toast.success(uiMessage('command-center.pairing-token-copied.e23d53b09a'));
    } catch {
      toast.error(uiMessage('command-center.copy-failed.150177ecfd'));
    }
  }, [pairingToken]);

  const runSandboxProbe = useCallback(async (session: LAPSessionProjection) => {
    const prompt = String(probePrompt[session.sessionId] || '').replace(/\s+/g, ' ').trim();
    if (!prompt) {
      toast.error(uiMessage('command-center.probe-prompt-required.087c5892c3'));
      return;
    }
    setProbingSessionId(session.sessionId);
    setProbeResult(previous => ({ ...previous, [session.sessionId]: { tone: 'ready', text: uiMessage('command-center.probe-running.a478c0bc0e') } }));
    try {
      const response = await apiFetch(`/api/lap/sessions/${encodeURIComponent(session.sessionId)}/sandbox-probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_probe_http_${response.status}`);
      setProbeResult(previous => ({
        ...previous,
        [session.sessionId]: {
          tone: 'ready',
          text: `${uiMessage('command-center.probe-accepted.66ac386914')} · ${String(payload.taskId || '')}`,
        },
      }));
    } catch (error: any) {
      setProbeResult(previous => ({ ...previous, [session.sessionId]: { tone: 'error', text: String(error?.message || uiMessage('command-center.probe-failed.c49ff322d4')) } }));
    } finally {
      setProbingSessionId('');
    }
  }, [probePrompt]);

  const loadPeerContexts = useCallback(async (session: LAPSessionProjection) => {
    setContextLoadingSessionId(session.sessionId);
    try {
      const response = await apiFetch(`/api/lap/contexts/${encodeURIComponent(session.sessionId)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_context_http_${response.status}`);
      setContextsBySession(previous => ({ ...previous, [session.sessionId]: Array.isArray(payload.contexts) ? payload.contexts : [] }));
    } catch (error: any) {
      toast.error(String(error?.message || uiMessage('command-center.context-load-failed.d5b5a2c9f7')));
    } finally {
      setContextLoadingSessionId('');
    }
  }, []);

  const absorbPeerContext = useCallback(async (session: LAPSessionProjection, context: LAPContextProjection) => {
    const accepted = await appConfirm({
      title: uiMessage('command-center.absorb-title.c816db1ecf'),
      message: `${context.entry.payload.slice(0, 300)}\n\n${uiMessage('command-center.absorb-warning.b839cc486f')}`,
      confirmText: uiMessage('command-center.absorb.55c9e779c1'),
      cancelText: uiMessage('command-center.cancel.7cc65d915c'),
    });
    if (!accepted) return;
    setAbsorbingContextId(context.id);
    try {
      const response = await apiFetch(`/api/lap/sessions/${encodeURIComponent(session.sessionId)}/contexts/${encodeURIComponent(context.id)}/absorb`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `lap_absorb_http_${response.status}`);
      toast.success(uiMessage('command-center.absorbed-with-provenance.5bf8ad2639'));
    } catch (error: any) {
      toast.error(String(error?.message || uiMessage('command-center.absorb-failed.b79b8245d7')));
    } finally {
      setAbsorbingContextId('');
    }
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-400/[0.06] text-cyan-100/60 transition-colors hover:bg-cyan-400/[0.12] hover:text-cyan-50"
              title={uiMessage('command-center.office.26fdbd3a4a')}
            >
              <Building2 size={14} />
            </button>
            <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-black text-white/90">
              <Command size={16} className="text-cyan-200" />
              {view === 'network' ? uiMessage('command-center.network.e5d531b657') : uiMessage('command-center.core.1b1073a209')}
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

            <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/[0.08] bg-[#050b13]/74 p-1.5 shadow-2xl shadow-black/35 backdrop-blur-2xl">
              <button type="button" onClick={() => onViewChange('network')} className="flex h-9 items-center gap-2 rounded-xl px-3 text-[10px] font-bold text-cyan-100/65 transition-colors hover:bg-cyan-400/[0.10] hover:text-cyan-50" title={uiMessage('command-center.network.e5d531b657')}>
                <Network size={13} />
                <span>{uiMessage('command-center.network.e5d531b657')}</span>
              </button>
              <button type="button" onClick={() => onOpenNexus ? onOpenNexus() : onViewChange('core')} className="flex h-9 items-center gap-2 rounded-xl px-3 text-[10px] font-bold text-violet-100/70 transition-colors hover:bg-violet-400/[0.12] hover:text-violet-50" title={uiMessage('command-center.core.1b1073a209')}>
                <Cpu size={13} />
                <span>{uiMessage('command-center.core.1b1073a209')}</span>
              </button>
              <button type="button" onClick={() => setLedgerOpen(current => !current)} className={`flex h-9 items-center gap-2 rounded-xl px-3 text-[10px] font-bold transition-colors ${ledgerOpen ? 'bg-white/[0.07] text-white/75' : 'text-white/40 hover:bg-white/[0.05] hover:text-white/70'}`} title={uiMessage('command-center.real-task-ledger.5b1be77168')}>
                <Crosshair size={13} />
                <span>{uiMessage('command-center.tasks.1ddfd1ee9d')}</span>
              </button>
              <button type="button" onClick={() => { void refresh(); void refreshRuntime(); refreshScene(true); }} className="flex h-9 w-9 items-center justify-center rounded-xl text-white/35 transition-colors hover:bg-white/[0.05] hover:text-white/70" title={uiMessage('command-center.refresh.7436ee304a')}>
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            {ledgerOpen && <aside className="custom-scrollbar absolute bottom-4 right-4 top-16 z-30 w-[min(310px,calc(100%-2rem))] overflow-y-auto rounded-[1.75rem] border border-white/[0.08] bg-[#050b13]/78 p-3 shadow-2xl shadow-black/35 backdrop-blur-2xl" aria-label={uiMessage('command-center.real-task-ledger.5b1be77168')}>
              <div className="sticky top-0 z-10 mb-3 border-b border-white/[0.06] bg-[#050a11]/95 pb-3 backdrop-blur-xl">
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-white/55">
                  <span className="flex items-center gap-2"><Crosshair size={12} />{uiMessage('command-center.real-task-ledger.5b1be77168')}</span>
                  <span className="font-normal normal-case tracking-normal text-white/28">{uiMessage('command-center.receipt-driven.c10f9390d4')}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-xl bg-cyan-400/[0.06] px-1 py-2"><div className="text-base font-black text-cyan-100">{status?.counts.activeTasks || 0}</div><div className="text-[8px] text-white/28">{uiMessage('command-center.active-tasks.e3c67ca0fe')}</div></div>
                  <div className="rounded-xl bg-white/[0.035] px-1 py-2"><div className="text-base font-black text-white/75">{activeBackgroundCount}</div><div className="text-[8px] text-white/28">{uiMessage('command-center.background-tasks.99e4258af0')}</div></div>
                  <div className="rounded-xl bg-amber-400/[0.05] px-1 py-2"><div className="text-base font-black text-amber-100">{status?.counts.waitingConfirmation || 0}</div><div className="text-[8px] text-white/28">{uiMessage('command-center.confirmations.60da2ef07a')}</div></div>
                </div>
              </div>
              <div className="space-y-2">
                {(status?.tasks || []).length > 0 ? status!.tasks.slice(0, 12).map(task => (
                  <article key={task.taskId} className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {task.status === 'waiting_confirmation' ? <ShieldAlert size={12} className="shrink-0 text-amber-200" /> : <Clock3 size={12} className="shrink-0 text-cyan-200" />}
                      <span className="min-w-0 flex-1 text-xs font-bold leading-relaxed text-white/75">{task.goal}</span>
                      <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] text-white/42">{task.status}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between pl-5 text-[9px] text-white/30">
                      <span>{task.evidence.verified}/{task.evidence.total} {uiMessage('command-center.verified-receipts.02cc95eeba')}</span>
                      <span className="truncate font-mono">{task.taskId}</span>
                    </div>
                  </article>
                )) : (
                  <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-12 text-center text-[10px] leading-relaxed text-white/28">{uiMessage('command-center.real-state.33d73ad8c9')}</div>
                )}
              </div>
            </aside>}
          </div>
        )}

        {view === 'network' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-emerald-300/15 bg-emerald-400/[0.05] p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-emerald-100/80"><CheckCircle2 size={14} />{uiMessage('command-center.local-lumi.11866c1402')}</div>
                <div className="mt-2 truncate text-sm font-black text-white/85">{lapPolicy?.localAgent?.name || 'Lumi'}</div>
                <div className="mt-1 font-mono text-[10px] text-white/32">{lapPolicy?.protocol || 'LAP'} {lapPolicy?.version || '2.0'}</div>
              </div>
              <div className="rounded-2xl border border-violet-300/15 bg-violet-400/[0.05] p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-violet-100/80"><Boxes size={14} />{uiMessage('command-center.available-capabilities.1a80c899d2')}</div>
                <div className="mt-2 text-2xl font-black text-white/85">{externalCapabilityCount}</div>
                <div className="mt-1 text-[10px] text-white/32">{uiMessage('command-center.marketplace-runtimes.52d43cf3bd')}</div>
              </div>
            </div>

            <div className="rounded-2xl border border-cyan-300/12 bg-cyan-400/[0.035] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-bold text-cyan-100/75"><Link2 size={13} />{uiMessage('command-center.pair-another-lumi.166e66dcab')}</div>
                  <p className="mt-1 text-[10px] leading-relaxed text-white/32">{uiMessage('command-center.pairing-ticket-note.48c906291e')}</p>
                </div>
                <button type="button" disabled={creatingPairing} onClick={() => void createPairing()} className="shrink-0 rounded-lg border border-cyan-300/15 bg-cyan-400/[0.08] px-2.5 py-1.5 text-[9px] font-bold text-cyan-100/75 disabled:opacity-40">{creatingPairing ? <Loader2 size={11} className="animate-spin" /> : uiMessage('command-center.create-pairing-ticket.23c7b7105a')}</button>
              </div>
              {pairingToken && (
                <button type="button" onClick={() => void copyPairingToken()} className="mt-3 w-full rounded-xl border border-white/[0.08] bg-black/25 px-3 py-2 text-left">
                  <span className="block break-all font-mono text-[10px] text-cyan-100/70">{pairingToken}</span>
                  <span className="mt-1 block text-[9px] text-white/28">{uiMessage('command-center.click-to-copy.3a8b4d21c1')} · {pairingExpiresAt ? new Date(pairingExpiresAt).toLocaleTimeString() : ''}</span>
                </button>
              )}
            </div>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-white/42">
                <span className="flex items-center gap-2"><Network size={12} />{uiMessage('command-center.community-lumi.2a9df06015')}</span>
                <span className="font-normal normal-case tracking-normal text-white/25">{communityDirectory?.profiles.length || 0}</span>
              </div>
              {communityDirectory?.status === 'online' ? (
                communityDirectory.profiles.length > 0 ? communityDirectory.profiles.map(profile => (
                  <article key={`${profile.agentId}:${profile.publicKeyFingerprint}`} className="rounded-xl border border-cyan-300/10 bg-cyan-400/[0.03] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-white/72">{profile.displayName}</div>
                        <div className="mt-1 truncate font-mono text-[9px] text-white/25">{profile.agentId} · {profile.publicKeyFingerprint.slice(0, 12)}</div>
                      </div>
                      <span className="shrink-0 rounded-full border border-cyan-300/12 px-2 py-0.5 text-[9px] text-cyan-100/55">{profile.homeNode || uiMessage('command-center.community-node.75930e79ad')}</span>
                    </div>
                    {profile.description && <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-white/38">{profile.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1">{profile.capabilities.slice(0, 6).map(capability => <span key={capability} className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[9px] text-white/35">{capability}</span>)}</div>
                  </article>
                )) : <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-5 text-center text-[10px] text-white/28">{uiMessage('command-center.community-empty.2ff60e4e91')}</div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-4 text-[10px] leading-relaxed text-white/30">
                  {communityDirectory?.status === 'offline' || communityDirectory?.status === 'invalid_configuration'
                    ? `${uiMessage('command-center.community-offline.37b0415de7')}${communityDirectory.error ? ` · ${communityDirectory.error}` : ''}`
                    : uiMessage('command-center.community-not-configured.70ac8f734b')}
                </div>
              )}
              <p className="text-[9px] leading-relaxed text-white/24">{uiMessage('command-center.community-boundary.181ef36bbd')}</p>
            </section>

            {lapSessions.length > 0 ? (
              <div className="space-y-2">
                {lapSessions.map(session => (
                  <div key={session.sessionId} className="rounded-2xl border border-cyan-300/12 bg-cyan-400/[0.04] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0"><div className="truncate text-sm font-bold text-white/85">{session.peer.name}</div><div className="mt-1 font-mono text-[10px] text-white/30">{session.peer.agentId}</div></div>
                      <span className={`rounded-full border px-2 py-1 text-[9px] font-bold ${session.approved ? 'border-emerald-300/15 text-emerald-100/70' : 'border-amber-300/15 text-amber-100/70'}`}>{session.approved ? uiMessage('command-center.authorized.4357a61fc6') : uiMessage('command-center.pending-authorization.81ff59477b')}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">{(session.approved ? session.scope : session.requestedScope).map(scope => <span key={scope} className="rounded-full bg-white/[0.04] px-2 py-1 text-[9px] text-white/38">{scope}</span>)}</div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[9px] text-white/28">
                        {session.trustLevel}{session.publicKeyFingerprint ? ` · ${session.publicKeyFingerprint.slice(0, 12)}` : ''}
                      </span>
                      {session.approved ? (
                        <button type="button" disabled={pairingSessionId === session.sessionId} onClick={() => void revokePeer(session)} className="flex items-center gap-1.5 rounded-lg border border-red-300/15 bg-red-400/[0.06] px-2.5 py-1.5 text-[9px] font-bold text-red-100/70 disabled:opacity-40"><Unplug size={10} />{uiMessage('command-center.revoke.6fd9cdb478')}</button>
                      ) : (
                        <button type="button" disabled={pairingSessionId === session.sessionId} onClick={() => void approvePeer(session)} className="flex items-center gap-1.5 rounded-lg border border-cyan-300/15 bg-cyan-400/[0.08] px-2.5 py-1.5 text-[9px] font-bold text-cyan-100/75 disabled:opacity-40">{pairingSessionId === session.sessionId ? <Loader2 size={10} className="animate-spin" /> : <Link2 size={10} />}{uiMessage('command-center.authorize.76b1820f2e')}</button>
                      )}
                    </div>
                    {session.approved && session.scope.includes('delegate_task') && (
                      <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-2.5">
                        <div className="text-[9px] font-bold uppercase tracking-wider text-white/38">{uiMessage('command-center.sandbox-probe.8dd49c2607')}</div>
                        <div className="mt-2 flex gap-2">
                          <input
                            value={probePrompt[session.sessionId] || ''}
                            onChange={event => setProbePrompt(previous => ({ ...previous, [session.sessionId]: event.target.value }))}
                            placeholder={uiMessage('command-center.sandbox-probe-placeholder.7cde36e482')}
                            className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[10px] text-white/70 outline-none placeholder:text-white/22 focus:border-cyan-300/20"
                          />
                          <button type="button" disabled={probingSessionId === session.sessionId} onClick={() => void runSandboxProbe(session)} className="shrink-0 rounded-lg border border-violet-300/15 bg-violet-400/[0.08] px-2.5 py-1.5 text-[9px] font-bold text-violet-100/70 disabled:opacity-40">{probingSessionId === session.sessionId ? <Loader2 size={10} className="animate-spin" /> : uiMessage('command-center.run-probe.a9d83908f4')}</button>
                        </div>
                        <div className="mt-1.5 text-[9px] leading-relaxed text-white/27">{uiMessage('command-center.sandbox-limits.289559ff72')}</div>
                        {probeResult[session.sessionId] && <div className={`mt-2 break-all text-[9px] ${probeResult[session.sessionId].tone === 'error' ? 'text-red-200/70' : 'text-cyan-100/60'}`}>{probeResult[session.sessionId].text}</div>}
                      </div>
                    )}
                    {session.approved && session.scope.includes('share_context') && (
                      <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[9px] font-bold uppercase tracking-wider text-white/38">{uiMessage('command-center.selective-absorption.56fd31ae52')}</div>
                          <button type="button" disabled={contextLoadingSessionId === session.sessionId} onClick={() => void loadPeerContexts(session)} className="rounded-lg border border-white/[0.08] px-2 py-1 text-[9px] text-white/45 disabled:opacity-40">{contextLoadingSessionId === session.sessionId ? <Loader2 size={9} className="animate-spin" /> : uiMessage('command-center.inspect-context.8966bf16d6')}</button>
                        </div>
                        {(contextsBySession[session.sessionId] || []).length === 0 ? (
                          <div className="mt-2 text-[9px] leading-relaxed text-white/25">{uiMessage('command-center.no-external-context.762357399e')}</div>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {(contextsBySession[session.sessionId] || []).map(context => {
                              const absorbable = context.entry.type === 'knowledge' || context.entry.type === 'capability';
                              return (
                                <div key={context.id} className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="text-[9px] font-bold text-cyan-100/55">{context.entry.type} · {Math.round(context.entry.confidence * 100)}%</div>
                                      <p className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-white/45">{context.entry.payload}</p>
                                    </div>
                                    {absorbable && <button type="button" disabled={absorbingContextId === context.id} onClick={() => void absorbPeerContext(session, context)} className="shrink-0 rounded-lg border border-emerald-300/15 bg-emerald-400/[0.07] px-2 py-1 text-[9px] font-bold text-emerald-100/65 disabled:opacity-40">{absorbingContextId === context.id ? <Loader2 size={9} className="animate-spin" /> : uiMessage('command-center.absorb.55c9e779c1')}</button>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center text-xs leading-relaxed text-white/35">{uiMessage('command-center.no-peers.b9c177fcb5')}</div>
            )}

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-white/42">
                <span className="flex items-center gap-2"><Boxes size={12} />{uiMessage('command-center.external-ai-collaboration.041cce3f7e')}</span>
                <span className="font-normal normal-case tracking-normal text-white/25">{externalAiSessions.length}</span>
              </div>
              {externalAiSessions.length > 0 ? externalAiSessions.map(item => (
                <article key={item.session.id} className="rounded-xl border border-violet-300/10 bg-violet-400/[0.035] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1 truncate text-xs font-bold text-white/72">{item.session.question}</div>
                    <span className="rounded-full border border-violet-300/12 px-2 py-0.5 text-[9px] text-violet-100/55">{item.session.status}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-white/28">
                    <span className="truncate">{(item.session.targetIds || []).join(' · ')}</span>
                    <span className="shrink-0">{item.counts?.answered || 0}/{item.counts?.targets || 0} {uiMessage('command-center.answers.2508a7e9d3')}</span>
                  </div>
                </article>
              )) : (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-5 text-center text-[10px] leading-relaxed text-white/28">{uiMessage('command-center.no-external-ai-sessions.123849148a')}</div>
              )}
            </section>

            <div className="rounded-2xl border border-amber-300/15 bg-amber-400/[0.05] p-4 text-xs leading-relaxed text-amber-50/65">
              <div className="mb-2 flex items-center gap-2 font-bold"><ShieldCheck size={14} />{uiMessage('command-center.context-firewall.17a3907fd4')}</div>
              {uiMessage('command-center.external-context.5de665e847')}
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
