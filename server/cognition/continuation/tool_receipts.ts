import { toolRecordSucceeded } from "../task_execution_ledger";
import type { ToolExecutionRecord } from "../../tools/types";
import type { ToolRecordTaskDurability, ActionContinuationHistoryItem } from './contracts';
import { toolCallName, compact, toolCallResult, toolCallArguments, parseToolCalls, collectPathValues } from './history_values';

/**
 * Durable conversation state follows the capability contract selected by the
 * model, not the wording or name of a tool. Pure reads remain ordinary turn
 * evidence; mutations and any persistent/external side effect may own a task
 * pointer. Legacy records without a capability snapshot stay unknown so a
 * migration caller can handle them explicitly.
 */
export function classifyToolRecordTaskDurability(
  record: Pick<import("../../tools/types").ToolExecutionRecord, 'capability'>,
): ToolRecordTaskDurability {
  const capability = record?.capability;
  if (!capability || !Array.isArray(capability.sideEffects)) return 'unknown';
  const safeObservationEffects = capability.sideEffects.every(effect => (
    effect.type === 'none'
    || effect.type === 'local_read'
    || effect.type === 'network_read'
  ));
  if (
    (capability.operation === 'observe' || capability.operation === 'test')
    && safeObservationEffects
  ) return 'observation_only';
  if (
    capability.operation === 'mutate'
    || capability.operation === 'create'
    || capability.operation === 'communicate'
    || !safeObservationEffects
  ) return 'durable';
  return 'unknown';
}

export function toolCallFailure(call: any): string {
  const name = toolCallName(call);
  const explicitError = compact(call?.error, 260);
  if (explicitError) return `${name || 'tool'}: ${explicitError}`;

  const result = toolCallResult(call);
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, any>
    : null;
  const verification = payload?.verification && typeof payload.verification === 'object'
    ? payload.verification as Record<string, any>
    : {};
  const status = compact(
    payload?.status
      || payload?.verificationStatus
      || verification.status
      || call?.status,
    120,
  ).toLowerCase();
  const raw = compact(typeof result === 'string' ? result : JSON.stringify(result || ''), 320);
  const incompleteStatus = /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|incomplete|needs_confirmation|not_ready|partial|pending|queued|requires_confirmation|requires_setup|submitted_unverified|unverified)$/i;
  const structuredFailure = Boolean(payload && (
    payload.ok === false
    || payload.success === false
    || payload.sent === false
    || payload.opened === false
    || payload.saved === false
    || payload.targetMatched === false
    || payload.failed === true
    || payload.completed === false
    || payload.verified === false
    || payload.completionMarkerExists === false
    || payload.requiresConfirmation === true
    || payload.confirmationRequired === true
    || incompleteStatus.test(status)
    || compact(payload.error || verification.error, 260)
  ));
  if (
    structuredFailure
    || incompleteStatus.test(status)
    || /requires? (?:user )?confirmation|timed out|permission denied|not allowed|outside (?:the )?allowed|forbidden|(?:^|\b)(?:failed|error|blocked)(?:\b|:)/i.test(raw)
  ) {
    const detail = compact(
      payload?.error
      || payload?.reason
      || payload?.blocker
      || payload?.verificationReason
      || verification.error
      || verification.reason
      || status
      || raw,
      320,
    );
    return `${name || 'tool'}: ${detail}`.slice(0, 380);
  }
  return '';
}

export function toolCallSucceeded(call: any): boolean {
  const name = toolCallName(call);
  if (!name) return false;
  const result = typeof call?.result === 'string'
    ? call.result
    : JSON.stringify(call?.result ?? '');
  return toolRecordSucceeded({
    id: compact(call?.id, 180),
    name,
    arguments: toolCallArguments(call),
    result,
    ...(call?.receipt !== undefined ? { receipt: call.receipt } : {}),
    error: compact(call?.error, 700) || undefined,
    ...(call?.terminalVerification && typeof call.terminalVerification === 'object'
      ? { terminalVerification: call.terminalVerification }
      : {}),
    ...(call?.capability && typeof call.capability === 'object'
      ? { capability: call.capability }
      : {}),
  } as ToolExecutionRecord);
}

export function summarizeToolCalls(history: ActionContinuationHistoryItem[]): string[] {
  const summaries: string[] = [];
  for (const item of history.slice(-12)) {
    for (const call of parseToolCalls(item).slice(-10)) {
      const name = toolCallName(call);
      if (!name) continue;
      const result = toolCallResult(call);
      const resultObject = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, any>
        : {};
      const liveResult = resultObject.result && typeof resultObject.result === 'object'
        ? resultObject.result as Record<string, any>
        : resultObject;
      const verification = liveResult.verification && typeof liveResult.verification === 'object'
        ? liveResult.verification as Record<string, any>
        : resultObject.verification && typeof resultObject.verification === 'object'
          ? resultObject.verification as Record<string, any>
          : {};
      const status = compact(
        call?.error
        || resultObject.status
        || call?.terminalVerification?.status
        || verification.status
        || call?.status
        || '',
        120,
      );
      const args = toolCallArguments(call);
      const paths = new Set<string>();
      collectPathValues(args, paths);
      collectPathValues(result, paths);
      const resultEvidence = Array.isArray(result)
        ? [
            `items=${result.length}`,
            result.length
              ? `sample=${result.slice(0, 5)
                  .map(entry => compact(
                    (entry as any)?.label
                      || (entry as any)?.name
                      || (entry as any)?.appName
                      || (entry as any)?.title,
                    80,
                  ))
                  .filter(Boolean)
                  .join(' | ')}`
              : '',
          ].filter(Boolean).join(' | ')
        : '';
      summaries.push([
        name,
        status ? `status=${status}` : '',
        args.action || liveResult.action ? `action=${compact(args.action || liveResult.action, 100)}` : '',
        args.target || liveResult.target ? `target=${compact(args.target || liveResult.target, 100)}` : '',
        args.section || liveResult.section ? `section=${compact(args.section || liveResult.section, 100)}` : '',
        verification.status ? `verification=${compact(verification.status, 80)}` : '',
        paths.size ? `paths=${Array.from(paths).slice(0, 3).join(' | ')}` : '',
        resultEvidence,
      ].filter(Boolean).join(' | '));
    }
  }
  return Array.from(new Set(summaries)).slice(-10);
}
