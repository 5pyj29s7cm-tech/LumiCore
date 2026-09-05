import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, CircleAlert, Loader2, ShieldAlert } from 'lucide-react';
import {
  customerVisibleTaskBlocker,
  customerVisibleTaskDetail,
  type WorkflowTask,
} from './workflowTypes';
import type { ConversationFocusThread } from '@/hooks/useFocusThreads';
import type { RuntimeTaskProjection, StructuredRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { uiMessage } from '@/i18n/uiMessages';
import type { Locale } from '@/i18n/runtime';
import { taskCompletionFeedbackCopy } from '@/i18n/locales/taskCompletionFeedback';

const ACTIVE_TASK_STATUSES = new Set(['created', 'planning', 'executing', 'verifying', 'waiting_confirmation']);
const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'pausing', 'cancelling']);

export interface ActiveTaskWidgetState {
  visible: boolean;
  title: string;
  detail: string;
  status: string;
  activeCount: number;
  receiptTotal: number;
  verifiedReceipts: number;
  failedReceipts: number;
}

function activeRuntimeTasks(status: StructuredRuntimeStatus | null): RuntimeTaskProjection[] {
  return (status?.tasks || []).filter(task => ACTIVE_TASK_STATUSES.has(task.status));
}

function activeFocusThreads(threads: ConversationFocusThread[] | undefined): ConversationFocusThread[] {
  return (threads || []).filter(thread => ACTIVE_TASK_STATUSES.has(thread.status));
}

function activeWorkflowTasks(tasks: WorkflowTask[] | undefined): WorkflowTask[] {
  return (tasks || []).filter(task => ACTIVE_WORKFLOW_STATUSES.has(task.status));
}

export function selectActiveTaskWidgetState(input: {
  status: StructuredRuntimeStatus | null;
  focusThreads: ConversationFocusThread[];
  tasks: WorkflowTask[];
  workflowActive: boolean;
  workflowStatus: string;
  progressText: string;
  fallbackTitle: string;
  locale?: Locale;
}): ActiveTaskWidgetState {
  const locale = input.locale || 'en';
  const runtimeTasks = activeRuntimeTasks(input.status);
  const threads = activeFocusThreads(input.focusThreads);
  const tasks = activeWorkflowTasks(input.tasks);
  const primaryRuntimeTask = runtimeTasks[0];
  const primaryThread = threads[0];
  const primaryWorkflowTask = tasks[0];
  const visible = Boolean(primaryRuntimeTask || primaryThread || primaryWorkflowTask || input.workflowActive);
  const status = primaryRuntimeTask?.status
    || primaryThread?.status
    || primaryWorkflowTask?.status
    || input.workflowStatus;
  const rawTitle = primaryRuntimeTask?.goal
    || primaryThread?.goal
    || primaryWorkflowTask?.title
    || input.fallbackTitle;
  const rawDetail = primaryRuntimeTask?.blocker
    || primaryThread?.waitingFor
    || primaryThread?.nextAction
    || primaryWorkflowTask?.error
    || primaryWorkflowTask?.completionFeedback?.blockers[0]
    || primaryWorkflowTask?.completionFeedback?.incomplete[0]
    || primaryWorkflowTask?.completionFeedback?.nextSteps[0]
    || input.progressText;
  const title = customerVisibleTaskDetail(rawTitle, locale, input.fallbackTitle);
  const detail = customerVisibleTaskBlocker(rawDetail, locale);
  const activeTaskIds = new Set([
    ...runtimeTasks.map(task => task.taskId),
    ...threads.map(thread => thread.taskId),
    ...tasks.map(task => task.id),
  ].filter(Boolean));
  const activeCount = Math.max(activeTaskIds.size, input.workflowActive ? 1 : 0);

  return {
    visible,
    title,
    detail,
    status,
    activeCount,
    receiptTotal: primaryRuntimeTask?.evidence.total || 0,
    verifiedReceipts: primaryRuntimeTask?.evidence.verified || 0,
    failedReceipts: (primaryRuntimeTask?.evidence.failed || 0) + (primaryRuntimeTask?.evidence.unknown || 0),
  };
}

function statusCopy(status: string, locale: Locale): string {
  if (status === 'waiting_confirmation') return uiMessage('command-center.waiting-confirmation.1640ac02bb', locale);
  if (status === 'created' || status === 'planning' || status === 'thinking') return uiMessage('focus-thread-panel.planning.46c9f7780c', locale);
  if (status === 'queued') return uiMessage('command-center.ready.4a09f2582b', locale);
  if (status === 'cancelling') return uiMessage('agent-chat-page.cancelling.7163e20e93', locale);
  return uiMessage('command-center.working.90f16b23a5', locale);
}

