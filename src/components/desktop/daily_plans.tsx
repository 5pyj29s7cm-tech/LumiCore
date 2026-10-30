import { lazy, Suspense, useState, useCallback, useEffect } from "react";
import { Calendar, Trash2 } from "lucide-react";
import { uiMessage, formatUiMessage } from "../../i18n/uiMessages";
import { toast } from "sonner";
import { GlassCard } from "../SharedUI";
import { LazyPanelFallback } from "./window_shell";
import { useApp } from '@/contexts/AppContext';
import { useRecoverableRead } from '@/hooks/useRecoverableRead';
import { settingsRecoveryCopy } from '@/i18n/locales/settingsRecovery';
const AutonomousFeed = lazy(() => import("../AutonomousFeed").then(m => ({ default: m.AutonomousFeed })));


export function ExecutionWorkQueue({ t }: { t: any }) {
  const isZh = t?.langCode !== 'en';
  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-8">
      <section className="lumi-surface min-h-full rounded-3xl bg-black/20 p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-black uppercase tracking-widest text-white/85">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn">
              <Calendar size={18} />
            </span>
            {uiMessage('desktop-ui.lumi-learning-absorption.63919d4e18', (isZh) ? 'zh' : 'en')}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/42">
            {uiMessage('desktop-ui.this-is-lumi-s-own.657323f25a', (isZh) ? 'zh' : 'en')}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.25fr]">
        <DailyPlans t={t} embedded />
        <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
          <AutonomousFeed expanded />
        </Suspense>
      </div>
      </section>
    </div>
  );
}


