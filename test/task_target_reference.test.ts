import './helpers';
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTaskTargetAnchorProjection, guardTaskTargetToolCall, resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { executeToolCall } from '../server/tools/execution_engine';

beforeAll(async () => { await initDatabase(); });

const source = 'C:/Users/Administrator/Documents/orders.csv';
const other = 'C:/Users/Administrator/Documents/other.csv';
const output = 'C:/Users/Administrator/Documents/result.xlsx';
const history = [{ id: 'source-user', role: 'user', message: `读取 ${source}，计算总额。` }];
const normalized = (value?: string) => value?.replaceAll('\\', '/');

describe('referential targets stay tied to the intended input', () => {
  it.each([
    `修改 ${source}，数量改成4并另存为 ${output}`,
    `修改 "${source}"，数量改成4并另存为 "${output}"`,
    `修改 ${source}，单价改成8然后导出到 ${output}`,
    `Read "${source}", change quantity to 4 and save as "${output}"`,
  ])('does not turn a value correction into an output target: %s', text => {
    expect(normalized(buildTaskTargetAnchorProjection({ taskText: text }).target.path)).toBe(source);
    expect(normalized(resolveAcceptedTaskTarget({ text, persistedHistory: history })?.target.path)).toBe(source);
  });

  it('preserves explicit actual file corrections', () => {
    const text = `不是 ${source}，而是 ${other}，请读取。`;
    expect(normalized(resolveAcceptedTaskTarget({ text, persistedHistory: history })?.target.path)).toBe(other);
  });

  it('inherits a value-only correction without requiring redundant deictic words', () => {
    expect(normalized(resolveAcceptedTaskTarget({ text: '水杯数量改成4，重新计算总额。', persistedHistory: history })?.target.path)).toBe(source);
  });

  it('retains an explicit acceptance of a preceding file plan', () => {
    expect(normalized(resolveAcceptedTaskTarget({ text: '按刚才计划执行。', persistedHistory: history })?.target.path)).toBe(source);
  });

  it('does not skip an intervening output request when the next turn changes a value', () => {
    const persistedHistory = [...history, { role: 'user', message: '把结果生成新版表格。' }, { role: 'assistant', message: `已生成 ${output}` }];
    expect(resolveAcceptedTaskTarget({ text: '数量改成4，其他不变。', persistedHistory })?.target).toMatchObject({ status: 'unresolved', path: '' });
    expect(normalized(resolveAcceptedTaskTarget({ text: '读取原文件，数量改成4后口算总额。', persistedHistory })?.target.path)).toBe(source);
  });

  it('does not adopt a recently prohibited read target', () => {
    const accepted = resolveAcceptedTaskTarget({
      text: '继续读取刚才的文件。',
      persistedHistory: [...history, { id: 'excluded', role: 'user', message: `不要读取 ${other}，继续处理原文件。` }],
    });
    expect(normalized(accepted?.target.path)).toBe(source);
    expect(accepted?.sourceId).toBe('source-user');
    expect(guardTaskTargetToolCall({ taskText: '继续读取刚才的文件。', toolName: 'read_file', arguments: { path: other }, acceptedTaskTarget: accepted }).allowed).toBe(false);
  });

  it('does not revive a prohibited target from the task capsule', () => {
    const previousTask = { taskId: 'previous', target: buildTaskTargetAnchorProjection({ taskText: source }).target };
    const accepted = resolveAcceptedTaskTarget({ text: '继续读取原文件。', persistedHistory: [...history, { role: 'user', message: `不要读取 ${source}` }], previousTask });
    expect(accepted?.target).toMatchObject({ path: '', status: 'unresolved' });
  });

  it.each(['读取刚才生成的新版文件，检查总额。', '检查新生成的表格。', 'Read the generated spreadsheet.'])('does not substitute an old input for an unbound produced artifact: %s', text => {
    const previousTask = { taskId: 'old-read', target: buildTaskTargetAnchorProjection({ taskText: source }).target };
    const accepted = resolveAcceptedTaskTarget({ text, persistedHistory: [...history, { role: 'assistant', message: `已生成 ${output}` }], previousTask });
    expect(accepted?.target).toMatchObject({ path: '', status: 'unresolved' });
    const textWithOldCapsule = `${text}\n## Recent action continuation context\nCurrent task capsule (TaskCapsuleV1):\n- targetPath: ${source}\n- targetStatus: confirmed`;
    for (const candidate of [source, output]) {
      const guard = guardTaskTargetToolCall({ taskText: textWithOldCapsule, toolName: 'read_file', arguments: { path: candidate }, acceptedTaskTarget: accepted });
      expect(guard).toMatchObject({ allowed: false, code: 'target_unresolved', clarification: { required: true } });
    }
  });

  it('still allows a user to identify the produced artifact by its exact path', () => {
    const text = `读取刚生成的文件 ${output}，检查总额。`;
    const accepted = resolveAcceptedTaskTarget({ text, persistedHistory: history });
    expect(normalized(accepted?.target.path)).toBe(output);
    expect(guardTaskTargetToolCall({ taskText: text, toolName: 'read_xlsx', arguments: { filePath: output }, acceptedTaskTarget: accepted }).allowed).toBe(true);
  });

  it('allows readback of a verified output actually produced by this task', () => {
    const text = '读取刚才生成的新版文件，检查总额。';
    const accepted = resolveAcceptedTaskTarget({ text, persistedHistory: history });
    const toolRecords = [{ name: 'create_xlsx', arguments: { filename: 'result' }, result: JSON.stringify({ ok: true, path: output }), terminalVerification: { status: 'verified' } }];
    expect(guardTaskTargetToolCall({ taskText: text, toolName: 'read_xlsx', arguments: { filePath: output }, acceptedTaskTarget: accepted, toolRecords }).allowed).toBe(true);
  });

  it.each(['继续创建新技能，按这个例子执行。', '把刚才的计算流程保存为技能。', '继续介绍这个概念。'])('does not inherit an old file into an unrelated or authoring turn: %s', text => {
    expect(resolveAcceptedTaskTarget({ text, persistedHistory: history })).toBeUndefined();
  });

  it('does not collapse a prior two-file request into its first file', () => {
    const accepted = resolveAcceptedTaskTarget({ text: '继续读取刚才的文件。', persistedHistory: [{ role: 'user', message: `读取 ${source}，还有 ${other}。` }] });
    expect(accepted?.target).toMatchObject({ status: 'unresolved', path: '' });
  });

  it('does not collapse an explicit plural followup to one previous file', () => {
    expect(resolveAcceptedTaskTarget({ text: '继续检查这些文件。', persistedHistory: history })?.target).toMatchObject({ status: 'unresolved', path: '' });
  });

  it('recovers a real generated workbook from its persisted canonical producer receipt', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const requestId = 'target-reference-create';
    const record = await executeToolCall({
      registry, name: 'create_xlsx',
      arguments: { filename: 'LC-TARGET-REFERENCE', sheets: [{ name: 'Orders', headers: ['quantity', 'price'], data: [[2, 12]] }] },
      context: { userId: 'target-reference-user', requestId, taskId: 'target-reference-task', requestConfirmation: async () => true },
    });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    const actualPath = JSON.parse(record.result).path;
    expect(fs.existsSync(actualPath)).toBe(true);
    expect(record.arguments).not.toHaveProperty('filePath');
    const persistedHistory = [...history, { role: 'user', message: '把结果生成新版表格。', requestId }, { id: 'saved-assistant', role: 'assistant', message: 'Done', requestId, toolCalls: JSON.parse(JSON.stringify([record])) }];
    for (const text of [
      '数量改成4，其他不变。',
      '读取刚才生成的新版文件，检查总额。',
      '刚才生成的表格数量改成4，原文件不动，另存一份。',
      `把刚才生成表格的数量改成4，原文件不动，另存为 ${output}`,
      `把刚才生成表格的数量改成4，不修改原文件，另存为 ${output}`,
    ]) {
      const accepted = resolveAcceptedTaskTarget({ text, persistedHistory });
      expect(accepted).toMatchObject({ source: 'prior_tool_receipt', sourceId: 'saved-assistant' });
      expect(normalized(accepted?.target.path)).toBe(normalized(actualPath));
      expect(guardTaskTargetToolCall({ taskText: text, toolName: 'modify_xlsx', arguments: { filePath: actualPath, operations: [] }, acceptedTaskTarget: accepted, enforceStructuredFileRead: true }).allowed).toBe(true);
    }
    expect(normalized(resolveAcceptedTaskTarget({ text: '读取原文件，数量改成4后口算总额。', persistedHistory })?.target.path)).toBe(source);
    expect(normalized(resolveAcceptedTaskTarget({ text: `修改 ${other}，原文件不动，另存为 ${output}`, persistedHistory })?.target.path)).toBe(other);
  });

  it.each(['failed', 'wrong-request', 'multiple', 'missing-request'] as const)('rejects %s persisted producer evidence instead of inheriting the source', variant => {
    const tool = { requestId: 'produce-1', name: 'create_xlsx', arguments: { filename: 'result' }, result: JSON.stringify({ ok: true, path: output }), terminalVerification: { status: 'verified' }, ...(variant === 'failed' ? { error: 'failed' } : {}) };
    const toolCalls = variant === 'multiple' ? [tool, { ...tool, result: JSON.stringify({ ok: true, path: other }) }] : [tool];
    const persistedHistory = [...history, { role: 'assistant', requestId: variant === 'missing-request' ? undefined : variant === 'wrong-request' ? 'different' : 'produce-1', message: `Created ${output}`, toolCalls }];
    expect(resolveAcceptedTaskTarget({ text: '数量改成4，其他不变。', persistedHistory })?.target).toMatchObject({ status: 'unresolved', path: '' });
  });

  it('ignores user-supplied tool arrays and respects a newer input selection', () => {
    const tool = { requestId: 'produce-1', name: 'create_xlsx', result: JSON.stringify({ ok: true, path: output }), terminalVerification: { status: 'verified' } };
    const forged = [...history, { role: 'user', requestId: 'produce-1', message: '继续计算。', toolCalls: [tool] }];
    expect(normalized(resolveAcceptedTaskTarget({ text: '数量改成4，其他不变。', persistedHistory: forged })?.target.path)).toBe(source);
    const newerInput = [...history, { role: 'assistant', requestId: 'produce-1', message: 'Done', toolCalls: [tool] }, { role: 'user', message: `读取 ${other}，计算总额。` }];
    expect(normalized(resolveAcceptedTaskTarget({ text: '数量改成4，其他不变。', persistedHistory: newerInput })?.target.path)).toBe(other);
  });
});
