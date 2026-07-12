import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, FileText, FolderOpen, Hash, Loader2, MapPin, Search, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { runLegalTool } from '../../lib/legalToolClient';
import type { LegalCaseFile, LegalCaseMaterial } from '../../lib/legalCaseStore';
import { LegalCaseContextBar } from './LegalCaseContextBar';

interface CaseResult {
  articleId: string;
  title: string;
  caseNumber?: string;
  court?: string;
  chunk: string;
  score: number;
  date?: string;
}

function caseSearchSeed(caseFile?: LegalCaseFile | null): string {
  if (!caseFile) return '';
  const facts = String(caseFile.notes || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^【材料归档】/.test(line))
    .join('\n');
  return [caseFile.cause, facts].filter(Boolean).join('\n');
}

export function LegalCaseSearch({
  caseFile,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => void;
}) {
  const t = useT();
  const { workDomain, orgConnection } = useApp();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const defaultQuery = useMemo(() => caseSearchSeed(caseFile), [caseFile?.cause, caseFile?.notes]);
  const [query, setQuery] = useState(defaultQuery);
  const [results, setResults] = useState<CaseResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<CaseResult | null>(null);

  useEffect(() => {
    setQuery(defaultQuery);
    setResults([]);
    setSelected(null);
    setSearched(false);
  }, [caseFile?.id]);

  const search = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setSearched(true);
    setSelected(null);
    try {
      const text = await runLegalTool('legal_search_case', {
        query,
        orgId: workDomain === 'work' && orgConnection?.orgId ? orgConnection.orgId : undefined,
        caseId: caseFile?.id,
        caseName: caseFile?.title || caseFile?.party || caseFile?.caseNumber || undefined,
        caseType: caseFile?.cause || undefined,
        persistCase: Boolean(caseFile),
      });
      const parsed = parseCaseResults(text);
      setResults(parsed.length > 0 ? parsed : [{ articleId: 'raw', title: t.legalCaseSearchResults || ui('检索结果', 'Search Results'), chunk: text, score: 0 }]);
    } catch (e: any) {
      setResults([{ articleId: 'error', title: ui('检索失败', 'Error'), chunk: e.message, score: 0 }]);
    } finally {
      setLoading(false);
    }
  };

  const active = selected || results[0] || null;
  const archive = () => {
    if (!active || active.articleId === 'error' || !onAddMaterial) return;
    const caseTitle = caseFile?.title || caseFile?.party || caseFile?.caseNumber || ui('案件', 'Case');
    const content = [
      active.title,
      active.caseNumber ? `${ui('案号', 'Case number')}: ${active.caseNumber}` : '',
      active.court ? `${ui('法院', 'Court')}: ${active.court}` : '',
      active.score > 0 ? `${ui('相似度', 'Similarity')}: ${(active.score * 100).toFixed(1)}%` : '',
      '',
      active.chunk,
    ].filter(Boolean).join('\n');
    onAddMaterial('note', `${caseTitle} ${ui('类案检索记录', 'similar case research')}`, content, 'tool');
    toast.success(ui('类案结果已归档到当前案件', 'Similar-case result archived to the current case'));
  };

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-400/20 bg-amber-500/10 text-amber-300">
              <Scale size={22} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-white">{t.legalCaseSearchTitle || ui('类案检索', 'Similar Case Search')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalCaseSearchDesc || ui('基于事实、案由或争议焦点检索组织裁判文书库，辅助律师形成判断。', 'Search the organization judgment library by facts, cause, or issues to support lawyer review.')}
              </p>
            </div>
          </div>
        </section>

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : searched ? 'result' : 'input'} />

        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/45" />
              <input
                type="text"
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') search(); }}
                placeholder={t.legalCaseSearchPlaceholder || ui('输入案由、事实经过、争议焦点...', 'Enter cause, facts, or disputed issues...')}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
              />
            </div>
            <button
              onClick={search}
              disabled={loading || !query.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {t.legalCaseSearchSearch || ui('检索', 'Search')}
            </button>
          </div>
        </section>

        <section className="grid min-h-[440px] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-2">
            {loading ? (
              <div className="flex h-full min-h-[300px] items-center justify-center text-white/55">
                <Loader2 size={24} className="animate-spin" />
              </div>
            ) : searched && results.length === 0 ? (
              <EmptyState text={t.legalCaseSearchNoResults || ui('没有找到类案', 'No cases found')} />
            ) : !searched ? (
              <EmptyState text={ui('输入案件事实后开始检索。', 'Enter case facts to start searching.')} />
            ) : (
              <div className="space-y-2">
                {results.map((result, index) => {
                  const isActive = active === result;
                  return (
                    <button
                      key={`${result.articleId}-${index}`}
                      onClick={() => setSelected(result)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        isActive
                          ? 'border-amber-400/30 bg-amber-500/10'
                          : 'border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <FileText size={14} className="mt-0.5 shrink-0 text-amber-200/70" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-white">{result.title}</p>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/45">{result.chunk}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/45">
                        {result.caseNumber && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1"><Hash size={10} />{result.caseNumber}</span>}
                        {result.court && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1"><MapPin size={10} />{result.court}</span>}
                        {result.score > 0 && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-200">{t.legalScore || ui('相似度', 'Score')}: {(result.score * 100).toFixed(1)}%</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
            {active ? (
              <article className="h-full overflow-y-auto custom-scrollbar">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-white">{active.title}</h3>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/45">
                      {active.caseNumber && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1"><Hash size={10} />{active.caseNumber}</span>}
                      {active.court && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1"><MapPin size={10} />{active.court}</span>}
                      {active.score > 0 && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-200">{(active.score * 100).toFixed(1)}%</span>}
                    </div>
                  </div>
                  {onAddMaterial && active.articleId !== 'error' && (
                    <button onClick={archive} className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                      <FolderOpen size={14} />
                      {ui('归档到案件', 'Archive to Case')}
                    </button>
                  )}
                </div>
                <div className={`rounded-lg border p-4 text-sm leading-7 whitespace-pre-wrap ${
                  active.articleId === 'error'
                    ? 'border-red-400/20 bg-red-500/10 text-red-200'
                    : 'border-white/10 bg-black/15 text-white/72'
                }`}>
                  {active.articleId === 'error' && <AlertCircle size={16} className="mb-2 text-red-200" />}
                  {active.chunk || ui('暂无摘要内容。', 'No summary available.')}
                </div>
              </article>
            ) : (
              <EmptyState text={ui('选择左侧类案查看摘要和相似度。', 'Select a case to view details and similarity.')} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
      <FileText size={30} className="text-white/20" />
      <span>{text}</span>
    </div>
  );
}

function parseCaseResults(text: string): CaseResult[] {
  const lines = text.split('\n');
  const parsed: CaseResult[] = [];
  let current: Partial<CaseResult> = {};

  for (const line of lines) {
    const titleMatch = line.match(/^\d+\.\s*\*\*(.+?)\*\*\s*(?:\[相似度[:：]?\s*([\d.]+)\])?/);
    if (titleMatch) {
      if (current.title) parsed.push(current as CaseResult);
      current = {
        title: titleMatch[1].trim(),
        score: titleMatch[2] ? parseFloat(titleMatch[2]) : 0,
        articleId: '',
        chunk: '',
      };
      continue;
    }
    if (line.includes('案号:') || line.includes('案号：')) {
      current.caseNumber = line.split(/案号[:：]/)[1]?.split('|')[0]?.trim() || '';
    } else if (line.includes('法院:') || line.includes('法院：')) {
      current.court = line.split(/法院[:：]/)[1]?.split('|')[0]?.trim() || '';
    } else if (line.includes('摘要:') || line.includes('摘要：')) {
      current.chunk = line.split(/摘要[:：]/)[1]?.trim() || '';
    } else if (current.title && line.trim()) {
      current.chunk = [current.chunk, line.trim()].filter(Boolean).join('\n');
    }
  }
  if (current.title) parsed.push(current as CaseResult);
  return parsed;
}
