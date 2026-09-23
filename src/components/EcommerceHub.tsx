import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Download,
  FileDown,
  FileSpreadsheet,
  MessageSquare,
  PackageCheck,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  analyzeEcommerceWorkbench,
  getEcommerceFieldDefinitions,
  normalizeReviewSourceRecords,
  normalizedReviewsToTable,
  parseDelimitedReport,
  suggestEcommerceColumnMapping,
  tableFromMatrix,
  type EcommerceColumnMapping,
  type EcommerceReportKind,
  type EcommerceRisk,
  type EcommerceTable,
  type EcommerceWorkbenchSnapshot,
} from '../../shared/ecommerce_workbench';
import {
  buildEcommerceTemplateCsv,
  ECOMMERCE_PLATFORM_PRESETS,
  type EcommercePlatformId,
} from '../../shared/ecommerce_platform_presets';
import { ecommerceWorkbenchCopy } from '../i18n/locales/ecommerceWorkbench';
import { startIndustryWorkflow, verifyIndustryWorkflow } from '../lib/industryWorkflowClient';

const REPORT_KINDS: EcommerceReportKind[] = ['orders', 'campaigns', 'inventory', 'afterSales', 'reviews'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type HubCopy = (typeof ecommerceWorkbenchCopy)[keyof typeof ecommerceWorkbenchCopy];

function formatMoney(value: number, lang: 'en' | 'zh'): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value: number, lang: 'en' | 'zh', maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits }).format(value || 0);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sourceBaseName(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().split(/[\\/]/).pop() || '';
}

function worksheetMatrix(worksheet: any): Array<Array<string | number>> {
  const matrix: Array<Array<string | number>> = [];
  const columnCount = Math.max(Number(worksheet.actualColumnCount || 0), Number(worksheet.columnCount || 0));
  worksheet.eachRow({ includeEmpty: false }, (row: any) => {
    const values: Array<string | number> = [];
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = row.getCell(column);
      if (typeof cell.value === 'number') values.push(cell.value);
      else values.push(String(cell.text ?? cell.value ?? '').trim());
    }
    matrix.push(values);
  });
  return matrix;
}

function normalizeReviewTable(table: EcommerceTable): EcommerceTable {
  const normalized = normalizeReviewSourceRecords({
    sourceText: JSON.stringify(table.rows),
    sourceFormat: 'json',
  });
  return normalizedReviewsToTable(normalized.records);
}

async function readReportFile(file: File, kind: EcommerceReportKind): Promise<EcommerceTable> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'xlsx') {
    const module = await import('exceljs/dist/exceljs.min.js');
    const workbook = new module.default.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets.find((candidate: any) => Number(candidate.actualRowCount || 0) > 1);
    if (!worksheet) throw new Error('NO_WORKSHEET');
    const table = tableFromMatrix(worksheetMatrix(worksheet));
    return kind === 'reviews' ? normalizeReviewTable(table) : table;
  }
  const textExtensions = kind === 'reviews' ? ['csv', 'tsv', 'txt', 'json', 'jsonl'] : ['csv', 'tsv', 'txt'];
  if (!textExtensions.includes(extension || '')) throw new Error('UNSUPPORTED');
  const text = await file.text();
  if (kind !== 'reviews') return parseDelimitedReport(text);
  const sourceFormat = extension === 'json' || extension === 'jsonl' ? extension : 'auto';
  const normalized = normalizeReviewSourceRecords({ sourceText: text, sourceFormat });
  return normalizedReviewsToTable(normalized.records);
}

function riskValue(risk: EcommerceRisk, lang: 'en' | 'zh'): string {
  if (risk.code === 'high_ad_cost' || risk.code === 'high_refund' || risk.code === 'negative_reviews') return `${formatNumber(risk.value, lang)}%`;
  if (risk.code === 'low_roas') return `${formatNumber(risk.value, lang)}x`;
  return formatNumber(risk.value, lang, 0);
}

