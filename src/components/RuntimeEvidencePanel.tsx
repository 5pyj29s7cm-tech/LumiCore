import React from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, ShieldCheck, XCircle } from 'lucide-react';
import type { RuntimeEvidenceReceipt, RuntimeTaskProjection, StructuredRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { runtimeStatusCopy } from '@/i18n/locales/runtimeStatus';
import { getLocale, type Locale } from '@/i18n/runtime';
import { sanitizeAgentResponseTextForDisplay } from '@/lib/agentResponseDelivery';
import {
  customerVisibleTaskBlocker,
  customerVisibleTaskDetail,
  customerVisibleTaskNextAction,
  customerVisibleTaskStatus,
} from './workflowTypes';

function levelClass(level: StructuredRuntimeStatus['level']): string {
  if (level === 'attention') return 'border-amber-300/20 bg-amber-300/[0.06] text-amber-100';
  if (level === 'working') return 'border-cyan-300/20 bg-cyan-300/[0.06] text-cyan-100';
  return 'border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-100';
}

function LevelIcon({ level }: { level: StructuredRuntimeStatus['level'] }) {
  if (level === 'attention') return <AlertTriangle size={14} className="text-amber-200" />;
  if (level === 'working') return <Activity size={14} className="animate-pulse text-cyan-200" />;
  return <CheckCircle2 size={14} className="text-emerald-200" />;
}

function levelLabel(status: StructuredRuntimeStatus) {
  const copy = runtimeStatusCopy();
  return status.level === 'attention' ? copy.attention : status.level === 'working' ? copy.working : copy.ready;
}

function reasonLabel(reason: string, locale: Locale): string {
  const copy = runtimeStatusCopy(locale);
  if (reason === 'waiting_confirmation') return copy.reasonWaiting;
  if (reason === 'blocked_task') return copy.reasonBlocked;
  if (reason === 'failed_receipt') return copy.reasonFailed;
  if (reason === 'unknown_or_unverified_outcome') return copy.reasonUnknown;
  if (reason === 'durable_work_blocked') return copy.reasonDurableBlocked;
  return copy.reasonUnknown;
}

function receiptClass(receipt: RuntimeEvidenceReceipt): string {
  if (receipt.outcome === 'verified_success' && receipt.verification === 'verified') return 'text-emerald-200';
  if (receipt.outcome === 'waiting_confirmation') return 'text-amber-200';
  if (receipt.outcome === 'unknown_outcome' || receipt.outcome === 'timeout' || receipt.outcome === 'target_mismatch') return 'text-orange-200';
  return 'text-red-200';
}

export function runtimeReceiptPublicText(receipt: RuntimeEvidenceReceipt, locale: Locale): string {
  const copy = runtimeStatusCopy(locale);
  if (receipt.outcome === 'verified_success' && receipt.verification === 'verified') return copy.verified;
  if (receipt.outcome === 'waiting_confirmation') return copy.reasonWaiting;
  if (receipt.outcome === 'target_mismatch') {
    return sanitizeAgentResponseTextForDisplay(receipt.outcome, locale);
  }
  if (receipt.outcome === 'unknown_outcome' || receipt.outcome === 'timeout') return copy.reasonUnknown;
  return copy.reasonFailed;
}

function ReceiptLine({ receipt, locale }: { receipt: RuntimeEvidenceReceipt; locale: Locale }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-black/20 px-2.5 py-2 text-[10px]">
      {receipt.verification === 'verified'
        ? <CheckCircle2 size={11} className="shrink-0 text-emerald-200" />
        : receipt.verification === 'failed'
          ? <XCircle size={11} className="shrink-0 text-red-200" />
          : <Clock3 size={11} className="shrink-0 text-amber-200" />}
      <span className={`min-w-0 flex-1 truncate ${receiptClass(receipt)}`}>
        {runtimeReceiptPublicText(receipt, locale)}
      </span>
    </div>
  );
}

