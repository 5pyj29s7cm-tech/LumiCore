import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Database,
  FileCheck2,
  FileSpreadsheet,
  GitCompareArrows,
  Landmark,
  Layers3,
  LineChart,
  ListChecks,
  ReceiptText,
  ShieldCheck,
  TableProperties,
  TriangleAlert,
  WalletCards,
  Wrench,
} from 'lucide-react';
import { financeWorkbenchCopy } from '../i18n/locales/financeWorkbench';
import { financeDeliveryFormCopy } from '../i18n/locales/financeDeliveryForm';
import {
  financeModuleCopy,
  type FinanceModuleCopy,
  type FinanceModuleId,
} from '../i18n/locales/financeModules';
import {
  buildIndustryWorkflowIdempotencyKey,
  executeFinanceDeliveryWorkflow,
  executeIndustryWorkflow,
  startIndustryWorkflow,
} from '../lib/industryWorkflowClient';

export interface FinanceWorkbenchProps {
  lang: string;
  domain: 'personal' | 'work';
  initialWorkflowId?: string;
  onOpenKnowledge: () => void;
  onOpenSkills: () => void;
}

const WORKFLOW_ICONS = [LineChart, ReceiptText, FileSpreadsheet, Landmark, WalletCards, ShieldCheck];

function structuredFinanceInput(value: string): Record<string, unknown> {
  const source = value.trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { sourceBrief: source };
  } catch {
    // The server returns the exact required structured fields without inventing
    // figures when the brief is not a JSON object.
    return { sourceBrief: source };
  }
}

function financeDeliveryInput(entryId: string, values: Record<string, string>): Record<string, unknown> {
  const supplied = (name: string) => values[name]?.trim() || '';
  if (entryId === 'tax-filing') {
    return Object.fromEntries(Object.entries({
      period: supplied('period'),
      jurisdiction: supplied('jurisdiction'),
      taxpayerType: supplied('taxpayerType'),
      dueDate: supplied('dueDate'),
      taxes: supplied('taxes').split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean),
      businessType: supplied('businessType'),
      currency: supplied('currency'),
      revenue: supplied('revenue'),
      deductibleCost: supplied('deductibleCost'),
      deductibleExpense: supplied('deductibleExpense'),
      incomeTaxRate: supplied('incomeTaxRate'),
      vatOutputTax: supplied('vatOutputTax'),
      vatInputTax: supplied('vatInputTax'),
      surchargeRate: supplied('surchargeRate'),
    }).filter(([, value]) => value !== '' && (!Array.isArray(value) || value.length > 0)));
  }
  if (entryId === 'report-delivery') {
    const statement = Object.fromEntries(['totalAssets', 'totalLiabilities', 'totalEquity', 'tolerance']
      .map(name => [name, supplied(name)])
      .filter(([, value]) => value !== ''));
    return {
      period: supplied('period'),
      currency: supplied('currency'),
      businessType: supplied('businessType'),
      dataSummary: supplied('dataSummary'),
      statement,
    };
  }
  return structuredFinanceInput(values.sourceBrief || '');
}

