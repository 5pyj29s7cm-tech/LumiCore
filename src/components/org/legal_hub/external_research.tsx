import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

export function LegalExternalResearchView({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
}) {
  const { text: facts, setText: setFacts, result, successfulResult, busy, save, generate: run } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' });
  const [issues, setIssues] = useState(caseFile?.cause || '');
  const [companies, setCompanies] = useState(caseFile?.party || '');
  const loading = Boolean(busy);

  const generate = () => {
    if (!facts.trim() && !issues.trim() && !companies.trim()) return;
    return run(signal => runLegalTool('legal_external_research_plan', {
      ...legalCaseToolArgs(caseFile, orgId),
      facts,
      issues: issues.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
      companyNames: companies.split(/[，,；;\n]/).map(item => item.trim()).filter(Boolean),
    }, signal));
  };


  return (
    <LegalTwoPaneTool
      icon={<Search size={22} />}
      accent="cyan"
      title={uiMessage('legal-hub.semi-automated-external-research.a9fe50cd06')}
      desc={uiMessage('legal-hub.generate-search-terms-login-presets.497732dec9')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <input value={issues} onChange={event => setIssues(event.target.value)} placeholder={uiMessage('legal-hub.issues-comma-separated.f2f8ca4339')} className="lumi-field h-10 w-full rounded-lg" />
          <input value={companies} onChange={event => setCompanies(event.target.value)} placeholder={uiMessage('legal-hub.companies-debtors-comma-separated.052f39a297')} className="lumi-field mt-3 h-10 w-full rounded-lg" />
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={uiMessage('legal-hub.facts-and-research-context.cd7839dce0')} className="mt-3 min-h-[340px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-cyan-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !issues.trim() && !companies.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-500/15 px-4 py-2.5 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-plan.6825d94075')}
          </button>
        </>
      )}
      result={result}
      successfulResult={successfulResult}
      emptyText={uiMessage('legal-hub.external-research-plan-will-appear.701d667eed')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!orgId && successfulResult && onAddMaterial ? () => save(() => onAddMaterial('note', CHINA_LEGAL_WORKSPACE_COPY.researchTitle(caseFile?.title || caseFile?.caseNumber || uiMessage('legal-hub.case.8a53cf13fb')), successfulResult, 'tool')) : undefined}
    />
  );
}
