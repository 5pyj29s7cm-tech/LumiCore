import './helpers';
import { describe, expect, it } from 'vitest';
import { artifactContentRequirements, checkArtifactContent } from '../server/cognition/artifact_progress';
import { buildActionContract, getArtifactTaskProgress, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { buildArtifactProgressPrompt, resolveArtifactReadbackCall } from '../server/llm/adapter';
import { toolRecordIdempotencyKey } from '../server/tools/execution_envelope';
import { normalizeCompletionFeedbackForPersistence } from '../server/conversation/completion_feedback';
import { mergeTaskReceipts, taskReceiptsToRecords } from '../server/cognition/task_execution_ledger';

const task = '新建 D:/work/meeting.docx，资料：6人、1200元。整理为安排、议题、留空的会议结论。请回读检查，不要打开软件窗口。';
const turn = { requestId: 'current-request', taskId: 'current-task' };
const saved: any = { ...turn, id: 'write-1', name: 'create_docx', arguments: { outputPath: 'D:/work/meeting.docx' }, result: JSON.stringify({ ok: true, status: 'created', path: 'D:/work/meeting.docx' }), terminalVerification: { status: 'verified' } };
const read = (text: string, extra = {}): any => ({ ...turn, id: 'read-1', name: 'read_docx', arguments: { filePath: 'D:/work/meeting.docx' }, result: text, terminalVerification: { status: 'verified' }, ...extra });
const incomplete = '一、会议安排\n6人、1200元\n\n二、会议议题\n讨论交付时间';
const complete = `${incomplete}\n\n三、会议结论\n\n`;

describe('one artifact checkpoint for continuation and completion', () => {
  it('archives separate reads of successive versions but deduplicates delivery of the same read', () => {
    const first = read(incomplete, { id: 'first-observation', capability: { operation: 'observe' } });
    const second = read(complete, { id: 'second-observation', capability: { operation: 'observe' } });
    expect(toolRecordIdempotencyKey(first)).not.toBe(toolRecordIdempotencyKey(second));
    expect(toolRecordIdempotencyKey(first)).toBe(toolRecordIdempotencyKey({...first}));
    expect(toolRecordIdempotencyKey({ ...saved, id: 'write-other' })).toBe(toolRecordIdempotencyKey(saved));
  });
  it('does not promote a saved/read file with a missing required section to task completion', () => {
    const records = [saved, read(incomplete)];
    const progress = getArtifactTaskProgress(task, records, turn)!;
    expect(progress).toMatchObject({ next: 'repair_content', readBack: true, complete: false });
    expect(progress.missingContent).toEqual([{ kind: 'blank_section', value: '会议结论', status: 'missing' }]);
    expect(hasCoreActionEvidence(buildActionContract(task), records, task, undefined, turn)).toBe(false);
    for (const source of ['chat', 'voice', 'task', 'workflow']) {
      const result = finalizeLumiResponse({ ...turn, taskText: task, responseText: '已经全部完成。', toolRecords: records, source });
      expect(result).toMatchObject({ blocked: true, reason: 'artifact_step_pending:repair_content' });
      expect(result.text).toContain('文件已保存');
      expect(result.text).toContain('缺少要求的内容：会议结论');
    }
    expect(tryFinalizeVerifiedBoundedAction({ ...turn, taskText: task, responseText: '', toolRecords: records, source: 'chat' })).toBeNull();
    const feedback = buildForegroundTaskCompletionFeedback({ taskId: turn.taskId, taskLabel: task, toolRecords: records });
    expect(feedback?.status).toBe('blocked');
    expect(feedback?.completed).toContain('已回读当前版本');
    expect(feedback?.incomplete).toContain('缺少要求的内容：会议结论');
    expect(feedback?.nextSteps[0]).toContain('补齐');
    const publicFeedback = normalizeCompletionFeedbackForPersistence(feedback)!;
    expect(publicFeedback.completed).toContain('已回读当前版本');
    expect(publicFeedback.completed).not.toContain('任务已完成。');
    expect(publicFeedback.incomplete).toContain('缺少要求的内容：会议结论');
    expect(normalizeCompletionFeedbackForPersistence(publicFeedback)).toEqual(publicFeedback);
    expect(buildArtifactProgressPrompt(task, records, turn)).toContain('repair_content');
    expect(resolveArtifactReadbackCall(task, records, new Set(['read_docx']), turn)).toBeNull();
  });
  it('invalidates old readback after a repair and resumes only the unfinished read step', () => {
    const fixed = { ...saved, id: 'write-2' };
    const records = [saved, read(incomplete), fixed];
    expect(getArtifactTaskProgress(task, records, turn)).toMatchObject({ next: 'readback', readBack: false });
    expect(resolveArtifactReadbackCall(task, records, new Set(['read_docx']), turn)).toEqual({ name: 'read_docx', arguments: { filePath: 'D:/work/meeting.docx' } });
    records.push(read(complete, { id: 'read-2' }));
    expect(getArtifactTaskProgress(task, records, turn)).toMatchObject({ next: 'complete', complete: true });
    expect(hasCoreActionEvidence(buildActionContract(task), records, task, undefined, turn)).toBe(true);
    expect(buildForegroundTaskCompletionFeedback({ taskId: turn.taskId, taskLabel: task, toolRecords: records })?.status).toBe('completed');
  });
  it('keeps successive document observations and section formatting through durable task hydration', () => {
    const verified = { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'actual tool result' };
    const old = [saved, read(incomplete)].map(row => ({ ...row, terminalVerification: verified }));
    const repaired = [{ ...saved, id: 'write-2', arguments: { ...saved.arguments, blocks: ['fixed'] } }, read(complete, { id: 'read-2' })]
      .map(row => ({ ...row, terminalVerification: verified }));
    const stored = mergeTaskReceipts(mergeTaskReceipts([], old), repaired);
    expect(stored).toHaveLength(4);
    expect(getArtifactTaskProgress(task, taskReceiptsToRecords(stored), turn)).toMatchObject({ next: 'complete', readBack: true });
  });
  it('does not let a model error erase already saved and read progress', () => {
    const result = finalizeLumiResponse({ ...turn, source: 'chat', taskText: task, responseText: '', toolRecords: [saved, read(incomplete)], completionGuard: { blocked: true, text: '未发起新的操作', reason: 'model_failed_before_tool_execution' } });
    expect(result.text).toContain('文件已保存');
    expect(result.text).not.toContain('未发起新的操作');
  });
  it('fences readback to the latest output and current request', () => {
    const stale = read(complete, { requestId: 'old' });
    expect(getArtifactTaskProgress(task, [saved, stale], turn)?.next).toBe('readback');
    expect(getArtifactTaskProgress(task, [saved, read(complete, { arguments: { filePath: 'D:/other.docx' } })], turn)?.next).toBe('readback');
  });
  it('checks blank sections, accepts honest placeholders and rejects invented decisions', () => {
    const requirements = artifactContentRequirements(task);
    expect(checkArtifactContent(requirements, `${complete}同意提前交付，待填写`).at(-1)?.status).toBe('not_blank');
    expect(checkArtifactContent(requirements, `${complete}（会议尚未举行，此处留空，待会议结束后由记录人补充填写。）`).at(-1)?.status).toBe('passed');
    expect(artifactContentRequirements('生成报告，不要分为安排、议题。')).toEqual([]);
    expect(artifactContentRequirements('新建文件，内容是“分为安排、议题”。')).toEqual([{ kind: 'text', value: '分为安排、议题' }]);
  });
  it('requires real readback for explicit DOCX content even without a separate read command', () => {
    const text = '新建 D:/work/meeting.docx，必须包含“合同编号 LC-82”。';
    expect(resolveArtifactReadbackCall(text, [saved], new Set(['read_docx']), turn)).toEqual({ name: 'read_docx', arguments: { filePath: 'D:/work/meeting.docx' } });
    expect(getArtifactTaskProgress(text, [saved, read('合同编号 LC-81')], turn)?.next).toBe('repair_content');
  });
});
