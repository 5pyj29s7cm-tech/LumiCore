import type { ToolExecutionRecord } from '../tools/types';
import { artifactRecordMatchesTurn } from '../tools/artifact_evidence';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { classifySkillAuthoringIntent } from './authoring_intent';

/** Authoring completes a lifecycle phase, never the example business task. */
export function verifiedSkillAuthoringReceipt(task: string, records: ToolExecutionRecord[], turn: { requestId?: string; taskId?: string } = {}) {
  const intent = classifySkillAuthoringIntent(task);
  const names = intent === 'generate' ? ['generate_skill'] : intent === 'save' ? ['save_workflow', 'capture_recent_workflow']
    : intent === 'install' ? ['install_skill'] : intent === 'publish' ? ['publish_workflow']
      : intent === 'use' ? ['run_workflow', 'get_workflow_run'] : [];
  for (const record of [...records].reverse()) {
    if (!names.includes(record.name) || record.error || !artifactRecordMatchesTurn(record, turn)
      || record.terminalVerification?.status !== 'verified' || record.envelope && record.envelope.status !== 'verified_success') continue;
    const result = parseReceiptObject(toolRecordTerminalPayload(record));
    if (result?.ok !== true) continue;
    // Discovery, starting and waiting never prove the business workflow finished.
    if (intent === 'use' && result.runId && result.workflowId
      && result.status === 'completed' && result.totalSteps > 0 && result.completedSteps === result.totalSteps) return { intent, record, result };
    if (intent === 'generate' && result.status === 'draft' && result.installed === false && result.executable === false
      && typeof result.draftDirectory === 'string' && result.draftDirectory && result.entryPath && result.manifestPath
      && result.review?.status === 'draft' && result.review?.staticCheck?.passed === true && result.review?.trialRun?.passed === true
      && result.review?.requiresUserApproval === true && /^[a-f0-9]{64}$/i.test(result.review?.contentHash || '')) return { intent, record, result };
    if ((intent === 'save' && result.status === 'draft' || intent === 'publish' && result.status === 'published')
      && result.workflowId && result.hash) return { intent, record, result };
    if (intent === 'install' && result.status === 'installed' && result.runtimeStatus === 'registered' && result.usable === true
      && Array.isArray(result.registeredToolNames) && result.registeredToolNames.length
      && Array.isArray(result.manifestCapabilityIds) && result.manifestCapabilityIds.length) return { intent, record, result };
  }
  return null;
}
