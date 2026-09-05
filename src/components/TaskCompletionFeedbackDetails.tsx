import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  CircleDashed,
  ShieldAlert,
} from 'lucide-react';
import type { Locale } from '@/i18n/runtime';
import { taskCompletionFeedbackCopy } from '@/i18n/locales/taskCompletionFeedback';
import {
  normalizeTaskCompletionFeedback,
  projectTaskCompletionFeedbackForCustomer,
  type TaskCompletionFeedback,
} from './workflowTypes';

type FeedbackSectionKey = 'completed' | 'evidence' | 'incomplete' | 'blockers' | 'nextSteps';

const SECTION_STYLE: Record<FeedbackSectionKey, string> = {
  completed: 'border-emerald-300/12 bg-emerald-300/[0.045] text-emerald-100/78',
  evidence: 'border-cyan-300/12 bg-cyan-300/[0.045] text-cyan-100/76',
  incomplete: 'border-amber-300/12 bg-amber-300/[0.045] text-amber-100/75',
  blockers: 'border-rose-300/12 bg-rose-300/[0.045] text-rose-100/75',
  nextSteps: 'border-violet-300/12 bg-violet-300/[0.045] text-violet-100/75',
};

const SECTION_ICON = {
  completed: CheckCircle2,
  evidence: BadgeCheck,
  incomplete: CircleDashed,
  blockers: ShieldAlert,
  nextSteps: ArrowRight,
} satisfies Record<FeedbackSectionKey, typeof CheckCircle2>;

function statusTone(status: TaskCompletionFeedback['status']): string {
  if (status === 'completed') return 'border-emerald-200/20 bg-emerald-300/10 text-emerald-100/80';
  if (status === 'blocked' || status === 'failed') return 'border-rose-200/20 bg-rose-300/10 text-rose-100/80';
  if (status === 'cancelled') return 'border-white/10 bg-white/[0.04] text-white/48';
  if (status === 'working') return 'border-cyan-200/20 bg-cyan-300/[0.08] text-cyan-100/78';
  return 'border-amber-200/16 bg-amber-300/[0.06] text-amber-100/65';
}

function statusTextTone(status: TaskCompletionFeedback['status']): string {
  if (status === 'completed') return 'text-emerald-100/78';
  if (status === 'blocked' || status === 'failed') return 'text-rose-100/80';
  if (status === 'cancelled') return 'text-white/48';
  if (status === 'working') return 'text-cyan-100/78';
  return 'text-amber-100/65';
}

// i18n-allow: Multilingual execution-state recognition; not user-visible copy.
const CONFIRMATION_DETAIL_RE = /(?:confirm|confirmation|approval|approve|authorize|authorization|waiting[_\s-]*confirmation|确认|批准|授权|待确认|等待确认)/i;

function feedbackNeedsConfirmation(feedback: TaskCompletionFeedback): boolean {
  return [...feedback.blockers, ...feedback.incomplete, ...feedback.nextSteps]
    .some(item => CONFIRMATION_DETAIL_RE.test(item));
}

function ChatTaskCompletionFeedback({
  feedback,
  locale,
  className,
}: {
  feedback: TaskCompletionFeedback;
  locale: Locale;
  className: string;
}) {
  const copy = taskCompletionFeedbackCopy(locale);
  const waitingForConfirmation = feedbackNeedsConfirmation(feedback);
  const attention = waitingForConfirmation
    ? copy.confirmationHint
    : feedback.status === 'working'
      ? copy.workingHint
      : copy.attentionHint;
  const SummaryIcon = feedback.status === 'completed'
    ? CheckCircle2
    : feedback.status === 'blocked' || feedback.status === 'failed'
      ? ShieldAlert
      : CircleDashed;
  return (
    <div
      data-task-completion-feedback={feedback.status}
      data-task-feedback-presentation="chat-attention"
      className={`flex min-h-8 items-center gap-2 rounded-lg border border-white/[0.07] bg-black/10 px-2.5 py-1.5 text-[10px] text-white/52 ${className}`}
    >
      <SummaryIcon
        size={12}
        className={feedback.status === 'blocked' || feedback.status === 'failed'
          ? 'shrink-0 text-rose-200/75'
          : 'shrink-0 text-amber-100/65'}
      />
      <span className={`shrink-0 font-semibold ${statusTextTone(feedback.status)}`}>
        {waitingForConfirmation ? copy.awaitingConfirmation : copy.status[feedback.status]}
      </span>
      <span data-task-feedback-attention className="min-w-0 flex-1 truncate text-white/48">
        {attention}
      </span>
    </div>
  );
}

export function TaskCompletionFeedbackDetails({
  feedback,
  locale,
  compact = false,
  variant = 'default',
  className = '',
}: {
  feedback?: TaskCompletionFeedback | null;
  locale: Locale;
  compact?: boolean;
  variant?: 'default' | 'chat';
  className?: string;
}) {
  const normalizedInput = normalizeTaskCompletionFeedback(feedback);
  if (!normalizedInput) return null;
  if (variant === 'chat') {
    // A normal completed/cancelled task should read like an ordinary assistant
    // reply. Failed/blocked details are already present in the assistant's
    // natural-language reply, so reserve the inline disclosure for live work
    // or a confirmation that actually needs the user's attention.
    if (normalizedInput.status !== 'working' && !feedbackNeedsConfirmation(normalizedInput)) return null;
    return <ChatTaskCompletionFeedback feedback={normalizedInput} locale={locale} className={className} />;
  }
  const normalized = projectTaskCompletionFeedbackForCustomer(normalizedInput, locale);
  if (!normalized) return null;
  const copy = taskCompletionFeedbackCopy(locale);
  const sections: Array<{ key: FeedbackSectionKey; items: string[] }> = [
    { key: 'completed', items: normalized.completed },
    { key: 'evidence', items: normalized.evidence },
    { key: 'incomplete', items: normalized.incomplete },
    { key: 'blockers', items: normalized.blockers },
    { key: 'nextSteps', items: normalized.nextSteps },
  ];

  return (
    <section
      data-task-completion-feedback={normalized.status}
      aria-label={copy.title}
      className={`rounded-xl border border-white/[0.07] bg-black/15 ${compact ? 'p-2' : 'p-3'} ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.16em] text-white/38">{copy.title}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[8px] font-black uppercase ${statusTone(normalized.status)}`}>
          {copy.status[normalized.status]}
        </span>
      </div>
      <div className={`grid gap-1.5 ${compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
        {sections.map(section => {
          const Icon = SECTION_ICON[section.key];
          return (
            <div
              key={section.key}
              data-task-feedback-section={section.key}
              className={`min-w-0 rounded-lg border px-2.5 py-2 ${SECTION_STYLE[section.key]}`}
            >
              <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.12em]">
                <Icon size={11} className="shrink-0" />
                <span>{copy[section.key]}</span>
                <span className="ml-auto font-mono opacity-55">{section.items.length}</span>
              </div>
              {section.items.length > 0 ? (
                <ul className="mt-1.5 space-y-1 text-[10px] leading-4 text-white/58">
                  {section.items.map((item, index) => (
                    <li key={`${section.key}-${index}`} className="flex min-w-0 gap-1.5">
                      <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
                      <span className="min-w-0 break-words">{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[10px] leading-4 text-white/28">{copy.empty[section.key]}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
