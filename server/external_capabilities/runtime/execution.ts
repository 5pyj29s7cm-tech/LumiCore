import { cloneDatabaseValue } from "../../db/snapshot_changes";
import crypto from "node:crypto";
import { executeToolCall, isCanonicalToolExecutionRecord } from "../../tools/execution_engine";
import { externalCommitInputDigest, type ToolRegistry } from "../../tools/registry";
import type { ToolContext, ToolExecutionRecord } from "../../tools/types";
import { assertExternalCapabilityArguments, externalCapabilityProposalDigest, normalizeExternalCapabilityProposal } from "../schema";
import { sameExternalCapabilityCredentialRevision } from "../credential_binding";
import type { ExternalCapabilityPackageRow, ExternalCapabilityReceiptRow } from './contracts';
import { arrays, persistRows, snapshotExternalCapabilityStore, restoreExternalCapabilityStore } from './store';
import { resolveReviewedRowRuntime } from './proposal_resolution';
import { mergeActionArguments } from './argument_binding';
import { projectRow } from './projection';
import { persistStrict } from './persistence';

function externalCapabilityExecutionRow(
  ownerUserId: string,
  capabilityId: string,
): ExternalCapabilityPackageRow {
  const row = arrays().packages.find(candidate => (
    candidate
    && candidate.ownerUserId === ownerUserId
    && candidate.capabilityId === capabilityId
    && candidate.status === 'active'
  ));
  if (!row) throw new Error('External capability is not active for this user.');
  return row;
}

