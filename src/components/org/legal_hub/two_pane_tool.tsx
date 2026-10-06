import type React from "react";
import { FileText, FolderOpen } from "lucide-react";
import { LegalCaseContextBar } from "../LegalCaseContextBar";
import type { LegalCaseFile } from "../../../lib/legalCaseStore";

export function LegalTwoPaneTool({
  icon,
  accent,
  title,
  desc,
  caseFile,
  running = false,
  left,
  result,
  successfulResult,
  emptyText,
  archiveLabel,
  onArchive,
}: {
  icon: React.ReactNode;
  accent: 'amber' | 'emerald' | 'cyan' | 'blue';
  title: string;
  desc: string;
  caseFile?: LegalCaseFile | null;
  running?: boolean;
  left: React.ReactNode;
  result: string;
  successfulResult: string;
  emptyText: string;
  archiveLabel?: string;
  onArchive?: () => void;
}) {
  const color = {
    amber: 'border-amber-400/20 bg-amber-500/10 text-amber-300 focus:border-amber-400/35',
    emerald: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300 focus:border-emerald-400/35',
    cyan: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-300 focus:border-cyan-400/35',
    blue: 'border-blue-400/20 bg-blue-500/10 text-blue-300 focus:border-blue-400/35',
  }[accent];
  return (
    <div className="h-full overflow-y-auto p-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <section className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
          <div className="flex items-start gap-3">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg border ${color}`}>
              {icon}
            </span>
            <div>
              <h2 className="text-xl font-semibold text-white">{title}</h2>
              <p className="mt-1 text-sm leading-6 text-white/50">{desc}</p>
            </div>
          </div>
        </section>
        <LegalCaseContextBar caseFile={caseFile} state={running ? 'running' : successfulResult ? 'result' : 'input'} />
        <section className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">{left}</div>
          <div className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-white">Output</h3>
              {onArchive && (
                <button onClick={onArchive} disabled={running} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65 transition hover:bg-white/10 hover:text-white">
                  <FolderOpen size={14} />
                  {archiveLabel || 'Archive'}
                </button>
              )}
            </div>
            <div className="min-h-[460px] flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-4 custom-scrollbar">
              {result ? (
                <article className={`whitespace-pre-wrap text-sm leading-7 ${successfulResult ? 'text-white/78' : 'text-red-300'}`}>{result}</article>
              ) : (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <FileText size={32} className="text-white/20" />
                  <span>{emptyText}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
