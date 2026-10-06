import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import { CheckCircle, Loader2 } from "lucide-react";
import { useT } from "../../../lib/useT";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseToolArgs, legalCaseTitle } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

export function LegalVerifyView({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
}) {
  const t = useT();
  const { text, setText, result, successfulResult, busy, save, generate } = useLegalDocument(
    (caseFile?.materials || []).find(material => (
      Boolean(material.content) && (material.type === 'pleading' || material.type === 'contract')
    ))?.content || '', { error: 'Error' });
  const loading = Boolean(busy);

  const verify = () => {
    if (!text.trim()) return;
    return generate(signal => runLegalTool('legal_verify_citation', { ...legalCaseToolArgs(caseFile, orgId), text }, signal));
  };

  return (
    <LegalTwoPaneTool
      icon={<CheckCircle size={22} />}
      accent="emerald"
      title={t.legalVerifyCitationTitle}
      desc={t.legalVerifyCitationDesc}
      caseFile={caseFile}
      running={loading}
      left={(
        <div className="flex min-h-0 flex-col">
          <label className="mb-2 text-sm font-medium text-white">{uiMessage('legal-hub.text-to-verify.e83f5c99d9')}</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={t.legalVerifyCitationPlaceholder}
            className="min-h-[340px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-emerald-400/35"
          />
          <button
            onClick={verify}
            disabled={loading || !text.trim()}
            className="mt-3 inline-flex items-center justify-center gap-2 self-end rounded-lg border border-emerald-400/20 bg-emerald-500/15 px-4 py-2.5 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
            {loading ? uiMessage('legal-hub.verifying.1c01a1f8ae') : t.legalVerifyCitationVerify}
          </button>
        </div>
      )}
      result={result}
      successfulResult={successfulResult}
      emptyText={uiMessage('legal-hub.citation-verification-results-will-appear.7fa754234b')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={successfulResult && onAddMaterial ? () => save(() => onAddMaterial('note', CHINA_LEGAL_WORKSPACE_COPY.verificationTitle(legalCaseTitle(caseFile)), successfulResult, 'tool')) : undefined}
    />
  );
}
