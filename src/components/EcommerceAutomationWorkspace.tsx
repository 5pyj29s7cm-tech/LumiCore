import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Database,
  FileSearch,
  Flame,
  Headphones,
  Link2,
  ListChecks,
  Megaphone,
  PackageCheck,
  Radar,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TicketCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  ecommerceModuleCommonCopy,
  ecommerceModuleCopy,
  type EcommerceModuleCopy,
  type EcommerceOutcomeId,
} from '../i18n/locales/ecommerceModules';
import { executeIndustryWorkflow, startIndustryWorkflow } from '../lib/industryWorkflowClient';
import type { EcommerceReportKind, EcommerceWorkbenchSnapshot } from '../../shared/ecommerce_workbench';
import { EcommerceHub } from './EcommerceHub';

export type EcommerceWorkspaceTarget =
  | 'reviews'
  | 'inventory'
  | 'listing-automation'
  | 'trend-discovery'
  | 'ai-customer-service';

function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-white/55">
      <span className="text-cyan-200/70">{icon}</span>
      {title}
    </h3>
  );
}

function formatCommerceCurrency(value: number, lang: string): string {
  return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCommerceNumber(value: number, lang: string, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits }).format(value);
}

export function TodayOperationsBoard({
  module,
  lang,
  snapshot,
  onOpenWorkspace,
}: {
  module: EcommerceModuleCopy;
  lang: string;
  snapshot?: EcommerceWorkbenchSnapshot | null;
  onOpenWorkspace?: (target: EcommerceWorkspaceTarget) => void;
}) {
  const common = ecommerceModuleCommonCopy(lang);
  const sourceKinds = new Set<EcommerceReportKind>(snapshot?.sources.map(source => source.kind) || []);
  const hasData = sourceKinds.size > 0;
  const hasOrders = sourceKinds.has('orders');
  const hasRefundBasis = hasOrders || sourceKinds.has('afterSales');
  const hasInventory = sourceKinds.has('inventory');
  const hasCampaigns = sourceKinds.has('campaigns');
  const metrics = [
    {
      id: 'sales',
      label: common.metricLabels[0],
      value: hasOrders && snapshot ? formatCommerceCurrency(snapshot.metrics.gmv, lang) : '—',
      ready: hasOrders,
    },
    {
      id: 'orders',
      label: common.metricLabels[1],
      value: hasOrders && snapshot ? formatCommerceNumber(snapshot.metrics.orderCount, lang) : '—',
      ready: hasOrders,
    },
    {
      id: 'contribution',
      label: common.metricLabels[2],
      value: hasOrders && snapshot ? formatCommerceCurrency(snapshot.metrics.contributionProfit, lang) : '—',
      ready: hasOrders,
    },
    {
      id: 'roas',
      label: common.metricLabels[3],
      value: hasCampaigns && snapshot && snapshot.metrics.adSpend > 0
        ? `${formatCommerceNumber(snapshot.metrics.roas, lang, 2)}x`
        : '—',
      ready: hasCampaigns && Boolean(snapshot?.metrics.adSpend),
    },
    {
      id: 'refund-rate',
      label: common.metricLabels[4],
      value: hasRefundBasis && snapshot ? `${formatCommerceNumber(snapshot.metrics.refundRate, lang, 2)}%` : '—',
      ready: hasRefundBasis,
    },
    {
      id: 'stockout-risk',
      label: common.metricLabels[5],
      value: hasInventory && snapshot ? formatCommerceNumber(snapshot.inventoryAlerts.length, lang) : '—',
      ready: hasInventory,
    },
  ];
  const entries: Array<{
    target: EcommerceWorkspaceTarget;
    title: string;
    description: string;
    icon: React.ReactNode;
    ready: boolean;
    tone: string;
  }> = [
    {
      target: 'reviews',
      title: common.ordersEntry,
      description: common.ordersEntryDescription,
      icon: <ShoppingBag size={19} />,
      ready: hasOrders,
      tone: 'border-cyan-300/12 bg-cyan-300/[0.035] text-cyan-100',
    },
    {
      target: 'listing-automation',
      title: common.productsEntry,
      description: common.productsEntryDescription,
      icon: <PackageCheck size={19} />,
      ready: hasOrders || hasInventory,
      tone: 'border-emerald-300/12 bg-emerald-300/[0.035] text-emerald-100',
    },
    {
      target: 'inventory',
      title: common.inventoryEntry,
      description: common.inventoryEntryDescription,
      icon: <Boxes size={19} />,
      ready: hasInventory,
      tone: 'border-amber-300/12 bg-amber-300/[0.035] text-amber-100',
    },
    {
      target: 'trend-discovery',
      title: common.marketingEntry,
      description: common.marketingEntryDescription,
      icon: <Megaphone size={19} />,
      ready: hasCampaigns,
      tone: 'border-orange-300/12 bg-orange-300/[0.035] text-orange-100',
    },
    {
      target: 'ai-customer-service',
      title: common.serviceEntry,
      description: common.serviceEntryDescription,
      icon: <Headphones size={19} />,
      ready: sourceKinds.has('reviews') || sourceKinds.has('afterSales'),
      tone: 'border-violet-300/12 bg-violet-300/[0.035] text-violet-100',
    },
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-cyan-300/12 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.08),transparent_42%),rgba(0,0,0,0.2)] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <SectionHeading icon={<Database size={17} />} title={common.overviewTitle} />
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/48">{common.overviewSubtitle}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-[10px] font-black">
            <span className={`rounded-full border px-3 py-1.5 ${hasData ? 'border-emerald-300/15 bg-emerald-300/[0.07] text-emerald-100/70' : 'border-white/10 bg-white/[0.035] text-white/38'}`}>
              {hasData ? common.dataReady : common.sourcePending}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-white/45">
              {common.sourceCoverage} {sourceKinds.size}/5
            </span>
            <span className="rounded-full border border-amber-300/12 bg-amber-300/[0.045] px-3 py-1.5 text-amber-100/55">
              {common.riskItems} {hasData ? snapshot?.risks.length || 0 : '—'}
            </span>
          </div>
        </div>
        {!hasData && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-dashed border-white/10 bg-black/15 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-black text-white/68">{common.emptyTitle}</p>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-white/38">{common.emptyDescription}</p>
            </div>
            <button
              type="button"
              disabled={!onOpenWorkspace}
              onClick={() => onOpenWorkspace?.('reviews')}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.08] px-4 text-xs font-black text-cyan-100/70 transition hover:bg-cyan-300/[0.13] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Database size={15} />{common.openStoreData}<ArrowRight size={14} />
            </button>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {metrics.map(metric => (
          <article key={metric.id} className="rounded-2xl border border-cyan-300/10 bg-cyan-300/[0.035] p-4">
            <div className="flex items-center justify-between text-[11px] text-white/35"><span>{metric.label}</span><BarChart3 size={13} /></div>
            <p data-testid={`commerce-metric-${metric.id}`} className={`mt-4 truncate text-2xl font-black tabular-nums ${metric.ready ? 'text-white/78' : 'text-white/25'}`}>{metric.value}</p>
            <p className={`mt-2 text-[10px] ${metric.ready ? 'text-emerald-100/48' : 'text-cyan-100/35'}`}>{metric.ready ? common.dataReady : common.sourcePending}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {entries.map(entry => (
          <button
            key={entry.target}
            type="button"
            disabled={!onOpenWorkspace}
            onClick={() => onOpenWorkspace?.(entry.target)}
            aria-label={`${entry.title} · ${common.openWorkspace}`}
            className={`group flex min-h-44 flex-col rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.055] disabled:cursor-not-allowed disabled:opacity-45 ${entry.tone}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-xl border border-current/10 bg-black/15 p-2.5">{entry.icon}</span>
              <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black ${entry.ready ? 'border-emerald-300/15 bg-emerald-300/[0.07] text-emerald-100/65' : 'border-white/9 bg-white/[0.035] text-white/32'}`}>
                {entry.ready ? common.dataReady : common.sourcePending}
              </span>
            </div>
            <p className="mt-4 text-sm font-black text-white/72">{entry.title}</p>
            <p className="mt-2 flex-1 text-xs leading-5 text-white/40">{entry.description}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-[10px] font-black text-white/55 group-hover:text-white/80">{common.openWorkspace}<ArrowRight size={13} /></span>
          </button>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-2xl border border-white/9 bg-black/20 p-5">
          <SectionHeading icon={<ListChecks size={16} />} title={common.actionQueue} />
          <div className="mt-4 space-y-2">
            {module.process.map((item, index) => (
              <div key={item} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-white/7 bg-white/[0.025] px-3 py-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-300/10 text-[11px] font-black text-cyan-100/65">0{index + 1}</span>
                <span className="text-sm text-white/65">{item}</span>
                <span className="text-[10px] text-white/28">{common.sourcePending}</span>
              </div>
            ))}
          </div>
        </article>
        <article className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.035] p-5">
          <SectionHeading icon={<TriangleAlert size={16} />} title={module.outputs[1]} />
          <div className="mt-4 space-y-3">
            {module.checks.map(item => (
              <div key={item} className="flex gap-3 rounded-xl bg-black/15 px-3 py-3 text-xs leading-5 text-white/52">
                <CircleDashed size={15} className="mt-0.5 shrink-0 text-amber-200/60" />{item}
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}

function TrendSignalBoard({ module, lang }: { module: EcommerceModuleCopy; lang: string }) {
  const common = ecommerceModuleCommonCopy(lang);
  return (
    <section className="rounded-3xl border border-orange-300/12 bg-[radial-gradient(circle_at_10%_0%,rgba(251,146,60,0.11),transparent_36%),rgba(10,10,10,0.25)] p-5">
      <SectionHeading icon={<Radar size={17} />} title={common.signalBoard} />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {common.trendChannels.map((channel, index) => (
          <article key={channel} className="relative overflow-hidden rounded-2xl border border-white/8 bg-black/20 p-4">
            <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full border border-orange-200/10" />
            <div className="absolute -right-2 -top-3 h-16 w-16 rounded-full border border-orange-200/10" />
            <div className="flex items-center justify-between"><span className="text-sm font-black text-white/72">{channel}</span><Flame size={16} className="text-orange-200/60" /></div>
            <div className="mt-6 flex h-20 items-end gap-2">
              {[34, 62, 47, 78, 55].map((height, barIndex) => <span key={barIndex} className="flex-1 rounded-t bg-gradient-to-t from-orange-400/15 to-rose-300/45" style={{ height: `${Math.max(18, height - index * 6)}%` }} />)}
            </div>
            <p className="mt-3 text-[11px] text-orange-100/35">{common.sourcePending}</p>
          </article>
        ))}
      </div>
      <div className="mt-4 grid gap-2 lg:grid-cols-4">
        {module.process.map((item, index) => (
          <div key={item} className="rounded-xl border border-orange-300/8 bg-orange-300/[0.025] px-3 py-3 text-xs leading-5 text-white/52">
            <span className="mr-2 font-mono text-orange-200/45">0{index + 1}</span>{item}
          </div>
        ))}
      </div>
    </section>
  );
}

function ListingQueue({ module, lang }: { module: EcommerceModuleCopy; lang: string }) {
  const common = ecommerceModuleCommonCopy(lang);
  return (
    <section className="overflow-hidden rounded-3xl border border-emerald-300/12 bg-[#081411]">
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-4">
        <SectionHeading icon={<PackageCheck size={17} />} title={common.skuQueue} />
        <span className="rounded-full border border-emerald-300/12 bg-emerald-300/[0.06] px-3 py-1 text-[10px] text-emerald-100/48">{common.reviewPending}</span>
      </div>
      <div className="hidden grid-cols-[1.2fr_1fr_1fr_1fr_0.8fr] gap-3 border-b border-white/6 bg-white/[0.018] px-5 py-3 text-[10px] font-black uppercase tracking-[0.1em] text-white/28 md:grid">
        {common.skuHeaders.map(header => <span key={header}>{header}</span>)}
      </div>
      <div className="divide-y divide-white/6">
        {module.inputs.map((item, index) => (
          <div key={item} className="grid gap-2 px-5 py-4 text-xs md:grid-cols-[1.2fr_1fr_1fr_1fr_0.8fr] md:items-center md:gap-3">
            <span className="font-semibold text-white/68">{item}</span>
            <span className="text-white/32">{common.sourcePending}</span>
            <span className="text-amber-100/42">{module.checks[index]}</span>
            <span className="text-emerald-100/42">{module.process[index + 1]}</span>
            <span className="w-fit rounded-full bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/32">{common.reviewPending}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ContentServiceBoard({ module, lang }: { module: EcommerceModuleCopy; lang: string }) {
  const common = ecommerceModuleCommonCopy(lang);
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <article className="rounded-3xl border border-violet-300/12 bg-violet-300/[0.03] p-5">
        <SectionHeading icon={<Sparkles size={17} />} title={common.contentPlan} />
        <div className="mt-4 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2">
          {module.process.slice(0, 3).map((item, index) => (
            <div key={item} className="contents">
              <span className="rounded-lg bg-violet-300/[0.07] px-2 py-3 text-center text-[10px] font-black text-violet-100/50">D+{index}</span>
              <div className="rounded-xl border border-white/7 bg-black/15 px-3 py-3 text-xs text-white/55"><p>{item}</p><p className="mt-1 text-[10px] text-violet-100/32">{common.sourcePending}</p></div>
            </div>
          ))}
        </div>
      </article>
      <article className="rounded-3xl border border-fuchsia-300/12 bg-fuchsia-300/[0.025] p-5">
        <SectionHeading icon={<Headphones size={17} />} title={common.serviceQueue} />
        <div className="mt-4 space-y-2">
          {module.outputs.map((item, index) => (
            <div key={item} className="flex items-center gap-3 rounded-xl border border-white/7 bg-black/15 px-3 py-3">
              <span className={`h-2.5 w-2.5 rounded-full ${index === 2 ? 'bg-rose-300/60' : 'bg-fuchsia-300/50'}`} />
              <span className="min-w-0 flex-1 text-xs text-white/58">{item}</span>
              <span className="text-[10px] text-white/28">{common.reviewPending}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-rose-300/10 bg-rose-300/[0.035] p-3 text-xs leading-5 text-rose-100/48">{module.confirmation}</div>
      </article>
    </section>
  );
}

function ModuleVisualization({
  module,
  lang,
  snapshot,
  onOpenWorkspace,
}: {
  module: EcommerceModuleCopy;
  lang: string;
  snapshot?: EcommerceWorkbenchSnapshot | null;
  onOpenWorkspace?: (target: EcommerceWorkspaceTarget) => void;
}) {
  if (module.id === 'today-operations') {
    return <TodayOperationsBoard module={module} lang={lang} snapshot={snapshot} onOpenWorkspace={onOpenWorkspace} />;
  }
  if (module.id === 'trend-discovery') return <TrendSignalBoard module={module} lang={lang} />;
  if (module.id === 'listing-automation') return <ListingQueue module={module} lang={lang} />;
  return <ContentServiceBoard module={module} lang={lang} />;
}

export function EcommerceAutomationWorkspace({
  appId,
  lang,
  onOpenSettings,
  snapshot,
  onSnapshotChange,
  onOpenWorkspace,
  initialReportKind = 'orders',
}: {
  appId: EcommerceOutcomeId;
  lang: 'en' | 'zh';
  onOpenSettings: () => void;
  snapshot?: EcommerceWorkbenchSnapshot | null;
  onSnapshotChange?: (snapshot: EcommerceWorkbenchSnapshot | null) => void;
  onOpenWorkspace?: (target: EcommerceWorkspaceTarget) => void;
  initialReportKind?: EcommerceReportKind;
}) {
  const module = ecommerceModuleCopy(lang, appId);
  const common = ecommerceModuleCommonCopy(lang);
  const [input, setInput] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [result, setResult] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    setInput('');
    setTaskId('');
    setResult('');
    setWorkflowStatus('');
    setError('');
  }, [appId]);

  if (appId === 'store-data') {
    return <EcommerceHub lang={lang} initialReportKind={initialReportKind} workflowEntryId="store-data" onSnapshotChange={onSnapshotChange} />;
  }

  const prepare = async () => {
    const source = input.trim();
    if (!source || preparing) return;
    setPreparing(true);
    setResult('');
    setWorkflowStatus('creating');
    setError('');
    try {
      const workflow = await startIndustryWorkflow({ entryId: appId, sourceInput: source, source: 'ecommerce_workspace' });
      setTaskId(workflow.task.id);
      setWorkflowStatus('in_progress');
      const controller = new AbortController();
      abortRef.current = controller;
      const execution = await executeIndustryWorkflow({
        taskId: workflow.task.id,
        sourceInput: source,
        prompt: `${workflow.handoffPrompt}\n\n${module.prompt}\n\n${module.inputLabel}:\n${source}\n\n${module.confirmation}`,
        signal: controller.signal,
        onProgress: progress => {
          setResult(progress.text);
          setWorkflowStatus(progress.status);
        },
      });
      setResult(execution.text);
      setWorkflowStatus(execution.status);
    } catch (reason) {
      if ((reason as any)?.name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : String(reason));
        setWorkflowStatus('blocked');
      }
    } finally {
      abortRef.current = null;
      setPreparing(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.09),transparent_31%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.06),transparent_28%)] text-white">
      <div className="mx-auto flex min-h-full max-w-[1320px] flex-col gap-5 p-5 sm:p-6">
        <header className="flex flex-col gap-4 border-b border-white/7 pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.07] p-3 text-cyan-100/75">
              {appId === 'today-operations' ? <ShoppingBag size={25} /> : appId === 'trend-discovery' ? <Radar size={25} /> : appId === 'listing-automation' ? <PackageCheck size={25} /> : <Headphones size={25} />}
            </div>
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.16em] text-cyan-100/45">{module.eyebrow}</div>
              <h2 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">{module.title}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/48">{module.subtitle}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/15 bg-cyan-300/[0.06] px-3 py-1.5 text-[10px] font-black text-cyan-100/65"><Sparkles size={12} />{common.semiAutomated}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/15 bg-amber-300/[0.06] px-3 py-1.5 text-[10px] font-black text-amber-100/65"><ShieldCheck size={12} />{common.humanApproval}</span>
          </div>
        </header>

        <ModuleVisualization module={module} lang={lang} snapshot={snapshot} onOpenWorkspace={onOpenWorkspace} />

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(310px,0.75fr)]">
          <article className="rounded-3xl border border-white/9 bg-black/20 p-5">
            <SectionHeading icon={<FileSearch size={17} />} title={common.taskBrief} />
            <p className="mt-3 text-sm leading-6 text-white/45">{module.objective}</p>
            <textarea
              value={input}
              onChange={event => { setInput(event.target.value); setTaskId(''); setResult(''); setWorkflowStatus(''); }}
              placeholder={module.inputPlaceholder}
              className="mt-4 min-h-28 w-full resize-y rounded-2xl border border-white/10 bg-black/25 p-4 text-sm leading-6 text-white/75 outline-none placeholder:text-white/22 focus:border-cyan-300/25"
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={!input.trim() || preparing} onClick={() => void prepare()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-300 to-emerald-300 px-4 text-xs font-black text-[#041012] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35">
                <TicketCheck size={16} />{preparing ? common.starting : common.start}<ArrowRight size={15} />
              </button>
              {preparing && (
                <button type="button" onClick={() => abortRef.current?.abort()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-rose-300/15 bg-rose-300/[0.06] px-4 text-xs font-black text-rose-100/65 hover:bg-rose-300/10">{common.stop}</button>
              )}
              {appId === 'today-operations' && onOpenWorkspace && (
                <button type="button" onClick={() => onOpenWorkspace('reviews')} className="inline-flex h-10 items-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.06] px-4 text-xs font-black text-cyan-100/65 hover:bg-cyan-300/10"><BarChart3 size={15} />{common.openStoreData}</button>
              )}
              <button type="button" onClick={onOpenSettings} className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-white/50 hover:bg-white/[0.08] hover:text-white"><Link2 size={15} />{common.openConnections}</button>
            </div>
            {taskId && <p className="mt-3 flex items-center gap-2 text-xs font-bold text-emerald-200/65"><CheckCircle2 size={14} />{common.taskCreated}<span className="font-mono text-emerald-200/35">{taskId}</span></p>}
            {error && <p className="mt-3 text-xs font-bold text-rose-200/70">{error}</p>}
          </article>

          <aside className="rounded-3xl border border-amber-300/12 bg-amber-300/[0.035] p-5">
            <SectionHeading icon={<ShieldCheck size={17} />} title={common.outputTitle} />
            <div className="mt-4 space-y-2">
              {module.outputs.map(item => <div key={item} className="flex gap-3 rounded-xl border border-white/6 bg-black/12 px-3 py-3 text-xs leading-5 text-white/55"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-200/55" />{item}</div>)}
            </div>
            <div className="mt-4 rounded-xl border border-amber-300/10 bg-black/12 p-3 text-xs leading-5 text-amber-50/50">{module.confirmation}</div>
          </aside>
        </section>

        {(preparing || result || taskId) && (
          <section className="rounded-3xl border border-cyan-300/12 bg-cyan-300/[0.025] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionHeading icon={<Sparkles size={17} />} title={common.liveResult} />
              <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-1 text-[10px] font-mono text-white/42">{workflowStatus || 'in_progress'}</span>
            </div>
            <div className="mt-4 min-h-20 whitespace-pre-wrap rounded-2xl border border-white/7 bg-black/20 p-4 text-sm leading-6 text-white/65">
              {result || (preparing ? common.running : common.noResultYet)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
