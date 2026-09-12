import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { preservedSourceOutputScope, requestedSingleArtifact } from '../server/cognition/artifact_write_scope';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';
import { ToolRegistry } from '../server/tools/registry';

beforeAll(() => initDatabase());

describe('preserved input and separate output through the real executor', () => {
  it('distinguishes an input/output request from multiple requested output files and resolves a named directory', () => {
    expect(requestedSingleArtifact('请用 write_file 创建两个文件：C:/test/first.txt 内容为 first；C:/test/second.txt 内容为 second。')).toBeNull();
    expect(requestedSingleArtifact('在 C:\\Users\\test-user\\Documents 创建 Lumi现场验收_晨星716.txt，写入后重读核验')?.path)
      .toBe('C:\\Users\\test-user\\Documents\\Lumi现场验收_晨星716.txt');
  });
  it('does not replace a requested CSV result with an unrelated PDF in a read-calculate-save task', async () => {
    const root = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'csv-output-'));
    const source = path.join(root, 'input.csv'), output = path.join(root, 'output.csv');
    fs.writeFileSync(source, 'quantity,price\n4,18\n');
    const task = `这是虚构验收，不要记入个人记忆。请读取 ${source}，计算 total，生成同目录 output.csv。然后保存成工作流草稿。`;
    expect(requestedSingleArtifact(task)?.path.replace(/\\/g, '/')).toBe(output.replace(/\\/g, '/'));
    const registry = new ToolRegistry(); registerDocumentTools(registry); registerPdfTools(registry); registerFileOpsTools(registry);
    const context = { userId: 'csv-output-user', taskId: 'csv-output-task', requestId: 'csv-output-request',
      authenticated: true, authRole: 'admin' as const, localExecution: true, userConfirmed: true, allowLocalFileWrites: true };
    const wrong = await executeToolCall({ registry, name: 'create_pdf', arguments: { title: 'Wrong format', content: '72' }, context: { ...context, actionIntent: task } });
    expect(wrong.error).toMatch(/different document format/);
    // A legacy/unrelated verified PDF receipt must not pass the finalizer either.
    const other = await executeToolCall({ registry, name: 'create_pdf', arguments: { title: 'Legacy unrelated PDF', content: '72' }, context });
    expect(other.terminalVerification?.status).toBe('verified');
    expect(hasCoreActionEvidence(buildActionContract(task), [other], task, undefined, context)).toBe(false);
    const final = finalizeLumiResponse({ ...context, taskText: task, source: 'chat', responseText: '文件已完成。', toolRecords: [other] });
    expect(final.blocked).toBe(true);
    expect(final.text).not.toContain('已完成并验证本地文件');
    const correct = await executeToolCall({ registry, name: 'write_file', arguments: { path: output, content: 'quantity,price,total\n4,18,72\n' }, context: { ...context, actionIntent: task } });
    expect(correct.error).toBeUndefined();
    expect(fs.readFileSync(source, 'utf8')).toBe('quantity,price\n4,18\n');
  });
  it('keeps an exact XLSX request as XLSX and binds the requested destination before writing', async () => {
    const root = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'exact-format-'));
    const output = path.join(root, 'orders.xlsx');
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    registerFileOpsTools(registry);
    const context = { userId: 'exact-format-user', authRole: 'admin' as const, domain: 'personal' as const, userConfirmed: true, localExecution: true, actionIntent: `新建 ${output}，只有一个工作表“订单”，表头为商品、数量、单价、金额，只有一条数据：水杯，2，12，24。实际保存后回读表格并告诉我内容。` };
    const wrongFormat = await executeToolCall({ registry, name: 'create_docx', arguments: { title: 'Orders', content: 'wrong format' }, context });
    expect(wrongFormat.error).toMatch(/different document format/);
    const wrongPath = await executeToolCall({ registry, name: 'create_xlsx', arguments: { outputPath: path.join(root, 'wrong.xlsx'), sheets: [{ name: 'Orders', data: [[24]] }] }, context });
    expect(wrongPath.error).toMatch(/exact file path/);
    expect(fs.existsSync(path.join(root, 'wrong.xlsx'))).toBe(false);
    const created = await executeToolCall({ registry, name: 'create_xlsx', arguments: { filename: 'orders', sheets: [{ name: 'Orders', data: [[24]] }] }, context });
    expect(created.error).toBeFalsy();
    expect(created.arguments?.outputPath).toBe(path.resolve(output));
    expect(fs.statSync(output).size).toBeGreaterThan(100);
  });

  it('saves and modifies a real spreadsheet at the requested destinations while preserving both sources', async () => {
    const root = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'preserve-xlsx-'));
    const source = path.join(root, 'orders.csv');
    const output = path.join(root, 'result.xlsx');
    fs.writeFileSync(source, 'quantity,price\n4,12');
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const record = await executeToolCall({
      registry, name: 'create_xlsx',
      arguments: { outputPath: output, sheets: [{ name: 'Orders', headers: ['Total'], data: [[48]] }] },
      context: { userId: 'copy-xlsx-user', authRole: 'admin', domain: 'personal', userConfirmed: true, localExecution: true, actionIntent: `读取 ${source}，不修改原文件，将结果另存为 ${output}。` },
    });
    expect(record.error).toBeFalsy();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(fs.statSync(output).size).toBeGreaterThan(100);
    expect(fs.readFileSync(source, 'utf8')).toBe('quantity,price\n4,12');
    const originalBytes = fs.readFileSync(output);
    const modified = path.join(root, 'modified.xlsx');
    const change = await executeToolCall({
      registry, name: 'modify_xlsx',
      arguments: { filePath: output, outputPath: modified, operations: [{ sheet: 'Orders', cell: 'A2', value: 84 }] },
      context: { userId: 'copy-xlsx-user', authRole: 'admin', domain: 'personal', userConfirmed: true, localExecution: true, actionIntent: `读取 ${output}，金额改成84，不修改原文件，另存为 ${modified}。` },
    });
    expect(change.error).toBeFalsy();
    expect(change.terminalVerification?.status).toBe('verified');
    expect(fs.readFileSync(output)).toEqual(originalBytes);
    const { loadXlsxWorkbook } = await import('../server/utils/spreadsheet');
    expect((await loadXlsxWorkbook(modified)).getWorksheet('Orders')!.getCell('A2').value).toBe(84);
    const automaticCopy = await executeToolCall({
      registry, name: 'modify_xlsx',
      arguments: { filePath: output, operations: [{ sheet: 'Orders', cell: 'A2', value: 60 }] },
      context: { userId: 'copy-xlsx-user', authRole: 'admin', domain: 'personal', userConfirmed: true, localExecution: true, actionIntent: `读取 ${output}，金额改成60，原文件不动，另存一份。` },
    });
    expect(automaticCopy.error).toBeFalsy();
    expect(automaticCopy.terminalVerification?.status).toBe('verified');
    expect(automaticCopy.arguments?.outputPath).toBeTruthy();
    expect((await loadXlsxWorkbook(String(automaticCopy.arguments?.outputPath))).getWorksheet('Orders')!.getCell('A2').value).toBe(60);
    expect(fs.readFileSync(output)).toEqual(originalBytes);
  });

  it('writes the requested copy but rejects overwriting the source or an unrelated file', async () => {
    const root = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'preserve-source-'));
    const source = path.join(root, 'orders.csv');
    const output = path.join(root, 'result.csv');
    const unrelated = path.join(root, 'unrelated.csv');
    fs.writeFileSync(source, 'quantity,price\n2,12');
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    const text = `读取 ${source}，不修改原文件，将结果另存为 ${output}。`;
    const context = { userId: 'copy-scope-user', authRole: 'admin' as const, domain: 'personal' as const, userConfirmed: true, localExecution: true, actionIntent: text };
    for (const candidate of [source, unrelated]) {
      const blocked = await executeToolCall({ registry, name: 'write_file', arguments: { path: candidate, content: 'incorrect' }, context });
      expect(blocked.error).toBeTruthy();
    }
    for (const aliases of [{ path: source, filePath: output }, { path: source, outputPath: output }]) {
      const blocked = await executeToolCall({ registry, name: 'write_file', arguments: { ...aliases, content: 'wrong alias priority' }, context });
      expect(blocked.error).toBeTruthy();
      expect(fs.readFileSync(source, 'utf8')).toBe('quantity,price\n2,12');
    }
    const saved = await executeToolCall({ registry, name: 'write_file', arguments: { path: output, content: 'total\n24' }, context });
    expect(saved.error).toBeFalsy();
    expect(saved.terminalVerification?.status).toBe('verified');
    expect(fs.readFileSync(source, 'utf8')).toBe('quantity,price\n2,12');
    expect(fs.readFileSync(output, 'utf8')).toBe('total\n24');
    expect(fs.existsSync(unrelated)).toBe(false);
  });

  it.each([
    '不修改原文件，不要另存为 C:/test/copy.csv',
    '不修改任何文件，只说说另存为 C:/test/copy.csv 怎么做',
    'Do not modify the source file. Do not export to C:/test/copy.csv',
  ])('does not authorize a prohibited or unscoped mutation: %s', text => {
    expect(preservedSourceOutputScope(text)).toBeNull();
  });
});
