import React, { useState } from 'react';
import { AlertCircle, Building2, FileText, Loader2, Network, Search, Target } from 'lucide-react';
import { useT } from '../../lib/useT';
import type { LegalCaseFile } from '../../lib/legalCaseStore';
import { runLegalTool } from '../../lib/legalToolClient';

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
  if (!caseFile) return '未命名案件';
  return caseFile.title || caseFile.party || caseFile.caseNumber || '未命名案件';
}

function assetTraceCaseArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return orgId ? { orgId } : {};
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || '执行/财产保全',
    parties: caseFile.party || undefined,
    orgId,
    persistCase: true,
  };
}

export function LegalAssetTrace({
  caseFile,
  orgId,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [name, setName] = useState('');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'info' | 'enforcement' | 'equity' | 'raw'>('info');

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
      setResult({ raw: `${ui('错误', 'Error')}: ${e.message}` });
      setActiveTab('raw');
    } finally {
      setLoading(false);
    }
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
              <h2 className="text-xl font-semibold text-white">{t.legalAssetTraceTitle || ui('财产线索', 'Asset Trace')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalAssetTraceDesc || ui('围绕被执行人、企业和股权结构整理公开线索，辅助执行策略判断。', 'Organize public clues around debtors, companies, and equity structure for enforcement planning.')}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') trace(); }}
                placeholder={t.legalAssetTracePlaceholder || ui('输入被执行人、企业名称或统一社会信用代码...', 'Enter debtor, company name, or registration code...')}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35"
              />
            </div>
            <button
              onClick={trace}
              disabled={loading || !name.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {t.legalAssetTraceSearch || ui('开始追踪', 'Trace')}
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
              <div className="mb-4 flex flex-wrap gap-2 border-b border-white/10 pb-3">
                <TabButton active={activeTab === 'info'} icon={<Building2 size={14} />} label={ui('企业信息', 'Enterprise')} onClick={() => setActiveTab('info')} />
                <TabButton active={activeTab === 'enforcement'} icon={<AlertCircle size={14} />} label={ui('执行记录', 'Enforcement')} onClick={() => setActiveTab('enforcement')} />
                <TabButton active={activeTab === 'equity'} icon={<Network size={14} />} label={ui('股权结构', 'Equity')} onClick={() => setActiveTab('equity')} />
                <TabButton active={activeTab === 'raw'} icon={<FileText size={14} />} label={ui('原始报告', 'Raw Report')} onClick={() => setActiveTab('raw')} />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                {activeTab === 'info' && <EnterpriseInfo result={result} ui={ui} />}
                {activeTab === 'enforcement' && <EnforcementList result={result} ui={ui} />}
                {activeTab === 'equity' && <EquityList result={result} ui={ui} />}
                {activeTab === 'raw' && <RawReport text={result.raw || ui('暂无原始输出。', 'No raw output.')} />}
              </div>
            </div>
          ) : (
            <div className="flex h-96 flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
              <Target size={34} className="text-white/20" />
              <span>{ui('输入对象后开始追踪财产线索。', 'Enter a subject to trace asset clues.')}</span>
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
    return <Empty text={ui('没有解析到结构化企业信息，请查看原始报告。', 'No structured enterprise data parsed. Check raw report.')} />;
  }
  const items = [
    [ui('名称', 'Name'), result.company],
    [ui('法定代表人', 'Legal Person'), result.legalPerson],
    [ui('注册资本', 'Capital'), result.capital],
    [ui('状态', 'Status'), result.status],
    [ui('成立日期', 'Established'), result.establishDate],
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
    return <Empty text={ui('没有解析到执行记录，请查看原始报告。', 'No enforcement records parsed. Check raw report.')} />;
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
            <span>{ui('法院', 'Court')}: {item.court}</span>
            <span>{ui('立案/日期', 'Date')}: {item.date}</span>
            <span>{ui('执行标的', 'Target')}: {item.target}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EquityList({ result, ui }: { result: TraceResult; ui: (zh: string, en: string) => string }) {
  if (!result.shareholders || result.shareholders.length === 0) {
    return <Empty text={ui('没有解析到股权结构，请查看原始报告。', 'No equity structure parsed. Check raw report.')} />;
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
