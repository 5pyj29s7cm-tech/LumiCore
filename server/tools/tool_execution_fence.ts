import crypto from 'node:crypto';
import { stableValue } from '../../shared/stable_json';
import { getJwtSecret } from '../config/local_identity';
import { isDefiniteOfficialImageRejection, isDefiniteOfficialVideoRejection } from '../llm/official_api';
import type { ToolContext, ToolDefinition } from './types';
import type { beginToolMetric } from '../runtime/tool_metrics';
import { beforeAdapterExecution, cancelAdapterExecutionPermit, recordAdapterExecutionFailure, recordAdapterExecutionSuccess } from './adapter_resilience';
import { claimExternalCommitAttempt, settleExternalCommitAttempt } from './external_commit_journal';
import { isToolLifecyclePersistenceFailure } from './lifecycle_persistence_error';

export function executionIdempotencyKey(name: string, args: Record<string, any>, context?: ToolContext): string {
  if (context?.idempotencyKey) return context.idempotencyKey;
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({
    userId: context?.userId || '',
    taskId: context?.taskId || '',
    // Task-bound retries reuse their durable operation. Taskless requests need
    // their own immutable identity instead of sharing identical text/arguments.
    requestId: context?.taskId ? undefined : context?.requestId || undefined,
    actionIntent: context?.actionIntent || '',
    name,
    args,
  }))).digest('hex');
}

export function externalCommitInputDigest(name: string, args: Record<string, any>): string {
  return crypto.createHmac('sha256', getJwtSecret())
    .update('lumi.external-commit.input.v1\0')
    .update(JSON.stringify(stableValue({ name, args })))
    .digest('hex');
}

const EXTERNAL_REPLAY_SECRET_KEY_RE = /password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin/i;

const EXTERNAL_REPLAY_SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{12,}\b)/i;

function sanitizeExternalCommitReplayValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[nested data omitted]';
  if (typeof value === 'string') {
    if (EXTERNAL_REPLAY_SECRET_VALUE_RE.test(value)) return '[redacted]';
    return value.slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeExternalCommitReplayValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        EXTERNAL_REPLAY_SECRET_KEY_RE.test(key)
          ? '[redacted]'
          : sanitizeExternalCommitReplayValue(item, depth + 1),
      ]),
  );
}

function persistedExternalCommitReplay(result: string, idempotencyKey: string): string {
  const safeKeys = /^(?:sent|submitted|published|verified|verificationStatus|verificationMethod|verificationConfidence|verificationReason|providerReceipt|messageId|submissionId|publicationId|paymentId|signatureId|status|targetMatched|conversationVerified|contactVerified|sendAttempted|sessionId|taskId|questionDigest|counts|routePriority|reconciled|completedAt|timestamp)$/i;
  try {
    const parsed = JSON.parse(result || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const safe = Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => safeKeys.test(key))
          .slice(0, 40)
          .map(([key, value]) => [key, sanitizeExternalCommitReplayValue(value)]),
      );
      const replay = JSON.stringify({
        ...safe,
        verified: true,
        verificationStatus: 'verified',
        deduplicated: true,
        idempotencyKey,
      });
      if (replay.length <= 8_192) return replay;
      return JSON.stringify({
        verified: true,
        verificationStatus: 'verified',
        deduplicated: true,
        receiptTruncated: true,
        idempotencyKey,
      });
    }
  } catch {}
  return JSON.stringify({
    verified: true,
    verificationStatus: 'verified',
    deduplicated: true,
    idempotencyKey,
    resultDigest: crypto.createHash('sha256').update(String(result || '')).digest('hex'),
  });
}

function externalCommitUnknownError(name: string, detail: string): Error {
  const error = new Error(
    `Tool "${name}" external commit outcome is unknown and automatic resend was stopped. ${detail}`.trim(),
  ) as Error & { externalCommitUnknown?: boolean };
  error.externalCommitUnknown = true;
  return error;
}

