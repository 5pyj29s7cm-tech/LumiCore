import { canonicalJson } from '../../../shared/stable_json';
import { promptBlockMessage } from "../prompt_blocks";
import type { ToolRegistry } from "../../tools/registry";
import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { NormalizedMessage } from "../providers";
import { buildActionEvidenceContract, formatActionContractPrompt } from "../../cognition/action_contract";
import { buildConfirmedStepContinuationNote } from "../../cognition/task_execution_ledger";
import { getArtifactTaskProgress } from "../../cognition/action_contract";
import { formatToolRecordForModel } from './receipts';
import { hasCompletedCoreAction } from './projection';
import { buildArtifactProgressPrompt } from './artifacts';

export const MAX_IDENTICAL_RECOVERY_RETRIES = 1;

export const MAX_TOOL_RECOVERY_REPLANS = 1;

export const MAX_VERIFICATION_OBLIGATION_REPLANS = 1;

export const TRANSIENT_TOOL_FAILURE_RE = /\b(?:timeout|timed[ -]?out|temporar(?:y|ily)|rate[ -]?limit|too many requests|service unavailable|try again|busy|network|connection|socket|stream|econnreset|econnrefused|etimedout|eai_again|429|502|503|504)\b/i;

/**
 * Reconstruct the exact confirmed call as normal assistant/tool history. This
 * keeps the adapter output in the tool-output trust boundary while allowing
 * every provider to reason from the canonical receipt. The trailing system
 * policy tells the model to assess the whole goal without replaying the
 * consumed side effect.
 */
export function buildConfirmedStepContinuationMessages(
  goal: string,
  record: ToolExecutionRecord,
  acceptedSource?: {
    messageId: string;
    text: string;
  },
): NormalizedMessage[] {
  const toolCallId = String(record.id || `confirmed_${Date.now().toString(36)}`);
  const sourceMessageId = String(acceptedSource?.messageId || '').trim();
  const sourceText = String(acceptedSource?.text || '').trim();
  return [
    // The original task is runtime-owned continuation context. It must not be
    // attributed to the newly accepted confirmation transcript row.
    { role: 'user', content: String(goal || '').trim() },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: toolCallId,
        name: record.name,
        arguments: record.arguments || {},
      }],
    },
    {
      role: 'tool',
      toolCallId,
      name: record.name,
      content: formatToolRecordForModel(record),
    },
    ...(sourceMessageId && sourceText ? [{
      role: 'user' as const,
      content: sourceText,
      sourceMessageId,
    }] : []),
    promptBlockMessage({ id: 'confirmed-step-receipt', kind: 'receipt', authority: 'server',
      required: true, content: buildConfirmedStepContinuationNote(record) }),
  ];
}

export function toolCallSignature(call: Pick<ToolExecutionRecord, 'name' | 'arguments'>): string {
  return `${call.name}\u0000${canonicalJson(call.arguments || {})}`;
}

export function withoutRuntimeOwnedRecoveryCall(context?: ToolContext): ToolContext | undefined {
  if (!context?.runtimeOwnedDeterministicRecoveryCall) return context;
  const { runtimeOwnedDeterministicRecoveryCall: _runtimePrivate, ...toolContext } = context;
  return toolContext;
}

export function isVerifiedToolSuccess(record: ToolExecutionRecord | undefined): boolean {
  return Boolean(
    record
    && !record.error
    && record.terminalVerification?.status === 'verified',
  );
}

export function isSafeReadOnlyRetry(record: ToolExecutionRecord | undefined): boolean {
  if (!record?.capability) return false;
  if (record.capability.operation !== 'observe' && record.capability.operation !== 'test') return false;
  return record.capability.sideEffects.every(effect => (
    effect.type === 'none'
    || effect.type === 'local_read'
    || effect.type === 'network_read'
  ));
}

