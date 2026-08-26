import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  HardDrive,
  Loader2,
  MessageCircleQuestion,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  systemExplorerCopy,
  systemExplorerFallbackQuestions,
} from '../i18n/locales/systemExplorer';

interface OnboardingProps {
  isOpen: boolean;
  onFinish: () => void;
  onAsk?: (prompt: string) => void;
  t: any;
}

type LocalizedText = { zh: string; en: string };

type CapabilityOpportunity = {
  id: string;
  label: string;
  ready: boolean;
  confidence: number;
  evidence: string[];
  suggestedPrompts: LocalizedText[];
};

type ExplorationSnapshot = {
  timestamp?: string;
  hardware?: {
    cpus?: { model?: string; cores?: number; threads?: number };
    totalMemoryGB?: number;
    gpus?: string[];
    disks?: Array<{ name?: string; totalGB?: number; freeGB?: number }>;
  };
  software?: { installedApps?: string[] };
  peripherals?: {
    displays?: Array<{ name?: string }>;
    audioDevices?: string[];
    cameras?: string[];
  };
  capabilityProfile?: {
    opportunities?: CapabilityOpportunity[];
    firstQuestions?: LocalizedText[];
    evidenceGaps?: string[];
  };
};

type ExplorationStatus = {
  explored?: boolean;
  authorized?: boolean;
  consent?: { status?: string };
  latest?: ExplorationSnapshot | null;
};

