import { makeChatArtifact, type ChatArtifact } from '../../shared/chat_artifacts';
import { artifactPathFromRecord, isArtifactProducerRecord, sameArtifactPath } from '../tools/artifact_evidence';
import { parseNestedJson, parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { buildMediaArtifactReceipt } from '../socket/media_artifact_receipt';
import type { ToolExecutionRecord } from '../tools/types';
import path from 'node:path';
import { getGeneratedOutputDir } from '../config/data_path';

/** Only server-owned terminal tool evidence can attach a local file to a chat. */
export function collectChatArtifacts(value: unknown, conversationId?: string): ChatArtifact[] {
  const records = parseNestedJson(value);
  if (!Array.isArray(records)) return [];
  const paths = new Set<string>();
  const expanded = records.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as ToolExecutionRecord;
    const payload = parseReceiptObject(toolRecordTerminalPayload(record));
    if (!['get_workflow_run', 'run_workflow'].includes(record.name) || record.error || raw.outcome === 'failure'
      || record.terminalVerification?.status !== 'verified' || payload?.ok !== true
      || payload.success === false || payload.error || payload.reconciliationRequired
      || payload.status !== 'completed' || !payload.runId || !payload.workflowId
      || !(payload.totalSteps > 0 && payload.completedSteps === payload.totalSteps)) return [raw];
    // These are the workflow runtime's verified step outputs, not arbitrary
    // nested tool text. Input reads and model-only paths are never producers.
    const outputs = Array.isArray(payload.outputs) ? payload.outputs.slice(-20) : [];
    return [raw, ...outputs.filter(output => output?.status === 'verified' && typeof output.capabilityId === 'string')
      .map(output => ({ name: output.capabilityId, arguments: {}, result: typeof output.result === 'string'
        ? output.result : JSON.stringify(output.result), receipt: output.receipt, terminalVerification: record.terminalVerification }))];
  });
  for (const raw of expanded) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as ToolExecutionRecord;
    if (record.error || raw.outcome === 'failure') continue;
    const result = toolRecordTerminalPayload(record);
    const payload = parseReceiptObject(result);
    if (payload && (payload.ok === false || payload.success === false || payload.error
      || /^(failed|error|cancelled|canceled|pending|waiting_confirmation|unknown_outcome)$/i.test(String(payload.status || '')))) continue;
    const media = buildMediaArtifactReceipt(record.name, record.arguments, result);
    if (media) {
      for (const artifact of media.artifacts) if (artifact.path) paths.add(artifact.path);
    } else if (record.name === 'external_cli_run' && record.terminalVerification?.status === 'verified'
      && payload?.ok === true && payload.status === 'completed' && payload.exitCode === 0 && payload.runId && Array.isArray(payload.artifacts)) {
      for (const artifact of payload.artifacts.slice(0, 24)) {
        if (typeof artifact?.path === 'string' && artifact.size > 0 && /^[a-f0-9]{64}$/.test(artifact.sha256 || '')) paths.add(artifact.path);
      }
    } else if (record.terminalVerification?.status === 'verified' && isArtifactProducerRecord(record)) {
      const output = artifactPathFromRecord(record);
      if (output && (/^[a-z]:[\\/]/i.test(output) || output.startsWith('/'))) paths.add(output);
    }
  }
  const normalized: string[] = [];
  for (let filePath of paths) {
    if (filePath.startsWith('/lumi_output/')) {
      const root = getGeneratedOutputDir();
      filePath = path.resolve(root, filePath.slice('/lumi_output/'.length));
      const relative = path.relative(root, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    }
    if (!normalized.some(other => sameArtifactPath(other, filePath))) normalized.push(filePath);
  }
  return normalized.slice(0, 24).map(filePath => makeChatArtifact(filePath, conversationId));
}