function TaskEvidence({ task, compact = false, locale }: { task: RuntimeTaskProjection; compact?: boolean; locale: Locale }) {
  const copy = runtimeStatusCopy(locale);
  const latest = compact ? task.evidence.latest.slice(0, 1) : task.evidence.latest;
  const goal = customerVisibleTaskDetail(task.goal, locale, copy.task);
  const nextAction = customerVisibleTaskNextAction(task.focus.nextAction, locale);
  const blocker = customerVisibleTaskBlocker(task.blocker, locale);
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-white/82">{goal}</span>
        <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-black uppercase text-white/45">
          {customerVisibleTaskStatus(task.status, locale)}
        </span>
      </div>
      {!compact && (
        <div className="mt-1.5 grid gap-1 text-[10px] text-white/38">
          {nextAction && <div className="truncate"><span className="text-white/25">{copy.next}: </span>{nextAction}</div>}
          {blocker && <div className="truncate text-amber-100/70"><span className="text-white/25">{copy.blocker}: </span>{blocker}</div>}
        </div>
      )}
      <div className="mt-2 space-y-1.5">
        {latest.length > 0
          ? latest.map(receipt => <ReceiptLine key={receipt.receiptId} receipt={receipt} locale={locale} />)
          : <div className="rounded-lg bg-black/15 px-2.5 py-2 text-[10px] text-white/28">{copy.noEvidence}</div>}
      </div>
    </article>
  );
}

export function RuntimeEvidencePanel({
  status,
  loading = false,
  error = '',
  variant = 'full',
}: {
  status: StructuredRuntimeStatus | null;
  loading?: boolean;
  error?: string;
  variant?: 'compact' | 'full';
}) {
  const locale = getLocale();
  const copy = runtimeStatusCopy(locale);
  if (!status) {
    if (!loading && !error) return null;
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2 text-xs text-white/40">
        {loading ? copy.syncing : copy.unavailable}
      </section>
    );
  }
  const activeTasks = status.tasks.filter(task => ['created', 'planning', 'executing', 'verifying', 'waiting_confirmation', 'blocked'].includes(task.status));
  const visibleTasks = (variant === 'compact' ? activeTasks.slice(0, 1) : status.tasks.slice(0, 8));

  return (
    <section className={`rounded-xl border p-3 ${levelClass(status.level)}`}>
      <div className="flex min-w-0 items-center gap-2">
        <LevelIcon level={status.level} />
        <span className="text-[10px] font-black uppercase tracking-widest">{copy.title}</span>
        <span className="rounded-md border border-current/15 bg-black/10 px-1.5 py-0.5 text-[9px] font-black uppercase">{levelLabel(status)}</span>
        <span className="min-w-0 flex-1" />
      </div>

      <div className={`mt-3 grid gap-2 ${variant === 'compact' ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7'}`}>
        {[
          [copy.active, status.counts.activeTasks],
          [copy.waiting, status.counts.waitingConfirmation],
          [copy.blocked, status.counts.blockedTasks + status.counts.durableBlocked],
          ...(variant === 'full' ? [
            [copy.verified, status.counts.verifiedReceipts],
            [copy.failed, status.counts.failedReceipts],
            [copy.background, status.counts.backgroundActive],
            [copy.autonomous, status.counts.autonomousActive],
          ] : []),
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg bg-black/15 px-2 py-2 text-center">
            <div className="text-base font-black text-white/85">{value}</div>
            <div className="mt-0.5 truncate text-[8px] font-bold uppercase tracking-wide text-white/35">{label}</div>
          </div>
        ))}
      </div>

      {status.attentionReasons.length > 0 && (
        <div className="mt-3 space-y-1">
          {status.attentionReasons.map(reason => (
            <div key={reason} className="flex items-center gap-2 text-[10px] text-amber-50/70">
              <AlertTriangle size={10} className="shrink-0" />
              {reasonLabel(reason, locale)}
            </div>
          ))}
        </div>
      )}

      {visibleTasks.length > 0 && (
        <div className="mt-3 space-y-2">
          {visibleTasks.map(task => <TaskEvidence key={task.taskId} task={task} compact={variant === 'compact'} locale={locale} />)}
        </div>
      )}

      {variant === 'full' && (
        <div className="mt-3 rounded-xl border border-white/8 bg-black/15 p-3">
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-white/50">
            <ShieldCheck size={12} />
            {copy.safety}
          </div>
          <div className="mt-2 grid gap-1.5 text-[10px] text-white/38 md:grid-cols-2">
            <div>{copy.externalConfirmation}</div>
            <div>{copy.unknownReplay}</div>
            <div>{copy.legacyFallback}</div>
            <div>{copy.payloadsExcluded}</div>
          </div>
        </div>
      )}
    </section>
  );
}
