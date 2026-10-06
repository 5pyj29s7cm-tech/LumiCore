import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import { useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { useLegalDocument } from "../../../hooks/useLegalDocument";
import { runLegalTool } from "../../../lib/legalToolClient";
import type { LegalCaseFile, LegalCaseMaterial } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";
import { legalCaseDraftContext, legalCaseToolArgs } from './case_values';
import { LegalTwoPaneTool } from './two_pane_tool';

export function LegalPacketView({
  caseFile,
  orgId,
  onAddMaterial,
}: {
  caseFile?: LegalCaseFile | null;
  orgId?: string;
  onAddMaterial?: (type: LegalCaseMaterial['type'], title: string, content?: string, source?: LegalCaseMaterial['source']) => boolean | Promise<boolean>;
}) {
  const { text: facts, setText: setFacts, result, successfulResult, busy, save, generate: run } = useLegalDocument(legalCaseDraftContext(caseFile), { error: 'Error' });
  const [evidence, setEvidence] = useState(() => (
    (caseFile?.materials || [])
      .filter(material => material.type === 'evidence')
      .map(material => `${material.title}\n${material.content || ''}`)
      .join('\n\n')
  ));
  const [role, setRole] = useState('plaintiff');
  const [claims, setClaims] = useState('');
  const loading = Boolean(busy);

  const generate = () => {
    if (!facts.trim() && !evidence.trim()) return;
    return run(signal => runLegalTool('legal_generate_litigation_packet', {
      ...legalCaseToolArgs(caseFile, orgId),
      role,
      claims,
      facts,
      evidence,
    }, signal));
  };


  return (
    <LegalTwoPaneTool
      icon={<ClipboardList size={22} />}
      accent="amber"
      title={uiMessage('legal-hub.semi-automated-litigation-packet.37b15d0cf5')}
      desc={uiMessage('legal-hub.draft-complaint-defense-evidence-retainer.da01b9a635')}
      caseFile={caseFile}
      running={loading}
      left={(
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <select value={role} onChange={event => setRole(event.target.value)} className="lumi-field h-10 rounded-lg">
              <option value="plaintiff">{uiMessage('legal-hub.plaintiff.607f2116c4')}</option>
              <option value="defendant">{uiMessage('legal-hub.defendant.a3bd508da0')}</option>
              <option value="applicant">{uiMessage('legal-hub.applicant.5be3a82eea')}</option>
              <option value="respondent">{uiMessage('legal-hub.respondent.f726ebb1c2')}</option>
            </select>
            <input value={claims} onChange={event => setClaims(event.target.value)} placeholder={uiMessage('legal-hub.claims-defenses-or-objective.00855c8c20')} className="lumi-field h-10 rounded-lg" />
          </div>
          <textarea value={facts} onChange={event => setFacts(event.target.value)} placeholder={uiMessage('legal-hub.facts-timeline-parties.6783b7303c')} className="mt-3 min-h-[240px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <textarea value={evidence} onChange={event => setEvidence(event.target.value)} placeholder={uiMessage('legal-hub.evidence-opponent-materials-gaps.61eff6246d')} className="mt-3 min-h-[140px] w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/35 focus:border-amber-400/35" />
          <button onClick={generate} disabled={loading || (!facts.trim() && !evidence.trim())} className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <ClipboardList size={16} />}
            {loading ? uiMessage('legal-hub.generating.634308f29b') : uiMessage('legal-hub.generate-packet.8494e1ff7c')}
          </button>
        </>
      )}
      result={result}
      successfulResult={successfulResult}
      emptyText={uiMessage('legal-hub.the-packet-will-appear-here.52a02955fa')}
      archiveLabel={uiMessage('legal-hub.archive-to-case.6dc41a223d')}
      onArchive={!orgId && successfulResult && onAddMaterial ? () => save(() => onAddMaterial('pleading', CHINA_LEGAL_WORKSPACE_COPY.packetTitle(caseFile?.title || caseFile?.caseNumber || uiMessage('legal-hub.case.8a53cf13fb')), successfulResult, 'tool')) : undefined}
    />
  );
}
