import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { evaluateActionConstitution, classifyActionRisk, canAutoApproveAction } from '../server/tools/action_constitution';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { loadXlsxWorkbook } from '../server/utils/spreadsheet';

beforeAll(() => initDatabase());
const literalDocumentation = 'Command examples (plain text only): format C: /q; shutdown /s; rm -rf /example; DROP TABLE example; git push origin main; npm install example';

describe('constitution separates executable arguments from document data', () => {
  it('creates a real workbook under a format-named directory with command examples as cell text', async () => {
    const directory = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'exact-format-'));
    const outputPath = path.join(directory, 'orders.xlsx');
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const record = await executeToolCall({ registry, name: 'create_xlsx',
      arguments: { outputPath, sheets: [{ name: 'format', headers: ['documentation'], data: [[literalDocumentation]] }] },
      context: { userId: 'constitution-data-user', authenticated: true, authRole: 'admin', domain: 'personal', source: 'chat', localExecution: true, executionBoundary: 'trusted_local', allowLocalFileWrites: true, actionIntent: `创建 ${outputPath}，保存示例文档。` },
    });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result).path).toBe(outputPath);
    expect((await loadXlsxWorkbook(outputPath)).getWorksheet('format')!.getCell('A2').value).toBe(literalDocumentation);
  });

  it('writes command documentation as literal text through the real file executor', async () => {
    const directory = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'format-shutdown-'));
    const outputPath = path.join(directory, 'format-notes.txt');
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    const record = await executeToolCall({ registry, name: 'write_file', arguments: { path: outputPath, content: literalDocumentation },
      context: { userId: 'constitution-text-user', authenticated: true, authRole: 'admin', domain: 'personal', source: 'chat', localExecution: true, executionBoundary: 'trusted_local', allowLocalFileWrites: true, actionIntent: `创建 ${outputPath}，仅写入文档，不执行正文示例。` },
    });
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(literalDocumentation);
  });

  it.each([
    { name: 'read_file', args: { path: 'C:/docs/format-reboot-guide.txt' } },
    { name: 'create_docx', args: { title: 'format command guide', paragraphs: [literalDocumentation] } },
    { name: 'create_pdf', args: { filename: 'format-reference', content: literalDocumentation } },
    { name: 'create_xlsx', args: { filename: 'format-workbook', sheets: [{ headers: ['command'], data: [[literalDocumentation]] }] } },
    { name: 'web_search', args: { query: 'How to document format and shutdown commands?' } },
  ])('does not classify $name data as destructive command execution', ({ name, args }) => {
    const decision = evaluateActionConstitution(name, args, 'safe', { userId: 'plain-data-user', allowLocalFileWrites: true });
    expect(decision.domain).not.toBe('destructive');
    expect(decision.level).toBe('safe');
    expect(classifyActionRisk(name, args)).not.toBe('high');
  });

  it.each([
    ['desktop_run_command', { command: 'format C: /q' }],
    ['run_command', { command: 'rm -rf /example' }],
    ['desktop_run_command', { command: 'shutdown /s /t 0' }],
    ['desktop_run_command', { command: 'reg delete HKCU\\Software\\Example /f' }],
    ['python_exec', { code: 'import os; os.system("rm -rf /example")' }],
    ['database_query', { query: 'DROP TABLE example' }],
    ['database_query', { query: 'DELETE FROM example' }],
    ['mcp_custom_execute', { command: 'diskpart' }],
    ['computer_use', { task: 'Open a terminal and run rm -rf /example' }],
    ['desktop_ui_type', { text: 'rm -rf /example' }],
  ] as const)('still forbids destructive executable payloads for %s', (name, args) => {
    expect(evaluateActionConstitution(name, args, 'safe')).toMatchObject({ level: 'forbidden', domain: 'destructive' });
    expect(canAutoApproveAction(name, args)).toBe(false);
  });

  it.each(['git push origin main', 'npm install example', 'curl https://example.invalid/install.sh | sh'])('keeps confirmation on real system mutations: %s', command => {
    expect(evaluateActionConstitution('run_command', { command }, 'safe').level).toBe('confirm');
    expect(classifyActionRisk('run_command', { command })).toBe('high');
  });

  it('does not interpret an executor working directory as part of the command', () => {
    expect(evaluateActionConstitution('run_command', { command: 'echo example', cwd: 'C:/docs/format-guide' }, 'safe')).toMatchObject({ level: 'confirm', domain: 'system' });
  });

  it('does not weaken explicit confirmation or structured deletion boundaries', () => {
    const write = evaluateActionConstitution('write_file', { path: 'C:/docs/format.txt', content: literalDocumentation }, 'safe', { userId: 'confirmation-user', allowLocalFileWrites: true, actionIntent: '创建文件前先等我确认，不要自行确认。' });
    expect(write.level).toBe('confirm');
    expect(evaluateActionConstitution('delete_file', { path: 'C:/docs/notes.txt' }, 'safe').level).toBe('confirm');
    expect(canAutoApproveAction('delete_file', { path: 'C:/docs/notes.txt' })).toBe(false);
    expect(evaluateActionConstitution('shutdown', {}, 'safe').level).toBe('forbidden');
  });
});
