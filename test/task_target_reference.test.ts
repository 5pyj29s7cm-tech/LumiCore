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


describe('explicit multiple sources bind each read independently', () => {
  const desktop = process.env.USERPROFILE ? process.env.USERPROFILE.replaceAll('\\', '/') + '/Desktop' : '/tmp/Desktop';
  const first = desktop + '/MERGE-SOURCE-A.docx';
  const second = desktop + '/MERGE-SOURCE-B.docx';
  const out = desktop + '/MERGE-OUTPUT.docx';
  const text = '把桌面的“MERGE-SOURCE-A.docx”和“MERGE-SOURCE-B.docx”合并成“MERGE-OUTPUT.docx”，保留两份文件全部正文。';
  const requestId = 'current-multi-source', taskId = 'multi-source-task';
  const discovered = { name: 'search_files', arguments: { directory: desktop, pattern: 'MERGE-*.docx' }, result: JSON.stringify([first, second]), requestId, taskId, terminalVerification: { status: 'verified' } };
  const accepted = resolveAcceptedTaskTarget({ text });
  const unscopedText = text.replace('桌面的', '');
  const check = (path: string, toolRecords: any[] = [discovered], taskText = text) => guardTaskTargetToolCall({ taskText, toolName: 'read_docx', arguments: { filePath: path }, acceptedTaskTarget: accepted, toolRecords, requestId, taskId });
  const pathCheck = (file: string, patch: any = {}) => ({ name: 'desktop_path_info', arguments: { target: file }, result: JSON.stringify({ exists: true, is_directory: false, path: file }), requestId, taskId, terminalVerification: { status: 'verified' }, ...patch });
  it('accepts each named source after fresh exact path verification without a directory search', () => {
    for (const file of [first, second]) expect(check(file, [pathCheck(first), pathCheck(second)], unscopedText).allowed).toBe(true);
  });
  it.each(['missing', 'directory', 'mismatched-path', 'stale-request', 'stale-task', 'unverified'] as const)('rejects invalid exact-path evidence: %s', variant => {
    const evidence = pathCheck(second, variant === 'missing' ? { result: JSON.stringify({ exists: false, is_directory: false, path: second }) }
      : variant === 'directory' ? { result: JSON.stringify({ exists: true, is_directory: true, path: second }) }
        : variant === 'mismatched-path' ? { result: JSON.stringify({ exists: true, is_directory: false, path: out }) }
          : variant === 'stale-request' ? { requestId: 'previous-request' }
            : variant === 'stale-task' ? { taskId: 'previous-task' } : { terminalVerification: { status: 'unverified' } });
    expect(check(second, [evidence], unscopedText).allowed).toBe(false);
  });
  it('does not authorize another folder or a not-yet-produced output from path checks', () => {
    const other = desktop.replace(/Desktop$/u, 'Documents') + '/MERGE-SOURCE-B.docx';
    expect(check(other, [pathCheck(other)]).allowed).toBe(false);
    expect(check(second, [pathCheck(second), pathCheck(other)], unscopedText).allowed).toBe(false);
    expect(check(out, [pathCheck(out)]).allowed).toBe(false);
  });
  it('does not demand a discovery tool before reading each explicitly named source in the stated folder', () => {
    expect(check(first, []).allowed).toBe(true);
    expect(check(second, []).allowed).toBe(true);
    expect(check(out, []).allowed).toBe(false);
  });
  it('keeps a plural overall target unresolved while allowing both specifically named sources', () => {
    expect(accepted?.target.status).toBe('unresolved');
    for (const path of [first, second]) {
      const result = check(path);
      expect(result.allowed).toBe(true);
      expect(normalized(result.normalizedArguments?.filePath as string)).toBe(path);
    }
  });
  it.each(['missing', 'failed', 'stale-request', 'stale-task', 'unverified'] as const)('requires current verified discovery: %s', variant => {
    const record = { ...discovered, ...(variant === 'failed' ? { error: 'failed' } : {}), ...(variant === 'stale-request' ? { requestId: 'old-request' } : {}), ...(variant === 'stale-task' ? { taskId: 'old-task' } : {}), ...(variant === 'unverified' ? { terminalVerification: { status: 'unverified' } } : {}) };
    expect(check(second, variant === 'missing' ? [] : [record], unscopedText).allowed).toBe(false);
  });
  it.each(['requestId', 'taskId'] as const)('does not use the new multi-source exception without the current %s', missing => {
    const context = { taskText: unscopedText, toolName: 'read_docx', arguments: { filePath: second }, acceptedTaskTarget: accepted, toolRecords: [discovered], requestId, taskId, [missing]: undefined };
    expect(guardTaskTargetToolCall(context).allowed).toBe(false);
  });
  it('rejects an unproduced output or a different document even when listed', () => {
    const extra = { ...discovered, result: JSON.stringify([first, second, out, desktop + '/UNRELATED.docx']) };
    expect(check(out, [extra]).allowed).toBe(false);
    expect(check(desktop + '/UNRELATED.docx', [extra]).allowed).toBe(false);
  });
  it('does not choose from two same-name paths or widen a stated desktop location', () => {
    const alternate = desktop.replace(/Desktop$/u, 'Documents') + '/MERGE-SOURCE-B.docx';
    const other = { ...discovered, arguments: { directory: desktop.replace(/Desktop$/u, 'Documents'), pattern: 'MERGE-*.docx' }, result: JSON.stringify([alternate]) };
    expect(check(second, [discovered, other], unscopedText).allowed).toBe(false);
    expect(check(alternate, [other]).allowed).toBe(false);
  });
});


