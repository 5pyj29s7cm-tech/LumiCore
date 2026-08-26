import { createHash, createHmac } from 'crypto';
import { getJwtSecret } from '../config/local_identity';
import type { ToolContext, ToolExecutionRecord } from './types';
import { externalCommitInputDigest, type ToolRegistry } from './registry';
import { verifyCapabilityReceipt } from './capability_verification';
import { decodeToolResult } from './result_envelope';
import { buildToolExecutionEnvelope, toolRecordIdempotencyKey } from './execution_envelope';
import { inspectExternalCommitAttempt, settleExternalCommitAttempt } from './external_commit_journal';
import { isToolLifecyclePersistenceFailure } from './lifecycle_persistence_error';

const CANONICAL_TOOL_EXECUTION_RECORD = Symbol('lumi.canonical_tool_execution_record');
const CANONICAL_EXTERNAL_COMMIT_RECONCILIATION = Symbol('lumi.canonical_external_commit_reconciliation');
const canonicalRecordDigests = new WeakMap<ToolExecutionRecord, string>();
const canonicalInputDigests = new WeakMap<ToolExecutionRecord, ToolExecutionInputDigests>();

export interface ToolExecutionInputDigests {
  argumentsDigest: string;
  targetDigest: string;
}

function stableInputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableInputValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableInputValue(item)]),
  );
}

function inputTargetIdentity(args: Record<string, unknown>): string {
  return String(
    args.contact
    || args.recipient
    || args.target
    || args.filePath
    || args.path
    || args.url
    || args.applicationTarget
    || '',
  ).trim().slice(0, 500);
}

/** Hash raw execution inputs without exposing them in a persisted receipt. */
export function toolExecutionInputDigests(args: Record<string, unknown>): ToolExecutionInputDigests {
  const targetIdentity = inputTargetIdentity(args);
  const installationKey = getJwtSecret();
  return {
    argumentsDigest: createHmac('sha256', installationKey)
      .update('lumi.tool-input.arguments.v1\0')
      .update(JSON.stringify(stableInputValue(args)))
      .digest('hex'),
    targetDigest: targetIdentity
      ? createHmac('sha256', installationKey)
          .update('lumi.tool-input.target.v1\0')
          .update(targetIdentity)
          .digest('hex')
      : '',
  };
}

function canonicalRecordDigest(record: ToolExecutionRecord): string {
  try { return JSON.stringify(record); } catch { return ''; }
}

export function isCanonicalToolExecutionRecord(record: ToolExecutionRecord): boolean {
  return (record as ToolExecutionRecord & { [CANONICAL_TOOL_EXECUTION_RECORD]?: true })[CANONICAL_TOOL_EXECUTION_RECORD] === true
    && canonicalRecordDigests.get(record) === canonicalRecordDigest(record);
}

export function getCanonicalToolExecutionInputDigests(record: ToolExecutionRecord): ToolExecutionInputDigests | undefined {
  if (!isCanonicalToolExecutionRecord(record)) return undefined;
  const digests = canonicalInputDigests.get(record);
  return digests ? { ...digests } : undefined;
}

export function isCanonicalExternalCommitReconciliationRecord(record: ToolExecutionRecord): boolean {
  return isCanonicalToolExecutionRecord(record)
    && (record as ToolExecutionRecord & { [CANONICAL_EXTERNAL_COMMIT_RECONCILIATION]?: true })[CANONICAL_EXTERNAL_COMMIT_RECONCILIATION] === true;
}

export function attachedExternalCommitReconciliationFingerprint(input: {
  toolName: string;
  capabilityId: string;
  capabilityContractHash: string;
  hook: NonNullable<ReturnType<ToolRegistry['get']>>['reconcileExternalCommit'];
}): string {
  const stable = JSON.stringify({
    capabilityContractHash: input.capabilityContractHash,
    capabilityId: input.capabilityId,
    hookSource: String(input.hook),
    toolName: input.toolName,
  });
  return createHash('sha256').update(stable).digest('hex');
}

