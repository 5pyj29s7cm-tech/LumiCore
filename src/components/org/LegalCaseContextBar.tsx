import React from 'react';
import { CheckCircle2, FolderOpen, Loader2, Link2, MinusCircle } from 'lucide-react';
import { useT } from '../../lib/useT';
import type { LegalCaseFile } from '../../lib/legalCaseStore';
import { uiMessage } from '../../i18n/uiMessages';

export type LegalToolState = 'input' | 'running' | 'result';

export function LegalCaseContextBar({
  caseFile,
  state = 'input',
  detail,
}: {
  caseFile?: LegalCaseFile | null;
  state?: LegalToolState;
  detail?: string;
}) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const title = caseFile?.title || caseFile?.party || caseFile?.caseNumber || uiMessage('legal-case-context-bar.untitled-case.796e2578d9');
  const stageLabel = caseFile ? ({
    consultation: uiMessage('legal-case-context-bar.consultation.af6082a2f4'),
    filing: uiMessage('legal-case-context-bar.filing.84e2c4dc09'),
    trial: uiMessage('legal-case-context-bar.trial.dd116e8770'),
    judgment: uiMessage('legal-case-context-bar.judgment.f074948f1e'),
    enforcement: uiMessage('legal-case-context-bar.enforcement.10a7440dfb'),
    closed: uiMessage('legal-case-context-bar.closed.f9c16bb807'),
  } as const)[caseFile.stage] : '';
  const stateMeta = state === 'running'
    ? { icon: <Loader2 size={13} className="animate-spin" />, label: uiMessage('legal-case-context-bar.running.db90792ce0'), className: 'border-amber-400/20 bg-amber-500/10 text-amber-100' }
    : state === 'result'
      ? { icon: <CheckCircle2 size={13} />, label: uiMessage('legal-case-context-bar.result-ready.b0ca5c7857'), className: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100' }
      : { icon: <MinusCircle size={13} />, label: uiMessage('legal-case-context-bar.awaiting-input.17d3a4d6ae'), className: 'border-white/10 bg-white/[0.04] text-white/50' };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/16 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${caseFile ? 'border-cyan-400/18 bg-cyan-500/8 text-cyan-200' : 'border-white/10 bg-white/[0.035] text-white/35'}`}>
          {caseFile ? <Link2 size={15} /> : <FolderOpen size={15} />}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-white/38">{uiMessage('legal-case-context-bar.current-case.0708a66402')}</span>
            <span className="truncate text-sm font-semibold text-white/78">{caseFile ? title : uiMessage('legal-case-context-bar.no-case-linked.46aa65b93f')}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/35">
            {caseFile ? (
              <>
                <span>{uiMessage('legal-case-context-bar.stage.1f0cfbfea3')}: {stageLabel}</span>
                <span>{uiMessage('legal-case-context-bar.cause.8d47df5928')}: {caseFile.cause || '-'}</span>
                <span>{uiMessage('legal-case-context-bar.materials.821acb0776')}: {(caseFile.materials || []).length}</span>
                <span>{detail || uiMessage('legal-case-context-bar.results-stay-linked-to-the.8c34a53402')}</span>
              </>
            ) : (
              <span>{detail || uiMessage('legal-case-context-bar.select-or-create-a-case.55c616e673')}</span>
            )}
          </div>
        </div>
      </div>
      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${stateMeta.className}`}>
        {stateMeta.icon}
        {stateMeta.label}
      </span>
    </div>
  );
}
