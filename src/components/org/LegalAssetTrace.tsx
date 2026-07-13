import React, { useEffect, useState } from 'react';
import { AlertCircle, Building2, FileText, FolderOpen, Loader2, Network, Search, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { getLegalCaseLabel, type LegalCaseFile, type LegalCaseMaterial } from '../../lib/legalCaseStore';
import { runLegalTool } from '../../lib/legalToolClient';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { uiMessage } from '../../i18n/uiMessages';
import { chinaLegalCopy } from '../../i18n/regions/cn/legal';

interface TraceResult {
  company?: string;
  legalPerson?: string;
  capital?: string;
  status?: string;
  establishDate?: string;
  shareholders?: { name: string; ratio: number }[];
  enforcements?: { caseNumber: string; court: string; target: string; date: string }[];
  risks?: { type: string; count: number }[];
  raw?: string;
}

function legalCaseTitle(caseFile?: LegalCaseFile | null): string {
  return getLegalCaseLabel(caseFile || null) || chinaLegalCopy().unnamedCase;
}

function assetTraceCaseArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return orgId ? { orgId } : {};
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || chinaLegalCopy().assetTraceCaseType,
    parties: caseFile.party || undefined,
    orgId,
    persistCase: true,
  };
}

export function LegalAssetTrace({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [name, setName] = useState(caseFile?.party || '');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'info' | 'enforcement' | 'equity' | 'raw'>('info');

  useEffect(() => {
    setName(caseFile?.party || '');
    setResult(null);
    setActiveTab('info');
  }, [caseFile?.id, caseFile?.party]);

  const trace = async () => {
    if (!name.trim() || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const commonArgs = assetTraceCaseArgs(caseFile, orgId);
      const assetText = await runLegalTool('legal_trace_assets', {
        ...commonArgs,
        name,
      });
      const equityText = await runLegalTool('legal_equity_penetration', {
        ...commonArgs,
        name,
      });
      const text = [assetText, equityText].filter(Boolean).join('\n\n---\n\n');
      const parsed = parseTraceResult(text);
      setResult(parsed);
      setActiveTab(parsed.company ? 'info' : 'raw');
    } catch (e: any) {
      setResult({ raw: `${uiMessage('legal-asset-trace.error.1d47687da7')}: ${e.message}` });
      setActiveTab('raw');
    } finally {
      setLoading(false);
    }
  };

  const archive = () => {
    if (!result?.raw || !onAddMaterial) return;
    onAddMaterial('note', `${legalCaseTitle(caseFile)} ${uiMessage('legal-asset-trace.asset-trace-report.d6c2fdd263')}`, result.raw, 'tool');
    toast.success(uiMessage('legal-asset-trace.asset-trace-report-archived-to.2e6765985f'));
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-500/10 text-cyan-300">
              <Target size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.legalAssetTraceTitle || uiMessage('legal-asset-trace.asset-trace.494723c6e0')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalAssetTraceDesc || uiMessage('legal-asset-trace.organize-public-clues-around-debtors.4c099af3ad')}
              </p>
            </div>
          </div>
        </section>

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : result ? 'result' : 'input'} />

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') trace(); }}
                placeholder={t.legalAssetTracePlaceholder || uiMessage('legal-asset-trace.enter-debtor-company-name-or.97560b906d')}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35"
              />
            </div>
            <button
              onClick={trace}
              disabled={loading || !name.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {t.legalAssetTraceSearch || uiMessage('legal-asset-trace.trace.d2c6a7c6c9')}
            </button>
          </div>
        </section>

        <section className="min-h-[460px] rounded-lg border border-white/10 bg-white/[0.04] p-4">
          {loading ? (
            <div className="flex h-96 items-center justify-center text-white/55">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : result ? (
            <div className="flex h-full min-h-[420px] flex-col">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex flex-wrap gap-2">
                  <TabButton active={activeTab === 'info'} icon={<Building2 size={14} />} label={uiMessage('legal-asset-trace.enterprise.f29acd4634')} onClick={() => setActiveTab('info')} />
                  <TabButton active={activeTab === 'enforcement'} icon={<AlertCircle size={14} />} label={uiMessage('legal-asset-trace.enforcement.43186c5e00')} onClick={() => setActiveTab('enforcement')} />
                  <TabButton active={activeTab === 'equity'} icon={<Network size={14} />} label={uiMessage('legal-asset-trace.equity.88cbe6797c')} onClick={() => setActiveTab('equity')} />
                  <TabButton active={activeTab === 'raw'} icon={<FileText size={14} />} label={uiMessage('legal-asset-trace.raw-report.ed806061d6')} onClick={() => setActiveTab('raw')} />
                </div>
                {result.raw && onAddMaterial && !orgId && (
                  <button onClick={archive} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                    <FolderOpen size={14} />
                    {uiMessage('legal-asset-trace.archive-to-case.6dc41a223d')}
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                {activeTab === 'info' && <EnterpriseInfo result={result} ui={ui} />}
                {activeTab === 'enforcement' && <EnforcementList result={result} ui={ui} />}
                {activeTab === 'equity' && <EquityList result={result} ui={ui} />}
                {activeTab === 'raw' && <RawReport text={result.raw || uiMessage('legal-asset-trace.no-raw-output.f6fab13ffa')} />}
              </div>
            </div>
          ) : (
            <div className="flex h-96 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
              <Target size={34} className="text-white/20" />
              <span>{uiMessage('legal-asset-trace.enter-a-subject-to-trace.741abddf3e')}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
        active
          ? 'border-cyan-400/25 bg-cyan-500/15 text-cyan-100'
          : 'border-white/10 bg-white/5 text-white/55 hover:bg-white/10 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function EnterpriseInfo({ result, ui }: { result: TraceResult; ui: (zh: string, en: string) => string }) {
  if (!result.company && !result.legalPerson && !result.capital && !result.status) {
    return <Empty text={uiMessage('legal-asset-trace.no-structured-enterprise-data-parsed.a78346c3cf')} />;
  }
  const items = [
    [uiMessage('legal-asset-trace.name.dd4dc4c5a9'), result.company],
    [uiMessage('legal-asset-trace.legal-person.ea73efc282'), result.legalPerson],
    [uiMessage('legal-asset-trace.capital.6fd6a86cb2'), result.capital],
    [uiMessage('legal-asset-trace.status.b8f1474d96'), result.status],
    [uiMessage('legal-asset-trace.established.307fd80c80'), result.establishDate],
  ].filter(([, value]) => value);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <p className="text-xs text-white/40">{label}</p>
          <p className="mt-2 text-sm text-white/80">{value}</p>
        </div>
      ))}
    </div>
  );
}

function EnforcementList({ result, ui }: { result: TraceResult; ui: (zh: string, en: string) => string }) {
  if (!result.enforcements || result.enforcements.length === 0) {
    return <Empty text={uiMessage('legal-asset-trace.no-enforcement-records-parsed-check.19d42c2925')} />;
  }
  return (
    <div className="space-y-2">
      {result.enforcements.map((item, index) => (
        <div key={`${item.caseNumber}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <FileText size={14} className="text-red-300" />
            {item.caseNumber}
          </div>
          <div className="mt-2 grid gap-2 text-xs text-white/50 md:grid-cols-3">
            <span>{uiMessage('legal-asset-trace.court.4dc052bdf6')}: {item.court}</span>
            <span>{uiMessage('legal-asset-trace.date.6d5f0033b0')}: {item.date}</span>
            <span>{uiMessage('legal-asset-trace.target.86287a26eb')}: {item.target}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EquityList({ result, ui }: { result: TraceResult; ui: (zh: string, en: string) => string }) {
  if (!result.shareholders || result.shareholders.length === 0) {
    return <Empty text={uiMessage('legal-asset-trace.no-equity-structure-parsed-check.60dfc119e1')} />;
  }
  return (
    <div className="space-y-2">
      {result.shareholders.map((item, index) => (
        <div key={`${item.name}-${index}`} className="rounded-lg border border-white/10 bg-black/15 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm text-white/80">{item.name}</span>
            <span className="font-mono text-sm text-cyan-200">{item.ratio}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-cyan-400/60" style={{ width: `${Math.max(0, Math.min(100, item.ratio))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RawReport({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-4 text-sm leading-7 text-white/72">
      {text}
    </pre>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
      <FileText size={30} className="text-white/20" />
      <span>{text}</span>
    </div>
  );
}

function parseTraceResult(text: string): TraceResult {
  const traceResult: TraceResult = { raw: text };
  const get = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return '';
  };

  traceResult.company = get([/名称[：:]\s*(.+)/, /企业名称[：:]\s*(.+)/]);
  traceResult.legalPerson = get([/法定代表人[：:]\s*(.+)/, /法人[：:]\s*(.+)/]);
  traceResult.capital = get([/注册资本[：:]\s*(.+)/]);
  traceResult.status = get([/状态[：:]\s*(.+)/, /经营状态[：:]\s*(.+)/]);
  traceResult.establishDate = get([/成立日期[：:]\s*(.+)/]);

  const shareholders: { name: string; ratio: number }[] = [];
  const shareholderRegex = /[-•]\s*(.+?)[：:]\s*(?:持股)?\s*(\d+(?:\.\d+)?)%/g;
  let shareholderMatch: RegExpExecArray | null;
  while ((shareholderMatch = shareholderRegex.exec(text)) !== null) {
    shareholders.push({ name: shareholderMatch[1].trim(), ratio: Number(shareholderMatch[2]) });
  }
  if (shareholders.length > 0) traceResult.shareholders = shareholders;

  const enforcements: { caseNumber: string; court: string; target: string; date: string }[] = [];
  const enforcementRegex = /\[([^\]]+)\]\s*([^|]+)\|\s*(?:立案|日期)[：:]?\s*([^|]*)\|\s*(?:执行标的|标的)[：:]?\s*(.+)/g;
  let enforcementMatch: RegExpExecArray | null;
  while ((enforcementMatch = enforcementRegex.exec(text)) !== null) {
    enforcements.push({
      caseNumber: enforcementMatch[1].trim(),
      court: enforcementMatch[2].trim(),
      date: enforcementMatch[3].trim(),
      target: enforcementMatch[4].trim(),
    });
  }
  if (enforcements.length > 0) traceResult.enforcements = enforcements;

  return traceResult;
}
