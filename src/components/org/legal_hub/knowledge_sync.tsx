import { useMemo } from "react";
import { Loader2, Archive } from "lucide-react";
import { toast } from "sonner";
import { LegalCaseContextBar } from "../LegalCaseContextBar";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { apiJson } from "../../../services/apiClient";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseTitle, buildLegalCaseKnowledgeMarkdown } from './case_values';

export function LegalKnowledgeSyncView({ caseFile }: { caseFile?: LegalCaseFile | null }) {
  const { result: status, successfulResult, busy, generate } = useLegalDocument('', { error: 'Error' });
  const loading = Boolean(busy);
  const caseTitle = legalCaseTitle(caseFile);
  const articleTitle = `${caseTitle} - ${uiMessage('legal-hub.case-knowledge-archive.fb5aa7cf62')}`;
  const articleContent = useMemo(() => (
    caseFile ? buildLegalCaseKnowledgeMarkdown(caseFile) : ''
  ), [caseFile]);

  const syncToKnowledgeBase = () => {
    if (!caseFile) return;
    return generate(async signal => {
      const data = await apiJson('/api/org/kb/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          title: articleTitle,
          content: articleContent,
          category: 'legal_case',
          tags: ['legal', 'case', caseFile.stage, caseFile.cause].filter(Boolean),
          status: 'published',
        }),
      });
      signal.throwIfAborted();
      const articleId = data?.id || data?.article?.id || data?.articleId;
      if (typeof articleId !== 'string' || !articleId.trim()) throw new Error(uiMessage('legal-hub.failed-to-sync-to-knowledge.c0a55da5a1'));
      window.dispatchEvent(new CustomEvent('lumi:knowledge-updated', {
        detail: {
          domain: 'work',
          files: [{ id: articleId, name: articleTitle, displayName: articleTitle }],
        },
      }));
      window.dispatchEvent(new CustomEvent('lumi:client-state-refresh'));
      toast.success(uiMessage('legal-hub.case-synced-to-organization-knowledge.e5d9130fb8'));
      return uiMessage('legal-hub.synced-to-the-organization-knowledge.f95c36e4c6');
    });
  };

  if (!caseFile) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-white">
        <div className="max-w-md text-center">
          <Archive size={36} className="mx-auto mb-3 text-white/25" />
          <h2 className="text-xl font-semibold">{uiMessage('legal-hub.create-a-case-first.277e87bd38')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {uiMessage('legal-hub.knowledge-sync-needs-a-current.b4ab7aa09b')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-emerald-400/15 bg-emerald-500/[0.045] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
                <Archive size={22} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold text-white">{uiMessage('legal-hub.sync-to-organization-knowledge.06ec3e8e07')}</h2>
                <p className="mt-1 text-sm leading-6 text-white/50">
                  {uiMessage('legal-hub.package-the-current-case-facts.ac1c53077e')}
                </p>
              </div>
            </div>
            <button
              onClick={syncToKnowledgeBase}
              disabled={loading || !articleContent.trim()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-45"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
              {loading ? uiMessage('legal-hub.syncing.379d137ae4') : uiMessage('legal-hub.sync-to-kb.f5314698c5')}
            </button>
          </div>
          {status && (
            <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              successfulResult
                ? 'border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-100'
                : 'border-red-400/20 bg-red-500/[0.08] text-red-200'
            }`}>
              {status}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'kb' } }))}
              className="lumi-button h-9 px-3 text-xs"
            >
              {uiMessage('legal-hub.open-knowledge-base.fecb312d9e')}
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('lumi:navigate', { detail: { tab: 'org', sub: 'chat' } }))}
              className="lumi-button h-9 px-3 text-xs"
            >
              {uiMessage('legal-hub.ask-lumi-in-work-workspace.6fe76d2092')}
            </button>
          </div>
        </section>

        <LegalCaseContextBar caseFile={caseFile} state={loading ? 'running' : successfulResult ? 'result' : 'input'} />

        <section className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <h3 className="text-sm font-semibold text-white">{uiMessage('legal-hub.archive-summary.089620ba4e')}</h3>
            <div className="mt-3 space-y-2 text-sm text-white/62">
              <div>{uiMessage('legal-hub.case.8a53cf13fb')}: {caseTitle}</div>
              <div>{uiMessage('legal-hub.case-number.1adfaa625a')}: {caseFile.caseNumber || '-'}</div>
              <div>{uiMessage('legal-hub.cause.8d47df5928')}: {caseFile.cause || '-'}</div>
              <div>{uiMessage('legal-hub.stage.1f0cfbfea3')}: {caseFile.stage || '-'}</div>
              <div>{uiMessage('legal-hub.materials.987ed9a5e2')}: {(caseFile.materials || []).length}</div>
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">{uiMessage('legal-hub.knowledge-preview.5f5d84067a')}</h3>
              <span className="text-xs text-white/35">{articleContent.length} chars</span>
            </div>
            <pre className="max-h-[560px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/25 p-4 text-xs leading-6 text-white/72 custom-scrollbar">
              {articleContent}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}
