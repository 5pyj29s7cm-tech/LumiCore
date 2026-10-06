import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import { Brain, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs, legalCaseTitle } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

export function LegalStrategyView({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
}) {
  const t = useT();
  const { text: facts, setText: setFacts, result, successfulResult, busy, save, generate } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' });
  const loading = Boolean(busy);

  const analyze = () => {
    if (!facts.trim()) return;
    return generate(signal => runLegalTool('legal_case_strategy', { ...legalCaseToolArgs(caseFile, orgId), facts }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<Brain size={22} />}
      accent="amber"
      title={t.legalCaseStrategyTitle}
      desc={t.legalCaseStrategyDesc}
      caseFile={caseFile}
      running={loading}
      left={(
        <div className="flex min-h-0 flex-col">
          <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.case-facts.a83dee9a30')}</label>
          <textarea
            value={facts}
            onChange={e => setFacts(e.target.value)}
            placeholder={t.legalCaseStrategyPlaceholder}
            className="min-h-[360px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35"
          />
          <button
            onClick={analyze}
            disabled={loading || !facts.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
            {loading ? uiMessage('legal-hub.analyzing.3b98929aff') : t.legalCaseStrategyAnalyze}
          </button>
        </div>
      )}
      result={result}
      successfulResult={successfulResult}
      emptyText={uiMessage('legal-hub.strategy-analysis-will-appear-here.61c7ee7a79')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!orgId && successfulResult && onAddMaterial ? () => save(() => onAddMaterial('note', CHINA_LEGAL_WORKSPACE_COPY.strategyTitle(legalCaseTitle(caseFile)), successfulResult, 'tool'), uiMessage('legal-hub.strategy-analysis-archived-to-the.7220b483ae')) : undefined}
    />
  );
}
