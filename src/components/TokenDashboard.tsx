import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { Zap, TrendingUp, Clock, Layers, RefreshCw, AlertTriangle } from 'lucide-react';
import { GlassCard } from './SharedUI';
import { socketService } from '@/services/socketService';
import { useT } from '../lib/useT';
import { uiMessage } from '../i18n/uiMessages';

interface ProviderStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

interface DailyStats {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UsageData {
  byProvider: Record<string, ProviderStats>;
  daily: DailyStats[];
  grandTotal: number;
  days: number;
  recordCount: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  ark: 'Doubao',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
};

const PROVIDER_COLORS: Record<string, string> = {
  deepseek: '#6366f1',
  qwen: '#06b6d4',
  ark: '#00d4ff',
  openai: '#10b981',
  gemini: '#8b5cf6',
  anthropic: '#f59e0b',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export const TokenDashboard: React.FC = () => {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; cap: number; remaining: number; plan?: string } | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usageResp, subResp] = await Promise.all([
        fetch(`/api/llm/usage?days=${days}`, { credentials: 'include' }),
        fetch('/api/subscription/status', { credentials: 'include' }),
      ]);
      if (!usageResp.ok) throw new Error(usageResp.status === 401 ? uiMessage('token-dashboard.login-required.5fda35cfff') : `HTTP ${usageResp.status}`);
      const res = await usageResp.json();
      setData(res);
      if (subResp.ok) {
        const sub = await subResp.json();
        if (sub?.subscription) {
          setQuota({
            used: sub.subscription.tokensUsedThisMonth || 0,
            cap: sub.subscription.monthlyTokenCap || 500000,
            remaining: Math.max(0, (sub.subscription.monthlyTokenCap || 500000) - (sub.subscription.tokensUsedThisMonth || 0)),
            plan: sub.subscription.planId || 'Free',
          });
        }
      }
    } catch (err: any) {
      setError(err.message || uiMessage('token-dashboard.failed-to-load.1131733383'));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchUsage(); }, [fetchUsage]);

  useEffect(() => {
    const id = setInterval(() => fetchUsage(), 10000);
    return () => clearInterval(id);
  }, [fetchUsage]);

  useEffect(() => {
    const s = socketService.getSocket();
    if (!s) return;
    const handler = () => { fetchUsage(); };
    s.on('token:usage_update', handler);
    s.on('token:quota_update', handler);
    return () => {
      s.off('token:usage_update', handler);
      s.off('token:quota_update', handler);
    };
  }, [fetchUsage]);

  const providers = data?.byProvider ? Object.entries(data.byProvider) : [];
  const maxDaily = data?.daily?.length ? Math.max(...data.daily.map(d => d.totalTokens), 1) : 1;

  const total = providers.reduce((sum, [, s]) => sum + s.totalTokens, 0);
  let cumulative = 0;
  const segments = providers.map(([p, s]) => {
    const start = cumulative;
    const frac = total > 0 ? s.totalTokens / total : 0;
    cumulative += frac;
    return { provider: p, stats: s, start, frac, color: PROVIDER_COLORS[p] || '#666' };
  });
  const circumference = 2 * Math.PI * 52;

  const quotaPct = quota ? Math.round((quota.used / quota.cap) * 100) : 0;
  const barColor = quotaPct >= 90 ? 'bg-red-500' : quotaPct >= 80 ? 'bg-amber-500' : 'bg-emerald-400';

  return (
    <div className="h-full flex flex-col text-white">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Zap size={16} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-black tracking-tight">{uiMessage('token-dashboard.token-usage.074d21ae63')}</h2>
            <p className="text-xs text-white/50 font-medium">{uiMessage('token-dashboard.llm-api-consumption.493dcca6c3')}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 bg-white/5 rounded-xl p-1">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 rounded-lg text-xs font-bold tracking-wider transition-all ${
                days === d ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/50'
              }`}
            >
              {d}{uiMessage('token-dashboard.d.a2698d0e7d')}
            </button>
          ))}
          <button onClick={fetchUsage} className="p-1.5 rounded-lg hover:bg-white/5 text-white/55 hover:text-white/60 transition-all">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <RefreshCw size={20} className="text-white/45 animate-spin" />
        </div>
      ) : error && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-3 overflow-auto custom-scrollbar pr-0.5">
          {/* Top row: Total + Quota */}
          <div className="grid grid-cols-2 gap-3">
            {/* Grand total */}
            <GlassCard className="p-4 rounded-2xl border-white/5 bg-white/[0.03]">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp size={13} className="text-amber-400/70" />
                <span className="text-[12px] font-bold text-white/50 uppercase tracking-wider">{uiMessage('token-dashboard.total-tokens.45e4cbe764')}</span>
              </div>
              <div className="text-2xl font-black tracking-tight">{formatTokens(data?.grandTotal || 0)}</div>
              <div className="text-xs text-white/45 mt-0.5">{formatNumber(data?.recordCount || 0)} {uiMessage('token-dashboard.api-calls.adf9b52346')}</div>
            </GlassCard>

            {/* Quota */}
            <GlassCard className="p-4 rounded-2xl border-white/5 bg-white/[0.03]">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={13} className={quotaPct >= 80 ? 'text-amber-400' : 'text-white/50'} />
                <span className="text-[12px] font-bold text-white/50 uppercase tracking-wider">
                  {uiMessage('token-dashboard.quota.474cf3da08')} · {quota?.plan || 'Free'}
                </span>
              </div>
              {quota ? (
                <>
                  <div className="text-lg font-black tracking-tight">
                    {formatTokens(quota.remaining)} <span className="text-xs text-white/45 font-normal">{uiMessage('token-dashboard.left.78dff592bf')}</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(quotaPct, 100)}%` }}
                      transition={{ duration: 0.6 }}
                      className={`h-full rounded-full ${barColor}`}
                    />
                  </div>
                  <div className="text-[12px] text-white/45 mt-1">
                    {formatTokens(quota.used)} / {formatTokens(quota.cap)} · {quotaPct}%
                  </div>
                </>
              ) : (
                <div className="text-sm text-white/45">{uiMessage('token-dashboard.no-subscription-data.4e1e6c99ac')}</div>
              )}
            </GlassCard>
          </div>

          {/* Providers + Ring */}
          <GlassCard className="p-4 rounded-2xl border-white/5 bg-white/[0.03]">
            <h3 className="text-[12px] font-bold text-white/45 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Layers size={10} /> {uiMessage('token-dashboard.providers.e98de89731')}
            </h3>
            {providers.length === 0 ? (
              <p className="text-white/45 text-xs py-6 text-center">{uiMessage('token-dashboard.no-usage-data-yet.3365b0e5cf')}</p>
            ) : (
              <div className="flex items-center gap-5">
                {/* Ring */}
                <svg width="110" height="110" viewBox="0 0 110 110" className="shrink-0">
                  {segments.map(seg => {
                    const dash = seg.frac * circumference;
                    return (
                      <circle
                        key={seg.provider}
                        r="52" cx="55" cy="55"
                        fill="none"
                        stroke={seg.color}
                        strokeWidth="11"
                        strokeDasharray={`${dash} ${circumference - dash}`}
                        strokeDashoffset={-seg.start * circumference}
                        strokeLinecap="butt"
                        transform="rotate(-90 55 55)"
                      />
                    );
                  })}
                  <text x="55" y="52" textAnchor="middle" className="text-[15px] font-black" fill="white">
                    {formatTokens(total)}
                  </text>
                  <text x="55" y="66" textAnchor="middle" className="text-xs font-bold" fill="rgba(255,255,255,0.2)">
                    TOTAL
                  </text>
                </svg>

                {/* Provider list */}
                <div className="flex-1 space-y-2">
                  {providers.map(([provider, stats]) => {
                    const pct = total > 0 ? Math.round((stats.totalTokens / total) * 100) : 0;
                    return (
                      <div key={provider} className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PROVIDER_COLORS[provider] || '#666' }} />
                            <span className="text-xs font-bold text-white/60">{PROVIDER_LABELS[provider] || provider}</span>
                          </div>
                          <span className="text-xs font-mono text-white/40">
                            {formatTokens(stats.totalTokens)} <span className="text-white/40">· {stats.calls} {uiMessage('token-dashboard.calls.4ba0c892ed')}</span>
                          </span>
                        </div>
                        <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, backgroundColor: PROVIDER_COLORS[provider] || '#666' }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </GlassCard>

          {/* Daily chart */}
          <GlassCard className="flex-1 p-4 rounded-2xl border-white/5 bg-white/[0.03] flex flex-col">
            <h3 className="text-[12px] font-bold text-white/45 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Clock size={10} /> {uiMessage('token-dashboard.daily-trend.d1aa72886d')}
            </h3>
            {!data?.daily || data.daily.length === 0 ? (
              <p className="text-white/45 text-xs py-6 text-center">{uiMessage('token-dashboard.no-daily-data-yet.2e3e2fda36')}</p>
            ) : (
              <div className="flex-1 flex flex-col justify-end">
                <div className="flex items-end gap-[2px] flex-1">
                  {data.daily.map((d, i) => {
                    const h = (d.totalTokens / maxDaily) * 100;
                    return (
                      <motion.div
                        key={d.date}
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max(h, 1.5)}%` }}
                        transition={{ delay: i * 0.005, type: 'spring', stiffness: 300, damping: 20 }}
                        className="flex-1 rounded-t-[3px] bg-amber-500/30 hover:bg-amber-400/60 transition-colors min-h-[3px] relative group cursor-pointer"
                      >
                        <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-black/90 border border-white/10 rounded-md text-[12px] font-mono text-white/70 opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity z-10">
                          {formatTokens(d.totalTokens)}
                        </div>
                        {/* Date label on x-axis */}
                        <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/40 opacity-0 group-hover:opacity-100 whitespace-nowrap transition-opacity">
                          {d.date.slice(5)}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
                {/* X-axis: first/last date labels */}
                <div className="flex justify-between mt-5 text-xs text-white/40 font-mono">
                  <span>{data.daily[0]?.date?.slice(5)}</span>
                  <span>{data.daily[data.daily.length - 1]?.date?.slice(5)}</span>
                </div>
              </div>
            )}
          </GlassCard>
        </div>
      )}
    </div>
  );
};
