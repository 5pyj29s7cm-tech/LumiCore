import React, { useState } from "react";
import { Plus, Loader2, Trash2, X } from "lucide-react";
import type { LegalCaseFile, LegalCaseStage } from "../../../lib/legalCaseStore";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import type { LegalCaseCreateInput } from './contracts';
import { CaseField } from './controls';
import { legalStageLabels, legalCaseTitle } from './case_values';

export function LegalCaseCreateDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: LegalCaseCreateInput) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<LegalCaseCreateInput>({
    title: '',
    caseNumber: '',
    party: '',
    cause: '',
    stage: 'consultation',
    notes: '',
  });
  const updateDraft = <K extends keyof LegalCaseCreateInput>(key: K, value: LegalCaseCreateInput[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    void onSubmit({
      ...draft,
      title: draft.title.trim(),
      caseNumber: draft.caseNumber.trim(),
      party: draft.party.trim(),
      cause: draft.cause.trim(),
      notes: draft.notes.trim(),
    });
  };

  return (
    <div data-wallpaper-modal="legal-case-create" className="lumi-legal-modal fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label={uiMessage('legal-hub.close-new-case.cc85fb0c91')} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-create-case-title"
        onSubmit={submit}
        className="relative z-10 w-full max-w-2xl rounded-lg border border-white/12 bg-[#11151b] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="legal-create-case-title" className="text-lg font-bold text-white">{uiMessage('legal-hub.new-case.8aa99242cb')}</h2>
            <p className="mt-1 text-sm text-white/45">{uiMessage('legal-hub.create-the-case-profile-first.1f798cd917')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="lumi-icon-button h-9 w-9" title={uiMessage('legal-hub.close.6cf4a7773a')}>
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.case-name.55c6d2512f')} *</span>
            <input
              autoFocus
              required
              value={draft.title}
              onChange={event => updateDraft('title', event.target.value)}
              className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50"
              placeholder={uiMessage('legal-hub.example-alpha-v-beta-sales.b1bd15cfe1')}
            />
          </label>
          <CaseField label={uiMessage('legal-hub.party.9f6b14598d')} value={draft.party} onChange={value => updateDraft('party', value)} />
          <CaseField label={uiMessage('legal-hub.case-number.1adfaa625a')} value={draft.caseNumber} onChange={value => updateDraft('caseNumber', value)} />
          <CaseField label={uiMessage('legal-hub.cause.8d47df5928')} value={draft.cause} onChange={value => updateDraft('cause', value)} />
          <label className="space-y-1.5">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.current-stage.44a8df1018')}</span>
            <select value={draft.stage} onChange={event => updateDraft('stage', event.target.value as LegalCaseStage)} className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50">
              {Object.entries(legalStageLabels()).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-xs text-white/48">{uiMessage('legal-hub.case-summary.da1171fae6')}</span>
            <textarea
              value={draft.notes}
              onChange={event => updateDraft('notes', event.target.value)}
              rows={4}
              className="lumi-field w-full resize-none rounded-lg focus:border-amber-400/50"
            />
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="lumi-button h-10 px-4 text-sm">{uiMessage('legal-hub.cancel.998b9c48fb')}</button>
          <button type="submit" disabled={busy || !draft.title.trim()} className="lumi-button-primary h-10 border-amber-400/25 bg-amber-500/15 px-4 text-sm text-amber-100 hover:bg-amber-500/25">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {busy ? uiMessage('legal-hub.creating.ba147d5f24') : uiMessage('legal-hub.create-case.ed15df1c91')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function LegalCaseDeleteDialog({
  caseFile,
  busy,
  onClose,
  onConfirm,
}: {
  caseFile: LegalCaseFile;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div data-wallpaper-modal="legal-case-delete" className="lumi-legal-modal fixed inset-0 z-[310] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label={uiMessage('legal-hub.close-delete-confirmation.ccd3d3d67d')} />
      <div role="dialog" aria-modal="true" aria-labelledby="legal-delete-case-title" className="relative z-10 w-full max-w-md rounded-lg border border-rose-400/18 bg-[#11151b] p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-rose-400/20 bg-rose-500/10 text-rose-200">
            <Trash2 size={18} />
          </span>
          <div className="min-w-0">
            <h2 id="legal-delete-case-title" className="text-lg font-bold text-white">{uiMessage('legal-hub.delete-case.ba2912671e')}</h2>
            <p className="mt-2 text-sm leading-6 text-white/55">
              {formatUiMessage('legal-hub.this-removes-value0-and-value1.366643037e', { value0: legalCaseTitle(caseFile), value1: caseFile.materials?.length || 0 })}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="lumi-button h-10 px-4 text-sm">{uiMessage('legal-hub.cancel.998b9c48fb')}</button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/12 px-4 text-sm font-bold text-rose-100 transition hover:bg-rose-500/20 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            {busy ? uiMessage('legal-hub.deleting.052026caec') : uiMessage('legal-hub.delete.d95c2d03f8')}
          </button>
        </div>
      </div>
    </div>
  );
}
