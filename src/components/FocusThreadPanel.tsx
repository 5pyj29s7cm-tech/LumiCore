import React from 'react';
import { CheckCircle2, CirclePause, Clock3, Crosshair, ShieldAlert } from 'lucide-react';
import { formatUiMessage, uiMessage } from '@/i18n/uiMessages';
import type { ConversationFocusThread, FocusThreadStatus } from '@/hooks/useFocusThreads';

function statusCopy(status: FocusThreadStatus): string {
  switch (status) {
    case 'planning':
      return uiMessage('focus-thread-panel.planning.46c9f7780c');
    case 'executing':
      return uiMessage('focus-thread-panel.executing.76b91cbb06');
    case 'waiting_confirmation':
      return uiMessage('focus-thread-panel.waiting-confirmation.266caeaec0');
    case 'blocked':
      return uiMessage('focus-thread-panel.blocked.d42294315f');
    case 'completed':
      return uiMessage('focus-thread-panel.completed.d824a8a52c');
    case 'cancelled':
      return uiMessage('focus-thread-panel.cancelled.2c1db96e4c');
  }
}

function statusClass(status: FocusThreadStatus): string {
  if (status === 'waiting_confirmation') return 'border-amber-300/20 bg-amber-300/10 text-amber-100';
  if (status === 'blocked') return 'border-red-300/20 bg-red-300/10 text-red-100';
  if (status === 'completed') return 'border-emerald-300/20 bg-emerald-300/10 text-emerald-100';
  if (status === 'cancelled') return 'border-white/10 bg-white/[0.04] text-white/45';
  return 'border-cyan-300/20 bg-cyan-300/10 text-cyan-100';
}

function StatusIcon({ status }: { status: FocusThreadStatus }) {
  if (status === 'waiting_confirmation') return <ShieldAlert size={13} className="text-amber-200" />;
  if (status === 'blocked' || status === 'cancelled') return <CirclePause size={13} className="text-red-200" />;
  if (status === 'completed') return <CheckCircle2 size={13} className="text-emerald-200" />;
  return <Crosshair size={13} className="text-cyan-200" />;
}

function waitingCopy(value: string): string {
  return value === 'user_confirmation'
    ? uiMessage('focus-thread-panel.user-confirmation.00a5dd69ad')
    : value;
}

function FocusThreadCard({ thread, compact = false }: { thread: ConversationFocusThread; compact?: boolean }) {
  const nextDetail = thread.waitingFor
    ? `${uiMessage('focus-thread-panel.waiting-for.52c50d0b29')}: ${waitingCopy(thread.waitingFor)}`
    : thread.nextAction
      ? `${uiMessage('focus-thread-panel.next-action.c19d64b6d0')}: ${thread.nextAction}`
      : thread.resumePoint
        ? `${uiMessage('focus-thread-panel.resume-point.f54de8a76a')}: ${thread.resumePoint}`
        : '';
  const dateLocale = uiMessage('focus-thread-panel.date-locale.43f735d2f1');

  return (
    <div className={`rounded-xl border border-white/10 bg-white/[0.035] ${compact ? 'px-3 py-2' : 'px-3 py-2.5'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={thread.status} />
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-white/85">
          {thread.commitment || thread.goal}
        </span>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide ${statusClass(thread.status)}`}>
          {statusCopy(thread.status)}
        </span>
      </div>
      {nextDetail && (
        <div className="mt-1 truncate pl-5 text-[11px] text-white/52" title={nextDetail}>
          {nextDetail}
        </div>
      )}
      {!compact && (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 pl-5 text-[9px] text-white/30">
          <span className="truncate font-mono" title={thread.evidenceTaskId}>
            {uiMessage('focus-thread-panel.evidence-task.40d66a3a28')}: {thread.evidenceTaskId}
          </span>
          <span className="shrink-0">·</span>
          <span className="flex shrink-0 items-center gap-1">
            <Clock3 size={9} />
            {new Date(thread.updatedAt).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}
    </div>
  );
}

export function FocusThreadPanel({
  threads,
  loading = false,
  variant = 'panel',
}: {
  threads: ConversationFocusThread[];
  loading?: boolean;
  variant?: 'panel' | 'strip';
}) {
  if (threads.length === 0) return null;
  const visibleThreads = threads.slice(0, 3);

  if (variant === 'strip') {
    const primary = visibleThreads[0];
    return (
      <details className="group border-b border-white/10 bg-cyan-300/[0.035] px-4 py-2 md:px-6">
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
          <Crosshair size={13} className="shrink-0 text-cyan-200" />
          <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-cyan-100/65">
            {uiMessage('focus-thread-panel.active-focus.09d8da7b70')}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-white/65">
            {primary.commitment || primary.goal}
          </span>
          <span className="shrink-0 text-[10px] text-white/35">
            {formatUiMessage('focus-thread-panel.active-count.9f970d5ccb', { count: threads.length })}
          </span>
        </summary>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {visibleThreads.map(thread => <FocusThreadCard key={thread.threadId} thread={thread} />)}
        </div>
      </details>
    );
  }

  return (
    <section className="space-y-2" aria-label={uiMessage('focus-thread-panel.active-focus.09d8da7b70')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-100/65">
          <Crosshair size={12} />
          {uiMessage('focus-thread-panel.active-focus.09d8da7b70')}
        </div>
        <span className="text-[9px] text-white/30">
          {loading
            ? uiMessage('focus-thread-panel.syncing.b0915c9901')
            : formatUiMessage('focus-thread-panel.active-count.9f970d5ccb', { count: threads.length })}
        </span>
      </div>
      {visibleThreads.map(thread => <FocusThreadCard key={thread.threadId} thread={thread} compact />)}
    </section>
  );
}
