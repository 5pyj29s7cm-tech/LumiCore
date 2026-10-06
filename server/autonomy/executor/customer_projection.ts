import type { TaskCompletionFeedback } from "../../cognition/acceptance_evidence";
import { containsInternalExecutionLanguage, sanitizePublicExecutionText, type PublicExecutionLanguage } from "../../../shared/public_execution_language";
import { CN_AUTONOMOUS_CUSTOMER_MESSAGES } from "../../regions/messages/autonomous_customer_messages";

// A task record keeps the original exception, recovery diagnosis, receipts,
// and tool ledger for durable recovery. Socket clients receive only this
// compact projection; none of those machine fields belongs in customer copy.
// i18n-allow -- recognition only; mapped to the localized copy below.
const AUTONOMOUS_MACHINE_DETAIL_RE = /(?:\b(?:receipt|terminalVerification|verificationStatus|requestId|taskId|idempotencyKey|target_mismatch|execution_recovery_incomplete)\b|\b(?:desktop|web|url|write|read|extract|work_product|adapter_registry|self_improvement|client|system)_[a-z0-9_]+\b|No successful (?:current-turn )?tool execution|Missing (?:core|verified|current-turn|desktop|client|action) evidence)/iu;

export function inferAutonomousPublicLanguage(value: unknown): PublicExecutionLanguage {
  return /[\u3400-\u9fff]/u.test(String(value || '')) ? 'zh' : 'en';
}

function autonomousFallbackText(
  language: PublicExecutionLanguage,
  state: 'completed' | 'failed' | 'retrying' | 'cancelled',
): string {
  if (language === 'zh') {
    if (state === 'completed') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.completed;
    if (state === 'retrying') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.retrying;
    if (state === 'cancelled') return CN_AUTONOMOUS_CUSTOMER_MESSAGES.cancelled;
    return CN_AUTONOMOUS_CUSTOMER_MESSAGES.failed;
  }
  if (state === 'completed') return 'This autonomous task is complete.';
  if (state === 'retrying') return 'This autonomous task has not finished yet. I kept its progress and will try again later.';
  if (state === 'cancelled') return 'This autonomous task was stopped.';
  return 'This autonomous task did not finish. You can ask me to retry later.';
}

export function projectAutonomousCustomerMessage(
  value: unknown,
  options: {
    language?: PublicExecutionLanguage;
    state: 'completed' | 'failed' | 'retrying' | 'cancelled';
    preserveCleanText?: boolean;
  },
): string {
  const raw = String(value || '').trim();
  const language = options.language || inferAutonomousPublicLanguage(raw);
  const projected = sanitizePublicExecutionText(raw, language);
  const wasInternal = containsInternalExecutionLanguage(raw);
  if (
    projected
    && !AUTONOMOUS_MACHINE_DETAIL_RE.test(projected)
    && (wasInternal || options.preserveCleanText === true)
  ) {
    return projected;
  }
  return autonomousFallbackText(language, options.state);
}

export function projectAutonomousCompletionFeedback(
  feedback: TaskCompletionFeedback,
): TaskCompletionFeedback {
  // The detailed receipt-backed feedback remains on the durable task. The
  // public event needs only its semantic status; result/error already carries
  // the single customer-facing sentence.
  return {
    status: feedback.status,
    completed: [],
    evidence: [],
    incomplete: [],
    blockers: [],
    nextSteps: [],
  };
}