const FINANCE_PRESENTATION: Record<FinanceModuleId, {
  shell: string;
  header: string;
  badge: string;
  evidence: string;
  task: string;
  primary: string;
  result: string;
  icon: typeof LineChart;
}> = {
  'business-dashboard': {
    shell: 'bg-[#07120e] bg-[radial-gradient(circle_at_12%_0%,rgba(16,185,129,0.11),transparent_35%)]',
    header: 'border-emerald-300/12 bg-[linear-gradient(105deg,rgba(6,78,59,0.28),rgba(0,0,0,0.08))]',
    badge: 'border-emerald-300/18 bg-emerald-300/10 text-emerald-100',
    evidence: 'border-emerald-300/12 bg-emerald-300/[0.045]',
    task: 'border-emerald-300/14 bg-emerald-300/[0.035]',
    primary: 'bg-emerald-300 text-[#06110d] hover:bg-emerald-200',
    result: 'border-emerald-300/12 bg-emerald-300/[0.025]',
    icon: BarChart3,
  },
  'invoice-tax': {
    shell: 'bg-[#151108] bg-[radial-gradient(circle_at_84%_0%,rgba(245,158,11,0.11),transparent_34%)]',
    header: 'border-amber-300/12 bg-[linear-gradient(105deg,rgba(120,53,15,0.28),rgba(0,0,0,0.08))]',
    badge: 'border-amber-300/18 bg-amber-300/10 text-amber-100',
    evidence: 'border-amber-300/12 bg-amber-300/[0.045]',
    task: 'border-amber-300/14 bg-amber-300/[0.035]',
    primary: 'bg-amber-300 text-[#181006] hover:bg-amber-200',
    result: 'border-amber-300/12 bg-amber-300/[0.025]',
    icon: ReceiptText,
  },
  accounting: {
    shell: 'bg-[#071117] bg-[linear-gradient(rgba(34,211,238,0.022)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.022)_1px,transparent_1px)] bg-[size:30px_30px]',
    header: 'border-cyan-300/12 bg-[linear-gradient(105deg,rgba(14,116,144,0.23),rgba(0,0,0,0.08))]',
    badge: 'border-cyan-300/18 bg-cyan-300/10 text-cyan-100',
    evidence: 'border-cyan-300/12 bg-cyan-300/[0.045]',
    task: 'border-cyan-300/14 bg-cyan-300/[0.035]',
    primary: 'bg-cyan-300 text-[#061116] hover:bg-cyan-200',
    result: 'border-cyan-300/12 bg-cyan-300/[0.025]',
    icon: BookOpenCheck,
  },
  'tax-filing': {
    shell: 'bg-[#100c18] bg-[radial-gradient(circle_at_50%_-8%,rgba(139,92,246,0.13),transparent_36%)]',
    header: 'border-violet-300/12 bg-[linear-gradient(105deg,rgba(76,29,149,0.28),rgba(0,0,0,0.08))]',
    badge: 'border-violet-300/18 bg-violet-300/10 text-violet-100',
    evidence: 'border-violet-300/12 bg-violet-300/[0.045]',
    task: 'border-violet-300/14 bg-violet-300/[0.035]',
    primary: 'bg-violet-300 text-[#10091d] hover:bg-violet-200',
    result: 'border-violet-300/12 bg-violet-300/[0.025]',
    icon: CalendarClock,
  },
  'cash-risk': {
    shell: 'bg-[#170b0f] bg-[radial-gradient(circle_at_82%_5%,rgba(244,63,94,0.12),transparent_34%)]',
    header: 'border-rose-300/12 bg-[linear-gradient(105deg,rgba(136,19,55,0.26),rgba(0,0,0,0.08))]',
    badge: 'border-rose-300/18 bg-rose-300/10 text-rose-100',
    evidence: 'border-rose-300/12 bg-rose-300/[0.045]',
    task: 'border-rose-300/14 bg-rose-300/[0.035]',
    primary: 'bg-rose-300 text-[#19070d] hover:bg-rose-200',
    result: 'border-rose-300/12 bg-rose-300/[0.025]',
    icon: LineChart,
  },
  'report-delivery': {
    shell: 'bg-[#08111b] bg-[radial-gradient(circle_at_18%_0%,rgba(56,189,248,0.11),transparent_35%)]',
    header: 'border-sky-300/12 bg-[linear-gradient(105deg,rgba(7,89,133,0.25),rgba(0,0,0,0.08))]',
    badge: 'border-sky-300/18 bg-sky-300/10 text-sky-100',
    evidence: 'border-sky-300/12 bg-sky-300/[0.045]',
    task: 'border-sky-300/14 bg-sky-300/[0.035]',
    primary: 'bg-sky-300 text-[#06121a] hover:bg-sky-200',
    result: 'border-sky-300/12 bg-sky-300/[0.025]',
    icon: FileCheck2,
  },
};

const DEFAULT_PRESENTATION = FINANCE_PRESENTATION['business-dashboard'];

interface FinanceSkillRuntime {
  name: string;
  enabled?: boolean;
  connected?: boolean;
  broken?: boolean;
  toolCount?: number;
  healthStatus?: string;
  startupError?: string;
}

