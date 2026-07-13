import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  CheckCircle2,
  Crown,
  ExternalLink,
  Loader2,
  Mail,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';
import { uiMessage } from '../i18n/uiMessages';

interface PlanInfo {
  id: string;
  name: string;
  tier: 'free' | 'light' | 'pro' | 'org';
  monthlyTokens: number;
  llmProviders: string[];
  sttIncluded?: boolean;
  ttsIncluded?: boolean;
  voiceCloneIncluded?: boolean;
  memoryIncluded?: boolean;
  agentCount?: number;
  priority?: boolean;
  priceCNY: number;
  description: string;
}

interface SubStatus {
  subscription: {
    planId: string;
    status: string;
    tokensUsedThisMonth: number;
    monthlyTokenCap: number;
    startedAt: string | null;
    expiresAt: string | null;
  };
  plan: PlanInfo;
  usage: { used: number; cap: number; remaining: number };
}

interface ReleaseInfo {
  appName: string;
  version: string;
  channel: 'private-paid' | 'public-free' | 'internal';
  websiteUrl: string;
  downloadUrl: string;
  supportEmail: string;
  salesContact: string;
  billingMode: 'manual-activation' | 'online-checkout' | 'free-download';
  publicDownloadPlanned: boolean;
  headline: string;
  note: string;
  freeBoundary: string[];
  paidBoundary: string[];
}

interface ActivationRequest {
  id: string;
  planId: string;
  contact: string;
  note: string;
  status: string;
  createdAt: string;
}

const COLORS: Record<string, string> = {
  free: 'bg-white/5 border-white/10',
  light: 'bg-blue-500/5 border-blue-500/30',
  pro: 'bg-purple-500/5 border-purple-500/30',
  org: 'bg-amber-500/5 border-amber-500/30',
};

