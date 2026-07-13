import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, FileText, FolderOpen, Hash, Loader2, MapPin, Search, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { useT } from '../../lib/useT';
import { useApp } from '../../contexts/AppContext';
import { runLegalTool } from '../../lib/legalToolClient';
import type { LegalCaseFile, LegalCaseMaterial } from '../../lib/legalCaseStore';
import { LegalCaseContextBar } from './LegalCaseContextBar';
import { uiMessage } from '../../i18n/uiMessages';
import {
  parseChinaCaseSearchResults,
  type ChinaCaseSearchResult,
} from '../../i18n/regions/cn/legal';

type CaseResult = ChinaCaseSearchResult;

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
      const parsed = parseChinaCaseSearchResults(text);
      setResults(parsed.length > 0 ? parsed : [{ articleId: 'raw', title: t.legalCaseSearchResults || uiMessage('legal-case-search.search-results.4e08a3c3ba'), chunk: text, score: 0 }]);
    } catch (e: any) {
      setResults([{ articleId: 'error', title: uiMessage('legal-case-search.error.67aaab3281'), chunk: e.message, score: 0 }]);
    } finally {
      setLoading(false);
    }
  };

  const active = selected || results[0] || null;
  const archive = () => {
    if (!active || active.articleId === 'error' || !onAddMaterial) return;
    const caseTitle = caseFile?.title || caseFile?.party || caseFile?.caseNumber || uiMessage('legal-case-search.case.8a53cf13fb');
    const content = [
      active.title,
      active.caseNumber ? `${uiMessage('legal-case-search.case-number.1adfaa625a')}: ${active.caseNumber}` : '',
      active.court ? `${uiMessage('legal-case-search.court.4dc052bdf6')}: ${active.court}` : '',
      active.score > 0 ? `${uiMessage('legal-case-search.similarity.612732130c')}: ${(active.score * 100).toFixed(1)}%` : '',
      '',
      active.chunk,
    ].filter(Boolean).join('\n');
    onAddMaterial('note', `${caseTitle} ${uiMessage('legal-case-search.similar-case-research.82308874a9')}`, content, 'tool');
    toast.success(uiMessage('legal-case-search.similar-case-result-archived-to.9ac661af08'));
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
              <h2 className="text-xl font-semibold text-white">{t.legalCaseSearchTitle || uiMessage('legal-case-search.similar-case-search.8cb8f83711')}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">
                {t.legalCaseSearchDesc || uiMessage('legal-case-search.search-the-organization-judgment-library.9b70217519')}
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
                placeholder={t.legalCaseSearchPlaceholder || uiMessage('legal-case-search.enter-cause-facts-or-disputed.7ba11bf8e1')}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
              />
            </div>
            <button
              onClick={search}
              disabled={loading || !query.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              {t.legalCaseSearchSearch || uiMessage('legal-case-search.search.3992189fae')}
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
              <EmptyState text={t.legalCaseSearchNoResults || uiMessage('legal-case-search.no-cases-found.fb27bfd04d')} />
            ) : !searched ? (
              <EmptyState text={uiMessage('legal-case-search.enter-case-facts-to-start.a0300d09e3')} />
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
                        {result.score > 0 && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-200">{t.legalScore || uiMessage('legal-case-search.score.ec7c5b9118')}: {(result.score * 100).toFixed(1)}%</span>}
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
                      {uiMessage('legal-case-search.archive-to-case.6dc41a223d')}
                    </button>
                  )}
                </div>
                <div className={`rounded-lg border p-4 text-sm leading-7 whitespace-pre-wrap ${
                  active.articleId === 'error'
                    ? 'border-red-400/20 bg-red-500/10 text-red-200'
                    : 'border-white/10 bg-black/15 text-white/72'
                }`}>
                  {active.articleId === 'error' && <AlertCircle size={16} className="mb-2 text-red-200" />}
                  {active.chunk || uiMessage('legal-case-search.no-summary-available.82a6e46bf8')}
                </div>
              </article>
            ) : (
              <EmptyState text={uiMessage('legal-case-search.select-a-case-to-view.99215b4ad0')} />
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