function MetricCard({
  label,
  value,
  tone = 'cyan',
}: {
  label: string;
  value: string;
  tone?: 'cyan' | 'emerald' | 'amber' | 'rose';
}) {
  const tones = {
    cyan: 'from-cyan-400/18 to-blue-500/5 border-cyan-300/15 text-cyan-100',
    emerald: 'from-emerald-400/18 to-teal-500/5 border-emerald-300/15 text-emerald-100',
    amber: 'from-amber-400/18 to-orange-500/5 border-amber-300/15 text-amber-100',
    rose: 'from-rose-400/18 to-red-500/5 border-rose-300/15 text-rose-100',
  };
  return (
    <div className={`rounded-2xl border bg-gradient-to-br p-4 ${tones[tone]}`}>
      <div className="text-xs font-bold uppercase tracking-[0.16em] text-white/40">{label}</div>
      <div className="mt-2 truncate text-2xl font-black tabular-nums tracking-tight">{value}</div>
    </div>
  );
}

function SourceBadge({
  kind,
  fileName,
  rowCount,
  mappedCount,
  missingFields,
  table,
  mapping,
  copy,
  onRemove,
  onMappingChange,
}: {
  kind: EcommerceReportKind;
  fileName: string;
  rowCount: number;
  mappedCount: number;
  missingFields: string[];
  table: EcommerceTable;
  mapping: EcommerceColumnMapping;
  copy: HubCopy;
  onRemove: () => void;
  onMappingChange: (field: string, column: string) => void;
}) {
  const fields = getEcommerceFieldDefinitions(kind);
  const fieldLabel = (field: string) => (copy.fieldLabels as Record<string, string>)[field] || field;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-cyan-400/10 p-2 text-cyan-200"><FileSpreadsheet size={15} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black text-white/80">{copy.reportTypes[kind]}</span>
            <span className="truncate text-xs text-white/35">{fileName}</span>
          </div>
          <div className="mt-1 text-xs text-white/40">{rowCount} {copy.rows} · {mappedCount} {copy.mapped}</div>
          {missingFields.length > 0 && (
            <div className="mt-1 truncate text-xs text-amber-200/65" title={missingFields.join(', ')}>
              {copy.missingRecommended}: {missingFields.map(fieldLabel).join(', ')}
            </div>
          )}
        </div>
        <button type="button" onClick={onRemove} className="rounded-lg p-1.5 text-white/30 transition-colors hover:bg-white/10 hover:text-rose-200" title={copy.remove}>
          <Trash2 size={14} />
        </button>
      </div>
      <details className="mt-2 border-t border-white/[0.07] pt-2">
        <summary className="cursor-pointer select-none text-xs font-bold text-cyan-100/55 hover:text-cyan-100">
          {copy.fieldMapping}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-white/30">{copy.fieldMappingHint}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {fields.map(definition => (
            <label key={definition.field} className="min-w-0">
              <span className="mb-1 block truncate text-xs text-white/40">
                {fieldLabel(definition.field)}{definition.recommended ? ` · ${copy.recommended}` : ''}
              </span>
              <select
                value={mapping[definition.field] || ''}
                onChange={event => onMappingChange(definition.field, event.target.value)}
                className="h-8 w-full rounded-lg border border-white/10 bg-[#0b1116] px-2 text-xs text-white/65 outline-none focus:border-cyan-300/25"
              >
                <option value="">{copy.unmapped}</option>
                {table.headers.map(header => <option key={header} value={header}>{header}</option>)}
              </select>
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export function EcommerceHub({
  lang,
  initialReportKind = 'orders',
  workflowEntryId = 'store-data',
  onSnapshotChange,
}: {
  lang: 'en' | 'zh';
  initialReportKind?: EcommerceReportKind;
  workflowEntryId?: 'today-operations' | 'store-data';
  onSnapshotChange?: (snapshot: EcommerceWorkbenchSnapshot | null) => void;
}) {
  const copy = ecommerceWorkbenchCopy[lang];
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<EcommerceReportKind>(initialReportKind);
  const [selectedPlatform, setSelectedPlatform] = useState<EcommercePlatformId>('generic');
  const [reports, setReports] = useState<Partial<Record<EcommerceReportKind, EcommerceTable>>>({});
  const [sourceNames, setSourceNames] = useState<Partial<Record<EcommerceReportKind, string>>>({});
  const [columnMappings, setColumnMappings] = useState<Partial<Record<EcommerceReportKind, EcommerceColumnMapping>>>({});
  const [grossMarginPercent, setGrossMarginPercent] = useState(35);
  const [targetStockDays, setTargetStockDays] = useState(30);
  const [pasteValue, setPasteValue] = useState('');
  const [processing, setProcessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveTaskId, setArchiveTaskId] = useState('');
  const snapshot = useMemo(() => analyzeEcommerceWorkbench(reports, {
    grossMarginRate: grossMarginPercent / 100,
    targetStockDays,
    columnMappings,
  }), [columnMappings, grossMarginPercent, reports, targetStockDays]);
  const hasData = snapshot.sources.length > 0;

  useEffect(() => {
    setSelectedKind(initialReportKind);
  }, [initialReportKind]);

  useEffect(() => {
    onSnapshotChange?.(hasData ? snapshot : null);
  }, [hasData, onSnapshotChange, snapshot]);

  const setReport = (kind: EcommerceReportKind, table: EcommerceTable, sourceName: string) => {
    setReports(current => ({ ...current, [kind]: table }));
    setSourceNames(current => ({ ...current, [kind]: sourceName }));
    setColumnMappings(current => ({ ...current, [kind]: suggestEcommerceColumnMapping(kind, table) }));
    toast.success(`${copy.importSuccess}: ${copy.reportTypes[kind]}`);
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error(copy.tooLarge);
      return;
    }
    setProcessing(true);
    try {
      setReport(selectedKind, await readReportFile(file, selectedKind), file.name);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      toast.error(code === 'UNSUPPORTED' ? copy.unsupported : code === 'NO_WORKSHEET' ? copy.noWorksheet : copy.invalidFile);
    } finally {
      setProcessing(false);
    }
  };

  const analyzePaste = () => {
    if (!pasteValue.trim()) {
      toast.error(copy.noPaste);
      return;
    }
    try {
      const table = selectedKind === 'reviews'
        ? normalizedReviewsToTable(normalizeReviewSourceRecords({ sourceText: pasteValue }).records)
        : parseDelimitedReport(pasteValue);
      setReport(selectedKind, table, copy.pastedData);
      setPasteValue('');
    } catch {
      toast.error(copy.invalidFile);
    }
  };

  const removeReport = (kind: EcommerceReportKind) => {
    setReports(current => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    setSourceNames(current => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    setColumnMappings(current => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
  };

  const clearReports = () => {
    setReports({});
    setSourceNames({});
    setColumnMappings({});
    setPasteValue('');
  };

  const changeMapping = (kind: EcommerceReportKind, field: string, column: string) => {
    setColumnMappings(current => ({
      ...current,
      [kind]: { ...(current[kind] || {}), [field]: column },
    }));
  };

  const downloadTemplate = () => {
    const blob = new Blob([buildEcommerceTemplateCsv(selectedPlatform, selectedKind)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lumi-${selectedPlatform}-${selectedKind}-template.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const diagnosisCsv = () => {
    const lines: unknown[][] = [
      ['section', 'item', 'value', 'details'],
      ['metric', 'gmv', snapshot.metrics.gmv, 'CNY'],
      ['metric', 'net_revenue', snapshot.metrics.netRevenue, 'CNY'],
      ['metric', 'contribution_profit', snapshot.metrics.contributionProfit, 'CNY'],
      ['metric', 'contribution_margin', snapshot.metrics.contributionMargin, '%'],
      ['metric', 'roas', snapshot.metrics.roas, 'x'],
      ['metric', 'refund_rate', snapshot.metrics.refundRate, '%'],
      ...snapshot.risks.map(risk => ['risk', risk.code, risk.value, risk.items.join(' | ')]),
      ...snapshot.topSkus.map(item => ['sku', item.sku, item.contributionProfit, `revenue=${item.revenue}; margin=${item.contributionMargin}%`]),
      ...snapshot.inventoryAlerts.map(item => ['inventory', item.sku, item.suggestedOrderQty, `stock=${item.stock}; days_cover=${item.daysCover ?? ''}`]),
      ...snapshot.reviewInsights.topics.map(item => ['review_topic', item.topic, item.negativeCount, `mentions=${item.count}; negative_rate=${item.negativeRate}%`]),
      ...snapshot.reviewInsights.negativeSamples.map(item => ['negative_review', item.sku, item.rating ?? '', `${item.topic}; ${item.content}`]),
    ];
    return `\uFEFF${lines.map(line => line.map(csvCell).join(',')).join('\r\n')}`;
  };

  const archiveDiagnosis = async () => {
    if (!hasData || archiving) return;
    setArchiving(true);
    try {
      const archiveSourceNames = Object.fromEntries(
        Object.entries(sourceNames)
          .map(([kind, name]) => [kind, sourceBaseName(name)] as const)
          .filter(([, name]) => Boolean(name)),
      );
      const archiveTopics = snapshot.reviewInsights.topics.map(topic => ({
        topic: topic.topic,
        count: topic.count,
        negativeCount: topic.negativeCount,
        negativeRate: topic.negativeRate,
      }));
      const workflow = await startIndustryWorkflow({
        entryId: workflowEntryId,
        sourceInput: JSON.stringify({
          platform: selectedPlatform,
          sourceNames: archiveSourceNames,
          sourceRows: snapshot.sources.map(source => ({ kind: source.kind, rowCount: source.rowCount })),
          grossMarginPercent,
          targetStockDays,
        }),
        source: 'ecommerce_data_workbench',
      });
      const archived = await verifyIndustryWorkflow({
        taskId: workflow.task.id,
        workbenchInput: {
          reports,
          columnMappings,
          platform: selectedPlatform,
          sourceNames: archiveSourceNames,
          grossMarginPercent,
          targetStockDays,
          snapshot: {
            sources: snapshot.sources,
            metrics: snapshot.metrics,
            risks: snapshot.risks,
            topSkus: snapshot.topSkus,
            campaigns: snapshot.campaigns,
            inventoryAlerts: snapshot.inventoryAlerts,
            reviewInsights: {
              totalReviews: snapshot.reviewInsights.totalReviews,
              averageRating: snapshot.reviewInsights.averageRating,
              positiveRate: snapshot.reviewInsights.positiveRate,
              negativeRate: snapshot.reviewInsights.negativeRate,
              topics: archiveTopics,
            },
          },
        },
        source: 'ecommerce_data_workbench',
      });
      setArchiveTaskId(workflow.task.id);
      // i18n-allow: Short bilingual operational feedback local to the ecommerce variant.
      if (archived.verification?.passed) toast.success(lang === 'zh' ? '经营诊断已核验并归档' : 'Diagnosis verified and archived');
      // i18n-allow: Short bilingual operational feedback local to the ecommerce variant.
      else toast.warning(lang === 'zh' ? '经营诊断已归档，仍需复核' : 'Diagnosis archived for review');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchiving(false);
    }
  };

  const exportDiagnosis = () => {
    const blob = new Blob([diagnosisCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lumi-ecommerce-diagnosis-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(copy.exported);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.09),transparent_32%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.08),transparent_28%)] text-white">
      <input ref={inputRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl" className="hidden" onChange={handleFile} />
      <div className="mx-auto flex min-h-full max-w-[1320px] flex-col gap-5 p-5 sm:p-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-cyan-300/20 to-emerald-400/10 p-3 text-cyan-100 shadow-lg shadow-cyan-950/20">
              <ShoppingBag size={25} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-white sm:text-2xl">{copy.title}</h1>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2 py-1 text-xs font-bold text-emerald-200">
                  <ShieldCheck size={12} /> {copy.readOnly}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/45">{copy.subtitle}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-cyan-100/45"><CheckCircle2 size={12} /> {copy.localOnly}</p>
            </div>
          </div>
          {hasData && (
            <div className="flex items-center gap-2">
              <button type="button" disabled={archiving} onClick={() => void archiveDiagnosis()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 text-xs font-black text-emerald-100 transition-colors hover:bg-emerald-300/20 disabled:opacity-50">
                {/* i18n-allow: Compact bilingual action copy local to the ecommerce variant. */}
                <PackageCheck size={14} /> {archiving ? (lang === 'zh' ? '归档中…' : 'Archiving…') : (lang === 'zh' ? '核验归档' : 'Verify & archive')}
              </button>
              <button type="button" onClick={exportDiagnosis} className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 text-xs font-black text-cyan-100 transition-colors hover:bg-cyan-300/20">
                <Download size={14} /> {copy.export}
              </button>
              <button type="button" onClick={clearReports} className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-black text-white/45 transition-colors hover:bg-white/10 hover:text-white">
                <Trash2 size={14} /> {copy.clear}
              </button>
            </div>
          )}
          {archiveTaskId && <div className="-mt-3 text-right text-[11px] font-mono text-emerald-200/35">archive {archiveTaskId}</div>}
        </header>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <MetricCard label={copy.metrics.gmv} value={hasData ? formatMoney(snapshot.metrics.gmv, lang) : '—'} />
          <MetricCard label={copy.metrics.netRevenue} value={hasData ? formatMoney(snapshot.metrics.netRevenue, lang) : '—'} tone="emerald" />
          <MetricCard label={copy.metrics.profit} value={hasData ? formatMoney(snapshot.metrics.contributionProfit, lang) : '—'} tone={snapshot.metrics.contributionProfit < 0 ? 'rose' : 'emerald'} />
          <MetricCard label={copy.metrics.margin} value={hasData ? `${formatNumber(snapshot.metrics.contributionMargin, lang)}%` : '—'} tone={snapshot.metrics.contributionMargin < 0 ? 'rose' : 'cyan'} />
          <MetricCard label={copy.metrics.roas} value={hasData && snapshot.metrics.adSpend > 0 ? `${formatNumber(snapshot.metrics.roas, lang)}x` : '—'} tone="amber" />
          <MetricCard label={copy.metrics.refundRate} value={hasData ? `${formatNumber(snapshot.metrics.refundRate, lang)}%` : '—'} tone={snapshot.metrics.refundRate >= 10 ? 'rose' : 'amber'} />
        </section>

        <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
          <div className="space-y-4 rounded-2xl border border-white/10 bg-black/20 p-4 backdrop-blur-xl">
            <div>
              <h2 className="text-sm font-black text-white/85">{copy.importTitle}</h2>
              <p className="mt-1 text-xs leading-relaxed text-white/40">{copy.importDescription}</p>
            </div>
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-white/35">{copy.platform}</span>
              <select
                value={selectedPlatform}
                onChange={event => setSelectedPlatform(event.target.value as EcommercePlatformId)}
                className="h-10 w-full rounded-xl border border-white/10 bg-[#0b1116] px-3 text-xs font-bold text-white/65 outline-none focus:border-cyan-300/25"
              >
                {ECOMMERCE_PLATFORM_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </label>
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/35">{copy.selectType}</div>
              <div className="grid grid-cols-2 gap-2">
                {REPORT_KINDS.map(kind => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setSelectedKind(kind)}
                    className={`rounded-xl border px-3 py-2.5 text-left text-xs font-bold transition-colors ${selectedKind === kind ? 'border-cyan-300/30 bg-cyan-300/12 text-cyan-100' : 'border-white/8 bg-white/[0.035] text-white/45 hover:bg-white/[0.07] hover:text-white/75'}`}
                  >
                    {copy.reportTypes[kind]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-white/35">{copy.reportHints[selectedKind]}</p>
            </div>
            <div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => inputRef.current?.click()}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-cyan-300/25 bg-cyan-300/[0.07] px-2 text-xs font-black text-cyan-100 transition-colors hover:bg-cyan-300/15 disabled:opacity-50"
                >
                  <Upload size={15} /> {processing ? copy.processing : reports[selectedKind] ? copy.replace : copy.upload}
                </button>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.045] px-2 text-xs font-black text-white/55 transition-colors hover:bg-white/[0.09] hover:text-white"
                >
                  <FileDown size={15} /> {copy.downloadTemplate}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-white/30">{copy.templateNote}</p>
            </div>
            <div>
              <div className="mb-2 text-xs font-bold text-white/35">{copy.pasteLabel}</div>
              <textarea
                value={pasteValue}
                onChange={event => setPasteValue(event.target.value)}
                placeholder={selectedKind === 'reviews' ? copy.reviewPastePlaceholder : copy.pastePlaceholder}
                className="h-24 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs leading-relaxed text-white/70 outline-none placeholder:text-white/20 focus:border-cyan-300/25"
              />
              <button type="button" onClick={analyzePaste} className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-white/[0.07] text-xs font-black text-white/65 transition-colors hover:bg-white/[0.12] hover:text-white">
                <BarChart3 size={14} /> {copy.analyzePaste}
              </button>
            </div>
            <details className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-black text-white/55 hover:text-white/80">
                <SlidersHorizontal size={14} /> {copy.calculationSettings}
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label>
                  <span className="mb-1 block text-xs text-white/35">{copy.grossMarginRate}</span>
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={grossMarginPercent}
                      onChange={event => setGrossMarginPercent(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
                      className="h-8 min-w-0 flex-1 bg-transparent text-xs text-white/65 outline-none"
                    />
                    <span className="text-xs text-white/30">%</span>
                  </div>
                </label>
                <label>
                  <span className="mb-1 block text-xs text-white/35">{copy.targetStockDays}</span>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    step="1"
                    value={targetStockDays}
                    onChange={event => setTargetStockDays(Math.min(365, Math.max(1, Number(event.target.value) || 1)))}
                    className="h-8 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-xs text-white/65 outline-none focus:border-cyan-300/25"
                  />
                </label>
              </div>
            </details>
            {snapshot.sources.length > 0 && (
              <div className="space-y-2 border-t border-white/8 pt-4">
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-white/35">{copy.imported}</div>
                {snapshot.sources.map(source => (
                  <SourceBadge
                    key={source.kind}
                    kind={source.kind}
                    fileName={sourceNames[source.kind] || ''}
                    rowCount={source.rowCount}
                    mappedCount={source.mappedFields.length}
                    missingFields={source.missingRecommendedFields}
                    table={reports[source.kind]!}
                    mapping={columnMappings[source.kind] || {}}
                    copy={copy}
                    onRemove={() => removeReport(source.kind)}
                    onMappingChange={(field, column) => changeMapping(source.kind, field, column)}
                  />
                ))}
              </div>
            )}
          </div>

          {!hasData ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-8 text-center">
              <div className="rounded-3xl border border-cyan-300/15 bg-cyan-300/[0.07] p-5 text-cyan-200"><FileSpreadsheet size={36} /></div>
              <h2 className="mt-5 text-lg font-black text-white/80">{copy.emptyTitle}</h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-white/40">{copy.emptyDescription}</p>
            </div>
          ) : (
            <div className="min-w-0 space-y-5">
              <section className="rounded-2xl border border-white/10 bg-black/20 p-4 backdrop-blur-xl">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-sm font-black text-white/85"><AlertTriangle size={16} className="text-amber-300" /> {copy.riskTitle}</h2>
                  <span className="text-xs text-white/30">{snapshot.risks.length}</span>
                </div>
                {snapshot.risks.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-xl border border-emerald-300/10 bg-emerald-300/[0.06] px-3 py-3 text-xs text-emerald-100/70"><CheckCircle2 size={15} /> {copy.noRisks}</div>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {snapshot.risks.map(risk => {
                      const riskItems = risk.code === 'negative_reviews'
                        ? risk.items.map(item => copy.topicLabels[item as keyof typeof copy.topicLabels] || item)
                        : risk.items;
                      return (
                        <div key={risk.code} className={`rounded-xl border p-3 ${risk.severity === 'high' ? 'border-rose-300/15 bg-rose-400/[0.07]' : 'border-amber-300/15 bg-amber-400/[0.07]'}`}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs font-black text-white/75">{copy.riskLabels[risk.code]}</div>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-black ${risk.severity === 'high' ? 'bg-rose-400/15 text-rose-200' : 'bg-amber-400/15 text-amber-200'}`}>{riskValue(risk, lang)}</span>
                          </div>
                          {riskItems.length > 0 && <div className="mt-2 truncate text-xs text-white/35" title={riskItems.join(', ')}>{riskItems.join(' · ')}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {snapshot.reviewInsights.totalReviews > 0 && (
                <section className="overflow-hidden rounded-2xl border border-white/10 bg-black/20 backdrop-blur-xl">
                  <div className="flex items-start justify-between gap-3 border-b border-white/8 px-4 py-3">
                    <div>
                      <h2 className="flex items-center gap-2 text-sm font-black text-white/85"><MessageSquare size={15} className="text-cyan-200/70" /> {copy.reviewTitle}</h2>
                      <p className="mt-1 text-xs leading-relaxed text-white/35">{copy.reviewDescription}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-b border-white/8 p-4 sm:grid-cols-4">
                    {[
                      [copy.reviewMetrics.total, formatNumber(snapshot.reviewInsights.totalReviews, lang, 0), 'text-cyan-100'],
                      [copy.reviewMetrics.averageRating, snapshot.reviewInsights.averageRating === null ? '—' : `${formatNumber(snapshot.reviewInsights.averageRating, lang)} / 5`, 'text-amber-100'],
                      [copy.reviewMetrics.positiveRate, `${formatNumber(snapshot.reviewInsights.positiveRate, lang)}%`, 'text-emerald-200'],
                      [copy.reviewMetrics.negativeRate, `${formatNumber(snapshot.reviewInsights.negativeRate, lang)}%`, snapshot.reviewInsights.negativeRate >= 20 ? 'text-rose-200' : 'text-white/75'],
                    ].map(([label, value, tone]) => (
                      <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                        <div className="text-xs font-bold text-white/35">{label}</div>
                        <div className={`mt-1 text-lg font-black tabular-nums ${tone}`}>{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid lg:grid-cols-2">
                    <div className="border-b border-white/8 p-4 lg:border-b-0 lg:border-r">
                      <h3 className="mb-3 text-xs font-black uppercase tracking-[0.12em] text-white/45">{copy.reviewTopics}</h3>
                      <div className="space-y-3">
                        {snapshot.reviewInsights.topics.slice(0, 8).map(item => (
                          <div key={item.topic}>
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="font-bold text-white/70">{copy.topicLabels[item.topic]}</span>
                              <span className="text-white/35">{item.count} {copy.topicReviews} · {item.negativeCount} {copy.topicNegative}</span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                              <div className="h-full rounded-full bg-gradient-to-r from-amber-400/70 to-rose-400/80" style={{ width: `${Math.max(item.negativeRate, item.negativeCount > 0 ? 4 : 0)}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="p-4">
                      <h3 className="mb-3 text-xs font-black uppercase tracking-[0.12em] text-white/45">{copy.negativeSamples}</h3>
                      {snapshot.reviewInsights.negativeSamples.length === 0 ? (
                        <div className="rounded-xl border border-emerald-300/10 bg-emerald-300/[0.05] px-3 py-3 text-xs text-emerald-100/60">{copy.noNegativeSamples}</div>
                      ) : (
                        <div className="max-h-64 space-y-2 overflow-auto pr-1">
                          {snapshot.reviewInsights.negativeSamples.map((item, index) => (
                            <div key={`${item.sku}-${index}`} className="rounded-xl border border-rose-300/10 bg-rose-400/[0.045] p-3">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="font-black text-white/70">{item.sku}</span>
                                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-white/40">{item.rating === null ? copy.unrated : `${formatNumber(item.rating, lang)} ★`}</span>
                                <span className="rounded-full bg-rose-400/10 px-2 py-0.5 text-rose-200/75">{copy.topicLabels[item.topic]}</span>
                              </div>
                              <p className="mt-2 break-words text-xs leading-relaxed text-white/50">{item.content}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {snapshot.topSkus.length > 0 && (
                <section className="overflow-hidden rounded-2xl border border-white/10 bg-black/20 backdrop-blur-xl">
                  <div className="flex items-center justify-between border-b border-white/8 px-4 py-3"><h2 className="text-sm font-black text-white/85">{copy.skuTitle}</h2><ShoppingBag size={15} className="text-cyan-200/60" /></div>
                  <div className="max-h-60 overflow-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-[#0b1116] text-white/35"><tr><th className="px-4 py-2 font-bold">{copy.sku}</th><th className="px-3 py-2 text-right font-bold">{copy.revenue}</th><th className="px-3 py-2 text-right font-bold">{copy.profit}</th><th className="px-4 py-2 text-right font-bold">{copy.margin}</th></tr></thead>
                      <tbody className="divide-y divide-white/[0.055]">
                        {snapshot.topSkus.map(item => <tr key={item.sku} className="text-white/60 hover:bg-white/[0.025]"><td className="max-w-48 truncate px-4 py-2.5 font-bold text-white/75">{item.sku}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(item.revenue, lang)}</td><td className={`px-3 py-2.5 text-right tabular-nums ${item.contributionProfit < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{formatMoney(item.contributionProfit, lang)}</td><td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(item.contributionMargin, lang)}%</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <div className="grid gap-5 lg:grid-cols-2">
                {snapshot.campaigns.length > 0 && (
                  <section className="overflow-hidden rounded-2xl border border-white/10 bg-black/20 backdrop-blur-xl">
                    <div className="border-b border-white/8 px-4 py-3"><h2 className="text-sm font-black text-white/85">{copy.campaignTitle}</h2></div>
                    <div className="max-h-60 overflow-auto divide-y divide-white/[0.055]">
                      {snapshot.campaigns.map(item => (
                        <div key={item.campaign} className="flex items-center gap-3 px-4 py-3 text-xs">
                          <div className="min-w-0 flex-1"><div className="truncate font-bold text-white/75">{item.campaign}</div><div className="mt-1 text-white/35">{copy.spend} {formatMoney(item.spend, lang)} · ROAS {formatNumber(item.roas, lang)}x</div></div>
                          <span className={`rounded-full px-2 py-1 font-bold ${item.status === 'scale' ? 'bg-emerald-400/10 text-emerald-200' : item.status === 'fix' ? 'bg-rose-400/10 text-rose-200' : 'bg-amber-400/10 text-amber-200'}`}>{copy.statusLabels[item.status]}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {snapshot.inventoryAlerts.length > 0 && (
                  <section className="overflow-hidden rounded-2xl border border-white/10 bg-black/20 backdrop-blur-xl">
                    <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3"><PackageCheck size={15} className="text-emerald-200/70" /><h2 className="text-sm font-black text-white/85">{copy.inventoryTitle}</h2></div>
                    <div className="max-h-60 overflow-auto divide-y divide-white/[0.055]">
                      {snapshot.inventoryAlerts.map(item => (
                        <div key={item.sku} className="flex items-center gap-3 px-4 py-3 text-xs">
                          <div className="min-w-0 flex-1"><div className="truncate font-bold text-white/75">{item.sku}</div><div className="mt-1 text-white/35">{copy.stock} {formatNumber(item.stock, lang)} · {copy.daysCover} {formatNumber(item.daysCover || 0, lang)}</div></div>
                          <div className="text-right"><div className={item.status === 'urgent' ? 'font-black text-rose-200' : 'font-black text-amber-200'}>{copy.statusLabels[item.status]}</div><div className="mt-1 text-white/35">{copy.suggestedQty} {formatNumber(item.suggestedOrderQty, lang, 0)}</div></div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              <section className="rounded-2xl border border-white/8 bg-white/[0.025] px-4 py-3">
                <div className="text-xs font-black text-white/55">{copy.assumptions}</div>
                <p className="mt-1 text-xs leading-relaxed text-white/30">
                  {copy.grossMarginRate} {formatNumber(grossMarginPercent, lang)}% · {copy.targetStockDays} {formatNumber(targetStockDays, lang, 0)}. {copy.assumptionsDescription}
                </p>
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