const ACCENTS: Record<string, string> = {
  free: 'text-white/45',
  light: 'text-blue-400',
  pro: 'text-purple-400',
  org: 'text-amber-400',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtPrice(plan: PlanInfo): string {
  return plan.priceCNY > 0 ? `CNY ${plan.priceCNY}/mo` : 'Free';
}

export function SubscriptionPanel({ t }: { t: any }) {
  const { user } = useApp();
  const isZh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh');
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  const [status, setStatus] = useState<SubStatus | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [requests, setRequests] = useState<ActivationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'status' | 'plans' | 'activate'>('status');
  const [selectedPlanId, setSelectedPlanId] = useState('pro');
  const [contact, setContact] = useState(() => (user as any)?.email || (user as any)?.username || '');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, plansRes, releaseRes, requestsRes] = await Promise.all([
        fetch('/api/subscription/status', { credentials: 'include' }),
        fetch('/api/subscription/plans', { credentials: 'include' }),
        fetch('/api/subscription/release-info', { credentials: 'include' }),
        fetch('/api/subscription/activation-requests', { credentials: 'include' }),
      ]);

      if (!statusRes.ok) throw new Error(uiMessage('subscription-panel.failed-to-load-subscription-status.b34a73b90e'));
      const statusData = await statusRes.json();
      const plansData = plansRes.ok ? await plansRes.json() : null;
      const releaseData = releaseRes.ok ? await releaseRes.json() : null;
      const requestsData = requestsRes.ok ? await requestsRes.json() : null;

      setStatus(statusData);
      setPlans(plansData?.plans || []);
      setReleaseInfo(releaseData || null);
      setRequests(requestsData?.requests || []);
    } catch (e: any) {
      setError(e?.message || uiMessage('subscription-panel.network-error.92e4a239d2'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (!contact && user) setContact((user as any)?.email || (user as any)?.username || '');
  }, [contact, user]);

  const currentPlan = status?.plan;
  const currentUsage = status?.usage;
  const pct = currentUsage && currentUsage.cap > 0 ? Math.round((currentUsage.used / currentUsage.cap) * 100) : 0;
  const paidPlans = useMemo(() => plans.filter((plan) => plan.priceCNY > 0), [plans]);
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) || paidPlans[0] || currentPlan;
  const pendingRequest = requests.find((request) => request.status === 'pending');

  const submitActivationRequest = async () => {
    if (!selectedPlan) return;
    if (!contact.trim()) {
      toast.error(uiMessage('subscription-panel.enter-a-contact-method.33a04c5074'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/subscription/activation-requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: selectedPlan.id,
          contact: contact.trim(),
          note: note.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || uiMessage('subscription-panel.request-failed.975ba56a43'));
      toast.success(uiMessage('subscription-panel.activation-request-submitted.a30c160e59'));
      setNote('');
      await loadData();
      setTab('status');
    } catch (e: any) {
      toast.error(e?.message || uiMessage('subscription-panel.request-failed.975ba56a43'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-white/45">{uiMessage('subscription-panel.log-in-to-view-subscription.63fac4aec4')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-white/45" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={() => void loadData()} className="text-xs text-white/45 underline hover:text-white/70">
          {uiMessage('subscription-panel.retry.563171cfe4')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-950/60 text-white">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 bg-zinc-950/90 px-6 py-4 backdrop-blur-xl">
        <Crown size={18} className="text-celestial-saturn" />
        <div>
          <h2 className="text-sm font-bold text-white/90">{uiMessage('subscription-panel.subscription-activation.adf311cc1e')}</h2>
          <p className="text-xs text-white/40">
            {releaseInfo ? `${releaseInfo.appName} v${releaseInfo.version} · ${releaseInfo.channel}` : 'Lumi OS'}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
          {([
            ['status', uiMessage('subscription-panel.status.b8f1474d96')],
            ['plans', uiMessage('subscription-panel.plans.cd279ecf3f')],
            ['activate', uiMessage('subscription-panel.activate.95003fa938')],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-xs font-bold uppercase transition-all ${
                tab === id ? 'bg-white/10 text-white' : 'text-white/55 hover:text-white/75'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'status' && currentPlan && (
        <div className="space-y-5 p-6">
          <div className={`rounded-2xl border p-6 ${COLORS[currentPlan.tier] || COLORS.free}`}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <span className={`text-xs font-black uppercase tracking-widest ${ACCENTS[currentPlan.tier] || ACCENTS.free}`}>
                  {currentPlan.tier}
                </span>
                <h3 className="mt-1 text-2xl font-black tracking-tight">{currentPlan.name}</h3>
              </div>
              <span className="text-sm font-black text-white/80">{fmtPrice(currentPlan)}</span>
            </div>
            <p className="mb-6 text-xs leading-relaxed text-white/45">{currentPlan.description}</p>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-bold uppercase tracking-widest text-white/40">Tokens</span>
                <span className="font-mono text-white/60">{fmtTokens(currentUsage?.used || 0)} / {fmtTokens(currentUsage?.cap || 0)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(pct, 100)}%` }}
                  className={`h-full rounded-full ${pct > 90 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-celestial-saturn'}`}
                />
              </div>
              <div className="flex justify-between text-xs text-white/45">
                <span>{pct}% {uiMessage('subscription-panel.used.cc42f7b540')}</span>
                <span>{fmtTokens(currentUsage?.remaining || 0)} {uiMessage('subscription-panel.remaining.113ea03291')}</span>
              </div>
            </div>
          </div>

          {pendingRequest && (
            <div className="rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 p-4 text-sm text-celestial-saturn">
              <div className="flex items-center gap-2 font-bold">
                <CheckCircle2 size={16} />
                {uiMessage('subscription-panel.activation-request-pending.2039f4ccaf')}
              </div>
              <p className="mt-1 text-xs text-white/50">
                {uiMessage('subscription-panel.target-plan.8b8ea2ef87')}: {pendingRequest.planId} · {new Date(pendingRequest.createdAt).toLocaleString()}
              </p>
            </div>
          )}

          {releaseInfo && (
            <div className="grid gap-3 md:grid-cols-2">
              <a href={releaseInfo.websiteUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:bg-white/10">
                <div className="flex items-center gap-2 text-sm font-bold"><ExternalLink size={15} /> {uiMessage('subscription-panel.website.8e805238ba')}</div>
                <p className="mt-1 truncate text-xs text-white/45">{releaseInfo.websiteUrl}</p>
              </a>
              <a href={`mailto:${releaseInfo.supportEmail}`} className="rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:bg-white/10">
                <div className="flex items-center gap-2 text-sm font-bold"><Mail size={15} /> {uiMessage('subscription-panel.support.a708e57f24')}</div>
                <p className="mt-1 truncate text-xs text-white/45">{releaseInfo.supportEmail}</p>
              </a>
            </div>
          )}
        </div>
      )}

      {tab === 'plans' && (
        <div className="grid gap-4 p-6">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlan?.id;
            const features = [
              `${fmtTokens(plan.monthlyTokens)} tokens/mo`,
              `${plan.agentCount || 1} ${uiMessage('subscription-panel.agents.364731ee22')}`,
              plan.voiceCloneIncluded ? uiMessage('subscription-panel.voice-cloning.af508583e9') : uiMessage('subscription-panel.basic-voice.6b48b379cd'),
              plan.priority ? uiMessage('subscription-panel.priority-queue.91844d6271') : uiMessage('subscription-panel.standard-queue.c2134618a8'),
            ];
            return (
              <div
                key={plan.id}
                className={`rounded-2xl border p-5 transition-all ${isCurrent ? 'border-celestial-saturn/50 bg-celestial-saturn/5' : 'border-white/5 bg-white/[0.02] hover:border-white/10'}`}
              >
                <div className="mb-3 flex items-start justify-between gap-4">
                  <div>
                    <span className={`text-xs font-black uppercase tracking-widest ${ACCENTS[plan.tier] || ACCENTS.free}`}>{plan.tier}</span>
                    <h4 className="mt-0.5 text-sm font-bold">{plan.name}</h4>
                  </div>
                  <div className="text-sm font-black text-white/80">{fmtPrice(plan)}</div>
                </div>
                <p className="mb-3 text-xs leading-relaxed text-white/55">{plan.description}</p>
                <div className="mb-4 flex flex-wrap gap-1">
                  {plan.llmProviders.map((provider) => (
                    <span key={provider} className="rounded bg-white/5 px-1.5 py-0.5 text-xs font-bold uppercase text-white/40">{provider}</span>
                  ))}
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {features.map((feature) => (
                    <div key={feature} className="flex items-center gap-2 text-xs text-white/55">
                      <Check size={13} className="text-celestial-saturn" />
                      {feature}
                    </div>
                  ))}
                </div>
                <div className="mt-4">
                  {isCurrent ? (
                    <span className="text-xs font-bold uppercase tracking-widest text-celestial-saturn">{uiMessage('subscription-panel.current-plan.79019776da')}</span>
                  ) : (
                    <button
                      onClick={() => { setSelectedPlanId(plan.id); setTab('activate'); }}
                      className="text-xs font-bold uppercase tracking-widest text-white/55 transition-colors hover:text-white"
                    >
                      {uiMessage('subscription-panel.request-activation.22a6ce6562')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'activate' && (
        <div className="grid gap-5 p-6 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold">
                <ShieldCheck size={16} className="text-celestial-saturn" />
                {uiMessage('subscription-panel.manual-activation-before-website-launch.f6283fecf1')}
              </div>
              <p className="text-xs leading-relaxed text-white/50">
                {releaseInfo?.note || uiMessage('subscription-panel.free-remains-usable-paid-plans.7582919e6a')}
              </p>
            </div>

            {releaseInfo && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-white/50">{uiMessage('subscription-panel.paid-boundary.eb2c6c0d0f')}</h4>
                <div className="space-y-2">
                  {releaseInfo.paidBoundary.map((item) => (
                    <div key={item} className="flex items-center gap-2 text-xs text-white/60">
                      <Check size={13} className="text-celestial-saturn" />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
            <h3 className="mb-4 text-sm font-bold">{uiMessage('subscription-panel.submit-activation-request.2953a3a2f4')}</h3>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{uiMessage('subscription-panel.target-plan.8b8ea2ef87')}</span>
                <select
                  value={selectedPlan?.id || selectedPlanId}
                  onChange={(event) => setSelectedPlanId(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white outline-none focus:border-celestial-saturn/50"
                >
                  {(paidPlans.length > 0 ? paidPlans : plans).map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name} · {fmtPrice(plan)}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{uiMessage('subscription-panel.contact.7c7e7a1bc6')}</span>
                <input
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder={uiMessage('subscription-panel.wechat-email-phone.dc8732b23e')}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-celestial-saturn/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{uiMessage('subscription-panel.note.a907cbf17f')}</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={uiMessage('subscription-panel.example-i-want-pro-for.4dfc27dd3b')}
                  className="min-h-24 w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-celestial-saturn/50"
                />
              </label>

              <button
                onClick={() => void submitActivationRequest()}
                disabled={submitting || !selectedPlan}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-celestial-saturn px-4 py-3 text-sm font-black text-black transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {uiMessage('subscription-panel.submit-request.6d2a2e58bb')}
              </button>

              {releaseInfo && (
                <p className="text-center text-xs text-white/35">
                  {uiMessage('subscription-panel.or-contact.ccb8e41498')} {releaseInfo.salesContact} · {releaseInfo.supportEmail}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
