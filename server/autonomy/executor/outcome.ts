import type { ToolExecutionRecord } from "../../tools/types";
import type { AutonomousTask } from "../task_queue";
import { finalizeLumiResponse, type LumiResultFinalizerInput } from "../../cognition/result_finalizer";
import { taskActionContract, resultTaskText, hasResultCoreActionEvidence } from "../../cognition/result_finalizer_support";
import { parseStructuredToolResult, isSuccessfulAutonomousToolRecord } from './receipts';
import type { AutonomousTaskOutcome } from './contracts';

function autonomousResponseReportsIncomplete(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return true;
  return /(?:\b(?:could\s+not|couldn't|unable\s+to|failed\s+to|not\s+completed|not\s+finished|incomplete|unfinished|blocked|requires?\s+(?:user\s+)?confirmation)\b|(?:\u672a\u5b8c\u6210|\u6ca1\u6709\u5b8c\u6210|\u65e0\u6cd5\u5b8c\u6210|\u4e0d\u80fd\u5b8c\u6210|\u53d7\u963b|\u6267\u884c\u5931\u8d25|\u9700\u8981\u7528\u6237\u786e\u8ba4))/iu.test(text);
}

function selfImprovementProposalId(
  task?: Partial<Pick<AutonomousTask, 'idempotencyKey'>>,
): string {
  const match = /^self-improvement:(improvement_[a-z0-9_-]+):\d+$/i
    .exec(String(task?.idempotencyKey || ''));
  return match?.[1] || '';
}

function selfImprovementProgramRevision(
  task?: Partial<Pick<AutonomousTask, 'idempotencyKey'>>,
): number {
  const match = /^self-improvement:improvement_[a-z0-9_-]+:(\d+)$/i
    .exec(String(task?.idempotencyKey || ''));
  return Number(match?.[1] || -1);
}

/**
 * A queued self-improvement task ends at a verified isolated stage. Activation
 * is deliberately outside the autonomous task and still requires a separate
 * foreground confirmation.  Do not make an honest boundary explanation look
 * like a failed task, and do not accept generic file-write evidence in place
 * of the exact proposal receipt.
 */
export function hasVerifiedSelfImprovementStageReceipt(
  task: Partial<Pick<AutonomousTask, 'id' | 'idempotencyKey'>> | undefined,
  toolRecords: ToolExecutionRecord[],
): boolean {
  const proposalId = selfImprovementProposalId(task);
  const programRevision = selfImprovementProgramRevision(task);
  const taskId = String(task?.id || '').trim();
  if (!proposalId || !taskId || !Number.isSafeInteger(programRevision) || programRevision < 0) return false;
  return toolRecords.some(record => {
    if (
      !['self_improvement_stage_patch', 'self_improvement_replay_verified_stage'].includes(record.name)
      || record.error
      || !String(record.id || '').trim()
      || String(record.arguments?.proposalId || '') !== proposalId
      || record.taskId !== taskId
      || record.terminalVerification?.status !== 'verified'
      || record.terminalVerification.strategy !== 'terminal_receipt'
      || record.envelope?.version !== 1
      || record.envelope.status !== 'verified_success'
      || record.envelope.toolName !== record.name
      || record.envelope.taskId !== taskId
      || record.envelope.verification.status !== 'verified'
      || !String(record.envelope.idempotencyKey || '').trim()
      || record.envelope.idempotencyKey !== record.idempotencyKey
    ) return false;
    const payload = parseStructuredToolResult(record.result);
    if (!payload) return false;
    const proposal = payload.proposal && typeof payload.proposal === 'object'
      ? payload.proposal as Record<string, unknown>
      : null;
    const commit = String(payload.commit || '');
    const treeDigest = String(payload.treeDigest || '');
    const repositoryId = String(payload.repositoryId || '');
    const baseCommit = String(payload.baseCommit || '');
    const branch = String(payload.branch || '');
    return payload.ok === true
      && payload.status === 'verified'
      && payload.persisted === true
      && payload.isolated === true
      && payload.activated === false
      && payload.pushed === false
      && /^[0-9a-f]{40,64}$/i.test(commit)
      && /^[0-9a-f]{64}$/i.test(treeDigest)
      && /^[0-9a-f]{64}$/i.test(repositoryId)
      && /^[0-9a-f]{40,64}$/i.test(baseCommit)
      && branch === `lumi/self-improvement/${proposalId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)}`
      && String(proposal?.id || '') === proposalId
      && proposal?.status === 'verified'
      && proposal?.stagingProtocol === 'static_git_plumbing_v1'
      && proposal?.taskId === taskId
      && Number(proposal?.programRevision) === programRevision
      && proposal?.stagedCommit === commit
      && proposal?.stagedTreeDigest === treeDigest
      && proposal?.repositoryId === repositoryId
      && proposal?.baseCommit === baseCommit
      && proposal?.stagedBranch === branch;
  });
}

export function evaluateAutonomousTaskOutcome(
  taskText: string,
  responseText: string,
  toolRecords: ToolExecutionRecord[],
  task?: Partial<Pick<AutonomousTask, 'id' | 'idempotencyKey'>>,
  evaluation: Pick<LumiResultFinalizerInput, 'completionGuard' | 'taskId' | 'requestId' | 'flow'> = {},
): AutonomousTaskOutcome {
  const candidateText = String(responseText || '').trim();
  const selfImprovementTask = Boolean(selfImprovementProposalId(task));
  const verifiedSelfImprovementStage = hasVerifiedSelfImprovementStageReceipt(task, toolRecords);
  const modelBlocked = evaluation.completionGuard?.blocked === true;
  const finalized = finalizeLumiResponse({
    ...evaluation, taskText,
    responseText: candidateText || 'Autonomous task returned no final summary.',
    toolRecords,
    source: 'autonomous',
  });
  const successfulToolRecords = toolRecords.filter(isSuccessfulAutonomousToolRecord);
  const contractInput = { ...evaluation, taskText, responseText: candidateText, source: 'autonomous' };
  const actionContract = taskActionContract(contractInput);
  const missingSummary = !candidateText;
  const reportedIncomplete = !verifiedSelfImprovementStage
    && autonomousResponseReportsIncomplete(candidateText);
  const missingEvidence = successfulToolRecords.length === 0;
  const missingCoreEvidence = !selfImprovementTask && actionContract.applies
    && !hasResultCoreActionEvidence(contractInput, actionContract, toolRecords, resultTaskText(contractInput));
  const selfImprovementEvidenceMissing = selfImprovementTask && !verifiedSelfImprovementStage;
  const verified = (
    !modelBlocked
    && (!finalized.blocked || verifiedSelfImprovementStage)
    && !missingSummary
    && !reportedIncomplete
    && !missingEvidence
    && !missingCoreEvidence
    && !selfImprovementEvidenceMissing
  );
  const reason = modelBlocked
    ? evaluation.completionGuard?.reason || 'The autonomous model response did not complete.'
    : selfImprovementEvidenceMissing
    ? 'The autonomous self-improvement task did not produce an exact verified isolated-stage receipt for its bound proposal.'
    : finalized.blocked && !verifiedSelfImprovementStage
    ? finalized.reason || 'Autonomous completion claim was not supported by its tool ledger.'
    : missingCoreEvidence
      ? `Missing core evidence for autonomous ${actionContract.kind}.`
      : missingEvidence
      ? 'No successful autonomous tool evidence was recorded.'
      : missingSummary
        ? 'Autonomous execution returned no final summary.'
        : reportedIncomplete
          ? 'Autonomous execution reported that the task was incomplete or blocked.'
          : finalized.reason || '';

  return {
    text: modelBlocked ? evaluation.completionGuard!.text : verifiedSelfImprovementStage ? candidateText : finalized.text,
    blocked: (finalized.blocked && !verifiedSelfImprovementStage) || !verified,
    verified,
    reason,
    successfulToolRecords,
  };
}
