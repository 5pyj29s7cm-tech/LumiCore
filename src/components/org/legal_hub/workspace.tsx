import { Scale, FileText, Search, Brain, CheckCircle, Calendar, ClipboardList, Plus, FolderOpen, Gavel, AlertTriangle, RefreshCw, Loader2, Trash2 } from "lucide-react";
import type { LegalCaseStage } from "../../../lib/legalCaseStore";
import { formatUiMessage, uiMessage } from "../../../i18n/uiMessages";
import { useLegalCaseWorkspaceState } from './useLegalCaseWorkspaceState';
import { buildLegalCaseReadiness, legalReadinessTone, legalReadinessIcon } from './readiness';
import { LegalMeetingInlineButton, CaseField, LegalMeetingActionButton, LegalActionButton } from './controls';

export function LegalCaseWorkspace(props: Parameters<typeof useLegalCaseWorkspaceState>[0]) {
  return renderLegalCaseWorkspace(useLegalCaseWorkspaceState(props));
}

function renderLegalCaseWorkspace(input: ReturnType<typeof useLegalCaseWorkspaceState>) {
  const { activeCase, onCreateCase, selectedMaterialId, onStartConsultation, orgBacked, onRefreshCases, refreshing, caseFilter, setCaseFilter, filteredCases, onSelectCase, stageLabels, canDeleteCases, onDeleteCase, update, onSetView, onCreatePlan, generateReasoningMatrix, documentLoading, runDeliveryGate, createDateReminder, calculateAppealDeadline, onOpenMeetingNotes, noticeText, setNoticeText, notice, extractNotice, noticeLoading, processNoticeLink, noticeStatus, generateEngagementLetter, documentStatus, documents, setSelectedMaterialId } = input;


  if (!activeCase) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300">
            <Scale size={26} />
          </div>
          <h2 className="text-xl font-bold text-white">{uiMessage('legal-hub.create-a-case-file-first.05eb2b4304')}</h2>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {uiMessage('legal-hub.legal-work-flows-around-a.07585ffb03')}
          </p>
          <button
            onClick={onCreateCase}
            className="lumi-button-primary mt-6 border-amber-400/25 bg-amber-500/15 px-5 py-3 text-amber-200 hover:bg-amber-500/25"
          >
            <Plus size={16} />
            {uiMessage('legal-hub.new-case.8aa99242cb')}
          </button>
        </div>
      </div>
    );
  }

  const caseTitle = activeCase.title || activeCase.party || activeCase.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9');
  const selectedMaterial = (activeCase.materials || []).find(material => material.id === selectedMaterialId) || (activeCase.materials || [])[0] || null;
  const readinessItems = buildLegalCaseReadiness(activeCase);
  const readinessDone = readinessItems.filter(item => item.done).length;
  const readinessNext = readinessItems.find(item => item.status === 'blocked')
    || readinessItems.find(item => item.status === 'ready')
    || readinessItems.find(item => item.status === 'missing')
    || readinessItems.find(item => item.status === 'manual')
    || null;

  return (
    <div className="custom-scrollbar h-full overflow-y-auto p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-amber-300">
            <Scale size={17} />
            <span className="text-xs font-black uppercase tracking-[0.16em]">{uiMessage('legal-hub.case-workspace.9f165fc920')}</span>
          </div>
          <h2 className="mt-1 text-2xl font-bold text-white">{caseTitle}</h2>
          <p className="mt-1 text-sm text-white/42">
            {uiMessage('legal-hub.assists-legal-work-final-judgment.57ea0942e9')}
          </p>
        </div>
        <LegalMeetingInlineButton className="ml-auto" label={uiMessage('legal-hub.meeting.e16a90b510')} onClick={onStartConsultation} />
        <button
          onClick={onCreateCase}
          className="lumi-button h-10 px-4 text-sm"
        >
          <Plus size={15} />
          {uiMessage('legal-hub.new-case.8aa99242cb')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="lumi-panel p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-[0.14em] text-white/40">{uiMessage('legal-hub.cases.f93a5c3a91')}</div>
              {orgBacked && (
                <button
                  type="button"
                  onClick={onRefreshCases}
                  disabled={refreshing}
                  className="lumi-icon-button h-7 w-7 rounded-lg"
                  title={uiMessage('legal-hub.refresh-organization-cases.ff33e945a4')}
                >
                  <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
                </button>
              )}
            </div>
            <div className="lumi-field mb-2 flex items-center gap-2 rounded-lg px-2 py-0">
              <Search size={13} className="shrink-0 text-white/30" />
              <input
                value={caseFilter}
                onChange={event => setCaseFilter(event.target.value)}
                placeholder={uiMessage('legal-hub.search-case-number-party.102dc53546')}
                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-white/70 outline-none placeholder:text-white/25"
              />
            </div>
            <div className="space-y-1.5">
              {filteredCases.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-white/30">
                  {uiMessage('legal-hub.no-matching-cases.1bc9817d75')}
                </div>
              ) : filteredCases.map(item => (
                <div
                  key={item.id}
                  className={`group flex items-center rounded-xl border transition-colors ${
                    item.id === activeCase?.id
                      ? 'border-amber-400/20 bg-amber-500/[0.12] text-amber-200'
                      : 'border-transparent bg-white/[0.03] text-white/58 hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white/75'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCase(item.id)}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                  >
                    <span className="block truncate text-sm font-semibold">{item.title || item.party || item.caseNumber || uiMessage('legal-hub.untitled-case.796e2578d9')}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/32">{stageLabels[item.stage]} / {item.cause || uiMessage('legal-hub.no-cause.88636fe5c2')}</span>
                  </button>
                  {canDeleteCases && (
                    <button
                      type="button"
                      onClick={() => onDeleteCase(item)}
                      className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/30 transition hover:bg-rose-500/12 hover:text-rose-200"
                      aria-label={formatUiMessage('legal-hub.delete-case-value0.2812ed70f8', { value0: item.title || item.caseNumber || '' })}
                      title={uiMessage('legal-hub.delete-case.d0c1c0a330')}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="lumi-panel border-amber-400/15 bg-amber-400/[0.045] p-3">
            <div className="flex items-start gap-2 text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="text-xs leading-5 text-amber-100/70">
                {uiMessage('legal-hub.deadline-calculations-are-assistant-reminders.e596ac453b')}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <FolderOpen size={16} className="text-amber-300" />
              <h3 className="text-sm font-bold">{uiMessage('legal-hub.case-file.65a38706c2')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <CaseField label={uiMessage('legal-hub.case-name.55c6d2512f')} value={activeCase.title} onChange={value => update({ title: value })} />
              <CaseField label={uiMessage('legal-hub.case-number.1adfaa625a')} value={activeCase.caseNumber} onChange={value => update({ caseNumber: value })} />
              <CaseField label={uiMessage('legal-hub.party.9f6b14598d')} value={activeCase.party} onChange={value => update({ party: value })} />
              <CaseField label={uiMessage('legal-hub.cause.8d47df5928')} value={activeCase.cause} onChange={value => update({ cause: value })} />
              <CaseField label={uiMessage('legal-hub.court.4dc052bdf6')} value={activeCase.court} onChange={value => update({ court: value })} />
              <CaseField label={uiMessage('legal-hub.judge.329c4c5855')} value={activeCase.judge} onChange={value => update({ judge: value })} />
              <label className="space-y-1.5">
                <span className="text-xs text-white/42">{uiMessage('legal-hub.stage.1f0cfbfea3')}</span>
                <select
                  value={activeCase.stage}
                  onChange={event => update({ stage: event.target.value as LegalCaseStage })}
                  className="lumi-field h-10 w-full rounded-lg focus:border-amber-400/50"
                >
                  {Object.entries(stageLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block space-y-1.5">
              <span className="text-xs text-white/42">{uiMessage('legal-hub.facts-missing-materials.af3bad57e8')}</span>
              <textarea
                value={activeCase.notes}
                onChange={event => update({ notes: event.target.value })}
                rows={4}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={uiMessage('legal-hub.record-statements-issues-evidence-gaps.f97abfc047')}
              />
            </label>
          </section>

          <section className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <LegalMeetingActionButton title={uiMessage('legal-hub.consultation.921ab7edb9')} desc={uiMessage('legal-hub.start-transcription.c0d64487e4')} onClick={onStartConsultation} />
            <LegalActionButton icon={<Search size={16} />} title={uiMessage('legal-hub.case-analysis.4e8fce63e9')} desc={uiMessage('legal-hub.search-precedents.5d3dd9e729')} onClick={() => onSetView('case-search')} />
            <LegalActionButton icon={<Brain size={16} />} title={uiMessage('legal-hub.strategy.25d1bf401d')} desc={uiMessage('legal-hub.build-litigation-route.7c821a3812')} onClick={() => onSetView('strategy')} />
            <LegalActionButton icon={<ClipboardList size={16} />} title={uiMessage('legal-hub.case-plan.ed9eaee22d')} desc={uiMessage('legal-hub.create-workflow.9ccc04284c')} onClick={onCreatePlan} />
          </section>

          <section className="lumi-panel p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-white/78">
                <CheckCircle size={16} className="text-emerald-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.case-loop.9317db1dd1')}</h3>
              </div>
              <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/45">
                {readinessDone}/{readinessItems.length}
              </span>
            </div>
            {readinessNext && (
              <button
                type="button"
                onClick={() => readinessNext.view && onSetView(readinessNext.view)}
                className="mb-3 w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-left text-xs text-white/58 transition-colors hover:border-amber-400/18 hover:bg-amber-500/[0.05]"
              >
                <span className="font-semibold text-white/76">{uiMessage('legal-hub.next.b527069e7f')}</span>
                <span className="mx-2 text-white/22">/</span>
                <span className={readinessNext.status === 'blocked' ? 'text-rose-200' : 'text-amber-100/80'}>{readinessNext.label}</span>
                <span className="ml-2 text-white/45">{readinessNext.nextStep}</span>
              </button>
            )}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              {readinessItems.map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => item.view && onSetView(item.view)}
                  title={item.nextStep}
                  className={`min-h-[76px] rounded-lg border px-3 py-2 text-left transition-colors ${legalReadinessTone(item.status)}`}
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold">
                    {legalReadinessIcon(item)}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </div>
                  <div className="mt-2 text-[11px] text-white/50">{item.detail}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={generateReasoningMatrix}
                disabled={Boolean(documentLoading)}
                className="lumi-button h-9 px-3 text-xs"
              >
                {uiMessage('legal-hub.reasoning-matrix.7e54736217')}
              </button>
              <button type="button" onClick={() => onSetView('external-research')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.sources.2c0ee0fd12')}
              </button>
              <button type="button" onClick={() => onSetView('packet')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.packet.1758eaea66')}
              </button>
              <button
                type="button"
                onClick={runDeliveryGate}
                disabled={Boolean(documentLoading)}
                className="lumi-button h-9 px-3 text-xs"
              >
                {uiMessage('legal-hub.delivery-gate.de13676f0a')}
              </button>
            </div>
          </section>

          <section className="lumi-panel p-4">
            <div className="mb-4 flex items-center gap-2 text-white/78">
              <Calendar size={16} className="text-cyan-300" />
              <h3 className="text-sm font-bold">{uiMessage('legal-hub.deadlines-and-hearings.804d0a2db1')}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <CaseField type="date" label={uiMessage('legal-hub.hearing-date.e3930c19c4')} value={activeCase.hearingDate} onChange={value => update({ hearingDate: value })} onReminder={() => createDateReminder('hearing')} />
              <CaseField type="date" label={uiMessage('legal-hub.judgment-date.abf2b584c3')} value={activeCase.judgmentDate} onChange={value => update({ judgmentDate: value })} />
              <CaseField type="date" label={uiMessage('legal-hub.appeal-deadline.0e3e1ebb0f')} value={activeCase.appealDeadline} onChange={value => update({ appealDeadline: value })} onReminder={() => createDateReminder('appeal')} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={calculateAppealDeadline} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.calculate-appeal-deadline.7fb9a79f48')}
              </button>
              <LegalMeetingInlineButton label={uiMessage('legal-hub.open-meeting-notes.8f232a1703')} onClick={onOpenMeetingNotes} />
              <button onClick={() => onSetView('import')} className="lumi-button h-9 px-3 text-xs">
                {uiMessage('legal-hub.import-judgment.7b322fc577')}
              </button>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <Gavel size={16} className="text-amber-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.hearing-notice-extractor.291c653bd1')}</h3>
              </div>
              <textarea
                value={noticeText}
                onChange={event => setNoticeText(event.target.value)}
                rows={5}
                className="lumi-field w-full resize-none rounded-lg text-sm leading-6 focus:border-amber-400/50"
                placeholder={uiMessage('legal-hub.paste-sms-or-court-notice.e888cb415d')}
              />
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => notice.generate(extractNotice)}
                  disabled={!noticeText.trim() || Boolean(noticeLoading)}
                  className="lumi-button-primary h-9 border-amber-400/25 bg-amber-500/15 px-4 text-xs text-amber-200 hover:bg-amber-500/25"
                >
                  {uiMessage('legal-hub.extract.c127c363a4')}
                </button>
                <button
                  onClick={processNoticeLink}
                  disabled={!noticeText.trim() || Boolean(noticeLoading)}
                  className="lumi-button h-9 px-3 text-xs"
                >
                  {noticeLoading ? uiMessage('legal-hub.processing.45c0c78af6') : uiMessage('legal-hub.process-link.7a43f618ce')}
                </button>
                {noticeStatus && <span className={`max-h-64 overflow-y-auto whitespace-pre-wrap text-xs ${notice.successfulResult ? 'text-emerald-300/70' : 'text-red-300'}`}>{noticeStatus}</span>}
              </div>
            </div>

            <div className="lumi-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-white/78">
                <FileText size={16} className="text-blue-300" />
                <h3 className="text-sm font-bold">{uiMessage('legal-hub.materials-and-documents.af06979d97')}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={generateEngagementLetter}
                  disabled={Boolean(documentLoading)}
                  className="lumi-button h-9 px-3 text-xs"
                >
                  {uiMessage('legal-hub.engagement-letter.260ac284a3')}
                </button>
                <LegalMeetingInlineButton
                  label={uiMessage('legal-hub.trial-notes.25b8c590da')}
                  onClick={onStartConsultation}
                />
                <button onClick={() => onSetView('contract-review')} className="lumi-button h-9 px-3 text-xs">
                  {uiMessage('legal-hub.contract-review.798c7d6913')}
                </button>
                <button onClick={() => onSetView('asset-trace')} className="lumi-button h-9 px-3 text-xs">
                  {uiMessage('legal-hub.asset-trace.24d93c8873')}
                </button>
              </div>
              {documentLoading && <Loader2 size={16} className="mt-3 animate-spin text-white/50" />}
              {documentStatus && (
                <div className={`mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border px-3 py-2 text-xs ${
                  documents.successfulResult
                    ? 'border-emerald-400/[0.18] bg-emerald-500/[0.08] text-emerald-200/78'
                    : 'border-red-400/20 bg-red-500/[0.08] text-red-200/80'
                }`}>
                  {documentStatus}
                </div>
              )}
              <div className="mt-4 space-y-2">
                {(activeCase.materials || []).length === 0 ? (
                  <p className="text-sm text-white/28">{uiMessage('legal-hub.no-materials-yet-consultations-notices.9b7ef37152')}</p>
                ) : (
                  activeCase.materials.slice(0, 8).map(material => (
                    <button
                      key={material.id}
                      type="button"
                      onClick={() => setSelectedMaterialId(material.id)}
                       className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
                        selectedMaterial?.id === material.id ? 'bg-cyan-400/10' : 'bg-black/22 hover:bg-white/[0.055]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-white/72">{material.title}</div>
                        <div className="text-xs text-white/30">{material.type} / {new Date(material.createdAt).toLocaleString()}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
              {selectedMaterial?.content && (
                <div className="lumi-panel mt-4 rounded-xl bg-black/24 p-3">
                  <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-white/35">{uiMessage('legal-hub.material-content.a5b29f0203')}</div>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-6 text-white/68 custom-scrollbar">{selectedMaterial.content}</pre>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