function localSideEffectFenceKey(name: string, context?: ToolContext): string {
  const idempotencyKey = String(context?.idempotencyKey || '').trim();
  if (!idempotencyKey) return '';
  const userId = String(context?.userId || '').trim() || 'anonymous';
  const domain = String(context?.domain || '').trim() || 'personal';
  const orgId = String(context?.orgId || '').trim();
  return JSON.stringify([name, userId, domain, orgId, idempotencyKey]);
}

function externalResultIsVerified(result: string): boolean {
  try {
    const payload = JSON.parse(result || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.sent === false || payload.submitted === false || payload.published === false) return false;
    if (Object.prototype.hasOwnProperty.call(payload, 'verificationStatus')) {
      return payload.verificationStatus === 'verified';
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'verified')) {
      return payload.verified === true;
    }
  } catch {
    // External side effects must never become durable successes from prose or
    // malformed provider output. Only an explicit verified receipt may close
    // the idempotency fence; every other result remains unknown and blocks a
    // resend until host-owned reconciliation can prove the outcome.
  }
  return false;
}

type ToolAttempt = {
  toolName: string;
  inputDigest: string;
  state: 'preparing' | 'running' | 'verified' | 'unknown';
  ready?: Promise<void>;
  promise?: Promise<string>;
  result?: string;
  expiresAt: number;
};

const FENCE_TTL_MS = 24 * 60 * 60_000;
const externalCommitAttempts = new Map<string, ToolAttempt>();
const sideEffectAttempts = new Map<string, ToolAttempt>();

function readAttempt(attempts: Map<string, ToolAttempt>, key: string): ToolAttempt | undefined {
  const attempt = attempts.get(key);
  // A preparation or handler promise retains its exact owner until settlement.
  if (attempt && attempt.expiresAt <= Date.now() && !attempt.promise && !attempt.ready) {
    attempts.delete(key);
    return undefined;
  }
  return attempt;
}

function rememberAttempt(
  attempts: Map<string, ToolAttempt>, key: string, name: string, inputDigest: string,
  attempt: Omit<ToolAttempt, 'toolName' | 'inputDigest' | 'expiresAt'>,
): void {
  attempts.set(key, { ...attempt, toolName: name, inputDigest, expiresAt: Date.now() + FENCE_TTL_MS });
}

/** Test-only process restart simulation; durable journal rows remain authoritative. */
export function resetExternalCommitRuntimeCacheForTests(): void {
  externalCommitAttempts.clear();
  sideEffectAttempts.clear();
}

type ToolFenceInput = {
  name: string;
  executionArgs: Record<string, any>;
  context?: ToolContext;
  externalCommit: boolean;
  hasSideEffect: boolean;
  adapterPermit: ReturnType<typeof beforeAdapterExecution>;
  finishMetric: ReturnType<typeof beginToolMetric>;
  finishResultMetric: (result: string) => void;
  pinnedLocalIdempotencyReplay: NonNullable<ToolDefinition['localIdempotencyReplay']>;
  pinnedReconcileExternalCommit: ToolDefinition['reconcileExternalCommit'];
};

type HandlerLifecycle = { readonly handlerEntered: boolean; readonly timedOut: boolean };
export interface ToolExecutionFence {
  beforeHandler(): Promise<void>;
  onTimeout(): Promise<boolean> | null;
  finalize(execution: Promise<string>, lifecycle: HandlerLifecycle): Promise<string>;
}

