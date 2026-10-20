import {
  classifyInternalExecutionIssue,
  type PublicExecutionIssue,
  type PublicExecutionLanguage,
} from '../../shared/public_execution_language';
import { CN_PUBLIC_AGENT_EVENT_MESSAGES } from "../regions/messages/public_agent_event_messages";

export interface CustomerVisibleExecutionProjectionOptions {
  taskText?: unknown;
  language?: PublicExecutionLanguage;
}

type ExecutionPhase = 'working' | 'completed' | 'failed' | 'waiting_confirmation' | 'unknown_outcome';

const CUSTOMER_VISIBLE_EXECUTION_EVENTS = new Set<string>([
  'agent:progress',
  'agent:tool_call',
  'agent:tool',
]);

function inferLanguage(
  payload: Record<string, unknown>,
  options: CustomerVisibleExecutionProjectionOptions,
): PublicExecutionLanguage {
  if (options.language) return options.language;
  const sample = [
    options.taskText,
    payload.publicText,
    payload.text,
    payload.error,
    payload.result,
  ].map(value => String(value || '')).join('\n');
  return /[\u3400-\u9fff]/u.test(sample) ? 'zh' : 'en';
}

export function inferPhase(payload: Record<string, unknown>): ExecutionPhase {
  if (payload.phase === 'waiting_confirmation' || payload.phase === 'unknown_outcome') return payload.phase;
  if (payload.phase === 'forbidden') return 'failed';
  const status = String(payload.status ?? payload.phase ?? payload.state ?? '').trim().toLowerCase();
  if (
    (Object.hasOwn(payload, 'error') && payload.error !== undefined && payload.error !== null)
    || /(?:fail|error|block|reject|timeout|cancel|mismatch|unavailable|unreachable|paused)/u.test(status)
  ) return 'failed';
  if (
    (Object.hasOwn(payload, 'result') && payload.result !== undefined)
    || /(?:complete|success|verified|done)/u.test(status)
  ) return 'completed';
  return 'working';
}

function diagnosticSample(payload: Record<string, unknown>): string {
  return [
    payload.error,
    payload.reason,
    payload.status,
    payload.result,
    payload.text,
  ].map(value => String(value || '')).join('\n');
}

function failureText(issue: PublicExecutionIssue, language: PublicExecutionLanguage): string {
  if (language === 'zh') {
    if (issue === 'target_changed') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.targetChanged;
    if (issue === 'user_active') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.userActive;
    if (issue === 'desktop_busy') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.desktopBusy;
    if (issue === 'service_unavailable') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.serviceUnavailable;
    if (issue === 'timed_out') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.timedOut;
    if (issue === 'cancelled') return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.cancelled;
    return CN_PUBLIC_AGENT_EVENT_MESSAGES.failures.generic;
  }
  if (issue === 'target_changed') return 'The window no longer matched the target, so this step did not finish.';
  if (issue === 'user_active') return 'I paused this step because you are using the computer.';
  if (issue === 'desktop_busy') return 'The desktop is handling another operation. This step can be retried shortly.';
  if (issue === 'service_unavailable') return 'The operation service is currently unavailable, so this step did not finish.';
  if (issue === 'timed_out') return 'This step waited too long without a result and has stopped.';
  if (issue === 'cancelled') return 'This operation has stopped.';
  return 'This step did not finish.';
}

/**
 * Adds reviewed customer copy to non-terminal execution events while retaining
 * the complete machine payload for lifecycle tracking and diagnostics.
 * Customer copy is derived only from event phase;
 * raw names, arguments, results, and errors are never interpolated.
 */
export function projectCustomerVisibleExecutionEvent<T extends Record<string, unknown>>(
  event: string,
  payload: T,
  options: CustomerVisibleExecutionProjectionOptions = {},
): T & { publicText?: string } {
  if (!CUSTOMER_VISIBLE_EXECUTION_EVENTS.has(event)) return { ...payload };
  const language = inferLanguage(payload, options);
  const phase = inferPhase(payload);
  const publicText = phase === 'waiting_confirmation'
    ? language === 'zh' ? CN_PUBLIC_AGENT_EVENT_MESSAGES.waitingConfirmation : 'This step is waiting for your confirmation.'
    : phase === 'unknown_outcome'
      ? language === 'zh' ? CN_PUBLIC_AGENT_EVENT_MESSAGES.unknownOutcome : 'The outcome of this step has not been verified.'
    : phase === 'failed'
    ? failureText(classifyInternalExecutionIssue(diagnosticSample(payload)), language)
    : language === 'zh' ? CN_PUBLIC_AGENT_EVENT_MESSAGES[phase]
      : phase === 'completed' ? 'This step is complete.' : 'I am working on this step.';
  return { ...payload, publicText };
}