export function isRetryableToolOutcome(record: ToolExecutionRecord | undefined): boolean {
  if (!record || !isSafeReadOnlyRetry(record)) return false;
  if (record.terminalVerification?.status === 'unverified') return true;
  const detail = `${record.error || ''} ${record.terminalVerification?.reason || ''}`;
  return record.terminalVerification?.status === 'failed' && TRANSIENT_TOOL_FAILURE_RE.test(detail);
}

export function shouldSuppressConfirmedReplay(record: ToolExecutionRecord | undefined): boolean {
  if (!record || isSafeReadOnlyRetry(record)) return false;
  // A conclusive preflight failure did not cross the adapter boundary, so the
  // normal policy/recovery loop may propose the call again. Once a mutation or
  // unknown-effect tool started, however, its confirmed receipt is immutable
  // commit-state evidence and the exact call must be reconciled, not replayed.
  if (
    record.adapterStarted === false
    && (Boolean(record.error) || record.terminalVerification?.status === 'failed')
  ) return false;
  return true;
}

export function hasUnverifiedToolOutcome(records: ToolExecutionRecord[]): boolean {
  return records.some(record => (
    Boolean(record.error)
    || record.terminalVerification?.status === 'failed'
    || record.terminalVerification?.status === 'unverified'
  ));
}

export function buildToolRecoveryReplanPrompt(reason: string): string {
  return [
    'Tool recovery required:',
    reason,
    'Do not stop with an explanation of the failure and do not claim completion.',
    'Re-plan from the original user goal now. Prefer a different declared fallback or verification capability. Repeat an identical call only when the prior outcome was transient/unverified, the capability is read-only, and its bounded retry budget remains.',
    'If no safe executable route exists, preserve the receipts and report the exact blocker without asking the user to repeat information already present.',
  ].join('\n');
}

export function hasPendingVerificationObligation(
  task: string,
  records: ToolExecutionRecord[],
  context?: ToolContext,
): boolean {
  const contract = buildActionEvidenceContract(task, undefined, context?.acceptedActionContract);
  if (!contract.applies || records.length === 0 || hasCompletedCoreAction(task, records, context)) return false;
  return records.some(record => (
    !record.error
    && record.terminalVerification?.status === 'verified'
    && record.capability?.operation !== 'observe'
    && record.capability?.operation !== 'test'
  ));
}

export function buildMissingVerificationObligationPrompt(
  task: string,
  records: ToolExecutionRecord[],
  registry: ToolRegistry,
  exposedToolNames: Set<string>,
  policy?: ToolContext['toolPolicy'],
  context?: ToolContext,
): string {
  const contract = buildActionEvidenceContract(task, undefined, context?.acceptedActionContract);
  if (!hasPendingVerificationObligation(task, records, context)) return '';
  const artifactProgress = getArtifactTaskProgress(task, records, { requestId: context?.requestId, taskId: context?.taskId });
  if (artifactProgress && !artifactProgress.complete) return 'Declarative verification obligation:\n'
    + buildArtifactProgressPrompt(task, records, { requestId: context?.requestId, taskId: context?.taskId });
  const verificationCapabilities = registry.getCapabilityManifest(policy, {
    executableOnly: true,
    context,
  })
    .filter(entry => (
      exposedToolNames.has(entry.toolName)
      && (entry.operation === 'observe' || entry.operation === 'test')
    ))
    .slice(0, 12)
    .map(entry => `${entry.toolName} (${entry.capabilityId}; ${entry.verification.strategy})`);
  return [
    'Declarative verification obligation:',
    formatActionContractPrompt(contract),
    'The current verified capability receipts do not yet satisfy the whole action contract.',
    verificationCapabilities.length
      ? `Currently declared observation/test capabilities: ${verificationCapabilities.join('; ')}.`
      : 'No declared observation/test capability is currently exposed.',
    'Choose the declared capability that best supplies the missing evidence, or state a real blocker if none can. Do not repeat a verified mutation, and do not claim completion yet.',
  ].filter(Boolean).join('\n');
}