async function reconcileReadOnly(input: ToolFenceInput, key: string): Promise<string | null> {
  if (!input.pinnedReconcileExternalCommit) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.pinnedReconcileExternalCommit(input.executionArgs, input.context, key),
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 8_000); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function prepareToolExecutionFence(
  input: ToolFenceInput,
): Promise<ToolExecutionFence | { replay: string }> {
  const { name, executionArgs, context, externalCommit, adapterPermit, finishMetric } = input;
  const idempotencyKey = externalCommit ? executionIdempotencyKey(name, executionArgs, context) : '';
  const sideEffectFenceKey = !externalCommit && input.hasSideEffect ? localSideEffectFenceKey(name, context) : '';
  const key = idempotencyKey || sideEffectFenceKey;
  const attempts = externalCommit ? externalCommitAttempts : sideEffectAttempts;
  const inputDigest = key ? externalCommitInputDigest(name, executionArgs) : '';
  let claimToken = externalCommit ? crypto.randomUUID() : '';
  let preparation: (() => void) | undefined;
  const releasePreparation = () => { const release = preparation; preparation = undefined; release?.(); };

  if (key) {
    let existing = readAttempt(attempts, key);
    const assertBinding = () => {
      if (existing && (existing.toolName !== name || existing.inputDigest !== inputDigest)) {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('target_mismatch');
        throw new Error('Tool "' + name + '" target mismatch: this idempotency key is already bound to different input.');
      }
    };
    assertBinding();
    if (existing?.state === 'preparing' && existing.ready) {
      await existing.ready;
      existing = readAttempt(attempts, key);
      assertBinding();
    }
    if (existing?.state === 'verified') {
      cancelAdapterExecutionPermit(adapterPermit);
      if (externalCommit) finishMetric('verified_success');
      else input.finishResultMetric(existing.result || '');
      return { replay: existing.result || '' };
    }
    if (existing?.promise) {
      cancelAdapterExecutionPermit(adapterPermit);
      try {
        const result = await existing.promise;
        if (externalCommit) finishMetric(externalResultIsVerified(result) ? 'verified_success' : 'unknown_outcome');
        else input.finishResultMetric(result);
        return { replay: result };
      } catch (error) {
        finishMetric(externalCommit
          ? /unknown|timed?\s*out|timeout/i.test(String((error as any)?.message || error)) ? 'unknown_outcome' : 'failed'
          : existing.state === 'unknown' ? 'unknown_outcome' : 'failed');
        throw error;
      }
    }
    if (existing?.state === 'unknown') {
      cancelAdapterExecutionPermit(adapterPermit);
      finishMetric('unknown_outcome');
      throw new Error('Tool "' + name + '" has an unknown prior outcome for this idempotency key; automatic resend was stopped.');
    }
    const ready = new Promise<void>(resolve => { preparation = resolve; });
    rememberAttempt(attempts, key, name, inputDigest, { state: 'preparing', ready });
  }

  if (externalCommit) {
    let claim;
    try {
      const now = new Date().toISOString();
      claim = await claimExternalCommitAttempt({
        idempotencyKey, taskId: String(context?.taskId || ''), userId: String(context?.userId || ''),
        toolName: name, inputDigest, state: 'not_started', replayResult: '', claimToken, createdAt: now, updatedAt: now,
      });
    } catch (error: any) {
      externalCommitAttempts.delete(idempotencyKey); releasePreparation();
      cancelAdapterExecutionPermit(adapterPermit); finishMetric('forbidden');
      throw new Error('Tool "' + name + '" external commit was stopped before execution because the durable idempotency journal is unavailable: ' + String(error?.message || error));
    }
    if (!claim.claimed) {
      const prior = claim.entry;
      if (prior.toolName !== name || prior.inputDigest !== inputDigest) {
        // Rejection must not replace the prior target with the rejected input.
        externalCommitAttempts.delete(idempotencyKey); releasePreparation();
        cancelAdapterExecutionPermit(adapterPermit); finishMetric('target_mismatch');
        throw new Error('Tool "' + name + '" target mismatch: this idempotency key is already bound to different external commit input.');
      }
      if (prior.state === 'verified') {
        const replay = prior.replayResult || persistedExternalCommitReplay('', idempotencyKey);
        rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, { state: 'verified', result: replay });
        releasePreparation(); cancelAdapterExecutionPermit(adapterPermit); finishMetric('verified_success');
        return { replay };
      }
      if (prior.state === 'not_started') {
        claimToken = prior.claimToken;
      } else {
        const reconciled = await reconcileReadOnly(input, idempotencyKey);
        if (reconciled && externalResultIsVerified(reconciled)) {
          const settled = await settleExternalCommitAttempt({
            idempotencyKey, claimToken: prior.claimToken, state: 'verified',
            replayResult: persistedExternalCommitReplay(reconciled, idempotencyKey),
            updatedAt: new Date().toISOString(), recoverExisting: true,
          }).catch(() => false);
          if (settled) {
            rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, { state: 'verified', result: reconciled });
            releasePreparation(); recordAdapterExecutionSuccess(adapterPermit); finishMetric('verified_success');
            return { replay: reconciled };
          }
          rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, { state: 'unknown' });
          releasePreparation(); recordAdapterExecutionSuccess(adapterPermit); finishMetric('unknown_outcome');
          throw externalCommitUnknownError(name, 'The recovered receipt was verified, but its durable terminal state could not be persisted.');
        }
        await settleExternalCommitAttempt({
          idempotencyKey, claimToken: prior.claimToken, state: 'unknown', replayResult: '',
          updatedAt: new Date().toISOString(), recoverExisting: true,
        }).catch(() => false);
        rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, { state: 'unknown' });
        releasePreparation(); cancelAdapterExecutionPermit(adapterPermit); finishMetric('unknown_outcome');
        throw externalCommitUnknownError(name, 'A prior running or unknown attempt could not be verified by read-only reconciliation.');
      }
    }
  }
  return {
    async beforeHandler() {
      if (!externalCommit) return;
      const armed = await settleExternalCommitAttempt({
        idempotencyKey, claimToken, state: 'running', replayResult: '', updatedAt: new Date().toISOString(),
      });
      if (!armed) throw new Error('Tool "' + name + '" external commit was stopped because its durable handler-entry barrier could not be armed.');
    },
    onTimeout() {
      if (key) {
        const active = attempts.get(key);
        if (active?.promise) rememberAttempt(attempts, key, name, inputDigest, { ...active, state: 'unknown' });
      }
      return externalCommit ? settleExternalCommitAttempt({
        idempotencyKey, claimToken, state: 'unknown', replayResult: '', updatedAt: new Date().toISOString(),
      }).catch(() => false) : null;
    },
    finalize(execution, lifecycle) {
      const finalized = finalizeToolExecution({
        ...input, context, execution, idempotencyKey, inputDigest, claimToken, sideEffectFenceKey,
        releasePreparation,
        get handlerEntered() { return lifecycle.handlerEntered; },
        get timedOut() { return lifecycle.timedOut; },
      });
      if (key) rememberAttempt(attempts, key, name, inputDigest, { state: 'running', promise: finalized });
      releasePreparation();
      return finalized;
    },
  };
}
type ToolFinalizationState = ToolFenceInput & HandlerLifecycle & {
  execution: Promise<string>;
  idempotencyKey: string;
  inputDigest: string;
  claimToken: string;
  sideEffectFenceKey: string;
  releasePreparation: () => void;
};

