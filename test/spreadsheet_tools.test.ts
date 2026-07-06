import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';

const createdFiles = new Set<string>();

function remember(filePath: string): string {
  createdFiles.add(filePath);
  return filePath;
}

function extractPath(result: string): string {
  const match = result.match(/[A-Z]:\\.+?\.xlsx|\/.+?\.xlsx/);
  if (!match) throw new Error(`No xlsx path found in result: ${result}`);
  return remember(match[0]);
}

afterEach(() => {
  for (const filePath of createdFiles) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }
  createdFiles.clear();
});

describe('spreadsheet document tools', () => {
  it('creates, reads, modifies, and converts xlsx files without SheetJS', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const context = { requestConfirmation: async () => true };

    const created = await registry.execute('create_xlsx', {
      filename: 'spreadsheet-tool-regression',
      sheets: [
        { name: 'Orders', headers: ['sku', 'qty'], data: [['A-1', 2], ['B-2', 5]] },
      ],
    }, context);
    const xlsxPath = extractPath(created);

    const read = await registry.execute('read_xlsx', { filePath: xlsxPath, sheetName: 'Orders' });
    expect(read).toContain('sku,qty');
    expect(read).toContain('A-1,2');

    const modified = await registry.execute('modify_xlsx', {
      filePath: xlsxPath,
      operations: [
        { sheet: 'Orders', cell: 'B2', value: 3 },
        { addSheet: true, sheet: 'Summary', headers: ['metric', 'value'], data: [['total', 8]] },
      ],
    }, context);
    const modifiedPath = extractPath(modified);
    const modifiedRead = await registry.execute('read_xlsx', { filePath: modifiedPath, sheetName: 'Summary' });
    expect(modifiedRead).toContain('metric,value');
    expect(modifiedRead).toContain('total,8');

    const csvPath = remember(modifiedPath.replace(/\.xlsx$/i, '.csv'));
    const csv = await registry.execute('xlsx_to_csv', { filePath: modifiedPath, sheetName: 'Orders', outputPath: csvPath }, context);
    expect(csv).toContain('XLSX converted to CSV');
    expect(fs.readFileSync(csvPath, 'utf-8')).toContain('A-1,3');
  });

  it('fails legacy xls files with a clear conversion hint', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const xlsPath = remember(path.join(process.cwd(), 'lumi_output', `legacy_${Date.now()}.xls`));
    fs.mkdirSync(path.dirname(xlsPath), { recursive: true });
    fs.writeFileSync(xlsPath, 'not a real workbook');

    await expect(registry.execute('read_xlsx', { filePath: xlsPath })).rejects.toThrow('Convert the file to .xlsx or .csv first');
  });
});