export async function executeExternalCapabilityAction(input: {
  ownerUserId: string;
  capabilityId: string;
  actionId: string;
  arguments?: unknown;
  requestId: string;
  idempotencyKey: string;
  registry: ToolRegistry;
  context: ToolContext;
}) {
  const row = externalCapabilityExecutionRow(input.ownerUserId, input.capabilityId);
  const proposal = normalizeExternalCapabilityProposal(row.proposal);
  if (externalCapabilityProposalDigest(proposal) !== String(row.packageDigest || '').trim().toLowerCase()) {
    throw new Error('External capability package data changed after review.');
  }
  const action = proposal.actions.find(candidate => candidate.id === input.actionId);
  if (!action) throw new Error('External capability action was not found.');
  const runtime = resolveReviewedRowRuntime(row, input.registry);
  const resolved = runtime.actions.find(candidate => candidate.actionId === action.id);
  if (runtime.availability !== 'ready' || !resolved?.executable) {
    throw new Error(runtime.reason || 'External capability action is unavailable.');
  }
  if (resolved.requiresConfirmation) {
    const error = new Error('This action retains the underlying tool confirmation boundary and cannot be executed by a bare icon request.') as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }
  const supplied = assertExternalCapabilityArguments(input.arguments);
  const proxyName = resolved.proxyToolName;
  if (!input.registry.get(proxyName)) throw new Error('External capability proxy is not hydrated in the current runtime.');
  const reviewedArguments = mergeActionArguments(action, supplied);
  const inputDigest = externalCommitInputDigest(proxyName, reviewedArguments);
  const store = arrays();
  const priorReceipt = [...store.receipts].reverse().find(receipt => (
    receipt.kind === 'execution'
    && receipt.packageRowId === row.id
    && receipt.ownerUserId === input.ownerUserId
    && receipt.actionId === action.id
    && receipt.runtimeIdentityDigest === resolved.runtimeIdentityDigest
    && sameExternalCapabilityCredentialRevision(
      receipt.credentialBindingRevision,
      row.credentialBindingRevision,
    )
    && receipt.idempotencyKey === input.idempotencyKey
    && (receipt.persistenceState === 'pending'
      || receipt.status === 'verified_success'
      || receipt.status === 'unknown_outcome')
  ));
  const persistenceUnknownMessage = 'The action may have completed, but its durable capability receipt is not yet available. Automatic resend was stopped; retry with the same request key to reconcile it.';
  const pendingExecution = (receipt: ExternalCapabilityReceiptRow) => ({
    execution: {
      receiptId: receipt.id,
      recordId: receipt.canonicalOutcome?.recordId || '',
      status: 'unknown_outcome',
      toolName: receipt.canonicalOutcome?.toolName || proxyName,
      underlyingToolName: receipt.canonicalOutcome?.underlyingToolName || action.tool.name,
      result: '',
      error: persistenceUnknownMessage,
      terminalVerification: receipt.terminalVerification,
      recovery: {
        pendingPersistence: true,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    capability: projectRow(row, input.registry, store.receipts),
  });
  if (priorReceipt) {
    if (priorReceipt.inputDigest && priorReceipt.inputDigest !== inputDigest) {
      throw new Error('External capability idempotency key is already bound to different reviewed arguments.');
    }
    if (priorReceipt.persistenceState === 'pending') {
      const pendingSnapshot = cloneDatabaseValue(priorReceipt);
      const canonical = priorReceipt.canonicalOutcome;
      if (!canonical) return pendingExecution(priorReceipt);
      priorReceipt.status = canonical.status;
      priorReceipt.hostVerified = canonical.hostVerified;
      priorReceipt.terminalVerification = canonical.terminalVerification;
      priorReceipt.persistenceState = 'persisted';
      delete priorReceipt.persistenceErrorDigest;
      persistRows(store);
      try {
        await persistStrict();
      } catch (error) {
        Object.assign(priorReceipt, pendingSnapshot);
        persistRows(store);
        return pendingExecution(priorReceipt);
      }
      return {
        execution: {
          receiptId: priorReceipt.id,
          recordId: canonical.recordId,
          status: canonical.status,
          toolName: canonical.toolName,
          underlyingToolName: canonical.underlyingToolName,
          result: JSON.stringify({ deduplicated: true, recovered: true }),
          error: undefined,
          terminalVerification: canonical.terminalVerification,
          recovery: {
            pendingPersistence: false,
            deduplicated: true,
            recovered: true,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        capability: projectRow(row, input.registry, store.receipts),
      };
    }
    const canonical = priorReceipt.canonicalOutcome;
    return {
      execution: {
        receiptId: priorReceipt.id,
        recordId: canonical?.recordId || '',
        status: priorReceipt.status,
        toolName: canonical?.toolName || priorReceipt.toolName || proxyName,
        underlyingToolName: canonical?.underlyingToolName || action.tool.name,
        result: JSON.stringify({ deduplicated: true }),
        error: undefined,
        terminalVerification: priorReceipt.terminalVerification,
        recovery: {
          pendingPersistence: false,
          deduplicated: true,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      capability: projectRow(row, input.registry, store.receipts),
    };
  }
  const receiptId = crypto.randomUUID();
  const now = new Date().toISOString();
  const beforePreclaim = snapshotExternalCapabilityStore();
  const receipt: ExternalCapabilityReceiptRow = {
    id: receiptId,
    packageRowId: row.id,
    ownerUserId: row.ownerUserId,
    capabilityId: row.capabilityId,
    actionId: action.id,
    kind: 'execution',
    status: 'unknown_outcome',
    hostVerified: false,
    toolName: proxyName,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    inputDigest,
    persistenceState: 'pending',
    runtimeIdentityDigest: resolved.runtimeIdentityDigest,
    credentialBindingRevision: row.credentialBindingRevision,
    terminalVerification: {
      status: 'unverified',
      strategy: 'none',
      reason: 'The durable execution preclaim exists, but the reviewed action has not reached a canonical terminal receipt.',
    },
    createdAt: now,
  };
  store.receipts.push(receipt);
  row.updatedAt = now;
  try {
    // This durable preclaim is the outer action fence. If it cannot be stored,
    // the handler is never entered. A crash or later flush failure therefore
    // leaves a restart-visible unknown record rather than permitting a resend.
    persistRows(store);
    await persistStrict();
  } catch (error) {
    restoreExternalCapabilityStore(beforePreclaim);
    throw new Error(
      `External capability execution was stopped before the action started because its durable idempotency preclaim could not be stored: ${String((error as Error)?.message || error)}`,
    );
  }
  const durablePreclaim = cloneDatabaseValue(receipt);
  const reviewedTargetEntries = ['url', 'target', 'path', 'filePath', 'applicationTarget', 'executable']
    .flatMap(key => typeof reviewedArguments[key] === 'string' && String(reviewedArguments[key]).trim()
      ? [{ key, value: String(reviewedArguments[key]).trim().slice(0, 1_000) }]
      : []);
  const primaryReviewedTarget = reviewedTargetEntries[0];
  // Target extraction is intentionally fed the server-owned reviewed target
  // before any natural-language package copy. Otherwise text such as "open the
  // customer tool" can be parsed as the target and incorrectly reject the
  // exact fixed URL/path during the canonical semantic guard.
  const routedActionIntent = [
    primaryReviewedTarget
      ? `Open ${primaryReviewedTarget.value}`
      : '',
    `${proposal.name}: ${action.description}`,
    reviewedTargetEntries.length
      ? `Reviewed action target: ${reviewedTargetEntries.map(entry => `${entry.key}=${entry.value}`).join('; ')}`
      : '',
  ].filter(Boolean).join('\n');
  let record: ToolExecutionRecord;
  try {
    record = await executeToolCall({
      registry: input.registry,
      name: proxyName,
      arguments: supplied,
      id: crypto.randomUUID(),
      executionOrigin: 'deterministic_route',
      context: {
        ...input.context,
        userId: input.ownerUserId,
        authenticated: true,
        taskId: `external-capability:${row.capabilityId}:${action.id}:${input.requestId}`,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        currentTurnExecutionRequested: true,
        actionIntent: routedActionIntent,
        routedTaskText: routedActionIntent,
        toolRegistry: input.registry,
        source: 'external-capability-icon',
      },
    });
  } catch (error) {
    receipt.persistenceErrorDigest = crypto.createHash('sha256')
      .update(String((error as Error)?.message || error || 'execution boundary failure'))
      .digest('hex');
    persistRows(store);
    return pendingExecution(receipt);
  }
  const canonical = isCanonicalToolExecutionRecord(record);
  const hostVerified = canonical && record.terminalVerification?.status === 'verified';
  const canonicalStatus = record.envelope?.status || (record.error ? 'failed' : 'unknown_outcome');
  receipt.status = canonicalStatus;
  receipt.hostVerified = hostVerified;
  receipt.persistenceState = 'persisted';
  receipt.canonicalOutcome = {
    recordId: record.id,
    status: canonicalStatus,
    hostVerified,
    toolName: record.name,
    underlyingToolName: action.tool.name,
    terminalVerification: record.terminalVerification,
  };
  receipt.terminalVerification = record.terminalVerification ? { ...record.terminalVerification } : undefined;
  receipt.envelope = record.envelope ? cloneDatabaseValue(record.envelope) : undefined;
  if (record.error) {
    receipt.errorDigest = crypto.createHash('sha256').update(record.error).digest('hex');
  }
  try {
    persistRows(store);
    await persistStrict();
  } catch (error) {
    const operation = record.capability?.operation;
    const sideEffectingAction = ['mutate', 'create', 'communicate', 'unknown'].includes(String(operation || ''))
      || resolved.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type));
    const handlerMayHaveRun = record.adapterStarted === true
      || Boolean(record.adapterSettlements?.length);
    const sideEffectMayHaveOccurred = canonicalStatus === 'verified_success'
      || canonicalStatus === 'unknown_outcome'
      || (sideEffectingAction && handlerMayHaveRun);
    const pendingTerminalVerification: ToolExecutionRecord['terminalVerification'] = {
      status: 'unverified',
      strategy: record.terminalVerification?.strategy || 'none',
      reason: persistenceUnknownMessage,
    };
    const recoverableCanonicalOutcome = {
      recordId: record.id,
      status: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? 'unknown_outcome'
        : canonicalStatus,
      hostVerified: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? false
        : hostVerified,
      toolName: record.name,
      underlyingToolName: action.tool.name,
      terminalVerification: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? pendingTerminalVerification
        : record.terminalVerification,
    };
    Object.assign(receipt, durablePreclaim);
    delete receipt.envelope;
    delete receipt.errorDigest;
    receipt.canonicalOutcome = recoverableCanonicalOutcome;
    receipt.persistenceErrorDigest = crypto.createHash('sha256')
      .update(String((error as Error)?.message || error || 'persistence failure'))
      .digest('hex');
    receipt.terminalVerification = pendingTerminalVerification;
    // The already-durable preclaim remains authoritative on disk. Keep the
    // richer canonical outcome only in memory until a same-key retry can flush
    // it; neither a process restart nor an immediate retry may re-enter handler.
    persistRows(store);
    return pendingExecution(receipt);
  }
  return {
    execution: {
      receiptId,
      recordId: record.id,
      status: record.envelope?.status || (record.error ? 'failed' : 'unknown_outcome'),
      toolName: record.name,
      underlyingToolName: action.tool.name,
      arguments: cloneDatabaseValue(record.arguments || {}),
      evidence: record.evidence ? cloneDatabaseValue(record.evidence) : undefined,
      result: String(record.result || '').slice(0, 64 * 1024),
      error: record.error ? String(record.error).slice(0, 1_000) : undefined,
      terminalVerification: record.terminalVerification,
    },
    capability: projectRow(row, input.registry, store.receipts),
  };
}