interface FinanceRuntimeState {
  status: 'checking' | 'ready' | 'attention';
  version?: string;
  variantId?: string;
  skills: Record<string, FinanceSkillRuntime>;
}

function ModuleHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
      <span className="text-emerald-200/75">{icon}</span>
      {title}
    </h2>
  );
}

function ModuleVisualization({ module }: { module: FinanceModuleCopy }) {
  if (module.id === 'business-dashboard') {
    return (
      <section className="rounded-2xl border border-emerald-300/12 bg-[#0a1712] p-5">
        <ModuleHeading icon={<BarChart3 size={17} />} title={module.processTitle} />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {module.process.map((item, index) => (
            <article key={item} className="rounded-xl border border-white/8 bg-white/[0.035] p-4">
              <div className="flex items-center justify-between text-[11px] text-white/35">
                <span>0{index + 1}</span><CircleDashed size={14} />
              </div>
              <p className="mt-5 text-sm font-semibold leading-5 text-white/75">{item}</p>
              <p className="mt-2 text-[11px] text-emerald-100/40">{module.sourcePending}</p>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (module.id === 'invoice-tax') {
    return (
      <section className="overflow-hidden rounded-2xl border border-amber-300/12 bg-[#17130a]">
        <div className="border-b border-white/8 px-5 py-4"><ModuleHeading icon={<ReceiptText size={17} />} title={module.inputTitle} /></div>
        <div className="divide-y divide-white/6">
          {module.inputs.map((item, index) => (
            <div key={item} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-300/10 text-[11px] font-semibold text-amber-100/65">{index + 1}</span>
              <span className="text-sm text-white/68">{item}</span>
              <span className="rounded-full border border-amber-300/12 bg-amber-300/[0.06] px-2.5 py-1 text-[10px] text-amber-100/50">{module.sourcePending}</span>
            </div>
          ))}
        </div>
        <div className="grid gap-2 border-t border-white/8 bg-black/10 p-4 sm:grid-cols-3">
          {module.checks.map(item => <div key={item} className="flex gap-2 text-xs leading-5 text-white/48"><TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-200/65" />{item}</div>)}
        </div>
      </section>
    );
  }

  if (module.id === 'accounting') {
    const columns = [
      { title: module.inputTitle, items: module.inputs, icon: <BookOpenCheck size={17} /> },
      { title: module.processTitle, items: module.process, icon: <GitCompareArrows size={17} /> },
      { title: module.outputTitle, items: module.outputs, icon: <TableProperties size={17} /> },
    ];
    return (
      <section className="grid gap-3 lg:grid-cols-3">
        {columns.map(column => (
          <article key={column.title} className="rounded-2xl border border-cyan-300/10 bg-cyan-300/[0.025] p-4">
            <ModuleHeading icon={column.icon} title={column.title} />
            <div className="mt-4 space-y-2">
              {column.items.map(item => <div key={item} className="rounded-xl border border-white/6 bg-black/15 px-3 py-2.5 text-xs leading-5 text-white/55">{item}</div>)}
            </div>
          </article>
        ))}
      </section>
    );
  }

  if (module.id === 'tax-filing') {
    return (
      <section className="rounded-2xl border border-violet-300/12 bg-violet-300/[0.025] p-5">
        <ModuleHeading icon={<CalendarClock size={17} />} title={module.processTitle} />
        <div className="relative mt-5 space-y-0 before:absolute before:bottom-4 before:left-[15px] before:top-4 before:w-px before:bg-violet-200/15">
          {module.process.map((item, index) => (
            <div key={item} className="relative flex items-start gap-4 pb-5 last:pb-0">
              <span className="z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-200/20 bg-[#100d19] text-xs font-semibold text-violet-100/70">{index + 1}</span>
              <div className="min-w-0 flex-1 rounded-xl border border-white/7 bg-white/[0.03] px-4 py-3">
                <p className="text-sm text-white/72">{item}</p>
                <p className="mt-1 text-[11px] text-violet-100/38">{index === module.process.length - 1 ? module.reviewPending : module.sourcePending}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (module.id === 'cash-risk') {
    const widths = ['58%', '76%', '38%'];
    return (
      <section className="rounded-2xl border border-rose-300/12 bg-[#170d10] p-5">
        <ModuleHeading icon={<LineChart size={17} />} title={module.outputTitle} />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {module.outputs.map((item, index) => (
            <article key={item} className="rounded-xl border border-white/8 bg-black/15 p-4">
              <p className="text-sm font-semibold text-white/70">{item}</p>
              <div className="mt-6 h-24 rounded-lg bg-[linear-gradient(to_top,rgba(251,113,133,0.08),transparent)] p-3">
                <div className="flex h-full items-end gap-1.5">
                  {[42, 62, 54, 74, 48, 68].map((height, barIndex) => (
                    <span key={barIndex} className="flex-1 rounded-t bg-rose-300/25" style={{ height: `${Math.max(12, height - index * 7)}%` }} />
                  ))}
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-rose-300/45" style={{ width: widths[index] }} /></div>
              <p className="mt-2 text-[11px] text-rose-100/40">{module.sourcePending}</p>
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-sky-300/12 bg-sky-300/[0.025] p-5">
      <ModuleHeading icon={<FileCheck2 size={17} />} title={module.outputTitle} />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {module.outputs.map((item, index) => (
          <article key={item} className="rounded-xl border border-white/8 bg-black/15 p-4">
            <div className="flex items-center justify-between">
              <FileSpreadsheet size={22} className="text-sky-200/65" />
              <span className="text-[10px] font-mono text-white/25">0{index + 1}</span>
            </div>
            <p className="mt-5 text-sm font-semibold leading-5 text-white/72">{item}</p>
            <p className="mt-2 text-[11px] text-sky-100/40">{module.reviewPending}</p>
          </article>
        ))}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {module.checks.map(item => <div key={item} className="flex gap-2 rounded-lg bg-white/[0.025] px-3 py-2 text-xs leading-5 text-white/48"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-sky-200/60" />{item}</div>)}
      </div>
    </section>
  );
}

export function FinanceWorkbench({
  lang,
  domain,
  initialWorkflowId,
  onOpenKnowledge,
  onOpenSkills,
}: FinanceWorkbenchProps) {
  const copy = financeWorkbenchCopy(lang);
  const scopeLabel = domain === 'work' ? copy.organizationScope : copy.personalScope;
  const selectedWorkflow = initialWorkflowId
    ? copy.workflows.find(workflow => workflow.id === initialWorkflowId) || null
    : null;
  const selectedModule = selectedWorkflow ? financeModuleCopy(lang, selectedWorkflow.id) : null;
  const presentation = selectedModule ? FINANCE_PRESENTATION[selectedModule.id] : DEFAULT_PRESENTATION;
  const PresentationIcon = presentation.icon;
  const [runtime, setRuntime] = useState<FinanceRuntimeState>({ status: 'checking', skills: {} });
  const [startingId, setStartingId] = useState('');
  const [lastTaskId, setLastTaskId] = useState('');
  const [executionResult, setExecutionResult] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState('');
  const [startError, setStartError] = useState('');
  const [taskBrief, setTaskBrief] = useState('');
  const [deliveryFields, setDeliveryFields] = useState<Record<string, string>>({});
  const [missingDeliveryFields, setMissingDeliveryFields] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    setTaskBrief('');
    setDeliveryFields({});
    setMissingDeliveryFields([]);
    setLastTaskId('');
    setExecutionResult('');
    setWorkflowStatus('');
    setStartError('');
  }, [initialWorkflowId]);

  const startWorkflow = async (workflow: { id: string; prompt: string; title: string; evidence: string }) => {
    if (startingId) return;
    const deliveryForm = financeDeliveryFormCopy(lang, workflow.id);
    const missingFields = deliveryForm?.fields
      .filter(field => field.required && !deliveryFields[field.name]?.trim())
      .map(field => field.name) || [];
    if (deliveryForm && missingFields.length) {
      setMissingDeliveryFields(missingFields);
      setStartError(deliveryForm.requiredHint);
      setWorkflowStatus('needs_input');
      return;
    }
    setStartingId(workflow.id);
    setExecutionResult('');
    setWorkflowStatus('creating');
    setStartError('');
    try {
      const deterministicInput = deliveryForm
        ? financeDeliveryInput(workflow.id, deliveryFields)
        : null;
      const sourceInput = [
        `${workflow.title}; evidence required: ${workflow.evidence}`,
        taskBrief.trim(),
        deterministicInput ? JSON.stringify(deterministicInput) : '',
      ].filter(Boolean).join('\n');
      const started = await startIndustryWorkflow({
        entryId: workflow.id,
        sourceInput,
        source: 'finance_workbench',
        idempotencyKey: await buildIndustryWorkflowIdempotencyKey({
          entryId: workflow.id,
          sourceInput,
          source: 'finance_workbench',
        }),
      });
      setLastTaskId(started.task.id);
      setWorkflowStatus('in_progress');
      const controller = new AbortController();
      abortRef.current = controller;
      if (workflow.id === 'tax-filing' || workflow.id === 'report-delivery') {
        const execution = await executeFinanceDeliveryWorkflow({
          taskId: started.task.id,
          financeInput: deterministicInput || {},
          signal: controller.signal,
        });
        setExecutionResult([
          execution.task.result || '',
          ...execution.artifacts.map(artifact => `${artifact.path}\nSHA-256 ${artifact.sha256}`),
        ].filter(Boolean).join('\n\n'));
        setWorkflowStatus(execution.status);
        return;
      }
      const execution = await executeIndustryWorkflow({
        taskId: started.task.id,
        prompt: `${started.handoffPrompt}\n\n${workflow.prompt}${taskBrief.trim() ? `\n\nUser brief:\n${taskBrief.trim()}` : ''}`,
        sourceInput,
        signal: controller.signal,
        onProgress: progress => {
          setExecutionResult(progress.text);
          setWorkflowStatus(progress.status);
        },
      });
      setExecutionResult(execution.text);
      setWorkflowStatus(execution.status);
    } catch (reason) {
      if ((reason as any)?.name !== 'AbortError') {
        setStartError(reason instanceof Error ? reason.message : String(reason));
        setWorkflowStatus('blocked');
      }
    } finally {
      abortRef.current = null;
      setStartingId('');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const [versionResult, skillsResult] = await Promise.allSettled([
        fetch('/api/version', { credentials: 'include', signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error(`version:${response.status}`);
          return response.json();
        }),
        fetch('/api/industry/workflows/contracts', { credentials: 'include', signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error(`skills:${response.status}`);
          return response.json();
        }),
      ]);
      if (controller.signal.aborted) return;

      const version = versionResult.status === 'fulfilled' ? versionResult.value : null;
      const skillList: FinanceSkillRuntime[] = skillsResult.status === 'fulfilled' && Array.isArray(skillsResult.value?.skills)
        ? skillsResult.value.skills
        : [];
      const skills = Object.fromEntries(skillList.map(skill => [skill.name, skill]));
      const hasAttention = skillsResult.status !== 'fulfilled' || !skillsResult.value?.contracts?.some((item: any) => item.productLine === 'finance');
      setRuntime({
        status: version && !hasAttention ? 'ready' : 'attention',
        version: version?.version,
        variantId: version?.variant?.variantId,
        skills,
      });
    };
    void load().catch(() => {
      if (!controller.signal.aborted) setRuntime({ status: 'attention', skills: {} });
    });
    return () => controller.abort();
  }, []);

  const runtimeLabel = runtime.status === 'checking'
    ? copy.checking
    : runtime.status === 'ready'
      ? copy.ready
      : copy.runtimeAttention;
  const deliveryForm = selectedModule ? financeDeliveryFormCopy(lang, selectedModule.id) : null;
  return (
    <div className={`min-h-full text-white transition-colors duration-300 ${presentation.shell}`} data-finance-workspace={selectedModule?.id || 'overview'}>
      <div className={`border-b px-5 py-5 sm:px-7 ${presentation.header}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/60">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${presentation.badge}`}>
                <PresentationIcon size={13} />
                {runtimeLabel}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-white/50">
                {scopeLabel}
              </span>
              {runtime.version && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-white/50">
                  v{runtime.version}{runtime.variantId ? ` · ${runtime.variantId}` : ''}
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{selectedModule?.title || copy.title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">{selectedModule?.description || copy.subtitle}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenKnowledge}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Database size={14} />
              {copy.sourceFiles}
            </button>
            <button
              type="button"
              onClick={onOpenSkills}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-100 transition-colors hover:bg-emerald-300/20"
            >
              <Wrench size={14} />
              {copy.manageSkills}
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-7 p-5 sm:p-7">
        {selectedWorkflow && selectedModule ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200/55">{selectedModule.eyebrow}</p>
                <p className="mt-1 text-xs text-white/38"><span className="font-semibold text-white/52">{copy.evidenceLabel}: </span>{selectedWorkflow.evidence}</p>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] text-white/52 ${presentation.evidence}`}>
                <Layers3 size={13} />{scopeLabel}
              </span>
            </div>

            <ModuleVisualization module={selectedModule} />

            {selectedModule.id !== 'accounting' && selectedModule.id !== 'invoice-tax' && (
              <section className="grid gap-3 lg:grid-cols-2">
                <article className="rounded-2xl border border-white/8 bg-[#0b1713] p-5">
                  <ModuleHeading icon={<Database size={17} />} title={selectedModule.inputTitle} />
                  <ul className="mt-4 space-y-2.5">
                    {selectedModule.inputs.map(item => <li key={item} className="flex gap-2.5 text-xs leading-5 text-white/52"><CircleDashed size={14} className="mt-0.5 shrink-0 text-emerald-200/45" />{item}</li>)}
                  </ul>
                </article>
                <article className="rounded-2xl border border-white/8 bg-[#0b1713] p-5">
                  <ModuleHeading icon={<ListChecks size={17} />} title={selectedModule.reviewTitle} />
                  <ul className="mt-4 space-y-2.5">
                    {selectedModule.checks.map(item => <li key={item} className="flex gap-2.5 text-xs leading-5 text-white/52"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-amber-200/55" />{item}</li>)}
                  </ul>
                </article>
              </section>
            )}

            <section className={`rounded-2xl border p-5 ${presentation.task}`}>
              <ModuleHeading icon={<WalletCards size={17} />} title={selectedModule.taskTitle} />
              <p className="mt-2 text-xs leading-5 text-white/42">{selectedModule.taskHint}</p>
              {deliveryForm && (
                <div className="mt-4 rounded-xl border border-emerald-300/12 bg-black/15 p-4">
                  <p className="text-sm font-semibold text-white/78">{deliveryForm.title}</p>
                  <p className="mt-1 text-xs leading-5 text-white/42">{deliveryForm.hint}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {deliveryForm.fields.map(field => {
                      const missing = missingDeliveryFields.includes(field.name);
                      const common = {
                        value: deliveryFields[field.name] || '',
                        placeholder: field.placeholder,
                        'aria-invalid': missing,
                        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                          setDeliveryFields(current => ({ ...current, [field.name]: event.target.value }));
                          setMissingDeliveryFields(current => current.filter(name => name !== field.name));
                          setStartError('');
                          setLastTaskId('');
                          setExecutionResult('');
                          setWorkflowStatus('');
                        },
                        disabled: Boolean(startingId),
                        className: `mt-1.5 w-full rounded-lg border bg-black/20 px-3 py-2 text-xs leading-5 text-white/78 outline-none placeholder:text-white/22 disabled:cursor-not-allowed disabled:opacity-55 ${missing ? 'border-rose-300/55' : 'border-white/10 focus:border-emerald-300/30'}`,
                      };
                      return (
                        <label key={field.name} className={field.multiline ? 'sm:col-span-2' : ''}>
                          <span className="text-[11px] font-semibold text-white/52">{field.label}{field.required ? ' *' : ''}</span>
                          {field.multiline
                            ? <textarea {...common} rows={3} />
                            : <input {...common} type="text" />}
                        </label>
                      );
                    })}
                  </div>
                  {missingDeliveryFields.length > 0 && (
                    <p className="mt-3 text-xs font-semibold text-rose-200/75">{deliveryForm.requiredHint}</p>
                  )}
                </div>
              )}
              {!deliveryForm && (
                <textarea
                  value={taskBrief}
                  onChange={event => { setTaskBrief(event.target.value); setLastTaskId(''); setExecutionResult(''); setWorkflowStatus(''); }}
                  disabled={Boolean(startingId)}
                  placeholder={selectedModule.taskPlaceholder}
                  rows={4}
                  className="mt-4 w-full resize-y rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-white/78 outline-none transition-colors placeholder:text-white/25 focus:border-emerald-300/30 disabled:cursor-not-allowed disabled:opacity-55"
                />
              )}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  {lastTaskId && <p className="text-[11px] font-mono text-emerald-100/45">task {lastTaskId}</p>}
                  {startError && <p className="text-xs font-semibold text-rose-200/75">{startError}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {startingId === selectedWorkflow.id && (
                    <button type="button" onClick={() => abortRef.current?.abort()} className="inline-flex items-center justify-center rounded-xl border border-rose-300/15 bg-rose-300/[0.06] px-4 py-3 text-xs font-semibold text-rose-100/65 transition-colors hover:bg-rose-300/10">
                      {selectedModule.stopLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={Boolean(startingId)}
                    onClick={() => void startWorkflow(selectedWorkflow)}
                    className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${presentation.primary}`}
                  >
                    {startingId === selectedWorkflow.id ? copy.checking : selectedModule.startLabel}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </section>

            {(startingId || executionResult || lastTaskId) && (
              <section className={`rounded-2xl border p-5 ${presentation.result}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <ModuleHeading icon={<CheckCircle2 size={17} />} title={selectedModule.executionTitle} />
                  <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-1 text-[10px] font-mono text-white/42">{workflowStatus || 'in_progress'}</span>
                </div>
                <div className="mt-4 min-h-20 whitespace-pre-wrap rounded-xl border border-white/7 bg-black/20 p-4 text-sm leading-6 text-white/65">
                  {executionResult || (startingId ? selectedModule.executionRunning : selectedModule.executionWaiting)}
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            <section>
              <div className="mb-4">
                <h2 className="text-base font-semibold text-white">{copy.workflowTitle}</h2>
                <p className="mt-1 text-xs leading-5 text-white/42">{copy.workflowSubtitle}</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {copy.workflows.map((workflow, index) => {
                  const Icon = WORKFLOW_ICONS[index] || FileSpreadsheet;
                  return (
                    <article key={workflow.id} className="rounded-2xl border border-white/8 bg-[#0b1713] p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-300/15 bg-emerald-300/8 text-emerald-200"><Icon size={18} /></div>
                        <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-white/90">{workflow.title}</h3><p className="mt-1 text-xs leading-5 text-white/45">{workflow.description}</p></div>
                      </div>
                      <p className="mt-4 border-t border-white/6 pt-3 text-[11px] text-white/35"><span className="font-semibold text-white/48">{copy.evidenceLabel}: </span>{workflow.evidence}</p>
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
              <div className="rounded-2xl border border-cyan-300/12 bg-cyan-300/[0.035] p-5">
                <ModuleHeading icon={<LineChart size={18} />} title={copy.marketTitle} />
                <p className="mt-2 text-xs leading-5 text-white/45">{copy.marketDescription}</p>
                <ul className="mt-4 space-y-2">{copy.marketRules.map(rule => <li key={rule} className="flex gap-2 text-xs leading-5 text-white/48"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-cyan-300/70" />{rule}</li>)}</ul>
              </div>
              <div className="rounded-2xl border border-amber-300/12 bg-amber-300/[0.035] p-5">
                <ModuleHeading icon={<ShieldCheck size={18} />} title={copy.safetyTitle} />
                <p className="mt-3 text-xs leading-6 text-white/48">{copy.safetyDescription}</p>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