function brandCanonicalToolExecutionRecord(
  record: ToolExecutionRecord,
  inputDigests: ToolExecutionInputDigests,
): ToolExecutionRecord {
  Object.defineProperty(record, CANONICAL_TOOL_EXECUTION_RECORD, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  canonicalRecordDigests.set(record, canonicalRecordDigest(record));
  canonicalInputDigests.set(record, { ...inputDigests });
  return record;
}

const SECRET_ARGUMENT_RE =
  /password|passphrase|passkey|secret|token|api.?key|credential|otp|captcha|verification.?code/i;

function sanitizeReceiptValue(value: unknown, depth = 0): any {
  if (depth > 5) return '[nested data omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeReceiptValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4_000) return `${value.slice(0, 4_000)}...`;
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 80)
      .map(([key, item]) => [
        key,
        SECRET_ARGUMENT_RE.test(key)
          ? '[redacted]'
          : sanitizeReceiptValue(item, depth + 1),
      ]),
  );
}

export interface ToolExecutionPreflightResult {
  allowed: boolean;
  arguments?: Record<string, any>;
  reason?: string;
}

export interface ExecuteToolCallInput {
  registry: ToolRegistry;
  name: string;
  arguments?: Record<string, any>;
  id?: string;
  context?: ToolContext;
  /**
   * Optional domain guard. It may normalize arguments or block execution, but
   * the actual permission/risk decision always remains in ToolRegistry.
   */
  preflight?: (
    name: string,
    args: Record<string, any>,
  ) => ToolExecutionPreflightResult;
}

export interface ExecuteAttachedExternalCommitReconciliationInput {
  registry: ToolRegistry;
  originalToolName: string;
  originalCapabilityId: string;
  capabilityContractHash: string;
  expectedImplementationFingerprint: string;
  originalArguments: Record<string, any>;
  expectedInputDigests: ToolExecutionInputDigests;
  originalIdempotencyKey: string;
  reconciliationRecordId: string;
  context: ToolContext;
  timeoutMs?: number;
}

/**
 * Invoke only a tool definition's attached read-only reconciliation hook.
 * The mutation handler and public registry execution path are deliberately not
 * reachable from this function.
 */
