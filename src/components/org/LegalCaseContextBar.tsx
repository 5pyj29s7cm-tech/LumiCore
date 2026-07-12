import React from 'react';
import { CheckCircle2, FolderOpen, Loader2, Link2, MinusCircle } from 'lucide-react';
import { useT } from '../../lib/useT';
import type { LegalCaseFile } from '../../lib/legalCaseStore';

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
  const title = caseFile?.title || caseFile?.party || caseFile?.caseNumber || ui('未命名案件', 'Untitled case');
  const stageLabel = caseFile ? ({
    consultation: ui('咨询与收案', 'Consultation'),
    filing: ui('立案', 'Filing'),
    trial: ui('审理', 'Trial'),
    judgment: ui('裁判', 'Judgment'),
    enforcement: ui('执行', 'Enforcement'),
    closed: ui('已结案', 'Closed'),
  } as const)[caseFile.stage] : '';
  const stateMeta = state === 'running'
    ? { icon: <Loader2 size={13} className="animate-spin" />, label: ui('执行中', 'Running'), className: 'border-amber-400/20 bg-amber-500/10 text-amber-100' }
    : state === 'result'
      ? { icon: <CheckCircle2 size={13} />, label: ui('结果已生成', 'Result ready'), className: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100' }
      : { icon: <MinusCircle size={13} />, label: ui('等待输入', 'Awaiting input'), className: 'border-white/10 bg-white/[0.04] text-white/50' };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/16 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${caseFile ? 'border-cyan-400/18 bg-cyan-500/8 text-cyan-200' : 'border-white/10 bg-white/[0.035] text-white/35'}`}>
          {caseFile ? <Link2 size={15} /> : <FolderOpen size={15} />}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-white/38">{ui('当前案件', 'Current case')}</span>
            <span className="truncate text-sm font-semibold text-white/78">{caseFile ? title : ui('未关联案件', 'No case linked')}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/35">
            {caseFile ? (
              <>
                <span>{ui('阶段', 'Stage')}: {stageLabel}</span>
                <span>{ui('案由', 'Cause')}: {caseFile.cause || '-'}</span>
                <span>{ui('材料', 'Materials')}: {(caseFile.materials || []).length}</span>
                <span>{detail || ui('执行结果将与当前案件关联', 'Results stay linked to the current case')}</span>
              </>
            ) : (
              <span>{detail || ui('先在案件工作台选择或创建案件，才能形成完整归档闭环', 'Select or create a case in Case Workspace to complete the archive loop')}</span>
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
