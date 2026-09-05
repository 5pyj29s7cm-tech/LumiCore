import {
  classifyInternalExecutionIssue,
  type PublicExecutionIssue,
  type PublicExecutionLanguage,
} from '../../shared/public_execution_language';
import { CN_PUBLIC_AGENT_EVENT_MESSAGES } from '../regions/packs/cn/public_agent_event_messages';

export type CustomerVisibleExecutionEvent =
  | 'agent:progress'
  | 'agent:tool_call'
  | 'agent:tool';

export interface CustomerVisibleExecutionProjectionOptions {
  taskText?: unknown;
  language?: PublicExecutionLanguage;
}

type ExecutionPhase = 'working' | 'completed' | 'failed';
type ActionKind = 'inspect' | 'open' | 'write' | 'send' | 'remove' | 'generic';

const CUSTOMER_VISIBLE_EXECUTION_EVENTS = new Set<string>([
  'agent:progress',
  'agent:tool_call',
  'agent:tool',
]);

const HAS_OWN = Object.prototype.hasOwnProperty;

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return HAS_OWN.call(input, key);
}

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

function inferPhase(payload: Record<string, unknown>, event: string): ExecutionPhase {
  const status = String(payload.status ?? payload.phase ?? payload.state ?? '').trim().toLowerCase();
  if (
    (hasOwn(payload, 'error') && payload.error !== undefined && payload.error !== null)
    || /(?:fail|error|block|reject|timeout|cancel|mismatch|unavailable|unreachable|paused)/u.test(status)
  ) return 'failed';
  if (
    (hasOwn(payload, 'result') && payload.result !== undefined)
    || /(?:complete|success|verified|done)/u.test(status)
  ) return 'completed';
  return event === 'agent:progress' ? 'working' : 'working';
}

function inferActionKind(payload: Record<string, unknown>): ActionKind {
  const name = String(payload.name ?? payload.toolName ?? '').trim().toLowerCase();
  // Resource nouns (email/message) do not identify an operation. Match verb
  // tokens so read_email_attachments and recent_emails never claim a send,
  // and unrelated substrings such as "get" in "target" stay neutral.
  const tokens = new Set(name.split(/[^a-z0-9]+/u).filter(Boolean));
  const has = (...verbs: string[]) => verbs.some(verb => tokens.has(verb));
  if (has('read', 'list', 'search', 'find', 'get', 'inspect', 'status', 'info', 'capture', 'query', 'check', 'verify', 'recent')) return 'inspect';
  if (has('delete', 'remove', 'clear', 'cleanup', 'cancel')) return 'remove';
  if (has('send', 'publish', 'upload', 'notify', 'share')) return 'send';
  if (has('write', 'create', 'save', 'update', 'edit', 'replace', 'append', 'generate', 'export')) return 'write';
  if (has('open', 'show', 'navigate', 'focus', 'launch', 'activate')) return 'open';
  if (/(?:active_window|running_process)/u.test(name)) return 'inspect';
  return 'generic';
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
  return 'This step did not finish. You can retry it.';
}

function lifecycleText(
  phase: Exclude<ExecutionPhase, 'failed'>,
  kind: ActionKind,
  language: PublicExecutionLanguage,
): string {
  if (language === 'zh') {
    if (phase === 'completed') {
      return CN_PUBLIC_AGENT_EVENT_MESSAGES.completed[kind];
    }
    return CN_PUBLIC_AGENT_EVENT_MESSAGES.working[kind];
  }
  if (phase === 'completed') {
    if (kind === 'inspect') return 'The relevant information has been checked.';
    if (kind === 'open') return 'The requested content is open.';
    if (kind === 'write') return 'The content has been processed and saved.';
    if (kind === 'send') return 'The send operation is complete.';
    if (kind === 'remove') return 'The cleanup operation is complete.';
    return 'This step is complete.';
  }
  if (kind === 'inspect') return 'I am checking the relevant information.';
  if (kind === 'open') return 'I am opening the requested content.';
  if (kind === 'write') return 'I am processing and saving the content.';
  if (kind === 'send') return 'I am handling the send operation you approved.';
  if (kind === 'remove') return 'I am handling the cleanup operation you approved.';
  return 'I am working on this step.';
}

/**
 * Adds reviewed customer copy to non-terminal execution events while retaining
 * the complete machine payload for lifecycle tracking and diagnostics.
 * Customer copy is derived only from event phase and a coarse action category;
 * raw names, arguments, results, and errors are never interpolated.
 */
export function projectCustomerVisibleExecutionEvent<T extends Record<string, unknown>>(
  event: string,
  payload: T,
  options: CustomerVisibleExecutionProjectionOptions = {},
): T & { publicText?: string } {
  if (!CUSTOMER_VISIBLE_EXECUTION_EVENTS.has(event)) return { ...payload };
  const language = inferLanguage(payload, options);
  const phase = inferPhase(payload, event);
  const publicText = phase === 'failed'
    ? failureText(classifyInternalExecutionIssue(diagnosticSample(payload)), language)
    : lifecycleText(phase, inferActionKind(payload), language);
  return { ...payload, publicText };
}