export function DesktopOnboarding({ isOpen, onFinish, onAsk, t }: OnboardingProps) {
  const isZh = t?.langCode !== 'en';
  const reduceMotion = useReducedMotion();
  const copy = systemExplorerCopy(isZh ? 'zh' : 'en').onboarding;
  const [status, setStatus] = useState<ExplorationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetch('/api/explore/status', {
      credentials: 'include',
      signal: controller.signal,
    }).then(async response => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setStatus(payload);
    }).catch(cause => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [isOpen]);

  const latest = status?.latest || null;
  const readyOpportunities = useMemo(() => (
    (latest?.capabilityProfile?.opportunities || [])
      .filter(item => item.ready)
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 6)
  ), [latest]);
  const firstQuestions = useMemo(() => {
    const questions = latest?.capabilityProfile?.firstQuestions || systemExplorerFallbackQuestions;
    return questions.slice(0, 5);
  }, [latest]);
  const authorized = status?.authorized === true;

  const updateConsent = async (granted: boolean) => {
    const response = await fetch('/api/explore/consent', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };

  const scanComputer = async () => {
    setScanning(true);
    setError('');
    try {
      const consent = await updateConsent(true);
      const response = await fetch('/api/explore/scan', {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.snapshot) {
        throw new Error(payload.error || copy.scanNoResult);
      }
      setStatus(previous => ({
        ...(previous || {}),
        explored: true,
        authorized: true,
        consent: consent.consent,
        latest: payload.snapshot,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  };

  const finishWithoutScan = async () => {
    if (!authorized && status?.consent?.status !== 'legacy_local_scan') {
      try { await updateConsent(false); } catch {}
    }
    onFinish();
  };

  const askLumi = (question: LocalizedText) => {
    onAsk?.(isZh ? question.zh : question.en);
    onFinish();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-2 pointer-events-auto sm:p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-[#02040a]/92 backdrop-blur-2xl"
        />

        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 12 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="relative grid max-h-[calc(100dvh-1rem)] w-full max-w-6xl overflow-y-auto rounded-[2rem] border border-cyan-200/12 bg-[#050812]/96 shadow-[0_34px_120px_rgba(0,0,0,0.65)] lg:grid-cols-[0.88fr_1.12fr]"
        >
          <button
            type="button"
            onClick={() => void finishWithoutScan()}
            className="absolute right-5 top-5 z-20 text-xs font-black uppercase tracking-[0.18em] text-white/35 transition-colors hover:text-white/75"
          >
            {copy.enterNow}
          </button>

          <section className="relative min-h-[430px] overflow-hidden border-b border-white/[0.07] p-7 lg:min-h-[650px] lg:border-b-0 lg:border-r lg:p-10">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_38%_38%,rgba(34,211,238,0.14),transparent_28%),radial-gradient(circle_at_70%_70%,rgba(139,92,246,0.12),transparent_34%)]" />
            <div className="absolute inset-0 opacity-45 [background-image:radial-gradient(circle,rgba(255,255,255,.6)_0_1px,transparent_1.5px)] [background-size:41px_41px]" />
            <div className="relative flex h-full flex-col">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.26em] text-cyan-100/45">
                <Sparkles size={15} />
                {copy.eyebrow}
              </div>
              <h1 className="mt-5 max-w-xl text-4xl font-black leading-tight text-white sm:text-5xl">
                {copy.title}
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-white/55 sm:text-base">
                {copy.description}
              </p>

              <div className="relative mx-auto my-10 flex h-48 w-48 items-center justify-center sm:h-56 sm:w-56">
                <motion.div
                  animate={reduceMotion ? undefined : { rotate: 360 }}
                  transition={{ duration: 28, repeat: Infinity, ease: 'linear' }}
                  className="absolute inset-0 rounded-full border border-cyan-200/12 border-t-cyan-200/55"
                />
                <motion.div
                  animate={reduceMotion ? undefined : { scale: [0.96, 1.05, 0.96], opacity: [0.55, 0.9, 0.55] }}
                  transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute inset-7 rounded-full bg-[radial-gradient(circle_at_35%_30%,rgba(255,255,255,.85),rgba(34,211,238,.28)_18%,rgba(79,70,229,.16)_46%,transparent_72%)] shadow-[0_0_70px_rgba(34,211,238,.22)]"
                />
                <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-white/15 bg-black/35 text-cyan-100 shadow-[inset_0_0_34px_rgba(34,211,238,.12)] backdrop-blur-xl">
                  {scanning ? <Loader2 size={30} className="animate-spin" /> : <MessageCircleQuestion size={30} />}
                </div>
              </div>

              <div className="mt-auto rounded-2xl border border-white/[0.07] bg-black/25 p-4 text-xs leading-5 text-white/48 backdrop-blur-xl">
                <div className="flex items-center gap-2 font-black text-white/74"><ShieldCheck size={15} className="text-emerald-300" />{copy.boundaryTitle}</div>
                <p className="mt-2">
                  {copy.boundaryText}
                </p>
              </div>
            </div>
          </section>

          <section className="flex min-h-[520px] flex-col p-6 pt-16 sm:p-8 sm:pt-16 lg:p-10 lg:pt-16">
            {loading ? (
              <div className="flex flex-1 items-center justify-center gap-3 text-sm text-white/45"><Loader2 size={20} className="animate-spin" />{copy.loading}</div>
            ) : latest ? (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.2em] text-emerald-200/55">{copy.profileReady}</div>
                    <h2 className="mt-2 text-2xl font-black text-white">{copy.profileTitle}</h2>
                  </div>
                  <span className="flex items-center gap-1.5 rounded-full border border-emerald-300/15 bg-emerald-300/[0.07] px-3 py-1.5 text-[10px] font-black text-emerald-100/70"><Check size={12} />{copy.localEvidence}</span>
                </div>

                <div className="mt-5 grid grid-cols-3 gap-2">
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3"><Cpu size={15} className="text-cyan-200" /><div className="mt-2 truncate text-xs font-bold text-white/72">{latest.hardware?.cpus?.model || copy.unknownCpu}</div><div className="mt-1 text-[10px] text-white/32">{latest.hardware?.cpus?.cores || '?'} / {latest.hardware?.cpus?.threads || '?'} {copy.coresThreads}</div></div>
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3"><HardDrive size={15} className="text-violet-200" /><div className="mt-2 text-xs font-bold text-white/72">{latest.hardware?.totalMemoryGB || '?'} GB</div><div className="mt-1 text-[10px] text-white/32">{copy.memory} · {latest.hardware?.disks?.length || 0} {copy.disks}</div></div>
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3"><ScanSearch size={15} className="text-emerald-200" /><div className="mt-2 text-xs font-bold text-white/72">{latest.software?.installedApps?.length || 0}</div><div className="mt-1 text-[10px] text-white/32">{copy.knownApps}</div></div>
                </div>

                {readyOpportunities.length > 0 && (
                  <div className="mt-6">
                    <div className="text-[11px] font-black uppercase tracking-[0.2em] text-white/35">{copy.readyTitle}</div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {readyOpportunities.map(item => (
                        <div key={item.id} className="rounded-2xl border border-cyan-200/[0.08] bg-cyan-200/[0.025] p-3">
                          <div className="text-xs font-black text-white/72">{item.label}</div>
                          <div className="mt-1 truncate text-[10px] text-white/32">{item.evidence.slice(0, 3).join(' · ') || copy.localEnvironment}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-6 min-h-0 flex-1">
                  <div className="text-[11px] font-black uppercase tracking-[0.2em] text-white/35">{copy.startQuestion}</div>
                  <div className="mt-3 space-y-2">
                    {firstQuestions.map((question, index) => (
                      <button key={`${question.zh}-${index}`} type="button" onClick={() => askLumi(question)} className="group flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-left text-sm leading-6 text-white/62 transition-colors hover:border-cyan-200/20 hover:bg-cyan-200/[0.055] hover:text-white">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-cyan-100/60">{index + 1}</span>
                        <span className="min-w-0 flex-1">{isZh ? question.zh : question.en}</span>
                        <ChevronRight size={15} className="shrink-0 text-white/20 transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-100/65" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={onFinish} className="flex h-12 items-center gap-2 rounded-2xl bg-white px-6 text-sm font-black text-black transition-transform hover:scale-[1.015] active:scale-95">{copy.enter}<ArrowRight size={17} /></button>
                  <button type="button" disabled={scanning} onClick={() => void scanComputer()} className="h-12 rounded-2xl border border-white/10 px-5 text-sm font-black text-white/45 transition-colors hover:bg-white/[0.05] hover:text-white/75 disabled:cursor-wait disabled:opacity-45">{scanning ? copy.refreshing : copy.refresh}</button>
                </div>
              </>
            ) : (
              <>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-cyan-100/45">{copy.startAdaptation}</div>
                <h2 className="mt-3 text-3xl font-black text-white">{copy.adaptationTitle}</h2>
                <p className="mt-4 text-sm leading-7 text-white/52">{copy.adaptationDescription}</p>

                <div className="mt-7 space-y-3">
                  {copy.scanItems.map(item => <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 text-sm text-white/58"><Check size={15} className="shrink-0 text-emerald-300" />{item}</div>)}
                </div>

                {error && <div role="alert" className="mt-5 flex items-start gap-2 rounded-2xl border border-rose-300/15 bg-rose-300/[0.05] p-4 text-xs leading-5 text-rose-100/70"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}

                <div className="mt-auto flex flex-wrap items-center gap-3 pt-8">
                  <button type="button" disabled={scanning} onClick={() => void scanComputer()} className="flex h-12 min-w-48 items-center justify-center gap-2 rounded-2xl bg-cyan-100 px-6 text-sm font-black text-[#061016] shadow-[0_0_38px_rgba(103,232,249,.16)] transition-transform hover:scale-[1.015] active:scale-95 disabled:cursor-wait disabled:opacity-55">{scanning ? <Loader2 size={17} className="animate-spin" /> : <ScanSearch size={17} />}{scanning ? copy.understanding : copy.allowScan}</button>
                  <button type="button" disabled={scanning} onClick={() => void finishWithoutScan()} className="h-12 rounded-2xl border border-white/10 px-5 text-sm font-black text-white/42 transition-colors hover:bg-white/[0.05] hover:text-white/72 disabled:opacity-35">{copy.notNow}</button>
                </div>
              </>
            )}
            {error && latest && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-3 text-xs leading-5 text-amber-100/70"><CircleAlert size={14} className="mt-0.5 shrink-0" />{error}</div>}
          </section>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
