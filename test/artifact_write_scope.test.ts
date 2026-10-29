import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { preservedSourceOutputScope, requestedSingleArtifact } from '../server/cognition/artifact_write_scope';
import { requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { directoryArtifactPath, withoutLocationLiterals } from '../server/cognition/location_literals';
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
  it.each([
    [String.raw`C:\Users\Test User\Documents`, String.raw`C:\Users\Test User\Documents\local-result.txt`],
    ['D:/test files/output', 'D:/test files/output/local-result.txt'],
    ['/tmp/local output', '/tmp/local output/local-result.txt'],
  ])('keeps creation outside the directory operand %s', (directory, output) => {
    expect(requestedSingleArtifact(`在 ${directory} 创建 local-result.txt，写入后重读核验。`)?.path).toBe(output);
  });
  it.each([
    '不要在 D:/test 创建 local-result.txt。',
    '原文写着“在 D:/test 创建 local-result.txt”。只解释原文。',
    '读取“D:/test/create local-result.txt”的完整正文。',
    '假设在 /tmp 创建 local-result.txt。',
    '读取 D:/创建 文档/已完成.md。',
    '在 relative/output 创建 local-result.txt。',
  ])('does not authorize a directory creation from negation or literal content: %s', text => {
    expect(requestedSingleArtifact(text)).toBeNull();
  });
  it.each(['；', '，', '。', ';', ',', '！', '!', '？', '?'])('does not mask instructions across a directory clause boundary %s', separator => {
    const text = `在 D:/fixtures${separator}不要创建 x.md${separator}在 D:/other 创建 y.md。`;
    expect(withoutLocationLiterals(text)).toContain('不要创建');
    expect(requestedArtifactInstructions(text).map(item => item.path)).toEqual(['D:/other/y.md']);
  });
  it('keeps two directory destinations separate', () => {
    expect(requestedArtifactInstructions('在 D:/first 创建 a.md；在 D:/second 创建 b.md。').map(item => item.path))
      .toEqual(['D:/first/a.md', 'D:/second/b.md']);
  });
  it('does not treat a URL or relative directory as an explicit absolute destination', () => {
    expect(directoryArtifactPath('在 https://example.test/tmp 创建 local-result.txt。')).toBe('');
    expect(directoryArtifactPath('在 relative/output 创建 local-result.txt。')).toBe('');
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


describe('named merge output roles', () => {
  it('binds only the merged document in an explicitly named Desktop folder', () => {
    const task = '请把桌面的“共同验收甲.docx”和“共同验收乙.docx”合并成“共同验收合并.docx”，保留两份文件的全部正文，完成后把合并文件发到当前聊天。';
    const expected = path.join(os.homedir(), 'Desktop', '共同验收合并.docx');
    expect(requestedSingleArtifact(task)).toEqual({ path: expected, producer: 'create_docx', reader: 'read_docx' });
    expect(requestedArtifactInstructions(task).map(item => item.path)).toEqual([expected]);
  });
  it('prefers an explicit output folder over the source folder', () => {
    const task = '请把桌面的“alpha.docx”和“beta.docx”合并成下载文件夹中的“merged.docx”。';
    expect(requestedSingleArtifact(task)?.path).toBe(path.join(os.homedir(), 'Downloads', 'merged.docx'));
  });
  it('keeps an absolute merge destination separate from both sources', () => {
    const task = '请把 D:/fictional/alpha.docx 和 D:/fictional/beta.docx 合并成 D:/fictional/merged.docx，保留源文件。';
    expect(requestedSingleArtifact(task)?.path).toBe('D:/fictional/merged.docx');
    expect(requestedArtifactInstructions(task).map(item => item.path)).toEqual(['D:/fictional/merged.docx']);
  });
  it.each([
    '把“alpha.docx”和“beta.docx”合并成“merged.docx”。',
    '请把其他文件夹的“alpha.docx”和“beta.docx”合并成“merged.docx”。',
    '请把 D:/Desktop/alpha.docx 和 D:/Desktop/beta.docx 合并成“merged.docx”。',
    '请把“desktop.docx”和“beta.docx”合并成“merged.docx”。',
    '我怎么把桌面的“alpha.docx”和“beta.docx”合并成“merged.docx”？',
    '不要把桌面的“alpha.docx”和“beta.docx”合并成“merged.docx”。',
  ])('does not guess or grant a merge output: %s', task => {
    expect(requestedSingleArtifact(task)).toBeNull();
    expect(requestedArtifactInstructions(task)).toEqual([]);
  });
  it('does not collapse two requested merge outputs into one', () => {
    const task = '请把桌面的“alpha.docx”和“beta.docx”合并成“merged.docx”，再另存为“copy.docx”。';
    expect(requestedSingleArtifact(task)).toBeNull();
    const explicit = '请把 D:/fictional/alpha.docx 和 D:/fictional/beta.docx 合并成 D:/fictional/merged.docx，再另存为 D:/fictional/copy.docx。';
    expect(requestedSingleArtifact(explicit)).toBeNull();
    expect(requestedArtifactInstructions(explicit).map(item => item.path)).toEqual(['D:/fictional/merged.docx', 'D:/fictional/copy.docx']);
  });
});


describe('explicit standard-folder document outputs', () => {
  it('keeps the source Word separate from a PDF made from all its text', async () => {
    const { sourceDocumentInstruction, outputDocumentInstruction } = await import('../server/conversation/task_target_anchor');
    const { resolveExplicitUserArtifactPath, requestedArtifactSaveAsPath } = await import('../server/cognition/artifact_write_scope');
    const task = '读取桌面的“共同验收修订.docx”，将全部文字制作成桌面的“共同验收修订.pdf”，保留标题和两条内容，不修改原Word。核对PDF文字后，把原Word和PDF两个文件都发到当前聊天。';
    const output = path.join(os.homedir(), 'Desktop', '共同验收修订.pdf');
    expect(outputDocumentInstruction(task)).toBe('桌面的“共同验收修订.pdf”');
    expect(sourceDocumentInstruction(task)).not.toContain('共同验收修订.pdf');
    expect(resolveExplicitUserArtifactPath(sourceDocumentInstruction(task))).toBe(path.join(os.homedir(), 'Desktop', '共同验收修订.docx'));
    expect(requestedSingleArtifact(task)).toEqual({ path: output, producer: 'create_pdf', reader: 'read_pdf' });
    expect(requestedArtifactSaveAsPath(task)).toBe(output);
    expect(requestedArtifactInstructions(task).map(item => item.path)).toEqual([output]);
  });
  it.each([
    ['保存为桌面的“清点副本.docx”', 'Desktop', '清点副本.docx'],
    ['将全部文字制作成下载文件夹中的“仓储报告.pdf”', 'Downloads', '仓储报告.pdf'],
  ])('resolves a single explicit output clause: %s', (task, folder, name) => {
    const output = path.join(os.homedir(), folder, name);
    expect(requestedSingleArtifact(task)?.path).toBe(output);
    expect(requestedArtifactInstructions(task).map(item => item.path)).toEqual([output]);
  });
  it('does not invent a source directory from a filename or a different absolute path', async () => {
    const { resolveExplicitUserArtifactPath } = await import('../server/cognition/artifact_write_scope');
    expect(resolveExplicitUserArtifactPath('读取“desktop.docx”')).toBe('');
    expect(resolveExplicitUserArtifactPath('读取“source.docx”')).toBe('');
    expect(resolveExplicitUserArtifactPath('读取 D:/Desktop/source.docx')).toBe('D:/Desktop/source.docx');
    expect(resolveExplicitUserArtifactPath('读取桌面的“one.docx”和“two.docx”')).toBe('');
  });
  it('checks create_pdf actual outputPath against the requested destination', async () => {
    const { requestedArtifactFormatBlockReason, preservedSourceWriteBlockReason } = await import('../server/cognition/artifact_write_scope');
    const task = '创建桌面的“清点报告.pdf”';
    const output = path.join(os.homedir(), 'Desktop', '清点报告.pdf');
    expect(requestedArtifactFormatBlockReason(task, 'create_pdf', { outputPath: output })).toBeNull();
    expect(requestedArtifactFormatBlockReason(task, 'create_pdf', {})).toContain(output);
    expect(requestedArtifactFormatBlockReason(task, 'create_pdf', { outputPath: path.join(os.homedir(), 'Downloads', '清点报告.pdf') })).toContain(output);
    const protectedTask = '读取 C:/fixtures/source.docx，不修改原文件，另存为 C:/fixtures/result.pdf。';
    expect(preservedSourceWriteBlockReason({ text: protectedTask, toolName: 'create_pdf', arguments: { outputPath: 'C:/fixtures/result.pdf' } })).toBeNull();
    expect(preservedSourceWriteBlockReason({ text: protectedTask, toolName: 'create_pdf', arguments: { outputPath: 'C:/fixtures/source.docx' } })).toContain('original file');
  });
  it.each([
    ['读取桌面的“源稿.docx”，将全部文字制作成桌面的“报告.pdf”。核对PDF文字后，把PDF发到当前聊天。', true],
    ['核对PDF文字后，创建桌面的“报告.pdf”。', false],
    ['先读取桌面的“源稿.docx”，再创建桌面的“报告.pdf”。', false],
    ['创建桌面的“报告.pdf”，不要核对PDF文字。', false],
    ['创建桌面的“报告.pdf”，内容为“核对PDF文字后”。', false],
  ])('requires a read only for an affirmative post-create text check: %s', async (task, expected) => {
    const { requiresArtifactPostWriteReadback } = await import('../server/cognition/action_request');
    expect(requiresArtifactPostWriteReadback(task)).toBe(expected);
  });
});