export async function executeAttachedExternalCommitReconciliation(
  input: ExecuteAttachedExternalCommitReconciliationInput,
): Promise<ToolExecutionRecord> {
  const definition = input.registry.get(input.originalToolName);
  const manifest = input.registry.getCapabilityManifestEntry(input.originalToolName, input.context.toolPolicy);
  if (!definition?.reconcileExternalCommit || !manifest
    || manifest.capabilityId !== input.originalCapabilityId) {
    throw new Error(`Capability '${input.originalToolName}' has no compatible attached reconciliation hook.`);
  }
  const fingerprint = attachedExternalCommitReconciliationFingerprint({
    toolName: input.originalToolName,
    capabilityId: input.originalCapabilityId,
    capabilityContractHash: input.capabilityContractHash,
    hook: definition.reconcileExternalCommit,
  });
  if (fingerprint !== input.expectedImplementationFingerprint) {
    throw new Error(`Capability '${input.originalToolName}' reconciliation implementation changed after workflow publication.`);
  }
  const inputDigests = toolExecutionInputDigests(input.originalArguments);
  if (inputDigests.argumentsDigest !== input.expectedInputDigests.argumentsDigest
    || inputDigests.targetDigest !== input.expectedInputDigests.targetDigest) {
    throw new Error('Attached reconciliation must address the exact original workflow arguments and target.');
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const name = `reconcile_external_commit:${input.originalToolName}`;
  const verification = {
    strategy: 'terminal_receipt' as const,
    required: true,
    requiredFields: ['reconciliationStatus', 'verificationStatus'],
    requiredValues: { reconciliationStatus: 'committed', verificationStatus: 'verified' },
    successStatuses: ['committed'],
    successSignals: ['the original capability-specific read-only hook verified the exact prior commit'],
    limitations: ['This observation can prove a commit; absence or ambiguous evidence remains unknown and never authorizes replay.'],
  };
  const record: ToolExecutionRecord = {
    id: input.reconciliationRecordId,
    taskId: input.context.taskId,
    turnId: input.context.turnId,
    requestId: input.context.requestId,
    name,
    arguments: sanitizeReceiptValue(input.originalArguments) as Record<string, any>,
    result: '',
    idempotencyKey: input.reconciliationRecordId,
    adapterStarted: false,
    capability: {
      capabilityId: `workflow.reconciliation.attached.${input.originalCapabilityId}`,
      lane: manifest.lane,
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification,
      reconciliation: {
        reconcilesCapabilityIds: [input.originalCapabilityId],
        outcomeField: 'reconciliationStatus',
        committedValues: ['committed'],
        notCommittedValues: [],
      },
    },
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (input.context.isCancelled?.()) throw new Error('Task was cancelled before reconciliation started.');
    const inspection = await inspectExternalCommitAttempt(input.originalIdempotencyKey);
    const exactJournalEntry = inspection.durable
      && inspection.entry?.toolName === input.originalToolName
      && inspection.entry?.taskId === String(input.context.taskId || '')
      && inspection.entry?.userId === String(input.context.userId || '')
      && inspection.entry?.inputDigest === externalCommitInputDigest(
        input.originalToolName,
        input.originalArguments,
      )
      ? inspection.entry
      : null;
    let raw: string | null = null;
    let provenNotStarted = false;
    if (exactJournalEntry?.state === 'verified') {
      raw = exactJournalEntry.replayResult || null;
    } else if (exactJournalEntry?.state === 'not_started') {
      provenNotStarted = true;
    } else if (exactJournalEntry && (exactJournalEntry.state === 'running' || exactJournalEntry.state === 'unknown')) {
      const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs || 20_000, 60_000));
      const timeoutPromise = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
        timeout.unref?.();
      });
      record.adapterStarted = true;
      raw = await Promise.race([
        definition.reconcileExternalCommit(
          input.originalArguments,
          { ...input.context, idempotencyKey: input.originalIdempotencyKey },
          input.originalIdempotencyKey,
        ),
        timeoutPromise,
      ]);
    }
    let payload: Record<string, unknown> | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch {
        payload = null;
      }
    }
    const explicitlyVerified = payload?.verificationStatus === 'verified'
      && (payload.verified === true || payload.sent === true || payload.reconciled === true);
    if (provenNotStarted) {
      const receipt = {
        ok: true,
        status: 'not_committed',
        reconciliationStatus: 'not_committed',
        verificationStatus: 'verified',
        evidence: 'durable_handler_entry_not_started',
      };
      record.result = JSON.stringify(receipt);
      record.receipt = receipt;
      record.capability!.reconciliation!.notCommittedValues = ['not_committed'];
      record.terminalVerification = {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The durable external-commit journal proves the adapter handler never started.',
      };
    } else if (explicitlyVerified && exactJournalEntry) {
      const receipt = sanitizeReceiptValue({
        ...payload,
        reconciliationStatus: 'committed',
        verificationStatus: 'verified',
      });
      record.result = JSON.stringify(receipt);
      record.receipt = receipt;
      const settled = exactJournalEntry.state === 'verified' || await settleExternalCommitAttempt({
        idempotencyKey: input.originalIdempotencyKey,
        claimToken: exactJournalEntry.claimToken,
        state: 'verified',
        replayResult: record.result,
        updatedAt: new Date().toISOString(),
        recoverExisting: true,
      });
      if (!settled) throw new Error('The verified reconciliation could not be committed to the durable external journal.');
      record.terminalVerification = {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: 'The frozen capability-specific read-only hook verified the exact prior commit.',
      };
    } else {
      record.result = JSON.stringify({
        ok: false,
        status: 'unknown',
        reconciliationStatus: 'unknown',
        verificationStatus: 'unverified',
      });
      record.terminalVerification = {
        status: 'unverified',
        strategy: 'terminal_receipt',
        reason: 'The attached read-only hook could not prove whether the prior side effect committed.',
      };
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.terminalVerification = {
      status: 'unverified',
      strategy: 'terminal_receipt',
      reason: 'Attached reconciliation failed without proving commit state.',
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  record.envelope = buildToolExecutionEnvelope(record, {
    taskId: input.context.taskId,
    turnId: input.context.turnId,
    requestId: input.context.requestId,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
  });
  Object.defineProperty(record, CANONICAL_EXTERNAL_COMMIT_RECONCILIATION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return brandCanonicalToolExecutionRecord(record, inputDigests);
}

/**
 * Canonical terminal tool-call path. Every caller receives the same receipt
 * shape, argument redaction, evidence envelope, cancellation behavior, and
 * registry permission enforcement.
 */
export async function executeToolCall(
  input: ExecuteToolCallInput,
): Promise<ToolExecutionRecord> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requestedArguments = input.arguments || {};
  const callerPreflight = input.preflight?.(input.name, requestedArguments)
    || { allowed: true, arguments: requestedArguments };
  const capabilityGetter = (input.registry as any)?.getCapabilityManifestEntry;
  const capability = typeof capabilityGetter === 'function'
    ? capabilityGetter.call(input.registry, input.name, input.context?.toolPolicy)
    : undefined;
  const desktopAuthorization = callerPreflight.allowed
    ? input.context?.desktopExecutionTracker?.authorize(input.name, capability)
    : undefined;
  const preflight = desktopAuthorization && !desktopAuthorization.allowed
    ? { allowed: false, arguments: callerPreflight.arguments, reason: desktopAuthorization.reason }
    : callerPreflight;
  const executionArguments = preflight.arguments || requestedArguments;
  const receiptArguments = sanitizeReceiptValue(executionArguments) as Record<string, any>;
  const evidenceBuilder = (input.registry as any)?.buildEvidenceRecord;
  const record: ToolExecutionRecord = {
    id: input.id,
    taskId: input.context?.taskId,
    turnId: input.context?.turnId,
    requestId: input.context?.requestId,
    name: input.name,
    arguments: receiptArguments,
    result: '',
    evidence: typeof evidenceBuilder === 'function'
      ? evidenceBuilder.call(input.registry, input.name, executionArguments)
      : undefined,
    capability: capability
      ? {
          capabilityId: capability.capabilityId,
          lane: capability.lane,
          operation: capability.operation,
          risk: capability.risk,
          sideEffects: capability.sideEffects,
          verification: capability.verification,
          reconciliation: capability.reconciliation,
        }
      : undefined,
  };
  record.idempotencyKey = input.context?.idempotencyKey || toolRecordIdempotencyKey(record);
  const finalizeRecord = (): ToolExecutionRecord => {
    record.envelope = buildToolExecutionEnvelope(record, {
      taskId: input.context?.taskId,
      turnId: input.context?.turnId,
      requestId: input.context?.requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
    });
    try {
      input.context?.desktopExecutionTracker?.record(record);
    } catch {
      // Desktop observability must not change the canonical tool outcome.
    }
    return brandCanonicalToolExecutionRecord(record, toolExecutionInputDigests(executionArguments));
  };

  if (!preflight.allowed) {
    record.error = preflight.reason || 'Tool execution was blocked by preflight validation.';
    record.terminalVerification = verifyCapabilityReceipt(capability, record);
    return finalizeRecord();
  }
  if (input.context?.isCancelled?.()) {
    record.error = 'Task was cancelled before the tool started.';
    record.terminalVerification = verifyCapabilityReceipt(capability, record);
    return finalizeRecord();
  }

  try {
    input.context?.onToolStart?.({
      id: input.id,
      name: input.name,
      arguments: receiptArguments,
    });
  } catch {
    // Observability callbacks must never change execution outcome.
  }

  let adapterStarted = false;
  try {
    const rawResult = await input.registry.execute(
      input.name,
      executionArguments,
      {
        ...(input.context || {}),
        onAdapterStart: async call => {
          await input.context?.onAdapterStart?.(call);
          adapterStarted = true;
          record.adapterStarted = true;
        },
        onAdapterSettlement: async settlement => {
          record.adapterSettlements = [...(record.adapterSettlements || []), { ...settlement }];
          await input.context?.onAdapterSettlement?.(settlement);
        },
      },
    );
    record.adapterStarted = adapterStarted;
    const decoded = decodeToolResult(rawResult);
    record.result = decoded.content;
    if (decoded.receipt !== undefined) record.receipt = decoded.receipt;
  } catch (error: any) {
    // Durable lifecycle observers own the execution fence. Converting their
    // branded failure into a normal record would let callers publish a false
    // terminal state or retry an adapter whose start may already be durable.
    if (isToolLifecyclePersistenceFailure(error)) throw error;
    // The registry callback distinguishes a denied/preflight call from an
    // adapter that may already have committed a side effect before failing.
    record.adapterStarted = adapterStarted;
    record.error = String(error?.message || error || 'Tool execution failed.');
  }
  record.terminalVerification = verifyCapabilityReceipt(capability, record);
  return finalizeRecord();
}

/**
 * Compatibility adapter for modules whose public contract returns a string or
 * throws. Execution still passes through the canonical receipt-producing path.
 */
export async function executeToolCallOrThrow(
  input: ExecuteToolCallInput,
): Promise<string> {
  const record = await executeToolCall(input);
  const verificationFailure = record.terminalVerification?.status !== 'verified'
    ? record.terminalVerification?.reason || 'The tool did not produce verified terminal evidence.'
    : '';
  if (record.error || verificationFailure) {
    const error = new Error(record.error || verificationFailure) as Error & { toolRecord?: ToolExecutionRecord };
    error.toolRecord = record;
    throw error;
  }
  return record.result;
}
