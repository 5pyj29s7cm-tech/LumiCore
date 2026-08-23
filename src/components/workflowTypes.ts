export interface WorkflowStep {
  id: string;
  type: 'thinking' | 'background' | 'confirmation' | 'tool_start' | 'tool_result' | 'response' | 'error';
  text: string;
  time: number;
  detail?: string;
}

export type TaskCompletionFeedbackStatus =
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'working'
  | 'unknown';

export interface TaskCompletionFeedback {
  status: TaskCompletionFeedbackStatus;
  completed: string[];
  evidence: string[];
  incomplete: string[];
  blockers: string[];
  nextSteps: string[];
}

const TASK_COMPLETION_FEEDBACK_STATUSES = new Set<TaskCompletionFeedbackStatus>([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'working',
  'unknown',
]);

function feedbackItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 700))
    .filter(Boolean)))
    .slice(0, 20);
}

export function normalizeTaskCompletionFeedback(value: unknown): TaskCompletionFeedback | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawStatus = String(record.status || '').trim().toLowerCase() as TaskCompletionFeedbackStatus;
  const hasFeedbackShape = Boolean(rawStatus)
    || ['completed', 'evidence', 'incomplete', 'blockers', 'nextSteps'].some(key => Array.isArray(record[key]));
  if (!hasFeedbackShape) return undefined;
  return {
    status: TASK_COMPLETION_FEEDBACK_STATUSES.has(rawStatus) ? rawStatus : 'unknown',
    completed: feedbackItems(record.completed),
    evidence: feedbackItems(record.evidence),
    incomplete: feedbackItems(record.incomplete),
    blockers: feedbackItems(record.blockers),
    nextSteps: feedbackItems(record.nextSteps),
  };
}

export interface BackgroundWorkflowTask {
  id: string;
  title?: string;
  status: 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  workerNames?: string[];
  toolCallsCount?: number;
  error?: string;
  resultPreview?: string;
  updatedAt?: string;
  completionFeedback?: TaskCompletionFeedback;
}
