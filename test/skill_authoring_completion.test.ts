import './helpers';
import { describe, expect, it } from 'vitest';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { verifiedSkillAuthoringReceipt } from '../server/skills/authoring_receipt';
import { isArtifactProducerRecord } from '../server/tools/artifact_evidence';
import type { ToolExecutionRecord } from '../server/tools/types';
import { sanitizeUserFacingExecutionOutput } from '../server/cognition/user_output_protection';

const taskText = '生成订单汇总技能草稿，接收 csvText，按商品、数量、单价计算总额。先生成草稿并给审核信息，不安装、不执行。';
const identity = { requestId: 'draft-request', taskId: 'draft-task' };
const draft = { ok: true, status: 'draft', installed: false, executable: false, skillName: 'order-parser', displayName: '订单汇总',
  draftDirectory: 'C:/test/skill-drafts/parser', entryPath: 'C:/test/skill-drafts/parser/index.ts', manifestPath: 'C:/test/skill-drafts/parser/package.json',
  review: { status: 'draft', contentHash: 'a'.repeat(64), staticCheck: { passed: true }, trialRun: { passed: true }, requiresUserApproval: true } };
const record = (result: unknown = draft): ToolExecutionRecord => ({ ...identity, name: 'generate_skill', arguments: {}, result: JSON.stringify(result),
  capability: { capabilityId: 'skills.draft.generate', lane: 'system', operation: 'create', risk: 'high',
    sideEffects: [{ type: 'local_write', scope: 'isolated draft', reversible: true }],
    verification: { strategy: 'artifact', required: true, requiredFields: ['ok'], successSignals: ['Reviewed draft exists'], limitations: [] } },
  terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Reviewed draft artifacts exist' } });

describe('skill lifecycle completion uses the same intent as routing', () => {
  it('requires both execution and a saved draft for a compound request, including after output redaction', () => {
    const task = '请读取 C:/Users/test/Documents/input.csv，按数量乘单价计算每行 total，生成同目录 output.csv。然后把读取、计算、写文件保存成可复用工作流草稿。先做到草稿，不发布。';
    const read = { ...record('product,quantity,price\nblue-cup,4,18'), name: 'read_file', arguments: { path: 'C:/Users/test/Documents/input.csv' } };
    const failed = { ...record(''), name: 'code_execution', error: 'Target anchor blocked code_execution: unstructured file access forbidden.' };
    const save = { ...record({ ok: true, status: 'draft', workflowId: 'workflow-1', name: 'line-totals', hash: 'a'.repeat(64), stepCount: 3 }), name: 'save_workflow' };
    const contract = buildActionContract(task);
    expect(contract.components).toHaveLength(2);
    for (const records of [[read, failed], [save], [read, save]]) {
      expect(hasCoreActionEvidence(contract, records, task, undefined, identity)).toBe(false);
      expect(tryFinalizeVerifiedBoundedAction({ ...identity, source: 'chat', taskText: task, responseText: '', toolRecords: records })).toBeNull();
      const responseText = sanitizeUserFacingExecutionOutput('terminalVerification: failed', { task, toolRecords: records });
      expect(finalizeLumiResponse({ ...identity, source: 'chat', taskText: task, responseText, toolRecords: records }).blocked).toBe(true);
    }
  });
  it('does not mark a missing lifecycle receipt complete just because the response avoids success words', () => {
    for (const responseText of ['收到。', '执行中有步骤失败，目前不能确认任务完成。', '已获取执行结果。']) {
      expect(finalizeLumiResponse({ ...identity, source: 'chat', taskText: '保存成可复用工作流草稿', responseText, toolRecords: [] }).blocked).toBe(true);
    }
  });
  it('does not turn workflow discovery or screen vocabulary into task completion', () => {
    const task = '运行已经发布的工作流，读取新订单并计算总额。';
    const discovery = { ...record({ ok: true, capabilities: [{ toolName: 'desktop_capture_screen', description: 'screen vision' }], terminalVerification: {} }), name: 'client_capability_manifest' };
    expect(hasCoreActionEvidence(buildActionContract(task), [discovery], task, null, identity)).toBe(false);
    expect(sanitizeUserFacingExecutionOutput(discovery.result!, { task, toolRecords: [discovery] })).not.toContain('已获取屏幕');
  });
  it('finishes draft generation across all shared channels without another model call', () => {
    expect(buildActionContract(taskText).kind).toBe('skill_authoring');
    for (const source of ['chat', 'voice', 'task', 'workflow']) {
      const input = { ...identity, taskText, source, toolRecords: [record()], responseText: '' };
      const bounded = tryFinalizeVerifiedBoundedAction(input);
      expect(bounded?.blocked).toBe(false);
      expect(bounded?.text).toContain('尚未安装或执行');
      expect(bounded?.text).toContain(draft.review.contentHash);
      expect(finalizeLumiResponse({ ...input, responseText: bounded!.text }).blocked).toBe(false);
    }
  });
  it('does not turn a skill draft into a produced user document', () => {
    expect(isArtifactProducerRecord(record())).toBe(false);
    const task = '创建一个 Excel 文件';
    expect(hasCoreActionEvidence(buildActionContract(task), [record()], task, null, identity)).toBe(false);
  });
  it('rejects stale, failed, unverified and incomplete draft receipts', () => {
    for (const bad of [
      { ...record(), requestId: 'old-request' }, { ...record(), taskId: 'old-task' }, { ...record(), error: 'failed' },
      { ...record(), terminalVerification: undefined }, record({ ...draft, installed: true }),
      record({ ...draft, review: { ...draft.review, contentHash: 'wrong' } }),
      record({ ...draft, review: { ...draft.review, trialRun: { passed: false } } }),
    ]) expect(verifiedSkillAuthoringReceipt(taskText, [bad], identity)).toBeNull();
  });
  it('requires the actual requested installation and publication phase', () => {
    for (const task of ['安装这个技能', '发布这个工作流', '保存这个工作流']) {
      expect(buildActionContract(task).kind).toBe('skill_authoring');
      expect(hasCoreActionEvidence(buildActionContract(task), [record()], task, null, identity)).toBe(false);
    }
    const install = { ...record({ ok: true, status: 'installed', runtimeStatus: 'registered', usable: true, registeredToolNames: ['calculate'], manifestCapabilityIds: ['calculate'] }), name: 'install_skill' };
    expect(verifiedSkillAuthoringReceipt('安装这个技能', [install], identity)).not.toBeNull();
    expect(verifiedSkillAuthoringReceipt('安装这个技能', [{ ...install, result: JSON.stringify({ ok: true, status: 'installed', usable: false }) }], identity)).toBeNull();
  });
});