it('allows one exact current source in a stated standard directory without accepting neighboring files', async () => {
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { vi } = await import('vitest');
  const home = path.join(String(process.env.LUMI_DATA_DIR), 'single-explicit-source-home');
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const desktop = path.join(home, 'Desktop'); fs.mkdirSync(desktop, { recursive: true });
    const source = path.join(desktop, 'SINGLE-SOURCE.docx');
    const text = '读取桌面的“SINGLE-SOURCE.docx”，将全部文字制作成桌面的“SINGLE-SOURCE.pdf”，保留标题和两条内容，不修改原Word。';
    const accepted = resolveAcceptedTaskTarget({ text }) || resolveAcceptedTaskTarget({ text: '读取这些文件。' });
    expect(accepted?.target).toMatchObject({ status: 'unresolved', path: '' });
    const check = (candidate: string, taskText = text, toolRecords: any[] = []) => guardTaskTargetToolCall({
      taskText, toolName: 'read_docx', arguments: { filePath: candidate }, acceptedTaskTarget: accepted,
      requestId: 'single-current-request', taskId: 'single-current-task', toolRecords,
    });
    expect(check(source).allowed).toBe(true);
    for (const candidate of [path.join(home, 'Documents', 'SINGLE-SOURCE.docx'), path.join(desktop, 'NEIGHBOR.docx'), path.join(desktop, 'SINGLE-SOURCE.pdf')]) {
      expect(check(candidate).allowed).toBe(false);
    }
    const unscoped = text.replaceAll('桌面的', '');
    expect(check(source, unscoped).allowed).toBe(false);
    const oldDiscovery = { name: 'search_files', arguments: { directory: desktop, pattern: '*.docx' }, result: JSON.stringify([source]),
      requestId: 'old-request', taskId: 'old-task', terminalVerification: { status: 'verified' } };
    expect(check(source, unscoped, [oldDiscovery]).allowed, JSON.stringify({accepted,unscoped,result:check(source, unscoped, [oldDiscovery])})).toBe(false);
    expect(check(source, '不要读取桌面的“SINGLE-SOURCE.docx”，只说明如何制作PDF。').allowed).toBe(false);
  } finally { homedir.mockRestore(); }
});