function DailyPlans({ t, embedded = false, onOpenQueue }: { t: any; embedded?: boolean; onOpenQueue?: () => void }) {
  const { user, workDomain, orgConnection } = useApp();
  const scope = JSON.stringify([user?.uid, user?.role, workDomain, orgConnection?.orgId]);
  const recovery = settingsRecoveryCopy(t?.langCode);
  const [page, setPage] = useState(0);
  const read = useRecoverableRead<any[]>(scope, async signal => {
    const res = await fetch('/api/plans?status=active', { credentials: 'include', signal });
    if (!res.ok) throw new Error('Failed to load plans');
    const d = await res.json();
    if (!Array.isArray(d?.plans) || !d.plans.every((p: any) => p && typeof p.id === 'string' && typeof p.title === 'string')) throw new Error('Invalid plans response');
    return d.plans.filter((p: any) => (p.source === 'lumi' || p.source === 'auto') && !['done', 'completed', 'cancelled'].includes(p.status));
  });
  const plans = read.data || [], loading = read.loading;
  const setPlans = (update: (previous: any[]) => any[]) => read.setData(previous => update(previous || []));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(plans.length / 8) - 1));
  useEffect(() => { setPage(0); setBusyPlanIds([]); }, [scope]);
  const [busyPlanIds, setBusyPlanIds] = useState<string[]>([]);
  const isZh = t?.langCode !== 'en';
  const activeCount = plans.length;


  const deletePlan = async (id: string) => {
    setBusyPlanIds(prev => prev.includes(id) ? prev : [...prev, id]);
    try {
      const res = await fetch(`/api/plans/${id}`, { method: 'DELETE', credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Failed to delete plan');
      setPlans(prev => prev.filter(p => p.id !== id));
      toast.success(t.planDeleted || 'Plan deleted');
    } catch (err: any) {
      toast.error(err?.message || (t.planDeleteFailed || 'Failed to delete plan'));
    } finally {
      setBusyPlanIds(prev => prev.filter(planId => planId !== id));
    }
  };

  const getStepInfo = (plan: any) => {
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const done = steps.filter((step: any) => step.status === 'done' || step.status === 'skipped').length;
    const activeStep = steps.find((step: any) => step.status === 'in_progress')
      || steps.find((step: any) => step.status === 'pending');
    const label = activeStep
      ? activeStep.status === 'in_progress'
        ? (uiMessage('desktop-ui.absorbing.9a2002c5f8', (isZh) ? 'zh' : 'en'))
        : activeStep.title
      : (uiMessage('desktop-ui.waiting-for-next-run.d3f6c83394', (isZh) ? 'zh' : 'en'));
    return { steps, done, label };
  };

  const formatUpdatedAt = (value?: string) => {
    if (!value) return '';
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    return time.toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <GlassCard
      className={`lumi-panel ${embedded ? 'h-full' : 'cursor-pointer hover:bg-white/[0.05]'} space-y-3 rounded-2xl bg-black/20 p-5 transition-colors`}
      onClick={onOpenQueue}
    >
      <div className="flex items-center justify-between">
        <div>
          <span className="text-[12px] font-black uppercase tracking-widest text-white/65 flex items-center gap-2">
            <Calendar size={12} className="text-celestial-saturn" />
            {embedded ? (uiMessage('desktop-ui.lumi-learning-plans.217854e552', (isZh) ? 'zh' : 'en')) : (uiMessage('desktop-ui.lumi-learning.e36f32b264', (isZh) ? 'zh' : 'en'))}
          </span>
          {!embedded && (
            <p className="mt-1 text-[11px] text-white/30">
              {activeCount > 0
                ? (formatUiMessage('desktop-ui.value0-learning-plan-value1.cb87ad5f27', { value0: activeCount, value1: { en: activeCount === 1 ? '' : 's', zh: '' } }, (isZh) ? 'zh' : 'en'))
                : (uiMessage('desktop-ui.no-learning-plans.0a25534ef8', (isZh) ? 'zh' : 'en'))}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenQueue && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenQueue(); }}
              className="lumi-button h-7 px-2 text-[10px]"
            >
              {uiMessage('desktop-ui.queue.9b6d779554', (isZh) ? 'zh' : 'en')}
            </button>
          )}
        </div>
      </div>
      {read.error && <div role="alert">{recovery.failed} <button onClick={event => { event.stopPropagation(); void read.refresh(); }}>{recovery.retry}</button></div>}
      {loading ? (
        <div className="text-white/30 text-xs py-2">{uiMessage('desktop-ui.loading.586f5af819', (isZh) ? 'zh' : 'en')}</div>
      ) : read.error ? null : plans.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-xs text-white/30">
          {uiMessage('desktop-ui.lumi-has-not-generated-learning.6c804f7045', (isZh) ? 'zh' : 'en')}
        </div>
      ) : (
        <div className="space-y-2">
          {plans.slice(currentPage * 8, currentPage * 8 + 8).map((plan: any) => {
            const { steps, done, label } = getStepInfo(plan);
            const progress = steps.length > 0 ? `${done}/${steps.length}` : (uiMessage('desktop-ui.queued.bb6e139347', (isZh) ? 'zh' : 'en'));
            const updatedAt = formatUpdatedAt(plan.updatedAt);
            return (
              <div key={plan.id} className="group rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${plan.priority === 'critical' ? 'bg-red-300' : plan.priority === 'high' ? 'bg-orange-300' : plan.priority === 'medium' ? 'bg-amber-300' : 'bg-white/25'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-bold text-white/70">{plan.title}</span>
                      <span className="shrink-0 rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[10px] font-bold text-celestial-saturn/80">
                        {progress}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-white/35">
                      <span className="truncate">{label}</span>
                      {updatedAt && <span className="shrink-0 font-mono">{updatedAt}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deletePlan(plan.id); }}
                    disabled={busyPlanIds.includes(plan.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/15 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-200 group-hover:opacity-100 disabled:opacity-30"
                    title={uiMessage('desktop-ui.remove-plan.1f9be63399', (isZh) ? 'zh' : 'en')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && !read.error && plans.length > 8 && <nav aria-label={t.queue || 'Queue'} className="flex gap-3">
        <button disabled={currentPage === 0} onClick={event => { event.stopPropagation(); setPage(currentPage - 1); }}>{recovery.previous}</button>
        <span>{currentPage + 1} / {Math.ceil(plans.length / 8)}</span>
        <button disabled={(currentPage + 1) * 8 >= plans.length} onClick={event => { event.stopPropagation(); setPage(currentPage + 1); }}>{recovery.next}</button>
      </nav>}
    </GlassCard>
  );
}
