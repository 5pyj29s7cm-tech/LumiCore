import type { ToolExecutionRecord } from "../../tools/types";
import { getCanonicalToolExecutionInputDigests, isCanonicalToolExecutionRecord } from "../../tools/execution_engine";
import type { WorkflowRun, WorkflowReceiptSnapshot } from './contracts';
import { workflowStepExecutionKey } from './execution_identity';
import { WorkflowStateError } from './contracts';
import { redactWorkflowValue } from './values';

export function canonicalReceiptSnapshot(
  run: WorkflowRun,
  stepId: string,
  capabilityId: string,
  record: ToolExecutionRecord,
): Omit<WorkflowReceiptSnapshot, 'recordedAt'> {
  const expectedKey = workflowStepExecutionKey(run, stepId);
  if (!isCanonicalToolExecutionRecord(record)) throw new WorkflowStateError('Workflow receipts must originate from the canonical tool executor.');
  if (!record.envelope) throw new WorkflowStateError('Workflow receipts must come from the canonical tool executor.');
  if (record.id !== expectedKey) throw new WorkflowStateError(`Workflow receipt record identity mismatch for step '${stepId}'.`);
  if (record.name !== capabilityId || record.envelope.toolName !== capabilityId) {
    throw new WorkflowStateError(`Workflow receipt capability mismatch for step '${stepId}'.`);
  }
  if (record.taskId !== run.runId || record.envelope.taskId !== run.runId) {
    throw new WorkflowStateError(`Workflow receipt task identity mismatch for step '${stepId}'.`);
  }
  if (record.idempotencyKey !== expectedKey || record.envelope.idempotencyKey !== expectedKey) {
    throw new WorkflowStateError(`Workflow receipt execution identity mismatch for step '${stepId}'.`);
  }
  const pending = run.pendingExecution;
  const inputDigests = getCanonicalToolExecutionInputDigests(record);
  if (!pending
    || pending.stepId !== stepId
    || pending.capabilityId !== capabilityId
    || pending.executionId !== expectedKey
    || pending.idempotencyKey !== expectedKey
    || !inputDigests
    || pending.argumentsDigest !== inputDigests.argumentsDigest
    || pending.targetDigest !== inputDigests.targetDigest) {
    throw new WorkflowStateError(`Workflow receipt input identity mismatch for step '${stepId}'.`);
  }
  const verified = record.terminalVerification?.status === 'verified'
    && record.envelope.status === 'verified_success'
    && record.envelope.verification.status === 'verified';
  const hasSideEffects = (record.capability?.sideEffects || []).length > 0;
  const definitelyNotStarted = record.envelope.status === 'waiting_confirmation'
    || record.envelope.status === 'forbidden'
    || record.envelope.status === 'target_mismatch';
  const unknownOutcome = record.envelope.status === 'unknown_outcome'
    || (hasSideEffects && record.adapterStarted === true && !verified && !definitelyNotStarted);
  let parsedResult: unknown = record.receipt;
  if (parsedResult === undefined) {
    try { parsedResult = JSON.parse(record.result || 'null'); } catch { parsedResult = record.result; }
  }
  return {
    stepId,
    capabilityId,
    planRevision: run.planRevision,
    executionId: String(record.id || expectedKey),
    idempotencyKey: expectedKey,
    recordId: record.id,
    status: verified ? 'verified' : unknownOutcome ? 'unknown_outcome' : record.error ? 'failed' : 'unverified',
    result: parsedResult,
    resultReusable: JSON.stringify(redactWorkflowValue(parsedResult)) === JSON.stringify(parsedResult),
    receipt: record.receipt,
    reason: record.error || record.terminalVerification?.reason || record.envelope.verification.reason,
    argumentsDigest: inputDigests.argumentsDigest,
    targetDigest: inputDigests.targetDigest,
  };
}