async function finalizeToolExecution(state: ToolFinalizationState): Promise<string> {
  const { execution, externalCommit, idempotencyKey, inputDigest, claimToken, adapterPermit, finishMetric, name, sideEffectFenceKey, pinnedLocalIdempotencyReplay, releasePreparation } = state;

  try {
    const result = await execution;
    if (externalCommit) {
      if (externalResultIsVerified(result)) {
        const replayResult = persistedExternalCommitReplay(result, idempotencyKey);
        const settled = await settleExternalCommitAttempt({
          idempotencyKey,
          claimToken,
          state: 'verified',
          replayResult,
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
        if (!settled) {
          rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, {
            state: 'unknown',
          });
          // The adapter handler returned a verified receipt. A later local
          // journal failure must keep the external outcome unknown and
          // block replay, but it is not evidence that the adapter itself
          // is unhealthy.
          recordAdapterExecutionSuccess(adapterPermit);
          finishMetric('unknown_outcome');
          throw externalCommitUnknownError(
            name,
            'The handler settled successfully, but its verified terminal state could not be persisted.',
          );
        }
        rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, {
          state: 'verified',
          result,
        });
        recordAdapterExecutionSuccess(adapterPermit);
      } else {
        await settleExternalCommitAttempt({
          idempotencyKey,
          claimToken,
          state: 'unknown',
          replayResult: '',
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
        rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, {
          state: 'unknown',
        });
        // The handler fulfilled, so the adapter transport is healthy even
        // though the business outcome is not sufficiently verified. Keep
        // the durable attempt unknown (and therefore non-replayable), but
        // do not turn missing provider evidence into an adapter outage.
        recordAdapterExecutionSuccess(adapterPermit);
        finishMetric('unknown_outcome');
        return result;
      }
    }
    if (sideEffectFenceKey) {
      if (pinnedLocalIdempotencyReplay === 'durable_handler') {
        sideEffectAttempts.delete(sideEffectFenceKey);
      } else {
        rememberAttempt(sideEffectAttempts, sideEffectFenceKey, name, inputDigest, {
          state: 'verified',
          result,
        });
      }
    }
    if (!externalCommit) recordAdapterExecutionSuccess(adapterPermit);
    if (externalCommit) finishMetric('verified_success');
    else state.finishResultMetric(result);
    return result;
  } catch (error: any) {
    if (error?.externalCommitUnknown === true) throw error;
    if (externalCommit) {
      if (!state.handlerEntered
        || (['generate_image', 'ai_edit_image'].includes(name) && isDefiniteOfficialImageRejection(error))
        || (name === 'generate_video' && isDefiniteOfficialVideoRejection(error))) {
        await settleExternalCommitAttempt({
          idempotencyKey,
          claimToken,
          state: 'not_started',
          replayResult: '',
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
        externalCommitAttempts.delete(idempotencyKey);
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('failed');
        throw error;
      }
      const reconciled = !isToolLifecyclePersistenceFailure(error)
        ? await reconcileReadOnly(state, idempotencyKey) : null;
      if (reconciled && externalResultIsVerified(reconciled)) {
        const replayResult = persistedExternalCommitReplay(reconciled, idempotencyKey);
        const settled = await settleExternalCommitAttempt({
          idempotencyKey,
          claimToken,
          state: 'verified',
          replayResult,
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
        if (settled) {
          rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, {
            state: 'verified',
            result: reconciled,
          });
          recordAdapterExecutionSuccess(adapterPermit);
          finishMetric('verified_success');
          return reconciled;
        }
      }
      await settleExternalCommitAttempt({
        idempotencyKey,
        claimToken,
        state: 'unknown',
        replayResult: '',
        updatedAt: new Date().toISOString(),
      }).catch(() => false);
      rememberAttempt(externalCommitAttempts, idempotencyKey, name, inputDigest, {
        state: 'unknown',
      });
      // Only transient adapter/transport failures contribute to the
      // resilience circuit. Business rejection and local lifecycle errors
      // still leave the external commit unknown, but must not poison the
      // shared adapter family for later read-only work.
      recordAdapterExecutionFailure(adapterPermit, error);
      finishMetric('unknown_outcome');
      if (isToolLifecyclePersistenceFailure(error)) throw error;
      throw externalCommitUnknownError(
        name,
        `${state.timedOut ? 'The call timed out.' : 'The handler failed after the durable claim.'} ${String(error?.message || error || '')}`,
      );
    } else {
      if (sideEffectFenceKey) {
        if (state.handlerEntered) {
          rememberAttempt(sideEffectAttempts, sideEffectFenceKey, name, inputDigest, {
            state: 'unknown',
          });
        } else {
          sideEffectAttempts.delete(sideEffectFenceKey);
        }
      }
      recordAdapterExecutionFailure(adapterPermit, error);
      finishMetric(state.timedOut ? 'timeout' : 'failed');
    }
    throw error;
  } finally {
    releasePreparation();
  }

}
