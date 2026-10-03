import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'motion/react';
import { Loader2, Sparkles, GitBranch, TrendingUp, Clock, Target, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { useT } from '../lib/useT';
import { uiMessage } from '../i18n/uiMessages';
import { personalityEvolutionCopy } from '../i18n/locales/personalityEvolution';

import { apiJson } from '../services/apiClient';
import type { EvolutionStep as StoredEvolutionStep } from '../../server/personality/evolution';
import type { PersonalityConfig, PersonalityEvolutionAudit, PersonalityGrowthState, PersonalityVector } from '../../server/personality/types';

type EvolutionStep = Pick<StoredEvolutionStep, 'version' | 'timestamp' | 'mutations' | 'narrative'> & {
  auditId?: string;
  trigger: string;
  ownerProfile?: StoredEvolutionStep['ownerProfile'];
};

interface EvolutionData {
  personalityId: string;
  currentVector: PersonalityVector | null;
  version: string;
  evolutionConfig: NonNullable<PersonalityConfig['evolutionConfig']>;
  history: EvolutionStep[];
  audit?: PersonalityEvolutionAudit[];
  growthState?: PersonalityGrowthState | null;
  evolutionFrozenAt?: string | null;
}

interface Props {
  personalityId?: string;
}

const RADAR_AXES = ['analytical', 'intuitive', 'systematic', 'creative', 'warmth', 'directness', 'playfulness', 'formality'].map((dim, index, dimensions) => {
  const angle = (Math.PI * 2 * index) / dimensions.length - Math.PI / 2;
  return { dim, cosine: Math.cos(angle), sine: Math.sin(angle) };
});

/** Compute 8-vertex SVG polygon points for a given set of dimension values */
function getRadarPoints(cx: number, cy: number, radius: number, values?: Record<string, number>) {
  const vertices = RADAR_AXES.map(({ dim, cosine, sine }) => {
    const value = values ? Math.max(0.05, values[dim] || 0) : 1;
    return { x: cx + radius * value * cosine, y: cy + radius * value * sine };
  });
  return { points: vertices.map(v => `${v.x},${v.y}`).join(' '), vertices };
}

/** Reconstruct each historical vector in one reverse pass. */
function getEvolutionVectors(data: EvolutionData | null): Record<string, number>[] {
  if (!data?.currentVector) return [];
  const values: Record<string, number> = { ...data.currentVector.cognitiveStyle, ...data.currentVector.socialStyle };
  const vectors: Record<string, number>[] = new Array(data.history.length);
  for (let index = data.history.length - 1; index >= 0; index--) {
    vectors[index] = { ...values };
    if (index > 0) for (const mutation of data.history[index].mutations) {
      const parts = mutation.field.split('.');
      if (parts[0] === 'personalityVector' && parts.length === 3 && values[parts[2]] !== undefined && typeof mutation.from === 'number') values[parts[2]] = mutation.from;
    }
  }
  return vectors;
}

export function PersonalityEvolution({ personalityId = 'lumi' }: Props) {
  const { user, workDomain, orgConnection } = useApp();
  const owner = JSON.stringify([personalityId, user?.uid, user?.role, workDomain, orgConnection?.orgId]);
  return <EvolutionView key={owner} personalityId={personalityId} />;
}

function EvolutionView({ personalityId }: { personalityId: string }) {
  const t = useT();
  const { addNotification, user, workDomain, orgConnection } = useApp();
  const orgId = workDomain === 'work' ? orgConnection?.orgId || '' : '';
  const isZh = t.langCode !== 'en';
  const copy = personalityEvolutionCopy(isZh ? 'zh' : 'en');
  const DIM_LABELS = copy.dimensions as Record<string, string>;

  const [data, setData] = useState<EvolutionData | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const requests = useRef({ active: false, pendingEvent: false, read: null as AbortController | null, write: null as AbortController | null }).current;
  const messages = useRef({ t, copy });
  messages.current = { t, copy };
  const socket = useSocket();
  const baseUrl = `/api/personality/${encodeURIComponent(personalityId)}`;

  const fetchEvolutionData = useCallback(async (latest = false) => {
    if (!requests.active) return false;
    requests.read?.abort();
    const controller = requests.read = new AbortController();
    try {
      const next = await apiJson<EvolutionData>(baseUrl + '/evolution', { signal: controller.signal });
      if (controller.signal.aborted) return false;
      if (!next || next.personalityId !== personalityId || !Array.isArray(next.history)
        || typeof next.evolutionConfig?.plasticity !== 'number' || typeof next.evolutionConfig?.cooldownMs !== 'number') {
        throw new Error(messages.current.t.failedToLoadEvolution);
      }
      setData(next);
      setSelectedStep(next.history.length ? (latest ? next.history.length - 1 : 0) : null);
      setError('');
      return next;
    } catch (cause: any) {
      if (!controller.signal.aborted) setError(cause?.message || messages.current.t.failedToLoadEvolution);
      return false;
    } finally {
      if (requests.read === controller) requests.read = null;
    }
  }, [baseUrl, personalityId, requests]);

  useEffect(() => {
    requests.active = true;
    void fetchEvolutionData();
    return () => { requests.active = false; requests.read?.abort(); requests.write?.abort(); };
  }, [fetchEvolutionData, requests]);

  const mutate = async (action: 'evolve' | 'freeze' | 'revert') => {
    if (!requests.active || requests.write || !data || error
      || (action === 'evolve' && data.evolutionFrozenAt)
      || (action === 'revert' && (!selected?.auditId || !selectedAudit?.reversible || selectedAudit.status === 'reverted'))) return;
    const controller = requests.write = new AbortController();
    requests.read?.abort();
    setOperation(action);
    try {
      const body = action === 'freeze' ? { frozen: !data.evolutionFrozenAt } : action === 'revert' ? { auditId: selected!.auditId } : undefined;
      const result = await apiJson(baseUrl + (action === 'evolve' ? '/evolve' : '/evolution/' + action), {
        method: 'POST', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (controller.signal.aborted) return;
      if (!result || (action === 'evolve' ? typeof result.evolved !== 'boolean'
        : action === 'freeze' ? result.frozen !== !data.evolutionFrozenAt : result.reverted !== true || result.auditId !== selected!.auditId)) {
        setError(messages.current.copy.unconfirmed);
        return;
      }
      requests.pendingEvent = false;
      const next = await fetchEvolutionData(action === 'evolve' && result.evolved);
      if (next && !controller.signal.aborted) {
        if ((action === 'freeze' && Boolean(next.evolutionFrozenAt) !== !data.evolutionFrozenAt)
          || (action === 'revert' && !next.audit?.some(audit => audit.id === selected!.auditId && audit.status === 'reverted'))) {
          setError(messages.current.copy.unconfirmed);
          return;
        }
        if (action === 'evolve' && !result.evolved) toast.info(result.reason || messages.current.copy.noChange);
        else toast.success(action === 'evolve' ? messages.current.t.personalityEvolved : action === 'revert'
          ? uiMessage('personality-evolution.evolution-reverted.b147387ec8')
          : uiMessage(data.evolutionFrozenAt ? 'personality-evolution.evolution-unfrozen.c118b2912f' : 'personality-evolution.evolution-frozen.09edf7e1bf'));
      }
    } catch (cause: any) {
      if (!controller.signal.aborted) toast.error(cause?.message || messages.current.copy.unconfirmed);
    } finally {
      if (requests.write === controller) { requests.write = null; if (requests.active) setOperation(''); }
      if (requests.active && requests.pendingEvent) { requests.pendingEvent = false; void fetchEvolutionData(); }
    }
  };

  // Listen for real-time evolution events via WebSocket
  useEffect(() => {
    if (!socket) return;
    const handler = (event: { personalityId: string; userId?: string; orgId?: string; version: string; narrative: string }) => {
      if (event.personalityId !== personalityId || event.userId !== user?.uid || (event.orgId || '') !== orgId) return;
      addNotification({ type: 'system', title: `${t.lumiEvolvedTo || uiMessage('personality-evolution.lumi-evolved-to.08b443c0e5')} ${event.version}!`, message: event.narrative?.slice(0, 100) || event.version });
      if (requests.write) requests.pendingEvent = true;
      else void fetchEvolutionData();
    };
    socket.on('personality:evolved', handler);
    return () => { socket.off('personality:evolved', handler); };
  }, [socket, personalityId, user?.uid, orgId, fetchEvolutionData, addNotification, t.lumiEvolvedTo, requests]);

  const triggerEvolution = () => void mutate('evolve');
  const toggleFreeze = () => void mutate('freeze');
  const revertSelected = () => void mutate('revert');
  const busy = Boolean(operation) || !data || Boolean(error);

  const vectors = useMemo(() => getEvolutionVectors(data), [data]);
  if (!data && !error) {
    return (
      <div className="lumi-panel flex h-full items-center justify-center bg-zinc-950/60">
        <Loader2 size={24} className="animate-spin text-white/55" />
      </div>
    );
  }

  const hasHistory = data && data.history.length > 0;
  const evolutionSteps = data?.history || [];
  const selected = selectedStep !== null && selectedStep !== undefined ? evolutionSteps[selectedStep] : null;
  const selectedAudit = selected?.auditId ? data?.audit?.find(a => a.id === selected.auditId) : null;

  const cx = 150, cy = 150, r = 130;

  return (
    <div className="lumi-surface h-full overflow-hidden rounded-2xl bg-zinc-950/75">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.08] p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-fuchsia-300/15 bg-fuchsia-400/10 text-fuchsia-300">
            <GitBranch size={18} />
          </span>
          <div>
            <h2 className="text-sm font-black text-white/90 uppercase tracking-wider">{t.personalityEvolution || uiMessage('personality-evolution.personality-evolution.e4e10dc508')}</h2>
            {data && (
              <p className="text-xs text-white/55 font-mono">
                v{data.version} &middot; {evolutionSteps.length} step{evolutionSteps.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleFreeze}
            disabled={busy}
            className={`lumi-button h-9 px-3 text-xs ${
              data?.evolutionFrozenAt
                ? 'border-amber-500/30 bg-amber-500/20 text-amber-300'
                : ''
            }`}
          >
            {operation === 'freeze' ? <Loader2 size={12} className="animate-spin" /> : null}
            {data?.evolutionFrozenAt ? uiMessage('personality-evolution.frozen.427478b47a') : uiMessage('personality-evolution.active.9d9aa763fa')}
          </button>
          <button
            onClick={triggerEvolution}
            disabled={busy || Boolean(data?.evolutionFrozenAt)}
            className="lumi-button-primary h-9 border-fuchsia-500/30 bg-fuchsia-500/20 px-4 text-xs text-fuchsia-300 hover:bg-fuchsia-500/30"
          >
            {operation === 'evolve' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {t.evolve || uiMessage('personality-evolution.evolve.555fe90284')}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-amber-200">
        <span>{error}</span><button className="lumi-button shrink-0 px-3 py-1" onClick={() => void fetchEvolutionData()}>{copy.retry}</button>
      </div>}
      {error && !data ? null : !hasHistory ? (
        <div className="flex h-64 flex-col items-center justify-center gap-4 text-white/45">
          <TrendingUp size={48} />
          <p className="text-xs">{t.noEvolutionHistory || uiMessage('personality-evolution.no-evolution-history-yet-lumi.d37707c7e2')}</p>
        </div>
      ) : (
        <div className="flex h-[calc(100%-65px)]">
          {/* Left: Radar Chart */}
          <div className="flex w-[420px] flex-shrink-0 flex-col items-center border-r border-white/[0.08] p-6">
            <svg width={340} height={340} viewBox="0 0 300 300">
              {/* Background rings */}
              {[0.25, 0.5, 0.75, 1].map(scale => (
                <motion.polygon
                  key={scale}
                  points={getRadarPoints(cx, cy, r * scale).points}
                  fill="none"
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth={0.5}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: scale * 0.1 }}
                />
              ))}
              {/* Axis lines and labels share the same directions. */}
              {RADAR_AXES.map(({ dim, cosine, sine }) => (
                <g key={dim}>
                  <line x1={cx} y1={cy} x2={cx + r * cosine} y2={cy + r * sine} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5} />
                  <text x={cx + (r + 22) * cosine} y={cy + (r + 22) * sine} textAnchor="middle" dominantBaseline="middle"
                    className="fill-white/25" style={{ fontSize: '7px', fontWeight: 700, fontFamily: 'monospace' }}>
                    {DIM_LABELS[dim]}
                  </text>
                </g>
              ))}
              {/* Historical step polygons */}
              {evolutionSteps.map((step, idx) => {
                if (!vectors[idx]) return null;
                const { points, vertices } = getRadarPoints(cx, cy, r, vectors[idx]);
                return (
                  <g key={step.version}>
                    <motion.polygon
                      points={points}
                      fill={idx === selectedStep ? 'rgba(192,132,252,0.3)' : 'rgba(192,132,252,0.08)'}
                      stroke={idx === selectedStep ? 'rgba(192,132,252,0.8)' : 'rgba(192,132,252,0.25)'}
                      strokeWidth={idx === selectedStep ? 1.5 : 0.5}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: idx * 0.1 }}
                    />
                    {idx === selectedStep && vertices.map((v, vi) => (
                      <circle key={vi} cx={v.x} cy={v.y} r={3} fill="rgba(192,132,252,0.9)" stroke="white" strokeWidth={0.5} />
                    ))}
                  </g>
                );
              })}
            </svg>
            {selected && (
              <p className="text-[12px] text-white/55 text-center mt-2 italic max-w-[340px]">
                {selected.narrative}
              </p>
            )}
          </div>

          {/* Right: Timeline + Mutations */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Timeline */}
            <div className="custom-scrollbar overflow-x-auto border-b border-white/[0.08] p-4">
              <div className="flex gap-2 items-center min-w-max">
                <Clock size={12} className="text-white/45 flex-shrink-0" />
                {evolutionSteps.map((step, idx) => (
                  <button
                    key={step.version}
                    onClick={() => setSelectedStep(idx)}
                    className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 font-mono text-xs transition-colors ${
                      idx === selectedStep
                        ? 'border-fuchsia-500/30 bg-fuchsia-500/20 text-fuchsia-300'
                        : 'border-white/[0.06] bg-white/[0.04] text-white/40 hover:bg-white/[0.08]'
                    }`}
                  >
                    <span className="font-black">v{step.version}</span>
                    <span className="text-xs opacity-50">{step.timestamp.slice(0, 10)}</span>
                    <span className={`text-xs uppercase px-1.5 py-0.5 rounded-full ${
                      step.trigger === 'manual' ? 'bg-amber-500/20 text-amber-400' :
                      step.trigger === 'milestone' ? 'bg-emerald-500/20 text-emerald-400' :
                      'bg-blue-500/20 text-blue-400'
                    }`}>{step.trigger}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Mutation details */}
            <div className="custom-scrollbar flex-1 space-y-4 overflow-auto p-5">
              {selected ? (
                <>
                  {/* Owner Profile (if available) */}
                  {selected.ownerProfile && (
                    <div className="lumi-panel space-y-2 p-4">
                      <h3 className="text-xs font-black text-white/55 uppercase tracking-wider flex items-center gap-2">
                        <Target size={12} /> {t.ownerProfile || uiMessage('personality-evolution.owner-profile.31f76cbf19')}
                      </h3>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-white/45">{t.dominantTone || 'Dominant Tone: '}</span>
                          <span className="text-white/60">{selected.ownerProfile.dominantTone}</span>
                        </div>
                        <div>
                          <span className="text-white/45">{t.formalityLabel || 'Formality: '}</span>
                          <span className="text-white/60">{selected.ownerProfile.formalityLevel.toFixed(1)}</span>
                        </div>
                        <div>
                          <span className="text-white/45">{t.expressiveness || 'Expressiveness: '}</span>
                          <span className="text-white/60">{selected.ownerProfile.emotionalExpressiveness.toFixed(1)}</span>
                        </div>
                        <div>
                          <span className="text-white/45">{t.memoriesAnalyzed || 'Memories Analyzed: '}</span>
                          <span className="text-white/60">{selected.ownerProfile.memoryCount}</span>
                        </div>
                      </div>
                      {selected.ownerProfile.interestClusters?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {selected.ownerProfile.interestClusters.map(c => (
                            <span key={c} className="px-2 py-0.5 bg-fuchsia-500/10 border border-fuchsia-500/20 rounded-full text-xs text-fuchsia-300">{c}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {selectedAudit && (
                    <div className="lumi-panel space-y-3 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-xs font-black text-white/55 uppercase tracking-wider">{uiMessage('personality-evolution.evolution-audit.1714ef9a1a')}</h3>
                        <span className={`text-[11px] font-mono uppercase px-2 py-1 rounded-full ${
                          selectedAudit.status === 'reverted'
                            ? 'bg-zinc-500/20 text-zinc-300'
                            : selectedAudit.affectedLayer === 'core'
                            ? 'bg-red-500/20 text-red-300'
                            : selectedAudit.affectedLayer === 'mixed'
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}>
                          {selectedAudit.status} / {selectedAudit.affectedLayer}
                        </span>
                      </div>
                      <div className="text-[12px] text-white/50 space-y-1">
                        <div>{uiMessage('personality-evolution.audit-id.da02889b75')}: <span className="font-mono text-white/65">{selectedAudit.id}</span></div>
                        <div>{uiMessage('personality-evolution.reversible.211bcaf50b')}: {selectedAudit.reversible ? uiMessage('personality-evolution.yes.4e00e01840') : uiMessage('personality-evolution.no.739dd5875e')}</div>
                        <div>{uiMessage('personality-evolution.fields.b7ea4c3e6c')}: {selectedAudit.mutationFields.join(', ') || uiMessage('personality-evolution.none.a8d7c6c030')}</div>
                      </div>
                      <button
                        onClick={revertSelected}
                        disabled={!selectedAudit.reversible || selectedAudit.status === 'reverted' || busy}
                        className="lumi-button h-9 border-red-500/20 bg-red-500/10 px-3 text-xs text-red-300 hover:bg-red-500/20"
                      >
                        {operation === 'revert' ? uiMessage('personality-evolution.reverting.b9ec255e19') : uiMessage('personality-evolution.revert-this-step.420eacb6ac')}
                      </button>
                    </div>
                  )}

                  {/* Mutations */}
                  <h3 className="text-xs font-black text-white/55 uppercase tracking-wider flex items-center gap-2">
                    <Sparkles size={12} /> {t.mutations || uiMessage('personality-evolution.mutations.d1e3a3b72a')}
                  </h3>
                  {selected.mutations.map((mut, mi) => (
                    <motion.div
                      key={mi}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: mi * 0.08 }}
                      className="lumi-panel space-y-2 p-4"
                    >
                      <div className="flex items-center gap-2">
                        <code className="text-[12px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                          {mut.field}
                        </code>
                        <ChevronRight size={10} className="text-white/35" />
                      </div>
                      <div className="flex items-center gap-3 text-xs font-mono">
                        <span className="text-red-400/60 line-through">{typeof mut.from === 'number' ? (mut.from as number).toFixed(2) : String(mut.from)}</span>
                        <span className="text-white/35">&rarr;</span>
                        <span className="text-emerald-400">{typeof mut.to === 'number' ? (mut.to as number).toFixed(2) : String(mut.to)}</span>
                      </div>
                      <p className="text-[12px] text-white/55 italic">{mut.reason}</p>
                    </motion.div>
                  ))}
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-white/35 text-xs">
                  {t.selectEvolutionStep || uiMessage('personality-evolution.select-an-evolution-step-to.55e09ae29e')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Config bar */}
      {data && (
        <div className="flex items-center gap-6 border-t border-white/[0.08] px-5 py-3 font-mono text-[12px] text-white/45">
          <span>{t.plasticity || 'Plasticity:'} <span className="text-white/40">{data.evolutionConfig.plasticity.toFixed(1)}</span></span>
          <span>{t.cooldown || 'Cooldown:'} <span className="text-white/40">{(data.evolutionConfig.cooldownMs / 86400000).toFixed(0)}d</span></span>
          <span>{t.maxMutations || uiMessage('personality-evolution.max-mutations.6acce93010')} <span className="text-white/40">{data.evolutionConfig.maxMutationsPerStep}</span></span>
          <span>{t.minMemories || 'Min Memories:'} <span className="text-white/40">{data.evolutionConfig.minMemoriesForEvolution}</span></span>
        </div>
      )}
    </div>
  );
}
