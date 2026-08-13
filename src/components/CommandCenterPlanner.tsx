import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CalendarClock,
  Check,
  Loader2,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  Target,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '@/services/apiClient';
import { socketService } from '@/services/socketService';
import { commandCenterPlannerCopy } from '@/i18n/locales/commandCenterPlanner';

type PlanKind = 'daily_task' | 'long_term_goal' | 'periodic_report';
type PlanCadence = 'none' | 'daily' | 'weekly' | 'monthly';

type CommandCenterPlan = {
  id: string;
  kind: PlanKind;
  title: string;
  instruction: string;
  cadence: PlanCadence;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  status: 'active' | 'paused' | 'completed';
  nextRunAt: string;
  lastRuntimeTaskId: string;
  updatedAt: string;
};

type RuntimeTask = {
  id: string;
  status: string;
  resultPreview?: string;
  error?: string;
};

const KIND_ICONS = {
  daily_task: CalendarClock,
  long_term_goal: Target,
  periodic_report: BarChart3,
};

export function CommandCenterPlanner({
  isZh,
  conversationId,
  onDiscuss,
}: {
  isZh: boolean;
  conversationId: string;
  onDiscuss: (prompt: string) => void;
}) {
  const [plans, setPlans] = useState<CommandCenterPlan[]>([]);
  const [runtimeTasks, setRuntimeTasks] = useState<RuntimeTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [kind, setKind] = useState<PlanKind>('daily_task');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [cadence, setCadence] = useState<PlanCadence>('daily');
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);

  const copy = commandCenterPlannerCopy(isZh ? 'zh' : 'en');
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const [planResult, taskResult] = await Promise.allSettled([
      apiFetch('/api/command-center/plans').then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      }),
      apiFetch('/api/autonomy/background-tasks').then(async response => response.ok ? response.json() : {}),
    ]);
    if (planResult.status === 'fulfilled') {
      setPlans(Array.isArray(planResult.value?.plans) ? planResult.value.plans : []);
      setError('');
    } else {
      setError(planResult.reason instanceof Error ? planResult.reason.message : String(planResult.reason));
    }
    if (taskResult.status === 'fulfilled') {
      setRuntimeTasks(Array.isArray(taskResult.value?.tasks) ? taskResult.value.tasks : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const socket = socketService.connect();
    const update = () => void refresh(true);
    socket.on('agent:background_task_update', update);
    const timer = window.setInterval(update, 15_000);
    return () => {
      window.clearInterval(timer);
      socket.off('agent:background_task_update', update);
    };
  }, [refresh]);

  useEffect(() => {
    if (kind === 'daily_task') setCadence('daily');
    else if (kind === 'long_term_goal') setCadence('weekly');
    else setCadence('weekly');
  }, [kind]);

  const taskById = useMemo(() => new Map(runtimeTasks.map(task => [task.id, task])), [runtimeTasks]);

  const createPlan = async () => {
    if (!title.trim() || !instruction.trim()) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch('/api/command-center/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, title, instruction, cadence, timeOfDay, dayOfWeek, dayOfMonth, conversationId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setTitle('');
      setInstruction('');
      setShowCreate(false);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const updatePlan = async (plan: CommandCenterPlan, patch: Record<string, unknown>) => {
    setError('');
    const response = await apiFetch(`/api/command-center/plans/${encodeURIComponent(plan.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    await refresh(true);
  };

  const runPlan = async (plan: CommandCenterPlan) => {
    setError('');
    try {
      const response = await apiFetch(`/api/command-center/plans/${encodeURIComponent(plan.id)}/run`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removePlan = async (plan: CommandCenterPlan) => {
    const response = await apiFetch(`/api/command-center/plans/${encodeURIComponent(plan.id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error || `HTTP ${response.status}`);
      return;
    }
    await refresh(true);
  };

  const kindLabel = (value: PlanKind) => ({
    daily_task: copy.dailyTask,
    long_term_goal: copy.longTermGoal,
    periodic_report: copy.periodicReport,
  })[value];
  const cadenceLabel = (value: PlanCadence) => ({
    none: copy.manualOnly,
    daily: copy.daily,
    weekly: copy.weekly,
    monthly: copy.monthly,
  })[value];
  const planScheduleLabel = (plan: CommandCenterPlan) => {
    if (plan.cadence === 'none') return copy.manualOnly;
    if (plan.cadence === 'weekly') return `${copy.weekly} ${copy.weekdays[Math.max(0, Math.min(6, plan.dayOfWeek))]} ${plan.timeOfDay}`;
    if (plan.cadence === 'monthly') return `${copy.monthly} ${plan.dayOfMonth}${copy.monthDaySuffix} ${plan.timeOfDay}`;
    return `${copy.daily} ${plan.timeOfDay}`;
  };

  return <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(40,205,220,.08),transparent_42%)] px-4 py-4">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-black text-white/90">{copy.headerTitle}</div>
        <div className="mt-1 text-[10px] leading-4 text-white/35">{copy.headerDetail}</div>
      </div>
      <button type="button" onClick={() => setShowCreate(value => !value)} className="flex h-8 items-center gap-1.5 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.08] px-2.5 text-[10px] font-bold text-cyan-100/80 hover:bg-cyan-300/[0.13]">
        <Plus size={13} />{copy.newPlan}
      </button>
    </div>

    {showCreate && <div className="mb-4 space-y-3 rounded-2xl border border-cyan-300/14 bg-[#09121c]/88 p-3 shadow-xl shadow-black/20">
      <div className="grid grid-cols-3 gap-1.5">
        {(['daily_task', 'long_term_goal', 'periodic_report'] as PlanKind[]).map(value => {
          const Icon = KIND_ICONS[value];
          return <button key={value} type="button" onClick={() => setKind(value)} className={`rounded-xl border px-2 py-2 text-[9px] font-bold transition-colors ${kind === value ? 'border-cyan-300/30 bg-cyan-300/[0.11] text-cyan-50' : 'border-white/[0.07] bg-white/[0.025] text-white/40 hover:text-white/65'}`}>
            <Icon size={13} className="mx-auto mb-1" />{kindLabel(value)}
          </button>;
        })}
      </div>
      <input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder={copy.titlePlaceholder} className="h-9 w-full rounded-xl border border-white/[0.08] bg-black/25 px-3 text-xs text-white/80 outline-none placeholder:text-white/25 focus:border-cyan-300/25" />
      <textarea value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={2000} rows={3} placeholder={copy.instructionPlaceholder} className="w-full resize-none rounded-xl border border-white/[0.08] bg-black/25 px-3 py-2 text-xs leading-5 text-white/80 outline-none placeholder:text-white/25 focus:border-cyan-300/25" />
      <div className="flex gap-2">
        <select value={cadence} onChange={event => setCadence(event.target.value as PlanCadence)} className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#0a111a] px-2 text-[10px] text-white/60 outline-none">
          {(['none', 'daily', 'weekly', 'monthly'] as PlanCadence[]).map(value => <option key={value} value={value}>{cadenceLabel(value)}</option>)}
        </select>
        <input type="time" value={timeOfDay} onChange={event => setTimeOfDay(event.target.value)} disabled={cadence === 'none'} className="h-9 rounded-xl border border-white/[0.08] bg-[#0a111a] px-2 text-[10px] text-white/60 outline-none disabled:opacity-35" />
        <button type="button" disabled={saving || !title.trim() || !instruction.trim()} onClick={() => void createPlan()} className="flex h-9 items-center gap-1.5 rounded-xl bg-cyan-200 px-3 text-[10px] font-black text-[#062027] disabled:opacity-35">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}{copy.save}
        </button>
      </div>
      {cadence === 'weekly' && <label className="flex items-center gap-2 text-[9px] text-white/35">
        <span className="shrink-0">{copy.weekday}</span>
        <select value={dayOfWeek} onChange={event => setDayOfWeek(Number(event.target.value))} className="h-8 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#0a111a] px-2 text-[10px] text-white/60 outline-none">
          {copy.weekdays.map((label, value) => <option key={label} value={value}>{label}</option>)}
        </select>
      </label>}
      {cadence === 'monthly' && <label className="flex items-center gap-2 text-[9px] text-white/35">
        <span className="shrink-0">{copy.monthDay}</span>
        <input type="number" min={1} max={28} value={dayOfMonth} onChange={event => setDayOfMonth(Math.max(1, Math.min(28, Number(event.target.value) || 1)))} className="h-8 min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-[#0a111a] px-2 text-[10px] text-white/60 outline-none" />
        <span>{copy.monthDaySuffix}</span>
      </label>}
    </div>}

    {error && <div className="mb-3 rounded-xl border border-rose-300/15 bg-rose-400/[0.06] px-3 py-2 text-[10px] text-rose-100/70">{error}</div>}
    {loading ? <div className="flex flex-1 items-center justify-center text-cyan-100/35"><Loader2 size={18} className="animate-spin" /></div> : plans.length === 0 ? (
      <button type="button" onClick={() => setShowCreate(true)} className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-center text-white/30 hover:border-cyan-300/18 hover:text-white/45">
        <Target size={28} className="mb-3 text-cyan-200/25" />
        <span className="text-xs font-bold">{copy.emptyTitle}</span>
        <span className="mt-1 text-[10px]">{copy.emptyDetail}</span>
      </button>
    ) : <div className="space-y-2.5">
      {plans.map(plan => {
        const Icon = KIND_ICONS[plan.kind];
        const task = plan.lastRuntimeTaskId ? taskById.get(plan.lastRuntimeTaskId) : undefined;
        const status = task?.status || plan.status;
        return <article key={plan.id} className="rounded-2xl border border-white/[0.075] bg-[#09111a]/82 p-3 transition-colors hover:border-cyan-300/16">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/14 bg-cyan-300/[0.07] text-cyan-100/65"><Icon size={15} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-white/82">{plan.title}</div>
                  <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-white/36">{plan.instruction}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[8px] font-black uppercase ${['queued', 'running'].includes(status) ? 'bg-cyan-300/[0.11] text-cyan-100/80' : status === 'failed' || status === 'blocked' ? 'bg-rose-300/[0.10] text-rose-100/75' : status === 'completed' ? 'bg-emerald-300/[0.10] text-emerald-100/75' : 'bg-white/[0.05] text-white/35'}`}>{status}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[9px] text-white/28">
                <span>{kindLabel(plan.kind)}</span><span>·</span><span>{planScheduleLabel(plan)}</span>
                {plan.nextRunAt && <><span>·</span><span>{copy.next} {new Date(plan.nextRunAt).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></>}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-white/[0.05] pt-2.5">
            <button type="button" onClick={() => onDiscuss(copy.discussPrompt(plan.title, plan.instruction))} className="flex h-7 items-center gap-1 rounded-lg px-2 text-[9px] text-white/38 hover:bg-white/[0.05] hover:text-white/65"><MessageSquareText size={11} />{copy.discuss}</button>
            <button type="button" onClick={() => void runPlan(plan)} className="flex h-7 items-center gap-1 rounded-lg px-2 text-[9px] text-cyan-100/55 hover:bg-cyan-300/[0.08] hover:text-cyan-50"><Play size={11} />{copy.run}</button>
            <button type="button" onClick={() => void updatePlan(plan, { status: plan.status === 'paused' ? 'active' : 'paused' }).catch(cause => setError(String(cause)))} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/30 hover:bg-white/[0.05] hover:text-white/60" title={plan.status === 'paused' ? copy.resume : copy.pause}>{plan.status === 'paused' ? <Play size={11} /> : <Pause size={11} />}</button>
            <button type="button" onClick={() => void updatePlan(plan, { status: 'completed' }).catch(cause => setError(String(cause)))} className="flex h-7 w-7 items-center justify-center rounded-lg text-emerald-100/35 hover:bg-emerald-300/[0.08] hover:text-emerald-100" title={copy.complete}><Check size={11} /></button>
            <button type="button" onClick={() => void removePlan(plan)} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/24 hover:bg-rose-300/[0.08] hover:text-rose-100/70" title={copy.remove}><Trash2 size={11} /></button>
          </div>
        </article>;
      })}
    </div>}
  </div>;
}