export function ActiveTaskWidget({
  status,
  focusThreads,
  tasks,
  workflowActive,
  workflowStatus,
  progressText,
  isZh,
}: {
  status: StructuredRuntimeStatus | null;
  focusThreads: ConversationFocusThread[];
  tasks: WorkflowTask[];
  workflowActive: boolean;
  workflowStatus: string;
  progressText: string;
  isZh: boolean;
}) {
  const locale: Locale = isZh ? 'zh' : 'en';
  const feedbackCopy = taskCompletionFeedbackCopy(locale);
  const view = selectActiveTaskWidgetState({
    status,
    focusThreads,
    tasks,
    workflowActive,
    workflowStatus,
    progressText,
    fallbackTitle: uiMessage('agent-chat-page.lumi-is-working.98a841ddde', locale),
    locale,
  });
  const waitingConfirmation = view.status === 'waiting_confirmation';
  const hasEvidenceProblem = view.failedReceipts > 0;
  const tone = waitingConfirmation
    ? 'border-amber-200/25 bg-[#171309]/88 shadow-[0_18px_55px_rgba(0,0,0,0.36),0_0_32px_rgba(251,191,36,0.08)]'
    : hasEvidenceProblem
      ? 'border-red-200/25 bg-[#180d10]/88 shadow-[0_18px_55px_rgba(0,0,0,0.36),0_0_32px_rgba(248,113,113,0.08)]'
      : 'border-cyan-200/18 bg-[#061019]/88 shadow-[0_18px_55px_rgba(0,0,0,0.36),0_0_32px_rgba(34,211,238,0.08)]';

  return (
    <AnimatePresence>
      {view.visible && (
        <motion.aside
          key="active-task-widget"
          initial={{ opacity: 0, y: 14, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
          className={`pointer-events-none absolute bottom-20 left-4 z-[44] w-[min(340px,calc(100%-2rem))] overflow-hidden rounded-2xl border p-3.5 backdrop-blur-2xl sm:left-5 ${tone}`}
          aria-live="polite"
          aria-label={uiMessage('command-center.tasks.1ddfd1ee9d', locale)}
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
              waitingConfirmation
                ? 'border-amber-200/20 bg-amber-300/10 text-amber-100'
                : hasEvidenceProblem
                  ? 'border-red-200/20 bg-red-300/10 text-red-100'
                  : 'border-cyan-200/18 bg-cyan-300/[0.08] text-cyan-100'
            }`}>
              {waitingConfirmation
                ? <ShieldAlert size={15} />
                : hasEvidenceProblem
                  ? <CircleAlert size={15} />
                  : <Loader2 size={15} className="animate-spin" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-black uppercase tracking-[0.2em] text-white/35">
                  {uiMessage('command-center.tasks.1ddfd1ee9d', locale)}
                </span>
                <span className={`rounded-full border px-1.5 py-0.5 text-[8px] font-black ${
                  waitingConfirmation
                    ? 'border-amber-200/18 bg-amber-300/10 text-amber-100/80'
                    : 'border-cyan-200/15 bg-cyan-300/[0.07] text-cyan-100/75'
                }`}>
                  {statusCopy(view.status, locale)}
                </span>
                {view.activeCount > 1 && (
                  <span className="text-[9px] font-bold text-white/28">+{view.activeCount - 1}</span>
                )}
              </div>
              <div className="mt-1 line-clamp-2 text-xs font-bold leading-relaxed text-white/82">
                {view.title}
              </div>
              {view.detail && (
                <div className={`mt-1 truncate text-[10px] ${waitingConfirmation ? 'text-amber-100/58' : 'text-white/40'}`} title={view.detail}>
                  {view.detail}
                </div>
              )}
            </div>
          </div>
          {view.receiptTotal > 0 && (
            <div className="mt-2.5 flex items-center gap-3 border-t border-white/[0.07] pt-2 text-[9px] text-white/32">
              {view.verifiedReceipts > 0 && (
                <span className="inline-flex items-center gap-1 text-emerald-100/60">
                  <CheckCircle2 size={10} />
                  {feedbackCopy.receipts} {view.verifiedReceipts}
                </span>
              )}
              {view.failedReceipts > 0 && (
                <span className="text-red-100/65">
                  {uiMessage('command-center.attention.c47451e86a', locale)} {view.failedReceipts}
                </span>
              )}
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
