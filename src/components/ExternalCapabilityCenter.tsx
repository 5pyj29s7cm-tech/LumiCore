import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileJson, Play, PowerOff, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  activateExternalCapability,
  createExternalCapabilityExecutionCorrelation,
  deactivateExternalCapability,
  executeExternalCapabilityAction,
  getExternalCapabilityLaunchAction,
  reviewExternalCapability,
  type ExternalCapabilityProjection,
  type ExternalCapabilityReview,
  type ExternalCapabilityExecutionCorrelation,
} from '@/services/externalCapabilities';
import {
  externalCapabilityAvailabilityLabel,
  externalCapabilityCopy,
  externalCapabilityStageLabel,
  externalCapabilityVerificationLabel,
} from '../i18n/locales/externalCapabilities';

function dateLabel(value: string | undefined, lang: 'en' | 'zh'): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.035] p-4">
      <p className="text-[11px] font-black uppercase tracking-wider text-white/45">{title}</p>
      <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-white/65">
        {items.map(item => <p key={item} className="break-words">{item}</p>)}
      </div>
    </div>
  );
}

export function ExternalCapabilityIntakeDialog({
  open,
  lang,
  onClose,
  onActivated,
}: {
  open: boolean;
  lang: 'en' | 'zh';
  onClose: () => void;
  onActivated: () => Promise<void> | void;
}) {
  const copy = externalCapabilityCopy(lang);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState('');
  const [review, setReview] = useState<ExternalCapabilityReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [activating, setActivating] = useState(false);

  if (!open) return null;

  const updateSource = (value: string) => {
    setSource(value);
    setReview(null);
  };

  const parseProposal = (): Record<string, unknown> => {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(copy.invalidJson);
    return parsed as Record<string, unknown>;
  };

  const runReview = async () => {
    setReviewing(true);
    try {
      const result = await reviewExternalCapability(parseProposal());
      setReview(result);
      toast.success(copy.reviewReady);
    } catch (error: any) {
      toast.error(error?.message || copy.invalidJson);
    } finally {
      setReviewing(false);
    }
  };

  const activate = async () => {
    if (!review || !window.confirm(copy.activationConfirm(review.name))) return;
    setActivating(true);
    try {
      await activateExternalCapability(review.proposal, review.reviewNonce);
      toast.success(copy.activated(review.name));
      window.dispatchEvent(new CustomEvent('lumi:external-capabilities-changed'));
      await onActivated();
      onClose();
    } catch (error: any) {
      toast.error(error?.message || copy.loadFailed);
    } finally {
      setActivating(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text);
      setFileName(file.name);
      updateSource(text);
      toast.success(copy.importedFile(file.name));
    } catch {
      toast.error(copy.invalidJson);
    }
  };

  const runtimeLabels = review
    ? review.runtimeRefs.map(runtime => [runtime.kind, runtime.provider].filter(Boolean).join(' · '))
    : [];

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onClick={onClose}>
      <div className="lumi-panel flex max-h-[min(780px,calc(100vh-32px))] w-full max-w-4xl flex-col overflow-hidden border border-cyan-300/15 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
              <ShieldCheck size={19} />
            </div>
            <div>
              <h3 className="text-base font-black text-white/90">{copy.intakeTitle}</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">{copy.intakeDescription}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="lumi-icon-button h-9 w-9" title={copy.close}><X size={15} /></button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="external-capability-proposal" className="text-[11px] font-black uppercase tracking-wider text-white/55">{copy.jsonLabel}</label>
              <div className="flex items-center gap-2">
                {fileName && <span className="max-w-48 truncate text-[11px] text-white/40">{fileName}</span>}
                <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={event => void onFile(event.target.files?.[0])} />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-bold text-white/65 hover:bg-white/[0.08]">
                  <Upload size={13} /> {copy.importJson}
                </button>
              </div>
            </div>
            <textarea
              id="external-capability-proposal"
              value={source}
              onChange={event => updateSource(event.target.value)}
              spellCheck={false}
              placeholder={copy.jsonPlaceholder}
              className="lumi-field min-h-52 w-full resize-y rounded-2xl p-4 font-mono text-xs leading-relaxed"
            />
            <div className="flex justify-end">
              <button type="button" onClick={() => void runReview()} disabled={reviewing || !source.trim()} className="lumi-button-primary flex h-10 items-center gap-2 rounded-xl bg-celestial-saturn px-4 text-xs font-black text-black disabled:cursor-not-allowed disabled:opacity-40">
                {reviewing ? <RefreshCw size={14} className="animate-spin" /> : <FileJson size={14} />}
                {reviewing ? copy.reviewing : copy.reviewAction}
              </button>
            </div>
          </div>

          {review && (
            <div className="space-y-4 rounded-3xl border border-amber-300/15 bg-amber-300/[0.025] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-emerald-300" />
                    <h4 className="text-sm font-black text-white/90">{copy.reviewTitle}</h4>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-white/75">{review.name} · v{review.version}</p>
                  {review.expiresAt && <p className="mt-1 text-[11px] text-white/40">{copy.approvalExpires(dateLabel(review.expiresAt, lang))}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {(runtimeLabels.length ? runtimeLabels : [copy.noneDeclared]).map(runtimeLabel => (
                    <span key={runtimeLabel} className="rounded-full border border-cyan-300/15 bg-cyan-300/10 px-2.5 py-1 text-[11px] font-bold text-cyan-200">{runtimeLabel}</span>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <ReviewList title={copy.summary} items={[review.summary || copy.noneDeclared]} />
                <ReviewList title={copy.documents} items={review.documents.length ? review.documents : [copy.noneDeclared]} />
                <ReviewList title={copy.permissions} items={review.permissions.length ? review.permissions : [copy.noneDeclared]} />
              </div>

              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.035] p-4">
                <p className="text-[11px] font-black uppercase tracking-wider text-white/45">{copy.actions}</p>
                <div className="mt-3 space-y-2">
                  {review.actions.length ? review.actions.map(action => (
                    <div key={action.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-white/75">{action.label}</p>
                        <p className="mt-0.5 break-all font-mono text-[10px] text-white/35">{action.capabilityId} · {action.toolName || action.id}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[10px] font-bold">
                        <span className={`rounded-full px-2 py-1 ${action.executable ? 'bg-emerald-400/10 text-emerald-200' : 'bg-rose-400/10 text-rose-200'}`}>{action.executable ? copy.executable : copy.notExecutable}</span>
                        {action.requiresConfirmation && <span className="rounded-full bg-amber-400/10 px-2 py-1 text-amber-200">{copy.confirmationRequired}</span>}
                      </div>
                    </div>
                  )) : <p className="text-xs text-white/45">{copy.noneDeclared}</p>}
                </div>
              </div>

              {review.warnings.length > 0 && (
                <div className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-4">
                  <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-amber-200"><AlertTriangle size={13} />{copy.warnings}</p>
                  <div className="mt-2 space-y-1 text-xs leading-relaxed text-amber-100/65">{review.warnings.map(item => <p key={item}>{item}</p>)}</div>
                </div>
              )}

              <div className="flex justify-end">
                <button type="button" onClick={() => void activate()} disabled={activating} className="lumi-button-primary flex h-10 items-center gap-2 rounded-xl bg-emerald-300 px-4 text-xs font-black text-black disabled:opacity-40">
                  {activating ? <RefreshCw size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {activating ? copy.activating : copy.activateAction}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExternalCapabilityManagerSection({
  capabilities,
  loading,
  error,
  lang,
  canDeactivate = false,
  onRefresh,
}: {
  capabilities: ExternalCapabilityProjection[];
  loading: boolean;
  error: string;
  lang: 'en' | 'zh';
  canDeactivate?: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const copy = externalCapabilityCopy(lang);
  const [runningAction, setRunningAction] = useState('');
  const [deactivatingId, setDeactivatingId] = useState('');
  const executionRequests = useRef(new Map<string, ExternalCapabilityExecutionCorrelation>());
  const sorted = useMemo(() => [...capabilities].sort((a, b) => a.name.localeCompare(b.name)), [capabilities]);

  const runLaunch = async (capability: ExternalCapabilityProjection, actionId: string, requiresConfirmation: boolean) => {
    if (requiresConfirmation && !window.confirm(copy.launchConfirm(capability.name))) return;
    const key = `${capability.id}:${actionId}`;
    const correlation = executionRequests.current.get(key)
      || createExternalCapabilityExecutionCorrelation();
    executionRequests.current.set(key, correlation);
    setRunningAction(key);
    try {
      await executeExternalCapabilityAction(capability.id, actionId, {}, correlation);
      executionRequests.current.delete(key);
      toast.success(copy.launchCompleted(capability.name));
      await onRefresh();
    } catch (runError: any) {
      toast.error(runError?.message || copy.loadFailed);
    } finally {
      setRunningAction('');
    }
  };

  const deactivate = async (capability: ExternalCapabilityProjection) => {
    if (!window.confirm(copy.deactivationConfirm(capability.name))) return;
    setDeactivatingId(capability.id);
    try {
      await deactivateExternalCapability(capability.id);
      toast.success(copy.deactivated(capability.name));
      window.dispatchEvent(new CustomEvent('lumi:external-capabilities-changed'));
      await onRefresh();
    } catch (deactivateError: any) {
      toast.error(deactivateError?.message || copy.loadFailed);
    } finally {
      setDeactivatingId('');
    }
  };

  return (
    <div className="lumi-panel space-y-4 p-5" data-testid="external-capability-manager">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/15 bg-cyan-300/10 text-cyan-200"><ShieldCheck size={16} /></div>
          <div>
            <h4 className="text-sm font-black text-white/85">{copy.reviewedCapabilities}</h4>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">{copy.reviewedCapabilitiesDescription}</p>
          </div>
        </div>
        <button type="button" onClick={() => void onRefresh()} disabled={loading} className="lumi-icon-button h-8 w-8" title={copy.refresh}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {error && <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-xs text-amber-100/70">{error}</div>}
      {!loading && sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-white/40">{copy.noReviewedCapabilities}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sorted.map(capability => {
            const launch = getExternalCapabilityLaunchAction(capability);
            const ready = capability.availability === 'ready';
            return (
              <div key={`${capability.id}:${capability.version}`} className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h5 className="truncate text-sm font-bold text-white/85">{capability.name}</h5>
                    <p className="mt-1 font-mono text-[10px] text-white/35">{capability.id} · v{capability.version}</p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-black ${ready ? 'border-emerald-300/15 bg-emerald-300/10 text-emerald-200' : 'border-amber-300/15 bg-amber-300/10 text-amber-200'}`}>{externalCapabilityAvailabilityLabel(capability.availability, lang)}</span>
                </div>
                {capability.description && <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-white/50">{capability.description}</p>}
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold">
                  <span className="rounded-full border border-cyan-300/10 bg-cyan-300/[0.06] px-2 py-1 text-cyan-100/65">{externalCapabilityStageLabel(capability.stage, lang)}</span>
                  {capability.runtimeRefs.map(runtime => (
                    <span key={runtime.id} className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-1 text-white/50">
                      {[runtime.kind, runtime.provider].filter(Boolean).join(' · ')}
                    </span>
                  ))}
                  <span className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-1 text-white/50">{copy.actionCount(capability.actions.length)}</span>
                </div>
                {capability.unavailableReason && <p className="mt-3 text-[11px] leading-relaxed text-amber-100/60"><span className="font-bold">{copy.unavailableReason}:</span> {capability.unavailableReason}</p>}
                {capability.guidance.whenToUse.length > 0 && <p className="mt-3 text-[11px] leading-relaxed text-white/45"><span className="font-bold text-white/60">{copy.whenToUse}:</span> {capability.guidance.whenToUse.join(' · ')}</p>}
                {capability.guidance.steps.length > 0 && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-white/45"><span className="font-bold text-white/60">{copy.workflowSteps}:</span> {capability.guidance.steps.join(' → ')}</p>}
                {capability.guidance.completionRules.length > 0 && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-white/45"><span className="font-bold text-white/60">{copy.completionRules}:</span> {capability.guidance.completionRules.join(' · ')}</p>}
                <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
                  {capability.actions.map(action => (
                    <div key={action.id} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="min-w-0 truncate font-mono text-white/45">{action.label || action.id}</span>
                      <span className={`shrink-0 ${action.verification.status === 'verified' ? 'text-emerald-300' : action.verification.status === 'failed' ? 'text-rose-300' : 'text-white/35'}`}>
                        {externalCapabilityVerificationLabel(action.verification.status, lang)} · {copy.verifiedRuns(action.verification.verifiedRuns)}
                      </span>
                    </div>
                  ))}
                </div>
                {launch && (
                  <button type="button" onClick={() => void runLaunch(capability, launch.id, launch.requiresConfirmation)} disabled={runningAction === `${capability.id}:${launch.id}` || !ready || launch.availability !== 'ready'} className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.07] text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40">
                    {runningAction === `${capability.id}:${launch.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
                    {launch.label}
                  </button>
                )}
                {canDeactivate && (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void deactivate(capability)}
                      disabled={deactivatingId === capability.id}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-rose-300/10 bg-rose-300/[0.035] px-2 text-[10px] font-bold text-rose-200/65 transition-colors hover:bg-rose-300/[0.08] hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title={copy.deactivateAction}
                    >
                      {deactivatingId === capability.id ? <RefreshCw size={11} className="animate-spin" /> : <PowerOff size={11} />}
                      {deactivatingId === capability.id ? copy.deactivating : copy.deactivateAction}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
