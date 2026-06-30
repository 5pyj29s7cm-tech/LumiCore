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

      if (!statusRes.ok) throw new Error(ui('订阅状态加载失败', 'Failed to load subscription status'));
      const statusData = await statusRes.json();
      const plansData = plansRes.ok ? await plansRes.json() : null;
      const releaseData = releaseRes.ok ? await releaseRes.json() : null;
      const requestsData = requestsRes.ok ? await requestsRes.json() : null;

      setStatus(statusData);
      setPlans(plansData?.plans || []);
      setReleaseInfo(releaseData || null);
      setRequests(requestsData?.requests || []);
    } catch (e: any) {
      setError(e?.message || ui('网络异常', 'Network error'));
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
      toast.error(ui('请填写联系方式', 'Enter a contact method'));
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
      if (!res.ok) throw new Error(data?.error || ui('提交失败', 'Request failed'));
      toast.success(ui('激活申请已提交', 'Activation request submitted'));
      setNote('');
      await loadData();
      setTab('status');
    } catch (e: any) {
      toast.error(e?.message || ui('提交失败', 'Request failed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-white/45">{ui('登录后查看订阅与激活状态。', 'Log in to view subscription and activation status.')}</p>
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
          {ui('重试', 'Retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-950/60 text-white">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/5 bg-zinc-950/90 px-6 py-4 backdrop-blur-xl">
        <Crown size={18} className="text-celestial-saturn" />
        <div>
          <h2 className="text-sm font-bold text-white/90">{ui('订阅与激活', 'Subscription & Activation')}</h2>
          <p className="text-xs text-white/40">
            {releaseInfo ? `${releaseInfo.appName} v${releaseInfo.version} · ${releaseInfo.channel}` : 'Lumi OS'}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
          {([
            ['status', ui('状态', 'Status')],
            ['plans', ui('套餐', 'Plans')],
            ['activate', ui('激活', 'Activate')],
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
                <span>{pct}% {ui('已使用', 'used')}</span>
                <span>{fmtTokens(currentUsage?.remaining || 0)} {ui('剩余', 'remaining')}</span>
              </div>
            </div>
          </div>

          {pendingRequest && (
            <div className="rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 p-4 text-sm text-celestial-saturn">
              <div className="flex items-center gap-2 font-bold">
                <CheckCircle2 size={16} />
                {ui('已有待处理激活申请', 'Activation request pending')}
              </div>
              <p className="mt-1 text-xs text-white/50">
                {ui('目标套餐', 'Target plan')}: {pendingRequest.planId} · {new Date(pendingRequest.createdAt).toLocaleString()}
              </p>
            </div>
          )}

          {releaseInfo && (
            <div className="grid gap-3 md:grid-cols-2">
              <a href={releaseInfo.websiteUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:bg-white/10">
                <div className="flex items-center gap-2 text-sm font-bold"><ExternalLink size={15} /> {ui('官网', 'Website')}</div>
                <p className="mt-1 truncate text-xs text-white/45">{releaseInfo.websiteUrl}</p>
              </a>
              <a href={`mailto:${releaseInfo.supportEmail}`} className="rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:bg-white/10">
                <div className="flex items-center gap-2 text-sm font-bold"><Mail size={15} /> {ui('支持', 'Support')}</div>
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
              `${plan.agentCount || 1} ${ui('个 Agent', 'agents')}`,
              plan.voiceCloneIncluded ? ui('声音克隆', 'Voice cloning') : ui('基础语音', 'Basic voice'),
              plan.priority ? ui('优先队列', 'Priority queue') : ui('标准队列', 'Standard queue'),
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
                    <span className="text-xs font-bold uppercase tracking-widest text-celestial-saturn">{ui('当前套餐', 'Current plan')}</span>
                  ) : (
                    <button
                      onClick={() => { setSelectedPlanId(plan.id); setTab('activate'); }}
                      className="text-xs font-bold uppercase tracking-widest text-white/55 transition-colors hover:text-white"
                    >
                      {ui('申请激活', 'Request activation')}
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
                {ui('官网上线前采用人工激活', 'Manual activation before website launch')}
              </div>
              <p className="text-xs leading-relaxed text-white/50">
                {releaseInfo?.note || ui('Free 可以继续使用基础能力。付费套餐通过人工确认后开通，更高配额和声音克隆等能力会随套餐开放。', 'Free remains usable. Paid plans are activated manually until online checkout is ready.')}
              </p>
            </div>

            {releaseInfo && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-white/50">{ui('付费版开放能力', 'Paid boundary')}</h4>
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
            <h3 className="mb-4 text-sm font-bold">{ui('提交激活申请', 'Submit activation request')}</h3>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{ui('目标套餐', 'Target plan')}</span>
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
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{ui('联系方式', 'Contact')}</span>
                <input
                  value={contact}
                  onChange={(event) => setContact(event.target.value)}
                  placeholder={ui('微信 / 邮箱 / 手机号', 'WeChat / email / phone')}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-celestial-saturn/50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-white/45">{ui('备注', 'Note')}</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={ui('例如：想开通 Pro，用于声音克隆和形象设计室。', 'Example: I want Pro for voice cloning and avatar studio.')}
                  className="min-h-24 w-full resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-celestial-saturn/50"
                />
              </label>

              <button
                onClick={() => void submitActivationRequest()}
                disabled={submitting || !selectedPlan}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-celestial-saturn px-4 py-3 text-sm font-black text-black transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {ui('提交申请', 'Submit request')}
              </button>

              {releaseInfo && (
                <p className="text-center text-xs text-white/35">
                  {ui('也可以直接联系', 'Or contact')} {releaseInfo.salesContact} · {releaseInfo.supportEmail}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
