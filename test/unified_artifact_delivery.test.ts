import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactPathFromRecord, isArtifactProducerRecord, resolveArtifactDelivery, sameArtifactPath } from '../server/tools/artifact_evidence';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { isVerifiedProducedDocumentTarget, resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import type { ToolExecutionRecord } from '../server/tools/types';

describe('one artifact identity and delivery decision across consumers', () => {
  it('keeps skill and workflow state writes out of document continuity and completion', () => {
    const csv = 'C:/Users/Administrator/Documents/orders.csv';
    const calls: ToolExecutionRecord[] = ['generate_skill', 'save_workflow'].map(name => ({
      name, requestId: 'authoring-request', arguments: {}, result: '', error: 'draft rejected',
      capability: { capabilityId: 'skills.draft.generate', lane: 'system', operation: 'create', risk: 'high',
        sideEffects: [{ type: 'local_write', scope: 'draft state', reversible: true }],
        verification: { strategy: 'artifact', required: true, requiredFields: ['ok'], requiredValues: { ok: true }, successSignals: ['Draft exists'], limitations: [] } },
    }));
    for (const call of calls) {
      expect(isArtifactProducerRecord(call)).toBe(false);
      expect(isArtifactProducerRecord({ name: call.name })).toBe(false);
    }
    const accepted = resolveAcceptedTaskTarget({ text: '把刚才读取的那份 CSV 做成 Excel，保存后回读。', persistedHistory: [
      { role: 'user', message: `读取 ${csv}，计算总额。` },
      { role: 'assistant', requestId: 'authoring-request', message: 'Draft failed', toolCalls: calls },
    ] });
    expect(accepted?.target.path.replaceAll('\\', '/')).toBe(csv);
    const task = '创建一个 Excel 文件';
    expect(hasCoreActionEvidence(buildActionContract(task), calls.map(call => ({ ...call, error: undefined,
      result: '{"ok":true,"status":"verified"}', terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Draft exists' } })), task)).toBe(false);
  });
  it('uses returned output rather than the mutation input, including encoded receipts', () => {
    const record: ToolExecutionRecord = { name: 'modify_xlsx', arguments: { filePath: 'C:/input.xlsx' }, result: '', receipt: JSON.stringify(JSON.stringify({ path: 'C:/output.xlsx' })) };
    expect(artifactPathFromRecord(record)).toBe('C:/output.xlsx');
    expect(artifactPathFromRecord({ ...record, receipt: undefined })).toBe('');
    expect(sameArtifactPath('C:/Folder/../out.xlsx', 'c:\\OUT.xlsx')).toBe(true);
    expect(sameArtifactPath('/tmp/Output.xlsx', '/tmp/output.xlsx')).toBe(false);
  });

  it('delivers the same verified output through chat, voice, task and workflow without a model summary', () => {
    const output = path.join(process.env.LUMI_DATA_DIR!, 'unified-delivery.txt');
    const content = 'alpha\nbeta'; fs.writeFileSync(output, content);
    const identity = { taskId: 'unified-task', requestId: 'unified-request' };
    const verification = { status: 'verified' as const, strategy: 'artifact' as const, reason: 'Actual fixture file and same-path readback' };
    const producer: ToolExecutionRecord = { ...identity, name: 'write_file', arguments: { path: output, content }, result: JSON.stringify({ ok: true, path: output }), terminalVerification: verification };
    const reader: ToolExecutionRecord = { ...identity, name: 'read_file', arguments: { path: output }, result: fs.readFileSync(output, 'utf8'), terminalVerification: verification };
    const records = [producer, reader];
    const taskText = `创建 ${output}，保存后回读并告诉我全文。`;
    expect(hasCoreActionEvidence(buildActionContract(taskText), records, taskText, null, identity)).toBe(true);
    expect(isVerifiedProducedDocumentTarget(output, records)).toBe(true);
    const outcomes = ['chat', 'voice', 'task', 'workflow'].map(source => {
      const input = { ...identity, taskText, responseText: '', toolRecords: records, source };
      const bounded = tryFinalizeVerifiedBoundedAction(input);
      expect(bounded?.blocked).toBe(false);
      const delivered = finalizeLumiResponse({ ...input, responseText: bounded!.text });
      expect(delivered.blocked).toBe(false); expect(delivered.text).toContain(content);
      expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: [producer] })).toBeNull();
      expect(hasCoreActionEvidence(buildActionContract(taskText), records, taskText, null, { ...identity, requestId: 'other' })).toBe(false);
      return delivered.text;
    });
    expect(new Set(outcomes).size).toBe(1);
    expect(resolveArtifactDelivery([producer, { ...reader, requestId: 'different' }])?.readback).toBeUndefined();
    expect(resolveArtifactDelivery([reader, producer])?.readback).toBeUndefined();
    expect(resolveArtifactDelivery([producer, { ...reader, error: 'read failed' }])?.readback).toBeUndefined();
  });
});
